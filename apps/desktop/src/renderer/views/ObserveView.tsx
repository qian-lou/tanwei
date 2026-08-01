import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  Activity,
  Clock3,
  Eye,
  GitBranch,
  RotateCcw,
  ShieldCheck,
  Target,
  Timer,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import type { ActionResult, ObservationEvent } from "@shared/contracts";
import {
  serializeObservationCondition,
  type ObservationConditionClause,
} from "@shared/observation-condition";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import ObservationConditionBuilder from "../components/ObservationConditionBuilder";
import ObservationEventCard from "../components/ObservationEventCard";
import RiskPill from "../components/RiskPill";
import { t, useLocale } from "../i18n";
import { useObservationsStore } from "../stores/observations";
import { selectConnection, useTargetsStore } from "../stores/targets";
import {
  DiagnosticTaskPoller,
  type DiagnosticPollResult,
} from "../utils/diagnostic-task-poller";

export default function ObserveView() {
  useLocale();
  const navigate = useNavigate();
  const selectedTargetId = useTargetsStore((s) => s.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const selection = useObservationsStore((s) => s.selection);
  const observationTaskId = useObservationsStore((s) => s.taskId);
  const observationState = useObservationsStore((s) => s.state);
  const events = useObservationsStore((s) => s.events);
  const captured = useObservationsStore((s) => s.captured);
  const dropped = useObservationsStore((s) => s.dropped);
  const [maximumEvents, setMaximumEvents] = useState(20);
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [includeInternal, setIncludeInternal] = useState(true);
  const [watchPhases, setWatchPhases] = useState<
    readonly ObservationEvent["phase"][]
  >(["FINISH"]);
  const [conditionClauses, setConditionClauses] = useState<
    readonly ObservationConditionClause[]
  >([]);
  const [preview, setPreview] = useState<ActionResult | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [replayEventSequence, setReplayEventSequence] = useState<number | null>(
    null,
  );
  const [replayPreview, setReplayPreview] = useState<ActionResult | null>(null);
  const [replayResult, setReplayResult] = useState<ActionResult | null>(null);
  const [replayConfirmed, setReplayConfirmed] = useState(false);
  const [replaySecondaryConfirmed, setReplaySecondaryConfirmed] =
    useState(false);
  const taskPollerRef = useRef<DiagnosticTaskPoller | null>(null);

  const canOperate =
    connection?.state === "READY" &&
    selectedTargetId !== null &&
    selection !== null;
  const boundariesValid =
    Number.isInteger(maximumEvents) &&
    maximumEvents >= 1 &&
    maximumEvents <= 100 &&
    watchPhases.length > 0 &&
    Number.isInteger(timeoutSeconds) &&
    timeoutSeconds >= 1 &&
    timeoutSeconds <= 60;
  const compiledCondition = serializeObservationCondition(conditionClauses);

  const aggregate = (() => {
    const durations = events.map((event) => event.durationNanos);
    if (durations.length === 0) {
      return { count: 0, averageMillis: 0, maximumMillis: 0, failures: 0 };
    }
    const total = durations.reduce((sum, duration) => sum + duration, 0);
    return {
      count: durations.length,
      averageMillis: total / durations.length / 1_000_000,
      maximumMillis: Math.max(...durations) / 1_000_000,
      failures: events.filter((event) => event.exceptionType).length,
    };
  })();

  const replayAvailable = Boolean(
    connection?.capabilities.some(
      (capability) =>
        capability.id === "invoke-replay" && capability.state === "AVAILABLE",
    ),
  );

  function actionParameters(): Readonly<Record<string, string>> | null {
    const currentSelection = useObservationsStore.getState().selection;
    if (!currentSelection) {
      return null;
    }
    return {
      className: currentSelection.className,
      classLoader: currentSelection.classLoader,
      methodName: currentSelection.method.name,
      parameterTypes: currentSelection.method.parameterTypes.join(","),
    };
  }

  function replayParameters(
    event: ObservationEvent,
  ): Readonly<Record<string, string>> | null {
    const parameters = actionParameters();
    if (!parameters || event.arguments.length > 8) {
      return null;
    }
    return event.arguments.reduce<Record<string, string>>(
      (result, argument, index) => {
        result[`argument${index}`] = argument;
        return result;
      },
      {
        ...parameters,
        argumentCount: String(event.arguments.length),
        argument0: "",
        argument1: "",
        argument2: "",
        argument3: "",
        argument4: "",
        argument5: "",
        argument6: "",
        argument7: "",
      },
    );
  }

  function canReplay(event: ObservationEvent): boolean {
    const modifiers = selection?.method.modifiers.split(/\s+/u) ?? [];
    return (
      replayAvailable &&
      event.depth === 0 &&
      event.arguments.length === selection?.method.parameterTypes.length &&
      event.arguments.length <= 8 &&
      event.arguments.every(
        (argument) => argument !== "null" && !argument.endsWith("…"),
      ) &&
      modifiers.includes("public") &&
      modifiers.includes("static")
    );
  }

  async function previewReplay(event: ObservationEvent): Promise<void> {
    const parameters = replayParameters(event);
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!parameters || !targetId) {
      return;
    }
    setLoading(`replay-preview-${event.eventId}`);
    setErrorMessage(null);
    setReplayEventSequence(event.eventId);
    setReplayPreview(null);
    setReplayResult(null);
    setReplayConfirmed(false);
    setReplaySecondaryConfirmed(false);
    try {
      const result = await window.tanwei.executeAction({
        targetId,
        actionId: "invoke.replay.preview",
        parameters,
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ?? result.value?.message ?? t("调用重放预检失败"),
        );
        return;
      }
      setReplayPreview(result.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("调用重放预检失败"),
      );
    } finally {
      setLoading(null);
    }
  }

  async function executeReplay(event: ObservationEvent): Promise<void> {
    const parameters = replayParameters(event);
    const fingerprint = replayPreview?.values.fingerprint;
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (
      !parameters ||
      !fingerprint ||
      !targetId ||
      !replayConfirmed ||
      !replaySecondaryConfirmed
    ) {
      return;
    }
    setLoading(`replay-execute-${event.eventId}`);
    setErrorMessage(null);
    setReplayResult(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId,
        actionId: "invoke.replay",
        parameters: {
          ...parameters,
          expectedFingerprint: fingerprint,
          confirmed: "true",
          confirmedSecondary: "true",
        },
      });
      setReplayResult(result.value);
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ?? result.value?.message ?? t("调用重放失败"),
        );
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("调用重放失败"),
      );
    } finally {
      setLoading(null);
    }
  }

  async function previewObservation(): Promise<void> {
    const parameters = actionParameters();
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!parameters || !targetId) {
      return;
    }
    if (!boundariesValid) {
      setErrorMessage(t("事件上限或超时超出允许范围"));
      return;
    }
    if (!compiledCondition.ok) {
      setErrorMessage(t(compiledCondition.error));
      return;
    }
    setLoading("preview");
    setErrorMessage(null);
    setPreview(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId,
        actionId: "observe.preview",
        parameters,
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ?? result.value?.message ?? t("无法确认方法匹配"),
        );
        return;
      }
      setPreview(result.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法确认方法匹配"),
      );
    } finally {
      setLoading(null);
    }
  }

  async function startObservation(): Promise<void> {
    const parameters = actionParameters();
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!parameters || !targetId || !preview) {
      return;
    }
    if (!compiledCondition.ok) {
      setErrorMessage(t(compiledCondition.error));
      return;
    }
    setLoading("start");
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId,
        actionId: "observe.start",
        parameters: {
          ...parameters,
          maximumEvents: String(maximumEvents),
          timeoutMillis: String(timeoutSeconds * 1_000),
          includeInternal: String(includeInternal),
          condition: compiledCondition.expression,
          phases: watchPhases.join(","),
          confirmed: "true",
        },
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ?? result.value?.message ?? t("无法启动方法观测"),
        );
        return;
      }
      const startedTaskId = result.value.values.taskId;
      if (!startedTaskId) {
        setErrorMessage(t("Agent未返回观测任务标识"));
        return;
      }
      useObservationsStore.getState().started(targetId, startedTaskId);
      startPolling();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法启动方法观测"),
      );
    } finally {
      setLoading(null);
    }
  }

  async function pollEvents(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DiagnosticPollResult> {
    const observationsState = useObservationsStore.getState();
    if (
      !observationsState.targetId ||
      !observationsState.taskId ||
      useTargetsStore.getState().selectedTargetId !==
        observationsState.targetId
    ) {
      return "stop";
    }
    const targetId = observationsState.targetId;
    const taskId = observationsState.taskId;
    const result = await window.tanwei.getObservationEvents(
      targetId,
      taskId,
    );
    const currentState = useObservationsStore.getState();
    if (
      signal.aborted ||
      useTargetsStore.getState().selectedTargetId !== targetId ||
      currentState.targetId !== targetId ||
      currentState.taskId !== taskId
    ) {
      return "stop";
    }
    if (!result.ok || !result.value) {
      setErrorMessage(result.errorMessage ?? t("无法读取观测事件"));
      return "continue";
    }
    currentState.applyBatch(result.value);
    return result.value.state === "RUNNING" ? "continue" : "stop";
  }

  async function cancelObservation(): Promise<void> {
    const observationsState = useObservationsStore.getState();
    if (!observationsState.targetId || !observationsState.taskId) {
      return;
    }
    stopPolling();
    setLoading("cancel");
    try {
      const result = await window.tanwei.cancelObservation(
        observationsState.targetId,
        observationsState.taskId,
      );
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法取消观测任务"));
        return;
      }
      observationsState.setState(result.value);
      await pollEvents();
    } finally {
      setLoading(null);
    }
  }

  function startPolling(): void {
    stopPolling();
    const poller = new DiagnosticTaskPoller({
      intervalMillis: 500,
      poll: pollEvents,
      onError: (error) => {
        setErrorMessage(
          error instanceof Error ? error.message : t("无法读取观测事件"),
        );
      },
    });
    taskPollerRef.current = poller;
    poller.start();
  }

  function stopPolling(): void {
    taskPollerRef.current?.stop();
    taskPollerRef.current = null;
  }

  useEffect(() => {
    if (useObservationsStore.getState().state === "RUNNING") {
      startPolling();
    }
    return () => {
      stopPolling();
    };
  }, []);

  return (
    <section className="page observe-view space-y-6">
      <header className="page-heading">
        <div>
          <p className="eyebrow">OBSERVE</p>
          <h1>{t("只观测你明确选择的方法。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "每个任务拥有精确类加载器身份、事件上限、超时和唯一增强所有权；达到终态后仅回滚该任务持有的类。",
          )}
        </p>
      </header>

      {connection?.state !== "READY" ? (
        <ObservationEmptyState
          icon={<Unplug />}
          eyebrow="NO ACTIVE CONNECTION"
          title={t("连接目标后选择观测方法。")}
          description={t("观测任务需要一个已经完成 Attach 的目标 JVM。")}
          actionLabel={t("选择目标")}
          onAction={() => void navigate("/targets")}
        />
      ) : !selection ? (
        <ObservationEmptyState
          icon={<Target />}
          eyebrow="NO METHOD SELECTED"
          title={t("从类详情中的方法签名进入观测。")}
          description={t("类、ClassLoader 与完整方法签名会共同绑定本次任务。")}
          actionLabel={t("浏览已加载类")}
          onAction={() => void navigate("/classes")}
        />
      ) : (
        <>
          {errorMessage && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>{t("观测操作未完成")}</AlertTitle>
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(0,1.35fr)_minmax(24rem,0.65fr)]">
            <Card className="selection-card min-w-0 gap-0">
              <CardHeader className="border-b">
                <div className="flex items-center gap-3">
                  <span className="bg-primary/10 text-primary grid size-9 shrink-0 place-items-center rounded-lg">
                    <Target className="size-4" />
                  </span>
                  <div className="grid min-w-0 gap-1">
                    <CardTitle>{t("精确方法身份")}</CardTitle>
                    <CardDescription>
                      {t("增强只绑定下面的类、加载器与方法签名。")}
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

            <Card className="observe-config gap-0">
              <CardHeader className="border-b">
                <div className="grid gap-1">
                  <CardTitle>{t("采集边界")}</CardTitle>
                  <CardDescription>
                    {t("事件、时间与调用树均在固定预算内。")}
                  </CardDescription>
                </div>
                <CardAction>
                  <RiskPill level="R2" compact />
                </CardAction>
              </CardHeader>
              <CardContent className="grid gap-4 py-5 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="observe-maximum-events">
                    {t("最多事件")}
                  </Label>
                  <Input
                    id="observe-maximum-events"
                    type="number"
                    min={1}
                    max={100}
                    aria-invalid={maximumEvents < 1 || maximumEvents > 100}
                    disabled={observationState === "RUNNING"}
                    value={maximumEvents}
                    onChange={(event) =>
                      setMaximumEvents(Number(event.target.value))
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="observe-timeout-seconds">
                    {t("超时（秒）")}
                  </Label>
                  <Input
                    id="observe-timeout-seconds"
                    type="number"
                    min={1}
                    max={60}
                    aria-invalid={timeoutSeconds < 1 || timeoutSeconds > 60}
                    disabled={observationState === "RUNNING"}
                    value={timeoutSeconds}
                    onChange={(event) =>
                      setTimeoutSeconds(Number(event.target.value))
                    }
                  />
                </div>
                <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3 sm:col-span-2">
                  <Switch
                    id="observe-include-internal"
                    checked={includeInternal}
                    disabled={observationState === "RUNNING"}
                    onCheckedChange={setIncludeInternal}
                  />
                  <div className="grid gap-1">
                    <Label
                      htmlFor="observe-include-internal"
                      className="cursor-pointer"
                    >
                      {t("捕获同类内部调用树")}
                    </Label>
                    <p className="text-muted-foreground text-xs leading-5">
                      {t("记录同一增强类内部的父子调用关系。")}
                    </p>
                  </div>
                </div>
                <fieldset className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:col-span-2">
                  <legend className="px-1 text-sm font-medium">
                    {t("观测时机")}
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {(
                      ["BEFORE", "RETURN", "THROW", "FINISH"] as const
                    ).map((phase) => (
                      <Label
                        key={phase}
                        className="flex cursor-pointer items-center gap-2 rounded-md border bg-background/60 px-3 py-2"
                      >
                        <Checkbox
                          checked={watchPhases.includes(phase)}
                          disabled={observationState === "RUNNING"}
                          onCheckedChange={(checked) => {
                            setWatchPhases((current) =>
                              checked
                                ? [...current, phase]
                                : current.filter((item) => item !== phase),
                            );
                            setPreview(null);
                          }}
                        />
                        <span>
                          {phase === "BEFORE"
                            ? t("进入前")
                            : phase === "RETURN"
                              ? t("正常返回")
                              : phase === "THROW"
                                ? t("异常退出")
                                : t("完成")}
                        </span>
                      </Label>
                    ))}
                  </div>
                  <p className="text-muted-foreground text-xs leading-5">
                    {t(
                      "进入前不提供耗时、返回值或异常；同时选择返回/异常与完成会为同一次调用生成独立事件。",
                    )}
                  </p>
                </fieldset>
                <Button
                  type="button"
                  variant="outline"
                  className="sm:col-span-2"
                  disabled={
                    !canOperate ||
                    !boundariesValid ||
                    loading !== null ||
                    observationState === "RUNNING"
                  }
                  onClick={() => void previewObservation()}
                >
                  {loading === "preview" ? <Spinner /> : <Eye />}
                  {t("预检匹配")}
                </Button>
              </CardContent>
            </Card>
          </div>

          <ObservationConditionBuilder
            value={conditionClauses}
            disabled={observationState === "RUNNING"}
            onChange={(nextClauses) => {
              setConditionClauses(nextClauses);
              setPreview(null);
              setErrorMessage(null);
            }}
          />

          {preview && (
            <Card className="preview-card border-primary/40 bg-primary/5 gap-0">
              <CardHeader>
                <div className="flex items-start gap-3">
                  <span className="bg-primary/10 text-primary grid size-9 shrink-0 place-items-center rounded-lg">
                    <ShieldCheck className="size-4" />
                  </span>
                  <div className="grid min-w-0 gap-1">
                    <CardTitle>
                      {t("匹配 {count} 个方法", {
                        count: preview.values.matchCount ?? "0",
                      })}
                    </CardTitle>
                    <CardDescription className="break-all font-mono">
                      {preview.values.method}
                    </CardDescription>
                    <code className="text-muted-foreground mt-2 break-all rounded-md border bg-background/70 px-3 py-2 text-xs">
                      {t("事件条件：{condition}", {
                        condition:
                          compiledCondition.ok && compiledCondition.expression
                            ? compiledCondition.expression
                            : t("无条件（捕获全部）"),
                      })}
                    </code>
                    <code className="text-muted-foreground break-all rounded-md border bg-background/70 px-3 py-2 text-xs">
                      {t("观测时机：{phases}", {
                        phases: watchPhases.join(" / "),
                      })}
                    </code>
                  </div>
                </div>
                <CardAction>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      loading !== null || observationState === "RUNNING"
                    }
                    onClick={() => void startObservation()}
                  >
                    {loading === "start" ? <Spinner /> : <Activity />}
                    {t("确认增强并开始")}
                  </Button>
                </CardAction>
              </CardHeader>
            </Card>
          )}

          {observationTaskId && (
            <Card className="task-card gap-0">
              <CardHeader className="border-b">
                <div className="grid min-w-0 gap-1">
                  <CardTitle>{t("观测任务")}</CardTitle>
                  <CardDescription className="break-all font-mono">
                    {observationTaskId}
                  </CardDescription>
                </div>
                <CardAction>
                  <Badge
                    variant={
                      observationState === "RUNNING" ? "secondary" : "outline"
                    }
                  >
                    {observationState ?? "UNKNOWN"}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3 py-5">
                <Badge variant="secondary">
                  {t("已捕获 {captured}", { captured })}
                </Badge>
                <Badge variant={dropped > 0 ? "destructive" : "outline"}>
                  {t("已丢弃 {dropped}", { dropped })}
                </Badge>
              </CardContent>
              {observationState === "RUNNING" && (
                <CardFooter className="justify-end border-t py-4">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading !== null}
                    onClick={() => void cancelObservation()}
                  >
                    {loading === "cancel" ? <Spinner /> : <RotateCcw />}
                    {t("取消并回滚增强")}
                  </Button>
                </CardFooter>
              )}
            </Card>
          )}

          {aggregate.count > 0 && (
            <section
              className="aggregate-card grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
              aria-label={t("观测统计")}
            >
              <ObservationMetric
                icon={<Activity />}
                label={t("样本")}
                value={String(aggregate.count)}
              />
              <ObservationMetric
                icon={<Timer />}
                label={t("平均耗时")}
                value={`${aggregate.averageMillis.toFixed(3)} ms`}
              />
              <ObservationMetric
                icon={<Clock3 />}
                label={t("最大耗时")}
                value={`${aggregate.maximumMillis.toFixed(3)} ms`}
              />
              <ObservationMetric
                icon={<TriangleAlert />}
                label={t("异常")}
                value={String(aggregate.failures)}
                destructive={aggregate.failures > 0}
              />
            </section>
          )}

          <Card className="event-list min-w-0 gap-0 overflow-hidden">
            <CardHeader className="border-b">
              <div className="flex items-start gap-3">
                <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-lg">
                  <GitBranch className="size-4" />
                </span>
                <div className="grid gap-1">
                  <CardTitle>{t("有界调用事件")}</CardTitle>
                  <CardDescription>
                    {t("按调用层级检查参数、结果、来源栈与安全重放入口。")}
                  </CardDescription>
                </div>
              </div>
              <CardAction>
                <Badge variant="secondary">{events.length}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              {events.map((event) => (
                <ObservationEventCard
                  key={event.eventId}
                  event={event}
                  replayable={canReplay(event)}
                  loading={loading}
                  replayEventSequence={replayEventSequence}
                  replayPreview={replayPreview}
                  replayResult={replayResult}
                  replayConfirmed={replayConfirmed}
                  replaySecondaryConfirmed={replaySecondaryConfirmed}
                  onPreviewReplay={(currentEvent) =>
                    void previewReplay(currentEvent)
                  }
                  onExecuteReplay={(currentEvent) =>
                    void executeReplay(currentEvent)
                  }
                  onReplayConfirmedChange={setReplayConfirmed}
                  onReplaySecondaryConfirmedChange={setReplaySecondaryConfirmed}
                />
              ))}
              {events.length === 0 && (
                <Empty className="event-list__empty min-h-48 py-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Activity />
                    </EmptyMedia>
                    <EmptyTitle>{t("等待匹配调用")}</EmptyTitle>
                    <EmptyDescription>
                      {t("等待目标方法被调用；实时对象值不会写入 SQLite。")}
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

interface ObservationEmptyStateProps {
  readonly icon: ReactNode;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}

function ObservationEmptyState({
  icon,
  eyebrow,
  title,
  description,
  actionLabel,
  onAction,
}: ObservationEmptyStateProps) {
  return (
    <Empty className="empty-panel min-h-72 border py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <p className="text-muted-foreground text-xs font-medium tracking-wider">
          {eyebrow}
        </p>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <Button type="button" variant="outline" onClick={onAction}>
        {actionLabel}
      </Button>
    </Empty>
  );
}

interface IdentityFieldProps {
  readonly label: string;
  readonly value: string;
}

function IdentityField({ label, value }: IdentityFieldProps) {
  return (
    <div className="grid min-w-0 gap-1">
      <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        {label}
      </p>
      <code className="break-all rounded-md border bg-muted/30 px-3 py-2 text-xs leading-5">
        {value}
      </code>
    </div>
  );
}

interface ObservationMetricProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly destructive?: boolean;
}

function ObservationMetric({
  icon,
  label,
  value,
  destructive = false,
}: ObservationMetricProps) {
  return (
    <Card className="gap-3 py-5">
      <CardContent className="flex items-start justify-between gap-4">
        <div className="grid gap-2">
          <p className="text-muted-foreground text-sm">{label}</p>
          <p
            className={
              destructive
                ? "text-destructive font-mono text-2xl font-semibold tabular-nums"
                : "font-mono text-2xl font-semibold tabular-nums"
            }
          >
            {value}
          </p>
        </div>
        <span className="bg-muted text-muted-foreground grid size-9 place-items-center rounded-lg [&>svg]:size-4">
          {icon}
        </span>
      </CardContent>
    </Card>
  );
}
