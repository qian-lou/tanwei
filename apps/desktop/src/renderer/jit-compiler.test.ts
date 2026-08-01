import { describe, expect, it } from "vitest";
import {
  appendJitCompilerSample,
  buildJitTrendRecording,
  jitCodeCachePressure,
  MAXIMUM_JIT_TREND_SAMPLES,
  parseJitCompilerSnapshot,
  summarizeJitCompilerTrend,
} from "./jit-compiler";

const baseValues = {
  schemaVersion: "1",
  sampledAtEpochMillis: "1000",
  "compiler.available": "true",
  "compiler.name": "HotSpot 64-Bit Tiered Compilers",
  "compiler.timeSupported": "true",
  "compiler.totalTimeMillis": "120",
  "internal.available": "true",
  "internal.reason": "",
  "internal.counterCount": "16",
  "internal.truncated": "false",
  "metric.totalCompiles": "40",
  "metric.standardCompiles": "30",
  "metric.osrCompiles": "10",
  "metric.bailouts": "2",
  "metric.invalidations": "1",
  "metric.nmethodCodeBytes": "2048",
  "metric.nmethodTotalBytes": "4096",
  "codeCache.count": "2",
  "codeCache.truncated": "false",
  "codeCache.totalUsedBytes": "300",
  "codeCache.totalCommittedBytes": "600",
  "codeCache.totalMaxBytes": "1000",
  "codeCache.totalMaxComplete": "true",
  "codeCache.00.name": "CodeHeap 'non-profiled nmethods'",
  "codeCache.00.usedBytes": "100",
  "codeCache.00.committedBytes": "200",
  "codeCache.00.maxBytes": "400",
  "codeCache.00.peakUsedBytes": "120",
  "codeCache.01.name": "CodeHeap 'profiled nmethods'",
  "codeCache.01.usedBytes": "200",
  "codeCache.01.committedBytes": "400",
  "codeCache.01.maxBytes": "600",
  "codeCache.01.peakUsedBytes": "240",
  "last.success.method": "example.Work::run",
  "last.success.type": "1",
  "last.success.sizeBytes": "128",
  "last.failed.method": "example.Work::fail",
  "last.failed.type": "2",
  "last.failed.sizeBytes": "64",
  "last.invalidated.method": "example.Work::old",
  "last.invalidated.type": "3",
  "last.invalidated.sizeBytes": "32",
} as const;

describe("JIT compiler response", () => {
  it("parses compiler, semantic counters, events and code-cache pools", () => {
    const snapshot = parseJitCompilerSnapshot(baseValues);

    expect(snapshot.compiler.name).toBe("HotSpot 64-Bit Tiered Compilers");
    expect(snapshot.metrics.totalCompiles).toBe(40);
    expect(snapshot.codeCache.pools).toHaveLength(2);
    expect(snapshot.codeCache.totalUsedBytes).toBe(300);
    expect(snapshot.last.success.method).toBe("example.Work::run");
  });

  it("rejects malformed booleans and inconsistent cache totals", () => {
    expect(() =>
      parseJitCompilerSnapshot({
        ...baseValues,
        "internal.available": "yes",
      }),
    ).toThrow(/internal\.available/u);
    expect(() =>
      parseJitCompilerSnapshot({
        ...baseValues,
        "codeCache.totalUsedBytes": "301",
      }),
    ).toThrow(/inconsistent code cache totals/u);
  });

  it("keeps 120 samples and derives only monotonic rates", () => {
    let samples = Array.from(
      { length: MAXIMUM_JIT_TREND_SAMPLES + 1 },
      (_, index) =>
        parseJitCompilerSnapshot({
          ...baseValues,
          sampledAtEpochMillis: String((index + 1) * 1_000),
          "compiler.totalTimeMillis": String(120 + index * 50),
          "metric.totalCompiles": String(40 + index * 2),
          "metric.bailouts": String(2 + index),
          "metric.invalidations": String(1 + index),
          "codeCache.00.usedBytes": String(100 + index),
          "codeCache.totalUsedBytes": String(300 + index),
        }),
    ).reduce<readonly ReturnType<typeof parseJitCompilerSnapshot>[]>(
      (history, sample) => appendJitCompilerSample(history, sample),
      [],
    );

    expect(samples).toHaveLength(MAXIMUM_JIT_TREND_SAMPLES);
    const summary = summarizeJitCompilerTrend(samples);
    expect(summary.compilesPerSecond).toBe(2);
    expect(summary.failuresPerSecond).toBe(2);
    expect(summary.compilationTimePercent).toBe(5);
    expect(summary.codeCacheGrowthBytesPerSecond).toBe(1);

    const reset = parseJitCompilerSnapshot({
      ...baseValues,
      sampledAtEpochMillis: String((MAXIMUM_JIT_TREND_SAMPLES + 2) * 1_000),
      "compiler.totalTimeMillis": "1",
      "metric.totalCompiles": "1",
      "metric.bailouts": "0",
      "metric.invalidations": "0",
    });
    samples = appendJitCompilerSample(samples, reset);
    expect(summarizeJitCompilerTrend(samples).compilesPerSecond).toBeNull();
  });

  it("builds a bounded persistent window with an explicit cache boundary", () => {
    const first = parseJitCompilerSnapshot(baseValues);
    const second = parseJitCompilerSnapshot({
      ...baseValues,
      sampledAtEpochMillis: "2000",
      "compiler.totalTimeMillis": "170",
      "metric.totalCompiles": "42",
      "metric.standardCompiles": "32",
      "codeCache.00.usedBytes": "300",
      "codeCache.00.committedBytes": "400",
      "codeCache.01.usedBytes": "600",
      "codeCache.01.committedBytes": "600",
      "codeCache.totalUsedBytes": "900",
      "codeCache.totalCommittedBytes": "1000",
    });

    expect(jitCodeCachePressure(second)).toEqual({
      percent: 90,
      state: "HIGH",
      capacityBytes: 1000,
      capacityKind: "MAX",
    });
    expect(
      buildJitTrendRecording([first, second], "local:42", 500, 1_000),
    ).toMatchObject({
      targetId: "local:42",
      jvmStartTimeEpochMillis: 500,
      samplingIntervalMillis: 1_000,
      samples: [
        { sampledAtEpochMillis: 1_000, codeCacheCapacityKind: "MAX" },
        {
          sampledAtEpochMillis: 2_000,
          codeCacheUsedBytes: 900,
          codeCacheCapacityBytes: 1_000,
        },
      ],
    });
    expect(buildJitTrendRecording([first], "local:42", 500, 1_000)).toBeNull();
  });
});
