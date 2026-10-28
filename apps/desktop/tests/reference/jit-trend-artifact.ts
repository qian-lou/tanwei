import { Buffer } from "node:buffer";
import { z } from "zod";
import type {
  JitTrendComparison,
  JitTrendInspectionReport,
  JitTrendComparisonMode,
  JitTrendRecording,
  JitTrendSample,
  JitTrendSummary,
} from "../../src/shared/contracts.js";
import { codeCachePressure } from "../../src/shared/jit-trend.js";

export const MAXIMUM_JIT_TREND_ARTIFACT_BYTES = 256 * 1_024;

const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const optionalCounter = safeCount.nullable();
const boundedIdentityText = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);

export const jitRegressionIdentitySchema = z
  .object({
    workloadKey: boundedIdentityText,
    releaseLabel: boundedIdentityText,
    targetMainClass: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
    javaVersion: boundedIdentityText,
    compilerName: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
  })
  .strict();

const jitTrendSampleSchema = z
  .object({
    sampledAtEpochMillis: safeCount.min(1),
    totalCompiles: optionalCounter,
    standardCompiles: optionalCounter,
    osrCompiles: optionalCounter,
    bailouts: optionalCounter,
    invalidations: optionalCounter,
    compilerTimeMillis: optionalCounter,
    codeCacheUsedBytes: safeCount,
    codeCacheCapacityBytes: safeCount.min(1),
    codeCacheCapacityKind: z.enum(["MAX", "COMMITTED"]),
  })
  .strict()
  .superRefine((sample, context) => {
    if (sample.codeCacheUsedBytes > sample.codeCacheCapacityBytes) {
      context.addIssue({
        code: "custom",
        path: ["codeCacheUsedBytes"],
        message: "Code Cache usage cannot exceed its capacity boundary",
      });
    }
  });

const MONOTONIC_FIELDS = [
  "totalCompiles",
  "standardCompiles",
  "osrCompiles",
  "bailouts",
  "invalidations",
  "compilerTimeMillis",
] as const satisfies readonly (keyof JitTrendSample)[];

export const jitTrendRecordingSchema = z
  .object({
    targetId: z
      .string()
      .min(1)
      .max(560)
      .regex(
        /^(?:local:\d+|remote:(?:ssh|kubernetes|persistent):[a-f0-9]{24})$/u,
      ),
    jvmStartTimeEpochMillis: safeCount.min(1),
    samplingIntervalMillis: z.union([
      z.literal(1_000),
      z.literal(2_000),
      z.literal(5_000),
      z.literal(10_000),
    ]),
    samples: z.array(jitTrendSampleSchema).min(2).max(120),
    regressionIdentity: jitRegressionIdentitySchema.optional(),
  })
  .strict()
  .superRefine((recording, context) => {
    let previous: JitTrendSample | null = null;
    const first = recording.samples[0];
    for (const [index, sample] of recording.samples.entries()) {
      if (sample.sampledAtEpochMillis < recording.jvmStartTimeEpochMillis) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "sampledAtEpochMillis"],
          message: "JIT trend sample predates the JVM startup cycle",
        });
      }
      if (
        previous &&
        sample.sampledAtEpochMillis <= previous.sampledAtEpochMillis
      ) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "sampledAtEpochMillis"],
          message: "JIT trend samples must be strictly chronological",
        });
      }
      if (
        first &&
        sample.codeCacheCapacityKind !== first.codeCacheCapacityKind
      ) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "codeCacheCapacityKind"],
          message: "Code Cache capacity semantics changed within one window",
        });
      }
      if (
        first?.codeCacheCapacityKind === "MAX" &&
        sample.codeCacheCapacityBytes !== first.codeCacheCapacityBytes
      ) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "codeCacheCapacityBytes"],
          message: "Maximum Code Cache capacity changed within one JVM cycle",
        });
      }
      if (previous) {
        for (const field of MONOTONIC_FIELDS) {
          const earlier = previous[field];
          const current = sample[field];
          if (
            typeof earlier === "number" &&
            typeof current === "number" &&
            current < earlier
          ) {
            context.addIssue({
              code: "custom",
              path: ["samples", index, field],
              message: `${field} regressed within one JVM cycle`,
            });
          }
        }
      }
      previous = sample;
    }
    const last = recording.samples.at(-1);
    if (
      first &&
      last &&
      last.sampledAtEpochMillis - first.sampledAtEpochMillis >
        24 * 60 * 60 * 1_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["samples"],
        message: "JIT trend duration exceeds 24 hours",
      });
    }
  });

const jitTrendArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("tanwei"),
    kind: z.literal("jit-trend"),
    recording: jitTrendRecordingSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.recording.regressionIdentity) {
      context.addIssue({
        code: "custom",
        path: ["recording", "regressionIdentity"],
        message: "JIT trend v1 cannot contain a regression identity",
      });
    }
  });

const jitTrendArtifactV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    product: z.literal("tanwei"),
    kind: z.literal("jit-trend"),
    recording: jitTrendRecordingSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    if (!artifact.recording.regressionIdentity) {
      context.addIssue({
        code: "custom",
        path: ["recording", "regressionIdentity"],
        message: "JIT trend v2 requires a regression identity",
      });
    }
  });

const jitTrendArtifactSchema = z.union([
  jitTrendArtifactV1Schema,
  jitTrendArtifactV2Schema,
]);

function normalizeJitTrendRecording(
  parsed: z.infer<typeof jitTrendRecordingSchema>,
): JitTrendRecording {
  const { regressionIdentity, ...recording } = parsed;
  return regressionIdentity ? { ...recording, regressionIdentity } : recording;
}

export function serializeJitTrendArtifact(
  recording: JitTrendRecording,
): Buffer {
  const validated = normalizeJitTrendRecording(
    jitTrendRecordingSchema.parse(recording),
  );
  const schemaVersion = validated.regressionIdentity ? 2 : 1;
  const content = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion,
        product: "tanwei",
        kind: "jit-trend",
        recording: validated,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (content.byteLength > MAXIMUM_JIT_TREND_ARTIFACT_BYTES) {
    throw new Error("JIT trend exceeds the artifact size boundary");
  }
  return content;
}

export function parseJitTrendArtifact(
  content: string,
  artifactId: string,
): JitTrendInspectionReport {
  if (!artifactId.trim() || artifactId.length > 128) {
    throw new Error("JIT trend artifact id is invalid");
  }
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes <= 0 || contentBytes > MAXIMUM_JIT_TREND_ARTIFACT_BYTES) {
    throw new Error("JIT trend exceeds the artifact size boundary");
  }
  const parsed = jitTrendArtifactSchema.parse(JSON.parse(content));
  const recording = normalizeJitTrendRecording(parsed.recording);
  return {
    artifactId,
    schemaVersion: parsed.schemaVersion,
    recording,
    summary: summarizeValidatedRecording(recording),
  };
}

export function summarizeJitTrend(
  recording: JitTrendRecording,
): JitTrendSummary {
  return summarizeValidatedRecording(
    normalizeJitTrendRecording(jitTrendRecordingSchema.parse(recording)),
  );
}

