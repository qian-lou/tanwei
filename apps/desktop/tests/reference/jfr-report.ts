import type {
  JfrAllocationSummary,
  JfrCompilationSummary,
  JfrCompilerTierSummary,
  JfrCpuSample,
  JfrDeoptimizationSummary,
  JfrGcPauseSummary,
  JfrHotMethodSummary,
  JfrInspectionReport,
} from "../../src/shared/contracts.js";

const MAXIMUM_EVENTS = 200_000;
const MAXIMUM_EVENT_TYPES = 100;
const MAXIMUM_HOT_METHODS = 50;
const MAXIMUM_ALLOCATIONS = 50;
const MAXIMUM_CPU_SAMPLES = 300;
const MAXIMUM_GC_PAUSES = 100;
const MAXIMUM_COMPILATION_GROUPS = 20_000;
const MAXIMUM_DEOPTIMIZATION_GROUPS = 20_000;
const MAXIMUM_COMPILATIONS = 50;
const MAXIMUM_DEOPTIMIZATIONS = 50;
const MAXIMUM_STRING_LENGTH = 4_096;

type UnknownRecord = Readonly<Record<string, unknown>>;
type CompilerTier = JfrCompilerTierSummary["compiler"];
type CompilationAccumulator = Omit<JfrCompilationSummary, "method" | "compiler" | "compileLevel">;
type CompilerTierAccumulator = Omit<JfrCompilerTierSummary, "compiler">;
type DeoptimizationAccumulator = Omit<
  JfrDeoptimizationSummary,
  "method" | "compiler" | "reason" | "action"
>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_STRING_LENGTH
    ? value
    : null;
}

function boundedNumber(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : 0;
}

function normalizedClassName(value: string | null): string {
  return value?.replaceAll("/", ".") ?? "(unknown)";
}

function methodName(values: UnknownRecord): string | null {
  const stackTrace = record(values.stackTrace);
  const frames = stackTrace?.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    return null;
  }
  const method = record(record(frames[0])?.method);
  const owner = normalizedClassName(
    stringValue(record(method?.type)?.name),
  );
  const name = stringValue(method?.name);
  return name ? `${owner}.${name}` : null;
}

function qualifiedMethodName(value: unknown): string | null {
  const method = record(value);
  const owner = normalizedClassName(
    stringValue(record(method?.type)?.name),
  );
  const name = stringValue(method?.name);
  if (!name) {
    return null;
  }
  const descriptor = stringValue(method?.descriptor)?.replaceAll("/", ".");
  return `${owner}.${name}${descriptor ?? ""}`;
}

function compilerTier(value: unknown): CompilerTier {
  const compiler = stringValue(value)?.toLocaleLowerCase();
  if (compiler === "c1") {
    return "C1";
  }
  if (compiler === "c2") {
    return "C2";
  }
  return "OTHER";
}

