import { describe, expect, it } from "vitest";
import type { ThreadDescriptor } from "@shared/contracts";
import {
  buildThreadSnapshotDiff,
  type ThreadSnapshot,
} from "./thread-snapshot-diff";

function thread(
  id: number,
  overrides: Partial<ThreadDescriptor> = {},
): ThreadDescriptor {
  return {
    id,
    name: `worker-${id}`,
    state: "WAITING",
    daemon: true,
    priority: 5,
    cpuTimeNanos: 1_000,
    deadlocked: false,
    lockName: null,
    lockOwnerId: null,
    stack: [],
    ...overrides,
  };
}

function snapshot(
  capturedAt: number,
  threads: readonly ThreadDescriptor[],
): ThreadSnapshot {
  return {
    targetId: "local:42",
    capturedAt,
    total: threads.length,
    truncated: false,
    threads,
  };
}

const translate = (
  key: string,
  parameters?: Readonly<Record<string, string | number>>,
): string =>
  key.replace(/\{(\w+)\}/gu, (match, name: string) =>
    parameters?.[name] === undefined ? match : String(parameters[name]),
  );

describe("thread snapshot diff", () => {
  it("detects lifecycle, state, lock and sorted CPU changes", () => {
    const baseline = snapshot(1, [
      thread(1, { name: "exited" }),
      thread(2, { cpuTimeNanos: 5_000 }),
      thread(3, {
        state: "BLOCKED",
        lockName: "Lock@1",
        lockOwnerId: 9,
        cpuTimeNanos: 2_000,
      }),
    ]);
    const current = snapshot(2, [
      thread(2, { cpuTimeNanos: 9_000 }),
      thread(3, {
        state: "RUNNABLE",
        cpuTimeNanos: 12_000,
      }),
      thread(4, { name: "created" }),
    ]);

    const result = buildThreadSnapshotDiff(baseline, current, translate);

    expect(result.newCount).toBe(1);
    expect(result.exitedCount).toBe(1);
    expect(result.stateChangedCount).toBe(1);
    expect(result.lockChangedCount).toBe(1);
    expect(result.totalCpuDeltaNanos).toBe(14_000);
    expect(result.topCpu.map((item) => item.id)).toEqual([3, 2]);
    expect(result.changes.map((item) => item.category)).toEqual([
      "STATE",
      "LOCK",
      "NEW",
      "EXITED",
    ]);
  });

  it("treats a reused thread id with a different name as exit plus new", () => {
    const result = buildThreadSnapshotDiff(
      snapshot(1, [thread(7, { name: "old" })]),
      snapshot(2, [thread(7, { name: "new" })]),
      translate,
    );

    expect(result.newCount).toBe(1);
    expect(result.exitedCount).toBe(1);
    expect(result.topCpu).toHaveLength(0);
  });

  it("ignores unavailable or decreasing CPU counters", () => {
    const result = buildThreadSnapshotDiff(
      snapshot(1, [
        thread(1, { cpuTimeNanos: null }),
        thread(2, { cpuTimeNanos: 10_000 }),
      ]),
      snapshot(2, [
        thread(1, { cpuTimeNanos: 20_000 }),
        thread(2, { cpuTimeNanos: 9_000 }),
      ]),
      translate,
    );

    expect(result.totalCpuDeltaNanos).toBe(0);
    expect(result.topCpu).toHaveLength(0);
  });
});
