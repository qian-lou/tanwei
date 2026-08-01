import { describe, expect, it } from "vitest";
import {
  buildHeapHistogramDiff,
  heapHistogramCompatibilityIssue,
  type HeapHistogramRow,
  type HeapHistogramSnapshot,
} from "./heap-histogram-diff";

function row(
  className: string,
  instanceCount: number,
  shallowBytes: number,
): HeapHistogramRow {
  return {
    className,
    classLoader: "AppClassLoader@1",
    instanceCount,
    shallowBytes,
    averageShallowBytes:
      instanceCount === 0 ? 0 : Math.floor(shallowBytes / instanceCount),
  };
}

function snapshot(
  rows: readonly HeapHistogramRow[],
  overrides: Partial<HeapHistogramSnapshot> = {},
): HeapHistogramSnapshot {
  return {
    targetId: "local:42",
    targetStartTime: "2026-07-31T00:00:00Z",
    capturedAt: 1_000,
    query: "dev.example",
    limit: 100,
    scanLimit: 1_000_000,
    scanComplete: true,
    rowsComplete: true,
    accountedObjects: rows.reduce(
      (total, item) => total + item.instanceCount,
      0,
    ),
    accountedBytes: rows.reduce((total, item) => total + item.shallowBytes, 0),
    rows,
    ...overrides,
  };
}

describe("heap histogram diff", () => {
  it("builds an exact linear union for growing, released and stable classes", () => {
    const result = buildHeapHistogramDiff(
      snapshot([row("A", 10, 100), row("B", 5, 50)]),
      snapshot([row("A", 12, 130), row("C", 1, 20)], {
        capturedAt: 2_000,
      }),
    );

    expect(result).toMatchObject({
      exactRowCoverage: true,
      totalsComparable: true,
      instanceDelta: -2,
      shallowBytesDelta: 0,
      growingClasses: 2,
      releasedClasses: 1,
      stableClasses: 0,
      unmatchedBaselineRows: 0,
      unmatchedCurrentRows: 0,
    });
    expect(result.rows.map((item) => item.className)).toEqual(["B", "A", "C"]);
    expect(result.rows.map((item) => item.shallowBytesDelta)).toEqual([
      -50, 30, 20,
    ]);
  });

  it("compares only intersecting rows when either top-N result is incomplete", () => {
    const result = buildHeapHistogramDiff(
      snapshot([row("A", 10, 100), row("B", 5, 50)], {
        rowsComplete: false,
      }),
      snapshot([row("A", 13, 140), row("C", 2, 30)], {
        capturedAt: 2_000,
        rowsComplete: false,
      }),
    );

    expect(result.exactRowCoverage).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      className: "A",
      instanceDelta: 3,
      shallowBytesDelta: 40,
    });
    expect(result.unmatchedBaselineRows).toBe(1);
    expect(result.unmatchedCurrentRows).toBe(1);
  });

  it("withholds aggregate deltas when either heap traversal was truncated", () => {
    const result = buildHeapHistogramDiff(
      snapshot([row("A", 10, 100)]),
      snapshot([row("A", 11, 110)], {
        capturedAt: 2_000,
        scanComplete: false,
      }),
    );

    expect(result.totalsComparable).toBe(false);
    expect(result.instanceDelta).toBeNull();
    expect(result.shallowBytesDelta).toBeNull();
    expect(result.rows[0]?.instanceDelta).toBe(1);
  });

  it("rejects a different target, JVM lifetime, scope or scan budget", () => {
    const baseline = snapshot([]);

    expect(
      heapHistogramCompatibilityIssue(
        baseline,
        snapshot([], { targetId: "local:43" }),
      ),
    ).toBe("TARGET_CHANGED");
    expect(
      heapHistogramCompatibilityIssue(
        baseline,
        snapshot([], { targetStartTime: null }),
      ),
    ).toBe("JVM_IDENTITY_UNAVAILABLE");
    expect(
      heapHistogramCompatibilityIssue(
        baseline,
        snapshot([], { targetStartTime: "later" }),
      ),
    ).toBe("JVM_RESTARTED");
    expect(
      heapHistogramCompatibilityIssue(
        baseline,
        snapshot([], { query: "other" }),
      ),
    ).toBe("SCOPE_CHANGED");
    expect(
      heapHistogramCompatibilityIssue(
        baseline,
        snapshot([], { scanLimit: 5_000_000 }),
      ),
    ).toBe("BUDGET_CHANGED");
  });
});
