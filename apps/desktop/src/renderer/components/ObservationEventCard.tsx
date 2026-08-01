import {
  ChevronRight,
  Clock3,
  Play,
  RotateCw,
  ShieldAlert,
} from "lucide-react";
import type { ActionResult, ObservationEvent } from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Disclosure } from "@/components/ui/disclosure";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, t } from "../i18n";

interface ObservationEventCardProps {
  readonly event: ObservationEvent;
  readonly replayable: boolean;
  readonly loading: string | null;
  readonly replayEventSequence: number | null;
  readonly replayPreview: ActionResult | null;
  readonly replayResult: ActionResult | null;
  readonly replayConfirmed: boolean;
  readonly replaySecondaryConfirmed: boolean;
  readonly onPreviewReplay: (event: ObservationEvent) => void;
  readonly onExecuteReplay: (event: ObservationEvent) => void;
  readonly onReplayConfirmedChange: (checked: boolean) => void;
  readonly onReplaySecondaryConfirmedChange: (checked: boolean) => void;
}

export default function ObservationEventCard({
  event,
  replayable,
  loading,
  replayEventSequence,
  replayPreview,
  replayResult,
  replayConfirmed,
  replaySecondaryConfirmed,
  onPreviewReplay,
  onExecuteReplay,
  onReplayConfirmedChange,
  onReplaySecondaryConfirmedChange,
}: ObservationEventCardProps) {
  const replayOpen = replayEventSequence === event.eventId && replayPreview;
  const returned = !event.exceptionType;
  const phaseLabel =
    event.phase === "BEFORE"
      ? t("进入前")
      : event.phase === "RETURN"
        ? t("正常返回")
        : event.phase === "THROW"
          ? t("异常退出")
          : t("完成");
  const parentLabel =
    event.parentSequence === null
      ? t("根调用")
      : t("父事件 #{sequence}", { sequence: event.parentSequence });

  return (
    <Disclosure
      className="event-row group border-b last:border-b-0"
      triggerClassName="hover:bg-muted/40 focus-visible:ring-ring/50 grid min-h-16 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-none px-6 py-3 text-left outline-none transition-colors focus-visible:ring-2"
      trigger={
        <>
          <ChevronRight className="text-muted-foreground size-4 transition-transform group-data-[state=open]:rotate-90" />
          <span className="min-w-0">
            <span className="text-muted-foreground mb-1 flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline">#{event.sequence}</Badge>
              <Badge variant="secondary">{phaseLabel}</Badge>
              <span>
                {t("深度 {depth} · {parent}", {
                  depth: event.depth,
                  parent: parentLabel,
                })}
              </span>
              <span>·</span>
              <span className="truncate">{event.threadName}</span>
            </span>
            <span className="block truncate font-mono text-sm font-medium">
              {event.method}
            </span>
          </span>
          <span className="flex items-center gap-3">
            <Badge variant={returned ? "secondary" : "destructive"}>
              {event.phase === "BEFORE"
                ? t("入参快照")
                : returned
                  ? t("正常返回")
                  : t("抛出异常")}
            </Badge>
            <span className="text-muted-foreground flex min-w-24 items-center justify-end gap-1 font-mono text-xs tabular-nums">
              <Clock3 className="size-3" />
              {(event.durationNanos / 1_000_000).toFixed(3)} ms
            </span>
          </span>
        </>
      }
    >
      <div className="bg-muted/15 grid gap-5 border-t px-6 py-5">
        <dl className="grid gap-4 lg:grid-cols-2">
          <EvidenceField label={t("方法")} value={event.method} />
          <EvidenceField
            label={t("时间")}
            value={formatDateTime(event.capturedAt)}
          />
          <EvidenceField
            label={t("参数")}
            value={event.arguments.join(" · ") || t("无")}
          />
          {event.phase === "BEFORE" ? (
            <EvidenceField label={t("返回")} value={t("进入时不可用")} />
          ) : event.exceptionType ? (
            <EvidenceField
              label={t("异常")}
              value={`${event.exceptionType} · ${event.exceptionMessage}`}
              destructive
            />
          ) : (
            <EvidenceField
              label={t("返回")}
              value={event.returnValue ?? "null"}
            />
          )}
        </dl>

        <div className="grid gap-2">
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            {t("调用来源")}
          </p>
          {event.callStack.length > 0 ? (
            <ScrollArea className="h-40 rounded-md border bg-background/60">
              <ol className="grid gap-1 p-3 font-mono text-xs leading-5">
                {event.callStack.map((frame, index) => (
                  <li
                    key={`${event.eventId}-caller-${index}`}
                    className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2"
                  >
                    <span className="text-muted-foreground text-right tabular-nums">
                      {index + 1}
                    </span>
                    <span className="break-all">{frame}</span>
                  </li>
                ))}
              </ol>
            </ScrollArea>
          ) : (
            <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-sm">
              {t("不可用")}
            </p>
          )}
        </div>

        {replayable && event.phase !== "BEFORE" && (
          <Card className="replay-panel border-destructive/40 bg-destructive/5 gap-0 shadow-none">
            <CardHeader className="border-b border-destructive/20">
              <div className="flex items-start gap-3">
                <span className="bg-destructive/10 text-destructive grid size-9 shrink-0 place-items-center rounded-lg">
                  <ShieldAlert className="size-4" />
                </span>
                <div className="grid gap-1">
                  <CardTitle>{t("受控调用重放")}</CardTitle>
                  <CardDescription>
                    {t(
                      "仅公开静态方法和完整标量参数可重放。目标代码可能产生不可逆业务副作用。",
                    )}
                  </CardDescription>
                </div>
              </div>
              <CardAction>
                <Button
                  type="button"
                  variant="outline"
                  disabled={loading !== null}
                  onClick={() => onPreviewReplay(event)}
                >
                  {loading === `replay-preview-${event.eventId}` ? (
                    <Spinner />
                  ) : (
                    <RotateCw />
                  )}
                  {t("为此快照生成重放预览")}
                </Button>
              </CardAction>
            </CardHeader>

            {replayOpen && (
              <CardContent className="grid gap-4 py-5">
                <dl className="replay-panel__preview grid gap-3">
                  <EvidenceField
                    label={t("最终调用")}
                    value={replayPreview.values.invocation ?? ""}
                  />
                  <EvidenceField
                    label={t("精确目标")}
                    value={`${replayPreview.values.classLoader ?? ""} · ${replayPreview.values.method ?? ""}`}
                  />
                  <EvidenceField
                    label={t("预检指纹")}
                    value={replayPreview.values.fingerprint ?? ""}
                  />
                  <EvidenceField
                    label={t("中断边界")}
                    value={replayPreview.values.boundary ?? ""}
                  />
                </dl>

                <Separator />

                <ReplayConfirmation
                  id={`replay-primary-${event.eventId}`}
                  checked={replayConfirmed}
                  label={t(
                    "我已核对目标、参数和最终调用，并理解该方法会再次真实执行。",
                  )}
                  onChange={onReplayConfirmedChange}
                />
                <ReplayConfirmation
                  id={`replay-secondary-${event.eventId}`}
                  checked={replaySecondaryConfirmed}
                  label={t(
                    "我再次确认接受业务副作用，且超时或中断不保证目标代码停止。",
                  )}
                  onChange={onReplaySecondaryConfirmedChange}
                />

                <Button
                  type="button"
                  variant="destructive"
                  className="justify-self-start"
                  disabled={
                    loading !== null ||
                    !replayConfirmed ||
                    !replaySecondaryConfirmed
                  }
                  onClick={() => onExecuteReplay(event)}
                >
                  {loading === `replay-execute-${event.eventId}` ? (
                    <Spinner />
                  ) : (
                    <Play />
                  )}
                  {t("二次确认并执行重放")}
                </Button>

                {replayResult && (
                  <dl className="replay-panel__result grid gap-3 rounded-lg border bg-background/70 p-4">
                    {Object.entries(replayResult.values).map(([key, value]) => (
                      <EvidenceField key={key} label={key} value={value} />
                    ))}
                  </dl>
                )}
              </CardContent>
            )}
          </Card>
        )}
      </div>
    </Disclosure>
  );
}

interface EvidenceFieldProps {
  readonly label: string;
  readonly value: string;
  readonly destructive?: boolean;
}

function EvidenceField({
  label,
  value,
  destructive = false,
}: EvidenceFieldProps) {
  return (
    <div className="grid min-w-0 gap-1">
      <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        {label}
      </dt>
      <dd
        className={
          destructive
            ? "text-destructive m-0 break-all font-mono text-xs leading-5"
            : "m-0 break-all font-mono text-xs leading-5"
        }
      >
        {value}
      </dd>
    </div>
  );
}

interface ReplayConfirmationProps {
  readonly id: string;
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}

function ReplayConfirmation({
  id,
  checked,
  label,
  onChange,
}: ReplayConfirmationProps) {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-background/60 p-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(nextValue) => onChange(nextValue === true)}
      />
      <Label htmlFor={id} className="cursor-pointer text-sm leading-5">
        {label}
      </Label>
    </div>
  );
}
