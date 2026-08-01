import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type {
  ActionResult,
  ArtifactDescriptor,
  CollectAgentArtifactInput,
  TargetConnection,
} from "@shared/contracts";
import { cn } from "@/lib/utils";
import RiskPill from "../components/RiskPill";
import StatusPill from "../components/StatusPill";
import { formatDateTime, formatNumber, t, useLocale } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./TasksView.css";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";

type ActiveTaskKind =
  | "OBSERVATION"
  | "LINE"
  | "MONITOR"
  | "TRACE"
  | "THREAD_POOL_LATENCY"
  | "PROFILE"
  | "JFR";

interface ActiveTask {
  readonly kind: ActiveTaskKind;
  readonly taskId: string;
  readonly state: string;
  readonly title: string;
  readonly detail: string;
  readonly startedAtEpochMillis: number;
  readonly deadlineEpochMillis: number;
  readonly current: number;
  readonly maximum: number;
  readonly dropped: number;
}

interface RetransformOwner {
  readonly ownerId: string;
  readonly kind: string;
  readonly state: string;
  readonly error: string;
  readonly classes: readonly string[];
}

interface SessionResetPreviewItem {
  readonly kind:
    | ActiveTaskKind
    | "CLASS_REDEFINITION"
    | "RETRANSFORM_ROLLBACK";
  readonly identity: string;
  readonly title: string;
  readonly detail: string;
  readonly rollbackCount: number;
}

interface SessionResetPreview {
  readonly fingerprint: string;
  readonly taskCount: number;
  readonly classCount: number;
  readonly retransformCount: number;
  readonly rollbackCount: number;
  readonly artifactPotentialCount: number;
  readonly items: readonly SessionResetPreviewItem[];
}

interface SessionResetResultItem {
  readonly kind: string;
  readonly identity: string;
  readonly title: string;
  readonly state: string;
  readonly error: string;
}

interface SessionResetResult {
  readonly outcome: string;
  readonly succeeded: number;
  readonly failed: number;
  readonly remainingTaskCount: number;
  readonly remainingClassCount: number;
  readonly remainingRetransformCount: number;
  readonly items: readonly SessionResetResultItem[];
}

const REFRESH_INTERVAL_MILLIS = 1_000;
const MAXIMUM_RESET_ITEMS = 128;
const MAXIMUM_RESET_ARTIFACTS = 8;

function parseSafeNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseTasks(
  values: Readonly<Record<string, string>>,
): readonly ActiveTask[] {
  const total = Math.min(parseSafeNumber(values.total), 96);
  return Array.from({ length: total }, (_, index): ActiveTask | null => {
    const prefix = `task.${String(index).padStart(4, "0")}.`;
    const kind = values[`${prefix}kind`];
    const taskId = values[`${prefix}taskId`] ?? "";
    if (
      !taskId ||
      (kind !== "OBSERVATION" &&
        kind !== "LINE" &&
        kind !== "MONITOR" &&
        kind !== "TRACE" &&
        kind !== "THREAD_POOL_LATENCY" &&
        kind !== "PROFILE" &&
        kind !== "JFR")
    ) {
      return null;
    }
    return {
      kind,
      taskId,
      state: values[`${prefix}state`] ?? "RUNNING",
      title: values[`${prefix}title`] ?? taskId,
      detail: values[`${prefix}detail`] ?? "",
      startedAtEpochMillis: parseSafeNumber(
        values[`${prefix}startedAtEpochMillis`],
      ),
      deadlineEpochMillis: parseSafeNumber(
        values[`${prefix}deadlineEpochMillis`],
      ),
      current: parseSafeNumber(values[`${prefix}current`]),
      maximum: parseSafeNumber(values[`${prefix}maximum`]),
      dropped: parseSafeNumber(values[`${prefix}dropped`]),
    };
  }).filter((task): task is ActiveTask => task !== null);
}

function parseRetransformOwners(
  values: Readonly<Record<string, string>>,
): readonly RetransformOwner[] {
  const total = Math.min(parseSafeNumber(values.total), 64);
  return Array.from(
    { length: total },
    (_, index): RetransformOwner | null => {
      const prefix = `owner.${String(index).padStart(4, "0")}.`;
      const ownerId = values[`${prefix}ownerId`] ?? "";
      const classCount = Math.min(
        parseSafeNumber(values[`${prefix}class.count`]),
        64,
      );
      if (!/^[A-Z_]+:[0-9a-f-]{36}$/u.test(ownerId)) {
        return null;
      }
      return {
        ownerId,
        kind: values[`${prefix}kind`] ?? "UNKNOWN",
        state: values[`${prefix}state`] ?? "UNKNOWN",
        error: values[`${prefix}error`] ?? "",
        classes: Array.from(
          { length: classCount },
          (_, classIndex) =>
            values[
              `${prefix}class.${String(classIndex).padStart(4, "0")}.name`
            ] ?? "",
        ).filter(Boolean),
      };
    },
  ).filter((owner): owner is RetransformOwner => owner !== null);
}

