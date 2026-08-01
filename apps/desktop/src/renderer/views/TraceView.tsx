import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router";
import type {
  ActionResult,
  ArtifactDescriptor,
  MethodDescriptor,
  ObservationTaskState,
} from "@shared/contracts";
import StatusPill from "../components/StatusPill";
import { formatDateTime, formatNumber, t, useLocale } from "../i18n";
import {
  type ObservationSelection,
  useObservationsStore,
} from "../stores/observations";
import { selectConnection, useTargetsStore } from "../stores/targets";
import { aggregateTraceHotspots } from "@shared/trace-aggregation";
import { cn } from "@/lib/utils";
import "./TraceView.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

interface TraceSpan {
  readonly sequence: number;
  readonly parentSequence: number | null;
  readonly depth: number;
  readonly method: string;
  readonly sourceFile: string | null;
  readonly sourceLine: number | null;
  readonly callSiteFile: string | null;
  readonly callSiteLine: number | null;
  readonly durationNanos: number;
  readonly exceptionType: string | null;
  readonly exceptionMessage: string | null;
}

interface CapturedTrace {
  readonly traceId: number;
  readonly capturedAtEpochMillis: number;
  readonly durationNanos: number;
  readonly threadId: number;
  readonly threadName: string;
  readonly threadDaemon: boolean;
  readonly threadPriority: number;
  readonly threadGroup: string;
  readonly contextClassLoader: string;
  readonly truncatedSpans: number;
  readonly spans: readonly TraceSpan[];
}

interface PersistedTrace {
  readonly targetId: string;
  readonly taskId: string;
  readonly target: ObservationSelection;
  readonly scopePrefix: string;
  readonly includeRules?: string;
  readonly excludeRules?: string;
  readonly rootMethod: string;
  readonly deadlineEpochMillis: number;
  readonly minimumDurationMillis?: number;
}

type TraceInspectorMode = "TREE" | "HOTSPOTS";

