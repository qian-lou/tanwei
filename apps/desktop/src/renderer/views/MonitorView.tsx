import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type {
  ActionResult,
  ArtifactDescriptor,
  MethodDescriptor,
  MonitorWindowSample,
  ObservationTaskState,
} from "@shared/contracts";
import StatusPill from "../components/StatusPill";
import { formatDateTime, formatNumber, t, useLocale } from "../i18n";
import {
  type ObservationSelection,
  useObservationsStore,
} from "../stores/observations";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./MonitorView.css";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";

type MonitorWindow = MonitorWindowSample;

interface PersistedMonitor {
  readonly targetId: string;
  readonly taskId: string;
  readonly target: ObservationSelection;
  readonly intervalMillis: number;
  readonly minimumDurationMillis?: number;
  readonly deadlineEpochMillis: number;
  readonly method: string;
}

const WINDOW_LIMIT = 300;
const STORAGE_KEY = "tanwei.monitor";

function actionParameters(
  target: ObservationSelection,
): Readonly<Record<string, string>> {
  return {
    className: target.className,
    classLoader: target.classLoader,
    methodName: target.method.name,
    parameterTypes: target.method.parameterTypes.join(","),
  };
}

function safeNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseWindows(
  values: Readonly<Record<string, string>>,
): readonly MonitorWindow[] {
  const count = Math.min(100, Math.floor(safeNumber(values["window.count"])));
  return Array.from({ length: count }, (_, index): MonitorWindow | null => {
    const prefix = `window.${String(index).padStart(4, "0")}.`;
    const sequence = safeNumber(values[`${prefix}sequence`]);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      return null;
    }
    return {
      sequence,
      startedAtEpochMillis: safeNumber(values[`${prefix}startedAtEpochMillis`]),
      endedAtEpochMillis: safeNumber(values[`${prefix}endedAtEpochMillis`]),
      minimumDurationMillis: safeNumber(
        values[`${prefix}minimumDurationMillis`],
      ),
      calls: safeNumber(values[`${prefix}calls`]),
      failures: safeNumber(values[`${prefix}failures`]),
      durationNanos: safeNumber(values[`${prefix}durationNanos`]),
      maximumDurationNanos: safeNumber(values[`${prefix}maximumDurationNanos`]),
      p95DurationNanos: safeNumber(values[`${prefix}p95DurationNanos`]),
      p99DurationNanos: safeNumber(values[`${prefix}p99DurationNanos`]),
    };
  }).filter((window): window is MonitorWindow => window !== null);
}

function validSelection(
  selection: ObservationSelection | null | undefined,
): selection is ObservationSelection {
  const method = selection?.method as MethodDescriptor | undefined;
  return Boolean(
    selection?.className &&
      selection.classLoader &&
      method?.name &&
      Array.isArray(method.parameterTypes),
  );
}

function windowAverageMillis(sample: MonitorWindow): number {
  return sample.calls > 0 ? sample.durationNanos / sample.calls / 1_000_000 : 0;
}

