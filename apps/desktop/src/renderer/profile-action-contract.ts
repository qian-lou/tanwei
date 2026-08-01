import type {
  ActionResult,
  CollectAgentArtifactInput,
} from "@shared/contracts";
import type { HeapHistogramRow } from "./heap-histogram-diff";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ProfileTaskState =
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export interface ArtifactTicket {
  readonly token: string;
  readonly type: CollectAgentArtifactInput["type"];
  readonly expectedSize: number;
}

export interface ProfileTaskSnapshot {
  readonly taskId: string;
  readonly state: ProfileTaskState;
  readonly samples: number;
  readonly dropped: number;
  readonly engine: string;
  readonly artifact: ArtifactTicket | null;
}

export interface JfrStatusSnapshot {
  readonly running: boolean;
  readonly recordingName: string | null;
  readonly configuration: "PROFILE" | "DEFAULT" | null;
  readonly maxAgeMillis: number;
  readonly maxSizeBytes: number;
}

export interface HeapHistogramResult {
  readonly rows: readonly HeapHistogramRow[];
  readonly scanned: number;
  readonly accountedObjects: number;
  readonly accountedBytes: number;
  readonly nonEmptyClasses: number;
  readonly skippedClasses: number;
  readonly truncated: boolean;
  readonly classSelectionTruncated: boolean;
}

export interface ClassRetainedRow {
  readonly rank: number;
  readonly className: string;
  readonly classLoader: string;
  readonly instanceCount: number;
  readonly shallowBytes: number;
  readonly retainedObjects: number;
  readonly candidateRetainedBytes: number;
  readonly retainedBytes: number;
}

export interface ClassRetainedResult {
  readonly exact: boolean;
  readonly graphNodes: number;
  readonly graphEdges: number;
  readonly reachableNodes: number;
  readonly reachableBytes: number;
  readonly taggedClasses: number;
  readonly skippedTaggedClasses: number;
  readonly tagConflicts: number;
  readonly truncated: boolean;
  readonly nodeLimitReached: boolean;
  readonly edgeLimitReached: boolean;
  readonly weakSemanticsComplete: boolean;
  readonly classSelectionComplete: boolean;
  readonly accountedObjects: number;
  readonly accountedShallowBytes: number;
  readonly rows: readonly ClassRetainedRow[];
}

export interface DominatorTreeObject {
  readonly handle: string;
  readonly type: string;
  readonly identity: string;
  readonly shallowSize: number;
}

export interface DominatorTreeNode {
  readonly index: number;
  readonly parentIndex: number;
  readonly depth: number;
  readonly shallowBytes: number;
  readonly retainedObjects: number;
  readonly candidateRetainedBytes: number;
  readonly retainedBytes: number;
  readonly directChildren: number;
  readonly displayedChildren: number;
  readonly classLoader: string;
  readonly target: DominatorTreeObject;
}

export interface DominatorTreeResult {
  readonly exact: boolean;
  readonly graphNodes: number;
  readonly graphEdges: number;
  readonly reachableNodes: number;
  readonly reachableBytes: number;
  readonly tagConflicts: number;
  readonly truncated: boolean;
  readonly nodeLimitReached: boolean;
  readonly edgeLimitReached: boolean;
  readonly weakSemanticsComplete: boolean;
  readonly classSelectionComplete: boolean;
  readonly viewTruncated: boolean;
  readonly rootChildren: number;
  readonly nodes: readonly DominatorTreeNode[];
}

