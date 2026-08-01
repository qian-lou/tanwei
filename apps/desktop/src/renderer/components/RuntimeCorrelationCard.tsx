import { useState, type ReactNode } from "react";
import { Clock3, Info, Waves } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";

import { t } from "../i18n";
import type {
  RuntimeCorrelationSummary,
  RuntimeIntervalAssessment,
  RuntimeIntervalEvidence,
  RuntimeIntervalSignal,
} from "../utils/runtime-correlation";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "./ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";

const MAXIMUM_VISIBLE_INTERVALS = 60;
const MAXIMUM_INSPECTED_INTERVALS = 10;
const VISIBLE_INTERVAL_OPTIONS = [20, 40, 60] as const;
const MEBIBYTE = 1024 * 1024;
const CHART_SYNC_ID = "runtime-correlation-signals";

interface RuntimeChartDatum {
  readonly endedAtEpochMillis: number;
  readonly processCpuPercent: number | null;
  readonly heapUsedMiB: number;
  readonly gcTimeDeltaMillis: number | null;
  readonly liveThreads: number;
}

export interface RuntimeCorrelationCardProps {
  readonly intervals: readonly RuntimeIntervalEvidence[];
  readonly summary: RuntimeCorrelationSummary;
}

export default function RuntimeCorrelationCard({
  intervals,
  summary,
}: RuntimeCorrelationCardProps) {
  const [visibleIntervalCount, setVisibleIntervalCount] = useState(
    MAXIMUM_VISIBLE_INTERVALS,
  );
  const latest = intervals.at(-1) ?? null;
  const visible = intervals.slice(-visibleIntervalCount);

  function handleVisibleIntervalChange(value: string): void {
    const parsed = Number(value);
    if (
      VISIBLE_INTERVAL_OPTIONS.includes(
        parsed as (typeof VISIBLE_INTERVAL_OPTIONS)[number],
      )
    ) {
      setVisibleIntervalCount(parsed);
    }
  }

  return (
    <Card
      data-testid="runtime-correlation"
      className="mt-6 gap-0 overflow-hidden"
      aria-labelledby="runtime-correlation-title"
    >
      <CardHeader className="border-b">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="grid gap-2">
            <CardTitle>
              <h2 id="runtime-correlation-title" className="text-lg">
                {t("运行时关联")}
              </h2>
            </CardTitle>
            <CardDescription className="max-w-3xl">
              {t(
                "CPU、Heap、GC 与线程使用独立量纲，并在同一时间轴上同步定位。",
              )}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2 xl:max-w-md xl:justify-end">
            <Badge variant="outline">
              {t("{count} 个有效区间", { count: summary.intervalCount })}
            </Badge>
            <Badge variant="outline">
              {t("{count} 个压力区间", {
                count: summary.pressureIntervals,
              })}
            </Badge>
            <Badge variant="outline">
              {t("{count} 个并发信号", {
                count: summary.concurrentSignalIntervals,
              })}
            </Badge>
          </div>
        </div>
      </CardHeader>

      {latest ? (
        <CardContent className="p-0">
          <RuntimeFacts latest={latest} summary={summary} />
          <div className="flex flex-col gap-3 border-b px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-muted-foreground text-sm">
              {t("显示最近 {count} 个采样区间", {
                count: Math.min(visible.length, visibleIntervalCount),
              })}
            </div>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={String(visibleIntervalCount)}
              onValueChange={handleVisibleIntervalChange}
              aria-label={t("选择图表时间窗口")}
            >
              {VISIBLE_INTERVAL_OPTIONS.map((count) => (
                <ToggleGroupItem key={count} value={String(count)}>
                  {count}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="grid xl:grid-cols-[minmax(0,7fr)_minmax(20rem,3fr)]">
            <SignalCharts intervals={visible} />
            <IntervalInspector intervals={intervals} summary={summary} />
          </div>
        </CardContent>
      ) : (
        <CardContent className="p-6">
          <Empty className="min-h-56 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Waves aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{t("等待第一个采样区间")}</EmptyTitle>
              <EmptyDescription>
                {t("至少需要两个同 JVM 周期的快照，才能计算区间变化。")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      )}
    </Card>
  );
}

interface RuntimeFactsProps {
  readonly latest: RuntimeIntervalEvidence;
  readonly summary: RuntimeCorrelationSummary;
}

function RuntimeFacts({ latest, summary }: RuntimeFactsProps) {
  return (
    <dl className="grid border-b sm:grid-cols-2 xl:grid-cols-4">
      <CorrelationFact
        label="PROCESS CPU"
        value={formatPercent(latest.processCpuLoad)}
        detail={
          summary.peakProcessCpuLoad === null
            ? t("窗口内不可用")
            : t("窗口峰值 {value}", {
                value: formatPercent(summary.peakProcessCpuLoad),
              })
        }
      />
      <CorrelationFact
        label="HEAP USED"
        value={formatBytes(latest.heapUsedBytes)}
        detail={t("当前区间 {value}", {
          value: formatSignedBytes(latest.heapDeltaBytes),
        })}
      />
      <CorrelationFact
        label="GC PAUSE"
        value={
          latest.gcTimeDeltaMillis === null
            ? t("不可用")
            : `${latest.gcTimeDeltaMillis} ms`
        }
        detail={t("窗口合计 {value} ms", {
          value: summary.totalGcTimeDeltaMillis,
        })}
      />
      <CorrelationFact
        label="LIVE THREADS"
        value={String(latest.liveThreads)}
        detail={t("当前区间 {value}", {
          value: formatSignedInteger(latest.threadDelta),
        })}
      />
    </dl>
  );
}

interface CorrelationFactProps {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}

function CorrelationFact({ label, value, detail }: CorrelationFactProps) {
  return (
    <div className="grid min-w-0 gap-2 border-b p-4 last:border-b-0 sm:border-r sm:nth-[2n]:border-r-0 xl:border-b-0 xl:border-r xl:nth-[2n]:border-r xl:last:border-r-0">
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="truncate font-mono text-lg font-semibold tabular-nums">
        {value}
      </dd>
      <span className="text-muted-foreground truncate text-xs">{detail}</span>
    </div>
  );
}

function SignalCharts({
  intervals,
}: {
  readonly intervals: readonly RuntimeIntervalEvidence[];
}) {
  const data = buildRuntimeChartData(intervals);
  const cpuValues = finiteValues(data.map((item) => item.processCpuPercent));
  const heapValues = finiteValues(data.map((item) => item.heapUsedMiB));
  const gcValues = finiteValues(data.map((item) => item.gcTimeDeltaMillis));
  const threadValues = finiteValues(data.map((item) => item.liveThreads));
  const cpuDomain = zeroBasedDomain(cpuValues, 0.1);
  const heapDomain = paddedDomain(heapValues, 0.5);
  const gcDomain = zeroBasedDomain(gcValues, 1);
  const threadDomain = integerDomain(threadValues);
  const latest = data.at(-1) ?? null;
  const missingCpuPoints = data.filter(
    (item) => item.processCpuPercent === null,
  ).length;
  const chartConfig = {
    processCpuPercent: {
      label: t("Process CPU"),
      color: "var(--chart-1)",
    },
    heapUsedMiB: {
      label: t("Heap used"),
      color: "var(--chart-2)",
    },
    gcTimeDeltaMillis: {
      label: t("GC pause"),
      color: "var(--chart-3)",
    },
    liveThreads: {
      label: t("Live threads"),
      color: "var(--chart-4)",
    },
  } satisfies ChartConfig;

  return (
    <figure
      className="min-w-0 border-b xl:border-r xl:border-b-0"
      aria-label={t("CPU、Heap、GC 与线程独立量纲关联趋势")}
    >
      <SignalLane
        label="Process CPU"
        value={formatPercentFromPercentage(latest?.processCpuPercent ?? null)}
        detail={formatDomain(cpuDomain, formatPercentFromPercentage)}
        explanation={t("CPU 使用局部百分比量程；缺失采样保持断点，不按 0 处理。")}
      >
        <ChartContainer
          config={chartConfig}
          className="h-28 w-full min-w-0 aspect-auto"
          data-series="process-cpu"
          data-available-points={data.length - missingCpuPoints}
          data-missing-points={missingCpuPoints}
        >
          <LineChart
            accessibilityLayer
            data={data}
            syncId={CHART_SYNC_ID}
            margin={{ top: 10, right: 12, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} />
            <TimeAxis hidden />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              width={54}
              domain={cpuDomain}
              tickFormatter={(value: number) => compactPercent(value)}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)" }}
              content={
                <MetricTooltipContent
                  label={t("Process CPU")}
                  formatValue={(value) => compactPercent(value)}
                />
              }
            />
            <Line
              dataKey="processCpuPercent"
              type="linear"
              stroke="var(--color-processCpuPercent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      </SignalLane>

      <SignalLane
        label="Heap used"
        value={
          latest === null ? t("不可用") : `${latest.heapUsedMiB.toFixed(1)} MiB`
        }
        detail={formatDomain(heapDomain, (value) => `${value.toFixed(1)} MiB`)}
        explanation={t("Heap 使用当前窗口的局部 MiB 量程，避免 24 GiB 上限吞掉细微变化。")}
      >
        <ChartContainer
          config={chartConfig}
          className="h-28 w-full min-w-0 aspect-auto"
          data-series="heap-used"
        >
          <LineChart
            accessibilityLayer
            data={data}
            syncId={CHART_SYNC_ID}
            margin={{ top: 10, right: 12, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} />
            <TimeAxis hidden />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              width={54}
              domain={heapDomain}
              tickFormatter={(value: number) => value.toFixed(1)}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)" }}
              content={
                <MetricTooltipContent
                  label={t("Heap used")}
                  formatValue={(value) => `${value.toFixed(1)} MiB`}
                />
              }
            />
            <Line
              dataKey="heapUsedMiB"
              type="linear"
              stroke="var(--color-heapUsedMiB)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      </SignalLane>

      <SignalLane
        label="GC pause"
        value={
          latest?.gcTimeDeltaMillis === null || latest === null
            ? t("不可用")
            : `${latest.gcTimeDeltaMillis} ms`
        }
        detail={formatDomain(gcDomain, (value) => `${value.toFixed(0)} ms`)}
        explanation={t("GC 是离散停顿事件，因此使用毫秒柱而不是连续折线。")}
      >
        <ChartContainer
          config={chartConfig}
          className="h-24 w-full min-w-0 aspect-auto"
          data-series="gc-pause"
        >
          <BarChart
            accessibilityLayer
            data={data}
            syncId={CHART_SYNC_ID}
            margin={{ top: 10, right: 12, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} />
            <TimeAxis hidden />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              width={54}
              domain={gcDomain}
              tickFormatter={(value: number) =>
                String(Number(value.toFixed(1)))
              }
            />
            <ChartTooltip
              cursor={{ fill: "var(--muted)", opacity: 0.25 }}
              content={
                <MetricTooltipContent
                  label={t("GC pause")}
                  formatValue={(value) => `${value.toFixed(0)} ms`}
                />
              }
            />
            <Bar
              dataKey="gcTimeDeltaMillis"
              fill="var(--color-gcTimeDeltaMillis)"
              radius={[3, 3, 0, 0]}
              maxBarSize={10}
              isAnimationActive={false}
            />
          </BarChart>
        </ChartContainer>
      </SignalLane>

      <SignalLane
        label="Live threads"
        value={latest === null ? t("不可用") : String(latest.liveThreads)}
        detail={formatDomain(threadDomain, (value) => value.toFixed(0))}
        explanation={t("线程使用独立整数范围，并与其他信号共享悬停时间游标。")}
      >
        <ChartContainer
          config={chartConfig}
          className="h-32 w-full min-w-0 aspect-auto"
          data-series="live-threads"
        >
          <LineChart
            accessibilityLayer
            data={data}
            syncId={CHART_SYNC_ID}
            margin={{ top: 10, right: 12, bottom: 6, left: 0 }}
          >
            <CartesianGrid vertical={false} />
            <TimeAxis />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              width={54}
              domain={threadDomain}
              allowDecimals={false}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)" }}
              content={
                <MetricTooltipContent
                  label={t("Live threads")}
                  formatValue={(value) => value.toFixed(0)}
                />
              }
            />
            <Line
              dataKey="liveThreads"
              type="stepAfter"
              stroke="var(--color-liveThreads)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      </SignalLane>
    </figure>
  );
}

interface SignalLaneProps {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly explanation: string;
  readonly children: ReactNode;
}

function SignalLane({
  label,
  value,
  detail,
  explanation,
  children,
}: SignalLaneProps) {
  return (
    <div className="grid min-w-0 border-b last:border-b-0 md:grid-cols-[12rem_minmax(0,1fr)]">
      <div className="flex min-w-0 items-start justify-between gap-3 border-b p-4 md:border-r md:border-b-0">
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          <div className="mt-2 truncate font-mono text-lg font-semibold tabular-nums">
            {value}
          </div>
          <div className="text-muted-foreground mt-1 whitespace-nowrap text-xs">
            {detail}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("说明 {label} 的图表量程", { label })}
            >
              <Info aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-64">
            {explanation}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="min-w-0 px-3">{children}</div>
    </div>
  );
}

function TimeAxis({ hidden = false }: { readonly hidden?: boolean }) {
  return (
    <XAxis
      dataKey="endedAtEpochMillis"
      type="number"
      scale="time"
      domain={["dataMin", "dataMax"]}
      axisLine={false}
      tickLine={false}
      tickMargin={8}
      minTickGap={48}
      hide={hidden}
      tickFormatter={(value: number) => formatClockTime(value, false)}
    />
  );
}

interface MetricTooltipContentProps {
  readonly label: string;
  readonly formatValue: (value: number) => string;
}

function MetricTooltipContent({
  label,
  formatValue,
}: MetricTooltipContentProps) {
  return (
    <ChartTooltipContent
      indicator="line"
      labelFormatter={(_, payload) => {
        const value = payload.at(0)?.payload as RuntimeChartDatum | undefined;
        return value
          ? formatClockTime(value.endedAtEpochMillis, true)
          : t("未知时间");
      }}
      formatter={(value) => (
        <div className="flex min-w-40 items-center justify-between gap-4">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-mono font-medium tabular-nums">
            {formatTooltipValue(value, formatValue)}
          </span>
        </div>
      )}
    />
  );
}

interface IntervalInspectorProps {
  readonly intervals: readonly RuntimeIntervalEvidence[];
  readonly summary: RuntimeCorrelationSummary;
}

function IntervalInspector({ intervals, summary }: IntervalInspectorProps) {
  const inspected = intervals.slice(-MAXIMUM_INSPECTED_INTERVALS).reverse();
  return (
    <section className="min-w-0">
      <header className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-medium">{t("区间证据")}</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("逐区间核对共同信号，不推断因果。")}
          </p>
        </div>
        <Badge variant="secondary">
          {t("GC 合计 {value} ms", {
            value: summary.totalGcTimeDeltaMillis,
          })}
        </Badge>
      </header>
      <ScrollArea className="h-[32rem]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">{t("区间")}</TableHead>
              <TableHead>{t("证据")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inspected.map((interval) => (
              <TableRow key={interval.endedAtEpochMillis}>
                <TableCell className="align-top">
                  <div className="flex items-center gap-2 font-medium">
                    <Clock3 aria-hidden="true" className="size-3.5" />
                    <span className="font-mono text-xs tabular-nums">
                      {formatClockTime(interval.endedAtEpochMillis, false)}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-1 text-xs">
                    {(interval.durationMillis / 1_000).toFixed(1)} s
                  </div>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div className="text-muted-foreground grid gap-1 text-xs">
                    <span>CPU {formatPercent(interval.processCpuLoad)}</span>
                    <span>
                      Heap {formatSignedBytes(interval.heapDeltaBytes)}
                    </span>
                    <span>
                      GC{" "}
                      {interval.gcTimeDeltaMillis === null
                        ? t("不可用")
                        : `${interval.gcTimeDeltaMillis} ms`}
                    </span>
                  </div>
                  <Separator className="my-2" />
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant={assessmentBadgeVariant(interval.assessment)}>
                      {assessmentLabel(interval.assessment)}
                    </Badge>
                    {interval.signals.map((signal) => (
                      <Badge key={signal} variant="outline">
                        {correlationSignalLabel(signal)}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollArea>
    </section>
  );
}

function buildRuntimeChartData(
  intervals: readonly RuntimeIntervalEvidence[],
): RuntimeChartDatum[] {
  return intervals.map((interval) => ({
    endedAtEpochMillis: interval.endedAtEpochMillis,
    processCpuPercent:
      interval.processCpuLoad === null ? null : interval.processCpuLoad * 100,
    heapUsedMiB: interval.heapUsedBytes / MEBIBYTE,
    gcTimeDeltaMillis: interval.gcTimeDeltaMillis,
    liveThreads: interval.liveThreads,
  }));
}

function finiteValues(values: readonly (number | null)[]): number[] {
  return values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
}

function zeroBasedDomain(
  values: readonly number[],
  minimumUpperBound: number,
): [number, number] {
  const maximum = values.length === 0 ? 0 : Math.max(...values);
  return [0, Math.max(minimumUpperBound, maximum * 1.2)];
}

function paddedDomain(
  values: readonly number[],
  minimumPadding: number,
): [number, number] {
  if (values.length === 0) {
    return [0, minimumPadding * 2];
  }
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding = Math.max((maximum - minimum) * 0.15, minimumPadding);
  return [minimum - padding, maximum + padding];
}

function integerDomain(values: readonly number[]): [number, number] {
  if (values.length === 0) {
    return [0, 1];
  }
  return [Math.floor(Math.min(...values) - 1), Math.ceil(Math.max(...values) + 1)];
}

function formatDomain(
  domain: readonly [number, number],
  formatter: (value: number) => string,
): string {
  return `${formatter(domain[0])}–${formatter(domain[1])}`;
}

function formatTooltipValue(
  value: unknown,
  formatter: (value: number) => string,
): string {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? formatter(numeric) : t("不可用");
}

function compactPercent(value: number): string {
  return `${value < 1 ? value.toFixed(2) : value.toFixed(1)}%`;
}

function formatClockTime(epochMillis: number, includeSeconds: boolean): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  }).format(new Date(epochMillis));
}

function assessmentBadgeVariant(
  assessment: RuntimeIntervalAssessment,
): "destructive" | "secondary" | "outline" {
  switch (assessment) {
    case "PRESSURE":
      return "destructive";
    case "NOTICE":
      return "secondary";
    case "STABLE":
      return "outline";
  }
}

function assessmentLabel(assessment: RuntimeIntervalAssessment): string {
  switch (assessment) {
    case "PRESSURE":
      return t("压力");
    case "NOTICE":
      return t("关注");
    case "STABLE":
      return t("稳定");
  }
}

function correlationSignalLabel(signal: RuntimeIntervalSignal): string {
  switch (signal) {
    case "GC_ACTIVITY":
      return t("GC 活动");
    case "GC_PRESSURE":
      return t("GC 时间占比");
    case "CPU_PRESSURE":
      return t("CPU 压力");
    case "HEAP_GROWTH":
      return t("Heap 增长");
    case "THREAD_SURGE":
      return t("线程增长");
  }
}

function formatPercent(value: number | null): string {
  return value === null ? t("未知") : `${(value * 100).toFixed(1)}%`;
}

function formatPercentFromPercentage(value: number | null): string {
  return value === null ? t("未知") : `${value.toFixed(2)}%`;
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatSignedBytes(value: number): string {
  if (value === 0) {
    return "0 B";
  }
  return `${value > 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`;
}

function formatSignedInteger(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}
