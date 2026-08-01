import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import StatePagination from "../components/StatePagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Disclosure } from "@/components/ui/disclosure";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useNavigate } from "react-router";
import type { ActionResult } from "@shared/contracts";
import RiskPill from "../components/RiskPill";
import StatusPill from "../components/StatusPill";
import { Textarea } from "../components/ui/textarea";
import { t, useLocale } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./MBeansView.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

const PAGE_SIZE = 50;
const MAXIMUM_ATTRIBUTE_VALUE_NODES = 256;
const MAXIMUM_ATTRIBUTE_VALUE_CHARACTERS = 32_768;
const ATTRIBUTE_VALUE_KINDS = new Set([
  "NULL",
  "SCALAR",
  "COMPOSITE",
  "TABULAR",
  "ARRAY",
  "MAP",
  "COLLECTION",
  "UNSUPPORTED",
  "CYCLE",
]);

interface MBeanListItem {
  readonly objectName: string;
  readonly domain: string;
  readonly type: string;
  readonly name: string;
}

interface MBeanAttribute {
  readonly name: string;
  readonly type: string;
  readonly readable: boolean;
  readonly writeable: boolean;
  readonly writeSupported: boolean;
  readonly writeDeniedReason: string;
  readonly writeFormat: "SCALAR" | "OPEN_TYPE_JSON" | "";
  readonly writeSchema: string;
  readonly description: string;
}

interface MBeanOperation {
  readonly name: string;
  readonly returnType: string;
  readonly impact: string;
  readonly signature: string;
  readonly parameterTypes: string;
  readonly description: string;
  readonly invokable: boolean;
  readonly deniedReason: string;
  readonly parameters: readonly MBeanOperationParameter[];
}

interface MBeanOperationParameter {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly format: "SCALAR" | "OPEN_TYPE_JSON";
  readonly schema: string;
}

interface MBeanDetails {
  readonly objectName: string;
  readonly className: string;
  readonly description: string;
  readonly attributeTotal: number;
  readonly operationTotal: number;
  readonly attributes: readonly MBeanAttribute[];
  readonly operations: readonly MBeanOperation[];
}

interface AttributeValue {
  readonly type: string;
  readonly valueClass: string;
  readonly value: string;
  readonly structured: boolean;
  readonly nodes: readonly AttributeValueNode[];
  readonly nodeLimitReached: boolean;
  readonly depthLimitReached: boolean;
  readonly entryLimitReached: boolean;
  readonly characterLimitReached: boolean;
  readonly editableFormat: "SCALAR" | "OPEN_TYPE_JSON" | "";
  readonly editableValue: string;
  readonly editableSchema: string;
  readonly editableDeniedReason: string;
}

interface AttributeValueNode {
  readonly index: number;
  readonly parentIndex: number;
  readonly depth: number;
  readonly key: string;
  readonly kind: string;
  readonly type: string;
  readonly value: string;
  readonly childCount: number;
  readonly displayedChildren: number;
  readonly truncated: boolean;
}

interface OperationPreview {
  readonly fingerprint: string;
  readonly invocation: string;
  readonly returnType: string;
  readonly impact: string;
  readonly boundary: string;
  readonly arguments: readonly OperationPreviewArgument[];
}

interface OperationPreviewArgument {
  readonly format: "SCALAR" | "OPEN_TYPE_JSON";
  readonly schema: string;
  readonly value: string;
}

interface InvocationRecord {
  readonly id: number;
  readonly createdAt: number;
  readonly objectName: string;
  readonly operation: string;
  readonly outcome: string;
  readonly valueClass: string;
  readonly returnValue: string;
  readonly exceptionType: string;
  readonly exceptionMessage: string;
  readonly durationMillis: number;
}

interface AttributeWritePreview {
  readonly fingerprint: string;
  readonly type: string;
  readonly oldValue: string;
  readonly proposedValue: string;
  readonly restoreSupported: boolean;
  readonly valueFormat: "SCALAR" | "OPEN_TYPE_JSON";
  readonly valueSchema: string;
}

interface AttributeWriteRecord {
  readonly id: number;
  readonly createdAt: number;
  readonly objectName: string;
  readonly attribute: string;
  readonly type: string;
  readonly oldValue: string;
  readonly newValue: string;
  readonly restoreSupported: boolean;
  readonly durationMillis: number;
  readonly valueFormat: "SCALAR" | "OPEN_TYPE_JSON";
  readonly valueSchema: string;
}

type AttributeWriteFormat = "SCALAR" | "OPEN_TYPE_JSON";

function parseAttributeWriteFormat(
  value: string | undefined,
): AttributeWriteFormat | "" {
  return value === "SCALAR" || value === "OPEN_TYPE_JSON" ? value : "";
}

function readActionFailure(
  result: {
    readonly ok: boolean;
    readonly value: ActionResult | null;
    readonly errorMessage: string | null;
  },
  fallback: string,
): string | null {
  if (result.ok && result.value?.status === "SUCCEEDED") {
    return null;
  }
  return result.errorMessage ?? result.value?.message ?? fallback;
}

function parseMBeanList(
  values: Readonly<Record<string, string>>,
): readonly MBeanListItem[] {
  const count = boundedCount(values.count, PAGE_SIZE);
  return Array.from({ length: count }, (_, index) => {
    const prefix = `bean.${String(index).padStart(4, "0")}.`;
    return {
      objectName: values[`${prefix}objectName`] ?? "",
      domain: values[`${prefix}domain`] ?? "",
      type: values[`${prefix}type`] ?? "",
      name: values[`${prefix}name`] ?? "",
    };
  }).filter((item) => item.objectName.length > 0);
}

function boundedCount(value: string | undefined, maximum: number): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(parsed, maximum);
}

