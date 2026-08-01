import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { z } from "zod";
import { BUILD_METADATA } from "../shared/build-metadata.generated.js";

export type ComponentName =
  | "attach-helper"
  | "bootstrap"
  | "agent"
  | "protocol"
  | "decompiler"
  | "relay";

const COMPONENT_FILES: Readonly<Record<ComponentName, string>> =
  BUILD_METADATA.componentFiles;
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("tanwei"),
    productVersion: z.string().min(1),
    protocolVersion: z.string().min(1),
    platform: z.string().min(1),
    architecture: z.string().min(1),
    components: z.array(
      z
        .object({
          id: z.enum([
            "attach-helper",
            "bootstrap",
            "agent",
            "protocol",
            "relay",
            "decompiler",
          ]),
          version: z.string().min(1),
          file: z.string().regex(/^[a-zA-Z0-9._-]+$/),
          size: z.number().int().positive(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    nativeComponents: z
      .array(
        z.discriminatedUnion("id", [
          z
            .object({
              id: z.literal("async-profiler"),
              version: z.literal(BUILD_METADATA.asyncProfilerVersion),
              license: z.literal("Apache-2.0"),
              source: z.literal(
                "https://github.com/async-profiler/async-profiler",
              ),
              platforms: z.tuple([
                z.literal("linux-x64"),
                z.literal("linux-arm64"),
                z.literal("macos-x64"),
                z.literal("macos-arm64"),
              ]),
              embeddedIn: z.literal(BUILD_METADATA.componentFiles.agent),
              containerSha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
          z
            .object({
              id: z.literal("tanwei-heap-query"),
              version: z.literal(BUILD_METADATA.heapQueryVersion),
              license: z.literal("PolyForm-Noncommercial-1.0.0"),
              source: z.literal("jvm/native/heap_query.c"),
              platforms: z
                .array(
                  z.enum([
                    "linux-x64",
                    "linux-arm64",
                    "macos-x64",
                    "macos-arm64",
                    "windows-x64",
                  ]),
                )
                .length(1),
              embeddedIn: z.literal(BUILD_METADATA.componentFiles.agent),
              containerSha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        ]),
      )
      .length(2),
    runtimeFiles: z
      .array(
        z
          .object({
            file: z.enum([
              "bin/java",
              "bin/java.exe",
              "bin/javac",
              "bin/javac.exe",
              "bin/jfr",
              "bin/jfr.exe",
              "lib/modules",
            ]),
            size: z.number().int().positive(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(3),
  })
  .strict();
let packagedManifestPromise:
  | Promise<z.infer<typeof manifestSchema>>
  | undefined;
const packagedComponentPromises = new Map<ComponentName, Promise<string>>();

export interface JvmComponentDescriptor {
  readonly id: ComponentName;
  readonly path: string;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
}

function developmentPath(component: ComponentName): string {
  switch (component) {
    case "attach-helper":
      return path.join(
        "jvm",
        "attach-helper",
        "target",
        COMPONENT_FILES[component],
      );
    case "agent":
      return path.join("jvm", "agent", "target", COMPONENT_FILES[component]);
    case "bootstrap":
      return path.join(
        "jvm",
        "bootstrap",
        "target",
        COMPONENT_FILES[component],
      );
    case "protocol":
      return path.join(
        "jvm",
        "protocol",
        "src",
        "main",
        "proto",
        COMPONENT_FILES[component],
      );
    case "decompiler":
      return path.join(
        "jvm",
        "decompiler",
        "target",
        COMPONENT_FILES[component],
      );
    case "relay":
      return path.join(
        "jvm",
        "relay",
        "target",
        COMPONENT_FILES[component],
      );
    default:
      throw new Error(`未知 JVM 组件: ${String(component)}`);
  }
}

export async function resolveJvmComponent(
  component: ComponentName,
): Promise<string> {
  const environmentVariable =
    component === "attach-helper"
      ? process.env.TANWEI_ATTACH_HELPER_JAR
      : component === "bootstrap"
        ? process.env.TANWEI_BOOTSTRAP_JAR
      : component === "agent"
        ? process.env.TANWEI_AGENT_JAR
        : component === "decompiler"
          ? process.env.TANWEI_DECOMPILER_JAR
        : component === "relay"
          ? process.env.TANWEI_RELAY_JAR
        : process.env.TANWEI_PROTOCOL_PATH;
  const developmentRelativePath = developmentPath(component);
  if (app.isPackaged) {
    const cached = packagedComponentPromises.get(component);
    if (cached) {
      return cached;
    }
    const verification = verifyPackagedComponent(component);
    packagedComponentPromises.set(component, verification);
    return verification;
  }
  const candidates = [
    environmentVariable?.trim(),
    path.resolve(app.getAppPath(), "..", "..", developmentRelativePath),
    path.resolve(process.cwd(), "..", "..", developmentRelativePath),
    path.resolve(process.cwd(), developmentRelativePath),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through deterministic candidates.
    }
  }

  throw new Error(
    `找不到 Tanwei ${component} 组件；请先执行 npm run build:jvm`,
  );
}

export async function describeJvmComponent(
  component: ComponentName,
): Promise<JvmComponentDescriptor> {
  const componentPath = await resolveJvmComponent(component);
  const fileStat = await stat(componentPath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(`组件 ${component} 缺失或不是常规文件`);
  }
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(componentPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return {
    id: component,
    path: componentPath,
    file: COMPONENT_FILES[component],
    size: fileStat.size,
    sha256: hash.digest("hex"),
  };
}

export async function verifyPackagedInstallation(): Promise<void> {
  if (!app.isPackaged) {
    return;
  }
  const manifest = await (packagedManifestPromise ??= readPackagedManifest());
  await Promise.all(
    (Object.keys(COMPONENT_FILES) as ComponentName[]).map((component) =>
      resolveJvmComponent(component),
    ),
  );
  for (const runtimeFile of manifest.runtimeFiles) {
    const runtimePath = path.join(
      process.resourcesPath,
      "runtime",
      ...runtimeFile.file.split("/"),
    );
    await verifyFile(
      runtimePath,
      runtimeFile.size,
      runtimeFile.sha256,
      `运行时文件 ${runtimeFile.file}`,
    );
  }
  const agent = manifest.components.find((component) => component.id === "agent");
  const nativeProfiler = manifest.nativeComponents.find(
    (component) => component.id === "async-profiler",
  );
  const heapQuery = manifest.nativeComponents.find(
    (component) => component.id === "tanwei-heap-query",
  );
  const expectedHeapPlatform =
    `${
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : process.platform
    }-${process.arch}`;
  if (
    !agent ||
    !nativeProfiler ||
    !heapQuery ||
    nativeProfiler.containerSha256 !== agent.sha256 ||
    heapQuery.containerSha256 !== agent.sha256 ||
    heapQuery.platforms.length !== 1 ||
    heapQuery.platforms[0] !== expectedHeapPlatform
  ) {
    throw new Error("Native 组件清单与 Agent 容器或当前平台不一致");
  }
}

export function resolveJavaExecutable(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "runtime",
      "bin",
      process.platform === "win32" ? "java.exe" : "java",
    );
  }
  const configured = process.env.TANWEI_JAVA_HOME?.trim();
  if (!configured) {
    return "java";
  }
  return path.join(
    configured,
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
}

export function resolveJavacExecutable(): string {
  const executable = process.platform === "win32" ? "javac.exe" : "javac";
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "runtime", "bin", executable);
  }
  const configured = process.env.TANWEI_JAVA_HOME?.trim();
  return configured ? path.join(configured, "bin", executable) : executable;
}

export function resolveJfrExecutable(): string {
  const executable = process.platform === "win32" ? "jfr.exe" : "jfr";
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "runtime", "bin", executable);
  }
  const configured = process.env.TANWEI_JAVA_HOME?.trim();
  return configured ? path.join(configured, "bin", executable) : executable;
}

async function verifyPackagedComponent(
  component: ComponentName,
): Promise<string> {
  const manifest =
    await (packagedManifestPromise ??= readPackagedManifest());
  const entry = manifest.components.find((item) => item.id === component);
  if (
    !entry ||
    entry.file !== COMPONENT_FILES[component] ||
    entry.version !== componentVersion(component)
  ) {
    throw new Error(`组件清单缺少或错误声明 ${component}`);
  }
  const componentPath = path.join(process.resourcesPath, "jvm", entry.file);
  await verifyFile(
    componentPath,
    entry.size,
    entry.sha256,
    `组件 ${component}`,
  );
  return componentPath;
}

async function verifyFile(
  filePath: string,
  expectedSize: number,
  expectedHash: string,
  label: string,
): Promise<void> {
  const fileStat = await stat(filePath).catch((error: unknown) => {
    throw new Error(`${label} 缺失或不可读`, { cause: error });
  });
  if (!fileStat.isFile() || fileStat.size !== expectedSize) {
    throw new Error(`${label} 大小校验失败，已拒绝运行`);
  }
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  }).catch((error: unknown) => {
    throw new Error(`${label} 无法完成完整性校验`, { cause: error });
  });
  if (hash.digest("hex") !== expectedHash) {
    throw new Error(`${label} SHA-256 校验失败，已拒绝运行`);
  }
}

async function readPackagedManifest(): Promise<z.infer<typeof manifestSchema>> {
  const manifestPath = path.join(
    process.resourcesPath,
    "jvm",
    "component-manifest.json",
  );
  const content = await readFile(manifestPath, "utf8").catch(
    (error: unknown) => {
      throw new Error("探微组件清单缺失或不可读", { cause: error });
    },
  );
  const manifest = manifestSchema.parse(JSON.parse(content));
  if (
    manifest.productVersion !== BUILD_METADATA.productVersion ||
    manifest.protocolVersion !== BUILD_METADATA.protocolVersion
  ) {
    throw new Error("组件清单版本与 Host 构建元数据不一致");
  }
  if (
    manifest.platform !== process.platform ||
    manifest.architecture !== process.arch
  ) {
    throw new Error(
      `组件平台不匹配：${manifest.platform}/${manifest.architecture}，当前为 ${process.platform}/${process.arch}`,
    );
  }
  return manifest;
}

function componentVersion(component: ComponentName): string {
  if (component === "protocol") {
    return BUILD_METADATA.protocolVersion;
  }
  if (component === "decompiler") {
    return BUILD_METADATA.decompilerVersion;
  }
  return BUILD_METADATA.productVersion;
}
