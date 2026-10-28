import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const testing = process.argv.includes("--test");
if (process.argv.slice(2).some(argument => argument !== "--test")) throw new Error("未知打包参数");
execFileSync(process.execPath, [path.join(root, "scripts/generate-rust-contracts.mjs")], { cwd: root, stdio: "inherit" });
const args = ["build"];
if (testing) {
  args.push("--features", "desktop-e2e");
  // Windows/Linux 驱动直接启动测试二进制；macOS 需要应用包定位资源。
  args.push(...(process.platform === "darwin" ? ["--bundles", "app"] : ["--no-bundle"]));
}
if (process.platform === "linux") args.push("--verbose");
execFileSync(process.execPath, [path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), ...args], {
  cwd: path.join(root, "apps/desktop"),
  stdio: "inherit",
  // linuxdeploy 自带 strip 不兼容现代 ELF，也不能改写已校验的运行时组件。
  env: { ...process.env, ...(process.platform === "linux" ? { NO_STRIP: "true" } : {}) },
});