function summarizeValidatedRecording(
  recording: JitTrendRecording,
): JitTrendSummary {
  const first = recording.samples[0];
  const last = recording.samples.at(-1);
  if (!first || !last) {
    throw new Error("JIT trend requires at least two samples");
  }
  const durationMillis = last.sampledAtEpochMillis - first.sampledAtEpochMillis;
  const durationSeconds = durationMillis / 1_000;
  const compileDelta = counterDelta(first.totalCompiles, last.totalCompiles);
  const standardCompileDelta = counterDelta(
    first.standardCompiles,
    last.standardCompiles,
  );
  const osrCompileDelta = counterDelta(first.osrCompiles, last.osrCompiles);
  const bailoutDelta = counterDelta(first.bailouts, last.bailouts);
  const invalidationDelta = counterDelta(
    first.invalidations,
    last.invalidations,
  );
  const failureDelta =
    bailoutDelta === null || invalidationDelta === null
      ? null
      : bailoutDelta + invalidationDelta;
  const compilerTimeDelta = counterDelta(
    first.compilerTimeMillis,
    last.compilerTimeMillis,
  );
  let peakCodeCacheUsedBytes = 0;
  let peakCodeCachePercent = 0;
  let pressure = codeCachePressure(
    first.codeCacheUsedBytes,
    first.codeCacheCapacityBytes,
  ).state;
  for (const sample of recording.samples) {
    peakCodeCacheUsedBytes = Math.max(
      peakCodeCacheUsedBytes,
      sample.codeCacheUsedBytes,
    );
    const samplePressure = codeCachePressure(
      sample.codeCacheUsedBytes,
      sample.codeCacheCapacityBytes,
    );
    peakCodeCachePercent = Math.max(
      peakCodeCachePercent,
      samplePressure.percent,
    );
    if (pressureRank(samplePressure.state) > pressureRank(pressure)) {
      pressure = samplePressure.state;
    }
  }
  const endingPressure = codeCachePressure(
    last.codeCacheUsedBytes,
    last.codeCacheCapacityBytes,
  );
  return {
    sampleCount: recording.samples.length,
    durationMillis,
    compileDelta,
    standardCompileDelta,
    osrCompileDelta,
    failureDelta,
    compilesPerSecond: rate(compileDelta, durationSeconds),
    failuresPerSecond: rate(failureDelta, durationSeconds),
    compilationTimePercent:
      compilerTimeDelta === null || durationMillis <= 0
        ? null
        : roundMetric((compilerTimeDelta / durationMillis) * 100),
    initialCodeCacheUsedBytes: first.codeCacheUsedBytes,
    endingCodeCacheUsedBytes: last.codeCacheUsedBytes,
    peakCodeCacheUsedBytes,
    codeCacheGrowthBytes: last.codeCacheUsedBytes - first.codeCacheUsedBytes,
    endingCodeCachePercent: endingPressure.percent,
    peakCodeCachePercent: roundMetric(peakCodeCachePercent),
    codeCachePressure: pressure,
    codeCacheCapacityKind: last.codeCacheCapacityKind,
  };
}

interface ComparisonContext {
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
  readonly mode?: JitTrendComparisonMode;
}

