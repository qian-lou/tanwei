import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const CLOSE_COMMAND_TIMEOUT = 2_000;

function running(child) {
  return Boolean(child.pid && child.exitCode === null && child.signalCode === null);
}

function waitForExit(child, timeout) {
  if (!running(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    child.once("exit", onExit);
  });
}

function signalProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    // Darwin can report EPERM for signal 0 while orphaned group members are
    // being reaped. It still means the group exists; actual signals must fail.
    if (signal === 0 && error.code === "EPERM") return true;
    throw error;
  }
}

async function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (running(child)) {
      try {
        await executeFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5_000, windowsHide: true });
      } catch (error) {
        if (running(child)) throw new Error(`Unable to terminate Tauri process tree: ${error.message}`);
      }
    }
  } else {
    // The dedicated process group remains addressable if the Host exits before
    // one of its children. Terminate remaining members even after graceful exit.
    signalProcessGroup(child.pid, "SIGTERM");
    await waitForExit(child, 2_000);
    signalProcessGroup(child.pid, "SIGKILL");
  }
  if (!await waitForExit(child, 5_000)) throw new Error("Tauri Host did not exit after process-tree termination");
  if (process.platform !== "win32") {
    const deadline = Date.now() + 5_000;
    while (signalProcessGroup(child.pid, 0)) {
      if (Date.now() >= deadline) throw new Error("Tauri child process group did not exit after termination");
      await delay(50);
    }
  }
}

/** The embedded driver is compiled only with Cargo's desktop-e2e feature. */
export function desktopPaths(projectRoot = process.cwd()) {
  const target = process.env.CARGO_TARGET_DIR || path.join(projectRoot, "apps/desktop/src-tauri/target");
  const executablePath = process.env.TANWEI_E2E_EXECUTABLE?.trim() ||
    (process.platform === "darwin"
      ? path.join(target, "release/bundle/macos/探微.app/Contents/MacOS/tanwei-desktop")
      : path.join(target, "release", process.platform === "win32" ? "tanwei-desktop.exe" : "tanwei-desktop"));
  const resourcesPath = process.env.TANWEI_E2E_RESOURCES?.trim() ||
    (process.platform === "darwin" && executablePath.includes(".app/")
      ? path.resolve(executablePath, "../../Resources")
      : path.join(projectRoot, "apps/desktop/build-resources"));
  return { executablePath, resourcesPath };
}

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve WebDriver port");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

class WebDriver {
  constructor(baseUrl, sessionId) { this.baseUrl = baseUrl; this.sessionId = sessionId; }
  async command(method, endpoint, body, timeout = 120_000) {
    const response = await fetch(`${this.baseUrl}/session/${this.sessionId}${endpoint}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const payload = await response.json();
    if (!response.ok || payload.value?.error) throw new Error(`${method} ${endpoint}: ${payload.value?.message || payload.value?.error || response.statusText}`);
    return payload.value;
  }
  getWindowHandles() { return this.command("GET", "/window/handles"); }
  getWindowHandle() { return this.command("GET", "/window"); }
  switchToWindow(handle) { return this.command("POST", "/window", { handle }); }
  getTitle() { return this.command("GET", "/title"); }
  getUrl() { return this.command("GET", "/url"); }
  refresh() { return this.command("POST", "/refresh", {}); }
  closeWindow() { return this.command("DELETE", "/window"); }
  setWindowRect(rect) { return this.command("POST", "/window/rect", rect); }
  takeScreenshot() { return this.command("GET", "/screenshot"); }
  deleteSession(timeout) { return this.command("DELETE", "", undefined, timeout); }
  executeScript(script, args = []) { return this.command("POST", "/execute/sync", { script, args }); }
  async execute(fn, ...args) {
    const script = `const done = arguments[arguments.length - 1]; const args = Array.from(arguments).slice(0, -1); Promise.resolve().then(() => (${fn.toString()})(...args)).then(value => done({ok:true,value:value ?? null}), error => done({ok:false,error:String(error?.stack || error)}));`;
    const result = await this.command("POST", "/execute/async", { script, args });
    if (!result?.ok) throw new Error(result?.error || "WebDriver script returned no result");
    return result.value;
  }
}

export async function launchTauri({ executablePath, env = {}, startupTimeout = 60_000 } = desktopPaths()) {
  const port = await reservePort();
  const child = spawn(executablePath, [], { env: { ...process.env, ...env, TAURI_WEBDRIVER_PORT: String(port) }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  let spawnError;
  child.on("error", error => { spawnError = error; });
  child.stdout.on("data", chunk => { log = `${log}${chunk}`.slice(-32_768); });
  child.stderr.on("data", chunk => { log = `${log}${chunk}`.slice(-32_768); });
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser;
  try {
    const deadline = Date.now() + startupTimeout;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Tauri exited before WebDriver became ready: ${log}`);
      try { const response = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(1_000) }); if (response.ok) { ready = true; break; } } catch { /* The native WebView is still starting. */ }
      await delay(100);
    }
    if (!ready) throw new Error(`Embedded WebDriver did not start. Build with --features desktop-e2e.\n${log}`);
    const remainingStartup = () => Math.max(1, Math.min(30_000, deadline - Date.now()));
    const response = await fetch(`${baseUrl}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capabilities: { alwaysMatch: {} } }), signal: AbortSignal.timeout(remainingStartup()) });
    const payload = await response.json();
    if (!response.ok || !payload.value?.sessionId) throw new Error(`Unable to create WebDriver session: ${JSON.stringify(payload)}`);
    browser = new WebDriver(baseUrl, payload.value.sessionId);
    await browser.command("POST", "/timeouts", { script: 120_000, pageLoad: 60_000, implicit: 0 }, remainingStartup());
    let queue = Promise.resolve();
    let closing;
    return {
      browser, process: child,
      get log() { return log; },
      serial(operation) { const result = queue.then(operation); queue = result.catch(() => undefined); return result; },
      close() {
        return closing ??= (async () => {
          try {
            if (running(child)) {
              const requested = await browser.command("POST", "/execute/sync", {
                script: 'if (window.tanwei?.resolveAppExit) { void window.tanwei.resolveAppExit({ reason: "APP_QUIT", mode: "QUIT_APP" }).catch(() => undefined); } return null;', args: [],
              }, CLOSE_COMMAND_TIMEOUT).then(() => true, () => false);
              if (requested) await waitForExit(child, 8_000);
            }
            if (running(child)) await browser.deleteSession(CLOSE_COMMAND_TIMEOUT).catch(() => undefined);
          } finally {
            await terminateProcessTree(child);
          }
        })();
      },
    };
  } catch (error) {
    try {
      await browser?.deleteSession(CLOSE_COMMAND_TIMEOUT).catch(() => undefined);
      await terminateProcessTree(child);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${error.message}; startup cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}
