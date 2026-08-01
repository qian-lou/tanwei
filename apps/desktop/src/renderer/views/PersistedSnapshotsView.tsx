import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Archive,
  CheckCircle2,
  Database,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type {
  PersistedInvocationSnapshot,
  PersistedInvocationSnapshotPage,
  PersistedInvocationSnapshotQuery,
  PersistedInvocationSnapshotSummary,
} from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import StatePagination from "../components/StatePagination";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
const EMPTY_PAGE: PersistedInvocationSnapshotPage = {
  total: 0,
  retained: 0,
  offset: 0,
  limit: PAGE_SIZE,
  returned: 0,
  threw: 0,
  root: 0,
  internal: 0,
  estimatedBytes: 0,
  items: [],
};

type OutcomeFilter = PersistedInvocationSnapshotQuery["outcome"];
type ScopeFilter = PersistedInvocationSnapshotQuery["scope"];
type TargetScope = "ALL" | "CURRENT";

export default function PersistedSnapshotsView() {
  useLocale();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTargetId = useTargetsStore((state) => state.selectedTargetId);
  const requestedSnapshotId = normalizeSnapshotId(searchParams.get("snapshot"));
  const [draftQuery, setDraftQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [outcome, setOutcome] = useState<OutcomeFilter>("ALL");
  const [scope, setScope] = useState<ScopeFilter>("ALL");
  const [targetScope, setTargetScope] = useState<TargetScope>("ALL");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(EMPTY_PAGE);
  const [selectedId, setSelectedId] = useState<string | null>(
    requestedSnapshotId,
  );
  const [details, setDetails] =
    useState<PersistedInvocationSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

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
    const requestId = ++listRequestRef.current;
    setLoading(true);
    setErrorMessage(null);
    void window.tanwei
      .queryPersistedInvocationSnapshots({
        offset,
        limit: PAGE_SIZE,
        query: appliedQuery,
        targetId: effectiveTargetId,
        outcome,
        scope,
      })
      .then((result) => {
        if (requestId !== listRequestRef.current) {
          return;
        }
        if (!result.ok || !result.value) {
          setPage(EMPTY_PAGE);
          setSelectedId(null);
          setErrorMessage(result.errorMessage ?? t("无法检索桌面调用档案"));
          return;
        }
        setPage(result.value);
        setSelectedId((current) => {
          if (requestedSnapshotId) {
            return requestedSnapshotId;
          }
          return result.value?.items.some((item) => item.id === current)
            ? current
            : (result.value?.items[0]?.id ?? null);
        });
      })
      .catch((error: unknown) => {
        if (requestId === listRequestRef.current) {
          setPage(EMPTY_PAGE);
          setSelectedId(null);
          setErrorMessage(
            error instanceof Error
              ? error.message
              : t("无法检索桌面调用档案"),
          );
        }
      })
      .finally(() => {
        if (requestId === listRequestRef.current) {
          setLoading(false);
        }
      });
    return () => {
      listRequestRef.current += 1;
    };
  }, [appliedQuery, effectiveTargetId, offset, outcome, requestedSnapshotId, scope]);

  useEffect(() => {
    if (!selectedId) {
      setDetails(null);
      return;
    }
    const requestId = ++detailRequestRef.current;
    setLoadingDetails(true);
    setDetails(null);
    void window.tanwei
      .getPersistedInvocationSnapshot(selectedId)
      .then((result) => {
        if (requestId !== detailRequestRef.current) {
          return;
        }
        if (!result.ok || !result.value) {
          setErrorMessage(result.errorMessage ?? t("无法读取桌面调用档案"));
          return;
        }
        setDetails(result.value);
      })
      .catch((error: unknown) => {
        if (requestId === detailRequestRef.current) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : t("无法读取桌面调用档案"),
          );
        }
      })
      .finally(() => {
        if (requestId === detailRequestRef.current) {
          setLoadingDetails(false);
        }
      });
    return () => {
      detailRequestRef.current += 1;
    };
  }, [selectedId]);

  function selectSnapshot(snapshot: PersistedInvocationSnapshotSummary): void {
    setSelectedId(snapshot.id);
    setSearchParams({}, { replace: true });
    setDeleteOpen(false);
    setDeleteConfirmed(false);
  }

  function submitQuery(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setOffset(0);
    setAppliedQuery(draftQuery.trim());
    setSearchParams({}, { replace: true });
  }

  function resetFilters(): void {
    setDraftQuery("");
    setAppliedQuery("");
    setOutcome("ALL");
    setScope("ALL");
    setTargetScope("ALL");
    setOffset(0);
    setSearchParams({}, { replace: true });
  }

  async function deleteSnapshot(): Promise<void> {
    if (!details || !deleteConfirmed) {
      return;
    }
    setDeleting(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.deletePersistedInvocationSnapshot(
        details.id,
        true,
      );
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("无法删除桌面调用档案"));
        return;
      }
      setDeleteOpen(false);
      setDeleteConfirmed(false);
      setSelectedId(null);
      setDetails(null);
      setSearchParams({}, { replace: true });
      setOffset((current) =>
        page.items.length === 1 ? Math.max(0, current - PAGE_SIZE) : current,
      );
      listRequestRef.current += 1;
      const refreshed = await window.tanwei.queryPersistedInvocationSnapshots({
        offset: page.items.length === 1 ? Math.max(0, offset - PAGE_SIZE) : offset,
        limit: PAGE_SIZE,
        query: appliedQuery,
        targetId: effectiveTargetId,
        outcome,
        scope,
      });
      if (refreshed.ok && refreshed.value) {
        setPage(refreshed.value);
        setSelectedId(refreshed.value.items[0]?.id ?? null);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法删除桌面调用档案"),
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="page space-y-6" data-testid="persisted-snapshots-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">DESKTOP INVOCATION ARCHIVE</p>
          <h1>{t("调用已经结束，证据仍然在。")}</h1>
        </div>
        <div className="flex flex-col items-end gap-3">
          <p className="page-heading__summary">
            {t(
              "跨桌面会话检索显式固定的调用快照；Host 重新读取并脱敏，断开目标后仍可检查。",
            )}
          </p>
          <Button type="button" variant="outline" onClick={() => void navigate("/snapshots")}>
            {t("返回会话快照")}
          </Button>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={t("本地保留")} value={page.retained} icon={<Archive />} testId="archive-retained" />
        <MetricCard label={t("正常返回")} value={page.returned} icon={<CheckCircle2 />} testId="archive-returned" />
        <MetricCard label={t("抛出异常")} value={page.threw} icon={<TriangleAlert />} testId="archive-threw" />
        <MetricCard label={t("估算空间")} value={formatBytes(page.estimatedBytes)} icon={<Database />} testId="archive-bytes" />
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("筛选桌面调用档案")}</CardTitle>
          <CardDescription>{t("搜索类、方法、线程、参数、返回值或异常。")}</CardDescription>
          <CardAction>
            <Button type="button" variant="ghost" onClick={resetFilters}>
              <RefreshCw />
              {t("重置")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 xl:grid-cols-[minmax(18rem,1fr)_12rem_12rem_14rem_auto]" onSubmit={submitQuery}>
            <div className="grid gap-2">
              <Label htmlFor="snapshot-archive-query">{t("搜索档案")}</Label>
              <Input
                id="snapshot-archive-query"
                type="search"
                maxLength={256}
                value={draftQuery}
                placeholder={t("例如类名、方法、线程或异常")}
                onChange={(event) => setDraftQuery(event.target.value)}
              />
            </div>
            <FilterSelect
              label={t("调用结果")}
              value={outcome}
              onValueChange={(value) => {
                if (value === "ALL" || value === "RETURNED" || value === "THREW") {
                  setOutcome(value);
                  setOffset(0);
                }
              }}
              items={[["ALL", t("全部结果")], ["RETURNED", t("正常返回")], ["THREW", t("抛出异常")]]}
            />
            <FilterSelect
              label={t("调用层级")}
              value={scope}
              onValueChange={(value) => {
                if (value === "ROOT" || value === "ALL") {
                  setScope(value);
                  setOffset(0);
                }
              }}
              items={[["ALL", t("包含内部调用")], ["ROOT", t("仅根调用")]]}
            />
            <FilterSelect
              label={t("目标范围")}
              value={targetScope}
              onValueChange={(value) => {
                if (value === "ALL" || (value === "CURRENT" && selectedTargetId)) {
                  setTargetScope(value);
                  setOffset(0);
                }
              }}
              items={[["ALL", t("全部目标")], ["CURRENT", selectedTargetId ? t("当前目标") : t("当前没有目标"), !selectedTargetId]]}
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

      <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(0,1.55fr)_minmax(24rem,0.85fr)]">
        <Card className="min-w-0">
          <CardHeader className="border-b">
            <CardTitle>{t("调用时间索引")}</CardTitle>
            <CardDescription>{t("按捕获时间倒序；每页最多 {count} 条。", { count: PAGE_SIZE })}</CardDescription>
            <CardAction><Badge variant="secondary">{t("{start}–{end} / {total}", { start: pageStart, end: pageEnd, total: page.total })}</Badge></CardAction>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">{t("类与方法")}</TableHead>
                  <TableHead>{t("结果")}</TableHead>
                  <TableHead>{t("耗时")}</TableHead>
                  <TableHead>{t("捕获时间")}</TableHead>
                  <TableHead className="pr-6 text-right">{t("详情")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && page.items.length === 0
                  ? Array.from({ length: 5 }, (_, index) => (
                      <TableRow key={index}><TableCell className="pl-6" colSpan={5}><Skeleton className="h-9 w-full" /></TableCell></TableRow>
                    ))
                  : page.items.map((snapshot) => (
                      <TableRow key={snapshot.id} data-state={selectedId === snapshot.id ? "selected" : undefined}>
                        <TableCell className="max-w-96 pl-6">
                          <div className="truncate font-mono text-sm font-medium" title={snapshot.className}>{snapshot.className}</div>
                          <div className="text-muted-foreground truncate font-mono text-xs" title={snapshot.method}>{snapshot.method}</div>
                        </TableCell>
                        <TableCell><Badge variant={snapshot.outcome === "THREW" ? "destructive" : "secondary"}>{snapshot.outcome === "THREW" ? t("异常") : t("返回")}</Badge></TableCell>
                        <TableCell>{formatDuration(snapshot.durationNanos)}</TableCell>
                        <TableCell className="whitespace-nowrap">{formatDateTime(snapshot.capturedAtEpochMillis)}</TableCell>
                        <TableCell className="pr-6 text-right"><Button type="button" size="sm" variant="ghost" aria-label={t("查看 {method} 调用档案", { method: snapshot.method })} onClick={() => selectSnapshot(snapshot)}>{t("查看")}</Button></TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
            {!loading && page.items.length === 0 && (
              <div className="text-muted-foreground grid min-h-48 place-items-center px-6 text-center text-sm">
                <div><Archive className="mx-auto mb-3 size-6" /><p className="text-foreground font-medium">{t("还没有匹配的桌面调用档案。")}</p><p>{t("在会话快照详情中选择“固定到桌面”。")}</p></div>
              </div>
            )}
          </CardContent>
          <CardFooter className="justify-between border-t">
            <StatePagination
              ariaLabel={t("桌面调用档案分页")}
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

        <SnapshotDetailCard details={details} loading={loadingDetails} onDelete={() => setDeleteOpen(true)} />
      </div>

      <Dialog open={deleteOpen} onOpenChange={(open) => { setDeleteOpen(open); if (!open) setDeleteConfirmed(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("删除桌面调用档案？")}</DialogTitle>
            <DialogDescription>{t("只删除本地副本，不影响原始调用、目标 JVM 或 Agent 会话。")}</DialogDescription>
          </DialogHeader>
          <Label className="flex items-start gap-3 rounded-md border p-3">
            <Checkbox checked={deleteConfirmed} onCheckedChange={(checked) => setDeleteConfirmed(checked === true)} />
            <span>{t("我确认永久删除这条本地调用档案。")}</span>
          </Label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteOpen(false)}>{t("取消")}</Button>
            <Button type="button" variant="destructive" disabled={!deleteConfirmed || deleting} onClick={() => void deleteSnapshot()}>{deleting ? t("删除中…") : t("删除档案")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

interface MetricCardProps {
  readonly label: string;
  readonly value: string | number;
  readonly icon: React.ReactNode;
  readonly testId: string;
}

function MetricCard({ label, value, icon, testId }: MetricCardProps) {
  return (
    <Card className="gap-3 py-5" data-testid={testId}>
      <CardHeader className="grid-cols-[1fr_auto] px-5"><CardDescription>{label}</CardDescription><span className="text-muted-foreground [&>svg]:size-4">{icon}</span></CardHeader>
      <CardContent className="px-5"><strong className="text-2xl tracking-tight">{typeof value === "number" ? formatNumber(value) : value}</strong></CardContent>
    </Card>
  );
}

interface FilterSelectProps {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly items: ReadonlyArray<readonly [string, string, boolean?]>;
}

function FilterSelect({ label, value, onValueChange, items }: FilterSelectProps) {
  const id = `snapshot-archive-${label}`;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
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

interface SnapshotDetailCardProps {
  readonly details: PersistedInvocationSnapshot | null;
  readonly loading: boolean;
  readonly onDelete: () => void;
}

function SnapshotDetailCard({ details, loading, onDelete }: SnapshotDetailCardProps) {
  if (loading) {
    return <Card data-testid="snapshot-archive-detail"><CardHeader><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-64" /></CardHeader><CardContent className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></CardContent></Card>;
  }
  if (!details) {
    return <Card data-testid="snapshot-archive-detail"><CardContent className="text-muted-foreground grid min-h-72 place-items-center text-center text-sm"><div><Archive className="mx-auto mb-3 size-6" /><p className="text-foreground font-medium">{t("选择一条档案查看完整上下文。")}</p><p>{t("档案不依赖当前目标连接。")}</p></div></CardContent></Card>;
  }
  return (
    <Card data-testid="snapshot-archive-detail" className="min-w-0 self-start">
      <CardHeader className="border-b">
        <CardTitle className="truncate font-mono" title={details.className}>{details.className}</CardTitle>
        <CardDescription className="truncate font-mono" title={details.method}>{details.method}</CardDescription>
        <CardAction><Badge variant={details.outcome === "THREW" ? "destructive" : "secondary"}>{details.outcome}</Badge></CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <DetailFact label={t("捕获时间")} value={formatDateTime(details.capturedAtEpochMillis)} />
          <DetailFact label={t("固定时间")} value={formatDateTime(details.savedAt)} />
          <DetailFact label={t("耗时")} value={formatDuration(details.durationNanos)} />
          <DetailFact label={t("线程")} value={details.threadName || t("未知")} />
          <DetailFact label={t("目标 ID")} value={details.targetId} mono />
          <DetailFact label={t("JVM 启动周期")} value={formatDateTime(details.jvmStartTimeEpochMillis)} />
        </dl>
        <section className="rounded-lg border p-4">
          <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">{details.outcome === "THREW" ? t("异常") : t("返回值")}</p>
          <code className="block break-all text-sm">{details.outcome === "THREW" ? details.exceptionType : (details.returnValue || t("空值"))}</code>
          {details.exceptionMessage && <p className="text-muted-foreground mt-2 break-words text-sm">{details.exceptionMessage}</p>}
        </section>
        <DetailList title={t("参数")} empty={t("此调用没有参数。")} items={details.arguments} />
        <DetailList title={t("来源栈")} empty={t("没有可用的来源栈。")} items={details.callStack} />
        <p className="text-muted-foreground text-xs">{t("保存时由 Host 再次遮罩疑似凭据；桌面档案始终只读，不直接用于重放。")}</p>
      </CardContent>
      <CardFooter className="justify-end border-t"><Button type="button" variant="destructive" onClick={onDelete}><Trash2 />{t("删除档案")}</Button></CardFooter>
    </Card>
  );
}

function DetailFact({ label, value, mono = false }: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return <div className="min-w-0"><dt className="text-muted-foreground text-xs">{label}</dt><dd className={mono ? "truncate font-mono text-xs" : "truncate"} title={value}>{value}</dd></div>;
}

function DetailList({ title, empty, items }: { readonly title: string; readonly empty: string; readonly items: readonly string[] }) {
  return (
    <section>
      <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">{title} · {items.length}</p>
      {items.length > 0 ? <ol className="max-h-64 space-y-2 overflow-auto rounded-lg border p-3">{items.map((item, index) => <li key={`${index}:${item}`} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2 text-sm"><span className="text-muted-foreground text-right tabular-nums">{index + 1}</span><code className="break-all">{item}</code></li>)}</ol> : <p className="text-muted-foreground text-sm">{empty}</p>}
    </section>
  );
}

function normalizeSnapshotId(value: string | null): string | null {
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
    ? value
    : null;
}

function formatDuration(durationNanos: number): string {
  if (durationNanos < 1_000) return `${durationNanos} ns`;
  if (durationNanos < 1_000_000) return `${(durationNanos / 1_000).toFixed(2)} µs`;
  return `${(durationNanos / 1_000_000).toFixed(2)} ms`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
