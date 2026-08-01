import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { ActionResult } from "@shared/contracts";
import StatusPill from "../components/StatusPill";
import StatePagination from "../components/StatePagination";
import { t, useLocale } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./LoggersView.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";

type LoggerFramework = "JUL" | "LOGBACK" | "LOG4J" | "LOG4J2";
type LoggerFrameworkFilter = "ALL" | LoggerFramework;

interface LoggerListItem {
  readonly framework: LoggerFramework;
  readonly contextId: string;
  readonly context: string;
  readonly name: string;
  readonly level: string;
  readonly effectiveLevel: string;
  readonly additive: boolean;
  readonly handlerCount: number;
}

interface LoggerHandler {
  readonly name: string;
  readonly type: string;
  readonly level: string;
  readonly detail: string;
}

interface LoggerDetails extends LoggerListItem {
  readonly handlers: readonly LoggerHandler[];
}

interface LoggerLevelPreview {
  readonly framework: LoggerFramework;
  readonly contextId: string;
  readonly name: string;
  readonly currentLevel: string;
  readonly effectiveLevel: string;
  readonly newLevel: string;
  readonly changed: boolean;
  readonly fingerprint: string;
}

const PAGE_SIZE = 50;
const LEVELS_BY_FRAMEWORK: Readonly<
  Record<LoggerFramework, readonly string[]>
> = {
  JUL: [
    "<inherited>",
    "OFF",
    "SEVERE",
    "WARNING",
    "INFO",
    "CONFIG",
    "FINE",
    "FINER",
    "FINEST",
    "ALL",
  ],
  LOGBACK: [
    "<inherited>",
    "OFF",
    "ERROR",
    "WARN",
    "INFO",
    "DEBUG",
    "TRACE",
    "ALL",
  ],
  LOG4J: [
    "<inherited>",
    "OFF",
    "FATAL",
    "ERROR",
    "WARN",
    "INFO",
    "DEBUG",
    "TRACE",
    "ALL",
  ],
  LOG4J2: ["OFF", "FATAL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE", "ALL"],
};

function loggerIdentity(logger: LoggerListItem): string {
  return `${logger.framework}\u0000${logger.contextId}\u0000${logger.name}`;
}

function parseSafeNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseLoggerList(
  values: Readonly<Record<string, string>>,
): readonly LoggerListItem[] {
  const count = Math.min(parseSafeNumber(values.count), PAGE_SIZE);
  return Array.from({ length: count }, (_, index): LoggerListItem | null => {
    const prefix = `logger.${String(index).padStart(4, "0")}.`;
    const itemFramework = values[`${prefix}framework`];
    const name = values[`${prefix}name`] ?? "";
    if (
      !name ||
      (itemFramework !== "JUL" &&
        itemFramework !== "LOGBACK" &&
        itemFramework !== "LOG4J" &&
        itemFramework !== "LOG4J2")
    ) {
      return null;
    }
    return {
      framework: itemFramework,
      contextId: values[`${prefix}contextId`] ?? "",
      context: values[`${prefix}context`] ?? "",
      name,
      level: values[`${prefix}level`] ?? "<unknown>",
      effectiveLevel: values[`${prefix}effectiveLevel`] ?? "<unknown>",
      additive: values[`${prefix}additive`] === "true",
      handlerCount: parseSafeNumber(values[`${prefix}handlerCount`]),
    };
  }).filter((logger): logger is LoggerListItem => logger !== null);
}

function parseLoggerDetails(
  values: Readonly<Record<string, string>>,
): LoggerDetails {
  const handlerCount = Math.min(parseSafeNumber(values["handler.count"]), 100);
  const itemFramework = values.framework;
  if (
    itemFramework !== "JUL" &&
    itemFramework !== "LOGBACK" &&
    itemFramework !== "LOG4J" &&
    itemFramework !== "LOG4J2"
  ) {
    throw new Error(t("Agent返回了未知日志框架"));
  }
  const handlers = Array.from(
    { length: handlerCount },
    (_, index): LoggerHandler => {
      const prefix = `handler.${String(index).padStart(4, "0")}.`;
      return {
        name: values[`${prefix}name`] ?? "",
        type: values[`${prefix}type`] ?? "",
        level: values[`${prefix}level`] ?? "",
        detail: values[`${prefix}detail`] ?? "",
      };
    },
  );
  return {
    framework: itemFramework,
    contextId: values.contextId ?? "",
    context: values.context ?? "",
    name: values.name ?? "",
    level: values.level ?? "<unknown>",
    effectiveLevel: values.effectiveLevel ?? "<unknown>",
    additive: values.additive === "true",
    handlerCount: parseSafeNumber(values.handlerCount),
    handlers,
  };
}

