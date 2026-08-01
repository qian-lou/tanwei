import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

execFileSync(
  process.execPath,
  [path.join(process.cwd(), "scripts", "sync-build-metadata.mjs"), "--check"],
  { stdio: "inherit" },
);

const repository =
  process.env.GITHUB_REPOSITORY?.trim() ??
  process.env.TANWEI_GITHUB_REPOSITORY?.trim();
const match = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/u.exec(
  repository ?? "",
);
if (!match?.[1] || !match[2]) {
  throw new Error(
    "正式发布必须通过 GITHUB_REPOSITORY 或 TANWEI_GITHUB_REPOSITORY 指定 owner/repository",
  );
}

const releaseTag =
  process.env.GITHUB_REF_NAME?.trim() ??
  process.env.TANWEI_RELEASE_TAG?.trim();
const desktopPackage = JSON.parse(
  await readFile(
    path.join(process.cwd(), "apps", "desktop", "package.json"),
    "utf8",
  ),
);
const expectedTag = `v${String(desktopPackage.version ?? "")}`;
if (releaseTag !== expectedTag) {
  throw new Error(
    `发布标签必须与 Desktop 版本完全一致：期望 ${expectedTag}，实际 ${releaseTag || "<未提供>"}`,
  );
}

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(
  npmExecutable,
  [
    "exec",
    "--workspace",
    "@tanwei/desktop",
    "--",
    "electron-builder",
    "--publish",
    "never",
    "--config.publish.provider=github",
    `--config.publish.owner=${match[1]}`,
    `--config.publish.repo=${match[2]}`,
  ],
  {
    stdio: "inherit",
    env: process.env,
  },
);
