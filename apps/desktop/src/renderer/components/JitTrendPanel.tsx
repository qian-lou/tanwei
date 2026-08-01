import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { ArtifactDescriptor, JitTrendRecording } from "@shared/contracts";
import {
  buildJitTrendRecording,
  jitCodeCachePressure,
  type JitCompilerSnapshot,
} from "../jit-compiler";
import { t } from "../i18n";
import { useTargetsStore } from "../stores/targets";
import StatusPill from "./StatusPill";
import { Checkbox } from "./ui/checkbox";
import "./JitTrendPanel.css";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";

interface JitTrendPanelProps {
  readonly targetId: string | null;
  readonly samples: readonly JitCompilerSnapshot[];
  readonly samplingIntervalMillis: JitTrendRecording["samplingIntervalMillis"];
}

function formatBytes(value: number): string {
  if (value >= 1_048_576) {
    return `${(value / 1_048_576).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })} MiB`;
  }
  if (value >= 1_024) {
    return `${(value / 1_024).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })} KiB`;
  }
  return `${value.toLocaleString()} B`;
}

function pressureLabel(
  pressure: ReturnType<typeof jitCodeCachePressure>,
): string {
  switch (pressure.state) {
    case "EXHAUSTED":
      return pressure.capacityKind === "MAX"
        ? t("最大容量已耗尽")
        : t("已提交容量已用尽");
    case "HIGH":
      return t("高压力");
    case "ELEVATED":
      return t("压力升高");
    case "NORMAL":
    default:
      return t("容量正常");
  }
}

