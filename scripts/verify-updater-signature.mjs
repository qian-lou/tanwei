import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";

function decode(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Tauri 更新签名编码无效");
  }
  return Buffer.from(value, "base64");
}

// Tauri encodes a Minisign document in Base64. Use Node's Ed25519 implementation
// and stream its BLAKE2b prehash so release archives need not fit in memory.
export async function verifyUpdaterSignature(artifact, encodedSignature, encodedPublicKey) {
  const publicLines = decode(encodedPublicKey.trim()).toString("utf8").trimEnd().split(/\r?\n/u);
  const signatureLines = decode(encodedSignature.trim()).toString("utf8").trimEnd().split(/\r?\n/u);
  if (publicLines.length !== 2 || signatureLines.length !== 4 || !signatureLines[2].startsWith("trusted comment: ")) {
    throw new Error("Tauri 更新签名文档无效");
  }
  const publicData = decode(publicLines[1]);
  const signatureData = decode(signatureLines[1]);
  const commentSignature = decode(signatureLines[3]);
  if (publicData.length !== 42 || publicData.subarray(0, 2).toString("ascii") !== "Ed" || signatureData.length !== 74 || signatureData.subarray(0, 2).toString("ascii") !== "ED" || commentSignature.length !== 64) {
    throw new Error("Tauri 更新必须使用 Ed25519/BLAKE2b 签名");
  }
  if (!publicData.subarray(2, 10).equals(signatureData.subarray(2, 10))) {
    throw new Error("Tauri 更新签名与内置公钥不匹配");
  }
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicData.subarray(10)]), format: "der", type: "spki" });
  const hash = createHash("blake2b512");
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  const signature = signatureData.subarray(10);
  const trustedComment = Buffer.from(signatureLines[2].slice("trusted comment: ".length), "utf8");
  if (!verify(null, hash.digest(), publicKey, signature) || !verify(null, Buffer.concat([signature, trustedComment]), publicKey, commentSignature)) {
    throw new Error("Tauri 更新产物或可信注释签名验证失败");
  }
}
