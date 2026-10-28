import { describe, expect, it } from "vitest";
import { parseJfrReportJson } from "./jfr-report.js";

function event(type: string, values: Readonly<Record<string, unknown>>) {
  return { type, values };
}

function executionSample(
  capturedAt: string,
  owner: string,
  method: string,
) {
  return event("jdk.ExecutionSample", {
    startTime: capturedAt,
    stackTrace: {
      frames: [
        {
          method: {
            type: { name: owner },
            name: method,
          },
        },
      ],
    },
  });
}

function jfrMethod(owner: string, method: string, descriptor: string) {
  return {
    type: { name: owner },
    name: method,
    descriptor,
  };
}

describe("JFR report parser", () => {
  it("builds bounded runtime, compilation and deoptimization summaries", () => {
    const report = parseJfrReportJson(
      JSON.stringify({
        recording: {
          events: [
            executionSample(
              "2026-07-30T10:00:00.000Z",
              "dev/example/Worker",
              "run",
            ),
            executionSample(
              "2026-07-30T10:00:00.100Z",
              "dev/example/Worker",
              "run",
            ),
            executionSample(
              "2026-07-30T10:00:00.200Z",
              "dev/example/Other",
              "call",
            ),
            event("jdk.ObjectAllocationSample", {
              startTime: "2026-07-30T10:00:00.300Z",
              objectClass: { name: "java/lang/String" },
              weight: 4_096,
            }),
            event("jdk.CPULoad", {
              startTime: "2026-07-30T10:00:00.400Z",
              jvmUser: 0.25,
              jvmSystem: 0.05,
              machineTotal: 0.6,
            }),
            event("jdk.GarbageCollection", {
              startTime: "2026-07-30T10:00:00.500Z",
              name: "G1New",
              cause: "Allocation Failure",
              duration: "PT0.0125S",
            }),
            event("jdk.Compilation", {
              startTime: "2026-07-30T10:00:00.600Z",
              duration: "PT0.002S",
              compiler: "c1",
              method: jfrMethod(
                "dev/example/Worker",
                "run",
                "()V",
              ),
              compileLevel: 3,
              succeded: true,
              isOsr: false,
              codeSize: 1_024,
              inlinedBytes: 128,
            }),
            event("jdk.Compilation", {
              startTime: "2026-07-30T10:00:00.700Z",
              duration: "PT0.004S",
              compiler: "c1",
              method: jfrMethod(
                "dev/example/Worker",
                "run",
                "()V",
              ),
              compileLevel: 3,
              succeded: true,
              isOsr: true,
              codeSize: 2_048,
              inlinedBytes: 256,
            }),
            event("jdk.Compilation", {
              startTime: "2026-07-30T10:00:00.800Z",
              duration: "PT0.008S",
              compiler: "c2",
              method: jfrMethod(
                "dev/example/Worker",
                "run",
                "()V",
              ),
              compileLevel: 4,
              succeeded: false,
              isOsr: false,
              codeSize: 4_096,
              inlinedBytes: 512,
            }),
            event("jdk.Deoptimization", {
              startTime: "2026-07-30T10:00:00.850Z",
              compiler: "c2",
              method: jfrMethod(
                "dev/example/Worker",
                "run",
                "()V",
              ),
              reason: "class_check",
              action: "maybe_recompile",
            }),
            event("jdk.Deoptimization", {
              startTime: "2026-07-30T10:00:00.900Z",
              compiler: "c2",
              method: jfrMethod(
                "dev/example/Worker",
                "run",
                "()V",
              ),
              reason: "class_check",
              action: "maybe_recompile",
            }),
          ],
        },
      }),
      "artifact-1",
    );

    expect(report.eventCount).toBe(11);
    expect(report.durationMillis).toBe(900);
    expect(report.hotMethods[0]).toEqual({
      method: "dev.example.Worker.run",
      samples: 2,
      sharePercent: 200 / 3,
    });
    expect(report.allocations[0]).toEqual({
      className: "java.lang.String",
      samples: 1,
      estimatedBytes: 4_096,
    });
    expect(report.cpuSamples[0]?.jvmUser).toBe(0.25);
    expect(report.gcPauses[0]?.durationMillis).toBe(12.5);
    expect(report.eventTypes.find(({ type }) => type === "jdk.ExecutionSample")).toEqual({
      type: "jdk.ExecutionSample",
      count: 3,
    });
    expect(report.compilationCount).toBe(3);
    expect(report.deoptimizationCount).toBe(2);
    expect(report.compilationDurationMillis).toBe(14);
    expect(report.compiledCodeBytes).toBe(7_168);
    expect(report.compilations[0]).toMatchObject({
      method: "dev.example.Worker.run()V",
      compiler: "C2",
      compileLevel: 4,
      compilations: 1,
      failedCompilations: 1,
      totalDurationMillis: 8,
      codeBytes: 4_096,
    });
    expect(report.compilations[1]).toMatchObject({
      method: "dev.example.Worker.run()V",
      compiler: "C1",
      compileLevel: 3,
      compilations: 2,
      osrCompilations: 1,
      succeededCompilations: 2,
      totalDurationMillis: 6,
      maximumDurationMillis: 4,
      codeBytes: 3_072,
      inlinedBytes: 384,
    });
    expect(report.compilerTiers).toEqual([
      {
        compiler: "C1",
        compilations: 2,
        osrCompilations: 1,
        failedCompilations: 0,
        totalDurationMillis: 6,
        codeBytes: 3_072,
      },
      {
        compiler: "C2",
        compilations: 1,
        osrCompilations: 0,
        failedCompilations: 1,
        totalDurationMillis: 8,
        codeBytes: 4_096,
      },
    ]);
    expect(report.deoptimizations[0]).toEqual({
      method: "dev.example.Worker.run()V",
      compiler: "C2",
      reason: "class_check",
      action: "maybe_recompile",
      count: 2,
    });
    expect(report.truncated).toBe(false);
  });

  it("ignores malformed optional values without producing NaN", () => {
    const report = parseJfrReportJson(
      JSON.stringify({
        recording: {
          events: [
            event("jdk.CPULoad", {
              startTime: "invalid",
              jvmUser: "0.5",
            }),
            event("jdk.ObjectAllocationSample", {
              objectClass: null,
              weight: -1,
            }),
            event("jdk.Compilation", {
              duration: "not-a-duration",
              compiler: 42,
              method: jfrMethod(
                "dev/example/Probe",
                "run",
                "()V",
              ),
              compileLevel: -1,
              codeSize: -1,
            }),
          ],
        },
      }),
      "artifact-2",
    );

    expect(report.startedAt).toBeNull();
    expect(report.cpuSamples).toEqual([]);
    expect(report.allocations[0]?.estimatedBytes).toBe(0);
    expect(report.compilationCount).toBe(1);
    expect(report.deoptimizationCount).toBe(0);
    expect(report.compilations[0]).toMatchObject({
      compiler: "OTHER",
      compileLevel: null,
      unknownOutcomeCompilations: 1,
      totalDurationMillis: 0,
      codeBytes: 0,
    });
    expect(report.deoptimizations).toEqual([]);
  });

  it("caps compilation and deoptimization tables independently", () => {
    const compilations = Array.from({ length: 51 }, (_, index) =>
      event("jdk.Compilation", {
        compiler: index % 2 === 0 ? "c1" : "c2",
        method: jfrMethod(
          `dev/example/Compiler${index}`,
          "run",
          "()V",
        ),
        compileLevel: index % 5,
        succeded: true,
        duration: index,
        codeSize: index,
      }),
    );
    const deoptimizations = Array.from({ length: 51 }, (_, index) =>
      event("jdk.Deoptimization", {
        compiler: "c2",
        method: jfrMethod(
          `dev/example/Deopt${index}`,
          "run",
          "()V",
        ),
        reason: `reason-${index}`,
        action: "maybe_recompile",
      }),
    );
    const report = parseJfrReportJson(
      JSON.stringify({
        recording: {
          events: [...compilations, ...deoptimizations],
        },
      }),
      "artifact-bounded",
    );

    expect(report.compilationCount).toBe(51);
    expect(report.deoptimizationCount).toBe(51);
    expect(report.compilations).toHaveLength(50);
    expect(report.deoptimizations).toHaveLength(50);
    expect(report.truncated).toBe(true);
  });

  it("rejects JSON without the JFR event envelope", () => {
    expect(() => parseJfrReportJson("{}", "artifact-3")).toThrow(
      "JFR JSON 缺少事件列表",
    );
  });
});
