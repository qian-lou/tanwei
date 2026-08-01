import type {
  ActionRequest,
  ActionResult,
  OperationResult,
} from "@shared/contracts";
import {
  parseThreadPoolInspection,
  type ThreadPoolInspection,
} from "./thread-pool-inspection";
import {
  parseThreadPoolLatencySnapshot,
  type ThreadPoolLatencyMode,
  type ThreadPoolLatencyPoolClass,
  type ThreadPoolLatencySnapshot,
} from "./thread-pool-latency";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface HeldLock {
  readonly lock: string;
  readonly frame: string;
}

export interface LockNode {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly deadlocked: boolean;
  readonly waitingLock: string;
  readonly ownerId: number | null;
  readonly ownerName: string;
  readonly stackTop: string;
  readonly monitors: readonly HeldLock[];
  readonly synchronizers: readonly HeldLock[];
}

export interface LockSummary {
  readonly scanned: number;
  readonly related: number;
  readonly truncated: number;
  readonly waiting: number;
  readonly heldLocks: number;
  readonly deadlocked: number;
  readonly edges: number;
}

export interface ThreadLockInspection {
  readonly nodes: readonly LockNode[];
  readonly summary: LockSummary;
}

export interface ThreadPoolInspectionResult {
  readonly inspection: ThreadPoolInspection;
  readonly completedAt: string;
}

export interface ThreadDumpTicket {
  readonly token: string;
  readonly expectedSize: number;
}

export interface ThreadPoolLatencyStart {
  readonly taskId: string;
  readonly poolIdentity: string;
  readonly poolClassName: ThreadPoolLatencyPoolClass;
  readonly attributionMode: ThreadPoolLatencyMode;
}

export interface ThreadInterruptPreview {
  readonly threadId: number;
  readonly name: string;
  readonly state: string;
  readonly daemon: boolean;
  readonly stackTop: string;
  readonly boundary: string;
}

export interface ThreadInterruptExecution {
  readonly threadId: number;
  readonly name: string;
}

type Parser<T> = (result: ActionResult) => T;

function failure<T>(
  errorCode: string,
  errorMessage: string,
): OperationResult<T> {
  return { ok: false, value: null, errorCode, errorMessage };
}

