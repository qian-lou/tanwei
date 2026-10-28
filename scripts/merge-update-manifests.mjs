import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "release-assets");
const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.TANWEI_RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? "") || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag ?? "")) {
  throw new Error("更新清单合并需要有效的 GITHUB_REPOSITORY/GITHUB_REF_NAME");
}
const expected = new Map([["darwin-aarch64", ".app.tar.gz"], ["darwin-x86_64", ".app.tar.gz"], ["linux-x86_64-appimage", ".AppImage"], ["linux-x86_64-deb", ".deb"], ["windows-x86_64", ".exe"]]);
const platforms = {};
let publishedAt = "";
const files = new Set(await readdir(directory));
for (const filename of files) {
  if (!/^updater-[a-z0-9_-]+\.json$/.test(filename)) continue;
  const document = JSON.parse(await readFile(path.join(directory, filename), "utf8"));
  if (document.version !== tag.slice(1) || !Number.isFinite(Date.parse(document.pub_date))) throw new Error(`更新清单版本或时间无效：${filename}`);
  for (const [platform, entry] of Object.entries(document.platforms ?? {})) {
    if (!expected.has(platform) || platforms[platform]) throw new Error(`更新平台缺失、重复或无效：${platform}`);
    if (typeof entry.signature !== "string" || !entry.signature.trim()) throw new Error(`更新签名为空：${platform}`);
    const url = new URL(entry.url);
    const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
    if (!url.href.startsWith(prefix)) throw new Error(`更新 URL 不属于当前不可变 Release：${platform}`);
    const artifact = decodeURIComponent(url.href.slice(prefix.length));
    if (!artifact || artifact.includes("/") || artifact.includes("\\")) throw new Error("更新文件名无效");
    if (!artifact.endsWith(expected.get(platform))) throw new Error(`更新安装格式与平台不匹配：${platform}`);
    if (!files.has(artifact)) throw new Error(`缺少更新安装包：${artifact}`);
    const detached = (await readFile(path.join(directory, `${artifact}.sig`), "utf8")).trim();
    if (detached !== entry.signature.trim()) throw new Error(`更新清单签名与产物不匹配：${artifact}`);
    platforms[platform] = entry;
  }
  if (document.pub_date > publishedAt) publishedAt = document.pub_date;
}
if (Object.keys(platforms).length !== expected.size) throw new Error("必须取得全部四个平台及 Linux 两种安装格式的签名更新产物才能发布");
await writeFile(path.join(directory, "latest.json"), `${JSON.stringify({ version: tag.slice(1), notes: `探微 ${tag}`, pub_date: publishedAt, platforms }, null, 2)}\n`);
console.log(`Validated updater manifest for ${Object.keys(platforms).join(", ")}.`);
