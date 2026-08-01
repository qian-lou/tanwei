const PRODUCT_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const COMPONENT_VERSION_PATTERN =
  /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){1,2}$/u;

export function parseBuildMetadata(packageJson) {
  if (!isRecord(packageJson) || !isRecord(packageJson.tanweiBuild)) {
    throw new Error("根 package.json 缺少 tanweiBuild 元数据");
  }
  const productVersion = requiredVersion(
    packageJson.version,
    "productVersion",
    PRODUCT_VERSION_PATTERN,
  );
  const build = packageJson.tanweiBuild;
  return Object.freeze({
    productVersion,
    protocolVersion: requiredVersion(
      build.protocolVersion,
      "protocolVersion",
      COMPONENT_VERSION_PATTERN,
    ),
    decompilerVersion: requiredVersion(
      build.decompilerVersion,
      "decompilerVersion",
      COMPONENT_VERSION_PATTERN,
    ),
    asyncProfilerVersion: requiredVersion(
      build.asyncProfilerVersion,
      "asyncProfilerVersion",
      COMPONENT_VERSION_PATTERN,
    ),
    heapQueryVersion: requiredVersion(
      build.heapQueryVersion,
      "heapQueryVersion",
      PRODUCT_VERSION_PATTERN,
    ),
    boundedProfilerVersion: requiredVersion(
      build.boundedProfilerVersion,
      "boundedProfilerVersion",
      COMPONENT_VERSION_PATTERN,
    ),
  });
}

export function componentFiles(metadata) {
  const version = metadata.productVersion;
  return Object.freeze({
    "attach-helper": "tanwei-attach-helper-" + version + ".jar",
    bootstrap: "tanwei-bootstrap-" + version + ".jar",
    agent: "tanwei-agent-" + version + ".jar",
    protocol: "tanwei.proto",
    relay: "tanwei-relay-" + version + ".jar",
    decompiler: "tanwei-decompiler-" + version + ".jar",
  });
}

function requiredVersion(value, name, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error("构建元数据 " + name + " 格式无效");
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