function safeCount(raw: string | undefined): number | null {
  if (!/^(?:0|[1-9]\d*)$/u.test(raw ?? "")) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseArtifactTicket(
  result: ActionResult,
  expectedType: CollectAgentArtifactInput["type"],
): ArtifactTicket | null {
  const token = result.values.token ?? "";
  const type = result.values.type ?? "";
  const expectedSize = safeCount(result.values.size);
  return UUID_PATTERN.test(token) &&
    type === expectedType &&
    expectedSize !== null &&
    expectedSize > 0 &&
    expectedSize <= Number.MAX_SAFE_INTEGER
    ? { token, type: expectedType, expectedSize }
    : null;
}

export function parseProfileTaskResult(
  result: ActionResult,
): ProfileTaskSnapshot | null {
  if (
    result.actionId !== "profile.start" &&
    result.actionId !== "profile.status" &&
    result.actionId !== "profile.dump" &&
    result.actionId !== "profile.stop"
  ) {
    return null;
  }
  const taskId = result.values.taskId ?? "";
  const state = result.values.state ?? "";
  const engine = (result.values.engine ?? "").trim();
  const samples = safeCount(result.values.samples ?? "0");
  const dropped = safeCount(result.values.dropped ?? "0");
  if (
    result.values.kind !== "PROFILE" ||
    !UUID_PATTERN.test(taskId) ||
    (state !== "RUNNING" &&
      state !== "SUCCEEDED" &&
      state !== "FAILED" &&
      state !== "CANCELLED" &&
      state !== "TIMED_OUT") ||
    !engine ||
    engine.length > 128 ||
    samples === null ||
    dropped === null
  ) {
    return null;
  }
  const hasArtifactFields =
    result.values.token !== undefined ||
    result.values.size !== undefined ||
    result.values.type !== undefined;
  const artifact = parseArtifactTicket(result, "PROFILE");
  if (hasArtifactFields && artifact === null) {
    return null;
  }
  return {
    taskId,
    state,
    samples,
    dropped,
    engine,
    artifact,
  };
}

export function parseJfrStatus(result: ActionResult): JfrStatusSnapshot | null {
  if (result.actionId !== "jfr.status") {
    return null;
  }
  const runningValue = result.values.running;
  if (runningValue !== "true" && runningValue !== "false") {
    return null;
  }
  const rawConfiguration = result.values.configuration?.trim() ?? "";
  const configuration = rawConfiguration || null;
  const maxAgeMillis = safeCount(result.values.maxAgeMillis ?? "0");
  const maxSizeBytes = safeCount(result.values.maxSizeBytes ?? "0");
  if (
    maxAgeMillis === null ||
    maxSizeBytes === null ||
    (configuration !== null &&
      configuration !== "PROFILE" &&
      configuration !== "DEFAULT")
  ) {
    return null;
  }
  return {
    running: runningValue === "true",
    recordingName: result.values.recordingName?.trim() || null,
    configuration,
    maxAgeMillis,
    maxSizeBytes,
  };
}

export function parseHeapHistogramResult(
  result: ActionResult,
): HeapHistogramResult | null {
  const count = safeCount(result.values.count);
  if (count === null || count > 200) {
    return null;
  }
  const rows: HeapHistogramRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const prefix = `row.${String(index).padStart(4, "0")}.`;
    const className = result.values[`${prefix}className`]?.trim();
    const classLoader = result.values[`${prefix}classLoader`]?.trim();
    const instanceCount = safeCount(result.values[`${prefix}instanceCount`]);
    const shallowBytes = safeCount(result.values[`${prefix}shallowBytes`]);
    const averageShallowBytes = safeCount(
      result.values[`${prefix}averageShallowBytes`],
    );
    if (
      !className ||
      !classLoader ||
      instanceCount === null ||
      shallowBytes === null ||
      averageShallowBytes === null
    ) {
      return null;
    }
    rows.push({
      className,
      classLoader,
      instanceCount,
      shallowBytes,
      averageShallowBytes,
    });
  }
  const scanned = safeCount(result.values.scannedObjects);
  const accountedObjects = safeCount(result.values.accountedObjects);
  const accountedBytes = safeCount(result.values.accountedBytes);
  const nonEmptyClasses = safeCount(result.values.nonEmptyClasses);
  const skippedClasses = safeCount(result.values.skippedTaggedClasses);
  if (
    scanned === null ||
    accountedObjects === null ||
    accountedBytes === null ||
    nonEmptyClasses === null ||
    skippedClasses === null
  ) {
    return null;
  }
  return {
    rows,
    scanned,
    accountedObjects,
    accountedBytes,
    nonEmptyClasses,
    skippedClasses,
    truncated: result.values.truncated === "true",
    classSelectionTruncated:
      result.values.classSelectionTruncated === "true",
  };
}

