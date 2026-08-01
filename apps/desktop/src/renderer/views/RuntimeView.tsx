import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import StatePagination from "../components/StatePagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Disclosure } from "@/components/ui/disclosure";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { ActionResult } from "@shared/contracts";
import RiskPill from "../components/RiskPill";
import StatusPill from "../components/StatusPill";
import SystemPropertyInspector from "../components/SystemPropertyInspector";
import VmOptionInspector from "../components/VmOptionInspector";
import { formatDateTime, t, useLocale } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./RuntimeView.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";

type EnvironmentCategory =
  | "ALL"
  | "JAVA"
  | "PATH"
  | "LOCALE"
  | "PROCESS"
  | "OTHER";
type EnvironmentVisibility = "VISIBLE" | "MASKED";
interface EnvironmentEntry {
  readonly key: string;
  readonly value: string;
  readonly category: Exclude<EnvironmentCategory, "ALL">;
  readonly visibility: EnvironmentVisibility;
  readonly valueLength: number;
  readonly truncated: boolean;
}

const ENVIRONMENT_PAGE_SIZE = 50;
const ENVIRONMENT_CATEGORIES = new Set<EnvironmentEntry["category"]>([
  "JAVA",
  "PATH",
  "LOCALE",
  "PROCESS",
  "OTHER",
]);

type RuntimeWorkspace =
  | "facts"
  | "properties"
  | "environment"
  | "vm-options"
  | "mutation";
const RUNTIME_WORKSPACE_IDS = new Set<RuntimeWorkspace>([
  "facts",
  "properties",
  "environment",
  "vm-options",
  "mutation",
]);

function routeWorkspace(value: unknown): RuntimeWorkspace {
  return typeof value === "string" &&
    RUNTIME_WORKSPACE_IDS.has(value as RuntimeWorkspace)
    ? (value as RuntimeWorkspace)
    : "facts";
}

type MutationAction =
  | "system.property.set"
  | "logging.set"
  | "vm.option.set"
  | "gc.run";

function parseEnvironmentInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(t("{label} 超出安全边界。", { label }));
  }
  return parsed;
}

function parseEnvironmentText(
  value: string | undefined,
  maximumLength: number,
  label: string,
  allowEmpty = false,
): string {
  if (
    value === undefined ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength ||
    value.includes("\u0000")
  ) {
    throw new Error(t("{label} 无效。", { label }));
  }
  return value;
}

function parseEnvironmentResponse(values: Readonly<Record<string, string>>): {
  readonly environmentCount: number;
  readonly visibleCount: number;
  readonly maskedCount: number;
  readonly invalidCount: number;
  readonly total: number;
  readonly offset: number;
  readonly entries: readonly EnvironmentEntry[];
} {
  const sourceCount = parseEnvironmentInteger(
    values.environmentCount,
    0,
    100_000,
    t("环境变量总数"),
  );
  const visibleCount = parseEnvironmentInteger(
    values.visibleCount,
    0,
    sourceCount,
    t("可见变量数量"),
  );
  const maskedCount = parseEnvironmentInteger(
    values.maskedCount,
    0,
    sourceCount,
    t("已遮罩变量数量"),
  );
  const invalidCount = parseEnvironmentInteger(
    values.invalidCount,
    0,
    sourceCount,
    t("无效变量数量"),
  );
  if (visibleCount + maskedCount + invalidCount !== sourceCount) {
    throw new Error(t("环境变量汇总响应无效。"));
  }
  const total = parseEnvironmentInteger(
    values.total,
    0,
    visibleCount + maskedCount,
    t("环境变量匹配数量"),
  );
  const offset = parseEnvironmentInteger(
    values.offset,
    0,
    total,
    t("环境变量分页偏移"),
  );
  const limit = parseEnvironmentInteger(
    values.limit,
    1,
    200,
    t("环境变量分页上限"),
  );
  const count = parseEnvironmentInteger(
    values.count,
    0,
    Math.min(limit, total - offset),
    t("环境变量结果数量"),
  );
  const keys = new Set<string>();
  const entries = Array.from(
    { length: count },
    (_, index): EnvironmentEntry => {
      const prefix = `environment.${String(index).padStart(4, "0")}.`;
      const key = parseEnvironmentText(
        values[`${prefix}key`],
        512,
        t("环境变量名称"),
      );
      if (keys.has(key)) {
        throw new Error(t("环境变量响应包含重复名称。"));
      }
      keys.add(key);
      const category = values[`${prefix}category`];
      const visibility = values[`${prefix}visibility`];
      const truncated = values[`${prefix}truncated`];
      if (
        !ENVIRONMENT_CATEGORIES.has(category as EnvironmentEntry["category"]) ||
        (visibility !== "VISIBLE" && visibility !== "MASKED") ||
        (truncated !== "true" && truncated !== "false")
      ) {
        throw new Error(t("环境变量分类或可见性响应无效。"));
      }
      const value = parseEnvironmentText(
        values[`${prefix}value`],
        4_097,
        t("环境变量值"),
        true,
      );
      const valueLength = parseEnvironmentInteger(
        values[`${prefix}valueLength`],
        0,
        10_000_000,
        t("环境变量值长度"),
      );
      const isTruncated = truncated === "true";
      if (
        (visibility === "MASKED" && (value !== "<masked>" || isTruncated)) ||
        (visibility === "VISIBLE" &&
          ((isTruncated &&
            (valueLength <= 4_096 ||
              value.length !== 4_097 ||
              !value.endsWith("…"))) ||
            (!isTruncated && value.length !== valueLength)))
      ) {
        throw new Error(t("环境变量值边界响应无效。"));
      }
      return {
        key,
        value,
        category: category as EnvironmentEntry["category"],
        visibility,
        valueLength,
        truncated: isTruncated,
      };
    },
  );
  return {
    environmentCount: sourceCount,
    visibleCount,
    maskedCount,
    invalidCount,
    total,
    offset,
    entries,
  };
}

