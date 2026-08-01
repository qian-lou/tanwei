export type InvocationValueKind =
  | "NULL"
  | "SCALAR"
  | "OBJECT"
  | "ARRAY"
  | "COLLECTION"
  | "MAP"
  | "ENTRY"
  | "REFERENCE"
  | "MASKED"
  | "UNAVAILABLE"
  | "OPAQUE";

export interface InvocationValueNode {
  readonly path: string;
  readonly parentIndex: number;
  readonly depth: number;
  readonly kind: InvocationValueKind;
  readonly typeName: string;
  readonly value: string;
  readonly childCount: number;
  readonly truncated: boolean;
}

export interface InvocationValueEvidence {
  readonly available: boolean;
  readonly scannedFields: number;
  readonly truncated: boolean;
  readonly nodes: readonly InvocationValueNode[];
}

export interface InvocationValueDiffInput {
  readonly snapshotId: number;
  readonly className: string;
  readonly classLoader: string;
  readonly method: string;
  readonly invocationValues: InvocationValueEvidence;
}

export type InvocationValueChangeKind = "ADDED" | "REMOVED" | "CHANGED";

export interface InvocationValueChange {
  readonly key: string;
  readonly path: string;
  readonly depth: number;
  readonly kind: InvocationValueChangeKind;
  readonly before: InvocationValueNode | null;
  readonly after: InvocationValueNode | null;
}

export type InvocationValueDiffCompatibility =
  | "COMPATIBLE"
  | "SAME_SNAPSHOT"
  | "METHOD_MISMATCH"
  | "VALUES_UNAVAILABLE";

export interface InvocationValueDiff {
  readonly compatibility: InvocationValueDiffCompatibility;
  readonly baselineSnapshotId: number;
  readonly currentSnapshotId: number;
  readonly addedCount: number;
  readonly removedCount: number;
  readonly changedCount: number;
  readonly unchangedCount: number;
  readonly truncated: boolean;
  readonly changes: readonly InvocationValueChange[];
}

interface IndexedNode {
  readonly key: string;
  readonly node: InvocationValueNode;
}

function indexedNodes(nodes: readonly InvocationValueNode[]): readonly IndexedNode[] {
  const occurrences = new Map<string, number>();
  return nodes.map((node) => {
    const occurrence = occurrences.get(node.path) ?? 0;
    occurrences.set(node.path, occurrence + 1);
    return {
      key: `${node.path}\u0000${occurrence}`,
      node,
    };
  });
}

function nodesEqual(
  baseline: InvocationValueNode,
  current: InvocationValueNode,
): boolean {
  return (
    baseline.depth === current.depth &&
    baseline.kind === current.kind &&
    baseline.typeName === current.typeName &&
    baseline.value === current.value &&
    baseline.childCount === current.childCount &&
    baseline.truncated === current.truncated
  );
}

function emptyDiff(
  compatibility: Exclude<
    InvocationValueDiffCompatibility,
    "COMPATIBLE"
  >,
  baseline: InvocationValueDiffInput,
  current: InvocationValueDiffInput,
): InvocationValueDiff {
  return {
    compatibility,
    baselineSnapshotId: baseline.snapshotId,
    currentSnapshotId: current.snapshotId,
    addedCount: 0,
    removedCount: 0,
    changedCount: 0,
    unchangedCount: 0,
    truncated:
      baseline.invocationValues.truncated ||
      current.invocationValues.truncated,
    changes: [],
  };
}

/**
 * Compares two bounded invocation trees in O(B + C) time and memory, where
 * B and C are each capped at 96 validated nodes by the snapshot parser.
 */
export function buildInvocationValueDiff(
  baseline: InvocationValueDiffInput,
  current: InvocationValueDiffInput,
): InvocationValueDiff {
  if (baseline.snapshotId === current.snapshotId) {
    return emptyDiff("SAME_SNAPSHOT", baseline, current);
  }
  if (
    baseline.className !== current.className ||
    baseline.classLoader !== current.classLoader ||
    baseline.method !== current.method
  ) {
    return emptyDiff("METHOD_MISMATCH", baseline, current);
  }
  if (
    !baseline.invocationValues.available ||
    !current.invocationValues.available
  ) {
    return emptyDiff("VALUES_UNAVAILABLE", baseline, current);
  }

  const baselineNodes = indexedNodes(baseline.invocationValues.nodes);
  const currentNodes = indexedNodes(current.invocationValues.nodes);
  const baselineByKey = new Map(
    baselineNodes.map((entry) => [entry.key, entry.node]),
  );
  const currentKeys = new Set(currentNodes.map((entry) => entry.key));
  const changes: InvocationValueChange[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;

  for (const entry of currentNodes) {
    const previous = baselineByKey.get(entry.key);
    if (!previous) {
      addedCount += 1;
      changes.push({
        key: `added:${entry.key}`,
        path: entry.node.path,
        depth: entry.node.depth,
        kind: "ADDED",
        before: null,
        after: entry.node,
      });
    } else if (nodesEqual(previous, entry.node)) {
      unchangedCount += 1;
    } else {
      changedCount += 1;
      changes.push({
        key: `changed:${entry.key}`,
        path: entry.node.path,
        depth: entry.node.depth,
        kind: "CHANGED",
        before: previous,
        after: entry.node,
      });
    }
  }

  for (const entry of baselineNodes) {
    if (currentKeys.has(entry.key)) {
      continue;
    }
    removedCount += 1;
    changes.push({
      key: `removed:${entry.key}`,
      path: entry.node.path,
      depth: entry.node.depth,
      kind: "REMOVED",
      before: entry.node,
      after: null,
    });
  }

  return {
    compatibility: "COMPATIBLE",
    baselineSnapshotId: baseline.snapshotId,
    currentSnapshotId: current.snapshotId,
    addedCount,
    removedCount,
    changedCount,
    unchangedCount,
    truncated:
      baseline.invocationValues.truncated ||
      current.invocationValues.truncated,
    changes,
  };
}
