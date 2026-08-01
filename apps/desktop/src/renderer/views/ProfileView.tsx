import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
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
import { useNavigate } from "react-router";
import type {
  ActionResult,
  ArtifactDescriptor,
} from "@shared/contracts";
import StatusPill from "../components/StatusPill";
import {
  buildHeapHistogramDiff,
  heapHistogramCompatibilityIssue,
  type HeapHistogramCompatibilityIssue,
  type HeapHistogramRow,
  type HeapHistogramSnapshot,
} from "../heap-histogram-diff";
import { formatDateTime, t, useLocale } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./ProfileView.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { CircleDotIcon } from "lucide-react";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";
import {
  DiagnosticTaskPoller,
  type DiagnosticPollResult,
} from "../utils/diagnostic-task-poller";
import {
  parseArtifactTicket,
  parseClassRetainedResult,
  parseDominatorTreeResult,
  parseHeapHistogramResult,
  parseJfrStatus,
  parseProfileTaskResult,
  type ArtifactTicket,
  type ClassRetainedResult,
  type ClassRetainedRow,
  type DominatorTreeNode,
  type DominatorTreeResult,
} from "../profile-action-contract";

type HistogramSort = "BYTES" | "COUNT" | "AVERAGE" | "CLASS";
type HistogramDiffSort =
  | "ABSOLUTE_BYTES"
  | "GROWTH"
  | "RELEASE"
  | "COUNT"
  | "CLASS";
