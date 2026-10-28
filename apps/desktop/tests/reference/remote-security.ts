import { createHash } from "node:crypto";

export interface NormalizedRemotePlatform {
  readonly platform: "linux" | "darwin";
  readonly architecture: "x64" | "arm64";
  readonly javaVersion: string;
}

const REMOTE_DIRECTORY_PATTERN = /^\/tmp\/tanwei-[a-f0-9-]{36}$/u;

export function normalizeRemotePlatform(
  systemValue: string,
  architectureValue: string,
  javaVersion: string,
): NormalizedRemotePlatform {
  const system = systemValue.trim().toLocaleLowerCase();
  const architecture = architectureValue.trim().toLocaleLowerCase();
  const platform =
    system === "linux"
      ? "linux"
      : system === "darwin"
        ? "darwin"
        : null;
  const normalizedArchitecture =
    architecture === "x86_64" || architecture === "amd64"
      ? "x64"
      : architecture === "aarch64" || architecture === "arm64"
        ? "arm64"
        : null;
  if (!platform || !normalizedArchitecture) {
    throw new Error(
      `远程平台 ${systemValue.trim()}/${architectureValue.trim()} 不受支持`,
    );
  }
  const versionLine = javaVersion
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!versionLine) {
    throw new Error("远程目标未返回 Java 版本");
  }
  return {
    platform,
    architecture: normalizedArchitecture,
    javaVersion: versionLine,
  };
}

export function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function isSafeRemoteDirectory(value: string): boolean {
  return REMOTE_DIRECTORY_PATTERN.test(value);
}

export function stableRemoteTargetId(
  mode: "ssh" | "kubernetes" | "persistent",
  identity: string,
  pid: number,
): string {
  const digest = createHash("sha256")
    .update(`${mode}\0${identity}\0${pid}`)
    .digest("hex")
    .slice(0, 24);
  return `remote:${mode}:${digest}`;
}
