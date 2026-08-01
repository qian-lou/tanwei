import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  Activity,
  Braces,
  Code2,
  MapPin,
  RotateCcw,
  ShieldCheck,
  Target,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import type { ActionResult } from "@shared/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import RiskPill from "../components/RiskPill";
import { formatDateTime, t, useLocale } from "../i18n";
import { useObservationsStore } from "../stores/observations";
import { selectConnection, useTargetsStore } from "../stores/targets";

export interface LineLocalValue {
  readonly name: string;
  readonly value: string;
}

export interface LineEvent {
  readonly sequence: number;
  readonly capturedAtEpochMillis: number;
  readonly threadName: string;
  readonly className: string;
  readonly method: string;
  readonly lineNumber: number;
  readonly locals: readonly LineLocalValue[];
  readonly callStack: readonly string[];
}

export interface LineEventBatch {
  readonly taskId: string;
  readonly state: string;
  readonly captured: number;
  readonly dropped: number;
  readonly events: readonly LineEvent[];
}

const POLL_INTERVAL_MILLIS = 500;
const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseBoundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : minimum;
}

export function parseLineBatch(result: ActionResult): LineEventBatch {
  const { values } = result;
  const taskId = values.taskId ?? "";
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(t("Agent 返回的行探针任务标识无效"));
  }
  const eventCount = parseBoundedInteger(values["event.count"], 0, 100);
  const events = Array.from({ length: eventCount }, (_, eventIndex) => {
    const prefix = `event.${String(eventIndex).padStart(4, "0")}.`;
    const localCount = parseBoundedInteger(
      values[`${prefix}local.count`],
      0,
      32,
    );
    const stackCount = parseBoundedInteger(
      values[`${prefix}stack.count`],
      0,
      12,
    );
    return {
      sequence: parseBoundedInteger(values[`${prefix}sequence`], 1, 100),
      capturedAtEpochMillis: parseBoundedInteger(
        values[`${prefix}capturedAtEpochMillis`],
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      threadName: values[`${prefix}threadName`] ?? "",
      className: values[`${prefix}className`] ?? "",
      method: values[`${prefix}method`] ?? "",
      lineNumber: parseBoundedInteger(
        values[`${prefix}lineNumber`],
        1,
        1_000_000,
      ),
      locals: Array.from({ length: localCount }, (_, localIndex) => {
        const localPrefix = `${prefix}local.${String(localIndex).padStart(2, "0")}.`;
        return {
          name: values[`${localPrefix}name`] ?? `local${localIndex}`,
          value: values[`${localPrefix}value`] ?? "",
        };
      }),
      callStack: Array.from(
        { length: stackCount },
        (_, stackIndex) =>
          values[`${prefix}stack.${String(stackIndex).padStart(2, "0")}`] ?? "",
      ).filter(Boolean),
    } satisfies LineEvent;
  });
  return {
    taskId,
    state: values.state ?? "UNKNOWN",
    captured: parseBoundedInteger(values.captured, 0, 100),
    dropped: parseBoundedInteger(values.dropped, 0, Number.MAX_SAFE_INTEGER),
    events,
  };
}

