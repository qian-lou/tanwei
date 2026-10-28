import { Buffer } from "node:buffer";
import { z } from "zod";
import type {
  ThreadPoolKind,
  ThreadPoolTrendComparison,
  ThreadPoolTrendInspectionReport,
  ThreadPoolTrendRecording,
  ThreadPoolTrendSample,
  ThreadPoolTrendSummary,
} from "../../src/shared/contracts.js";

export const MAXIMUM_THREAD_POOL_TREND_ARTIFACT_BYTES = 256 * 1024;

const safeCount = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const optionalMetric = safeCount.nullable();
const supportedPoolClassSchema = z.enum([
  "java.util.concurrent.ThreadPoolExecutor",
  "java.util.concurrent.ScheduledThreadPoolExecutor",
  "java.util.concurrent.ForkJoinPool",
]);
const poolKindSchema = z.enum([
  "THREAD_POOL",
  "SCHEDULED",
  "FORK_JOIN",
]);

const threadPoolTrendSampleSchema = z
  .object({
    capturedAt: safeCount.min(1),
    state: z.enum([
      "RUNNING",
      "QUIESCENT",
      "SHUTDOWN",
      "TERMINATING",
      "TERMINATED",
    ]),
    configuredSize: optionalMetric,
    poolSize: optionalMetric,
    activeCount: optionalMetric,
    maximumSize: optionalMetric,
    queuedTasks: optionalMetric,
    remainingQueueCapacity: optionalMetric,
    completedTasks: optionalMetric,
    queuedSubmissions: optionalMetric,
    runningCount: optionalMetric,
    stealCount: optionalMetric,
  })
  .strict()
  .superRefine((sample, context) => {
    if (sample.queuedTasks === null && sample.queuedSubmissions === null) {
      context.addIssue({
        code: "custom",
        path: ["queuedTasks"],
        message: "A trend sample requires a bounded queue metric",
      });
    }
    const queueTotal =
      (sample.queuedTasks ?? 0) + (sample.queuedSubmissions ?? 0);
    if (!Number.isSafeInteger(queueTotal)) {
      context.addIssue({
        code: "custom",
        path: ["queuedSubmissions"],
        message: "Combined queue metrics exceed the safe integer boundary",
      });
    }
    if (
      sample.activeCount !== null &&
      sample.poolSize !== null &&
      sample.activeCount > sample.poolSize
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeCount"],
        message: "Active threads cannot exceed the current pool size",
      });
    }
    if (
      sample.poolSize !== null &&
      sample.maximumSize !== null &&
      sample.poolSize > sample.maximumSize
    ) {
      context.addIssue({
        code: "custom",
        path: ["poolSize"],
        message: "Current pool size cannot exceed the maximum size",
      });
    }
  });

export const threadPoolTrendRecordingSchema = z
  .object({
    targetId: z
      .string()
      .min(1)
      .max(560)
      .regex(
        /^(?:local:\d+|remote:(?:ssh|kubernetes|persistent):[a-f0-9]{24})$/u,
      ),
    jvmStartTimeEpochMillis: safeCount.min(1),
    poolIdentity: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^(?:ThreadPoolExecutor|ScheduledThreadPoolExecutor|ForkJoinPool)@[0-9a-f]+$/u,
      ),
    poolClassName: supportedPoolClassSchema,
    poolKind: poolKindSchema,
    alias: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[^\u0000-\u001f\u007f]+$/u)
      .nullable(),
    samplingIntervalMillis: z.union([
      z.literal(2_000),
      z.literal(5_000),
      z.literal(10_000),
      z.literal(30_000),
    ]),
    samples: z.array(threadPoolTrendSampleSchema).min(2).max(120),
  })
  .strict()
  .superRefine((recording, context) => {
    validatePoolIdentity(recording, context);
    let previous: ThreadPoolTrendSample | null = null;
    for (const [index, sample] of recording.samples.entries()) {
      if (sample.capturedAt < recording.jvmStartTimeEpochMillis) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "capturedAt"],
          message: "Sample predates the JVM startup cycle",
        });
      }
      if (previous && sample.capturedAt <= previous.capturedAt) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "capturedAt"],
          message: "Trend samples must be strictly chronological",
        });
      }
      if (
        previous?.completedTasks !== null &&
        previous?.completedTasks !== undefined &&
        sample.completedTasks !== null &&
        sample.completedTasks < previous.completedTasks
      ) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "completedTasks"],
          message: "Completed task counter regressed within one exact pool",
        });
      }
      if (
        previous?.stealCount !== null &&
        previous?.stealCount !== undefined &&
        sample.stealCount !== null &&
        sample.stealCount < previous.stealCount
      ) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "stealCount"],
          message: "ForkJoin steal counter regressed within one exact pool",
        });
      }
      previous = sample;
    }
    const first = recording.samples[0];
    const last = recording.samples.at(-1);
    if (
      first &&
      last &&
      last.capturedAt - first.capturedAt > 24 * 60 * 60 * 1_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["samples"],
        message: "Thread-pool trend duration exceeds 24 hours",
      });
    }
  });

const threadPoolTrendArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("tanwei"),
    kind: z.literal("thread-pool-trend"),
    recording: threadPoolTrendRecordingSchema,
  })
  .strict();

interface PoolIdentity {
  readonly poolIdentity: string;
  readonly poolClassName:
    | "java.util.concurrent.ThreadPoolExecutor"
    | "java.util.concurrent.ScheduledThreadPoolExecutor"
    | "java.util.concurrent.ForkJoinPool";
  readonly poolKind: ThreadPoolKind;
}

function validatePoolIdentity(
  value: PoolIdentity,
  context: z.RefinementCtx,
): void {
  const expected =
    value.poolClassName === "java.util.concurrent.ThreadPoolExecutor"
      ? { prefix: "ThreadPoolExecutor@", kind: "THREAD_POOL" }
      : value.poolClassName ===
          "java.util.concurrent.ScheduledThreadPoolExecutor"
        ? { prefix: "ScheduledThreadPoolExecutor@", kind: "SCHEDULED" }
        : { prefix: "ForkJoinPool@", kind: "FORK_JOIN" };
  if (!value.poolIdentity.startsWith(expected.prefix)) {
    context.addIssue({
      code: "custom",
      path: ["poolIdentity"],
      message: "Thread-pool identity does not match its exact class",
    });
  }
  if (value.poolKind !== expected.kind) {
    context.addIssue({
      code: "custom",
      path: ["poolKind"],
      message: "Thread-pool kind does not match its exact class",
    });
  }
}

export function serializeThreadPoolTrendArtifact(
  recording: ThreadPoolTrendRecording,
): Buffer {
  const validated = threadPoolTrendRecordingSchema.parse(recording);
  const content = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "tanwei",
        kind: "thread-pool-trend",
        recording: validated,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (content.byteLength > MAXIMUM_THREAD_POOL_TREND_ARTIFACT_BYTES) {
    throw new Error("Thread-pool trend exceeds the artifact size boundary");
  }
  return content;
}

export function parseThreadPoolTrendArtifact(
  content: string,
  artifactId: string,
): ThreadPoolTrendInspectionReport {
  if (!artifactId.trim() || artifactId.length > 128) {
    throw new Error("Thread-pool trend artifact id is invalid");
  }
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (
    contentBytes <= 0 ||
    contentBytes > MAXIMUM_THREAD_POOL_TREND_ARTIFACT_BYTES
  ) {
    throw new Error("Thread-pool trend exceeds the artifact size boundary");
  }
  const parsed = threadPoolTrendArtifactSchema.parse(JSON.parse(content));
  return {
    artifactId,
    schemaVersion: 1,
    recording: parsed.recording,
    summary: summarizeValidatedRecording(parsed.recording),
  };
}

export function summarizeThreadPoolTrend(
  recording: ThreadPoolTrendRecording,
): ThreadPoolTrendSummary {
  return summarizeValidatedRecording(
    threadPoolTrendRecordingSchema.parse(recording),
  );
}

function summarizeValidatedRecording(
  recording: ThreadPoolTrendRecording,
): ThreadPoolTrendSummary {
  const first = recording.samples[0];
  const last = recording.samples.at(-1);
  if (!first || !last) {
    throw new Error("Thread-pool trend requires at least two samples");
  }
  const durationMillis = last.capturedAt - first.capturedAt;
  let peakQueue = 0;
  let queueGrowthIntervals = 0;
  let previousQueue: number | null = null;
  let utilizationTotal = 0;
  let utilizationSamples = 0;
  let peakUtilizationPercent = 0;
  let saturatedSamples = 0;
  let terminalStateSeen = false;
  for (const sample of recording.samples) {
    const queue = queueLevel(sample);
    peakQueue = Math.max(peakQueue, queue);
    if (previousQueue !== null && queue > previousQueue) {
      queueGrowthIntervals += 1;
    }
    previousQueue = queue;
    const utilization = utilizationPercent(sample, recording.poolKind);
    if (utilization !== null) {
      utilizationTotal += utilization;
      utilizationSamples += 1;
      peakUtilizationPercent = Math.max(peakUtilizationPercent, utilization);
      if (utilization >= 100) {
        saturatedSamples += 1;
      }
    }
    terminalStateSeen ||=
      sample.state === "SHUTDOWN" ||
      sample.state === "TERMINATING" ||
      sample.state === "TERMINATED";
  }
  const initialQueue = queueLevel(first);
  const currentQueue = queueLevel(last);
  const completedTaskDelta = counterDelta(
    first.completedTasks,
    last.completedTasks,
  );
  const stealDelta = counterDelta(first.stealCount, last.stealCount);
  const throughputPerSecond =
    completedTaskDelta === null || durationMillis <= 0
      ? null
      : roundMetric(completedTaskDelta / (durationMillis / 1_000));
  return {
    sampleCount: recording.samples.length,
    durationMillis,
    initialQueue,
    currentQueue,
    queueDelta: currentQueue - initialQueue,
    peakQueue,
    queueGrowthIntervals,
    averageUtilizationPercent:
      utilizationSamples === 0
        ? null
        : roundMetric(utilizationTotal / utilizationSamples),
    peakUtilizationPercent:
      utilizationSamples === 0
        ? null
        : roundMetric(peakUtilizationPercent),
    saturatedSamples,
    completedTaskDelta,
    throughputPerSecond,
    stealDelta,
    terminalStateSeen,
    starvationLikely:
      currentQueue > 0 &&
      currentQueue > initialQueue &&
      saturatedSamples * 2 >= recording.samples.length,
  };
}

