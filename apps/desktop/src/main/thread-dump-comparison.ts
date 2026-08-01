import type {
  ThreadDumpComparison,
  ThreadDumpComparisonSummary,
  ThreadDumpInspectionReport,
  ThreadDumpThread,
  ThreadDumpThreadChange,
} from "../shared/contracts.js";

interface ThreadDumpComparisonContext {
  readonly targetId: string;
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
}

export function compareThreadDumpReports(
  baseline: ThreadDumpInspectionReport,
  current: ThreadDumpInspectionReport,
  context: ThreadDumpComparisonContext,
): ThreadDumpComparison {
  if (
    !context.targetId.trim() ||
    !context.baselineArtifactId.trim() ||
    !context.currentArtifactId.trim()
  ) {
    throw new Error("Thread dump comparison context is incomplete");
  }
  if (context.baselineArtifactId === context.currentArtifactId) {
    throw new Error("Thread dump comparison requires two artifacts");
  }
  if (
    baseline.processId === null ||
    current.processId === null ||
    baseline.processId !== current.processId
  ) {
    throw new Error(
      "Thread dump process identity is missing or does not match",
    );
  }
  if (
    baseline.jvmStartTimeMillis === null ||
    current.jvmStartTimeMillis === null ||
    baseline.jvmStartTimeMillis !== current.jvmStartTimeMillis
  ) {
    throw new Error(
      "Thread dump JVM lifetime is missing or does not match",
    );
  }

  const baselineByIdentity = indexThreads(baseline.threads);
  const currentByIdentity = indexThreads(current.threads);
  const changes: ThreadDumpThreadChange[] = [];
  const mutableSummary = {
    baselineThreads: baseline.threads.length,
    currentThreads: current.threads.length,
    persistedThreads: 0,
    addedThreads: 0,
    removedThreads: 0,
    changedThreads: 0,
    unchangedThreads: 0,
    stateChanges: 0,
    waitChanges: 0,
    stackChanges: 0,
    lockChanges: 0,
    newlyDeadlocked: 0,
    recoveredDeadlocked: 0,
  };

  for (const currentThread of current.threads) {
    const identity = threadIdentity(currentThread);
    const baselineThread = baselineByIdentity.get(identity);
    if (!baselineThread) {
      changes.push(addedThread(currentThread));
      mutableSummary.addedThreads++;
      if (currentThread.deadlocked) {
        mutableSummary.newlyDeadlocked++;
      }
      continue;
    }
    const change = persistedThread(baselineThread, currentThread);
    changes.push(change);
    mutableSummary.persistedThreads++;
    if (change.kind === "CHANGED") {
      mutableSummary.changedThreads++;
    } else {
      mutableSummary.unchangedThreads++;
    }
    accumulateChangeSummary(mutableSummary, change);
  }

  for (const baselineThread of baseline.threads) {
    if (!currentByIdentity.has(threadIdentity(baselineThread))) {
      const change = removedThread(baselineThread);
      changes.push(change);
      mutableSummary.removedThreads++;
      if (baselineThread.deadlocked) {
        mutableSummary.recoveredDeadlocked++;
      }
    }
  }

  return {
    baselineArtifactId: context.baselineArtifactId,
    currentArtifactId: context.currentArtifactId,
    targetId: context.targetId,
    processId: baseline.processId ?? current.processId,
    baselineCapturedAt: baseline.capturedAt,
    currentCapturedAt: current.capturedAt,
    intervalMillis: captureIntervalMillis(
      baseline.capturedAt,
      current.capturedAt,
    ),
    baselineTruncated: baseline.truncated,
    currentTruncated: current.truncated,
    summary: mutableSummary satisfies ThreadDumpComparisonSummary,
    threads: changes,
  };
}

function indexThreads(
  threads: readonly ThreadDumpThread[],
): ReadonlyMap<string, ThreadDumpThread> {
  const indexed = new Map<string, ThreadDumpThread>();
  for (const thread of threads) {
    const identity = threadIdentity(thread);
    if (indexed.has(identity)) {
      throw new Error(
        `Thread dump contains duplicate identity #${thread.id} ${thread.name}`,
      );
    }
    indexed.set(identity, thread);
  }
  return indexed;
}

function threadIdentity(thread: ThreadDumpThread): string {
  return `${thread.id}\u0000${thread.name}`;
}

