import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { launchTauri } from "./tauri-driver.mjs";

const executeFile = promisify(execFile);
const fakeDriver = `
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)"], { env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "ignore"] });
process.on("SIGTERM", () => {});
child.stdout.once("data", () => {
  fs.writeFileSync(process.env.FAKE_DRIVER_PIDS, JSON.stringify({ host: process.pid, child: child.pid }));
  http.createServer((request, response) => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ value })); };
    if (request.url === "/status") return reply({ ready: true });
    if (request.url === "/session" && process.env.FAKE_DRIVER_MODE === "startup-reset") {
      console.error("deliberate startup reset diagnostic");
      request.socket.destroy();
      return;
    }
    if (request.url === "/session") return process.env.FAKE_DRIVER_MODE === "startup-failure"
      ? reply({ error: "session not created", message: "deliberate startup failure" }, 500)
      : reply({ sessionId: "fixture" });
    if (request.url.endsWith("/timeouts")) return reply(null);
    if (request.url.endsWith("/execute/sync") && process.env.FAKE_DRIVER_MODE === "host-exits-first") {
      reply(null);
      return setTimeout(() => process.exit(0), 50);
    }
    // Simulate a wedged renderer and session deletion: neither request returns.
  }).listen(Number(process.env.TAURI_WEBDRIVER_PORT), "127.0.0.1");
});
`;

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function fixture(mode, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-fake-driver-"));
  const script = path.join(directory, "fake-driver.cjs");
  const pids = path.join(directory, "pids.json");
  await writeFile(script, fakeDriver);
  try {
    await run({
      executablePath: process.execPath,
      startupTimeout: 5_000,
      env: { NODE_OPTIONS: `--require ${JSON.stringify(script.replaceAll("\\", "/"))}`, FAKE_DRIVER_PIDS: pids, FAKE_DRIVER_MODE: mode },
    }, async () => JSON.parse(await readFile(pids, "utf8")));
  } finally {
    try {
      const recorded = await readFile(pids, "utf8").then(JSON.parse, () => null);
      if (recorded) {
        if (process.platform === "win32") {
          for (const pid of [recorded.host, recorded.child]) {
            await executeFile("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5_000, windowsHide: true }).catch(() => undefined);
          }
        } else {
          try { process.kill(-recorded.host, "SIGKILL"); } catch { /* Already reaped. */ }
        }
        const deadline = Date.now() + 5_000;
        while (alive(recorded.host) || alive(recorded.child)) {
          if (Date.now() >= deadline) throw new Error("Fake WebDriver fixture process cleanup failed");
          await delay(50);
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

test("hung close commands remain bounded and concurrent callers await the complete process tree", { timeout: 20_000 }, async () => {
  await fixture("hung", async (options, pids) => {
    const app = await launchTauri(options);
    const recorded = await pids();
    const started = Date.now();
    const first = app.close();
    assert.equal(app.close(), first);
    await first;
    assert.ok(Date.now() - started < 15_000);
    assert.ok(app.process.exitCode !== null || app.process.signalCode !== null);
    assert.equal(alive(recorded.host), false);
    assert.equal(alive(recorded.child), false);
  });
});

test("startup failure terminates and awaits both the fake Host and its child", { timeout: 15_000 }, async () => {
  await fixture("startup-failure", async (options, pids) => {
    await assert.rejects(launchTauri(options), /deliberate startup failure/u);
    const recorded = await pids();
    assert.equal(alive(recorded.host), false);
    assert.equal(alive(recorded.child), false);
  });
});

test("startup connection reset includes its phase and process output and cleans both processes", { timeout: 15_000 }, async () => {
  await fixture("startup-reset", async (options, pids) => {
    await assert.rejects(launchTauri(options), /creating WebDriver session.*\n.*deliberate startup reset diagnostic/su);
    const recorded = await pids();
    assert.equal(alive(recorded.host), false);
    assert.equal(alive(recorded.child), false);
  });
});

test("Unix cleanup terminates remaining group members after the Host exits first", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  await fixture("host-exits-first", async (options, pids) => {
    const app = await launchTauri(options);
    const recorded = await pids();
    await app.close();
    assert.equal(app.process.exitCode, 0);
    assert.equal(alive(recorded.child), false);
  });
});
