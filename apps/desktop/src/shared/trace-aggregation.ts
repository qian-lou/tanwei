import type { TraceHotspotRow } from "./contracts.js";

export interface TraceAggregationSpan {
  readonly sequence: number;
  readonly parentSequence: number | null;
  readonly method: string;
  readonly durationNanos: number;
  readonly exceptionType: string | null;
}

export interface TraceAggregationInput {
  readonly durationNanos: number;
  readonly spans: readonly TraceAggregationSpan[];
}

interface MutableTraceHotspot {
  calls: number;
  errors: number;
  totalDurationNanos: number;
  selfDurationNanos: number;
  maximumDurationNanos: number;
}

const DEFAULT_HOTSPOT_LIMIT = 100;
const MAXIMUM_HOTSPOT_LIMIT = 512;

function safeDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function aggregateTraceHotspots(
  traces: readonly TraceAggregationInput[],
  requestedLimit = DEFAULT_HOTSPOT_LIMIT,
): readonly TraceHotspotRow[] {
  const limit =
    Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAXIMUM_HOTSPOT_LIMIT)
      : DEFAULT_HOTSPOT_LIMIT;
  const groups = new Map<string, MutableTraceHotspot>();
  let totalRootDurationNanos = 0;

  for (const trace of traces) {
    totalRootDurationNanos += safeDuration(trace.durationNanos);
    const knownSequences = new Set(
      trace.spans.map((span) => span.sequence),
    );
    const directChildDuration = new Map<number, number>();

    for (const span of trace.spans) {
      if (
        span.parentSequence === null ||
        !knownSequences.has(span.parentSequence)
      ) {
        continue;
      }
      directChildDuration.set(
        span.parentSequence,
        (directChildDuration.get(span.parentSequence) ?? 0) +
          safeDuration(span.durationNanos),
      );
    }

    for (const span of trace.spans) {
      const method = span.method.trim();
      if (!method) {
        continue;
      }
      const durationNanos = safeDuration(span.durationNanos);
      const selfDurationNanos = Math.max(
        0,
        durationNanos - (directChildDuration.get(span.sequence) ?? 0),
      );
      const group = groups.get(method) ?? {
        calls: 0,
        errors: 0,
        totalDurationNanos: 0,
        selfDurationNanos: 0,
        maximumDurationNanos: 0,
      };
      group.calls += 1;
      if (span.exceptionType) {
        group.errors += 1;
      }
      group.totalDurationNanos += durationNanos;
      group.selfDurationNanos += selfDurationNanos;
      group.maximumDurationNanos = Math.max(
        group.maximumDurationNanos,
        durationNanos,
      );
      groups.set(method, group);
    }
  }

  return [...groups.entries()]
    .map(([method, group]): TraceHotspotRow => ({
      method,
      calls: group.calls,
      errors: group.errors,
      totalDurationNanos: group.totalDurationNanos,
      selfDurationNanos: group.selfDurationNanos,
      averageDurationNanos:
        group.calls > 0 ? group.totalDurationNanos / group.calls : 0,
      maximumDurationNanos: group.maximumDurationNanos,
      selfSharePercent:
        totalRootDurationNanos > 0
          ? Math.min(
              100,
              (group.selfDurationNanos / totalRootDurationNanos) * 100,
            )
          : 0,
    }))
    .sort(
      (left, right) =>
        right.selfDurationNanos - left.selfDurationNanos ||
        right.totalDurationNanos - left.totalDurationNanos ||
        right.calls - left.calls ||
        left.method.localeCompare(right.method),
    )
    .slice(0, limit);
}
