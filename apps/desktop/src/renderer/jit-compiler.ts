import type {
  CodeCachePressureState,
  JitTrendRecording,
  JitTrendSample,
} from "@shared/contracts";
import { codeCachePressure } from "@shared/jit-trend";

export const MAXIMUM_JIT_TREND_SAMPLES = 120;
const MAXIMUM_CODE_CACHE_POOLS = 8;
const MAXIMUM_INTERNAL_COUNTERS = 20_000;
const MAXIMUM_TEXT_LENGTH = 4_096;

export interface JitCodeCachePool {
  readonly name: string;
  readonly usedBytes: number;
  readonly committedBytes: number;
  readonly maxBytes: number | null;
  readonly peakUsedBytes: number | null;
}

export interface JitCompilationEvent {
  readonly method: string | null;
  readonly type: string | null;
  readonly sizeBytes: number | null;
}

export interface JitCompilerSnapshot {
  readonly sampledAtEpochMillis: number;
  readonly compiler: {
    readonly available: boolean;
    readonly name: string;
    readonly timeSupported: boolean;
    readonly totalTimeMillis: number | null;
  };
  readonly internal: {
    readonly available: boolean;
    readonly reason: string;
    readonly counterCount: number;
    readonly truncated: boolean;
  };
  readonly metrics: {
    readonly totalCompiles: number | null;
    readonly standardCompiles: number | null;
    readonly osrCompiles: number | null;
    readonly bailouts: number | null;
    readonly invalidations: number | null;
    readonly nmethodCodeBytes: number | null;
    readonly nmethodTotalBytes: number | null;
  };
  readonly codeCache: {
    readonly pools: readonly JitCodeCachePool[];
    readonly truncated: boolean;
    readonly totalUsedBytes: number;
    readonly totalCommittedBytes: number;
    readonly totalMaxBytes: number | null;
    readonly totalMaxComplete: boolean;
  };
  readonly last: {
    readonly success: JitCompilationEvent;
    readonly failed: JitCompilationEvent;
    readonly invalidated: JitCompilationEvent;
  };
}

export interface JitCompilerTrendSummary {
  readonly current: JitCompilerSnapshot | null;
  readonly compilesPerSecond: number | null;
  readonly failuresPerSecond: number | null;
  readonly compilationTimePercent: number | null;
  readonly codeCacheGrowthBytesPerSecond: number | null;
  readonly compilePoints: readonly number[];
  readonly codeCachePoints: readonly number[];
}

export interface JitCodeCachePressure {
  readonly percent: number;
  readonly state: CodeCachePressureState;
  readonly capacityBytes: number;
  readonly capacityKind: "MAX" | "COMMITTED";
}

function parseBoolean(
  values: Readonly<Record<string, string>>,
  key: string,
): boolean {
  const value = values[key];
  if (value !== "true" && value !== "false") {
    throw new Error(`JIT compiler response has invalid ${key}`);
  }
  return value === "true";
}

function parseUnsigned(
  values: Readonly<Record<string, string>>,
  key: string,
  options: {
    readonly optional?: boolean;
    readonly maximum?: number;
  } = {},
): number | null {
  const value = values[key];
  if ((value === undefined || value === "") && options.optional) {
    return null;
  }
  if (value === undefined || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`JIT compiler response has invalid ${key}`);
  }
  const parsed = Number(value);
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`JIT compiler response exceeds ${key} boundary`);
  }
  return parsed;
}

function requiredUnsigned(
  values: Readonly<Record<string, string>>,
  key: string,
  maximum?: number,
): number {
  const parsed = parseUnsigned(
    values,
    key,
    maximum === undefined ? {} : { maximum },
  );
  if (parsed === null) {
    throw new Error(`JIT compiler response is missing ${key}`);
  }
  return parsed;
}

function parseText(
  values: Readonly<Record<string, string>>,
  key: string,
  options: {
    readonly optional?: boolean;
    readonly allowEmpty?: boolean;
  } = {},
): string | null {
  const value = values[key];
  if (value === undefined && options.optional) {
    return null;
  }
  if (
    value === undefined ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > MAXIMUM_TEXT_LENGTH
  ) {
    throw new Error(`JIT compiler response has invalid ${key}`);
  }
  return value;
}

function parseEvent(
  values: Readonly<Record<string, string>>,
  prefix: string,
): JitCompilationEvent {
  return {
    method: parseText(values, `${prefix}.method`, {
      optional: true,
      allowEmpty: true,
    }),
    type: parseText(values, `${prefix}.type`, {
      optional: true,
      allowEmpty: true,
    }),
    sizeBytes: parseUnsigned(values, `${prefix}.sizeBytes`, {
      optional: true,
    }),
  };
}

