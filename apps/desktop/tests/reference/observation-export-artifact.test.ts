// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseObservationExportArtifact,
  serializeMonitorWindowsArtifact,
  serializeTraceHotspotArtifact,
  summarizeMonitorWindows,
} from "./observation-export-artifact.js";

const JVM_START = 1_785_450_000_000;
const EXPORTED_AT = JVM_START + 60_000;
const TASK_ID = "4ff55836-c7de-4d82-a4b5-6008f9a9f55c";
const target = {
  className: "dev.tanwei.OrderService",
  classLoader: "AppClassLoader@1a2b3c",
  methodName: "submit",
  parameterTypes: ["java.lang.String"],
} as const;

describe("observation export artifacts", () => {
  it("recomputes bounded Trace hotspots before serializing", () => {
    const content = serializeTraceHotspotArtifact(
      {
        targetId: "local:42",
        taskId: TASK_ID,
        taskState: "SUCCEEDED",
        target,
        rootMethod: "dev.tanwei.OrderService#submit(java.lang.String)",
        scopePrefix: "dev.tanwei",
        includeRules: ["dev.tanwei.*"],
        excludeRules: [],
        dropped: 2,
        traces: [
          {
            traceId: 1,
            capturedAtEpochMillis: JVM_START + 10_000,
            durationNanos: 100,
            truncatedSpans: 0,
            spans: [
              span(1, null, "OrderService#submit", 100),
              span(2, 1, "OrderRepository#save", 70),
            ],
          },
        ],
      },
      JVM_START,
      EXPORTED_AT,
    );

    const report = parseObservationExportArtifact(
      content.toString("utf8"),
      TASK_ID,
    );
    expect(report.kind).toBe("TRACE_HOTSPOTS");
    if (report.kind !== "TRACE_HOTSPOTS") {
      throw new Error("Expected a Trace hotspot report");
    }
    expect(report.recording).toMatchObject({
      jvmStartTimeEpochMillis: JVM_START,
      traceCount: 1,
      spanCount: 2,
      dropped: 2,
    });
    expect(report.recording.hotspots[0]).toMatchObject({
      method: "OrderRepository#save",
      selfDurationNanos: 70,
    });
  });

  it("persists full Monitor windows and derives cumulative summary", () => {
    const windows = [
      windowSample(1, JVM_START + 1_000, 5, 1, 500, 200, 150, 180),
      windowSample(2, JVM_START + 2_000, 3, 0, 240, 100, 80, 90, 25),
    ];
    const content = serializeMonitorWindowsArtifact(
      {
        targetId: "local:42",
        taskId: TASK_ID,
        taskState: "RUNNING",
        target,
        method: "dev.tanwei.OrderService#submit(java.lang.String)",
        intervalMillis: 1_000,
        windows,
      },
      JVM_START,
      EXPORTED_AT,
    );

    const report = parseObservationExportArtifact(
      content.toString("utf8"),
      TASK_ID,
    );
    expect(report.kind).toBe("MONITOR_WINDOWS");
    if (report.kind !== "MONITOR_WINDOWS") {
      throw new Error("Expected a Monitor windows report");
    }
    expect(report.recording.windows).toEqual(windows);
    expect(report.recording.summary).toEqual({
      windowCount: 2,
      totalCalls: 8,
      totalFailures: 1,
      totalDurationNanos: 740,
      averageDurationNanos: 92.5,
      maximumDurationNanos: 200,
      maximumP95DurationNanos: 150,
      maximumP99DurationNanos: 180,
    });
  });

  it("accepts percentile bucket upper bounds above the observed maximum", () => {
    expect(() =>
      serializeMonitorWindowsArtifact(
        {
          targetId: "local:42",
          taskId: TASK_ID,
          taskState: "RUNNING",
          target,
          method: "dev.tanwei.OrderService#submit(java.lang.String)",
          intervalMillis: 1_000,
          windows: [
            windowSample(1, JVM_START + 1_000, 9, 0, 90, 30, 40, 40),
          ],
        },
        JVM_START,
        EXPORTED_AT,
      ),
    ).not.toThrow();
  });

  it("rejects stale JVM timestamps and unsafe aggregate counters", () => {
    expect(() =>
      serializeMonitorWindowsArtifact(
        {
          targetId: "local:42",
          taskId: TASK_ID,
          taskState: "SUCCEEDED",
          target,
          method: "dev.tanwei.OrderService#submit(java.lang.String)",
          intervalMillis: 1_000,
          windows: [
            windowSample(1, JVM_START - 2_000, 1, 0, 1, 1, 1, 1),
          ],
        },
        JVM_START,
        EXPORTED_AT,
      ),
    ).toThrow("JVM cycle");
    expect(() =>
      summarizeMonitorWindows([
        windowSample(
          1,
          JVM_START + 1_000,
          Number.MAX_SAFE_INTEGER,
          0,
          1,
          1,
          1,
          1,
        ),
        windowSample(2, JVM_START + 2_000, 1, 0, 1, 1, 1, 1),
      ]),
    ).toThrow("safe integer");
  });
});

function span(
  sequence: number,
  parentSequence: number | null,
  method: string,
  durationNanos: number,
) {
  return {
    sequence,
    parentSequence,
    method,
    durationNanos,
    exceptionType: null,
  };
}

function windowSample(
  sequence: number,
  startedAtEpochMillis: number,
  calls: number,
  failures: number,
  durationNanos: number,
  maximumDurationNanos: number,
  p95DurationNanos: number,
  p99DurationNanos: number,
  minimumDurationMillis = 0,
) {
  return {
    sequence,
    startedAtEpochMillis,
    endedAtEpochMillis: startedAtEpochMillis + 1_000,
    calls,
    failures,
    durationNanos,
    maximumDurationNanos,
    p95DurationNanos,
    p99DurationNanos,
    minimumDurationMillis,
  };
}
