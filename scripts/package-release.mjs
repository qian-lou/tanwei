import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";
import { withMacSigning, verifyMacApplication } from "./sign-macos-runtime.mjs";

const projectRoot = process.cwd();
const desktopRoot = path.join(projectRoot, "apps", "desktop");
const bundleRoot = path.join(desktopRoot, "src-tauri", "target", "release", "bundle");
const releaseRoot = path.join(desktopRoot, "release");
execFileSync(process.execPath, [path.join(projectRoot, "scripts", "sync-build-metadata.mjs"), "--check"], { stdio: "inherit" });

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`正式发布缺少 ${name}`);
  return value;
}

const repository = process.env.GITHUB_REPOSITORY?.trim() ?? process.env.TANWEI_GITHUB_REPOSITORY?.trim();
if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? "")) {
  throw new Error("正式发布必须通过 GITHUB_REPOSITORY 或 TANWEI_GITHUB_REPOSITORY 指定 owner/repository");
}
const releaseTag = process.env.TANWEI_RELEASE_TAG?.trim() ?? process.env.GITHUB_REF_NAME?.trim();
const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const version = desktopPackage.version;
if (releaseTag !== `v${version}`) throw new Error(`发布标签必须与 Desktop 版本完全一致：期望 v${version}`);
if (process.env.CARGO_FEATURE_DESKTOP_E2E === "1") throw new Error("正式包不能包含桌面 WebDriver 测试服务");

