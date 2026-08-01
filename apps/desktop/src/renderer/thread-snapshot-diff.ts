import type { ThreadDescriptor } from "@shared/contracts";
import type { TranslationParameters } from "./i18n";

export interface ThreadSnapshot {
  readonly targetId: string;
  readonly capturedAt: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly threads: readonly ThreadDescriptor[];
}

export interface ThreadCpuDelta {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly deltaNanos: number;
}

export interface ThreadChange {
  readonly key: string;
  readonly category: "NEW" | "EXITED" | "STATE" | "LOCK";
  readonly id: number;
  readonly name: string;
  readonly detail: string;
}

export interface ThreadSnapshotDiff {
  readonly current: ThreadSnapshot;
  readonly newCount: number;
  readonly exitedCount: number;
  readonly stateChangedCount: number;
  readonly lockChangedCount: number;
  readonly totalCpuDeltaNanos: number;
  readonly topCpu: readonly ThreadCpuDelta[];
  readonly changes: readonly ThreadChange[];
}

type Translate = (
  key: string,
  parameters?: TranslationParameters,
) => string;

export function buildThreadSnapshotDiff(
  baseline: ThreadSnapshot,
  current: ThreadSnapshot,
  translate: Translate,
): ThreadSnapshotDiff {
  const baselineById = new Map(
    baseline.threads.map((thread) => [thread.id, thread]),
  );
  const currentById = new Map(
    current.threads.map((thread) => [thread.id, thread]),
  );
  const changes: ThreadChange[] = [];
  const topCpu: ThreadCpuDelta[] = [];
  let newCount = 0;
  let exitedCount = 0;
  let stateChangedCount = 0;
  let lockChangedCount = 0;
  let totalCpuDeltaNanos = 0;

  for (const thread of current.threads) {
    const previous = baselineById.get(thread.id);
    if (!previous || previous.name !== thread.name) {
      newCount++;
      changes.push({
        key: `new:${thread.id}:${thread.name}`,
        category: "NEW",
        id: thread.id,
        name: thread.name,
        detail: translate("新线程 · {state}", {
          state: thread.state,
        }),
      });
      continue;
    }
    if (previous.state !== thread.state) {
      stateChangedCount++;
      changes.push({
        key: `state:${thread.id}`,
        category: "STATE",
        id: thread.id,
        name: thread.name,
        detail: `${previous.state} → ${thread.state}`,
      });
    }
    if (
      previous.lockName !== thread.lockName ||
      previous.lockOwnerId !== thread.lockOwnerId
    ) {
      lockChangedCount++;
      changes.push({
        key: `lock:${thread.id}`,
        category: "LOCK",
        id: thread.id,
        name: thread.name,
        detail: thread.lockName
          ? translate("等待 {lock} · 持有者 #{owner}", {
              lock: thread.lockName,
              owner: thread.lockOwnerId ?? translate("未知"),
            })
          : translate("已离开锁等待"),
      });
    }
    if (
      previous.cpuTimeNanos !== null &&
      thread.cpuTimeNanos !== null &&
      thread.cpuTimeNanos >= previous.cpuTimeNanos
    ) {
      const deltaNanos =
        thread.cpuTimeNanos - previous.cpuTimeNanos;
      if (deltaNanos > 0) {
        totalCpuDeltaNanos = Math.min(
          Number.MAX_SAFE_INTEGER,
          totalCpuDeltaNanos + deltaNanos,
        );
        topCpu.push({
          id: thread.id,
          name: thread.name,
          state: thread.state,
          deltaNanos,
        });
      }
    }
  }

  for (const thread of baseline.threads) {
    const currentThread = currentById.get(thread.id);
    if (!currentThread || currentThread.name !== thread.name) {
      exitedCount++;
      changes.push({
        key: `exited:${thread.id}:${thread.name}`,
        category: "EXITED",
        id: thread.id,
        name: thread.name,
        detail: translate("已退出 · 基线状态 {state}", {
          state: thread.state,
        }),
      });
    }
  }

  topCpu.sort(
    (left, right) =>
      right.deltaNanos - left.deltaNanos || left.id - right.id,
  );
  return {
    current,
    newCount,
    exitedCount,
    stateChangedCount,
    lockChangedCount,
    totalCpuDeltaNanos,
    topCpu: topCpu.slice(0, 20),
    changes: changes.slice(0, 50),
  };
}