export function parseClassRetainedResult(
  result: ActionResult,
): ClassRetainedResult | null {
  const count = safeCount(result.values.count);
  if (count === null || count > 200) {
    return null;
  }
  const exact = result.values.exact === "true";
  const rows: ClassRetainedRow[] = [];
  const ranks = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const prefix = `row.${String(index).padStart(4, "0")}.`;
    const rank = Number(result.values[`${prefix}rank`]);
    const className = result.values[`${prefix}className`]?.trim();
    const classLoader = result.values[`${prefix}classLoader`]?.trim();
    const instanceCount = safeCount(result.values[`${prefix}instanceCount`]);
    const shallowBytes = safeCount(result.values[`${prefix}shallowBytes`]);
    const retainedObjects = safeCount(
      result.values[`${prefix}candidateRetainedObjects`],
    );
    const candidateRetainedBytes = safeCount(
      result.values[`${prefix}candidateRetainedBytes`],
    );
    const retainedBytes = Number(result.values[`${prefix}retainedBytes`] ?? -1);
    if (
      !className ||
      !classLoader ||
      !Number.isSafeInteger(rank) ||
      rank < 1 ||
      rank > count ||
      ranks.has(rank) ||
      instanceCount === null ||
      instanceCount < 1 ||
      shallowBytes === null ||
      retainedObjects === null ||
      retainedObjects < instanceCount ||
      candidateRetainedBytes === null ||
      candidateRetainedBytes < shallowBytes ||
      !Number.isSafeInteger(retainedBytes) ||
      (exact ? retainedBytes !== candidateRetainedBytes : retainedBytes !== -1)
    ) {
      return null;
    }
    ranks.add(rank);
    rows.push({
      rank,
      className,
      classLoader,
      instanceCount,
      shallowBytes,
      retainedObjects,
      candidateRetainedBytes,
      retainedBytes,
    });
  }
  const graphNodes = safeCount(result.values.graphNodes);
  const graphEdges = safeCount(result.values.graphEdges);
  const reachableNodes = safeCount(result.values.reachableNodes);
  const reachableBytes = safeCount(result.values.reachableBytes);
  const taggedClasses = safeCount(result.values.taggedClasses);
  const skippedTaggedClasses = safeCount(result.values.skippedTaggedClasses);
  const tagConflicts = safeCount(result.values.tagConflicts);
  const accountedObjects = safeCount(result.values.accountedObjects);
  const accountedShallowBytes = safeCount(result.values.accountedShallowBytes);
  const truncated = result.values.truncated === "true";
  const weakSemanticsComplete = result.values.weakSemanticsComplete === "true";
  const classSelectionComplete = result.values.classSelectionComplete === "true";
  if (
    graphNodes === null ||
    graphEdges === null ||
    reachableNodes === null ||
    reachableBytes === null ||
    taggedClasses === null ||
    skippedTaggedClasses === null ||
    tagConflicts === null ||
    accountedObjects === null ||
    accountedShallowBytes === null ||
    graphNodes > 500_000 ||
    graphEdges > 2_000_000 ||
    reachableNodes > graphNodes ||
    (exact &&
      (truncated ||
        tagConflicts > 0 ||
        !weakSemanticsComplete ||
        !classSelectionComplete))
  ) {
    return null;
  }
  return {
    exact,
    graphNodes,
    graphEdges,
    reachableNodes,
    reachableBytes,
    taggedClasses,
    skippedTaggedClasses,
    tagConflicts,
    truncated,
    nodeLimitReached: result.values.nodeLimitReached === "true",
    edgeLimitReached: result.values.edgeLimitReached === "true",
    weakSemanticsComplete,
    classSelectionComplete,
    accountedObjects,
    accountedShallowBytes,
    rows,
  };
}

