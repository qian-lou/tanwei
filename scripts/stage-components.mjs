import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  componentFiles,
  parseBuildMetadata,
} from "./build-metadata.mjs";

const projectRoot = process.cwd();
execFileSync(
  process.execPath,
  [path.join(projectRoot, "scripts", "sync-build-metadata.mjs"), "--check"],
  { stdio: "inherit" },
);
const buildMetadata = parseBuildMetadata(
  JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ),
);
const componentFileNames = componentFiles(buildMetadata);
const stageRoot = path.join(
  projectRoot,
  "apps",
  "desktop",
  "build-resources",
);
const jvmStageRoot = path.join(stageRoot, "jvm");
const runtimeStageRoot = path.join(stageRoot, "runtime");
const licensesStageRoot = path.join(stageRoot, "licenses");
const components = [
  {
    id: "attach-helper",
    version: buildMetadata.productVersion,
    source: path.join(
      projectRoot,
      "jvm",
      "attach-helper",
      "target",
      componentFileNames["attach-helper"],
    ),
    file: componentFileNames["attach-helper"],
  },
  {
    id: "bootstrap",
    version: buildMetadata.productVersion,
    source: path.join(
      projectRoot,
      "jvm",
      "bootstrap",
      "target",
      componentFileNames.bootstrap,
    ),
    file: componentFileNames.bootstrap,
  },
  {
    id: "agent",
    version: buildMetadata.productVersion,
    source: path.join(
      projectRoot,
      "jvm",
      "agent",
      "target",
      componentFileNames.agent,
    ),
    file: componentFileNames.agent,
  },
  {
    id: "protocol",
    version: buildMetadata.protocolVersion,
    source: path.join(
      projectRoot,
      "jvm",
      "protocol",
      "src",
      "main",
      "proto",
      componentFileNames.protocol,
    ),
    file: componentFileNames.protocol,
  },
  {
    id: "relay",
    version: buildMetadata.productVersion,
    source: path.join(
      projectRoot,
      "jvm",
      "relay",
      "target",
      componentFileNames.relay,
    ),
    file: componentFileNames.relay,
  },
  {
    id: "decompiler",
    version: buildMetadata.decompilerVersion,
    source: path.join(
      projectRoot,
      "jvm",
      "decompiler",
      "target",
      componentFileNames.decompiler,
    ),
    file: componentFileNames.decompiler,
  },
];

await rm(stageRoot, { recursive: true, force: true });
await mkdir(jvmStageRoot, { recursive: true });
await mkdir(licensesStageRoot, { recursive: true });

const manifestComponents = [];
for (const component of components) {
  const sourceStat = await stat(component.source).catch(() => null);
  if (!sourceStat?.isFile()) {
    throw new Error(
      `缺少 ${component.id} 构建产物：${component.source}；请先执行 npm run build:jvm`,
    );
  }
  const destination = path.join(jvmStageRoot, component.file);
  await cp(component.source, destination);
  const content = await readFile(destination);
  manifestComponents.push({
    id: component.id,
    version: component.version,
    file: component.file,
    size: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
const nativePlatform =
  `${
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform
  }-${process.arch}`;
const heapLibraryFile =
  process.platform === "win32"
    ? "tanwei_heap.dll"
    : process.platform === "darwin"
      ? "libtanwei_heap.dylib"
      : "libtanwei_heap.so";
const heapResource =
  `META-INF/tanwei-native/${nativePlatform}/${heapLibraryFile}`;
const stagedAgent = await readFile(
  path.join(jvmStageRoot, componentFileNames.agent),
);
if (!stagedAgent.includes(Buffer.from(heapResource, "utf8"))) {
  throw new Error(`Agent 未包含当前平台 JVMTI 组件：${heapResource}`);
}
const agentSha256 =
  manifestComponents.find((component) => component.id === "agent")
    ?.sha256 ?? "";

const manifest = {
  schemaVersion: 1,
  product: "tanwei",
  productVersion: buildMetadata.productVersion,
  protocolVersion: buildMetadata.protocolVersion,
  platform: process.platform,
  architecture: process.arch,
  components: manifestComponents,
  nativeComponents: [
    {
      id: "async-profiler",
      version: buildMetadata.asyncProfilerVersion,
      license: "Apache-2.0",
      source: "https://github.com/async-profiler/async-profiler",
      platforms: ["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"],
      embeddedIn: componentFileNames.agent,
      containerSha256: agentSha256,
    },
    {
      id: "tanwei-heap-query",
      version: buildMetadata.heapQueryVersion,
      license: "PolyForm-Noncommercial-1.0.0",
      source: "jvm/native/heap_query.c",
      platforms: [nativePlatform],
      embeddedIn: componentFileNames.agent,
      containerSha256: agentSha256,
    },
  ],
  runtimeFiles: [],
};

for (const licenseFile of [
  "THIRD_PARTY_NOTICES.md",
  "async-profiler-LICENSE.txt",
]) {
  await cp(
    path.join(projectRoot, "licenses", licenseFile),
    path.join(licensesStageRoot, licenseFile),
  );
}
await cp(
  path.join(projectRoot, "LICENSE"),
  path.join(licensesStageRoot, "TANWEI-LICENSE.md"),
);

if (process.env.TANWEI_SKIP_RUNTIME !== "1") {
  const javaHome = process.env.JAVA_HOME?.trim();
  const jlink =
    javaHome
      ? path.join(
          javaHome,
          "bin",
          process.platform === "win32" ? "jlink.exe" : "jlink",
        )
      : process.platform === "win32"
        ? "jlink.exe"
        : "jlink";
  execFileSync(
    jlink,
    [
      "--add-modules",
      "java.base,java.instrument,java.logging,java.management,jdk.attach,jdk.compiler,jdk.management,jdk.jfr,jdk.unsupported",
      "--strip-debug",
      "--no-header-files",
      "--no-man-pages",
      "--compress=2",
      "--output",
      runtimeStageRoot,
    ],
    { stdio: "inherit" },
  );
  for (const relativeFile of [
    path.join("bin", process.platform === "win32" ? "java.exe" : "java"),
    path.join("bin", process.platform === "win32" ? "javac.exe" : "javac"),
    path.join("bin", process.platform === "win32" ? "jfr.exe" : "jfr"),
    path.join("lib", "modules"),
  ]) {
    const runtimeFile = path.join(runtimeStageRoot, relativeFile);
    const content = await readFile(runtimeFile);
    manifest.runtimeFiles.push({
      file: relativeFile.replaceAll(path.sep, "/"),
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
}

await writeFile(
  path.join(jvmStageRoot, "component-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(
  `Staged ${manifestComponents.length} verified components for ${process.platform}/${process.arch}.`,
);
