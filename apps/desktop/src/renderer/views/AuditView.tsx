import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import type {
  ActionAuditDescriptor,
  ActionAuditPage,
  ActionAuditQuery,
} from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import RiskPill from "../components/RiskPill";
import StatePagination from "../components/StatePagination";
import StatusPill from "../components/StatusPill";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatNumber, t, useLocale } from "../i18n";
import { useTargetsStore } from "../stores/targets";

const PAGE_SIZE = 50;
const EMPTY_PAGE: ActionAuditPage = {
  total: 0,
  retained: 0,
  offset: 0,
  limit: PAGE_SIZE,
  succeeded: 0,
  failed: 0,
  items: [],
};

type AuditStatus = ActionAuditQuery["status"];
type AuditRisk = ActionAuditQuery["riskLevel"];
type TargetScope = "ALL" | "CURRENT";

export default function AuditView() {
  useLocale();
  const navigate = useNavigate();
  const selectedTargetId = useTargetsStore((state) => state.selectedTargetId);
  const [draftQuery, setDraftQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState<AuditStatus>("ALL");
  const [riskLevel, setRiskLevel] = useState<AuditRisk>("ALL");
  const [targetScope, setTargetScope] = useState<TargetScope>("ALL");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ActionAuditPage>(EMPTY_PAGE);
  const [selectedAudit, setSelectedAudit] =
    useState<ActionAuditDescriptor | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);

  const effectiveTargetId =
    targetScope === "CURRENT" ? (selectedTargetId ?? "") : "";
  const maximumOffset = Math.max(
    0,
    Math.floor(Math.max(0, page.total - 1) / PAGE_SIZE) * PAGE_SIZE,
  );
  const pageStart = page.total === 0 ? 0 : page.offset + 1;
  const pageEnd = Math.min(page.offset + page.items.length, page.total);

  useEffect(() => {
    if (targetScope === "CURRENT" && !selectedTargetId) {
      setTargetScope("ALL");
      setOffset(0);
    }
  }, [selectedTargetId, targetScope]);

  useEffect(() => {
    const requestSequence = ++requestSequenceRef.current;
    setLoading(true);
    setErrorMessage(null);
    void window.tanwei
      .queryActionAudits({
        offset,
        limit: PAGE_SIZE,
        query: appliedQuery,
        targetId: effectiveTargetId,
        status,
        riskLevel,
      })
      .then((result) => {
        if (requestSequence !== requestSequenceRef.current) {
          return;
        }
        if (!result.ok || !result.value) {
          setErrorMessage(result.errorMessage ?? t("无法检索诊断审计记录"));
          setPage(EMPTY_PAGE);
          setSelectedAudit(null);
          return;
        }
        setPage(result.value);
        setSelectedAudit((previous) =>
          result.value?.items.find(
            (item) => item.taskId === previous?.taskId,
          ) ??
          result.value?.items[0] ??
          null,
        );
      })
      .catch((error: unknown) => {
        if (requestSequence === requestSequenceRef.current) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : t("无法检索诊断审计记录"),
          );
          setPage(EMPTY_PAGE);
          setSelectedAudit(null);
        }
      })
      .finally(() => {
        if (requestSequence === requestSequenceRef.current) {
          setLoading(false);
        }
      });
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [appliedQuery, effectiveTargetId, offset, riskLevel, status]);

  function submitQuery(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setOffset(0);
    setAppliedQuery(draftQuery.trim());
  }

  function changeStatus(value: string): void {
    if (value === "ALL" || value === "SUCCEEDED" || value === "FAILED") {
      setStatus(value);
      setOffset(0);
    }
  }

  function changeRiskLevel(value: string): void {
    if (
      value === "ALL" ||
      value === "R0" ||
      value === "R1" ||
      value === "R2" ||
      value === "R3" ||
      value === "R4"
    ) {
      setRiskLevel(value);
      setOffset(0);
    }
  }

  function changeTargetScope(value: string): void {
    if (value === "ALL" || (value === "CURRENT" && selectedTargetId)) {
      setTargetScope(value);
      setOffset(0);
    }
  }

  function resetFilters(): void {
    setDraftQuery("");
    setAppliedQuery("");
    setStatus("ALL");
    setRiskLevel("ALL");
    setTargetScope("ALL");
    setOffset(0);
  }

  function openCaseEvidence(audit: ActionAuditDescriptor): void {
    void navigate({
      pathname: "/cases",
      search: `?action=${encodeURIComponent(audit.taskId)}`,
    });
  }

  return (
    <section className="page space-y-6" data-testid="audit-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">DIAGNOSTIC AUDIT</p>
          <h1>{t("每一次诊断，都能追溯。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "跨桌面会话检索 Host 已执行的结构化 Action；只保留目标、风险、状态、错误码和结果字段名，不保存业务值。",
          )}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={t("匹配记录")}
          value={page.total}
          icon={<Search />}
          testId="audit-total"
        />
        <MetricCard
          label={t("执行成功")}
          value={page.succeeded}
          icon={<CheckCircle2 />}
          testId="audit-succeeded"
        />
        <MetricCard
          label={t("执行失败")}
          value={page.failed}
          icon={<AlertTriangle />}
          testId="audit-failed"
        />
        <MetricCard
          label={t("本地保留")}
          value={page.retained}
          icon={<Database />}
          testId="audit-retained"
        />
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("筛选审计记录")}</CardTitle>
          <CardDescription>
            {t("搜索 Action ID、任务 ID、目标 ID 或稳定错误码。")}
          </CardDescription>
          <CardAction>
            <Button type="button" variant="ghost" onClick={resetFilters}>
              <RefreshCw />
              {t("重置")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 xl:grid-cols-[minmax(18rem,1fr)_12rem_12rem_14rem_auto]"
            onSubmit={submitQuery}
          >
            <div className="grid gap-2">
              <Label htmlFor="audit-query">{t("搜索审计")}</Label>
              <Input
                id="audit-query"
                type="search"
                maxLength={256}
                value={draftQuery}
                placeholder={t("例如 mbean、session.reset 或错误码")}
                onChange={(event) => setDraftQuery(event.target.value)}
              />
            </div>
            <AuditSelect
              label={t("状态")}
              value={status}
              onValueChange={changeStatus}
              items={[
                ["ALL", t("全部状态")],
                ["SUCCEEDED", t("成功")],
                ["FAILED", t("失败")],
              ]}
            />
            <AuditSelect
              label={t("风险等级")}
              value={riskLevel}
              onValueChange={changeRiskLevel}
              items={[
                ["ALL", t("全部风险")],
                ["R0", "R0"],
                ["R1", "R1"],
                ["R2", "R2"],
                ["R3", "R3"],
                ["R4", "R4"],
              ]}
            />
            <AuditSelect
              label={t("目标范围")}
              value={targetScope}
              onValueChange={changeTargetScope}
              items={[
                ["ALL", t("全部目标")],
                [
                  "CURRENT",
                  selectedTargetId ? t("当前目标") : t("当前没有目标"),
                  !selectedTargetId,
                ],
              ]}
            />
            <Button
              className="self-end"
              type="submit"
              variant="secondary"
              disabled={loading}
            >
              <Search />
              {t("查询")}
            </Button>
          </form>
        </CardContent>
      </Card>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("Action 历史")}</CardTitle>
          <CardDescription>
            {t("按完成时间倒序；每页最多 {count} 条。", {
              count: PAGE_SIZE,
            })}
          </CardDescription>
          <CardAction>
            <Badge variant="secondary">
              {t("{start}–{end} / {total}", {
                start: pageStart,
                end: pageEnd,
                total: page.total,
              })}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Action</TableHead>
                <TableHead>{t("状态")}</TableHead>
                <TableHead>{t("风险")}</TableHead>
                <TableHead>{t("目标")}</TableHead>
                <TableHead>{t("完成时间")}</TableHead>
                <TableHead className="pr-6 text-right">{t("详情")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && page.items.length === 0
                ? Array.from({ length: 5 }, (_, index) => (
                    <TableRow key={index}>
                      <TableCell className="pl-6" colSpan={6}>
                        <Skeleton className="h-9 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : page.items.map((audit) => (
                    <TableRow
                      key={audit.taskId}
                      data-state={
                        selectedAudit?.taskId === audit.taskId
                          ? "selected"
                          : undefined
                      }
                    >
                      <TableCell className="pl-6 font-mono font-medium">
                        {audit.actionId}
                      </TableCell>
                      <TableCell>
                        <StatusPill
                          state={audit.status === "FAILED" ? "error" : "ready"}
                          label={audit.status}
                        />
                      </TableCell>
                      <TableCell>
                        <RiskPill level={audit.riskLevel} compact />
                      </TableCell>
                      <TableCell
                        className="max-w-64 truncate font-mono text-xs"
                        title={audit.targetId}
                      >
                        {audit.targetId}
                      </TableCell>
                      <TableCell>{formatDateTime(audit.completedAt)}</TableCell>
                      <TableCell className="pr-6 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={t("查看 {action} 审计详情", {
                            action: audit.actionId,
                          })}
                          onClick={() => setSelectedAudit(audit)}
                        >
                          {t("查看")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
          {!loading && page.items.length === 0 && (
            <div className="text-muted-foreground grid min-h-40 place-items-center px-6 text-center text-sm">
              <div>
                <ShieldCheck className="mx-auto mb-3 size-6" />
                <p className="text-foreground font-medium">
                  {t("没有匹配的审计记录。")}
                </p>
                <p>{t("调整搜索、状态、风险或目标范围后重试。")}</p>
              </div>
            </div>
          )}
        </CardContent>
        <CardFooter className="justify-between border-t">
          <StatePagination
            ariaLabel={t("审计记录分页")}
            previousLabel={t("上一页")}
            nextLabel={t("下一页")}
            previousDisabled={offset === 0 || loading}
            nextDisabled={offset >= maximumOffset || loading}
            onPrevious={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            onNext={() =>
              setOffset(Math.min(maximumOffset, offset + PAGE_SIZE))
            }
            summary={
              <span className="text-muted-foreground text-sm">
                {t("第 {page} 页", {
                  page: Math.floor(offset / PAGE_SIZE) + 1,
                })}
              </span>
            }
          />
        </CardFooter>
      </Card>

      {selectedAudit && (
        <Card data-testid="audit-detail">
          <CardHeader className="border-b">
            <CardTitle className="font-mono">{selectedAudit.actionId}</CardTitle>
            <CardDescription>
              {t("Host 权威摘要 · 不包含参数值和结果值")}
            </CardDescription>
            <CardAction>
              <Button
                type="button"
                variant="outline"
                onClick={() => openCaseEvidence(selectedAudit)}
              >
                {t("加入案例证据")}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <AuditFact label={t("任务 ID")} value={selectedAudit.taskId} />
            <AuditFact label={t("目标 ID")} value={selectedAudit.targetId} />
            <AuditFact
              label={t("状态")}
              value={selectedAudit.status}
            />
            <div className="min-w-0">
              <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
                {t("风险")}
              </p>
              <RiskPill level={selectedAudit.riskLevel} />
            </div>
            <AuditFact
              label={t("稳定错误码")}
              value={selectedAudit.errorCode ?? t("无")}
            />
            <div className="md:col-span-2 xl:col-span-4">
              <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
                {t("结果字段名")}
              </p>
              <div className="flex flex-wrap gap-2">
                {selectedAudit.valueKeys.length > 0 ? (
                  selectedAudit.valueKeys.map((key) => (
                    <Badge key={key} variant="outline" className="font-mono">
                      {key}
                    </Badge>
                  ))
                ) : (
                  <span className="text-muted-foreground text-sm">
                    {t("没有记录结果字段。")}
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

interface MetricCardProps {
  readonly label: string;
  readonly value: number;
  readonly icon: React.ReactNode;
  readonly testId: string;
}

function MetricCard({ label, value, icon, testId }: MetricCardProps) {
  return (
    <Card className="gap-3 py-5" data-testid={testId}>
      <CardHeader className="grid-cols-[1fr_auto] px-5">
        <CardDescription>{label}</CardDescription>
        <span className="text-muted-foreground [&>svg]:size-4">{icon}</span>
      </CardHeader>
      <CardContent className="px-5">
        <strong className="text-2xl tracking-tight">{formatNumber(value)}</strong>
      </CardContent>
    </Card>
  );
}

interface AuditSelectProps {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly items: ReadonlyArray<readonly [string, string, boolean?]>;
}

function AuditSelect({
  label,
  value,
  onValueChange,
  items,
}: AuditSelectProps) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map(([itemValue, itemLabel, disabled]) => (
            <SelectItem
              key={itemValue}
              value={itemValue}
              {...(disabled === undefined ? {} : { disabled })}
            >
              {itemLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface AuditFactProps {
  readonly label: string;
  readonly value: string;
}

function AuditFact({ label, value }: AuditFactProps) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
        {label}
      </p>
      <code className="block truncate text-sm" title={value}>
        {value}
      </code>
    </div>
  );
}