export function parseDominatorTreeResult(
  result: ActionResult,
  maximumDepth: number,
  maximumViewNodes: number,
): DominatorTreeResult | null {
  const count = Number(result.values.count);
  const exact = result.values.exact === "true";
  if (!Number.isSafeInteger(count) || count < 0 || count > maximumViewNodes) {
    return null;
  }
  const nodes: DominatorTreeNode[] = [];
  for (let index = 0; index < count; index += 1) {
    const prefix = `node.${String(index).padStart(4, "0")}.`;
    const encodedIndex = Number(result.values[`${prefix}index`]);
    const parentIndex = Number(result.values[`${prefix}parentIndex`]);
    const depth = Number(result.values[`${prefix}depth`]);
    const shallowBytes = Number(result.values[`${prefix}shallowBytes`]);
    const retainedObjects = Number(result.values[`${prefix}retainedObjects`]);
    const candidateRetainedBytes = Number(
      result.values[`${prefix}candidateRetainedBytes`],
    );
    const retainedBytes = Number(result.values[`${prefix}retainedBytes`]);
    const directChildren = Number(result.values[`${prefix}directChildren`]);
    const displayedChildren = Number(
      result.values[`${prefix}displayedChildren`],
    );
    const handle = result.values[`${prefix}handle`]?.trim();
    const type = result.values[`${prefix}type`]?.trim();
    const identity = result.values[`${prefix}identity`]?.trim();
    const classLoader = result.values[`${prefix}classLoader`]?.trim();
    const shallowSize = Number(result.values[`${prefix}shallowSize`]);
    if (
      encodedIndex !== index ||
      !Number.isSafeInteger(parentIndex) ||
      parentIndex < -1 ||
      parentIndex >= index ||
      !Number.isSafeInteger(depth) ||
      depth < 1 ||
      depth > maximumDepth ||
      (parentIndex === -1 ? depth !== 1 : depth !== nodes[parentIndex]!.depth + 1) ||
      !Number.isSafeInteger(shallowBytes) ||
      shallowBytes < 0 ||
      !Number.isSafeInteger(shallowSize) ||
      shallowSize !== shallowBytes ||
      !Number.isSafeInteger(retainedObjects) ||
      retainedObjects < 1 ||
      !Number.isSafeInteger(candidateRetainedBytes) ||
      candidateRetainedBytes < shallowBytes ||
      !Number.isSafeInteger(retainedBytes) ||
      (exact ? retainedBytes !== candidateRetainedBytes : retainedBytes !== -1) ||
      !Number.isSafeInteger(directChildren) ||
      !Number.isSafeInteger(displayedChildren) ||
      directChildren < displayedChildren ||
      displayedChildren < 0 ||
      !handle ||
      !UUID_PATTERN.test(handle) ||
      !type ||
      !identity ||
      !classLoader ||
      result.values[`${prefix}navigable`] !== "true"
    ) {
      return null;
    }
    nodes.push({
      index,
      parentIndex,
      depth,
      shallowBytes,
      retainedObjects,
      candidateRetainedBytes,
      retainedBytes,
      directChildren,
      displayedChildren,
      classLoader,
      target: { handle, type, identity, shallowSize },
    });
  }
  const actualChildren = new Array<number>(count).fill(0);
  let displayedRoots = 0;
  for (const node of nodes) {
    if (node.parentIndex < 0) {
      displayedRoots += 1;
    } else {
      actualChildren[node.parentIndex] =
        (actualChildren[node.parentIndex] ?? 0) + 1;
    }
  }
  if (nodes.some((node) => actualChildren[node.index] !== node.displayedChildren)) {
    return null;
  }
  const graphNodes = safeCount(result.values.graphNodes);
  const graphEdges = safeCount(result.values.graphEdges);
  const reachableNodes = safeCount(result.values.reachableNodes);
  const reachableBytes = safeCount(result.values.reachableBytes);
  const tagConflicts = safeCount(result.values.tagConflicts);
  const rootChildren = safeCount(result.values.rootChildren);
  const truncated = result.values.truncated === "true";
  const weakSemanticsComplete = result.values.weakSemanticsComplete === "true";
  const classSelectionComplete = result.values.classSelectionComplete === "true";
  if (
    graphNodes === null ||
    graphEdges === null ||
    reachableNodes === null ||
    reachableBytes === null ||
    tagConflicts === null ||
    rootChildren === null ||
    graphNodes > 500_000 ||
    graphEdges > 2_000_000 ||
    reachableNodes > graphNodes ||
    displayedRoots > rootChildren ||
    (exact &&
      (truncated ||
        tagConflicts > 0 ||
        !weakSemanticsComplete ||
        !classSelectionComplete))
  ) {
    return null;
  }
  return {
    exact,
    graphNodes,
    graphEdges,
    reachableNodes,
    reachableBytes,
    tagConflicts,
    truncated,
    nodeLimitReached: result.values.nodeLimitReached === "true",
    edgeLimitReached: result.values.edgeLimitReached === "true",
    weakSemanticsComplete,
    classSelectionComplete,
    viewTruncated: result.values.viewTruncated === "true",
    rootChildren,
    nodes,
  };
}