const STORAGE_KEY = "tanwei.trace";
const RETAINED_TRACES = 20;
const INITIAL_SPAN_RENDER_LIMIT = 200;
const MAXIMUM_TRACE_FILTER_RULES = 16;
const TRACE_PATH_RULE_PATTERN =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+(?:\.\*)?(?:#[A-Za-z_$][A-Za-z0-9_$]*)?$/u;

function validInteger(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function defaultScope(className: string): string {
  const separator = className.lastIndexOf(".");
  return separator > 0 ? className.slice(0, separator) : "";
}

function normalizeTraceRules(value: string): string | null {
  const rules = value
    .split(/\r?\n/u)
    .map((rule) => rule.trim())
    .filter(Boolean);
  if (
    rules.length > MAXIMUM_TRACE_FILTER_RULES ||
    rules.some(
      (rule) =>
        rule.length > 512 ||
        !TRACE_PATH_RULE_PATTERN.test(rule) ||
        rule.includes(".*#"),
    )
  ) {
    return null;
  }
  return [...new Set(rules)].join("\n");
}

function rulesWithinScope(rules: string, scope: string): boolean {
  if (!scope) {
    return false;
  }
  return traceRuleLines(rules).every((rule) => {
    const path = rule.split("#", 1)[0]?.replace(/\.\*$/u, "") ?? "";
    return path === scope || path.startsWith(`${scope}.`);
  });
}

function traceRuleLines(value: string | undefined): readonly string[] {
  return (value ?? "").split("\n").filter(Boolean).slice(0, 16);
}

function traceRuleSummary(value: string, fallback: string): string {
  const rules = traceRuleLines(value);
  return rules.length > 0 ? rules.join(" · ") : fallback;
}

function safeNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parsePreviewClasses(
  values: Readonly<Record<string, string>>,
): readonly string[] {
  const count = Math.min(64, Math.floor(safeNumber(values["class.count"])));
  return Array.from(
    { length: count },
    (_, index) => values[`class.${String(index).padStart(4, "0")}.name`],
  ).filter((value): value is string => Boolean(value));
}

function parseTraces(
  values: Readonly<Record<string, string>>,
): readonly CapturedTrace[] {
  const traceCount = Math.min(5, Math.floor(safeNumber(values["trace.count"])));
  return Array.from(
    { length: traceCount },
    (_, traceIndex): CapturedTrace | null => {
      const tracePrefix = `trace.${String(traceIndex).padStart(4, "0")}.`;
      const traceId = safeNumber(values[`${tracePrefix}traceId`]);
      if (!Number.isSafeInteger(traceId) || traceId <= 0) {
        return null;
      }
      const spanCount = Math.min(
        512,
        Math.floor(safeNumber(values[`${tracePrefix}span.count`])),
      );
      const spans = Array.from(
        { length: spanCount },
        (_, spanIndex): TraceSpan | null => {
          const spanPrefix = `${tracePrefix}span.${String(spanIndex).padStart(4, "0")}.`;
          const sequence = safeNumber(values[`${spanPrefix}sequence`]);
          const method = values[`${spanPrefix}method`] ?? "";
          if (!Number.isSafeInteger(sequence) || !method) {
            return null;
          }
          const parent = Number(values[`${spanPrefix}parentSequence`] ?? -1);
          const exceptionType = values[`${spanPrefix}exceptionType`] ?? "";
          return {
            sequence,
            parentSequence:
              Number.isSafeInteger(parent) && parent >= 0 ? parent : null,
            depth: Math.min(
              32,
              Math.floor(safeNumber(values[`${spanPrefix}depth`])),
            ),
            method,
            sourceFile: values[`${spanPrefix}sourceFile`] || null,
            sourceLine:
              Number(values[`${spanPrefix}sourceLine`] ?? -1) > 0
                ? Number(values[`${spanPrefix}sourceLine`])
                : null,
            callSiteFile: values[`${spanPrefix}callSiteFile`] || null,
            callSiteLine:
              Number(values[`${spanPrefix}callSiteLine`] ?? -1) > 0
                ? Number(values[`${spanPrefix}callSiteLine`])
                : null,
            durationNanos: safeNumber(values[`${spanPrefix}durationNanos`]),
            exceptionType: exceptionType || null,
            exceptionMessage: values[`${spanPrefix}exceptionMessage`] || null,
          };
        },
      ).filter((span): span is TraceSpan => span !== null);
      return {
        traceId,
        capturedAtEpochMillis: safeNumber(
          values[`${tracePrefix}capturedAtEpochMillis`],
        ),
        durationNanos: safeNumber(values[`${tracePrefix}durationNanos`]),
        threadId: safeNumber(values[`${tracePrefix}threadId`]),
        threadName: values[`${tracePrefix}threadName`] ?? "",
        threadDaemon: values[`${tracePrefix}threadDaemon`] === "true",
        threadPriority: safeNumber(values[`${tracePrefix}threadPriority`]),
        threadGroup: values[`${tracePrefix}threadGroup`] ?? "",
        contextClassLoader: values[`${tracePrefix}contextClassLoader`] ?? "",
        truncatedSpans: safeNumber(values[`${tracePrefix}truncatedSpans`]),
        spans,
      };
    },
  ).filter((trace): trace is CapturedTrace => trace !== null);
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

function formatMillis(value: number): string {
  const milliseconds = value / 1_000_000;
  if (milliseconds < 0.001) {
    return "<0.001 ms";
  }
  return `${milliseconds.toFixed(milliseconds < 10 ? 3 : 1)} ms`;
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

export default function TraceView() {
  useLocale();
  const navigate = useNavigate();
  const connection = useTargetsStore(selectConnection);
  const selection = useObservationsStore((s) => s.selection);
  const [restoredTarget, setRestoredTarget] =
    useState<ObservationSelection | null>(null);
  const [scopePrefix, setScopePrefix] = useState("");
  const [includeRulesText, setIncludeRulesText] = useState("");
  const [excludeRulesText, setExcludeRulesText] = useState("");
  const [maximumTraces, setMaximumTraces] = useState(10);
  const [maximumDepth, setMaximumDepth] = useState(12);
  const [maximumSpans, setMaximumSpans] = useState(256);
  const [minimumDurationMillis, setMinimumDurationMillis] = useState(0);
  const [activeMinimumDurationMillis, setActiveMinimumDurationMillis] =
    useState(0);
  const [thresholdDraft, setThresholdDraft] = useState(0);
  const [thresholdUpdated, setThresholdUpdated] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(15);
  const [preview, setPreview] = useState<ActionResult | null>(null);
  const [previewClasses, setPreviewClasses] = useState<readonly string[]>([]);
  const [taskId, setTaskIdState] = useState<string | null>(null);
  const [taskState, setTaskState] = useState<string | null>(null);
  const [rootMethod, setRootMethod] = useState("");
  const [deadlineEpochMillis, setDeadlineEpochMillis] = useState(0);
  const [captured, setCaptured] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [traces, setTracesState] = useState<readonly CapturedTrace[]>([]);
  const [selectedTraceId, setSelectedTraceIdState] = useState<number | null>(
    null,
  );
  const [inspectorMode, setInspectorMode] =
    useState<TraceInspectorMode>("TREE");
  const [spanRenderLimit, setSpanRenderLimit] = useState(
    INITIAL_SPAN_RENDER_LIMIT,
  );
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [startConfirmed, setStartConfirmed] = useState(false);
  const [stopConfirmed, setStopConfirmed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportedArtifact, setExportedArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingInFlightRef = useRef(false);
  const taskIdRef = useRef<string | null>(null);
  const tracesRef = useRef<readonly CapturedTrace[]>([]);
  const selectedTraceIdRef = useRef<number | null>(null);
  const thresholdDraftDirtyRef = useRef(false);

  function setTaskId(value: string | null): void {
    taskIdRef.current = value;
    setTaskIdState(value);
  }

  function setTraces(value: readonly CapturedTrace[]): void {
    tracesRef.current = value;
    setTracesState(value);
  }

  function setSelectedTraceId(value: number | null): void {
    selectedTraceIdRef.current = value;
    setSelectedTraceIdState(value);
  }

  const traceCapability = connection?.capabilities.find(
    (capability) => capability.id === "trace",
  );
  const selectedMethod = taskId
    ? (restoredTarget ?? selection)
    : (selection ?? restoredTarget);
  const running = taskId !== null && taskState === "RUNNING";
  const previewWithinLimit = preview?.values.withinLimit === "true";
  const normalizedIncludeRules = normalizeTraceRules(includeRulesText);
  const normalizedExcludeRules = normalizeTraceRules(excludeRulesText);
  const filterRulesValid =
    normalizedIncludeRules !== null &&
    normalizedExcludeRules !== null &&
    rulesWithinScope(normalizedIncludeRules, scopePrefix.trim()) &&
    rulesWithinScope(normalizedExcludeRules, scopePrefix.trim());
  const selectedTrace =
    traces.find((trace) => trace.traceId === selectedTraceId) ??
    traces.at(-1) ??
    null;
  const visibleSpans = selectedTrace?.spans.slice(0, spanRenderLimit) ?? [];
  const totalSpans = traces.reduce(
    (total, trace) => total + trace.spans.length,
    0,
  );
  const exceptionSpans = traces.reduce(
    (total, trace) =>
      total + trace.spans.filter((span) => span.exceptionType !== null).length,
    0,
  );
  const averageDurationMillis =
    traces.length > 0
      ? traces.reduce((total, trace) => total + trace.durationNanos, 0) /
        traces.length /
        1_000_000
      : 0;
  const maximumDurationMillis =
    Math.max(0, ...traces.map((trace) => trace.durationNanos)) / 1_000_000;
  const traceHotspots = useMemo(() => aggregateTraceHotspots(traces), [traces]);
  const configurationValid =
    validInteger(maximumTraces, 1, 20) &&
    validInteger(maximumDepth, 1, 32) &&
    validInteger(maximumSpans, 16, 512) &&
    validInteger(minimumDurationMillis, 0, 60_000) &&
    validInteger(timeoutSeconds, 1, 60) &&
    filterRulesValid;

  function identityParameters(
    target: ObservationSelection,
  ): Readonly<Record<string, string>> {
    return {
      className: target.className,
      classLoader: target.classLoader,
      methodName: target.method.name,
      parameterTypes: target.method.parameterTypes.join(","),
      scopePrefix: scopePrefix.trim(),
      includeRules: normalizedIncludeRules ?? "",
      excludeRules: normalizedExcludeRules ?? "",
    };
  }

  async function previewTrace(): Promise<void> {
    const target = selectedMethod;
    const activeTargetId = useTargetsStore.getState().selectedTargetId;
    if (!target || !activeTargetId || !scopePrefix.trim()) {
      return;
    }
    setLoadingAction("preview");
    setErrorMessage(null);
    setPreview(null);
    setPreviewClasses([]);
    setStartConfirmed(false);
    try {
      const response = await window.tanwei.executeAction({
        targetId: activeTargetId,
        actionId: "trace.preview",
        parameters: identityParameters(target),
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法预检跨类追踪"),
        );
        return;
      }
      setPreview(response.value);
      setPreviewClasses(parsePreviewClasses(response.value.values));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法预检跨类追踪"),
      );
    } finally {
      setLoadingAction(null);
    }
  }

  async function startTrace(): Promise<void> {
    const target = selectedMethod;
    const activeTargetId = useTargetsStore.getState().selectedTargetId;
    if (
      !target ||
      !activeTargetId ||
      !preview ||
      !previewWithinLimit ||
      !configurationValid ||
      !startConfirmed
    ) {
      return;
    }
    setLoadingAction("start");
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: activeTargetId,
        actionId: "trace.start",
        parameters: {
          ...identityParameters(target),
          maximumTraces: String(maximumTraces),
          maximumDepth: String(maximumDepth),
          maximumSpans: String(maximumSpans),
          minimumDurationMillis: String(minimumDurationMillis),
          timeoutMillis: String(timeoutSeconds * 1_000),
          confirmed: "true",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法启动跨类追踪"),
        );
        return;
      }
      const startedTaskId = response.value.values.taskId;
      if (!startedTaskId) {
        setErrorMessage(t("Agent返回的追踪任务无效"));
        return;
      }
      const nextRootMethod = response.value.values.method ?? "";
      const nextIncludeRules = response.value.values.includeRules ?? "";
      const nextExcludeRules = response.value.values.excludeRules ?? "";
      const nextDeadlineEpochMillis = safeNumber(
        response.value.values.deadlineEpochMillis,
      );
      const nextMinimumDurationMillis = safeNumber(
        response.value.values.minimumDurationMillis,
      );
      setRestoredTarget(target);
      setTaskId(startedTaskId);
      setTaskState("RUNNING");
      setRootMethod(nextRootMethod);
      setIncludeRulesText(nextIncludeRules);
      setExcludeRulesText(nextExcludeRules);
      setDeadlineEpochMillis(nextDeadlineEpochMillis);
      setActiveMinimumDurationMillis(nextMinimumDurationMillis);
      setThresholdDraft(nextMinimumDurationMillis);
      thresholdDraftDirtyRef.current = false;
      setThresholdUpdated(false);
      setCaptured(0);
      setDropped(0);
      setTraces([]);
      setExportedArtifact(null);
      setSelectedTraceId(null);
      persistTrace(
        target,
        startedTaskId,
        nextRootMethod,
        nextIncludeRules,
        nextExcludeRules,
        nextDeadlineEpochMillis,
        nextMinimumDurationMillis,
      );
      startPolling();
      await pollTraceEvents();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法启动跨类追踪"),
      );
    } finally {
      setLoadingAction(null);
    }
  }

  async function pollTraceEvents(): Promise<void> {
    const activeTaskId = taskIdRef.current;
    const targetsState = useTargetsStore.getState();
    const activeTargetId = targetsState.selectedTargetId;
    const activeConnection = selectConnection(targetsState);
    if (
      pollingInFlightRef.current ||
      !activeTaskId ||
      !activeTargetId ||
      activeConnection?.state !== "READY"
    ) {
      return;
    }
    pollingInFlightRef.current = true;
    try {
      const response = await window.tanwei.executeAction({
        targetId: activeTargetId,
        actionId: "trace.events",
        parameters: {
          taskId: activeTaskId,
          limit: "5",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取追踪事件"),
        );
        return;
      }
      const incoming = parseTraces(response.value.values);
      if (incoming.length > 0) {
        const indexed = new Map(
          tracesRef.current.map((trace) => [trace.traceId, trace] as const),
        );
        for (const trace of incoming) {
          indexed.set(trace.traceId, trace);
        }
        const next = [...indexed.values()]
          .sort(
            (left, right) =>
              left.capturedAtEpochMillis - right.capturedAtEpochMillis ||
              left.traceId - right.traceId,
          )
          .slice(-RETAINED_TRACES);
        setTraces(next);
        const currentSelectedTraceId = selectedTraceIdRef.current;
        if (
          currentSelectedTraceId === null ||
          !next.some((trace) => trace.traceId === currentSelectedTraceId)
        ) {
          setSelectedTraceId(next.at(-1)?.traceId ?? null);
        }
      }
      setCaptured(safeNumber(response.value.values.captured));
      setDropped(safeNumber(response.value.values.dropped));
      const nextMinimumDurationMillis = safeNumber(
        response.value.values.minimumDurationMillis,
      );
      if (validInteger(nextMinimumDurationMillis, 0, 60_000)) {
        setActiveMinimumDurationMillis(nextMinimumDurationMillis);
        if (!thresholdDraftDirtyRef.current) {
          setThresholdDraft(nextMinimumDurationMillis);
        }
      }
      const nextTaskState = response.value.values.state ?? "UNKNOWN";
      setTaskState(nextTaskState);
      setErrorMessage(null);
      if (nextTaskState !== "RUNNING") {
        stopPolling();
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取追踪事件"),
      );
    } finally {
      pollingInFlightRef.current = false;
    }
  }

  async function stopTrace(): Promise<void> {
    const activeTaskId = taskIdRef.current;
    const activeTargetId = useTargetsStore.getState().selectedTargetId;
    if (!activeTaskId || !activeTargetId || !stopConfirmed) {
      return;
    }
    setLoadingAction("stop");
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: activeTargetId,
        actionId: "tasks.cancel",
        parameters: {
          kind: "TRACE",
          taskId: activeTaskId,
          confirmed: "true",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法停止跨类追踪"),
        );
        return;
      }
      setTaskState(response.value.values.state ?? "CANCELLED");
      setStopConfirmed(false);
      stopPolling();
      sessionStorage.removeItem(STORAGE_KEY);
      await pollTraceEvents();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法停止跨类追踪"),
      );
    } finally {
      setLoadingAction(null);
    }
  }

  async function updateTraceThreshold(): Promise<void> {
    const activeTaskId = taskIdRef.current;
    const activeTargetId = useTargetsStore.getState().selectedTargetId;
    if (
      !activeTaskId ||
      !activeTargetId ||
      !running ||
      !validInteger(thresholdDraft, 0, 60_000) ||
      thresholdDraft === activeMinimumDurationMillis
    ) {
      return;
    }
    setLoadingAction("threshold");
    setErrorMessage(null);
    setThresholdUpdated(false);
    try {
      const response = await window.tanwei.executeAction({
        targetId: activeTargetId,
        actionId: "trace.threshold.update",
        parameters: {
          taskId: activeTaskId,
          minimumDurationMillis: String(thresholdDraft),
          confirmed: "true",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法更新 Trace 实时阈值"),
        );
        return;
      }
      const applied = safeNumber(response.value.values.minimumDurationMillis);
      if (!validInteger(applied, 0, 60_000)) {
        setErrorMessage(t("Agent返回的 Trace 阈值无效"));
        return;
      }
      setActiveMinimumDurationMillis(applied);
      setThresholdDraft(applied);
      thresholdDraftDirtyRef.current = false;
      setThresholdUpdated(true);
      persistTraceThreshold(applied);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法更新 Trace 实时阈值"),
      );
    } finally {
      setLoadingAction(null);
    }
  }

  async function exportTraceHotspots(): Promise<void> {
    const activeTargetId = useTargetsStore.getState().selectedTargetId;
    const target = selectedMethod;
    const currentTaskId = taskIdRef.current;
    const currentTraces = tracesRef.current;
    if (
      !activeTargetId ||
      !target ||
      !currentTaskId ||
      currentTraces.length === 0
    ) {
      return;
    }
    setLoadingAction("export");
    setErrorMessage(null);
    try {
      const result = await window.tanwei.createTraceHotspotArtifact({
        targetId: activeTargetId,
        taskId: currentTaskId,
        taskState: observationTaskState(taskState),
        target: {
          className: target.className,
          classLoader: target.classLoader,
          methodName: target.method.name,
          parameterTypes: target.method.parameterTypes,
        },
        rootMethod,
        scopePrefix,
        includeRules: traceRuleLines(includeRulesText),
        excludeRules: traceRuleLines(excludeRulesText),
        dropped,
        traces: currentTraces.map((trace) => ({
          traceId: trace.traceId,
          capturedAtEpochMillis: trace.capturedAtEpochMillis,
          durationNanos: trace.durationNanos,
          truncatedSpans: trace.truncatedSpans,
          spans: trace.spans.map((span) => ({
            sequence: span.sequence,
            parentSequence: span.parentSequence,
            method: span.method,
            durationNanos: span.durationNanos,
            exceptionType: span.exceptionType,
          })),
        })),
      });
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法保存 Trace 热点制品"));
        return;
      }
      setExportedArtifact(result.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法保存 Trace 热点制品"),
      );
    } finally {
      setLoadingAction(null);
    }
  }

  function persistTrace(
    target: ObservationSelection,
    persistedTaskId: string,
    persistedRootMethod: string,
    persistedIncludeRules: string,
    persistedExcludeRules: string,
    persistedDeadlineEpochMillis: number,
    persistedMinimumDurationMillis: number,
  ): void {
    const activeTargetId = useTargetsStore.getState().selectedTargetId;
    if (!activeTargetId || !persistedTaskId) {
      return;
    }
    const persisted: PersistedTrace = {
      targetId: activeTargetId,
      taskId: persistedTaskId,
      target,
      scopePrefix,
      includeRules: persistedIncludeRules,
      excludeRules: persistedExcludeRules,
      rootMethod: persistedRootMethod,
      deadlineEpochMillis: persistedDeadlineEpochMillis,
      minimumDurationMillis: persistedMinimumDurationMillis,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  }

  function persistTraceThreshold(value: number): void {
    try {
      const persisted = JSON.parse(
        sessionStorage.getItem(STORAGE_KEY) ?? "null",
      ) as PersistedTrace | null;
      if (!persisted || persisted.taskId !== taskIdRef.current) {
        return;
      }
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...persisted, minimumDurationMillis: value }),
      );
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }

  function restoreTrace(): void {
    const currentSelection = useObservationsStore.getState().selection;
    if (currentSelection && !scopePrefix) {
      setScopePrefix(defaultScope(currentSelection.className));
    }
    try {
      const persisted = JSON.parse(
        sessionStorage.getItem(STORAGE_KEY) ?? "null",
      ) as PersistedTrace | null;
      if (
        !persisted ||
        persisted.targetId !== useTargetsStore.getState().selectedTargetId ||
        !persisted.taskId ||
        !validSelection(persisted.target)
      ) {
        return;
      }
      setRestoredTarget(persisted.target);
      setScopePrefix(persisted.scopePrefix);
      setIncludeRulesText(persisted.includeRules ?? "");
      setExcludeRulesText(persisted.excludeRules ?? "");
      setTaskId(persisted.taskId);
      setTaskState("RUNNING");
      setRootMethod(persisted.rootMethod);
      setDeadlineEpochMillis(persisted.deadlineEpochMillis);
      const restoredMinimumDuration = validInteger(
        persisted.minimumDurationMillis ?? 0,
        0,
        60_000,
      )
        ? (persisted.minimumDurationMillis ?? 0)
        : 0;
      setActiveMinimumDurationMillis(restoredMinimumDuration);
      setThresholdDraft(restoredMinimumDuration);
      thresholdDraftDirtyRef.current = false;
      startPolling();
      void pollTraceEvents();
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }

  function resetTrace(): void {
    stopPolling();
    sessionStorage.removeItem(STORAGE_KEY);
    setTaskId(null);
    setTaskState(null);
    setRootMethod("");
    setDeadlineEpochMillis(0);
    setActiveMinimumDurationMillis(0);
    setThresholdDraft(0);
    thresholdDraftDirtyRef.current = false;
    setThresholdUpdated(false);
    setCaptured(0);
    setDropped(0);
    setTraces([]);
    setExportedArtifact(null);
    setSelectedTraceId(null);
    setInspectorMode("TREE");
    setRestoredTarget(null);
    setIncludeRulesText("");
    setExcludeRulesText("");
    setPreview(null);
    setPreviewClasses([]);
    setStartConfirmed(false);
    setStopConfirmed(false);
    setSpanRenderLimit(INITIAL_SPAN_RENDER_LIMIT);
    const currentSelection = useObservationsStore.getState().selection;
    if (currentSelection) {
      setScopePrefix(defaultScope(currentSelection.className));
    }
  }

  function selectTrace(trace: CapturedTrace): void {
    setSelectedTraceId(trace.traceId);
    setSpanRenderLimit(INITIAL_SPAN_RENDER_LIMIT);
  }

  function startPolling(): void {
    stopPolling();
    pollingTimerRef.current = setInterval(() => void pollTraceEvents(), 500);
  }

  function stopPolling(): void {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }

  function spanShare(span: TraceSpan): string {
    const total = selectedTrace?.durationNanos ?? 0;
    if (total <= 0) {
      return "0%";
    }
    return `${Math.min(100, Math.max(0, (span.durationNanos / total) * 100))}%`;
  }

  const selectionWatchSkippedRef = useRef(false);
  useEffect(() => {
    if (!selectionWatchSkippedRef.current) {
      selectionWatchSkippedRef.current = true;
      return;
    }
    if (selection && !taskIdRef.current) {
      setScopePrefix(defaultScope(selection.className));
      setIncludeRulesText("");
      setExcludeRulesText("");
      setPreview(null);
      setPreviewClasses([]);
      setStartConfirmed(false);
    }
  }, [selection]);

  const configWatchSkippedRef = useRef(false);
  useEffect(() => {
    if (!configWatchSkippedRef.current) {
      configWatchSkippedRef.current = true;
      return;
    }
    if (!taskIdRef.current) {
      setPreview(null);
      setPreviewClasses([]);
      setStartConfirmed(false);
    }
  }, [
    scopePrefix,
    includeRulesText,
    excludeRulesText,
    maximumTraces,
    maximumDepth,
    maximumSpans,
    minimumDurationMillis,
    timeoutSeconds,
  ]);

  useEffect(() => {
    restoreTrace();
    return () => stopPolling();
  }, []);

  return (
    <section className="page trace-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">CROSS-CLASS TRACE</p>
          <h1>{t("沿着一次调用，看见跨类路径。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "从一个精确根方法开始，只追踪同一 ClassLoader、已加载且可修改的包内类；不采集参数和返回对象。",
          )}
        </p>
      </header>

      {connection?.state !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">
            {t("连接目标后选择 Trace 根方法。")}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate("/targets")}
          >
            {t("选择目标")}
          </Button>
        </Empty>
      ) : traceCapability?.state !== "AVAILABLE" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">CAPABILITY UNAVAILABLE</p>
          <p className="empty-panel__title">
            {t("当前 Agent 不支持跨类 Trace。")}
          </p>
          <p>
            {traceCapability?.reason ?? t("请重新连接目标以加载最新 Agent。")}
          </p>
        </Empty>
      ) : !selectedMethod ? (
        <div className="trace-onboarding">
          <div>
            <p className="eyebrow">START HERE</p>
            <h2>{t("从类检查器选择根方法。")}</h2>
            <p>{t("Trace 不接受类或方法通配符，根方法必须唯一。")}</p>
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

          <section className="trace-target">
            <div>
              <p className="eyebrow">ROOT METHOD</p>
              <h2>{selectedMethod.className}</h2>
              <p className="trace-target__signature">
                {selectedMethod.method.returnType} {selectedMethod.method.name}(
                {selectedMethod.method.parameterTypes.join(", ")})
              </p>
              <small>{selectedMethod.classLoader}</small>
              {taskId && (
                <div className="trace-target__filters">
                  <span>
                    <small>INCLUDE</small>
                    <code>
                      {traceRuleSummary(includeRulesText, t("范围内全部路径"))}
                    </code>
                  </span>
                  <span>
                    <small>EXCLUDE</small>
                    <code>
                      {traceRuleSummary(excludeRulesText, t("未排除路径"))}
                    </code>
                  </span>
                </div>
              )}
            </div>
            {taskState && (
              <StatusPill
                state={running ? "working" : "idle"}
                label={taskState}
              />
            )}
          </section>

          {!taskId ? (
            <section className="trace-setup">
              <header>
                <div>
                  <p className="eyebrow">
                    BOUNDED MULTI-CLASS ENHANCEMENT / R2
                  </p>
                  <h2>{t("先限定范围，再生成调用树。")}</h2>
                </div>
                <p>
                  {t(
                    "包前缀必须包含根类；最多增强 64 个同 ClassLoader 的具体类。",
                  )}
                </p>
              </header>
              <div className="trace-fields">
                <Label className="trace-fields__scope">
                  <span>{t("包范围")}</span>
                  <Input
                    value={scopePrefix}
                    onChange={(event) =>
                      setScopePrefix(event.target.value.trim())
                    }
                    type="text"
                    maxLength={512}
                    placeholder="dev.example.order"
                  />
                </Label>
                <Label>
                  <span>{t("最多 Trace")}</span>
                  <Input
                    value={maximumTraces}
                    onChange={(event) =>
                      setMaximumTraces(Number(event.target.value))
                    }
                    type="number"
                    min="1"
                    max="20"
                  />
                </Label>
                <Label>
                  <span>{t("最大深度")}</span>
                  <Input
                    value={maximumDepth}
                    onChange={(event) =>
                      setMaximumDepth(Number(event.target.value))
                    }
                    type="number"
                    min="1"
                    max="32"
                  />
                </Label>
                <Label>
                  <span>{t("每条最多 Span")}</span>
                  <Input
                    value={maximumSpans}
                    onChange={(event) =>
                      setMaximumSpans(Number(event.target.value))
                    }
                    type="number"
                    min="16"
                    max="512"
                  />
                </Label>
                <Label>
                  <span>{t("根调用最小耗时（ms）")}</span>
                  <Input
                    value={minimumDurationMillis}
                    onChange={(event) =>
                      setMinimumDurationMillis(Number(event.target.value))
                    }
                    type="number"
                    min="0"
                    max="60000"
                  />
                </Label>
                <Label>
                  <span>{t("超时（秒）")}</span>
                  <Input
                    value={timeoutSeconds}
                    onChange={(event) =>
                      setTimeoutSeconds(Number(event.target.value))
                    }
                    type="number"
                    min="1"
                    max="60"
                  />
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    Boolean(!scopePrefix || !configurationValid) ||
                    Boolean(loadingAction === "preview")
                  }
                  onClick={() => void previewTrace()}
                  aria-busy={Boolean(loadingAction === "preview")}
                >
                  {Boolean(loadingAction === "preview") && <Spinner />}
                  {t("预检 Trace 范围")}
                </Button>
              </div>

              <div className="trace-filter-grid">
                <Label>
                  <span>{t("包含路径规则（可选）")}</span>
                  <Textarea
                    value={includeRulesText}
                    onChange={(event) =>
                      setIncludeRulesText(event.target.value)
                    }
                    rows={3}
                    maxLength={8192}
                    spellCheck={false}
                    placeholder={
                      "dev.example.order.*\ndev.example.shared.Clock#now"
                    }
                  />
                </Label>
                <Label>
                  <span>{t("排除路径规则（可选）")}</span>
                  <Textarea
                    value={excludeRulesText}
                    onChange={(event) =>
                      setExcludeRulesText(event.target.value)
                    }
                    rows={3}
                    maxLength={8192}
                    spellCheck={false}
                    placeholder={
                      "dev.example.order.internal.*\ndev.example.order.OrderService#debug"
                    }
                  />
                </Label>
              </div>
              <p className="trace-filter-hint">
                {t(
                  "每行一条：package.*、完整类名或完整类名#方法名；各最多 16 条，排除优先，根方法始终保留。",
                )}
              </p>

              {preview && (
                <section className="trace-preview">
                  <div className="trace-preview__summary">
                    <div>
                      <p className="eyebrow">MATCHED ROOT / 1</p>
                      <strong>{preview.values.method}</strong>
                      <p>
                        {t(
                          "{classes} 个候选类 · {methods} 个可增强方法 · 上限 {limit}",
                          {
                            classes: preview.values["class.count"] ?? "0",
                            methods:
                              preview.values.instrumentedMethodCount ?? "0",
                            limit: preview.values.classLimit ?? "64",
                          },
                        )}
                      </p>
                    </div>
                    <StatusPill
                      state={previewWithinLimit ? "ready" : "error"}
                      label={
                        previewWithinLimit ? t("范围可执行") : t("范围超过上限")
                      }
                    />
                  </div>
                  <div className="trace-preview__filters">
                    <div>
                      <p className="eyebrow">INCLUDE</p>
                      {traceRuleLines(preview.values.includeRules).map(
                        (rule) => (
                          <code key={rule}>{rule}</code>
                        ),
                      )}
                      {!preview.values.includeRules && (
                        <span>{t("范围内全部路径")}</span>
                      )}
                    </div>
                    <div>
                      <p className="eyebrow">EXCLUDE</p>
                      {traceRuleLines(preview.values.excludeRules).map(
                        (rule) => (
                          <code key={rule}>{rule}</code>
                        ),
                      )}
                      {!preview.values.excludeRules && (
                        <span>{t("未排除路径")}</span>
                      )}
                    </div>
                  </div>
                  <div className="trace-preview__classes">
                    {previewClasses.slice(0, 20).map((className) => (
                      <code key={className}>{className}</code>
                    ))}
                    {previewClasses.length > 20 && (
                      <span>
                        {t("还有 {count} 个类", {
                          count: previewClasses.length - 20,
                        })}
                      </span>
                    )}
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
                        "我已核对根方法、包范围、路径规则和类/方法数量，并接受有界跨类字节码增强开销。",
                      )}
                    </span>
                  </Label>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      Boolean(
                        !startConfirmed ||
                          !previewWithinLimit ||
                          !configurationValid,
                      ) || Boolean(loadingAction === "start")
                    }
                    onClick={() => void startTrace()}
                    aria-busy={Boolean(loadingAction === "start")}
                  >
                    {Boolean(loadingAction === "start") && <Spinner />}
                    {t("确认增强并开始 Trace")}
                  </Button>
                </section>
              )}
            </section>
          ) : (
            <>
              <section className="trace-kpis" aria-label={t("跨类 Trace 摘要")}>
                <article>
                  <p className="eyebrow">TRACES</p>
                  <strong>{formatNumber(captured)}</strong>
                  <span>{t("已完成根调用")}</span>
                </article>
                <article>
                  <p className="eyebrow">SPANS</p>
                  <strong>{formatNumber(totalSpans)}</strong>
                  <span>
                    {t("{count} 个异常节点", { count: exceptionSpans })}
                  </span>
                </article>
                <article>
                  <p className="eyebrow">AVERAGE</p>
                  <strong>{averageDurationMillis.toFixed(3)} ms</strong>
                  <span>{t("根调用平均耗时")}</span>
                </article>
                <article>
                  <p className="eyebrow">MAXIMUM</p>
                  <strong>{maximumDurationMillis.toFixed(3)} ms</strong>
                  <span>{t("根调用最大耗时")}</span>
                </article>
              </section>

              {taskId && (
                <section className="trace-threshold">
                  <div className="trace-threshold__copy">
                    <p className="eyebrow">LIVE ROOT FILTER / R1</p>
                    <h2>{t("运行中调整慢调用阈值。")}</h2>
                    <p>
                      {t(
                        "无需重新增强类；新阈值在根调用完成时生效，已捕获的 Trace 保持不变。",
                      )}
                    </p>
                  </div>
                  <div className="trace-threshold__control">
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
                            !validInteger(thresholdDraft, 0, 60_000) ||
                            thresholdDraft === activeMinimumDurationMillis,
                        ) || Boolean(loadingAction === "threshold")
                      }
                      onClick={() => void updateTraceThreshold()}
                      aria-busy={Boolean(loadingAction === "threshold")}
                    >
                      {Boolean(loadingAction === "threshold") && <Spinner />}
                      {t("应用实时阈值")}
                    </Button>
                    {thresholdUpdated && (
                      <small role="status">
                        {t("已应用 {value} ms；未重新增强类。", {
                          value: activeMinimumDurationMillis,
                        })}
                      </small>
                    )}
                  </div>
                </section>
              )}

              <Tabs
                value={inspectorMode}
                onValueChange={(mode) =>
                  setInspectorMode(mode as TraceInspectorMode)
                }
                className="mt-5 w-fit gap-0"
              >
                <TabsList aria-label={t("Trace 结果视图")}>
                  <TabsTrigger value="TREE">{t("调用树")}</TabsTrigger>
                  <TabsTrigger value="HOTSPOTS">{t("热点聚合")}</TabsTrigger>
                </TabsList>
              </Tabs>

              {inspectorMode === "TREE" ? (
                <div className="trace-inspector">
                  <section className="trace-list">
                    <header>
                      <div>
                        <p className="eyebrow">CAPTURED ROOT CALLS</p>
                        <strong>
                          {t("{count} 条本页 Trace", {
                            count: traces.length,
                          })}
                        </strong>
                      </div>
                      <span>{t("截断 {count}", { count: dropped })}</span>
                    </header>
                    {traces.length ? (
                      <div className="trace-list__rows">
                        {[...traces].reverse().map((trace) => (
                          <Button
                            variant="ghost"
                            key={trace.traceId}
                            type="button"
                            className={cn(
                              "trace-row",
                              trace.traceId === selectedTrace?.traceId &&
                                "trace-row--selected",
                            )}
                            onClick={() => selectTrace(trace)}
                          >
                            <span>
                              <strong>#{trace.traceId}</strong>
                              <small>
                                {formatDateTime(trace.capturedAtEpochMillis)}
                              </small>
                            </span>
                            <span>
                              <strong>
                                {formatMillis(trace.durationNanos)}
                              </strong>
                              <small>
                                {t("{count} Span", {
                                  count: trace.spans.length,
                                })}
                              </small>
                            </span>
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <div className="trace-list__empty">
                        <p className="eyebrow">WAITING FOR ROOT CALL</p>
                        <strong>{t("等待根方法完成一次调用。")}</strong>
                      </div>
                    )}
                  </section>

                  <section className="trace-detail">
                    {selectedTrace ? (
                      <>
                        <header>
                          <div>
                            <p className="eyebrow">
                              TRACE #{selectedTrace.traceId}
                            </p>
                            <h2>{rootMethod}</h2>
                            <p>
                              {selectedTrace.threadName} #
                              {selectedTrace.threadId} · p
                              {selectedTrace.threadPriority} ·{" "}
                              {selectedTrace.threadDaemon
                                ? t("守护线程")
                                : t("用户线程")} ·{" "}
                              {formatMillis(selectedTrace.durationNanos)}
                            </p>
                            <p>
                              {selectedTrace.threadGroup || t("无 ThreadGroup")} ·{" "}
                              {selectedTrace.contextClassLoader ||
                                t("未知上下文 ClassLoader")}
                            </p>
                          </div>
                          <StatusPill
                            state={
                              selectedTrace.truncatedSpans ? "error" : "ready"
                            }
                            label={
                              selectedTrace.truncatedSpans
                                ? t("截断 {count} Span", {
                                    count: selectedTrace.truncatedSpans,
                                  })
                                : t("调用树完整")
                            }
                          />
                        </header>
                        <ol
                          className="trace-tree"
                          aria-label={t("跨类调用树")}
                        >
                          {visibleSpans.map((span) => (
                            <li
                              key={span.sequence}
                              className={cn(
                                "trace-span",
                                span.exceptionType && "trace-span--error",
                              )}
                              style={
                                {
                                  "--trace-depth": span.depth,
                                  "--trace-share": spanShare(span),
                                } as CSSProperties
                              }
                              aria-level={span.depth + 1}
                            >
                              <span
                                className="trace-span__branch"
                                aria-hidden="true"
                              />
                              <span className="trace-span__method">
                                <strong>{span.method}</strong>
                                <small>
                                  {span.parentSequence === null
                                    ? t("根 Span")
                                    : t("父 Span #{sequence}", {
                                        sequence: span.parentSequence,
                                      })}
                                </small>
                                {span.sourceFile && span.sourceLine && (
                                  <small>
                                    {t("方法源码位置：{file}:{line}", {
                                      file: span.sourceFile,
                                      line: span.sourceLine,
                                    })}
                                  </small>
                                )}
                                {span.callSiteFile && span.callSiteLine && (
                                  <small>
                                    {t("父方法调用点：{file}:{line}", {
                                      file: span.callSiteFile,
                                      line: span.callSiteLine,
                                    })}
                                  </small>
                                )}
                                {span.exceptionType && (
                                  <small>
                                    {span.exceptionType}
                                    {span.exceptionMessage
                                      ? ` · ${span.exceptionMessage}`
                                      : null}
                                  </small>
                                )}
                              </span>
                              <span className="trace-span__duration">
                                <strong>
                                  {formatMillis(span.durationNanos)}
                                </strong>
                                <span aria-hidden="true">
                                  <i />
                                </span>
                              </span>
                            </li>
                          ))}
                          {visibleSpans.length < selectedTrace.spans.length && (
                            <li className="trace-tree__more">
                              <p>
                                {t("还有 {count} 个 Span 未渲染", {
                                  count:
                                    selectedTrace.spans.length -
                                    visibleSpans.length,
                                })}
                              </p>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() =>
                                  setSpanRenderLimit(selectedTrace.spans.length)
                                }
                              >
                                {t("展开剩余 Span")}
                              </Button>
                            </li>
                          )}
                        </ol>
                      </>
                    ) : (
                      <div className="trace-detail__empty">
                        <p className="eyebrow">NO TRACE SELECTED</p>
                        <h2>{t("捕获后在这里检查跨类调用路径。")}</h2>
                      </div>
                    )}
                  </section>
                </div>
              ) : (
                <section className="trace-hotspots">
                  <header>
                    <div>
                      <p className="eyebrow">CROSS-TRACE HOTSPOTS</p>
                      <h2>{t("跨 Trace 热点聚合。")}</h2>
                    </div>
                    <p>
                      {t(
                        "基于当前页面最多 20 条 Trace 计算；自耗时扣除直接子 Span，结果按累计自耗时排序。",
                      )}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        Boolean(traceHotspots.length === 0) ||
                        Boolean(loadingAction === "export")
                      }
                      onClick={() => void exportTraceHotspots()}
                      aria-busy={Boolean(loadingAction === "export")}
                    >
                      {Boolean(loadingAction === "export") && <Spinner />}
                      {t("保存热点制品")}
                    </Button>
                  </header>
                  {exportedArtifact && (
                    <Alert className="trace-hotspots__export" role="status">
                      <AlertDescription>
                        {t("热点聚合已进入制品中心：{name}", {
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
                  {traceHotspots.length ? (
                    <div className="trace-hotspot-table">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead scope="col">{t("方法")}</TableHead>
                            <TableHead scope="col">{t("累计自耗时")}</TableHead>
                            <TableHead scope="col">{t("累计总耗时")}</TableHead>
                            <TableHead scope="col">{t("调用量")}</TableHead>
                            <TableHead scope="col">{t("异常量")}</TableHead>
                            <TableHead scope="col">{t("平均耗时")}</TableHead>
                            <TableHead scope="col">{t("最大耗时")}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {traceHotspots.map((hotspot) => (
                            <TableRow key={hotspot.method}>
                              <TableCell className="trace-hotspot-method">
                                <code>{hotspot.method}</code>
                                <span aria-hidden="true">
                                  <i
                                    style={
                                      {
                                        "--hotspot-share": `${hotspot.selfSharePercent}%`,
                                      } as CSSProperties
                                    }
                                  />
                                </span>
                              </TableCell>
                              <TableCell>
                                <strong>
                                  {formatMillis(hotspot.selfDurationNanos)}
                                </strong>
                              </TableCell>
                              <TableCell>
                                {formatMillis(hotspot.totalDurationNanos)}
                              </TableCell>
                              <TableCell>
                                {formatNumber(hotspot.calls)}
                              </TableCell>
                              <TableCell>
                                {formatNumber(hotspot.errors)}
                              </TableCell>
                              <TableCell>
                                {formatMillis(hotspot.averageDurationNanos)}
                              </TableCell>
                              <TableCell>
                                {formatMillis(hotspot.maximumDurationNanos)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <div className="trace-hotspots__empty">
                      <p className="eyebrow">NO HOTSPOTS</p>
                      <strong>{t("捕获 Trace 后生成热点聚合。")}</strong>
                    </div>
                  )}
                </section>
              )}

              {running ? (
                <section className="trace-stop">
                  <div>
                    <p className="eyebrow">EXACT CANCELLATION / R1</p>
                    <h2>{t("停止并回滚这一组增强。")}</h2>
                    <p>
                      {t(
                        "回滚仅覆盖此 Trace 任务选择的 Transformer；其他观测和监控任务保持独立。",
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
                    <span>{t("我确认停止当前跨类 Trace。")}</span>
                  </Label>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      Boolean(!stopConfirmed) ||
                      Boolean(loadingAction === "stop")
                    }
                    onClick={() => void stopTrace()}
                    aria-busy={Boolean(loadingAction === "stop")}
                  >
                    {Boolean(loadingAction === "stop") && <Spinner />}
                    {t("停止 Trace")}
                  </Button>
                </section>
              ) : (
                <section className="trace-finished">
                  <div>
                    <p className="eyebrow">TASK COMPLETE</p>
                    <h2>{t("Trace 已结束，调用树保留在当前页面。")}</h2>
                  </div>
                  <Button type="button" variant="outline" onClick={resetTrace}>
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