const updaterPublicKey = required("TANWEI_UPDATER_PUBLIC_KEY");
required("TAURI_SIGNING_PRIVATE_KEY");
required("TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
const platform = { darwin: "darwin", win32: "windows", linux: "linux" }[process.platform];
const architecture = { x64: "x86_64", arm64: "aarch64" }[process.arch];
if (!platform || !architecture) throw new Error(`不支持的发布平台 ${process.platform}/${process.arch}`);

const bundle = { createUpdaterArtifacts: true };
if (process.platform === "darwin") {
  required("MACOS_CERTIFICATE");
  required("MACOS_CERTIFICATE_PASSWORD");
  required("MACOS_CERTIFICATE_SHA256");
  bundle.macOS = { hardenedRuntime: true };
  bundle.targets = ["app", "dmg"];
} else if (process.platform === "win32") {
  bundle.targets = ["nsis"];
} else {
  bundle.targets = ["appimage", "deb"];
}
const configuration = {
  bundle,
  plugins: { updater: { pubkey: updaterPublicKey, endpoints: [`https://github.com/${repository}/releases/latest/download/latest.json`] } },
};
await rm(bundleRoot, { recursive: true, force: true });
// Invoke the installed JavaScript CLI directly; Windows .cmd wrappers require a shell.
const cli = path.join(projectRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
function build() {
  execFileSync(process.execPath, [cli, "build", ...(process.platform === "linux" ? ["--verbose"] : []), "--config", JSON.stringify(configuration)], {
    cwd: desktopRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...(process.platform === "linux" ? {
        NO_STRIP: "true",
        LD_LIBRARY_PATH: [
          path.join(desktopRoot, "build-resources", "runtime", "lib", "server"),
          path.join(desktopRoot, "build-resources", "runtime", "lib"),
          process.env.LD_LIBRARY_PATH,
        ].filter(Boolean).join(path.delimiter),
      } : {}),
    },
  });
}
if (process.platform === "darwin") {
  await withMacSigning(path.join(desktopRoot, "build-resources"), async (identity) => {
    configuration.bundle.macOS.signingIdentity = identity;
    build();
    const apps = (await readdir(path.join(bundleRoot, "macos"))).filter(name => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("必须生成唯一的 macOS 应用");
    await verifyMacApplication(path.join(bundleRoot, "macos", apps[0]));
  });
} else build();

if (process.platform === "linux") {
  const directory = path.join(bundleRoot, "appimage");
  const entries = await readdir(directory);
  const images = entries.filter(name => name.endsWith(".AppImage"));
  const appDirs = entries.filter(name => name.endsWith(".AppDir"));
  if (images.length !== 1 || appDirs.length !== 1) throw new Error("必须生成唯一的 AppImage 与 AppDir");
  const image = path.join(directory, images[0]);
  const appDir = path.join(directory, appDirs[0]);
  const runtime = path.join(appDir, "usr", "lib", "tanwei", "runtime");
  // linuxdeploy 会重写 usr/lib 下的 ELF；保留供应商 JRE 原始字节及其完整性清单。
  await rm(runtime, { recursive: true, force: true });
  await cp(path.join(desktopRoot, "build-resources", "runtime"), runtime, {
    recursive: true, dereference: true, preserveTimestamps: true,
  });
  const tools = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "tauri");
  const packer = path.join(tools, "linuxdeploy-plugin-appimage.AppImage");
  const offset = Number(execFileSync(image, ["--appimage-offset"], { encoding: "utf8" }).trim());
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset > 16 * 1024 * 1024) throw new Error("AppImage 运行时边界无效");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tanwei-appimage-runtime-"));
  try {
    // 复用 Tauri 已生成的运行时，重打包不需要再次下载运行时。
    const runtimeFile = path.join(temporary, "runtime");
    await pipeline(createReadStream(image, { end: offset - 1 }), createWriteStream(runtimeFile, { flags: "wx", mode: 0o600 }));
    await rm(image);
    await rm(`${image}.sig`, { force: true });
    execFileSync(packer, ["--appimage-extract-and-run", "--appdir", appDir], {
      cwd: directory,
      stdio: "inherit",
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1", OUTPUT: image, LDAI_OUTPUT: image, LDAI_RUNTIME_FILE: runtimeFile, ARCH: architecture },
    });
    // 恢复 JRE 后重新生成的安装包必须重新签名，随后统一验证签名再发布。
    execFileSync(process.execPath, [cli, "signer", "sign", image], { cwd: desktopRoot, stdio: "inherit" });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.endsWith(".app")) files.push(...await filesUnder(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
const files = await filesUnder(bundleRoot);
const fileSet = new Set(files);
const updateFormats = process.platform === "darwin" ? [[".app.tar.gz", ""]] : process.platform === "win32" ? [[".exe", ""]] : [[".AppImage", "-appimage"], [".deb", "-deb"]];
const prefix = `tanwei-${version}-${platform}-${architecture}`;
const installSuffixes = [".app.tar.gz", ".AppImage", ".dmg", ".exe", ".deb"];
const platforms = {};
for (const [suffix, format] of updateFormats) {
  const candidates = files.filter((file) => file.endsWith(suffix) && fileSet.has(`${file}.sig`));
  if (candidates.length !== 1) throw new Error(`必须且只能生成一个带签名的 ${platform}/${architecture} ${suffix} 更新包`);
  const artifact = candidates[0];
  const signature = (await readFile(`${artifact}.sig`, "utf8")).trim();
  await verifyUpdaterSignature(artifact, signature, updaterPublicKey);
  platforms[`${platform}-${architecture}${format}`] = {
    signature,
    url: `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(`${prefix}${suffix}`)}`,
  };
}
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });
for (const file of files) {
  const suffix = installSuffixes.find((suffix) => file.endsWith(suffix));
  if (!suffix) continue;
  const name = `${prefix}${suffix}`;
  await copyFile(file, path.join(releaseRoot, name));
  if (fileSet.has(`${file}.sig`)) await copyFile(`${file}.sig`, path.join(releaseRoot, `${name}.sig`));
}
const manifest = {
  version,
  notes: `探微 ${releaseTag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
await writeFile(path.join(releaseRoot, `updater-${platform}-${architecture}.json`), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Signed Tauri release staged for ${platform}/${architecture}.`);