export function parseJitCompilerSnapshot(
  values: Readonly<Record<string, string>>,
): JitCompilerSnapshot {
  if (values.schemaVersion !== "1") {
    throw new Error("JIT compiler response schema is not supported");
  }
  const sampledAtEpochMillis = requiredUnsigned(
    values,
    "sampledAtEpochMillis",
  );
  if (sampledAtEpochMillis <= 0) {
    throw new Error("JIT compiler response has invalid sample time");
  }

  const compilerAvailable = parseBoolean(values, "compiler.available");
  const compilerName =
    parseText(values, "compiler.name", {
      allowEmpty: !compilerAvailable,
    }) ?? "";
  const timeSupported = parseBoolean(
    values,
    "compiler.timeSupported",
  );
  const totalTimeMillis = parseUnsigned(
    values,
    "compiler.totalTimeMillis",
    { optional: true },
  );
  if (!timeSupported && totalTimeMillis !== null) {
    throw new Error(
      "JIT compiler response reports time without monitoring support",
    );
  }

  const poolCount = requiredUnsigned(
    values,
    "codeCache.count",
    MAXIMUM_CODE_CACHE_POOLS,
  );
  const pools = Array.from(
    { length: poolCount },
    (_, index): JitCodeCachePool => {
      const prefix = `codeCache.${String(index).padStart(2, "0")}.`;
      return {
        name: parseText(values, `${prefix}name`) ?? "",
        usedBytes: requiredUnsigned(values, `${prefix}usedBytes`),
        committedBytes: requiredUnsigned(
          values,
          `${prefix}committedBytes`,
        ),
        maxBytes: parseUnsigned(values, `${prefix}maxBytes`, {
          optional: true,
        }),
        peakUsedBytes: parseUnsigned(
          values,
          `${prefix}peakUsedBytes`,
          { optional: true },
        ),
      };
    },
  );
  const totalUsedBytes = requiredUnsigned(
    values,
    "codeCache.totalUsedBytes",
  );
  const totalCommittedBytes = requiredUnsigned(
    values,
    "codeCache.totalCommittedBytes",
  );
  const totalMaxBytes = parseUnsigned(
    values,
    "codeCache.totalMaxBytes",
    { optional: true },
  );
  const expectedUsedBytes = pools.reduce(
    (total, pool) => total + pool.usedBytes,
    0,
  );
  const expectedCommittedBytes = pools.reduce(
    (total, pool) => total + pool.committedBytes,
    0,
  );
  const expectedMaximumBytes = pools.reduce(
    (total, pool) => total + (pool.maxBytes ?? 0),
    0,
  );
  if (
    !Number.isSafeInteger(expectedUsedBytes) ||
    !Number.isSafeInteger(expectedCommittedBytes) ||
    !Number.isSafeInteger(expectedMaximumBytes) ||
    expectedUsedBytes !== totalUsedBytes ||
    expectedCommittedBytes !== totalCommittedBytes ||
    (totalMaxBytes !== null && totalMaxBytes !== expectedMaximumBytes)
  ) {
    throw new Error("JIT compiler response has inconsistent code cache totals");
  }

  return {
    sampledAtEpochMillis,
    compiler: {
      available: compilerAvailable,
      name: compilerName,
      timeSupported,
      totalTimeMillis,
    },
    internal: {
      available: parseBoolean(values, "internal.available"),
      reason:
        parseText(values, "internal.reason", { allowEmpty: true }) ?? "",
      counterCount: requiredUnsigned(
        values,
        "internal.counterCount",
        MAXIMUM_INTERNAL_COUNTERS,
      ),
      truncated: parseBoolean(values, "internal.truncated"),
    },
    metrics: {
      totalCompiles: parseUnsigned(values, "metric.totalCompiles", {
        optional: true,
      }),
      standardCompiles: parseUnsigned(
        values,
        "metric.standardCompiles",
        { optional: true },
      ),
      osrCompiles: parseUnsigned(values, "metric.osrCompiles", {
        optional: true,
      }),
      bailouts: parseUnsigned(values, "metric.bailouts", {
        optional: true,
      }),
      invalidations: parseUnsigned(values, "metric.invalidations", {
        optional: true,
      }),
      nmethodCodeBytes: parseUnsigned(
        values,
        "metric.nmethodCodeBytes",
        { optional: true },
      ),
      nmethodTotalBytes: parseUnsigned(
        values,
        "metric.nmethodTotalBytes",
        { optional: true },
      ),
    },
    codeCache: {
      pools,
      truncated: parseBoolean(values, "codeCache.truncated"),
      totalUsedBytes,
      totalCommittedBytes,
      totalMaxBytes,
      totalMaxComplete: parseBoolean(
        values,
        "codeCache.totalMaxComplete",
      ),
    },
    last: {
      success: parseEvent(values, "last.success"),
      failed: parseEvent(values, "last.failed"),
      invalidated: parseEvent(values, "last.invalidated"),
    },
  };
}

export function appendJitCompilerSample(
  samples: readonly JitCompilerSnapshot[],
  sample: JitCompilerSnapshot,
): readonly JitCompilerSnapshot[] {
  const previous = samples[samples.length - 1];
  if (
    previous &&
    sample.sampledAtEpochMillis < previous.sampledAtEpochMillis
  ) {
    return samples;
  }
  return [...samples, sample].slice(-MAXIMUM_JIT_TREND_SAMPLES);
}

