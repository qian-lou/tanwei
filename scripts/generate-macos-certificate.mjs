import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MACOS_SIGNING_IDENTITY } from "./sign-macos-runtime.mjs";

const output = path.resolve(process.argv[2] ?? "");
const password = process.env.MACOS_CERTIFICATE_PASSWORD;
if (process.platform !== "darwin" || !process.argv[2]) throw new Error("请在 macOS 指定仓库外的空备份目录");
if (output === process.cwd() || output.startsWith(`${process.cwd()}${path.sep}`)) throw new Error("证书私钥不能放在源码仓库中");
if (!password || password.length < 24) throw new Error("MACOS_CERTIFICATE_PASSWORD 至少需要 24 个字符");
process.umask(0o077);
await mkdir(output, { mode: 0o700 });
const key = path.join(output, "private-key.pem");
const pem = path.join(output, "certificate.pem");
const p12 = path.join(output, "certificate.p12");
function openssl(args) {
  try { return execFileSync("/usr/bin/openssl", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }); }
  catch { throw new Error("生成 macOS 自签名证书失败，未输出私钥或密码"); }
}
try {
  openssl(["req", "-new", "-newkey", "rsa:3072", "-x509", "-sha256", "-days", "7300", "-subj", `/CN=${MACOS_SIGNING_IDENTITY}/O=Tanwei`, "-addext", "basicConstraints=critical,CA:true,pathlen:0", "-addext", "keyUsage=critical,digitalSignature,keyCertSign,cRLSign", "-addext", "extendedKeyUsage=critical,codeSigning", "-passout", "env:MACOS_CERTIFICATE_PASSWORD", "-keyout", key, "-out", pem]);
  openssl(["pkcs12", "-export", "-inkey", key, "-passin", "env:MACOS_CERTIFICATE_PASSWORD", "-in", pem, "-name", MACOS_SIGNING_IDENTITY, "-passout", "env:MACOS_CERTIFICATE_PASSWORD", "-out", p12]);
  const certificate = new X509Certificate(await readFile(pem));
  await writeFile(path.join(output, "certificate.sha256"), `${certificate.fingerprint256.replaceAll(":", "")}\n`, { mode: 0o600, flag: "wx" });
  await chmod(p12, 0o600);
  console.log(`固定自签名证书已生成：${output}`);
} finally { await rm(key, { force: true }); }