function environmentCategoryLabel(
  category: EnvironmentEntry["category"],
): string {
  switch (category) {
    case "JAVA":
      return t("Java 工具链");
    case "PATH":
      return t("路径与目录");
    case "LOCALE":
      return t("语言与时区");
    case "PROCESS":
      return t("进程上下文");
    case "OTHER":
      return t("其他变量");
  }
}

const JUL_LEVELS = [
  "OFF",
  "SEVERE",
  "WARNING",
  "INFO",
  "CONFIG",
  "FINE",
  "FINER",
  "FINEST",
  "ALL",
] as const;

export default function RuntimeView() {
  useLocale();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTargetId = useTargetsStore((s) => s.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedAction, setSelectedAction] = useState("jvm.info");
  const workspaceParam = searchParams.get("workspace");
  const [activeWorkspace, setActiveWorkspace] = useState<RuntimeWorkspace>(
    routeWorkspace(workspaceParam),
  );
  const [selectedMutation, setSelectedMutation] = useState<MutationAction>(
    "system.property.set",
  );
  const [mutationName, setMutationName] = useState("java.io.tmpdir");
  const [mutationNewValue, setMutationNewValue] = useState("");
  const [mutationOldValue, setMutationOldValue] = useState("");
  const [mutationPrepared, setMutationPrepared] = useState(false);
  const [mutationConfirmed, setMutationConfirmed] = useState(false);
  const [mutationConfirmedSecondary, setMutationConfirmedSecondary] =
    useState(false);
  const [mutationLoading, setMutationLoading] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationResult, setMutationResult] = useState<ActionResult | null>(
    null,
  );
  const [environmentQuery, setEnvironmentQuery] = useState("");
  const [environmentCategory, setEnvironmentCategory] =
    useState<EnvironmentCategory>("ALL");
  const [environmentEntries, setEnvironmentEntries] = useState<
    readonly EnvironmentEntry[]
  >([]);
  const [selectedEnvironmentKey, setSelectedEnvironmentKey] = useState<
    string | null
  >(null);
  const [environmentCount, setEnvironmentCount] = useState(0);
  const [environmentVisibleCount, setEnvironmentVisibleCount] = useState(0);
  const [environmentMaskedCount, setEnvironmentMaskedCount] = useState(0);
  const [environmentInvalidCount, setEnvironmentInvalidCount] = useState(0);
  const [environmentTotal, setEnvironmentTotal] = useState(0);
  const [environmentOffset, setEnvironmentOffset] = useState(0);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const environmentRequestIdRef = useRef(0);
  const categoryFirstRunRef = useRef(true);
  const targetFirstRunRef = useRef(true);

  const runtimeWorkspaces: readonly {
    readonly id: RuntimeWorkspace;
    readonly label: string;
  }[] = [
    { id: "facts", label: t("基础事实") },
    { id: "properties", label: t("系统属性") },
    { id: "environment", label: t("环境变量") },
    { id: "vm-options", label: "VM Options" },
    { id: "mutation", label: t("受控修改") },
  ];

  function selectRuntimeWorkspace(workspace: RuntimeWorkspace): void {
    setActiveWorkspace(workspace);
    if (searchParams.get("workspace") !== workspace) {
      const next = new URLSearchParams(searchParams);
      next.set("workspace", workspace);
      setSearchParams(next, { replace: true });
    }
  }

  const selectedEnvironment =
    environmentEntries.find((entry) => entry.key === selectedEnvironmentKey) ??
    null;
  const mutationRisk = selectedMutation === "gc.run" ? "R4" : "R3";
  const mutationImpact = (() => {
    switch (selectedMutation) {
      case "system.property.set":
        return t(
          "修改目标 JVM 中已存在且非敏感的系统属性；业务代码可能立即读到新值。",
        );
      case "logging.set":
        return t(
          "修改 java.util.logging 精确 Logger 的级别；日志量和性能可能立即变化。",
        );
      case "vm.option.set":
        return t("修改 HotSpot 声明为可写的诊断选项；影响由具体选项决定。");
      case "gc.run":
        return t(
          "向目标 JVM 请求一次全量垃圾回收；可能产生明显停顿，JVM 也可能忽略请求。",
        );
    }
  })();
  const mutationNameLabel = (() => {
    switch (selectedMutation) {
      case "system.property.set":
        return t("系统属性名");
      case "logging.set":
        return t("Logger 名称");
      case "vm.option.set":
        return t("VM Option 名称");
      case "gc.run":
        return "";
    }
  })();

  async function loadEnvironment(nextOffset = 0): Promise<void> {
    if (!selectedTargetId || connection?.state !== "READY") {
      setEnvironmentEntries([]);
      setSelectedEnvironmentKey(null);
      return;
    }
    const requestId = ++environmentRequestIdRef.current;
    setEnvironmentLoading(true);
    setEnvironmentError(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: selectedTargetId,
        actionId: "environment.list",
        parameters: {
          query: environmentQuery.trim(),
          category: environmentCategory,
          offset: String(Math.max(0, nextOffset)),
          limit: String(ENVIRONMENT_PAGE_SIZE),
        },
      });
      if (requestId !== environmentRequestIdRef.current) {
        return;
      }
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setEnvironmentError(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取环境变量索引"),
        );
        return;
      }
      const parsed = parseEnvironmentResponse(response.value.values);
      setEnvironmentCount(parsed.environmentCount);
      setEnvironmentVisibleCount(parsed.visibleCount);
      setEnvironmentMaskedCount(parsed.maskedCount);
      setEnvironmentInvalidCount(parsed.invalidCount);
      setEnvironmentTotal(parsed.total);
      setEnvironmentOffset(parsed.offset);
      setEnvironmentEntries(parsed.entries);
      setSelectedEnvironmentKey(
        (previousKey) =>
          parsed.entries.find((entry) => entry.key === previousKey)?.key ??
          parsed.entries[0]?.key ??
          null,
      );
    } catch (error) {
      if (requestId === environmentRequestIdRef.current) {
        setEnvironmentError(
          error instanceof Error ? error.message : t("无法读取环境变量索引"),
        );
      }
    } finally {
      if (requestId === environmentRequestIdRef.current) {
        setEnvironmentLoading(false);
      }
    }
  }

  async function executeSelectedAction(): Promise<void> {
    if (!selectedTargetId || connection?.state !== "READY") {
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
      setResult(response.value);
      if (!response.ok) {
        setErrorMessage(response.errorMessage ?? t("无法读取JVM信息"));
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取JVM信息"),
      );
    } finally {
      setLoading(false);
    }
  }

  function resetMutationPreview(): void {
    setMutationOldValue("");
    setMutationPrepared(false);
    setMutationConfirmed(false);
    setMutationConfirmedSecondary(false);
    setMutationError(null);
    setMutationResult(null);
  }

  function scrollMutationIntoView(): void {
    requestAnimationFrame(() => {
      document
        .getElementById("runtime-mutation")
        ?.scrollIntoView({ block: "start" });
    });
  }

  function preparePropertyMutation(propertyName: string): void {
    setSelectedMutation("system.property.set");
    setMutationName(propertyName);
    setMutationNewValue("");
    resetMutationPreview();
    selectRuntimeWorkspace("mutation");
    scrollMutationIntoView();
  }

  function prepareVmOptionMutation(optionName: string): void {
    setSelectedMutation("vm.option.set");
    setMutationName(optionName);
    setMutationNewValue("");
    resetMutationPreview();
    selectRuntimeWorkspace("mutation");
    scrollMutationIntoView();
  }

  useEffect(() => {
    setMutationName(
      selectedMutation === "system.property.set"
        ? "java.io.tmpdir"
        : selectedMutation === "logging.set"
          ? "<root>"
          : selectedMutation === "vm.option.set"
            ? "HeapDumpOnOutOfMemoryError"
            : "",
    );
    setMutationNewValue("");
    resetMutationPreview();
  }, [selectedMutation]);

  useEffect(() => {
    if (mutationPrepared) {
      setMutationPrepared(false);
      setMutationConfirmed(false);
      setMutationConfirmedSecondary(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutationName, mutationNewValue]);

  useEffect(() => {
    if (categoryFirstRunRef.current) {
      categoryFirstRunRef.current = false;
      return;
    }
    setSelectedEnvironmentKey(null);
    void loadEnvironment(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentCategory]);

  useEffect(() => {
    if (targetFirstRunRef.current) {
      targetFirstRunRef.current = false;
      return;
    }
    environmentRequestIdRef.current++;
    setEnvironmentEntries([]);
    setSelectedEnvironmentKey(null);
    setEnvironmentCount(0);
    setEnvironmentVisibleCount(0);
    setEnvironmentMaskedCount(0);
    setEnvironmentInvalidCount(0);
    setEnvironmentTotal(0);
    setEnvironmentOffset(0);
    void loadEnvironment(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTargetId]);

  useEffect(() => {
    setActiveWorkspace(routeWorkspace(workspaceParam));
  }, [workspaceParam]);

  async function prepareMutation(): Promise<void> {
    if (!selectedTargetId || connection?.state !== "READY") {
      return;
    }
    setMutationLoading(true);
    setMutationError(null);
    setMutationResult(null);
    try {
      if (selectedMutation === "gc.run") {
        setMutationOldValue(t("不适用"));
        setMutationPrepared(true);
        return;
      }
      const queryAction =
        selectedMutation === "system.property.set"
          ? "system.properties"
          : selectedMutation === "logging.set"
            ? "logging.summary"
            : "vm.options";
      const response = await window.tanwei.executeAction({
        targetId: selectedTargetId,
        actionId: queryAction,
        parameters: {},
      });
      if (
        !response.ok ||
        !response.value ||
        response.value.status !== "SUCCEEDED"
      ) {
        setMutationError(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取修改前的值"),
        );
        return;
      }
      const rawValue = response.value.values[mutationName];
      if (rawValue === undefined) {
        setMutationError(t("目标中不存在该名称，请检查精确拼写。"));
        return;
      }
      if (rawValue === "<masked>") {
        setMutationError(t("敏感值不可通过探微读取或修改。"));
        return;
      }
      if (selectedMutation === "vm.option.set") {
        if (!rawValue.includes(" | writeable=true | ")) {
          setMutationError(t("该 VM Option 不可写。"));
          return;
        }
        setMutationOldValue(rawValue.split(" | writeable=", 1)[0] ?? "");
      } else {
        setMutationOldValue(rawValue);
      }
      setMutationPrepared(true);
    } catch (error) {
      setMutationError(
        error instanceof Error ? error.message : t("无法读取修改前的值"),
      );
    } finally {
      setMutationLoading(false);
    }
  }

  async function executeMutation(): Promise<void> {
    if (
      !selectedTargetId ||
      !mutationPrepared ||
      !mutationConfirmed ||
      (selectedMutation === "gc.run" && !mutationConfirmedSecondary)
    ) {
      return;
    }
    setMutationLoading(true);
    setMutationError(null);
    try {
      const parameters: Record<string, string> =
        selectedMutation === "gc.run"
          ? {
              confirmed: "true",
              confirmedSecondary: "true",
            }
          : {
              name: mutationName,
              expectedOldValue: mutationOldValue,
              newValue: mutationNewValue,
              confirmed: "true",
            };
      const response = await window.tanwei.executeAction({
        targetId: selectedTargetId,
        actionId: selectedMutation,
        parameters,
      });
      setMutationResult(response.value);
      if (
        !response.ok ||
        !response.value ||
        response.value.status !== "SUCCEEDED"
      ) {
        setMutationError(
          response.errorMessage ??
            response.value?.message ??
            t("运行时修改失败"),
        );
        return;
      }
      setMutationPrepared(false);
      setMutationConfirmed(false);
      setMutationConfirmedSecondary(false);
    } catch (error) {
      setMutationError(
        error instanceof Error ? error.message : t("运行时修改失败"),
      );
    } finally {
      setMutationLoading(false);
    }
  }

  useEffect(() => {
    void executeSelectedAction();
    void loadEnvironment(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="page runtime-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">RUNTIME</p>
          <h1>{t("运行时事实。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "所有查询通过主进程 Action Policy 与 Agent allowlist 双重校验；Renderer 不拥有执行权限。",
          )}
        </p>
      </header>

      {connection?.state !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">
            {t("连接目标后读取运行时信息。")}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate("/targets")}
          >
            {t("选择目标")}
          </Button>
        </Empty>
      ) : (
        <>
          <Tabs
            className="runtime-workspaces"
            value={activeWorkspace}
            onValueChange={(value) =>
              selectRuntimeWorkspace(value as RuntimeWorkspace)
            }
          >
            <TabsList aria-label={t("运行时检查器")}>
              {runtimeWorkspaces.map((workspace) => (
                <TabsTrigger key={workspace.id} value={workspace.id}>
                  {workspace.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {activeWorkspace === "facts" && (
            <div className="runtime-actions">
              <div>
                <Label>
                  <span className="eyebrow">ACTION SCHEMA</span>
                  <SelectControl
                    value={selectedAction}
                    onValueChange={(value) => setSelectedAction(value)}
                  >
                    <SelectControlItem value="jvm.info">
                      jvm.info
                    </SelectControlItem>
                    <SelectControlItem value="jvm.arguments">
                      jvm.arguments
                    </SelectControlItem>
                    <SelectControlItem value="system.properties">
                      system.properties
                    </SelectControlItem>
                    <SelectControlItem value="environment.summary">
                      environment.summary
                    </SelectControlItem>
                    <SelectControlItem value="memory.pools">
                      memory.pools
                    </SelectControlItem>
                    <SelectControlItem value="gc.collectors">
                      gc.collectors
                    </SelectControlItem>
                    <SelectControlItem value="mbeans.summary">
                      mbeans.summary
                    </SelectControlItem>
                    <SelectControlItem value="vm.options">
                      vm.options
                    </SelectControlItem>
                    <SelectControlItem value="logging.summary">
                      logging.summary
                    </SelectControlItem>
                  </SelectControl>
                </Label>
                <p>{t("R0 · 只读低成本 · 5 秒截止时间")}</p>
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void executeSelectedAction()}
                aria-busy={Boolean(loading)}
                disabled={Boolean(loading)}
              >
                {Boolean(loading) && <Spinner />}
                {t("执行查询")}
              </Button>
            </div>
          )}

          {activeWorkspace === "facts" && errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          {activeWorkspace === "facts" && result && (
            <section className="runtime-result">
              <header>
                <div>
                  <p className="eyebrow">STRUCTURED RESULT</p>
                  <p className="runtime-result__title">{result.actionId}</p>
                </div>
                <StatusPill
                  state={result.status === "SUCCEEDED" ? "ready" : "error"}
                  label={result.status}
                />
              </header>
              <dl>
                {Object.entries(result.values).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value || t("未知")}</dd>
                  </div>
                ))}
              </dl>
              <footer>
                <span>{t("任务 {taskId}", { taskId: result.taskId })}</span>
                <time dateTime={result.completedAt}>
                  {formatDateTime(result.completedAt)}
                </time>
              </footer>
            </section>
          )}

          {activeWorkspace === "properties" && (
            <SystemPropertyInspector
              onPrepareMutation={preparePropertyMutation}
            />
          )}

          {activeWorkspace === "environment" && (
            <section className="environment-explorer">
              <header>
                <div>
                  <p className="eyebrow">ENVIRONMENT EXPLORER / R0</p>
                  <h2>{t("检查进程环境，不暴露秘密。")}</h2>
                </div>
                <StatusPill
                  state="ready"
                  label={t("{count} 个变量", { count: environmentCount })}
                />
              </header>
              <p>
                {t(
                  "按名称搜索并分类目标 JVM 的启动环境；仅展示明确允许的运行时上下文值，其余变量只保留名称、类别和字符长度。",
                )}
              </p>

              <form
                className="environment-explorer__toolbar"
                onSubmit={(event) => {
                  event.preventDefault();
                  void loadEnvironment(0);
                }}
              >
                <Label>
                  <span>{t("环境变量名称")}</span>
                  <Input
                    value={environmentQuery}
                    onChange={(event) =>
                      setEnvironmentQuery(event.target.value)
                    }
                    type="search"
                    maxLength={128}
                    autoComplete="off"
                    placeholder={t("例如 JAVA、PATH 或 LANG")}
                  />
                </Label>
                <Label>
                  <span>{t("变量类别")}</span>
                  <SelectControl
                    value={environmentCategory}
                    onValueChange={(value) =>
                      setEnvironmentCategory(
                        value as EnvironmentCategory,
                      )
                    }
                  >
                    <SelectControlItem value="ALL">
                      {t("全部类别")}
                    </SelectControlItem>
                    <SelectControlItem value="JAVA">
                      {t("Java 工具链")}
                    </SelectControlItem>
                    <SelectControlItem value="PATH">
                      {t("路径与目录")}
                    </SelectControlItem>
                    <SelectControlItem value="LOCALE">
                      {t("语言与时区")}
                    </SelectControlItem>
                    <SelectControlItem value="PROCESS">
                      {t("进程上下文")}
                    </SelectControlItem>
                    <SelectControlItem value="OTHER">
                      {t("其他变量")}
                    </SelectControlItem>
                  </SelectControl>
                </Label>
                <Button
                  variant="secondary"
                  type="submit"
                  aria-busy={Boolean(environmentLoading)}
                  disabled={Boolean(environmentLoading)}
                >
                  {Boolean(environmentLoading) && <Spinner />}
                  {t("搜索环境")}
                </Button>
              </form>

              <dl className="environment-explorer__stats">
                <div>
                  <dt>{t("匹配")}</dt>
                  <dd>{environmentTotal}</dd>
                </div>
                <div>
                  <dt>{t("允许展示")}</dt>
                  <dd>{environmentVisibleCount}</dd>
                </div>
                <div>
                  <dt>{t("安全遮罩")}</dt>
                  <dd>{environmentMaskedCount}</dd>
                </div>
                <div>
                  <dt>{t("无效跳过")}</dt>
                  <dd>{environmentInvalidCount}</dd>
                </div>
              </dl>

              {environmentError && (
                <Alert variant="destructive">
                  <AlertDescription>{t(environmentError)}</AlertDescription>
                </Alert>
              )}

              <div className="environment-explorer__workspace">
                <section
                  className="environment-explorer__list"
                  aria-label={t("环境变量列表")}
                >
                  <header>
                    <p className="eyebrow">BOUNDED INDEX</p>
                    <span>
                      {t("{start}–{end} / {total}", {
                        start:
                          environmentTotal === 0 ? 0 : environmentOffset + 1,
                        end: Math.min(
                          environmentOffset + environmentEntries.length,
                          environmentTotal,
                        ),
                        total: environmentTotal,
                      })}
                    </span>
                  </header>
                  {environmentEntries.length > 0 ? (
                    <div className="environment-explorer__rows">
                      {environmentEntries.map((entry) => (
                        <Button
                          variant="ghost"
                          key={entry.key}
                          type="button"
                          aria-pressed={entry.key === selectedEnvironmentKey}
                          className="environment-row aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                          onClick={() => setSelectedEnvironmentKey(entry.key)}
                        >
                          <span>
                            <strong>{entry.key}</strong>
                            <small>
                              {environmentCategoryLabel(entry.category)}
                            </small>
                          </span>
                          <StatusPill
                            state={
                              entry.visibility === "VISIBLE" ? "ready" : "idle"
                            }
                            label={
                              entry.visibility === "VISIBLE"
                                ? t("允许展示")
                                : t("已遮罩")
                            }
                          />
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <div className="environment-explorer__empty">
                      {environmentLoading
                        ? t("正在读取环境变量…")
                        : t("没有匹配的环境变量。")}
                    </div>
                  )}
                  <footer>
                    <StatePagination
                      ariaLabel={t("环境变量分页")}
                      previousLabel={t("上一页")}
                      nextLabel={t("下一页")}
                      previousDisabled={
                        environmentOffset === 0 || environmentLoading
                      }
                      nextDisabled={
                        environmentOffset + ENVIRONMENT_PAGE_SIZE >=
                          environmentTotal || environmentLoading
                      }
                      onPrevious={() =>
                        void loadEnvironment(
                          Math.max(
                            0,
                            environmentOffset - ENVIRONMENT_PAGE_SIZE,
                          ),
                        )
                      }
                      onNext={() =>
                        void loadEnvironment(
                          environmentOffset + ENVIRONMENT_PAGE_SIZE,
                        )
                      }
                    />
                  </footer>
                </section>

                <aside className="environment-explorer__detail">
                  {selectedEnvironment ? (
                    <>
                      <header>
                        <div>
                          <p className="eyebrow">EXACT ENVIRONMENT KEY</p>
                          <h3>{selectedEnvironment.key}</h3>
                        </div>
                        <StatusPill
                          state={
                            selectedEnvironment.visibility === "VISIBLE"
                              ? "ready"
                              : "idle"
                          }
                          label={
                            selectedEnvironment.visibility === "VISIBLE"
                              ? t("允许展示")
                              : t("安全遮罩")
                          }
                        />
                      </header>
                      <dl>
                        <div>
                          <dt>{t("类别")}</dt>
                          <dd>
                            {environmentCategoryLabel(
                              selectedEnvironment.category,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("原始字符数")}</dt>
                          <dd>{selectedEnvironment.valueLength}</dd>
                        </div>
                        <div>
                          <dt>{t("返回边界")}</dt>
                          <dd>
                            {selectedEnvironment.visibility === "MASKED"
                              ? t("值未离开 Agent")
                              : selectedEnvironment.truncated
                                ? t("已截断为 4,096 个字符")
                                : t("完整安全值")}
                          </dd>
                        </div>
                      </dl>
                      <pre>
                        <code>{selectedEnvironment.value}</code>
                      </pre>
                      {selectedEnvironment.visibility === "MASKED" && (
                        <p>
                          {t(
                            "探微不提供查看或复制此值的路径；需要确认变量内容时，请在目标所属的秘密管理系统中核对。",
                          )}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="environment-explorer__empty">
                      {t("选择一个环境变量查看边界信息。")}
                    </div>
                  )}
                </aside>
              </div>
            </section>
          )}

          {activeWorkspace === "vm-options" && (
            <VmOptionInspector onPrepareMutation={prepareVmOptionMutation} />
          )}

          {activeWorkspace === "mutation" && (
            <section id="runtime-mutation" className="mutation-panel">
              <header>
                <div>
                  <p className="eyebrow">CONTROLLED MUTATION</p>
                  <h2>{t("先读取旧值，再明确修改。")}</h2>
                </div>
                <RiskPill level={mutationRisk} />
              </header>
              <p>{mutationImpact}</p>
              <div className="mutation-fields">
                <Label>
                  <span>{t("操作")}</span>
                  <SelectControl
                    value={selectedMutation}
                    onValueChange={(value) =>
                      setSelectedMutation(value as MutationAction)
                    }
                  >
                    <SelectControlItem value="system.property.set">
                      system.property.set
                    </SelectControlItem>
                    <SelectControlItem value="logging.set">
                      logging.set · JUL
                    </SelectControlItem>
                    <SelectControlItem value="vm.option.set">
                      vm.option.set
                    </SelectControlItem>
                    <SelectControlItem value="gc.run">
                      gc.run
                    </SelectControlItem>
                  </SelectControl>
                </Label>
                {selectedMutation !== "gc.run" && (
                  <Label>
                    <span>{mutationNameLabel}</span>
                    <Input
                      value={mutationName}
                      onChange={(event) =>
                        setMutationName(event.target.value.trim())
                      }
                      autoComplete="off"
                    />
                  </Label>
                )}
                {selectedMutation === "logging.set" ? (
                  <Label>
                    <span>{t("新值")}</span>
                    <SelectControl
                      value={mutationNewValue}
                      onValueChange={(value) =>
                        setMutationNewValue(value)
                      }
                    >
                      <SelectControlItem value="">
                        {t("选择级别")}
                      </SelectControlItem>
                      <SelectControlItem value="<inherited>">
                        &lt;inherited&gt;
                      </SelectControlItem>
                      {JUL_LEVELS.map((level) => (
                        <SelectControlItem key={level} value={level}>
                          {level}
                        </SelectControlItem>
                      ))}
                    </SelectControl>
                  </Label>
                ) : (
                  selectedMutation !== "gc.run" && (
                    <Label>
                      <span>{t("新值")}</span>
                      <Input
                        value={mutationNewValue}
                        onChange={(event) =>
                          setMutationNewValue(event.target.value)
                        }
                        autoComplete="off"
                      />
                    </Label>
                  )
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={
                  Boolean(
                    selectedMutation !== "gc.run" &&
                      (!mutationName || !mutationNewValue),
                  ) || Boolean(mutationLoading)
                }
                onClick={() => void prepareMutation()}
                aria-busy={Boolean(mutationLoading)}
              >
                {Boolean(mutationLoading) && <Spinner />}
                {t("读取旧值并生成影响预览")}
              </Button>

              {mutationError && (
                <Alert variant="destructive">
                  <AlertDescription>{t(mutationError)}</AlertDescription>
                </Alert>
              )}

              {mutationPrepared && (
                <div className="mutation-preview">
                  <dl>
                    <div>
                      <dt>{t("精确目标")}</dt>
                      <dd>{connection?.target.displayName}</dd>
                    </div>
                    {selectedMutation !== "gc.run" && (
                      <div>
                        <dt>{mutationNameLabel}</dt>
                        <dd>{mutationName}</dd>
                      </div>
                    )}
                    <div>
                      <dt>{t("旧值")}</dt>
                      <dd>{mutationOldValue}</dd>
                    </div>
                    {selectedMutation !== "gc.run" && (
                      <div>
                        <dt>{t("新值")}</dt>
                        <dd>{mutationNewValue}</dd>
                      </div>
                    )}
                  </dl>
                  <p>
                    {selectedMutation === "gc.run"
                      ? t("GC 请求无法回滚。")
                      : t("成功后会返回可用于恢复的旧值和校验参数。")}
                  </p>
                  <Label className="confirmation-check">
                    <Checkbox
                      checked={mutationConfirmed}
                      onCheckedChange={(event) =>
                        setMutationConfirmed(event === true)
                      }
                    />
                    <span>{t("我已核对精确目标、旧值、新值与影响。")}</span>
                  </Label>
                  {selectedMutation === "gc.run" && (
                    <Label className="confirmation-check">
                      <Checkbox
                        checked={mutationConfirmedSecondary}
                        onCheckedChange={(event) =>
                          setMutationConfirmedSecondary(event === true)
                        }
                      />
                      <span>{t("我再次确认允许目标 JVM 发生潜在停顿。")}</span>
                    </Label>
                  )}
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      Boolean(
                        !mutationConfirmed ||
                          (selectedMutation === "gc.run" &&
                            !mutationConfirmedSecondary),
                      ) || Boolean(mutationLoading)
                    }
                    onClick={() => void executeMutation()}
                    aria-busy={Boolean(mutationLoading)}
                  >
                    {Boolean(mutationLoading) && <Spinner />}
                    {t("确认执行受控修改")}
                  </Button>
                </div>
              )}
            </section>
          )}

          {activeWorkspace === "mutation" && mutationResult && (
            <section className="runtime-result">
              <header>
                <div>
                  <p className="eyebrow">MUTATION RESULT</p>
                  <p className="runtime-result__title">
                    {mutationResult.actionId}
                  </p>
                </div>
                <StatusPill
                  state={
                    mutationResult.status === "SUCCEEDED" ? "ready" : "error"
                  }
                  label={mutationResult.status}
                />
              </header>
              {mutationResult.message && <p>{mutationResult.message}</p>}
              <dl>
                {Object.entries(mutationResult.values).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value || t("未知")}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {activeWorkspace === "facts" && (
            <Disclosure
              className="capability-disclosure"
              trigger={
                <>
                  <span>{t("目标能力矩阵")}</span>
                  <span>
                    {t("{count} 项", {
                      count: connection?.capabilities.length ?? 0,
                    })}
                  </span>
                </>
              }
            >
              <section className="capability-grid">
                {(connection?.capabilities ?? []).map((capability) => (
                  <article key={capability.id}>
                    <p className="eyebrow">{capability.id}</p>
                    <StatusPill
                      state={
                        capability.state === "AVAILABLE" ? "ready" : "idle"
                      }
                      label={capability.state}
                    />
                    <p>{capability.reason ?? t("目标已声明此能力。")}</p>
                  </article>
                ))}
              </section>
            </Disclosure>
          )}
        </>
      )}
    </section>
  );
}
