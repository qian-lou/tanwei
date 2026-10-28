import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  componentFiles,
  parseBuildMetadata,
} from "./build-metadata.mjs";

const projectRoot = process.cwd();
const write = process.argv.includes("--write");
const unexpectedArguments = process.argv.slice(2).filter(
  (argument) => argument !== "--write" && argument !== "--check",
);
if (unexpectedArguments.length > 0) {
  throw new Error("未知参数：" + unexpectedArguments.join(", "));
}

const rootPackage = await readJson(path.join(projectRoot, "package.json"));
const metadata = parseBuildMetadata(rootPackage);
const files = componentFiles(metadata);
const generatedTypeScriptPath = path.join(
  projectRoot,
  "apps",
  "desktop",
  "src",
  "shared",
  "build-metadata.generated.ts",
);
const generatedJavaPath = path.join(
  projectRoot,
  "jvm",
  "protocol",
  "src",
  "main",
  "java",
  "dev",
  "tanwei",
  "protocol",
  "BuildMetadata.java",
);
const generatedFiles = new Map([
  [generatedTypeScriptPath, renderTypeScript(metadata, files)],
  [generatedJavaPath, renderJava(metadata)],
]);
const packagePaths = [
  path.join(projectRoot, "apps", "desktop", "package.json"),
  path.join(projectRoot, "packages", "plugin-sdk", "package.json"),
];
const tauriConfigPath = path.join(projectRoot, "apps/desktop/src-tauri/tauri.conf.json");
const cargoManifestPath = path.join(projectRoot, "apps/desktop/src-tauri/Cargo.toml");
const cargoLockPath = path.join(projectRoot, "apps/desktop/src-tauri/Cargo.lock");
const rustVersionPattern = /(name = "tanwei-desktop"\r?\nversion = ")[^"]+("\r?\n)/u;
const pomPaths = [
  path.join(projectRoot, "jvm", "pom.xml"),
  path.join(projectRoot, "jvm", "protocol", "pom.xml"),
  path.join(projectRoot, "jvm", "agent", "pom.xml"),
  path.join(projectRoot, "jvm", "bootstrap", "pom.xml"),
  path.join(projectRoot, "jvm", "attach-helper", "pom.xml"),
  path.join(projectRoot, "jvm", "decompiler", "pom.xml"),
  path.join(projectRoot, "jvm", "relay", "pom.xml"),
  path.join(projectRoot, "jvm", "integration-tests", "pom.xml"),
];

if (write) {
  const tauriConfig = await readJson(tauriConfigPath);
  tauriConfig.version = metadata.productVersion;
  await writeJson(tauriConfigPath, tauriConfig);
  for (const rustPath of [cargoManifestPath, cargoLockPath]) {
    const content = await readFile(rustPath, "utf8");
    if (!rustVersionPattern.test(content)) throw new Error("无法定位 Rust 应用版本：" + rustPath);
    await writeFile(rustPath, content.replace(rustVersionPattern, "$1" + metadata.productVersion + "$2"));
  }
  for (const [filePath, content] of generatedFiles) {
    await writeFile(filePath, content, "utf8");
  }
  for (const packagePath of packagePaths) {
    const packageJson = await readJson(packagePath);
    packageJson.version = metadata.productVersion;
    await writeJson(packagePath, packageJson);
  }
  const packageLockPath = path.join(projectRoot, "package-lock.json");
  const packageLock = await readJson(packageLockPath);
  packageLock.version = metadata.productVersion;
  for (const packageKey of ["", "apps/desktop", "packages/plugin-sdk"]) {
    if (!isRecord(packageLock.packages?.[packageKey])) {
      throw new Error("package-lock.json 缺少 workspace：" + packageKey);
    }
    packageLock.packages[packageKey].version = metadata.productVersion;
  }
  await writeJson(packageLockPath, packageLock);
  for (const pomPath of pomPaths) {
    const content = await readFile(pomPath, "utf8");
    await writeFile(
      pomPath,
      replaceParentVersion(content, metadata.productVersion, pomPath),
      "utf8",
    );
  }
}

const errors = [];
if ((await readJson(tauriConfigPath)).version !== metadata.productVersion) errors.push("tauri.conf.json 版本不一致");
for (const rustPath of [cargoManifestPath, cargoLockPath]) {
  const content = await readFile(rustPath, "utf8");
  const expected = content.replace(rustVersionPattern, "$1" + metadata.productVersion + "$2");
  if (!rustVersionPattern.test(content) || content !== expected) errors.push(path.relative(projectRoot, rustPath) + " 版本不一致");
}
for (const [filePath, expected] of generatedFiles) {
  const actual = await readFile(filePath, "utf8").catch(() => "");
  if (actual !== expected) {
    errors.push(path.relative(projectRoot, filePath) + " 未同步");
  }
}
for (const packagePath of packagePaths) {
  const packageJson = await readJson(packagePath);
  if (packageJson.version !== metadata.productVersion) {
    errors.push(path.relative(projectRoot, packagePath) + " 版本不一致");
  }
}
const packageLock = await readJson(path.join(projectRoot, "package-lock.json"));
if (
  packageLock.version !== metadata.productVersion ||
  packageLock.packages?.[""]?.version !== metadata.productVersion ||
  packageLock.packages?.["apps/desktop"]?.version !== metadata.productVersion ||
  packageLock.packages?.["packages/plugin-sdk"]?.version !==
    metadata.productVersion
) {
  errors.push("package-lock.json workspace 版本不一致");
}
for (const pomPath of pomPaths) {
  const content = await readFile(pomPath, "utf8");
  if (parentVersion(content) !== metadata.productVersion) {
    errors.push(path.relative(projectRoot, pomPath) + " 版本不一致");
  }
}

if (errors.length > 0) {
  throw new Error(
    "构建元数据校验失败：\n- " +
      errors.join("\n- ") +
      "\n请执行 npm run metadata:sync",
  );
}

console.log(
  "Build metadata " +
    (write ? "synchronized" : "verified") +
    " for Tanwei " +
    metadata.productVersion +
    " / protocol " +
    metadata.protocolVersion +
    ".",
);

function renderTypeScript(value, componentFileNames) {
  return [
    "// Generated by scripts/sync-build-metadata.mjs. Do not edit directly.",
    "export const BUILD_METADATA = {",
    '  productVersion: "' + value.productVersion + '",',
    '  protocolVersion: "' + value.protocolVersion + '",',
    '  decompilerVersion: "' + value.decompilerVersion + '",',
    '  asyncProfilerVersion: "' + value.asyncProfilerVersion + '",',
    '  heapQueryVersion: "' + value.heapQueryVersion + '",',
    '  boundedProfilerVersion: "' + value.boundedProfilerVersion + '",',
    "  componentFiles: {",
    '    "attach-helper": "' + componentFileNames["attach-helper"] + '",',
    '    bootstrap: "' + componentFileNames.bootstrap + '",',
    '    agent: "' + componentFileNames.agent + '",',
    '    protocol: "' + componentFileNames.protocol + '",',
    '    relay: "' + componentFileNames.relay + '",',
    '    decompiler: "' + componentFileNames.decompiler + '",',
    "  },",
    "} as const;",
    "",
  ].join("\n");
}

function renderJava(value) {
  return [
    "package dev.tanwei.protocol;",
    "",
    "// Generated by scripts/sync-build-metadata.mjs. Do not edit directly.",
    "public final class BuildMetadata {",
    '  public static final String PRODUCT_VERSION = "' +
      value.productVersion +
      '";',
    '  public static final String PROTOCOL_VERSION = "' +
      value.protocolVersion +
      '";',
    '  public static final String DECOMPILER_VERSION = "' +
      value.decompilerVersion +
      '";',
    '  public static final String ASYNC_PROFILER_VERSION = "' +
      value.asyncProfilerVersion +
      '";',
    '  public static final String HEAP_QUERY_VERSION = "' +
      value.heapQueryVersion +
      '";',
    '  public static final String BOUNDED_PROFILER_VERSION = "' +
      value.boundedProfilerVersion +
      '";',
    "",
    "  private BuildMetadata() {}",
    "}",
    "",
  ].join("\n");
}

function replaceParentVersion(content, version, filePath) {
  const pattern =
    /(<artifactId>tanwei-jvm-parent<\/artifactId>\s*<version>)[^<]+(<\/version>)/u;
  if (!pattern.test(content)) {
    throw new Error("无法定位 Maven 版本：" + filePath);
  }
  return content.replace(pattern, "$1" + version + "$2");
}

function parentVersion(content) {
  const match =
    /<artifactId>tanwei-jvm-parent<\/artifactId>\s*<version>([^<]+)<\/version>/u.exec(
      content,
    );
  return match?.[1] ?? null;
}

async function readJson(filePath) {
  const content = await readFile(filePath, "utf8");
  const value = JSON.parse(content);
  if (!isRecord(value)) {
    throw new Error("JSON 根必须是对象：" + filePath);
  }
  return value;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
