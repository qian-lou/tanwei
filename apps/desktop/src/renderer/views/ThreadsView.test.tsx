import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationResult, TargetConnection } from "@shared/contracts";
import { useTargetsStore } from "../stores/targets";
import { threadActions } from "../thread-action-contract";
import { parseThreadPoolInspection } from "../thread-pool-inspection";
import type { ThreadPoolLatencySnapshot } from "../thread-pool-latency";
import ThreadsView from "./ThreadsView";

function success<T>(value: T): OperationResult<T> {
  return { ok: true, value, errorCode: null, errorMessage: null };
}

const connection: TargetConnection = {
  target: {
    id: "local:42",
    pid: 42,
    displayName: "test-target",
    mainClass: "example.Main",
    arguments: [],
    javaPath: null,
    javaVersion: "21",
    user: null,
    startTime: null,
    attachable: true,
    attachReason: null,
  },
  state: "READY",
  protocolVersion: "1.0",
  agentVersion: "0.3.0",
  javaVersion: "21",
  capabilities: ["thread-pools", "thread-pool-latency"].map((id) => ({
    id,
    state: "AVAILABLE",
    reason: null,
  })),
  connectedAt: "2026-10-28T00:00:00.000Z",
  errorCode: null,
  errorMessage: null,
};

const inspection = parseThreadPoolInspection({
  count: "2",
  "pool.0000.kind": "SCHEDULED_THREAD_POOL",
  "pool.0000.className": "java.util.concurrent.ScheduledThreadPoolExecutor",
  "pool.0000.identity": "ScheduledThreadPoolExecutor@abc",
  "pool.0000.membershipAvailable": "true",
  "pool.0001.kind": "FORK_JOIN_POOL",
  "pool.0001.className": "java.util.concurrent.ForkJoinPool",
  "pool.0001.identity": "ForkJoinPool@def",
  "pool.0001.membershipAvailable": "true",
});

const snapshot: ThreadPoolLatencySnapshot = {
  taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
  state: "RUNNING",
  error: "",
  poolIdentity: "ScheduledThreadPoolExecutor@abc",
  poolClassName: "java.util.concurrent.ScheduledThreadPoolExecutor",
  attributionMode: "SCHEDULE_AND_RUN",
  startedAtEpochMillis: 1_000_000,
  deadlineEpochMillis: 1_030_000,
  maximumTrackedTasks: 1024,
  submitted: 0,
  started: 0,
  completed: 0,
  failures: 0,
  rejected: 0,
  unmatchedStarts: 0,
  droppedSubmissions: 0,
  orphanedSubmissions: 0,
  pendingTracked: 0,
  inFlight: 0,
  waitObserved: 0,
  waitDurationNanos: 0,
  waitMaximumNanos: 0,
  waitP95Nanos: 0,
  waitP99Nanos: 0,
  scheduleDelayObserved: 0,
  scheduleDelayDurationNanos: 0,
  scheduleDelayMaximumNanos: 0,
  scheduleDelayP95Nanos: 0,
  scheduleDelayP99Nanos: 0,
  startLatenessObserved: 0,
  startLatenessDurationNanos: 0,
  startLatenessMaximumNanos: 0,
  startLatenessP95Nanos: 0,
  startLatenessP99Nanos: 0,
  runDurationNanos: 0,
  runMaximumNanos: 0,
  runP95Nanos: 0,
  runP99Nanos: 0,
  taskTypes: [],
  boundary: "bounded",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useTargetsStore.setState(useTargetsStore.getInitialState(), true);
});

describe("thread-pool latency selection", () => {
  it.each(["success", "failure"])(
    "ignores a late stop %s after switching pools",
    async (outcome) => {
      useTargetsStore.setState({
        selectedTargetId: connection.target.id,
        connections: { [connection.target.id]: connection },
      });
      vi.stubGlobal("tanwei", {
        listThreads: async () => success({ offset: 0, total: 0, items: [] }),
        listThreadPoolAliases: async () => success([]),
      });
      vi.spyOn(threadActions, "inspectPools").mockResolvedValue(
        success({ inspection, completedAt: "2026-10-28T00:00:00.000Z" }),
      );
      vi.spyOn(threadActions, "startLatency").mockResolvedValue(
        success(snapshot),
      );
      vi.spyOn(threadActions, "latencySnapshot").mockResolvedValue(
        success(snapshot),
      );
      let finishStop!: (
        result: OperationResult<ThreadPoolLatencySnapshot>,
      ) => void;
      const stopResult = new Promise<
        OperationResult<ThreadPoolLatencySnapshot>
      >((resolve) => {
        finishStop = resolve;
      });
      const stop = vi
        .spyOn(threadActions, "stopLatency")
        .mockReturnValue(stopResult);
      await act(async () => {
        render(
          <MemoryRouter>
            <ThreadsView />
          </MemoryRouter>,
        );
      });
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: "我确认执行一次有界的 JVMTI 线程池实例扫描。",
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "检查线程池" }));
      await screen.findByRole("region", { name: snapshot.poolIdentity });
      fireEvent.click(screen.getByTestId("thread-pool-latency-confirmation"));
      fireEvent.click(screen.getByTestId("thread-pool-latency-start"));
      await screen.findByText("时长归因中");
      fireEvent.click(screen.getByTestId("thread-pool-latency-stop"));
      expect(stop).toHaveBeenCalledOnce();
      const forkJoinCard = screen
        .getByText("ForkJoinPool@def")
        .closest("article");
      expect(forkJoinCard).not.toBeNull();
      fireEvent.click(
        within(forkJoinCard!).getByRole("button", { name: "查看成员" }),
      );
      expect(screen.getByText(/外部协助执行不混入结果/u)).toBeTruthy();
      await act(async () => {
        finishStop(
          outcome === "success"
            ? success({ ...snapshot, state: "CANCELLED" })
            : {
                ok: false,
                value: null,
                errorCode: "STOP_FAILED",
                errorMessage: "stale stop failure",
              },
        );
        await stopResult;
      });
      expect(screen.getByText(/外部协助执行不混入结果/u)).toBeTruthy();
      expect(screen.queryByText("stale stop failure")).toBeNull();
    },
  );
});