function parseBoundedInteger(
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

function parseAttributeValue(
  values: Readonly<Record<string, string>>,
  fallbackType: string,
): AttributeValue {
  const base = {
    type: values.type ?? fallbackType,
    valueClass: values.valueClass ?? "",
    value: values.value ?? "",
    editableFormat: parseAttributeWriteFormat(values.editableFormat),
    editableValue: values.editableValue ?? "",
    editableSchema: values.editableSchema ?? "",
    editableDeniedReason: values.editableDeniedReason ?? "",
  };
  if (values.structured !== "true") {
    return {
      ...base,
      structured: false,
      nodes: [],
      nodeLimitReached: false,
      depthLimitReached: false,
      entryLimitReached: false,
      characterLimitReached: false,
    };
  }

  const count = parseBoundedInteger(
    values["node.count"],
    1,
    MAXIMUM_ATTRIBUTE_VALUE_NODES,
    t("MBean 属性节点数"),
  );
  let characterCount = 0;
  const nodes = Array.from({ length: count }, (_, index) => {
    const prefix = `node.${String(index).padStart(4, "0")}.`;
    const nodeIndex = parseBoundedInteger(
      values[`${prefix}index`],
      index,
      index,
      t("MBean 属性节点索引"),
    );
    const parentIndex = parseBoundedInteger(
      values[`${prefix}parentIndex`],
      -1,
      Math.max(-1, index - 1),
      t("MBean 属性父节点索引"),
    );
    const depth = parseBoundedInteger(
      values[`${prefix}depth`],
      0,
      5,
      t("MBean 属性节点深度"),
    );
    const childCount = parseBoundedInteger(
      values[`${prefix}childCount`],
      0,
      Number.MAX_SAFE_INTEGER,
      t("MBean 属性子节点数"),
    );
    const displayedChildren = parseBoundedInteger(
      values[`${prefix}displayedChildren`],
      0,
      Math.min(childCount, 50),
      t("MBean 属性已展示子节点数"),
    );
    const key = values[`${prefix}key`] ?? "";
    const kind = values[`${prefix}kind`] ?? "";
    const type = values[`${prefix}type`] ?? "";
    const value = values[`${prefix}value`] ?? "";
    characterCount += key.length + type.length + value.length;
    if (
      !ATTRIBUTE_VALUE_KINDS.has(kind) ||
      characterCount > MAXIMUM_ATTRIBUTE_VALUE_CHARACTERS ||
      (index === 0 && (parentIndex !== -1 || depth !== 0)) ||
      (index > 0 && (parentIndex < 0 || parentIndex >= index))
    ) {
      throw new Error(t("MBean 属性结构响应无效。"));
    }
    return {
      index: nodeIndex,
      parentIndex,
      depth,
      key,
      kind,
      type,
      value,
      childCount,
      displayedChildren,
      truncated: values[`${prefix}truncated`] === "true",
    };
  });

  const actualChildren = Array.from({ length: count }, () => 0);
  for (const node of nodes) {
    if (node.parentIndex >= 0) {
      const parent = nodes[node.parentIndex];
      if (!parent || node.depth !== parent.depth + 1) {
        throw new Error(t("MBean 属性结构层级无效。"));
      }
      actualChildren[node.parentIndex] =
        (actualChildren[node.parentIndex] ?? 0) + 1;
    }
  }
  if (
    nodes.some((node) => actualChildren[node.index] !== node.displayedChildren)
  ) {
    throw new Error(t("MBean 属性结构子节点计数无效。"));
  }

  return {
    ...base,
    structured: true,
    nodes,
    nodeLimitReached: values["node.nodeLimitReached"] === "true",
    depthLimitReached: values["node.depthLimitReached"] === "true",
    entryLimitReached: values["node.entryLimitReached"] === "true",
    characterLimitReached: values["node.characterLimitReached"] === "true",
  };
}

function attributeNodeId(attributeName: string, nodeIndex: number): string {
  return `${attributeName}\u0000${nodeIndex}`;
}

function attributeNodeDepthClass(node: AttributeValueNode): string {
  return `attribute-value__node--depth-${Math.min(node.depth, 5)}`;
}

function attributeValueKindLabel(kind: string): string {
  const labels: Readonly<Record<string, string>> = {
    NULL: t("空值"),
    SCALAR: t("标量"),
    COMPOSITE: "CompositeData",
    TABULAR: "TabularData",
    ARRAY: t("数组"),
    MAP: "Map",
    COLLECTION: t("集合"),
    UNSUPPORTED: t("不透明对象"),
    CYCLE: t("循环引用"),
  };
  return labels[kind] ?? kind;
}

function attributeValueBoundary(
  value: AttributeValue | undefined,
): string | null {
  if (!value) {
    return null;
  }
  const boundaries = [
    value.nodeLimitReached ? t("节点上限") : null,
    value.depthLimitReached ? t("深度上限") : null,
    value.entryLimitReached ? t("集合项上限") : null,
    value.characterLimitReached ? t("字符上限") : null,
  ].filter((item): item is string => item !== null);
  return boundaries.length
    ? t("为保护目标 JVM，结果已触达：{boundaries}。", {
        boundaries: boundaries.join("、"),
      })
    : null;
}

function parseMBeanDetails(
  values: Readonly<Record<string, string>>,
): MBeanDetails {
  const attributeCount = boundedCount(values["attribute.count"], 200);
  const operationCount = boundedCount(values["operation.count"], 200);
  const attributes = Array.from(
    {
      length: Number.isFinite(attributeCount) ? attributeCount : 0,
    },
    (_, index): MBeanAttribute => {
      const prefix = `attribute.${String(index).padStart(4, "0")}.`;
      const writeSupported = values[`${prefix}writeSupported`] === "true";
      return {
        name: values[`${prefix}name`] ?? "",
        type: values[`${prefix}type`] ?? "",
        readable: values[`${prefix}readable`] === "true",
        writeable: values[`${prefix}writeable`] === "true",
        writeSupported,
        writeDeniedReason: values[`${prefix}writeDeniedReason`] ?? "",
        writeFormat:
          parseAttributeWriteFormat(values[`${prefix}writeFormat`]) ||
          (writeSupported ? "SCALAR" : ""),
        writeSchema: values[`${prefix}writeSchema`] ?? "",
        description: values[`${prefix}description`] ?? "",
      };
    },
  ).filter((attribute) => attribute.name.length > 0);
  const operations = Array.from(
    {
      length: Number.isFinite(operationCount) ? operationCount : 0,
    },
    (_, index): MBeanOperation => {
      const prefix = `operation.${String(index).padStart(4, "0")}.`;
      const parameterCount = boundedCount(
        values[`${prefix}parameter.count`],
        8,
      );
      const parameters = Array.from(
        { length: parameterCount },
        (_, parameterIndex): MBeanOperationParameter => {
          const parameterPrefix = `${prefix}parameter.${String(
            parameterIndex,
          ).padStart(2, "0")}.`;
          return {
            name:
              values[`${parameterPrefix}name`] ?? `arg${parameterIndex + 1}`,
            type: values[`${parameterPrefix}type`] ?? "",
            description: values[`${parameterPrefix}description`] ?? "",
            format:
              parseAttributeWriteFormat(values[`${parameterPrefix}format`]) ||
              "SCALAR",
            schema: values[`${parameterPrefix}schema`] ?? "",
          };
        },
      );
      return {
        name: values[`${prefix}name`] ?? "",
        returnType: values[`${prefix}returnType`] ?? "",
        impact: values[`${prefix}impact`] ?? "UNKNOWN",
        signature: values[`${prefix}signature`] ?? "",
        parameterTypes: values[`${prefix}parameterTypes`] ?? "",
        description: values[`${prefix}description`] ?? "",
        invokable: values[`${prefix}invokable`] === "true",
        deniedReason: values[`${prefix}deniedReason`] ?? "",
        parameters,
      };
    },
  ).filter((operation) => operation.name.length > 0);
  return {
    objectName: values.objectName ?? "",
    className: values.className ?? "",
    description: values.description ?? "",
    attributeTotal: Number(values["attribute.total"] ?? attributes.length),
    operationTotal: Number(values["operation.total"] ?? operations.length),
    attributes,
    operations,
  };
}

function operationKey(operation: MBeanOperation): string {
  return `${operation.name}:${operation.parameterTypes}`;
}

function formatRecordTime(epochMillis: number): string {
  if (!Number.isFinite(epochMillis) || epochMillis <= 0) {
    return t("未知");
  }
  return new Date(epochMillis).toLocaleTimeString();
}

function operationDeniedMessage(reason: string): string {
  if (reason.includes("DiagnosticCommand")) {
    return t("DiagnosticCommand 必须使用探微的专用类型化操作。");
  }
  if (reason.includes("more than 8")) {
    return t("参数超过 8 个，受控调用已禁用。");
  }
  if (
    reason.includes("Only string") ||
    reason.includes("Only scalar or bounded")
  ) {
    return t("参数包含不受支持的对象类型，受控调用已禁用。");
  }
  if (reason.includes("Process termination")) {
    return t("进程终止、命令执行和 Agent 加载操作已被拒绝。");
  }
  return t("Agent 拒绝了此操作。");
}

function operationBoundaryMessage(): string {
  return t("MBean 代码可能产生不可逆副作用；3 秒超时无法保证目标操作终止。");
}

function attributeWriteDeniedMessage(reason: string): string {
  if (reason.includes("Write-only")) {
    return t("只写属性无法核对旧值，受控修改已禁用。");
  }
  if (reason.includes("Only scalar or bounded")) {
    return t("属性类型不属于可安全构造的标量或有界 JMX OpenType。");
  }
  return t("Agent 拒绝了此属性修改。");
}

function attributeWriteBoundaryMessage(): string {
  return t(
    "Setter 可能产生不可逆副作用；Agent 会在写入前再次核对旧值，3 秒超时不保证 Setter 停止。",
  );
}

function attributeWriteValueLimit(attribute: MBeanAttribute): number {
  return attribute.writeFormat === "OPEN_TYPE_JSON" ? 32_768 : 512;
}

function formatEditableAttributeValue(
  value: string,
  format: MBeanAttribute["writeFormat"],
): string {
  if (format !== "OPEN_TYPE_JSON" || value.length === 0) {
    return value;
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export default function MBeansView() {
  useLocale();
  const navigate = useNavigate();
  const selectedTargetId = useTargetsStore((state) => state.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [beans, setBeans] = useState<readonly MBeanListItem[]>([]);
  const [selectedObjectName, setSelectedObjectName] = useState<string | null>(
    null,
  );
  const selectedObjectNameRef = useRef<string | null>(selectedObjectName);
  const [details, setDetails] = useState<MBeanDetails | null>(null);
  const [attributeValues, setAttributeValues] = useState<
    Readonly<Record<string, AttributeValue>>
  >({});
  const [collapsedAttributeNodes, setCollapsedAttributeNodes] = useState<
    ReadonlySet<string>
  >(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [readingAttribute, setReadingAttribute] = useState<string | null>(null);
  const [selectedOperation, setSelectedOperation] =
    useState<MBeanOperation | null>(null);
  const selectedOperationRef = useRef<MBeanOperation | null>(selectedOperation);
  const [operationArguments, setOperationArguments] = useState<
    readonly string[]
  >([]);
  const [operationPreview, setOperationPreview] =
    useState<OperationPreview | null>(null);
  const [operationConfirmed, setOperationConfirmed] = useState(false);
  const [operationConfirmedSecondary, setOperationConfirmedSecondary] =
    useState(false);
  const [previewingOperation, setPreviewingOperation] = useState(false);
  const [invokingOperation, setInvokingOperation] = useState(false);
  const [invocationHistory, setInvocationHistory] = useState<
    readonly InvocationRecord[]
  >([]);
  const [invocationSequence, setInvocationSequence] = useState(0);
  const [selectedWritableAttribute, setSelectedWritableAttribute] =
    useState<MBeanAttribute | null>(null);
  const [proposedAttributeValue, setProposedAttributeValue] = useState("");
  const [attributeWritePreview, setAttributeWritePreview] =
    useState<AttributeWritePreview | null>(null);
  const [attributeWriteConfirmed, setAttributeWriteConfirmed] = useState(false);
  const [
    attributeWriteConfirmedSecondary,
    setAttributeWriteConfirmedSecondary,
  ] = useState(false);
  const [previewingAttributeWrite, setPreviewingAttributeWrite] =
    useState(false);
  const [writingAttribute, setWritingAttribute] = useState(false);
  const [attributeWriteHistory, setAttributeWriteHistory] = useState<
    readonly AttributeWriteRecord[]
  >([]);
  const [attributeWriteSequence, setAttributeWriteSequence] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mbeanCapability = connection?.capabilities.find(
    (capability) => capability.id === "mbeans",
  );

  useEffect(() => {
    selectedObjectNameRef.current = selectedObjectName;
  }, [selectedObjectName]);

  useEffect(() => {
    selectedOperationRef.current = selectedOperation;
  }, [selectedOperation]);

  function initializeAttributeNodeState(
    attributeName: string,
    value: AttributeValue,
  ): void {
    const prefix = `${attributeName}\u0000`;
    const next = new Set(
      [...collapsedAttributeNodes].filter((item) => !item.startsWith(prefix)),
    );
    for (const node of value.nodes) {
      if (node.index !== 0 && node.displayedChildren > 0) {
        next.add(attributeNodeId(attributeName, node.index));
      }
    }
    setCollapsedAttributeNodes(next);
  }

  function visibleAttributeNodes(
    attributeName: string,
    value: AttributeValue | undefined,
  ): readonly AttributeValueNode[] {
    if (!value) {
      return [];
    }
    const hidden = Array.from({ length: value.nodes.length }, () => false);
    return value.nodes.filter((node) => {
      if (node.parentIndex >= 0) {
        hidden[node.index] =
          hidden[node.parentIndex] ||
          collapsedAttributeNodes.has(
            attributeNodeId(attributeName, node.parentIndex),
          );
      }
      return !hidden[node.index];
    });
  }

  function toggleAttributeNode(
    attributeName: string,
    node: AttributeValueNode,
  ): void {
    if (node.displayedChildren === 0) {
      return;
    }
    const id = attributeNodeId(attributeName, node.index);
    const next = new Set(collapsedAttributeNodes);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setCollapsedAttributeNodes(next);
  }

  function isAttributeNodeCollapsed(
    attributeName: string,
    node: AttributeValueNode,
  ): boolean {
    return collapsedAttributeNodes.has(
      attributeNodeId(attributeName, node.index),
    );
  }

  function resetOperationComposer(): void {
    selectedOperationRef.current = null;
    setSelectedOperation(null);
    setOperationArguments([]);
    setOperationPreview(null);
    setOperationConfirmed(false);
    setOperationConfirmedSecondary(false);
  }

  function resetAttributeWriteComposer(): void {
    setSelectedWritableAttribute(null);
    setProposedAttributeValue("");
    setAttributeWritePreview(null);
    setAttributeWriteConfirmed(false);
    setAttributeWriteConfirmedSecondary(false);
  }

  function selectOperation(operation: MBeanOperation): void {
    if (!operation.invokable) {
      return;
    }
    resetAttributeWriteComposer();
    selectedOperationRef.current = operation;
    setSelectedOperation(operation);
    setOperationArguments(operation.parameters.map(() => ""));
    setOperationPreview(null);
    setOperationConfirmed(false);
    setOperationConfirmedSecondary(false);
    setErrorMessage(null);
  }

  function selectWritableAttribute(
    attribute: MBeanAttribute,
    proposedValue = "",
  ): void {
    if (!attribute.writeSupported) {
      return;
    }
    resetOperationComposer();
    setSelectedWritableAttribute(attribute);
    setProposedAttributeValue(
      formatEditableAttributeValue(proposedValue, attribute.writeFormat).slice(
        0,
        attributeWriteValueLimit(attribute),
      ),
    );
    setAttributeWritePreview(null);
    setAttributeWriteConfirmed(false);
    setAttributeWriteConfirmedSecondary(false);
    setErrorMessage(null);
  }

  async function configureWritableAttribute(
    attribute: MBeanAttribute,
  ): Promise<void> {
    if (!attribute.writeSupported) {
      return;
    }
    let currentValue = attributeValues[attribute.name];
    if (
      attribute.writeFormat === "OPEN_TYPE_JSON" &&
      currentValue?.editableFormat !== "OPEN_TYPE_JSON"
    ) {
      const loadedValue = await readAttribute(attribute);
      if (!loadedValue) {
        return;
      }
      currentValue = loadedValue;
    }
    if (
      attribute.writeFormat === "OPEN_TYPE_JSON" &&
      currentValue?.editableFormat !== "OPEN_TYPE_JSON"
    ) {
      setErrorMessage(
        currentValue?.editableDeniedReason ||
          t("当前值超过复合 OpenType 编辑边界，无法安全生成写入预览。"),
      );
      return;
    }
    selectWritableAttribute(
      attribute,
      currentValue?.editableFormat === attribute.writeFormat
        ? currentValue.editableValue
        : "",
    );
  }

  function updateProposedAttributeValue(
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void {
    const limit = selectedWritableAttribute
      ? attributeWriteValueLimit(selectedWritableAttribute)
      : 512;
    setProposedAttributeValue(event.target.value.slice(0, limit));
    setAttributeWritePreview(null);
    setAttributeWriteConfirmed(false);
    setAttributeWriteConfirmedSecondary(false);
  }

  async function previewAttributeWrite(
    attributeOverride?: MBeanAttribute,
    proposedValueOverride?: string,
  ): Promise<void> {
    const attribute = attributeOverride ?? selectedWritableAttribute;
    const proposedValue = proposedValueOverride ?? proposedAttributeValue;
    const targetsState = useTargetsStore.getState();
    if (!targetsState.selectedTargetId || !selectedObjectName || !attribute) {
      return;
    }
    setPreviewingAttributeWrite(true);
    setAttributeWritePreview(null);
    setAttributeWriteConfirmed(false);
    setAttributeWriteConfirmedSecondary(false);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "mbean.attribute.write.preview",
        parameters: {
          objectName: selectedObjectName,
          attribute: attribute.name,
          valueFormat: attribute.writeFormat,
          proposedValue,
        },
      });
      const failure = readActionFailure(result, t("MBean 属性修改预检失败"));
      if (failure || !result.value) {
        setErrorMessage(failure);
        return;
      }
      setAttributeWritePreview({
        fingerprint: result.value.values.fingerprint ?? "",
        type: result.value.values.type ?? attribute.type,
        oldValue: result.value.values.oldValue ?? "",
        proposedValue: result.value.values.proposedValue ?? "",
        restoreSupported: result.value.values.restoreSupported === "true",
        valueFormat:
          parseAttributeWriteFormat(result.value.values.valueFormat) ||
          attribute.writeFormat ||
          "SCALAR",
        valueSchema: result.value.values.valueSchema ?? attribute.writeSchema,
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("MBean 属性修改预检失败"),
      );
    } finally {
      setPreviewingAttributeWrite(false);
    }
  }

  async function writeAttributeValue(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    if (
      !targetsState.selectedTargetId ||
      !selectedObjectName ||
      !selectedWritableAttribute ||
      !attributeWritePreview ||
      !attributeWriteConfirmed ||
      !attributeWriteConfirmedSecondary
    ) {
      return;
    }
    setWritingAttribute(true);
    setErrorMessage(null);
    const attribute = selectedWritableAttribute;
    const objectName = selectedObjectName;
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "mbean.attribute.write",
        parameters: {
          objectName,
          attribute: attribute.name,
          valueFormat: attribute.writeFormat,
          proposedValue: proposedAttributeValue,
          expectedFingerprint: attributeWritePreview.fingerprint,
          confirmed: "true",
          confirmedSecondary: "true",
        },
      });
      const failure = readActionFailure(result, t("MBean 属性修改失败"));
      if (failure || !result.value) {
        setErrorMessage(failure);
        setAttributeWritePreview(null);
        return;
      }
      const nextSequence = attributeWriteSequence + 1;
      setAttributeWriteSequence(nextSequence);
      const record: AttributeWriteRecord = {
        id: nextSequence,
        createdAt: Date.now(),
        objectName,
        attribute: attribute.name,
        type: result.value.values.type ?? attribute.type,
        oldValue: result.value.values.oldValue ?? "",
        newValue: result.value.values.newValue ?? "",
        restoreSupported: result.value.values.restoreSupported === "true",
        durationMillis: Number(result.value.values.durationMillis ?? 0),
        valueFormat:
          parseAttributeWriteFormat(result.value.values.valueFormat) ||
          attribute.writeFormat ||
          "SCALAR",
        valueSchema: result.value.values.valueSchema ?? attribute.writeSchema,
      };
      setAttributeWriteHistory((current) => [record, ...current].slice(0, 20));
      setAttributeWritePreview(null);
      setAttributeWriteConfirmed(false);
      setAttributeWriteConfirmedSecondary(false);
      await readAttribute(attribute);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("MBean 属性修改失败"),
      );
      setAttributeWritePreview(null);
    } finally {
      setWritingAttribute(false);
    }
  }

  async function prepareAttributeRestore(
    record: AttributeWriteRecord,
  ): Promise<void> {
    if (
      !record.restoreSupported ||
      record.objectName !== selectedObjectName ||
      !details
    ) {
      return;
    }
    const attribute = details.attributes.find(
      (candidate) => candidate.name === record.attribute,
    );
    if (!attribute?.writeSupported) {
      return;
    }
    selectWritableAttribute(attribute, record.oldValue);
    await previewAttributeWrite(
      attribute,
      record.oldValue.slice(0, attributeWriteValueLimit(attribute)),
    );
  }

  function updateOperationArgument(index: number, value: string): void {
    const parameter = selectedOperation?.parameters[index];
    if (!parameter || index < 0 || index >= operationArguments.length) {
      return;
    }
    const otherCharacters = operationArguments.reduce(
      (total, argument, argumentIndex) =>
        argumentIndex === index ? total : total + argument.length,
      0,
    );
    const aggregateLimit = Math.max(0, 32_768 - otherCharacters);
    const parameterLimit = parameter.format === "OPEN_TYPE_JSON" ? 32_768 : 512;
    const boundedValue = value.slice(
      0,
      Math.min(parameterLimit, aggregateLimit),
    );
    setOperationArguments(
      operationArguments.map((argument, argumentIndex) =>
        argumentIndex === index ? boundedValue : argument,
      ),
    );
    setOperationPreview(null);
    setOperationConfirmed(false);
    setOperationConfirmedSecondary(false);
  }

  function onOperationArgumentInput(
    index: number,
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void {
    updateOperationArgument(index, event.target.value);
  }

  function operationActionParameters(
    operation: MBeanOperation,
  ): Readonly<Record<string, string>> {
    const parameters: Record<string, string> = {
      objectName: selectedObjectName ?? "",
      operation: operation.name,
      parameterTypes: operation.parameterTypes,
      argumentCount: String(operation.parameters.length),
    };
    for (let index = 0; index < 8; index += 1) {
      parameters[`argument${index}`] =
        index < operationArguments.length
          ? (operationArguments[index] ?? "")
          : "";
      if (index < operation.parameters.length) {
        parameters[`argumentFormat${index}`] =
          operation.parameters[index]?.format ?? "SCALAR";
      }
    }
    return parameters;
  }

  async function previewOperation(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    if (
      !targetsState.selectedTargetId ||
      !selectedObjectName ||
      !selectedOperation
    ) {
      return;
    }
    const targetId = targetsState.selectedTargetId;
    const objectName = selectedObjectName;
    const operation = selectedOperation;
    const selectedOperationKey = operationKey(operation);
    setPreviewingOperation(true);
    setOperationPreview(null);
    setOperationConfirmed(false);
    setOperationConfirmedSecondary(false);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId,
        actionId: "mbean.operation.preview",
        parameters: operationActionParameters(operation),
      });
      if (
        useTargetsStore.getState().selectedTargetId !== targetId ||
        selectedObjectNameRef.current !== objectName ||
        !selectedOperationRef.current ||
        operationKey(selectedOperationRef.current) !== selectedOperationKey
      ) {
        return;
      }
      const failure = readActionFailure(result, t("MBean 操作预检失败"));
      if (failure || !result.value) {
        setErrorMessage(failure);
        return;
      }
      setOperationPreview({
        fingerprint: result.value.values.fingerprint ?? "",
        invocation: result.value.values.invocation ?? "",
        returnType: result.value.values.returnType ?? operation.returnType,
        impact: result.value.values.impact ?? operation.impact,
        boundary: result.value.values.boundary ?? "",
        arguments: operation.parameters.map((parameter, index) => {
          const prefix = `argument.${String(index).padStart(2, "0")}.`;
          return {
            format:
              parseAttributeWriteFormat(
                result.value?.values[`${prefix}format`],
              ) || parameter.format,
            schema: result.value?.values[`${prefix}schema`] ?? parameter.schema,
            value:
              result.value?.values[`${prefix}value`] ??
              operationArguments[index] ??
              "",
          };
        }),
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("MBean 操作预检失败"),
      );
    } finally {
      setPreviewingOperation(false);
    }
  }

  async function invokeOperation(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    if (
      !targetsState.selectedTargetId ||
      !selectedObjectName ||
      !selectedOperation ||
      !operationPreview ||
      !operationConfirmed ||
      !operationConfirmedSecondary
    ) {
      return;
    }
    setInvokingOperation(true);
    setErrorMessage(null);
    const operation = selectedOperation;
    const objectName = selectedObjectName;
    const targetId = targetsState.selectedTargetId;
    const selectedOperationKey = operationKey(operation);
    try {
      const result = await window.tanwei.executeAction({
        targetId,
        actionId: "mbean.operation.invoke",
        parameters: {
          ...operationActionParameters(operation),
          expectedFingerprint: operationPreview.fingerprint,
          confirmed: "true",
          confirmedSecondary: "true",
        },
      });
      if (
        useTargetsStore.getState().selectedTargetId !== targetId ||
        selectedObjectNameRef.current !== objectName ||
        !selectedOperationRef.current ||
        operationKey(selectedOperationRef.current) !== selectedOperationKey
      ) {
        return;
      }
      const failure = readActionFailure(result, t("MBean 操作调用失败"));
      if (failure || !result.value) {
        setErrorMessage(failure);
        setOperationPreview(null);
        return;
      }
      const nextSequence = invocationSequence + 1;
      setInvocationSequence(nextSequence);
      const record: InvocationRecord = {
        id: nextSequence,
        createdAt: Date.now(),
        objectName,
        operation: operation.name,
        outcome: result.value.values.outcome ?? "UNKNOWN",
        valueClass: result.value.values.valueClass ?? "",
        returnValue: result.value.values.returnValue ?? "",
        exceptionType: result.value.values.exceptionType ?? "",
        exceptionMessage: result.value.values.exceptionMessage ?? "",
        durationMillis: Number(result.value.values.durationMillis ?? 0),
      };
      setInvocationHistory((current) => [record, ...current].slice(0, 20));
      setOperationPreview(null);
      setOperationConfirmed(false);
      setOperationConfirmedSecondary(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("MBean 操作调用失败"),
      );
      setOperationPreview(null);
    } finally {
      setInvokingOperation(false);
    }
  }

  async function loadBeans(nextOffset = 0): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const activeConnection = selectConnection(targetsState);
    const capability = activeConnection?.capabilities.find(
      (candidate) => candidate.id === "mbeans",
    );
    if (
      !targetsState.selectedTargetId ||
      activeConnection?.state !== "READY" ||
      capability?.state !== "AVAILABLE"
    ) {
      setBeans([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "mbean.list",
        parameters: {
          query: query.trim(),
          offset: String(Math.max(0, nextOffset)),
          limit: String(PAGE_SIZE),
        },
      });
      const failure = readActionFailure(result, t("无法读取 MBean 列表"));
      if (failure || !result.value) {
        setErrorMessage(failure);
        return;
      }
      setTotal(Number(result.value.values.total ?? 0));
      setOffset(Number(result.value.values.offset ?? 0));
      const nextBeans = parseMBeanList(result.value.values);
      setBeans(nextBeans);
      if (
        selectedObjectName &&
        !nextBeans.some((item) => item.objectName === selectedObjectName)
      ) {
        setSelectedObjectName(null);
        setDetails(null);
        setAttributeValues({});
        setCollapsedAttributeNodes(new Set());
        resetOperationComposer();
        resetAttributeWriteComposer();
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取 MBean 列表"),
      );
    } finally {
      setLoading(false);
    }
  }

  async function selectMBean(item: MBeanListItem): Promise<void> {
    const targetsState = useTargetsStore.getState();
    if (!targetsState.selectedTargetId) {
      return;
    }
    setSelectedObjectName(item.objectName);
    setDetails(null);
    setAttributeValues({});
    setCollapsedAttributeNodes(new Set());
    resetOperationComposer();
    resetAttributeWriteComposer();
    setLoadingDetails(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "mbean.describe",
        parameters: { objectName: item.objectName },
      });
      const failure = readActionFailure(result, t("无法读取 MBean 元数据"));
      if (failure || !result.value) {
        setErrorMessage(failure);
        return;
      }
      setDetails(parseMBeanDetails(result.value.values));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取 MBean 元数据"),
      );
    } finally {
      setLoadingDetails(false);
    }
  }

  async function readAttribute(
    attribute: MBeanAttribute,
  ): Promise<AttributeValue | null> {
    const targetsState = useTargetsStore.getState();
    const targetId = targetsState.selectedTargetId;
    const objectName = selectedObjectName;
    if (!targetId || !objectName || !attribute.readable) {
      return null;
    }
    setReadingAttribute(attribute.name);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId,
        actionId: "mbean.attribute.read",
        parameters: {
          objectName,
          attribute: attribute.name,
        },
      });
      const failure = readActionFailure(result, t("无法读取 MBean 属性"));
      if (failure || !result.value) {
        setErrorMessage(failure);
        return null;
      }
      const value = parseAttributeValue(result.value.values, attribute.type);
      const currentState = useTargetsStore.getState();
      if (
        currentState.selectedTargetId !== targetId ||
        selectedObjectNameRef.current !== objectName
      ) {
        return null;
      }
      initializeAttributeNodeState(attribute.name, value);
      setAttributeValues((current) => ({
        ...current,
        [attribute.name]: value,
      }));
      return value;
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取 MBean 属性"),
      );
      return null;
    } finally {
      setReadingAttribute(null);
    }
  }

  const previousTargetIdRef = useRef(selectedTargetId);
  useEffect(() => {
    if (previousTargetIdRef.current === selectedTargetId) {
      return;
    }
    previousTargetIdRef.current = selectedTargetId;
    setSelectedObjectName(null);
    setDetails(null);
    setAttributeValues({});
    setCollapsedAttributeNodes(new Set());
    resetOperationComposer();
    resetAttributeWriteComposer();
    setInvocationHistory([]);
    setAttributeWriteHistory([]);
    void loadBeans(0);
  }, [selectedTargetId]);

  useEffect(() => {
    void loadBeans(0);
  }, []);

  return (
    <section className="page mbeans-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">MBean INSPECTOR</p>
          <h1>{t("管理接口，逐项检查。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "搜索已注册 MBean；属性修改和操作调用都必须经过精确预检、R4 双确认和结果留痕。",
          )}
        </p>
      </header>

      {connection?.state !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">{t("连接目标后检查 MBean。")}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigate("/targets")}
          >
            {t("选择目标")}
          </Button>
        </Empty>
      ) : mbeanCapability?.state !== "AVAILABLE" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">CAPABILITY UNAVAILABLE</p>
          <p className="empty-panel__title">
            {t("当前 Agent 不支持 MBean 检查器。")}
          </p>
          <p>
            {mbeanCapability?.reason ?? t("请重新连接目标以加载最新 Agent。")}
          </p>
        </Empty>
      ) : (
        <>
          <form
            className="mbean-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              void loadBeans(0);
            }}
          >
            <Label>
              <span>{t("搜索 ObjectName")}</span>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value.trim())}
                type="search"
                maxLength={256}
                placeholder={t("例如 java.lang:type=Memory")}
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

          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          <div className="mbean-inspector">
            <section className="mbean-list" aria-label={t("MBean 搜索结果")}>
              <header>
                <div>
                  <p className="eyebrow">REGISTERED BEANS</p>
                  <strong>{t("{count} 个匹配", { count: total })}</strong>
                </div>
                <RiskPill level="R0" />
              </header>
              {beans.length > 0 ? (
                <div className="mbean-list__items">
                  {beans.map((bean) => (
                    <Button
                      variant="ghost"
                      key={bean.objectName}
                      type="button"
                      className={
                        bean.objectName === selectedObjectName
                          ? "mbean-row mbean-row--selected"
                          : "mbean-row"
                      }
                      onClick={() => void selectMBean(bean)}
                    >
                      <span>
                        <strong>{bean.type || bean.domain}</strong>
                        <small>{bean.name || bean.objectName}</small>
                      </span>
                      <span>{bean.domain}</span>
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="mbean-list__empty">
                  {loading ? t("正在读取 MBean…") : t("没有匹配的 MBean。")}
                </div>
              )}
              <footer>
                <StatePagination
                  ariaLabel={t("MBean 分页")}
                  previousLabel={t("上一页")}
                  nextLabel={t("下一页")}
                  previousDisabled={offset === 0 || loading}
                  nextDisabled={offset + PAGE_SIZE >= total || loading}
                  onPrevious={() =>
                    void loadBeans(Math.max(0, offset - PAGE_SIZE))
                  }
                  onNext={() => void loadBeans(offset + PAGE_SIZE)}
                  summary={t("{start}–{end} / {total}", {
                    start: total === 0 ? 0 : offset + 1,
                    end: Math.min(offset + PAGE_SIZE, total),
                    total,
                  })}
                />
              </footer>
            </section>

            <section className="mbean-detail">
              {loadingDetails ? (
                <div className="mbean-detail__empty">
                  <p className="eyebrow">READING METADATA</p>
                  <p>{t("正在读取 MBean 元数据…")}</p>
                </div>
              ) : details ? (
                <>
                  <header className="mbean-detail__header">
                    <div>
                      <p className="eyebrow">EXACT OBJECT NAME</p>
                      <h2>{details.objectName}</h2>
                      <p>{details.className}</p>
                    </div>
                    <StatusPill state="ready" label={t("已注册")} />
                  </header>
                  {details.description && (
                    <p className="mbean-description">{details.description}</p>
                  )}

                  <section className="mbean-section">
                    <header>
                      <div>
                        <p className="eyebrow">ATTRIBUTES</p>
                        <h3>
                          {t("{count} 个属性", {
                            count: details.attributeTotal,
                          })}
                        </h3>
                      </div>
                      <p>{t("只在点击时读取单个 Getter")}</p>
                    </header>
                    {details.attributes.length > 0 ? (
                      <div className="attribute-list">
                        {details.attributes.map((attribute) => {
                          const attributeValue =
                            attributeValues[attribute.name];
                          const boundary =
                            attributeValueBoundary(attributeValue);
                          return (
                            <article
                              key={attribute.name}
                              className={
                                selectedWritableAttribute?.name ===
                                attribute.name
                                  ? "attribute-row attribute-row--selected"
                                  : "attribute-row"
                              }
                            >
                              <div className="attribute-row__metadata">
                                <strong>{attribute.name}</strong>
                                <code>{attribute.type}</code>
                                {attribute.description && (
                                  <p>{attribute.description}</p>
                                )}
                                <span>
                                  {attribute.readable ? t("可读") : t("不可读")}
                                  {" · "}
                                  {attribute.writeable ? t("可写") : t("只读")}
                                </span>
                                {attribute.writeable &&
                                  !attribute.writeSupported &&
                                  attribute.writeDeniedReason && (
                                    <p className="attribute-row__denied">
                                      {attributeWriteDeniedMessage(
                                        attribute.writeDeniedReason,
                                      )}
                                    </p>
                                  )}
                              </div>
                              <div className="attribute-row__actions">
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={
                                    Boolean(
                                      !attribute.readable ||
                                        readingAttribute !== null ||
                                        writingAttribute,
                                    ) ||
                                    Boolean(readingAttribute === attribute.name)
                                  }
                                  onClick={() => void readAttribute(attribute)}
                                  aria-busy={Boolean(
                                    readingAttribute === attribute.name,
                                  )}
                                >
                                  {Boolean(
                                    readingAttribute === attribute.name,
                                  ) && <Spinner />}
                                  {t("读取值")}
                                </Button>
                                {attribute.writeSupported && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    disabled={writingAttribute}
                                    onClick={() =>
                                      void configureWritableAttribute(attribute)
                                    }
                                  >
                                    {selectedWritableAttribute?.name ===
                                    attribute.name
                                      ? t("已选择")
                                      : t("配置修改")}
                                  </Button>
                                )}
                              </div>
                              {attributeValue && (
                                <div className="attribute-value">
                                  <header className="attribute-value__summary">
                                    <div>
                                      <span className="attribute-value__class">
                                        {attributeValue.valueClass}
                                      </span>
                                      <strong>
                                        {attributeValue.structured
                                          ? t("{count} 个有界结构节点", {
                                              count:
                                                attributeValue.nodes.length,
                                            })
                                          : t("有界文本值")}
                                      </strong>
                                    </div>
                                    <StatusPill
                                      state={boundary ? "idle" : "ready"}
                                      label={
                                        attributeValue.structured
                                          ? "OpenType"
                                          : t("文本")
                                      }
                                    />
                                  </header>
                                  {boundary && (
                                    <p className="attribute-value__boundary">
                                      {boundary}
                                    </p>
                                  )}
                                  {attributeValue.structured && (
                                    <ol
                                      className="attribute-value__tree"
                                      aria-label={t(
                                        "{attribute} 结构化属性值",
                                        {
                                          attribute: attribute.name,
                                        },
                                      )}
                                    >
                                      {visibleAttributeNodes(
                                        attribute.name,
                                        attributeValue,
                                      ).map((node) => (
                                        <li
                                          key={node.index}
                                          className={`attribute-value__node ${attributeNodeDepthClass(node)}`}
                                          aria-level={node.depth + 1}
                                        >
                                          {node.displayedChildren === 0 ? (
                                            <span
                                              className="attribute-value__toggle attribute-value__toggle--leaf"
                                              aria-hidden="true"
                                            >
                                              ·
                                            </span>
                                          ) : (
                                            <Button
                                              variant="ghost"
                                              type="button"
                                              className="attribute-value__toggle"
                                              aria-expanded={
                                                !isAttributeNodeCollapsed(
                                                  attribute.name,
                                                  node,
                                                )
                                              }
                                              aria-label={
                                                isAttributeNodeCollapsed(
                                                  attribute.name,
                                                  node,
                                                )
                                                  ? t("展开 {key}", {
                                                      key: node.key,
                                                    })
                                                  : t("折叠 {key}", {
                                                      key: node.key,
                                                    })
                                              }
                                              onClick={() =>
                                                toggleAttributeNode(
                                                  attribute.name,
                                                  node,
                                                )
                                              }
                                            >
                                              <span aria-hidden="true">
                                                {isAttributeNodeCollapsed(
                                                  attribute.name,
                                                  node,
                                                )
                                                  ? "+"
                                                  : "−"}
                                              </span>
                                            </Button>
                                          )}
                                          <div className="attribute-value__node-body">
                                            <header>
                                              <strong>{node.key}</strong>
                                              <span className="attribute-value__kind">
                                                {attributeValueKindLabel(
                                                  node.kind,
                                                )}
                                              </span>
                                            </header>
                                            <code className="attribute-value__type">
                                              {node.type}
                                            </code>
                                            {node.value && (
                                              <code className="attribute-value__node-value">
                                                {node.value}
                                              </code>
                                            )}
                                            {(node.childCount > 0 ||
                                              node.truncated) && (
                                              <small>
                                                {t(
                                                  "展示 {shown} / {total} 个子节点",
                                                  {
                                                    shown:
                                                      node.displayedChildren,
                                                    total: node.childCount,
                                                  },
                                                )}
                                              </small>
                                            )}
                                          </div>
                                        </li>
                                      ))}
                                    </ol>
                                  )}
                                  <Disclosure
                                    className="attribute-value__raw"
                                    trigger={t("原始有界文本")}
                                  >
                                    <pre>{attributeValue.value}</pre>
                                  </Disclosure>
                                </div>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="mbean-detail__empty">
                        {t("此 MBean 没有公开属性。")}
                      </p>
                    )}

                    {selectedWritableAttribute && (
                      <form
                        className="operation-composer attribute-write-composer"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void previewAttributeWrite();
                        }}
                      >
                        <header>
                          <div>
                            <p className="eyebrow">
                              EXACT ATTRIBUTE WRITE / R4
                            </p>
                            <h3>{t("先锁定旧值，再提交新值。")}</h3>
                          </div>
                          <RiskPill level="R4" />
                        </header>
                        <code className="operation-composer__signature">
                          {selectedObjectName} ::{" "}
                          {selectedWritableAttribute.type}{" "}
                          {selectedWritableAttribute.name}
                        </code>
                        <Label className="attribute-write-composer__field">
                          <span>
                            {selectedWritableAttribute.writeFormat ===
                            "OPEN_TYPE_JSON"
                              ? t("OpenType JSON 新值")
                              : t("新值")}
                          </span>
                          {selectedWritableAttribute.writeFormat ===
                          "OPEN_TYPE_JSON" ? (
                            <Textarea
                              value={proposedAttributeValue}
                              maxLength={32_768}
                              rows={12}
                              spellCheck={false}
                              className="min-h-56 resize-y font-mono text-xs leading-5"
                              aria-label={`${selectedWritableAttribute.name} ${t("OpenType JSON 新值")}`}
                              placeholder={t("输入符合下方 Schema 的 JSON")}
                              onChange={updateProposedAttributeValue}
                            />
                          ) : (
                            <Input
                              value={proposedAttributeValue}
                              maxLength={512}
                              aria-label={`${selectedWritableAttribute.name} ${t("新值")}`}
                              placeholder={t("输入标量属性值")}
                              onChange={updateProposedAttributeValue}
                            />
                          )}
                          {selectedWritableAttribute.writeFormat ===
                            "OPEN_TYPE_JSON" && (
                            <small className="attribute-write-composer__schema">
                              <span>{t("Schema")}</span>
                              <code>
                                {selectedWritableAttribute.writeSchema ||
                                  attributeValues[
                                    selectedWritableAttribute.name
                                  ]?.editableSchema}
                              </code>
                              <span>
                                {t(
                                  "最多 32 KiB、5 层、256 节点，每个容器 50 项。",
                                )}
                              </span>
                            </small>
                          )}
                        </Label>
                        <div className="operation-composer__actions">
                          <Button
                            type="submit"
                            variant="outline"
                            disabled={
                              Boolean(writingAttribute) ||
                              Boolean(previewingAttributeWrite)
                            }
                            aria-busy={Boolean(previewingAttributeWrite)}
                          >
                            {Boolean(previewingAttributeWrite) && <Spinner />}
                            {t("读取旧值并生成预检")}
                          </Button>
                        </div>

                        {attributeWritePreview && (
                          <div className="operation-preview attribute-write-preview">
                            <header>
                              <div>
                                <p className="eyebrow">COMPARE AND SET</p>
                                {attributeWritePreview.valueFormat ===
                                "OPEN_TYPE_JSON" ? (
                                  <div className="attribute-write-preview__values">
                                    <pre>
                                      {formatEditableAttributeValue(
                                        attributeWritePreview.oldValue,
                                        "OPEN_TYPE_JSON",
                                      )}
                                    </pre>
                                    <span aria-hidden="true">→</span>
                                    <pre>
                                      {formatEditableAttributeValue(
                                        attributeWritePreview.proposedValue,
                                        "OPEN_TYPE_JSON",
                                      )}
                                    </pre>
                                  </div>
                                ) : (
                                  <strong>
                                    {attributeWritePreview.oldValue}
                                    {" → "}
                                    {attributeWritePreview.proposedValue}
                                  </strong>
                                )}
                              </div>
                              <RiskPill level="R4" compact />
                            </header>
                            <dl>
                              <div>
                                <dt>{t("类型")}</dt>
                                <dd>{attributeWritePreview.type}</dd>
                              </div>
                              <div>
                                <dt>{t("值格式")}</dt>
                                <dd>{attributeWritePreview.valueFormat}</dd>
                              </div>
                              {attributeWritePreview.valueSchema && (
                                <div>
                                  <dt>{t("Schema")}</dt>
                                  <dd>{attributeWritePreview.valueSchema}</dd>
                                </div>
                              )}
                              <div>
                                <dt>{t("恢复能力")}</dt>
                                <dd>
                                  {attributeWritePreview.restoreSupported
                                    ? t("可生成恢复预览")
                                    : t("旧值为空，无法自动恢复")}
                                </dd>
                              </div>
                              <div>
                                <dt>{t("预检指纹")}</dt>
                                <dd>{attributeWritePreview.fingerprint}</dd>
                              </div>
                              <div>
                                <dt>{t("边界")}</dt>
                                <dd>{attributeWriteBoundaryMessage()}</dd>
                              </div>
                            </dl>
                            <Label className="operation-confirmation">
                              <Checkbox
                                checked={attributeWriteConfirmed}
                                onCheckedChange={(event) =>
                                  setAttributeWriteConfirmed(event === true)
                                }
                              />
                              <span>
                                {attributeWritePreview.valueFormat ===
                                "OPEN_TYPE_JSON"
                                  ? t(
                                      "我确认将 {objectName} 的 {attribute} 写入已预检的复合 OpenType 值，Setter 可能立即产生业务副作用。",
                                      {
                                        objectName: selectedObjectName ?? "",
                                        attribute:
                                          selectedWritableAttribute.name,
                                      },
                                    )
                                  : t(
                                      "我确认将 {objectName} 的 {attribute} 从 {oldValue} 修改为 {newValue}，Setter 可能立即产生业务副作用。",
                                      {
                                        objectName: selectedObjectName ?? "",
                                        attribute:
                                          selectedWritableAttribute.name,
                                        oldValue:
                                          attributeWritePreview.oldValue,
                                        newValue:
                                          attributeWritePreview.proposedValue,
                                      },
                                    )}
                              </span>
                            </Label>
                            <Label className="operation-confirmation">
                              <Checkbox
                                checked={attributeWriteConfirmedSecondary}
                                onCheckedChange={(event) =>
                                  setAttributeWriteConfirmedSecondary(
                                    event === true,
                                  )
                                }
                              />
                              <span>
                                {t(
                                  "我再次确认接受不可逆副作用，并理解旧值变化会使本次预检失效。",
                                )}
                              </span>
                            </Label>
                            <div className="operation-composer__actions">
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={
                                  Boolean(
                                    !attributeWriteConfirmed ||
                                      !attributeWriteConfirmedSecondary ||
                                      previewingAttributeWrite,
                                  ) || Boolean(writingAttribute)
                                }
                                onClick={() => void writeAttributeValue()}
                                aria-busy={Boolean(writingAttribute)}
                              >
                                {Boolean(writingAttribute) && <Spinner />}
                                {t("二次确认并修改属性")}
                              </Button>
                            </div>
                          </div>
                        )}
                      </form>
                    )}
                  </section>

                  {attributeWriteHistory.length > 0 && (
                    <section className="mbean-section attribute-write-history">
                      <header>
                        <div>
                          <p className="eyebrow">ATTRIBUTE CHANGE HISTORY</p>
                          <h3>
                            {t("最近 {count} 次属性修改", {
                              count: attributeWriteHistory.length,
                            })}
                          </h3>
                        </div>
                        <p>{t("每次恢复仍需重新预检和双确认")}</p>
                      </header>
                      {attributeWriteHistory.map((record) => (
                        <article
                          key={record.id}
                          className="invocation-record attribute-write-record"
                        >
                          <header>
                            <div>
                              <strong>{record.attribute}</strong>
                              <small>
                                {record.objectName} · {record.type}
                              </small>
                            </div>
                            <StatusPill state="ready" label={t("已应用")} />
                          </header>
                          {record.valueFormat === "OPEN_TYPE_JSON" ? (
                            <div className="attribute-write-record__values">
                              <pre>
                                {formatEditableAttributeValue(
                                  record.oldValue,
                                  "OPEN_TYPE_JSON",
                                )}
                              </pre>
                              <span aria-hidden="true">→</span>
                              <pre>
                                {formatEditableAttributeValue(
                                  record.newValue,
                                  "OPEN_TYPE_JSON",
                                )}
                              </pre>
                            </div>
                          ) : (
                            <code>
                              {record.oldValue}
                              {" → "}
                              {record.newValue}
                            </code>
                          )}
                          <dl>
                            <div>
                              <dt>{t("耗时")}</dt>
                              <dd>{record.durationMillis} ms</dd>
                            </div>
                            <div>
                              <dt>{t("时间")}</dt>
                              <dd>{formatRecordTime(record.createdAt)}</dd>
                            </div>
                          </dl>
                          {record.restoreSupported && (
                            <div className="operation-composer__actions">
                              <Button
                                type="button"
                                variant="outline"
                                disabled={
                                  writingAttribute || previewingAttributeWrite
                                }
                                onClick={() =>
                                  void prepareAttributeRestore(record)
                                }
                              >
                                {t("生成恢复预览")}
                              </Button>
                            </div>
                          )}
                        </article>
                      ))}
                    </section>
                  )}

                  <section className="mbean-section">
                    <header>
                      <div>
                        <p className="eyebrow">OPERATIONS / CONTROLLED R4</p>
                        <h3>
                          {t("{count} 个操作", {
                            count: details.operationTotal,
                          })}
                        </h3>
                      </div>
                      <p>{t("支持最多 8 个标量或有界 OpenType 参数")}</p>
                    </header>
                    {details.operations.length > 0 ? (
                      <div className="operation-list">
                        {details.operations.map((operation, index) => (
                          <article
                            key={`${operationKey(operation)}:${index}`}
                            className={
                              selectedOperation &&
                              operationKey(selectedOperation) ===
                                operationKey(operation)
                                ? "operation-row--selected"
                                : undefined
                            }
                          >
                            <header>
                              <strong>{operation.name}</strong>
                              <span className="operation-row__actions">
                                <StatusPill
                                  state="idle"
                                  label={operation.impact}
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={!operation.invokable}
                                  onClick={() => selectOperation(operation)}
                                >
                                  {selectedOperation &&
                                  operationKey(selectedOperation) ===
                                    operationKey(operation)
                                    ? t("已选择")
                                    : t("配置调用")}
                                </Button>
                              </span>
                            </header>
                            <code>
                              {operation.returnType} {operation.name}(
                              {operation.signature})
                            </code>
                            {operation.description && (
                              <p>{operation.description}</p>
                            )}
                            {!operation.invokable && operation.deniedReason && (
                              <p className="operation-row__denied">
                                {operationDeniedMessage(operation.deniedReason)}
                              </p>
                            )}
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="mbean-detail__empty">
                        {t("此 MBean 没有公开操作。")}
                      </p>
                    )}

                    {selectedOperation && (
                      <form
                        className="operation-composer"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void previewOperation();
                        }}
                      >
                        <header>
                          <div>
                            <p className="eyebrow">EXACT INVOCATION / R4</p>
                            <h3>{t("先核对调用，再决定是否执行。")}</h3>
                          </div>
                          <RiskPill level="R4" />
                        </header>
                        <code className="operation-composer__signature">
                          {selectedObjectName} :: {selectedOperation.returnType}{" "}
                          {selectedOperation.name}({selectedOperation.signature}
                          )
                        </code>
                        {selectedOperation.parameters.length > 0 ? (
                          <>
                            <div className="operation-arguments">
                              {selectedOperation.parameters.map(
                                (parameter, index) => (
                                  <Label
                                    key={`${parameter.type}:${index}`}
                                    className={
                                      parameter.format === "OPEN_TYPE_JSON"
                                        ? "operation-argument operation-argument--json"
                                        : "operation-argument"
                                    }
                                  >
                                    <span>
                                      {parameter.name || `arg${index + 1}`}
                                      {" · "}
                                      <code>{parameter.type}</code>
                                    </span>
                                    {parameter.format === "OPEN_TYPE_JSON" ? (
                                      <Textarea
                                        value={operationArguments[index] ?? ""}
                                        maxLength={32_768}
                                        rows={8}
                                        aria-label={`${parameter.name || `arg${index + 1}`} · ${parameter.type} · OpenType JSON`}
                                        placeholder={t("按 Schema 输入 JSON")}
                                        onChange={(event) =>
                                          onOperationArgumentInput(index, event)
                                        }
                                      />
                                    ) : (
                                      <Input
                                        value={operationArguments[index] ?? ""}
                                        maxLength={512}
                                        aria-label={`${parameter.name || `arg${index + 1}`} · ${parameter.type}`}
                                        placeholder={
                                          parameter.description ||
                                          t("标量参数值")
                                        }
                                        onChange={(event) =>
                                          onOperationArgumentInput(index, event)
                                        }
                                      />
                                    )}
                                    {parameter.format === "OPEN_TYPE_JSON" && (
                                      <small className="operation-argument__schema">
                                        <span>Schema</span>
                                        <code>
                                          {parameter.schema ||
                                            t("由 Agent 预检")}
                                        </code>
                                      </small>
                                    )}
                                  </Label>
                                ),
                              )}
                            </div>
                            {selectedOperation.parameters.some(
                              (parameter) =>
                                parameter.format === "OPEN_TYPE_JSON",
                            ) && (
                              <p className="operation-arguments__boundary">
                                {t(
                                  "复杂参数合计最多 32 KiB；每个 JSON 最多 5 层、256 节点、每个容器 50 项。",
                                )}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="operation-composer__empty">
                            {t("此操作没有参数。")}
                          </p>
                        )}
                        <div className="operation-composer__actions">
                          <Button
                            type="submit"
                            variant="outline"
                            disabled={
                              Boolean(invokingOperation) ||
                              Boolean(previewingOperation)
                            }
                            aria-busy={Boolean(previewingOperation)}
                          >
                            {Boolean(previewingOperation) && <Spinner />}
                            {t("预检精确调用")}
                          </Button>
                        </div>

                        {operationPreview && (
                          <div className="operation-preview">
                            <header>
                              <div>
                                <p className="eyebrow">PREVIEW FINGERPRINT</p>
                                <strong>{operationPreview.invocation}</strong>
                              </div>
                              <StatusPill
                                state="error"
                                label={operationPreview.impact}
                              />
                            </header>
                            {operationPreview.arguments.some(
                              (argument) =>
                                argument.format === "OPEN_TYPE_JSON",
                            ) && (
                              <div className="operation-preview__arguments">
                                <p className="eyebrow">
                                  {t("AGENT 规范化参数")}
                                </p>
                                {operationPreview.arguments.map(
                                  (argument, index) =>
                                    argument.format === "OPEN_TYPE_JSON" ? (
                                      <article key={index}>
                                        <header>
                                          <strong>
                                            {selectedOperation.parameters[index]
                                              ?.name || `arg${index + 1}`}
                                          </strong>
                                          <code>{argument.schema}</code>
                                        </header>
                                        <pre>{argument.value}</pre>
                                      </article>
                                    ) : null,
                                )}
                              </div>
                            )}
                            <dl>
                              <div>
                                <dt>{t("返回类型")}</dt>
                                <dd>{operationPreview.returnType}</dd>
                              </div>
                              <div>
                                <dt>{t("预检指纹")}</dt>
                                <dd>{operationPreview.fingerprint}</dd>
                              </div>
                              <div>
                                <dt>{t("边界")}</dt>
                                <dd>{operationBoundaryMessage()}</dd>
                              </div>
                            </dl>
                            <Label className="operation-confirmation">
                              <Checkbox
                                checked={operationConfirmed}
                                onCheckedChange={(event) =>
                                  setOperationConfirmed(event === true)
                                }
                              />
                              <span>
                                {t(
                                  "我确认调用 {objectName} 的 {operation} 操作可能立即改变目标 JVM 状态。",
                                  {
                                    objectName: selectedObjectName ?? "",
                                    operation: selectedOperation.name,
                                  },
                                )}
                              </span>
                            </Label>
                            <Label className="operation-confirmation">
                              <Checkbox
                                checked={operationConfirmedSecondary}
                                onCheckedChange={(event) =>
                                  setOperationConfirmedSecondary(event === true)
                                }
                              />
                              <span>
                                {t(
                                  "我再次确认接受不可逆副作用；超时或中断不保证目标操作停止。",
                                )}
                              </span>
                            </Label>
                            <div className="operation-composer__actions">
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={
                                  Boolean(
                                    !operationConfirmed ||
                                      !operationConfirmedSecondary ||
                                      previewingOperation,
                                  ) || Boolean(invokingOperation)
                                }
                                onClick={() => void invokeOperation()}
                                aria-busy={Boolean(invokingOperation)}
                              >
                                {Boolean(invokingOperation) && <Spinner />}
                                {t("二次确认并调用操作")}
                              </Button>
                            </div>
                          </div>
                        )}
                      </form>
                    )}
                  </section>

                  {invocationHistory.length > 0 && (
                    <section className="mbean-section invocation-history">
                      <header>
                        <div>
                          <p className="eyebrow">SESSION RESULT HISTORY</p>
                          <h3>
                            {t("最近 {count} 次调用", {
                              count: invocationHistory.length,
                            })}
                          </h3>
                        </div>
                        <p>{t("仅保留当前连接的最近 20 条结果")}</p>
                      </header>
                      {invocationHistory.map((record) => (
                        <article key={record.id} className="invocation-record">
                          <header>
                            <div>
                              <strong>{record.operation}</strong>
                              <small>{record.objectName}</small>
                            </div>
                            <StatusPill
                              state={
                                record.outcome === "RETURNED"
                                  ? "ready"
                                  : "error"
                              }
                              label={record.outcome}
                            />
                          </header>
                          <dl>
                            <div>
                              <dt>{t("耗时")}</dt>
                              <dd>{record.durationMillis} ms</dd>
                            </div>
                            <div>
                              <dt>{t("时间")}</dt>
                              <dd>{formatRecordTime(record.createdAt)}</dd>
                            </div>
                          </dl>
                          {record.outcome === "RETURNED" ? (
                            <pre>{record.returnValue}</pre>
                          ) : (
                            <pre>{`${record.exceptionType}: ${record.exceptionMessage}`}</pre>
                          )}
                        </article>
                      ))}
                    </section>
                  )}
                </>
              ) : (
                <div className="mbean-detail__empty">
                  <p className="eyebrow">NO SELECTION</p>
                  <p>{t("选择一个 MBean 查看属性与操作。")}</p>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
