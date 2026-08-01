import type { TargetSnapshot } from "@shared/contracts";

export const MAXIMUM_RUNTIME_CORRELATION_SAMPLES = 300;

const CPU_PRESSURE_THRESHOLD = 0.8;
const GC_TIME_SHARE_THRESHOLD = 0.1;
const MINIMUM_HEAP_GROWTH_BYTES = 32 * 1024 * 1024;
const HEAP_GROWTH_RATIO = 0.05;
const MINIMUM_THREAD_SURGE = 10;
const THREAD_SURGE_RATIO = 0.2;

export type RuntimeIntervalSignal =
  | "GC_ACTIVITY"
  | "GC_PRESSURE"
  | "CPU_PRESSURE"
  | "HEAP_GROWTH"
  | "THREAD_SURGE";

export type RuntimeIntervalAssessment = "STABLE" | "NOTICE" | "PRESSURE";

export interface RuntimeIntervalEvidence {
  readonly startedAtEpochMillis: number;
  readonly endedAtEpochMillis: number;
  readonly durationMillis: number;
  readonly processCpuLoad: number | null;
  readonly heapUsedBytes: number;
  readonly heapMaxBytes: number;
  readonly heapDeltaBytes: number;
  readonly liveThreads: number;
  readonly threadDelta: number;
  readonly gcCountDelta: number | null;
  readonly gcTimeDeltaMillis: number | null;
  readonly gcTimeShare: number | null;
  readonly signals: readonly RuntimeIntervalSignal[];
  readonly assessment: RuntimeIntervalAssessment;
}

