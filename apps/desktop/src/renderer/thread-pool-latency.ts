const MAXIMUM_TASK_TYPES = 33;
const MAXIMUM_TEXT_LENGTH = 512;
const MAXIMUM_METRIC = Number.MAX_SAFE_INTEGER;

export type ThreadPoolLatencyState =
  | "RUNNING"
  | "CANCELLED"
  | "TIMED_OUT"
  | "FAILED";

export type ThreadPoolLatencyMode =
  | "QUEUE_AND_RUN"
  | "SCHEDULE_AND_RUN"
  | "RUN_ONLY";

export type ThreadPoolLatencyPoolClass =
  | "java.util.concurrent.ThreadPoolExecutor"
  | "java.util.concurrent.ScheduledThreadPoolExecutor"
  | "java.util.concurrent.ForkJoinPool";

export interface ThreadPoolLatencyTaskType {
  readonly className: string;
  readonly started: number;
  readonly completed: number;
  readonly failures: number;
  readonly waitObserved: number;
  readonly waitDurationNanos: number;
  readonly waitMaximumNanos: number;
  readonly scheduleDelayObserved: number;
  readonly scheduleDelayDurationNanos: number;
  readonly scheduleDelayMaximumNanos: number;
  readonly startLatenessObserved: number;
  readonly startLatenessDurationNanos: number;
  readonly startLatenessMaximumNanos: number;
  readonly runDurationNanos: number;
  readonly runMaximumNanos: number;
}

export interface ThreadPoolLatencySnapshot {
  readonly taskId: string;
  readonly state: ThreadPoolLatencyState;
  readonly error: string;
  readonly poolIdentity: string;
  readonly poolClassName: ThreadPoolLatencyPoolClass;
  readonly attributionMode: ThreadPoolLatencyMode;
  readonly startedAtEpochMillis: number;
  readonly deadlineEpochMillis: number;
  readonly maximumTrackedTasks: number;
  readonly submitted: number;
  readonly started: number;
  readonly completed: number;
  readonly failures: number;
  readonly rejected: number;
  readonly unmatchedStarts: number;
  readonly droppedSubmissions: number;
  readonly orphanedSubmissions: number;
  readonly pendingTracked: number;
  readonly inFlight: number;
  readonly waitObserved: number;
  readonly waitDurationNanos: number;
  readonly waitMaximumNanos: number;
  readonly waitP95Nanos: number;
  readonly waitP99Nanos: number;
  readonly scheduleDelayObserved: number;
  readonly scheduleDelayDurationNanos: number;
  readonly scheduleDelayMaximumNanos: number;
  readonly scheduleDelayP95Nanos: number;
  readonly scheduleDelayP99Nanos: number;
  readonly startLatenessObserved: number;
  readonly startLatenessDurationNanos: number;
  readonly startLatenessMaximumNanos: number;
  readonly startLatenessP95Nanos: number;
  readonly startLatenessP99Nanos: number;
  readonly runDurationNanos: number;
  readonly runMaximumNanos: number;
  readonly runP95Nanos: number;
  readonly runP99Nanos: number;
  readonly taskTypes: readonly ThreadPoolLatencyTaskType[];
  readonly boundary: string;
}

function safeText(
  values: Readonly<Record<string, string>>,
  key: string,
): string {
  return (values[key] ?? "").slice(0, MAXIMUM_TEXT_LENGTH);
}

function requiredInteger(
  values: Readonly<Record<string, string>>,
  key: string,
  minimum = 0,
  maximum = MAXIMUM_METRIC,
): number {
  const raw = values[key] ?? "";
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
    throw new Error(`Invalid thread-pool latency metric: ${key}`);
  }
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`Out-of-range thread-pool latency metric: ${key}`);
  }
  return parsed;
}