function parseSessionResetPreview(
  values: Readonly<Record<string, string>>,
): SessionResetPreview {
  const tasks = Array.from(
    {
      length: Math.min(
        parseSafeNumber(values["task.total"]),
        MAXIMUM_RESET_ITEMS,
      ),
    },
    (_, index): SessionResetPreviewItem | null => {
      const prefix = `task.${String(index).padStart(4, "0")}.`;
      const kind = values[`${prefix}kind`];
      const identity = values[`${prefix}taskId`] ?? "";
      if (
        !identity ||
        (kind !== "OBSERVATION" &&
          kind !== "LINE" &&
          kind !== "MONITOR" &&
          kind !== "TRACE" &&
          kind !== "THREAD_POOL_LATENCY" &&
          kind !== "PROFILE" &&
          kind !== "JFR")
      ) {
        return null;
      }
      return {
        kind,
        identity,
        title: values[`${prefix}title`] ?? identity,
        detail: values[`${prefix}detail`] ?? "",
        rollbackCount: 0,
      };
    },
  ).filter((item): item is SessionResetPreviewItem => item !== null);
  const classes = Array.from(
    {
      length: Math.min(
        parseSafeNumber(values["class.total"]),
        MAXIMUM_RESET_ITEMS - tasks.length,
      ),
    },
    (_, index): SessionResetPreviewItem | null => {
      const prefix = `class.${String(index).padStart(4, "0")}.`;
      const identity = values[`${prefix}name`] ?? "";
      if (!identity) {
        return null;
      }
      return {
        kind: "CLASS_REDEFINITION",
        identity,
        title: values[`${prefix}classLoader`] ?? "",
        detail: values[`${prefix}baselineSha256`] ?? "",
        rollbackCount: parseSafeNumber(values[`${prefix}rollbackCount`]),
      };
    },
  ).filter((item): item is SessionResetPreviewItem => item !== null);
  const retransforms = Array.from(
    {
      length: Math.min(
        parseSafeNumber(values["retransform.total"]),
        MAXIMUM_RESET_ITEMS - tasks.length - classes.length,
      ),
    },
    (_, index): SessionResetPreviewItem | null => {
      const prefix = `retransform.${String(index).padStart(4, "0")}.`;
      const identity = values[`${prefix}ownerId`] ?? "";
      const classCount = Math.min(
        parseSafeNumber(values[`${prefix}class.count`]),
        64,
      );
      if (!/^[A-Z_]+:[0-9a-f-]{36}$/u.test(identity)) {
        return null;
      }
      const classes = Array.from(
        { length: classCount },
        (_, classIndex) =>
          values[
            `${prefix}class.${String(classIndex).padStart(4, "0")}.name`
          ] ?? "",
      ).filter(Boolean);
      return {
        kind: "RETRANSFORM_ROLLBACK",
        identity,
        title: values[`${prefix}kind`] ?? "UNKNOWN",
        detail: values[`${prefix}error`] || classes.join(" · "),
        rollbackCount: 0,
      };
    },
  ).filter((item): item is SessionResetPreviewItem => item !== null);
  const fingerprint = values.fingerprint ?? "";
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error(t("Agent 返回的会话恢复指纹无效"));
  }
  return {
    fingerprint,
    taskCount: parseSafeNumber(values["task.total"]),
    classCount: parseSafeNumber(values["class.total"]),
    retransformCount: parseSafeNumber(values["retransform.total"]),
    rollbackCount: parseSafeNumber(values["rollback.total"]),
    artifactPotentialCount: parseSafeNumber(values["artifactPotential.total"]),
    items: [...tasks, ...retransforms, ...classes],
  };
}

function parseSessionResetResult(
  values: Readonly<Record<string, string>>,
): SessionResetResult {
  const total = Math.min(
    parseSafeNumber(values["item.total"]),
    MAXIMUM_RESET_ITEMS,
  );
  return {
    outcome: values.outcome ?? "PARTIAL",
    succeeded: parseSafeNumber(values.succeeded),
    failed: parseSafeNumber(values.failed),
    remainingTaskCount: parseSafeNumber(values.remainingTaskCount),
    remainingClassCount: parseSafeNumber(values.remainingClassCount),
    remainingRetransformCount: parseSafeNumber(
      values.remainingRetransformCount,
    ),
    items: Array.from(
      { length: total },
      (_, index): SessionResetResultItem | null => {
        const prefix = `item.${String(index).padStart(4, "0")}.`;
        const identity = values[`${prefix}identity`] ?? "";
        if (!identity) {
          return null;
        }
        return {
          kind: values[`${prefix}kind`] ?? "UNKNOWN",
          identity,
          title: values[`${prefix}title`] ?? "",
          state: values[`${prefix}state`] ?? "UNKNOWN",
          error: values[`${prefix}error`] ?? "",
        };
      },
    ).filter((item): item is SessionResetResultItem => item !== null),
  };
}

