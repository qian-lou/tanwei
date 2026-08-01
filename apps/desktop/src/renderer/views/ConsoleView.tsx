import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import type { ActionResult } from "@shared/contracts";
import RiskPill from "../components/RiskPill";
import { t, useLocale } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./ConsoleView.css";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";

const MAXIMUM_HISTORY = 100;

export default function ConsoleView() {
  useLocale();
  const selectedTargetId = useTargetsStore((state) => state.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const [selectedAction, setSelectedAction] = useState("jvm.info");
  const [history, setHistory] = useState<readonly ActionResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const preview = JSON.stringify(
    {
      actionId: selectedAction,
      parameters: {},
      targetId: selectedTargetId ?? `<${t("未选择目标")}>`,
      policy: "R0 / HOST_AND_AGENT",
    },
    null,
    2,
  );

  async function execute(): Promise<void> {
    if (!selectedTargetId || connection?.state !== "READY") {
      setErrorMessage(t("请先连接目标JVM"));
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: selectedTargetId,
        actionId: selectedAction,
        parameters: {},
      });
      const value = response.value;
      if (!response.ok || !value) {
        setErrorMessage(response.errorMessage ?? t("Action执行失败"));
        return;
      }
      setHistory((current) => [value, ...current].slice(0, MAXIMUM_HISTORY));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("Action执行失败"),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="page console-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">EXPERT CONSOLE</p>
          <h1>{t("结构化，不猜测。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "Console 只发送已声明 Action 与通过 Schema 校验的参数；不存在任意文本命令或 Renderer 绕过路径。",
          )}
        </p>
      </header>

      <div className="console-shell">
        <section className="console-command">
          <Label>
            <span>ACTION SCHEMA</span>
            <SelectControl
              value={selectedAction}
              onValueChange={(value) => setSelectedAction(value)}
            >
              <SelectControlItem value="jvm.info">
                jvm.info — {t("JVM基础信息")}
              </SelectControlItem>
              <SelectControlItem value="arthas.compatibility">
                arthas.compatibility — {t("Arthas 生态映射")}
              </SelectControlItem>
              <SelectControlItem value="retransform.status">
                retransform.status — {t("增强生命周期")}
              </SelectControlItem>
              <SelectControlItem value="jvm.arguments">
                jvm.arguments — {t("启动参数")}
              </SelectControlItem>
              <SelectControlItem value="system.properties">
                system.properties — {t("系统属性")}
              </SelectControlItem>
              <SelectControlItem value="environment.summary">
                environment.summary — {t("环境摘要")}
              </SelectControlItem>
              <SelectControlItem value="memory.pools">
                memory.pools — {t("内存池")}
              </SelectControlItem>
              <SelectControlItem value="gc.collectors">
                gc.collectors — {t("GC收集器")}
              </SelectControlItem>
              <SelectControlItem value="mbeans.summary">
                mbeans.summary — {t("MBean域")}
              </SelectControlItem>
              <SelectControlItem value="vm.options">
                vm.options — VM Options
              </SelectControlItem>
              <SelectControlItem value="logging.summary">
                logging.summary — {t("日志级别")}
              </SelectControlItem>
            </SelectControl>
          </Label>
          <pre aria-label={t("操作预览")}>{preview}</pre>
          <div className="console-command__footer">
            <RiskPill level="R0" />
            <Button
              type="button"
              variant="secondary"
              disabled={
                Boolean(connection?.state !== "READY") || Boolean(loading)
              }
              onClick={() => void execute()}
              aria-busy={Boolean(loading)}
            >
              {Boolean(loading) && <Spinner />}
              {t("执行Action")}
            </Button>
          </div>
        </section>

        <section className="console-output" aria-live="polite">
          <header>
            <span>RESULT EVENTS</span>
            <span>
              {history.length}/{MAXIMUM_HISTORY}
            </span>
          </header>
          {errorMessage && (
            <Alert variant="destructive">
              <AlertTitle>ERROR</AlertTitle>
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}
          {history.map((item) => (
            <article key={item.taskId}>
              <div>
                <strong>{item.actionId}</strong>
                <span>
                  {item.status} · {item.riskLevel}
                </span>
              </div>
              <pre>{JSON.stringify(item, null, 2)}</pre>
            </article>
          ))}
          {history.length === 0 && !errorMessage && (
            <p className="console-empty">
              {t("暂无事件。连接目标并执行一个 Action。")}
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
