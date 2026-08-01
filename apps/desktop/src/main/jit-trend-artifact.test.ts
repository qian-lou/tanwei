import { describe, expect, it } from "vitest";
import type {
  JitTrendInspectionReport,
  JitTrendRecording,
} from "../shared/contracts.js";
import { codeCachePressure } from "../shared/jit-trend.js";
import {
  compareJitTrendReports,
  parseJitTrendArtifact,
  serializeJitTrendArtifact,
  summarizeJitTrend,
} from "./jit-trend-artifact.js";

function recording(
  overrides: Partial<JitTrendRecording> = {},
): JitTrendRecording {
  return {
    targetId: "local:42",
    jvmStartTimeEpochMillis: 500,
    samplingIntervalMillis: 10_000,
    samples: [
      {
        sampledAtEpochMillis: 1_000,
        totalCompiles: 100,
        standardCompiles: 90,
        osrCompiles: 10,
        bailouts: 1,
        invalidations: 2,
        compilerTimeMillis: 200,
        codeCacheUsedBytes: 70,
        codeCacheCapacityBytes: 100,
        codeCacheCapacityKind: "MAX",
      },
      {
        sampledAtEpochMillis: 11_000,
        totalCompiles: 120,
        standardCompiles: 108,
        osrCompiles: 12,
        bailouts: 2,
        invalidations: 3,
        compilerTimeMillis: 700,
        codeCacheUsedBytes: 85,
        codeCacheCapacityBytes: 100,
        codeCacheCapacityKind: "MAX",
      },
    ],
    ...overrides,
  };
}

function report(
  artifactId: string,
  value: JitTrendRecording,
): JitTrendInspectionReport {
  return {
    artifactId,
    schemaVersion: value.regressionIdentity ? 2 : 1,
    recording: value,
    summary: summarizeJitTrend(value),
  };
}

