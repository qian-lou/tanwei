import assert from "node:assert/strict";
import test from "node:test";
import { applicationProcesses } from "./desktop-process-metrics.mjs";
const row = (pid, parentPid, command = "process") => ({ pid, parentPid, command, workingSetBytes: pid * 1024, cpuPercent: 0.5 });

test("resource sampling includes the complete descendant tree without unrelated processes", () => {
  const processes = applicationProcesses([row(1, 0), row(20, 1), row(21, 20), row(22, 21), row(25, 1)], 20, new Set(), "linux");
  assert.deepEqual(processes.map((process) => process.pid), [20, 21, 22]);
  assert.equal(processes.reduce((sum, process) => sum + process.workingSetBytes, 0), 63 * 1024);
});
test("macOS conservatively includes new reparented WebKit XPC helpers", () => {
  const processes = applicationProcesses([row(20, 1), row(30, 1, "com.apple.WebKit.WebContent"), row(31, 1, "com.apple.WebKit.Networking"), row(40, 1, "unrelated")], 20, new Set([30]), "darwin");
  assert.deepEqual(processes.map((process) => process.pid), [20, 31]);
});
test("a missing host is a sampling failure and cannot report zero memory", () => {
  assert.throws(() => applicationProcesses([row(1, 0)], 20, new Set(), "linux"), /Host/u);
});
