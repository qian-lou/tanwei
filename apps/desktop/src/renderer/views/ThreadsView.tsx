import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Disclosure } from "@/components/ui/disclosure";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type {
  ArtifactDescriptor,
  SupportedThreadPoolClass,
  TargetConnection,
  ThreadDescriptor,
  ThreadPoolAliasDescriptor,
  ThreadPoolKind,
  ThreadPoolRuntimeState,
  ThreadPoolTrendSample,
} from "@shared/contracts";
import { cn } from "@/lib/utils";
import StatePagination from "../components/StatePagination";
import StatusPill from "../components/StatusPill";
import { t, useLocale } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import {
  buildThreadSnapshotDiff,
  type ThreadSnapshot,
  type ThreadSnapshotDiff,
} from "../thread-snapshot-diff";
import {
  buildThreadTrendPoint,
  type ThreadHotCpuRate,
  type ThreadTrendPoint,
} from "../thread-trend";
import {
  type ThreadPool,
  type ThreadPoolMember,
  type ThreadPoolSummary,
} from "../thread-pool-inspection";
import {
  averageNanos,
  type ThreadPoolLatencyMode,
  type ThreadPoolLatencySnapshot,
} from "../thread-pool-latency";
import {
  threadActions,
  type LockNode,
  type LockSummary,
  type ThreadInterruptExecution,
  type ThreadInterruptPreview,
} from "../thread-action-contract";
import { RingBuffer } from "../utils/ring-buffer";
import "./ThreadsView.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";

const PAGE_SIZE = 100;
const MAXIMUM_THREAD_TREND_SAMPLES = 120;

type ThreadState =
  | "ALL"
  | "NEW"
  | "RUNNABLE"
  | "BLOCKED"
  | "WAITING"
  | "TIMED_WAITING"
  | "TERMINATED";

interface ThreadPoolTrendIdentity {
  readonly targetId: string;
  readonly jvmStartTimeEpochMillis: number;
  readonly poolIdentity: string;
  readonly poolClassName: SupportedThreadPoolClass;
  readonly poolKind: ThreadPoolKind;
  readonly alias: string | null;
}
interface ThreadPoolMemberEvidenceGroup {
  readonly value: string;
  readonly count: number;
  readonly states: string;
  readonly representative: ThreadPoolMember;
}
interface ThreadPoolLatencyIdentity {
  readonly targetId: string;
  readonly taskId: string;
  readonly poolIdentity: string;
  readonly poolClassName: SupportedThreadPoolClass;
}
interface ThreadsViewState {
  threads: readonly ThreadDescriptor[];
  total: number;
  offset: number;
  query: string;
  stateFilter: ThreadState;
  loading: boolean;
  errorMessage: string | null;
  previewingThreadId: number | null;
  interrupting: boolean;
  interruptConfirmed: boolean;
  interruptConfirmedSecondary: boolean;
  interruptPreview: ThreadInterruptPreview | null;
  interruptResult: ThreadInterruptExecution | null;
  lockNodes: readonly LockNode[];
  lockSummary: LockSummary | null;
  includeUncontended: boolean;
  maximumLockNodes: number;
  loadingLocks: boolean;
  selectedLockThreadId: number | null;
  lockRenderLimit: number;
  threadPools: readonly ThreadPool[];
  threadPoolSummary: ThreadPoolSummary | null;
  threadPoolLimit: number;
  threadPoolMemberLimit: number;
  threadPoolConfirmed: boolean;
  loadingThreadPools: boolean;
  selectedThreadPoolIdentity: string | null;
  threadPoolAliases: Readonly<Record<string, ThreadPoolAliasDescriptor>>;
  threadPoolAliasDraft: string;
  savingThreadPoolAlias: boolean;
  threadPoolAliasMessage: string | null;
  threadPoolTrendSamples: readonly ThreadPoolTrendSample[];
  threadPoolTrendIdentity: ThreadPoolTrendIdentity | null;
  threadPoolTrendSamplingIntervalMillis: 2_000 | 5_000 | 10_000 | 30_000;
  threadPoolTrendConfirmed: boolean;
  threadPoolTrendSampling: boolean;
  collectingThreadPoolTrend: boolean;
  savingThreadPoolTrend: boolean;
  threadPoolTrendErrorMessage: string | null;
  threadPoolTrendArtifact: ArtifactDescriptor | null;
  threadPoolLatencyIdentity: ThreadPoolLatencyIdentity | null;
  threadPoolLatencySnapshot: ThreadPoolLatencySnapshot | null;
  threadPoolLatencyDurationMillis: number;
  threadPoolLatencyMaximumTrackedTasks: number;
  threadPoolLatencyConfirmed: boolean;
  startingThreadPoolLatency: boolean;
  collectingThreadPoolLatency: boolean;
  stoppingThreadPoolLatency: boolean;
  threadPoolLatencyErrorMessage: string | null;
  baselineSnapshot: ThreadSnapshot | null;
  snapshotDiff: ThreadSnapshotDiff | null;
  capturingBaseline: boolean;
  comparingSnapshots: boolean;
  threadDumpStackDepth: number;
  threadDumpIncludeLocks: boolean;
  creatingThreadDump: boolean;
  threadDumpArtifact: ArtifactDescriptor | null;
  threadTrendSamples: readonly ThreadTrendPoint[];
  threadTrendSamplingIntervalMillis: number;
  threadTrendSampling: boolean;
  collectingThreadTrend: boolean;
  threadTrendErrorMessage: string | null;
}

const states: readonly ThreadState[] = [
  "ALL",
  "NEW",
  "RUNNABLE",
  "BLOCKED",
  "WAITING",
  "TIMED_WAITING",
  "TERMINATED",
];

function createInitialState(): ThreadsViewState {
  return {
    threads: [],
    total: 0,
    offset: 0,
    query: "",
    stateFilter: "ALL",
    loading: false,
    errorMessage: null,
    previewingThreadId: null,
    interrupting: false,
    interruptConfirmed: false,
    interruptConfirmedSecondary: false,
    interruptPreview: null,
    interruptResult: null,
    lockNodes: [],
    lockSummary: null,
    includeUncontended: false,
    maximumLockNodes: 200,
    loadingLocks: false,
    selectedLockThreadId: null,
    lockRenderLimit: 100,
    threadPools: [],
    threadPoolSummary: null,
    threadPoolLimit: 12,
    threadPoolMemberLimit: 100,
    threadPoolConfirmed: false,
    loadingThreadPools: false,
    selectedThreadPoolIdentity: null,
    threadPoolAliases: {},
    threadPoolAliasDraft: "",
    savingThreadPoolAlias: false,
    threadPoolAliasMessage: null,
    threadPoolTrendSamples: [],
    threadPoolTrendIdentity: null,
    threadPoolTrendSamplingIntervalMillis: 5_000,
    threadPoolTrendConfirmed: false,
    threadPoolTrendSampling: false,
    collectingThreadPoolTrend: false,
    savingThreadPoolTrend: false,
    threadPoolTrendErrorMessage: null,
    threadPoolTrendArtifact: null,
    threadPoolLatencyIdentity: null,
    threadPoolLatencySnapshot: null,
    threadPoolLatencyDurationMillis: 30_000,
    threadPoolLatencyMaximumTrackedTasks: 1_024,
    threadPoolLatencyConfirmed: false,
    startingThreadPoolLatency: false,
    collectingThreadPoolLatency: false,
    stoppingThreadPoolLatency: false,
    threadPoolLatencyErrorMessage: null,
    baselineSnapshot: null,
    snapshotDiff: null,
    capturingBaseline: false,
    comparingSnapshots: false,
    threadDumpStackDepth: 256,
    threadDumpIncludeLocks: true,
    creatingThreadDump: false,
    threadDumpArtifact: null,
    threadTrendSamples: [],
    threadTrendSamplingIntervalMillis: 2_000,
    threadTrendSampling: false,
    collectingThreadTrend: false,
    threadTrendErrorMessage: null,
  };
}

function capabilityAvailable(
  connection: TargetConnection | null,
  capabilityId: string,
): boolean {
  return (
    connection?.capabilities.some(
      (capability) =>
        capability.id === capabilityId && capability.state === "AVAILABLE",
    ) ?? false
  );
}

function formatCpu(nanoseconds: number | null): string {
  if (nanoseconds === null) {
    return t("不支持");
  }
  return `${(nanoseconds / 1_000_000).toFixed(1)} ms`;
}

function isSupportedThreadPoolClass(
  value: string,
): value is SupportedThreadPoolClass {
  return (
    value === "java.util.concurrent.ThreadPoolExecutor" ||
    value === "java.util.concurrent.ScheduledThreadPoolExecutor" ||
    value === "java.util.concurrent.ForkJoinPool"
  );
}

function poolKindLabel(kind: string): string {
  if (kind === "FORK_JOIN") {
    return "ForkJoinPool";
  }
  if (kind === "SCHEDULED") {
    return "ScheduledThreadPool";
  }
  return "ThreadPoolExecutor";
}

function shortClassName(className: string): string {
  const segments = className.split(".");
  return segments.at(-1) ?? className;
}