export function compareJitTrendReports(
  baseline: JitTrendInspectionReport,
  current: JitTrendInspectionReport,
  context: ComparisonContext,
): JitTrendComparison {
  if (
    !context.baselineArtifactId.trim() ||
    !context.currentArtifactId.trim() ||
    context.baselineArtifactId === context.currentArtifactId
  ) {
    throw new Error("JIT trend comparison context is invalid");
  }
  if (
    baseline.artifactId !== context.baselineArtifactId ||
    current.artifactId !== context.currentArtifactId
  ) {
    throw new Error("JIT trend artifact identity does not match");
  }
  const left = baseline.recording;
  const right = current.recording;
  const mode = context.mode ?? "SAME_JVM";
  const leftCapacity = left.samples[0];
  const rightCapacity = right.samples[0];
  if (!leftCapacity || !rightCapacity) {
    throw new Error("Incompatible JIT trends: EMPTY_WINDOW");
  }
  if (mode === "SAME_JVM") {
    if (left.targetId !== right.targetId) {
      throw new Error("JIT trend target identity does not match");
    }
    if (left.jvmStartTimeEpochMillis !== right.jvmStartTimeEpochMillis) {
      throw new Error("Incompatible JIT trends: JVM_RESTARTED");
    }
    if (
      leftCapacity.codeCacheCapacityKind !==
        rightCapacity.codeCacheCapacityKind ||
      (leftCapacity.codeCacheCapacityKind === "MAX" &&
        leftCapacity.codeCacheCapacityBytes !==
          rightCapacity.codeCacheCapacityBytes)
    ) {
      throw new Error("Incompatible JIT trends: CODE_CACHE_CAPACITY_CHANGED");
    }
  } else {
    const leftIdentity = left.regressionIdentity;
    const rightIdentity = right.regressionIdentity;
    if (!leftIdentity || !rightIdentity) {
      throw new Error("Incompatible JIT trends: REGRESSION_IDENTITY_MISSING");
    }
    if (
      left.targetId === right.targetId &&
      left.jvmStartTimeEpochMillis === right.jvmStartTimeEpochMillis
    ) {
      throw new Error("Incompatible JIT trends: SAME_JVM_CYCLE");
    }
    if (
      leftIdentity.workloadKey !== rightIdentity.workloadKey ||
      leftIdentity.targetMainClass !== rightIdentity.targetMainClass
    ) {
      throw new Error("Incompatible JIT trends: WORKLOAD_MISMATCH");
    }
    if (leftIdentity.releaseLabel === rightIdentity.releaseLabel) {
      throw new Error("Incompatible JIT trends: RELEASE_LABEL_UNCHANGED");
    }
    if (left.samplingIntervalMillis !== right.samplingIntervalMillis) {
      throw new Error("Incompatible JIT trends: SAMPLING_INTERVAL_CHANGED");
    }
    if (
      leftCapacity.codeCacheCapacityKind !== "MAX" ||
      rightCapacity.codeCacheCapacityKind !== "MAX"
    ) {
      throw new Error("Incompatible JIT trends: MAX_CAPACITY_REQUIRED");
    }
  }
  const baselineStartedAt = left.samples[0]?.sampledAtEpochMillis;
  const baselineEndedAt = left.samples.at(-1)?.sampledAtEpochMillis;
  const currentStartedAt = right.samples[0]?.sampledAtEpochMillis;
  const currentEndedAt = right.samples.at(-1)?.sampledAtEpochMillis;
  if (
    baselineStartedAt === undefined ||
    baselineEndedAt === undefined ||
    currentStartedAt === undefined ||
    currentEndedAt === undefined ||
    baselineEndedAt > currentStartedAt
  ) {
    throw new Error("JIT trend baseline must finish before the current window");
  }
  const baselineSummary = summarizeValidatedRecording(left);
  const currentSummary = summarizeValidatedRecording(right);
  if (mode === "CROSS_RELEASE") {
    const durationRatio =
      currentSummary.durationMillis / baselineSummary.durationMillis;
    if (durationRatio < 0.8 || durationRatio > 1.25) {
      throw new Error("Incompatible JIT trends: DURATION_MISMATCH");
    }
  }
  return {
    baselineArtifactId: baseline.artifactId,
    currentArtifactId: current.artifactId,
    mode,
    baselineTargetId: left.targetId,
    currentTargetId: right.targetId,
    baselineJvmStartTimeEpochMillis: left.jvmStartTimeEpochMillis,
    currentJvmStartTimeEpochMillis: right.jvmStartTimeEpochMillis,
    baselineIdentity: left.regressionIdentity ?? null,
    currentIdentity: right.regressionIdentity ?? null,
    baselineStartedAt,
    baselineEndedAt,
    currentStartedAt,
    currentEndedAt,
    intervalMillis: currentStartedAt - baselineEndedAt,
    baseline: baselineSummary,
    current: currentSummary,
    compileRateDelta: nullableDelta(
      baselineSummary.compilesPerSecond,
      currentSummary.compilesPerSecond,
    ),
    failureRateDelta: nullableDelta(
      baselineSummary.failuresPerSecond,
      currentSummary.failuresPerSecond,
    ),
    compilationTimePercentDelta: nullableDelta(
      baselineSummary.compilationTimePercent,
      currentSummary.compilationTimePercent,
    ),
    endingCodeCachePercentDelta: roundMetric(
      currentSummary.endingCodeCachePercent -
        baselineSummary.endingCodeCachePercent,
    ),
    peakCodeCachePercentDelta: roundMetric(
      currentSummary.peakCodeCachePercent -
        baselineSummary.peakCodeCachePercent,
    ),
    codeCacheGrowthDeltaBytes:
      currentSummary.codeCacheGrowthBytes -
      baselineSummary.codeCacheGrowthBytes,
    pressureChanged:
      baselineSummary.codeCachePressure !== currentSummary.codeCachePressure,
  };
}

function counterDelta(
  first: number | null,
  last: number | null,
): number | null {
  return first === null || last === null ? null : last - first;
}

function rate(delta: number | null, durationSeconds: number): number | null {
  return delta === null || durationSeconds <= 0
    ? null
    : roundMetric(delta / durationSeconds);
}

function nullableDelta(
  left: number | null,
  right: number | null,
): number | null {
  return left === null || right === null ? null : roundMetric(right - left);
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function pressureRank(value: JitTrendSummary["codeCachePressure"]): number {
  switch (value) {
    case "EXHAUSTED":
      return 3;
    case "HIGH":
      return 2;
    case "ELEVATED":
      return 1;
    case "NORMAL":
    default:
      return 0;
  }
}