async function execute<T>(
  request: ActionRequest,
  parser: Parser<T>,
): Promise<OperationResult<T>> {
  const response = await window.tanwei.executeAction({
    ...request,
    contractVersion: "1.0",
  });
  if (!response.ok || !response.value) {
    return failure(
      response.errorCode ?? "ACTION_EXECUTION_FAILED",
      response.errorMessage ?? "诊断操作执行失败",
    );
  }
  if (response.value.status !== "SUCCEEDED") {
    return failure(
      response.value.errorCode ?? "ACTION_EXECUTION_FAILED",
      response.value.message ?? "Agent 未能完成诊断操作",
    );
  }
  try {
    return {
      ok: true,
      value: parser(response.value),
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    return failure(
      "ACTION_CONTRACT_INVALID_RESPONSE",
      error instanceof Error ? error.message : "Agent 返回了无效的 Action 契约",
    );
  }
}

function boundedCount(
  values: Readonly<Record<string, string>>,
  key: string,
  maximum: number,
): number {
  const raw = values[key] ?? "";
  const parsed = Number(raw);
  if (
    !/^(?:0|[1-9]\d*)$/u.test(raw) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > maximum
  ) {
    throw new Error(`线程 Action 字段无效：${key}`);
  }
  return parsed;
}

function parseLocks(
  values: Readonly<Record<string, string>>,
  prefix: string,
  kind: "monitor" | "synchronizer",
): readonly HeldLock[] {
  const count = boundedCount(values, `${prefix}${kind}.count`, 32);
  return Array.from({ length: count }, (_, index): HeldLock => {
    const lockPrefix = `${prefix}${kind}.${String(index).padStart(4, "0")}.`;
    const lock = values[`${lockPrefix}lock`] ?? "";
    if (!lock) {
      throw new Error(`线程锁字段缺失：${lockPrefix}lock`);
    }
    return { lock, frame: values[`${lockPrefix}frame`] ?? "" };
  });
}

export function parseThreadLockInspection(
  result: ActionResult,
): ThreadLockInspection {
  const values = result.values;
  const count = boundedCount(values, "count", 500);
  const nodes = Array.from({ length: count }, (_, index): LockNode => {
    const prefix = `node.${String(index).padStart(4, "0")}.`;
    const id = Number(values[`${prefix}id`] ?? "");
    const name = values[`${prefix}name`] ?? "";
    const rawOwner = Number(values[`${prefix}ownerId`] ?? -1);
    if (!Number.isSafeInteger(id) || id <= 0 || !name) {
      throw new Error(`线程锁节点无效：${prefix}`);
    }
    return {
      id,
      name,
      state: values[`${prefix}state`] ?? "UNKNOWN",
      deadlocked: values[`${prefix}deadlocked`] === "true",
      waitingLock: values[`${prefix}waitingLock`] ?? "",
      ownerId: Number.isSafeInteger(rawOwner) && rawOwner >= 0 ? rawOwner : null,
      ownerName: values[`${prefix}ownerName`] ?? "",
      stackTop: values[`${prefix}stackTop`] ?? "",
      monitors: parseLocks(values, prefix, "monitor"),
      synchronizers: parseLocks(values, prefix, "synchronizer"),
    };
  });
  return {
    nodes,
    summary: {
      scanned: boundedCount(values, "scanned", 1_000_000),
      related: boundedCount(values, "related", 1_000_000),
      truncated: boundedCount(values, "truncated", 1_000_000),
      waiting: boundedCount(values, "waiting", 1_000_000),
      heldLocks: boundedCount(values, "heldLocks", 1_000_000),
      deadlocked: boundedCount(values, "deadlocked", 1_000_000),
      edges: boundedCount(values, "edges", 1_000_000),
    },
  };
}

function parseThreadDump(result: ActionResult): ThreadDumpTicket {
  const token = result.values.token ?? "";
  const expectedSize = Number(result.values.size ?? "");
  if (
    result.values.type !== "THREAD_DUMP" ||
    !UUID_PATTERN.test(token) ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    expectedSize > 32 * 1024 * 1024
  ) {
    throw new Error("Agent 返回了无效的线程转储契约");
  }
  return { token, expectedSize };
}

function parseLatencyStart(result: ActionResult): ThreadPoolLatencyStart {
  const taskId = result.values.taskId ?? "";
  const poolIdentity = result.values.poolIdentity ?? "";
  const poolClassName = result.values.poolClassName as ThreadPoolLatencyPoolClass;
  const attributionMode = result.values.attributionMode as ThreadPoolLatencyMode;
  if (
    !UUID_PATTERN.test(taskId) ||
    !poolIdentity ||
    (poolClassName !== "java.util.concurrent.ThreadPoolExecutor" &&
      poolClassName !== "java.util.concurrent.ScheduledThreadPoolExecutor" &&
      poolClassName !== "java.util.concurrent.ForkJoinPool") ||
    (attributionMode !== "QUEUE_AND_RUN" &&
      attributionMode !== "SCHEDULE_AND_RUN" &&
      attributionMode !== "RUN_ONLY")
  ) {
    throw new Error("Agent 返回了无效的线程池时长任务契约");
  }
  return { taskId, poolIdentity, poolClassName, attributionMode };
}

function parseInterruptPreview(result: ActionResult): ThreadInterruptPreview {
  const threadId = Number(result.values.threadId ?? "");
  const daemon = result.values.daemon;
  const name = result.values.name ?? "";
  if (
    !Number.isSafeInteger(threadId) ||
    threadId <= 0 ||
    !name ||
    (daemon !== "true" && daemon !== "false")
  ) {
    throw new Error("Agent 返回了无效的线程中断预览契约");
  }
  return {
    threadId,
    name,
    state: result.values.state ?? "UNKNOWN",
    daemon: daemon === "true",
    stackTop: result.values.stackTop ?? "",
    boundary: result.values.boundary ?? "",
  };
}

function parseInterruptExecution(result: ActionResult): ThreadInterruptExecution {
  const threadId = Number(result.values.threadId ?? "");
  const name = result.values.name ?? "";
  if (!Number.isSafeInteger(threadId) || threadId <= 0 || !name) {
    throw new Error("Agent 返回了无效的线程中断结果契约");
  }
  return { threadId, name };
}

export const threadActions = {
  inspectPools(
    targetId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<OperationResult<ThreadPoolInspectionResult>> {
    return execute(
      { targetId, actionId: "thread.pools", parameters },
      (result) => ({
        inspection: parseThreadPoolInspection(result.values),
        completedAt: result.completedAt,
      }),
    );
  },
  createDump(
    targetId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<OperationResult<ThreadDumpTicket>> {
    return execute({ targetId, actionId: "thread.dump", parameters }, parseThreadDump);
  },
  latencySnapshot(
    targetId: string,
    taskId: string,
  ): Promise<OperationResult<ThreadPoolLatencySnapshot>> {
    return execute(
      {
        targetId,
        actionId: "thread.pool.latency.snapshot",
        parameters: { taskId },
      },
      (result) => parseThreadPoolLatencySnapshot(result.values),
    );
  },
  startLatency(
    targetId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<OperationResult<ThreadPoolLatencyStart>> {
    return execute(
      { targetId, actionId: "thread.pool.latency.start", parameters },
      parseLatencyStart,
    );
  },
  stopLatency(
    targetId: string,
    taskId: string,
  ): Promise<OperationResult<ThreadPoolLatencySnapshot>> {
    return execute(
      {
        targetId,
        actionId: "thread.pool.latency.stop",
        parameters: { taskId, confirmed: "true" },
      },
      (result) => parseThreadPoolLatencySnapshot(result.values),
    );
  },
  inspectLocks(
    targetId: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<OperationResult<ThreadLockInspection>> {
    return execute(
      { targetId, actionId: "thread.locks", parameters },
      parseThreadLockInspection,
    );
  },
  previewInterrupt(
    targetId: string,
    threadId: number,
  ): Promise<OperationResult<ThreadInterruptPreview>> {
    return execute(
      {
        targetId,
        actionId: "thread.interrupt.preview",
        parameters: { threadId: String(threadId) },
      },
      parseInterruptPreview,
    );
  },
  interrupt(
    targetId: string,
    threadId: number,
    expectedName: string,
  ): Promise<OperationResult<ThreadInterruptExecution>> {
    return execute(
      {
        targetId,
        actionId: "thread.interrupt",
        parameters: {
          threadId: String(threadId),
          expectedName,
          confirmed: "true",
          confirmedSecondary: "true",
        },
      },
      parseInterruptExecution,
    );
  },
};