function groupThreadPoolMemberEvidence(
  members: readonly ThreadPoolMember[],
  selectValue: (member: ThreadPoolMember) => string,
): readonly ThreadPoolMemberEvidenceGroup[] {
  const groups = new Map<
    string,
    {
      count: number;
      states: Set<string>;
      representative: ThreadPoolMember;
    }
  >();
  for (const member of members) {
    const value = selectValue(member);
    if (!value) {
      continue;
    }
    const existing = groups.get(value);
    if (existing) {
      existing.count += 1;
      existing.states.add(member.state);
    } else {
      groups.set(value, {
        count: 1,
        states: new Set([member.state]),
        representative: member,
      });
    }
  }
  return [...groups.entries()]
    .map(([value, group]) => ({
      value,
      count: group.count,
      states: [...group.states].sort().join(" · "),
      representative: group.representative,
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.value.localeCompare(right.value),
    )
    .slice(0, 8);
}

function threadPoolRejectionDescription(pool: ThreadPool): string {
  const policy = shortClassName(pool.rejectionHandlerType);
  switch (policy) {
    case "ThreadPoolExecutor$AbortPolicy":
      return t("队列满且无法扩容时抛出 RejectedExecutionException。");
    case "ThreadPoolExecutor$CallerRunsPolicy":
      return t("队列满时由提交线程执行任务，可能把背压传回请求线程。");
    case "ThreadPoolExecutor$DiscardPolicy":
      return t("队列满时静默丢弃新任务，需要核对业务补偿与丢弃指标。");
    case "ThreadPoolExecutor$DiscardOldestPolicy":
      return t("队列满时丢弃最旧排队任务并重试提交。");
    case "":
      return pool.kind === "FORK_JOIN"
        ? t("ForkJoinPool 不使用 ThreadPoolExecutor 拒绝处理器。")
        : t("没有返回拒绝策略证据。");
    default:
      return t("自定义拒绝策略；这里只展示精确类型，不执行处理器方法。");
  }
}

function threadPoolQueueEvidenceIssue(issue: string): string {
  switch (issue) {
    case "FORK_JOIN_TASK_TYPES_UNAVAILABLE":
      return t(
        "ForkJoinPool 的任务分散在工作队列中，本检查器不读取其内部任务对象。",
      );
    case "CUSTOM_QUEUE_NOT_INSPECTED":
      return t("自定义队列不会被迭代，避免执行未知实现代码。");
    case "EVIDENCE_BUDGET_EXHAUSTED":
      return t("本次全局队列证据预算已用尽。");
    case "QUEUE_ITERATION_FAILED":
      return t("目标队列在有界迭代期间发生变化，未返回任务类型。");
    case "NOT_REQUESTED":
      return t("本次扫描没有请求队列任务证据。");
    default:
      return t("队列任务类型当前不可用。");
  }
}

function threadPoolKind(value: string): ThreadPoolKind | null {
  return value === "THREAD_POOL" ||
    value === "SCHEDULED" ||
    value === "FORK_JOIN"
    ? value
    : null;
}

function threadPoolRuntimeState(value: string): ThreadPoolRuntimeState | null {
  return value === "RUNNING" ||
    value === "QUIESCENT" ||
    value === "SHUTDOWN" ||
    value === "TERMINATING" ||
    value === "TERMINATED"
    ? value
    : null;
}

function threadPoolMetric(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9]\d{0,18})$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function buildThreadPoolTrendSample(
  pool: ThreadPool,
  capturedAt: number,
): ThreadPoolTrendSample | null {
  const state = threadPoolRuntimeState(pool.state);
  const queuedTasks = threadPoolMetric(pool.queuedTasks);
  const queuedSubmissions = threadPoolMetric(pool.queuedSubmissions);
  if (
    !Number.isSafeInteger(capturedAt) ||
    capturedAt <= 0 ||
    state === null ||
    (queuedTasks === null && queuedSubmissions === null)
  ) {
    return null;
  }
  return {
    capturedAt,
    state,
    configuredSize: threadPoolMetric(pool.configuredSize),
    poolSize: threadPoolMetric(pool.poolSize),
    activeCount: threadPoolMetric(pool.activeCount),
    maximumSize: threadPoolMetric(pool.maximumSize),
    queuedTasks,
    remainingQueueCapacity: threadPoolMetric(pool.remainingQueueCapacity),
    completedTasks: threadPoolMetric(pool.completedTasks),
    queuedSubmissions,
    runningCount: threadPoolMetric(pool.runningCount),
    stealCount: threadPoolMetric(pool.stealCount),
  };
}

function threadPoolQueueLevel(sample: ThreadPoolTrendSample): number {
  return (sample.queuedTasks ?? 0) + (sample.queuedSubmissions ?? 0);
}

function formatLatencyNanos(nanoseconds: number): string {
  if (!Number.isSafeInteger(nanoseconds) || nanoseconds <= 0) {
    return "—";
  }
  if (nanoseconds < 1_000_000) {
    return `${(nanoseconds / 1_000).toFixed(1)} μs`;
  }
  if (nanoseconds < 1_000_000_000) {
    return `${(nanoseconds / 1_000_000).toFixed(1)} ms`;
  }
  return `${(nanoseconds / 1_000_000_000).toFixed(2)} s`;
}

function taskTypeAverageWaitNanos(
  taskType: ThreadPoolLatencySnapshot["taskTypes"][number],
): number {
  return averageNanos(taskType.waitDurationNanos, taskType.waitObserved);
}

function taskTypeAverageRunNanos(
  taskType: ThreadPoolLatencySnapshot["taskTypes"][number],
): number {
  return averageNanos(taskType.runDurationNanos, taskType.completed);
}

function taskTypeAverageScheduleDelayNanos(
  taskType: ThreadPoolLatencySnapshot["taskTypes"][number],
): number {
  return averageNanos(
    taskType.scheduleDelayDurationNanos,
    taskType.scheduleDelayObserved,
  );
}

function taskTypeAverageStartLatenessNanos(
  taskType: ThreadPoolLatencySnapshot["taskTypes"][number],
): number {
  return averageNanos(
    taskType.startLatenessDurationNanos,
    taskType.startLatenessObserved,
  );
}

function threadPoolLatencyMode(
  poolClassName: SupportedThreadPoolClass,
): ThreadPoolLatencyMode {
  if (poolClassName === "java.util.concurrent.ThreadPoolExecutor") {
    return "QUEUE_AND_RUN";
  }
  if (poolClassName === "java.util.concurrent.ScheduledThreadPoolExecutor") {
    return "SCHEDULE_AND_RUN";
  }
  return "RUN_ONLY";
}

function threadPoolTrendPath(
  points: readonly number[],
  samples: readonly ThreadPoolTrendSample[],
): string {
  if (points.length === 0) {
    return "";
  }
  const maximum = Math.max(
    1,
    ...samples.flatMap((sample) => [
      threadPoolQueueLevel(sample),
      sample.activeCount ?? sample.runningCount ?? 0,
      sample.poolSize ?? sample.configuredSize ?? 0,
    ]),
  );
  const denominator = Math.max(points.length - 1, 1);
  return points
    .map((point, index) => {
      const x = (index / denominator) * 600;
      const y = 128 - (Math.max(0, point) / maximum) * 112;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function threadTrendPath(
  points: readonly number[],
  samples: readonly ThreadTrendPoint[],
): string {
  if (points.length === 0) {
    return "";
  }
  const maximum = Math.max(
    1,
    ...samples.flatMap((sample) => [
      sample.total,
      sample.runnable,
      sample.waiting,
      sample.blocked,
    ]),
  );
  const denominator = Math.max(points.length - 1, 1);
  return points
    .map((point, index) => {
      const x = (index / denominator) * 600;
      const y = 128 - (Math.max(0, point) / maximum) * 112;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function formatThreadTrendCpu(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} ms/s`;
}

function formatHotThreadPercent(value: number): string {
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })}%`;
}

function hotThreadBarWidth(value: number): string {
  return `${Math.min(100, Math.max(1, value))}%`;
}

function formatSnapshotTime(epochMillis: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(epochMillis));
}

function formatCpuDelta(nanoseconds: number): string {
  if (nanoseconds < 1_000_000) {
    return `${(nanoseconds / 1_000).toFixed(1)} μs`;
  }
  return `${(nanoseconds / 1_000_000).toFixed(1)} ms`;
}

function findSelectedThreadPool(
  pools: readonly ThreadPool[],
  identity: string | null,
): ThreadPool | null {
  return pools.find((pool) => pool.identity === identity) ?? null;
}

function threadPoolAliasOf(
  aliases: Readonly<Record<string, ThreadPoolAliasDescriptor>>,
  poolIdentity: string,
): string {
  return aliases[poolIdentity]?.alias ?? "";
}

function threadPoolLatencyRunningOf(
  identity: ThreadPoolLatencyIdentity | null,
  snapshot: ThreadPoolLatencySnapshot | null,
): boolean {
  return identity !== null && (snapshot?.state ?? "RUNNING") === "RUNNING";
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

export default function ThreadsView() {
  useLocale();
  const navigate = useNavigate();
  const selectedTargetId = useTargetsStore((state) => state.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const connectionState = connection?.state ?? null;

  const [vm, setVm] = useState<ThreadsViewState>(createInitialState);
  const latestRef = useRef<ThreadsViewState>(vm);
  const apply = useCallback((patch: Partial<ThreadsViewState>): void => {
    const next = { ...latestRef.current, ...patch };
    latestRef.current = next;
    setVm(next);
  }, []);

  const threadListRef = useRef<HTMLDivElement | null>(null);
  const [threadTrendBuffer] = useState(
    () => new RingBuffer<ThreadTrendPoint>(MAXIMUM_THREAD_TREND_SAMPLES),
  );
  const [threadPoolTrendBuffer] = useState(
    () => new RingBuffer<ThreadPoolTrendSample>(MAXIMUM_THREAD_TREND_SAMPLES),
  );
  const previousThreadTrendSnapshotRef = useRef<ThreadSnapshot | null>(null);
  const threadTrendTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const threadPoolTrendTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const threadPoolLatencyTimerRef = useRef<ReturnType<
    typeof setInterval
  > | null>(null);

  const {
    threads,
    total,
    offset,
    query,
    stateFilter,
    loading,
    errorMessage,
    previewingThreadId,
    interrupting,
    interruptConfirmed,
    interruptConfirmedSecondary,
    interruptPreview,
    interruptResult,
    lockNodes,
    lockSummary,
    includeUncontended,
    maximumLockNodes,
    loadingLocks,
    lockRenderLimit,
    selectedLockThreadId,
    threadPools,
    threadPoolSummary,
    threadPoolLimit,
    threadPoolMemberLimit,
    threadPoolConfirmed,
    loadingThreadPools,
    selectedThreadPoolIdentity,
    threadPoolAliases,
    threadPoolAliasDraft,
    savingThreadPoolAlias,
    threadPoolAliasMessage,
    threadPoolTrendSamples,
    threadPoolTrendSamplingIntervalMillis,
    threadPoolTrendConfirmed,
    threadPoolTrendSampling,
    collectingThreadPoolTrend,
    savingThreadPoolTrend,
    threadPoolTrendErrorMessage,
    threadPoolTrendArtifact,
    threadPoolLatencyIdentity,
    threadPoolLatencySnapshot,
    threadPoolLatencyDurationMillis,
    threadPoolLatencyMaximumTrackedTasks,
    threadPoolLatencyConfirmed,
    startingThreadPoolLatency,
    stoppingThreadPoolLatency,
    threadPoolLatencyErrorMessage,
    baselineSnapshot,
    snapshotDiff,
    capturingBaseline,
    comparingSnapshots,
    threadDumpStackDepth,
    threadDumpIncludeLocks,
    creatingThreadDump,
    threadDumpArtifact,
    threadTrendSamples,
    threadTrendSamplingIntervalMillis,
    threadTrendSampling,
    collectingThreadTrend,
    threadTrendErrorMessage,
  } = vm;

  const visibleThreads = threads;
  const deadlockCount = threads.filter((thread) => thread.deadlocked).length;
  const threadControlAvailable = capabilityAvailable(
    connection,
    "thread-control",
  );
  const threadLocksAvailable = capabilityAvailable(connection, "thread-locks");
  const threadPoolsAvailable = capabilityAvailable(connection, "thread-pools");
  const threadPoolLatencyAvailable = capabilityAvailable(
    connection,
    "thread-pool-latency",
  );
  const threadDumpAvailable = capabilityAvailable(connection, "thread-dump");
  const selectedLockNode =
    lockNodes.find((node) => node.id === selectedLockThreadId) ??
    lockNodes[0] ??
    null;
  const visibleLockNodes = lockNodes.slice(0, lockRenderLimit);
  const selectedThreadPool = findSelectedThreadPool(
    threadPools,
    selectedThreadPoolIdentity,
  );
  const selectedThreadPoolGroupSet = new Set<string>();
  for (const member of selectedThreadPool?.members ?? []) {
    if (member.groupName) {
      selectedThreadPoolGroupSet.add(member.groupName);
    }
  }
  const selectedThreadPoolGroups = [...selectedThreadPoolGroupSet];
  const selectedThreadPoolQueueTaskTypes = [
    ...(selectedThreadPool?.queueTaskTypes ?? []),
  ].sort(
    (left, right) =>
      right.count - left.count || left.className.localeCompare(right.className),
  );
  const selectedThreadPoolApplicationFrames = groupThreadPoolMemberEvidence(
    selectedThreadPool?.members ?? [],
    (member) => member.applicationFrame,
  );
  const selectedThreadPoolBlockers = groupThreadPoolMemberEvidence(
    selectedThreadPool?.members ?? [],
    (member) => member.blockerType,
  );
  const selectedThreadPoolSupportsLatency =
    selectedThreadPool !== null &&
    isSupportedThreadPoolClass(selectedThreadPool.className) &&
    threadPoolLatencyAvailable;
  const selectedThreadPoolLatencyMode =
    selectedThreadPool &&
    isSupportedThreadPoolClass(selectedThreadPool.className)
      ? threadPoolLatencyMode(selectedThreadPool.className)
      : "RUN_ONLY";
  const activeThreadPoolLatencyMode =
    threadPoolLatencySnapshot?.attributionMode ?? selectedThreadPoolLatencyMode;
  const threadPoolLatencyWaitSupported =
    activeThreadPoolLatencyMode === "QUEUE_AND_RUN";
  const threadPoolLatencyScheduleSupported =
    activeThreadPoolLatencyMode === "SCHEDULE_AND_RUN";
  const threadPoolLatencyRunning = threadPoolLatencyRunningOf(
    threadPoolLatencyIdentity,
    threadPoolLatencySnapshot,
  );
  const threadPoolLatencyAverageWaitNanos = threadPoolLatencySnapshot
    ? averageNanos(
        threadPoolLatencySnapshot.waitDurationNanos,
        threadPoolLatencySnapshot.waitObserved,
      )
    : 0;
  const threadPoolLatencyAverageRunNanos = threadPoolLatencySnapshot
    ? averageNanos(
        threadPoolLatencySnapshot.runDurationNanos,
        threadPoolLatencySnapshot.completed,
      )
    : 0;
  const threadPoolLatencyAverageScheduleDelayNanos = threadPoolLatencySnapshot
    ? averageNanos(
        threadPoolLatencySnapshot.scheduleDelayDurationNanos,
        threadPoolLatencySnapshot.scheduleDelayObserved,
      )
    : 0;
  const threadPoolLatencyAverageStartLatenessNanos = threadPoolLatencySnapshot
    ? averageNanos(
        threadPoolLatencySnapshot.startLatenessDurationNanos,
        threadPoolLatencySnapshot.startLatenessObserved,
      )
    : 0;
  const threadPoolLatencyTaskTypes = (
    threadPoolLatencySnapshot?.taskTypes ?? []
  ).slice(0, 8);
  const latestThreadPoolTrendSample =
    threadPoolTrendSamples[threadPoolTrendSamples.length - 1] ?? null;
  const firstThreadPoolTrendSample = threadPoolTrendSamples[0];
  const threadPoolTrendQueueDelta =
    firstThreadPoolTrendSample && latestThreadPoolTrendSample
      ? threadPoolQueueLevel(latestThreadPoolTrendSample) -
        threadPoolQueueLevel(firstThreadPoolTrendSample)
      : 0;
  const threadPoolTrendPaths = {
    queue: threadPoolTrendPath(
      threadPoolTrendSamples.map(threadPoolQueueLevel),
      threadPoolTrendSamples,
    ),
    active: threadPoolTrendPath(
      threadPoolTrendSamples.map(
        (sample) => sample.activeCount ?? sample.runningCount ?? 0,
      ),
      threadPoolTrendSamples,
    ),
    size: threadPoolTrendPath(
      threadPoolTrendSamples.map(
        (sample) => sample.poolSize ?? sample.configuredSize ?? 0,
      ),
      threadPoolTrendSamples,
    ),
  };
  const latestThreadTrendSample =
    threadTrendSamples[threadTrendSamples.length - 1] ?? null;
  const threadTrendPaths = {
    total: threadTrendPath(
      threadTrendSamples.map((sample) => sample.total),
      threadTrendSamples,
    ),
    runnable: threadTrendPath(
      threadTrendSamples.map((sample) => sample.runnable),
      threadTrendSamples,
    ),
    waiting: threadTrendPath(
      threadTrendSamples.map((sample) => sample.waiting),
      threadTrendSamples,
    ),
    blocked: threadTrendPath(
      threadTrendSamples.map((sample) => sample.blocked),
      threadTrendSamples,
    ),
  };

  async function load(nextOffset = latestRef.current.offset): Promise<void> {
    const storeState = useTargetsStore.getState();
    if (
      !storeState.selectedTargetId ||
      selectConnection(storeState)?.state !== "READY"
    ) {
      apply({ threads: [], total: 0 });
      return;
    }
    apply({ loading: true, errorMessage: null });
    try {
      const current = latestRef.current;
      const result = await window.tanwei.listThreads(
        storeState.selectedTargetId,
        {
          offset: nextOffset,
          limit: PAGE_SIZE,
          query: current.query.trim(),
          stackDepth: 256,
          state: current.stateFilter === "ALL" ? "" : current.stateFilter,
        },
      );
      if (!result.ok || !result.value) {
        apply({ errorMessage: result.errorMessage ?? t("无法读取线程列表") });
        return;
      }
      apply({
        offset: result.value.offset,
        total: result.value.total,
        threads: result.value.items,
      });
    } catch (error) {
      apply({
        errorMessage:
          error instanceof Error ? error.message : t("无法读取线程列表"),
      });
    } finally {
      apply({ loading: false });
    }
  }

  async function inspectThreadPools(): Promise<void> {
    const current = latestRef.current;
    const storeState = useTargetsStore.getState();
    if (
      !storeState.selectedTargetId ||
      !capabilityAvailable(selectConnection(storeState), "thread-pools") ||
      !current.threadPoolConfirmed ||
      !Number.isInteger(current.threadPoolLimit) ||
      current.threadPoolLimit < 3 ||
      current.threadPoolLimit > 20 ||
      !Number.isInteger(current.threadPoolMemberLimit) ||
      current.threadPoolMemberLimit < 10 ||
      current.threadPoolMemberLimit > 200
    ) {
      return;
    }
    apply({ loadingThreadPools: true, errorMessage: null });
    try {
      const result = await threadActions.inspectPools(
        storeState.selectedTargetId,
        {
          limit: String(current.threadPoolLimit),
          memberLimit: String(current.threadPoolMemberLimit),
          includeEvidence: "true",
          queueTaskLimit: "100",
          confirmed: "true",
        },
      );
      if (!result.ok || !result.value) {
        apply({
          errorMessage:
            result.errorMessage ?? t("无法识别线程池"),
        });
        return;
      }
      const { inspection } = result.value;
      apply({
        threadPools: inspection.pools,
        threadPoolSummary: inspection.summary,
      });
      await loadThreadPoolAliases(false);
      const previousIdentity = latestRef.current.selectedThreadPoolIdentity;
      const selectedIdentity =
        inspection.pools.find((pool) => pool.identity === previousIdentity)
          ?.identity ??
        inspection.pools.find((pool) => pool.members.length > 0)?.identity ??
        inspection.pools[0]?.identity ??
        null;
      apply({
        selectedThreadPoolIdentity: selectedIdentity,
        threadPoolAliasDraft: selectedIdentity
          ? threadPoolAliasOf(
              latestRef.current.threadPoolAliases,
              selectedIdentity,
            )
          : "",
        threadPoolAliasMessage: null,
        threadPoolConfirmed: false,
      });
    } catch (error) {
      apply({
        errorMessage:
          error instanceof Error ? error.message : t("无法识别线程池"),
      });
    } finally {
      apply({ loadingThreadPools: false });
    }
  }

  function selectThreadPool(pool: ThreadPool): void {
    const trendIdentity = latestRef.current.threadPoolTrendIdentity;
    if (trendIdentity && trendIdentity.poolIdentity !== pool.identity) {
      resetThreadPoolTrend();
    }
    const latencyIdentity = latestRef.current.threadPoolLatencyIdentity;
    if (latencyIdentity && latencyIdentity.poolIdentity !== pool.identity) {
      void stopThreadPoolLatency(true);
    }
    apply({
      selectedThreadPoolIdentity: pool.identity,
      threadPoolAliasDraft: threadPoolAliasOf(
        latestRef.current.threadPoolAliases,
        pool.identity,
      ),
      threadPoolAliasMessage: null,
    });
  }

  async function loadThreadPoolAliases(reportError: boolean): Promise<void> {
    const storeState = useTargetsStore.getState();
    if (
      !storeState.selectedTargetId ||
      selectConnection(storeState)?.state !== "READY"
    ) {
      apply({ threadPoolAliases: {} });
      return;
    }
    const targetId = storeState.selectedTargetId;
    try {
      const result = await window.tanwei.listThreadPoolAliases(targetId);
      if (targetId !== useTargetsStore.getState().selectedTargetId) {
        return;
      }
      if (!result.ok || !result.value) {
        if (reportError) {
          apply({
            errorMessage: result.errorMessage ?? t("无法读取线程池别名"),
          });
        }
        return;
      }
      apply({
        threadPoolAliases: Object.fromEntries(
          result.value
            .filter(
              (alias) =>
                alias.targetId === targetId &&
                alias.poolIdentity.length > 0 &&
                alias.alias.length > 0,
            )
            .slice(0, 1_000)
            .map((alias) => [alias.poolIdentity, alias]),
        ),
      });
    } catch (error) {
      if (reportError) {
        apply({
          errorMessage:
            error instanceof Error ? error.message : t("无法读取线程池别名"),
        });
      }
    }
  }

  async function saveThreadPoolAlias(): Promise<void> {
    const current = latestRef.current;
    const pool = findSelectedThreadPool(
      current.threadPools,
      current.selectedThreadPoolIdentity,
    );
    const targetId = useTargetsStore.getState().selectedTargetId;
    const alias = current.threadPoolAliasDraft.trim();
    if (
      !pool ||
      !targetId ||
      !isSupportedThreadPoolClass(pool.className) ||
      alias.length < 1 ||
      alias.length > 64
    ) {
      apply({ threadPoolAliasMessage: t("请输入 1–64 个字符的业务别名。") });
      return;
    }
    apply({ savingThreadPoolAlias: true, threadPoolAliasMessage: null });
    try {
      const result = await window.tanwei.upsertThreadPoolAlias({
        targetId,
        poolIdentity: pool.identity,
        poolClassName: pool.className,
        alias,
      });
      if (!result.ok || !result.value) {
        apply({
          errorMessage: result.errorMessage ?? t("无法保存线程池别名"),
        });
        return;
      }
      apply({
        threadPoolAliases: {
          ...latestRef.current.threadPoolAliases,
          [pool.identity]: result.value,
        },
        threadPoolAliasDraft: result.value.alias,
        threadPoolAliasMessage: t("本地业务别名已保存。"),
      });
    } catch (error) {
      apply({
        errorMessage:
          error instanceof Error ? error.message : t("无法保存线程池别名"),
      });
    } finally {
      apply({ savingThreadPoolAlias: false });
    }
  }

  async function clearThreadPoolAlias(): Promise<void> {
    const current = latestRef.current;
    const pool = findSelectedThreadPool(
      current.threadPools,
      current.selectedThreadPoolIdentity,
    );
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!pool || !targetId || !isSupportedThreadPoolClass(pool.className)) {
      return;
    }
    apply({ savingThreadPoolAlias: true, threadPoolAliasMessage: null });
    try {
      const result = await window.tanwei.deleteThreadPoolAlias({
        targetId,
        poolIdentity: pool.identity,
        poolClassName: pool.className,
      });
      if (!result.ok) {
        apply({
          errorMessage: result.errorMessage ?? t("无法清除线程池别名"),
        });
        return;
      }
      const aliases = { ...latestRef.current.threadPoolAliases };
      delete aliases[pool.identity];
      apply({
        threadPoolAliases: aliases,
        threadPoolAliasDraft: "",
        threadPoolAliasMessage: t("本地业务别名已清除。"),
      });
    } catch (error) {
      apply({
        errorMessage:
          error instanceof Error ? error.message : t("无法清除线程池别名"),
      });
    } finally {
      apply({ savingThreadPoolAlias: false });
    }
  }

  async function createThreadDump(): Promise<void> {
    const current = latestRef.current;
    const storeState = useTargetsStore.getState();
    if (
      !storeState.selectedTargetId ||
      !capabilityAvailable(selectConnection(storeState), "thread-dump") ||
      !Number.isInteger(current.threadDumpStackDepth) ||
      current.threadDumpStackDepth < 1 ||
      current.threadDumpStackDepth > 512
    ) {
      return;
    }
    apply({ creatingThreadDump: true, errorMessage: null });
    try {
      const targetId = storeState.selectedTargetId;
      const result = await threadActions.createDump(targetId, {
          maximumThreads: "10000",
          maximumStackDepth: String(current.threadDumpStackDepth),
          includeLocks: String(current.threadDumpIncludeLocks),
      });
      if (!result.ok || !result.value) {
        apply({
          errorMessage: result.errorMessage ?? t("无法生成线程转储"),
        });
        return;
      }
      const collected = await window.tanwei.collectAgentArtifact({
        targetId,
        token: result.value.token,
        type: "THREAD_DUMP",
        expectedSize: result.value.expectedSize,
      });
      if (!collected.ok || !collected.value) {
        apply({
          errorMessage: collected.errorMessage ?? t("无法保存线程转储"),
        });
        return;
      }
      apply({ threadDumpArtifact: collected.value });
    } catch (error) {
      apply({
        errorMessage:
          error instanceof Error ? error.message : t("无法生成线程转储"),
      });
    } finally {
      apply({ creatingThreadDump: false });
    }
  }

  function stopThreadPoolLatencyPolling(): void {
    if (threadPoolLatencyTimerRef.current !== null) {
      clearInterval(threadPoolLatencyTimerRef.current);
      threadPoolLatencyTimerRef.current = null;
    }
  }

  function clearThreadPoolLatencyState(): void {
    stopThreadPoolLatencyPolling();
    apply({
      threadPoolLatencyIdentity: null,
      threadPoolLatencySnapshot: null,
      threadPoolLatencyConfirmed: false,
      threadPoolLatencyErrorMessage: null,
    });
  }

  async function collectThreadPoolLatencySnapshot(): Promise<void> {
    const current = latestRef.current;
    const identity = current.threadPoolLatencyIdentity;
    const storeState = useTargetsStore.getState();
    if (
      !identity ||
      current.collectingThreadPoolLatency ||
      storeState.selectedTargetId !== identity.targetId ||
      selectConnection(storeState)?.state !== "READY"
    ) {
      if (selectConnection(storeState)?.state !== "READY") {
        stopThreadPoolLatencyPolling();
      }
      return;
    }
    apply({ collectingThreadPoolLatency: true });
    try {
      const result = await threadActions.latencySnapshot(
        identity.targetId,
        identity.taskId,
      );
      if (!result.ok || !result.value) {
        throw new Error(
          result.errorMessage ?? t("无法读取线程池时长归因"),
        );
      }
      if (identity !== latestRef.current.threadPoolLatencyIdentity) {
        return;
      }
      const snapshot = result.value;
      if (
        snapshot.taskId !== identity.taskId ||
        snapshot.poolIdentity !== identity.poolIdentity ||
        snapshot.poolClassName !== identity.poolClassName
      ) {
        throw new Error(t("线程池时长归因身份发生变化。"));
      }
      apply({
        threadPoolLatencySnapshot: snapshot,
        threadPoolLatencyErrorMessage: snapshot.error || null,
      });
      if (snapshot.state !== "RUNNING") {
        stopThreadPoolLatencyPolling();
      }
    } catch (error) {
      apply({
        threadPoolLatencyErrorMessage:
          error instanceof Error ? error.message : t("无法读取线程池时长归因"),
      });
      stopThreadPoolLatencyPolling();
    } finally {
      apply({ collectingThreadPoolLatency: false });
    }
  }

  async function startThreadPoolLatency(): Promise<void> {
    const current = latestRef.current;
    const pool = findSelectedThreadPool(
      current.threadPools,
      current.selectedThreadPoolIdentity,
    );
    const storeState = useTargetsStore.getState();
    const targetId = storeState.selectedTargetId;
    const supportsLatency =
      pool !== null &&
      isSupportedThreadPoolClass(pool.className) &&
      capabilityAvailable(selectConnection(storeState), "thread-pool-latency");
    const latencyMode =
      pool && isSupportedThreadPoolClass(pool.className)
        ? threadPoolLatencyMode(pool.className)
        : "RUN_ONLY";
    if (
      !pool ||
      !targetId ||
      !isSupportedThreadPoolClass(pool.className) ||
      !supportsLatency ||
      !current.threadPoolLatencyConfirmed ||
      !Number.isInteger(current.threadPoolLatencyDurationMillis) ||
      current.threadPoolLatencyDurationMillis < 10_000 ||
      current.threadPoolLatencyDurationMillis > 300_000 ||
      (latencyMode !== "RUN_ONLY" &&
        (!Number.isInteger(current.threadPoolLatencyMaximumTrackedTasks) ||
          current.threadPoolLatencyMaximumTrackedTasks < 128 ||
          current.threadPoolLatencyMaximumTrackedTasks > 4_096))
    ) {
      return;
    }
    const poolClassName = pool.className;
    apply({
      startingThreadPoolLatency: true,
      threadPoolLatencyErrorMessage: null,
      threadPoolLatencySnapshot: null,
    });
    try {
      const result = await threadActions.startLatency(targetId, {
          poolIdentity: pool.identity,
          poolClassName,
          durationMillis: String(current.threadPoolLatencyDurationMillis),
          maximumTrackedTasks: String(
            latencyMode !== "RUN_ONLY"
              ? current.threadPoolLatencyMaximumTrackedTasks
              : 128,
          ),
          confirmed: "true",
      });
      const taskId = result.value?.taskId ?? "";
      if (
        !result.ok ||
        !result.value ||
        result.value.poolIdentity !== pool.identity ||
        result.value.poolClassName !== poolClassName ||
        result.value.attributionMode !== latencyMode
      ) {
        throw new Error(
          result.errorMessage ?? t("无法启动线程池时长归因"),
        );
      }
      apply({
        threadPoolLatencyIdentity: {
          targetId,
          taskId,
          poolIdentity: pool.identity,
          poolClassName,
        },
        threadPoolLatencyConfirmed: false,
      });
      await collectThreadPoolLatencySnapshot();
      if (
        latestRef.current.threadPoolLatencyIdentity?.taskId === taskId &&
        threadPoolLatencyRunningOf(
          latestRef.current.threadPoolLatencyIdentity,
          latestRef.current.threadPoolLatencySnapshot,
        ) &&
        threadPoolLatencyTimerRef.current === null
      ) {
        threadPoolLatencyTimerRef.current = setInterval(() => {
          void collectThreadPoolLatencySnapshot();
        }, 1_000);
      }
    } catch (error) {
      apply({
        threadPoolLatencyErrorMessage:
          error instanceof Error ? error.message : t("无法启动线程池时长归因"),
      });
    } finally {
      apply({ startingThreadPoolLatency: false });
    }
  }

  async function stopThreadPoolLatency(silent = false): Promise<void> {
    const identity = latestRef.current.threadPoolLatencyIdentity;
    if (!identity || latestRef.current.stoppingThreadPoolLatency) {
      if (silent) {
        clearThreadPoolLatencyState();
      }
      return;
    }
    stopThreadPoolLatencyPolling();
    apply({ stoppingThreadPoolLatency: true });
    try {
      const result = await threadActions.stopLatency(
        identity.targetId,
        identity.taskId,
      );
      if (!silent) {
        if (!result.ok || !result.value) {
          throw new Error(
            result.errorMessage ?? t("无法停止线程池时长归因"),
          );
        }
        apply({
          threadPoolLatencySnapshot: result.value,
        });
      }
    } catch (error) {
      if (!silent) {
        apply({
          threadPoolLatencyErrorMessage:
            error instanceof Error
              ? error.message
              : t("无法停止线程池时长归因"),
        });
      }
    } finally {
      apply({ stoppingThreadPoolLatency: false });
      if (silent) {
        clearThreadPoolLatencyState();
      }
    }
  }

  function stopThreadPoolTrendSampling(): void {
    if (threadPoolTrendTimerRef.current !== null) {
      clearInterval(threadPoolTrendTimerRef.current);
      threadPoolTrendTimerRef.current = null;
    }
    apply({ threadPoolTrendSampling: false });
  }

  function resetThreadPoolTrend(): void {
    stopThreadPoolTrendSampling();
    threadPoolTrendBuffer.clear();
    apply({
      threadPoolTrendSamples: [],
      threadPoolTrendIdentity: null,
      threadPoolTrendConfirmed: false,
      threadPoolTrendErrorMessage: null,
      threadPoolTrendArtifact: null,
    });
  }

  async function collectThreadPoolTrendSample(): Promise<void> {
    const current = latestRef.current;
    const identity = current.threadPoolTrendIdentity;
    const storeState = useTargetsStore.getState();
    if (
      current.collectingThreadPoolTrend ||
      !identity ||
      storeState.selectedTargetId !== identity.targetId ||
      selectConnection(storeState)?.state !== "READY"
    ) {
      if (selectConnection(storeState)?.state !== "READY") {
        stopThreadPoolTrendSampling();
      }
      return;
    }
    apply({
      collectingThreadPoolTrend: true,
      threadPoolTrendErrorMessage: null,
    });
    try {
      const result = await threadActions.inspectPools(identity.targetId, {
          limit: "20",
          memberLimit: "10",
          includeEvidence: "false",
          queueTaskLimit: "10",
          confirmed: "true",
      });
      if (!result.ok || !result.value) {
        throw new Error(
          result.errorMessage ?? t("无法采集线程池趋势"),
        );
      }
      if (
        identity !== latestRef.current.threadPoolTrendIdentity ||
        identity.targetId !== useTargetsStore.getState().selectedTargetId
      ) {
        return;
      }
      const { inspection } = result.value;
      const pool = inspection.pools.find(
        (candidate) =>
          candidate.identity === identity.poolIdentity &&
          candidate.className === identity.poolClassName,
      );
      if (!pool) {
        throw new Error(t("精确线程池已消失或超出扫描上限，趋势采样已停止。"));
      }
      const capturedAt = Date.parse(result.value.completedAt);
      const sample = buildThreadPoolTrendSample(pool, capturedAt);
      const previous = latestRef.current.threadPoolTrendSamples.at(-1);
      if (!sample || (previous && sample.capturedAt <= previous.capturedAt)) {
        throw new Error(t("线程池趋势样本时间或指标无效。"));
      }
      threadPoolTrendBuffer.append(sample);
      apply({
        threadPools: inspection.pools,
        threadPoolSummary: inspection.summary,
        threadPoolTrendSamples: threadPoolTrendBuffer.toArray(),
      });
    } catch (error) {
      apply({
        threadPoolTrendErrorMessage:
          error instanceof Error ? error.message : t("无法采集线程池趋势"),
      });
      stopThreadPoolTrendSampling();
    } finally {
      apply({ collectingThreadPoolTrend: false });
    }
  }

  async function startThreadPoolTrendSampling(): Promise<void> {
    const current = latestRef.current;
    const pool = findSelectedThreadPool(
      current.threadPools,
      current.selectedThreadPoolIdentity,
    );
    const storeState = useTargetsStore.getState();
    const targetId = storeState.selectedTargetId;
    const kind = pool ? threadPoolKind(pool.kind) : null;
    if (
      current.threadPoolTrendSampling ||
      !current.threadPoolTrendConfirmed ||
      !pool ||
      !targetId ||
      !kind ||
      !isSupportedThreadPoolClass(pool.className)
    ) {
      return;
    }
    threadPoolTrendBuffer.clear();
    apply({
      threadPoolTrendSamples: [],
      threadPoolTrendIdentity: null,
      threadPoolTrendArtifact: null,
      threadPoolTrendConfirmed: false,
      threadPoolTrendSampling: true,
      threadPoolTrendErrorMessage: null,
    });
    try {
      const snapshot = await window.tanwei.getSnapshot(targetId);
      if (
        !snapshot.ok ||
        !snapshot.value ||
        !Number.isSafeInteger(snapshot.value.jvmStartTimeEpochMillis) ||
        snapshot.value.jvmStartTimeEpochMillis <= 0
      ) {
        throw new Error(
          snapshot.errorMessage ?? t("无法核对线程池所属JVM周期"),
        );
      }
      if (
        !latestRef.current.threadPoolTrendSampling ||
        targetId !== useTargetsStore.getState().selectedTargetId ||
        pool.identity !==
          findSelectedThreadPool(
            latestRef.current.threadPools,
            latestRef.current.selectedThreadPoolIdentity,
          )?.identity
      ) {
        return;
      }
      apply({
        threadPoolTrendIdentity: {
          targetId,
          jvmStartTimeEpochMillis: snapshot.value.jvmStartTimeEpochMillis,
          poolIdentity: pool.identity,
          poolClassName: pool.className,
          poolKind: kind,
          alias:
            threadPoolAliasOf(
              latestRef.current.threadPoolAliases,
              pool.identity,
            ) || null,
        },
      });
      await collectThreadPoolTrendSample();
      if (
        latestRef.current.threadPoolTrendSampling &&
        threadPoolTrendTimerRef.current === null
      ) {
        threadPoolTrendTimerRef.current = setInterval(() => {
          void collectThreadPoolTrendSample();
        }, latestRef.current.threadPoolTrendSamplingIntervalMillis);
      }
    } catch (error) {
      apply({
        threadPoolTrendErrorMessage:
          error instanceof Error ? error.message : t("无法启动线程池趋势"),
      });
      stopThreadPoolTrendSampling();
    }
  }

  async function saveThreadPoolTrendArtifact(): Promise<void> {
    const current = latestRef.current;
    const identity = current.threadPoolTrendIdentity;
    if (
      current.threadPoolTrendSampling ||
      !identity ||
      identity.targetId !== useTargetsStore.getState().selectedTargetId ||
      current.threadPoolTrendSamples.length < 2
    ) {
      return;
    }
    apply({
      savingThreadPoolTrend: true,
      threadPoolTrendErrorMessage: null,
    });
    try {
      const result = await window.tanwei.createThreadPoolTrendArtifact({
        recording: {
          ...identity,
          samplingIntervalMillis: current.threadPoolTrendSamplingIntervalMillis,
          samples: current.threadPoolTrendSamples,
        },
      });
      if (!result.ok || !result.value) {
        throw new Error(result.errorMessage ?? t("无法保存线程池趋势制品"));
      }
      apply({ threadPoolTrendArtifact: result.value });
    } catch (error) {
      apply({
        threadPoolTrendErrorMessage:
          error instanceof Error ? error.message : t("无法保存线程池趋势制品"),
      });
    } finally {
      apply({ savingThreadPoolTrend: false });
    }
  }

  async function locateThread(
    threadId: number,
    name: string,
    missingMessage: string,
  ): Promise<void> {
    apply({ errorMessage: null, query: name, stateFilter: "ALL" });
    await load(0);
    await nextFrame();
    const row = threadListRef.current?.querySelector<HTMLElement>(
      `[data-thread-id="${threadId}"]`,
    );
    if (!row) {
      apply({ errorMessage: missingMessage });
      return;
    }
    const trigger = row.querySelector<HTMLElement>(
      "[data-slot='collapsible-trigger']",
    );
    if (row.dataset.state !== "open") {
      trigger?.click();
    }
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    trigger?.focus();
  }

  async function locateHotThread(thread: ThreadHotCpuRate): Promise<void> {
    await locateThread(
      thread.id,
      thread.name,
      t("热点线程已退出或不在当前结果页。"),
    );
  }

  async function locateThreadPoolMember(
    member: ThreadPoolMember,
  ): Promise<void> {
    await locateThread(
      member.threadId,
      member.name,
      t("成员线程已退出或不在当前结果页，请重新检查线程池。"),
    );
  }

  function stopThreadTrendSampling(): void {
    if (threadTrendTimerRef.current !== null) {
      clearInterval(threadTrendTimerRef.current);
      threadTrendTimerRef.current = null;
    }
    apply({ threadTrendSampling: false });
  }

  function clearThreadTrendHistory(): void {
    threadTrendBuffer.clear();
    previousThreadTrendSnapshotRef.current = null;
    apply({ threadTrendSamples: [], threadTrendErrorMessage: null });
  }

  function resetThreadTrend(): void {
    stopThreadTrendSampling();
    clearThreadTrendHistory();
  }

  async function captureSnapshot(): Promise<ThreadSnapshot | null> {
    const storeState = useTargetsStore.getState();
    if (!storeState.selectedTargetId) {
      return null;
    }
    const targetId = storeState.selectedTargetId;
    const result = await window.tanwei.listThreads(targetId, {
      offset: 0,
      limit: 1_000,
      query: "",
      stackDepth: 1,
      state: "",
    });
    if (!result.ok || !result.value) {
      throw new Error(result.errorMessage ?? t("无法采集线程快照"));
    }
    return {
      targetId,
      capturedAt: Date.now(),
      total: result.value.total,
      truncated: result.value.total > result.value.items.length,
      threads: result.value.items.map((thread) => ({
        ...thread,
        stack: [...thread.stack],
      })),
    };
  }

  async function collectThreadTrendSample(): Promise<void> {
    const current = latestRef.current;
    const storeState = useTargetsStore.getState();
    if (
      current.collectingThreadTrend ||
      !storeState.selectedTargetId ||
      selectConnection(storeState)?.state !== "READY"
    ) {
      if (selectConnection(storeState)?.state !== "READY") {
        stopThreadTrendSampling();
      }
      return;
    }
    apply({ collectingThreadTrend: true, threadTrendErrorMessage: null });
    try {
      const snapshot = await captureSnapshot();
      if (
        !snapshot ||
        snapshot.targetId !== useTargetsStore.getState().selectedTargetId
      ) {
        return;
      }
      const point = buildThreadTrendPoint(
        previousThreadTrendSnapshotRef.current,
        snapshot,
      );
      previousThreadTrendSnapshotRef.current = snapshot;
      threadTrendBuffer.append(point);
      apply({ threadTrendSamples: threadTrendBuffer.toArray() });
    } catch (error) {
      apply({
        threadTrendErrorMessage:
          error instanceof Error ? error.message : t("无法采集线程趋势"),
      });
    } finally {
      apply({ collectingThreadTrend: false });
    }
  }

  async function startThreadTrendSampling(): Promise<void> {
    const storeState = useTargetsStore.getState();
    if (
      latestRef.current.threadTrendSampling ||
      !storeState.selectedTargetId ||
      selectConnection(storeState)?.state !== "READY"
    ) {
      return;
    }
    apply({ threadTrendSampling: true });
    if (previousThreadTrendSnapshotRef.current === null) {
      await collectThreadTrendSample();
    }
    if (
      !latestRef.current.threadTrendSampling ||
      threadTrendTimerRef.current !== null
    ) {
      return;
    }
    threadTrendTimerRef.current = setInterval(() => {
      void collectThreadTrendSample();
    }, latestRef.current.threadTrendSamplingIntervalMillis);
  }

  async function pinBaseline(): Promise<void> {
    apply({ capturingBaseline: true, errorMessage: null });
    try {
      const snapshot = await captureSnapshot();
      if (snapshot) {
        apply({ baselineSnapshot: snapshot, snapshotDiff: null });
      }
    } catch (error) {
      apply({
        errorMessage:
          error instanceof Error ? error.message : t("无法采集线程快照"),
      });
    } finally {
      apply({ capturingBaseline: false });
    }
  }

  async function compareWithCurrent(): Promise<void> {
    const baseline = latestRef.current.baselineSnapshot;
    if (
      !baseline ||
      baseline.targetId !== useTargetsStore.getState().selectedTargetId
    ) {
      return;
    }
    apply({ comparingSnapshots: true, errorMessage: null });
    try {
      const current = await captureSnapshot();
      if (current) {
        apply({
          snapshotDiff: buildThreadSnapshotDiff(baseline, current, t),
        });
      }
    } catch (error) {
      apply({
        errorMessage:
          error instanceof Error ? error.message : t("无法对比线程快照"),
      });
    } finally {
      apply({ comparingSnapshots: false });
    }
  }

  async function inspectLocks(): Promise<void> {
    const current = latestRef.current;
    const storeState = useTargetsStore.getState();
    if (
      !storeState.selectedTargetId ||
      !capabilityAvailable(selectConnection(storeState), "thread-locks") ||
      !Number.isInteger(current.maximumLockNodes) ||
      current.maximumLockNodes < 1 ||
      current.maximumLockNodes > 500
    ) {
      return;
    }
    apply({ loadingLocks: true, errorMessage: null });
    try {
      const result = await threadActions.inspectLocks(
        storeState.selectedTargetId,
        {
          includeUncontended: String(current.includeUncontended),
          maximumNodes: String(current.maximumLockNodes),
        },
      );
      if (!result.ok || !result.value) {
        apply({
          errorMessage: result.errorMessage ?? t("无法分析线程锁关系"),
        });
        return;
      }
      const { nodes, summary } = result.value;
      apply({
        lockNodes: nodes,
        lockRenderLimit: 100,
        lockSummary: summary,
      });
      if (
        latestRef.current.selectedLockThreadId === null ||
        !nodes.some(
          (node) => node.id === latestRef.current.selectedLockThreadId,
        )
      ) {
        apply({ selectedLockThreadId: nodes[0]?.id ?? null });
      }
    } catch (error) {
      apply({
        errorMessage:
          error instanceof Error ? error.message : t("无法分析线程锁关系"),
      });
    } finally {
      apply({ loadingLocks: false });
    }
  }

  function selectLockOwner(ownerId: number | null): void {
    if (
      ownerId !== null &&
      latestRef.current.lockNodes.some((node) => node.id === ownerId)
    ) {
      apply({ selectedLockThreadId: ownerId });
    }
  }

  async function previewThreadInterrupt(
    thread: ThreadDescriptor,
  ): Promise<void> {
    const storeState = useTargetsStore.getState();
    if (
      !storeState.selectedTargetId ||
      !capabilityAvailable(selectConnection(storeState), "thread-control")
    ) {
      return;
    }
    apply({
      previewingThreadId: thread.id,
      interruptPreview: null,
      interruptResult: null,
      interruptConfirmed: false,
      interruptConfirmedSecondary: false,
      errorMessage: null,
    });
    try {
      const result = await threadActions.previewInterrupt(
        storeState.selectedTargetId,
        thread.id,
      );
      if (!result.ok || !result.value) {
        apply({
          errorMessage: result.errorMessage ?? t("无法生成线程中断预览"),
        });
        return;
      }
      apply({ interruptPreview: result.value });
    } catch (error) {
      apply({
        errorMessage:
          error instanceof Error ? error.message : t("无法生成线程中断预览"),
      });
    } finally {
      apply({ previewingThreadId: null });
    }
  }

  async function executeThreadInterrupt(): Promise<void> {
    const current = latestRef.current;
    const storeState = useTargetsStore.getState();
    if (
      !storeState.selectedTargetId ||
      !current.interruptPreview ||
      !current.interruptConfirmed ||
      !current.interruptConfirmedSecondary
    ) {
      return;
    }
    apply({ interrupting: true, errorMessage: null });
    try {
      const result = await threadActions.interrupt(
        storeState.selectedTargetId,
        current.interruptPreview.threadId,
        current.interruptPreview.name,
      );
      apply({ interruptResult: result.value });
      if (!result.ok || !result.value) {
        apply({
          errorMessage: result.errorMessage ?? t("线程中断失败"),
        });
        return;
      }
      apply({
        interruptPreview: null,
        interruptConfirmed: false,
        interruptConfirmedSecondary: false,
      });
      await load(latestRef.current.offset);
    } catch (error) {
      apply({
        errorMessage:
          error instanceof Error ? error.message : t("线程中断失败"),
      });
    } finally {
      apply({ interrupting: false });
    }
  }

  const previousTargetIdRef = useRef(selectedTargetId);
  useEffect(() => {
    if (previousTargetIdRef.current === selectedTargetId) {
      return;
    }
    previousTargetIdRef.current = selectedTargetId;
    void stopThreadPoolLatency(true);
    resetThreadTrend();
    resetThreadPoolTrend();
    apply({
      threadPools: [],
      threadPoolSummary: null,
      selectedThreadPoolIdentity: null,
      threadPoolAliases: {},
      threadPoolAliasDraft: "",
      threadPoolAliasMessage: null,
      threadDumpArtifact: null,
      baselineSnapshot: null,
      snapshotDiff: null,
    });
    void loadThreadPoolAliases(false);
  }, [selectedTargetId, apply]);

  const previousConnectionStateRef = useRef(connectionState);
  useEffect(() => {
    if (previousConnectionStateRef.current === connectionState) {
      return;
    }
    previousConnectionStateRef.current = connectionState;
    if (connectionState !== "READY") {
      void stopThreadPoolLatency(true);
      resetThreadTrend();
      resetThreadPoolTrend();
      apply({
        threadPools: [],
        threadPoolSummary: null,
        selectedThreadPoolIdentity: null,
        threadPoolAliases: {},
        threadPoolAliasDraft: "",
        threadPoolAliasMessage: null,
      });
      return;
    }
    void loadThreadPoolAliases(false);
  }, [connectionState, apply]);

  useEffect(() => {
    void load(0);
    void loadThreadPoolAliases(false);
    return () => {
      void stopThreadPoolLatency(true);
      stopThreadTrendSampling();
      stopThreadPoolTrendSampling();
    };
  }, []);

  return (
    <section className="page threads-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">THREAD DIAGNOSTICS</p>
          <h1>{t("线程与锁。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "Agent 端按名称过滤并分页，默认按累计 CPU 时间降序。完整堆栈只保留当前页。",
          )}
        </p>
      </header>

      {connectionState !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">{t("连接目标后读取线程。")}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate("/targets")}
          >
            {t("选择目标")}
          </Button>
        </Empty>
      ) : (
        <>
          <div className="thread-toolbar">
            <Label>
              <span>{t("线程名称")}</span>
              <Input
                value={query}
                type="search"
                autoComplete="off"
                onChange={(event) => apply({ query: event.target.value })}
                onKeyUp={(event) => {
                  if (event.key === "Enter") {
                    void load(0);
                  }
                }}
              />
            </Label>
            <Label>
              <span>{t("状态")}</span>
              <SelectControl
                value={stateFilter}
                onValueChange={(value) => {
                  apply({ stateFilter: value as ThreadState });
                  void load(0);
                }}
              >
                {states.map((state) => (
                  <SelectControlItem key={state} value={state}>
                    {state === "ALL" ? t("全部状态") : state}
                  </SelectControlItem>
                ))}
              </SelectControl>
            </Label>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void load(0)}
              aria-busy={Boolean(loading)}
              disabled={Boolean(loading)}
            >
              {Boolean(loading) && <Spinner />}
              {t("查询")}
            </Button>
          </div>

          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          <section className="thread-dump-bar">
            <header>
              <div>
                <p className="eyebrow">THREAD DUMP ARTIFACT / R1</p>
                <h2>{t("把线程现场固定成可校验证据。")}</h2>
                <p>
                  {t(
                    "生成单次 UTF-8 转储，最多 10000 个线程、每线程 512 层和 32 MiB；完成后进入制品与案例链路。",
                  )}
                </p>
              </div>
              <div className="thread-dump-controls">
                <Label>
                  <span>{t("堆栈深度")}</span>
                  <Input
                    value={threadDumpStackDepth}
                    type="number"
                    min="1"
                    max="512"
                    onChange={(event) =>
                      apply({
                        threadDumpStackDepth: Number(event.target.value),
                      })
                    }
                  />
                </Label>
                <Label className="thread-dump-locks">
                  <Checkbox
                    checked={threadDumpIncludeLocks}
                    onCheckedChange={(event) =>
                      apply({ threadDumpIncludeLocks: event === true })
                    }
                  />
                  <span>{t("包含 Monitor 与 Synchronizer")}</span>
                </Label>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    Boolean(!threadDumpAvailable) || Boolean(creatingThreadDump)
                  }
                  onClick={() => void createThreadDump()}
                  aria-busy={Boolean(creatingThreadDump)}
                >
                  {Boolean(creatingThreadDump) && <Spinner />}
                  {t("生成线程转储")}
                </Button>
              </div>
            </header>
            {threadDumpArtifact && (
              <div className="thread-dump-outcome">
                <span>
                  <strong>{threadDumpArtifact.name}</strong>
                  <small>
                    {t("已校验并保存 · {size} 字节", {
                      size: threadDumpArtifact.size.toLocaleString(),
                    })}
                  </small>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      pathname: "/artifacts",
                      search: `?inspect=${encodeURIComponent(threadDumpArtifact.id)}`,
                    })
                  }
                >
                  {t("在线程转储检查器中打开")}
                </Button>
              </div>
            )}
          </section>

          <section className="thread-pool-workbench">
            <header>
              <div>
                <p className="eyebrow">EXECUTOR INSPECTOR / R2</p>
                <h2>{t("找到真实线程池，而不是猜线程名。")}</h2>
              </div>
              <p>
                {t(
                  "识别 JDK 执行器的精确实例与真实 Worker 成员，并从成员直接定位线程堆栈。",
                )}
              </p>
            </header>
            <div className="thread-pool-controls">
              <Label>
                <span>{t("线程池上限")}</span>
                <Input
                  value={threadPoolLimit}
                  type="number"
                  min="3"
                  max="20"
                  onChange={(event) =>
                    apply({ threadPoolLimit: Number(event.target.value) })
                  }
                />
              </Label>
              <Label>
                <span>{t("成员返回上限")}</span>
                <SelectControl
                  value={threadPoolMemberLimit}
                  onValueChange={(value) =>
                    apply({ threadPoolMemberLimit: Number(value) })
                  }
                >
                  <SelectControlItem value={20}>20</SelectControlItem>
                  <SelectControlItem value={50}>50</SelectControlItem>
                  <SelectControlItem value={100}>100</SelectControlItem>
                  <SelectControlItem value={200}>200</SelectControlItem>
                </SelectControl>
              </Label>
              <Label className="thread-pool-confirmation">
                <Checkbox
                  checked={threadPoolConfirmed}
                  onCheckedChange={(event) =>
                    apply({ threadPoolConfirmed: event === true })
                  }
                />
                <span>{t("我确认执行一次有界的 JVMTI 线程池实例扫描。")}</span>
              </Label>
              <Button
                type="button"
                variant="outline"
                disabled={
                  Boolean(!threadPoolsAvailable || !threadPoolConfirmed) ||
                  Boolean(loadingThreadPools)
                }
                onClick={() => void inspectThreadPools()}
                aria-busy={Boolean(loadingThreadPools)}
              >
                {Boolean(loadingThreadPools) && <Spinner />}
                {t("检查线程池")}
              </Button>
            </div>

            {threadPoolSummary && (
              <>
                <div className="thread-pool-summary">
                  <p>
                    <span>{t("已识别")}</span>
                    <strong>{threadPools.length}</strong>
                  </p>
                  <p>
                    <span>{t("执行器类型")}</span>
                    <strong>{threadPoolSummary.queriedTypes}</strong>
                  </p>
                  <p>
                    <span>{t("精确成员")}</span>
                    <strong>
                      {threadPoolSummary.returnedMembers} /{" "}
                      {threadPoolSummary.discoveredMembers}
                    </strong>
                  </p>
                  <p>
                    <span>{t("线程枚举")}</span>
                    <strong>{threadPoolSummary.scannedThreads}</strong>
                  </p>
                  <StatusPill
                    state={
                      threadPoolSummary.truncated ||
                      threadPoolSummary.threadEnumerationTruncated
                        ? "idle"
                        : "ready"
                    }
                    label={
                      threadPoolSummary.truncated ||
                      threadPoolSummary.threadEnumerationTruncated
                        ? t("结果已到上限")
                        : t("扫描完整")
                    }
                  />
                </div>

                {threadPools.length ? (
                  <>
                    <div className="thread-pool-grid">
                      {threadPools.map((pool) => (
                        <article
                          key={pool.identity}
                          className={cn(
                            "thread-pool-card",
                            pool.identity === selectedThreadPoolIdentity &&
                              "thread-pool-card--selected",
                          )}
                        >
                          <header>
                            <div>
                              <p className="eyebrow">
                                {poolKindLabel(pool.kind)}
                              </p>
                              <h3>
                                {threadPoolAliasOf(
                                  threadPoolAliases,
                                  pool.identity,
                                ) || pool.identity}
                              </h3>
                              {threadPoolAliasOf(
                                threadPoolAliases,
                                pool.identity,
                              ) && (
                                <small className="thread-pool-exact-identity">
                                  {pool.identity}
                                </small>
                              )}
                            </div>
                            <StatusPill
                              state={
                                pool.state === "RUNNING" ? "ready" : "idle"
                              }
                              label={pool.state}
                            />
                          </header>
                          <dl>
                            <div>
                              <dt>
                                {pool.kind === "FORK_JOIN"
                                  ? t("并行度")
                                  : t("核心线程")}
                              </dt>
                              <dd>{pool.configuredSize ?? "—"}</dd>
                            </div>
                            <div>
                              <dt>{t("当前线程")}</dt>
                              <dd>{pool.poolSize ?? "—"}</dd>
                            </div>
                            <div>
                              <dt>
                                {pool.kind === "FORK_JOIN"
                                  ? t("活跃线程")
                                  : t("执行任务")}
                              </dt>
                              <dd>{pool.activeCount ?? "—"}</dd>
                            </div>
                            <div>
                              <dt>
                                {pool.kind === "FORK_JOIN"
                                  ? t("运行线程")
                                  : t("最大线程")}
                              </dt>
                              <dd>
                                {pool.kind === "FORK_JOIN"
                                  ? (pool.runningCount ?? "—")
                                  : (pool.maximumSize ?? "—")}
                              </dd>
                            </div>
                            <div>
                              <dt>{t("队列任务")}</dt>
                              <dd>{pool.queuedTasks ?? "—"}</dd>
                            </div>
                            <div>
                              <dt>
                                {pool.kind === "FORK_JOIN"
                                  ? t("窃取任务")
                                  : t("已完成")}
                              </dt>
                              <dd>
                                {pool.kind === "FORK_JOIN"
                                  ? (pool.stealCount ?? "—")
                                  : (pool.completedTasks ?? "—")}
                              </dd>
                            </div>
                          </dl>
                          <div className="thread-pool-card__evidence">
                            <span>
                              {t("精确成员")}
                              <strong>
                                {pool.members.length} / {pool.memberCount}
                              </strong>
                            </span>
                            <span title={pool.threadFactoryType}>
                              {t("线程工厂")}
                              <strong>
                                {pool.threadFactoryType
                                  ? shortClassName(pool.threadFactoryType)
                                  : "—"}
                              </strong>
                            </span>
                          </div>
                          <footer>
                            <span className="thread-pool-card__footer-copy">
                              <span>
                                {pool.queueType
                                  ? shortClassName(pool.queueType)
                                  : pool.className}
                              </span>
                              {pool.remainingQueueCapacity !== null ? (
                                <small>
                                  {t("剩余容量 {count}", {
                                    count: pool.remainingQueueCapacity,
                                  })}
                                </small>
                              ) : (
                                pool.queuedSubmissions !== null && (
                                  <small>
                                    {t("外部提交 {count}", {
                                      count: pool.queuedSubmissions,
                                    })}
                                  </small>
                                )
                              )}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={!pool.membershipAvailable}
                              onClick={() => selectThreadPool(pool)}
                            >
                              {t("查看成员")}
                            </Button>
                          </footer>
                        </article>
                      ))}
                    </div>

                    {selectedThreadPool && (
                      <section
                        className="thread-pool-member-inspector"
                        aria-labelledby="thread-pool-member-title"
                      >
                        <header>
                          <div>
                            <p className="eyebrow">
                              EXACT MEMBER ASSOCIATION / IDENTITY
                            </p>
                            <h3 id="thread-pool-member-title">
                              {threadPoolAliasOf(
                                threadPoolAliases,
                                selectedThreadPool.identity,
                              ) || selectedThreadPool.identity}
                            </h3>
                            {threadPoolAliasOf(
                              threadPoolAliases,
                              selectedThreadPool.identity,
                            ) && (
                              <small className="thread-pool-exact-identity">
                                {selectedThreadPool.identity}
                              </small>
                            )}
                          </div>
                          <StatusPill
                            state={
                              selectedThreadPool.membershipAvailable
                                ? "ready"
                                : "idle"
                            }
                            label={
                              selectedThreadPool.membershipAvailable
                                ? t("{count} 个精确成员", {
                                    count: selectedThreadPool.memberCount,
                                  })
                                : t("成员访问不可用")
                            }
                          />
                        </header>

                        <div className="thread-pool-member-facts">
                          <p>
                            <span>{t("线程工厂类型")}</span>
                            <strong>
                              {selectedThreadPool.threadFactoryType || "—"}
                            </strong>
                          </p>
                          <p>
                            <span>{t("线程组")}</span>
                            <strong>
                              {selectedThreadPoolGroups.join(" · ") || "—"}
                            </strong>
                          </p>
                          <p>
                            <span>{t("返回覆盖")}</span>
                            <strong>
                              {selectedThreadPool.members.length} /{" "}
                              {selectedThreadPool.memberCount}
                            </strong>
                          </p>
                          <p>
                            <span>{t("拒绝策略")}</span>
                            <strong
                              title={selectedThreadPool.rejectionHandlerType}
                            >
                              {selectedThreadPool.rejectionHandlerType
                                ? shortClassName(
                                    selectedThreadPool.rejectionHandlerType,
                                  )
                                : "—"}
                            </strong>
                          </p>
                        </div>

                        <form
                          className="thread-pool-alias-editor"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveThreadPoolAlias();
                          }}
                        >
                          <Label>
                            <span>{t("本地业务别名")}</span>
                            <Input
                              value={threadPoolAliasDraft}
                              data-testid="thread-pool-alias-input"
                              type="text"
                              maxLength={64}
                              autoComplete="off"
                              placeholder={t("例如：订单异步池")}
                              onChange={(event) =>
                                apply({
                                  threadPoolAliasDraft: event.target.value,
                                })
                              }
                            />
                          </Label>
                          <div className="thread-pool-alias-editor__actions">
                            <Button
                              variant="secondary"
                              type="submit"
                              disabled={
                                Boolean(!threadPoolAliasDraft.trim()) ||
                                Boolean(savingThreadPoolAlias)
                              }
                              data-testid="thread-pool-alias-save"
                              aria-busy={Boolean(savingThreadPoolAlias)}
                            >
                              {Boolean(savingThreadPoolAlias) && <Spinner />}
                              {t("保存别名")}
                            </Button>
                            {threadPoolAliasOf(
                              threadPoolAliases,
                              selectedThreadPool.identity,
                            ) && (
                              <Button
                                type="button"
                                variant="outline"
                                disabled={savingThreadPoolAlias}
                                onClick={() => void clearThreadPoolAlias()}
                              >
                                {t("清除别名")}
                              </Button>
                            )}
                          </div>
                          <p>
                            {t(
                              "仅保存在本机，并绑定当前目标、JVM 启动周期与精确池身份。",
                            )}
                          </p>
                          {threadPoolAliasMessage && (
                            <p
                              className="thread-pool-alias-editor__message"
                              role="status"
                            >
                              {threadPoolAliasMessage}
                            </p>
                          )}
                        </form>

                        <section
                          className="thread-pool-task-evidence"
                          aria-labelledby="thread-pool-task-evidence-title"
                        >
                          <header>
                            <div>
                              <p className="eyebrow">
                                QUEUE + EXECUTION EVIDENCE / BOUNDED
                              </p>
                              <h3 id="thread-pool-task-evidence-title">
                                {t("任务堆积在哪里，成员又停在哪里。")}
                              </h3>
                              <p>
                                {t(
                                  "只读取已知 JDK 队列中最多 100 个元素的类型，以及精确成员的当前栈位置；不执行任务方法或任意 toString()。",
                                )}
                              </p>
                            </div>
                            <StatusPill
                              state={
                                selectedThreadPool.queueInspectionAvailable
                                  ? "ready"
                                  : "idle"
                              }
                              label={
                                selectedThreadPool.queueInspectionAvailable
                                  ? t("{count} 个队列任务样本", {
                                      count:
                                        selectedThreadPool.queueTasksScanned,
                                    })
                                  : t("队列证据受限")
                              }
                            />
                          </header>

                          <div className="thread-pool-task-evidence__grid">
                            <article>
                              <p className="eyebrow">
                                REJECTION POLICY / EXACT TYPE
                              </p>
                              <h4>
                                {selectedThreadPool.rejectionHandlerType
                                  ? shortClassName(
                                      selectedThreadPool.rejectionHandlerType,
                                    )
                                  : t("不适用")}
                              </h4>
                              <p>
                                {threadPoolRejectionDescription(
                                  selectedThreadPool,
                                )}
                              </p>
                              {selectedThreadPool.rejectionHandlerType && (
                                <code>
                                  {selectedThreadPool.rejectionHandlerType}
                                </code>
                              )}
                            </article>

                            <article>
                              <p className="eyebrow">
                                QUEUED ELEMENT TYPES / TOP 100
                              </p>
                              <h4>{t("排队任务类型")}</h4>
                              {selectedThreadPoolQueueTaskTypes.length ? (
                                <ol>
                                  {selectedThreadPoolQueueTaskTypes.map(
                                    (taskType) => (
                                      <li key={taskType.className}>
                                        <span title={taskType.className}>
                                          {shortClassName(taskType.className)}
                                        </span>
                                        <strong>{taskType.count}</strong>
                                      </li>
                                    ),
                                  )}
                                </ol>
                              ) : (
                                <p>
                                  {selectedThreadPool.queueInspectionAvailable
                                    ? t("采样时队列为空。")
                                    : threadPoolQueueEvidenceIssue(
                                        selectedThreadPool.queueInspectionIssue,
                                      )}
                                </p>
                              )}
                              {selectedThreadPool.queueTasksTruncated && (
                                <small>
                                  {t("队列任务类型只覆盖本次有界样本。")}
                                </small>
                              )}
                            </article>

                            <article>
                              <p className="eyebrow">
                                MEMBER APPLICATION FRAMES / TOP 8
                              </p>
                              <h4>{t("成员业务栈位置")}</h4>
                              {selectedThreadPoolApplicationFrames.length ? (
                                <div className="thread-pool-task-evidence__rows">
                                  {selectedThreadPoolApplicationFrames.map(
                                    (frame) => (
                                      <Tooltip key={frame.value}>
                                        <TooltipTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            type="button"
                                            onClick={() =>
                                              void locateThreadPoolMember(
                                                frame.representative,
                                              )
                                            }
                                          >
                                            <span>
                                              <strong>{frame.value}</strong>
                                              <small>{frame.states}</small>
                                            </span>
                                            <b>×{frame.count}</b>
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          {frame.value}
                                        </TooltipContent>
                                      </Tooltip>
                                    ),
                                  )}
                                </div>
                              ) : (
                                <p>
                                  {t(
                                    "当前成员只停在平台调度栈，未发现业务栈帧。",
                                  )}
                                </p>
                              )}
                            </article>

                            <article>
                              <p className="eyebrow">PARK BLOCKERS / TOP 8</p>
                              <h4>{t("Park / 等待对象类型")}</h4>
                              {selectedThreadPoolBlockers.length ? (
                                <div className="thread-pool-task-evidence__rows">
                                  {selectedThreadPoolBlockers.map((blocker) => (
                                    <Tooltip key={blocker.value}>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          type="button"
                                          onClick={() =>
                                            void locateThreadPoolMember(
                                              blocker.representative,
                                            )
                                          }
                                        >
                                          <span>
                                            <strong>{blocker.value}</strong>
                                            <small>{blocker.states}</small>
                                          </span>
                                          <b>×{blocker.count}</b>
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        {blocker.value}
                                      </TooltipContent>
                                    </Tooltip>
                                  ))}
                                </div>
                              ) : (
                                <p>
                                  {t(
                                    "当前成员没有可见的 LockSupport blocker。",
                                  )}
                                </p>
                              )}
                            </article>
                          </div>

                          <p className="thread-pool-task-evidence__boundary">
                            {t(
                              "这是精确池对象的一次现场证据，不把栈位置或队列元素类型直接宣称为根因。点击成员证据可重新查询完整线程栈。",
                            )}
                          </p>
                        </section>

                        <section
                          className="thread-pool-latency-probe"
                          aria-labelledby="thread-pool-latency-title"
                        >
                          <header>
                            <div>
                              <p className="eyebrow">
                                {threadPoolLatencyWaitSupported
                                  ? "QUEUE WAIT + RUN TIME / R2 / 5 MIN MAX"
                                  : threadPoolLatencyScheduleSupported
                                    ? "SCHEDULE DELAY + START LATENESS + RUN TIME / R2"
                                    : "WORKER RUN TIME / R2 / 5 MIN MAX"}
                              </p>
                              <h3 id="thread-pool-latency-title">
                                {threadPoolLatencyWaitSupported
                                  ? t("测量任务等了多久，又执行了多久。")
                                  : threadPoolLatencyScheduleSupported
                                    ? t("拆开计划延迟、启动迟滞与执行耗时。")
                                    : t("测量 Worker 真正执行了多久。")}
                              </h3>
                              <p>
                                {threadPoolLatencyWaitSupported
                                  ? t(
                                      "只增强当前精确 ThreadPoolExecutor；固定直方图、弱任务身份与自动超时限制目标开销。",
                                    )
                                  : threadPoolLatencyScheduleSupported
                                    ? t(
                                        "只增强当前精确 ScheduledThreadPoolExecutor；分别记录任务计划等待、到期后启动迟滞和 Worker 执行区间。",
                                      )
                                    : t(
                                        "只测量当前精确 ForkJoinPool 自有 Worker 的 doExec；外部协助执行不混入结果。",
                                      )}
                              </p>
                            </div>
                            <StatusPill
                              state={
                                threadPoolLatencyRunning ? "working" : "idle"
                              }
                              label={
                                threadPoolLatencyRunning
                                  ? t("时长归因中")
                                  : threadPoolLatencySnapshot
                                    ? t("{count} 个已完成任务", {
                                        count:
                                          threadPoolLatencySnapshot.completed,
                                      })
                                    : t("尚未测量")
                              }
                            />
                          </header>

                          {!selectedThreadPoolSupportsLatency ? (
                            <div className="thread-pool-latency-probe__unsupported">
                              <p className="eyebrow">EXACT CLASS BOUNDARY</p>
                              <strong>
                                {t("当前池类型不支持主动时长归因。")}
                              </strong>
                              <span>
                                {t(
                                  "当前 Agent 不支持线程池主动时长归因，或池类型超出精确支持边界。",
                                )}
                              </span>
                            </div>
                          ) : (
                            <>
                              <div className="thread-pool-latency-probe__controls">
                                <Label>
                                  <span>{t("归因时长")}</span>
                                  <SelectControl
                                    value={threadPoolLatencyDurationMillis}
                                    disabled={threadPoolLatencyRunning}
                                    onValueChange={(value) =>
                                      apply({
                                        threadPoolLatencyDurationMillis: Number(
                                          value,
                                        ),
                                      })
                                    }
                                  >
                                    <SelectControlItem value={15000}>
                                      {t("15 秒")}
                                    </SelectControlItem>
                                    <SelectControlItem value={30000}>
                                      {t("30 秒")}
                                    </SelectControlItem>
                                    <SelectControlItem value={60000}>
                                      {t("60 秒")}
                                    </SelectControlItem>
                                    <SelectControlItem value={120000}>
                                      {t("120 秒")}
                                    </SelectControlItem>
                                    <SelectControlItem value={300000}>
                                      {t("300 秒")}
                                    </SelectControlItem>
                                  </SelectControl>
                                </Label>
                                {(threadPoolLatencyWaitSupported ||
                                  threadPoolLatencyScheduleSupported) && (
                                  <Label>
                                    <span>
                                      {threadPoolLatencyWaitSupported
                                        ? t("提交跟踪上限")
                                        : t("调度跟踪上限")}
                                    </span>
                                    <SelectControl
                                      value={
                                        threadPoolLatencyMaximumTrackedTasks
                                      }
                                      disabled={threadPoolLatencyRunning}
                                      onValueChange={(value) =>
                                        apply({
                                          threadPoolLatencyMaximumTrackedTasks:
                                            Number(value),
                                        })
                                      }
                                    >
                                      <SelectControlItem value={128}>
                                        128
                                      </SelectControlItem>
                                      <SelectControlItem value={512}>
                                        512
                                      </SelectControlItem>
                                      <SelectControlItem value={1024}>
                                        1,024
                                      </SelectControlItem>
                                      <SelectControlItem value={2048}>
                                        2,048
                                      </SelectControlItem>
                                      <SelectControlItem value={4096}>
                                        4,096
                                      </SelectControlItem>
                                    </SelectControl>
                                  </Label>
                                )}
                                {!threadPoolLatencyRunning && (
                                  <Label className="thread-pool-latency-probe__confirmation">
                                    <Checkbox
                                      checked={threadPoolLatencyConfirmed}
                                      data-testid="thread-pool-latency-confirmation"
                                      onCheckedChange={(event) =>
                                        apply({
                                          threadPoolLatencyConfirmed:
                                            event === true,
                                        })
                                      }
                                    />
                                    <span>
                                      {t(
                                        "我确认临时增强当前精确线程池，并在停止或超时后恢复。",
                                      )}
                                    </span>
                                  </Label>
                                )}
                                <div className="thread-pool-latency-probe__actions">
                                  {!threadPoolLatencyRunning ? (
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      data-testid="thread-pool-latency-start"
                                      disabled={
                                        Boolean(!threadPoolLatencyConfirmed) ||
                                        Boolean(startingThreadPoolLatency)
                                      }
                                      onClick={() =>
                                        void startThreadPoolLatency()
                                      }
                                      aria-busy={Boolean(
                                        startingThreadPoolLatency,
                                      )}
                                    >
                                      {Boolean(startingThreadPoolLatency) && (
                                        <Spinner />
                                      )}
                                      {t("开始时长归因")}
                                    </Button>
                                  ) : (
                                    <Button
                                      type="button"
                                      data-testid="thread-pool-latency-stop"
                                      variant="outline"
                                      onClick={() =>
                                        void stopThreadPoolLatency(false)
                                      }
                                      aria-busy={Boolean(
                                        stoppingThreadPoolLatency,
                                      )}
                                      disabled={Boolean(
                                        stoppingThreadPoolLatency,
                                      )}
                                    >
                                      {Boolean(stoppingThreadPoolLatency) && (
                                        <Spinner />
                                      )}
                                      {t("停止并恢复")}
                                    </Button>
                                  )}
                                </div>
                              </div>

                              {threadPoolLatencyErrorMessage && (
                                <Alert
                                  className="thread-pool-latency-probe__error"
                                  variant="destructive"
                                >
                                  <AlertDescription>
                                    {threadPoolLatencyErrorMessage}
                                  </AlertDescription>
                                </Alert>
                              )}

                              {threadPoolLatencySnapshot && (
                                <>
                                  <div className="thread-pool-latency-probe__kpis">
                                    {threadPoolLatencyWaitSupported && (
                                      <>
                                        <article>
                                          <span>{t("平均排队")}</span>
                                          <strong>
                                            {formatLatencyNanos(
                                              threadPoolLatencyAverageWaitNanos,
                                            )}
                                          </strong>
                                          <small>
                                            P95{" "}
                                            {formatLatencyNanos(
                                              threadPoolLatencySnapshot.waitP95Nanos,
                                            )}
                                          </small>
                                        </article>
                                        <article>
                                          <span>{t("最长排队")}</span>
                                          <strong>
                                            {formatLatencyNanos(
                                              threadPoolLatencySnapshot.waitMaximumNanos,
                                            )}
                                          </strong>
                                          <small>
                                            {
                                              threadPoolLatencySnapshot.waitObserved
                                            }{" "}
                                            {t("个匹配提交")}
                                          </small>
                                        </article>
                                      </>
                                    )}
                                    {threadPoolLatencyScheduleSupported && (
                                      <>
                                        <article>
                                          <span>{t("平均计划延迟")}</span>
                                          <strong>
                                            {formatLatencyNanos(
                                              threadPoolLatencyAverageScheduleDelayNanos,
                                            )}
                                          </strong>
                                          <small>
                                            P95{" "}
                                            {formatLatencyNanos(
                                              threadPoolLatencySnapshot.scheduleDelayP95Nanos,
                                            )}
                                          </small>
                                        </article>
                                        <article>
                                          <span>{t("平均启动迟滞")}</span>
                                          <strong>
                                            {formatLatencyNanos(
                                              threadPoolLatencyAverageStartLatenessNanos,
                                            )}
                                          </strong>
                                          <small>
                                            P95{" "}
                                            {formatLatencyNanos(
                                              threadPoolLatencySnapshot.startLatenessP95Nanos,
                                            )}
                                          </small>
                                        </article>
                                        <article>
                                          <span>{t("最长启动迟滞")}</span>
                                          <strong>
                                            {formatLatencyNanos(
                                              threadPoolLatencySnapshot.startLatenessMaximumNanos,
                                            )}
                                          </strong>
                                          <small>
                                            {
                                              threadPoolLatencySnapshot.startLatenessObserved
                                            }{" "}
                                            {t("个到期样本")}
                                          </small>
                                        </article>
                                      </>
                                    )}
                                    <article>
                                      <span>{t("平均执行")}</span>
                                      <strong>
                                        {formatLatencyNanos(
                                          threadPoolLatencyAverageRunNanos,
                                        )}
                                      </strong>
                                      <small>
                                        P95{" "}
                                        {formatLatencyNanos(
                                          threadPoolLatencySnapshot.runP95Nanos,
                                        )}
                                      </small>
                                    </article>
                                    <article>
                                      <span>{t("最长执行")}</span>
                                      <strong>
                                        {formatLatencyNanos(
                                          threadPoolLatencySnapshot.runMaximumNanos,
                                        )}
                                      </strong>
                                      <small>
                                        {threadPoolLatencySnapshot.completed}{" "}
                                        {t("个已完成任务")}
                                      </small>
                                    </article>
                                  </div>

                                  <div className="thread-pool-latency-probe__facts">
                                    <p>
                                      <span>
                                        {threadPoolLatencyWaitSupported
                                          ? t("提交 / 启动")
                                          : threadPoolLatencyScheduleSupported
                                            ? t("调度 / 启动")
                                            : t("启动 / 完成")}
                                      </span>
                                      <strong>
                                        {threadPoolLatencyWaitSupported ||
                                        threadPoolLatencyScheduleSupported
                                          ? threadPoolLatencySnapshot.submitted
                                          : threadPoolLatencySnapshot.started}{" "}
                                        /{" "}
                                        {threadPoolLatencyWaitSupported ||
                                        threadPoolLatencyScheduleSupported
                                          ? threadPoolLatencySnapshot.started
                                          : threadPoolLatencySnapshot.completed}
                                      </strong>
                                    </p>
                                    <p>
                                      <span>
                                        {threadPoolLatencyWaitSupported
                                          ? t("执行中 / 待匹配")
                                          : threadPoolLatencyScheduleSupported
                                            ? t("执行中 / 待就绪")
                                            : t("执行中 / 未捕获失败")}
                                      </span>
                                      <strong>
                                        {threadPoolLatencySnapshot.inFlight} /{" "}
                                        {threadPoolLatencyWaitSupported ||
                                        threadPoolLatencyScheduleSupported
                                          ? threadPoolLatencySnapshot.pendingTracked
                                          : threadPoolLatencySnapshot.failures}
                                      </strong>
                                    </p>
                                    {threadPoolLatencyWaitSupported && (
                                      <p>
                                        <span>{t("拒绝 / 未捕获失败")}</span>
                                        <strong>
                                          {threadPoolLatencySnapshot.rejected} /{" "}
                                          {threadPoolLatencySnapshot.failures}
                                        </strong>
                                      </p>
                                    )}
                                    {threadPoolLatencyScheduleSupported && (
                                      <p>
                                        <span>{t("计划样本 / 到期样本")}</span>
                                        <strong>
                                          {
                                            threadPoolLatencySnapshot.scheduleDelayObserved
                                          }{" "}
                                          /{" "}
                                          {
                                            threadPoolLatencySnapshot.startLatenessObserved
                                          }
                                        </strong>
                                      </p>
                                    )}
                                    {threadPoolLatencyScheduleSupported && (
                                      <p>
                                        <span>{t("拒绝 / 未匹配")}</span>
                                        <strong>
                                          {threadPoolLatencySnapshot.rejected} /{" "}
                                          {
                                            threadPoolLatencySnapshot.unmatchedStarts
                                          }
                                        </strong>
                                      </p>
                                    )}
                                    {threadPoolLatencyWaitSupported && (
                                      <p>
                                        <span>{t("丢弃跟踪 / 未匹配")}</span>
                                        <strong>
                                          {
                                            threadPoolLatencySnapshot.droppedSubmissions
                                          }{" "}
                                          /{" "}
                                          {
                                            threadPoolLatencySnapshot.unmatchedStarts
                                          }
                                        </strong>
                                      </p>
                                    )}
                                  </div>

                                  <div
                                    className={cn(
                                      "thread-pool-latency-probe__types",
                                      threadPoolLatencyScheduleSupported &&
                                        "thread-pool-latency-probe__types--scheduled",
                                    )}
                                  >
                                    <div className="thread-pool-latency-probe__type-header">
                                      <span>{t("任务运行时类型")}</span>
                                      <span>{t("完成")}</span>
                                      {threadPoolLatencyScheduleSupported ? (
                                        <>
                                          <span>{t("平均计划延迟")}</span>
                                          <span>{t("最大计划延迟")}</span>
                                          <span>{t("平均启动迟滞")}</span>
                                          <span>{t("最大启动迟滞")}</span>
                                        </>
                                      ) : (
                                        <>
                                          <span>{t("平均排队")}</span>
                                          <span>{t("最大排队")}</span>
                                        </>
                                      )}
                                      <span>{t("平均执行")}</span>
                                      <span>{t("最大执行")}</span>
                                    </div>
                                    {threadPoolLatencyTaskTypes.map(
                                      (taskType) => (
                                        <div
                                          key={taskType.className}
                                          className="thread-pool-latency-probe__type-row"
                                        >
                                          <strong title={taskType.className}>
                                            {shortClassName(taskType.className)}
                                          </strong>
                                          <span>{taskType.completed}</span>
                                          {threadPoolLatencyScheduleSupported ? (
                                            <>
                                              <span>
                                                {formatLatencyNanos(
                                                  taskTypeAverageScheduleDelayNanos(
                                                    taskType,
                                                  ),
                                                )}
                                              </span>
                                              <span>
                                                {formatLatencyNanos(
                                                  taskType.scheduleDelayMaximumNanos,
                                                )}
                                              </span>
                                              <span>
                                                {formatLatencyNanos(
                                                  taskTypeAverageStartLatenessNanos(
                                                    taskType,
                                                  ),
                                                )}
                                              </span>
                                              <span>
                                                {formatLatencyNanos(
                                                  taskType.startLatenessMaximumNanos,
                                                )}
                                              </span>
                                            </>
                                          ) : (
                                            <>
                                              <span>
                                                {threadPoolLatencyWaitSupported
                                                  ? formatLatencyNanos(
                                                      taskTypeAverageWaitNanos(
                                                        taskType,
                                                      ),
                                                    )
                                                  : "—"}
                                              </span>
                                              <span>
                                                {threadPoolLatencyWaitSupported
                                                  ? formatLatencyNanos(
                                                      taskType.waitMaximumNanos,
                                                    )
                                                  : "—"}
                                              </span>
                                            </>
                                          )}
                                          <span>
                                            {formatLatencyNanos(
                                              taskTypeAverageRunNanos(taskType),
                                            )}
                                          </span>
                                          <span>
                                            {formatLatencyNanos(
                                              taskType.runMaximumNanos,
                                            )}
                                          </span>
                                        </div>
                                      ),
                                    )}
                                    {!threadPoolLatencyTaskTypes.length && (
                                      <p>
                                        {t(
                                          "等待探针捕获由 Worker 执行的任务。",
                                        )}
                                      </p>
                                    )}
                                  </div>
                                </>
                              )}
                            </>
                          )}

                          <p className="thread-pool-latency-probe__boundary">
                            {threadPoolLatencyWaitSupported
                              ? t(
                                  "排队时长只统计探针启动后匹配到的提交；CallerRuns 与启动前已在队列中的任务不会伪造等待时间。",
                                )
                              : threadPoolLatencyScheduleSupported
                                ? t(
                                    "计划延迟取自 JDK Delayed 剩余时间；启动迟滞从任务到期时刻计算。探针启动前已排队的任务保持未匹配，不会伪造拥塞。",
                                  )
                                : t(
                                    "ForkJoin 只归因目标池自有 Worker 的 doExec；外部 help/join 与排队等待不计入结果。",
                                  )}
                          </p>
                        </section>

                        <section
                          className="thread-pool-trend-recorder"
                          aria-labelledby="thread-pool-trend-title"
                        >
                          <header>
                            <div>
                              <p className="eyebrow">
                                POOL TREND RECORDER / R2 / 120
                              </p>
                              <h3 id="thread-pool-trend-title">
                                {t("记录饱和、队列与吞吐变化。")}
                              </h3>
                              <p>
                                {t(
                                  "每次采样重新定位同一精确池对象；最多保留 120 点，停止后可保存为校验制品。",
                                )}
                              </p>
                            </div>
                            <StatusPill
                              state={
                                threadPoolTrendSampling ? "working" : "idle"
                              }
                              label={
                                threadPoolTrendSampling
                                  ? t("线程池采样中")
                                  : t("{count} 个池样本", {
                                      count: threadPoolTrendSamples.length,
                                    })
                              }
                            />
                          </header>

                          <div className="thread-pool-trend-recorder__controls">
                            <Label>
                              <span>{t("池采样间隔")}</span>
                              <SelectControl
                                value={threadPoolTrendSamplingIntervalMillis}
                                disabled={threadPoolTrendSampling}
                                onValueChange={(value) =>
                                  apply({
                                    threadPoolTrendSamplingIntervalMillis:
                                      Number(value) as
                                        | 2_000
                                        | 5_000
                                        | 10_000
                                        | 30_000,
                                  })
                                }
                              >
                                <SelectControlItem value={2000}>
                                  {t("2 秒")}
                                </SelectControlItem>
                                <SelectControlItem value={5000}>
                                  {t("5 秒")}
                                </SelectControlItem>
                                <SelectControlItem value={10000}>
                                  {t("10 秒")}
                                </SelectControlItem>
                                <SelectControlItem value={30000}>
                                  {t("30 秒")}
                                </SelectControlItem>
                              </SelectControl>
                            </Label>
                            {!threadPoolTrendSampling && (
                              <Label className="thread-pool-trend-recorder__confirmation">
                                <Checkbox
                                  checked={threadPoolTrendConfirmed}
                                  data-testid="thread-pool-trend-confirmation"
                                  onCheckedChange={(event) =>
                                    apply({
                                      threadPoolTrendConfirmed: event === true,
                                    })
                                  }
                                />
                                <span>
                                  {t(
                                    "我确认按所选间隔重复执行有界 R2 精确池扫描。",
                                  )}
                                </span>
                              </Label>
                            )}
                            {!threadPoolTrendSampling ? (
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={
                                  Boolean(!threadPoolTrendConfirmed) ||
                                  Boolean(collectingThreadPoolTrend)
                                }
                                data-testid="thread-pool-trend-start"
                                onClick={() =>
                                  void startThreadPoolTrendSampling()
                                }
                                aria-busy={Boolean(collectingThreadPoolTrend)}
                              >
                                {Boolean(collectingThreadPoolTrend) && (
                                  <Spinner />
                                )}
                                {t("开始池趋势")}
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                variant="outline"
                                data-testid="thread-pool-trend-stop"
                                onClick={() => stopThreadPoolTrendSampling()}
                              >
                                {t("停止池趋势")}
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="outline"
                              disabled={
                                Boolean(
                                  threadPoolTrendSampling ||
                                    threadPoolTrendSamples.length < 2,
                                ) || Boolean(savingThreadPoolTrend)
                              }
                              data-testid="thread-pool-trend-save"
                              onClick={() => void saveThreadPoolTrendArtifact()}
                              aria-busy={Boolean(savingThreadPoolTrend)}
                            >
                              {Boolean(savingThreadPoolTrend) && <Spinner />}
                              {t("保存趋势制品")}
                            </Button>
                          </div>

                          {threadPoolTrendErrorMessage && (
                            <Alert
                              className="thread-pool-trend-recorder__notice"
                              variant="destructive"
                            >
                              <AlertDescription>
                                {threadPoolTrendErrorMessage}
                              </AlertDescription>
                            </Alert>
                          )}

                          {latestThreadPoolTrendSample && (
                            <>
                              <dl className="thread-pool-trend-recorder__metrics">
                                <div>
                                  <dt>{t("当前队列")}</dt>
                                  <dd>
                                    {threadPoolQueueLevel(
                                      latestThreadPoolTrendSample,
                                    )}
                                  </dd>
                                </div>
                                <div>
                                  <dt>{t("队列净变化")}</dt>
                                  <dd>
                                    {threadPoolTrendQueueDelta > 0
                                      ? `+${threadPoolTrendQueueDelta}`
                                      : threadPoolTrendQueueDelta}
                                  </dd>
                                </div>
                                <div>
                                  <dt>{t("活跃 / 当前")}</dt>
                                  <dd>
                                    {latestThreadPoolTrendSample.activeCount ??
                                      "—"}{" "}
                                    /{" "}
                                    {latestThreadPoolTrendSample.poolSize ??
                                      "—"}
                                  </dd>
                                </div>
                                <div>
                                  <dt>{t("累计完成")}</dt>
                                  <dd>
                                    {latestThreadPoolTrendSample.completedTasks ??
                                      "—"}
                                  </dd>
                                </div>
                              </dl>

                              <div className="thread-pool-trend-recorder__chart">
                                <div className="thread-pool-trend-recorder__legend">
                                  <span>{t("队列")}</span>
                                  <span>{t("活跃")}</span>
                                  <span>{t("池大小")}</span>
                                </div>
                                <svg
                                  viewBox="0 0 600 144"
                                  preserveAspectRatio="none"
                                  role="img"
                                  aria-label={t(
                                    "最近 {count} 个精确线程池样本",
                                    {
                                      count: threadPoolTrendSamples.length,
                                    },
                                  )}
                                >
                                  <g aria-hidden="true">
                                    <line x1="0" y1="16" x2="600" y2="16" />
                                    <line x1="0" y1="72" x2="600" y2="72" />
                                    <line x1="0" y1="128" x2="600" y2="128" />
                                  </g>
                                  <path
                                    className="thread-pool-trend-recorder__queue"
                                    d={threadPoolTrendPaths.queue}
                                    vectorEffect="non-scaling-stroke"
                                  />
                                  <path
                                    className="thread-pool-trend-recorder__active"
                                    d={threadPoolTrendPaths.active}
                                    vectorEffect="non-scaling-stroke"
                                  />
                                  <path
                                    className="thread-pool-trend-recorder__size"
                                    d={threadPoolTrendPaths.size}
                                    vectorEffect="non-scaling-stroke"
                                  />
                                </svg>
                              </div>
                            </>
                          )}

                          {threadPoolTrendArtifact && (
                            <Alert
                              className="thread-pool-trend-recorder__artifact"
                              role="status"
                            >
                              <AlertDescription>
                                <strong>{threadPoolTrendArtifact.name}</strong>
                                <small>{t("已校验并写入本地制品")}</small>
                              </AlertDescription>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() =>
                                  void navigate({
                                    pathname: "/artifacts",
                                    search: `?inspect=${encodeURIComponent(threadPoolTrendArtifact.id)}`,
                                  })
                                }
                              >
                                {t("打开趋势检查器")}
                              </Button>
                            </Alert>
                          )}
                        </section>

                        {selectedThreadPool.members.length ? (
                          <div className="thread-pool-member-list">
                            {selectedThreadPool.members.map((member) => (
                              <Button
                                variant="ghost"
                                key={`${member.threadId}:${member.name}`}
                                type="button"
                                className="thread-pool-member-row"
                                data-testid={`thread-pool-member-${member.threadId}`}
                                aria-label={t("定位线程 #{id} · {name}", {
                                  id: member.threadId,
                                  name: member.name,
                                })}
                                onClick={() =>
                                  void locateThreadPoolMember(member)
                                }
                              >
                                <span className="thread-pool-member-row__id">
                                  #{member.threadId}
                                </span>
                                <span className="thread-pool-member-row__identity">
                                  <strong>{member.name}</strong>
                                  <small>
                                    {member.groupName || t("无线程组")}
                                    {" · "}
                                    {member.daemon ? "daemon" : "user"}
                                    {" · P"}
                                    {member.priority}
                                  </small>
                                </span>
                                <span>{member.state}</span>
                                <span>{t("定位堆栈")} →</span>
                              </Button>
                            ))}
                          </div>
                        ) : (
                          <div className="thread-pool-member-empty">
                            <strong>
                              {selectedThreadPool.membershipAvailable
                                ? t("这个线程池当前没有存活成员。")
                                : t("当前 JDK 不允许读取这个线程池的成员。")}
                            </strong>
                            {selectedThreadPool.membershipIssue && (
                              <p>{selectedThreadPool.membershipIssue}</p>
                            )}
                          </div>
                        )}
                      </section>
                    )}
                  </>
                ) : (
                  <div className="lock-empty">
                    <p className="eyebrow">NO EXACT JDK EXECUTORS</p>
                    <strong>
                      {t(
                        "当前没有可见的精确 JDK 线程池；自定义子类不会被误报。",
                      )}
                    </strong>
                  </div>
                )}
              </>
            )}
          </section>

          <section
            className="thread-trends"
            aria-labelledby="thread-trends-title"
          >
            <header>
              <div>
                <p className="eyebrow">BOUNDED THREAD TRENDS / R0</p>
                <h2 id="thread-trends-title">
                  {t("把线程变化留在有界时间窗里。")}
                </h2>
                <p>
                  {t(
                    "每次最多读取 1,000 个线程且只取一层栈，内存中保留最近 120 个样本；停止、断连、切换目标或离开页面都会释放定时器。",
                  )}
                </p>
              </div>
              <StatusPill
                state={threadTrendSampling ? "working" : "idle"}
                label={
                  threadTrendSampling
                    ? t("连续采样中")
                    : t("{count} 个样本", {
                        count: threadTrendSamples.length,
                      })
                }
              />
            </header>

            <div className="thread-trends__toolbar">
              <Label>
                <span>{t("采样间隔")}</span>
                <SelectControl
                  value={threadTrendSamplingIntervalMillis}
                  disabled={threadTrendSampling}
                  onValueChange={(value) =>
                    apply({
                      threadTrendSamplingIntervalMillis: Number(
                        value,
                      ),
                    })
                  }
                >
                  <SelectControlItem value={1000}>
                    {t("1 秒")}
                  </SelectControlItem>
                  <SelectControlItem value={2000}>
                    {t("2 秒")}
                  </SelectControlItem>
                  <SelectControlItem value={5000}>
                    {t("5 秒")}
                  </SelectControlItem>
                  <SelectControlItem value={10000}>
                    {t("10 秒")}
                  </SelectControlItem>
                </SelectControl>
              </Label>
              {!threadTrendSampling ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={collectingThreadTrend}
                  onClick={() => void startThreadTrendSampling()}
                >
                  {t("开始连续采样")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => stopThreadTrendSampling()}
                >
                  {t("停止连续采样")}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={
                  Boolean(collectingThreadTrend) ||
                  Boolean(collectingThreadTrend)
                }
                onClick={() => void collectThreadTrendSample()}
                aria-busy={Boolean(collectingThreadTrend)}
              >
                {Boolean(collectingThreadTrend) && <Spinner />}
                {t("立即采样")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  threadTrendSamples.length === 0 || collectingThreadTrend
                }
                onClick={() => clearThreadTrendHistory()}
              >
                {t("清空历史")}
              </Button>
            </div>

            {threadTrendErrorMessage && (
              <Alert variant="destructive">
                <AlertDescription>
                  {t(threadTrendErrorMessage)}
                </AlertDescription>
              </Alert>
            )}

            {latestThreadTrendSample ? (
              <>
                <div className="thread-trends__metrics">
                  <article>
                    <span>{t("线程总数")}</span>
                    <strong>{latestThreadTrendSample.total}</strong>
                  </article>
                  <article>
                    <span>{t("本次可见")}</span>
                    <strong>
                      {latestThreadTrendSample.visible} /{" "}
                      {latestThreadTrendSample.total}
                    </strong>
                  </article>
                  <article>
                    <span>{t("可见 CPU 速率")}</span>
                    <strong>
                      {formatThreadTrendCpu(
                        latestThreadTrendSample.cpuMillisPerSecond,
                      )}
                    </strong>
                  </article>
                  <article>
                    <span>{t("生命周期变化")}</span>
                    <strong>
                      {latestThreadTrendSample.newCount === null
                        ? "—"
                        : `+${latestThreadTrendSample.newCount} / −${latestThreadTrendSample.exitedCount ?? 0}`}
                    </strong>
                  </article>
                  <article>
                    <span>{t("可见死锁")}</span>
                    <strong>{latestThreadTrendSample.deadlocked}</strong>
                  </article>
                </div>

                {latestThreadTrendSample.truncated && (
                  <p className="thread-trends__boundary">
                    {t(
                      "线程总数仍为目标快照总数；状态、死锁、生命周期和 CPU 只覆盖前 1,000 个可见线程。",
                    )}
                  </p>
                )}

                <section
                  className="thread-hot-cpu"
                  aria-labelledby="thread-hot-cpu-title"
                >
                  <header>
                    <div>
                      <p className="eyebrow">HOT THREADS / INTERVAL DELTA</p>
                      <h3 id="thread-hot-cpu-title">
                        {t("当前采样窗口的热点线程。")}
                      </h3>
                    </div>
                    <p>
                      {t(
                        "按相邻样本 CPU 增量排序；百分比表示单线程占用一个逻辑核心的近似比例。",
                      )}
                    </p>
                  </header>

                  {latestThreadTrendSample.hotThreads.length ? (
                    <div className="thread-hot-cpu__list">
                      {latestThreadTrendSample.hotThreads.map(
                        (thread, index) => (
                          <Button
                            variant="ghost"
                            key={`${thread.id}:${thread.name}`}
                            type="button"
                            className="thread-hot-cpu__row h-auto"
                            aria-label={t("在线程列表中定位 #{id} · {name}", {
                              id: thread.id,
                              name: thread.name,
                            })}
                            onClick={() => void locateHotThread(thread)}
                          >
                            <span className="thread-hot-cpu__rank">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <span className="thread-hot-cpu__identity">
                              <strong>
                                #{thread.id} · {thread.name}
                              </strong>
                              <small>
                                {thread.topFrame ?? t("没有可用栈顶")}
                              </small>
                            </span>
                            <span className="thread-hot-cpu__state">
                              {thread.state}
                            </span>
                            <span className="thread-hot-cpu__rate">
                              <strong>
                                {formatHotThreadPercent(thread.oneCorePercent)}
                              </strong>
                              <small>
                                {formatThreadTrendCpu(
                                  thread.cpuMillisPerSecond,
                                )}
                              </small>
                            </span>
                            <span
                              className="thread-hot-cpu__bar"
                              aria-hidden="true"
                            >
                              <span
                                style={{
                                  inlineSize: hotThreadBarWidth(
                                    thread.oneCorePercent,
                                  ),
                                }}
                              />
                            </span>
                          </Button>
                        ),
                      )}
                    </div>
                  ) : (
                    <div className="thread-hot-cpu__empty">
                      {t("这一窗口没有可比较的 CPU 增量；首个样本只建立基线。")}
                    </div>
                  )}
                </section>

                <div className="thread-trends__chart">
                  <div className="thread-trends__legend" aria-hidden="true">
                    <span className="thread-trends__legend-total">
                      {t("总数")}
                    </span>
                    <span className="thread-trends__legend-runnable">
                      RUNNABLE
                    </span>
                    <span className="thread-trends__legend-waiting">
                      WAITING
                    </span>
                    <span className="thread-trends__legend-blocked">
                      BLOCKED
                    </span>
                  </div>
                  <svg
                    viewBox="0 0 600 144"
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={t("最近 {count} 个线程样本的总数与状态趋势", {
                      count: threadTrendSamples.length,
                    })}
                  >
                    <g className="thread-trends__grid" aria-hidden="true">
                      <line x1="0" y1="16" x2="600" y2="16" />
                      <line x1="0" y1="44" x2="600" y2="44" />
                      <line x1="0" y1="72" x2="600" y2="72" />
                      <line x1="0" y1="100" x2="600" y2="100" />
                      <line x1="0" y1="128" x2="600" y2="128" />
                    </g>
                    <path
                      className="thread-trends__line-total"
                      d={threadTrendPaths.total}
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      className="thread-trends__line-runnable"
                      d={threadTrendPaths.runnable}
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      className="thread-trends__line-waiting"
                      d={threadTrendPaths.waiting}
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      className="thread-trends__line-blocked"
                      d={threadTrendPaths.blocked}
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  <footer>
                    <span>
                      {t("{count} / {maximum} 个内存样本", {
                        count: threadTrendSamples.length,
                        maximum: MAXIMUM_THREAD_TREND_SAMPLES,
                      })}
                    </span>
                    <span>
                      {t("最近采样 {time}", {
                        time: formatSnapshotTime(
                          latestThreadTrendSample.capturedAt,
                        ),
                      })}
                    </span>
                  </footer>
                </div>
              </>
            ) : (
              <div className="thread-trends__empty">
                <p className="eyebrow">NO TREND SAMPLES</p>
                <strong>{t("先采集一个线程趋势样本。")}</strong>
                <p>
                  {t(
                    "首个样本建立基线；后续样本才计算线程新增、退出与可见累计 CPU 速率。",
                  )}
                </p>
              </div>
            )}
          </section>

          <section className="snapshot-workbench">
            <header>
              <div>
                <p className="eyebrow">THREAD SNAPSHOT DIFF</p>
                <h2>{t("两次采样之间，哪些线程真的变了。")}</h2>
              </div>
              <div className="snapshot-actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void pinBaseline()}
                  aria-busy={Boolean(capturingBaseline)}
                  disabled={Boolean(capturingBaseline)}
                >
                  {Boolean(capturingBaseline) && <Spinner />}
                  {baselineSnapshot ? t("重置线程基线") : t("固定线程基线")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    Boolean(!baselineSnapshot) || Boolean(comparingSnapshots)
                  }
                  onClick={() => void compareWithCurrent()}
                  aria-busy={Boolean(comparingSnapshots)}
                >
                  {Boolean(comparingSnapshots) && <Spinner />}
                  {t("与当前对比")}
                </Button>
              </div>
            </header>
            <p className="snapshot-boundary">
              {t(
                "一次最多采集 1000 个线程；对比新增、退出、状态、锁持有者和累计 CPU 增量。",
              )}
            </p>

            {baselineSnapshot && (
              <div className="snapshot-timeline">
                <article>
                  <p className="eyebrow">BASELINE</p>
                  <strong>
                    {formatSnapshotTime(baselineSnapshot.capturedAt)}
                  </strong>
                  <span>
                    {t("{count} 个线程", {
                      count: baselineSnapshot.threads.length,
                    })}
                    {baselineSnapshot.truncated && <>· {t("已截断")}</>}
                  </span>
                </article>
                <span className="snapshot-timeline__line" aria-hidden="true">
                  →
                </span>
                <article
                  className={cn(!snapshotDiff && "snapshot-timeline__pending")}
                >
                  <p className="eyebrow">CURRENT</p>
                  <strong>
                    {snapshotDiff
                      ? formatSnapshotTime(snapshotDiff.current.capturedAt)
                      : "—"}
                  </strong>
                  <span>
                    {snapshotDiff
                      ? t("{count} 个线程", {
                          count: snapshotDiff.current.threads.length,
                        })
                      : t("等待第二次采样")}
                  </span>
                </article>
              </div>
            )}

            {snapshotDiff && (
              <>
                <div className="snapshot-kpis">
                  <article>
                    <p className="eyebrow">NEW</p>
                    <strong>{snapshotDiff.newCount}</strong>
                    <span>{t("新增线程")}</span>
                  </article>
                  <article>
                    <p className="eyebrow">EXITED</p>
                    <strong>{snapshotDiff.exitedCount}</strong>
                    <span>{t("退出线程")}</span>
                  </article>
                  <article>
                    <p className="eyebrow">STATE</p>
                    <strong>{snapshotDiff.stateChangedCount}</strong>
                    <span>{t("状态变化")}</span>
                  </article>
                  <article>
                    <p className="eyebrow">CPU DELTA</p>
                    <strong>
                      {formatCpuDelta(snapshotDiff.totalCpuDeltaNanos)}
                    </strong>
                    <span>{t("累计增量")}</span>
                  </article>
                </div>

                <div className="snapshot-inspector">
                  <section>
                    <header>
                      <p className="eyebrow">TOP CPU GROWTH</p>
                      <span>{snapshotDiff.topCpu.length} / 20</span>
                    </header>
                    {snapshotDiff.topCpu.map((thread) => (
                      <article
                        key={`cpu:${thread.id}`}
                        className="snapshot-row"
                      >
                        <span>
                          <strong>
                            #{thread.id} · {thread.name}
                          </strong>
                          <small>{thread.state}</small>
                        </span>
                        <strong>+{formatCpuDelta(thread.deltaNanos)}</strong>
                      </article>
                    ))}
                    {!snapshotDiff.topCpu.length && (
                      <p className="snapshot-empty">
                        {t("当前采样间隔内没有可见 CPU 增量。")}
                      </p>
                    )}
                  </section>
                  <section>
                    <header>
                      <p className="eyebrow">LIFECYCLE & LOCK CHANGES</p>
                      <span>{snapshotDiff.changes.length} / 50</span>
                    </header>
                    {snapshotDiff.changes.map((change) => (
                      <article key={change.key} className="snapshot-row">
                        <span>
                          <strong>
                            #{change.id} · {change.name}
                          </strong>
                          <small>{change.detail}</small>
                        </span>
                        <StatusPill state="idle" label={change.category} />
                      </article>
                    ))}
                    {!snapshotDiff.changes.length && (
                      <p className="snapshot-empty">
                        {t("线程生命周期与锁关系保持稳定。")}
                      </p>
                    )}
                  </section>
                </div>
              </>
            )}
          </section>

          <section className="lock-workbench">
            <header>
              <div>
                <p className="eyebrow">LOCK RELATIONSHIP INSPECTOR</p>
                <h2>{t("等待者、持有者与锁，一次看清。")}</h2>
              </div>
              <p>
                {t(
                  "默认只返回存在等待、持有关系或死锁的线程；结果有界且不会持续轮询目标。",
                )}
              </p>
            </header>
            <div className="lock-controls">
              <Label>
                <span>{t("节点上限")}</span>
                <Input
                  value={maximumLockNodes}
                  type="number"
                  min="1"
                  max="500"
                  onChange={(event) =>
                    apply({ maximumLockNodes: Number(event.target.value) })
                  }
                />
              </Label>
              <Label className="lock-controls__checkbox">
                <Checkbox
                  checked={includeUncontended}
                  onCheckedChange={(event) =>
                    apply({ includeUncontended: event === true })
                  }
                />
                <span>{t("包含没有等待者的持有锁")}</span>
              </Label>
              <Button
                type="button"
                variant="outline"
                disabled={
                  Boolean(!threadLocksAvailable) || Boolean(loadingLocks)
                }
                onClick={() => void inspectLocks()}
                aria-busy={Boolean(loadingLocks)}
              >
                {Boolean(loadingLocks) && <Spinner />}
                {t("分析锁关系")}
              </Button>
            </div>

            {lockSummary && (
              <>
                <div className="lock-kpis" aria-label={t("锁关系摘要")}>
                  <article>
                    <p className="eyebrow">RELATED</p>
                    <strong>{lockSummary.related}</strong>
                    <span>{t("相关线程")}</span>
                  </article>
                  <article>
                    <p className="eyebrow">WAITING</p>
                    <strong>{lockSummary.waiting}</strong>
                    <span>{t("等待锁")}</span>
                  </article>
                  <article>
                    <p className="eyebrow">HELD LOCKS</p>
                    <strong>{lockSummary.heldLocks}</strong>
                    <span>{t("持有锁")}</span>
                  </article>
                  <article>
                    <p className="eyebrow">DEADLOCKED</p>
                    <strong>{lockSummary.deadlocked}</strong>
                    <span>{t("死锁线程")}</span>
                  </article>
                </div>

                {lockNodes.length ? (
                  <div className="lock-inspector">
                    <aside className="lock-node-list">
                      <header>
                        <div>
                          <p className="eyebrow">THREAD NODES</p>
                          <strong>
                            {t("{count} 个节点 · {edges} 条等待边", {
                              count: lockNodes.length,
                              edges: lockSummary.edges,
                            })}
                          </strong>
                        </div>
                        {lockSummary.truncated > 0 && (
                          <span>
                            {t("截断 {count}", {
                              count: lockSummary.truncated,
                            })}
                          </span>
                        )}
                      </header>
                      {visibleLockNodes.map((node) => (
                        <Button
                          variant="ghost"
                          key={node.id}
                          type="button"
                          className={cn(
                            "lock-node",
                            node.id === selectedLockNode?.id &&
                              "lock-node--selected",
                            node.deadlocked && "lock-node--deadlocked",
                          )}
                          onClick={() =>
                            apply({ selectedLockThreadId: node.id })
                          }
                        >
                          <span>
                            <strong>
                              #{node.id} · {node.name}
                            </strong>
                            <small>{node.state}</small>
                          </span>
                          {node.ownerId !== null ? (
                            <small>
                              {t("等待 #{owner}", { owner: node.ownerId })}
                            </small>
                          ) : (
                            <small>
                              {t("{count} 个持有锁", {
                                count:
                                  node.monitors.length +
                                  node.synchronizers.length,
                              })}
                            </small>
                          )}
                        </Button>
                      ))}
                      {visibleLockNodes.length < lockNodes.length && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            apply({ lockRenderLimit: lockNodes.length })
                          }
                        >
                          {t("展开剩余 {count} 个节点", {
                            count: lockNodes.length - visibleLockNodes.length,
                          })}
                        </Button>
                      )}
                    </aside>

                    <section className="lock-detail">
                      {selectedLockNode && (
                        <>
                          <header>
                            <div>
                              <p className="eyebrow">
                                THREAD #{selectedLockNode.id}
                              </p>
                              <h2>{selectedLockNode.name}</h2>
                            </div>
                            <StatusPill
                              state={
                                selectedLockNode.deadlocked ? "error" : "idle"
                              }
                              label={
                                selectedLockNode.deadlocked
                                  ? t("死锁")
                                  : selectedLockNode.state
                              }
                            />
                          </header>
                          <dl className="lock-detail__facts">
                            <div>
                              <dt>{t("栈顶")}</dt>
                              <dd>{selectedLockNode.stackTop || t("无")}</dd>
                            </div>
                            <div>
                              <dt>{t("等待锁")}</dt>
                              <dd>{selectedLockNode.waitingLock || t("无")}</dd>
                            </div>
                            <div>
                              <dt>{t("持有者")}</dt>
                              <dd>
                                {selectedLockNode.ownerId !== null ? (
                                  <>
                                    #{selectedLockNode.ownerId}
                                    {" · "}
                                    {selectedLockNode.ownerName}
                                    <Button
                                      type="button"
                                      variant="outline"
                                      onClick={() =>
                                        selectLockOwner(
                                          selectedLockNode.ownerId,
                                        )
                                      }
                                    >
                                      {t("定位持有线程")}
                                    </Button>
                                  </>
                                ) : (
                                  t("无")
                                )}
                              </dd>
                            </div>
                          </dl>
                          <div className="held-locks">
                            <section>
                              <p className="eyebrow">
                                MONITORS / {selectedLockNode.monitors.length}
                              </p>
                              {selectedLockNode.monitors.map((lock) => (
                                <article key={`${lock.lock}:${lock.frame}`}>
                                  <strong>{lock.lock}</strong>
                                  <small>{lock.frame || t("未知位置")}</small>
                                </article>
                              ))}
                              {!selectedLockNode.monitors.length && (
                                <p>{t("没有已记录的 Monitor。")}</p>
                              )}
                            </section>
                            <section>
                              <p className="eyebrow">
                                SYNCHRONIZERS /{" "}
                                {selectedLockNode.synchronizers.length}
                              </p>
                              {selectedLockNode.synchronizers.map((lock) => (
                                <article key={lock.lock}>
                                  <strong>{lock.lock}</strong>
                                </article>
                              ))}
                              {!selectedLockNode.synchronizers.length && (
                                <p>
                                  {t("没有已记录的 Ownable Synchronizer。")}
                                </p>
                              )}
                            </section>
                          </div>
                        </>
                      )}
                    </section>
                  </div>
                ) : (
                  <div className="lock-empty">
                    <p className="eyebrow">NO LOCK RELATIONSHIPS</p>
                    <strong>{t("当前没有匹配的锁等待或持有关系。")}</strong>
                  </div>
                )}
              </>
            )}
          </section>

          <div className="thread-summary">
            <p>
              <span>{t("匹配")}</span>
              <strong>{total}</strong>
            </p>
            <p>
              <span>{t("当前页")}</span>
              <strong>{visibleThreads.length}</strong>
            </p>
            <p>
              <span>{t("死锁")}</span>
              <strong>{deadlockCount}</strong>
            </p>
          </div>

          {interruptResult && (
            <section className="interrupt-outcome" aria-live="polite">
              <div>
                <p className="eyebrow">INTERRUPT SIGNAL SENT</p>
                <strong>
                  {t("已向线程 #{id} · {name} 发送中断信号", {
                    id: interruptResult.threadId,
                    name: interruptResult.name,
                  })}
                </strong>
              </div>
              <StatusPill state="ready" label="interruptSent=true" />
            </section>
          )}

          <div ref={threadListRef} className="thread-list" aria-live="polite">
            {visibleThreads.map((thread) => (
              <Disclosure
                key={thread.id}
                className={cn(
                  "thread-row",
                  thread.deadlocked && "thread-row--deadlocked",
                )}
                data-thread-id={thread.id}
                trigger={
                  <>
                    <span className="thread-row__id">#{thread.id}</span>
                    <span className="thread-row__name">
                      <strong>{thread.name}</strong>
                      <small>
                        {thread.daemon ? "DAEMON" : "USER"} · PRIORITY{" "}
                        {thread.priority}
                      </small>
                    </span>
                    <StatusPill
                      state={thread.deadlocked ? "error" : "idle"}
                      label={thread.deadlocked ? t("死锁") : thread.state}
                    />
                    <span className="thread-row__cpu">
                      {formatCpu(thread.cpuTimeNanos)}
                    </span>
                  </>
                }
              >
                <div className="thread-detail">
                  {thread.lockName && (
                    <p>
                      {t("等待锁 {lock}", { lock: thread.lockName })}
                      {thread.lockOwnerId !== null &&
                        t("，持有线程 #{owner}", {
                          owner: thread.lockOwnerId,
                        })}
                    </p>
                  )}
                  {thread.stack.length ? (
                    <ol>
                      {thread.stack.map((frame, index) => (
                        <li key={`${thread.id}-${index}`}>{frame}</li>
                      ))}
                    </ol>
                  ) : (
                    <p>{t("该线程没有可用堆栈。")}</p>
                  )}
                  <div className="thread-control">
                    <header>
                      <div>
                        <p className="eyebrow">CONTROLLED INTERRUPT / R4</p>
                        <strong>{t("仅发送 Java 中断信号。")}</strong>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          Boolean(!threadControlAvailable || interrupting) ||
                          Boolean(previewingThreadId === thread.id)
                        }
                        onClick={() => void previewThreadInterrupt(thread)}
                        aria-busy={Boolean(previewingThreadId === thread.id)}
                      >
                        {Boolean(previewingThreadId === thread.id) && (
                          <Spinner />
                        )}
                        {t("生成中断预览")}
                      </Button>
                    </header>
                    <p>
                      {t(
                        "目标代码可能忽略或清除中断状态；探微不会使用 Thread.stop。",
                      )}
                    </p>
                    {interruptPreview?.threadId === thread.id && (
                      <section className="interrupt-preview">
                        <dl>
                          <div>
                            <dt>{t("精确线程")}</dt>
                            <dd>
                              #{interruptPreview.threadId}
                              {" · "}
                              {interruptPreview.name}
                            </dd>
                          </div>
                          <div>
                            <dt>{t("预检状态")}</dt>
                            <dd>
                              {interruptPreview.state}
                              {" · "}
                              {interruptPreview.daemon ? "DAEMON" : "USER"}
                            </dd>
                          </div>
                          <div>
                            <dt>{t("栈顶")}</dt>
                            <dd>{interruptPreview.stackTop || t("无")}</dd>
                          </div>
                        </dl>
                        <Label>
                          <Checkbox
                            checked={interruptConfirmed}
                            onCheckedChange={(event) =>
                              apply({
                                interruptConfirmed: event === true,
                              })
                            }
                          />
                          <span>
                            {t(
                              "我已核对线程 ID、名称、状态和栈顶，并确认它是预期业务线程。",
                            )}
                          </span>
                        </Label>
                        <Label>
                          <Checkbox
                            checked={interruptConfirmedSecondary}
                            onCheckedChange={(event) =>
                              apply({
                                interruptConfirmedSecondary: event === true,
                              })
                            }
                          />
                          <span>
                            {t(
                              "我再次确认接受业务任务提前结束、回滚或状态不一致的风险。",
                            )}
                          </span>
                        </Label>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={
                            Boolean(
                              !interruptConfirmed ||
                                !interruptConfirmedSecondary,
                            ) || Boolean(interrupting)
                          }
                          onClick={() => void executeThreadInterrupt()}
                          aria-busy={Boolean(interrupting)}
                        >
                          {Boolean(interrupting) && <Spinner />}
                          {t("二次确认并发送中断信号")}
                        </Button>
                      </section>
                    )}
                  </div>
                </div>
              </Disclosure>
            ))}

            {!loading && visibleThreads.length === 0 && (
              <Empty className="empty-panel">
                <p className="eyebrow">NO THREADS</p>
                <p className="empty-panel__title">
                  {t("当前条件没有匹配线程。")}
                </p>
              </Empty>
            )}
          </div>

          <StatePagination
            className="pagination"
            ariaLabel={t("线程分页")}
            previousLabel={t("上一页")}
            nextLabel={t("下一页")}
            previousDisabled={offset === 0 || loading}
            nextDisabled={offset + PAGE_SIZE >= total || loading}
            onPrevious={() => void load(Math.max(0, offset - PAGE_SIZE))}
            onNext={() => void load(offset + PAGE_SIZE)}
            summary={
              <>
              {total === 0 ? 0 : offset + 1}–
              {Math.min(offset + PAGE_SIZE, total)}
              {" / "}
              {total}
              </>
            }
          />
        </>
      )}
    </section>
  );
}