function compileLevel(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 255
    ? value
    : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function durationMillis(value: unknown): number {
  if (typeof value === "number") {
    return boundedNumber(value);
  }
  if (typeof value !== "string") {
    return 0;
  }
  const match =
    /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/u.exec(
      value,
    );
  if (!match) {
    return 0;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const millis = (hours * 3_600 + minutes * 60 + seconds) * 1_000;
  return Number.isFinite(millis) && millis >= 0 ? millis : 0;
}

function timestamp(
  value: unknown,
): { readonly iso: string; readonly epochMillis: number } | null {
  const iso = stringValue(value);
  if (!iso) {
    return null;
  }
  const epochMillis = Date.parse(iso);
  return Number.isFinite(epochMillis) ? { iso, epochMillis } : null;
}

function topEntries(
  values: ReadonlyMap<string, number>,
  limit: number,
): readonly (readonly [string, number])[] {
  return [...values.entries()]
    .sort(
      ([leftName, leftValue], [rightName, rightValue]) =>
        rightValue - leftValue || leftName.localeCompare(rightName),
    )
    .slice(0, limit);
}

function topAllocations(
  values: ReadonlyMap<
    string,
    { readonly samples: number; readonly estimatedBytes: number }
  >,
): readonly JfrAllocationSummary[] {
  return [...values.entries()]
    .map(([className, summary]) => ({ className, ...summary }))
    .sort(
      (left, right) =>
        right.estimatedBytes - left.estimatedBytes ||
        right.samples - left.samples ||
        left.className.localeCompare(right.className),
    )
    .slice(0, MAXIMUM_ALLOCATIONS);
}

function topCompilations(
  values: ReadonlyMap<
    string,
    {
      readonly method: string;
      readonly compiler: CompilerTier;
      readonly compileLevel: number | null;
      readonly summary: CompilationAccumulator;
    }
  >,
): readonly JfrCompilationSummary[] {
  return [...values.values()]
    .map((value) => ({
      method: value.method,
      compiler: value.compiler,
      compileLevel: value.compileLevel,
      ...value.summary,
    }))
    .sort(
      (left, right) =>
        right.totalDurationMillis - left.totalDurationMillis ||
        right.codeBytes - left.codeBytes ||
        right.compilations - left.compilations ||
        left.method.localeCompare(right.method),
    )
    .slice(0, MAXIMUM_COMPILATIONS);
}

function topDeoptimizations(
  values: ReadonlyMap<
    string,
    {
      readonly method: string;
      readonly compiler: CompilerTier;
      readonly reason: string;
      readonly action: string;
      readonly summary: DeoptimizationAccumulator;
    }
  >,
): readonly JfrDeoptimizationSummary[] {
  return [...values.values()]
    .map((value) => ({
      method: value.method,
      compiler: value.compiler,
      reason: value.reason,
      action: value.action,
      ...value.summary,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.reason.localeCompare(right.reason) ||
        left.method.localeCompare(right.method),
    )
    .slice(0, MAXIMUM_DEOPTIMIZATIONS);
}

export function parseJfrReportJson(
  content: string,
  artifactId: string,
): JfrInspectionReport {
  const root = record(JSON.parse(content));
  const events = record(root?.recording)?.events;
  if (!Array.isArray(events)) {
    throw new Error("JFR JSON 缺少事件列表");
  }
  if (events.length > MAXIMUM_EVENTS) {
    throw new Error(`JFR 事件超过 ${MAXIMUM_EVENTS.toLocaleString()} 条安全上限`);
  }

  const eventTypes = new Map<string, number>();
  const hotMethods = new Map<string, number>();
  const allocations = new Map<
    string,
    { readonly samples: number; readonly estimatedBytes: number }
  >();
  const cpuSamples: JfrCpuSample[] = [];
  const gcPauses: JfrGcPauseSummary[] = [];
  const compilationGroups = new Map<
    string,
    {
      readonly method: string;
      readonly compiler: CompilerTier;
      readonly compileLevel: number | null;
      readonly summary: CompilationAccumulator;
    }
  >();
  const compilerTiers = new Map<CompilerTier, CompilerTierAccumulator>();
  const deoptimizationGroups = new Map<
    string,
    {
      readonly method: string;
      readonly compiler: CompilerTier;
      readonly reason: string;
      readonly action: string;
      readonly summary: DeoptimizationAccumulator;
    }
  >();
  let compilationCount = 0;
  let deoptimizationCount = 0;
  let compilationDurationMillis = 0;
  let compiledCodeBytes = 0;
  let compilationGroupsTruncated = false;
  let deoptimizationGroupsTruncated = false;
  let minimumTime: { readonly iso: string; readonly epochMillis: number } | null =
    null;
  let maximumTime: { readonly iso: string; readonly epochMillis: number } | null =
    null;

  for (const rawEvent of events) {
    const event = record(rawEvent);
    const type = stringValue(event?.type);
    const values = record(event?.values);
    if (!type || !values) {
      continue;
    }
    eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
    const capturedAt = timestamp(values.startTime);
    if (capturedAt) {
      if (!minimumTime || capturedAt.epochMillis < minimumTime.epochMillis) {
        minimumTime = capturedAt;
      }
      if (!maximumTime || capturedAt.epochMillis > maximumTime.epochMillis) {
        maximumTime = capturedAt;
      }
    }

    if (type === "jdk.ExecutionSample" || type === "jdk.NativeMethodSample") {
      const method = methodName(values);
      if (method) {
        hotMethods.set(method, (hotMethods.get(method) ?? 0) + 1);
      }
    } else if (type === "jdk.ObjectAllocationSample") {
      const className = normalizedClassName(
        stringValue(record(values.objectClass)?.name),
      );
      const current = allocations.get(className) ?? {
        samples: 0,
        estimatedBytes: 0,
      };
      allocations.set(className, {
        samples: current.samples + 1,
        estimatedBytes: current.estimatedBytes + boundedNumber(values.weight),
      });
    } else if (
      type === "jdk.CPULoad" &&
      capturedAt &&
      cpuSamples.length < MAXIMUM_CPU_SAMPLES
    ) {
      cpuSamples.push({
        capturedAt: capturedAt.iso,
        jvmUser: boundedNumber(values.jvmUser),
        jvmSystem: boundedNumber(values.jvmSystem),
        machineTotal: boundedNumber(values.machineTotal),
      });
    } else if (
      (type === "jdk.GarbageCollection" ||
        type === "jdk.GCPhasePause") &&
      capturedAt &&
      gcPauses.length < MAXIMUM_GC_PAUSES
    ) {
      gcPauses.push({
        capturedAt: capturedAt.iso,
        name:
          stringValue(values.name) ??
          (type === "jdk.GCPhasePause" ? "GC Phase Pause" : "Garbage Collection"),
        cause: stringValue(values.cause) ?? "",
        durationMillis: durationMillis(values.duration),
      });
    } else if (type === "jdk.Compilation") {
      const duration = durationMillis(values.duration);
      const codeBytes = boundedNumber(values.codeSize);
      const inlinedBytes = boundedNumber(values.inlinedBytes);
      const compiler = compilerTier(values.compiler);
      const level = compileLevel(values.compileLevel);
      const osr = booleanValue(values.isOsr) === true;
      const succeeded =
        booleanValue(values.succeded) ?? booleanValue(values.succeeded);
      compilationCount += 1;
      compilationDurationMillis += duration;
      compiledCodeBytes += codeBytes;

      const tier = compilerTiers.get(compiler) ?? {
        compilations: 0,
        osrCompilations: 0,
        failedCompilations: 0,
        totalDurationMillis: 0,
        codeBytes: 0,
      };
      compilerTiers.set(compiler, {
        compilations: tier.compilations + 1,
        osrCompilations: tier.osrCompilations + (osr ? 1 : 0),
        failedCompilations:
          tier.failedCompilations + (succeeded === false ? 1 : 0),
        totalDurationMillis: tier.totalDurationMillis + duration,
        codeBytes: tier.codeBytes + codeBytes,
      });

      const method = qualifiedMethodName(values.method);
      if (!method) {
        continue;
      }
      const key = JSON.stringify([method, compiler, level]);
      const current = compilationGroups.get(key);
      if (!current && compilationGroups.size >= MAXIMUM_COMPILATION_GROUPS) {
        compilationGroupsTruncated = true;
        continue;
      }
      const summary = current?.summary ?? {
        compilations: 0,
        osrCompilations: 0,
        succeededCompilations: 0,
        failedCompilations: 0,
        unknownOutcomeCompilations: 0,
        totalDurationMillis: 0,
        maximumDurationMillis: 0,
        codeBytes: 0,
        inlinedBytes: 0,
      };
      compilationGroups.set(key, {
        method,
        compiler,
        compileLevel: level,
        summary: {
          compilations: summary.compilations + 1,
          osrCompilations: summary.osrCompilations + (osr ? 1 : 0),
          succeededCompilations:
            summary.succeededCompilations + (succeeded === true ? 1 : 0),
          failedCompilations:
            summary.failedCompilations + (succeeded === false ? 1 : 0),
          unknownOutcomeCompilations:
            summary.unknownOutcomeCompilations + (succeeded === null ? 1 : 0),
          totalDurationMillis: summary.totalDurationMillis + duration,
          maximumDurationMillis: Math.max(
            summary.maximumDurationMillis,
            duration,
          ),
          codeBytes: summary.codeBytes + codeBytes,
          inlinedBytes: summary.inlinedBytes + inlinedBytes,
        },
      });
    } else if (type === "jdk.Deoptimization") {
      deoptimizationCount += 1;
      const method = qualifiedMethodName(values.method);
      if (!method) {
        continue;
      }
      const compiler = compilerTier(values.compiler);
      const reason = stringValue(values.reason) ?? "(unknown)";
      const action = stringValue(values.action) ?? "(unknown)";
      const key = JSON.stringify([method, compiler, reason, action]);
      const current = deoptimizationGroups.get(key);
      if (
        !current &&
        deoptimizationGroups.size >= MAXIMUM_DEOPTIMIZATION_GROUPS
      ) {
        deoptimizationGroupsTruncated = true;
        continue;
      }
      deoptimizationGroups.set(key, {
        method,
        compiler,
        reason,
        action,
        summary: {
          count: (current?.summary.count ?? 0) + 1,
        },
      });
    }
  }

  const totalMethodSamples = [...hotMethods.values()].reduce(
    (total, value) => total + value,
    0,
  );
  const methodSummaries: readonly JfrHotMethodSummary[] = topEntries(
    hotMethods,
    MAXIMUM_HOT_METHODS,
  ).map(([method, samples]) => ({
    method,
    samples,
    sharePercent:
      totalMethodSamples === 0 ? 0 : (samples * 100) / totalMethodSamples,
  }));
  const eventTypeSummaries = topEntries(eventTypes, MAXIMUM_EVENT_TYPES).map(
    ([type, count]) => ({ type, count }),
  );
  const allocationSummaries = topAllocations(allocations);
  const compilationSummaries = topCompilations(compilationGroups);
  const compilerTierSummaries = (["C1", "C2", "OTHER"] as const)
    .flatMap((compiler) => {
      const summary = compilerTiers.get(compiler);
      return summary ? [{ compiler, ...summary }] : [];
    });
  const deoptimizationSummaries = topDeoptimizations(deoptimizationGroups);
  const duration =
    minimumTime && maximumTime
      ? Math.max(0, maximumTime.epochMillis - minimumTime.epochMillis)
      : 0;

  return {
    artifactId,
    eventCount: events.length,
    startedAt: minimumTime?.iso ?? null,
    endedAt: maximumTime?.iso ?? null,
    durationMillis: duration,
    eventTypes: eventTypeSummaries,
    hotMethods: methodSummaries,
    allocations: allocationSummaries,
    cpuSamples,
    gcPauses,
    compilationCount,
    deoptimizationCount,
    compilationDurationMillis,
    compiledCodeBytes,
    compilations: compilationSummaries,
    compilerTiers: compilerTierSummaries,
    deoptimizations: deoptimizationSummaries,
    truncated:
      eventTypes.size > MAXIMUM_EVENT_TYPES ||
      hotMethods.size > MAXIMUM_HOT_METHODS ||
      allocations.size > MAXIMUM_ALLOCATIONS ||
      compilationGroups.size > MAXIMUM_COMPILATIONS ||
      deoptimizationGroups.size > MAXIMUM_DEOPTIMIZATIONS ||
      compilationGroupsTruncated ||
      deoptimizationGroupsTruncated,
  };
}
