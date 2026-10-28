import { execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MACH_O_HEADERS = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
export const MACOS_SIGNING_IDENTITY = "Tanwei Local Release";

export function validateMacCertificate(pem, fingerprint) {
  const expected = fingerprint?.replace(/[\s:]/gu, "").toUpperCase();
  if (!/^[A-F0-9]{64}$/u.test(expected ?? "")) throw new Error("macOS 发布证书需要有效的 SHA-256 指纹");
  const certificate = new X509Certificate(pem);
  if (certificate.fingerprint256.replaceAll(":", "") !== expected) throw new Error("macOS 发布证书指纹不匹配");
  if (!certificate.subject.split("\n").includes(`CN=${MACOS_SIGNING_IDENTITY}`) || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey)) {
    throw new Error("macOS 发布必须使用探微固定自签名证书");
  }
  if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error("macOS 发布证书不在有效期内");
  return certificate;
}

function signingCommand(command, args, timeout = 120_000) {
  try {
    return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout });
  } catch (error) {
    // execFileSync's default error contains argv, including keychain passwords.
    throw new Error(`macOS 运行时签名步骤 ${command} 失败（退出码 ${error.status ?? "未知"}）`);
  }
}

export async function runtimeMachOFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("签名前必须展开 Java 运行时符号链接");
    if (entry.isDirectory()) files.push(...await runtimeMachOFiles(filename));
    else if (entry.isFile() && !entry.name.endsWith(".class")) {
      const file = await open(filename, "r");
      try {
        const magic = Buffer.alloc(4);
        const { bytesRead } = await file.read(magic, 0, 4, 0);
        if (bytesRead === 4 && MACH_O_HEADERS.has(magic.toString("hex"))) files.push(filename);
      } finally { await file.close(); }
    }
  }
  return files;
}

export async function refreshRuntimeManifest(runtimeRoot, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest.runtimeFiles) || !manifest.runtimeFiles.length) throw new Error("组件清单缺少 Java 运行时完整性记录");
  for (const entry of manifest.runtimeFiles) {
    if (typeof entry.file !== "string" || !entry.file || entry.file.includes("\\") || entry.file.split("/").some((segment) => !segment || segment === "." || segment === "..") || path.isAbsolute(entry.file)) {
      throw new Error("组件清单包含无效运行时路径");
    }
    const filename = path.join(runtimeRoot, entry.file);
    const metadata = await stat(filename);
    if (!metadata.isFile()) throw new Error("组件清单运行时条目不是文件");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    entry.size = metadata.size;
    entry.sha256 = hash.digest("hex");
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function withMacSigning(stageRoot, build) {
  const runtimeRoot = path.join(stageRoot, "runtime");
  const files = await runtimeMachOFiles(runtimeRoot);
  if (!files.length) throw new Error("正式 macOS 包缺少可签名 Java 运行时");
  const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-runtime-signing-"));
  const certificate = path.join(directory, "certificate.p12");
  const certificatePem = path.join(directory, "certificate.pem");
  const keychain = path.join(directory, "runtime.keychain-db");
  const password = randomBytes(32).toString("hex");
  let keychainCreated = false;
  let trusted = false;
  let searchChanged = false;
  const admin = process.env.GITHUB_ACTIONS === "true";
  const originalKeychains = [...signingCommand("security", ["list-keychains", "-d", "user"]).toString().matchAll(/"([^"]+)"/gu)].map(match => match[1]);
  try {
    await writeFile(certificate, Buffer.from(process.env.MACOS_CERTIFICATE.replace(/\s+/gu, ""), "base64"), { mode: 0o600 });
    signingCommand("/usr/bin/openssl", ["pkcs12", "-in", certificate, "-nokeys", "-passin", "env:MACOS_CERTIFICATE_PASSWORD", "-out", certificatePem]);
    const identity = validateMacCertificate(await readFile(certificatePem), process.env.MACOS_CERTIFICATE_SHA256).fingerprint.replaceAll(":", "");
    signingCommand("security", ["create-keychain", "-p", password, keychain]);
    keychainCreated = true;
    signingCommand("security", ["unlock-keychain", "-p", password, keychain]);
    signingCommand("security", ["set-keychain-settings", "-t", "3600", "-u", keychain]);
    signingCommand("security", ["import", certificate, "-P", process.env.MACOS_CERTIFICATE_PASSWORD, "-T", "/usr/bin/codesign", "-k", keychain]);
    signingCommand("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]);
    // 只在构建期间信任本项目固定证书，随后恢复原有钥匙串和信任设置。
    const trustArgs = ["add-trusted-cert", ...(admin ? ["-d"] : []), "-r", "trustRoot", "-p", "codeSign", "-k", keychain, certificatePem];
    signingCommand(admin ? "sudo" : "security", admin ? ["-n", "security", ...trustArgs] : trustArgs);
    trusted = true;
    signingCommand("security", ["list-keychains", "-d", "user", "-s", keychain, ...originalKeychains]);
    searchChanged = true;
    for (const filename of files) {
      // Preserve the JDK vendor's JIT and library-validation entitlements. The
      // Rust Host keeps its own, narrower Tauri entitlements.
      signingCommand("codesign", ["--force", "--sign", identity, "--keychain", keychain, "--timestamp=none", "--options", "runtime", "--preserve-metadata=identifier,entitlements", filename]);
      signingCommand("codesign", ["--verify", "--strict", filename]);
    }
    signingCommand(path.join(runtimeRoot, "bin", "java"), ["-version"]);
    signingCommand(path.join(runtimeRoot, "bin", "javac"), ["-version"]);
    await refreshRuntimeManifest(runtimeRoot, path.join(stageRoot, "jvm", "component-manifest.json"));
    console.log(`Signed ${files.length} staged Java Mach-O files and refreshed runtime integrity metadata.`);
    return await build(identity);
  } finally {
    try {
      if (trusted) {
        const args = ["remove-trusted-cert", ...(admin ? ["-d"] : []), certificatePem];
        if (admin) {
          // 与 writer-agent 一致：临时 CI 主机的信任清理限时执行，仍继续删除私钥钥匙串。
          try {
            signingCommand("sudo", ["-n", "/usr/bin/perl", "-e", "alarm shift; exec @ARGV", "15", "/usr/bin/security", ...args], 20_000);
          } catch {
            console.warn("临时 CI 主机的证书信任清理未完成，继续恢复钥匙串并删除临时私钥。");
          }
        } else {
          signingCommand("security", args);
        }
      }
    } finally {
      try {
        if (searchChanged) signingCommand("security", ["list-keychains", "-d", "user", "-s", ...originalKeychains]);
      } finally {
        try {
          if (keychainCreated) signingCommand("security", ["delete-keychain", keychain]);
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  }
}

export async function verifyMacApplication(application) {
  signingCommand("codesign", ["--verify", "--deep", "--strict", application]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-app-certificate-"));
  try {
    const prefix = path.join(directory, "certificate");
    signingCommand("codesign", ["-d", `--extract-certificates=${prefix}`, application]);
    validateMacCertificate(await readFile(`${prefix}0`), process.env.MACOS_CERTIFICATE_SHA256);
    console.log(`Verified fixed self-signed macOS application: ${application}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
