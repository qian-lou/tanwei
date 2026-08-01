import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { JitTrendRecording } from "@shared/contracts";
import JitEvidencePanel from "../components/JitEvidencePanel";
import JitTrendPanel from "../components/JitTrendPanel";
import RiskPill from "../components/RiskPill";
import StatePagination from "../components/StatePagination";
import StatusPill from "../components/StatusPill";
import { t, useLocale } from "../i18n";
import {
  appendJitCompilerSample,
  MAXIMUM_JIT_TREND_SAMPLES,
  parseJitCompilerSnapshot,
  summarizeJitCompilerTrend,
  type JitCompilerSnapshot,
} from "../jit-compiler";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./PerfCountersView.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";

type CounterNamespace = "ALL" | "JAVA" | "SUN" | "JDK" | "OTHER";
type CounterCategory = Exclude<CounterNamespace, "ALL">;

interface PerfCounter {
  readonly name: string;
  readonly category: CounterCategory;
  readonly units: string;
  readonly variability: string;
  readonly value: string;
  readonly valueType: string;
  readonly internal: boolean;
  readonly vectorLength: number;
}

interface CounterTrendSample {
  readonly sampledAtEpochMillis: number;
  readonly values: Readonly<Record<string, number>>;
}

interface CounterTrendRow {
  readonly counter: PerfCounter;
  readonly current: number | null;
  readonly delta: number | null;
  readonly ratePerSecond: number | null;
  readonly points: readonly number[];
}

const PAGE_SIZE = 50;
const MAXIMUM_TRACKED_COUNTERS = 8;
const MAXIMUM_TREND_SAMPLES = 120;
const CATEGORIES = ["JAVA", "SUN", "JDK", "OTHER"] as const;

function parseSafeNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function numericCounterValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (
    !Number.isFinite(parsed) ||
    (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))
  ) {
    return null;
  }
  return parsed;
}

function formatCounterNumber(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 3,
  });
}

function formatCounterDelta(value: number | null): string {
  if (value === null) {
    return "—";
  }
  const formatted = formatCounterNumber(Math.abs(value));
  return value > 0 ? `+${formatted}` : value < 0 ? `−${formatted}` : "0";
}

