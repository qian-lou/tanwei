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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type {
  ArtifactDescriptor,
  JfrInspectionReport,
} from "@shared/contracts";
import {
  parseAgentArtifactReference,
  selectLatestReadyJfrArtifact,
} from "../jit-evidence";
import { t } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import StatusPill from "./StatusPill";
import "./JitEvidencePanel.css";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface JitEvidencePanelProps {
  readonly targetId: string | null;
  readonly available: boolean;
  readonly unavailableReason?: string | null;
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

function formatDuration(value: number): string {
  if (value >= 1_000) {
    return `${(value / 1_000).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })} s`;
  }
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })} ms`;
}

function formatCompileLevel(value: number | null): string {
  return value === null ? t("层级未知") : t("Level {level}", { level: value });
}

function actionError(
  fallback: string,
  response: Awaited<ReturnType<typeof window.tanwei.executeAction>>,
): string | null {
  if (!response.ok || !response.value) {
    return response.errorMessage ?? fallback;
  }
  if (response.value.status !== "SUCCEEDED") {
    return response.value.message ?? fallback;
  }
  return null;
}

export default function JitEvidencePanel({
  targetId,
  available,
  unavailableReason,
}: JitEvidencePanelProps) {
  const navigate = useNavigate();
  const requestSequenceRef = useRef(0);
  const [recording, setRecording] = useState(false);
  const [latestArtifact, setLatestArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const [inspectedArtifact, setInspectedArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const [report, setReport] = useState<JfrInspectionReport | null>(null);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function requestStillApplies(sequence: number, requestTargetId: string) {
    return (
      requestSequenceRef.current === sequence &&
      useTargetsStore.getState().selectedTargetId === requestTargetId
    );
  }

  useEffect(() => {
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    setRecording(false);
    setLatestArtifact(null);
    setInspectedArtifact(null);
    setReport(null);
    setErrorMessage(null);
    if (!targetId || !available) {
      setLoadingAction(null);
      return () => {
        requestSequenceRef.current += 1;
      };
    }

    setLoadingAction("refresh");
    void Promise.all([
      window.tanwei.executeAction({
        targetId,
        actionId: "jfr.status",
        parameters: {},
      }),
      window.tanwei.listArtifacts(),
    ])
      .then(([statusResponse, artifactResponse]) => {
        if (!requestStillApplies(sequence, targetId)) {
          return;
        }
        const statusError = actionError(
          t("无法读取 JFR 录制状态"),
          statusResponse,
        );
        if (statusError) {
          setErrorMessage(statusError);
        } else {
          setRecording(statusResponse.value?.values.running === "true");
        }
        if (artifactResponse.ok && artifactResponse.value) {
          setLatestArtifact(
            selectLatestReadyJfrArtifact(artifactResponse.value, targetId),
          );
        }
      })
      .catch((error: unknown) => {
        if (requestStillApplies(sequence, targetId)) {
          setErrorMessage(
            error instanceof Error ? error.message : t("无法读取 JIT 录制证据"),
          );
        }
      })
      .finally(() => {
        if (requestStillApplies(sequence, targetId)) {
          setLoadingAction(null);
        }
      });

    return () => {
      requestSequenceRef.current += 1;
    };
  }, [available, targetId]);

  async function startRecording(): Promise<void> {
    if (!targetId || !available) {
      return;
    }
    const sequence = requestSequenceRef.current;
    setLoadingAction("jfr.start");
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "jfr.start",
        parameters: {
          configuration: "PROFILE",
          maxAgeMillis: "0",
          maxSizeBytes: "0",
        },
      });
      if (!requestStillApplies(sequence, targetId)) {
        return;
      }
      const error = actionError(t("无法启动 JIT 证据录制"), response);
      if (error) {
        setErrorMessage(error);
        return;
      }
      setRecording(true);
    } catch (error) {
      if (requestStillApplies(sequence, targetId)) {
        setErrorMessage(
          error instanceof Error ? error.message : t("无法启动 JIT 证据录制"),
        );
      }
    } finally {
      if (requestStillApplies(sequence, targetId)) {
        setLoadingAction(null);
      }
    }
  }

  async function inspectArtifact(artifact: ArtifactDescriptor): Promise<void> {
    if (!targetId || artifact.targetId !== targetId) {
      return;
    }
    const sequence = requestSequenceRef.current;
    setLoadingAction("jfr.inspect");
    setErrorMessage(null);
    try {
      const response = await window.tanwei.inspectJfrArtifact(artifact.id);
      if (!requestStillApplies(sequence, targetId)) {
        return;
      }
      if (!response.ok || !response.value) {
        setErrorMessage(response.errorMessage ?? t("无法分析 JFR 制品"));
        return;
      }
      setInspectedArtifact(artifact);
      setReport(response.value);
    } catch (error) {
      if (requestStillApplies(sequence, targetId)) {
        setErrorMessage(
          error instanceof Error ? error.message : t("无法分析 JFR 制品"),
        );
      }
    } finally {
      if (requestStillApplies(sequence, targetId)) {
        setLoadingAction(null);
      }
    }
  }

  async function stopAndInspect(): Promise<void> {
    if (!targetId || !available) {
      return;
    }
    const sequence = requestSequenceRef.current;
    setLoadingAction("jfr.stop");
    setErrorMessage(null);
    try {
      const stopResponse = await window.tanwei.executeAction({
        targetId,
        actionId: "jfr.stop",
        parameters: {},
      });
      if (!requestStillApplies(sequence, targetId)) {
        return;
      }
      const stopError = actionError(t("无法停止 JIT 证据录制"), stopResponse);
      if (stopError || !stopResponse.value) {
        setErrorMessage(stopError ?? t("无法停止 JIT 证据录制"));
        return;
      }
      setRecording(false);
      const reference = parseAgentArtifactReference(stopResponse.value.values);
      if (!reference) {
        setErrorMessage(t("Agent 返回的 JFR 制品描述无效"));
        return;
      }

      setLoadingAction("artifact.collect");
      const collected = await window.tanwei.collectAgentArtifact({
        targetId,
        token: reference.token,
        type: "JFR",
        expectedSize: reference.expectedSize,
      });
      if (!requestStillApplies(sequence, targetId)) {
        return;
      }
      if (!collected.ok || !collected.value) {
        setErrorMessage(collected.errorMessage ?? t("无法保存诊断制品"));
        return;
      }
      setLatestArtifact(collected.value);
      setLoadingAction("jfr.inspect");
      const inspected = await window.tanwei.inspectJfrArtifact(
        collected.value.id,
      );
      if (!requestStillApplies(sequence, targetId)) {
        return;
      }
      if (!inspected.ok || !inspected.value) {
        setErrorMessage(inspected.errorMessage ?? t("无法分析 JFR 制品"));
        return;
      }
      setInspectedArtifact(collected.value);
      setReport(inspected.value);
    } catch (error) {
      if (requestStillApplies(sequence, targetId)) {
        setErrorMessage(
          error instanceof Error ? error.message : t("无法回收 JIT 录制证据"),
        );
      }
    } finally {
      if (requestStillApplies(sequence, targetId)) {
        setLoadingAction(null);
      }
    }
  }

  const busy = loadingAction !== null;
  const artifactForNavigation = inspectedArtifact ?? latestArtifact;
  const visibleCompilations = report?.compilations.slice(0, 8) ?? [];
  const visibleDeoptimizations = report?.deoptimizations.slice(0, 8) ?? [];

  return (
    <section
      className="jit-evidence"
      aria-labelledby="jit-evidence-title"
      aria-label={t("JIT 深度证据检查器")}
    >
      <header className="jit-evidence__header">
        <div>
          <p className="eyebrow">DEEP JIT EVIDENCE / JFR / R1</p>
          <h3 id="jit-evidence-title">
            {t("把实时异常接到 C1 / C2 录制证据。")}
          </h3>
          <p>
            {t(
              "PerfCounter 不提供编译层级和去优化原因；这里使用目标 JDK 的 JFR 事件，停止后校验并保存本地制品。",
            )}
          </p>
        </div>
        <StatusPill
          state={
            errorMessage
              ? "error"
              : loadingAction
                ? "working"
                : recording
                  ? "working"
                  : report
                    ? "ready"
                    : "idle"
          }
          label={
            loadingAction
              ? t("处理中")
              : recording
                ? t("JFR 记录中")
                : report
                  ? t("录制证据已加载")
                  : t("等待录制")
          }
        />
      </header>

      <div className="jit-evidence__actions">
        {!recording ? (
          <Button
            type="button"
            variant="secondary"
            disabled={
              Boolean(!available || busy || !targetId) ||
              Boolean(loadingAction === "jfr.start")
            }
            onClick={() => void startRecording()}
            aria-busy={Boolean(loadingAction === "jfr.start")}
          >
            {Boolean(loadingAction === "jfr.start") && <Spinner />}
            {t("开始 JIT 证据录制")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            disabled={
              Boolean(busy) ||
              Boolean(
                loadingAction === "jfr.stop" ||
                  loadingAction === "artifact.collect" ||
                  loadingAction === "jfr.inspect",
              )
            }
            onClick={() => void stopAndInspect()}
            aria-busy={Boolean(
              loadingAction === "jfr.stop" ||
                loadingAction === "artifact.collect" ||
                loadingAction === "jfr.inspect",
            )}
          >
            {Boolean(
              loadingAction === "jfr.stop" ||
                loadingAction === "artifact.collect" ||
                loadingAction === "jfr.inspect",
            ) && <Spinner />}
            {t("停止、保存并分析")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={
            Boolean(!latestArtifact || busy) ||
            Boolean(loadingAction === "jfr.inspect")
          }
          onClick={() => {
            if (latestArtifact) {
              void inspectArtifact(latestArtifact);
            }
          }}
          aria-busy={Boolean(loadingAction === "jfr.inspect")}
        >
          {Boolean(loadingAction === "jfr.inspect") && <Spinner />}
          {t("加载最近 JFR 证据")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!artifactForNavigation || busy}
          onClick={() => {
            if (artifactForNavigation) {
              void navigate({
                pathname: "/artifacts",
                search: `?inspect=${encodeURIComponent(artifactForNavigation.id)}`,
              });
            }
          }}
        >
          {t("打开完整 JFR 检查器")}
        </Button>
        {latestArtifact && (
          <span className="jit-evidence__artifact">
            {latestArtifact.name} · {formatBytes(latestArtifact.size)}
          </span>
        )}
      </div>

      {!available && (
        <div className="jit-evidence__notice">
          <strong>{t("当前 JDK 不支持 JFR。")}</strong>
          <span>{unavailableReason || t("需要 JDK 11 或更高版本。")}</span>
        </div>
      )}
      {errorMessage && (
        <Alert variant="destructive">
          <AlertTitle>{t("JIT 证据操作失败")}</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {report ? (
        <>
          <dl className="jit-evidence__metrics">
            <div>
              <dt>{t("JIT 编译")}</dt>
              <dd>{report.compilationCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("去优化")}</dt>
              <dd>{report.deoptimizationCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("编译耗时")}</dt>
              <dd>{formatDuration(report.compilationDurationMillis)}</dd>
            </div>
            <div>
              <dt>{t("生成代码")}</dt>
              <dd>{formatBytes(report.compiledCodeBytes)}</dd>
            </div>
          </dl>

          <div className="jit-evidence__grid">
            <section className="jit-evidence__panel">
              <header>
                <div>
                  <p className="eyebrow">COMPILER TIERS</p>
                  <h4>{t("C1 / C2 分层")}</h4>
                </div>
                <span>{report.compilerTiers.length}</span>
              </header>
              {report.compilerTiers.length ? (
                <dl className="jit-evidence__tiers">
                  {report.compilerTiers.map((tier) => (
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
                <p className="jit-evidence__empty">
                  {t("这次录制没有编译分层数据。")}
                </p>
              )}
            </section>

            <section className="jit-evidence__panel jit-evidence__panel--wide">
              <header>
                <div>
                  <p className="eyebrow">COMPILATION HOTSPOTS</p>
                  <h4>{t("录制期编译热点")}</h4>
                </div>
                <span>
                  {t("前 {count} 组", { count: visibleCompilations.length })}
                </span>
              </header>
              {visibleCompilations.length ? (
                <div className="jit-evidence__table-wrap">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{t("方法")}</TableHead>
                        <TableHead scope="col">{t("编译器 / 层级")}</TableHead>
                        <TableHead scope="col">{t("次数 / OSR")}</TableHead>
                        <TableHead scope="col">{t("总耗时 / 代码")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleCompilations.map((compilation) => (
                        <TableRow
                          key={`${compilation.method}:${compilation.compiler}:${compilation.compileLevel}`}
                        >
                          <TableCell>
                            <code>{compilation.method}</code>
                          </TableCell>
                          <TableCell>
                            <strong>{compilation.compiler}</strong>
                            <span>
                              {formatCompileLevel(compilation.compileLevel)}
                            </span>
                          </TableCell>
                          <TableCell>
                            <strong>
                              {compilation.compilations.toLocaleString()}
                            </strong>
                            <span>
                              {compilation.osrCompilations.toLocaleString()} OSR
                            </span>
                          </TableCell>
                          <TableCell>
                            <strong>
                              {formatDuration(compilation.totalDurationMillis)}
                            </strong>
                            <span>{formatBytes(compilation.codeBytes)}</span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="jit-evidence__empty">
                  {t("这次录制没有达到 1 ms 阈值的 Compilation 事件。")}
                </p>
              )}
            </section>

            <section className="jit-evidence__panel jit-evidence__panel--wide">
              <header>
                <div>
                  <p className="eyebrow">DEOPTIMIZATION REASONS</p>
                  <h4>{t("去优化原因与行动")}</h4>
                </div>
                <span>
                  {t("前 {count} 组", {
                    count: visibleDeoptimizations.length,
                  })}
                </span>
              </header>
              {visibleDeoptimizations.length ? (
                <ol className="jit-evidence__deoptimizations">
                  {visibleDeoptimizations.map((item) => (
                    <li
                      key={`${item.method}:${item.compiler}:${item.reason}:${item.action}`}
                    >
                      <span className="jit-evidence__rank">
                        ×{item.count.toLocaleString()}
                      </span>
                      <div>
                        <strong>{item.reason}</strong>
                        <code>{item.method}</code>
                        <span>
                          {item.compiler} · {item.action}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="jit-evidence__empty">
                  {t("这次录制没有 Deoptimization 事件。")}
                </p>
              )}
            </section>
          </div>

          <p className="jit-evidence__boundary">
            {t(
              "Host 已复验真实路径、文件类型、登记大小与 SHA-256；只解析受控 JFR 事件集合。",
            )}
            {report.truncated && <strong>{t("结果已按安全上限截断。")}</strong>}
          </p>
        </>
      ) : (
        <div className="jit-evidence__empty jit-evidence__empty--large">
          <strong>{t("实时快照与录制证据各司其职。")}</strong>
          <span>
            {latestArtifact
              ? t("已找到当前目标最近的 JFR 制品，可直接加载。")
              : t(
                  "开始录制，复现编译抖动后停止，即可检查 C1、C2 与去优化原因。",
                )}
          </span>
        </div>
      )}
    </section>
  );
}