describe("JIT trend artifacts", () => {
  it("round-trips a bounded window and derives rates and pressure", () => {
    const parsed = parseJitTrendArtifact(
      serializeJitTrendArtifact(recording()).toString("utf8"),
      "artifact-a",
    );

    expect(parsed.summary).toMatchObject({
      sampleCount: 2,
      durationMillis: 10_000,
      compileDelta: 20,
      standardCompileDelta: 18,
      osrCompileDelta: 2,
      failureDelta: 2,
      compilesPerSecond: 2,
      failuresPerSecond: 0.2,
      compilationTimePercent: 5,
      codeCacheGrowthBytes: 15,
      endingCodeCachePercent: 85,
      peakCodeCachePercent: 85,
      codeCachePressure: "ELEVATED",
    });
  });

  it("round-trips a portable v2 regression identity", () => {
    const parsed = parseJitTrendArtifact(
      serializeJitTrendArtifact(
        recording({
          regressionIdentity: {
            workloadKey: "checkout-steady-100rps",
            releaseLabel: "2026.07.1",
            targetMainClass: "dev.tanwei.CheckoutApplication",
            javaVersion: "25.0.1",
            compilerName: "HotSpot 64-Bit Tiered Compilers",
          },
        }),
      ).toString("utf8"),
      "artifact-v2",
    );

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.recording.regressionIdentity).toMatchObject({
      workloadKey: "checkout-steady-100rps",
      releaseLabel: "2026.07.1",
      javaVersion: "25.0.1",
    });
  });

  it("classifies explicit 80, 90 and 100 percent boundaries", () => {
    expect(codeCachePressure(79, 100).state).toBe("NORMAL");
    expect(codeCachePressure(80, 100).state).toBe("ELEVATED");
    expect(codeCachePressure(90, 100).state).toBe("HIGH");
    expect(codeCachePressure(100, 100).state).toBe("EXHAUSTED");
    expect(() => codeCachePressure(101, 100)).toThrow(/boundary/u);
  });

  it("rejects non-chronological, regressing and incompatible samples", () => {
    const base = recording();
    expect(() =>
      serializeJitTrendArtifact({
        ...base,
        samples: [base.samples[0]!, base.samples[0]!],
      }),
    ).toThrow(/chronological/u);
    expect(() =>
      serializeJitTrendArtifact({
        ...base,
        samples: [base.samples[0]!, { ...base.samples[1]!, totalCompiles: 99 }],
      }),
    ).toThrow(/regressed/u);
    expect(() =>
      serializeJitTrendArtifact({
        ...base,
        samples: [
          base.samples[0]!,
          {
            ...base.samples[1]!,
            codeCacheCapacityKind: "COMMITTED",
          },
        ],
      }),
    ).toThrow(/semantics/u);
  });

  it("compares non-overlapping windows from the same JVM cycle", () => {
    const baseline = recording();
    const current = recording({
      samples: [
        {
          ...baseline.samples[1]!,
          sampledAtEpochMillis: 20_000,
          codeCacheUsedBytes: 80,
        },
        {
          ...baseline.samples[1]!,
          sampledAtEpochMillis: 30_000,
          totalCompiles: 160,
          standardCompiles: 144,
          osrCompiles: 16,
          bailouts: 4,
          invalidations: 4,
          compilerTimeMillis: 1_700,
          codeCacheUsedBytes: 95,
        },
      ],
    });

    const comparison = compareJitTrendReports(
      report("baseline", baseline),
      report("current", current),
      {
        baselineArtifactId: "baseline",
        currentArtifactId: "current",
      },
    );

    expect(comparison.compileRateDelta).toBe(2);
    expect(comparison.endingCodeCachePercentDelta).toBe(10);
    expect(comparison.current.codeCachePressure).toBe("HIGH");
    expect(comparison.pressureChanged).toBe(true);
    expect(() =>
      compareJitTrendReports(
        report("baseline", baseline),
        report("current", {
          ...current,
          jvmStartTimeEpochMillis: 501,
        }),
        {
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/JVM_RESTARTED/u);
    expect(() =>
      compareJitTrendReports(
        report("baseline", baseline),
        report("current", {
          ...current,
          samples: current.samples.map((sample) => ({
            ...sample,
            codeCacheCapacityKind: "COMMITTED" as const,
          })),
        }),
        {
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/CODE_CACHE_CAPACITY_CHANGED/u);
    expect(() =>
      compareJitTrendReports(
        report("baseline", baseline),
        report("current", {
          ...current,
          samples: current.samples.map((sample) => ({
            ...sample,
            codeCacheCapacityBytes: 101,
          })),
        }),
        {
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/CODE_CACHE_CAPACITY_CHANGED/u);
  });

  it("compares verified releases across different JVM cycles", () => {
    const identity = {
      workloadKey: "checkout-steady-100rps",
      releaseLabel: "2026.07.1",
      targetMainClass: "dev.tanwei.CheckoutApplication",
      javaVersion: "21.0.8",
      compilerName: "HotSpot 64-Bit Tiered Compilers",
    };
    const baseline = recording({ regressionIdentity: identity });
    const current = recording({
      targetId: "local:43",
      jvmStartTimeEpochMillis: 15_000,
      regressionIdentity: {
        ...identity,
        releaseLabel: "2026.07.2",
        javaVersion: "25.0.1",
      },
      samples: [
        {
          ...baseline.samples[0]!,
          sampledAtEpochMillis: 20_000,
          totalCompiles: 140,
          standardCompiles: 126,
          osrCompiles: 14,
          bailouts: 4,
          invalidations: 3,
          compilerTimeMillis: 1_200,
          codeCacheUsedBytes: 75,
        },
        {
          ...baseline.samples[1]!,
          sampledAtEpochMillis: 30_000,
          totalCompiles: 180,
          standardCompiles: 162,
          osrCompiles: 18,
          bailouts: 6,
          invalidations: 5,
          compilerTimeMillis: 2_100,
          codeCacheUsedBytes: 92,
        },
      ],
    });

    const comparison = compareJitTrendReports(
      report("release-a", baseline),
      report("release-b", current),
      {
        baselineArtifactId: "release-a",
        currentArtifactId: "release-b",
        mode: "CROSS_RELEASE",
      },
    );

    expect(comparison).toMatchObject({
      mode: "CROSS_RELEASE",
      baselineTargetId: "local:42",
      currentTargetId: "local:43",
      baselineIdentity: { releaseLabel: "2026.07.1" },
      currentIdentity: { releaseLabel: "2026.07.2" },
    });
    expect(comparison.compileRateDelta).toBe(2);
    expect(comparison.peakCodeCachePercentDelta).toBe(7);

    expect(() =>
      compareJitTrendReports(
        report("release-a", baseline),
        report("release-b", {
          ...current,
          regressionIdentity: {
            ...current.regressionIdentity!,
            releaseLabel: identity.releaseLabel,
          },
        }),
        {
          baselineArtifactId: "release-a",
          currentArtifactId: "release-b",
          mode: "CROSS_RELEASE",
        },
      ),
    ).toThrow(/RELEASE_LABEL_UNCHANGED/u);
  });

  it("rejects unsafe cross-release pairings before calculating deltas", () => {
    const baseline = recording({
      regressionIdentity: {
        workloadKey: "checkout-steady-100rps",
        releaseLabel: "2026.07.1",
        targetMainClass: "dev.tanwei.CheckoutApplication",
        javaVersion: "21.0.8",
        compilerName: "HotSpot 64-Bit Tiered Compilers",
      },
    });
    const current = recording({
      targetId: "local:43",
      jvmStartTimeEpochMillis: 12_000,
      regressionIdentity: {
        ...baseline.regressionIdentity!,
        releaseLabel: "2026.07.2",
      },
      samples: baseline.samples.map((sample, index) => ({
        ...sample,
        sampledAtEpochMillis: 13_000 + index * 10_000,
      })),
    });
    const compare = (candidate: JitTrendRecording) =>
      compareJitTrendReports(
        report("release-a", baseline),
        report("release-b", candidate),
        {
          baselineArtifactId: "release-a",
          currentArtifactId: "release-b",
          mode: "CROSS_RELEASE",
        },
      );

    expect(() =>
      compare({
        ...current,
        targetId: baseline.targetId,
        jvmStartTimeEpochMillis: baseline.jvmStartTimeEpochMillis,
      }),
    ).toThrow(/SAME_JVM_CYCLE/u);
    expect(() =>
      compare({
        ...current,
        regressionIdentity: {
          ...current.regressionIdentity!,
          workloadKey: "different-workload",
        },
      }),
    ).toThrow(/WORKLOAD_MISMATCH/u);
    expect(() =>
      compare({ ...current, samplingIntervalMillis: 5_000 }),
    ).toThrow(/SAMPLING_INTERVAL_CHANGED/u);
    expect(() =>
      compare({
        ...current,
        samples: current.samples.map((sample) => ({
          ...sample,
          codeCacheCapacityKind: "COMMITTED" as const,
        })),
      }),
    ).toThrow(/MAX_CAPACITY_REQUIRED/u);
    expect(() =>
      compare({
        ...current,
        samples: current.samples.map((sample, index) => ({
          ...sample,
          sampledAtEpochMillis: 13_000 + index * 20_000,
        })),
      }),
    ).toThrow(/DURATION_MISMATCH/u);
    const { regressionIdentity: _, ...unlabeledCurrent } = current;
    expect(() => compare(unlabeledCurrent)).toThrow(
      /REGRESSION_IDENTITY_MISSING/u,
    );
  });
});
