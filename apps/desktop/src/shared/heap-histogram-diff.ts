import type {
  HeapHistogramDeltaRow,
  HeapHistogramDiff,
  HeapHistogramRow,
  HeapHistogramSnapshot,
} from "./contracts.js";

export type HeapHistogramCompatibilityIssue =
  | "TARGET_CHANGED"
  | "JVM_IDENTITY_UNAVAILABLE"
  | "JVM_RESTARTED"
  | "SCOPE_CHANGED"
  | "BUDGET_CHANGED";

function rowKey(row: HeapHistogramRow): string {
  return `${row.className.length}:${row.className}${row.classLoader}`;
}

function safeDelta(current: number, baseline: number): number {
  const delta = current - baseline;
  if (Number.isSafeInteger(delta)) {
    return delta;
  }
  return delta < 0 ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
}

function deltaRow(
  baseline: HeapHistogramRow | null,
  current: HeapHistogramRow | null,
): HeapHistogramDeltaRow {
  const baselineInstances = baseline?.instanceCount ?? 0;
  const currentInstances = current?.instanceCount ?? 0;
  const baselineShallowBytes = baseline?.shallowBytes ?? 0;
  const currentShallowBytes = current?.shallowBytes ?? 0;
  const instanceDelta = safeDelta(currentInstances, baselineInstances);
  const shallowBytesDelta = safeDelta(
    currentShallowBytes,
    baselineShallowBytes,
  );
  return {
    className: current?.className ?? baseline?.className ?? "",
    classLoader: current?.classLoader ?? baseline?.classLoader ?? "",
    baselineInstances,
    currentInstances,
    instanceDelta,
    baselineShallowBytes,
    currentShallowBytes,
    shallowBytesDelta,
    kind:
      instanceDelta > 0 || shallowBytesDelta > 0
        ? "GROWTH"
        : instanceDelta < 0 || shallowBytesDelta < 0
          ? "RELEASE"
          : "STABLE",
  };
}

export function heapHistogramCompatibilityIssue(
  baseline: HeapHistogramSnapshot,
  current: HeapHistogramSnapshot,
): HeapHistogramCompatibilityIssue | null {
  if (baseline.targetId !== current.targetId) {
    return "TARGET_CHANGED";
  }
  if (
    baseline.targetStartTime === null ||
    current.targetStartTime === null
  ) {
    return "JVM_IDENTITY_UNAVAILABLE";
  }
  if (baseline.targetStartTime !== current.targetStartTime) {
    return "JVM_RESTARTED";
  }
  if (baseline.query !== current.query || baseline.limit !== current.limit) {
    return "SCOPE_CHANGED";
  }
  if (baseline.scanLimit !== current.scanLimit) {
    return "BUDGET_CHANGED";
  }
  return null;
}

/** Builds the class union or safe intersection in O(B+C) time and space. */
export function buildHeapHistogramDiff(
  baseline: HeapHistogramSnapshot,
  current: HeapHistogramSnapshot,
): HeapHistogramDiff {
  const issue = heapHistogramCompatibilityIssue(baseline, current);
  if (issue !== null) {
    throw new Error(`Incompatible heap histogram snapshots: ${issue}`);
  }

  const baselineByKey = new Map(
    baseline.rows.map((row) => [rowKey(row), row]),
  );
  const currentKeys = new Set<string>();
  const exactRowCoverage = baseline.rowsComplete && current.rowsComplete;
  const rows: HeapHistogramDeltaRow[] = [];
  let unmatchedCurrentRows = 0;

  for (const currentRow of current.rows) {
    const key = rowKey(currentRow);
    currentKeys.add(key);
    const baselineRow = baselineByKey.get(key) ?? null;
    if (baselineRow !== null || exactRowCoverage) {
      rows.push(deltaRow(baselineRow, currentRow));
    } else {
      unmatchedCurrentRows += 1;
    }
  }

  let unmatchedBaselineRows = 0;
  for (const baselineRow of baseline.rows) {
    if (currentKeys.has(rowKey(baselineRow))) {
      continue;
    }
    if (exactRowCoverage) {
      rows.push(deltaRow(baselineRow, null));
    } else {
      unmatchedBaselineRows += 1;
    }
  }

  rows.sort(
    (left, right) =>
      Math.abs(right.shallowBytesDelta) -
        Math.abs(left.shallowBytesDelta) ||
      Math.abs(right.instanceDelta) - Math.abs(left.instanceDelta) ||
      left.className.localeCompare(right.className) ||
      left.classLoader.localeCompare(right.classLoader),
  );

  let growingClasses = 0;
  let releasedClasses = 0;
  let stableClasses = 0;
  for (const row of rows) {
    switch (row.kind) {
      case "GROWTH":
        growingClasses += 1;
        break;
      case "RELEASE":
        releasedClasses += 1;
        break;
      case "STABLE":
        stableClasses += 1;
        break;
    }
  }

  const totalsComparable = baseline.scanComplete && current.scanComplete;
  return {
    exactRowCoverage,
    totalsComparable,
    instanceDelta: totalsComparable
      ? safeDelta(current.accountedObjects, baseline.accountedObjects)
      : null,
    shallowBytesDelta: totalsComparable
      ? safeDelta(current.accountedBytes, baseline.accountedBytes)
      : null,
    growingClasses,
    releasedClasses,
    stableClasses,
    unmatchedBaselineRows,
    unmatchedCurrentRows,
    rows,
  };
}
