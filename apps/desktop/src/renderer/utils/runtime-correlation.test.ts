import { describe, expect, it } from "vitest";
import type { TargetSnapshot } from "@shared/contracts";
import {
  deriveRuntimeIntervals,
  MAXIMUM_RUNTIME_CORRELATION_SAMPLES,
  summarizeRuntimeIntervals,
} from "./runtime-correlation";

function snapshot(
  capturedAtEpochMillis: number,
  overrides: Partial<TargetSnapshot> = {},
): TargetSnapshot {
  return {
    targetId: "target-1",
    capturedAt: new Date(capturedAtEpochMillis).toISOString(),
    uptimeMillis: capturedAtEpochMillis,
    jvmStartTimeEpochMillis: 1_000,
    processCpuLoad: 0.2,
    systemCpuLoad: 0.3,
    heapUsedBytes: 100 * 1024 * 1024,
    heapMaxBytes: 1024 * 1024 * 1024,
    nonHeapUsedBytes: 32 * 1024 * 1024,
    liveThreads: 20,
    peakThreads: 24,
    loadedClasses: 500,
    gcCount: 10,
    gcTimeMillis: 100,
    ...overrides,
  };
}

describe("runtime correlation", () => {
  it("derives cross-metric deltas and pressure signals from adjacent snapshots", () => {
    const intervals = deriveRuntimeIntervals([
      snapshot(10_000),
      snapshot(12_000, {
        processCpuLoad: 0.9,
        heapUsedBytes: 180 * 1024 * 1024,
        liveThreads: 35,
        gcCount: 12,
        gcTimeMillis: 350,
      }),
    ]);

    expect(intervals).toEqual([
      expect.objectContaining({
        durationMillis: 2_000,
        processCpuLoad: 0.9,
        heapDeltaBytes: 80 * 1024 * 1024,
        threadDelta: 15,
        gcCountDelta: 2,
        gcTimeDeltaMillis: 250,
        gcTimeShare: 0.125,
        assessment: "PRESSURE",
        signals: [
          "GC_ACTIVITY",
          "GC_PRESSURE",
          "CPU_PRESSURE",
          "HEAP_GROWTH",
          "THREAD_SURGE",
        ],
      }),
    ]);
  });

  it("keeps valid interval evidence when cumulative counters regress", () => {
    const [interval] = deriveRuntimeIntervals([
      snapshot(10_000),
      snapshot(12_000, {
        processCpuLoad: Number.NaN,
        gcCount: 9,
        gcTimeMillis: 90,
      }),
    ]);

    expect(interval).toMatchObject({
      processCpuLoad: null,
      gcCountDelta: null,
      gcTimeDeltaMillis: null,
      gcTimeShare: null,
      signals: [],
      assessment: "STABLE",
    });
  });

  it("does not correlate across targets, JVM cycles or non-monotonic time", () => {
    expect(
      deriveRuntimeIntervals([
        snapshot(10_000),
        snapshot(12_000, { targetId: "target-2" }),
        snapshot(14_000, { jvmStartTimeEpochMillis: 2_000 }),
        snapshot(13_000, { jvmStartTimeEpochMillis: 2_000 }),
      ]),
    ).toEqual([]);
  });

  it("bounds retained work and summarizes intervals in one pass", () => {
    const samples = Array.from(
      { length: MAXIMUM_RUNTIME_CORRELATION_SAMPLES + 20 },
      (_, index) =>
        snapshot(10_000 + index * 1_000, {
          processCpuLoad: index % 3 === 0 ? 0.85 : 0.2,
          gcCount: 10 + Math.floor(index / 5),
          gcTimeMillis: 100 + Math.floor(index / 5) * 10,
        }),
    );
    const intervals = deriveRuntimeIntervals(samples);
    const summary = summarizeRuntimeIntervals(intervals);

    expect(intervals).toHaveLength(MAXIMUM_RUNTIME_CORRELATION_SAMPLES - 1);
    expect(summary.intervalCount).toBe(intervals.length);
    expect(summary.gcIntervals).toBeGreaterThan(0);
    expect(summary.pressureIntervals).toBeGreaterThan(0);
    expect(summary.peakProcessCpuLoad).toBe(0.85);
  });
});
