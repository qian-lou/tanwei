import { describe, expect, it } from "vitest";
import type {
  ThreadDumpInspectionReport,
  ThreadDumpThread,
} from "../shared/contracts.js";
import { compareThreadDumpReports } from "./thread-dump-comparison.js";

function thread(
  id: string,
  name: string,
  overrides: Partial<ThreadDumpThread> = {},
): ThreadDumpThread {
  return {
    id,
    name,
    state: "WAITING",
    cpuTimeNanos: "1000",
    deadlocked: false,
    waitingOn: null,
    lockOwnerId: null,
    lockOwnerName: null,
    stack: ["example.Work.run(Work.java:1)"],
    monitors: [],
    synchronizers: [],
    ...overrides,
  };
}

function report(
  artifactId: string,
  capturedAt: string,
  threads: readonly ThreadDumpThread[],
  processId = 42,
): ThreadDumpInspectionReport {
  return {
    artifactId,
    capturedAt,
    processId,
    jvmStartTimeMillis: "1785450000000",
    javaVersion: "21",
    threadsSeen: threads.length,
    threadsSelected: threads.length,
    maximumStackDepth: 256,
    truncated: false,
    monitorsIncluded: true,
    synchronizersIncluded: true,
    deadlockedThreads: threads.filter((item) => item.deadlocked).length,
    stateCounts: {},
    threads,
  };
}

describe("thread dump comparison", () => {
  it("detects lifecycle, state, wait, stack, lock and deadlock changes", () => {
    const baseline = report("baseline", "2026-07-30T22:00:00Z", [
      thread("1", "changed", {
        waitingOn: "java.lang.Object@1",
        lockOwnerId: "9",
        lockOwnerName: "owner",
        monitors: ["java.lang.Object@2"],
      }),
      thread("2", "removed", { deadlocked: true }),
      thread("3", "stable"),
    ]);
    const current = report("current", "2026-07-30T22:00:02Z", [
      thread("1", "changed", {
        state: "BLOCKED",
        cpuTimeNanos: "4250",
        deadlocked: true,
        waitingOn: "java.lang.Object@3",
        lockOwnerId: "10",
        lockOwnerName: "new-owner",
        stack: ["example.Work.block(Work.java:2)"],
        synchronizers: ["java.util.concurrent.Lock@4"],
      }),
      thread("3", "stable", { cpuTimeNanos: "1500" }),
      thread("4", "added"),
    ]);

    const comparison = compareThreadDumpReports(baseline, current, {
      targetId: "local:42",
      baselineArtifactId: "baseline",
      currentArtifactId: "current",
    });

    expect(comparison.intervalMillis).toBe(2_000);
    expect(comparison.summary).toEqual({
      baselineThreads: 3,
      currentThreads: 3,
      persistedThreads: 2,
      addedThreads: 1,
      removedThreads: 1,
      changedThreads: 1,
      unchangedThreads: 1,
      stateChanges: 1,
      waitChanges: 1,
      stackChanges: 1,
      lockChanges: 1,
      newlyDeadlocked: 1,
      recoveredDeadlocked: 1,
    });
    expect(comparison.threads[0]).toMatchObject({
      id: "1",
      kind: "CHANGED",
      cpuDeltaNanos: "3250",
      stateChanged: true,
      waitChanged: true,
      stackChanged: true,
      locksChanged: true,
      newlyDeadlocked: true,
    });
    expect(comparison.threads[1]).toMatchObject({
      id: "3",
      kind: "UNCHANGED",
      cpuDeltaNanos: "500",
    });
    expect(comparison.threads[2]).toMatchObject({
      id: "4",
      kind: "ADDED",
    });
    expect(comparison.threads[3]).toMatchObject({
      id: "2",
      kind: "REMOVED",
      recoveredDeadlocked: true,
    });
  });

  it("uses id and name together to defend against thread id reuse", () => {
    const comparison = compareThreadDumpReports(
      report("baseline", "2026-07-30T22:00:00Z", [
        thread("7", "old-name"),
      ]),
      report("current", "2026-07-30T22:00:01Z", [
        thread("7", "new-name"),
      ]),
      {
        targetId: "local:42",
        baselineArtifactId: "baseline",
        currentArtifactId: "current",
      },
    );

    expect(comparison.summary.addedThreads).toBe(1);
    expect(comparison.summary.removedThreads).toBe(1);
    expect(comparison.summary.persistedThreads).toBe(0);
  });

  it("rejects different processes and duplicate identities", () => {
    expect(() =>
      compareThreadDumpReports(
        report("baseline", "2026-07-30T22:00:00Z", [], 42),
        report("current", "2026-07-30T22:00:01Z", [], 43),
        {
          targetId: "local:42",
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/process identity/u);
    expect(() =>
      compareThreadDumpReports(
        report("baseline", "2026-07-30T22:00:00Z", []),
        {
          ...report("current", "2026-07-30T22:00:01Z", []),
          jvmStartTimeMillis: "1785450000001",
        },
        {
          targetId: "local:42",
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/JVM lifetime/u);
    expect(() =>
      compareThreadDumpReports(
        {
          ...report("baseline", "2026-07-30T22:00:00Z", []),
          jvmStartTimeMillis: null,
        },
        report("current", "2026-07-30T22:00:01Z", []),
        {
          targetId: "local:42",
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/JVM lifetime/u);
    expect(() =>
      compareThreadDumpReports(
        report("baseline", "2026-07-30T22:00:00Z", [
          thread("1", "duplicate"),
          thread("1", "duplicate"),
        ]),
        report("current", "2026-07-30T22:00:01Z", []),
        {
          targetId: "local:42",
          baselineArtifactId: "baseline",
          currentArtifactId: "current",
        },
      ),
    ).toThrow(/duplicate identity/u);
  });
});