interface ComparisonContext {
  readonly targetId: string;
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
}

export function compareThreadPoolTrendReports(
  baseline: ThreadPoolTrendInspectionReport,
  current: ThreadPoolTrendInspectionReport,
  context: ComparisonContext,
): ThreadPoolTrendComparison {
  if (
    !context.targetId.trim() ||
    !context.baselineArtifactId.trim() ||
    !context.currentArtifactId.trim() ||
    context.baselineArtifactId === context.currentArtifactId
  ) {
    throw new Error("Thread-pool trend comparison context is invalid");
  }
  if (
    baseline.artifactId !== context.baselineArtifactId ||
    current.artifactId !== context.currentArtifactId
  ) {
    throw new Error("Thread-pool trend artifact identity does not match");
  }
  const left = baseline.recording;
  const right = current.recording;
  if (left.targetId !== context.targetId || right.targetId !== context.targetId) {
    throw new Error("Thread-pool trend target identity does not match");
  }
  if (left.jvmStartTimeEpochMillis !== right.jvmStartTimeEpochMillis) {
    throw new Error("Incompatible thread-pool trends: JVM_RESTARTED");
  }
  if (
    left.poolIdentity !== right.poolIdentity ||
    left.poolClassName !== right.poolClassName ||
    left.poolKind !== right.poolKind
  ) {
    throw new Error("Incompatible thread-pool trends: POOL_IDENTITY_CHANGED");
  }
  const baselineStartedAt = left.samples[0]?.capturedAt;
  const baselineEndedAt = left.samples.at(-1)?.capturedAt;
  const currentStartedAt = right.samples[0]?.capturedAt;
  const currentEndedAt = right.samples.at(-1)?.capturedAt;
  if (
    baselineStartedAt === undefined ||
    baselineEndedAt === undefined ||
    currentStartedAt === undefined ||
    currentEndedAt === undefined ||
    baselineEndedAt > currentStartedAt
  ) {
    throw new Error(
      "Thread-pool trend baseline must finish before the current recording",
    );
  }
  const baselineSummary = summarizeValidatedRecording(left);
  const currentSummary = summarizeValidatedRecording(right);
  return {
    baselineArtifactId: baseline.artifactId,
    currentArtifactId: current.artifactId,
    targetId: context.targetId,
    jvmStartTimeEpochMillis: left.jvmStartTimeEpochMillis,
    poolIdentity: left.poolIdentity,
    poolClassName: left.poolClassName,
    poolKind: left.poolKind,
    baselineStartedAt,
    baselineEndedAt,
    currentStartedAt,
    currentEndedAt,
    intervalMillis: currentStartedAt - baselineEndedAt,
    baseline: baselineSummary,
    current: currentSummary,
    peakQueueDelta: currentSummary.peakQueue - baselineSummary.peakQueue,
    endingQueueDelta:
      currentSummary.currentQueue - baselineSummary.currentQueue,
    averageUtilizationDelta: nullableDelta(
      baselineSummary.averageUtilizationPercent,
      currentSummary.averageUtilizationPercent,
    ),
    throughputDelta: nullableDelta(
      baselineSummary.throughputPerSecond,
      currentSummary.throughputPerSecond,
    ),
    starvationChanged:
      baselineSummary.starvationLikely !== currentSummary.starvationLikely,
  };
}

function queueLevel(sample: ThreadPoolTrendSample): number {
  return (sample.queuedTasks ?? 0) + (sample.queuedSubmissions ?? 0);
}

function utilizationPercent(
  sample: ThreadPoolTrendSample,
  kind: ThreadPoolKind,
): number | null {
  if (sample.activeCount === null) {
    return null;
  }
  const capacity =
    kind === "THREAD_POOL"
      ? (sample.maximumSize ?? sample.configuredSize)
      : (sample.configuredSize ?? sample.maximumSize);
  return capacity && capacity > 0
    ? (sample.activeCount / capacity) * 100
    : null;
}

function counterDelta(
  first: number | null,
  last: number | null,
): number | null {
  return first === null || last === null ? null : last - first;
}

function nullableDelta(
  baseline: number | null,
  current: number | null,
): number | null {
  return baseline === null || current === null
    ? null
    : roundMetric(current - baseline);
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