export function jitCodeCachePressure(
  snapshot: JitCompilerSnapshot,
): JitCodeCachePressure {
  const completeMaximum =
    snapshot.codeCache.totalMaxComplete &&
    snapshot.codeCache.totalMaxBytes !== null &&
    snapshot.codeCache.totalMaxBytes > 0;
  const capacityBytes = completeMaximum
    ? snapshot.codeCache.totalMaxBytes!
    : snapshot.codeCache.totalCommittedBytes;
  const pressure = codeCachePressure(
    snapshot.codeCache.totalUsedBytes,
    capacityBytes,
  );
  return {
    ...pressure,
    capacityBytes,
    capacityKind: completeMaximum ? "MAX" : "COMMITTED",
  };
}

export function buildJitTrendRecording(
  samples: readonly JitCompilerSnapshot[],
  targetId: string,
  jvmStartTimeEpochMillis: number,
  samplingIntervalMillis: JitTrendRecording["samplingIntervalMillis"],
): JitTrendRecording | null {
  if (
    !targetId.trim() ||
    !Number.isSafeInteger(jvmStartTimeEpochMillis) ||
    jvmStartTimeEpochMillis <= 0
  ) {
    return null;
  }
  const compacted: JitTrendSample[] = [];
  for (const snapshot of samples) {
    if (snapshot.sampledAtEpochMillis < jvmStartTimeEpochMillis) {
      continue;
    }
    let pressure: JitCodeCachePressure;
    try {
      pressure = jitCodeCachePressure(snapshot);
    } catch {
      continue;
    }
    const sample: JitTrendSample = {
      sampledAtEpochMillis: snapshot.sampledAtEpochMillis,
      totalCompiles: snapshot.metrics.totalCompiles,
      standardCompiles: snapshot.metrics.standardCompiles,
      osrCompiles: snapshot.metrics.osrCompiles,
      bailouts: snapshot.metrics.bailouts,
      invalidations: snapshot.metrics.invalidations,
      compilerTimeMillis: snapshot.compiler.totalTimeMillis,
      codeCacheUsedBytes: snapshot.codeCache.totalUsedBytes,
      codeCacheCapacityBytes: pressure.capacityBytes,
      codeCacheCapacityKind: pressure.capacityKind,
    };
    const previous = compacted.at(-1);
    if (previous && sample.sampledAtEpochMillis < previous.sampledAtEpochMillis) {
      continue;
    }
    if (previous?.sampledAtEpochMillis === sample.sampledAtEpochMillis) {
      compacted[compacted.length - 1] = sample;
    } else {
      compacted.push(sample);
    }
  }
  return compacted.length < 2
    ? null
    : {
        targetId,
        jvmStartTimeEpochMillis,
        samplingIntervalMillis,
        samples: compacted.slice(-MAXIMUM_JIT_TREND_SAMPLES),
      };
}

function monotonicRate(
  previous: number | null,
  current: number | null,
  elapsedSeconds: number,
): number | null {
  if (
    previous === null ||
    current === null ||
    current < previous ||
    elapsedSeconds <= 0
  ) {
    return null;
  }
  return (current - previous) / elapsedSeconds;
}

export function summarizeJitCompilerTrend(
  samples: readonly JitCompilerSnapshot[],
): JitCompilerTrendSummary {
  const current = samples[samples.length - 1] ?? null;
  const previous = samples[samples.length - 2] ?? null;
  const elapsedMillis =
    current && previous
      ? current.sampledAtEpochMillis - previous.sampledAtEpochMillis
      : 0;
  const elapsedSeconds = elapsedMillis / 1_000;
  const currentFailures =
    current?.metrics.bailouts === null ||
    current?.metrics.invalidations === null
      ? null
      : (current?.metrics.bailouts ?? 0) +
        (current?.metrics.invalidations ?? 0);
  const previousFailures =
    previous?.metrics.bailouts === null ||
    previous?.metrics.invalidations === null
      ? null
      : (previous?.metrics.bailouts ?? 0) +
        (previous?.metrics.invalidations ?? 0);
  const compilationTimeRate = monotonicRate(
    previous?.compiler.totalTimeMillis ?? null,
    current?.compiler.totalTimeMillis ?? null,
    elapsedSeconds,
  );
  return {
    current,
    compilesPerSecond: monotonicRate(
      previous?.metrics.totalCompiles ?? null,
      current?.metrics.totalCompiles ?? null,
      elapsedSeconds,
    ),
    failuresPerSecond: monotonicRate(
      previousFailures,
      currentFailures,
      elapsedSeconds,
    ),
    compilationTimePercent:
      compilationTimeRate === null ? null : compilationTimeRate / 10,
    codeCacheGrowthBytesPerSecond:
      current && previous && elapsedSeconds > 0
        ? (current.codeCache.totalUsedBytes -
            previous.codeCache.totalUsedBytes) /
          elapsedSeconds
        : null,
    compilePoints: samples.flatMap((sample) =>
      sample.metrics.totalCompiles === null
        ? []
        : [sample.metrics.totalCompiles],
    ),
    codeCachePoints: samples.map(
      (sample) => sample.codeCache.totalUsedBytes,
    ),
  };
}
