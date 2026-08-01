// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ThreadDescriptor } from "@shared/contracts";
import type { ThreadSnapshot } from "./thread-snapshot-diff";
import { buildThreadTrendPoint } from "./thread-trend";

function thread(
  id: number,
  name: string,
  state: string,
  cpuTimeNanos: number | null,
  deadlocked = false,
): ThreadDescriptor {
  return {
    id,
    name,
    state,
    daemon: false,
    priority: 5,
    cpuTimeNanos,
    deadlocked,
    lockName: null,
    lockOwnerId: null,
    stack: [],
  };
}

function snapshot(
  capturedAt: number,
  threads: readonly ThreadDescriptor[],
  total = threads.length,
): ThreadSnapshot {
  return {
    targetId: "local:42",
    capturedAt,
    total,
    truncated: total > threads.length,
    threads,
  };
}

describe("thread trend aggregation", () => {
  it("aggregates states, lifecycle changes and retained-thread CPU in O(N)", () => {
    const previous = snapshot(1_000, [
      thread(1, "worker", "RUNNABLE", 1_000_000),
      thread(2, "departed", "WAITING", 2_000_000),
    ]);
    const current = snapshot(2_000, [
      thread(1, "worker", "BLOCKED", 4_000_000, true),
      thread(3, "new", "TIMED_WAITING", 500_000),
    ]);

    expect(buildThreadTrendPoint(previous, current)).toMatchObject({
      total: 2,
      visible: 2,
      runnable: 0,
      blocked: 1,
      waiting: 1,
      deadlocked: 1,
      newCount: 1,
      exitedCount: 1,
      cpuMillisPerSecond: 3,
      hotThreads: [
        {
          id: 1,
          name: "worker",
          cpuMillisPerSecond: 3,
          oneCorePercent: 0.3,
        },
      ],
    });
  });

  it("treats a reused thread id with a different name as lifecycle churn", () => {
    const previous = snapshot(1_000, [
      thread(7, "old-owner", "RUNNABLE", 9_000_000),
    ]);
    const current = snapshot(2_000, [
      thread(7, "new-owner", "RUNNABLE", 10_000_000),
    ]);

    expect(buildThreadTrendPoint(previous, current)).toMatchObject({
      newCount: 1,
      exitedCount: 1,
      cpuMillisPerSecond: null,
      hotThreads: [],
    });
  });

  it("marks partial state evidence while preserving the exact total", () => {
    const point = buildThreadTrendPoint(
      null,
      snapshot(1_000, [thread(1, "visible", "RUNNABLE", null)], 1_500),
    );

    expect(point).toMatchObject({
      total: 1_500,
      visible: 1,
      truncated: true,
      newCount: null,
      exitedCount: null,
      cpuMillisPerSecond: null,
      hotThreads: [],
    });
  });

  it("keeps the top eight CPU deltas in stable order with O(N) bounded work", () => {
    const previousThreads = Array.from({ length: 12 }, (_, index) =>
      thread(index + 1, `worker-${index + 1}`, "RUNNABLE", 0),
    );
    const currentThreads = previousThreads.map((item) => ({
      ...item,
      cpuTimeNanos: item.id * 1_000_000,
      stack: [`example.Worker.run(Worker.java:${item.id})`],
    }));

    const point = buildThreadTrendPoint(
      snapshot(1_000, previousThreads),
      snapshot(2_000, currentThreads),
    );

    expect(point.hotThreads).toHaveLength(8);
    expect(point.hotThreads.map((item) => item.id)).toEqual([
      12, 11, 10, 9, 8, 7, 6, 5,
    ]);
    expect(point.hotThreads[0]).toMatchObject({
      cpuMillisPerSecond: 12,
      oneCorePercent: 1.2,
      topFrame: "example.Worker.run(Worker.java:12)",
    });
  });
});
