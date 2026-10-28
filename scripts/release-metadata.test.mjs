import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";
import { refreshRuntimeManifest, runtimeMachOFiles, validateMacCertificate } from "./sign-macos-runtime.mjs";
import { X509Certificate } from "node:crypto";
import yaml from "js-yaml";
const execute = promisify(execFile);
const script = path.resolve("scripts/merge-update-manifests.mjs");
const formats = new Map([["darwin-aarch64", ".app.tar.gz"], ["darwin-x86_64", ".app.tar.gz"], ["linux-x86_64-appimage", ".AppImage"], ["linux-x86_64-deb", ".deb"], ["windows-x86_64", ".exe"]]);
const platforms = [...formats.keys()];

test("macOS release accepts only its pinned self-signed certificate", async () => {
  const pem = await readFile(new URL("./fixtures/macos-release-cert.pem", import.meta.url));
  const certificate = new X509Certificate(pem);
  assert.equal(validateMacCertificate(pem, certificate.fingerprint256).subject, certificate.subject);
  assert.throws(() => validateMacCertificate(pem, "0".repeat(64)), /指纹不匹配/u);
  assert.throws(() => validateMacCertificate(pem, "invalid"), /有效的 SHA-256/u);
});

test("four-platform release keeps update signatures without official certificate gates", async () => {
  const source = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const workflow = yaml.load(source);
  assert.equal(workflow.jobs.package.strategy.matrix.include.length, 4);
  const credentials = workflow.jobs.package.steps.find(step => step.name === "Require updater keys and fixed macOS certificate").env;
  for (const name of ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "TANWEI_UPDATER_PUBLIC_KEY", "MACOS_CERTIFICATE", "MACOS_CERTIFICATE_PASSWORD", "MACOS_CERTIFICATE_SHA256"]) assert(credentials[name]);
  assert.doesNotMatch(source, /APPLE_ID|APPLE_TEAM_ID|APPLE_PASSWORD|WINDOWS_CERTIFICATE|notarytool|spctl/u);
  assert.deepEqual(workflow.jobs.publish.needs, ["preflight", "package"]);
  assert(workflow.jobs.package.steps.some(step => step.run === "npm run package:release"));
});
async function fixture(directory, selected = platforms) {
  for (const platform of selected) {
    const file = `tanwei-${platform}${formats.get(platform)}`;
    await writeFile(path.join(directory, file), "signed artifact fixture");
    await writeFile(path.join(directory, `${file}.sig`), `signature-${platform}`);
    await writeFile(path.join(directory, `updater-${platform}.json`), JSON.stringify({ version: "1.2.3", pub_date: "2026-01-01T00:00:00.000Z", platforms: { [platform]: { signature: `signature-${platform}`, url: `https://github.com/tanwei/test/releases/download/v1.2.3/${file}` } } }));
  }
}
function merge(directory) { return execute(process.execPath, [script, directory], { env: { ...process.env, GITHUB_REPOSITORY: "tanwei/test", GITHUB_REF_NAME: "v1.2.3", TANWEI_RELEASE_TAG: "v1.2.3" } }); }

test("updater release metadata requires all platforms and both Linux installer formats", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-release-test-"));
  try {
    await fixture(directory, platforms.slice(0, 3));
    await assert.rejects(merge(directory), /全部四个/u);
    await fixture(directory, platforms.slice(3));
    await merge(directory);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(directory, "latest.json"), "utf8")).platforms).sort(), [...platforms].sort());
    await writeFile(path.join(directory, "tanwei-windows-x86_64.exe.sig"), "tampered");
    await assert.rejects(merge(directory), /签名与产物不匹配/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("runtime signing selects Mach-O files and rebinds only runtime integrity records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-runtime-manifest-"));
  try {
    const runtime = path.join(directory, "runtime");
    await mkdir(path.join(runtime, "bin"), { recursive: true });
    const binary = Buffer.from("cffaedfe01020304", "hex");
    await writeFile(path.join(runtime, "bin", "java"), binary);
    await writeFile(path.join(runtime, "Example.class"), Buffer.from("cafebabe01020304", "hex"));
    await writeFile(path.join(runtime, "license"), "text");
    assert.deepEqual(await runtimeMachOFiles(runtime), [path.join(runtime, "bin", "java")]);
    const manifest = path.join(directory, "manifest.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, components: [{ id: "agent", sha256: "preserve" }], runtimeFiles: [{ file: "bin/java", size: 0, sha256: "old" }] }));
    await refreshRuntimeManifest(runtime, manifest);
    const updated = JSON.parse(await readFile(manifest, "utf8"));
    assert.deepEqual(updated.components, [{ id: "agent", sha256: "preserve" }]);
    assert.deepEqual(updated.runtimeFiles, [{ file: "bin/java", size: binary.length, sha256: createHash("sha256").update(binary).digest("hex") }]);
    updated.runtimeFiles[0].file = "../outside";
    await writeFile(manifest, JSON.stringify(updated));
    await assert.rejects(refreshRuntimeManifest(runtime, manifest), /无效运行时路径/u);
    if (process.platform !== "win32") {
      await symlink(path.join(runtime, "bin", "java"), path.join(runtime, "redirect"));
      await assert.rejects(runtimeMachOFiles(runtime), /符号链接/u);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("release gate verifies real Tauri CLI signatures and rejects artifact, comment and key changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-updater-signature-"));
  const cli = path.resolve("node_modules/@tauri-apps/cli/tauri.js");
  const keyPath = path.join(directory, "test.key");
  const artifact = path.join(directory, "test.AppImage");
  const environment = { ...process.env };
  delete environment.TAURI_SIGNING_PRIVATE_KEY;
  delete environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  try {
    await execute(process.execPath, [cli, "signer", "generate", "--ci", "--password", "test-only", "--write-keys", keyPath], { env: environment });
    await writeFile(artifact, "updater signature integration fixture");
    await execute(process.execPath, [cli, "signer", "sign", "--private-key-path", keyPath, "--password", "test-only", artifact], { env: environment });
    const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
    const signature = (await readFile(`${artifact}.sig`, "utf8")).trim();
    await verifyUpdaterSignature(artifact, signature, publicKey);
    await writeFile(artifact, "modified artifact");
    await assert.rejects(verifyUpdaterSignature(artifact, signature, publicKey), /签名验证失败/u);
    await writeFile(artifact, "updater signature integration fixture");
    const modified = Buffer.from(signature, "base64").toString("utf8").trimEnd().split(/\r?\n/u);
    modified[2] = "trusted comment: tampered";
    await assert.rejects(verifyUpdaterSignature(artifact, Buffer.from(modified.join("\n")).toString("base64"), publicKey), /签名验证失败/u);
    const lines = Buffer.from(publicKey, "base64").toString("utf8").trimEnd().split(/\r?\n/u);
    const data = Buffer.from(lines[1], "base64");
    data[2] ^= 1;
    lines[1] = data.toString("base64");
    await assert.rejects(verifyUpdaterSignature(artifact, signature, Buffer.from(lines.join("\n")).toString("base64")), /内置公钥不匹配/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
