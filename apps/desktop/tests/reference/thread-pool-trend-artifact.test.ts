import { describe, expect, it } from "vitest";
import type {
  ThreadPoolTrendInspectionReport,
  ThreadPoolTrendRecording,
} from "../../src/shared/contracts.js";
import {
  compareThreadPoolTrendReports,
  parseThreadPoolTrendArtifact,
  serializeThreadPoolTrendArtifact,
  summarizeThreadPoolTrend,
} from "./thread-pool-trend-artifact.js";

function recording(
  startedAt = 1_785_450_001_000,
  queues: readonly number[] = [0, 3, 8],
): ThreadPoolTrendRecording {
  return {
    targetId: "local:42",
    jvmStartTimeEpochMillis: 1_785_450_000_000,
    poolIdentity: "ThreadPoolExecutor@1a2b3c",
    poolClassName: "java.util.concurrent.ThreadPoolExecutor",
    poolKind: "THREAD_POOL",
    alias: "订单异步池",
    samplingIntervalMillis: 2_000,
    samples: queues.map((queue, index) => ({
      capturedAt: startedAt + index * 2_000,
      state: "RUNNING",
      configuredSize: 2,
      poolSize: 4,
      activeCount: 4,
      maximumSize: 4,
      queuedTasks: queue,
      remainingQueueCapacity: 100 - queue,
      completedTasks: 10 + index * 2,
      queuedSubmissions: null,
      runningCount: null,
      stealCount: null,
    })),
  };
}

function report(
  artifactId: string,
  value: ThreadPoolTrendRecording,
): ThreadPoolTrendInspectionReport {
  return {
    artifactId,
    schemaVersion: 1,
    recording: value,
    summary: summarizeThreadPoolTrend(value),
  };
}

describe("thread-pool trend artifact", () => {
  it("round-trips a bounded recording and derives starvation evidence", () => {
    const value = recording();
    const parsed = parseThreadPoolTrendArtifact(
      serializeThreadPoolTrendArtifact(value).toString("utf8"),
      "artifact-1",
    );

    expect(parsed.recording).toEqual(value);
    expect(parsed.summary).toMatchObject({
      sampleCount: 3,
      queueDelta: 8,
      peakQueue: 8,
      saturatedSamples: 3,
      completedTaskDelta: 4,
      throughputPerSecond: 1,
      starvationLikely: true,
    });
  });

  it("rejects mismatched identities, regressing counters and unordered time", () => {
    expect(() =>
      serializeThreadPoolTrendArtifact({
        ...recording(),
        poolClassName: "java.util.concurrent.ForkJoinPool",
      }),
    ).toThrow(/identity does not match/u);
    expect(() =>
      serializeThreadPoolTrendArtifact({
        ...recording(),
        samples: recording().samples.map((sample, index) => ({
          ...sample,
          completedTasks: 10 - index,
        })),
      }),
    ).toThrow(/counter regressed/u);
    expect(() =>
      serializeThreadPoolTrendArtifact({
        ...recording(),
        samples: [recording().samples[1]!, recording().samples[0]!],
      }),
    ).toThrow(/strictly chronological/u);
  });

  it("compares sequential recordings in linear time", () => {
    const baseline = recording(1_785_450_001_000, [1, 1, 1]);
    const current = recording(1_785_450_010_000, [2, 6, 10]);
    const comparison = compareThreadPoolTrendReports(
      report("baseline", baseline),
      report("current", current),
      {
        targetId: "local:42",
        baselineArtifactId: "baseline",
        currentArtifactId: "current",
      },
    );

    expect(comparison).toMatchObject({
      intervalMillis: 5_000,
      peakQueueDelta: 9,
      endingQueueDelta: 9,
      starvationChanged: true,
    });
  });

  it("fails closed across a JVM restart, pool change or overlapping windows", () => {
    const baseline = recording();
    expect(() =>
      compareThreadPoolTrendReports(
        report("baseline", baseline),
        report("current", {
          ...recording(1_785_450_010_000),
          jvmStartTimeEpochMillis: 1_785_450_009_000,
        }),
        {
          targetId: "local:42",
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/JVM_RESTARTED/u);
    expect(() =>
      compareThreadPoolTrendReports(
        report("baseline", baseline),
        report("current", {
          ...recording(1_785_450_010_000),
          poolIdentity: "ThreadPoolExecutor@ffffff",
        }),
        {
          targetId: "local:42",
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/POOL_IDENTITY_CHANGED/u);
    expect(() =>
      compareThreadPoolTrendReports(
        report("baseline", baseline),
        report("current", recording(1_785_450_003_000)),
        {
          targetId: "local:42",
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/finish before/u);
  });
});
