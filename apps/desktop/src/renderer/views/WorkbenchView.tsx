import { useMatches } from "react-router";
import { useNavigate } from "react-router";
import { t, useLocale } from "../i18n";
import type { RouteMeta } from "../router";
import "./WorkbenchView.css";
import { Button } from "@/components/ui/button";

export default function WorkbenchView() {
  useLocale();
  const matches = useMatches();
  const navigate = useNavigate();
  const meta = (matches.at(-1)?.handle ?? null) as RouteMeta | null;
  const title = t(meta?.label ?? "工作台");
  const eyebrow = meta?.eyebrow ?? "WORKBENCH";
  const description = t(meta?.description ?? "");

  return (
    <section className="page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}。</h1>
        </div>
        <p className="page-heading__summary">{description}</p>
      </header>

      <section className="module-preview">
        <p className="eyebrow">MODULE CONTRACT</p>
        <p className="module-preview__title">{t("等待目标连接与能力协商。")}</p>
        <p>
          {t(
            "页面不会发送未知文本命令；操作入口由当前 Agent 的 Action Schema、能力清单和风险策略共同决定。",
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void navigate("/targets")}
        >
          {t("选择目标")}
        </Button>
      </section>
    </section>
  );
}