function nextMutationLevel(
  itemFramework: LoggerFramework,
  currentLevel: string,
): string {
  const levels = LEVELS_BY_FRAMEWORK[itemFramework];
  const currentIndex = levels.findIndex((level) => level === currentLevel);
  if (currentIndex < 0) {
    return levels.includes("INFO") ? "INFO" : (levels[0] ?? "OFF");
  }
  return levels[(currentIndex + 1) % levels.length] ?? "INFO";
}

function statePillState(state: string): "ready" | "idle" | "error" {
  if (state === "AVAILABLE") {
    return "ready";
  }
  if (state === "ERROR") {
    return "error";
  }
  return "idle";
}

export default function LoggersView() {
  useLocale();
  const navigate = useNavigate();
  const selectedTargetId = useTargetsStore((state) => state.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const [query, setQuery] = useState("");
  const [framework, setFramework] = useState<LoggerFrameworkFilter>("ALL");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loggers, setLoggers] = useState<readonly LoggerListItem[]>([]);
  const [frameworkStates, setFrameworkStates] = useState<
    Readonly<Record<LoggerFramework, string>>
  >({
    JUL: "NOT_REQUESTED",
    LOGBACK: "NOT_REQUESTED",
    LOG4J: "NOT_REQUESTED",
    LOG4J2: "NOT_REQUESTED",
  });
  const [frameworkErrors, setFrameworkErrors] = useState<
    Readonly<Partial<Record<LoggerFramework, string>>>
  >({});
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null);
  const [details, setDetails] = useState<LoggerDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [mutationLoading, setMutationLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mutationConfirmed, setMutationConfirmed] = useState(false);
  const [mutationLevel, setMutationLevel] = useState("INFO");
  const [mutationPreview, setMutationPreview] =
    useState<LoggerLevelPreview | null>(null);
  const [mutationResult, setMutationResult] = useState<ActionResult | null>(
    null,
  );

  const loggerCapability = connection?.capabilities.find(
    (capability) => capability.id === "loggers",
  );
  const mutationLevels = LEVELS_BY_FRAMEWORK[details?.framework ?? "JUL"];

  function readFrameworkMetadata(
    values: Readonly<Record<string, string>>,
  ): void {
    setFrameworkStates({
      JUL: values["framework.jul.state"] ?? "NOT_REQUESTED",
      LOGBACK: values["framework.logback.state"] ?? "NOT_REQUESTED",
      LOG4J: values["framework.log4j.state"] ?? "NOT_REQUESTED",
      LOG4J2: values["framework.log4j2.state"] ?? "NOT_REQUESTED",
    });
    const nextErrors: Partial<Record<LoggerFramework, string>> = {};
    for (const itemFramework of [
      "JUL",
      "LOGBACK",
      "LOG4J",
      "LOG4J2",
    ] as const) {
      const error = values[`framework.${itemFramework.toLowerCase()}.error`];
      if (error) {
        nextErrors[itemFramework] = error;
      }
    }
    setFrameworkErrors(nextErrors);
  }

  async function loadLoggers(
    nextOffset = 0,
  ): Promise<readonly LoggerListItem[]> {
    const targetsState = useTargetsStore.getState();
    const activeConnection = selectConnection(targetsState);
    const capability = activeConnection?.capabilities.find(
      (candidate) => candidate.id === "loggers",
    );
    if (
      !targetsState.selectedTargetId ||
      activeConnection?.state !== "READY" ||
      capability?.state !== "AVAILABLE"
    ) {
      setLoggers([]);
      setTotal(0);
      return [];
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "logger.list",
        parameters: {
          query: query.trim(),
          framework,
          offset: String(Math.max(0, nextOffset)),
          limit: String(PAGE_SIZE),
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取 Logger 列表"),
        );
        return loggers;
      }
      readFrameworkMetadata(response.value.values);
      setOffset(parseSafeNumber(response.value.values.offset));
      setTotal(parseSafeNumber(response.value.values.total));
      const nextLoggers = parseLoggerList(response.value.values);
      setLoggers(nextLoggers);
      if (
        selectedIdentity &&
        !nextLoggers.some(
          (logger) => loggerIdentity(logger) === selectedIdentity,
        )
      ) {
        setSelectedIdentity(null);
        setDetails(null);
        setMutationConfirmed(false);
      }
      return nextLoggers;
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取 Logger 列表"),
      );
      return loggers;
    } finally {
      setLoading(false);
    }
  }

  async function selectLogger(logger: LoggerListItem): Promise<void> {
    const targetsState = useTargetsStore.getState();
    if (!targetsState.selectedTargetId) {
      return;
    }
    setSelectedIdentity(loggerIdentity(logger));
    setDetails(null);
    setMutationConfirmed(false);
    setMutationPreview(null);
    setMutationResult(null);
    setLoadingDetails(true);
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "logger.describe",
        parameters: {
          framework: logger.framework,
          contextId: logger.contextId,
          name: logger.name,
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取 Logger 详情"),
        );
        return;
      }
      const nextDetails = parseLoggerDetails(response.value.values);
      setDetails(nextDetails);
      setMutationLevel(
        nextMutationLevel(nextDetails.framework, nextDetails.level),
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取 Logger 详情"),
      );
    } finally {
      setLoadingDetails(false);
    }
  }

  function resetLevelPreview(): void {
    setMutationPreview(null);
    setMutationConfirmed(false);
    setMutationResult(null);
  }

  function parseLevelPreview(
    values: Readonly<Record<string, string>>,
    expected: LoggerDetails,
  ): LoggerLevelPreview {
    const itemFramework = values.framework;
    const fingerprint = values.fingerprint ?? "";
    if (
      itemFramework !== expected.framework ||
      values.contextId !== expected.contextId ||
      values.name !== expected.name ||
      values.newLevel !== mutationLevel ||
      !/^[a-f0-9]{64}$/u.test(fingerprint)
    ) {
      throw new Error(t("Logger 级别预检响应身份无效"));
    }
    return {
      framework: itemFramework as LoggerFramework,
      contextId: values.contextId,
      name: values.name,
      currentLevel: values.currentLevel ?? "<unknown>",
      effectiveLevel: values.effectiveLevel ?? "<unknown>",
      newLevel: values.newLevel,
      changed: values.changed === "true",
      fingerprint,
    };
  }

  function validateLevelMutationResult(
    result: ActionResult,
    expected: LoggerDetails,
    preview: LoggerLevelPreview,
  ): void {
    const values = result.values;
    if (
      values.framework !== expected.framework ||
      values.contextId !== expected.contextId ||
      values.name !== expected.name ||
      values.oldValue !== preview.currentLevel ||
      values.newValue !== preview.newLevel ||
      !/^[a-f0-9]{64}$/u.test(values.rollbackFingerprint ?? "")
    ) {
      throw new Error(t("Logger 级别修改响应身份无效"));
    }
  }

  async function previewLoggerLevel(): Promise<void> {
    const current = details;
    const targetsState = useTargetsStore.getState();
    if (!targetsState.selectedTargetId || !current) {
      return;
    }
    setMutationLoading(true);
    setErrorMessage(null);
    setMutationPreview(null);
    setMutationConfirmed(false);
    setMutationResult(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "logger.level.preview",
        parameters: {
          framework: current.framework,
          contextId: current.contextId,
          name: current.name,
          newLevel: mutationLevel,
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法预检 Logger 级别"),
        );
        return;
      }
      setMutationPreview(parseLevelPreview(response.value.values, current));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法预检 Logger 级别"),
      );
    } finally {
      setMutationLoading(false);
    }
  }

  async function applyLoggerLevel(): Promise<void> {
    const current = details;
    const preview = mutationPreview;
    const targetsState = useTargetsStore.getState();
    if (
      !targetsState.selectedTargetId ||
      !current ||
      !preview ||
      !preview.changed ||
      !mutationConfirmed
    ) {
      return;
    }
    setMutationLoading(true);
    setErrorMessage(null);
    setMutationResult(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "logger.level.set",
        parameters: {
          framework: current.framework,
          contextId: current.contextId,
          name: current.name,
          newLevel: mutationLevel,
          expectedFingerprint: preview.fingerprint,
          confirmed: "true",
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法修改 Logger 级别"),
        );
        return;
      }
      validateLevelMutationResult(response.value, current, preview);
      setMutationConfirmed(false);
      setMutationPreview(null);
      const currentItem =
        loggers.find((logger) => loggerIdentity(logger) === selectedIdentity) ??
        null;
      const loadedLoggers = await loadLoggers(offset);
      if (currentItem) {
        const refreshed =
          loadedLoggers.find(
            (logger) => loggerIdentity(logger) === loggerIdentity(currentItem),
          ) ?? currentItem;
        await selectLogger(refreshed);
      }
      setMutationResult(response.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法修改 Logger 级别"),
      );
    } finally {
      setMutationLoading(false);
    }
  }

  function prepareLevelRollback(): void {
    const oldValue = mutationResult?.values.oldValue;
    if (!oldValue || !mutationLevels.includes(oldValue)) {
      return;
    }
    setMutationLevel(oldValue);
    resetLevelPreview();
  }

  const previousTargetIdRef = useRef(selectedTargetId);
  useEffect(() => {
    if (previousTargetIdRef.current === selectedTargetId) {
      return;
    }
    previousTargetIdRef.current = selectedTargetId;
    setSelectedIdentity(null);
    setDetails(null);
    setMutationPreview(null);
    setMutationResult(null);
    void loadLoggers(0);
  }, [selectedTargetId]);

  const previousFrameworkRef = useRef(framework);
  useEffect(() => {
    if (previousFrameworkRef.current === framework) {
      return;
    }
    previousFrameworkRef.current = framework;
    setSelectedIdentity(null);
    setDetails(null);
    setMutationPreview(null);
    setMutationResult(null);
    void loadLoggers(0);
  }, [framework]);

  useEffect(() => {
    void loadLoggers(0);
  }, []);

  return (
    <section className="page loggers-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">LOGGER CENTER</p>
          <h1>{t("日志配置，按上下文看清。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "搜索 JUL、Logback、Log4j 1.x、Log4j2 的上下文、有效级别与输出目标，并通过框架专属预检安全修改级别；不会为探测而加载业务日志库。",
          )}
        </p>
      </header>

      {connection?.state !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">{t("连接目标后检查 Logger。")}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate("/targets")}
          >
            {t("选择目标")}
          </Button>
        </Empty>
      ) : loggerCapability?.state !== "AVAILABLE" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">CAPABILITY UNAVAILABLE</p>
          <p className="empty-panel__title">
            {t("当前 Agent 不支持 Logger Center。")}
          </p>
          <p>
            {loggerCapability?.reason ?? t("请重新连接目标以加载最新 Agent。")}
          </p>
        </Empty>
      ) : (
        <>
          <form
            className="logger-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              void loadLoggers(0);
            }}
          >
            <Label>
              <span>{t("日志框架")}</span>
              <SelectControl
                value={framework}
                onValueChange={(value) =>
                  setFramework(value as LoggerFrameworkFilter)
                }
              >
                <SelectControlItem value="ALL">
                  {t("全部已加载框架")}
                </SelectControlItem>
                <SelectControlItem value="JUL">JUL</SelectControlItem>
                <SelectControlItem value="LOGBACK">Logback</SelectControlItem>
                <SelectControlItem value="LOG4J">Log4j 1.x</SelectControlItem>
                <SelectControlItem value="LOG4J2">Log4j2</SelectControlItem>
              </SelectControl>
            </Label>
            <Label>
              <span>{t("搜索 Logger")}</span>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value.trim())}
                type="search"
                maxLength={256}
                placeholder={t("名称或日志上下文")}
              />
            </Label>
            <Button
              variant="secondary"
              type="submit"
              aria-busy={Boolean(loading)}
              disabled={Boolean(loading)}
            >
              {Boolean(loading) && <Spinner />}
              {t("搜索")}
            </Button>
          </form>

          <div className="framework-strip" aria-label={t("日志框架状态")}>
            {(["JUL", "LOGBACK", "LOG4J", "LOG4J2"] as const).map(
              (itemFramework) => (
                <StatusPill
                  key={itemFramework}
                  state={statePillState(frameworkStates[itemFramework])}
                  label={`${itemFramework} · ${frameworkStates[itemFramework]}`}
                />
              ),
            )}
          </div>

          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}
          {(Object.entries(frameworkErrors) as [LoggerFramework, string][]).map(
            ([itemFramework, frameworkError]) => (
              <div key={itemFramework} className="framework-warning">
                <strong>{itemFramework}</strong>
                <span>{frameworkError}</span>
              </div>
            ),
          )}

          <div className="logger-inspector">
            <section className="logger-list" aria-label={t("Logger 搜索结果")}>
              <header>
                <div>
                  <p className="eyebrow">REGISTERED LOGGERS</p>
                  <strong>{t("{count} 个匹配", { count: total })}</strong>
                </div>
                <StatusPill state="idle" label={t("R0 · 只读")} />
              </header>
              {loggers.length > 0 ? (
                <div className="logger-list__items">
                  {loggers.map((logger) => (
                    <Button
                      variant="ghost"
                      key={loggerIdentity(logger)}
                      type="button"
                      className={
                        loggerIdentity(logger) === selectedIdentity
                          ? "logger-row logger-row--selected"
                          : "logger-row"
                      }
                      onClick={() => void selectLogger(logger)}
                    >
                      <span>
                        <strong>{logger.name}</strong>
                        <small>{logger.context}</small>
                      </span>
                      <span>
                        {logger.framework} · {logger.effectiveLevel}
                      </span>
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="logger-list__empty">
                  {loading ? t("正在读取 Logger…") : t("没有匹配的 Logger。")}
                </div>
              )}
              <footer>
                <StatePagination
                  ariaLabel={t("Logger 分页")}
                  previousLabel={t("上一页")}
                  nextLabel={t("下一页")}
                  previousDisabled={offset === 0 || loading}
                  nextDisabled={offset + PAGE_SIZE >= total || loading}
                  onPrevious={() =>
                    void loadLoggers(Math.max(0, offset - PAGE_SIZE))
                  }
                  onNext={() => void loadLoggers(offset + PAGE_SIZE)}
                  summary={t("{start}–{end} / {total}", {
                    start: total === 0 ? 0 : offset + 1,
                    end: Math.min(offset + PAGE_SIZE, total),
                    total,
                  })}
                />
              </footer>
            </section>

            <section className="logger-detail">
              {loadingDetails ? (
                <div className="logger-detail__empty">
                  <p className="eyebrow">READING LOGGER</p>
                  <p>{t("正在读取 Logger 详情…")}</p>
                </div>
              ) : details ? (
                <>
                  <header className="logger-detail__header">
                    <div>
                      <p className="eyebrow">{details.framework}</p>
                      <h2>{details.name}</h2>
                      <p>{details.context}</p>
                    </div>
                    <StatusPill state="ready" label={details.effectiveLevel} />
                  </header>

                  <dl className="logger-facts">
                    <div>
                      <dt>{t("声明级别")}</dt>
                      <dd>{details.level}</dd>
                    </div>
                    <div>
                      <dt>{t("有效级别")}</dt>
                      <dd>{details.effectiveLevel}</dd>
                    </div>
                    <div>
                      <dt>{t("向父级传递")}</dt>
                      <dd>{details.additive ? t("是") : t("否")}</dd>
                    </div>
                    <div>
                      <dt>{t("Handler / Appender")}</dt>
                      <dd>{details.handlerCount}</dd>
                    </div>
                  </dl>

                  <section className="logger-section">
                    <header>
                      <div>
                        <p className="eyebrow">HANDLERS / APPENDERS</p>
                        <h3>
                          {t("{count} 个输出目标", {
                            count: details.handlers.length,
                          })}
                        </h3>
                      </div>
                      <p>{t("仅展示直接绑定项")}</p>
                    </header>
                    {details.handlers.length > 0 ? (
                      <div className="handler-list">
                        {details.handlers.map((handler, index) => (
                          <article
                            key={`${handler.name}:${handler.type}:${index}`}
                          >
                            <header>
                              <strong>{handler.name || t("未命名输出")}</strong>
                              <StatusPill
                                state="idle"
                                label={
                                  handler.level || handler.detail || t("已绑定")
                                }
                              />
                            </header>
                            <code>{handler.type}</code>
                            {handler.detail && <p>{handler.detail}</p>}
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="logger-detail__empty">
                        {t("此 Logger 没有直接绑定输出项。")}
                      </p>
                    )}
                  </section>

                  <section className="logger-section logger-mutation">
                    <header>
                      <div>
                        <p className="eyebrow">CONTROLLED LEVEL CHANGE / R3</p>
                        <h3>
                          {t("修改精确 {framework} Logger。", {
                            framework: details.framework,
                          })}
                        </h3>
                      </div>
                      <p>{t("预检绑定框架、上下文、Logger 和当前级别指纹")}</p>
                    </header>
                    <div className="logger-mutation__controls">
                      <Label>
                        <span>{t("新级别")}</span>
                        <SelectControl
                          value={mutationLevel}
                          onValueChange={(value) => {
                            setMutationLevel(value);
                            resetLevelPreview();
                          }}
                        >
                          {mutationLevels.map((level) => (
                            <SelectControlItem key={level} value={level}>
                              {level}
                            </SelectControlItem>
                          ))}
                        </SelectControl>
                      </Label>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void previewLoggerLevel()}
                        aria-busy={Boolean(mutationLoading)}
                        disabled={Boolean(mutationLoading)}
                      >
                        {Boolean(mutationLoading) && <Spinner />}
                        {t("生成级别变更预检")}
                      </Button>
                    </div>

                    {mutationPreview && (
                      <section
                        className="logger-mutation__preview"
                        aria-label={t("Logger 级别变更预检")}
                      >
                        <p className="eyebrow">LEVEL CHANGE PREFLIGHT</p>
                        <dl>
                          <div>
                            <dt>{t("声明级别")}</dt>
                            <dd>{mutationPreview.currentLevel}</dd>
                          </div>
                          <div>
                            <dt>{t("有效级别")}</dt>
                            <dd>{mutationPreview.effectiveLevel}</dd>
                          </div>
                          <div>
                            <dt>{t("目标级别")}</dt>
                            <dd>{mutationPreview.newLevel}</dd>
                          </div>
                          <div>
                            <dt>{t("预检指纹")}</dt>
                            <dd>
                              <code>{mutationPreview.fingerprint}</code>
                            </dd>
                          </div>
                        </dl>
                        <p>
                          {t(
                            "精确框架、上下文、Logger 与当前级别共同形成指纹；预检后发生漂移将拒绝提交。",
                          )}
                        </p>
                      </section>
                    )}

                    {mutationPreview?.changed ? (
                      <>
                        <Label className="logger-confirmation">
                          <Checkbox
                            checked={mutationConfirmed}
                            onCheckedChange={(event) =>
                              setMutationConfirmed(event === true)
                            }
                          />
                          <span>
                            {t(
                              "我确认修改 {name} 的日志级别，日志量和性能可能立即变化。",
                              {
                                name: details.name,
                              },
                            )}
                          </span>
                        </Label>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={
                            Boolean(!mutationConfirmed) ||
                            Boolean(mutationLoading)
                          }
                          onClick={() => void applyLoggerLevel()}
                          aria-busy={Boolean(mutationLoading)}
                        >
                          {Boolean(mutationLoading) && <Spinner />}
                          {t("确认修改级别")}
                        </Button>
                      </>
                    ) : (
                      mutationPreview && (
                        <p className="logger-mutation__no-change">
                          {t("目标级别与当前声明级别相同，无需提交。")}
                        </p>
                      )
                    )}

                    {mutationResult && (
                      <div className="logger-mutation__result">
                        <header>
                          <div>
                            <p className="eyebrow">LEVEL CHANGE COMMITTED</p>
                            <strong>
                              {t("级别已从 {oldValue} 修改为 {newValue}", {
                                oldValue: mutationResult.values.oldValue ?? "",
                                newValue: mutationResult.values.newValue ?? "",
                              })}
                            </strong>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={prepareLevelRollback}
                          >
                            {t("准备回滚本次修改")}
                          </Button>
                        </header>
                        <dl>
                          <div>
                            <dt>{t("日志框架")}</dt>
                            <dd>{mutationResult.values.framework}</dd>
                          </div>
                          <div>
                            <dt>{t("上下文")}</dt>
                            <dd>{mutationResult.values.contextId}</dd>
                          </div>
                          <div>
                            <dt>{t("有效级别")}</dt>
                            <dd>{mutationResult.values.effectiveLevel}</dd>
                          </div>
                          <div>
                            <dt>{t("回滚指纹")}</dt>
                            <dd>
                              <code>
                                {mutationResult.values.rollbackFingerprint}
                              </code>
                            </dd>
                          </div>
                        </dl>
                      </div>
                    )}
                  </section>
                </>
              ) : (
                <div className="logger-detail__empty">
                  <p className="eyebrow">NO SELECTION</p>
                  <p>{t("选择一个 Logger 查看上下文与输出目标。")}</p>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
