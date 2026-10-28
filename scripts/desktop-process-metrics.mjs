import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

export async function readProcessSnapshot() {
  if (process.platform === "win32") {
    const script = 'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -gt 0 } | Select-Object @{n="pid";e={[int]$_.IDProcess}},@{n="parentPid";e={[int]$_.CreatingProcessID}},@{n="workingSetBytes";e={[double]$_.WorkingSet}},@{n="cpuPercent";e={[double]$_.PercentProcessorTime}},@{n="command";e={$_.Name}} | ConvertTo-Json -Compress';
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    const rows = JSON.parse(stdout.trim());
    return validateRows(Array.isArray(rows) ? rows : [rows]);
  }
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,command="], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
  const rows = stdout.split(/\r?\n/u).filter((line) => line.trim()).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/u.exec(line);
    if (!match) throw new Error("无法解析操作系统进程指标");
    return { pid: Number(match[1]), parentPid: Number(match[2]), workingSetBytes: Number(match[3]) * 1024, cpuPercent: Number(match[4]), command: match[5] };
  });
  return validateRows(rows);
}
function validateRows(rows) {
  if (!rows.length || rows.some((row) => !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 || !Number.isFinite(row.workingSetBytes) || row.workingSetBytes < 0 || !Number.isFinite(row.cpuPercent) || row.cpuPercent < 0 || typeof row.command !== "string")) {
    throw new Error("操作系统未返回有效进程资源指标");
  }
  return rows;
}

/** O(N) tree walk. New macOS XPC WebKit helpers are conservatively included. */
export function applicationProcesses(rows, hostPid, baselinePids, platform = process.platform) {
  const byParent = new Map();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  if (!byPid.has(hostPid)) throw new Error("Tauri Host 进程已经退出或无法采样");
  for (const row of rows) {
    const children = byParent.get(row.parentPid) ?? [];
    children.push(row.pid);
    byParent.set(row.parentPid, children);
  }
  const selected = new Set([hostPid]);
  const queue = [hostPid];
  for (let index = 0; index < queue.length; index += 1) {
    for (const pid of byParent.get(queue[index]) ?? []) {
      if (!selected.has(pid)) { selected.add(pid); queue.push(pid); }
    }
  }
  if (platform === "darwin") {
    for (const row of rows) {
      if (!baselinePids.has(row.pid) && /com\.apple\.WebKit\.(WebContent|Networking|GPU)/u.test(row.command)) selected.add(row.pid);
    }
  }
  return [...selected].map((pid) => {
    const row = byPid.get(pid);
    return { pid, type: pid === hostPid ? "Host" : "WebView/Child", workingSetBytes: row.workingSetBytes, cpuPercent: row.cpuPercent };
  });
}
