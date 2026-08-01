import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import type {
  ArtifactDescriptor,
  HeapHistogramComparison,
  HeapHistogramDeltaRow,
  HeapHistogramInspectionReport,
  JfrInspectionReport,
  JitRegressionBaselineDescriptor,
  JitRegressionBaselineIndex,
  JitTrendComparison,
  JitTrendComparisonMode,
  JitTrendInspectionReport,
  ObservationExportInspectionReport,
  ThreadPoolTrendComparison,
  ThreadPoolTrendInspectionReport,
  ThreadDumpComparison,
  ThreadDumpThreadChange,
  ThreadDumpInspectionReport,
} from "@shared/contracts";
import { cn } from "@/lib/utils";
import StatusPill from "../components/StatusPill";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { formatDateTime, t, useLocale } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./ArtifactsView.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";

type HeapHistogramComparisonSort =
  | "ABSOLUTE_BYTES"
  | "GROWTH"
  | "RELEASE"
  | "COUNT"
  | "CLASS";

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  }
  return `${(value / 1024).toFixed(1)} KiB`;
}

function artifactTrendPath(
  points: readonly number[],
  scalePoints: readonly number[],
): string {
  if (points.length === 0) {
    return "";
  }
  const maximum = Math.max(1, ...scalePoints);
  const denominator = Math.max(points.length - 1, 1);
  return points
    .map((point, index) => {
      const x = (index / denominator) * 600;
      const y = 128 - (Math.max(0, point) / maximum) * 112;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function formatNullablePercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatNullableRate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)} /s`;
}

function formatSignedDecimal(value: number | null, suffix: string): string {
  if (value === null) {
    return "—";
  }
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}${suffix}`;
}

function formatDuration(value: number): string {
  if (value < 1_000) {
    return `${value.toFixed(value < 10 ? 2 : 1)} ms`;
  }
  return `${(value / 1_000).toFixed(2)} s`;
}

function formatNanos(value: number): string {
  return formatDuration(value / 1_000_000);
}

function monitorThresholdSummary(
  windows: readonly { readonly minimumDurationMillis: number }[],
): string {
  const thresholds = [
    ...new Set(windows.map((window) => window.minimumDurationMillis)),
  ].sort((left, right) => left - right);
  if (thresholds.length === 0) {
    return "—";
  }
  if (thresholds.length === 1) {
    return `≥ ${thresholds[0]} ms`;
  }
  return `${thresholds[0]}–${thresholds.at(-1)} ms · ${thresholds.length} ${t("档")}`;
}

function formatSignedInteger(value: number | null): string {
  if (value === null) {
    return t("不完整");
  }
  return `${value > 0 ? "+" : ""}${value.toLocaleString()}`;
}

function formatSignedBytes(value: number | null): string {
  if (value === null) {
    return t("不完整");
  }
  const magnitude = formatBytes(Math.abs(value));
  return value === 0 ? magnitude : `${value > 0 ? "+" : "−"}${magnitude}`;
}

function heapHistogramChangeClass(row: HeapHistogramDeltaRow): string {
  return `heap-artifact-diff__delta--${row.kind.toLocaleLowerCase()}`;
}

function formatCompileLevel(value: number | null): string {
  return value === null ? t("未知") : `L${value}`;
}

function formatCpuNanos(value: string | null): string {
  if (value === null) {
    return t("不支持");
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return t("不支持");
  }
  return numeric >= 1_000_000_000
    ? `${(numeric / 1_000_000_000).toFixed(2)} s`
    : `${(numeric / 1_000_000).toFixed(1)} ms`;
}

function threadChangeIdentity(change: ThreadDumpThreadChange): string {
  return `${change.id}\u0000${change.name}`;
}

function threadChangeLabel(change: ThreadDumpThreadChange): string {
  if (change.kind === "ADDED") {
    return t("新增");
  }
  if (change.kind === "REMOVED") {
    return t("退出");
  }
  if (change.kind === "CHANGED") {
    return t("变化");
  }
  return t("稳定");
}

function threadChangeState(
  change: ThreadDumpThreadChange,
): "ready" | "idle" | "error" {
  if (change.newlyDeadlocked || change.kind === "REMOVED") {
    return "error";
  }
  return change.kind === "ADDED" ? "ready" : "idle";
}

function computeThreadDumpComparisonCandidates(
  artifacts: readonly ArtifactDescriptor[],
  current: ArtifactDescriptor | null,
): readonly ArtifactDescriptor[] {
  if (!current) {
    return [];
  }
  const currentCreatedAt = Date.parse(current.createdAt);
  return artifacts.filter(
    (artifact) =>
      artifact.type === "THREAD_DUMP" &&
      artifact.status === "READY" &&
      artifact.targetId === current.targetId &&
      artifact.id !== current.id &&
      Number.isFinite(Date.parse(artifact.createdAt)) &&
      Number.isFinite(currentCreatedAt) &&
      Date.parse(artifact.createdAt) <= currentCreatedAt,
  );
}

function computeHeapHistogramComparisonCandidates(
  artifacts: readonly ArtifactDescriptor[],
  current: ArtifactDescriptor | null,
): readonly ArtifactDescriptor[] {
  if (!current) {
    return [];
  }
  const currentCreatedAt = Date.parse(current.createdAt);
  return artifacts.filter(
    (artifact) =>
      artifact.type === "HEAP_HISTOGRAM" &&
      artifact.status === "READY" &&
      artifact.targetId === current.targetId &&
      artifact.id !== current.id &&
      Number.isFinite(Date.parse(artifact.createdAt)) &&
      Number.isFinite(currentCreatedAt) &&
      Date.parse(artifact.createdAt) <= currentCreatedAt,
  );
}

function computeThreadPoolTrendComparisonCandidates(
  artifacts: readonly ArtifactDescriptor[],
  current: ArtifactDescriptor | null,
): readonly ArtifactDescriptor[] {
  if (!current) {
    return [];
  }
  const currentCreatedAt = Date.parse(current.createdAt);
  return artifacts.filter(
    (artifact) =>
      artifact.type === "THREAD_POOL_TREND" &&
      artifact.status === "READY" &&
      artifact.targetId === current.targetId &&
      artifact.id !== current.id &&
      Number.isFinite(Date.parse(artifact.createdAt)) &&
      Number.isFinite(currentCreatedAt) &&
      Date.parse(artifact.createdAt) <= currentCreatedAt,
  );
}

function computeJitTrendComparisonCandidates(
  artifacts: readonly ArtifactDescriptor[],
  current: ArtifactDescriptor | null,
): readonly ArtifactDescriptor[] {
  if (!current) {
    return [];
  }
  const currentCreatedAt = Date.parse(current.createdAt);
  return artifacts.filter(
    (artifact) =>
      artifact.type === "JIT_TREND" &&
      artifact.status === "READY" &&
      artifact.targetId === current.targetId &&
      artifact.id !== current.id &&
      Number.isFinite(Date.parse(artifact.createdAt)) &&
      Number.isFinite(currentCreatedAt) &&
      Date.parse(artifact.createdAt) <= currentCreatedAt,
  );
}

function computeJitRegressionComparisonCandidates(
  index: JitRegressionBaselineIndex | null,
  currentArtifact: ArtifactDescriptor | null,
  currentReport: JitTrendInspectionReport | null,
): readonly JitRegressionBaselineDescriptor[] {
  const currentIdentity = currentReport?.recording.regressionIdentity;
  const currentStartedAt =
    currentReport?.recording.samples[0]?.sampledAtEpochMillis;
  if (
    !index ||
    !currentArtifact ||
    !currentReport ||
    !currentIdentity ||
    currentStartedAt === undefined ||
    currentReport.summary.codeCacheCapacityKind !== "MAX"
  ) {
    return [];
  }
  return index.baselines.filter((candidate) => {
    const baselineDuration = candidate.summary.durationMillis;
    const durationRatio =
      baselineDuration > 0
        ? currentReport.summary.durationMillis / baselineDuration
        : Number.POSITIVE_INFINITY;
    return (
      candidate.artifact.id !== currentArtifact.id &&
      (candidate.artifact.targetId !== currentArtifact.targetId ||
        candidate.jvmStartTimeEpochMillis !==
          currentReport.recording.jvmStartTimeEpochMillis) &&
      candidate.identity.workloadKey === currentIdentity.workloadKey &&
      candidate.identity.targetMainClass === currentIdentity.targetMainClass &&
      candidate.identity.releaseLabel !== currentIdentity.releaseLabel &&
      candidate.samplingIntervalMillis ===
        currentReport.recording.samplingIntervalMillis &&
      candidate.summary.codeCacheCapacityKind === "MAX" &&
      Number.isFinite(Date.parse(candidate.artifact.createdAt)) &&
      Date.parse(candidate.artifact.createdAt) <= currentStartedAt &&
      durationRatio >= 0.8 &&
      durationRatio <= 1.25
    );
  });
}

function codeCachePressureLabel(
  value: JitTrendInspectionReport["summary"]["codeCachePressure"],
  capacityKind: JitTrendInspectionReport["summary"]["codeCacheCapacityKind"],
): string {
  switch (value) {
    case "EXHAUSTED":
      return capacityKind === "COMMITTED" ? t("已提交容量已用尽") : t("已耗尽");
    case "HIGH":
      return t("高压力");
    case "ELEVATED":
      return t("压力升高");
    case "NORMAL":
    default:
      return t("正常");
  }
}

