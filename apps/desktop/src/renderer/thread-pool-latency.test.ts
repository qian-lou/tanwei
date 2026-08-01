import { describe, expect, it } from "vitest";
import {
  averageNanos,
  parseThreadPoolLatencySnapshot,
} from "./thread-pool-latency";

function response(): Record<string, string> {
  return {
    taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
    state: "RUNNING",
    error: "",
    poolIdentity: "ThreadPoolExecutor@1a2b3c",
    poolClassName: "java.util.concurrent.ThreadPoolExecutor",
    attributionMode: "QUEUE_AND_RUN",
    startedAtEpochMillis: "1000000",
    deadlineEpochMillis: "1030000",
    maximumTrackedTasks: "1024",
    submitted: "12",
    started: "10",
    completed: "9",
    failures: "1",
    rejected: "1",
    unmatchedStarts: "0",
    droppedSubmissions: "0",
    orphanedSubmissions: "0",
    pendingTracked: "2",
    inFlight: "1",
    waitObserved: "10",
    waitDurationNanos: "10000000",
    waitMaximumNanos: "3000000",
    waitP95Nanos: "2500000",
    waitP99Nanos: "3000000",
    scheduleDelayObserved: "0",
    scheduleDelayDurationNanos: "0",
    scheduleDelayMaximumNanos: "0",
    scheduleDelayP95Nanos: "0",
    scheduleDelayP99Nanos: "0",
    startLatenessObserved: "0",
    startLatenessDurationNanos: "0",
    startLatenessMaximumNanos: "0",
    startLatenessP95Nanos: "0",
    startLatenessP99Nanos: "0",
    runDurationNanos: "90000000",
    runMaximumNanos: "20000000",
    runP95Nanos: "18000000",
    runP99Nanos: "20000000",
    taskTypeCount: "1",
    "taskType.000.className": "example.DatabaseTask",
    "taskType.000.started": "10",
    "taskType.000.completed": "9",
    "taskType.000.failures": "1",
    "taskType.000.waitObserved": "10",
    "taskType.000.waitDurationNanos": "10000000",
    "taskType.000.waitMaximumNanos": "3000000",
    "taskType.000.scheduleDelayObserved": "0",
    "taskType.000.scheduleDelayDurationNanos": "0",
    "taskType.000.scheduleDelayMaximumNanos": "0",
    "taskType.000.startLatenessObserved": "0",
    "taskType.000.startLatenessDurationNanos": "0",
    "taskType.000.startLatenessMaximumNanos": "0",
    "taskType.000.runDurationNanos": "90000000",
    "taskType.000.runMaximumNanos": "20000000",
    boundary: "bounded",
  };
}