export default function JitTrendPanel({
  targetId,
  samples,
  samplingIntervalMillis,
}: JitTrendPanelProps) {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [savedArtifact, setSavedArtifact] = useState<ArtifactDescriptor | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const targetMainClass = useTargetsStore(
    (state) =>
      state.targets.find((target) => target.id === targetId)?.mainClass ?? "",
  );
  const [regressionEnabled, setRegressionEnabled] = useState(false);
  const [workloadKey, setWorkloadKey] = useState("");
  const [releaseLabel, setReleaseLabel] = useState("");
  const current = samples.at(-1) ?? null;
  let pressure: ReturnType<typeof jitCodeCachePressure> | null = null;
  if (current) {
    try {
      pressure = jitCodeCachePressure(current);
    } catch {
      pressure = null;
    }
  }

  useEffect(() => {
    setSaving(false);
    setSavedArtifact(null);
    setErrorMessage(null);
    setRegressionEnabled(false);
    setWorkloadKey(targetMainClass);
    setReleaseLabel("");
  }, [targetId, targetMainClass]);

  async function saveTrend(): Promise<void> {
    if (!targetId || samples.length < 2) {
      return;
    }
    const requestTargetId = targetId;
    setSaving(true);
    setErrorMessage(null);
    try {
      const snapshot = await window.tanwei.getSnapshot(requestTargetId);
      if (
        !snapshot.ok ||
        !snapshot.value ||
        useTargetsStore.getState().selectedTargetId !== requestTargetId
      ) {
        setErrorMessage(
          snapshot.errorMessage ?? t("无法核对 JIT 趋势所属 JVM"),
        );
        return;
      }
      const recording = buildJitTrendRecording(
        samples,
        requestTargetId,
        snapshot.value.jvmStartTimeEpochMillis,
        samplingIntervalMillis,
      );
      if (!recording) {
        setErrorMessage(t("至少需要两个同 JVM 周期的有效 JIT 样本"));
        return;
      }
      const result = await window.tanwei.createJitTrendArtifact({
        recording,
        regressionLabel: regressionEnabled
          ? {
              workloadKey: workloadKey.trim(),
              releaseLabel: releaseLabel.trim(),
            }
          : null,
      });
      if (useTargetsStore.getState().selectedTargetId !== requestTargetId) {
        return;
      }
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法保存 JIT 趋势制品"));
        return;
      }
      setSavedArtifact(result.value);
    } catch (error) {
      if (useTargetsStore.getState().selectedTargetId === requestTargetId) {
        setErrorMessage(
          error instanceof Error ? error.message : t("无法保存 JIT 趋势制品"),
        );
      }
    } finally {
      if (useTargetsStore.getState().selectedTargetId === requestTargetId) {
        setSaving(false);
      }
    }
  }

  return (
    <section
      className="jit-trend-panel"
      aria-label={t("JIT 趋势基线与容量告警")}
    >
      <header className="jit-trend-panel__header">
        <div>
          <p className="eyebrow">CODE CACHE PRESSURE / VERIFIED BASELINE</p>
          <h3>{t("把短时波动保存成可比较基线。")}</h3>
          <p>
            {t(
              "保存当前最多 120 个样本；Host 会复验 JVM 周期、时间顺序、单调计数器、大小与 SHA-256。",
            )}
          </p>
        </div>
        <StatusPill
          state={
            !pressure
              ? "idle"
              : pressure.state === "NORMAL"
                ? "ready"
                : pressure.state === "ELEVATED"
                  ? "working"
                  : "error"
          }
          label={pressure ? pressureLabel(pressure) : t("等待容量快照")}
        />
      </header>

      {pressure && current ? (
        <>
          <dl className="jit-trend-panel__metrics">
            <div>
              <dt>{t("当前使用")}</dt>
              <dd>{formatBytes(current.codeCache.totalUsedBytes)}</dd>
            </div>
            <div>
              <dt>
                {pressure.capacityKind === "MAX"
                  ? t("最大容量")
                  : t("已提交容量")}
              </dt>
              <dd>{formatBytes(pressure.capacityBytes)}</dd>
            </div>
            <div>
              <dt>{t("剩余容量")}</dt>
              <dd>
                {formatBytes(
                  Math.max(
                    0,
                    pressure.capacityBytes - current.codeCache.totalUsedBytes,
                  ),
                )}
              </dd>
            </div>
            <div>
              <dt>{t("使用率")}</dt>
              <dd>{pressure.percent.toFixed(1)}%</dd>
            </div>
          </dl>
          <div
            className="jit-trend-panel__track"
            role="meter"
            aria-label={t("Code Cache 使用率")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, pressure.percent)}
          >
            <span
              style={{ inlineSize: `${Math.min(100, pressure.percent)}%` }}
            />
          </div>
          <p className="jit-trend-panel__thresholds">
            {pressure.capacityKind === "MAX"
              ? t("按最大容量判断：80% 压力升高，90% 高压力，100% 已耗尽。")
              : t(
                  "JVM 未公开完整最大值，当前按已提交容量判断；JVM 仍可能继续扩展 Code Cache。",
                )}
          </p>
        </>
      ) : (
        <p className="jit-trend-panel__empty">
          {t("刷新编译器快照后计算 Code Cache 压力。")}
        </p>
      )}

      <section className="jit-trend-panel__regression">
        <div className="jit-trend-panel__regression-toggle">
          <Checkbox
            id="jit-regression-baseline"
            checked={regressionEnabled}
            onCheckedChange={(checked) => {
              setRegressionEnabled(checked === true);
              setSavedArtifact(null);
              setErrorMessage(null);
            }}
          />
          <Label htmlFor="jit-regression-baseline">
            <strong>{t("加入跨版本回归基线")}</strong>
            <span>
              {t("Host 将核对主类、JDK 与 JIT 编译器后写入可移植 v2 身份。")}
            </span>
          </Label>
        </div>
        {regressionEnabled && (
          <div className="jit-trend-panel__regression-fields">
            <Label>
              <span>{t("工作负载键")}</span>
              <Input
                value={workloadKey}
                maxLength={128}
                placeholder={t("例如 checkout-steady-100rps")}
                onChange={(event) => {
                  setWorkloadKey(event.target.value);
                  setSavedArtifact(null);
                }}
              />
            </Label>
            <Label>
              <span>{t("发布标签")}</span>
              <Input
                value={releaseLabel}
                maxLength={128}
                placeholder={t("例如 2026.07.2")}
                onChange={(event) => {
                  setReleaseLabel(event.target.value);
                  setSavedArtifact(null);
                }}
              />
            </Label>
          </div>
        )}
      </section>

      <div className="jit-trend-panel__actions">
        <Button
          type="button"
          variant="secondary"
          disabled={
            Boolean(
              !targetId ||
                samples.length < 2 ||
                saving ||
                (regressionEnabled &&
                  (!workloadKey.trim() || !releaseLabel.trim())),
            ) || Boolean(saving)
          }
          onClick={() => void saveTrend()}
          aria-busy={Boolean(saving)}
        >
          {Boolean(saving) && <Spinner />}
          {t("保存 JIT 趋势制品")}
        </Button>
        <span>{t("当前 {count} / 120 个样本", { count: samples.length })}</span>
        {savedArtifact && (
          <>
            <strong>{savedArtifact.name}</strong>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void navigate({
                  pathname: "/artifacts",
                  search: `?inspect=${encodeURIComponent(savedArtifact.id)}`,
                })
              }
            >
              {t("检查并对比基线")}
            </Button>
          </>
        )}
      </div>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertTitle>{t("JIT 趋势保存失败")}</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
