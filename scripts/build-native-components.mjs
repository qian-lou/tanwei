import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.join(projectRoot, "jvm", "native", "heap_query.c");

function platformIdentity() {
  const architecture =
    process.arch === "x64"
      ? "x64"
      : process.arch === "arm64"
        ? "arm64"
        : null;
  const operatingSystem =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "windows"
          : null;
  if (!architecture || !operatingSystem) {
    throw new Error(
      `不支持的 Native 构建平台：${process.platform}/${process.arch}`,
    );
  }
  return `${operatingSystem}-${architecture}`;
}

function javaHome() {
  const configured = process.env.JAVA_HOME?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  if (process.platform === "darwin") {
    return execFileSync("/usr/libexec/java_home", [], {
      encoding: "utf8",
    }).trim();
  }
  const command = process.platform === "win32" ? "where" : "which";
  const javaExecutable = execFileSync(command, ["java"], {
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .find(Boolean);
  if (!javaExecutable) {
    throw new Error("找不到用于 Native 构建的 JDK");
  }
  return path.resolve(path.dirname(realpathSync(javaExecutable)), "..");
}

const identity = platformIdentity();
const jdkRoot = javaHome();
const platformInclude =
  process.platform === "darwin"
    ? "darwin"
    : process.platform === "win32"
      ? "win32"
      : "linux";
const outputDirectory = path.join(
  projectRoot,
  "jvm",
  "agent",
  "target",
  "generated-native-resources",
  "META-INF",
  "tanwei-native",
  identity,
);
const outputFile = path.join(
  outputDirectory,
  process.platform === "win32"
    ? "tanwei_heap.dll"
    : process.platform === "darwin"
      ? "libtanwei_heap.dylib"
      : "libtanwei_heap.so",
);

await access(path.join(jdkRoot, "include", "jvmti.h"));
await mkdir(outputDirectory, { recursive: true });

const commonIncludes = [
  path.join(jdkRoot, "include"),
  path.join(jdkRoot, "include", platformInclude),
];
const invocation =
  process.platform === "win32"
    ? {
        command: "cl",
        arguments: [
          "/nologo",
          "/LD",
          "/O2",
          ...commonIncludes.map((directory) => `/I${directory}`),
          source,
          `/Fo:${path.join(outputDirectory, "heap_query.obj")}`,
          `/Fe:${outputFile}`,
        ],
      }
    : {
        command: process.env.CC?.trim() || "cc",
        arguments: [
          process.platform === "darwin" ? "-dynamiclib" : "-shared",
          "-O2",
          "-fPIC",
          "-Wall",
          "-Wextra",
          ...commonIncludes.flatMap((directory) => ["-I", directory]),
          source,
          "-o",
          outputFile,
        ],
      };
const result = spawnSync(invocation.command, invocation.arguments, {
  cwd: projectRoot,
  encoding: "utf8",
  stdio: "pipe",
});
if (result.status !== 0) {
  throw new Error(
    [
      `Native 组件编译失败：${invocation.command}`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
console.log(`Built JVMTI heap query for ${identity}.`);