describe("thread-pool latency response", () => {
  it("parses bounded totals and exact task types", () => {
    const parsed = parseThreadPoolLatencySnapshot(response());
    expect(parsed.poolIdentity).toBe("ThreadPoolExecutor@1a2b3c");
    expect(parsed.taskTypes).toEqual([
      expect.objectContaining({
        className: "example.DatabaseTask",
        completed: 9,
      }),
    ]);
    expect(averageNanos(parsed.runDurationNanos, parsed.completed)).toBe(
      10_000_000,
    );
  });

  it("rejects hostile counts, duplicates and inconsistent totals", () => {
    expect(() =>
      parseThreadPoolLatencySnapshot({
        ...response(),
        pendingTracked: "1025",
      }),
    ).toThrow(/pendingTracked/u);
    expect(() =>
      parseThreadPoolLatencySnapshot({
        ...response(),
        completed: "11",
      }),
    ).toThrow(/Inconsistent/u);
    expect(() =>
      parseThreadPoolLatencySnapshot({
        ...response(),
        taskTypeCount: "2",
        "taskType.001.className": "example.DatabaseTask",
        "taskType.001.started": "1",
        "taskType.001.completed": "1",
        "taskType.001.failures": "0",
        "taskType.001.waitObserved": "1",
        "taskType.001.waitDurationNanos": "1",
        "taskType.001.waitMaximumNanos": "1",
        "taskType.001.scheduleDelayObserved": "0",
        "taskType.001.scheduleDelayDurationNanos": "0",
        "taskType.001.scheduleDelayMaximumNanos": "0",
        "taskType.001.startLatenessObserved": "0",
        "taskType.001.startLatenessDurationNanos": "0",
        "taskType.001.startLatenessMaximumNanos": "0",
        "taskType.001.runDurationNanos": "1",
        "taskType.001.runMaximumNanos": "1",
      }),
    ).toThrow(/task type/u);
  });

  it("parses scheduled delay, start lateness and worker execution separately", () => {
    const parsed = parseThreadPoolLatencySnapshot({
      ...response(),
      poolIdentity: "ScheduledThreadPoolExecutor@1a2b3c",
      poolClassName: "java.util.concurrent.ScheduledThreadPoolExecutor",
      attributionMode: "SCHEDULE_AND_RUN",
      submitted: "12",
      rejected: "0",
      unmatchedStarts: "1",
      pendingTracked: "2",
      waitObserved: "0",
      waitDurationNanos: "0",
      waitMaximumNanos: "0",
      waitP95Nanos: "0",
      waitP99Nanos: "0",
      scheduleDelayObserved: "12",
      scheduleDelayDurationNanos: "1200000000",
      scheduleDelayMaximumNanos: "100000000",
      scheduleDelayP95Nanos: "100000000",
      scheduleDelayP99Nanos: "100000000",
      startLatenessObserved: "9",
      startLatenessDurationNanos: "18000000",
      startLatenessMaximumNanos: "5000000",
      startLatenessP95Nanos: "5000000",
      startLatenessP99Nanos: "5000000",
      "taskType.000.waitObserved": "0",
      "taskType.000.waitDurationNanos": "0",
      "taskType.000.waitMaximumNanos": "0",
      "taskType.000.scheduleDelayObserved": "12",
      "taskType.000.scheduleDelayDurationNanos": "1200000000",
      "taskType.000.scheduleDelayMaximumNanos": "100000000",
      "taskType.000.startLatenessObserved": "9",
      "taskType.000.startLatenessDurationNanos": "18000000",
      "taskType.000.startLatenessMaximumNanos": "5000000",
    });
    expect(parsed.attributionMode).toBe("SCHEDULE_AND_RUN");
    expect(parsed.scheduleDelayObserved).toBe(12);
    expect(parsed.startLatenessObserved).toBe(9);
    expect(parsed.waitObserved).toBe(0);
  });

  it("parses ForkJoin run-only snapshots without submission metrics", () => {
    const parsed = parseThreadPoolLatencySnapshot({
      ...response(),
      poolIdentity: "ForkJoinPool@1a2b3c",
      poolClassName: "java.util.concurrent.ForkJoinPool",
      attributionMode: "RUN_ONLY",
      submitted: "0",
      rejected: "0",
      unmatchedStarts: "0",
      droppedSubmissions: "0",
      orphanedSubmissions: "0",
      pendingTracked: "0",
      waitObserved: "0",
      waitDurationNanos: "0",
      waitMaximumNanos: "0",
      waitP95Nanos: "0",
      waitP99Nanos: "0",
      "taskType.000.waitObserved": "0",
      "taskType.000.waitDurationNanos": "0",
      "taskType.000.waitMaximumNanos": "0",
    });
    expect(parsed.attributionMode).toBe("RUN_ONLY");
    expect(parsed.started).toBe(10);
  });

  it("rejects mismatched identities, modes and invented run-only wait", () => {
    expect(() =>
      parseThreadPoolLatencySnapshot({
        ...response(),
        poolClassName: "java.util.concurrent.ForkJoinPool",
        attributionMode: "RUN_ONLY",
      }),
    ).toThrow(/identity/u);
    expect(() =>
      parseThreadPoolLatencySnapshot({
        ...response(),
        attributionMode: "RUN_ONLY",
      }),
    ).toThrow(/identity/u);
    expect(() =>
      parseThreadPoolLatencySnapshot({
        ...response(),
        poolIdentity: "ForkJoinPool@1a2b3c",
        poolClassName: "java.util.concurrent.ForkJoinPool",
        attributionMode: "RUN_ONLY",
        submitted: "0",
        rejected: "0",
        unmatchedStarts: "0",
        droppedSubmissions: "0",
        orphanedSubmissions: "0",
        pendingTracked: "0",
        waitObserved: "1",
      }),
    ).toThrow(/Inconsistent/u);
  });
});