function formatMillis(value: number): string {
  if (value < 0.01) {
    return "<0.01 ms";
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

function observationTaskState(value: string | null): ObservationTaskState {
  switch (value) {
    case "RUNNING":
    case "SUCCEEDED":
    case "FAILED":
    case "CANCELLED":
    case "TIMED_OUT":
      return value;
    default:
      return "UNKNOWN";
  }
}

export default function MonitorView() {
  useLocale();
  const navigate = useNavigate();
  const connection = useTargetsStore(selectConnection);
  const selection = useObservationsStore((state) => state.selection);
  const [restoredTarget, setRestoredTarget] =
    useState<ObservationSelection | null>(null);
  const [intervalSeconds, setIntervalSeconds] = useState(5);
  const [durationMinutes, setDurationMinutes] = useState(5);
  const [minimumDurationMillis, setMinimumDurationMillis] = useState(0);
  const [activeMinimumDurationMillis, setActiveMinimumDurationMillis] =
    useState(0);
  const [thresholdDraft, setThresholdDraft] = useState(0);
  const [thresholdUpdated, setThresholdUpdated] = useState(false);
  const [preview, setPreview] = useState<ActionResult | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskState, setTaskState] = useState<string | null>(null);
  const [activeMethod, setActiveMethod] = useState("");
  const [deadlineEpochMillis, setDeadlineEpochMillis] = useState(0);
  const [windows, setWindows] = useState<readonly MonitorWindow[]>([]);
  const [nextSequence, setNextSequence] = useState(0);
  const [totalCalls, setTotalCalls] = useState(0);
  const [totalFailures, setTotalFailures] = useState(0);
  const [totalDurationNanos, setTotalDurationNanos] = useState(0);
  const [totalMaximumDurationNanos, setTotalMaximumDurationNanos] = useState(0);
  const [totalP95DurationNanos, setTotalP95DurationNanos] = useState(0);
  const [totalP99DurationNanos, setTotalP99DurationNanos] = useState(0);
  const [starting, setStarting] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [updatingThreshold, setUpdatingThreshold] = useState(false);
  const [startConfirmed, setStartConfirmed] = useState(false);
  const [stopConfirmed, setStopConfirmed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportingWindows, setExportingWindows] = useState(false);
  const [exportedArtifact, setExportedArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingInFlightRef = useRef(false);
  const taskIdRef = useRef(taskId);
  const nextSequenceRef = useRef(nextSequence);
  const intervalSecondsRef = useRef(intervalSeconds);
  const activeMethodRef = useRef(activeMethod);
  const deadlineEpochMillisRef = useRef(deadlineEpochMillis);
  const activeMinimumDurationMillisRef = useRef(activeMinimumDurationMillis);
  const thresholdDraftDirtyRef = useRef(false);
  taskIdRef.current = taskId;
  nextSequenceRef.current = nextSequence;
  intervalSecondsRef.current = intervalSeconds;
  activeMethodRef.current = activeMethod;
  deadlineEpochMillisRef.current = deadlineEpochMillis;
  activeMinimumDurationMillisRef.current = activeMinimumDurationMillis;

  const monitorCapability = connection?.capabilities.find(
    (capability) => capability.id === "monitor",
  );
  const selectedMethod = selection ?? restoredTarget;
  const running = taskId !== null && taskState === "RUNNING";
  const configurationValid =
    Number.isInteger(intervalSeconds) &&
    intervalSeconds >= 1 &&
    intervalSeconds <= 60 &&
    Number.isInteger(durationMinutes) &&
    durationMinutes >= 1 &&
    durationMinutes <= 480 &&
    Number.isInteger(minimumDurationMillis) &&
    minimumDurationMillis >= 0 &&
    minimumDurationMillis <= 60_000;
  const successfulCalls = Math.max(0, totalCalls - totalFailures);
  const successRate =
    totalCalls > 0 ? (successfulCalls / totalCalls) * 100 : 100;
  const averageDurationMillis =
    totalCalls > 0 ? totalDurationNanos / totalCalls / 1_000_000 : 0;
  const maximumDurationMillis = totalMaximumDurationNanos / 1_000_000;
  const p95DurationMillis = totalP95DurationNanos / 1_000_000;
  const p99DurationMillis = totalP99DurationNanos / 1_000_000;
  const visibleWindows = windows.slice(-40);
  const maximumWindowCalls = Math.max(
    1,
    ...visibleWindows.map((window) => window.calls),
  );
  const maximumWindowLatencyMillis = Math.max(
    0.001,
    ...visibleWindows.flatMap((window) => [
      windowAverageMillis(window),
      window.p95DurationNanos / 1_000_000,
    ]),
  );
  const averageLatencyPoints = latencyPoints((sample) =>
    windowAverageMillis(sample),
  );
  const p95LatencyPoints = latencyPoints(
    (sample) => sample.p95DurationNanos / 1_000_000,
  );

  function latencyPoints(
    selectMillis: (sample: MonitorWindow) => number,
  ): string {
    const samples = visibleWindows;
    if (samples.length === 0) {
      return "";
    }
    return samples
      .map((window, index) => {
        const x =
          samples.length === 1 ? 500 : (index / (samples.length - 1)) * 1_000;
        const y =
          160 - (selectMillis(window) / maximumWindowLatencyMillis) * 140;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  function barHeight(sample: MonitorWindow): string {
    return `${Math.max(2, (sample.calls / maximumWindowCalls) * 100)}%`;
  }

  async function previewMonitor(): Promise<void> {
    const target = selectedMethod;
    const targetsState = useTargetsStore.getState();
    if (
      !target ||
      !targetsState.selectedTargetId ||
      selectConnection(targetsState)?.state !== "READY"
    ) {
      return;
    }
    setLoadingPreview(true);
    setErrorMessage(null);
    setPreview(null);
    setStartConfirmed(false);
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "monitor.preview",
        parameters: actionParameters(target),
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法确认监控方法"),
        );
        return;
      }
      setPreview(response.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法确认监控方法"),
      );
    } finally {
      setLoadingPreview(false);
    }
  }

  async function startMonitor(): Promise<void> {
    const target = selectedMethod;
    const targetsState = useTargetsStore.getState();
    if (
      !target ||
      !targetsState.selectedTargetId ||
      !preview ||
      !startConfirmed ||
      !configurationValid
    ) {
      return;
    }
    setStarting(true);
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "monitor.start",
        parameters: {
          ...actionParameters(target),
          intervalMillis: String(intervalSeconds * 1_000),
          durationMillis: String(durationMinutes * 60_000),
          minimumDurationMillis: String(minimumDurationMillis),
          confirmed: "true",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法启动方法监控"),
        );
        return;
      }
      const startedTaskId = response.value.values.taskId;
      if (!startedTaskId) {
        setErrorMessage(t("Agent返回的监控任务无效"));
        return;
      }
      taskIdRef.current = startedTaskId;
      setTaskId(startedTaskId);
      setTaskState("RUNNING");
      activeMethodRef.current = response.value.values.method ?? "";
      setActiveMethod(response.value.values.method ?? "");
      deadlineEpochMillisRef.current = safeNumber(
        response.value.values.deadlineEpochMillis,
      );
      setDeadlineEpochMillis(
        safeNumber(response.value.values.deadlineEpochMillis),
      );
      const appliedMinimumDurationMillis = safeNumber(
        response.value.values.minimumDurationMillis,
      );
      activeMinimumDurationMillisRef.current = appliedMinimumDurationMillis;
      setActiveMinimumDurationMillis(appliedMinimumDurationMillis);
      setThresholdDraft(appliedMinimumDurationMillis);
      thresholdDraftDirtyRef.current = false;
      setThresholdUpdated(false);
      setWindows([]);
      nextSequenceRef.current = 0;
      setNextSequence(0);
      setTotalCalls(0);
      setTotalFailures(0);
      setTotalDurationNanos(0);
      setTotalMaximumDurationNanos(0);
      setTotalP95DurationNanos(0);
      setTotalP99DurationNanos(0);
      setExportedArtifact(null);
      persistMonitor(target, appliedMinimumDurationMillis);
      startPolling();
      await refreshWindows();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法启动方法监控"),
      );
    } finally {
      setStarting(false);
    }
  }

  async function refreshWindows(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentTaskId = taskIdRef.current;
    if (
      pollingInFlightRef.current ||
      !currentTaskId ||
      !targetsState.selectedTargetId ||
      selectConnection(targetsState)?.state !== "READY"
    ) {
      return;
    }
    pollingInFlightRef.current = true;
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "monitor.windows",
        parameters: {
          taskId: currentTaskId,
          afterSequence: String(nextSequenceRef.current),
          limit: "100",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取监控窗口"),
        );
        return;
      }
      const values = response.value.values;
      const incoming = parseWindows(values);
      if (incoming.length > 0) {
        setWindows((previous) => {
          const indexed = new Map(
            previous.map((window) => [window.sequence, window] as const),
          );
          for (const sample of incoming) {
            indexed.set(sample.sequence, sample);
          }
          return [...indexed.values()]
            .sort((left, right) => left.sequence - right.sequence)
            .slice(-WINDOW_LIMIT);
        });
      }
      const next = safeNumber(values.nextSequence);
      nextSequenceRef.current = next;
      setNextSequence(next);
      setTotalCalls(safeNumber(values.totalCalls));
      setTotalFailures(safeNumber(values.totalFailures));
      setTotalDurationNanos(safeNumber(values.totalDurationNanos));
      setTotalMaximumDurationNanos(
        safeNumber(values.totalMaximumDurationNanos),
      );
      setTotalP95DurationNanos(safeNumber(values.totalP95DurationNanos));
      setTotalP99DurationNanos(safeNumber(values.totalP99DurationNanos));
      const nextMinimumDurationMillis = safeNumber(
        values.minimumDurationMillis,
      );
      if (
        Number.isInteger(nextMinimumDurationMillis) &&
        nextMinimumDurationMillis <= 60_000
      ) {
        activeMinimumDurationMillisRef.current = nextMinimumDurationMillis;
        setActiveMinimumDurationMillis(nextMinimumDurationMillis);
        if (!thresholdDraftDirtyRef.current) {
          setThresholdDraft(nextMinimumDurationMillis);
        }
      }
      const state = values.state ?? "UNKNOWN";
      setTaskState(state);
      setErrorMessage(null);
      if (state !== "RUNNING") {
        stopPolling();
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取监控窗口"),
      );
    } finally {
      pollingInFlightRef.current = false;
    }
  }

  async function stopMonitor(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentTaskId = taskIdRef.current;
    if (!currentTaskId || !targetsState.selectedTargetId || !stopConfirmed) {
      return;
    }
    setStopping(true);
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "tasks.cancel",
        parameters: {
          kind: "MONITOR",
          taskId: currentTaskId,
          confirmed: "true",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法停止方法监控"),
        );
        return;
      }
      setTaskState(response.value.values.state ?? "CANCELLED");
      setStopConfirmed(false);
      stopPolling();
      sessionStorage.removeItem(STORAGE_KEY);
      await refreshWindows();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法停止方法监控"),
      );
    } finally {
      setStopping(false);
    }
  }

  async function updateMonitorThreshold(): Promise<void> {
    const activeTargetId = useTargetsStore.getState().selectedTargetId;
    const currentTaskId = taskIdRef.current;
    if (
      !activeTargetId ||
      !currentTaskId ||
      !running ||
      !Number.isInteger(thresholdDraft) ||
      thresholdDraft < 0 ||
      thresholdDraft > 60_000 ||
      thresholdDraft === activeMinimumDurationMillis
    ) {
      return;
    }
    setUpdatingThreshold(true);
    setErrorMessage(null);
    setThresholdUpdated(false);
    try {
      const response = await window.tanwei.executeAction({
        targetId: activeTargetId,
        actionId: "monitor.threshold.update",
        parameters: {
          taskId: currentTaskId,
          minimumDurationMillis: String(thresholdDraft),
          confirmed: "true",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法更新 Monitor 实时阈值"),
        );
        return;
      }
      const applied = safeNumber(response.value.values.minimumDurationMillis);
      if (!Number.isInteger(applied) || applied > 60_000) {
        setErrorMessage(t("Agent返回的 Monitor 阈值无效"));
        return;
      }
      activeMinimumDurationMillisRef.current = applied;
      setActiveMinimumDurationMillis(applied);
      setThresholdDraft(applied);
      thresholdDraftDirtyRef.current = false;
      setThresholdUpdated(true);
      if (selectedMethod) {
        persistMonitor(selectedMethod, applied);
      }
      await refreshWindows();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法更新 Monitor 实时阈值"),
      );
    } finally {
      setUpdatingThreshold(false);
    }
  }

  async function exportMonitorWindows(): Promise<void> {
    const activeTargetId = useTargetsStore.getState().selectedTargetId;
    const target = selectedMethod;
    const currentTaskId = taskIdRef.current;
    if (!activeTargetId || !target || !currentTaskId || windows.length === 0) {
      return;
    }
    setExportingWindows(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.createMonitorWindowsArtifact({
        targetId: activeTargetId,
        taskId: currentTaskId,
        taskState: observationTaskState(taskState),
        target: {
          className: target.className,
          classLoader: target.classLoader,
          methodName: target.method.name,
          parameterTypes: target.method.parameterTypes,
        },
        method: activeMethod,
        intervalMillis: intervalSeconds * 1_000,
        windows,
      });
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法保存 Monitor 窗口制品"));
        return;
      }
      setExportedArtifact(result.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法保存 Monitor 窗口制品"),
      );
    } finally {
      setExportingWindows(false);
    }
  }

  function persistMonitor(
    target: ObservationSelection,
    appliedMinimumDurationMillis = activeMinimumDurationMillisRef.current,
  ): void {
    const currentTargetId = useTargetsStore.getState().selectedTargetId;
    if (!currentTargetId || !taskIdRef.current) {
      return;
    }
    const persisted: PersistedMonitor = {
      targetId: currentTargetId,
      taskId: taskIdRef.current,
      target,
      intervalMillis: intervalSecondsRef.current * 1_000,
      minimumDurationMillis: appliedMinimumDurationMillis,
      deadlineEpochMillis: deadlineEpochMillisRef.current,
      method: activeMethodRef.current,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  }

  function restoreMonitor(): void {
    try {
      const persisted = JSON.parse(
        sessionStorage.getItem(STORAGE_KEY) ?? "null",
      ) as PersistedMonitor | null;
      if (
        !persisted ||
        persisted.targetId !== useTargetsStore.getState().selectedTargetId ||
        !persisted.taskId ||
        !validSelection(persisted.target)
      ) {
        return;
      }
      setRestoredTarget(persisted.target);
      taskIdRef.current = persisted.taskId;
      setTaskId(persisted.taskId);
      setTaskState("RUNNING");
      activeMethodRef.current = persisted.method;
      setActiveMethod(persisted.method);
      const restoredIntervalSeconds = Math.max(
        1,
        Math.min(60, persisted.intervalMillis / 1_000),
      );
      intervalSecondsRef.current = restoredIntervalSeconds;
      setIntervalSeconds(restoredIntervalSeconds);
      const restoredMinimumDurationMillis =
        Number.isInteger(persisted.minimumDurationMillis) &&
        (persisted.minimumDurationMillis ?? -1) >= 0 &&
        (persisted.minimumDurationMillis ?? 60_001) <= 60_000
          ? (persisted.minimumDurationMillis ?? 0)
          : 0;
      activeMinimumDurationMillisRef.current = restoredMinimumDurationMillis;
      setActiveMinimumDurationMillis(restoredMinimumDurationMillis);
      setThresholdDraft(restoredMinimumDurationMillis);
      thresholdDraftDirtyRef.current = false;
      deadlineEpochMillisRef.current = persisted.deadlineEpochMillis;
      setDeadlineEpochMillis(persisted.deadlineEpochMillis);
      startPolling();
      void refreshWindows();
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }

  function startPolling(): void {
    stopPolling();
    pollingTimerRef.current = setInterval(() => void refreshWindows(), 1_000);
  }

  function stopPolling(): void {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }

  function resetMonitor(): void {
    stopPolling();
    sessionStorage.removeItem(STORAGE_KEY);
    taskIdRef.current = null;
    setTaskId(null);
    setTaskState(null);
    activeMethodRef.current = "";
    setActiveMethod("");
    deadlineEpochMillisRef.current = 0;
    setDeadlineEpochMillis(0);
    activeMinimumDurationMillisRef.current = 0;
    setActiveMinimumDurationMillis(0);
    setThresholdDraft(0);
    thresholdDraftDirtyRef.current = false;
    setThresholdUpdated(false);
    setWindows([]);
    nextSequenceRef.current = 0;
    setNextSequence(0);
    setTotalCalls(0);
    setTotalFailures(0);
    setTotalDurationNanos(0);
    setTotalMaximumDurationNanos(0);
    setTotalP95DurationNanos(0);
    setTotalP99DurationNanos(0);
    setExportedArtifact(null);
    setPreview(null);
    setStartConfirmed(false);
    setStopConfirmed(false);
  }

  useEffect(() => {
    if (!running) {
      setPreview(null);
      setStartConfirmed(false);
    }
  }, [intervalSeconds, durationMinutes, minimumDurationMillis, selectedMethod]);

  useEffect(() => {
    restoreMonitor();
    return () => stopPolling();
  }, []);

  return (
    <section className="page monitor-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">METHOD MONITOR</p>
          <h1>{t("让调用趋势持续可见。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "对一个精确方法建立轻量周期窗口，只统计完成调用、异常和耗时；不采集参数、返回对象或调用树。",
          )}
        </p>
      </header>

      {connection?.state !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">{t("连接目标后选择方法监控。")}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate("/targets")}
          >
            {t("选择目标")}
          </Button>
        </Empty>
      ) : monitorCapability?.state !== "AVAILABLE" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">CAPABILITY UNAVAILABLE</p>
          <p className="empty-panel__title">
            {t("当前 Agent 不支持方法监控。")}
          </p>
          <p>
            {monitorCapability?.reason ?? t("请重新连接目标以加载最新 Agent。")}
          </p>
        </Empty>
      ) : !selectedMethod ? (
        <div className="monitor-onboarding">
          <div>
            <p className="eyebrow">START HERE</p>
            <h2>{t("先从类检查器选择一个方法。")}</h2>
            <p>
              {t(
                "监控绑定类、ClassLoader 和完整方法签名，不接受模糊匹配或通配符。",
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void navigate("/classes")}
          >
            {t("打开类检查器")}
          </Button>
        </div>
      ) : (
        <>
          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          <section className="monitor-target">
            <div>
              <p className="eyebrow">EXACT TARGET</p>
              <h2>{selectedMethod.className}</h2>
              <p className="monitor-target__signature">
                {selectedMethod.method.returnType} {selectedMethod.method.name}(
                {selectedMethod.method.parameterTypes.join(", ")})
              </p>
              <small>{selectedMethod.classLoader}</small>
            </div>
            {taskState && (
              <StatusPill
                state={running ? "working" : "idle"}
                label={taskState}
              />
            )}
          </section>

          {!taskId ? (
            <section className="monitor-setup">
              <div className="monitor-setup__heading">
                <div>
                  <p className="eyebrow">BOUNDED ENHANCEMENT / R1</p>
                  <h2>{t("配置周期与自动结束边界。")}</h2>
                </div>
                <p>
                  {t(
                    "完成调用计入其结束时所在窗口；并发边界附近的调用可能归入相邻窗口。",
                  )}
                </p>
              </div>
              <div className="monitor-fields">
                <Label>
                  <span>{t("窗口周期")}</span>
                  <SelectControl
                    value={intervalSeconds}
                    onValueChange={(value) =>
                      setIntervalSeconds(Number(value))
                    }
                  >
                    <SelectControlItem value={1}>
                      {t("1 秒")}
                    </SelectControlItem>
                    <SelectControlItem value={2}>
                      {t("2 秒")}
                    </SelectControlItem>
                    <SelectControlItem value={5}>
                      {t("5 秒")}
                    </SelectControlItem>
                    <SelectControlItem value={10}>
                      {t("10 秒")}
                    </SelectControlItem>
                    <SelectControlItem value={30}>
                      {t("30 秒")}
                    </SelectControlItem>
                    <SelectControlItem value={60}>
                      {t("60 秒")}
                    </SelectControlItem>
                  </SelectControl>
                </Label>
                <Label>
                  <span>{t("持续时长（分钟）")}</span>
                  <Input
                    value={durationMinutes}
                    onChange={(event) =>
                      setDurationMinutes(Number(event.target.value))
                    }
                    type="number"
                    min="1"
                    max="480"
                  />
                </Label>
                <Label>
                  <span>{t("最小计入耗时（ms）")}</span>
                  <Input
                    aria-label={t("最小计入耗时（ms）")}
                    value={minimumDurationMillis}
                    onChange={(event) =>
                      setMinimumDurationMillis(Number(event.target.value))
                    }
                    type="number"
                    min="0"
                    max="60000"
                  />
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void previewMonitor()}
                  aria-busy={Boolean(loadingPreview)}
                  disabled={Boolean(loadingPreview)}
                >
                  {Boolean(loadingPreview) && <Spinner />}
                  {t("预检精确方法")}
                </Button>
              </div>

              {preview && (
                <div className="monitor-preview">
                  <div>
                    <p className="eyebrow">MATCHED / 1</p>
                    <strong>{preview.values.method}</strong>
                    <p>{t("只增强这一条完整方法签名。")}</p>
                  </div>
                  <Label>
                    <Checkbox
                      checked={startConfirmed}
                      onCheckedChange={(event) =>
                        setStartConfirmed(event === true)
                      }
                    />
                    <span>
                      {t(
                        "我确认对该方法启用有界轻量计数，并理解热点方法仍会产生少量监控开销。",
                      )}
                    </span>
                  </Label>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      Boolean(!startConfirmed || !configurationValid) ||
                      Boolean(starting)
                    }
                    onClick={() => void startMonitor()}
                    aria-busy={Boolean(starting)}
                  >
                    {Boolean(starting) && <Spinner />}
                    {t("确认并开始监控")}
                  </Button>
                </div>
              )}
            </section>
          ) : (
            <>
              <section className="monitor-kpis" aria-label={t("方法监控摘要")}>
                <article>
                  <p className="eyebrow">CALLS</p>
                  <strong>{formatNumber(totalCalls)}</strong>
                  <span>{t("完成调用")}</span>
                </article>
                <article>
                  <p className="eyebrow">SUCCESS</p>
                  <strong>{successRate.toFixed(2)}%</strong>
                  <span>
                    {t("{count} 次异常", {
                      count: formatNumber(totalFailures),
                    })}
                  </span>
                </article>
                <article>
                  <p className="eyebrow">AVERAGE</p>
                  <strong>{formatMillis(averageDurationMillis)}</strong>
                  <span>{t("累计平均耗时")}</span>
                </article>
                <article>
                  <p className="eyebrow">P95</p>
                  <strong>{formatMillis(p95DurationMillis)}</strong>
                  <span>{t("累计 P95 尾延迟")}</span>
                </article>
                <article>
                  <p className="eyebrow">P99</p>
                  <strong>{formatMillis(p99DurationMillis)}</strong>
                  <span>{t("累计 P99 尾延迟")}</span>
                </article>
                <article>
                  <p className="eyebrow">MAXIMUM</p>
                  <strong>{formatMillis(maximumDurationMillis)}</strong>
                  <span>{t("累计最大耗时")}</span>
                </article>
              </section>

              <section className="monitor-threshold">
                <div className="monitor-threshold__copy">
                  <p className="eyebrow">LIVE COMPLETION FILTER / R1</p>
                  <h2>{t("运行中调整计入阈值。")}</h2>
                  <p>
                    {t(
                      "更新时先封存旧窗口，再切换完成调用过滤；无需重新增强类，历史窗口保留各自阈值。",
                    )}
                  </p>
                </div>
                <div className="monitor-threshold__control">
                  <span>
                    {t("当前阈值：≥ {value} ms", {
                      value: activeMinimumDurationMillis,
                    })}
                  </span>
                  <Label>
                    <span>{t("运行中最小耗时（ms）")}</span>
                    <Input
                      aria-label={t("运行中最小耗时（ms）")}
                      value={thresholdDraft}
                      onChange={(event) => {
                        setThresholdDraft(Number(event.target.value));
                        thresholdDraftDirtyRef.current = true;
                        setThresholdUpdated(false);
                      }}
                      type="number"
                      min="0"
                      max="60000"
                    />
                  </Label>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      Boolean(
                        !running ||
                          !Number.isInteger(thresholdDraft) ||
                          thresholdDraft < 0 ||
                          thresholdDraft > 60_000 ||
                          thresholdDraft === activeMinimumDurationMillis,
                      ) || Boolean(updatingThreshold)
                    }
                    onClick={() => void updateMonitorThreshold()}
                    aria-busy={Boolean(updatingThreshold)}
                  >
                    {Boolean(updatingThreshold) && <Spinner />}
                    {t("应用监控阈值")}
                  </Button>
                  {thresholdUpdated && (
                    <small role="status">
                      {t("已应用 {value} ms；旧窗口保持原阈值。", {
                        value: activeMinimumDurationMillis,
                      })}
                    </small>
                  )}
                </div>
              </section>

              <div className="monitor-inspector">
                <section className="monitor-chart">
                  <header>
                    <div>
                      <p className="eyebrow">PERIODIC WINDOWS</p>
                      <h2>{t("调用量与尾延迟。")}</h2>
                    </div>
                    <div className="monitor-chart__actions">
                      <span>
                        {t("{count} 个窗口", {
                          count: formatNumber(windows.length),
                        })}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          Boolean(windows.length === 0) ||
                          Boolean(exportingWindows)
                        }
                        onClick={() => void exportMonitorWindows()}
                        aria-busy={Boolean(exportingWindows)}
                      >
                        {Boolean(exportingWindows) && <Spinner />}
                        {t("保存窗口制品")}
                      </Button>
                    </div>
                  </header>
                  {exportedArtifact && (
                    <Alert className="monitor-chart__export" role="status">
                      <AlertDescription>
                        {t("监控窗口已进入制品中心：{name}", {
                          name: exportedArtifact.name,
                        })}
                      </AlertDescription>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          void navigate(
                            `/artifacts?inspect=${exportedArtifact.id}`,
                          )
                        }
                      >
                        {t("检查制品")}
                      </Button>
                    </Alert>
                  )}
                  {visibleWindows.length ? (
                    <div className="monitor-plot">
                      <div className="monitor-bars" aria-hidden="true">
                        {visibleWindows.map((sample) => (
                          <span
                            key={sample.sequence}
                            style={{ blockSize: barHeight(sample) }}
                          />
                        ))}
                      </div>
                      <svg
                        viewBox="0 0 1000 180"
                        preserveAspectRatio="none"
                        role="img"
                        aria-label={t("窗口平均与 P95 耗时趋势")}
                      >
                        <polyline
                          className="monitor-latency-line monitor-latency-line--average"
                          points={averageLatencyPoints}
                        />
                        <polyline
                          className="monitor-latency-line"
                          points={p95LatencyPoints}
                        />
                      </svg>
                    </div>
                  ) : (
                    <div className="monitor-chart__empty">
                      <p className="eyebrow">WAITING FOR WINDOW</p>
                      <strong>{t("第一个周期结束后显示趋势。")}</strong>
                      <p>{t("即使没有调用，也会保留一个零值窗口。")}</p>
                    </div>
                  )}
                  <footer>
                    <span>{t("柱：调用量")}</span>
                    <span>{t("虚线：平均耗时")}</span>
                    <span>{t("实线：P95 耗时")}</span>
                    <span>
                      {t("当前过滤：≥ {value} ms", {
                        value: activeMinimumDurationMillis,
                      })}
                    </span>
                    <span>
                      {deadlineEpochMillis
                        ? t("自动结束：{time}", {
                            time: formatDateTime(deadlineEpochMillis),
                          })
                        : t("自动结束边界未知")}
                    </span>
                  </footer>
                </section>

                <section className="monitor-window-list">
                  <header>
                    <p className="eyebrow">LATEST WINDOWS</p>
                    <strong>{activeMethod}</strong>
                  </header>
                  {windows.length ? (
                    <div className="monitor-window-list__rows">
                      {windows
                        .slice(-20)
                        .reverse()
                        .map((sample) => (
                          <article key={sample.sequence}>
                            <span>
                              <strong>#{sample.sequence}</strong>
                              <small>
                                {formatDateTime(sample.endedAtEpochMillis)} · ≥{" "}
                                {sample.minimumDurationMillis} ms
                              </small>
                            </span>
                            <span>
                              <strong>{formatNumber(sample.calls)}</strong>
                              <small>{t("调用")}</small>
                            </span>
                            <span>
                              <strong>{formatNumber(sample.failures)}</strong>
                              <small>{t("异常")}</small>
                            </span>
                            <span>
                              <strong>
                                {formatMillis(windowAverageMillis(sample))}
                              </strong>
                              <small>{t("平均")}</small>
                            </span>
                            <span>
                              <strong>
                                P95{" "}
                                {formatMillis(
                                  sample.p95DurationNanos / 1_000_000,
                                )}
                              </strong>
                              <small>
                                P99{" "}
                                {formatMillis(
                                  sample.p99DurationNanos / 1_000_000,
                                )}
                                {" · MAX "}
                                {formatMillis(
                                  sample.maximumDurationNanos / 1_000_000,
                                )}
                              </small>
                            </span>
                          </article>
                        ))}
                    </div>
                  ) : (
                    <div className="monitor-window-list__empty">
                      {t("暂无周期数据。")}
                    </div>
                  )}
                </section>
              </div>

              {running ? (
                <section className="monitor-stop">
                  <div>
                    <p className="eyebrow">EXACT CANCELLATION / R1</p>
                    <h2>{t("停止并移除这一个增强。")}</h2>
                    <p>
                      {t(
                        "停止后保留当前页面的统计结果；统一任务中心也可以按同一任务标识停止。",
                      )}
                    </p>
                  </div>
                  <Label>
                    <Checkbox
                      checked={stopConfirmed}
                      onCheckedChange={(event) =>
                        setStopConfirmed(event === true)
                      }
                    />
                    <span>{t("我确认停止当前方法监控任务。")}</span>
                  </Label>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={Boolean(!stopConfirmed) || Boolean(stopping)}
                    onClick={() => void stopMonitor()}
                    aria-busy={Boolean(stopping)}
                  >
                    {Boolean(stopping) && <Spinner />}
                    {t("停止监控")}
                  </Button>
                </section>
              ) : (
                <section className="monitor-finished">
                  <div>
                    <p className="eyebrow">TASK COMPLETE</p>
                    <h2>{t("监控已结束，结果保留在当前页面。")}</h2>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={resetMonitor}
                  >
                    {t("重新配置")}
                  </Button>
                </section>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
