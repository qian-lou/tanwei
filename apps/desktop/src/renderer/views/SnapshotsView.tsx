import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { ActionResult } from "@shared/contracts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Disclosure } from "@/components/ui/disclosure";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import StatusPill from "../components/StatusPill";
import StatePagination from "../components/StatePagination";
import { t, useLocale } from "../i18n";
import {
  buildInvocationValueDiff,
  type InvocationValueDiff,
  type InvocationValueDiffInput,
  type InvocationValueEvidence,
  type InvocationValueKind,
  type InvocationValueNode,
} from "../invocation-value-diff";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./SnapshotsView.css";
import { Spinner } from "@/components/ui/spinner";

type SnapshotOutcome = "RETURNED" | "THREW";
type OutcomeFilter = "ALL" | SnapshotOutcome;
type ScopeFilter = "ROOT" | "ALL";
type ReplayMode = "STATIC" | "INSTANCE" | "NONE";
type ReplayFilter =
  | "ALL"
  | "REPLAYABLE"
  | "STATIC"
  | "INSTANCE"
  | "UNAVAILABLE";

interface SnapshotSummary {
  readonly snapshotId: number;
  readonly taskId: string;
  readonly className: string;
  readonly sequence: number;
  readonly depth: number;
  readonly method: string;
  readonly capturedAtEpochMillis: number;
  readonly durationNanos: number;
  readonly threadName: string;
  readonly outcome: SnapshotOutcome;
  readonly exceptionType: string;
  readonly replayEligible: boolean;
  readonly replayMode: ReplayMode;
  readonly receiverType: string;
  readonly receiverAvailable: boolean;
  readonly replayDeniedReason: string;
}

interface ReceiverStateField {
  readonly name: string;
  readonly value: string;
}

interface ReceiverStateEvidence {
  readonly available: boolean;
  readonly scannedFields: number;
  readonly unavailableFields: number;
  readonly truncated: boolean;
  readonly fields: readonly ReceiverStateField[];
}

interface ReceiverStateChange {
  readonly name: string;
  readonly before: string;
  readonly after: string;
  readonly kind: "CHANGED" | "ADDED" | "REMOVED";
}

interface SnapshotDetails extends SnapshotSummary {
  readonly classLoader: string;
  readonly rootMethodName: string;
  readonly parameterTypes: string;
  readonly modifiers: string;
  readonly parentSequence: number;
  readonly returnValue: string;
  readonly exceptionMessage: string;
  readonly arguments: readonly string[];
  readonly callStack: readonly string[];
  readonly receiverState: ReceiverStateEvidence;
  readonly invocationValues: InvocationValueEvidence;
}

const PAGE_SIZE = 50;
const MAXIMUM_DURATION_MILLIS = 3_600_000;

function parseSafeNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseSignedNumber(value: string | undefined): number {
  const parsed = Number(value ?? -1);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function parseReplayMode(
  value: string | undefined,
  replayEligible: boolean,
): ReplayMode {
  if (value === "STATIC" || value === "INSTANCE" || value === "NONE") {
    return value;
  }
  return replayEligible ? "STATIC" : "NONE";
}

function parseSummary(
  values: Readonly<Record<string, string>>,
  prefix: string,
): SnapshotSummary | null {
  const snapshotId = parseSafeNumber(values[`${prefix}snapshotId`]);
  const itemOutcome = values[`${prefix}outcome`];
  if (
    snapshotId <= 0 ||
    (itemOutcome !== "RETURNED" && itemOutcome !== "THREW")
  ) {
    return null;
  }
  const replayEligible = values[`${prefix}replayEligible`] === "true";
  return {
    snapshotId,
    taskId: values[`${prefix}taskId`] ?? "",
    className: values[`${prefix}className`] ?? "",
    sequence: parseSafeNumber(values[`${prefix}sequence`]),
    depth: parseSafeNumber(values[`${prefix}depth`]),
    method: values[`${prefix}method`] ?? "",
    capturedAtEpochMillis: parseSafeNumber(
      values[`${prefix}capturedAtEpochMillis`],
    ),
    durationNanos: parseSafeNumber(values[`${prefix}durationNanos`]),
    threadName: values[`${prefix}threadName`] ?? "",
    outcome: itemOutcome,
    exceptionType: values[`${prefix}exceptionType`] ?? "",
    replayEligible,
    replayMode: parseReplayMode(values[`${prefix}replayMode`], replayEligible),
    receiverType: values[`${prefix}receiverType`] ?? "",
    receiverAvailable: values[`${prefix}receiverAvailable`] === "true",
    replayDeniedReason: values[`${prefix}replayDeniedReason`] ?? "",
  };
}

function parseSnapshotList(
  values: Readonly<Record<string, string>>,
): readonly SnapshotSummary[] {
  const count = Math.min(parseSafeNumber(values.count), PAGE_SIZE);
  return Array.from({ length: count }, (_, index) =>
    parseSummary(values, `snapshot.${String(index).padStart(4, "0")}.`),
  ).filter((snapshot): snapshot is SnapshotSummary => snapshot !== null);
}

function parseReceiverState(
  values: Readonly<Record<string, string>>,
  prefix: string,
): ReceiverStateEvidence {
  const count = Math.min(parseSafeNumber(values[`${prefix}count`]), 16);
  return {
    available: values[`${prefix}available`] === "true",
    scannedFields: Math.min(
      parseSafeNumber(values[`${prefix}scannedFields`]),
      128,
    ),
    unavailableFields: Math.min(
      parseSafeNumber(values[`${prefix}unavailableFields`]),
      16,
    ),
    truncated: values[`${prefix}truncated`] === "true",
    fields: Array.from({ length: count }, (_, index) => {
      const fieldPrefix = `${prefix}${String(index).padStart(2, "0")}.`;
      return {
        name: values[`${fieldPrefix}name`] ?? "",
        value: values[`${fieldPrefix}value`] ?? "",
      };
    }).filter((field) => field.name.length > 0),
  };
}

function parseReceiverStateChanges(
  values: Readonly<Record<string, string>>,
  prefix: string,
): readonly ReceiverStateChange[] {
  const count = Math.min(parseSafeNumber(values[`${prefix}count`]), 32);
  return Array.from({ length: count }, (_, index) => {
    const changePrefix = `${prefix}${String(index).padStart(2, "0")}.`;
    const rawKind = values[`${changePrefix}kind`];
    const kind: ReceiverStateChange["kind"] =
      rawKind === "ADDED" || rawKind === "REMOVED" ? rawKind : "CHANGED";
    return {
      name: values[`${changePrefix}name`] ?? "",
      before: values[`${changePrefix}before`] ?? "",
      after: values[`${changePrefix}after`] ?? "",
      kind,
    };
  }).filter((change) => change.name.length > 0);
}

function isInvocationValueKind(
  value: string | undefined,
): value is InvocationValueKind {
  return (
    value === "NULL" ||
    value === "SCALAR" ||
    value === "OBJECT" ||
    value === "ARRAY" ||
    value === "COLLECTION" ||
    value === "MAP" ||
    value === "ENTRY" ||
    value === "REFERENCE" ||
    value === "MASKED" ||
    value === "UNAVAILABLE" ||
    value === "OPAQUE"
  );
}

function parseInvocationValues(
  values: Readonly<Record<string, string>>,
  prefix: string,
): InvocationValueEvidence {
  const available = values[`${prefix}available`] === "true";
  const scannedFields = Math.min(
    parseSafeNumber(values[`${prefix}scannedFields`]),
    256,
  );
  const truncated = values[`${prefix}truncated`] === "true";
  if (!available) {
    return { available: false, scannedFields, truncated, nodes: [] };
  }
  const count = Math.min(parseSafeNumber(values[`${prefix}count`]), 96);
  const nodes: InvocationValueNode[] = [];
  for (let index = 0; index < count; index += 1) {
    const nodePrefix = `${prefix}${String(index).padStart(3, "0")}.`;
    const path = values[`${nodePrefix}path`] ?? "";
    const parentIndex = parseSignedNumber(values[`${nodePrefix}parentIndex`]);
    const depth = parseSafeNumber(values[`${nodePrefix}depth`]);
    const kind = values[`${nodePrefix}kind`];
    const parent = parentIndex >= 0 ? nodes[parentIndex] : null;
    if (
      path.length === 0 ||
      parentIndex < -1 ||
      parentIndex >= index ||
      depth > 3 ||
      !isInvocationValueKind(kind) ||
      (parentIndex === -1 && depth !== 0) ||
      (parentIndex >= 0 && (!parent || parent.depth + 1 !== depth))
    ) {
      return {
        available: false,
        scannedFields: 0,
        truncated: true,
        nodes: [],
      };
    }
    nodes.push({
      path,
      parentIndex,
      depth,
      kind,
      typeName: values[`${nodePrefix}typeName`] ?? "",
      value: values[`${nodePrefix}value`] ?? "",
      childCount: parseSafeNumber(values[`${nodePrefix}childCount`]),
      truncated: values[`${nodePrefix}truncated`] === "true",
    });
  }
  return { available, scannedFields, truncated, nodes };
}

function displayReceiverFieldName(name: string): string {
  const separator = name.lastIndexOf("#");
  if (separator <= 0 || separator === name.length - 1) {
    return name;
  }
  return name.slice(separator + 1);
}

function parseDetails(
  values: Readonly<Record<string, string>>,
): SnapshotDetails {
  const summary = parseSummary(values, "");
  if (!summary) {
    throw new Error(t("Agent 返回了无效的快照详情"));
  }
  const argumentCount = Math.min(parseSafeNumber(values["argument.count"]), 16);
  const stackCount = Math.min(parseSafeNumber(values["stack.count"]), 12);
  return {
    ...summary,
    classLoader: values.classLoader ?? "",
    rootMethodName: values.rootMethodName ?? "",
    parameterTypes: values.parameterTypes ?? "",
    modifiers: values.modifiers ?? "",
    parentSequence: parseSignedNumber(values.parentSequence),
    returnValue: values.returnValue ?? "",
    exceptionMessage: values.exceptionMessage ?? "",
    arguments: Array.from(
      { length: argumentCount },
      (_, index) => values[`argument.${String(index).padStart(2, "0")}`] ?? "",
    ),
    callStack: Array.from(
      { length: stackCount },
      (_, index) => values[`stack.${String(index).padStart(2, "0")}`] ?? "",
    ),
    receiverState: parseReceiverState(values, "receiverState."),
    invocationValues: parseInvocationValues(values, "invocationValue."),
  };
}

function ReceiverStateCoverage({
  state,
}: {
  readonly state: ReceiverStateEvidence;
}) {
  return (
    <div className="receiver-state-coverage">
      <Badge variant="secondary">
        {t("{count} 个标量字段", { count: state.fields.length })}
      </Badge>
      <span>{t("扫描 {count} 个字段", { count: state.scannedFields })}</span>
      {state.unavailableFields > 0 && (
        <Badge variant="outline">
          {t("{count} 个不可读取", {
            count: state.unavailableFields,
          })}
        </Badge>
      )}
      {state.truncated && <Badge variant="outline">{t("已截断")}</Badge>}
    </div>
  );
}

function ReceiverStateFields({
  state,
}: {
  readonly state: ReceiverStateEvidence;
}) {
  if (!state.available) {
    return <p className="receiver-state-empty">{t("实例状态不可读取。")}</p>;
  }
  if (state.fields.length === 0) {
    return (
      <p className="receiver-state-empty">
        {t("未发现可安全读取的实例标量字段。")}
      </p>
    );
  }
  return (
    <Table className="receiver-state-table">
      <TableHeader>
        <TableRow>
          <TableHead>{t("字段")}</TableHead>
          <TableHead>{t("捕获值")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {state.fields.map((field) => (
          <TableRow key={field.name}>
            <TableCell>
              <code title={field.name}>
                {displayReceiverFieldName(field.name)}
              </code>
            </TableCell>
            <TableCell>
              <code>{field.value}</code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ReceiverStateChanges({
  changes,
  emptyMessage,
}: {
  readonly changes: readonly ReceiverStateChange[];
  readonly emptyMessage: string;
}) {
  if (changes.length === 0) {
    return <p className="receiver-state-empty">{emptyMessage}</p>;
  }
  return (
    <Table className="receiver-state-table receiver-state-table--changes">
      <TableHeader>
        <TableRow>
          <TableHead>{t("字段")}</TableHead>
          <TableHead>{t("之前")}</TableHead>
          <TableHead>{t("之后")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {changes.map((change) => (
          <TableRow key={`${change.kind}:${change.name}`}>
            <TableCell>
              <code title={change.name}>
                {displayReceiverFieldName(change.name)}
              </code>
              <Badge variant="outline">
                {change.kind === "ADDED"
                  ? t("新增")
                  : change.kind === "REMOVED"
                    ? t("移除")
                    : t("变化")}
              </Badge>
            </TableCell>
            <TableCell>
              <code>{change.before || "—"}</code>
            </TableCell>
            <TableCell>
              <code>{change.after || "—"}</code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const INVOCATION_KIND_LABELS: Readonly<Record<InvocationValueKind, string>> = {
  NULL: "空值",
  SCALAR: "标量",
  OBJECT: "对象",
  ARRAY: "数组",
  COLLECTION: "集合",
  MAP: "映射",
  ENTRY: "键值项",
  REFERENCE: "引用",
  MASKED: "已遮罩",
  UNAVAILABLE: "不可读取",
  OPAQUE: "不展开",
};

function displayInvocationNodePath(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > 0 ? path.slice(dot + 1) : path;
}

function displayInvocationType(typeName: string): string {
  if (!typeName) {
    return "—";
  }
  const arraySuffix = typeName.endsWith("[]") ? "[]" : "";
  const base = arraySuffix ? typeName.slice(0, -2) : typeName;
  return `${base.slice(base.lastIndexOf(".") + 1)}${arraySuffix}`;
}

function shouldShowInvocationValues(details: SnapshotDetails): boolean {
  return (
    !details.invocationValues.available ||
    details.invocationValues.nodes.some(
      (node) => node.kind !== "NULL" && node.kind !== "SCALAR",
    ) ||
    details.arguments.some((argument) => /^<[^>]+>$/u.test(argument)) ||
    /^<[^>]+>$/u.test(details.returnValue)
  );
}

function InvocationValuesInspector({
  evidence,
}: {
  readonly evidence: InvocationValueEvidence;
}) {
  if (!evidence.available) {
    return (
      <p className="invocation-value-empty">
        {t("结构化调用上下文不可读取。")}
      </p>
    );
  }
  if (evidence.nodes.length === 0) {
    return (
      <p className="invocation-value-empty">
        {t("此调用没有可展开的参数或返回值。")}
      </p>
    );
  }
  return (
    <>
      <div className="invocation-value-coverage">
        <Badge variant="secondary">
          {t("{count} 个结构节点", { count: evidence.nodes.length })}
        </Badge>
        <span>
          {t("扫描 {count} 个字段", { count: evidence.scannedFields })}
        </span>
        {evidence.truncated && <Badge variant="outline">{t("已截断")}</Badge>}
      </div>
      <Table className="invocation-value-table">
        <TableHeader>
          <TableRow>
            <TableHead>{t("节点")}</TableHead>
            <TableHead>{t("类型")}</TableHead>
            <TableHead>{t("种类")}</TableHead>
            <TableHead>{t("捕获值")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {evidence.nodes.map((node, index) => (
            <TableRow key={`${index}:${node.path}`}>
              <TableCell>
                <div
                  className={cn(
                    "invocation-value-path",
                    `invocation-value-path--depth-${node.depth}`,
                  )}
                >
                  <code title={node.path}>
                    {displayInvocationNodePath(node.path)}
                  </code>
                  {node.truncated && (
                    <Badge variant="outline">{t("截断")}</Badge>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <code title={node.typeName}>
                  {displayInvocationType(node.typeName)}
                </code>
              </TableCell>
              <TableCell>
                <Badge variant="outline">
                  {t(INVOCATION_KIND_LABELS[node.kind])}
                </Badge>
              </TableCell>
              <TableCell>
                <code>
                  {node.value ||
                    (node.childCount > 0
                      ? t("{count} 个子项", { count: node.childCount })
                      : "—")}
                </code>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function invocationDiffInput(
  details: SnapshotDetails,
): InvocationValueDiffInput {
  return {
    snapshotId: details.snapshotId,
    className: details.className,
    classLoader: details.classLoader,
    method: details.method,
    invocationValues: details.invocationValues,
  };
}

function displayInvocationNodeValue(node: InvocationValueNode | null): string {
  if (!node) {
    return "—";
  }
  if (node.value) {
    return node.value;
  }
  if (node.childCount > 0) {
    return t("{count} 个子项", { count: node.childCount });
  }
  return t(INVOCATION_KIND_LABELS[node.kind]);
}

function InvocationValueDiffInspector({
  diff,
}: {
  readonly diff: InvocationValueDiff;
}) {
  if (diff.compatibility === "SAME_SNAPSHOT") {
    return (
      <p className="invocation-value-empty">
        {t("当前快照已固定为基线；请从左侧选择另一条快照进行比较。")}
      </p>
    );
  }
  if (diff.compatibility === "METHOD_MISMATCH") {
    return (
      <p className="invocation-value-empty">
        {t("只能比较同一精确类、ClassLoader 与方法签名的调用快照。")}
      </p>
    );
  }
  if (diff.compatibility === "VALUES_UNAVAILABLE") {
    return (
      <p className="invocation-value-empty">
        {t("至少一条快照缺少结构化调用上下文，无法比较字段。")}
      </p>
    );
  }

  return (
    <>
      <div className="invocation-diff-coverage">
        <Badge variant="secondary">
          {t("{count} 个变化", { count: diff.changedCount })}
        </Badge>
        <Badge variant="outline">
          {t("{count} 个新增", { count: diff.addedCount })}
        </Badge>
        <Badge variant="outline">
          {t("{count} 个移除", { count: diff.removedCount })}
        </Badge>
        <span>{t("{count} 个未变化", { count: diff.unchangedCount })}</span>
        {diff.truncated && <Badge variant="outline">{t("部分比较")}</Badge>}
      </div>
      {diff.changes.length === 0 ? (
        <p className="invocation-value-empty">
          {t("两次调用未发现结构字段差异。")}
        </p>
      ) : (
        <Table className="invocation-diff-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("节点")}</TableHead>
              <TableHead>{t("状态")}</TableHead>
              <TableHead>{t("基线值")}</TableHead>
              <TableHead>{t("当前值")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {diff.changes.map((change) => (
              <TableRow key={change.key} data-change-kind={change.kind}>
                <TableCell>
                  <div
                    className={cn(
                      "invocation-value-path",
                      `invocation-value-path--depth-${change.depth}`,
                    )}
                  >
                    <code title={change.path}>
                      {displayInvocationNodePath(change.path)}
                    </code>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {change.kind === "ADDED"
                      ? t("新增")
                      : change.kind === "REMOVED"
                        ? t("移除")
                        : t("变化")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <code title={change.before?.typeName}>
                    {displayInvocationNodeValue(change.before)}
                  </code>
                </TableCell>
                <TableCell>
                  <code title={change.after?.typeName}>
                    {displayInvocationNodeValue(change.after)}
                  </code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function replayParameters(
  snapshot: SnapshotDetails,
): Readonly<Record<string, string>> {
  const parameters: Record<string, string> = {
    className: snapshot.className,
    classLoader: snapshot.classLoader,
    methodName: snapshot.rootMethodName,
    parameterTypes: snapshot.parameterTypes,
    argumentCount: String(snapshot.arguments.length),
    snapshotId: String(snapshot.snapshotId),
    replayMode: snapshot.replayMode,
    argument0: "",
    argument1: "",
    argument2: "",
    argument3: "",
    argument4: "",
    argument5: "",
    argument6: "",
    argument7: "",
  };
  snapshot.arguments.forEach((argument, index) => {
    parameters[`argument${index}`] = argument;
  });
  return parameters;
}

function formatDuration(durationNanos: number): string {
  if (durationNanos < 1_000) {
    return `${durationNanos} ns`;
  }
  if (durationNanos < 1_000_000) {
    return `${(durationNanos / 1_000).toFixed(2)} µs`;
  }
  return `${(durationNanos / 1_000_000).toFixed(2)} ms`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1_024).toFixed(1)} KiB`;
}

function formatCapturedAt(epochMillis: number): string {
  return epochMillis > 0 ? new Date(epochMillis).toLocaleString() : t("未知");
}

function durationFilterParameter(value: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    return "0";
  }
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(t("耗时筛选必须是非负整数毫秒"));
  }
  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAXIMUM_DURATION_MILLIS
  ) {
    throw new Error(t("耗时筛选必须在 0 到 3600000 毫秒之间"));
  }
  return String(parsed);
}

export default function SnapshotsView() {
  useLocale();
  const navigate = useNavigate();
  const selectedTargetId = useTargetsStore((s) => s.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<OutcomeFilter>("ALL");
  const [scope, setScope] = useState<ScopeFilter>("ROOT");
  const [taskIdFilter, setTaskIdFilter] = useState("");
  const [threadQuery, setThreadQuery] = useState("");
  const [replayFilter, setReplayFilter] = useState<ReplayFilter>("ALL");
  const [minimumDurationMillis, setMinimumDurationMillis] = useState("");
  const [maximumDurationMillis, setMaximumDurationMillis] = useState("");
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [retained, setRetained] = useState(0);
  const [returned, setReturned] = useState(0);
  const [threw, setThrew] = useState(0);
  const [rootCount, setRootCount] = useState(0);
  const [internalCount, setInternalCount] = useState(0);
  const [evicted, setEvicted] = useState(0);
  const [estimatedBytes, setEstimatedBytes] = useState(0);
  const [snapshots, setSnapshots] = useState<readonly SnapshotSummary[]>([]);
  const [selectedId, setSelectedIdState] = useState<number | null>(null);
  const [details, setDetails] = useState<SnapshotDetails | null>(null);
  const [comparisonBaseline, setComparisonBaseline] =
    useState<SnapshotDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [replayPreview, setReplayPreview] = useState<ActionResult | null>(null);
  const [replayResult, setReplayResult] = useState<ActionResult | null>(null);
  const [replayConfirmed, setReplayConfirmed] = useState(false);
  const [replaySecondaryConfirmed, setReplaySecondaryConfirmed] =
    useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [savedSnapshotId, setSavedSnapshotId] = useState<string | null>(null);
  const detailRequestIdRef = useRef(0);
  const selectedIdRef = useRef<number | null>(null);

  function setSelectedId(value: number | null): void {
    selectedIdRef.current = value;
    setSelectedIdState(value);
  }

  const snapshotCapability = connection?.capabilities.find(
    (capability) => capability.id === "snapshots",
  );
  const replayCapabilityAvailable = Boolean(
    connection?.capabilities.some(
      (capability) =>
        capability.id === "invoke-replay" && capability.state === "AVAILABLE",
    ),
  );

  function resetReplay(): void {
    setReplayPreview(null);
    setReplayResult(null);
    setReplayConfirmed(false);
    setReplaySecondaryConfirmed(false);
  }

  async function selectSnapshot(snapshot: SnapshotSummary): Promise<void> {
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!targetId) {
      return;
    }
    const requestId = ++detailRequestIdRef.current;
    setSelectedId(snapshot.snapshotId);
    setDetails(null);
    setDeleteConfirmed(false);
    setSavedSnapshotId(null);
    resetReplay();
    setLoadingDetails(true);
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "snapshot.describe",
        parameters: {
          snapshotId: String(snapshot.snapshotId),
        },
      });
      if (
        requestId !== detailRequestIdRef.current ||
        useTargetsStore.getState().selectedTargetId !== targetId
      ) {
        return;
      }
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取快照详情"),
        );
        return;
      }
      setDetails(parseDetails(response.value.values));
    } catch (error) {
      if (requestId === detailRequestIdRef.current) {
        setErrorMessage(
          error instanceof Error ? error.message : t("无法读取快照详情"),
        );
      }
    } finally {
      if (requestId === detailRequestIdRef.current) {
        setLoadingDetails(false);
      }
    }
  }

  async function loadSnapshots(nextOffset = 0): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const targetId = targetsState.selectedTargetId;
    const currentConnection = selectConnection(targetsState);
    const capability = currentConnection?.capabilities.find(
      (item) => item.id === "snapshots",
    );
    if (
      !targetId ||
      currentConnection?.state !== "READY" ||
      capability?.state !== "AVAILABLE"
    ) {
      setSnapshots([]);
      setDetails(null);
      setSelectedId(null);
      setComparisonBaseline(null);
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const minimumDuration = durationFilterParameter(minimumDurationMillis);
      const maximumDuration = durationFilterParameter(maximumDurationMillis);
      if (
        Number(maximumDuration) > 0 &&
        Number(maximumDuration) < Number(minimumDuration)
      ) {
        throw new Error(t("最大耗时必须为 0 或不小于最小耗时"));
      }
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "snapshot.list",
        parameters: {
          query: query.trim(),
          outcome,
          scope,
          taskId: taskIdFilter.trim(),
          threadQuery: threadQuery.trim(),
          replay: replayFilter,
          minimumDurationMillis: minimumDuration,
          maximumDurationMillis: maximumDuration,
          offset: String(Math.max(0, nextOffset)),
          limit: String(PAGE_SIZE),
        },
      });
      if (useTargetsStore.getState().selectedTargetId !== targetId) {
        return;
      }
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取调用快照"),
        );
        return;
      }

      const values = response.value.values;
      const nextSnapshots = parseSnapshotList(values);
      setOffset(parseSafeNumber(values.offset));
      setTotal(parseSafeNumber(values.total));
      setRetained(parseSafeNumber(values.retained));
      setReturned(parseSafeNumber(values.returned));
      setThrew(parseSafeNumber(values.threw));
      setRootCount(parseSafeNumber(values.root));
      setInternalCount(parseSafeNumber(values.internal));
      setEvicted(parseSafeNumber(values.evicted));
      setEstimatedBytes(parseSafeNumber(values.estimatedBytes));
      setSnapshots(nextSnapshots);

      const nextSelected =
        nextSnapshots.find(
          (snapshot) => snapshot.snapshotId === selectedIdRef.current,
        ) ??
        nextSnapshots[0] ??
        null;
      if (nextSelected) {
        await selectSnapshot(nextSelected);
      } else {
        setSelectedId(null);
        setDetails(null);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取调用快照"),
      );
    } finally {
      setLoading(false);
    }
  }

  async function deleteSnapshot(): Promise<void> {
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!targetId || !details || !deleteConfirmed) {
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "snapshot.delete",
        parameters: {
          snapshotId: String(details.snapshotId),
        },
      });
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("无法删除调用快照"),
        );
        return;
      }
      setSelectedId(null);
      setDetails(null);
      if (comparisonBaseline?.snapshotId === details.snapshotId) {
        setComparisonBaseline(null);
      }
      const nextOffset =
        snapshots.length === 1 ? Math.max(0, offset - PAGE_SIZE) : offset;
      await loadSnapshots(nextOffset);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法删除调用快照"),
      );
    } finally {
      setLoading(false);
    }
  }

  async function saveSnapshotToDesktop(): Promise<void> {
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (!targetId || !details) {
      return;
    }
    setSavingSnapshot(true);
    setSavedSnapshotId(null);
    setErrorMessage(null);
    try {
      const response = await window.tanwei.saveInvocationSnapshot({
        targetId,
        snapshotId: details.snapshotId,
      });
      if (!response.ok || !response.value) {
        setErrorMessage(response.errorMessage ?? t("无法把调用快照固定到桌面"));
        return;
      }
      setSavedSnapshotId(response.value.id);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法把调用快照固定到桌面"),
      );
    } finally {
      setSavingSnapshot(false);
    }
  }

  async function previewReplay(): Promise<void> {
    const targetId = useTargetsStore.getState().selectedTargetId;
    const snapshot = details;
    if (!targetId || !snapshot?.replayEligible || !replayCapabilityAvailable) {
      return;
    }
    setReplayLoading(true);
    setErrorMessage(null);
    resetReplay();
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "invoke.replay.preview",
        parameters: replayParameters(snapshot),
      });
      if (
        useTargetsStore.getState().selectedTargetId !== targetId ||
        selectedIdRef.current !== snapshot.snapshotId
      ) {
        return;
      }
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ??
            response.value?.message ??
            t("调用重放预检失败"),
        );
        return;
      }
      setReplayPreview(response.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("调用重放预检失败"),
      );
    } finally {
      setReplayLoading(false);
    }
  }

  async function executeReplay(): Promise<void> {
    const snapshot = details;
    const fingerprint = replayPreview?.values.fingerprint;
    const targetId = useTargetsStore.getState().selectedTargetId;
    if (
      !targetId ||
      !snapshot ||
      !fingerprint ||
      !replayConfirmed ||
      !replaySecondaryConfirmed
    ) {
      return;
    }
    setReplayLoading(true);
    setErrorMessage(null);
    setReplayResult(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId,
        actionId: "invoke.replay",
        parameters: {
          ...replayParameters(snapshot),
          expectedFingerprint: fingerprint,
          confirmed: "true",
          confirmedSecondary: "true",
        },
      });
      if (
        useTargetsStore.getState().selectedTargetId !== targetId ||
        selectedIdRef.current !== snapshot.snapshotId
      ) {
        return;
      }
      setReplayResult(response.value);
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setErrorMessage(
          response.errorMessage ?? response.value?.message ?? t("调用重放失败"),
        );
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("调用重放失败"),
      );
    } finally {
      setReplayLoading(false);
    }
  }

  const loadSnapshotsRef = useRef(loadSnapshots);
  useEffect(() => {
    loadSnapshotsRef.current = loadSnapshots;
  });

  const targetWatchRef = useRef(selectedTargetId);
  useEffect(() => {
    if (targetWatchRef.current === selectedTargetId) {
      return;
    }
    targetWatchRef.current = selectedTargetId;
    detailRequestIdRef.current += 1;
    setSelectedId(null);
    setDetails(null);
    setSavedSnapshotId(null);
    setComparisonBaseline(null);
    void loadSnapshotsRef.current(0);
  }, [selectedTargetId]);

  const filterWatchRef = useRef<readonly [OutcomeFilter, ScopeFilter]>([
    outcome,
    scope,
  ]);
  useEffect(() => {
    const [previousOutcome, previousScope] = filterWatchRef.current;
    if (previousOutcome === outcome && previousScope === scope) {
      return;
    }
    filterWatchRef.current = [outcome, scope];
    setSelectedId(null);
    setDetails(null);
    void loadSnapshotsRef.current(0);
  }, [outcome, scope]);

  useEffect(() => {
    void loadSnapshotsRef.current(0);
  }, []);

  const advancedFilterCount = [
    taskIdFilter.trim(),
    threadQuery.trim(),
    replayFilter === "ALL" ? "" : replayFilter,
    minimumDurationMillis.trim(),
    maximumDurationMillis.trim(),
  ].filter(Boolean).length;

  function clearAdvancedFilters(): void {
    setTaskIdFilter("");
    setThreadQuery("");
    setReplayFilter("ALL");
    setMinimumDurationMillis("");
    setMaximumDurationMillis("");
    setErrorMessage(null);
  }

  const previewReceiverState = replayPreview
    ? parseReceiverState(replayPreview.values, "currentState.")
    : null;
  const previewStateDrift = replayPreview
    ? parseReceiverStateChanges(replayPreview.values, "stateDrift.")
    : [];
  const replayBeforeState = replayResult
    ? parseReceiverState(replayResult.values, "beforeState.")
    : null;
  const replayStateChanges = replayResult
    ? parseReceiverStateChanges(replayResult.values, "stateChange.")
    : [];
  const invocationDiff =
    comparisonBaseline && details
      ? buildInvocationValueDiff(
          invocationDiffInput(comparisonBaseline),
          invocationDiffInput(details),
        )
      : null;

  return (
    <section className="page snapshots-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">INVOCATION SNAPSHOTS</p>
          <h1>{t("把一次调用，变成可检索证据。")}</h1>
        </div>
        <div className="flex flex-col items-end gap-3">
          <p className="page-heading__summary">
            {t(
              "跨观测任务检索调用时间、耗时、线程、参数、结果与来源栈；快照只保存安全字符串，并以弱引用关联可重放的原实例。",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate("/snapshot-library")}
          >
            {t("打开桌面调用档案")}
          </Button>
        </div>
      </header>

      {connection?.state !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">{t("连接目标后检查调用快照。")}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate("/targets")}
          >
            {t("选择目标")}
          </Button>
        </Empty>
      ) : snapshotCapability?.state !== "AVAILABLE" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">CAPABILITY UNAVAILABLE</p>
          <p className="empty-panel__title">
            {t("当前 Agent 不支持调用快照索引。")}
          </p>
          <p>
            {snapshotCapability?.reason ??
              t("请重新连接目标以加载最新 Agent。")}
          </p>
        </Empty>
      ) : (
        <>
          <Collapsible
            asChild
            open={advancedFiltersOpen}
            onOpenChange={setAdvancedFiltersOpen}
          >
            <form
              className="snapshot-toolbar"
              onSubmit={(event) => {
                event.preventDefault();
                void loadSnapshots(0);
              }}
            >
              <div className="snapshot-toolbar__primary">
              <div className="snapshot-filter-field">
                <Label htmlFor="snapshot-outcome">{t("调用结果")}</Label>
                <Select
                  value={outcome}
                  onValueChange={(value) => setOutcome(value as OutcomeFilter)}
                >
                  <SelectTrigger id="snapshot-outcome" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t("全部结果")}</SelectItem>
                    <SelectItem value="RETURNED">{t("正常返回")}</SelectItem>
                    <SelectItem value="THREW">{t("抛出异常")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="snapshot-filter-field">
                <Label htmlFor="snapshot-scope">{t("调用层级")}</Label>
                <Select
                  value={scope}
                  onValueChange={(value) => setScope(value as ScopeFilter)}
                >
                  <SelectTrigger id="snapshot-scope" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ROOT">{t("仅根调用")}</SelectItem>
                    <SelectItem value="ALL">{t("包含内部调用")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="snapshot-filter-field snapshot-filter-field--query">
                <Label htmlFor="snapshot-query">{t("搜索快照")}</Label>
                <Input
                  id="snapshot-query"
                  value={query}
                  type="search"
                  maxLength={256}
                  placeholder={t("类、方法、线程、参数或异常")}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="outline">
                    {t("高级筛选")}
                    {advancedFilterCount > 0 && (
                      <Badge variant="secondary">{advancedFilterCount}</Badge>
                    )}
                  </Button>
                </CollapsibleTrigger>
                <Button type="submit" variant="secondary" disabled={loading}>
                  {loading ? t("正在搜索…") : t("搜索")}
                </Button>
              </div>

              <CollapsibleContent asChild>
                <Card
                  id="snapshot-advanced-filters"
                  className="snapshot-advanced-filters gap-4 py-4"
                  data-testid="snapshot-advanced-filters"
                >
                <CardHeader className="px-4">
                  <CardTitle>{t("精确缩小调用证据")}</CardTitle>
                  <CardDescription>
                    {t(
                      "任务与线程使用精确/包含匹配；耗时单位为毫秒，0 或留空表示不设边界。",
                    )}
                  </CardDescription>
                  <CardAction>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={advancedFilterCount === 0}
                      onClick={clearAdvancedFilters}
                    >
                      {t("清除高级筛选")}
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="snapshot-advanced-filters__grid px-4">
                  <div className="snapshot-filter-field">
                    <Label htmlFor="snapshot-task-id">{t("任务 ID")}</Label>
                    <Input
                      id="snapshot-task-id"
                      value={taskIdFilter}
                      maxLength={128}
                      placeholder={t("精确任务 ID")}
                      onChange={(event) => setTaskIdFilter(event.target.value)}
                    />
                  </div>
                  <div className="snapshot-filter-field">
                    <Label htmlFor="snapshot-thread-query">{t("线程")}</Label>
                    <Input
                      id="snapshot-thread-query"
                      value={threadQuery}
                      maxLength={128}
                      placeholder={t("线程名称包含")}
                      onChange={(event) => setThreadQuery(event.target.value)}
                    />
                  </div>
                  <div className="snapshot-filter-field">
                    <Label htmlFor="snapshot-replay-filter">
                      {t("重放状态")}
                    </Label>
                    <Select
                      value={replayFilter}
                      onValueChange={(value) =>
                        setReplayFilter(value as ReplayFilter)
                      }
                    >
                      <SelectTrigger
                        id="snapshot-replay-filter"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">{t("全部重放状态")}</SelectItem>
                        <SelectItem value="REPLAYABLE">
                          {t("当前可重放")}
                        </SelectItem>
                        <SelectItem value="STATIC">{t("静态方法")}</SelectItem>
                        <SelectItem value="INSTANCE">{t("原实例")}</SelectItem>
                        <SelectItem value="UNAVAILABLE">
                          {t("不可重放")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="snapshot-filter-field">
                    <Label htmlFor="snapshot-min-duration">
                      {t("最小耗时（ms）")}
                    </Label>
                    <Input
                      id="snapshot-min-duration"
                      value={minimumDurationMillis}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={MAXIMUM_DURATION_MILLIS}
                      placeholder="0"
                      onChange={(event) =>
                        setMinimumDurationMillis(event.target.value)
                      }
                    />
                  </div>
                  <div className="snapshot-filter-field">
                    <Label htmlFor="snapshot-max-duration">
                      {t("最大耗时（ms）")}
                    </Label>
                    <Input
                      id="snapshot-max-duration"
                      value={maximumDurationMillis}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={MAXIMUM_DURATION_MILLIS}
                      placeholder={t("0 = 不限")}
                      onChange={(event) =>
                        setMaximumDurationMillis(event.target.value)
                      }
                    />
                  </div>
                </CardContent>
                </Card>
              </CollapsibleContent>
            </form>
          </Collapsible>

          <div className="snapshot-stats">
            <article>
              <span>{t("当前保留")}</span>
              <strong>{retained}</strong>
            </article>
            <article>
              <span>{t("正常返回")}</span>
              <strong>{returned}</strong>
            </article>
            <article>
              <span>{t("抛出异常")}</span>
              <strong>{threw}</strong>
            </article>
            <article>
              <span>{t("根 / 内部")}</span>
              <strong>
                {rootCount} / {internalCount}
              </strong>
            </article>
            <article>
              <span>{t("内存 / 淘汰")}</span>
              <strong>
                {formatBytes(estimatedBytes)} / {evicted}
              </strong>
            </article>
          </div>

          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          <div className="snapshot-inspector">
            <section className="snapshot-list" aria-label={t("调用快照列表")}>
              <header>
                <div>
                  <p className="eyebrow">TIME INDEX</p>
                  <strong>{t("{count} 个匹配", { count: total })}</strong>
                </div>
                <StatusPill state="idle" label={t("会话内存")} />
              </header>

              {snapshots.length > 0 ? (
                <div className="snapshot-list__items">
                  {snapshots.map((snapshot) => (
                    <Button
                      variant="ghost"
                      key={snapshot.snapshotId}
                      type="button"
                      className={cn(
                        "snapshot-row",
                        snapshot.snapshotId === selectedId &&
                          "snapshot-row--selected",
                      )}
                      onClick={() => void selectSnapshot(snapshot)}
                    >
                      <span className="snapshot-row__index">
                        #{snapshot.snapshotId}
                      </span>
                      <span>
                        <strong>{snapshot.className}</strong>
                        <small>{snapshot.method}</small>
                      </span>
                      <span className="snapshot-row__meta">
                        <span>
                          {formatDuration(snapshot.durationNanos)}
                          {" · "}
                          {snapshot.outcome === "THREW" ? t("异常") : t("返回")}
                        </span>
                        <Badge
                          variant={
                            snapshot.replayEligible ? "outline" : "secondary"
                          }
                        >
                          {snapshot.replayEligible
                            ? snapshot.replayMode === "INSTANCE"
                              ? t("原实例")
                              : t("静态方法")
                            : t("只读")}
                        </Badge>
                      </span>
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="snapshot-list__empty">
                  {loading
                    ? t("正在读取调用快照…")
                    : t("还没有匹配的调用快照。")}
                </div>
              )}

              <footer>
                <StatePagination
                  ariaLabel={t("调用快照分页")}
                  previousLabel={t("上一页")}
                  nextLabel={t("下一页")}
                  previousDisabled={offset === 0 || loading}
                  nextDisabled={offset + snapshots.length >= total || loading}
                  onPrevious={() =>
                    void loadSnapshots(Math.max(0, offset - PAGE_SIZE))
                  }
                  onNext={() => void loadSnapshots(offset + PAGE_SIZE)}
                  summary={t("{start}–{end} / {total}", {
                    start: total === 0 ? 0 : offset + 1,
                    end: Math.min(offset + snapshots.length, total),
                    total,
                  })}
                />
              </footer>
            </section>

            <section className="snapshot-detail">
              {loadingDetails ? (
                <div className="snapshot-detail__empty">
                  <p className="eyebrow">READING SNAPSHOT</p>
                  <p>{t("正在读取快照详情…")}</p>
                </div>
              ) : details ? (
                <>
                  <header className="snapshot-detail__header">
                    <div>
                      <p className="eyebrow">
                        SNAPSHOT #{details.snapshotId} · DEPTH {details.depth}
                      </p>
                      <h2>{details.className}</h2>
                      <code>{details.method}</code>
                    </div>
                    <StatusPill
                      state={details.outcome === "THREW" ? "error" : "ready"}
                      label={
                        details.outcome === "THREW"
                          ? t("抛出异常")
                          : t("正常返回")
                      }
                    />
                  </header>

                  <dl className="snapshot-facts">
                    <div>
                      <dt>{t("任务 ID")}</dt>
                      <dd>{details.taskId}</dd>
                    </div>
                    <div>
                      <dt>{t("捕获时间")}</dt>
                      <dd>{formatCapturedAt(details.capturedAtEpochMillis)}</dd>
                    </div>
                    <div>
                      <dt>{t("耗时")}</dt>
                      <dd>{formatDuration(details.durationNanos)}</dd>
                    </div>
                    <div>
                      <dt>{t("线程")}</dt>
                      <dd>{details.threadName}</dd>
                    </div>
                    <div>
                      <dt>{t("调用层级")}</dt>
                      <dd>
                        {details.depth === 0 ? t("根调用") : details.depth}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("重放接收者")}</dt>
                      <dd className="snapshot-receiver">
                        <Badge
                          variant={
                            details.replayMode === "INSTANCE" &&
                            !details.receiverAvailable
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {details.replayMode === "INSTANCE"
                            ? details.receiverAvailable
                              ? t("原实例可用")
                              : t("原实例已回收")
                            : details.replayMode === "STATIC"
                              ? t("静态方法")
                              : t("不可重放")}
                        </Badge>
                        {details.receiverType && (
                          <span>{details.receiverType}</span>
                        )}
                      </dd>
                    </div>
                  </dl>

                  {details.replayMode === "INSTANCE" && (
                    <Card
                      className="receiver-state-card gap-4 py-5"
                      data-testid="captured-receiver-state"
                    >
                      <CardHeader className="px-5">
                        <CardTitle>{t("捕获时实例状态")}</CardTitle>
                        <CardDescription>
                          {t(
                            "在目标方法退出时读取最多 16 个实例标量字段；敏感字段遮罩，不调用业务 toString()。",
                          )}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="grid gap-4 px-5">
                        <ReceiverStateCoverage state={details.receiverState} />
                        <ReceiverStateFields state={details.receiverState} />
                      </CardContent>
                    </Card>
                  )}

                  <section className="snapshot-result">
                    <p className="eyebrow">
                      {details.outcome === "THREW"
                        ? "THROWN EXCEPTION"
                        : "RETURN VALUE"}
                    </p>
                    <code>
                      {details.outcome === "THREW"
                        ? details.exceptionType
                        : details.returnValue}
                    </code>
                    {details.exceptionMessage && (
                      <p>{details.exceptionMessage}</p>
                    )}
                  </section>

                  {shouldShowInvocationValues(details) && (
                    <Card
                      className="invocation-value-card gap-4 py-5"
                      data-testid="invocation-value-tree"
                    >
                      <CardHeader className="px-5">
                        <CardTitle>{t("结构化调用上下文")}</CardTitle>
                        <CardDescription>
                          {t(
                            "在目标方法退出时展开参数、返回值与白名单 JDK 集合；最多 96 个节点、3 层深度和每节点 16 个子项，敏感字段及 Map 值遮罩且不调用业务 toString()。此证据只保留在当前 Agent 会话。",
                          )}
                        </CardDescription>
                        <CardAction>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              !details.invocationValues.available ||
                              comparisonBaseline?.snapshotId ===
                                details.snapshotId
                            }
                            onClick={() => setComparisonBaseline(details)}
                          >
                            {comparisonBaseline?.snapshotId ===
                            details.snapshotId
                              ? t("当前比较基线")
                              : comparisonBaseline
                                ? t("替换比较基线")
                                : t("设为比较基线")}
                          </Button>
                        </CardAction>
                      </CardHeader>
                      <CardContent className="grid gap-4 px-5">
                        <InvocationValuesInspector
                          evidence={details.invocationValues}
                        />
                      </CardContent>
                    </Card>
                  )}

                  {comparisonBaseline && invocationDiff && (
                    <Card
                      className="invocation-diff-card gap-4 py-5"
                      data-testid="invocation-value-diff"
                    >
                      <CardHeader className="px-5">
                        <CardTitle>{t("结构字段差异")}</CardTitle>
                        <CardDescription>
                          {t(
                            "基线 #{baseline} → 当前 #{current}；仅比较同一精确类、ClassLoader 与方法签名，使用两份会话内安全结构树。",
                            {
                              baseline: comparisonBaseline.snapshotId,
                              current: details.snapshotId,
                            },
                          )}
                        </CardDescription>
                        <CardAction>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setComparisonBaseline(null)}
                          >
                            {t("清除比较基线")}
                          </Button>
                        </CardAction>
                      </CardHeader>
                      <CardContent className="grid gap-4 px-5">
                        <InvocationValueDiffInspector diff={invocationDiff} />
                      </CardContent>
                    </Card>
                  )}

                  <div className="snapshot-columns">
                    <section className="snapshot-section">
                      <header>
                        <div>
                          <p className="eyebrow">ARGUMENTS</p>
                          <h3>
                            {t("{count} 个参数", {
                              count: details.arguments.length,
                            })}
                          </h3>
                        </div>
                      </header>
                      {details.arguments.length > 0 ? (
                        <ol className="argument-list">
                          {details.arguments.map((argument, index) => (
                            <li key={index}>
                              <span>arg{index}</span>
                              <code>{argument}</code>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="snapshot-section__empty">
                          {t("此调用没有参数。")}
                        </p>
                      )}
                    </section>

                    <section className="snapshot-section">
                      <header>
                        <div>
                          <p className="eyebrow">CALL STACK</p>
                          <h3>
                            {t("{count} 层来源", {
                              count: details.callStack.length,
                            })}
                          </h3>
                        </div>
                      </header>
                      {details.callStack.length > 0 ? (
                        <ol className="stack-list">
                          {details.callStack.map((frame, index) => (
                            <li key={`${index}:${frame}`}>
                              <span>{index + 1}</span>
                              <code>{frame}</code>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="snapshot-section__empty">
                          {t("没有可用的来源栈。")}
                        </p>
                      )}
                    </section>
                  </div>

                  <Card
                    className="gap-4 py-5"
                    data-testid="snapshot-persist-card"
                  >
                    <CardHeader className="px-5">
                      <CardTitle>{t("固定到桌面")}</CardTitle>
                      <CardDescription>
                        {t(
                          "Host 会重新读取这条精确快照、核对 JVM 启动周期并遮罩疑似凭据；之后断开目标也能查看。",
                        )}
                      </CardDescription>
                      <CardAction>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={savingSnapshot}
                          onClick={() => void saveSnapshotToDesktop()}
                        >
                          {savingSnapshot ? t("保存中…") : t("固定到桌面")}
                        </Button>
                      </CardAction>
                    </CardHeader>
                    {savedSnapshotId && (
                      <CardContent className="flex flex-wrap items-center justify-between gap-3 px-5">
                        <span className="text-muted-foreground text-sm">
                          {t("已保存为跨会话只读档案。")}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            void navigate(
                              `/snapshot-library?snapshot=${encodeURIComponent(savedSnapshotId)}`,
                            )
                          }
                        >
                          {t("查看桌面档案")}
                        </Button>
                      </CardContent>
                    )}
                  </Card>

                  <section className="snapshot-replay">
                    {details.replayEligible && replayCapabilityAvailable ? (
                      <>
                        <header>
                          <div>
                            <p className="eyebrow">CONTROLLED REPLAY / R4</p>
                            <h3>
                              {details.replayMode === "INSTANCE"
                                ? t("在原实例接收者上重新调用。")
                                : t("从安全字符串参数重新调用。")}
                            </h3>
                          </div>
                          <p>
                            {details.replayMode === "INSTANCE"
                              ? t(
                                  "仅持有原实例的弱引用；执行前重新校验快照、接收者身份与方法指纹",
                                )
                              : t(
                                  "公开静态标量方法；执行前重新解析类与方法并生成指纹",
                                )}
                          </p>
                        </header>
                        {!replayPreview ? (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void previewReplay()}
                            aria-busy={Boolean(replayLoading)}
                            disabled={Boolean(replayLoading)}
                          >
                            {Boolean(replayLoading) && <Spinner />}
                            {t("生成安全重放预检")}
                          </Button>
                        ) : (
                          <>
                            <dl className="replay-preview">
                              <div>
                                <dt>{t("最终调用")}</dt>
                                <dd>{replayPreview.values.invocation}</dd>
                              </div>
                              <div>
                                <dt>{t("校验指纹")}</dt>
                                <dd>{replayPreview.values.fingerprint}</dd>
                              </div>
                              <div>
                                <dt>{t("重放模式")}</dt>
                                <dd>
                                  {replayPreview.values.replayMode ===
                                  "INSTANCE"
                                    ? t("原实例")
                                    : t("静态方法")}
                                </dd>
                              </div>
                              <div>
                                <dt>{t("状态边界")}</dt>
                                <dd>
                                  {details.replayMode === "INSTANCE"
                                    ? t(
                                        "实例状态可能已变化，弱引用也可能在执行前失效。",
                                      )
                                    : t("静态方法不依赖实例接收者。")}
                                </dd>
                              </div>
                            </dl>
                            {details.replayMode === "INSTANCE" &&
                              previewReceiverState && (
                                <Card
                                  className="receiver-state-card gap-4 py-5"
                                  data-testid="receiver-state-drift"
                                >
                                  <CardHeader className="px-5">
                                    <CardTitle>
                                      {t("捕获后的实例状态漂移")}
                                    </CardTitle>
                                    <CardDescription>
                                      {t(
                                        "比较调用捕获现场与本次重放预检；这是当前标量字段证据，不会阻止并发业务继续修改实例。",
                                      )}
                                    </CardDescription>
                                  </CardHeader>
                                  <CardContent className="grid gap-4 px-5">
                                    <ReceiverStateCoverage
                                      state={previewReceiverState}
                                    />
                                    <ReceiverStateChanges
                                      changes={previewStateDrift}
                                      emptyMessage={t(
                                        "未发现捕获后标量字段变化。",
                                      )}
                                    />
                                  </CardContent>
                                </Card>
                              )}
                            <div className="snapshot-confirmation">
                              <Checkbox
                                id="snapshot-replay-confirm"
                                checked={replayConfirmed}
                                onCheckedChange={(checked) =>
                                  setReplayConfirmed(checked === true)
                                }
                              />
                              <Label htmlFor="snapshot-replay-confirm">
                                {t(
                                  "我已核对快照、目标方法、参数和最终调用，并理解它会再次真实执行。",
                                )}
                              </Label>
                            </div>
                            <div className="snapshot-confirmation">
                              <Checkbox
                                id="snapshot-replay-secondary-confirm"
                                checked={replaySecondaryConfirmed}
                                onCheckedChange={(checked) =>
                                  setReplaySecondaryConfirmed(checked === true)
                                }
                              />
                              <Label htmlFor="snapshot-replay-secondary-confirm">
                                {t(
                                  "我再次确认接受业务副作用，超时或中断不保证目标代码停止。",
                                )}
                              </Label>
                            </div>
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={
                                Boolean(
                                  !replayConfirmed || !replaySecondaryConfirmed,
                                ) || Boolean(replayLoading)
                              }
                              onClick={() => void executeReplay()}
                              aria-busy={Boolean(replayLoading)}
                            >
                              {Boolean(replayLoading) && <Spinner />}
                              {t("二次确认并执行快照重放")}
                            </Button>
                            {replayResult && (
                              <>
                                <dl className="replay-result">
                                  <div>
                                    <dt>{t("结果")}</dt>
                                    <dd>{replayResult.values.outcome}</dd>
                                  </div>
                                  <div>
                                    <dt>{t("返回值")}</dt>
                                    <dd>{replayResult.values.returnValue}</dd>
                                  </div>
                                </dl>
                                {details.replayMode === "INSTANCE" &&
                                  replayBeforeState && (
                                    <Card
                                      className="receiver-state-card gap-4 py-5"
                                      data-testid="receiver-state-change"
                                    >
                                      <CardHeader className="px-5">
                                        <CardTitle>
                                          {t("本次重放前后实例变化")}
                                        </CardTitle>
                                        <CardDescription>
                                          {t(
                                            "比较执行前后同一实例的有界标量字段；并发写入可能同时发生，因此只作为观测证据，不单独证明因果。",
                                          )}
                                        </CardDescription>
                                      </CardHeader>
                                      <CardContent className="grid gap-4 px-5">
                                        <ReceiverStateCoverage
                                          state={replayBeforeState}
                                        />
                                        <ReceiverStateChanges
                                          changes={replayStateChanges}
                                          emptyMessage={t(
                                            "本次重放前后未发现标量字段变化。",
                                          )}
                                        />
                                      </CardContent>
                                    </Card>
                                  )}
                              </>
                            )}
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="eyebrow">REPLAY UNAVAILABLE</p>
                        <h3>{t("此快照只用于检查。")}</h3>
                        <p>
                          {details.replayDeniedReason === "RECEIVER_EXPIRED"
                            ? t(
                                "原实例已被目标 JVM 回收；请重新捕获一次调用快照。",
                              )
                            : t(
                                "只有公开方法、最多 8 个完整标量参数的根调用可以进入受控重放；实例方法还要求原接收者仍然存活。",
                              )}
                        </p>
                      </>
                    )}
                  </section>

                  <Disclosure
                    className="snapshot-delete"
                    trigger={t("管理此快照")}
                  >
                    <div className="snapshot-confirmation">
                      <Checkbox
                        id="snapshot-delete-confirm"
                        checked={deleteConfirmed}
                        onCheckedChange={(checked) =>
                          setDeleteConfirmed(checked === true)
                        }
                      />
                      <Label htmlFor="snapshot-delete-confirm">
                        {t(
                          "我确认从当前 Agent 会话中删除快照 #{id}；原始调用不会受到影响。",
                          { id: details.snapshotId },
                        )}
                      </Label>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={Boolean(!deleteConfirmed) || Boolean(loading)}
                      onClick={() => void deleteSnapshot()}
                      aria-busy={Boolean(loading)}
                    >
                      {Boolean(loading) && <Spinner />}
                      {t("删除此快照")}
                    </Button>
                  </Disclosure>
                </>
              ) : (
                <div className="snapshot-detail__empty">
                  <p className="eyebrow">NO SELECTION</p>
                  <p>{t("选择一个调用快照查看完整上下文。")}</p>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