function formatBytes(value: number | null): string {
  if (value === null) {
    return "—";
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })} MiB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })} KiB`;
  }
  return `${value.toLocaleString()} B`;
}

function formatRate(value: number | null): string {
  return value === null
    ? "—"
    : value.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      });
}

function trendPath(points: readonly number[]): string {
  if (points.length === 0) {
    return "";
  }
  const minimum = Math.min(...points);
  const maximum = Math.max(...points);
  const range = Math.max(maximum - minimum, 1);
  const denominator = Math.max(points.length - 1, 1);
  return points
    .map((point, index) => {
      const x = (index / denominator) * 400;
      const y = 64 - ((point - minimum) / range) * 56;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function isCounterCategory(
  value: string | undefined,
): value is CounterCategory {
  return (
    value === "JAVA" || value === "SUN" || value === "JDK" || value === "OTHER"
  );
}

function parseCounters(
  values: Readonly<Record<string, string>>,
): readonly PerfCounter[] {
  const count = Math.min(parseSafeNumber(values.count), PAGE_SIZE);
  return Array.from({ length: count }, (_, index): PerfCounter | null => {
    const prefix = `counter.${String(index).padStart(4, "0")}.`;
    const name = values[`${prefix}name`] ?? "";
    const category = values[`${prefix}category`];
    if (!name || !isCounterCategory(category)) {
      return null;
    }
    return {
      name,
      category,
      units: values[`${prefix}units`] ?? "unknown",
      variability: values[`${prefix}variability`] ?? "unknown",
      value: values[`${prefix}value`] ?? "",
      valueType: values[`${prefix}valueType`] ?? "unknown",
      internal: values[`${prefix}internal`] === "true",
      vectorLength: parseSafeNumber(values[`${prefix}vectorLength`]),
    };
  }).filter((counter): counter is PerfCounter => counter !== null);
}

export default function PerfCountersView() {
  useLocale();
  const navigate = useNavigate();
  const selectedTargetId = useTargetsStore((state) => state.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const connectionState = connection?.state;
  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState<CounterNamespace>("ALL");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [counters, setCounters] = useState<readonly PerfCounter[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [sampledAtEpochMillis, setSampledAtEpochMillis] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [trackedCounterNames, setTrackedCounterNames] = useState<
    readonly string[]
  >([]);
  const [trackedCounterMetadata, setTrackedCounterMetadata] = useState<
    Readonly<Record<string, PerfCounter>>
  >({});
  const [trendSamples, setTrendSamples] = useState<
    readonly CounterTrendSample[]
  >([]);
  const [samplingIntervalMillis, setSamplingIntervalMillis] = useState(2_000);
  const [sampling, setSampling] = useState(false);
  const [samplingLoading, setSamplingLoading] = useState(false);
  const [samplingErrorMessage, setSamplingErrorMessage] = useState<
    string | null
  >(null);
  const [lastSampleScannedCounters, setLastSampleScannedCounters] = useState(0);
  const [lastSampleMissingCounters, setLastSampleMissingCounters] = useState(0);
  const [lastSampleTruncated, setLastSampleTruncated] = useState(false);
  const [jitSamples, setJitSamples] = useState<readonly JitCompilerSnapshot[]>(
    [],
  );
  const [jitLoading, setJitLoading] = useState(false);
  const [jitSampling, setJitSampling] = useState(false);
  const [jitSamplingIntervalMillis, setJitSamplingIntervalMillis] =
    useState<JitTrendRecording["samplingIntervalMillis"]>(2_000);
  const [jitErrorMessage, setJitErrorMessage] = useState<string | null>(null);
  const [categoryCounts, setCategoryCounts] = useState<
    Readonly<Record<CounterCategory, number>>
  >({
    JAVA: 0,
    SUN: 0,
    JDK: 0,
    OTHER: 0,
  });
  const samplingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jitSamplingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const jitRequestSequenceRef = useRef(0);
  const samplingRef = useRef(sampling);
  const samplingLoadingRef = useRef(samplingLoading);
  const samplingIntervalMillisRef = useRef(samplingIntervalMillis);
  const trackedCounterNamesRef = useRef(trackedCounterNames);
  const jitSamplingRef = useRef(jitSampling);
  const jitLoadingRef = useRef(jitLoading);
  const jitSamplingIntervalMillisRef = useRef(jitSamplingIntervalMillis);
  samplingRef.current = sampling;
  samplingLoadingRef.current = samplingLoading;
  samplingIntervalMillisRef.current = samplingIntervalMillis;
  trackedCounterNamesRef.current = trackedCounterNames;
  jitSamplingRef.current = jitSampling;
  jitLoadingRef.current = jitLoading;
  jitSamplingIntervalMillisRef.current = jitSamplingIntervalMillis;

  const counterCapability = connection?.capabilities.find(
    (capability) => capability.id === "perfcounters",
  );
  const jfrCapability = connection?.capabilities.find(
    (capability) => capability.id === "jfr",
  );
  const selectedCounter =
    counters.find((counter) => counter.name === selectedName) ?? null;
  const sampledAtLabel =
    sampledAtEpochMillis <= 0
      ? t("尚未采样")
      : new Date(sampledAtEpochMillis).toLocaleString();
  const selectedCounterTrackable =
    selectedCounter !== null &&
    numericCounterValue(selectedCounter.value) !== null &&
    selectedCounter.valueType !== "masked" &&
    selectedCounter.vectorLength === 0;
  const selectedCounterTracked =
    selectedCounter !== null &&
    trackedCounterNames.includes(selectedCounter.name);
  const latestTrendSample = trendSamples[trendSamples.length - 1] ?? null;
  const counterTrendRows: readonly CounterTrendRow[] =
    trackedCounterNames.flatMap((name) => {
      const counter = trackedCounterMetadata[name];
      if (!counter) {
        return [];
      }
      const samples = trendSamples
        .map((sample) => {
          const value = sample.values[name];
          return value === undefined
            ? null
            : {
                sampledAtEpochMillis: sample.sampledAtEpochMillis,
                value,
              };
        })
        .filter(
          (
            sample,
          ): sample is {
            readonly sampledAtEpochMillis: number;
            readonly value: number;
          } => sample !== null,
        );
      const current = samples[samples.length - 1] ?? null;
      const previous = samples[samples.length - 2] ?? null;
      const delta = current && previous ? current.value - previous.value : null;
      const elapsedSeconds =
        current && previous
          ? (current.sampledAtEpochMillis - previous.sampledAtEpochMillis) /
            1_000
          : 0;
      const monotonic = counter.variability
        .toLocaleLowerCase()
        .includes("monotonic");
      return [
        {
          counter,
          current: current?.value ?? null,
          delta,
          ratePerSecond:
            monotonic && delta !== null && elapsedSeconds > 0
              ? delta / elapsedSeconds
              : null,
          points: samples.map((sample) => sample.value),
        },
      ];
    });
  const jitSummary = summarizeJitCompilerTrend(jitSamples);
  const jitCodeCachePercent = (() => {
    const snapshot = jitSummary.current;
    if (!snapshot) {
      return 0;
    }
    const boundary =
      snapshot.codeCache.totalMaxComplete &&
      snapshot.codeCache.totalMaxBytes !== null
        ? snapshot.codeCache.totalMaxBytes
        : snapshot.codeCache.totalCommittedBytes;
    if (boundary <= 0) {
      return 0;
    }
    return Math.min(
      100,
      Math.max(0, (snapshot.codeCache.totalUsedBytes / boundary) * 100),
    );
  })();
  const jitEvents = (() => {
    const last = jitSummary.current?.last;
    if (!last) {
      return [];
    }
    return [
      {
        id: "success",
        eyebrow: "LAST COMPILED",
        label: t("最近成功编译"),
        event: last.success,
      },
      {
        id: "failed",
        eyebrow: "LAST FAILED",
        label: t("最近编译失败"),
        event: last.failed,
      },
      {
        id: "invalidated",
        eyebrow: "LAST INVALIDATED",
        label: t("最近失效编译"),
        event: last.invalidated,
      },
    ] as const;
  })();

  async function loadCounters(nextOffset = 0): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentConnection = selectConnection(targetsState);
    const capability = currentConnection?.capabilities.find(
      (item) => item.id === "perfcounters",
    );
    if (
      !targetsState.selectedTargetId ||
      currentConnection?.state !== "READY" ||
      capability?.state !== "AVAILABLE"
    ) {
      setCounters([]);
      setTotal(0);
      setSelectedName(null);
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "perfcounter.list",
        parameters: {
          query: query.trim(),
          namespace,
          offset: String(Math.max(0, nextOffset)),
          limit: String(PAGE_SIZE),
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取 JVM 内部计数器"),
        );
        return;
      }

      const values = response.value.values;
      const nextCounters = parseCounters(values);
      setOffset(parseSafeNumber(values.offset));
      setTotal(parseSafeNumber(values.total));
      setSampledAtEpochMillis(parseSafeNumber(values.sampledAtEpochMillis));
      setTruncated(values.truncated === "true");
      setCategoryCounts({
        JAVA: parseSafeNumber(values["category.JAVA"]),
        SUN: parseSafeNumber(values["category.SUN"]),
        JDK: parseSafeNumber(values["category.JDK"]),
        OTHER: parseSafeNumber(values["category.OTHER"]),
      });
      setCounters(nextCounters);
      setSelectedName(
        (previous) =>
          nextCounters.find((counter) => counter.name === previous)?.name ??
          nextCounters[0]?.name ??
          null,
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取 JVM 内部计数器"),
      );
    } finally {
      setLoading(false);
    }
  }

  function clearSamplingTimer(): void {
    if (samplingTimerRef.current !== null) {
      clearTimeout(samplingTimerRef.current);
      samplingTimerRef.current = null;
    }
  }

  function stopCounterSampling(): void {
    samplingRef.current = false;
    setSampling(false);
    clearSamplingTimer();
  }

  function clearJitSamplingTimer(): void {
    if (jitSamplingTimerRef.current !== null) {
      clearTimeout(jitSamplingTimerRef.current);
      jitSamplingTimerRef.current = null;
    }
  }

  function stopJitSampling(): void {
    jitSamplingRef.current = false;
    setJitSampling(false);
    clearJitSamplingTimer();
  }

  function scheduleJitSample(): void {
    clearJitSamplingTimer();
    if (!jitSamplingRef.current) {
      return;
    }
    jitSamplingTimerRef.current = setTimeout(() => {
      jitSamplingTimerRef.current = null;
      void collectJitCompilerSample();
    }, jitSamplingIntervalMillisRef.current);
  }

  function resetJitCompiler(): void {
    stopJitSampling();
    jitRequestSequenceRef.current += 1;
    setJitSamples([]);
    setJitErrorMessage(null);
    setJitLoading(false);
  }

  async function collectJitCompilerSample(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const targetId = targetsState.selectedTargetId;
    if (
      !targetId ||
      selectConnection(targetsState)?.state !== "READY" ||
      jitLoadingRef.current
    ) {
      if (jitSamplingRef.current) {
        scheduleJitSample();
      }
      return;
    }
    jitRequestSequenceRef.current += 1;
    const requestSequence = jitRequestSequenceRef.current;
    jitLoadingRef.current = true;
    setJitLoading(true);
    setJitErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "jit.compiler.summary",
        parameters: {},
      });
      if (requestSequence !== jitRequestSequenceRef.current) {
        return;
      }
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setJitErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取 JIT 编译器状态"),
        );
        return;
      }
      const sample = parseJitCompilerSnapshot(response.value.values);
      const freshState = useTargetsStore.getState();
      if (
        freshState.selectedTargetId !== targetId ||
        selectConnection(freshState)?.state !== "READY" ||
        requestSequence !== jitRequestSequenceRef.current
      ) {
        return;
      }
      setJitSamples((previous) => appendJitCompilerSample(previous, sample));
    } catch (error) {
      if (requestSequence === jitRequestSequenceRef.current) {
        setJitErrorMessage(
          error instanceof Error ? error.message : t("无法读取 JIT 编译器状态"),
        );
      }
    } finally {
      if (requestSequence === jitRequestSequenceRef.current) {
        jitLoadingRef.current = false;
        setJitLoading(false);
        if (jitSamplingRef.current) {
          scheduleJitSample();
        }
      }
    }
  }

  async function startJitSampling(): Promise<void> {
    if (jitSamplingRef.current) {
      return;
    }
    setJitSamples([]);
    jitSamplingRef.current = true;
    setJitSampling(true);
    await collectJitCompilerSample();
  }

  function clearJitHistory(): void {
    setJitSamples([]);
    setJitErrorMessage(null);
  }

  function scheduleCounterSample(): void {
    clearSamplingTimer();
    if (!samplingRef.current || trackedCounterNamesRef.current.length === 0) {
      return;
    }
    samplingTimerRef.current = setTimeout(() => {
      samplingTimerRef.current = null;
      void collectCounterSample();
    }, samplingIntervalMillisRef.current);
  }

  function resetCounterTrends(): void {
    stopCounterSampling();
    trackedCounterNamesRef.current = [];
    setTrackedCounterNames([]);
    setTrackedCounterMetadata({});
    setTrendSamples([]);
    setSamplingErrorMessage(null);
    setLastSampleScannedCounters(0);
    setLastSampleMissingCounters(0);
    setLastSampleTruncated(false);
  }

  function toggleTrackedCounter(counter: PerfCounter): void {
    const existing = trackedCounterNames.includes(counter.name);
    if (existing) {
      const nextNames = trackedCounterNames.filter(
        (name) => name !== counter.name,
      );
      trackedCounterNamesRef.current = nextNames;
      setTrackedCounterNames(nextNames);
      const nextMetadata = { ...trackedCounterMetadata };
      delete nextMetadata[counter.name];
      setTrackedCounterMetadata(nextMetadata);
      if (nextNames.length === 0) {
        stopCounterSampling();
      }
      return;
    }
    if (
      trackedCounterNames.length >= MAXIMUM_TRACKED_COUNTERS ||
      numericCounterValue(counter.value) === null ||
      counter.valueType === "masked" ||
      counter.vectorLength !== 0
    ) {
      return;
    }
    const nextNames = [...trackedCounterNames, counter.name];
    trackedCounterNamesRef.current = nextNames;
    setTrackedCounterNames(nextNames);
    setTrackedCounterMetadata({
      ...trackedCounterMetadata,
      [counter.name]: counter,
    });
  }

  async function collectCounterSample(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const targetId = targetsState.selectedTargetId;
    const names = [...trackedCounterNamesRef.current];
    if (
      !targetId ||
      selectConnection(targetsState)?.state !== "READY" ||
      names.length === 0 ||
      names.length > MAXIMUM_TRACKED_COUNTERS ||
      samplingLoadingRef.current
    ) {
      if (samplingRef.current) {
        scheduleCounterSample();
      }
      return;
    }

    samplingLoadingRef.current = true;
    setSamplingLoading(true);
    setSamplingErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "perfcounter.snapshot",
        parameters: {
          names: names.join("\n"),
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setSamplingErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法采样固定计数器"),
        );
        return;
      }
      const freshState = useTargetsStore.getState();
      if (
        freshState.selectedTargetId !== targetId ||
        selectConnection(freshState)?.state !== "READY"
      ) {
        return;
      }

      const values = response.value.values;
      const requestedCount = parseSafeNumber(values.requestedCount);
      const missingCount = parseSafeNumber(values.missingCount);
      const sampledAt = parseSafeNumber(values.sampledAtEpochMillis);
      const sampledCounters = parseCounters(values);
      const uniqueNames = new Set(
        sampledCounters.map((counter) => counter.name),
      );
      if (
        requestedCount !== names.length ||
        sampledCounters.length + missingCount !== requestedCount ||
        uniqueNames.size !== sampledCounters.length ||
        sampledCounters.some((counter) => !names.includes(counter.name)) ||
        sampledAt <= 0
      ) {
        setSamplingErrorMessage(t("Agent返回了无效的 PerfCounter 快照"));
        return;
      }

      const metadataUpdates: PerfCounter[] = [];
      const sampleValues: Record<string, number> = {};
      for (const counter of sampledCounters) {
        if (!trackedCounterNamesRef.current.includes(counter.name)) {
          continue;
        }
        metadataUpdates.push(counter);
        const numeric = numericCounterValue(counter.value);
        if (numeric !== null) {
          sampleValues[counter.name] = numeric;
        }
      }
      setTrackedCounterMetadata((previous) => {
        const nextMetadata = { ...previous };
        for (const counter of metadataUpdates) {
          nextMetadata[counter.name] = counter;
        }
        return nextMetadata;
      });
      setCounters((previous) =>
        previous.map(
          (counter) =>
            sampledCounters.find((sampled) => sampled.name === counter.name) ??
            counter,
        ),
      );
      setSampledAtEpochMillis(sampledAt);
      setTrendSamples((previous) =>
        [
          ...previous,
          {
            sampledAtEpochMillis: sampledAt,
            values: sampleValues,
          },
        ].slice(-MAXIMUM_TREND_SAMPLES),
      );
      setLastSampleScannedCounters(parseSafeNumber(values.scannedCounters));
      setLastSampleMissingCounters(missingCount);
      setLastSampleTruncated(values.truncated === "true");
    } catch (error) {
      setSamplingErrorMessage(
        error instanceof Error ? error.message : t("无法采样固定计数器"),
      );
    } finally {
      samplingLoadingRef.current = false;
      setSamplingLoading(false);
      if (samplingRef.current) {
        scheduleCounterSample();
      }
    }
  }

  async function startCounterSampling(): Promise<void> {
    if (trackedCounterNamesRef.current.length === 0 || samplingRef.current) {
      return;
    }
    setTrendSamples([]);
    samplingRef.current = true;
    setSampling(true);
    await collectCounterSample();
  }

  function clearCounterTrendHistory(): void {
    setTrendSamples([]);
    setSamplingErrorMessage(null);
    setLastSampleScannedCounters(0);
    setLastSampleMissingCounters(0);
    setLastSampleTruncated(false);
  }

  function chooseNamespace(nextNamespace: CounterNamespace): void {
    if (namespace === nextNamespace) {
      void loadCounters(0);
      return;
    }
    setNamespace(nextNamespace);
  }

  const skipInitialTargetSync = useRef(true);
  useEffect(() => {
    if (skipInitialTargetSync.current) {
      skipInitialTargetSync.current = false;
      return;
    }
    resetCounterTrends();
    resetJitCompiler();
    setSelectedName(null);
    void Promise.all([loadCounters(0), collectJitCompilerSample()]);
  }, [selectedTargetId]);

  const skipInitialConnectionSync = useRef(true);
  useEffect(() => {
    if (skipInitialConnectionSync.current) {
      skipInitialConnectionSync.current = false;
      return;
    }
    if (connectionState !== "READY") {
      resetCounterTrends();
      resetJitCompiler();
    } else {
      void Promise.all([loadCounters(0), collectJitCompilerSample()]);
    }
  }, [connectionState]);

  const skipInitialNamespaceSync = useRef(true);
  useEffect(() => {
    if (skipInitialNamespaceSync.current) {
      skipInitialNamespaceSync.current = false;
      return;
    }
    setSelectedName(null);
    void loadCounters(0);
  }, [namespace]);

  const skipInitialSamplingIntervalSync = useRef(true);
  useEffect(() => {
    if (skipInitialSamplingIntervalSync.current) {
      skipInitialSamplingIntervalSync.current = false;
      return;
    }
    if (samplingRef.current) {
      scheduleCounterSample();
    }
  }, [samplingIntervalMillis]);

  const skipInitialJitIntervalSync = useRef(true);
  useEffect(() => {
    if (skipInitialJitIntervalSync.current) {
      skipInitialJitIntervalSync.current = false;
      return;
    }
    if (jitSamplingRef.current) {
      scheduleJitSample();
    }
  }, [jitSamplingIntervalMillis]);

  useEffect(() => {
    void Promise.all([loadCounters(0), collectJitCompilerSample()]);
    return () => {
      stopCounterSampling();
      stopJitSampling();
      jitRequestSequenceRef.current += 1;
    };
  }, []);

  return (
    <section className="page perfcounters-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">PERFCOUNTER INSPECTOR</p>
          <h1>{t("JVM 内部计数器，不再藏在命令行。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "搜索 HotSpot 暴露的类加载、编译器、GC 与运行时计数器；每次只读有界快照，不执行表达式，也不调用业务代码。",
          )}
        </p>
      </header>

      {connectionState !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">
            {t("连接目标后检查 JVM 内部计数器。")}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate("/targets")}
          >
            {t("选择目标")}
          </Button>
        </Empty>
      ) : counterCapability?.state !== "AVAILABLE" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">CAPABILITY UNAVAILABLE</p>
          <p className="empty-panel__title">
            {t("当前运行时不支持 PerfCounter 检查器。")}
          </p>
          <p>
            {counterCapability?.reason ?? t("请重新连接目标以加载最新 Agent。")}
          </p>
        </Empty>
      ) : (
        <>
          <section
            className="jit-compiler"
            aria-labelledby="jit-compiler-title"
          >
            <header className="jit-compiler__header">
              <div>
                <p className="eyebrow">JIT COMPILER INSPECTOR / R0</p>
                <h2 id="jit-compiler-title">
                  {t("看清 JIT 编译器正在做什么。")}
                </h2>
                <p>
                  {t(
                    "聚合 CompilationMXBean、Code Cache 与 HotSpot 编译计数器；只保留最近 120 个内存样本，不执行命令或业务代码。",
                  )}
                </p>
              </div>
              <StatusPill
                state={
                  jitErrorMessage
                    ? "error"
                    : jitSampling
                      ? "working"
                      : jitSummary.current
                        ? "ready"
                        : "idle"
                }
                label={
                  jitSampling
                    ? t("连续采样中")
                    : jitSummary.current?.compiler.name || t("等待编译器快照")
                }
              />
            </header>

            <div className="jit-compiler__toolbar">
              <Label>
                <span>{t("采样间隔")}</span>
                <SelectControl
                  value={jitSamplingIntervalMillis}
                  onValueChange={(value) =>
                    setJitSamplingIntervalMillis(
                      Number(
                        value,
                      ) as JitTrendRecording["samplingIntervalMillis"],
                    )
                  }
                  disabled={jitLoading}
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
              {!jitSampling ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={jitLoading}
                  onClick={() => void startJitSampling()}
                >
                  {t("开始 JIT 连续采样")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={stopJitSampling}
                >
                  {t("停止 JIT 连续采样")}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(jitLoading) || Boolean(jitLoading)}
                onClick={() => void collectJitCompilerSample()}
                aria-busy={Boolean(jitLoading)}
              >
                {Boolean(jitLoading) && <Spinner />}
                {t("刷新编译器快照")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={jitSamples.length === 0 || jitLoading}
                onClick={clearJitHistory}
              >
                {t("清空 JIT 历史")}
              </Button>
            </div>

            {jitErrorMessage && (
              <Alert variant="destructive">
                <AlertDescription>{t(jitErrorMessage)}</AlertDescription>
              </Alert>
            )}

            {jitSummary.current ? (
              <>
                <div className="jit-compiler__metrics">
                  <article>
                    <span>{t("累计编译")}</span>
                    <strong>
                      {formatCounterNumber(
                        jitSummary.current.metrics.totalCompiles,
                      )}
                    </strong>
                    <small>
                      {t("{rate} 次/秒", {
                        rate: formatRate(jitSummary.compilesPerSecond),
                      })}
                    </small>
                  </article>
                  <article>
                    <span>{t("标准 / OSR")}</span>
                    <strong>
                      {formatCounterNumber(
                        jitSummary.current.metrics.standardCompiles,
                      )}{" "}
                      /{" "}
                      {formatCounterNumber(
                        jitSummary.current.metrics.osrCompiles,
                      )}
                    </strong>
                    <small>{t("常规编译与栈上替换")}</small>
                  </article>
                  <article>
                    <span>{t("编译线程时间")}</span>
                    <strong>
                      {jitSummary.current.compiler.totalTimeMillis === null
                        ? "—"
                        : `${formatRate(jitSummary.current.compiler.totalTimeMillis)} ms`}
                    </strong>
                    <small>
                      {t("窗口占比 {percent}%", {
                        percent: formatRate(jitSummary.compilationTimePercent),
                      })}
                    </small>
                  </article>
                  <article>
                    <span>{t("失败 / 失效速率")}</span>
                    <strong>
                      {t("{rate} 次/秒", {
                        rate: formatRate(jitSummary.failuresPerSecond),
                      })}
                    </strong>
                    <small>
                      {formatCounterNumber(jitSummary.current.metrics.bailouts)}{" "}
                      /{" "}
                      {formatCounterNumber(
                        jitSummary.current.metrics.invalidations,
                      )}
                    </small>
                  </article>
                  <article>
                    <span>{t("代码缓存")}</span>
                    <strong>
                      {formatBytes(jitSummary.current.codeCache.totalUsedBytes)}
                    </strong>
                    <small>
                      {t("{percent}% 已使用", {
                        percent: formatRate(jitCodeCachePercent),
                      })}
                    </small>
                  </article>
                  <article>
                    <span>{t("样本窗口")}</span>
                    <strong>
                      {jitSamples.length}/{MAXIMUM_JIT_TREND_SAMPLES}
                    </strong>
                    <small>
                      {new Date(
                        jitSummary.current.sampledAtEpochMillis,
                      ).toLocaleTimeString()}
                    </small>
                  </article>
                </div>

                <div className="jit-compiler__trends">
                  <article>
                    <header>
                      <div>
                        <p className="eyebrow">COMPILE COUNT</p>
                        <strong>{t("累计编译趋势")}</strong>
                      </div>
                      <span>
                        {t("{count} 个样本", {
                          count: jitSummary.compilePoints.length,
                        })}
                      </span>
                    </header>
                    <svg
                      viewBox="0 0 400 72"
                      preserveAspectRatio="none"
                      role="img"
                      aria-label={t("JIT 累计编译趋势")}
                    >
                      <path
                        d={trendPath(jitSummary.compilePoints)}
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                  </article>
                  <article>
                    <header>
                      <div>
                        <p className="eyebrow">CODE CACHE</p>
                        <strong>{t("代码缓存使用趋势")}</strong>
                      </div>
                      <span>
                        {t("{rate}/秒", {
                          rate: formatBytes(
                            jitSummary.codeCacheGrowthBytesPerSecond,
                          ),
                        })}
                      </span>
                    </header>
                    <svg
                      viewBox="0 0 400 72"
                      preserveAspectRatio="none"
                      role="img"
                      aria-label={t("代码缓存使用趋势")}
                    >
                      <path
                        d={trendPath(jitSummary.codeCachePoints)}
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                  </article>
                </div>

                <section className="jit-code-cache">
                  <header>
                    <div>
                      <p className="eyebrow">SEGMENTED CODE CACHE</p>
                      <h3>{t("每个 Code Heap 都有独立边界。")}</h3>
                    </div>
                    <span>
                      {t("{count} 个内存池", {
                        count: jitSummary.current.codeCache.pools.length,
                      })}
                    </span>
                  </header>
                  {jitSummary.current.codeCache.pools.length ? (
                    <div className="jit-code-cache__pools">
                      {jitSummary.current.codeCache.pools.map((pool) => (
                        <article key={pool.name}>
                          <div>
                            <strong>{pool.name}</strong>
                            <span>
                              {formatBytes(pool.usedBytes)} /{" "}
                              {formatBytes(
                                pool.maxBytes ?? pool.committedBytes,
                              )}
                            </span>
                          </div>
                          <div
                            className="jit-code-cache__track"
                            aria-hidden="true"
                          >
                            <span
                              style={{
                                inlineSize: `${Math.min(
                                  100,
                                  (pool.usedBytes /
                                    Math.max(
                                      pool.maxBytes ?? pool.committedBytes,
                                      1,
                                    )) *
                                    100,
                                )}%`,
                              }}
                            />
                          </div>
                          <small>
                            {t("峰值 {peak} · 已提交 {committed}", {
                              peak: formatBytes(pool.peakUsedBytes),
                              committed: formatBytes(pool.committedBytes),
                            })}
                          </small>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p>{t("当前 JVM 没有公开 Code Cache 内存池。")}</p>
                  )}
                </section>

                <div className="jit-compiler__events">
                  {jitEvents.map((item) => (
                    <article key={item.id}>
                      <p className="eyebrow">{item.eyebrow}</p>
                      <strong>{item.label}</strong>
                      <code>
                        {item.event.method ?? t("暂无内部计数器证据")}
                      </code>
                      <span>
                        {t("类型 {type} · 大小 {size}", {
                          type: item.event.type ?? "—",
                          size: formatBytes(item.event.sizeBytes),
                        })}
                      </span>
                    </article>
                  ))}
                </div>

                {(!jitSummary.current.internal.available ||
                  jitSummary.current.internal.truncated ||
                  jitSummary.current.codeCache.truncated) && (
                  <div className="counter-boundary">
                    <strong>{t("JIT 快照为部分结果")}</strong>
                    <span>
                      {jitSummary.current.internal.reason ||
                        t(
                          "内部计数器或 Code Cache 内存池达到有界读取上限；MXBean 指标仍然有效。",
                        )}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="jit-compiler__empty">
                {jitLoading
                  ? t("正在聚合编译器、Code Cache 与内部计数器…")
                  : t("刷新后查看 JIT 编译器快照。")}
              </div>
            )}

            <JitTrendPanel
              targetId={selectedTargetId}
              samples={jitSamples}
              samplingIntervalMillis={jitSamplingIntervalMillis}
            />

            <JitEvidencePanel
              targetId={selectedTargetId}
              available={jfrCapability?.state === "AVAILABLE"}
              unavailableReason={jfrCapability?.reason ?? null}
            />
          </section>

          <form
            className="counter-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              void loadCounters(0);
            }}
          >
            <Label>
              <span>{t("命名空间")}</span>
              <SelectControl
                value={namespace}
                onValueChange={(value) =>
                  setNamespace(value as CounterNamespace)
                }
              >
                <SelectControlItem value="ALL">
                  {t("全部命名空间")}
                </SelectControlItem>
                <SelectControlItem value="JAVA">java.*</SelectControlItem>
                <SelectControlItem value="SUN">
                  sun.* / com.sun.*
                </SelectControlItem>
                <SelectControlItem value="JDK">jdk.*</SelectControlItem>
                <SelectControlItem value="OTHER">
                  {t("其他")}
                </SelectControlItem>
              </SelectControl>
            </Label>
            <Label>
              <span>{t("搜索计数器")}</span>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                type="search"
                maxLength={256}
                placeholder={t("例如 java.cls")}
              />
            </Label>
            <Button
              variant="secondary"
              type="submit"
              aria-busy={Boolean(loading)}
              disabled={Boolean(loading)}
            >
              {Boolean(loading) && <Spinner />}
              {t("刷新快照")}
            </Button>
          </form>

          <ToggleGroup
            className="counter-categories"
            type="single"
            value={namespace}
            variant="outline"
            aria-label={t("计数器分类")}
            onValueChange={(value) => {
              if (value) {
                chooseNamespace(value as CounterNamespace);
              }
            }}
          >
            <ToggleGroupItem
              value="ALL"
              aria-label={t("全部计数器")}
              onClick={() => {
                if (namespace === "ALL") {
                  void loadCounters(0);
                }
              }}
            >
              <span>{t("全部")}</span>
              <strong>
                {categoryCounts.JAVA +
                  categoryCounts.SUN +
                  categoryCounts.JDK +
                  categoryCounts.OTHER}
              </strong>
            </ToggleGroupItem>
            {CATEGORIES.map((category) => (
              <ToggleGroupItem
                key={category}
                value={category}
                aria-label={t("{category} 计数器", { category })}
                onClick={() => {
                  if (namespace === category) {
                    void loadCounters(0);
                  }
                }}
              >
                <span>{category}</span>
                <strong>{categoryCounts[category]}</strong>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          {truncated && (
            <div className="counter-boundary">
              <strong>{t("扫描已达到安全上限")}</strong>
              <span>
                {t("只检查前 20,000 个计数器；请缩小名称或命名空间范围。")}
              </span>
            </div>
          )}

          <div className="counter-inspector">
            <section
              className="counter-list"
              aria-label={t("PerfCounter 搜索结果")}
            >
              <header>
                <div>
                  <p className="eyebrow">COUNTER INDEX</p>
                  <strong>{t("{count} 个匹配", { count: total })}</strong>
                </div>
                <RiskPill level="R0" />
              </header>

              {counters.length ? (
                <div className="counter-list__items">
                  {counters.map((counter) => (
                    <Button
                      variant="ghost"
                      key={counter.name}
                      type="button"
                      className={
                        counter.name === selectedName
                          ? "counter-row counter-row--selected"
                          : "counter-row"
                      }
                      aria-current={
                        counter.name === selectedName ? "true" : undefined
                      }
                      onClick={() => setSelectedName(counter.name)}
                    >
                      <span>
                        <strong>{counter.name}</strong>
                        <small>{counter.value}</small>
                      </span>
                      <span>{counter.category}</span>
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="counter-list__empty">
                  {loading
                    ? t("正在读取 PerfCounter…")
                    : t("没有匹配的 PerfCounter。")}
                </div>
              )}

              <footer>
                <StatePagination
                  ariaLabel={t("PerfCounter 分页")}
                  previousLabel={t("上一页")}
                  nextLabel={t("下一页")}
                  previousDisabled={offset === 0 || loading}
                  nextDisabled={offset + counters.length >= total || loading}
                  onPrevious={() =>
                    void loadCounters(Math.max(0, offset - PAGE_SIZE))
                  }
                  onNext={() => void loadCounters(offset + PAGE_SIZE)}
                  summary={t("{start}–{end} / {total}", {
                    start: total === 0 ? 0 : offset + 1,
                    end: Math.min(offset + counters.length, total),
                    total,
                  })}
                />
              </footer>
            </section>

            <section className="counter-detail">
              {selectedCounter ? (
                <>
                  <header className="counter-detail__header">
                    <div>
                      <p className="eyebrow">{selectedCounter.category}</p>
                      <h2>{selectedCounter.name}</h2>
                      <p>{t("采样于 {time}", { time: sampledAtLabel })}</p>
                    </div>
                    <div className="counter-detail__actions">
                      <StatusPill
                        state={selectedCounter.internal ? "idle" : "ready"}
                        label={
                          selectedCounter.internal
                            ? t("JVM 内部")
                            : t("公开计数器")
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          !selectedCounterTracked && !selectedCounterTrackable
                        }
                        onClick={() => toggleTrackedCounter(selectedCounter)}
                      >
                        {selectedCounterTracked
                          ? t("取消固定")
                          : t("固定到趋势")}
                      </Button>
                    </div>
                  </header>

                  <section className="counter-value">
                    <p className="eyebrow">CURRENT VALUE</p>
                    <code>{selectedCounter.value}</code>
                    <p>
                      {selectedCounter.valueType === "masked"
                        ? t("敏感值已在 Agent 内读取前遮罩。")
                        : selectedCounterTracked
                          ? t("该计数器已固定到下方趋势工作区。")
                          : selectedCounterTrackable
                            ? t("固定后可进行有界连续采样与跨快照差异。")
                            : t("当前值不是可安全计算差异的标量数值。")}
                    </p>
                  </section>

                  <dl className="counter-facts">
                    <div>
                      <dt>{t("单位")}</dt>
                      <dd>{selectedCounter.units}</dd>
                    </div>
                    <div>
                      <dt>{t("变化语义")}</dt>
                      <dd>{selectedCounter.variability}</dd>
                    </div>
                    <div>
                      <dt>{t("值类型")}</dt>
                      <dd>{selectedCounter.valueType}</dd>
                    </div>
                    <div>
                      <dt>{t("向量长度")}</dt>
                      <dd>{selectedCounter.vectorLength}</dd>
                    </div>
                  </dl>

                  <section className="counter-explanation">
                    <div>
                      <p className="eyebrow">READ BOUNDARY</p>
                      <h3>{t("只观察 JVM 自己维护的计数器。")}</h3>
                    </div>
                    <p>
                      {t(
                        "不会执行 OGNL、脚本或任意命令；未知对象类型不会调用 toString，数组只展示前 64 项，单值最多 4,096 个字符。",
                      )}
                    </p>
                  </section>
                </>
              ) : (
                <div className="counter-detail__empty">
                  <p className="eyebrow">NO SELECTION</p>
                  <p>{t("选择一个计数器查看值与元数据。")}</p>
                </div>
              )}
            </section>
          </div>

          <section
            className="counter-trends"
            aria-labelledby="counter-trends-title"
          >
            <header className="counter-trends__header">
              <div>
                <p className="eyebrow">BOUNDED COUNTER TRENDS / R0</p>
                <h2 id="counter-trends-title">
                  {t("把内部计数器固定成时间序列。")}
                </h2>
                <p>
                  {t(
                    "一次读取最多 8 个精确名称，历史只保留最近 120 个内存样本；停止或离开页面会释放定时器。",
                  )}
                </p>
              </div>
              <StatusPill
                state={
                  sampling
                    ? "working"
                    : trackedCounterNames.length
                      ? "idle"
                      : "ready"
                }
                label={
                  sampling
                    ? t("连续采样中")
                    : t("{count} 个已固定", {
                        count: trackedCounterNames.length,
                      })
                }
              />
            </header>

            <div className="counter-trends__toolbar">
              <Label>
                <span>{t("采样间隔")}</span>
                <SelectControl
                  value={samplingIntervalMillis}
                  onValueChange={(value) =>
                    setSamplingIntervalMillis(Number(value))
                  }
                  disabled={samplingLoading}
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
              {!sampling ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={trackedCounterNames.length === 0 || samplingLoading}
                  onClick={() => void startCounterSampling()}
                >
                  {t("开始连续采样")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={stopCounterSampling}
                >
                  {t("停止连续采样")}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={
                  Boolean(
                    trackedCounterNames.length === 0 || samplingLoading,
                  ) || Boolean(samplingLoading)
                }
                onClick={() => void collectCounterSample()}
                aria-busy={Boolean(samplingLoading)}
              >
                {Boolean(samplingLoading) && <Spinner />}
                {t("立即采样")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={trendSamples.length === 0 || samplingLoading}
                onClick={clearCounterTrendHistory}
              >
                {t("清空历史")}
              </Button>
            </div>

            {samplingErrorMessage && (
              <Alert variant="destructive">
                <AlertDescription>{t(samplingErrorMessage)}</AlertDescription>
              </Alert>
            )}
            {(lastSampleTruncated || lastSampleMissingCounters > 0) && (
              <div className="counter-boundary">
                <strong>{t("快照未覆盖全部固定指标")}</strong>
                <span>
                  {t(
                    "缺失 {missing} 个指标，扫描 {scanned} 个计数器；边界截断 {truncated}。",
                    {
                      missing: lastSampleMissingCounters,
                      scanned: lastSampleScannedCounters,
                      truncated: lastSampleTruncated ? t("是") : t("否"),
                    },
                  )}
                </span>
              </div>
            )}

            {trackedCounterNames.length ? (
              <>
                <div className="counter-trends__metrics">
                  <div>
                    <span>{t("固定指标")}</span>
                    <strong>
                      {trackedCounterNames.length}/{MAXIMUM_TRACKED_COUNTERS}
                    </strong>
                  </div>
                  <div>
                    <span>{t("样本窗口")}</span>
                    <strong>
                      {trendSamples.length}/{MAXIMUM_TREND_SAMPLES}
                    </strong>
                  </div>
                  <div>
                    <span>{t("采样周期")}</span>
                    <strong>
                      {t("{seconds} 秒", {
                        seconds: samplingIntervalMillis / 1000,
                      })}
                    </strong>
                  </div>
                  <div>
                    <span>{t("最近采样")}</span>
                    <strong>
                      {latestTrendSample
                        ? new Date(
                            latestTrendSample.sampledAtEpochMillis,
                          ).toLocaleTimeString()
                        : t("尚未采样")}
                    </strong>
                  </div>
                </div>

                <div className="counter-trends__grid">
                  {counterTrendRows.map((row) => (
                    <article
                      key={row.counter.name}
                      className="counter-trend-card"
                      data-counter-name={row.counter.name}
                    >
                      <header>
                        <div>
                          <p className="eyebrow">{row.counter.category}</p>
                          <strong>{row.counter.name}</strong>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => toggleTrackedCounter(row.counter)}
                        >
                          {t("移除")}
                        </Button>
                      </header>
                      <dl>
                        <div>
                          <dt>{t("当前值")}</dt>
                          <dd>{formatCounterNumber(row.current)}</dd>
                        </div>
                        <div>
                          <dt>{t("相邻差异")}</dt>
                          <dd>{formatCounterDelta(row.delta)}</dd>
                        </div>
                        <div>
                          <dt>{t("每秒速率")}</dt>
                          <dd>{formatCounterDelta(row.ratePerSecond)}</dd>
                        </div>
                        <div>
                          <dt>{t("单位")}</dt>
                          <dd>{row.counter.units}</dd>
                        </div>
                      </dl>
                      <svg
                        viewBox="0 0 400 72"
                        preserveAspectRatio="none"
                        role="img"
                        aria-label={t("{name} 最近 {count} 个样本趋势", {
                          name: row.counter.name,
                          count: row.points.length,
                        })}
                      >
                        <path
                          d={trendPath(row.points)}
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                      <footer>
                        <span>
                          {t("{count} 个数值样本", {
                            count: row.points.length,
                          })}
                        </span>
                        <span>{row.counter.variability}</span>
                      </footer>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <div className="counter-trends__empty">
                <p className="eyebrow">NO TRACKED COUNTERS</p>
                <strong>{t("先从上方详情固定一个数值计数器。")}</strong>
                <p>
                  {t(
                    "向量、遮罩值、非数值和超出 JavaScript 安全整数范围的值不会进入趋势计算。",
                  )}
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