function clearRestoredTask(task: ActiveTask): void {
  const storageKey =
    task.kind === "PROFILE"
      ? "tanwei.profile"
      : task.kind === "MONITOR"
        ? "tanwei.monitor"
        : task.kind === "TRACE"
          ? "tanwei.trace"
          : null;
  if (!storageKey) {
    return;
  }
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as {
      readonly taskId?: string;
    } | null;
    if (stored?.taskId === task.taskId) {
      sessionStorage.removeItem(storageKey);
    }
  } catch {
    sessionStorage.removeItem(storageKey);
  }
}

function clearSessionTaskPointers(): void {
  for (const key of ["tanwei.profile", "tanwei.monitor", "tanwei.trace"]) {
    sessionStorage.removeItem(key);
  }
}

async function collectArtifact(
  token: string,
  expectedSize: number,
  type: CollectAgentArtifactInput["type"],
): Promise<ArtifactDescriptor> {
  const targetId = useTargetsStore.getState().selectedTargetId;
  if (!targetId) {
    throw new Error(t("目标连接已经断开"));
  }
  const response = await window.tanwei.collectAgentArtifact({
    targetId,
    token,
    type,
    expectedSize,
  });
  if (!response.ok || !response.value) {
    throw new Error(response.errorMessage ?? t("无法保存诊断制品"));
  }
  return response.value;
}

function resetKindLabel(kind: string): string {
  if (kind === "CLASS_REDEFINITION") {
    return t("类替换");
  }
  if (kind === "RETRANSFORM_ROLLBACK") {
    return t("增强回滚");
  }
  if (
    kind === "OBSERVATION" ||
    kind === "LINE" ||
    kind === "MONITOR" ||
    kind === "TRACE" ||
    kind === "THREAD_POOL_LATENCY" ||
    kind === "PROFILE" ||
    kind === "JFR"
  ) {
    return kindLabel(kind);
  }
  return kind;
}

function kindLabel(kind: ActiveTaskKind): string {
  if (kind === "OBSERVATION") {
    return t("方法观测");
  }
  if (kind === "LINE") {
    return t("源码行探针");
  }
  if (kind === "PROFILE") {
    return t("性能剖析");
  }
  if (kind === "MONITOR") {
    return t("方法监控");
  }
  if (kind === "TRACE") {
    return t("跨类追踪");
  }
  if (kind === "THREAD_POOL_LATENCY") {
    return t("线程池时长归因");
  }
  return "JFR";
}

function metricLabel(task: ActiveTask): string {
  if (task.kind === "OBSERVATION" || task.kind === "LINE") {
    return t("已捕获 {current} / {maximum} · 丢弃 {dropped}", {
      current: formatNumber(task.current),
      maximum: formatNumber(task.maximum),
      dropped: formatNumber(task.dropped),
    });
  }
  if (task.kind === "PROFILE") {
    return t("样本 {current} · 丢弃 {dropped}", {
      current: formatNumber(task.current),
      dropped: formatNumber(task.dropped),
    });
  }
  if (task.kind === "MONITOR") {
    return t("完成调用 {current} · 异常 {dropped}", {
      current: formatNumber(task.current),
      dropped: formatNumber(task.dropped),
    });
  }
  if (task.kind === "TRACE") {
    return t("已捕获 {current} / {maximum} · 截断 {dropped}", {
      current: formatNumber(task.current),
      maximum: formatNumber(task.maximum),
      dropped: formatNumber(task.dropped),
    });
  }
  if (task.kind === "THREAD_POOL_LATENCY") {
    return t("完成任务 {current} · 跟踪上限 {maximum} · 丢弃 {dropped}", {
      current: formatNumber(task.current),
      maximum: formatNumber(task.maximum),
      dropped: formatNumber(task.dropped),
    });
  }
  return t("持续记录，停止后保存为本地制品");
}

