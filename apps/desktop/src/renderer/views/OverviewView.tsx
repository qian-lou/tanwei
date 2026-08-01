import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CirclePause,
  CirclePlay,
  RefreshCw,
  Route,
} from "lucide-react";
import { useNavigate } from "react-router";
import type { TargetSnapshot } from "@shared/contracts";
import MetricCard from "../components/MetricCard";
import RuntimeCorrelationCard from "../components/RuntimeCorrelationCard";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Spinner } from "../components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { t, useLocale } from "../i18n";
import { cn } from "../lib/utils";
import {
  selectConnection,
  selectSelectedTarget,
  useTargetsStore,
} from "../stores/targets";
import { RingBuffer } from "../utils/ring-buffer";
import {
  deriveRuntimeIntervals,
  summarizeRuntimeIntervals,
} from "../utils/runtime-correlation";

const MAXIMUM_SAMPLES = 300;

export default function OverviewView() {
  useLocale();
  const navigate = useNavigate();
  const selectedTargetId = useTargetsStore((state) => state.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const selectedTarget = useTargetsStore(selectSelectedTarget);
  const [samples, setSamples] = useState<readonly TargetSnapshot[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [intervalMillis, setIntervalMillis] = useState(2_000);
  const bufferRef = useRef<RingBuffer<TargetSnapshot> | null>(null);
  if (bufferRef.current === null) {
    bufferRef.current = new RingBuffer<TargetSnapshot>(MAXIMUM_SAMPLES);
  }
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(paused);
  const loadingRef = useRef(loading);
  const intervalMillisRef = useRef(intervalMillis);
  pausedRef.current = paused;
  loadingRef.current = loading;
  intervalMillisRef.current = intervalMillis;

  const hasReadyTarget = connection?.state === "READY";
  const latest = samples.at(-1) ?? null;
  const runtimeIntervals = deriveRuntimeIntervals(samples);
  const correlationSummary = summarizeRuntimeIntervals(runtimeIntervals);

  function formatPercent(value: number | null): string {
    return value === null ? t("未知") : `${(value * 100).toFixed(1)}%`;
  }

  function formatBytes(value: number | null): string {
    if (value === null) {
      return t("未知");
    }
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let amount = value;
    let unitIndex = 0;
    while (amount >= 1024 && unitIndex < units.length - 1) {
      amount /= 1024;
      unitIndex += 1;
    }
    return `${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  async function capture(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const targetId = targetsState.selectedTargetId;
    const ready = selectConnection(targetsState)?.state === "READY";
    if (!targetId || !ready || pausedRef.current || loadingRef.current) {
      scheduleNext();
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await window.tanwei.getSnapshot(targetId);
      if (result.ok && result.value) {
        setErrorMessage(null);
        bufferRef.current?.append(result.value);
        setSamples(bufferRef.current?.toArray() ?? []);
      } else {
        setErrorMessage(result.errorMessage ?? t("无法读取实时运行状态"));
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取实时运行状态"),
      );
    } finally {
      loadingRef.current = false;
      setLoading(false);
      scheduleNext();
    }
  }

  function scheduleNext(): void {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(
      () => void capture(),
      intervalMillisRef.current,
    );
  }

  function togglePause(): void {
    const nextPaused = !pausedRef.current;
    pausedRef.current = nextPaused;
    setPaused(nextPaused);
    if (!nextPaused) {
      void capture();
    }
  }

  function resetAndCapture(): void {
    bufferRef.current?.clear();
    setSamples([]);
    setErrorMessage(null);
    void capture();
  }

  const skipInitialTargetSync = useRef(true);
  useEffect(() => {
    if (skipInitialTargetSync.current) {
      skipInitialTargetSync.current = false;
      return;
    }
    resetAndCapture();
  }, [selectedTargetId]);

  const skipInitialIntervalSync = useRef(true);
  useEffect(() => {
    if (skipInitialIntervalSync.current) {
      skipInitialIntervalSync.current = false;
      return;
    }
    scheduleNext();
  }, [intervalMillis]);

  useEffect(() => {
    void (async () => {
      const settings = await window.tanwei.getSettings();
      if (settings.ok && settings.value) {
        intervalMillisRef.current =
          settings.value.defaultSamplingIntervalMillis;
        setIntervalMillis(settings.value.defaultSamplingIntervalMillis);
      }
      await capture();
    })();
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  const metrics = [
    {
      label: "PROCESS CPU",
      value: formatPercent(latest?.processCpuLoad ?? null),
      detail: latest
        ? `${t("系统")} ${formatPercent(latest.systemCpuLoad)}`
        : t("等待目标数据"),
      points: samples.flatMap((sample) =>
        sample.processCpuLoad === null ? [] : [sample.processCpuLoad * 100],
      ),
      pattern: "solid" as const,
    },
    {
      label: "HEAP USED",
      value: formatBytes(latest?.heapUsedBytes ?? null),
      detail:
        latest?.heapMaxBytes && latest.heapMaxBytes > 0
          ? `${t("上限")} ${formatBytes(latest.heapMaxBytes)}`
          : t("上限未知"),
      points: samples.map((sample) =>
        sample.heapMaxBytes > 0
          ? (sample.heapUsedBytes / sample.heapMaxBytes) * 100
          : sample.heapUsedBytes / 1024 / 1024,
      ),
      pattern: "dashed" as const,
    },
    {
      label: "LIVE THREADS",
      value: latest ? String(latest.liveThreads) : t("未知"),
      detail: latest ? `${t("峰值")} ${latest.peakThreads}` : t("等待目标数据"),
      points: samples.map((sample) => sample.liveThreads),
      pattern: "dotted" as const,
    },
    {
      label: "GC TIME",
      value: latest ? `${latest.gcTimeMillis} ms` : t("未知"),
      detail: latest
        ? t("{count} 次收集", { count: latest.gcCount })
        : t("等待目标数据"),
      points: samples.map((sample) => sample.gcTimeMillis),
      pattern: "dashed" as const,
    },
  ];

  return (
    <section className="page overview-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">LIVE RUNTIME</p>
          <h1>{t("运行正在发生。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "CPU、内存、线程、GC 与类加载使用最多 300 点的固定窗口。缺失数据明确显示为“未知”。",
          )}
        </p>
      </header>

      {!hasReadyTarget ? (
        <DisconnectedRuntimeCard
          targetSelected={selectedTarget !== null}
          onOpenTargets={() => void navigate("/targets")}
        />
      ) : (
        <SamplingToolbar
          paused={paused}
          loading={loading}
          sampleCount={samples.length}
          intervalMillis={intervalMillis}
          onIntervalChange={setIntervalMillis}
          onTogglePause={togglePause}
          onRefresh={() => void capture()}
        />
      )}

      {errorMessage && (
        <Alert variant="destructive" className="mb-5">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>{t("无法读取实时运行状态")}</AlertTitle>
          <AlertDescription>{t(errorMessage)}</AlertDescription>
        </Alert>
      )}

      <div
        data-testid="overview-metrics"
        className={cn(
          "grid gap-4 md:grid-cols-2",
          !hasReadyTarget && "opacity-50",
        )}
        aria-disabled={!hasReadyTarget}
      >
        {metrics.map((metric) => (
          <MetricCard
            key={metric.label}
            label={metric.label}
            value={metric.value}
            detail={metric.detail}
            points={metric.points}
            pattern={metric.pattern}
          />
        ))}
      </div>

      {latest && (
        <>
          <RuntimeSummaryCard latest={latest} formatBytes={formatBytes} />
          <RuntimeCorrelationCard
            intervals={runtimeIntervals}
            summary={correlationSummary}
          />
        </>
      )}

      <DiagnosticPathCard
        onOpenThreads={() => void navigate("/threads")}
        onOpenClasses={() => void navigate("/classes")}
        onOpenObserve={() => void navigate("/observe")}
      />
    </section>
  );
}

interface DisconnectedRuntimeCardProps {
  readonly targetSelected: boolean;
  readonly onOpenTargets: () => void;
}

function DisconnectedRuntimeCard({
  targetSelected,
  onOpenTargets,
}: DisconnectedRuntimeCardProps) {
  return (
    <Card className="mb-6">
      <CardContent className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
        <div className="grid gap-2">
          <Badge variant="outline">NO ACTIVE CONNECTION</Badge>
          <h2 className="text-lg font-semibold">{t("先连接一个目标 JVM。")}</h2>
          <p className="text-muted-foreground text-sm">
            {targetSelected
              ? t("目标已选择，但 Agent 尚未建立握手。")
              : t("当前没有选择目标。")}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={onOpenTargets}>
          {t("返回目标列表")}
          <ArrowRight aria-hidden="true" />
        </Button>
      </CardContent>
    </Card>
  );
}

interface SamplingToolbarProps {
  readonly paused: boolean;
  readonly loading: boolean;
  readonly sampleCount: number;
  readonly intervalMillis: number;
  readonly onIntervalChange: (intervalMillis: number) => void;
  readonly onTogglePause: () => void;
  readonly onRefresh: () => void;
}

function SamplingToolbar({
  paused,
  loading,
  sampleCount,
  intervalMillis,
  onIntervalChange,
  onTogglePause,
  onRefresh,
}: SamplingToolbarProps) {
  return (
    <Card className="mb-6 gap-0 py-0" aria-label={t("实时采样控制")}>
      <CardContent className="flex flex-col gap-4 py-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={paused ? "outline" : "secondary"} className="gap-1">
            {loading ? <Spinner /> : <Activity aria-hidden="true" />}
            {paused ? t("已暂停") : loading ? t("正在采样") : t("实时采样")}
          </Badge>
          <Badge variant="secondary">
            {t("{count}/{maximum} 点", {
              count: sampleCount,
              maximum: MAXIMUM_SAMPLES,
            })}
          </Badge>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="grid min-w-40 gap-2">
            <Label htmlFor="overview-sampling-interval">{t("刷新间隔")}</Label>
            <Select
              value={String(intervalMillis)}
              onValueChange={(value) => onIntervalChange(Number(value))}
            >
              <SelectTrigger id="overview-sampling-interval" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1000">{t("1 秒")}</SelectItem>
                <SelectItem value="2000">{t("2 秒")}</SelectItem>
                <SelectItem value="5000">{t("5 秒")}</SelectItem>
                <SelectItem value="10000">{t("10 秒")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="button" variant="outline" onClick={onTogglePause}>
            {paused ? (
              <CirclePlay aria-hidden="true" />
            ) : (
              <CirclePause aria-hidden="true" />
            )}
            {paused ? t("恢复") : t("暂停")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            aria-busy={loading}
            onClick={onRefresh}
          >
            {loading ? <Spinner /> : <RefreshCw aria-hidden="true" />}
            {t("立即刷新")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface RuntimeSummaryCardProps {
  readonly latest: TargetSnapshot;
  readonly formatBytes: (value: number | null) => string;
}

function RuntimeSummaryCard({ latest, formatBytes }: RuntimeSummaryCardProps) {
  return (
    <Card
      className="mt-5 gap-0 overflow-hidden py-0"
      aria-label={t("运行时摘要")}
    >
      <dl className="grid sm:grid-cols-3">
        <RuntimeSummaryFact
          label="NON-HEAP"
          value={formatBytes(latest.nonHeapUsedBytes)}
          detail="Non-Heap"
        />
        <RuntimeSummaryFact
          label="LOADED CLASSES"
          value={String(latest.loadedClasses)}
          detail={t("已加载类")}
        />
        <RuntimeSummaryFact
          label="UPTIME"
          value={Math.floor(latest.uptimeMillis / 1_000) + " s"}
          detail={t("{time} 更新", {
            time: new Date(latest.capturedAt).toLocaleTimeString(),
          })}
        />
      </dl>
    </Card>
  );
}

interface RuntimeSummaryFactProps {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}

function RuntimeSummaryFact({ label, value, detail }: RuntimeSummaryFactProps) {
  return (
    <div className="grid gap-2 border-b p-5 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="font-mono text-lg font-semibold tabular-nums">{value}</dd>
      <span className="text-muted-foreground text-xs">{detail}</span>
    </div>
  );
}

interface DiagnosticPathCardProps {
  readonly onOpenThreads: () => void;
  readonly onOpenClasses: () => void;
  readonly onOpenObserve: () => void;
}

function DiagnosticPathCard({
  onOpenThreads,
  onOpenClasses,
  onOpenObserve,
}: DiagnosticPathCardProps) {
  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Route aria-hidden="true" className="size-4" />
          <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            DIAGNOSTIC PATH
          </p>
        </div>
        <CardTitle>{t("从信号直接进入证据。")}</CardTitle>
        <CardDescription>
          {t("CPU、Heap 与 RT 信号只负责指路；结论仍需进入对应检查器核对。")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        <DiagnosticPathButton
          index="01"
          label={t("高 CPU → 线程排序 → 完整堆栈")}
          onClick={onOpenThreads}
        />
        <DiagnosticPathButton
          index="02"
          label={t("Heap 增长 → 类列表 → 加载器证据")}
          onClick={onOpenClasses}
        />
        <DiagnosticPathButton
          index="03"
          label={t("RT 异常 → 方法观测 → 调用树")}
          onClick={onOpenObserve}
        />
      </CardContent>
    </Card>
  );
}

interface DiagnosticPathButtonProps {
  readonly index: string;
  readonly label: string;
  readonly onClick: () => void;
}

function DiagnosticPathButton({
  index,
  label,
  onClick,
}: DiagnosticPathButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className="h-auto min-h-16 justify-between gap-3 whitespace-normal p-4 text-left"
    >
      <span className="flex items-center gap-3">
        <Badge variant="secondary" className="font-mono">
          {index}
        </Badge>
        {label}
      </span>
      <ArrowRight aria-hidden="true" />
    </Button>
  );
}