export function parseThreadPoolLatencySnapshot(
  values: Readonly<Record<string, string>>,
): ThreadPoolLatencySnapshot {
  const taskId = safeText(values, "taskId");
  const state = safeText(values, "state");
  const poolIdentity = safeText(values, "poolIdentity");
  const poolClassName = safeText(values, "poolClassName");
  const attributionMode = safeText(values, "attributionMode");
  const identityPatterns: Readonly<Record<ThreadPoolLatencyPoolClass, RegExp>> = {
    "java.util.concurrent.ThreadPoolExecutor":
      /^ThreadPoolExecutor@[0-9a-f]+$/u,
    "java.util.concurrent.ScheduledThreadPoolExecutor":
      /^ScheduledThreadPoolExecutor@[0-9a-f]+$/u,
    "java.util.concurrent.ForkJoinPool": /^ForkJoinPool@[0-9a-f]+$/u,
  };
  const supportedClass = poolClassName as ThreadPoolLatencyPoolClass;
  const identityPattern = identityPatterns[supportedClass];
  const expectedMode =
    supportedClass === "java.util.concurrent.ThreadPoolExecutor"
      ? "QUEUE_AND_RUN"
      : supportedClass ===
          "java.util.concurrent.ScheduledThreadPoolExecutor"
        ? "SCHEDULE_AND_RUN"
        : "RUN_ONLY";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      taskId,
    ) ||
    (state !== "RUNNING" &&
      state !== "CANCELLED" &&
      state !== "TIMED_OUT" &&
      state !== "FAILED") ||
    !identityPattern?.test(poolIdentity) ||
    attributionMode !== expectedMode
  ) {
    throw new Error("Invalid thread-pool latency identity");
  }

  const startedAtEpochMillis = requiredInteger(
    values,
    "startedAtEpochMillis",
    1,
  );
  const deadlineEpochMillis = requiredInteger(
    values,
    "deadlineEpochMillis",
    startedAtEpochMillis + 10_000,
  );
  if (deadlineEpochMillis - startedAtEpochMillis > 300_000) {
    throw new Error("Invalid thread-pool latency deadline");
  }
  const maximumTrackedTasks = requiredInteger(
    values,
    "maximumTrackedTasks",
    128,
    4_096,
  );
  const metric = (key: string): number => requiredInteger(values, key);
  const pendingTracked = requiredInteger(
    values,
    "pendingTracked",
    0,
    maximumTrackedTasks,
  );
  const inFlight = requiredInteger(values, "inFlight", 0, 100_000);
  const taskTypeCount = requiredInteger(
    values,
    "taskTypeCount",
    0,
    MAXIMUM_TASK_TYPES,
  );
  const taskTypes: ThreadPoolLatencyTaskType[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < taskTypeCount; index += 1) {
    const prefix = `taskType.${String(index).padStart(3, "0")}.`;
    const className = safeText(values, `${prefix}className`);
    if (!className || seen.has(className)) {
      throw new Error("Invalid thread-pool latency task type");
    }
    seen.add(className);
    const started = requiredInteger(values, `${prefix}started`);
    const completed = requiredInteger(values, `${prefix}completed`);
    const failures = requiredInteger(values, `${prefix}failures`);
    const waitObserved = requiredInteger(values, `${prefix}waitObserved`);
    const waitDurationNanos = requiredInteger(
      values,
      `${prefix}waitDurationNanos`,
    );
    const waitMaximumNanos = requiredInteger(
      values,
      `${prefix}waitMaximumNanos`,
    );
    const scheduleDelayObserved = requiredInteger(
      values,
      `${prefix}scheduleDelayObserved`,
    );
    const scheduleDelayDurationNanos = requiredInteger(
      values,
      `${prefix}scheduleDelayDurationNanos`,
    );
    const scheduleDelayMaximumNanos = requiredInteger(
      values,
      `${prefix}scheduleDelayMaximumNanos`,
    );
    const startLatenessObserved = requiredInteger(
      values,
      `${prefix}startLatenessObserved`,
    );
    const startLatenessDurationNanos = requiredInteger(
      values,
      `${prefix}startLatenessDurationNanos`,
    );
    const startLatenessMaximumNanos = requiredInteger(
      values,
      `${prefix}startLatenessMaximumNanos`,
    );
    if (
      completed > started ||
      failures > completed ||
      waitObserved > started ||
      startLatenessObserved > started ||
      startLatenessObserved > scheduleDelayObserved ||
      (attributionMode !== "QUEUE_AND_RUN" &&
        (waitObserved !== 0 ||
          waitDurationNanos !== 0 ||
          waitMaximumNanos !== 0)) ||
      (attributionMode !== "SCHEDULE_AND_RUN" &&
        (scheduleDelayObserved !== 0 ||
          scheduleDelayDurationNanos !== 0 ||
          scheduleDelayMaximumNanos !== 0 ||
          startLatenessObserved !== 0 ||
          startLatenessDurationNanos !== 0 ||
          startLatenessMaximumNanos !== 0))
    ) {
      throw new Error("Inconsistent thread-pool latency task type");
    }
    taskTypes.push({
      className,
      started,
      completed,
      failures,
      waitObserved,
      waitDurationNanos,
      waitMaximumNanos,
      scheduleDelayObserved,
      scheduleDelayDurationNanos,
      scheduleDelayMaximumNanos,
      startLatenessObserved,
      startLatenessDurationNanos,
      startLatenessMaximumNanos,
      runDurationNanos: requiredInteger(
        values,
        `${prefix}runDurationNanos`,
      ),
      runMaximumNanos: requiredInteger(
        values,
        `${prefix}runMaximumNanos`,
      ),
    });
  }

  const submitted = metric("submitted");
  const started = metric("started");
  const completed = metric("completed");
  const failures = metric("failures");
  const unmatchedStarts = metric("unmatchedStarts");
  const waitObserved = metric("waitObserved");
  const rejected = metric("rejected");
  const droppedSubmissions = metric("droppedSubmissions");
  const orphanedSubmissions = metric("orphanedSubmissions");
  const waitDurationNanos = metric("waitDurationNanos");
  const waitMaximumNanos = metric("waitMaximumNanos");
  const waitP95Nanos = metric("waitP95Nanos");
  const waitP99Nanos = metric("waitP99Nanos");
  const scheduleDelayObserved = metric("scheduleDelayObserved");
  const scheduleDelayDurationNanos = metric("scheduleDelayDurationNanos");
  const scheduleDelayMaximumNanos = metric("scheduleDelayMaximumNanos");
  const scheduleDelayP95Nanos = metric("scheduleDelayP95Nanos");
  const scheduleDelayP99Nanos = metric("scheduleDelayP99Nanos");
  const startLatenessObserved = metric("startLatenessObserved");
  const startLatenessDurationNanos = metric("startLatenessDurationNanos");
  const startLatenessMaximumNanos = metric("startLatenessMaximumNanos");
  const startLatenessP95Nanos = metric("startLatenessP95Nanos");
  const startLatenessP99Nanos = metric("startLatenessP99Nanos");
  const hasWaitMetrics =
    waitObserved !== 0 ||
    waitDurationNanos !== 0 ||
    waitMaximumNanos !== 0 ||
    waitP95Nanos !== 0 ||
    waitP99Nanos !== 0;
  const hasScheduleMetrics =
    scheduleDelayObserved !== 0 ||
    scheduleDelayDurationNanos !== 0 ||
    scheduleDelayMaximumNanos !== 0 ||
    scheduleDelayP95Nanos !== 0 ||
    scheduleDelayP99Nanos !== 0 ||
    startLatenessObserved !== 0 ||
    startLatenessDurationNanos !== 0 ||
    startLatenessMaximumNanos !== 0 ||
    startLatenessP95Nanos !== 0 ||
    startLatenessP99Nanos !== 0;
  if (
    completed > started ||
    failures > completed ||
    waitObserved > started ||
    scheduleDelayObserved > submitted ||
    startLatenessObserved > started ||
    startLatenessObserved > scheduleDelayObserved ||
    unmatchedStarts > started ||
    (attributionMode === "QUEUE_AND_RUN" &&
      state !== "RUNNING" &&
      started > submitted + unmatchedStarts) ||
    (attributionMode !== "QUEUE_AND_RUN" && hasWaitMetrics) ||
    (attributionMode !== "SCHEDULE_AND_RUN" && hasScheduleMetrics) ||
    (attributionMode === "RUN_ONLY" &&
      (submitted !== 0 ||
        rejected !== 0 ||
        unmatchedStarts !== 0 ||
        droppedSubmissions !== 0 ||
        orphanedSubmissions !== 0 ||
        pendingTracked !== 0 ||
        hasWaitMetrics ||
        hasScheduleMetrics))
  ) {
    throw new Error("Inconsistent thread-pool latency totals");
  }

  return {
    taskId,
    state,
    error: safeText(values, "error"),
    poolIdentity,
    poolClassName: supportedClass,
    attributionMode: attributionMode as ThreadPoolLatencyMode,
    startedAtEpochMillis,
    deadlineEpochMillis,
    maximumTrackedTasks,
    submitted,
    started,
    completed,
    failures,
    rejected,
    unmatchedStarts,
    droppedSubmissions,
    orphanedSubmissions,
    pendingTracked,
    inFlight,
    waitObserved,
    waitDurationNanos,
    waitMaximumNanos,
    waitP95Nanos,
    waitP99Nanos,
    scheduleDelayObserved,
    scheduleDelayDurationNanos,
    scheduleDelayMaximumNanos,
    scheduleDelayP95Nanos,
    scheduleDelayP99Nanos,
    startLatenessObserved,
    startLatenessDurationNanos,
    startLatenessMaximumNanos,
    startLatenessP95Nanos,
    startLatenessP99Nanos,
    runDurationNanos: metric("runDurationNanos"),
    runMaximumNanos: metric("runMaximumNanos"),
    runP95Nanos: metric("runP95Nanos"),
    runP99Nanos: metric("runP99Nanos"),
    taskTypes,
    boundary: safeText(values, "boundary"),
  };
}

export function averageNanos(total: number, count: number): number {
  return count > 0 ? Math.round(total / count) : 0;
}
