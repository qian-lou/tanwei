import { describe, expect, it } from "vitest";
import type {
  HeapHistogramInspectionReport,
  HeapHistogramSnapshot,
} from "../../src/shared/contracts.js";
import {
  compareHeapHistogramReports,
  parseHeapHistogramArtifact,
  serializeHeapHistogramArtifact,
} from "./heap-histogram-artifact.js";

function snapshot(
  capturedAt = 1_000,
  count = 3,
): HeapHistogramSnapshot {
  return {
    targetId: "local:42",
    targetStartTime: "2026-07-31T00:00:00Z",
    capturedAt,
    query: "dev.example",
    limit: 100,
    scanLimit: 1_000_000,
    scanComplete: true,
    rowsComplete: true,
    accountedObjects: count,
    accountedBytes: count * 24,
    rows: [
      {
        className: "dev.example.Probe",
        classLoader: "AppClassLoader@1",
        instanceCount: count,
        shallowBytes: count * 24,
        averageShallowBytes: 24,
      },
    ],
  };
}

function report(
  artifactId: string,
  value: HeapHistogramSnapshot,
): HeapHistogramInspectionReport {
  return { artifactId, schemaVersion: 1, snapshot: value };
}

describe("heap histogram artifact", () => {
  it("round-trips a bounded versioned snapshot", () => {
    const content = serializeHeapHistogramArtifact(snapshot()).toString(
      "utf8",
    );
    expect(parseHeapHistogramArtifact(content, "artifact-1")).toEqual({
      artifactId: "artifact-1",
      schemaVersion: 1,
      snapshot: snapshot(),
    });
  });

  it("rejects duplicate identities and inconsistent complete totals", () => {
    const duplicate = {
      ...snapshot(),
      accountedObjects: 6,
      accountedBytes: 144,
      rows: [...snapshot().rows, ...snapshot().rows],
    };
    expect(() => serializeHeapHistogramArtifact(duplicate)).toThrow(
      /Duplicate class and ClassLoader identity/u,
    );
    expect(() =>
      serializeHeapHistogramArtifact({
        ...snapshot(),
        accountedObjects: 4,
      }),
    ).toThrow(/Complete rows must equal/u);
  });

  it("compares two persisted reports and preserves completeness semantics", () => {
    const comparison = compareHeapHistogramReports(
      report("baseline", snapshot(1_000, 3)),
      report("current", snapshot(3_500, 15)),
      {
        targetId: "local:42",
        baselineArtifactId: "baseline",
        currentArtifactId: "current",
      },
    );
    expect(comparison).toMatchObject({
      intervalMillis: 2_500,
      instanceDelta: 12,
      shallowBytesDelta: 288,
      growingClasses: 1,
      exactRowCoverage: true,
      totalsComparable: true,
    });
    expect(comparison.rows[0]).toMatchObject({
      className: "dev.example.Probe",
      instanceDelta: 12,
      shallowBytesDelta: 288,
    });
  });

  it("fails closed across a JVM restart or reversed capture order", () => {
    expect(() =>
      compareHeapHistogramReports(
        report("baseline", snapshot(1_000)),
        report("current", {
          ...snapshot(2_000),
          targetStartTime: "2026-07-31T01:00:00Z",
        }),
        {
          targetId: "local:42",
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/JVM_RESTARTED/u);
    expect(() =>
      compareHeapHistogramReports(
        report("baseline", snapshot(3_000)),
        report("current", snapshot(2_000)),
        {
          targetId: "local:42",
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/captured first/u);
  });
});