type ProfileEvent = "CPU" | "WALL" | "ALLOCATION" | "LOCK";

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function formatInteger(value: number): string {
  return value.toLocaleString();
}

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${formatInteger(value)} B`;
  }
  if (value < 1_048_576) {
    return `${(value / 1_024).toFixed(1)} KiB`;
  }
  if (value < 1_073_741_824) {
    return `${(value / 1_048_576).toFixed(1)} MiB`;
  }
  return `${(value / 1_073_741_824).toFixed(1)} GiB`;
}

function formatSignedInteger(value: number | null): string {
  if (value === null) {
    return t("不可比较");
  }
  if (value === 0) {
    return "0";
  }
  return `${value > 0 ? "+" : "−"}${formatInteger(Math.abs(value))}`;
}

function formatSignedBytes(value: number | null): string {
  if (value === null) {
    return t("不可比较");
  }
  if (value === 0) {
    return "0 B";
  }
  return `${value > 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`;
}

function formatHistogramInterval(
  baselineCapturedAt: number,
  currentCapturedAt: number,
): string {
  const intervalMillis = Math.max(0, currentCapturedAt - baselineCapturedAt);
  if (intervalMillis < 1_000) {
    return `${formatInteger(intervalMillis)} ms`;
  }
  return `${(intervalMillis / 1_000).toFixed(1)} s`;
}

function heapHistogramDiffKindClass(
  kind: "GROWTH" | "RELEASE" | "STABLE",
): string {
  return `heap-histogram-diff__delta--${kind.toLocaleLowerCase()}`;
}

function heapHistogramDiffIssueMessage(
  issue: HeapHistogramCompatibilityIssue,
): string {
  switch (issue) {
    case "TARGET_CHANGED":
      return t("目标已切换，请重新固定基线。");
    case "JVM_IDENTITY_UNAVAILABLE":
      return t("缺少 JVM 启动时间，无法安全比较两次扫描。");
    case "JVM_RESTARTED":
      return t("目标 JVM 已重启，请重新固定基线。");
    case "SCOPE_CHANGED":
      return t("类名范围或结果行数已变化，请恢复基线参数或重新固定。");
    case "BUDGET_CHANGED":
      return t("对象遍历预算已变化，请恢复基线参数或重新固定。");
  }
}

export default function ProfileView() {
  useLocale();
  const navigate = useNavigate();
  const connection = useTargetsStore(selectConnection);
  const [recording, setRecording] = useState(false);
  const [jfrConfiguration, setJfrConfiguration] = useState<
    "PROFILE" | "DEFAULT"
  >("PROFILE");
  const [jfrRecordingName, setJfrRecordingName] = useState(
    "Tanwei Diagnostic Recording",
  );
  const [jfrMaxAgeMinutes, setJfrMaxAgeMinutes] = useState(0);
  const [jfrMaxSizeMiB, setJfrMaxSizeMiB] = useState(0);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ArtifactDescriptor | null>(null);
  const [heapConfirmationVisible, setHeapConfirmationVisible] = useState(false);
  const [heapConfirmed, setHeapConfirmed] = useState(false);
  const [liveHeapOnly, setLiveHeapOnly] = useState(true);
  const [profileEvent, setProfileEvent] = useState<ProfileEvent>("CPU");
  const [profileDurationSeconds, setProfileDurationSeconds] = useState(30);
  const [profileIntervalMillis, setProfileIntervalMillis] = useState(20);
  const [profileStackDepth, setProfileStackDepth] = useState(256);
  const [profileThreads, setProfileThreads] = useState(false);
  const [profileIncludeRules, setProfileIncludeRules] = useState("");
  const [profileExcludeRules, setProfileExcludeRules] = useState("");
  const [profileTaskId, setProfileTaskId] = useState<string | null>(null);
  const [profileState, setProfileState] = useState<string | null>(null);
  const [profileSamples, setProfileSamples] = useState(0);
  const [profileDropped, setProfileDropped] = useState(0);
  const [profileEngine, setProfileEngine] = useState<string | null>(null);
  const [heapHistogramClassQuery, setHeapHistogramClassQuery] = useState("");
  const [heapHistogramLimit, setHeapHistogramLimit] = useState(100);
  const [heapHistogramScanLimit, setHeapHistogramScanLimit] =
    useState(1_000_000);
  const [heapHistogramConfirmed, setHeapHistogramConfirmed] = useState(false);
  const [heapHistogramCompleted, setHeapHistogramCompleted] = useState(false);
  const [heapHistogramRows, setHeapHistogramRows] = useState<
    readonly HeapHistogramRow[]
  >([]);
  const [heapHistogramQuery, setHeapHistogramQuery] = useState("");
  const [heapHistogramSort, setHeapHistogramSort] =
    useState<HistogramSort>("BYTES");
  const [heapHistogramScanned, setHeapHistogramScanned] = useState(0);
  const [heapHistogramAccountedObjects, setHeapHistogramAccountedObjects] =
    useState(0);
  const [heapHistogramAccountedBytes, setHeapHistogramAccountedBytes] =
    useState(0);
  const [heapHistogramNonEmptyClasses, setHeapHistogramNonEmptyClasses] =
    useState(0);
  const [heapHistogramSkippedClasses, setHeapHistogramSkippedClasses] =
    useState(0);
  const [heapHistogramTruncated, setHeapHistogramTruncated] = useState(false);
  const [
    heapHistogramClassSelectionTruncated,
    setHeapHistogramClassSelectionTruncated,
  ] = useState(false);
  const [heapHistogramSnapshot, setHeapHistogramSnapshot] =
    useState<HeapHistogramSnapshot | null>(null);
  const [heapHistogramBaseline, setHeapHistogramBaseline] =
    useState<HeapHistogramSnapshot | null>(null);
  const [heapHistogramDiffQuery, setHeapHistogramDiffQuery] = useState("");
  const [heapHistogramDiffSort, setHeapHistogramDiffSort] =
    useState<HistogramDiffSort>("ABSOLUTE_BYTES");
  const [classRetainedQuery, setClassRetainedQuery] = useState("");
  const [classRetainedLimit, setClassRetainedLimit] = useState(50);
  const [classRetainedMaximumNodes, setClassRetainedMaximumNodes] =
    useState(250_000);
  const [classRetainedMaximumEdges, setClassRetainedMaximumEdges] =
    useState(1_000_000);
  const [classRetainedConfirmed, setClassRetainedConfirmed] = useState(false);
  const [classRetainedCompleted, setClassRetainedCompleted] = useState(false);
  const [classRetainedResult, setClassRetainedResult] =
    useState<ClassRetainedResult | null>(null);
  const [dominatorTreeMaximumDepth, setDominatorTreeMaximumDepth] = useState(4);
  const [dominatorTreeMaximumViewNodes, setDominatorTreeMaximumViewNodes] =
    useState(80);
  const [dominatorTreeRootLimit, setDominatorTreeRootLimit] = useState(10);
  const [dominatorTreeBranchLimit, setDominatorTreeBranchLimit] = useState(5);
  const [dominatorTreeMaximumNodes, setDominatorTreeMaximumNodes] =
    useState(250_000);
  const [dominatorTreeMaximumEdges, setDominatorTreeMaximumEdges] =
    useState(1_000_000);
  const [dominatorTreeConfirmed, setDominatorTreeConfirmed] = useState(false);
  const [dominatorTreeCompleted, setDominatorTreeCompleted] = useState(false);
  const [dominatorTreeResult, setDominatorTreeResult] =
    useState<DominatorTreeResult | null>(null);
  const [collapsedDominatorNodes, setCollapsedDominatorNodes] = useState<
    ReadonlySet<number>
  >(new Set<number>());
  const profilePollerRef = useRef<DiagnosticTaskPoller | null>(null);
  const profileTaskIdRef = useRef<string | null>(null);
  const profileEngineRef = useRef<string | null>(null);

  const jfrAvailable = Boolean(
    connection?.capabilities.some(
      (capability) =>
        capability.id === "jfr" && capability.state === "AVAILABLE",
    ),
  );
  const heapDumpAvailable = Boolean(
    connection?.capabilities.some(
      (capability) =>
        capability.id === "heap-dump" && capability.state === "AVAILABLE",
    ),
  );
  const profilerAvailable = Boolean(
    connection?.capabilities.some(
      (capability) =>
        capability.id === "profiler" && capability.state === "AVAILABLE",
    ),
  );
  const heapHistogramAvailable = Boolean(
    connection?.capabilities.some(
      (capability) =>
        capability.id === "heap-instances" && capability.state === "AVAILABLE",
    ),
  );
  const visibleHeapHistogramRows = useMemo(() => {
    const query = heapHistogramQuery.trim().toLocaleLowerCase();
    const rows = heapHistogramRows.filter(
      (row) =>
        !query ||
        row.className.toLocaleLowerCase().includes(query) ||
        row.classLoader.toLocaleLowerCase().includes(query),
    );
    return [...rows].sort((left, right) => {
      switch (heapHistogramSort) {
        case "COUNT":
          return (
            right.instanceCount - left.instanceCount ||
            left.className.localeCompare(right.className)
          );
        case "AVERAGE":
          return (
            right.averageShallowBytes - left.averageShallowBytes ||
            left.className.localeCompare(right.className)
          );
        case "CLASS":
          return left.className.localeCompare(right.className);
        case "BYTES":
        default:
          return (
            right.shallowBytes - left.shallowBytes ||
            left.className.localeCompare(right.className)
          );
      }
    });
  }, [heapHistogramRows, heapHistogramQuery, heapHistogramSort]);
  const heapHistogramDiffIssue = useMemo(() => {
    if (!heapHistogramBaseline || !heapHistogramSnapshot) {
      return null;
    }
    return heapHistogramCompatibilityIssue(
      heapHistogramBaseline,
      heapHistogramSnapshot,
    );
  }, [heapHistogramBaseline, heapHistogramSnapshot]);
  const heapHistogramDiff = useMemo(() => {
    if (
      !heapHistogramBaseline ||
      !heapHistogramSnapshot ||
      heapHistogramDiffIssue !== null
    ) {
      return null;
    }
    return buildHeapHistogramDiff(heapHistogramBaseline, heapHistogramSnapshot);
  }, [heapHistogramBaseline, heapHistogramSnapshot, heapHistogramDiffIssue]);
  const visibleHeapHistogramDiffRows = useMemo(() => {
    const result = heapHistogramDiff;
    if (!result) {
      return [];
    }
    const query = heapHistogramDiffQuery.trim().toLocaleLowerCase();
    const rows = result.rows.filter(
      (row) =>
        !query ||
        row.className.toLocaleLowerCase().includes(query) ||
        row.classLoader.toLocaleLowerCase().includes(query),
    );
    return [...rows].sort((left, right) => {
      switch (heapHistogramDiffSort) {
        case "GROWTH":
          return (
            right.shallowBytesDelta - left.shallowBytesDelta ||
            right.instanceDelta - left.instanceDelta ||
            left.className.localeCompare(right.className)
          );
        case "RELEASE":
          return (
            left.shallowBytesDelta - right.shallowBytesDelta ||
            left.instanceDelta - right.instanceDelta ||
            left.className.localeCompare(right.className)
          );
        case "COUNT":
          return (
            Math.abs(right.instanceDelta) - Math.abs(left.instanceDelta) ||
            Math.abs(right.shallowBytesDelta) -
              Math.abs(left.shallowBytesDelta) ||
            left.className.localeCompare(right.className)
          );
        case "CLASS":
          return (
            left.className.localeCompare(right.className) ||
            left.classLoader.localeCompare(right.classLoader)
          );
        case "ABSOLUTE_BYTES":
        default:
          return (
            Math.abs(right.shallowBytesDelta) -
              Math.abs(left.shallowBytesDelta) ||
            Math.abs(right.instanceDelta) - Math.abs(left.instanceDelta) ||
            left.className.localeCompare(right.className)
          );
      }
    });
  }, [heapHistogramDiff, heapHistogramDiffQuery, heapHistogramDiffSort]);
  const classRetainedStatusState: "ready" | "working" =
    classRetainedResult?.exact ? "ready" : "working";
  const classRetainedStatusLabel = classRetainedResult?.exact
    ? t("精确类排行")
    : t("候选类排行");
  const dominatorTreeStatusState: "ready" | "working" =
    dominatorTreeResult?.exact ? "ready" : "working";
  const dominatorTreeStatusLabel = dominatorTreeResult?.exact
    ? t("精确支配树")
    : t("候选支配树");
  const visibleDominatorTreeNodes = useMemo(() => {
    const result = dominatorTreeResult;
    if (!result) {
      return [];
    }
    return result.nodes.filter((node) => {
      let parentIndex = node.parentIndex;
      while (parentIndex >= 0) {
        if (collapsedDominatorNodes.has(parentIndex)) {
          return false;
        }
        parentIndex = result.nodes[parentIndex]?.parentIndex ?? -1;
      }
      return true;
    });
  }, [dominatorTreeResult, collapsedDominatorNodes]);

  function updateProfileTaskId(value: string | null): void {
    profileTaskIdRef.current = value;
    setProfileTaskId(value);
  }

  function updateProfileEngine(value: string | null): void {
    profileEngineRef.current = value;
    setProfileEngine(value);
  }

  async function execute(
    actionId: string,
    parameters: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
  ): Promise<ActionResult | null> {
    if (signal?.aborted) {
      return null;
    }
    const storeState = useTargetsStore.getState();
    const selectedTargetId = storeState.selectedTargetId;
    if (!selectedTargetId || selectConnection(storeState)?.state !== "READY") {
      return null;
    }
    setLoadingAction(actionId);
    setErrorMessage(null);
    if (actionId !== "profile.status") {
      setArtifact(null);
    }
    try {
      const response = await window.tanwei.executeAction({
        targetId: selectedTargetId,
        actionId,
        contractVersion: "1.0",
        parameters,
      });
      if (
        signal?.aborted ||
        useTargetsStore.getState().selectedTargetId !== selectedTargetId
      ) {
        return null;
      }
      if (!response.ok || !response.value) {
        setErrorMessage(response.errorMessage ?? t("诊断操作执行失败"));
        return null;
      }
      if (response.value.status !== "SUCCEEDED") {
        setErrorMessage(response.value.message ?? t("Agent未能完成操作"));
        return null;
      }
      return response.value;
    } catch (error) {
      if (signal?.aborted) {
        return null;
      }
      setErrorMessage(
        error instanceof Error ? error.message : t("诊断操作执行失败"),
      );
      return null;
    } finally {
      if (!signal?.aborted) {
        setLoadingAction(null);
      }
    }
  }

  async function startProfile(): Promise<void> {
    const result = await execute("profile.start", {
      event: profileEvent,
      intervalMillis: String(profileIntervalMillis),
      durationMillis: String(profileDurationSeconds * 1_000),
      stackDepth: String(profileStackDepth),
      threads: profileThreads ? "true" : "false",
      includeRules: profileIncludeRules,
      excludeRules: profileExcludeRules,
    });
    const profile = result ? parseProfileTaskResult(result) : null;
    if (!profile) {
      if (result) {
        setErrorMessage(t("Agent返回了无效的Profiler任务契约"));
      }
      return;
    }
    const { taskId, engine } = profile;
    updateProfileTaskId(taskId);
    setProfileState("RUNNING");
    setProfileSamples(0);
    setProfileDropped(0);
    updateProfileEngine(engine);
    sessionStorage.setItem(
      "tanwei.profile",
      JSON.stringify({
        targetId: useTargetsStore.getState().selectedTargetId,
        taskId,
        event: profileEvent,
        engine,
      }),
    );
    startProfilePolling();
  }

  async function pollProfile(
    signal: AbortSignal = new AbortController().signal,
    expectedTargetId = useTargetsStore.getState().selectedTargetId,
  ): Promise<DiagnosticPollResult> {
    const taskId = profileTaskIdRef.current;
    if (
      !taskId ||
      !expectedTargetId ||
      useTargetsStore.getState().selectedTargetId !== expectedTargetId
    ) {
      return "stop";
    }
    const result = await execute("profile.status", { taskId }, signal);
    if (
      signal.aborted ||
      useTargetsStore.getState().selectedTargetId !== expectedTargetId ||
      profileTaskIdRef.current !== taskId
    ) {
      return "stop";
    }
    if (!result) {
      return "continue";
    }
    const profile = parseProfileTaskResult(result);
    if (!profile) {
      setErrorMessage(t("Agent返回了无效的Profiler任务契约"));
      return "stop";
    }
    const nextState = profile.state;
    setProfileState(nextState);
    setProfileSamples(profile.samples);
    setProfileDropped(profile.dropped);
    updateProfileEngine(profile.engine || profileEngineRef.current);
    if (nextState !== "RUNNING") {
      sessionStorage.removeItem("tanwei.profile");
      if (profile.artifact) {
        await collectResult(profile.artifact);
      }
      return "stop";
    }
    return "continue";
  }

  async function stopProfile(): Promise<void> {
    if (!profileTaskId) {
      return;
    }
    stopProfilePolling();
    const result = await execute("profile.stop", {
      taskId: profileTaskId,
    });
    sessionStorage.removeItem("tanwei.profile");
    if (result) {
      const profile = parseProfileTaskResult(result);
      if (!profile) {
        setErrorMessage(t("Agent返回了无效的Profiler任务契约"));
        return;
      }
      setProfileState(profile.state);
      setProfileSamples(profile.samples);
      setProfileDropped(profile.dropped);
      updateProfileEngine(profile.engine || profileEngineRef.current);
      if (profile.artifact) {
        await collectResult(profile.artifact);
      }
    }
  }

  async function dumpProfile(): Promise<void> {
    if (!profileTaskId) {
      return;
    }
    stopProfilePolling();
    try {
      const result = await execute("profile.dump", {
        taskId: profileTaskId,
      });
      const profile = result ? parseProfileTaskResult(result) : null;
      if (result && !profile) {
        setErrorMessage(t("Agent返回了无效的Profiler任务契约"));
      } else if (profile?.artifact) {
        await collectResult(profile.artifact);
      }
    } finally {
      if (profileTaskIdRef.current) {
        startProfilePolling();
      }
    }
  }

  function startProfilePolling(): void {
    stopProfilePolling();
    const expectedTargetId = useTargetsStore.getState().selectedTargetId;
    if (!expectedTargetId) {
      return;
    }
    const poller = new DiagnosticTaskPoller({
      intervalMillis: 500,
      poll: (signal) => pollProfile(signal, expectedTargetId),
      onError: (error) => {
        setErrorMessage(
          error instanceof Error ? error.message : t("诊断操作执行失败"),
        );
      },
    });
    profilePollerRef.current = poller;
    poller.start();
  }

  function stopProfilePolling(): void {
    profilePollerRef.current?.stop();
    profilePollerRef.current = null;
  }

  async function refreshJfrStatus(): Promise<void> {
    if (!jfrAvailable) {
      setRecording(false);
      return;
    }
    const result = await execute("jfr.status");
    if (result) {
      const status = parseJfrStatus(result);
      if (!status) {
        setErrorMessage(t("Agent返回了无效的JFR状态契约"));
        return;
      }
      setRecording(status.running);
      if (status.running) {
        if (status.recordingName) {
          setJfrRecordingName(status.recordingName);
        }
        if (status.configuration) {
          setJfrConfiguration(status.configuration);
        }
        setJfrMaxAgeMinutes(status.maxAgeMillis / 60_000);
        setJfrMaxSizeMiB(status.maxSizeBytes / 1_048_576);
      }
    }
  }

  async function startJfr(): Promise<void> {
    const result = await execute("jfr.start", {
      configuration: jfrConfiguration,
      maxAgeMillis: String(jfrMaxAgeMinutes * 60_000),
      maxSizeBytes: String(jfrMaxSizeMiB * 1_048_576),
      recordingName: jfrRecordingName.trim(),
    });
    if (result) {
      setRecording(true);
    }
  }

  async function dumpJfr(): Promise<void> {
    const result = await execute("jfr.dump");
    if (result) {
      const ticket = parseArtifactTicket(result, "JFR");
      if (ticket) {
        await collectResult(ticket);
      } else {
        setErrorMessage(t("Agent返回的制品描述无效"));
      }
    }
  }

  async function stopJfr(): Promise<void> {
    const result = await execute("jfr.stop");
    setRecording(false);
    if (result) {
      const ticket = parseArtifactTicket(result, "JFR");
      if (ticket) {
        await collectResult(ticket);
      } else {
        setErrorMessage(t("Agent返回的制品描述无效"));
      }
    }
  }

  async function createHeapDump(): Promise<void> {
    if (!heapConfirmed) {
      return;
    }
    const result = await execute("heap.dump", {
      confirmed: "true",
      live: liveHeapOnly ? "true" : "false",
    });
    setHeapConfirmationVisible(false);
    setHeapConfirmed(false);
    if (result) {
      const ticket = parseArtifactTicket(result, "HEAP_DUMP");
      if (ticket) {
        await collectResult(ticket);
      } else {
        setErrorMessage(t("Agent返回的制品描述无效"));
      }
    }
  }

  async function queryHeapHistogram(): Promise<void> {
    const storeState = useTargetsStore.getState();
    const targetId = storeState.selectedTargetId;
    const targetStartTime =
      selectConnection(storeState)?.target.startTime ?? null;
    if (!heapHistogramConfirmed || !targetId) {
      return;
    }
    const limit = boundedInteger(heapHistogramLimit, 1, 100);
    setHeapHistogramLimit(limit);
    const scanLimit = boundedInteger(heapHistogramScanLimit, 10_000, 5_000_000);
    setHeapHistogramScanLimit(scanLimit);
    const query = heapHistogramClassQuery.trim();
    const result = await execute("heap.histogram", {
      query,
      limit: String(limit),
      scanLimit: String(scanLimit),
      confirmed: "true",
    });
    setHeapHistogramConfirmed(false);
    if (!result || useTargetsStore.getState().selectedTargetId !== targetId) {
      return;
    }
    const histogram = parseHeapHistogramResult(result);
    if (!histogram) {
      setErrorMessage(t("Agent返回了无效的Heap直方图契约"));
      return;
    }
    const {
      rows,
      scanned,
      accountedObjects,
      accountedBytes,
      nonEmptyClasses,
      skippedClasses,
      truncated,
      classSelectionTruncated,
    } = histogram;
    setHeapHistogramRows(rows);
    setHeapHistogramScanned(scanned);
    setHeapHistogramAccountedObjects(accountedObjects);
    setHeapHistogramAccountedBytes(accountedBytes);
    setHeapHistogramNonEmptyClasses(nonEmptyClasses);
    setHeapHistogramSkippedClasses(skippedClasses);
    setHeapHistogramTruncated(truncated);
    setHeapHistogramClassSelectionTruncated(classSelectionTruncated);
    setHeapHistogramSnapshot({
      targetId,
      targetStartTime,
      capturedAt: Date.now(),
      query,
      limit,
      scanLimit,
      scanComplete:
        !truncated && !classSelectionTruncated && skippedClasses === 0,
      rowsComplete: nonEmptyClasses <= rows.length,
      accountedObjects,
      accountedBytes,
      rows: [...rows],
    });
    setHeapHistogramCompleted(true);
  }

  function pinHeapHistogramBaseline(): void {
    const snapshot = heapHistogramSnapshot;
    if (!snapshot || snapshot.targetStartTime === null) {
      return;
    }
    setHeapHistogramBaseline(snapshot);
    setHeapHistogramDiffQuery("");
    setHeapHistogramDiffSort("ABSOLUTE_BYTES");
  }

  async function saveHeapHistogramSnapshot(): Promise<void> {
    const snapshot = heapHistogramSnapshot;
    if (!snapshot || snapshot.targetStartTime === null) {
      setErrorMessage(t("缺少可持久化的 Heap 直方图或 JVM 启动时间"));
      return;
    }
    setLoadingAction("heap.histogram.save");
    setErrorMessage(null);
    try {
      const response = await window.tanwei.createHeapHistogramArtifact({
        snapshot,
      });
      if (!response.ok || !response.value) {
        setErrorMessage(response.errorMessage ?? t("无法保存 Heap 直方图快照"));
        return;
      }
      setArtifact(response.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法保存 Heap 直方图快照"),
      );
    } finally {
      setLoadingAction(null);
    }
  }

  function clearHeapHistogramBaseline(): void {
    setHeapHistogramBaseline(null);
    setHeapHistogramDiffQuery("");
    setHeapHistogramDiffSort("ABSOLUTE_BYTES");
  }

  function resetHeapHistogram(): void {
    setHeapHistogramConfirmed(false);
    setHeapHistogramCompleted(false);
    setHeapHistogramClassQuery("");
    setHeapHistogramRows([]);
    setHeapHistogramQuery("");
    setHeapHistogramScanned(0);
    setHeapHistogramAccountedObjects(0);
    setHeapHistogramAccountedBytes(0);
    setHeapHistogramNonEmptyClasses(0);
    setHeapHistogramSkippedClasses(0);
    setHeapHistogramTruncated(false);
    setHeapHistogramClassSelectionTruncated(false);
    setHeapHistogramSnapshot(null);
    clearHeapHistogramBaseline();
  }

  async function queryClassRetainedHistogram(): Promise<void> {
    if (!classRetainedConfirmed) {
      return;
    }
    const limit = boundedInteger(classRetainedLimit, 1, 200);
    setClassRetainedLimit(limit);
    const maximumNodes = boundedInteger(
      classRetainedMaximumNodes,
      10_000,
      500_000,
    );
    setClassRetainedMaximumNodes(maximumNodes);
    const maximumEdges = boundedInteger(
      classRetainedMaximumEdges,
      10_000,
      2_000_000,
    );
    setClassRetainedMaximumEdges(maximumEdges);
    setClassRetainedResult(null);
    setClassRetainedCompleted(false);
    const result = await execute("heap.retained.classes", {
      query: classRetainedQuery.trim(),
      limit: String(limit),
      maximumNodes: String(maximumNodes),
      maximumEdges: String(maximumEdges),
      confirmed: "true",
    });
    setClassRetainedConfirmed(false);
    if (!result) {
      return;
    }
    const retained = parseClassRetainedResult(result);
    if (!retained) {
      setErrorMessage(t("Agent返回了无效的类Retained排行"));
      return;
    }
    setClassRetainedResult(retained);
    setClassRetainedCompleted(true);
  }

  function resetClassRetainedHistogram(): void {
    setClassRetainedQuery("");
    setClassRetainedConfirmed(false);
    setClassRetainedCompleted(false);
    setClassRetainedResult(null);
  }

  function inspectClassRetainedRow(row: ClassRetainedRow): void {
    void navigate({
      pathname: "/classes",
      search: `?${new URLSearchParams({
        className: row.className,
        classLoader: row.classLoader,
        inspect: "heap",
      }).toString()}`,
    });
  }

  async function queryDominatorTree(): Promise<void> {
    if (!dominatorTreeConfirmed) {
      return;
    }
    const maximumDepth = boundedInteger(dominatorTreeMaximumDepth, 1, 8);
    setDominatorTreeMaximumDepth(maximumDepth);
    const maximumViewNodes = boundedInteger(
      dominatorTreeMaximumViewNodes,
      10,
      200,
    );
    setDominatorTreeMaximumViewNodes(maximumViewNodes);
    const rootLimit = boundedInteger(dominatorTreeRootLimit, 1, 20);
    setDominatorTreeRootLimit(rootLimit);
    const branchLimit = boundedInteger(dominatorTreeBranchLimit, 1, 20);
    setDominatorTreeBranchLimit(branchLimit);
    const maximumNodes = boundedInteger(
      dominatorTreeMaximumNodes,
      10_000,
      500_000,
    );
    setDominatorTreeMaximumNodes(maximumNodes);
    const maximumEdges = boundedInteger(
      dominatorTreeMaximumEdges,
      10_000,
      2_000_000,
    );
    setDominatorTreeMaximumEdges(maximumEdges);
    setDominatorTreeResult(null);
    setDominatorTreeCompleted(false);
    setCollapsedDominatorNodes(new Set<number>());
    const result = await execute("heap.dominator.tree", {
      maximumDepth: String(maximumDepth),
      maximumViewNodes: String(maximumViewNodes),
      rootLimit: String(rootLimit),
      branchLimit: String(branchLimit),
      maximumNodes: String(maximumNodes),
      maximumEdges: String(maximumEdges),
      confirmed: "true",
    });
    setDominatorTreeConfirmed(false);
    if (!result) {
      return;
    }
    const dominator = parseDominatorTreeResult(
      result,
      maximumDepth,
      maximumViewNodes,
    );
    if (!dominator) {
      setErrorMessage(t("Agent返回了无效的支配树"));
      return;
    }
    setDominatorTreeResult(dominator);
    setDominatorTreeCompleted(true);
  }

  function resetDominatorTree(): void {
    setDominatorTreeConfirmed(false);
    setDominatorTreeCompleted(false);
    setDominatorTreeResult(null);
    setCollapsedDominatorNodes(new Set<number>());
  }

  function toggleDominatorNode(node: DominatorTreeNode): void {
    if (node.displayedChildren === 0) {
      return;
    }
    setCollapsedDominatorNodes((previous) => {
      const collapsed = new Set(previous);
      if (collapsed.has(node.index)) {
        collapsed.delete(node.index);
      } else {
        collapsed.add(node.index);
      }
      return collapsed;
    });
  }

  function isDominatorNodeCollapsed(index: number): boolean {
    return collapsedDominatorNodes.has(index);
  }

  function dominatorNodeDepthClass(node: DominatorTreeNode): string {
    return `dominator-tree__node--depth-${node.depth}`;
  }

  function inspectDominatorNode(node: DominatorTreeNode): void {
    void navigate({
      pathname: "/classes",
      search: `?${new URLSearchParams({
        className: node.target.type,
        classLoader: node.classLoader,
        inspect: "object",
        objectHandle: node.target.handle,
        objectIdentity: node.target.identity,
        objectShallowSize: String(node.target.shallowSize),
      }).toString()}`,
    });
  }

  async function collectResult(ticket: ArtifactTicket): Promise<void> {
    const selectedTargetId = useTargetsStore.getState().selectedTargetId;
    if (!selectedTargetId) {
      return;
    }
    setLoadingAction("artifact.collect");
    try {
      const response = await window.tanwei.collectAgentArtifact({
        targetId: selectedTargetId,
        token: ticket.token,
        type: ticket.type,
        expectedSize: ticket.expectedSize,
      });
      if (!response.ok || !response.value) {
        setErrorMessage(response.errorMessage ?? t("无法保存诊断制品"));
        return;
      }
      setArtifact(response.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法保存诊断制品"),
      );
    } finally {
      setLoadingAction(null);
    }
  }

  async function openProfileReport(): Promise<void> {
    if (!artifact || artifact.type !== "PROFILE") {
      return;
    }
    setLoadingAction("report.open");
    setErrorMessage(null);
    try {
      const response = await window.tanwei.openProfileReport(artifact.id);
      if (!response.ok) {
        setErrorMessage(response.errorMessage ?? t("无法打开性能报告"));
      }
    } finally {
      setLoadingAction(null);
    }
  }

  useEffect(() => {
    if (connection?.state === "READY") {
      void refreshJfrStatus();
    } else {
      setRecording(false);
      resetHeapHistogram();
      resetClassRetainedHistogram();
      resetDominatorTree();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  useEffect(() => {
    try {
      const stored = JSON.parse(
        sessionStorage.getItem("tanwei.profile") ?? "null",
      ) as {
        readonly targetId?: string;
        readonly taskId?: string;
        readonly event?: ProfileEvent;
        readonly engine?: string | null;
      } | null;
      if (
        stored?.targetId === useTargetsStore.getState().selectedTargetId &&
        stored.taskId &&
        stored.event
      ) {
        updateProfileTaskId(stored.taskId);
        setProfileEvent(stored.event);
        setProfileState("RUNNING");
        updateProfileEngine(stored.engine ?? null);
        startProfilePolling();
      }
    } catch {
      sessionStorage.removeItem("tanwei.profile");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => stopProfilePolling(), []);

  return (
    <section className="page profile-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">PROFILE</p>
          <h1>{t("留下可验证的性能证据。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "JFR 与 Heap Dump 在目标进程中生成临时文件，经回环加密令牌分块传回本机并校验后，Agent 立即清理临时副本。",
          )}
        </p>
      </header>

      {connection?.state !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">{t("连接目标后启动采集任务。")}</p>
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
          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          <section className="profile-grid">
            <article className="profile-card">
              <header>
                <div>
                  <p className="eyebrow">BOUNDED PROFILER / R1</p>
                  <h2>CPU · Wall · Allocation · Lock</h2>
                </div>
                <StatusPill
                  state={profileState === "RUNNING" ? "ready" : "idle"}
                  label={profileState ?? t("待机")}
                />
              </header>
              <p>
                {t(
                  "受支持平台优先按需加载 async-profiler 4.5；其他平台安全降级为 JDK 有界采样器。两种引擎都生成自包含 HTML，任务切换页面后继续运行。",
                )}
              </p>
              <div className="profile-config">
                <Label>
                  <span>{t("事件")}</span>
                  <SelectControl
                    value={profileEvent}
                    disabled={profileState === "RUNNING"}
                    onValueChange={(value) =>
                      setProfileEvent(value as ProfileEvent)
                    }
                  >
                    <SelectControlItem value="CPU">CPU</SelectControlItem>
                    <SelectControlItem value="WALL">Wall</SelectControlItem>
                    <SelectControlItem value="ALLOCATION">
                      Allocation
                    </SelectControlItem>
                    <SelectControlItem value="LOCK">Lock</SelectControlItem>
                  </SelectControl>
                </Label>
                <Label>
                  <span>{t("时长（秒）")}</span>
                  <Input
                    value={profileDurationSeconds}
                    type="number"
                    min="1"
                    max="60"
                    disabled={profileState === "RUNNING"}
                    onChange={(event) =>
                      setProfileDurationSeconds(Number(event.target.value))
                    }
                  />
                </Label>
                <Label>
                  <span>{t("间隔（ms）")}</span>
                  <Input
                    value={profileIntervalMillis}
                    type="number"
                    min="10"
                    max="1000"
                    disabled={profileState === "RUNNING"}
                    onChange={(event) =>
                      setProfileIntervalMillis(Number(event.target.value))
                    }
                  />
                </Label>
                <Label>
                  <span>{t("最大栈深")}</span>
                  <Input
                    value={profileStackDepth}
                    type="number"
                    min="16"
                    max="2048"
                    disabled={profileState === "RUNNING"}
                    onChange={(event) =>
                      setProfileStackDepth(Number(event.target.value))
                    }
                  />
                </Label>
                <Label className="profile-config__checkbox">
                  <Checkbox
                    checked={profileThreads}
                    disabled={profileState === "RUNNING"}
                    onCheckedChange={(checked) =>
                      setProfileThreads(checked === true)
                    }
                  />
                  <span>{t("按线程拆分火焰图")}</span>
                </Label>
                <Label className="profile-config__rules">
                  <span>{t("Include（每行一个，首尾 * 通配）")}</span>
                  <Textarea
                    value={profileIncludeRules}
                    rows={3}
                    maxLength={1032}
                    disabled={profileState === "RUNNING"}
                    placeholder="com/example/*"
                    onChange={(event) =>
                      setProfileIncludeRules(event.target.value)
                    }
                  />
                </Label>
                <Label className="profile-config__rules">
                  <span>{t("Exclude（每行一个，首尾 * 通配）")}</span>
                  <Textarea
                    value={profileExcludeRules}
                    rows={3}
                    maxLength={1032}
                    disabled={profileState === "RUNNING"}
                    placeholder="*GeneratedMethodAccessor*"
                    onChange={(event) =>
                      setProfileExcludeRules(event.target.value)
                    }
                  />
                </Label>
              </div>
              {profileTaskId && (
                <p>
                  {t("样本 {samples} · 丢弃 {dropped} · {taskId}", {
                    samples: profileSamples,
                    dropped: profileDropped,
                    taskId: profileTaskId,
                  })}
                </p>
              )}
              {profileEngine && (
                <p className="profile-engine">
                  {t("引擎：{engine}", { engine: profileEngine })}
                </p>
              )}
              <div className="profile-card__actions">
                {profileState !== "RUNNING" ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      Boolean(!profilerAvailable) ||
                      Boolean(loadingAction === "profile.start")
                    }
                    onClick={() => void startProfile()}
                    aria-busy={Boolean(loadingAction === "profile.start")}
                  >
                    {Boolean(loadingAction === "profile.start") && <Spinner />}
                    {t("开始剖析")}
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void dumpProfile()}
                      aria-busy={Boolean(
                        loadingAction === "profile.dump" ||
                          loadingAction === "artifact.collect",
                      )}
                      disabled={Boolean(
                        loadingAction === "profile.dump" ||
                          loadingAction === "profile.stop" ||
                          loadingAction === "artifact.collect",
                      )}
                    >
                      {Boolean(
                        loadingAction === "profile.dump" ||
                          loadingAction === "artifact.collect",
                      ) && <Spinner />}
                      {t("保存当前报告")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void stopProfile()}
                      aria-busy={Boolean(loadingAction === "profile.stop")}
                      disabled={Boolean(
                        loadingAction === "profile.dump" ||
                          loadingAction === "profile.stop" ||
                          loadingAction === "artifact.collect",
                      )}
                    >
                      {Boolean(loadingAction === "profile.stop") && <Spinner />}
                      {t("停止并保存")}
                    </Button>
                  </>
                )}
                {!profilerAvailable && (
                  <span>{t("当前 JVM 不支持有界剖析。")}</span>
                )}
              </div>
            </article>

            <article className="profile-card">
              <header>
                <div>
                  <p className="eyebrow">JFR / R1</p>
                  <h2>{t("低开销持续记录")}</h2>
                </div>
                <StatusPill
                  state={recording ? "ready" : "idle"}
                  label={recording ? t("记录中") : t("待机")}
                />
              </header>
              <p>
                {t(
                  "使用目标 JDK 自带的 Flight Recorder。可限制磁盘保留窗口与容量；运行中快照不会停止录制。",
                )}
              </p>
              <div className="profile-config">
                <Label className="profile-config__wide">
                  <span>{t("录制名称")}</span>
                  <Input
                    value={jfrRecordingName}
                    maxLength={128}
                    disabled={recording}
                    onChange={(event) =>
                      setJfrRecordingName(event.target.value)
                    }
                  />
                </Label>
                <Label>
                  <span>{t("配置")}</span>
                  <SelectControl
                    value={jfrConfiguration}
                    disabled={recording}
                    onValueChange={(value) =>
                      setJfrConfiguration(value as "PROFILE" | "DEFAULT")
                    }
                  >
                    <SelectControlItem value="PROFILE">
                      Profile
                    </SelectControlItem>
                    <SelectControlItem value="DEFAULT">
                      Default
                    </SelectControlItem>
                  </SelectControl>
                </Label>
                <Label>
                  <span>{t("最大保留（分钟，0=不限）")}</span>
                  <Input
                    value={jfrMaxAgeMinutes}
                    type="number"
                    min="0"
                    max="1440"
                    disabled={recording}
                    onChange={(event) =>
                      setJfrMaxAgeMinutes(Number(event.target.value))
                    }
                  />
                </Label>
                <Label>
                  <span>{t("最大容量（MiB，0=不限）")}</span>
                  <Input
                    value={jfrMaxSizeMiB}
                    type="number"
                    min="0"
                    max="10240"
                    disabled={recording}
                    onChange={(event) =>
                      setJfrMaxSizeMiB(Number(event.target.value))
                    }
                  />
                </Label>
              </div>
              <div className="profile-card__actions">
                {!recording ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      Boolean(!jfrAvailable) ||
                      jfrRecordingName.trim().length === 0 ||
                      Boolean(loadingAction === "jfr.start")
                    }
                    onClick={() => void startJfr()}
                    aria-busy={Boolean(loadingAction === "jfr.start")}
                  >
                    {Boolean(loadingAction === "jfr.start") && <Spinner />}
                    {t("开始记录")}
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void dumpJfr()}
                      aria-busy={Boolean(loadingAction === "jfr.dump")}
                      disabled={Boolean(loadingAction)}
                    >
                      {Boolean(loadingAction === "jfr.dump") && <Spinner />}
                      {t("保存运行中快照")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void stopJfr()}
                      aria-busy={Boolean(
                        loadingAction === "jfr.stop" ||
                          loadingAction === "artifact.collect",
                      )}
                      disabled={Boolean(loadingAction)}
                    >
                      {Boolean(
                        loadingAction === "jfr.stop" ||
                          loadingAction === "artifact.collect",
                      ) && <Spinner />}
                      {t("停止并保存")}
                    </Button>
                  </>
                )}
                {!jfrAvailable && <span>{t("当前 JDK 不支持 JFR。")}</span>}
              </div>
            </article>

            <article className="profile-card profile-card--risk">
              <header>
                <div>
                  <p className="eyebrow">HEAP DUMP / R2</p>
                  <h2>{t("高影响内存快照")}</h2>
                </div>
                <StatusPill state="idle" label={t("需确认")} />
              </header>
              <p>
                {t(
                  "生成期间可能触发长时间停顿并占用大量磁盘。主进程会在执行前校验能力、确认参数、配额和磁盘余量。",
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={!heapDumpAvailable}
                onClick={() => setHeapConfirmationVisible(true)}
              >
                {t("准备HeapDump")}
              </Button>

              {heapConfirmationVisible && (
                <div className="risk-confirmation">
                  <p className="eyebrow">EXPLICIT CONFIRMATION</p>
                  <Label>
                    <Checkbox
                      checked={liveHeapOnly}
                      onCheckedChange={(event) =>
                        setLiveHeapOnly(event === true)
                      }
                    />
                    <span>{t("只保留存活对象（建议，可能触发 Full GC）")}</span>
                  </Label>
                  <Label>
                    <Checkbox
                      checked={heapConfirmed}
                      onCheckedChange={(event) =>
                        setHeapConfirmed(event === true)
                      }
                    />
                    <span>
                      {t("我理解目标 JVM 可能长时间停顿且制品可能包含敏感数据")}
                    </span>
                  </Label>
                  <div className="profile-card__actions">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        Boolean(!heapConfirmed) ||
                        Boolean(
                          loadingAction === "heap.dump" ||
                            loadingAction === "artifact.collect",
                        )
                      }
                      onClick={() => void createHeapDump()}
                      aria-busy={Boolean(
                        loadingAction === "heap.dump" ||
                          loadingAction === "artifact.collect",
                      )}
                    >
                      {Boolean(
                        loadingAction === "heap.dump" ||
                          loadingAction === "artifact.collect",
                      ) && <Spinner />}
                      {t("确认生成并保存")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setHeapConfirmationVisible(false);
                        setHeapConfirmed(false);
                      }}
                    >
                      {t("取消")}
                    </Button>
                  </div>
                </div>
              )}
            </article>
          </section>

          <section className="heap-histogram">
            <header className="heap-histogram__header">
              <div>
                <p className="eyebrow">HEAP CLASS HISTOGRAM / R2</p>
                <h2>{t("堆里是什么。")}</h2>
                <p>
                  {t(
                    "按类统计实例数量与浅大小，用于快速定位内存主体。它不是 retained size，也不替代离线 Heap Dump 分析。",
                  )}
                </p>
              </div>
              <StatusPill
                state={heapHistogramCompleted ? "ready" : "idle"}
                label={heapHistogramCompleted ? t("已扫描") : t("需确认")}
              />
            </header>

            <div className="heap-histogram__controls">
              <Label>
                <span>{t("类名扫描范围（可选）")}</span>
                <Input
                  value={heapHistogramClassQuery}
                  type="search"
                  maxLength={256}
                  placeholder={t("例如 dev.example 或 java.lang.String")}
                  disabled={loadingAction === "heap.histogram"}
                  onChange={(event) =>
                    setHeapHistogramClassQuery(event.target.value)
                  }
                />
              </Label>
              <Label>
                <span>{t("结果行数")}</span>
                <Input
                  value={heapHistogramLimit}
                  type="number"
                  min="1"
                  max="100"
                  disabled={loadingAction === "heap.histogram"}
                  onChange={(event) =>
                    setHeapHistogramLimit(Number(event.target.value))
                  }
                />
              </Label>
              <Label>
                <span>{t("对象遍历预算")}</span>
                <SelectControl
                  value={heapHistogramScanLimit}
                  disabled={loadingAction === "heap.histogram"}
                  onValueChange={(value) =>
                    setHeapHistogramScanLimit(Number(value))
                  }
                >
                  <SelectControlItem value={250000}>
                    250,000
                  </SelectControlItem>
                  <SelectControlItem value={1000000}>
                    1,000,000
                  </SelectControlItem>
                  <SelectControlItem value={5000000}>
                    5,000,000
                  </SelectControlItem>
                </SelectControl>
              </Label>
              <Label className="heap-histogram__confirmation">
                <Checkbox
                  checked={heapHistogramConfirmed}
                  disabled={
                    !heapHistogramAvailable ||
                    loadingAction === "heap.histogram"
                  }
                  onCheckedChange={(event) =>
                    setHeapHistogramConfirmed(event === true)
                  }
                />
                <span>{t("我理解遍历 Heap 可能造成目标 JVM 短暂停顿。")}</span>
              </Label>
              <Button
                type="button"
                variant="secondary"
                disabled={
                  Boolean(!heapHistogramAvailable || !heapHistogramConfirmed) ||
                  Boolean(loadingAction === "heap.histogram")
                }
                onClick={() => void queryHeapHistogram()}
                aria-busy={Boolean(loadingAction === "heap.histogram")}
              >
                {Boolean(loadingAction === "heap.histogram") && <Spinner />}
                {t("扫描Heap直方图")}
              </Button>
            </div>

            {!heapHistogramAvailable && (
              <p className="heap-histogram__boundary">
                {t("当前 Agent 不支持 Heap 类直方图。")}
              </p>
            )}

            {heapHistogramCompleted && (
              <>
                <div className="heap-histogram__metrics">
                  <div>
                    <span>{t("已遍历对象")}</span>
                    <strong>{formatInteger(heapHistogramScanned)}</strong>
                  </div>
                  <div>
                    <span>{t("已归类实例")}</span>
                    <strong>
                      {formatInteger(heapHistogramAccountedObjects)}
                    </strong>
                  </div>
                  <div>
                    <span>{t("已归类浅大小")}</span>
                    <strong>{formatBytes(heapHistogramAccountedBytes)}</strong>
                  </div>
                  <div>
                    <span>{t("结果类")}</span>
                    <strong>{formatInteger(heapHistogramRows.length)}</strong>
                  </div>
                </div>

                {(heapHistogramTruncated ||
                  heapHistogramClassSelectionTruncated ||
                  heapHistogramSkippedClasses > 0) && (
                  <p className="heap-histogram__boundary">
                    {t(
                      "本次结果受安全边界限制：遍历截断 {truncated}，类集合截断 {classes}，跳过已有 JVMTI 标签的类 {skipped}。",
                      {
                        truncated: heapHistogramTruncated ? t("是") : t("否"),
                        classes: heapHistogramClassSelectionTruncated
                          ? t("是")
                          : t("否"),
                        skipped: heapHistogramSkippedClasses,
                      },
                    )}
                  </p>
                )}

                <div className="heap-histogram__toolbar">
                  <Label>
                    <span>{t("筛选类或ClassLoader")}</span>
                    <Input
                      value={heapHistogramQuery}
                      type="search"
                      placeholder={t("输入类名或ClassLoader")}
                      onChange={(event) =>
                        setHeapHistogramQuery(event.target.value)
                      }
                    />
                  </Label>
                  <Label>
                    <span>{t("排序")}</span>
                    <SelectControl
                      value={heapHistogramSort}
                      onValueChange={(value) =>
                        setHeapHistogramSort(
                          value as HistogramSort,
                        )
                      }
                    >
                      <SelectControlItem value="BYTES">
                        {t("浅大小")}
                      </SelectControlItem>
                      <SelectControlItem value="COUNT">
                        {t("实例数")}
                      </SelectControlItem>
                      <SelectControlItem value="AVERAGE">
                        {t("平均浅大小")}
                      </SelectControlItem>
                      <SelectControlItem value="CLASS">
                        {t("类名")}
                      </SelectControlItem>
                    </SelectControl>
                  </Label>
                </div>

                <div className="heap-histogram__table-wrap">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t("类名")}</TableHead>
                        <TableHead scope="col">{t("ClassLoader")}</TableHead>
                        <TableHead scope="col">{t("实例数")}</TableHead>
                        <TableHead scope="col">{t("浅大小")}</TableHead>
                        <TableHead scope="col">{t("平均")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleHeapHistogramRows.map((row) => (
                        <TableRow key={`${row.className}:${row.classLoader}`}>
                          <TableCell>
                            <code>{row.className}</code>
                          </TableCell>
                          <TableCell title={row.classLoader}>
                            {row.classLoader}
                          </TableCell>
                          <TableCell>
                            {formatInteger(row.instanceCount)}
                          </TableCell>
                          <TableCell>{formatBytes(row.shallowBytes)}</TableCell>
                          <TableCell>
                            {formatBytes(row.averageShallowBytes)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {visibleHeapHistogramRows.length === 0 && (
                    <p className="heap-histogram__empty">
                      {t("没有匹配的 Heap 类。")}
                    </p>
                  )}
                </div>

                <p className="heap-histogram__boundary">
                  {t(
                    "一次有界 JVMTI Heap 遍历；临时类标签在返回前清除，不保留业务对象。",
                  )}
                </p>

                <section
                  className="heap-histogram-diff"
                  aria-labelledby="heap-histogram-diff-title"
                >
                  <header className="heap-histogram-diff__header">
                    <div>
                      <p className="eyebrow">HEAP HISTOGRAM DIFF / R2</p>
                      <h3 id="heap-histogram-diff-title">
                        {t("两次扫描之间，哪些类在增长。")}
                      </h3>
                      <p>
                        {t(
                          "固定当前扫描，再以完全相同的类范围与预算扫描一次；差分只在同一目标和 JVM 启动周期内成立。",
                        )}
                      </p>
                    </div>
                    <div className="heap-histogram-diff__actions">
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={
                          Boolean(
                            !heapHistogramSnapshot ||
                              heapHistogramSnapshot.targetStartTime === null ||
                              loadingAction !== null,
                          ) || Boolean(loadingAction === "heap.histogram.save")
                        }
                        onClick={() => void saveHeapHistogramSnapshot()}
                        aria-busy={Boolean(
                          loadingAction === "heap.histogram.save",
                        )}
                      >
                        {Boolean(loadingAction === "heap.histogram.save") && (
                          <Spinner />
                        )}
                        {t("保存跨会话快照")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          !heapHistogramSnapshot ||
                          heapHistogramSnapshot.targetStartTime === null
                        }
                        onClick={pinHeapHistogramBaseline}
                      >
                        {t("固定当前为基线")}
                      </Button>
                      {heapHistogramBaseline && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={clearHeapHistogramBaseline}
                        >
                          {t("清除基线")}
                        </Button>
                      )}
                    </div>
                  </header>

                  {!heapHistogramBaseline ? (
                    <p className="heap-histogram-diff__empty">
                      {t(
                        "尚未固定基线。当前扫描只展示绝对值，不推断对象增长或释放。",
                      )}
                    </p>
                  ) : (
                    <>
                      <div className="heap-histogram-diff__identity">
                        <p>
                          <span>{t("基线")}</span>
                          <strong>
                            {formatDateTime(heapHistogramBaseline.capturedAt)}
                          </strong>
                        </p>
                        <p>
                          <span>{t("当前")}</span>
                          <strong>
                            {heapHistogramSnapshot
                              ? `${formatDateTime(
                                  heapHistogramSnapshot.capturedAt,
                                )} · ${t("间隔 {duration}", {
                                  duration: formatHistogramInterval(
                                    heapHistogramBaseline.capturedAt,
                                    heapHistogramSnapshot.capturedAt,
                                  ),
                                })}`
                              : t("等待扫描")}
                          </strong>
                        </p>
                        <p>
                          <span>{t("类范围")}</span>
                          <strong>
                            {heapHistogramBaseline.query || t("全部已加载类")}
                          </strong>
                        </p>
                        <p>
                          <span>{t("遍历预算")}</span>
                          <strong>
                            {formatInteger(heapHistogramBaseline.scanLimit)}
                          </strong>
                        </p>
                      </div>

                      {heapHistogramDiffIssue ? (
                        <p className="heap-histogram-diff__boundary">
                          {heapHistogramDiffIssueMessage(
                            heapHistogramDiffIssue,
                          )}
                        </p>
                      ) : (
                        heapHistogramDiff && (
                          <>
                            <div className="heap-histogram-diff__metrics">
                              <div>
                                <span>{t("实例净变化")}</span>
                                <strong>
                                  {formatSignedInteger(
                                    heapHistogramDiff.instanceDelta,
                                  )}
                                </strong>
                              </div>
                              <div>
                                <span>{t("浅大小净变化")}</span>
                                <strong>
                                  {formatSignedBytes(
                                    heapHistogramDiff.shallowBytesDelta,
                                  )}
                                </strong>
                              </div>
                              <div>
                                <span>{t("增长类")}</span>
                                <strong>
                                  {formatInteger(
                                    heapHistogramDiff.growingClasses,
                                  )}
                                </strong>
                              </div>
                              <div>
                                <span>{t("释放类")}</span>
                                <strong>
                                  {formatInteger(
                                    heapHistogramDiff.releasedClasses,
                                  )}
                                </strong>
                              </div>
                            </div>

                            {(!heapHistogramDiff.exactRowCoverage ||
                              !heapHistogramDiff.totalsComparable) && (
                              <p className="heap-histogram-diff__boundary">
                                {t(
                                  "覆盖不完整：总量截断 {totals}；Top N 未覆盖的基线行 {baseline}、当前行 {current} 不参与新增或释放判定。",
                                  {
                                    totals: heapHistogramDiff.totalsComparable
                                      ? t("否")
                                      : t("是"),
                                    baseline:
                                      heapHistogramDiff.unmatchedBaselineRows,
                                    current:
                                      heapHistogramDiff.unmatchedCurrentRows,
                                  },
                                )}
                              </p>
                            )}

                            <div className="heap-histogram-diff__toolbar">
                              <Label>
                                <span>{t("筛选差分类或ClassLoader")}</span>
                                <Input
                                  value={heapHistogramDiffQuery}
                                  type="search"
                                  placeholder={t("输入类名或ClassLoader")}
                                  onChange={(event) =>
                                    setHeapHistogramDiffQuery(
                                      event.target.value,
                                    )
                                  }
                                />
                              </Label>
                              <Label>
                                <span>{t("差分排序")}</span>
                                <SelectControl
                                  value={heapHistogramDiffSort}
                                  onValueChange={(value) =>
                                    setHeapHistogramDiffSort(
                                      value as HistogramDiffSort,
                                    )
                                  }
                                >
                                  <SelectControlItem value="ABSOLUTE_BYTES">
                                    {t("绝对浅大小变化")}
                                  </SelectControlItem>
                                  <SelectControlItem value="GROWTH">
                                    {t("增长优先")}
                                  </SelectControlItem>
                                  <SelectControlItem value="RELEASE">
                                    {t("释放优先")}
                                  </SelectControlItem>
                                  <SelectControlItem value="COUNT">
                                    {t("绝对实例变化")}
                                  </SelectControlItem>
                                  <SelectControlItem value="CLASS">
                                    {t("类名")}
                                  </SelectControlItem>
                                </SelectControl>
                              </Label>
                            </div>

                            <div className="heap-histogram-diff__table-wrap">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead scope="col">
                                      {t("类与ClassLoader")}
                                    </TableHead>
                                    <TableHead scope="col">
                                      {t("基线实例")}
                                    </TableHead>
                                    <TableHead scope="col">
                                      {t("当前实例")}
                                    </TableHead>
                                    <TableHead scope="col">
                                      {t("实例变化")}
                                    </TableHead>
                                    <TableHead scope="col">
                                      {t("浅大小变化")}
                                    </TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {visibleHeapHistogramDiffRows.map((row) => (
                                    <TableRow
                                      key={`${row.className}:${row.classLoader}`}
                                    >
                                      <TableCell>
                                        <code>{row.className}</code>
                                        <small title={row.classLoader}>
                                          {row.classLoader}
                                        </small>
                                      </TableCell>
                                      <TableCell>
                                        {formatInteger(row.baselineInstances)}
                                      </TableCell>
                                      <TableCell>
                                        {formatInteger(row.currentInstances)}
                                      </TableCell>
                                      <TableCell
                                        className={heapHistogramDiffKindClass(
                                          row.kind,
                                        )}
                                      >
                                        {formatSignedInteger(row.instanceDelta)}
                                      </TableCell>
                                      <TableCell
                                        className={heapHistogramDiffKindClass(
                                          row.kind,
                                        )}
                                      >
                                        {formatSignedBytes(
                                          row.shallowBytesDelta,
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                              {visibleHeapHistogramDiffRows.length === 0 && (
                                <p className="heap-histogram-diff__empty">
                                  {t("没有可比较的 Heap 类。")}
                                </p>
                              )}
                            </div>

                            <p className="heap-histogram-diff__boundary">
                              {t(
                                "差分使用类名与精确 ClassLoader 身份联合匹配，时间复杂度 O(B+C)，不会保留业务对象。",
                              )}
                            </p>
                          </>
                        )
                      )}
                    </>
                  )}
                </section>
              </>
            )}
          </section>

          <section
            className="class-retained"
            aria-labelledby="class-retained-title"
          >
            <header className="class-retained__header">
              <div>
                <p className="eyebrow">CLASS RETAINED UNION / R2</p>
                <h2 id="class-retained-title">{t("谁真正占住了内存。")}</h2>
                <p>
                  {t(
                    "一次全堆支配分析，按类合并同类实例的支配子树；嵌套的同类实例只计算一次。",
                  )}
                </p>
              </div>
              <StatusPill
                state={
                  classRetainedCompleted ? classRetainedStatusState : "idle"
                }
                label={
                  classRetainedCompleted
                    ? classRetainedStatusLabel
                    : t("需确认")
                }
              />
            </header>

            <div className="class-retained__controls">
              <Label>
                <span>{t("结果筛选（可选）")}</span>
                <Input
                  value={classRetainedQuery}
                  type="search"
                  maxLength={256}
                  placeholder={t("例如 dev.example 或 ClassLoader")}
                  disabled={loadingAction === "heap.retained.classes"}
                  onChange={(event) =>
                    setClassRetainedQuery(event.target.value)
                  }
                />
              </Label>
              <Label>
                <span>{t("结果行数")}</span>
                <SelectControl
                  value={classRetainedLimit}
                  disabled={loadingAction === "heap.retained.classes"}
                  onValueChange={(value) =>
                    setClassRetainedLimit(Number(value))
                  }
                >
                  <SelectControlItem value={20}>20</SelectControlItem>
                  <SelectControlItem value={50}>50</SelectControlItem>
                  <SelectControlItem value={100}>100</SelectControlItem>
                  <SelectControlItem value={200}>200</SelectControlItem>
                </SelectControl>
              </Label>
              <Label>
                <span>{t("支配图节点预算")}</span>
                <SelectControl
                  value={classRetainedMaximumNodes}
                  disabled={loadingAction === "heap.retained.classes"}
                  onValueChange={(value) =>
                    setClassRetainedMaximumNodes(Number(value))
                  }
                >
                  <SelectControlItem value={100000}>
                    100,000
                  </SelectControlItem>
                  <SelectControlItem value={250000}>
                    250,000
                  </SelectControlItem>
                  <SelectControlItem value={500000}>
                    500,000
                  </SelectControlItem>
                </SelectControl>
              </Label>
              <Label>
                <span>{t("支配图边预算")}</span>
                <SelectControl
                  value={classRetainedMaximumEdges}
                  disabled={loadingAction === "heap.retained.classes"}
                  onValueChange={(value) =>
                    setClassRetainedMaximumEdges(Number(value))
                  }
                >
                  <SelectControlItem value={250000}>
                    250,000
                  </SelectControlItem>
                  <SelectControlItem value={1000000}>
                    1,000,000
                  </SelectControlItem>
                  <SelectControlItem value={2000000}>
                    2,000,000
                  </SelectControlItem>
                </SelectControl>
              </Label>
            </div>

            <Label className="class-retained__confirmation">
              <Checkbox
                checked={classRetainedConfirmed}
                disabled={
                  !heapHistogramAvailable ||
                  loadingAction === "heap.retained.classes"
                }
                onCheckedChange={(event) =>
                  setClassRetainedConfirmed(event === true)
                }
              />
              <span>
                {t(
                  "我确认执行一次有界全堆强引用扫描，并使用最多 {nodes} 个节点、{edges} 条边计算类级支配并集。",
                  {
                    nodes: classRetainedMaximumNodes.toLocaleString(),
                    edges: classRetainedMaximumEdges.toLocaleString(),
                  },
                )}
              </span>
            </Label>

            <Button
              type="button"
              variant="secondary"
              disabled={
                Boolean(!heapHistogramAvailable || !classRetainedConfirmed) ||
                Boolean(loadingAction === "heap.retained.classes")
              }
              onClick={() => void queryClassRetainedHistogram()}
              aria-busy={Boolean(loadingAction === "heap.retained.classes")}
            >
              {Boolean(loadingAction === "heap.retained.classes") && (
                <Spinner />
              )}
              {t("计算类 Retained 排行")}
            </Button>

            {classRetainedCompleted && classRetainedResult && (
              <>
                <div className="class-retained__metrics">
                  <div>
                    <span>{t("强引用图")}</span>
                    <strong>
                      {t("{nodes} 节点 / {edges} 边", {
                        nodes: formatInteger(classRetainedResult.graphNodes),
                        edges: formatInteger(classRetainedResult.graphEdges),
                      })}
                    </strong>
                  </div>
                  <div>
                    <span>{t("可达内存")}</span>
                    <strong>
                      {formatBytes(classRetainedResult.reachableBytes)}
                    </strong>
                  </div>
                  <div>
                    <span>{t("已归类实例")}</span>
                    <strong>
                      {formatInteger(classRetainedResult.accountedObjects)}
                    </strong>
                  </div>
                  <div>
                    <span>{t("类型标签")}</span>
                    <strong>
                      {t("{tagged} 完成 / {skipped} 跳过", {
                        tagged: formatInteger(
                          classRetainedResult.taggedClasses,
                        ),
                        skipped: formatInteger(
                          classRetainedResult.skippedTaggedClasses,
                        ),
                      })}
                    </strong>
                  </div>
                </div>

                {!classRetainedResult.exact && (
                  <p className="class-retained__boundary">
                    {t(
                      "预算或元数据边界已触顶，当前显示候选支配并集，不标记为精确 Retained。",
                    )}
                  </p>
                )}

                <div className="class-retained__table-wrap">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t("排名")}</TableHead>
                        <TableHead scope="col">
                          {t("类 / ClassLoader")}
                        </TableHead>
                        <TableHead scope="col">{t("实例数")}</TableHead>
                        <TableHead scope="col">{t("浅大小")}</TableHead>
                        <TableHead scope="col">{t("支配对象")}</TableHead>
                        <TableHead scope="col">
                          {classRetainedResult.exact
                            ? t("精确 Retained")
                            : t("候选 Retained")}
                        </TableHead>
                        <TableHead scope="col">{t("钻取")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {classRetainedResult.rows.map((row) => (
                        <TableRow key={`${row.className}:${row.classLoader}`}>
                          <TableCell>#{row.rank}</TableCell>
                          <TableCell>
                            <code>{row.className}</code>
                            <small title={row.classLoader}>
                              {row.classLoader}
                            </small>
                          </TableCell>
                          <TableCell>
                            {formatInteger(row.instanceCount)}
                          </TableCell>
                          <TableCell>{formatBytes(row.shallowBytes)}</TableCell>
                          <TableCell>
                            {formatInteger(row.retainedObjects)}
                          </TableCell>
                          <TableCell>
                            {formatBytes(
                              classRetainedResult.exact
                                ? row.retainedBytes
                                : row.candidateRetainedBytes,
                            )}
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => inspectClassRetainedRow(row)}
                            >
                              {t("检查实例")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {classRetainedResult.rows.length === 0 && (
                    <p className="class-retained__empty">
                      {t("当前筛选没有存活实例。")}
                    </p>
                  )}
                </div>

                <p className="class-retained__boundary">
                  {t(
                    "类级值是该类最上层支配节点子树的并集；不会重复累计被同类祖先支配的实例。",
                  )}
                </p>
              </>
            )}
          </section>

          <section
            className="dominator-tree"
            aria-labelledby="dominator-tree-title"
          >
            <header className="dominator-tree__header">
              <div>
                <p className="eyebrow">WHOLE-HEAP DOMINATOR TREE / R2</p>
                <h2 id="dominator-tree-title">{t("沿着支配关系向下看。")}</h2>
                <p>
                  {t(
                    "从虚拟 GC Root 开始，优先保留 Retained 最大的直接支配子节点；折叠只影响当前视图，不会重新扫描 Heap。",
                  )}
                </p>
              </div>
              <StatusPill
                state={
                  dominatorTreeCompleted ? dominatorTreeStatusState : "idle"
                }
                label={
                  dominatorTreeCompleted
                    ? dominatorTreeStatusLabel
                    : t("需确认")
                }
              />
            </header>

            <div className="dominator-tree__controls">
              <Label>
                <span>{t("视图深度")}</span>
                <SelectControl
                  value={dominatorTreeMaximumDepth}
                  disabled={loadingAction === "heap.dominator.tree"}
                  onValueChange={(value) =>
                    setDominatorTreeMaximumDepth(Number(value))
                  }
                >
                  <SelectControlItem value={2}>2</SelectControlItem>
                  <SelectControlItem value={4}>4</SelectControlItem>
                  <SelectControlItem value={6}>6</SelectControlItem>
                  <SelectControlItem value={8}>8</SelectControlItem>
                </SelectControl>
              </Label>
              <Label>
                <span>{t("视图节点")}</span>
                <SelectControl
                  value={dominatorTreeMaximumViewNodes}
                  disabled={loadingAction === "heap.dominator.tree"}
                  onValueChange={(value) =>
                    setDominatorTreeMaximumViewNodes(Number(value))
                  }
                >
                  <SelectControlItem value={40}>40</SelectControlItem>
                  <SelectControlItem value={80}>80</SelectControlItem>
                  <SelectControlItem value={120}>120</SelectControlItem>
                  <SelectControlItem value={200}>200</SelectControlItem>
                </SelectControl>
              </Label>
              <Label>
                <span>{t("GC Root 分支")}</span>
                <SelectControl
                  value={dominatorTreeRootLimit}
                  disabled={loadingAction === "heap.dominator.tree"}
                  onValueChange={(value) =>
                    setDominatorTreeRootLimit(Number(value))
                  }
                >
                  <SelectControlItem value={5}>5</SelectControlItem>
                  <SelectControlItem value={10}>10</SelectControlItem>
                  <SelectControlItem value={20}>20</SelectControlItem>
                </SelectControl>
              </Label>
              <Label>
                <span>{t("每节点分支")}</span>
                <SelectControl
                  value={dominatorTreeBranchLimit}
                  disabled={loadingAction === "heap.dominator.tree"}
                  onValueChange={(value) =>
                    setDominatorTreeBranchLimit(Number(value))
                  }
                >
                  <SelectControlItem value={3}>3</SelectControlItem>
                  <SelectControlItem value={5}>5</SelectControlItem>
                  <SelectControlItem value={10}>10</SelectControlItem>
                  <SelectControlItem value={20}>20</SelectControlItem>
                </SelectControl>
              </Label>
              <Label>
                <span>{t("支配图节点预算")}</span>
                <SelectControl
                  value={dominatorTreeMaximumNodes}
                  disabled={loadingAction === "heap.dominator.tree"}
                  onValueChange={(value) =>
                    setDominatorTreeMaximumNodes(Number(value))
                  }
                >
                  <SelectControlItem value={100000}>
                    100,000
                  </SelectControlItem>
                  <SelectControlItem value={250000}>
                    250,000
                  </SelectControlItem>
                  <SelectControlItem value={500000}>
                    500,000
                  </SelectControlItem>
                </SelectControl>
              </Label>
              <Label>
                <span>{t("支配图边预算")}</span>
                <SelectControl
                  value={dominatorTreeMaximumEdges}
                  disabled={loadingAction === "heap.dominator.tree"}
                  onValueChange={(value) =>
                    setDominatorTreeMaximumEdges(Number(value))
                  }
                >
                  <SelectControlItem value={250000}>
                    250,000
                  </SelectControlItem>
                  <SelectControlItem value={1000000}>
                    1,000,000
                  </SelectControlItem>
                  <SelectControlItem value={2000000}>
                    2,000,000
                  </SelectControlItem>
                </SelectControl>
              </Label>
            </div>

            <Label className="dominator-tree__confirmation">
              <Checkbox
                checked={dominatorTreeConfirmed}
                disabled={
                  !heapHistogramAvailable ||
                  loadingAction === "heap.dominator.tree"
                }
                onCheckedChange={(event) =>
                  setDominatorTreeConfirmed(event === true)
                }
              />
              <span>
                {t(
                  "我确认构建最多 {nodes} 个节点、{edges} 条边的全堆支配图，并仅展示最多 {view} 个关键节点。",
                  {
                    nodes: dominatorTreeMaximumNodes.toLocaleString(),
                    edges: dominatorTreeMaximumEdges.toLocaleString(),
                    view: dominatorTreeMaximumViewNodes.toLocaleString(),
                  },
                )}
              </span>
            </Label>

            <Button
              type="button"
              variant="secondary"
              disabled={
                Boolean(!heapHistogramAvailable || !dominatorTreeConfirmed) ||
                Boolean(loadingAction === "heap.dominator.tree")
              }
              onClick={() => void queryDominatorTree()}
              aria-busy={Boolean(loadingAction === "heap.dominator.tree")}
            >
              {Boolean(loadingAction === "heap.dominator.tree") && <Spinner />}
              {t("构建支配树")}
            </Button>

            {dominatorTreeCompleted && dominatorTreeResult && (
              <>
                <div className="dominator-tree__metrics">
                  <div>
                    <span>{t("完整强引用图")}</span>
                    <strong>
                      {t("{nodes} 节点 / {edges} 边", {
                        nodes: formatInteger(dominatorTreeResult.graphNodes),
                        edges: formatInteger(dominatorTreeResult.graphEdges),
                      })}
                    </strong>
                  </div>
                  <div>
                    <span>{t("根可达内存")}</span>
                    <strong>
                      {formatBytes(dominatorTreeResult.reachableBytes)}
                    </strong>
                  </div>
                  <div>
                    <span>{t("GC Root 直接子节点")}</span>
                    <strong>
                      {formatInteger(dominatorTreeResult.rootChildren)}
                    </strong>
                  </div>
                  <div>
                    <span>{t("当前视图")}</span>
                    <strong>
                      {t("{visible} 可见 / {total} 返回", {
                        visible: formatInteger(
                          visibleDominatorTreeNodes.length,
                        ),
                        total: formatInteger(dominatorTreeResult.nodes.length),
                      })}
                    </strong>
                  </div>
                </div>

                {!dominatorTreeResult.exact && (
                  <p className="dominator-tree__boundary">
                    {t(
                      "全堆图达到预算或元数据不完整；当前树用于候选定位，不显示精确 Retained。",
                    )}
                  </p>
                )}
                {dominatorTreeResult.exact &&
                  dominatorTreeResult.viewTruncated && (
                    <p className="dominator-tree__boundary">
                      {t(
                        "全堆 Retained 数值精确；当前树仅按深度、总节点和分支预算展示最大的支配路径。",
                      )}
                    </p>
                  )}

                <div className="dominator-tree__canvas">
                  <div className="dominator-tree__virtual-root">
                    <CircleDotIcon aria-hidden="true" className="size-4" />
                    <strong>{t("虚拟 GC Root")}</strong>
                    <span>
                      {t("{count} 个直接支配子节点", {
                        count: formatInteger(dominatorTreeResult.rootChildren),
                      })}
                    </span>
                  </div>
                  {visibleDominatorTreeNodes.map((node) => (
                    <article
                      key={node.target.handle}
                      className={`dominator-tree__node ${dominatorNodeDepthClass(node)}`}
                    >
                      <Button
                        variant="ghost"
                        type="button"
                        className="dominator-tree__toggle"
                        disabled={node.displayedChildren === 0}
                        aria-expanded={
                          node.displayedChildren > 0
                            ? !isDominatorNodeCollapsed(node.index)
                            : undefined
                        }
                        aria-label={
                          isDominatorNodeCollapsed(node.index)
                            ? t("展开支配子树")
                            : t("折叠支配子树")
                        }
                        onClick={() => toggleDominatorNode(node)}
                      >
                        {node.displayedChildren === 0
                          ? "·"
                          : isDominatorNodeCollapsed(node.index)
                            ? "+"
                            : "−"}
                      </Button>
                      <div className="dominator-tree__identity">
                        <strong>{node.target.type}</strong>
                        <span>
                          @{node.target.identity} · {node.classLoader}
                        </span>
                      </div>
                      <dl>
                        <div>
                          <dt>
                            {dominatorTreeResult.exact
                              ? t("精确 Retained")
                              : t("候选 Retained")}
                          </dt>
                          <dd>
                            {formatBytes(
                              dominatorTreeResult.exact
                                ? node.retainedBytes
                                : node.candidateRetainedBytes,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("支配对象")}</dt>
                          <dd>{formatInteger(node.retainedObjects)}</dd>
                        </div>
                        <div>
                          <dt>{t("直接子节点")}</dt>
                          <dd>
                            {t("{shown}/{total}", {
                              shown: node.displayedChildren,
                              total: node.directChildren,
                            })}
                          </dd>
                        </div>
                      </dl>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => inspectDominatorNode(node)}
                      >
                        {t("检查对象")}
                      </Button>
                    </article>
                  ))}
                  {dominatorTreeResult.nodes.length === 0 && (
                    <p className="dominator-tree__empty">
                      {t("当前图没有可展示的根可达对象。")}
                    </p>
                  )}
                </div>
              </>
            )}
          </section>

          {artifact && (
            <section className="artifact-result">
              <div>
                <p className="eyebrow">ARTIFACT READY</p>
                <p className="artifact-result__name">{artifact.name}</p>
                <p>
                  {(artifact.size / 1024 / 1024).toFixed(2)} MiB · SHA-256{" "}
                  {artifact.sha256}
                </p>
              </div>
              <div className="artifact-result__actions">
                {artifact.type === "PROFILE" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void openProfileReport()}
                    aria-busy={Boolean(loadingAction === "report.open")}
                    disabled={Boolean(loadingAction === "report.open")}
                  >
                    {Boolean(loadingAction === "report.open") && <Spinner />}
                    {t("打开交互报告")}
                  </Button>
                )}
                {artifact.type === "JFR" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void navigate({
                        pathname: "/artifacts",
                        search: `?${new URLSearchParams({
                          inspect: artifact.id,
                        }).toString()}`,
                      })
                    }
                  >
                    {t("分析JFR")}
                  </Button>
                )}
                {artifact.type === "HEAP_HISTOGRAM" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void navigate({
                        pathname: "/artifacts",
                        search: `?${new URLSearchParams({
                          inspect: artifact.id,
                        }).toString()}`,
                      })
                    }
                  >
                    {t("检查Heap快照")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void navigate("/artifacts")}
                >
                  {t("查看制品")}
                </Button>
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}