export default function LineView() {
  useLocale();
  const navigate = useNavigate();
  const selectedTargetId = useTargetsStore((state) => state.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const selection = useObservationsStore((state) => state.selection);
  const [lineNumber, setLineNumber] = useState(1);
  const [maximumEvents, setMaximumEvents] = useState(20);
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [preview, setPreview] = useState<ActionResult | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskState, setTaskState] = useState<string | null>(null);
  const [captured, setCaptured] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [events, setEvents] = useState<readonly LineEvent[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingInFlightRef = useRef(false);
  const taskIdRef = useRef<string | null>(null);
  const targetIdRef = useRef<string | null>(null);
  taskIdRef.current = taskId;
  targetIdRef.current = selectedTargetId;

  const capability = connection?.capabilities.find(
    (candidate) => candidate.id === "line-probe",
  );
  const boundariesValid =
    Number.isInteger(lineNumber) &&
    lineNumber >= 1 &&
    lineNumber <= 1_000_000 &&
    Number.isInteger(maximumEvents) &&
    maximumEvents >= 1 &&
    maximumEvents <= 100 &&
    Number.isInteger(timeoutSeconds) &&
    timeoutSeconds >= 1 &&
    timeoutSeconds <= 60;
  const canOperate =
    connection?.state === "READY" &&
    capability?.state === "AVAILABLE" &&
    selectedTargetId !== null &&
    selection !== null &&
    boundariesValid;

  function selectionParameters(): Readonly<Record<string, string>> | null {
    const currentSelection = useObservationsStore.getState().selection;
    if (!currentSelection) {
      return null;
    }
    return {
      className: currentSelection.className,
      classLoader: currentSelection.classLoader,
      methodName: currentSelection.method.name,
      parameterTypes: currentSelection.method.parameterTypes.join(","),
      lineNumber: String(lineNumber),
    };
  }

  async function previewLine(): Promise<void> {
    const parameters = selectionParameters();
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!parameters || !targetId || !boundariesValid) {
      return;
    }
    setLoading("preview");
    setErrorMessage(null);
    setPreview(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "line.preview",
        parameters,
      });
      if (
        !response.ok ||
        !response.value ||
        response.value.status !== "SUCCEEDED"
      ) {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法预检源码行探针"),
        );
        return;
      }
      setPreview(response.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法预检源码行探针"),
      );
    } finally {
      setLoading(null);
    }
  }

  async function startLineProbe(): Promise<void> {
    const parameters = selectionParameters();
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!parameters || !targetId || !boundariesValid || !preview) {
      return;
    }
    setLoading("start");
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "line.start",
        parameters: {
          ...parameters,
          maximumEvents: String(maximumEvents),
          timeoutMillis: String(timeoutSeconds * 1_000),
          confirmed: "true",
        },
      });
      if (
        !response.ok ||
        !response.value ||
        response.value.status !== "SUCCEEDED"
      ) {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法启动源码行探针"),
        );
        return;
      }
      const nextTaskId = response.value.values.taskId ?? "";
      if (!TASK_ID_PATTERN.test(nextTaskId)) {
        setErrorMessage(t("Agent 返回的行探针任务标识无效"));
        return;
      }
      setTaskId(nextTaskId);
      setTaskState("RUNNING");
      setCaptured(0);
      setDropped(0);
      setEvents([]);
      startPolling();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法启动源码行探针"),
      );
    } finally {
      setLoading(null);
    }
  }

  async function pollEvents(): Promise<void> {
    const currentTaskId = taskIdRef.current;
    const currentTargetId = targetIdRef.current;
    if (!currentTaskId || !currentTargetId || pollingInFlightRef.current) {
      return;
    }
    pollingInFlightRef.current = true;
    try {
      const response = await window.tanwei.executeAction({
        targetId: currentTargetId,
        actionId: "line.events",
        parameters: { taskId: currentTaskId, limit: "100" },
      });
      if (
        !response.ok ||
        !response.value ||
        response.value.status !== "SUCCEEDED"
      ) {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取源码行事件"),
        );
        stopPolling();
        return;
      }
      const batch = parseLineBatch(response.value);
      setTaskState(batch.state);
      setCaptured(batch.captured);
      setDropped(batch.dropped);
      if (batch.events.length > 0) {
        setEvents((current) => {
          const bySequence = new Map(
            current.map((event) => [event.sequence, event] as const),
          );
          for (const event of batch.events) {
            bySequence.set(event.sequence, event);
          }
          return [...bySequence.values()]
            .sort((left, right) => left.sequence - right.sequence)
            .slice(-100);
        });
      }
      if (batch.state !== "RUNNING") {
        stopPolling();
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取源码行事件"),
      );
      stopPolling();
    } finally {
      pollingInFlightRef.current = false;
    }
  }

  async function cancelLineProbe(): Promise<void> {
    const currentTaskId = taskIdRef.current;
    const currentTargetId = targetIdRef.current;
    if (!currentTaskId || !currentTargetId) {
      return;
    }
    setLoading("cancel");
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: currentTargetId,
        actionId: "tasks.cancel",
        parameters: {
          kind: "LINE",
          taskId: currentTaskId,
          confirmed: "true",
        },
      });
      if (
        !response.ok ||
        !response.value ||
        response.value.status !== "SUCCEEDED"
      ) {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法停止源码行探针"),
        );
        return;
      }
      setTaskState(response.value.values.state ?? "CANCELLED");
      stopPolling();
      await pollEvents();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法停止源码行探针"),
      );
    } finally {
      setLoading(null);
    }
  }

  function startPolling(): void {
    stopPolling();
    void pollEvents();
    pollingTimerRef.current = setInterval(
      () => void pollEvents(),
      POLL_INTERVAL_MILLIS,
    );
  }

  function stopPolling(): void {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }

  useEffect(() => {
    if (taskState === "RUNNING") {
      startPolling();
    }
    return stopPolling;
  }, []);

  return (
    <section className="page line-view space-y-6">
      <header className="page-heading">
        <div>
          <p className="eyebrow">SOURCE LINE</p>
          <h1>{t("在精确源码行冻结一份安全现场。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "探针绑定类、ClassLoader、完整方法签名与行号；局部变量不调用业务 toString，并自动脱敏敏感名称。",
          )}
        </p>
      </header>

      {connection?.state !== "READY" ? (
        <LineEmptyState
          icon={<Unplug />}
          title={t("连接目标后设置源码行探针。")}
          description={t("源码行探针需要一个已经完成 Attach 的目标 JVM。")}
          actionLabel={t("选择目标")}
          onAction={() => void navigate("/targets")}
        />
      ) : capability?.state !== "AVAILABLE" ? (
        <LineEmptyState
          icon={<TriangleAlert />}
          title={t("当前目标不支持源码行探针。")}
          description={capability?.reason ?? t("目标 JVM 不支持类重转换。")}
          actionLabel={t("返回概览")}
          onAction={() => void navigate("/overview")}
        />
      ) : !selection ? (
        <LineEmptyState
          icon={<Target />}
          title={t("先从类详情选择一个方法。")}
          description={t("方法选择会保留精确 ClassLoader 与完整参数签名。")}
          actionLabel={t("浏览已加载类")}
          onAction={() => void navigate("/classes")}
        />
      ) : (
        <>
          {errorMessage && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>{t("源码行操作未完成")}</AlertTitle>
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(0,1.35fr)_minmax(24rem,0.65fr)]">
            <Card className="min-w-0 gap-0">
              <CardHeader className="border-b">
                <div className="flex items-center gap-3">
                  <span className="bg-primary/10 text-primary grid size-9 place-items-center rounded-lg">
                    <Target className="size-4" />
                  </span>
                  <div className="grid min-w-0 gap-1">
                    <CardTitle>{t("精确方法身份")}</CardTitle>
                    <CardDescription>
                      {t("只增强下面的方法与源码行。")}
                    </CardDescription>
                  </div>
                </div>
                <CardAction>
                  <Badge variant="outline">EXACT MATCH</Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="grid gap-4 py-5">
                <IdentityField label={t("类")} value={selection.className} />
                <IdentityField
                  label={t("方法签名")}
                  value={`${selection.method.returnType} ${selection.method.name}(${selection.method.parameterTypes.join(", ")})`}
                />
                <IdentityField
                  label="CLASSLOADER"
                  value={selection.classLoader}
                />
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="border-b">
                <div className="grid gap-1">
                  <CardTitle>{t("探针边界")}</CardTitle>
                  <CardDescription>
                    {t("行号、事件和时间均有固定预算。")}
                  </CardDescription>
                </div>
                <CardAction>
                  <RiskPill level="R2" compact />
                </CardAction>
              </CardHeader>
              <CardContent className="grid gap-4 py-5 sm:grid-cols-3">
                <NumberField
                  id="line-number"
                  label={t("源码行")}
                  value={lineNumber}
                  minimum={1}
                  maximum={1_000_000}
                  disabled={taskState === "RUNNING"}
                  onChange={(value) => {
                    setLineNumber(value);
                    setPreview(null);
                  }}
                />
                <NumberField
                  id="line-maximum-events"
                  label={t("最多事件")}
                  value={maximumEvents}
                  minimum={1}
                  maximum={100}
                  disabled={taskState === "RUNNING"}
                  onChange={setMaximumEvents}
                />
                <NumberField
                  id="line-timeout-seconds"
                  label={t("超时（秒）")}
                  value={timeoutSeconds}
                  minimum={1}
                  maximum={60}
                  disabled={taskState === "RUNNING"}
                  onChange={setTimeoutSeconds}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="sm:col-span-3"
                  disabled={
                    !canOperate || loading !== null || taskState === "RUNNING"
                  }
                  onClick={() => void previewLine()}
                >
                  {loading === "preview" ? <Spinner /> : <MapPin />}
                  {t("预检源码行")}
                </Button>
              </CardContent>
            </Card>
          </div>

          {preview && (
            <Card className="border-primary/40 bg-primary/5 gap-0">
              <CardHeader>
                <div className="flex items-start gap-3">
                  <span className="bg-primary/10 text-primary grid size-9 place-items-center rounded-lg">
                    <ShieldCheck className="size-4" />
                  </span>
                  <div className="grid min-w-0 gap-1">
                    <CardTitle>
                      {t("已定位 {file}:{line}", {
                        file: preview.values.sourceFile || t("未知源码"),
                        line: preview.values.lineNumber ?? lineNumber,
                      })}
                    </CardTitle>
                    <CardDescription className="break-all font-mono">
                      {preview.values.method}
                    </CardDescription>
                    <p className="text-muted-foreground text-xs">
                      {t("字节码位置 {points} · 最多 {locals} 个局部变量", {
                        points: preview.values.probePointCount ?? "0",
                        locals: preview.values.maximumLocalCount ?? "0",
                      })}
                    </p>
                  </div>
                </div>
                <CardAction>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={loading !== null || taskState === "RUNNING"}
                    onClick={() => void startLineProbe()}
                  >
                    {loading === "start" ? <Spinner /> : <Activity />}
                    {t("确认增强并开始")}
                  </Button>
                </CardAction>
              </CardHeader>
            </Card>
          )}

          {taskId && (
            <Card className="gap-0">
              <CardHeader className="border-b">
                <div className="grid min-w-0 gap-1">
                  <CardTitle>{t("源码行探针任务")}</CardTitle>
                  <CardDescription className="break-all font-mono">
                    {taskId}
                  </CardDescription>
                </div>
                <CardAction>
                  <Badge
                    variant={taskState === "RUNNING" ? "secondary" : "outline"}
                  >
                    {taskState ?? "UNKNOWN"}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-3 py-5">
                <Badge variant="secondary">
                  {t("已捕获 {captured}", { captured })}
                </Badge>
                <Badge variant={dropped > 0 ? "destructive" : "outline"}>
                  {t("已丢弃 {dropped}", { dropped })}
                </Badge>
              </CardContent>
              {taskState === "RUNNING" && (
                <CardFooter className="justify-end border-t py-4">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading !== null}
                    onClick={() => void cancelLineProbe()}
                  >
                    {loading === "cancel" ? <Spinner /> : <RotateCcw />}
                    {t("取消并回滚增强")}
                  </Button>
                </CardFooter>
              )}
            </Card>
          )}

          <Card className="min-w-0 gap-0 overflow-hidden">
            <CardHeader className="border-b">
              <div className="flex items-start gap-3">
                <span className="bg-muted text-muted-foreground grid size-9 place-items-center rounded-lg">
                  <Code2 className="size-4" />
                </span>
                <div className="grid gap-1">
                  <CardTitle>{t("源码行现场")}</CardTitle>
                  <CardDescription>
                    {t("显示安全渲染的局部变量与最多 12 层调用栈。")}
                  </CardDescription>
                </div>
              </div>
              <CardAction>
                <Badge variant="secondary">{events.length}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-4 p-4">
              {events.map((event) => (
                <LineEventCard key={event.sequence} event={event} />
              ))}
              {events.length === 0 && (
                <Empty className="min-h-48 py-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Braces />
                    </EmptyMedia>
                    <EmptyTitle>{t("等待源码行命中")}</EmptyTitle>
                    <EmptyDescription>
                      {t("目标方法执行到所选行后，安全现场会显示在这里。")}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}

function IdentityField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        {label}
      </span>
      <code className="break-all text-sm">{value}</code>
    </div>
  );
}

interface NumberFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}

