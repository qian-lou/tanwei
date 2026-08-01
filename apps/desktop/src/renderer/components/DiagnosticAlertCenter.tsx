import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  Check,
  CheckCheck,
  CircleAlert,
  Info,
  TriangleAlert,
} from "lucide-react";
import { useNavigate } from "react-router";
import type { DiagnosticAlertDescriptor } from "@shared/contracts";
import { formatDateTime, t, useLocale } from "../i18n";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Spinner } from "./ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import "./DiagnosticAlertCenter.css";

const MAXIMUM_RENDERED_ALERTS = 50;

function AlertSeverityIcon({
  severity,
}: Pick<DiagnosticAlertDescriptor, "severity">) {
  const sharedProps = {
    "aria-hidden": true,
    "data-slot": "diagnostic-alert-severity-icon",
    "data-severity": severity,
  } as const;

  switch (severity) {
    case "CRITICAL":
      return <CircleAlert {...sharedProps} />;
    case "WARNING":
      return <TriangleAlert {...sharedProps} />;
    default:
      return <Info {...sharedProps} />;
  }
}

function alertTitle(alert: DiagnosticAlertDescriptor): string {
  if (alert.kind === "JIT_BASELINE_READY") {
    return t("JIT 基线已保存");
  }
  switch (alert.codeCachePressure) {
    case "EXHAUSTED":
      return alert.codeCacheCapacityKind === "MAX"
        ? t("Code Cache 最大容量已耗尽")
        : t("Code Cache 已提交容量已用尽");
    case "HIGH":
      return t("Code Cache 进入高压力");
    case "ELEVATED":
    default:
      return t("Code Cache 压力升高");
  }
}

function alertEvidence(alert: DiagnosticAlertDescriptor): string {
  return t("窗口峰值 {percent}% · {capacity}", {
    percent: alert.codeCachePercent.toFixed(1),
    capacity:
      alert.codeCacheCapacityKind === "MAX"
        ? t("按最大容量")
        : t("按已提交容量"),
  });
}

export default function DiagnosticAlertCenter() {
  useLocale();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<readonly DiagnosticAlertDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const requestSequence = ++requestSequenceRef.current;
    setLoading(true);
    try {
      const result = await window.tanwei.listDiagnosticAlerts();
      if (!mountedRef.current || requestSequence !== requestSequenceRef.current) {
        return;
      }
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法读取诊断通知"));
        return;
      }
      setAlerts(result.value);
      setErrorMessage(null);
    } catch (error) {
      if (mountedRef.current && requestSequence === requestSequenceRef.current) {
        setErrorMessage(
          error instanceof Error ? error.message : t("无法读取诊断通知"),
        );
      }
    } finally {
      if (mountedRef.current && requestSequence === requestSequenceRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const stopListening = window.tanwei.onDiagnosticAlertsChanged(() => {
      void refresh();
    });
    void refresh();
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      stopListening?.();
    };
  }, [refresh]);

  const unreadCount = alerts.reduce(
    (count, alert) => count + (alert.acknowledgedAt ? 0 : 1),
    0,
  );
  const visibleAlerts = alerts.slice(0, MAXIMUM_RENDERED_ALERTS);

  async function acknowledge(alert: DiagnosticAlertDescriptor): Promise<void> {
    if (alert.acknowledgedAt || mutating) {
      return;
    }
    setMutating(true);
    try {
      const result = await window.tanwei.acknowledgeDiagnosticAlert(alert.id);
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("无法标记诊断通知"));
        return;
      }
      if (result.value) {
        setAlerts((current) =>
          current.map((item) =>
            item.id === result.value?.id ? result.value : item,
          ),
        );
      }
    } finally {
      if (mountedRef.current) {
        setMutating(false);
      }
    }
  }

  async function acknowledgeAll(): Promise<void> {
    if (unreadCount === 0 || mutating) {
      return;
    }
    setMutating(true);
    try {
      const result = await window.tanwei.acknowledgeAllDiagnosticAlerts();
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("无法标记全部诊断通知"));
        return;
      }
      await refresh();
    } finally {
      if (mountedRef.current) {
        setMutating(false);
      }
    }
  }

  async function inspectEvidence(
    alert: DiagnosticAlertDescriptor,
  ): Promise<void> {
    const artifactId = alert.artifactId;
    if (!artifactId) {
      return;
    }
    await acknowledge(alert);
    setOpen(false);
    await navigate({
      pathname: "/artifacts",
      search: `?inspect=${encodeURIComponent(artifactId)}`,
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          void refresh();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="diagnostic-alert-trigger"
          aria-label={t("诊断通知，{count} 条未读", { count: unreadCount })}
        >
          <Bell aria-hidden="true" />
          {unreadCount > 0 && (
            <span className="diagnostic-alert-trigger__count" aria-hidden="true">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="diagnostic-alert-center"
        data-testid="diagnostic-alert-center"
      >
        <DialogHeader>
          <div className="diagnostic-alert-center__title-row">
            <div>
              <p className="eyebrow">DIAGNOSTIC EVENTS / LOCAL ONLY</p>
              <DialogTitle>{t("诊断通知")}</DialogTitle>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={unreadCount === 0 || mutating}
              onClick={() => void acknowledgeAll()}
            >
              <CheckCheck aria-hidden="true" />
              {t("全部标为已读")}
            </Button>
          </div>
          <DialogDescription>
            {t(
              "事件由 Host 根据校验制品生成；只保留最近 200 条，本窗口显示最近 50 条。",
            )}
          </DialogDescription>
        </DialogHeader>

        {errorMessage && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{t("无法读取诊断通知")}</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        {loading && alerts.length === 0 ? (
          <Empty className="diagnostic-alert-center__state">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Spinner />
              </EmptyMedia>
              <EmptyTitle>{t("正在读取本地诊断事件…")}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : visibleAlerts.length === 0 ? (
          <Empty className="diagnostic-alert-center__state">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Bell aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{t("还没有诊断通知")}</EmptyTitle>
              <EmptyDescription>
                {t("保存 JIT 趋势后，基线或容量压力会出现在这里。")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ol className="diagnostic-alert-center__list" aria-label={t("诊断事件") }>
            {visibleAlerts.map((alert) => (
              <li
                key={alert.id}
                className={`diagnostic-alert-card diagnostic-alert-card--${alert.severity.toLocaleLowerCase()}`}
                data-read={alert.acknowledgedAt ? "true" : "false"}
              >
                <AlertSeverityIcon severity={alert.severity} />
                <div className="diagnostic-alert-card__body">
                  <header>
                    <strong>{alertTitle(alert)}</strong>
                    <time dateTime={alert.createdAt}>
                      {formatDateTime(alert.createdAt)}
                    </time>
                  </header>
                  <p>{alertEvidence(alert)}</p>
                  <code>{alert.targetId}</code>
                </div>
                <div className="diagnostic-alert-card__actions">
                  {!alert.acknowledgedAt && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={mutating}
                      aria-label={t("标为已读")}
                      onClick={() => void acknowledge(alert)}
                    >
                      <Check aria-hidden="true" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!alert.artifactId}
                    onClick={() => void inspectEvidence(alert)}
                  >
                    {alert.artifactId ? t("检查证据") : t("证据已删除")}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