export interface RuntimeCorrelationSummary {
  readonly intervalCount: number;
  readonly gcIntervals: number;
  readonly pressureIntervals: number;
  readonly concurrentSignalIntervals: number;
  readonly totalGcTimeDeltaMillis: number;
  readonly peakProcessCpuLoad: number | null;
  readonly maximumHeapGrowthBytes: number;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function cumulativeDelta(current: number, previous: number): number | null {
  if (!finiteNonNegative(current) || !finiteNonNegative(previous)) {
    return null;
  }
  const delta = current - previous;
  return delta >= 0 && Number.isSafeInteger(delta) ? delta : null;
}

function snapshotTime(snapshot: TargetSnapshot): number | null {
  const parsed = Date.parse(snapshot.capturedAt);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function signalsForInterval(
  current: TargetSnapshot,
  previous: TargetSnapshot,
  durationMillis: number,
  gcCountDelta: number | null,
  gcTimeDeltaMillis: number | null,
): readonly RuntimeIntervalSignal[] {
  const signals: RuntimeIntervalSignal[] = [];
  const gcTimeShare =
    gcTimeDeltaMillis === null ? null : gcTimeDeltaMillis / durationMillis;
  if (
    (gcCountDelta !== null && gcCountDelta > 0) ||
    (gcTimeDeltaMillis !== null && gcTimeDeltaMillis > 0)
  ) {
    signals.push("GC_ACTIVITY");
  }
  if (gcTimeShare !== null && gcTimeShare >= GC_TIME_SHARE_THRESHOLD) {
    signals.push("GC_PRESSURE");
  }
  if (
    current.processCpuLoad !== null &&
    Number.isFinite(current.processCpuLoad) &&
    current.processCpuLoad >= CPU_PRESSURE_THRESHOLD
  ) {
    signals.push("CPU_PRESSURE");
  }
  const heapGrowthThreshold = Math.max(
    MINIMUM_HEAP_GROWTH_BYTES,
    current.heapMaxBytes > 0 ? current.heapMaxBytes * HEAP_GROWTH_RATIO : 0,
  );
  if (current.heapUsedBytes - previous.heapUsedBytes >= heapGrowthThreshold) {
    signals.push("HEAP_GROWTH");
  }
  const threadSurgeThreshold = Math.max(
    MINIMUM_THREAD_SURGE,
    Math.ceil(previous.liveThreads * THREAD_SURGE_RATIO),
  );
  if (current.liveThreads - previous.liveThreads >= threadSurgeThreshold) {
    signals.push("THREAD_SURGE");
  }
  return signals;
}

function assessmentForSignals(
  signals: readonly RuntimeIntervalSignal[],
): RuntimeIntervalAssessment {
  return signals.includes("GC_PRESSURE") || signals.includes("CPU_PRESSURE")
    ? "PRESSURE"
    : signals.length > 0
      ? "NOTICE"
      : "STABLE";
}

export function deriveRuntimeIntervals(
  samples: readonly TargetSnapshot[],
): readonly RuntimeIntervalEvidence[] {
  const bounded = samples.slice(-MAXIMUM_RUNTIME_CORRELATION_SAMPLES);
  const intervals: RuntimeIntervalEvidence[] = [];
  for (let index = 1; index < bounded.length; index += 1) {
    const previous = bounded[index - 1];
    const current = bounded[index];
    if (!previous || !current) {
      continue;
    }
    const startedAtEpochMillis = snapshotTime(previous);
    const endedAtEpochMillis = snapshotTime(current);
    if (
      startedAtEpochMillis === null ||
      endedAtEpochMillis === null ||
      endedAtEpochMillis <= startedAtEpochMillis ||
      current.targetId !== previous.targetId ||
      current.jvmStartTimeEpochMillis !== previous.jvmStartTimeEpochMillis
    ) {
      continue;
    }
    const durationMillis = endedAtEpochMillis - startedAtEpochMillis;
    const gcCountDelta = cumulativeDelta(current.gcCount, previous.gcCount);
    const gcTimeDeltaMillis = cumulativeDelta(
      current.gcTimeMillis,
      previous.gcTimeMillis,
    );
    const signals = signalsForInterval(
      current,
      previous,
      durationMillis,
      gcCountDelta,
      gcTimeDeltaMillis,
    );
    intervals.push({
      startedAtEpochMillis,
      endedAtEpochMillis,
      durationMillis,
      processCpuLoad:
        current.processCpuLoad !== null &&
        Number.isFinite(current.processCpuLoad) &&
        current.processCpuLoad >= 0
          ? current.processCpuLoad
          : null,
      heapUsedBytes: current.heapUsedBytes,
      heapMaxBytes: current.heapMaxBytes,
      heapDeltaBytes: current.heapUsedBytes - previous.heapUsedBytes,
      liveThreads: current.liveThreads,
      threadDelta: current.liveThreads - previous.liveThreads,
      gcCountDelta,
      gcTimeDeltaMillis,
      gcTimeShare:
        gcTimeDeltaMillis === null ? null : gcTimeDeltaMillis / durationMillis,
      signals,
      assessment: assessmentForSignals(signals),
    });
  }
  return intervals;
}

export function summarizeRuntimeIntervals(
  intervals: readonly RuntimeIntervalEvidence[],
): RuntimeCorrelationSummary {
  let gcIntervals = 0;
  let pressureIntervals = 0;
  let concurrentSignalIntervals = 0;
  let totalGcTimeDeltaMillis = 0;
  let peakProcessCpuLoad: number | null = null;
  let maximumHeapGrowthBytes = 0;
  for (const interval of intervals) {
    if (interval.signals.includes("GC_ACTIVITY")) {
      gcIntervals += 1;
    }
    if (interval.assessment === "PRESSURE") {
      pressureIntervals += 1;
    }
    if (interval.signals.length >= 2) {
      concurrentSignalIntervals += 1;
    }
    if (interval.gcTimeDeltaMillis !== null) {
      totalGcTimeDeltaMillis += interval.gcTimeDeltaMillis;
    }
    if (
      interval.processCpuLoad !== null &&
      (peakProcessCpuLoad === null ||
        interval.processCpuLoad > peakProcessCpuLoad)
    ) {
      peakProcessCpuLoad = interval.processCpuLoad;
    }
    maximumHeapGrowthBytes = Math.max(
      maximumHeapGrowthBytes,
      interval.heapDeltaBytes,
    );
  }
  return {
    intervalCount: intervals.length,
    gcIntervals,
    pressureIntervals,
    concurrentSignalIntervals,
    totalGcTimeDeltaMillis,
    peakProcessCpuLoad,
    maximumHeapGrowthBytes,
  };
}
