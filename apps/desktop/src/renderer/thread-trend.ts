import type { ThreadSnapshot } from "./thread-snapshot-diff";

const MAXIMUM_HOT_THREADS = 8;

export interface ThreadHotCpuRate {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly cpuMillisPerSecond: number;
  readonly oneCorePercent: number;
  readonly topFrame: string | null;
}

export interface ThreadTrendPoint {
  readonly capturedAt: number;
  readonly total: number;
  readonly visible: number;
  readonly truncated: boolean;
  readonly runnable: number;
  readonly blocked: number;
  readonly waiting: number;
  readonly deadlocked: number;
  readonly newCount: number | null;
  readonly exitedCount: number | null;
  readonly cpuMillisPerSecond: number | null;
  readonly hotThreads: readonly ThreadHotCpuRate[];
}

interface RankedThread extends ThreadHotCpuRate {
  readonly deltaNanos: number;
}

function insertHotThread(
  ranked: RankedThread[],
  candidate: RankedThread,
): void {
  const insertionIndex = ranked.findIndex(
    (item) =>
      candidate.deltaNanos > item.deltaNanos ||
      (candidate.deltaNanos === item.deltaNanos &&
        candidate.id < item.id),
  );
  if (insertionIndex >= 0) {
    ranked.splice(insertionIndex, 0, candidate);
  } else if (ranked.length < MAXIMUM_HOT_THREADS) {
    ranked.push(candidate);
  }
  if (ranked.length > MAXIMUM_HOT_THREADS) {
    ranked.pop();
  }
}

export function buildThreadTrendPoint(
  previous: ThreadSnapshot | null,
  current: ThreadSnapshot,
): ThreadTrendPoint {
  let runnable = 0;
  let blocked = 0;
  let waiting = 0;
  let deadlocked = 0;
  for (const thread of current.threads) {
    switch (thread.state) {
      case "RUNNABLE":
        runnable++;
        break;
      case "BLOCKED":
        blocked++;
        break;
      case "WAITING":
      case "TIMED_WAITING":
        waiting++;
        break;
      default:
        break;
    }
    if (thread.deadlocked) {
      deadlocked++;
    }
  }

  if (!previous || previous.targetId !== current.targetId) {
    return {
      capturedAt: current.capturedAt,
      total: current.total,
      visible: current.threads.length,
      truncated: current.truncated,
      runnable,
      blocked,
      waiting,
      deadlocked,
      newCount: null,
      exitedCount: null,
      cpuMillisPerSecond: null,
      hotThreads: [],
    };
  }

  const previousById = new Map(
    previous.threads.map((thread) => [thread.id, thread]),
  );
  const currentById = new Map(
    current.threads.map((thread) => [thread.id, thread]),
  );
  let newCount = 0;
  let exitedCount = 0;
  let cpuDeltaNanos = 0;
  let comparableCpuThreads = 0;
  const rankedHotThreads: RankedThread[] = [];
  const elapsedMillis = current.capturedAt - previous.capturedAt;
  for (const thread of current.threads) {
    const oldThread = previousById.get(thread.id);
    if (!oldThread || oldThread.name !== thread.name) {
      newCount++;
      continue;
    }
    if (
      oldThread.cpuTimeNanos !== null &&
      thread.cpuTimeNanos !== null &&
      Number.isSafeInteger(oldThread.cpuTimeNanos) &&
      Number.isSafeInteger(thread.cpuTimeNanos) &&
      thread.cpuTimeNanos >= oldThread.cpuTimeNanos
    ) {
      comparableCpuThreads++;
      const deltaNanos =
        thread.cpuTimeNanos - oldThread.cpuTimeNanos;
      cpuDeltaNanos = Math.min(
        Number.MAX_SAFE_INTEGER,
        cpuDeltaNanos + deltaNanos,
      );
      if (deltaNanos > 0 && elapsedMillis > 0) {
        const cpuMillisPerSecond =
          deltaNanos / (elapsedMillis * 1_000);
        insertHotThread(rankedHotThreads, {
          id: thread.id,
          name: thread.name,
          state: thread.state,
          deltaNanos,
          cpuMillisPerSecond,
          oneCorePercent: cpuMillisPerSecond / 10,
          topFrame: thread.stack[0] ?? null,
        });
      }
    }
  }
  for (const thread of previous.threads) {
    const currentThread = currentById.get(thread.id);
    if (!currentThread || currentThread.name !== thread.name) {
      exitedCount++;
    }
  }
  return {
    capturedAt: current.capturedAt,
    total: current.total,
    visible: current.threads.length,
    truncated: current.truncated,
    runnable,
    blocked,
    waiting,
    deadlocked,
    newCount,
    exitedCount,
    cpuMillisPerSecond:
      comparableCpuThreads > 0 && elapsedMillis > 0
        ? cpuDeltaNanos / (elapsedMillis * 1_000)
        : null,
    hotThreads: rankedHotThreads.map(
      ({ deltaNanos: _deltaNanos, ...thread }) => thread,
    ),
  };
}