export default function TasksView() {
  useLocale();
  const navigate = useNavigate();
  const selectedTargetId = useTargetsStore((s) => s.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const [tasks, setTasks] = useState<readonly ActiveTask[]>([]);
  const [retransformOwners, setRetransformOwners] = useState<
    readonly RetransformOwner[]
  >([]);
  const [retryConfirmedOwnerId, setRetryConfirmedOwnerId] = useState<
    string | null
  >(null);
  const [retryingOwnerId, setRetryingOwnerId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskIdState] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(null);
  const [cancellationConfirmed, setCancellationConfirmed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [completionMessage, setCompletionMessage] = useState<string | null>(
    null,
  );
  const [artifact, setArtifact] = useState<ArtifactDescriptor | null>(null);
  const [resetArtifacts, setResetArtifacts] = useState<
    readonly ArtifactDescriptor[]
  >([]);
  const [resetPreview, setResetPreview] = useState<SessionResetPreview | null>(
    null,
  );
  const [resetResult, setResetResult] = useState<SessionResetResult | null>(
    null,
  );
  const [resetLoading, setResetLoading] = useState(false);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [resetSecondaryConfirmed, setResetSecondaryConfirmed] = useState(false);
  const [nowEpochMillis, setNowEpochMillis] = useState(Date.now());
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshInFlightRef = useRef(false);
  const selectedTaskIdRef = useRef<string | null>(null);

  function setSelectedTaskId(value: string | null): void {
    selectedTaskIdRef.current = value;
    setSelectedTaskIdState(value);
  }

  const tasksCapability = connection?.capabilities.find(
    (capability) => capability.id === "tasks",
  );
  const retransformCapability = connection?.capabilities.find(
    (capability) => capability.id === "retransform",
  );
  const selectedTask =
    tasks.find((task) => task.taskId === selectedTaskId) ?? null;
  const resetHasManagedState =
    (resetPreview?.taskCount ?? 0) +
      (resetPreview?.classCount ?? 0) +
      (resetPreview?.retransformCount ?? 0) >
    0;

  async function refreshTasks(showLoading = false): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const targetId = targetsState.selectedTargetId;
    const currentConnection = selectConnection(targetsState);
    const capability = currentConnection?.capabilities.find(
      (item) => item.id === "tasks",
    );
    if (
      refreshInFlightRef.current ||
      !targetId ||
      currentConnection?.state !== "READY" ||
      capability?.state !== "AVAILABLE"
    ) {
      return;
    }
    refreshInFlightRef.current = true;
    if (showLoading) {
      setLoading(true);
    }
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "tasks.list",
        parameters: {},
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取活动任务"),
        );
        return;
      }
      const nextTasks = parseTasks(response.value.values);
      setTasks(nextTasks);
      if (retransformCapability?.state === "AVAILABLE") {
        const lifecycleResponse = await window.tanwei.executeAction({
          targetId,
          actionId: "retransform.status",
          parameters: {},
        });
        if (
          lifecycleResponse.ok &&
          lifecycleResponse.value?.status === "SUCCEEDED"
        ) {
          const owners = parseRetransformOwners(
            lifecycleResponse.value.values,
          );
          setRetransformOwners(owners);
          if (
            retryConfirmedOwnerId &&
            !owners.some(
              (owner) =>
                owner.ownerId === retryConfirmedOwnerId &&
                owner.state === "ROLLBACK_FAILED",
            )
          ) {
            setRetryConfirmedOwnerId(null);
          }
        }
      } else {
        setRetransformOwners([]);
      }
      setNowEpochMillis(Date.now());
      const currentSelectedTaskId = selectedTaskIdRef.current;
      if (
        currentSelectedTaskId &&
        !nextTasks.some((task) => task.taskId === currentSelectedTaskId)
      ) {
        setSelectedTaskId(null);
        setCancellationConfirmed(false);
      }
      const firstTask = nextTasks[0];
      if (!selectedTaskIdRef.current && firstTask) {
        setSelectedTaskId(firstTask.taskId);
      }
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取活动任务"),
      );
    } finally {
      refreshInFlightRef.current = false;
      setLoading(false);
    }
  }

  async function retryRetransformRollback(ownerId: string): Promise<void> {
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!targetId || retryConfirmedOwnerId !== ownerId || retryingOwnerId) {
      return;
    }
    setRetryingOwnerId(ownerId);
    setErrorMessage(null);
    setCompletionMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "retransform.retry",
        parameters: { ownerId, confirmed: "true" },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("增强回滚重试失败"),
        );
        return;
      }
      setRetryConfirmedOwnerId(null);
      setCompletionMessage(t("增强所有权已释放：{ownerId}", { ownerId }));
      await refreshTasks(true);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("增强回滚重试失败"),
      );
    } finally {
      setRetryingOwnerId(null);
    }
  }

  function selectTask(task: ActiveTask): void {
    setSelectedTaskId(task.taskId);
    setCancellationConfirmed(false);
    setCompletionMessage(null);
  }

  async function collectResult(
    result: ActionResult,
    type: CollectAgentArtifactInput["type"],
  ): Promise<void> {
    const token = result.values.token;
    const expectedSize = Number(result.values.size);
    if (!token || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw new Error(t("Agent返回的制品描述无效"));
    }
    setArtifact(await collectArtifact(token, expectedSize, type));
  }

  async function cancelSelectedTask(): Promise<void> {
    const task = selectedTask;
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!task || !targetId || !cancellationConfirmed) {
      return;
    }
    setCancellingTaskId(task.taskId);
    setErrorMessage(null);
    setCompletionMessage(null);
    setArtifact(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "tasks.cancel",
        parameters: {
          kind: task.kind,
          taskId: task.taskId,
          confirmed: "true",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法停止活动任务"),
        );
        return;
      }
      if (response.value.values.token) {
        await collectResult(
          response.value,
          task.kind === "PROFILE" ? "PROFILE" : "JFR",
        );
      }
      clearRestoredTask(task);
      setCompletionMessage(
        t("任务已停止：{taskId}", {
          taskId: task.taskId,
        }),
      );
      setCancellationConfirmed(false);
      await refreshTasks();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法停止活动任务"),
      );
    } finally {
      setCancellingTaskId(null);
    }
  }

  async function scanSessionReset(): Promise<void> {
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!targetId || resetLoading) {
      return;
    }
    setResetLoading(true);
    setErrorMessage(null);
    setCompletionMessage(null);
    setResetResult(null);
    setResetArtifacts([]);
    setResetConfirmed(false);
    setResetSecondaryConfirmed(false);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "session.reset.preview",
        parameters: {},
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法扫描探微会话状态"),
        );
        setResetPreview(null);
        return;
      }
      setResetPreview(parseSessionResetPreview(response.value.values));
    } catch (error) {
      setResetPreview(null);
      setErrorMessage(
        error instanceof Error ? error.message : t("无法扫描探微会话状态"),
      );
    } finally {
      setResetLoading(false);
    }
  }

  async function executeSessionReset(): Promise<void> {
    const preview = resetPreview;
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (
      !targetId ||
      !preview ||
      !resetHasManagedState ||
      !resetConfirmed ||
      !resetSecondaryConfirmed ||
      resetLoading
    ) {
      return;
    }
    setResetLoading(true);
    setErrorMessage(null);
    setCompletionMessage(null);
    setResetResult(null);
    setResetArtifacts([]);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "session.reset",
        parameters: {
          expectedFingerprint: preview.fingerprint,
          confirmed: "true",
          confirmedSecondary: "true",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法恢复探微会话"),
        );
        return;
      }
      const nextResetResult = parseSessionResetResult(response.value.values);
      setResetResult(nextResetResult);
      const collected: ArtifactDescriptor[] = [];
      const artifactTotal = Math.min(
        parseSafeNumber(response.value.values["artifact.total"]),
        MAXIMUM_RESET_ARTIFACTS,
      );
      const collectionErrors: string[] = [];
      for (let index = 0; index < artifactTotal; index += 1) {
        const prefix = `artifact.${String(index).padStart(4, "0")}.`;
        const token = response.value.values[`${prefix}token`] ?? "";
        const expectedSize = Number(response.value.values[`${prefix}size`]);
        const type = response.value.values[`${prefix}type`];
        if (
          !token ||
          !Number.isSafeInteger(expectedSize) ||
          expectedSize <= 0 ||
          (type !== "PROFILE" && type !== "JFR")
        ) {
          collectionErrors.push(t("Agent返回的制品描述无效"));
          continue;
        }
        try {
          collected.push(await collectArtifact(token, expectedSize, type));
        } catch (error) {
          collectionErrors.push(
            error instanceof Error ? error.message : t("无法保存诊断制品"),
          );
        }
      }
      setResetArtifacts(collected);
      clearSessionTaskPointers();
      setResetConfirmed(false);
      setResetSecondaryConfirmed(false);
      setCompletionMessage(
        collectionErrors.length === 0
          ? t("探微会话恢复完成：{succeeded} 成功，{failed} 冲突", {
              succeeded: nextResetResult.succeeded,
              failed: nextResetResult.failed,
            })
          : t("会话已恢复，但有 {count} 个制品未能回收到本地", {
              count: collectionErrors.length,
            }),
      );
      setResetPreview(null);
      await refreshTasks();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法恢复探微会话"),
      );
    } finally {
      setResetLoading(false);
    }
  }

  function deadlineLabel(task: ActiveTask): string {
    if (task.deadlineEpochMillis <= 0) {
      return t("手动停止");
    }
    const remainingMillis = Math.max(
      0,
      task.deadlineEpochMillis - nowEpochMillis,
    );
    return t("约 {seconds} 秒后自动结束", {
      seconds: Math.ceil(remainingMillis / 1_000),
    });
  }

  const refreshTasksRef = useRef(refreshTasks);
  useEffect(() => {
    refreshTasksRef.current = refreshTasks;
  });

  const watchKeyRef = useRef<readonly [string | null, TargetConnection | null]>(
    [selectedTargetId, connection],
  );
  useEffect(() => {
    const [previousTargetId, previousConnection] = watchKeyRef.current;
    watchKeyRef.current = [selectedTargetId, connection];
    if (
      previousTargetId === selectedTargetId &&
      previousConnection === connection
    ) {
      return;
    }
    setTasks([]);
    setRetransformOwners([]);
    setRetryConfirmedOwnerId(null);
    setSelectedTaskId(null);
    setCancellationConfirmed(false);
    setArtifact(null);
    setResetArtifacts([]);
    setResetPreview(null);
    setResetResult(null);
    setResetConfirmed(false);
    setResetSecondaryConfirmed(false);
    setCompletionMessage(null);
    void refreshTasksRef.current(true);
  }, [selectedTargetId, connection]);

  useEffect(() => {
    void refreshTasksRef.current(true);
    refreshTimerRef.current = setInterval(
      () => void refreshTasksRef.current(),
      REFRESH_INTERVAL_MILLIS,
    );
    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  return (
    <section className="page tasks-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">ACTIVE TASKS</p>
          <h1>{t("持续任务，一处收束。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "统一查看探微创建的观测、行探针、Trace、监控、线程池归因、采样与 JFR 任务；停止操作绑定精确任务身份，采样与记录结果会先回收到本地制品库。",
          )}
        </p>
      </header>

      {connection?.state !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">{t("连接目标后管理活动任务。")}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate("/targets")}
          >
            {t("选择目标")}
          </Button>
        </Empty>
      ) : tasksCapability?.state !== "AVAILABLE" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">CAPABILITY UNAVAILABLE</p>
          <p className="empty-panel__title">
            {t("当前 Agent 不支持统一任务中心。")}
          </p>
          <p>
            {tasksCapability?.reason ?? t("请重新连接目标以加载最新 Agent。")}
          </p>
        </Empty>
      ) : (
        <>
          {errorMessage ? (
            <Alert variant="destructive">
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          ) : completionMessage ? (
            <Alert className="task-notice" role="status">
              <AlertDescription>{completionMessage}</AlertDescription>
            </Alert>
          ) : null}

          <div className="task-inspector">
            <section
              className="task-center-list"
              aria-label={t("活动任务列表")}
            >
              <header>
                <div>
                  <p className="eyebrow">TARGET OWNED</p>
                  <strong>
                    {t("{count} 个活动任务", { count: tasks.length })}
                  </strong>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void refreshTasks(true)}
                  aria-busy={Boolean(loading)}
                  disabled={Boolean(loading)}
                >
                  {Boolean(loading) && <Spinner />}
                  {t("刷新")}
                </Button>
              </header>

              {tasks.length > 0 ? (
                <div className="task-list__items">
                  {tasks.map((task) => (
                    <Button
                      variant="ghost"
                      key={task.taskId}
                      type="button"
                      className={cn(
                        "task-row",
                        task.taskId === selectedTaskId && "task-row--selected",
                      )}
                      onClick={() => selectTask(task)}
                    >
                      <span>
                        <strong>{task.title}</strong>
                        <small>{task.detail}</small>
                      </span>
                      <span>{kindLabel(task.kind)}</span>
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="task-list__empty">
                  <p className="eyebrow">NO ACTIVE TASKS</p>
                  <strong>
                    {loading
                      ? t("正在读取活动任务…")
                      : t("当前没有由探微创建的持续任务。")}
                  </strong>
                  <p>
                    {t(
                      "可从观测、行探针、Trace、监控、线程池或剖析页面启动一个有界任务。",
                    )}
                  </p>
                </div>
              )}
            </section>

            <section className="task-center-detail">
              {selectedTask ? (
                <>
                  <header className="task-detail__header">
                    <div>
                      <p className="eyebrow">{kindLabel(selectedTask.kind)}</p>
                      <h2>{selectedTask.title}</h2>
                      <p>{selectedTask.detail}</p>
                    </div>
                    <StatusPill state="working" label={selectedTask.state} />
                  </header>

                  <dl className="task-facts">
                    <div>
                      <dt>{t("任务标识")}</dt>
                      <dd>
                        <code>{selectedTask.taskId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{t("开始时间")}</dt>
                      <dd>
                        {formatDateTime(selectedTask.startedAtEpochMillis)}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("结束边界")}</dt>
                      <dd>{deadlineLabel(selectedTask)}</dd>
                    </div>
                    <div>
                      <dt>{t("当前进度")}</dt>
                      <dd>{metricLabel(selectedTask)}</dd>
                    </div>
                  </dl>

                  <section className="task-cancel">
                    <div>
                      <p className="eyebrow">EXACT CANCELLATION / R1</p>
                      <h3>{t("只停止这个任务。")}</h3>
                      <p>
                        {selectedTask.kind === "OBSERVATION" ||
                        selectedTask.kind === "LINE" ||
                        selectedTask.kind === "MONITOR" ||
                        selectedTask.kind === "TRACE" ||
                        selectedTask.kind === "THREAD_POOL_LATENCY"
                          ? t(
                              "停止后会移除该任务对应的字节码增强，不影响其他增强任务。",
                            )
                          : t(
                              "停止后会先完成报告或记录，再下载并校验本地制品。",
                            )}
                      </p>
                    </div>
                    <Label>
                      <Checkbox
                        checked={cancellationConfirmed}
                        onCheckedChange={(event) =>
                          setCancellationConfirmed(event === true)
                        }
                      />
                      <span>
                        {t("我确认停止任务 {taskId}", {
                          taskId: selectedTask.taskId,
                        })}
                      </span>
                    </Label>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        Boolean(!cancellationConfirmed) ||
                        Boolean(cancellingTaskId === selectedTask.taskId)
                      }
                      onClick={() => void cancelSelectedTask()}
                      aria-busy={Boolean(
                        cancellingTaskId === selectedTask.taskId,
                      )}
                    >
                      {Boolean(cancellingTaskId === selectedTask.taskId) && (
                        <Spinner />
                      )}
                      {t("停止所选任务")}
                    </Button>
                  </section>
                </>
              ) : (
                <div className="task-detail__empty">
                  <p className="eyebrow">NO SELECTION</p>
                  <h2>{t("选择一个活动任务查看生命周期。")}</h2>
                  <p>
                    {t(
                      "列表每秒刷新一次，仅包含探微自身创建且仍在运行的任务。",
                    )}
                  </p>
                </div>
              )}
            </section>
          </div>

          {retransformCapability?.state === "AVAILABLE" && (
            <section className="retransform-lifecycle">
            <header className="retransform-lifecycle__header">
              <div>
                <p className="eyebrow">RETRANSFORM OWNERSHIP</p>
                <h2>{t("增强类的所有权可见、可恢复。")}</h2>
                <p>
                  {t(
                    "活动增强按类身份互斥；若精确回滚失败，类会继续被 claim，直到显式重试成功。",
                  )}
                </p>
              </div>
              <StatusPill
                state={
                  retransformOwners.some(
                    (owner) => owner.state === "ROLLBACK_FAILED",
                  )
                    ? "error"
                    : "ready"
                }
                label={t("{count} 个持有者", {
                  count: retransformOwners.length,
                })}
              />
            </header>
            {retransformOwners.length > 0 ? (
              <div className="retransform-lifecycle__items">
                {retransformOwners.map((owner) => (
                  <article key={owner.ownerId}>
                    <div>
                      <span>{owner.kind}</span>
                      <strong>{owner.ownerId}</strong>
                      <small>
                        {owner.error || owner.classes.join(" · ")}
                      </small>
                    </div>
                    <div className="retransform-lifecycle__state">
                      <StatusPill
                        state={
                          owner.state === "ROLLBACK_FAILED"
                            ? "error"
                            : "working"
                        }
                        label={owner.state}
                      />
                      {owner.state === "ROLLBACK_FAILED" && (
                        <>
                          <Label>
                            <Checkbox
                              checked={retryConfirmedOwnerId === owner.ownerId}
                              onCheckedChange={(checked) =>
                                setRetryConfirmedOwnerId(
                                  checked === true ? owner.ownerId : null,
                                )
                              }
                            />
                            <span>{t("确认重试精确回滚")}</span>
                          </Label>
                          <RiskPill level="R2" />
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={
                              retryConfirmedOwnerId !== owner.ownerId ||
                              retryingOwnerId !== null
                            }
                            onClick={() =>
                              void retryRetransformRollback(owner.ownerId)
                            }
                            aria-busy={retryingOwnerId === owner.ownerId}
                          >
                            {retryingOwnerId === owner.ownerId && <Spinner />}
                            {t("重试并释放 claim")}
                          </Button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="retransform-lifecycle__empty">
                <strong>{t("当前没有被诊断增强持有的类。")}</strong>
              </div>
            )}
            </section>
          )}

          <section className="session-reset">
            <header className="session-reset__header">
              <div>
                <p className="eyebrow">MANAGED SESSION RESET</p>
                <h2>{t("把探微带来的运行时状态安全收回。")}</h2>
                <p>
                  {t(
                    "先扫描当前任务、失败的增强回滚和类替换回滚链，再用同一份指纹执行；状态一旦变化，Agent 会拒绝旧预检。",
                  )}
                </p>
              </div>
              <div className="session-reset__actions">
                <RiskPill level="R4" />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void scanSessionReset()}
                  aria-busy={Boolean(resetLoading)}
                  disabled={Boolean(resetLoading)}
                >
                  {Boolean(resetLoading) && <Spinner />}
                  {t("扫描会话状态")}
                </Button>
              </div>
            </header>

            {resetResult && (
              <div className="session-reset__result">
                <div>
                  <p className="eyebrow">RESET RESULT</p>
                  <h3>
                    {resetResult.outcome === "RESET"
                      ? t("已恢复到无探微增强状态。")
                      : t("恢复完成，但存在需要人工处理的冲突。")}
                  </h3>
                  <p>
                    {t(
                      "{succeeded} 项成功 · {failed} 项冲突 · 剩余 {tasks} 个任务 / {claims} 个增强 claim / {classes} 个类回滚",
                      {
                        succeeded: resetResult.succeeded,
                        failed: resetResult.failed,
                        tasks: resetResult.remainingTaskCount,
                        classes: resetResult.remainingClassCount,
                        claims: resetResult.remainingRetransformCount,
                      },
                    )}
                  </p>
                </div>
                <div className="session-reset__items">
                  {resetResult.items.map((item) => (
                    <article key={`${item.kind}:${item.identity}`}>
                      <div>
                        <span>{resetKindLabel(item.kind)}</span>
                        <strong>{item.identity}</strong>
                        <small>{item.error || item.title}</small>
                      </div>
                      <StatusPill
                        state={
                          item.state === "FAILED" || item.state === "CONFLICT"
                            ? "error"
                            : "ready"
                        }
                        label={item.state}
                      />
                    </article>
                  ))}
                </div>
              </div>
            )}

            {resetPreview ? (
              <div className="session-reset__preview">
                <dl className="session-reset__facts">
                  <div>
                    <dt>{t("活动任务")}</dt>
                    <dd>{resetPreview.taskCount}</dd>
                  </div>
                  <div>
                    <dt>{t("待恢复类")}</dt>
                    <dd>{resetPreview.classCount}</dd>
                  </div>
                  <div>
                    <dt>{t("失败增强回滚")}</dt>
                    <dd>{resetPreview.retransformCount}</dd>
                  </div>
                  <div>
                    <dt>{t("回滚节点")}</dt>
                    <dd>{resetPreview.rollbackCount}</dd>
                  </div>
                  <div>
                    <dt>{t("预计制品")}</dt>
                    <dd>{resetPreview.artifactPotentialCount}</dd>
                  </div>
                </dl>

                {resetPreview.items.length > 0 ? (
                  <div className="session-reset__items">
                    {resetPreview.items.map((item) => (
                      <article key={`${item.kind}:${item.identity}`}>
                        <div>
                          <span>{resetKindLabel(item.kind)}</span>
                          <strong>{item.identity}</strong>
                          <small>
                            {item.kind === "CLASS_REDEFINITION"
                              ? t("{count} 个回滚节点 · {loader}", {
                                  count: item.rollbackCount,
                                  loader: item.title,
                                })
                              : item.detail}
                          </small>
                        </div>
                        <StatusPill state="idle" label={t("纳入恢复")} />
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="session-reset__clean">
                    <p className="eyebrow">CLEAN SESSION</p>
                    <strong>{t("当前没有需要恢复的探微状态。")}</strong>
                  </div>
                )}

                <div className="session-reset__boundary">
                  <p className="eyebrow">STRICT BOUNDARY</p>
                  <p>
                    {t(
                      "不会回滚系统属性、日志级别、VM Option、MBean 值或第三方增强；若类定义已被外部修改，只报告冲突，不覆盖。",
                    )}
                  </p>
                </div>

                {resetHasManagedState && (
                  <div className="session-reset__confirmations">
                    <Label>
                      <Checkbox
                        checked={resetConfirmed}
                        onCheckedChange={(event) =>
                          setResetConfirmed(event === true)
                        }
                      />
                      <span>
                        {t(
                          "我确认停止预检中列出的全部探微任务，并回收 Profile / JFR 制品。",
                        )}
                      </span>
                    </Label>
                    <Label>
                      <Checkbox
                        checked={resetSecondaryConfirmed}
                        onCheckedChange={(event) =>
                          setResetSecondaryConfirmed(event === true)
                        }
                      />
                      <span>
                        {t(
                          "我确认重试失败的增强回滚，并恢复探微仍持有回滚链的类；遇到指纹漂移或外部变更时保留现状。",
                        )}
                      </span>
                    </Label>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        Boolean(!resetConfirmed || !resetSecondaryConfirmed) ||
                        Boolean(resetLoading)
                      }
                      onClick={() => void executeSessionReset()}
                      aria-busy={Boolean(resetLoading)}
                    >
                      {Boolean(resetLoading) && <Spinner />}
                      {t("执行统一恢复")}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              !resetResult && (
                <div className="session-reset__empty">
                  <p className="eyebrow">PREVIEW REQUIRED</p>
                  <strong>{t("扫描后才会开放恢复操作。")}</strong>
                  <p>
                    {t(
                      "扫描是只读操作，会生成一次性状态指纹，不会停止任务或修改目标 JVM。",
                    )}
                  </p>
                </div>
              )
            )}
          </section>

          {artifact && (
            <section className="task-artifact">
              <div>
                <p className="eyebrow">ARTIFACT READY</p>
                <strong>{artifact.name}</strong>
                <p>
                  {(artifact.size / 1024 / 1024).toFixed(2)} MiB · SHA-256{" "}
                  {artifact.sha256}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void navigate("/artifacts")}
              >
                {t("查看制品")}
              </Button>
            </section>
          )}
          {resetArtifacts.length > 0 && (
            <section className="task-artifact">
              <div>
                <p className="eyebrow">RESET ARTIFACTS</p>
                <strong>
                  {t("已回收并校验 {count} 个诊断制品", {
                    count: resetArtifacts.length,
                  })}
                </strong>
                <p>{resetArtifacts.map((item) => item.name).join(" · ")}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void navigate("/artifacts")}
              >
                {t("查看制品")}
              </Button>
            </section>
          )}
        </>
      )}
    </section>
  );
}
