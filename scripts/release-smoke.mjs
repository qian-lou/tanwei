import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "tanwei-release-smoke-"));
const bundle = path.join(root, "apps", "desktop", "src-tauri", "target", "release", "bundle");
const releases = path.join(root, "apps", "desktop", "release");
let processHandle;
let output = "";
let processError;
let exited = false;
try {
  let executable;
  if (process.platform === "darwin") {
    const apps = (await readdir(path.join(bundle, "macos"))).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("必须存在且仅存在一个正式 macOS App");
    executable = path.join(bundle, "macos", apps[0], "Contents", "MacOS", "tanwei-desktop");
  } else if (process.platform === "win32") {
    const installers = (await readdir(releases)).filter((name) => name.endsWith(".exe"));
    if (installers.length !== 1) throw new Error("必须存在且仅存在一个 Windows 安装器");
    const destination = path.join(temporary, "installed");
    execFileSync(path.join(releases, installers[0]), ["/S", `/D=${destination}`], { timeout: 120_000, stdio: "inherit" });
    executable = path.join(destination, "tanwei-desktop.exe");
  } else {
    const images = (await readdir(releases)).filter((name) => name.endsWith(".AppImage"));
    if (images.length !== 1) throw new Error("必须存在且仅存在一个 Linux AppImage");
    executable = path.join(releases, images[0]);
  }
  processHandle = spawn(executable, [], {
    env: { ...process.env, TANWEI_USER_DATA_DIR: path.join(temporary, "workspace"), APPIMAGE_EXTRACT_AND_RUN: "1" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-131_072); };
  processHandle.stdout.on("data", append);
  processHandle.stderr.on("data", append);
  processHandle.once("error", (error) => { processError = error; });
  processHandle.once("exit", () => { exited = true; });
  for (let second = 0; second < 20; second += 1) {
    await delay(1000);
    if (processError || exited) throw new Error(`正式应用启动失败：${processError?.message ?? output}`);
  }
  const database = path.join(temporary, "workspace", "tanwei.sqlite");
  if (!(await stat(database)).isFile()) throw new Error("正式应用没有完成工作区初始化");
  if (/panicked at|failed to run tauri application|启动完整性校验失败/i.test(output)) throw new Error(`正式应用输出启动错误：${output}`);
  console.log(`Production Tauri startup verified on ${process.platform}/${process.arch}; no WebDriver feature required.`);
} finally {
  if (processHandle?.pid && !exited) {
    if (process.platform === "win32") {
      try { execFileSync("taskkill", ["/PID", String(processHandle.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* Already exited. */ }
    } else {
      try { process.kill(-processHandle.pid, "SIGTERM"); } catch { /* Already exited. */ }
      await delay(1000);
      try { process.kill(-processHandle.pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
