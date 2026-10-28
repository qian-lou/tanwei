import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { repo: { type: "string" } } });

function github(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  } catch {
    throw new Error("无法读取 GitHub Secrets 名称，请检查 gh 登录状态和仓库管理权限。");
  }
}

const repository = values.repo ?? github(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
const configured = new Set(JSON.parse(github(["secret", "list", "--repo", repository, "--json", "name"])).map(({ name }) => name));
const groups = [
  ["Tauri 更新签名", ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "TANWEI_UPDATER_PUBLIC_KEY"]],
  ["macOS 固定自签名", ["MACOS_CERTIFICATE", "MACOS_CERTIFICATE_PASSWORD", "MACOS_CERTIFICATE_SHA256"]],
];

console.log(`仓库：${repository}`);
let missing = 0;
for (const [label, names] of groups) {
  console.log(`\n${label}`);
  for (const name of names) {
    const present = configured.has(name);
    console.log(`  ${present ? "已配置" : "缺少"} ${name}`);
    if (!present) missing += 1;
  }
}
console.log("\n本检查只读取 Secret 名称；证书有效性、密钥匹配和公证结果由正式发布 CI 验证。");
if (missing) {
  console.log(`仍缺少 ${missing} 项，暂不能运行四平台正式发布。`);
  process.exitCode = 1;
}