function NumberField({
  id,
  label,
  value,
  minimum,
  maximum,
  disabled,
  onChange,
}: NumberFieldProps) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={minimum}
        max={maximum}
        value={value}
        disabled={disabled}
        aria-invalid={value < minimum || value > maximum}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function LineEventCard({ event }: { readonly event: LineEvent }) {
  return (
    <article className="grid min-w-0 gap-4 rounded-xl border bg-muted/20 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <strong className="break-all font-mono text-sm">
            {event.className}:{event.lineNumber}
          </strong>
          <span className="text-muted-foreground break-all font-mono text-xs">
            {event.method}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">#{event.sequence}</Badge>
          <Badge variant="secondary">{event.threadName}</Badge>
          <Badge variant="outline">
            {formatDateTime(event.capturedAtEpochMillis)}
          </Badge>
        </div>
      </header>
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="grid min-w-0 gap-2">
          <h3 className="text-sm font-semibold">{t("局部变量")}</h3>
          {event.locals.length > 0 ? (
            <dl className="grid min-w-0 gap-2">
              {event.locals.map((local, index) => (
                <div
                  key={`${local.name}:${index}`}
                  className="grid min-w-0 grid-cols-[minmax(6rem,0.35fr)_minmax(0,1fr)] gap-3 rounded-md border bg-background/60 px-3 py-2"
                >
                  <dt className="truncate font-mono text-xs font-semibold">
                    {local.name}
                  </dt>
                  <dd className="break-all font-mono text-xs">{local.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("该位置没有可用的局部变量表，仅保留调用栈。")}
            </p>
          )}
        </section>
        <section className="grid min-w-0 gap-2">
          <h3 className="text-sm font-semibold">{t("调用栈")}</h3>
          {event.callStack.length > 0 ? (
            <ol className="grid min-w-0 gap-1 rounded-md border bg-background/60 p-3">
              {event.callStack.map((frame, index) => (
                <li
                  key={`${frame}:${index}`}
                  className="break-all font-mono text-xs"
                >
                  {frame}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground text-sm">{t("无可用堆栈")}</p>
          )}
        </section>
      </div>
    </article>
  );
}

interface LineEmptyStateProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}

function LineEmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: LineEmptyStateProps) {
  return (
    <Empty className="min-h-72 border py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <Button type="button" variant="outline" onClick={onAction}>
        {actionLabel}
      </Button>
    </Empty>
  );
}