function persistedThread(
  baseline: ThreadDumpThread,
  current: ThreadDumpThread,
): ThreadDumpThreadChange {
  const stateChanged = baseline.state !== current.state;
  const waitChanged =
    baseline.waitingOn !== current.waitingOn ||
    baseline.lockOwnerId !== current.lockOwnerId ||
    baseline.lockOwnerName !== current.lockOwnerName;
  const stackChanged = !arraysEqual(baseline.stack, current.stack);
  const locksChanged =
    !arraysEqual(baseline.monitors, current.monitors) ||
    !arraysEqual(baseline.synchronizers, current.synchronizers);
  const newlyDeadlocked = !baseline.deadlocked && current.deadlocked;
  const recoveredDeadlocked = baseline.deadlocked && !current.deadlocked;
  const changed =
    stateChanged ||
    waitChanged ||
    stackChanged ||
    locksChanged ||
    newlyDeadlocked ||
    recoveredDeadlocked;
  return {
    id: current.id,
    name: current.name,
    kind: changed ? "CHANGED" : "UNCHANGED",
    baselineState: baseline.state,
    currentState: current.state,
    baselineWaitingOn: baseline.waitingOn,
    currentWaitingOn: current.waitingOn,
    baselineLockOwnerId: baseline.lockOwnerId,
    baselineLockOwnerName: baseline.lockOwnerName,
    currentLockOwnerId: current.lockOwnerId,
    currentLockOwnerName: current.lockOwnerName,
    baselineTopFrame: baseline.stack[0] ?? null,
    currentTopFrame: current.stack[0] ?? null,
    cpuDeltaNanos: cpuDelta(baseline.cpuTimeNanos, current.cpuTimeNanos),
    stateChanged,
    waitChanged,
    stackChanged,
    locksChanged,
    newlyDeadlocked,
    recoveredDeadlocked,
  };
}

function addedThread(thread: ThreadDumpThread): ThreadDumpThreadChange {
  return {
    id: thread.id,
    name: thread.name,
    kind: "ADDED",
    baselineState: null,
    currentState: thread.state,
    baselineWaitingOn: null,
    currentWaitingOn: thread.waitingOn,
    baselineLockOwnerId: null,
    baselineLockOwnerName: null,
    currentLockOwnerId: thread.lockOwnerId,
    currentLockOwnerName: thread.lockOwnerName,
    baselineTopFrame: null,
    currentTopFrame: thread.stack[0] ?? null,
    cpuDeltaNanos: null,
    stateChanged: false,
    waitChanged: false,
    stackChanged: false,
    locksChanged: false,
    newlyDeadlocked: thread.deadlocked,
    recoveredDeadlocked: false,
  };
}

function removedThread(thread: ThreadDumpThread): ThreadDumpThreadChange {
  return {
    id: thread.id,
    name: thread.name,
    kind: "REMOVED",
    baselineState: thread.state,
    currentState: null,
    baselineWaitingOn: thread.waitingOn,
    currentWaitingOn: null,
    baselineLockOwnerId: thread.lockOwnerId,
    baselineLockOwnerName: thread.lockOwnerName,
    currentLockOwnerId: null,
    currentLockOwnerName: null,
    baselineTopFrame: thread.stack[0] ?? null,
    currentTopFrame: null,
    cpuDeltaNanos: null,
    stateChanged: false,
    waitChanged: false,
    stackChanged: false,
    locksChanged: false,
    newlyDeadlocked: false,
    recoveredDeadlocked: thread.deadlocked,
  };
}

function cpuDelta(
  baseline: string | null,
  current: string | null,
): string | null {
  if (baseline === null || current === null) {
    return null;
  }
  try {
    const baselineNanos = BigInt(baseline);
    const currentNanos = BigInt(current);
    return currentNanos >= baselineNanos
      ? String(currentNanos - baselineNanos)
      : null;
  } catch {
    return null;
  }
}

function arraysEqual(
  baseline: readonly string[],
  current: readonly string[],
): boolean {
  if (baseline.length !== current.length) {
    return false;
  }
  for (let index = 0; index < baseline.length; index++) {
    if (baseline[index] !== current[index]) {
      return false;
    }
  }
  return true;
}

function accumulateChangeSummary(
  summary: {
    stateChanges: number;
    waitChanges: number;
    stackChanges: number;
    lockChanges: number;
    newlyDeadlocked: number;
    recoveredDeadlocked: number;
  },
  change: ThreadDumpThreadChange,
): void {
  summary.stateChanges += Number(change.stateChanged);
  summary.waitChanges += Number(change.waitChanged);
  summary.stackChanges += Number(change.stackChanged);
  summary.lockChanges += Number(change.locksChanged);
  summary.newlyDeadlocked += Number(change.newlyDeadlocked);
  summary.recoveredDeadlocked += Number(change.recoveredDeadlocked);
}

function captureIntervalMillis(
  baseline: string | null,
  current: string | null,
): number | null {
  if (!baseline || !current) {
    return null;
  }
  const baselineMillis = Date.parse(baseline);
  const currentMillis = Date.parse(current);
  const interval = currentMillis - baselineMillis;
  return Number.isFinite(interval) && interval >= 0 ? interval : null;
}
