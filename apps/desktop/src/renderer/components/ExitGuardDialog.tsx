import { useMemo } from "react";
import type {
  AppExitReason,
  DesktopPlatform,
  ExitImpactSummary,
} from "@shared/contracts";
import { formatNumber, t, useLocale } from "../i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface ExitGuardDialogProps {
  readonly open: boolean;
  readonly loading: boolean;
  readonly reason: AppExitReason | null;
  readonly platform: DesktopPlatform | null;
  readonly impact: ExitImpactSummary | null;
  readonly errorMessage: string | null;
  readonly onContinue: () => void;
  readonly onReview: () => void;
  readonly onBackground: () => void;
  readonly onQuit: () => void;
}

export default function ExitGuardDialog({
  open,
  loading,
  reason,
  platform,
  impact,
  errorMessage,
  onContinue,
  onReview,
  onBackground,
  onQuit,
}: ExitGuardDialogProps) {
  useLocale();

  const hasManagedState = Boolean(
    impact &&
      (impact.taskCount > 0 ||
        impact.classCount > 0 ||
        impact.rollbackCount > 0 ||
        impact.artifactPotentialCount > 0),
  );

  const visibleTargets = useMemo(
    () =>
      (impact?.targets ?? [])
        .filter(
          (target) =>
            target.state === "FAILED" ||
            target.taskCount > 0 ||
            target.classCount > 0 ||
            target.rollbackCount > 0 ||
            target.artifactPotentialCount > 0,
        )
        .slice(0, 8),
    [impact],
  );

  const hiddenTargetCount = useMemo(() => {
    if (!impact) {
      return 0;
    }
    const relevantCount = impact.targets.filter(
      (target) =>
        target.state === "FAILED" ||
        target.taskCount > 0 ||
        target.classCount > 0 ||
        target.rollbackCount > 0 ||
        target.artifactPotentialCount > 0,
    ).length;
    return Math.max(0, relevantCount - visibleTargets.length);
  }, [impact, visibleTargets.length]);

  const canCloseInBackground =
    reason === "WINDOW_CLOSE" && platform === "darwin";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) {
          onContinue();
        }
      }}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (loading) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader className="exit-guard__header text-left">
          <p className="exit-guard__eyebrow">EXIT SAFETY / SESSION IMPACT</p>
          <p className="exit-guard__sequence">01 — 04</p>
          <DialogTitle>
            {loading
              ? t("正在核对每个 JVM。")
              : hasManagedState
                ? t("退出会终止仍在运行的诊断。")
                : t("退出影响尚未完全确认。")}
          </DialogTitle>
          <DialogDescription className="exit-guard__description">
            {loading
              ? t("正在只读扫描活动任务、字节码增强与可回收制品。")
              : hasManagedState
                ? t(
                    "探微会在退出时撤销自己持有的增强并停止任务；尚未保存的 Profile 或 JFR 结果可能无法回收。",
                  )
                : t(
                    "至少一个连接没有返回可信预检结果。继续退出会按安全清理流程断开连接。",
                  )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="exit-guard__loading" aria-live="polite">
            <Spinner />
            <p>SESSION RESET PREVIEW IN PROGRESS</p>
          </div>
        ) : (
          <>
            {impact && (
              <div className="exit-guard__metrics">
                <article>
                  <span>CONNECTED JVM</span>
                  <strong>{formatNumber(impact.connectionCount)}</strong>
                  <small>
                    {t("{count} 个未确认", {
                      count: formatNumber(impact.failedCount),
                    })}
                  </small>
                </article>
                <article>
                  <span>ACTIVE TASKS</span>
                  <strong>{formatNumber(impact.taskCount)}</strong>
                  <small>{t("观测 / Trace / Profile / JFR")}</small>
                </article>
                <article>
                  <span>ENHANCED CLASSES</span>
                  <strong>{formatNumber(impact.classCount)}</strong>
                  <small>
                    {t("{count} 条回滚记录", {
                      count: formatNumber(impact.rollbackCount),
                    })}
                  </small>
                </article>
                <article>
                  <span>RESULTS AT RISK</span>
                  <strong>{formatNumber(impact.artifactPotentialCount)}</strong>
                  <small>{t("可能尚未回收的制品")}</small>
                </article>
              </div>
            )}

            {errorMessage ? (
              <Alert className="exit-guard__warning" variant="destructive">
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            ) : impact?.failedCount ? (
              <Alert className="exit-guard__warning" role="status">
                <AlertDescription>
                  {t(
                    "{count} 个 JVM 未完成影响检查，探微不会把未知状态当作安全。",
                    { count: impact.failedCount },
                  )}
                </AlertDescription>
              </Alert>
            ) : null}

            {visibleTargets.length > 0 && (
              <div className="exit-guard__targets">
                {visibleTargets.map((target) => (
                  <article key={target.targetId} className="exit-guard__target">
                    <div>
                      <strong>{target.displayName}</strong>
                      <span>PID {target.pid}</span>
                    </div>
                    {target.state === "FAILED" ? (
                      <p>
                        {t("未确认 · {message}", {
                          message: target.errorMessage ?? t("未知错误"),
                        })}
                      </p>
                    ) : (
                      <p>
                        {t(
                          "{taskCount} 任务 · {classCount} 增强类 · {artifactCount} 待回收结果",
                          {
                            taskCount: target.taskCount,
                            classCount: target.classCount,
                            artifactCount: target.artifactPotentialCount,
                          },
                        )}
                      </p>
                    )}
                  </article>
                ))}
                {hiddenTargetCount > 0 && (
                  <p className="exit-guard__more">
                    {t("另有 {count} 个受影响目标", {
                      count: hiddenTargetCount,
                    })}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        <DialogFooter className="exit-guard__actions">
          <div>
            <Button
              type="button"
              data-autofocus
              variant="outline"
              disabled={loading}
              onClick={onContinue}
            >
              {t("继续诊断")}
            </Button>
            {hasManagedState && (
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={onReview}
              >
                {t("查看任务中心")}
              </Button>
            )}
          </div>
          <div>
            {canCloseInBackground && (
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={onBackground}
              >
                {t("关闭窗口，任务后台继续")}
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={Boolean(loading) || Boolean(loading)}
              onClick={onQuit}
              aria-busy={Boolean(loading)}
            >
              {Boolean(loading) && <Spinner />}
              {t("安全退出并清理")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