export default function ArtifactsView() {
  useLocale();
  const connection = useTargetsStore(selectConnection);
  const selectedTargetId = useTargetsStore((s) => s.selectedTargetId);
  const [searchParams] = useSearchParams();
  const [artifacts, setArtifacts] = useState<readonly ArtifactDescriptor[]>([]);
  const artifactsRef = useRef<readonly ArtifactDescriptor[]>(artifacts);
  const [pendingDelete, setPendingDelete] = useState<ArtifactDescriptor | null>(
    null,
  );
  const [pendingReveal, setPendingReveal] = useState<ArtifactDescriptor | null>(
    null,
  );
  const [verifiedArtifactId, setVerifiedArtifactId] = useState<string | null>(
    null,
  );
  const [openingArtifactId, setOpeningArtifactId] = useState<string | null>(
    null,
  );
  const [inspectingArtifactId, setInspectingArtifactId] = useState<
    string | null
  >(null);
  const [inspectedJfrArtifact, setInspectedJfrArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const [jfrReport, setJfrReport] = useState<JfrInspectionReport | null>(null);
  const [inspectedHeapHistogramArtifact, setInspectedHeapHistogramArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const [heapHistogramReport, setHeapHistogramReport] =
    useState<HeapHistogramInspectionReport | null>(null);
  const [selectedHeapHistogramBaselineId, setSelectedHeapHistogramBaselineId] =
    useState("");
  const [heapHistogramComparison, setHeapHistogramComparison] =
    useState<HeapHistogramComparison | null>(null);
  const [comparingHeapHistograms, setComparingHeapHistograms] = useState(false);
  const [heapHistogramComparisonQuery, setHeapHistogramComparisonQuery] =
    useState("");
  const [heapHistogramComparisonSort, setHeapHistogramComparisonSort] =
    useState<HeapHistogramComparisonSort>("ABSOLUTE_BYTES");
  const [
    inspectedThreadPoolTrendArtifact,
    setInspectedThreadPoolTrendArtifact,
  ] = useState<ArtifactDescriptor | null>(null);
  const [threadPoolTrendReport, setThreadPoolTrendReport] =
    useState<ThreadPoolTrendInspectionReport | null>(null);
  const [
    selectedThreadPoolTrendBaselineId,
    setSelectedThreadPoolTrendBaselineId,
  ] = useState("");
  const [threadPoolTrendComparison, setThreadPoolTrendComparison] =
    useState<ThreadPoolTrendComparison | null>(null);
  const [comparingThreadPoolTrends, setComparingThreadPoolTrends] =
    useState(false);
  const [inspectedJitTrendArtifact, setInspectedJitTrendArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const [jitTrendReport, setJitTrendReport] =
    useState<JitTrendInspectionReport | null>(null);
  const [selectedJitTrendBaselineId, setSelectedJitTrendBaselineId] =
    useState("");
  const [jitTrendComparison, setJitTrendComparison] =
    useState<JitTrendComparison | null>(null);
  const [jitRegressionIndex, setJitRegressionIndex] =
    useState<JitRegressionBaselineIndex | null>(null);
  const [jitTrendComparisonMode, setJitTrendComparisonMode] =
    useState<JitTrendComparisonMode>("SAME_JVM");
  const [comparingJitTrends, setComparingJitTrends] = useState(false);
  const [inspectedObservationArtifact, setInspectedObservationArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const [observationExportReport, setObservationExportReport] =
    useState<ObservationExportInspectionReport | null>(null);
  const [observationWindowRenderLimit, setObservationWindowRenderLimit] =
    useState(100);
  const [inspectedThreadDumpArtifact, setInspectedThreadDumpArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const [threadDumpReport, setThreadDumpReport] =
    useState<ThreadDumpInspectionReport | null>(null);
  const [threadDumpQueryInput, setThreadDumpQueryInput] = useState("");
  const [threadDumpQuery, setThreadDumpQuery] = useState("");
  const [threadDumpState, setThreadDumpState] = useState("ALL");
  const [threadDumpDeadlockedOnly, setThreadDumpDeadlockedOnly] =
    useState(false);
  const [threadDumpRenderLimit, setThreadDumpRenderLimit] = useState(100);
  const [selectedDumpThreadId, setSelectedDumpThreadId] = useState<
    string | null
  >(null);
  const [selectedBaselineArtifactId, setSelectedBaselineArtifactId] =
    useState("");
  const [threadDumpComparison, setThreadDumpComparison] =
    useState<ThreadDumpComparison | null>(null);
  const [comparingThreadDumps, setComparingThreadDumps] = useState(false);
  const [comparisonQueryInput, setComparisonQueryInput] = useState("");
  const [comparisonQuery, setComparisonQuery] = useState("");
  const [comparisonKind, setComparisonKind] = useState("ALL");
  const [comparisonRenderLimit, setComparisonRenderLimit] = useState(100);
  const [selectedThreadChangeIdentity, setSelectedThreadChangeIdentity] =
    useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const peakJvmCpuPercent = Math.max(
    0,
    ...(jfrReport?.cpuSamples.map(
      (sample) => (sample.jvmUser + sample.jvmSystem) * 100,
    ) ?? []),
  );
  const totalGcPauseMillis =
    jfrReport?.gcPauses.reduce(
      (total, pause) => total + pause.durationMillis,
      0,
    ) ?? 0;
  const totalOsrCompilations =
    jfrReport?.compilerTiers.reduce(
      (total, tier) => total + tier.osrCompilations,
      0,
    ) ?? 0;
  const totalFailedCompilations =
    jfrReport?.compilerTiers.reduce(
      (total, tier) => total + tier.failedCompilations,
      0,
    ) ?? 0;
  const threadDumpStates = [
    "ALL",
    ...Object.keys(threadDumpReport?.stateCounts ?? {}).sort(),
  ];
  const filteredDumpThreads = (() => {
    const query = threadDumpQuery.trim().toLocaleLowerCase();
    const report = threadDumpReport;
    if (!report) {
      return [];
    }
    return report.threads.filter((thread) => {
      if (threadDumpState !== "ALL" && thread.state !== threadDumpState) {
        return false;
      }
      if (threadDumpDeadlockedOnly && !thread.deadlocked) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        thread.id.includes(query) ||
        thread.name.toLocaleLowerCase().includes(query) ||
        thread.state.toLocaleLowerCase().includes(query) ||
        (thread.waitingOn ?? "").toLocaleLowerCase().includes(query) ||
        thread.stack.some((frame) => frame.toLocaleLowerCase().includes(query))
      );
    });
  })();
  const visibleDumpThreads = filteredDumpThreads.slice(
    0,
    threadDumpRenderLimit,
  );
  const selectedDumpThread =
    filteredDumpThreads.find((thread) => thread.id === selectedDumpThreadId) ??
    filteredDumpThreads[0] ??
    null;
  const threadDumpComparisonCandidates = computeThreadDumpComparisonCandidates(
    artifacts,
    inspectedThreadDumpArtifact,
  );
  const filteredThreadChanges = (() => {
    const comparison = threadDumpComparison;
    if (!comparison) {
      return [];
    }
    const query = comparisonQuery.trim().toLocaleLowerCase();
    return comparison.threads.filter((change) => {
      if (comparisonKind !== "ALL" && change.kind !== comparisonKind) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [
        change.id,
        change.name,
        change.baselineState,
        change.currentState,
        change.baselineWaitingOn,
        change.currentWaitingOn,
        change.baselineTopFrame,
        change.currentTopFrame,
      ].some((value) => value?.toLocaleLowerCase().includes(query));
    });
  })();
  const visibleThreadChanges = filteredThreadChanges.slice(
    0,
    comparisonRenderLimit,
  );
  const selectedThreadChange =
    filteredThreadChanges.find(
      (change) => threadChangeIdentity(change) === selectedThreadChangeIdentity,
    ) ??
    filteredThreadChanges[0] ??
    null;
  const heapHistogramComparisonCandidates =
    computeHeapHistogramComparisonCandidates(
      artifacts,
      inspectedHeapHistogramArtifact,
    );
  const threadPoolTrendComparisonCandidates =
    computeThreadPoolTrendComparisonCandidates(
      artifacts,
      inspectedThreadPoolTrendArtifact,
    );
  const sameJvmJitTrendComparisonCandidates =
    computeJitTrendComparisonCandidates(artifacts, inspectedJitTrendArtifact);
  const crossReleaseJitTrendComparisonCandidates =
    computeJitRegressionComparisonCandidates(
      jitRegressionIndex,
      inspectedJitTrendArtifact,
      jitTrendReport,
    );
  const jitTrendComparisonCandidates =
    jitTrendComparisonMode === "CROSS_RELEASE"
      ? crossReleaseJitTrendComparisonCandidates.map(
          (candidate) => candidate.artifact,
        )
      : sameJvmJitTrendComparisonCandidates;
  const jitRegressionByArtifactId = new Map(
    (jitRegressionIndex?.baselines ?? []).map((candidate) => [
      candidate.artifact.id,
      candidate,
    ]),
  );
  const threadPoolArtifactTrendPaths = (() => {
    const samples = threadPoolTrendReport?.recording.samples ?? [];
    const scalePoints = samples.flatMap((sample) => [
      (sample.queuedTasks ?? 0) + (sample.queuedSubmissions ?? 0),
      sample.activeCount ?? sample.runningCount ?? 0,
      sample.poolSize ?? sample.configuredSize ?? 0,
    ]);
    return {
      queue: artifactTrendPath(
        samples.map(
          (sample) =>
            (sample.queuedTasks ?? 0) + (sample.queuedSubmissions ?? 0),
        ),
        scalePoints,
      ),
      active: artifactTrendPath(
        samples.map((sample) => sample.activeCount ?? sample.runningCount ?? 0),
        scalePoints,
      ),
      size: artifactTrendPath(
        samples.map((sample) => sample.poolSize ?? sample.configuredSize ?? 0),
        scalePoints,
      ),
    };
  })();
  const jitArtifactCodeCachePath = artifactTrendPath(
    (jitTrendReport?.recording.samples ?? []).map(
      (sample) =>
        (sample.codeCacheUsedBytes / sample.codeCacheCapacityBytes) * 100,
    ),
    [100],
  );
  const visibleHeapHistogramChanges = (() => {
    const comparison = heapHistogramComparison;
    if (!comparison) {
      return [];
    }
    const query = heapHistogramComparisonQuery.trim().toLocaleLowerCase();
    const rows = comparison.rows.filter(
      (row) =>
        !query ||
        row.className.toLocaleLowerCase().includes(query) ||
        row.classLoader.toLocaleLowerCase().includes(query),
    );
    return [...rows].sort((left, right) => {
      switch (heapHistogramComparisonSort) {
        case "GROWTH":
          return (
            right.shallowBytesDelta - left.shallowBytesDelta ||
            left.className.localeCompare(right.className)
          );
        case "RELEASE":
          return (
            left.shallowBytesDelta - right.shallowBytesDelta ||
            left.className.localeCompare(right.className)
          );
        case "COUNT":
          return (
            Math.abs(right.instanceDelta) - Math.abs(left.instanceDelta) ||
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
            left.className.localeCompare(right.className)
          );
      }
    });
  })();

  function updateArtifacts(next: readonly ArtifactDescriptor[]): void {
    artifactsRef.current = next;
    setArtifacts(next);
  }

  async function load(): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.listArtifacts();
      updateArtifacts(result.value ?? []);
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("无法读取制品列表"));
      }
    } finally {
      setLoading(false);
    }
  }

  async function createSnapshot(): Promise<void> {
    if (!selectedTargetId) {
      setErrorMessage(t("请先选择并连接目标JVM"));
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const result =
        await window.tanwei.createSnapshotArtifact(selectedTargetId);
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法创建诊断快照"));
        return;
      }
      updateArtifacts([result.value, ...artifactsRef.current]);
    } finally {
      setLoading(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) {
      return;
    }
    setLoading(true);
    const artifact = pendingDelete;
    try {
      const result = await window.tanwei.deleteArtifact(artifact.id, true);
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("无法删除制品"));
        return;
      }
      updateArtifacts(
        artifactsRef.current.filter((item) => item.id !== artifact.id),
      );
      setPendingDelete(null);
    } finally {
      setLoading(false);
    }
  }

  async function verifyArtifact(artifact: ArtifactDescriptor): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.verifyArtifact(artifact.id);
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("制品校验失败"));
        return;
      }
      setVerifiedArtifactId(artifact.id);
    } finally {
      setLoading(false);
    }
  }

  async function openProfileReport(
    artifact: ArtifactDescriptor,
  ): Promise<void> {
    if (artifact.type !== "PROFILE" || artifact.status !== "READY") {
      setErrorMessage(t("只有已就绪的性能报告可以在应用内打开"));
      return;
    }
    setOpeningArtifactId(artifact.id);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.openProfileReport(artifact.id);
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("无法打开性能报告"));
      }
    } finally {
      setOpeningArtifactId(null);
    }
  }

  async function inspectJfr(artifact: ArtifactDescriptor): Promise<void> {
    if (artifact.type !== "JFR" || artifact.status !== "READY") {
      setErrorMessage(t("只有已就绪的 JFR 制品可以分析"));
      return;
    }
    setInspectingArtifactId(artifact.id);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.inspectJfrArtifact(artifact.id);
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法分析 JFR 制品"));
        return;
      }
      closeThreadDumpInspector();
      closeHeapHistogramInspector();
      closeThreadPoolTrendInspector();
      closeJitTrendInspector();
      closeObservationExportInspector();
      setInspectedJfrArtifact(artifact);
      setJfrReport(result.value);
    } finally {
      setInspectingArtifactId(null);
    }
  }

  async function inspectThreadDump(
    artifact: ArtifactDescriptor,
  ): Promise<void> {
    if (artifact.type !== "THREAD_DUMP" || artifact.status !== "READY") {
      setErrorMessage(t("只有已就绪的线程转储可以检查"));
      return;
    }
    setInspectingArtifactId(artifact.id);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.inspectThreadDumpArtifact(artifact.id);
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法检查线程转储"));
        return;
      }
      closeJfrInspector();
      closeHeapHistogramInspector();
      closeThreadPoolTrendInspector();
      closeJitTrendInspector();
      closeObservationExportInspector();
      setInspectedThreadDumpArtifact(artifact);
      setThreadDumpReport(result.value);
      setThreadDumpQueryInput("");
      setThreadDumpQuery("");
      setThreadDumpState("ALL");
      setThreadDumpDeadlockedOnly(false);
      setThreadDumpRenderLimit(100);
      setSelectedDumpThreadId(result.value.threads[0]?.id ?? null);
      resetThreadDumpComparison();
      setSelectedBaselineArtifactId(
        computeThreadDumpComparisonCandidates(artifactsRef.current, artifact)[0]
          ?.id ?? "",
      );
    } finally {
      setInspectingArtifactId(null);
    }
  }

  async function inspectHeapHistogram(
    artifact: ArtifactDescriptor,
  ): Promise<void> {
    if (artifact.type !== "HEAP_HISTOGRAM" || artifact.status !== "READY") {
      setErrorMessage(t("只有已就绪的 Heap 直方图快照可以检查"));
      return;
    }
    setInspectingArtifactId(artifact.id);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.inspectHeapHistogramArtifact(
        artifact.id,
      );
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法检查 Heap 直方图快照"));
        return;
      }
      closeJfrInspector();
      closeThreadDumpInspector();
      closeThreadPoolTrendInspector();
      closeJitTrendInspector();
      closeObservationExportInspector();
      setInspectedHeapHistogramArtifact(artifact);
      setHeapHistogramReport(result.value);
      resetHeapHistogramComparison();
      setSelectedHeapHistogramBaselineId(
        computeHeapHistogramComparisonCandidates(
          artifactsRef.current,
          artifact,
        )[0]?.id ?? "",
      );
    } finally {
      setInspectingArtifactId(null);
    }
  }

  function closeHeapHistogramInspector(): void {
    setInspectedHeapHistogramArtifact(null);
    setHeapHistogramReport(null);
    resetHeapHistogramComparison();
  }

  async function inspectThreadPoolTrend(
    artifact: ArtifactDescriptor,
  ): Promise<void> {
    if (artifact.type !== "THREAD_POOL_TREND" || artifact.status !== "READY") {
      setErrorMessage(t("只有已就绪的线程池趋势制品可以检查"));
      return;
    }
    setInspectingArtifactId(artifact.id);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.inspectThreadPoolTrendArtifact(
        artifact.id,
      );
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法检查线程池趋势制品"));
        return;
      }
      closeJfrInspector();
      closeThreadDumpInspector();
      closeHeapHistogramInspector();
      closeJitTrendInspector();
      closeObservationExportInspector();
      setInspectedThreadPoolTrendArtifact(artifact);
      setThreadPoolTrendReport(result.value);
      setThreadPoolTrendComparison(null);
      setSelectedThreadPoolTrendBaselineId(
        computeThreadPoolTrendComparisonCandidates(
          artifactsRef.current,
          artifact,
        )[0]?.id ?? "",
      );
    } finally {
      setInspectingArtifactId(null);
    }
  }

  function closeThreadPoolTrendInspector(): void {
    setInspectedThreadPoolTrendArtifact(null);
    setThreadPoolTrendReport(null);
    setSelectedThreadPoolTrendBaselineId("");
    setThreadPoolTrendComparison(null);
  }

  async function inspectJitTrend(artifact: ArtifactDescriptor): Promise<void> {
    if (artifact.type !== "JIT_TREND" || artifact.status !== "READY") {
      setErrorMessage(t("只有已就绪的 JIT 趋势制品可以检查"));
      return;
    }
    setInspectingArtifactId(artifact.id);
    setErrorMessage(null);
    try {
      const [result, regressionIndexResult] = await Promise.all([
        window.tanwei.inspectJitTrendArtifact(artifact.id),
        window.tanwei.listJitRegressionBaselines(),
      ]);
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法检查 JIT 趋势制品"));
        return;
      }
      closeJfrInspector();
      closeThreadDumpInspector();
      closeHeapHistogramInspector();
      closeThreadPoolTrendInspector();
      closeObservationExportInspector();
      setInspectedJitTrendArtifact(artifact);
      setJitTrendReport(result.value);
      setJitRegressionIndex(
        regressionIndexResult.ok && regressionIndexResult.value
          ? regressionIndexResult.value
          : null,
      );
      setJitTrendComparisonMode("SAME_JVM");
      setJitTrendComparison(null);
      setSelectedJitTrendBaselineId(
        computeJitTrendComparisonCandidates(artifactsRef.current, artifact)[0]
          ?.id ?? "",
      );
    } finally {
      setInspectingArtifactId(null);
    }
  }

  function closeJitTrendInspector(): void {
    setInspectedJitTrendArtifact(null);
    setJitTrendReport(null);
    setJitRegressionIndex(null);
    setJitTrendComparisonMode("SAME_JVM");
    setSelectedJitTrendBaselineId("");
    setJitTrendComparison(null);
  }

  function changeJitTrendComparisonMode(mode: JitTrendComparisonMode): void {
    const candidates =
      mode === "CROSS_RELEASE"
        ? crossReleaseJitTrendComparisonCandidates.map(
            (candidate) => candidate.artifact,
          )
        : sameJvmJitTrendComparisonCandidates;
    setJitTrendComparisonMode(mode);
    setSelectedJitTrendBaselineId(candidates[0]?.id ?? "");
    setJitTrendComparison(null);
    setErrorMessage(null);
  }

  async function inspectObservationExport(
    artifact: ArtifactDescriptor,
  ): Promise<void> {
    if (
      (artifact.type !== "TRACE_HOTSPOTS" &&
        artifact.type !== "MONITOR_WINDOWS") ||
      artifact.status !== "READY"
    ) {
      setErrorMessage(t("只有已就绪的 Trace/Monitor 导出可以检查"));
      return;
    }
    setInspectingArtifactId(artifact.id);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.inspectObservationExportArtifact(
        artifact.id,
      );
      if (!result.ok || !result.value) {
        setErrorMessage(
          result.errorMessage ?? t("无法检查 Trace/Monitor 导出"),
        );
        return;
      }
      closeJfrInspector();
      closeThreadDumpInspector();
      closeHeapHistogramInspector();
      closeThreadPoolTrendInspector();
      closeJitTrendInspector();
      setInspectedObservationArtifact(artifact);
      setObservationExportReport(result.value);
      setObservationWindowRenderLimit(100);
    } finally {
      setInspectingArtifactId(null);
    }
  }

  function closeObservationExportInspector(): void {
    setInspectedObservationArtifact(null);
    setObservationExportReport(null);
    setObservationWindowRenderLimit(100);
  }

  async function compareThreadPoolTrends(): Promise<void> {
    const current = inspectedThreadPoolTrendArtifact;
    const baselineId = selectedThreadPoolTrendBaselineId;
    if (!current || !baselineId) {
      return;
    }
    setComparingThreadPoolTrends(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.compareThreadPoolTrendArtifacts({
        baselineArtifactId: baselineId,
        currentArtifactId: current.id,
      });
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法对比线程池趋势制品"));
        return;
      }
      setThreadPoolTrendComparison(result.value);
    } finally {
      setComparingThreadPoolTrends(false);
    }
  }

  async function compareJitTrends(): Promise<void> {
    const current = inspectedJitTrendArtifact;
    const baselineId = selectedJitTrendBaselineId;
    if (!current || !baselineId) {
      return;
    }
    setComparingJitTrends(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.compareJitTrendArtifacts({
        baselineArtifactId: baselineId,
        currentArtifactId: current.id,
        mode: jitTrendComparisonMode,
      });
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法对比 JIT 趋势制品"));
        return;
      }
      setJitTrendComparison(result.value);
    } finally {
      setComparingJitTrends(false);
    }
  }

  async function compareHeapHistograms(): Promise<void> {
    const current = inspectedHeapHistogramArtifact;
    if (!current || !selectedHeapHistogramBaselineId) {
      return;
    }
    setComparingHeapHistograms(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.compareHeapHistogramArtifacts({
        baselineArtifactId: selectedHeapHistogramBaselineId,
        currentArtifactId: current.id,
      });
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法对比 Heap 直方图快照"));
        return;
      }
      setHeapHistogramComparison(result.value);
      setHeapHistogramComparisonQuery("");
      setHeapHistogramComparisonSort("ABSOLUTE_BYTES");
    } finally {
      setComparingHeapHistograms(false);
    }
  }

  function resetHeapHistogramComparison(): void {
    setHeapHistogramComparison(null);
    setSelectedHeapHistogramBaselineId("");
    setHeapHistogramComparisonQuery("");
    setHeapHistogramComparisonSort("ABSOLUTE_BYTES");
  }

  function applyThreadDumpFilter(): void {
    setThreadDumpQuery(threadDumpQueryInput);
    setThreadDumpRenderLimit(100);
    setSelectedDumpThreadId(null);
  }

  function closeThreadDumpInspector(): void {
    setInspectedThreadDumpArtifact(null);
    setThreadDumpReport(null);
    setSelectedDumpThreadId(null);
    resetThreadDumpComparison();
  }

  function closeJfrInspector(): void {
    setInspectedJfrArtifact(null);
    setJfrReport(null);
  }

  async function confirmReveal(): Promise<void> {
    if (!pendingReveal) {
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.revealArtifact(pendingReveal.id, true);
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("无法在系统中显示制品"));
        return;
      }
      setPendingReveal(null);
    } finally {
      setLoading(false);
    }
  }

  async function compareThreadDumps(): Promise<void> {
    const currentArtifact = inspectedThreadDumpArtifact;
    if (!currentArtifact || !selectedBaselineArtifactId) {
      return;
    }
    setComparingThreadDumps(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.compareThreadDumpArtifacts({
        baselineArtifactId: selectedBaselineArtifactId,
        currentArtifactId: currentArtifact.id,
      });
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法对比线程转储"));
        return;
      }
      setThreadDumpComparison(result.value);
      setComparisonQueryInput("");
      setComparisonQuery("");
      setComparisonKind("ALL");
      setComparisonRenderLimit(100);
      const firstChange = result.value.threads[0];
      setSelectedThreadChangeIdentity(
        firstChange ? threadChangeIdentity(firstChange) : null,
      );
    } finally {
      setComparingThreadDumps(false);
    }
  }

  function applyComparisonFilter(): void {
    setComparisonQuery(comparisonQueryInput);
    setComparisonRenderLimit(100);
    setSelectedThreadChangeIdentity(null);
  }

  function resetThreadDumpComparison(): void {
    setThreadDumpComparison(null);
    setSelectedBaselineArtifactId("");
    setComparisonQueryInput("");
    setComparisonQuery("");
    setComparisonKind("ALL");
    setComparisonRenderLimit(100);
    setSelectedThreadChangeIdentity(null);
  }

  useEffect(() => {
    void (async () => {
      await load();
      const requestedArtifactId = searchParams.get("inspect");
      const requestedArtifact = artifactsRef.current.find(
        (artifact) => artifact.id === requestedArtifactId,
      );
      if (requestedArtifact?.type === "JFR") {
        await inspectJfr(requestedArtifact);
      } else if (requestedArtifact?.type === "THREAD_DUMP") {
        await inspectThreadDump(requestedArtifact);
      } else if (requestedArtifact?.type === "HEAP_HISTOGRAM") {
        await inspectHeapHistogram(requestedArtifact);
      } else if (requestedArtifact?.type === "THREAD_POOL_TREND") {
        await inspectThreadPoolTrend(requestedArtifact);
      } else if (requestedArtifact?.type === "JIT_TREND") {
        await inspectJitTrend(requestedArtifact);
      } else if (
        requestedArtifact?.type === "TRACE_HOTSPOTS" ||
        requestedArtifact?.type === "MONITOR_WINDOWS"
      ) {
        await inspectObservationExport(requestedArtifact);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="page artifacts-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">ARTIFACTS</p>
          <h1>{t("证据成为文件。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "文件先写入受控临时路径并同步落盘，完成 SHA-256 校验后原子重命名；Renderer 永远看不到绝对路径。",
          )}
        </p>
      </header>

      <div className="artifact-toolbar">
        <div>
          <p className="eyebrow">LOCAL QUOTA</p>
          <p>
            {t("{count} 个已登记制品 · 默认上限 2 GiB", {
              count: artifacts.length,
            })}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={Boolean(connection?.state !== "READY") || Boolean(loading)}
          onClick={() => void createSnapshot()}
          aria-busy={Boolean(loading)}
        >
          {Boolean(loading) && <Spinner />}
          {t("固定当前快照")}
        </Button>
      </div>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{t(errorMessage)}</AlertDescription>
        </Alert>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !loading) {
            setPendingDelete(null);
          }
        }}
      >
        {pendingDelete && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("确认删除 {name}？", { name: pendingDelete.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("目标制品 ID：{id}。文件删除后不可从探微恢复。", {
                  id: pendingDelete.id,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={loading}>
                {t("取消")}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={loading}
                onClick={(event) => {
                  event.preventDefault();
                  void confirmDelete();
                }}
              >
                {loading ? t("正在删除") : t("确认删除")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      <AlertDialog
        open={pendingReveal !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !loading) {
            setPendingReveal(null);
          }
        }}
      >
        {pendingReveal && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("在系统文件管理器中显示？")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("目标文件：{name} · {size}", {
                  name: pendingReveal.name,
                  size: formatBytes(pendingReveal.size),
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={loading}>
                {t("取消")}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={loading}
                onClick={(event) => {
                  event.preventDefault();
                  void confirmReveal();
                }}
              >
                {loading ? t("正在打开") : t("确认显示")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      {observationExportReport && inspectedObservationArtifact && (
        <section
          className="observation-export-inspector"
          aria-labelledby="observation-export-title"
        >
          <header>
            <div>
              <p className="eyebrow">
                {observationExportReport.kind === "TRACE_HOTSPOTS"
                  ? "TRACE HOTSPOT ARTIFACT"
                  : "MONITOR WINDOW ARTIFACT"}
              </p>
              <h2 id="observation-export-title">
                {observationExportReport.kind === "TRACE_HOTSPOTS"
                  ? t("跨 Trace 热点证据。")
                  : t("方法监控窗口证据。")}
              </h2>
              <p>
                {inspectedObservationArtifact.name} ·{" "}
                {formatDateTime(
                  observationExportReport.recording.exportedAtEpochMillis,
                )}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={closeObservationExportInspector}
            >
              {t("关闭检查器")}
            </Button>
          </header>

          <dl className="observation-export-inspector__identity">
            <div>
              <dt>{t("精确方法")}</dt>
              <dd>
                <code>
                  {observationExportReport.recording.target.className}#
                  {observationExportReport.recording.target.methodName}(
                  {observationExportReport.recording.target.parameterTypes.join(
                    ", ",
                  )}
                  )
                </code>
              </dd>
            </div>
            <div>
              <dt>ClassLoader</dt>
              <dd>
                <code>
                  {observationExportReport.recording.target.classLoader}
                </code>
              </dd>
            </div>
            <div>
              <dt>{t("任务状态")}</dt>
              <dd>{observationExportReport.recording.taskState}</dd>
            </div>
            <div>
              <dt>{t("JVM 启动周期")}</dt>
              <dd>
                {formatDateTime(
                  observationExportReport.recording.jvmStartTimeEpochMillis,
                )}
              </dd>
            </div>
          </dl>

          {observationExportReport.kind === "TRACE_HOTSPOTS" ? (
            <>
              <dl className="observation-export-inspector__summary">
                <div>
                  <dt>{t("Trace 数")}</dt>
                  <dd>{observationExportReport.recording.traceCount}</dd>
                </div>
                <div>
                  <dt>Span</dt>
                  <dd>{observationExportReport.recording.spanCount}</dd>
                </div>
                <div>
                  <dt>{t("丢弃")}</dt>
                  <dd>{observationExportReport.recording.dropped}</dd>
                </div>
                <div>
                  <dt>{t("截断 Span")}</dt>
                  <dd>{observationExportReport.recording.truncatedSpans}</dd>
                </div>
              </dl>
              <div className="observation-export-inspector__table">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t("方法")}</TableHead>
                      <TableHead scope="col">{t("累计自耗时")}</TableHead>
                      <TableHead scope="col">{t("累计总耗时")}</TableHead>
                      <TableHead scope="col">{t("调用量")}</TableHead>
                      <TableHead scope="col">{t("异常量")}</TableHead>
                      <TableHead scope="col">{t("最大耗时")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {observationExportReport.recording.hotspots.map(
                      (hotspot) => (
                        <TableRow key={hotspot.method}>
                          <TableCell>
                            <code>{hotspot.method}</code>
                          </TableCell>
                          <TableCell>
                            {formatNanos(hotspot.selfDurationNanos)}
                          </TableCell>
                          <TableCell>
                            {formatNanos(hotspot.totalDurationNanos)}
                          </TableCell>
                          <TableCell>
                            {hotspot.calls.toLocaleString()}
                          </TableCell>
                          <TableCell>
                            {hotspot.errors.toLocaleString()}
                          </TableCell>
                          <TableCell>
                            {formatNanos(hotspot.maximumDurationNanos)}
                          </TableCell>
                        </TableRow>
                      ),
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : (
            <>
              <dl className="observation-export-inspector__summary">
                <div>
                  <dt>{t("窗口数")}</dt>
                  <dd>
                    {observationExportReport.recording.summary.windowCount}
                  </dd>
                </div>
                <div>
                  <dt>{t("计入阈值")}</dt>
                  <dd>
                    {monitorThresholdSummary(
                      observationExportReport.recording.windows,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("调用量")}</dt>
                  <dd>
                    {observationExportReport.recording.summary.totalCalls.toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>{t("异常量")}</dt>
                  <dd>
                    {observationExportReport.recording.summary.totalFailures.toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>{t("平均耗时")}</dt>
                  <dd>
                    {formatNanos(
                      observationExportReport.recording.summary
                        .averageDurationNanos,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("窗口最大 P95")}</dt>
                  <dd>
                    {formatNanos(
                      observationExportReport.recording.summary
                        .maximumP95DurationNanos,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("最大耗时")}</dt>
                  <dd>
                    {formatNanos(
                      observationExportReport.recording.summary
                        .maximumDurationNanos,
                    )}
                  </dd>
                </div>
              </dl>
              <div className="observation-export-inspector__table">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">#</TableHead>
                      <TableHead scope="col">{t("结束时间")}</TableHead>
                      <TableHead scope="col">{t("计入阈值")}</TableHead>
                      <TableHead scope="col">{t("调用量")}</TableHead>
                      <TableHead scope="col">{t("异常量")}</TableHead>
                      <TableHead scope="col">{t("平均耗时")}</TableHead>
                      <TableHead scope="col">P95 / P99 / MAX</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {observationExportReport.recording.windows
                      .slice(-observationWindowRenderLimit)
                      .reverse()
                      .map((window) => (
                        <TableRow key={window.sequence}>
                          <TableCell>{window.sequence}</TableCell>
                          <TableCell>
                            {formatDateTime(window.endedAtEpochMillis)}
                          </TableCell>
                          <TableCell>
                            ≥ {window.minimumDurationMillis} ms
                          </TableCell>
                          <TableCell>{window.calls.toLocaleString()}</TableCell>
                          <TableCell>
                            {window.failures.toLocaleString()}
                          </TableCell>
                          <TableCell>
                            {formatNanos(
                              window.calls > 0
                                ? window.durationNanos / window.calls
                                : 0,
                            )}
                          </TableCell>
                          <TableCell>
                            {formatNanos(window.p95DurationNanos)} /{" "}
                            {formatNanos(window.p99DurationNanos)} /{" "}
                            {formatNanos(window.maximumDurationNanos)}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
              {observationWindowRenderLimit <
                observationExportReport.recording.windows.length && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setObservationWindowRenderLimit((current) =>
                      Math.min(
                        current + 100,
                        observationExportReport.recording.windows.length,
                      ),
                    )
                  }
                >
                  {t("再显示 100 个窗口")}
                </Button>
              )}
            </>
          )}
        </section>
      )}

      {jitTrendReport && inspectedJitTrendArtifact && (
        <section
          className="pool-trend-artifact-inspector jit-trend-artifact-inspector"
          data-testid="jit-trend-artifact-inspector"
          aria-label={t("JIT 趋势制品检查器")}
        >
          <header className="pool-trend-artifact-inspector__header">
            <div>
              <p className="eyebrow">JIT TREND / VERIFIED LOCAL</p>
              <h2>{t("把编译与 Code Cache 压力放进长期基线。")}</h2>
              <p>
                {formatDateTime(
                  jitTrendReport.recording.samples[0]?.sampledAtEpochMillis ??
                    jitTrendReport.recording.jvmStartTimeEpochMillis,
                )}
                {" · "}
                {jitTrendReport.recording.samplingIntervalMillis / 1_000} s
              </p>
              <code>{jitTrendReport.recording.targetId}</code>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={closeJitTrendInspector}
            >
              {t("关闭检查器")}
            </Button>
          </header>

          <dl className="pool-trend-artifact-inspector__metrics">
            <div>
              <dt>{t("样本")}</dt>
              <dd>{jitTrendReport.summary.sampleCount}</dd>
            </div>
            <div>
              <dt>{t("持续时间")}</dt>
              <dd>{formatDuration(jitTrendReport.summary.durationMillis)}</dd>
            </div>
            <div>
              <dt>{t("编译速率")}</dt>
              <dd>
                {formatNullableRate(jitTrendReport.summary.compilesPerSecond)}
              </dd>
            </div>
            <div>
              <dt>{t("失败速率")}</dt>
              <dd>
                {formatNullableRate(jitTrendReport.summary.failuresPerSecond)}
              </dd>
            </div>
            <div>
              <dt>{t("编译时间占比")}</dt>
              <dd>
                {formatNullablePercent(
                  jitTrendReport.summary.compilationTimePercent,
                )}
              </dd>
            </div>
            <div>
              <dt>{t("窗口峰值压力")}</dt>
              <dd>
                {jitTrendReport.summary.peakCodeCachePercent.toFixed(1)}% ·{" "}
                {codeCachePressureLabel(
                  jitTrendReport.summary.codeCachePressure,
                  jitTrendReport.summary.codeCacheCapacityKind,
                )}
              </dd>
            </div>
          </dl>

          <div className="pool-trend-artifact-inspector__chart">
            <div className="pool-trend-artifact-inspector__legend">
              <span>{t("Code Cache 使用率")}</span>
              <strong>
                {t("结束 {ending}% · 峰值 {peak}%", {
                  ending:
                    jitTrendReport.summary.endingCodeCachePercent.toFixed(1),
                  peak: jitTrendReport.summary.peakCodeCachePercent.toFixed(1),
                })}
              </strong>
            </div>
            <svg
              viewBox="0 0 600 144"
              preserveAspectRatio="none"
              role="img"
              aria-label={t("校验 JIT Code Cache 趋势图")}
            >
              <g aria-hidden="true">
                <line x1="0" y1="16" x2="600" y2="16" />
                <line x1="0" y1="72" x2="600" y2="72" />
                <line x1="0" y1="128" x2="600" y2="128" />
              </g>
              <path
                className="pool-trend-artifact-inspector__queue"
                d={jitArtifactCodeCachePath}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>

          <p className="pool-trend-artifact-inspector__boundary">
            {t(
              "Host 已复验真实路径、普通 JSON、大小、SHA-256、目标、JVM 周期、时间顺序、单调计数器与 Code Cache 容量语义。",
            )}
            <strong>
              {t("窗口峰值 {peak}% · 净增长 {growth}", {
                peak: jitTrendReport.summary.peakCodeCachePercent.toFixed(1),
                growth: formatSignedBytes(
                  jitTrendReport.summary.codeCacheGrowthBytes,
                ),
              })}
            </strong>
          </p>

          {jitTrendReport.recording.regressionIdentity ? (
            <section className="jit-regression-identity">
              <header>
                <div>
                  <p className="eyebrow">PORTABLE REGRESSION IDENTITY / V2</p>
                  <h3>{t("Host 复验的跨发布基线身份。")}</h3>
                </div>
                <StatusPill state="ready" label={t("可跨发布比较")} />
              </header>
              <dl>
                <div>
                  <dt>{t("工作负载")}</dt>
                  <dd>
                    {jitTrendReport.recording.regressionIdentity.workloadKey}
                  </dd>
                </div>
                <div>
                  <dt>{t("发布")}</dt>
                  <dd>
                    {jitTrendReport.recording.regressionIdentity.releaseLabel}
                  </dd>
                </div>
                <div>
                  <dt>{t("目标主类")}</dt>
                  <dd>
                    {
                      jitTrendReport.recording.regressionIdentity
                        .targetMainClass
                    }
                  </dd>
                </div>
                <div>
                  <dt>JDK</dt>
                  <dd>
                    {jitTrendReport.recording.regressionIdentity.javaVersion}
                  </dd>
                </div>
                <div>
                  <dt>{t("编译器")}</dt>
                  <dd>
                    {jitTrendReport.recording.regressionIdentity.compilerName}
                  </dd>
                </div>
              </dl>
            </section>
          ) : (
            <p className="pool-trend-artifact-comparison__empty">
              {t(
                "这是兼容 v1 制品，只能在同一 JVM 周期内比较；新保存时启用“加入跨版本回归基线”即可生成 v2 身份。",
              )}
            </p>
          )}

          <section className="pool-trend-artifact-comparison">
            <header>
              <div>
                <p className="eyebrow">
                  {jitTrendComparisonMode === "CROSS_RELEASE"
                    ? "CROSS-RELEASE JIT REGRESSION / O(B+C)"
                    : "CROSS-SESSION JIT COMPARISON / O(B+C)"}
                </p>
                <h3>
                  {jitTrendComparisonMode === "CROSS_RELEASE"
                    ? t("比较两个发布版本的等价工作负载。")
                    : t("比较两个不重叠的 JIT 运行窗口。")}
                </h3>
                <p>
                  {jitTrendComparisonMode === "CROSS_RELEASE"
                    ? t(
                        "允许不同 JVM 与 JDK；Host 会复验工作负载、主类、发布标签、采样间隔、窗口长度和最大容量语义。",
                      )
                    : t(
                        "仅允许同一目标与同一 JVM 启动周期；Host 会重新读取并校验两份制品。",
                      )}
                </p>
              </div>
            </header>

            <Tabs
              value={jitTrendComparisonMode}
              onValueChange={(value) => {
                if (value === "SAME_JVM" || value === "CROSS_RELEASE") {
                  changeJitTrendComparisonMode(value);
                }
              }}
            >
              <TabsList aria-label={t("JIT 比较方式")}>
                <TabsTrigger value="SAME_JVM" data-testid="jit-mode-same-jvm">
                  {t("同 JVM 周期")}
                </TabsTrigger>
                <TabsTrigger
                  value="CROSS_RELEASE"
                  disabled={!jitTrendReport.recording.regressionIdentity}
                  data-testid="jit-mode-cross-release"
                >
                  {t("跨发布回归")}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="pool-trend-artifact-comparison__controls">
              <Label>
                <span>{t("基线 JIT 趋势")}</span>
                <SelectControl
                  value={selectedJitTrendBaselineId}
                  disabled={!jitTrendComparisonCandidates.length}
                  onValueChange={(value) => {
                    setSelectedJitTrendBaselineId(value);
                    setJitTrendComparison(null);
                  }}
                >
                  <SelectControlItem value="">
                    {t("选择较早的 JIT 趋势")}
                  </SelectControlItem>
                  {jitTrendComparisonCandidates.map((candidate) => {
                    const regression = jitRegressionByArtifactId.get(
                      candidate.id,
                    );
                    return (
                      <SelectControlItem
                        key={candidate.id}
                        value={candidate.id}
                      >
                        {jitTrendComparisonMode === "CROSS_RELEASE" &&
                        regression
                          ? `${regression.identity.releaseLabel} · ${regression.identity.javaVersion} · ${candidate.name}`
                          : `${formatDateTime(candidate.createdAt)} · ${candidate.name}`}
                      </SelectControlItem>
                    );
                  })}
                </SelectControl>
              </Label>
              <Button
                type="button"
                variant="secondary"
                disabled={
                  Boolean(!selectedJitTrendBaselineId) ||
                  Boolean(comparingJitTrends)
                }
                data-testid="compare-jit-trends"
                onClick={() => void compareJitTrends()}
                aria-busy={Boolean(comparingJitTrends)}
              >
                {Boolean(comparingJitTrends) && <Spinner />}
                {jitTrendComparisonMode === "CROSS_RELEASE"
                  ? t("运行回归比较")
                  : t("比较 JIT 窗口")}
              </Button>
            </div>

            {!jitTrendComparisonCandidates.length && (
              <p className="pool-trend-artifact-comparison__empty">
                {jitTrendComparisonMode === "CROSS_RELEASE"
                  ? t(
                      "没有兼容基线：需要较早的不同发布标签、不同 JVM 周期、相同工作负载与主类，并保持采样间隔和窗口长度可比。",
                    )
                  : t(
                      "还需要同一 JVM 周期的一份较早趋势；返回计数器页再次采样并保存。",
                    )}
              </p>
            )}

            {jitTrendComparison && (
              <>
                {jitTrendComparison.mode === "CROSS_RELEASE" &&
                  jitTrendComparison.baselineIdentity &&
                  jitTrendComparison.currentIdentity && (
                    <dl className="jit-regression-comparison__identity">
                      <div>
                        <dt>{t("基线发布")}</dt>
                        <dd>
                          {jitTrendComparison.baselineIdentity.releaseLabel}
                          <span>
                            {jitTrendComparison.baselineIdentity.javaVersion}
                          </span>
                          <span>
                            {jitTrendComparison.baselineIdentity.compilerName}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt>{t("当前发布")}</dt>
                        <dd>
                          {jitTrendComparison.currentIdentity.releaseLabel}
                          <span>
                            {jitTrendComparison.currentIdentity.javaVersion}
                          </span>
                          <span>
                            {jitTrendComparison.currentIdentity.compilerName}
                          </span>
                        </dd>
                      </div>
                    </dl>
                  )}
                <dl className="pool-trend-artifact-comparison__window">
                  <div>
                    <dt>{t("基线结束")}</dt>
                    <dd>
                      {formatDateTime(jitTrendComparison.baselineEndedAt)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("当前开始")}</dt>
                    <dd>
                      {formatDateTime(jitTrendComparison.currentStartedAt)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("窗口间隔")}</dt>
                    <dd>{formatDuration(jitTrendComparison.intervalMillis)}</dd>
                  </div>
                </dl>

                <div className="pool-trend-artifact-comparison__table-wrap">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t("指标")}</TableHead>
                        <TableHead scope="col">{t("基线窗口")}</TableHead>
                        <TableHead scope="col">{t("当前窗口")}</TableHead>
                        <TableHead scope="col">{t("变化")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableHead scope="row">{t("编译速率")}</TableHead>
                        <TableCell>
                          {formatNullableRate(
                            jitTrendComparison.baseline.compilesPerSecond,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatNullableRate(
                            jitTrendComparison.current.compilesPerSecond,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatSignedDecimal(
                            jitTrendComparison.compileRateDelta,
                            " /s",
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead scope="row">{t("失败速率")}</TableHead>
                        <TableCell>
                          {formatNullableRate(
                            jitTrendComparison.baseline.failuresPerSecond,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatNullableRate(
                            jitTrendComparison.current.failuresPerSecond,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatSignedDecimal(
                            jitTrendComparison.failureRateDelta,
                            " /s",
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead scope="row">{t("编译时间占比")}</TableHead>
                        <TableCell>
                          {formatNullablePercent(
                            jitTrendComparison.baseline.compilationTimePercent,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatNullablePercent(
                            jitTrendComparison.current.compilationTimePercent,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatSignedDecimal(
                            jitTrendComparison.compilationTimePercentDelta,
                            " pp",
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead scope="row">
                          {t("结束 Code Cache")}
                        </TableHead>
                        <TableCell>
                          {jitTrendComparison.baseline.endingCodeCachePercent.toFixed(
                            1,
                          )}
                          %
                        </TableCell>
                        <TableCell>
                          {jitTrendComparison.current.endingCodeCachePercent.toFixed(
                            1,
                          )}
                          %
                        </TableCell>
                        <TableCell>
                          {formatSignedDecimal(
                            jitTrendComparison.endingCodeCachePercentDelta,
                            " pp",
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead scope="row">
                          {t("峰值 Code Cache")}
                        </TableHead>
                        <TableCell>
                          {jitTrendComparison.baseline.peakCodeCachePercent.toFixed(
                            1,
                          )}
                          %
                        </TableCell>
                        <TableCell>
                          {jitTrendComparison.current.peakCodeCachePercent.toFixed(
                            1,
                          )}
                          %
                        </TableCell>
                        <TableCell>
                          {formatSignedDecimal(
                            jitTrendComparison.peakCodeCachePercentDelta,
                            " pp",
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead scope="row">
                          {t("Code Cache 净增长")}
                        </TableHead>
                        <TableCell>
                          {formatSignedBytes(
                            jitTrendComparison.baseline.codeCacheGrowthBytes,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatSignedBytes(
                            jitTrendComparison.current.codeCacheGrowthBytes,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatSignedBytes(
                            jitTrendComparison.codeCacheGrowthDeltaBytes,
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead scope="row">{t("压力等级")}</TableHead>
                        <TableCell>
                          {codeCachePressureLabel(
                            jitTrendComparison.baseline.codeCachePressure,
                            jitTrendComparison.baseline.codeCacheCapacityKind,
                          )}
                        </TableCell>
                        <TableCell>
                          {codeCachePressureLabel(
                            jitTrendComparison.current.codeCachePressure,
                            jitTrendComparison.current.codeCacheCapacityKind,
                          )}
                        </TableCell>
                        <TableCell>
                          {jitTrendComparison.pressureChanged
                            ? t("已变化")
                            : t("未变化")}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </section>
        </section>
      )}

      {threadPoolTrendReport && inspectedThreadPoolTrendArtifact && (
        <section
          className="pool-trend-artifact-inspector"
          data-testid="pool-trend-artifact-inspector"
          aria-label={t("线程池趋势制品检查器")}
        >
          <header className="pool-trend-artifact-inspector__header">
            <div>
              <p className="eyebrow">THREAD POOL TREND / VERIFIED LOCAL</p>
              <h2>{t("把池饱和与队列增长留成证据。")}</h2>
              <p>
                {threadPoolTrendReport.recording.alias ||
                  threadPoolTrendReport.recording.poolIdentity}
                {" · "}
                {formatDateTime(
                  threadPoolTrendReport.recording.samples[0]?.capturedAt ??
                    threadPoolTrendReport.recording.jvmStartTimeEpochMillis,
                )}
              </p>
              <code>{threadPoolTrendReport.recording.poolIdentity}</code>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={closeThreadPoolTrendInspector}
            >
              {t("关闭检查器")}
            </Button>
          </header>

          <dl className="pool-trend-artifact-inspector__metrics">
            <div>
              <dt>{t("样本")}</dt>
              <dd>{threadPoolTrendReport.summary.sampleCount}</dd>
            </div>
            <div>
              <dt>{t("持续时间")}</dt>
              <dd>
                {formatDuration(threadPoolTrendReport.summary.durationMillis)}
              </dd>
            </div>
            <div>
              <dt>{t("队列净变化")}</dt>
              <dd>
                {formatSignedInteger(threadPoolTrendReport.summary.queueDelta)}
              </dd>
            </div>
            <div>
              <dt>{t("峰值队列")}</dt>
              <dd>{threadPoolTrendReport.summary.peakQueue}</dd>
            </div>
            <div>
              <dt>{t("平均利用率")}</dt>
              <dd>
                {formatNullablePercent(
                  threadPoolTrendReport.summary.averageUtilizationPercent,
                )}
              </dd>
            </div>
            <div>
              <dt>{t("完成速率")}</dt>
              <dd>
                {formatNullableRate(
                  threadPoolTrendReport.summary.throughputPerSecond,
                )}
              </dd>
            </div>
          </dl>

          <div className="pool-trend-artifact-inspector__chart">
            <div className="pool-trend-artifact-inspector__legend">
              <span>{t("队列")}</span>
              <span>{t("活跃")}</span>
              <span>{t("池大小")}</span>
            </div>
            <svg
              viewBox="0 0 600 144"
              preserveAspectRatio="none"
              role="img"
              aria-label={t("校验线程池趋势图")}
            >
              <g aria-hidden="true">
                <line x1="0" y1="16" x2="600" y2="16" />
                <line x1="0" y1="72" x2="600" y2="72" />
                <line x1="0" y1="128" x2="600" y2="128" />
              </g>
              <path
                className="pool-trend-artifact-inspector__queue"
                d={threadPoolArtifactTrendPaths.queue}
                vectorEffect="non-scaling-stroke"
              />
              <path
                className="pool-trend-artifact-inspector__active"
                d={threadPoolArtifactTrendPaths.active}
                vectorEffect="non-scaling-stroke"
              />
              <path
                className="pool-trend-artifact-inspector__size"
                d={threadPoolArtifactTrendPaths.size}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>

          <p className="pool-trend-artifact-inspector__boundary">
            {t(
              "Host 已复验真实路径、普通 JSON、大小、SHA-256、目标、JVM 周期、精确池身份、时间顺序与单调计数器。",
            )}
            {threadPoolTrendReport.summary.starvationLikely && (
              <strong>
                {t(
                  "此窗口同时出现持续饱和与队列增长，需要检查任务耗时或下游阻塞。",
                )}
              </strong>
            )}
          </p>

          <section className="pool-trend-artifact-comparison">
            <header>
              <div>
                <p className="eyebrow">
                  CROSS-SESSION POOL COMPARISON / O(B+C)
                </p>
                <h3>{t("比较两个不重叠的池运行窗口。")}</h3>
                <p>
                  {t(
                    "仅允许同一目标、同一 JVM 启动周期、同一精确池对象与类型；不兼容制品会由 Host 拒绝。",
                  )}
                </p>
              </div>
              <div className="pool-trend-artifact-comparison__controls">
                <Label>
                  <span>{t("基线池趋势")}</span>
                  <SelectControl
                    value={selectedThreadPoolTrendBaselineId}
                    disabled={!threadPoolTrendComparisonCandidates.length}
                    onValueChange={(value) =>
                      setSelectedThreadPoolTrendBaselineId(value)
                    }
                  >
                    <SelectControlItem value="">
                      {t("选择较早的池趋势")}
                    </SelectControlItem>
                    {threadPoolTrendComparisonCandidates.map((candidate) => (
                      <SelectControlItem
                        key={candidate.id}
                        value={candidate.id}
                      >
                        {formatDateTime(candidate.createdAt)} · {candidate.name}
                      </SelectControlItem>
                    ))}
                  </SelectControl>
                </Label>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    Boolean(!selectedThreadPoolTrendBaselineId) ||
                    Boolean(comparingThreadPoolTrends)
                  }
                  data-testid="compare-thread-pool-trends"
                  onClick={() => void compareThreadPoolTrends()}
                  aria-busy={Boolean(comparingThreadPoolTrends)}
                >
                  {Boolean(comparingThreadPoolTrends) && <Spinner />}
                  {t("比较池窗口")}
                </Button>
              </div>
            </header>

            {!threadPoolTrendComparisonCandidates.length && (
              <p className="pool-trend-artifact-comparison__empty">
                {t(
                  "还需要同一精确池的一份较早趋势；返回线程页再次记录并保存。",
                )}
              </p>
            )}

            {threadPoolTrendComparison && (
              <>
                <dl className="pool-trend-artifact-comparison__window">
                  <div>
                    <dt>{t("基线结束")}</dt>
                    <dd>
                      {formatDateTime(
                        threadPoolTrendComparison.baselineEndedAt,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("当前开始")}</dt>
                    <dd>
                      {formatDateTime(
                        threadPoolTrendComparison.currentStartedAt,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("窗口间隔")}</dt>
                    <dd>
                      {formatDuration(threadPoolTrendComparison.intervalMillis)}
                    </dd>
                  </div>
                </dl>

                <div className="pool-trend-artifact-comparison__table-wrap">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t("指标")}</TableHead>
                        <TableHead scope="col">{t("基线窗口")}</TableHead>
                        <TableHead scope="col">{t("当前窗口")}</TableHead>
                        <TableHead scope="col">{t("变化")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableHead scope="row">{t("峰值队列")}</TableHead>
                        <TableCell>
                          {threadPoolTrendComparison.baseline.peakQueue}
                        </TableCell>
                        <TableCell>
                          {threadPoolTrendComparison.current.peakQueue}
                        </TableCell>
                        <TableCell>
                          {formatSignedInteger(
                            threadPoolTrendComparison.peakQueueDelta,
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead scope="row">{t("结束队列")}</TableHead>
                        <TableCell>
                          {threadPoolTrendComparison.baseline.currentQueue}
                        </TableCell>
                        <TableCell>
                          {threadPoolTrendComparison.current.currentQueue}
                        </TableCell>
                        <TableCell>
                          {formatSignedInteger(
                            threadPoolTrendComparison.endingQueueDelta,
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead scope="row">{t("平均利用率")}</TableHead>
                        <TableCell>
                          {formatNullablePercent(
                            threadPoolTrendComparison.baseline
                              .averageUtilizationPercent,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatNullablePercent(
                            threadPoolTrendComparison.current
                              .averageUtilizationPercent,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatSignedDecimal(
                            threadPoolTrendComparison.averageUtilizationDelta,
                            " pp",
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableHead scope="row">{t("完成速率")}</TableHead>
                        <TableCell>
                          {formatNullableRate(
                            threadPoolTrendComparison.baseline
                              .throughputPerSecond,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatNullableRate(
                            threadPoolTrendComparison.current
                              .throughputPerSecond,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatSignedDecimal(
                            threadPoolTrendComparison.throughputDelta,
                            " /s",
                          )}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </section>
        </section>
      )}

      {heapHistogramReport && inspectedHeapHistogramArtifact && (
        <section
          className="heap-artifact-inspector"
          aria-label={t("Heap 直方图制品检查器")}
        >
          <header className="heap-artifact-inspector__header">
            <div>
              <p className="eyebrow">HEAP HISTOGRAM INSPECTOR / LOCAL</p>
              <h2>{t("内存证据，跨会话重新比较。")}</h2>
              <p>
                {inspectedHeapHistogramArtifact.name} ·{" "}
                {formatDateTime(heapHistogramReport.snapshot.capturedAt)}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={closeHeapHistogramInspector}
            >
              {t("关闭检查器")}
            </Button>
          </header>

          <dl className="heap-artifact-metrics">
            <div>
              <dt>{t("已归类实例")}</dt>
              <dd>
                {heapHistogramReport.snapshot.accountedObjects.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>{t("已归类浅大小")}</dt>
              <dd>
                {formatBytes(heapHistogramReport.snapshot.accountedBytes)}
              </dd>
            </div>
            <div>
              <dt>{t("结果类")}</dt>
              <dd>{heapHistogramReport.snapshot.rows.length}</dd>
            </div>
            <div>
              <dt>{t("类范围")}</dt>
              <dd>{heapHistogramReport.snapshot.query || t("全部已加载类")}</dd>
            </div>
          </dl>

          <p className="heap-artifact-inspector__boundary">
            {t(
              "Host 已重新校验真实路径、普通 JSON 文件、大小、SHA-256、目标身份和采集时间；文件只包含类聚合，不包含业务对象内容。",
            )}
          </p>

          <section className="heap-artifact-diff">
            <header className="heap-artifact-diff__header">
              <div>
                <p className="eyebrow">PERSISTED HEAP DIFF / O(B+C)</p>
                <h3>{t("两份持久证据，找出持续增长。")}</h3>
                <p>
                  {t(
                    "选择同一目标、同一 JVM 启动周期且扫描参数一致的较早快照；Host 重新读取并校验两份制品后再计算。",
                  )}
                </p>
              </div>
              <div className="heap-artifact-diff__controls">
                <Label>
                  <span>{t("基线 Heap 快照")}</span>
                  <SelectControl
                    value={selectedHeapHistogramBaselineId}
                    disabled={!heapHistogramComparisonCandidates.length}
                    onValueChange={(value) =>
                      setSelectedHeapHistogramBaselineId(value)
                    }
                  >
                    <SelectControlItem value="">
                      {t("选择较早的快照")}
                    </SelectControlItem>
                    {heapHistogramComparisonCandidates.map((candidate) => (
                      <SelectControlItem
                        key={candidate.id}
                        value={candidate.id}
                      >
                        {formatDateTime(candidate.createdAt)} · {candidate.name}
                      </SelectControlItem>
                    ))}
                  </SelectControl>
                </Label>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    Boolean(!selectedHeapHistogramBaselineId) ||
                    Boolean(comparingHeapHistograms)
                  }
                  onClick={() => void compareHeapHistograms()}
                  aria-busy={Boolean(comparingHeapHistograms)}
                >
                  {Boolean(comparingHeapHistograms) && <Spinner />}
                  {t("生成跨会话差异")}
                </Button>
              </div>
            </header>

            {!heapHistogramComparisonCandidates.length && (
              <p className="heap-artifact-diff__empty">
                {t(
                  "还需要同一目标的一份较早 Heap 快照；返回剖析页以相同参数再次扫描并保存。",
                )}
              </p>
            )}

            {heapHistogramComparison && (
              <>
                <dl className="heap-artifact-diff__identity">
                  <div>
                    <dt>{t("基线")}</dt>
                    <dd>
                      {formatDateTime(
                        heapHistogramComparison.baselineCapturedAt,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("当前")}</dt>
                    <dd>
                      {formatDateTime(
                        heapHistogramComparison.currentCapturedAt,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("采集间隔")}</dt>
                    <dd>
                      {formatDuration(heapHistogramComparison.intervalMillis)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("遍历预算")}</dt>
                    <dd>
                      {heapHistogramComparison.scanLimit.toLocaleString()}
                    </dd>
                  </div>
                </dl>

                <dl className="heap-artifact-diff__metrics">
                  <div>
                    <dt>{t("实例净变化")}</dt>
                    <dd>
                      {formatSignedInteger(
                        heapHistogramComparison.instanceDelta,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("浅大小净变化")}</dt>
                    <dd>
                      {formatSignedBytes(
                        heapHistogramComparison.shallowBytesDelta,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("增长类")}</dt>
                    <dd>{heapHistogramComparison.growingClasses}</dd>
                  </div>
                  <div>
                    <dt>{t("释放类")}</dt>
                    <dd>{heapHistogramComparison.releasedClasses}</dd>
                  </div>
                </dl>

                {(!heapHistogramComparison.exactRowCoverage ||
                  !heapHistogramComparison.totalsComparable) && (
                  <p className="heap-artifact-diff__boundary">
                    {t(
                      "至少一份快照不完整：全局净变化可能隐藏，Top N 未匹配行不会被误判为新增或释放。",
                    )}
                  </p>
                )}

                <div className="heap-artifact-diff__filters">
                  <Label>
                    <span>{t("筛选差分类或ClassLoader")}</span>
                    <Input
                      value={heapHistogramComparisonQuery}
                      type="search"
                      placeholder={t("输入类名或ClassLoader")}
                      onChange={(e) =>
                        setHeapHistogramComparisonQuery(e.target.value)
                      }
                    />
                  </Label>
                  <Label>
                    <span>{t("差分排序")}</span>
                    <SelectControl
                      value={heapHistogramComparisonSort}
                      onValueChange={(value) =>
                        setHeapHistogramComparisonSort(
                          value as HeapHistogramComparisonSort,
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

                <div className="heap-artifact-diff__table-wrap">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">
                          {t("类与ClassLoader")}
                        </TableHead>
                        <TableHead scope="col">{t("基线实例")}</TableHead>
                        <TableHead scope="col">{t("当前实例")}</TableHead>
                        <TableHead scope="col">{t("实例变化")}</TableHead>
                        <TableHead scope="col">{t("浅大小变化")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleHeapHistogramChanges.map((row) => (
                        <TableRow key={`${row.className}:${row.classLoader}`}>
                          <TableCell>
                            <code>{row.className}</code>
                            <small title={row.classLoader}>
                              {row.classLoader}
                            </small>
                          </TableCell>
                          <TableCell>
                            {row.baselineInstances.toLocaleString()}
                          </TableCell>
                          <TableCell>
                            {row.currentInstances.toLocaleString()}
                          </TableCell>
                          <TableCell className={heapHistogramChangeClass(row)}>
                            {formatSignedInteger(row.instanceDelta)}
                          </TableCell>
                          <TableCell className={heapHistogramChangeClass(row)}>
                            {formatSignedBytes(row.shallowBytesDelta)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {visibleHeapHistogramChanges.length === 0 && (
                    <p className="heap-artifact-diff__empty">
                      {t("没有可比较的 Heap 类。")}
                    </p>
                  )}
                </div>

                <p className="heap-artifact-diff__boundary">
                  {t(
                    "差分按类名与精确 ClassLoader 身份联合匹配，时间和空间复杂度均为 O(B+C)；这不是 HPROF retained 差异。",
                  )}
                </p>
              </>
            )}
          </section>
        </section>
      )}

      {threadDumpReport && inspectedThreadDumpArtifact && (
        <section
          className="thread-dump-inspector"
          aria-label={t("线程转储检查器")}
        >
          <header className="thread-dump-inspector__header">
            <div>
              <p className="eyebrow">THREAD DUMP INSPECTOR / LOCAL</p>
              <h2>{t("线程现场，作为证据重新打开。")}</h2>
              <p>
                {inspectedThreadDumpArtifact.name} ·{" "}
                {threadDumpReport.capturedAt
                  ? formatDateTime(threadDumpReport.capturedAt)
                  : t("未知时间")}{" "}
                · PID {threadDumpReport.processId ?? "—"}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={closeThreadDumpInspector}
            >
              {t("关闭检查器")}
            </Button>
          </header>

          <dl className="thread-dump-metrics">
            <div>
              <dt>{t("线程")}</dt>
              <dd>{threadDumpReport.threads.length.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("状态类型")}</dt>
              <dd>{Object.keys(threadDumpReport.stateCounts).length}</dd>
            </div>
            <div>
              <dt>{t("死锁")}</dt>
              <dd>{threadDumpReport.deadlockedThreads}</dd>
            </div>
            <div>
              <dt>{t("最大堆栈")}</dt>
              <dd>{threadDumpReport.maximumStackDepth}</dd>
            </div>
          </dl>

          <p className="thread-dump-inspector__boundary">
            {t(
              "Host 已重新校验真实路径、普通文件、扩展名、大小与 SHA-256；Renderer 只接收最多 10000 个线程和每线程 512 层的结构化结果。",
            )}
            {threadDumpReport.truncated && (
              <strong>{t("目标线程数超过采集上限，结果已截断。")}</strong>
            )}
          </p>

          <section className="thread-dump-comparison">
            <header className="thread-dump-comparison__header">
              <div>
                <p className="eyebrow">THREAD DUMP DIFF / BOUNDED LINEAR</p>
                <h3>{t("两个现场，自动标出变化。")}</h3>
                <p>
                  {t(
                    "选择较早的同一 JVM 转储作为基线；Host 会再次校验两份制品，并按线程 ID 与名称联合识别生命周期。",
                  )}
                </p>
              </div>
              <div className="thread-dump-comparison__controls">
                <Label>
                  <span>{t("基线线程转储")}</span>
                  <SelectControl
                    value={selectedBaselineArtifactId}
                    disabled={!threadDumpComparisonCandidates.length}
                    onValueChange={(value) =>
                      setSelectedBaselineArtifactId(value)
                    }
                  >
                    <SelectControlItem value="">
                      {t("选择较早的转储")}
                    </SelectControlItem>
                    {threadDumpComparisonCandidates.map((artifact) => (
                      <SelectControlItem key={artifact.id} value={artifact.id}>
                        {formatDateTime(artifact.createdAt)} · {artifact.name}
                      </SelectControlItem>
                    ))}
                  </SelectControl>
                </Label>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    Boolean(!selectedBaselineArtifactId) ||
                    Boolean(comparingThreadDumps)
                  }
                  onClick={() => void compareThreadDumps()}
                  aria-busy={Boolean(comparingThreadDumps)}
                >
                  {Boolean(comparingThreadDumps) && <Spinner />}
                  {t("生成差异")}
                </Button>
              </div>
            </header>

            {!threadDumpComparisonCandidates.length && (
              <p className="thread-dump-comparison__empty">
                {t(
                  "还需要同一目标的一份较早线程转储；返回线程页再次采集后即可自动对比。",
                )}
              </p>
            )}

            {threadDumpComparison && (
              <>
                <dl className="thread-dump-comparison__metrics">
                  <div>
                    <dt>{t("新增")}</dt>
                    <dd>{threadDumpComparison.summary.addedThreads}</dd>
                  </div>
                  <div>
                    <dt>{t("退出")}</dt>
                    <dd>{threadDumpComparison.summary.removedThreads}</dd>
                  </div>
                  <div>
                    <dt>{t("变化")}</dt>
                    <dd>{threadDumpComparison.summary.changedThreads}</dd>
                  </div>
                  <div>
                    <dt>{t("状态变化")}</dt>
                    <dd>{threadDumpComparison.summary.stateChanges}</dd>
                  </div>
                  <div>
                    <dt>{t("新增死锁")}</dt>
                    <dd>{threadDumpComparison.summary.newlyDeadlocked}</dd>
                  </div>
                </dl>

                <p className="thread-dump-comparison__boundary">
                  {t(
                    "{persisted} 个线程持续存在 · 间隔 {duration} · CPU 增量仅在两次均可用且未回退时计算。",
                    {
                      persisted: threadDumpComparison.summary.persistedThreads,
                      duration:
                        threadDumpComparison.intervalMillis === null
                          ? t("未知")
                          : formatDuration(threadDumpComparison.intervalMillis),
                    },
                  )}
                  {(threadDumpComparison.baselineTruncated ||
                    threadDumpComparison.currentTruncated) && (
                    <strong>
                      {t("至少一份转储被截断，新增与退出数量可能不完整。")}
                    </strong>
                  )}
                </p>

                <div className="thread-dump-comparison__filters">
                  <Label>
                    <span>{t("线程、状态或栈顶")}</span>
                    <Input
                      value={comparisonQueryInput}
                      type="search"
                      autoComplete="off"
                      placeholder={t("例如 integration-lock-waiter")}
                      onChange={(e) => setComparisonQueryInput(e.target.value)}
                      onKeyUp={(e) => {
                        if (e.key === "Enter") {
                          applyComparisonFilter();
                        }
                      }}
                    />
                  </Label>
                  <Label>
                    <span>{t("变化类型")}</span>
                    <SelectControl
                      value={comparisonKind}
                      onValueChange={(value) => {
                        setComparisonKind(value);
                        applyComparisonFilter();
                      }}
                    >
                      <SelectControlItem value="ALL">
                        {t("全部变化")}
                      </SelectControlItem>
                      <SelectControlItem value="CHANGED">
                        {t("变化")}
                      </SelectControlItem>
                      <SelectControlItem value="ADDED">
                        {t("新增")}
                      </SelectControlItem>
                      <SelectControlItem value="REMOVED">
                        {t("退出")}
                      </SelectControlItem>
                      <SelectControlItem value="UNCHANGED">
                        {t("稳定")}
                      </SelectControlItem>
                    </SelectControl>
                  </Label>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={applyComparisonFilter}
                  >
                    {t("筛选差异")}
                  </Button>
                </div>

                <div className="thread-dump-comparison__workbench">
                  <aside className="thread-dump-change-list">
                    <header>
                      <div>
                        <p className="eyebrow">CHANGE INDEX</p>
                        <strong>
                          {t("{count} 个匹配", {
                            count: filteredThreadChanges.length,
                          })}
                        </strong>
                      </div>
                      <span>
                        {visibleThreadChanges.length} /{" "}
                        {filteredThreadChanges.length}
                      </span>
                    </header>
                    {visibleThreadChanges.map((change) => (
                      <Button
                        variant="ghost"
                        key={threadChangeIdentity(change)}
                        type="button"
                        className={cn(
                          "thread-dump-change",
                          threadChangeIdentity(change) ===
                            threadChangeIdentity(
                              selectedThreadChange ?? change,
                            ) && "thread-dump-change--selected",
                        )}
                        onClick={() =>
                          setSelectedThreadChangeIdentity(
                            threadChangeIdentity(change),
                          )
                        }
                      >
                        <span>
                          <strong>
                            #{change.id} · {change.name}
                          </strong>
                          <small>
                            {change.baselineState ?? "—"} →{" "}
                            {change.currentState ?? "—"}
                          </small>
                        </span>
                        <StatusPill
                          state={threadChangeState(change)}
                          label={threadChangeLabel(change)}
                        />
                      </Button>
                    ))}
                    {visibleThreadChanges.length <
                      filteredThreadChanges.length && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          setComparisonRenderLimit((limit) =>
                            Math.min(filteredThreadChanges.length, limit + 100),
                          )
                        }
                      >
                        {t("再显示 100 个变化")}
                      </Button>
                    )}
                    {!filteredThreadChanges.length && (
                      <p className="thread-dump-empty">
                        {t("当前筛选没有匹配变化。")}
                      </p>
                    )}
                  </aside>

                  <section className="thread-dump-change-detail">
                    {selectedThreadChange ? (
                      <>
                        <header>
                          <div>
                            <p className="eyebrow">
                              THREAD #{selectedThreadChange.id}
                            </p>
                            <h4>{selectedThreadChange.name}</h4>
                          </div>
                          <StatusPill
                            state={threadChangeState(selectedThreadChange)}
                            label={threadChangeLabel(selectedThreadChange)}
                          />
                        </header>
                        <dl>
                          <div>
                            <dt>{t("状态")}</dt>
                            <dd>
                              {selectedThreadChange.baselineState ?? "—"} →{" "}
                              {selectedThreadChange.currentState ?? "—"}
                            </dd>
                          </div>
                          <div>
                            <dt>{t("CPU 增量")}</dt>
                            <dd>
                              {formatCpuNanos(
                                selectedThreadChange.cpuDeltaNanos,
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>{t("变化证据")}</dt>
                            <dd className="thread-dump-change-flags">
                              {selectedThreadChange.stateChanged && (
                                <span>{t("状态")}</span>
                              )}
                              {selectedThreadChange.waitChanged && (
                                <span>{t("等待关系")}</span>
                              )}
                              {selectedThreadChange.stackChanged && (
                                <span>{t("堆栈")}</span>
                              )}
                              {selectedThreadChange.locksChanged && (
                                <span>{t("持有锁")}</span>
                              )}
                              {selectedThreadChange.newlyDeadlocked && (
                                <span>{t("新增死锁")}</span>
                              )}
                              {selectedThreadChange.recoveredDeadlocked && (
                                <span>{t("死锁解除")}</span>
                              )}
                              {selectedThreadChange.kind === "UNCHANGED" && (
                                <span>{t("结构稳定")}</span>
                              )}
                            </dd>
                          </div>
                        </dl>
                        <div className="thread-dump-change-evidence">
                          <section>
                            <p className="eyebrow">BASELINE</p>
                            <dl>
                              <div>
                                <dt>{t("等待锁")}</dt>
                                <dd>
                                  {selectedThreadChange.baselineWaitingOn ??
                                    t("无")}
                                </dd>
                              </div>
                              <div>
                                <dt>{t("持有者")}</dt>
                                <dd>
                                  {selectedThreadChange.baselineLockOwnerId ? (
                                    <>
                                      #
                                      {selectedThreadChange.baselineLockOwnerId}{" "}
                                      ·{" "}
                                      {selectedThreadChange.baselineLockOwnerName ||
                                        t("未知")}
                                    </>
                                  ) : (
                                    t("无")
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt>{t("栈顶")}</dt>
                                <dd>
                                  {selectedThreadChange.baselineTopFrame ??
                                    t("无可用堆栈")}
                                </dd>
                              </div>
                            </dl>
                          </section>
                          <section>
                            <p className="eyebrow">CURRENT</p>
                            <dl>
                              <div>
                                <dt>{t("等待锁")}</dt>
                                <dd>
                                  {selectedThreadChange.currentWaitingOn ??
                                    t("无")}
                                </dd>
                              </div>
                              <div>
                                <dt>{t("持有者")}</dt>
                                <dd>
                                  {selectedThreadChange.currentLockOwnerId ? (
                                    <>
                                      #{selectedThreadChange.currentLockOwnerId}{" "}
                                      ·{" "}
                                      {selectedThreadChange.currentLockOwnerName ||
                                        t("未知")}
                                    </>
                                  ) : (
                                    t("无")
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt>{t("栈顶")}</dt>
                                <dd>
                                  {selectedThreadChange.currentTopFrame ??
                                    t("无可用堆栈")}
                                </dd>
                              </div>
                            </dl>
                          </section>
                        </div>
                      </>
                    ) : (
                      <p className="thread-dump-empty">
                        {t("选择一个线程变化查看前后证据。")}
                      </p>
                    )}
                  </section>
                </div>
              </>
            )}
          </section>

          <div className="thread-dump-filters">
            <Label>
              <span>{t("线程、锁或堆栈")}</span>
              <Input
                value={threadDumpQueryInput}
                type="search"
                autoComplete="off"
                placeholder={t("例如 integration-lock-waiter")}
                onChange={(e) => setThreadDumpQueryInput(e.target.value)}
                onKeyUp={(e) => {
                  if (e.key === "Enter") {
                    applyThreadDumpFilter();
                  }
                }}
              />
            </Label>
            <Label>
              <span>{t("状态")}</span>
              <SelectControl
                value={threadDumpState}
                onValueChange={(value) => {
                  setThreadDumpState(value);
                  applyThreadDumpFilter();
                }}
              >
                {threadDumpStates.map((state) => (
                  <SelectControlItem key={state} value={state}>
                    {state === "ALL" ? t("全部状态") : state}
                  </SelectControlItem>
                ))}
              </SelectControl>
            </Label>
            <Label className="thread-dump-deadlock-filter">
              <Checkbox
                checked={threadDumpDeadlockedOnly}
                onCheckedChange={(e) => {
                  setThreadDumpDeadlockedOnly(e === true);
                  applyThreadDumpFilter();
                }}
              />
              <span>{t("仅死锁")}</span>
            </Label>
            <Button
              type="button"
              variant="outline"
              onClick={applyThreadDumpFilter}
            >
              {t("筛选转储")}
            </Button>
          </div>

          <div className="thread-dump-workbench">
            <aside className="thread-dump-thread-list">
              <header>
                <div>
                  <p className="eyebrow">THREAD INDEX</p>
                  <strong>
                    {t("{count} 个匹配", {
                      count: filteredDumpThreads.length,
                    })}
                  </strong>
                </div>
                <span>
                  {visibleDumpThreads.length} / {filteredDumpThreads.length}
                </span>
              </header>
              {visibleDumpThreads.map((thread) => (
                <Button
                  variant="ghost"
                  key={thread.id}
                  type="button"
                  className={cn(
                    "thread-dump-thread",
                    thread.id === selectedDumpThread?.id &&
                      "thread-dump-thread--selected",
                    thread.deadlocked && "thread-dump-thread--deadlocked",
                  )}
                  onClick={() => setSelectedDumpThreadId(thread.id)}
                >
                  <span>
                    <strong>
                      #{thread.id} · {thread.name}
                    </strong>
                    <small>{thread.stack[0] ?? t("无可用堆栈")}</small>
                  </span>
                  <StatusPill
                    state={thread.deadlocked ? "error" : "idle"}
                    label={thread.deadlocked ? t("死锁") : thread.state}
                  />
                </Button>
              ))}
              {visibleDumpThreads.length < filteredDumpThreads.length && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setThreadDumpRenderLimit((limit) =>
                      Math.min(filteredDumpThreads.length, limit + 100),
                    )
                  }
                >
                  {t("再显示 100 个线程")}
                </Button>
              )}
              {!filteredDumpThreads.length && (
                <p className="thread-dump-empty">
                  {t("当前筛选没有匹配线程。")}
                </p>
              )}
            </aside>

            <section className="thread-dump-detail">
              {selectedDumpThread && (
                <>
                  <header>
                    <div>
                      <p className="eyebrow">THREAD #{selectedDumpThread.id}</p>
                      <h3>{selectedDumpThread.name}</h3>
                    </div>
                    <StatusPill
                      state={selectedDumpThread.deadlocked ? "error" : "idle"}
                      label={
                        selectedDumpThread.deadlocked
                          ? t("死锁")
                          : selectedDumpThread.state
                      }
                    />
                  </header>
                  <dl>
                    <div>
                      <dt>{t("累计 CPU")}</dt>
                      <dd>{formatCpuNanos(selectedDumpThread.cpuTimeNanos)}</dd>
                    </div>
                    <div>
                      <dt>{t("等待锁")}</dt>
                      <dd>{selectedDumpThread.waitingOn ?? t("无")}</dd>
                    </div>
                    <div>
                      <dt>{t("持有者")}</dt>
                      <dd>
                        {selectedDumpThread.lockOwnerId ? (
                          <>
                            #{selectedDumpThread.lockOwnerId} ·{" "}
                            {selectedDumpThread.lockOwnerName || t("未知")}
                          </>
                        ) : (
                          t("无")
                        )}
                      </dd>
                    </div>
                  </dl>
                  <section className="thread-dump-stack">
                    <header>
                      <p className="eyebrow">STACK TRACE</p>
                      <span>{selectedDumpThread.stack.length}</span>
                    </header>
                    <ol>
                      {selectedDumpThread.stack.map((frame, index) => (
                        <li key={`${selectedDumpThread.id}:${index}`}>
                          {frame}
                        </li>
                      ))}
                    </ol>
                    {!selectedDumpThread.stack.length && (
                      <p>{t("无可用堆栈")}</p>
                    )}
                  </section>
                  <div className="thread-dump-locks">
                    <section>
                      <p className="eyebrow">
                        MONITORS / {selectedDumpThread.monitors.length}
                      </p>
                      {selectedDumpThread.monitors.map((monitor) => (
                        <code key={monitor}>{monitor}</code>
                      ))}
                      {!selectedDumpThread.monitors.length && (
                        <span>{t("无")}</span>
                      )}
                    </section>
                    <section>
                      <p className="eyebrow">
                        SYNCHRONIZERS /{" "}
                        {selectedDumpThread.synchronizers.length}
                      </p>
                      {selectedDumpThread.synchronizers.map((synchronizer) => (
                        <code key={synchronizer}>{synchronizer}</code>
                      ))}
                      {!selectedDumpThread.synchronizers.length && (
                        <span>{t("无")}</span>
                      )}
                    </section>
                  </div>
                </>
              )}
            </section>
          </div>
        </section>
      )}

      {jfrReport && inspectedJfrArtifact && (
        <section className="jfr-inspector" aria-label={t("JFR 事件检查器")}>
          <header className="jfr-inspector__header">
            <div>
              <p className="eyebrow">JFR EVENT INSPECTOR / LOCAL</p>
              <h2>{t("录制内容，直接检查。")}</h2>
              <p>
                {inspectedJfrArtifact.name} ·{" "}
                {t("{start} 至 {end}", {
                  start: jfrReport.startedAt
                    ? formatDateTime(jfrReport.startedAt)
                    : t("未知"),
                  end: jfrReport.endedAt
                    ? formatDateTime(jfrReport.endedAt)
                    : t("未知"),
                })}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={closeJfrInspector}>
              {t("关闭检查器")}
            </Button>
          </header>

          <dl className="jfr-metrics">
            <div>
              <dt>{t("事件")}</dt>
              <dd>{jfrReport.eventCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("事件类型")}</dt>
              <dd>{jfrReport.eventTypes.length.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("峰值 JVM CPU")}</dt>
              <dd>{peakJvmCpuPercent.toFixed(1)}%</dd>
            </div>
            <div>
              <dt>{t("GC 停顿合计")}</dt>
              <dd>{formatDuration(totalGcPauseMillis)}</dd>
            </div>
            <div>
              <dt>{t("JIT 编译")}</dt>
              <dd>{jfrReport.compilationCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("OSR / 失败")}</dt>
              <dd>
                {totalOsrCompilations.toLocaleString()} /{" "}
                {totalFailedCompilations.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>{t("去优化")}</dt>
              <dd>{jfrReport.deoptimizationCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("生成代码")}</dt>
              <dd>{formatBytes(jfrReport.compiledCodeBytes)}</dd>
            </div>
          </dl>

          <p className="jfr-inspector__boundary">
            {t(
              "Host 已重新校验真实路径、大小与 SHA-256；只解析选定事件，最多读取 32 MiB JSON 和 200,000 条事件。",
            )}
            {jfrReport.truncated && (
              <strong>{t("结果已按安全上限截断。")}</strong>
            )}
          </p>

          <div className="jfr-inspector__grid">
            <section className="jfr-panel jfr-panel--wide">
              <header>
                <div>
                  <p className="eyebrow">JIT COMPILATION / C1 + C2</p>
                  <h3>{t("编译热点")}</h3>
                </div>
                <span>
                  {t("{count} 组", { count: jfrReport.compilations.length })}
                </span>
              </header>
              {jfrReport.compilations.length ? (
                <div className="jfr-table-wrap">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t("方法")}</TableHead>
                        <TableHead scope="col">{t("编译器 / 层级")}</TableHead>
                        <TableHead scope="col">{t("次数 / OSR")}</TableHead>
                        <TableHead scope="col">
                          {t("成功 / 失败 / 未知")}
                        </TableHead>
                        <TableHead scope="col">{t("总耗时 / 最慢")}</TableHead>
                        <TableHead scope="col">{t("代码 / 内联")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jfrReport.compilations.map((compilation) => (
                        <TableRow
                          key={`${compilation.method}:${compilation.compiler}:${compilation.compileLevel}`}
                        >
                          <TableCell>
                            <code>{compilation.method}</code>
                          </TableCell>
                          <TableCell>
                            <span className="jfr-cell-stack">
                              <strong>{compilation.compiler}</strong>
                              <span>
                                {formatCompileLevel(compilation.compileLevel)}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="jfr-cell-stack">
                              <strong>
                                {compilation.compilations.toLocaleString()}
                              </strong>
                              <span>
                                {compilation.osrCompilations.toLocaleString()}{" "}
                                OSR
                              </span>
                            </span>
                          </TableCell>
                          <TableCell>
                            {compilation.succeededCompilations.toLocaleString()}{" "}
                            / {compilation.failedCompilations.toLocaleString()}{" "}
                            /{" "}
                            {compilation.unknownOutcomeCompilations.toLocaleString()}
                          </TableCell>
                          <TableCell>
                            <span className="jfr-cell-stack">
                              <strong>
                                {formatDuration(
                                  compilation.totalDurationMillis,
                                )}
                              </strong>
                              <span>
                                {formatDuration(
                                  compilation.maximumDurationMillis,
                                )}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="jfr-cell-stack">
                              <strong>
                                {formatBytes(compilation.codeBytes)}
                              </strong>
                              <span>
                                {formatBytes(compilation.inlinedBytes)}
                              </span>
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="jfr-panel__empty">
                  {t("这次录制没有达到 1 ms 阈值的 Compilation 事件。")}
                </p>
              )}
            </section>

            <section className="jfr-panel">
              <header>
                <div>
                  <p className="eyebrow">COMPILER TIERS</p>
                  <h3>{t("编译器分层")}</h3>
                </div>
                <span>
                  {formatDuration(jfrReport.compilationDurationMillis)}
                </span>
              </header>
              {jfrReport.compilerTiers.length ? (
                <dl className="jfr-tier-list">
                  {jfrReport.compilerTiers.map((tier) => (
                    <div key={tier.compiler}>
                      <dt>{tier.compiler}</dt>
                      <dd>
                        <strong>{tier.compilations.toLocaleString()}</strong>
                        <span>
                          {tier.osrCompilations.toLocaleString()} OSR ·{" "}
                          {tier.failedCompilations.toLocaleString()} {t("失败")}
                        </span>
                        <span>
                          {formatDuration(tier.totalDurationMillis)} ·{" "}
                          {formatBytes(tier.codeBytes)}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="jfr-panel__empty">
                  {t("这次录制没有编译分层数据。")}
                </p>
              )}
            </section>

            <section className="jfr-panel">
              <header>
                <div>
                  <p className="eyebrow">DEOPTIMIZATION</p>
                  <h3>{t("去优化原因")}</h3>
                </div>
                <span>{jfrReport.deoptimizations.length}</span>
              </header>
              {jfrReport.deoptimizations.length ? (
                <ol className="jfr-deoptimization-list">
                  {jfrReport.deoptimizations.map((deoptimization) => (
                    <li
                      key={`${deoptimization.method}:${deoptimization.compiler}:${deoptimization.reason}:${deoptimization.action}`}
                    >
                      <header>
                        <strong>{deoptimization.reason}</strong>
                        <span>×{deoptimization.count.toLocaleString()}</span>
                      </header>
                      <code>{deoptimization.method}</code>
                      <p>
                        {deoptimization.compiler} · {deoptimization.action}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="jfr-panel__empty">
                  {t("这次录制没有 Deoptimization 事件。")}
                </p>
              )}
            </section>

            <section className="jfr-panel jfr-panel--wide">
              <header>
                <div>
                  <p className="eyebrow">EXECUTION SAMPLES</p>
                  <h3>{t("热点方法")}</h3>
                </div>
                <span>{jfrReport.hotMethods.length}</span>
              </header>
              {jfrReport.hotMethods.length ? (
                <div className="jfr-table-wrap">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t("方法")}</TableHead>
                        <TableHead scope="col">{t("样本")}</TableHead>
                        <TableHead scope="col">{t("占比")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jfrReport.hotMethods.map((method) => (
                        <TableRow key={method.method}>
                          <TableCell>
                            <code>{method.method}</code>
                            <span
                              className="jfr-share-track"
                              style={
                                {
                                  "--jfr-share": `${method.sharePercent}%`,
                                } as CSSProperties
                              }
                              aria-hidden="true"
                            />
                          </TableCell>
                          <TableCell>
                            {method.samples.toLocaleString()}
                          </TableCell>
                          <TableCell>
                            {method.sharePercent.toFixed(1)}%
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="jfr-panel__empty">
                  {t("这次录制没有 Execution Sample。")}
                </p>
              )}
            </section>

            <section className="jfr-panel">
              <header>
                <div>
                  <p className="eyebrow">ALLOCATION SAMPLES</p>
                  <h3>{t("分配热点")}</h3>
                </div>
                <span>{jfrReport.allocations.length}</span>
              </header>
              {jfrReport.allocations.length ? (
                <div className="jfr-table-wrap">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t("类")}</TableHead>
                        <TableHead scope="col">{t("估算大小")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jfrReport.allocations.map((allocation) => (
                        <TableRow key={allocation.className}>
                          <TableCell>
                            <code>{allocation.className}</code>
                          </TableCell>
                          <TableCell>
                            {formatBytes(allocation.estimatedBytes)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="jfr-panel__empty">
                  {t("这次录制没有 Allocation Sample。")}
                </p>
              )}
            </section>

            <section className="jfr-panel">
              <header>
                <div>
                  <p className="eyebrow">EVENT CATALOG</p>
                  <h3>{t("事件分布")}</h3>
                </div>
              </header>
              <ol className="jfr-event-types">
                {jfrReport.eventTypes.map((eventType) => (
                  <li key={eventType.type}>
                    <code>{eventType.type}</code>
                    <strong>{eventType.count.toLocaleString()}</strong>
                  </li>
                ))}
              </ol>
            </section>

            {!!jfrReport.gcPauses.length && (
              <section className="jfr-panel jfr-panel--wide">
                <header>
                  <div>
                    <p className="eyebrow">GC PAUSES</p>
                    <h3>{t("GC 停顿")}</h3>
                  </div>
                </header>
                <div className="jfr-table-wrap">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t("时间")}</TableHead>
                        <TableHead scope="col">{t("名称")}</TableHead>
                        <TableHead scope="col">{t("原因")}</TableHead>
                        <TableHead scope="col">{t("耗时")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jfrReport.gcPauses.map((pause) => (
                        <TableRow key={`${pause.capturedAt}:${pause.name}`}>
                          <TableCell>
                            {formatDateTime(pause.capturedAt)}
                          </TableCell>
                          <TableCell>{pause.name}</TableCell>
                          <TableCell>{pause.cause || t("未知")}</TableCell>
                          <TableCell>
                            {formatDuration(pause.durationMillis)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )}
          </div>
        </section>
      )}

      <div className="artifact-list" aria-live="polite">
        {artifacts.map((artifact) => (
          <article key={artifact.id}>
            <header>
              <span className="artifact-type">{artifact.type}</span>
              <StatusPill
                state={artifact.status === "READY" ? "ready" : "error"}
                label={artifact.status}
              />
            </header>
            <h2>{artifact.name}</h2>
            <dl>
              <div>
                <dt>Target</dt>
                <dd>{artifact.targetId}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(artifact.size)}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd>{artifact.sha256}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(artifact.createdAt)}</dd>
              </div>
            </dl>
            <div className="artifact-actions">
              {artifact.type === "HEAP_HISTOGRAM" &&
                artifact.status === "READY" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void inspectHeapHistogram(artifact)}
                    aria-busy={Boolean(inspectingArtifactId === artifact.id)}
                    disabled={Boolean(inspectingArtifactId === artifact.id)}
                  >
                    {Boolean(inspectingArtifactId === artifact.id) && (
                      <Spinner />
                    )}
                    {t("检查Heap快照")}
                  </Button>
                )}
              {artifact.type === "THREAD_DUMP" &&
                artifact.status === "READY" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void inspectThreadDump(artifact)}
                    aria-busy={Boolean(inspectingArtifactId === artifact.id)}
                    disabled={Boolean(inspectingArtifactId === artifact.id)}
                  >
                    {Boolean(inspectingArtifactId === artifact.id) && (
                      <Spinner />
                    )}
                    {t("检查线程转储")}
                  </Button>
                )}
              {artifact.type === "THREAD_POOL_TREND" &&
                artifact.status === "READY" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void inspectThreadPoolTrend(artifact)}
                    aria-busy={Boolean(inspectingArtifactId === artifact.id)}
                    disabled={Boolean(inspectingArtifactId === artifact.id)}
                  >
                    {Boolean(inspectingArtifactId === artifact.id) && (
                      <Spinner />
                    )}
                    {t("检查池趋势")}
                  </Button>
                )}
              {artifact.type === "JIT_TREND" && artifact.status === "READY" && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void inspectJitTrend(artifact)}
                  aria-busy={Boolean(inspectingArtifactId === artifact.id)}
                  disabled={Boolean(inspectingArtifactId === artifact.id)}
                >
                  {Boolean(inspectingArtifactId === artifact.id) && <Spinner />}
                  {t("检查 JIT 趋势")}
                </Button>
              )}
              {(artifact.type === "TRACE_HOTSPOTS" ||
                artifact.type === "MONITOR_WINDOWS") &&
                artifact.status === "READY" && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void inspectObservationExport(artifact)}
                    aria-busy={Boolean(inspectingArtifactId === artifact.id)}
                    disabled={Boolean(inspectingArtifactId === artifact.id)}
                  >
                    {Boolean(inspectingArtifactId === artifact.id) && (
                      <Spinner />
                    )}
                    {t("检查观测导出")}
                  </Button>
                )}
              {artifact.type === "JFR" && artifact.status === "READY" && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void inspectJfr(artifact)}
                  aria-busy={Boolean(inspectingArtifactId === artifact.id)}
                  disabled={Boolean(inspectingArtifactId === artifact.id)}
                >
                  {Boolean(inspectingArtifactId === artifact.id) && <Spinner />}
                  {t("分析JFR")}
                </Button>
              )}
              {artifact.type === "PROFILE" && artifact.status === "READY" && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void openProfileReport(artifact)}
                  aria-busy={Boolean(openingArtifactId === artifact.id)}
                  disabled={Boolean(openingArtifactId === artifact.id)}
                >
                  {Boolean(openingArtifactId === artifact.id) && <Spinner />}
                  {t("在应用内打开报告")}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => void verifyArtifact(artifact)}
              >
                {verifiedArtifactId === artifact.id
                  ? t("校验通过")
                  : t("重新校验")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPendingReveal(artifact)}
              >
                {t("在文件夹中显示")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPendingDelete(artifact)}
              >
                {t("删除制品")}
              </Button>
            </div>
          </article>
        ))}

        {!loading && artifacts.length === 0 && (
          <Empty className="empty-panel">
            <p className="eyebrow">NO ARTIFACTS</p>
            <p className="empty-panel__title">{t("还没有固定证据。")}</p>
            <p>{t("连接目标后可把当前结构化快照保存为本地制品。")}</p>
          </Empty>
        )}
      </div>
    </section>
  );
}
