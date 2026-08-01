import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Disclosure } from "@/components/ui/disclosure";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type {
  ActionResult,
  ArtifactDescriptor,
  ClassDescriptor,
  ClassDetails,
  CompiledClass,
  CompiledClassChangeSet,
} from "@shared/contracts";
import {
  buildClassChangeSetParameters,
  parseClassChangeSetPreview,
  parseClassChangeSetResult,
  type ClassChangeSetDraft,
  type ClassChangeSetEvidenceItem,
  type ClassChangeSetPreviewEvidence,
} from "../class-change-set";
import StatusPill from "../components/StatusPill";
import { t, useLocale } from "../i18n";
import { useObservationsStore } from "../stores/observations";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./ClassesView.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import StatePagination from "../components/StatePagination";
import { SelectControl, SelectControlItem } from "@/components/SelectControl";

const PAGE_SIZE = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLASSLOADER_RESOURCE_KINDS = new Set([
  "FILE",
  "ARCHIVE",
  "MODULE",
  "REMOTE",
  "OTHER",
]);

interface ClassLoaderSummary {
  readonly identity: string;
  readonly type: string;
  readonly parent: string;
  readonly loadedClasses: number;
  readonly urls: readonly string[];
}

interface ClassLoaderMetaspaceRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly parentId: string;
  readonly parentName: string;
  readonly classCount: bigint;
  readonly chunkSize: bigint;
  readonly blockSize: bigint;
  readonly hiddenClassCount: bigint;
  readonly hiddenChunkSize: bigint;
  readonly hiddenBlockSize: bigint;
  readonly sampledAtEpochMillis: number;
}

interface ClassLoaderMetaspaceResult {
  readonly startedAtEpochMillis: number;
  readonly completedAtEpochMillis: number;
  readonly durationMillis: number;
  readonly periodMillis: number;
  readonly eventCount: number;
  readonly totalLoaders: number;
  readonly truncated: boolean;
  readonly totalClassCount: bigint;
  readonly totalChunkSize: bigint;
  readonly totalBlockSize: bigint;
  readonly totalHiddenClassCount: bigint;
  readonly totalHiddenChunkSize: bigint;
  readonly totalHiddenBlockSize: bigint;
  readonly rows: readonly ClassLoaderMetaspaceRow[];
}

interface ClassLoaderResourceLocation {
  readonly kind: "FILE" | "ARCHIVE" | "MODULE" | "REMOTE" | "OTHER";
  readonly protocol: string;
  readonly location: string;
}

interface ClassLoaderResourceResult {
  readonly resourceName: string;
  readonly scope: "SYSTEM_BOOTSTRAP" | "SELECTED_WITH_PARENTS";
  readonly scanned: number;
  readonly truncated: boolean;
  readonly characterLimitReached: boolean;
  readonly durationMillis: number;
  readonly resources: readonly ClassLoaderResourceLocation[];
}

interface HeapInstance {
  readonly handle: string;
  readonly type: string;
  readonly identity: string;
  readonly shallowSize: number;
  readonly navigable: boolean;
  readonly fields: readonly {
    readonly name: string;
    readonly value: string;
  }[];
}

interface HeapRelation {
  readonly label: string;
  readonly kind: string;
  readonly index: number;
  readonly target: HeapInstance;
}

interface HeapGraphNode {
  readonly index: number;
  readonly depth: number;
  readonly target: HeapInstance;
}

interface HeapGraphEdge {
  readonly source: number;
  readonly target: number;
  readonly label: string;
  readonly kind: string;
  readonly index: number;
}

interface HeapGraphResult {
  readonly direction: "OUTGOING" | "INCOMING";
  readonly scannedEdges: number;
  readonly taggedObjects: number;
  readonly tagConflicts: number;
  readonly truncated: boolean;
  readonly nodeLimitReached: boolean;
  readonly depthLimitReached: boolean;
  readonly branchLimitReached: boolean;
  readonly nodes: readonly HeapGraphNode[];
  readonly edges: readonly HeapGraphEdge[];
}

interface HeapGraphLayer {
  readonly depth: number;
  readonly nodes: readonly HeapGraphNode[];
}

interface HeapRootNode {
  readonly label: string;
  readonly kind: string;
  readonly index: number;
  readonly root: boolean;
  readonly target: HeapInstance;
}

interface HeapRootPath {
  readonly rootReached: boolean;
  readonly nodes: readonly HeapRootNode[];
}

interface HeapRetainedContributor {
  readonly rank: number;
  readonly shallowBytes: number;
  readonly target: HeapInstance;
}

interface HeapRetainedResult {
  readonly exact: boolean;
  readonly closureEdges: number;
  readonly rootEdges: number;
  readonly taggedObjects: number;
  readonly tagConflicts: number;
  readonly closureTruncated: boolean;
  readonly rootTruncated: boolean;
  readonly weakSemanticsComplete: boolean;
  readonly reachableObjects: number;
  readonly reachableBytes: number;
  readonly candidateObjects: number;
  readonly candidateBytes: number;
  readonly retainedBytes: number;
  readonly contributors: readonly HeapRetainedContributor[];
}

interface HeapRetainedRankingEntry {
  readonly rank: number;
  readonly candidateObjects: number;
  readonly candidateBytes: number;
  readonly retainedBytes: number;
  readonly target: HeapInstance;
}

interface HeapRetainedRankingResult {
  readonly exact: boolean;
  readonly graphNodes: number;
  readonly graphEdges: number;
  readonly tagConflicts: number;
  readonly truncated: boolean;
  readonly nodeLimitReached: boolean;
  readonly edgeLimitReached: boolean;
  readonly weakSemanticsComplete: boolean;
  readonly reachableNodes: number;
  readonly reachableBytes: number;
  readonly entries: readonly HeapRetainedRankingEntry[];
}

interface StaticFieldDescriptor {
  readonly declaringClass: string;
  readonly name: string;
  readonly type: string;
  readonly modifiers: string;
  readonly enumConstant: boolean;
}

function parseClassLoaderResourceInteger(
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

function parseClassLoaderResourceResult(
  values: Readonly<Record<string, string>>,
): ClassLoaderResourceResult {
  const count = parseClassLoaderResourceInteger(
    values.count,
    0,
    100,
    t("资源来源数量"),
  );
  const scanned = parseClassLoaderResourceInteger(
    values.scanned,
    count,
    1_000,
    t("资源扫描数量"),
  );
  const durationMillis = parseClassLoaderResourceInteger(
    values.durationMillis,
    0,
    60_000,
    t("资源定位耗时"),
  );
  let totalCharacters = 0;
  const resources = Array.from(
    { length: count },
    (_, index): ClassLoaderResourceLocation => {
      const prefix = `resource.${String(index).padStart(4, "0")}.`;
      const kind = values[`${prefix}kind`] ?? "";
      const protocol = values[`${prefix}protocol`] ?? "";
      const location = values[`${prefix}location`] ?? "";
      totalCharacters += location.length;
      if (
        !CLASSLOADER_RESOURCE_KINDS.has(kind) ||
        !protocol ||
        !location ||
        location.length > 4_096 ||
        totalCharacters > 64 * 1_024
      ) {
        throw new Error(t("ClassLoader 资源定位响应无效。"));
      }
      return {
        kind: kind as ClassLoaderResourceLocation["kind"],
        protocol,
        location,
      };
    },
  );
  const scope = values.scope;
  if (scope !== "SYSTEM_BOOTSTRAP" && scope !== "SELECTED_WITH_PARENTS") {
    throw new Error(t("ClassLoader 资源定位范围无效。"));
  }
  return {
    resourceName: values.resourceName ?? "",
    scope,
    scanned,
    truncated: values.truncated === "true",
    characterLimitReached: values.characterLimitReached === "true",
    durationMillis,
    resources,
  };
}

function parseMetaspaceUnsigned(
  value: string | undefined,
  label: string,
): bigint {
  if (!value || !/^(?:0|[1-9]\d{0,18})$/u.test(value)) {
    throw new Error(t("{label} 不是有效的非负整数。", { label }));
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new Error(t("{label} 超出安全边界。", { label }));
  }
  return parsed;
}

function parseMetaspaceText(value: string | undefined, label: string): string {
  if (!value || value.length > 4_096 || /[\u0000\r\n]/u.test(value)) {
    throw new Error(t("{label} 无效。", { label }));
  }
  return value;
}

function parseClassLoaderMetaspaceResult(
  values: Readonly<Record<string, string>>,
): ClassLoaderMetaspaceResult {
  const count = parseClassLoaderResourceInteger(
    values.count,
    0,
    100,
    t("元空间结果数量"),
  );
  const totalLoaders = parseClassLoaderResourceInteger(
    values.totalLoaders,
    count,
    4_096,
    t("ClassLoader 总数"),
  );
  const eventCount = parseClassLoaderResourceInteger(
    values.eventCount,
    0,
    50_000,
    t("JFR 事件数量"),
  );
  const durationMillis = parseClassLoaderResourceInteger(
    values.durationMillis,
    250,
    3_000,
    t("元空间采样时长"),
  );
  const periodMillis = parseClassLoaderResourceInteger(
    values.periodMillis,
    50,
    Math.min(1_000, durationMillis),
    t("元空间采样周期"),
  );
  const startedAtEpochMillis = parseClassLoaderResourceInteger(
    values.startedAtEpochMillis,
    1,
    Number.MAX_SAFE_INTEGER,
    t("采样开始时间"),
  );
  const completedAtEpochMillis = parseClassLoaderResourceInteger(
    values.completedAtEpochMillis,
    startedAtEpochMillis,
    Number.MAX_SAFE_INTEGER,
    t("采样完成时间"),
  );
  if (values.truncated !== "true" && values.truncated !== "false") {
    throw new Error(t("元空间截断状态无效。"));
  }

  const seenIds = new Set<string>();
  let previousChunkSize: bigint | null = null;
  let visibleClassCount = 0n;
  let visibleChunkSize = 0n;
  let visibleBlockSize = 0n;
  let visibleHiddenClassCount = 0n;
  let visibleHiddenChunkSize = 0n;
  let visibleHiddenBlockSize = 0n;
  const rows = Array.from(
    { length: count },
    (_, index): ClassLoaderMetaspaceRow => {
      const prefix = `loader.${String(index).padStart(4, "0")}.`;
      const id = parseMetaspaceText(values[`${prefix}id`], t("加载器 ID"));
      if (seenIds.has(id)) {
        throw new Error(t("元空间结果包含重复加载器。"));
      }
      seenIds.add(id);
      const chunkSize = parseMetaspaceUnsigned(
        values[`${prefix}chunkSize`],
        t("已分配元空间"),
      );
      const blockSize = parseMetaspaceUnsigned(
        values[`${prefix}blockSize`],
        t("已使用元空间"),
      );
      const hiddenChunkSize = parseMetaspaceUnsigned(
        values[`${prefix}hiddenChunkSize`],
        t("隐藏类已分配元空间"),
      );
      const hiddenBlockSize = parseMetaspaceUnsigned(
        values[`${prefix}hiddenBlockSize`],
        t("隐藏类已使用元空间"),
      );
      if (
        blockSize > chunkSize ||
        hiddenBlockSize > hiddenChunkSize ||
        (previousChunkSize !== null && chunkSize > previousChunkSize)
      ) {
        throw new Error(t("元空间容量或排序响应无效。"));
      }
      previousChunkSize = chunkSize;
      const classCount = parseMetaspaceUnsigned(
        values[`${prefix}classCount`],
        t("已加载类数量"),
      );
      const hiddenClassCount = parseMetaspaceUnsigned(
        values[`${prefix}hiddenClassCount`],
        t("隐藏类数量"),
      );
      visibleClassCount += classCount;
      visibleChunkSize += chunkSize;
      visibleBlockSize += blockSize;
      visibleHiddenClassCount += hiddenClassCount;
      visibleHiddenChunkSize += hiddenChunkSize;
      visibleHiddenBlockSize += hiddenBlockSize;
      return {
        id,
        name: parseMetaspaceText(values[`${prefix}name`], t("加载器名称")),
        type: parseMetaspaceText(values[`${prefix}type`], t("加载器类型")),
        parentId: parseMetaspaceText(
          values[`${prefix}parentId`],
          t("父加载器 ID"),
        ),
        parentName: parseMetaspaceText(
          values[`${prefix}parentName`],
          t("父加载器名称"),
        ),
        classCount,
        chunkSize,
        blockSize,
        hiddenClassCount,
        hiddenChunkSize,
        hiddenBlockSize,
        sampledAtEpochMillis: parseClassLoaderResourceInteger(
          values[`${prefix}sampledAtEpochMillis`],
          startedAtEpochMillis,
          completedAtEpochMillis,
          t("加载器采样时间"),
        ),
      };
    },
  );
  const totals = {
    totalClassCount: parseMetaspaceUnsigned(
      values.totalClassCount,
      t("类总数"),
    ),
    totalChunkSize: parseMetaspaceUnsigned(
      values.totalChunkSize,
      t("元空间分配总量"),
    ),
    totalBlockSize: parseMetaspaceUnsigned(
      values.totalBlockSize,
      t("元空间使用总量"),
    ),
    totalHiddenClassCount: parseMetaspaceUnsigned(
      values.totalHiddenClassCount,
      t("隐藏类总数"),
    ),
    totalHiddenChunkSize: parseMetaspaceUnsigned(
      values.totalHiddenChunkSize,
      t("隐藏类元空间分配总量"),
    ),
    totalHiddenBlockSize: parseMetaspaceUnsigned(
      values.totalHiddenBlockSize,
      t("隐藏类元空间使用总量"),
    ),
  };
  if (
    totals.totalClassCount < visibleClassCount ||
    totals.totalChunkSize < visibleChunkSize ||
    totals.totalBlockSize < visibleBlockSize ||
    totals.totalHiddenClassCount < visibleHiddenClassCount ||
    totals.totalHiddenChunkSize < visibleHiddenChunkSize ||
    totals.totalHiddenBlockSize < visibleHiddenBlockSize ||
    totals.totalBlockSize > totals.totalChunkSize ||
    totals.totalHiddenBlockSize > totals.totalHiddenChunkSize
  ) {
    throw new Error(t("元空间汇总响应无效。"));
  }
  return {
    startedAtEpochMillis,
    completedAtEpochMillis,
    durationMillis,
    periodMillis,
    eventCount,
    totalLoaders,
    truncated: values.truncated === "true",
    ...totals,
    rows,
  };
}

function formatMetaspaceBytes(value: bigint): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let divisor = 1n;
  let unitIndex = 0;
  while (unitIndex < units.length - 1 && value >= divisor * 1_024n) {
    divisor *= 1_024n;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${value.toLocaleString()} ${units[unitIndex]}`;
  }
  const tenths = (value * 10n + divisor / 2n) / divisor;
  return `${tenths / 10n}.${tenths % 10n} ${units[unitIndex]}`;
}

function formatMetaspaceUtilization(used: bigint, allocated: bigint): string {
  if (allocated === 0n) {
    return "—";
  }
  const tenths = (used * 1_000n + allocated / 2n) / allocated;
  return `${tenths / 10n}.${tenths % 10n}%`;
}

function boundedHeapNumber(value: string | undefined, maximum: number): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(parsed, maximum);
}

export default function ClassesView() {
  useLocale();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTargetId = useTargetsStore((state) => state.selectedTargetId);
  const connection = useTargetsStore(selectConnection);

  const [classes, setClasses] = useState<readonly ClassDescriptor[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<ClassDescriptor | null>(null);
  const [details, setDetails] = useState<ClassDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [classDumpConfirmation, setClassDumpConfirmation] = useState(false);
  const [dumpingClass, setDumpingClass] = useState(false);
  const [dumpedArtifact, setDumpedArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const [decompiledSource, setDecompiledSource] = useState<string | null>(null);
  const [compiledClass, setCompiledClass] = useState<CompiledClass | null>(
    null,
  );
  const [redefinitionPreview, setRedefinitionPreview] =
    useState<ActionResult | null>(null);
  const [redefinitionResult, setRedefinitionResult] =
    useState<ActionResult | null>(null);
  const [redefiningClass, setRedefiningClass] = useState(false);
  const [redefinitionConfirmed, setRedefinitionConfirmed] = useState(false);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [rollback, setRollback] = useState<{
    readonly token: string;
    readonly expectedCurrentSha256: string;
  } | null>(null);
  const [classChangeSetDrafts, setClassChangeSetDrafts] = useState<
    readonly ClassChangeSetDraft[]
  >([]);
  const [compiledClassChangeSet, setCompiledClassChangeSet] =
    useState<CompiledClassChangeSet | null>(null);
  const [classChangeSetPreview, setClassChangeSetPreview] =
    useState<ClassChangeSetPreviewEvidence | null>(null);
  const [classChangeSetResult, setClassChangeSetResult] = useState<
    readonly ClassChangeSetEvidenceItem[]
  >([]);
  const [classChangeSetBusy, setClassChangeSetBusy] = useState(false);
  const [classChangeSetConfirmed, setClassChangeSetConfirmed] = useState(false);
  const [classChangeSetRestoreConfirmed, setClassChangeSetRestoreConfirmed] =
    useState(false);
  const [classChangeSetMessage, setClassChangeSetMessage] = useState<
    string | null
  >(null);
  const [classChangeSetDraftsLoading, setClassChangeSetDraftsLoading] =
    useState(false);
  const [classChangeSetDraftPersistence, setClassChangeSetDraftPersistence] =
    useState<"idle" | "saving" | "saved" | "error">("idle");
  const [classChangeSetRollback, setClassChangeSetRollback] = useState<{
    readonly token: string;
    readonly expectedCurrentFingerprint: string;
  } | null>(null);
  const [heapInstanceLimit, setHeapInstanceLimit] = useState(5);
  const [heapInstanceConfirmed, setHeapInstanceConfirmed] = useState(false);
  const [heapInstances, setHeapInstances] = useState<readonly HeapInstance[]>(
    [],
  );
  const [queryingHeapInstances, setQueryingHeapInstances] = useState(false);
  const [heapQueryCompleted, setHeapQueryCompleted] = useState(false);
  const [
    heapRetainedRankingInstanceLimit,
    setHeapRetainedRankingInstanceLimit,
  ] = useState(10);
  const [heapRetainedRankingMaximumNodes, setHeapRetainedRankingMaximumNodes] =
    useState(250_000);
  const [heapRetainedRankingMaximumEdges, setHeapRetainedRankingMaximumEdges] =
    useState(1_000_000);
  const [heapRetainedRankingConfirmed, setHeapRetainedRankingConfirmed] =
    useState(false);
  const [queryingHeapRetainedRanking, setQueryingHeapRetainedRanking] =
    useState(false);
  const [heapRetainedRankingCompleted, setHeapRetainedRankingCompleted] =
    useState(false);
  const [heapRetainedRanking, setHeapRetainedRanking] =
    useState<HeapRetainedRankingResult | null>(null);
  const [heapRelationObject, setHeapRelationObject] =
    useState<HeapInstance | null>(null);
  const [heapRelationHistory, setHeapRelationHistory] = useState<
    readonly HeapInstance[]
  >([]);
  const [heapRelationDirection, setHeapRelationDirection] = useState<
    "OUTGOING" | "INCOMING" | "GRAPH" | "ROOT" | "RETAINED"
  >("OUTGOING");
  const [heapRelationLimit, setHeapRelationLimit] = useState(20);
  const [heapRelationScanLimit, setHeapRelationScanLimit] = useState(250_000);
  const [heapGraphDirection, setHeapGraphDirection] = useState<
    "OUTGOING" | "INCOMING"
  >("OUTGOING");
  const [heapGraphMaximumDepth, setHeapGraphMaximumDepth] = useState(3);
  const [heapGraphMaximumNodes, setHeapGraphMaximumNodes] = useState(40);
  const [heapGraphMaximumEdgesPerNode, setHeapGraphMaximumEdgesPerNode] =
    useState(4);
  const [heapGraphResult, setHeapGraphResult] =
    useState<HeapGraphResult | null>(null);
  const [heapRootMaximumPaths, setHeapRootMaximumPaths] = useState(4);
  const [heapRootMaximumDepth, setHeapRootMaximumDepth] = useState(16);
  const [heapRootMaximumNodes, setHeapRootMaximumNodes] = useState(50_000);
  const [heapRelationConfirmed, setHeapRelationConfirmed] = useState(false);
  const [heapRelations, setHeapRelations] = useState<readonly HeapRelation[]>(
    [],
  );
  const [heapRootPaths, setHeapRootPaths] = useState<readonly HeapRootPath[]>(
    [],
  );
  const [heapRelationScanned, setHeapRelationScanned] = useState(0);
  const [heapRootTaggedObjects, setHeapRootTaggedObjects] = useState(0);
  const [heapRootTagConflicts, setHeapRootTagConflicts] = useState(0);
  const [heapRootPathLimitReached, setHeapRootPathLimitReached] =
    useState(false);
  const [heapRetainedResult, setHeapRetainedResult] =
    useState<HeapRetainedResult | null>(null);
  const [heapRelationTruncated, setHeapRelationTruncated] = useState(false);
  const [heapRelationCompleted, setHeapRelationCompleted] = useState(false);
  const [queryingHeapRelations, setQueryingHeapRelations] = useState(false);
  const [staticFields, setStaticFields] = useState<
    readonly StaticFieldDescriptor[]
  >([]);
  const [loadingStaticFields, setLoadingStaticFields] = useState(false);
  const [staticFieldPreview, setStaticFieldPreview] =
    useState<ActionResult | null>(null);
  const [staticFieldResult, setStaticFieldResult] =
    useState<ActionResult | null>(null);
  const [staticFieldConfirmed, setStaticFieldConfirmed] = useState(false);
  const [selectedStaticField, setSelectedStaticField] =
    useState<StaticFieldDescriptor | null>(null);
  const [staticFieldAction, setStaticFieldAction] = useState<string | null>(
    null,
  );
  const [classLoaders, setClassLoaders] = useState<
    readonly ClassLoaderSummary[]
  >([]);
  const [bootstrapClasses, setBootstrapClasses] = useState(0);
  const [loadingClassLoaders, setLoadingClassLoaders] = useState(false);
  const [classLoaderMetaspaceDuration, setClassLoaderMetaspaceDuration] =
    useState(1_000);
  const [classLoaderMetaspaceLimit, setClassLoaderMetaspaceLimit] =
    useState(50);
  const [classLoaderMetaspaceResult, setClassLoaderMetaspaceResult] =
    useState<ClassLoaderMetaspaceResult | null>(null);
  const [loadingClassLoaderMetaspace, setLoadingClassLoaderMetaspace] =
    useState(false);
  const [classLoaderResourceName, setClassLoaderResourceName] = useState("");
  const [classLoaderResourceResult, setClassLoaderResourceResult] =
    useState<ClassLoaderResourceResult | null>(null);
  const [loadingClassLoaderResources, setLoadingClassLoaderResources] =
    useState(false);

  const classesRef = useRef<readonly ClassDescriptor[]>([]);
  const selectedRef = useRef<ClassDescriptor | null>(null);
  const classChangeSetDraftsRef = useRef<readonly ClassChangeSetDraft[]>([]);
  const classChangeSetDraftLoadIdRef = useRef(0);
  const heapRelationObjectRef = useRef<HeapInstance | null>(null);
  const classLoadRequestIdRef = useRef(0);
  const queryRef = useRef("");
  const classSearchInputRef = useRef<HTMLInputElement | null>(null);

  function updateQuery(next: string): void {
    queryRef.current = next;
    if (
      classSearchInputRef.current &&
      classSearchInputRef.current.value !== next
    ) {
      classSearchInputRef.current.value = next;
    }
  }

  function persistQuery(nextQuery: string): void {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (nextQuery.trim()) {
          next.set("query", nextQuery.trim());
        } else {
          next.delete("query");
        }
        return next;
      },
      { replace: true },
    );
  }

  function submitClassSearch(): void {
    const nextQuery = classSearchInputRef.current?.value ?? queryRef.current;
    updateQuery(nextQuery);
    persistQuery(nextQuery);
    void load(0, nextQuery);
  }

  useLayoutEffect(() => {
    const input = classSearchInputRef.current;
    if (!input) {
      return;
    }
    const storageKey = `tanwei:classes:query:${selectedTargetId ?? "none"}`;
    if (!queryRef.current) {
      queryRef.current = window.sessionStorage.getItem(storageKey) ?? "";
    }
    if (input.value !== queryRef.current) {
      input.value = queryRef.current;
    }
    const handleInput = (): void => {
      queryRef.current = input.value;
      window.sessionStorage.setItem(storageKey, input.value);
    };
    input.addEventListener("input", handleInput);
    return () => input.removeEventListener("input", handleInput);
  });

  function updateClasses(next: readonly ClassDescriptor[]): void {
    classesRef.current = next;
    setClasses(next);
  }

  function updateSelected(next: ClassDescriptor | null): void {
    selectedRef.current = next;
    setSelected(next);
  }

  function updateClassChangeSetDrafts(
    next: readonly ClassChangeSetDraft[],
  ): void {
    classChangeSetDraftsRef.current = next;
    setClassChangeSetDrafts(next);
  }

  function persistClassChangeSetDrafts(
    next: readonly ClassChangeSetDraft[],
  ): void {
    const targetId = useTargetsStore.getState().selectedTargetId;
    classChangeSetDraftLoadIdRef.current += 1;
    updateClassChangeSetDrafts(next);
    setClassChangeSetDraftsLoading(false);
    if (!targetId) {
      setClassChangeSetDraftPersistence("error");
      setClassChangeSetMessage(t("没有可保存草稿的目标 JVM。"));
      return;
    }
    setClassChangeSetDraftPersistence("saving");
    void window.tanwei
      .replaceClassChangeSetDrafts({ targetId, items: next })
      .then((result) => {
        if (
          useTargetsStore.getState().selectedTargetId !== targetId ||
          classChangeSetDraftsRef.current !== next
        ) {
          return;
        }
        if (!result.ok || !result.value) {
          setClassChangeSetDraftPersistence("error");
          setClassChangeSetMessage(
            result.errorMessage ?? t("无法保存类变更集草稿"),
          );
          return;
        }
        updateClassChangeSetDrafts(result.value);
        setClassChangeSetDraftPersistence("saved");
      })
      .catch((error: unknown) => {
        if (
          useTargetsStore.getState().selectedTargetId === targetId &&
          classChangeSetDraftsRef.current === next
        ) {
          setClassChangeSetDraftPersistence("error");
          setClassChangeSetMessage(
            error instanceof Error ? error.message : t("无法保存类变更集草稿"),
          );
        }
      });
  }

  function updateHeapRelationObject(next: HeapInstance | null): void {
    heapRelationObjectRef.current = next;
    setHeapRelationObject(next);
  }

  const visibleMethods = details?.methods.slice(0, 300) ?? [];
  const classRedefinitionAvailable = connection?.capabilities.some(
    (capability) =>
      capability.id === "class-redefine" && capability.state === "AVAILABLE",
  );
  const currentClassChangeSetDraft = (() => {
    const current = selected;
    if (!current) {
      return null;
    }
    return (
      classChangeSetDrafts.find(
        (item) =>
          item.className === current.name &&
          item.classLoader === current.classLoader,
      ) ?? null
    );
  })();
  const classChangeSetSourceBytes = classChangeSetDrafts.reduce(
    (totalBytes, item) =>
      totalBytes + new TextEncoder().encode(item.source).length,
    0,
  );
  const heapInstanceCapability = connection?.capabilities.find(
    (capability) => capability.id === "heap-instances",
  );
  const heapInstanceQueryAvailable =
    heapInstanceCapability?.state === "AVAILABLE";
  const heapRetainedRankingStatusState: "ready" | "working" =
    heapRetainedRanking?.exact ? "ready" : "working";
  const heapRetainedRankingStatusLabel = heapRetainedRanking?.exact
    ? t("精确排行")
    : t("候选排行");
  const heapRetainedRankingSummary = (() => {
    const result = heapRetainedRanking;
    if (!result) {
      return "";
    }
    return t(
      "共享分析 {nodes} 个图节点 / {edges} 条强引用边 · {count} 个样本",
      {
        nodes: result.graphNodes.toLocaleString(),
        edges: result.graphEdges.toLocaleString(),
        count: result.entries.length,
      },
    );
  })();
  const staticFieldCapability = connection?.capabilities.find(
    (capability) => capability.id === "static-fields",
  );
  const staticFieldInspectionAvailable =
    staticFieldCapability?.state === "AVAILABLE";
  const classLoaderMetaspaceCapability = connection?.capabilities.find(
    (capability) => capability.id === "classloader-metaspace",
  );
  const classLoaderMetaspaceAvailable =
    classLoaderMetaspaceCapability?.state === "AVAILABLE";
  const classLoaderResourceStatus = (() => {
    const count = classLoaderResourceResult?.resources.length ?? 0;
    if (count === 0) {
      return { state: "idle" as const, label: t("未命中") };
    }
    if (count === 1) {
      return { state: "ready" as const, label: t("唯一来源") };
    }
    return {
      state: "working" as const,
      label: t("{count} 个可见来源", { count }),
    };
  })();
  const heapRootReachedCount = heapRootPaths.filter(
    (path) => path.rootReached,
  ).length;
  const heapRootNodeCount = heapRootPaths.reduce(
    (count, path) => count + path.nodes.length,
    0,
  );
  const heapRootResultComplete =
    heapRootPaths.length > 0 &&
    heapRootReachedCount === heapRootPaths.length &&
    !heapRootPathLimitReached &&
    !heapRelationTruncated &&
    heapRootTagConflicts === 0;
  const heapGraphNodesByIndex = new Map<number, HeapGraphNode>();
  for (const node of heapGraphResult?.nodes ?? []) {
    heapGraphNodesByIndex.set(node.index, node);
  }
  const heapGraphEdgesBySource = new Map<number, HeapGraphEdge[]>();
  for (const edge of heapGraphResult?.edges ?? []) {
    const existing = heapGraphEdgesBySource.get(edge.source) ?? [];
    existing.push(edge);
    heapGraphEdgesBySource.set(edge.source, existing);
  }
  const heapGraphLayers = (() => {
    const layers = new Map<number, HeapGraphNode[]>();
    for (const node of heapGraphResult?.nodes ?? []) {
      const existing = layers.get(node.depth) ?? [];
      existing.push(node);
      layers.set(node.depth, existing);
    }
    return [...layers.entries()]
      .sort(([left], [right]) => left - right)
      .map(([depth, nodes]) => ({ depth, nodes }));
  })();
  const heapAnalysisConfirmation = (() => {
    const object = heapRelationObject;
    if (!object) {
      return "";
    }
    switch (heapRelationDirection) {
      case "RETAINED":
        return t(
          "我确认对对象 @{identity} 执行两次有界强引用扫描；每次最多检查 {budget} 条边，闭包最多临时标记 {nodes} 个对象。只有两次扫描完整、弱引用语义完整且无标签冲突时才报告精确 retained size。",
          {
            identity: object.identity,
            nodes: heapRootMaximumNodes.toLocaleString(),
            budget: heapRelationScanLimit.toLocaleString(),
          },
        );
      case "ROOT":
        return t(
          "我确认对对象 @{identity} 执行一次有界全堆引用扫描；最多返回 {paths} 条路径、临时标记 {nodes} 个对象并检查 {budget} 条边，返回前会清理临时标记。",
          {
            identity: object.identity,
            paths: heapRootMaximumPaths,
            nodes: heapRootMaximumNodes.toLocaleString(),
            budget: heapRelationScanLimit.toLocaleString(),
          },
        );
      case "GRAPH":
        return t(
          "我确认以对象 @{identity} 为中心按最大深度 {depth} 展开（起点深度为 0），最多返回 {nodes} 个节点、每节点 {branches} 条{direction}关系，并在 {budget} 条扫描边预算内停止。",
          {
            identity: object.identity,
            depth: heapGraphMaximumDepth,
            nodes: heapGraphMaximumNodes,
            branches: heapGraphMaximumEdgesPerNode,
            direction:
              heapGraphDirection === "OUTGOING" ? t("出向") : t("入向"),
            budget: heapRelationScanLimit.toLocaleString(),
          },
        );
      default:
        return t(
          "我确认检查对象 @{identity} 的直接引用；入向查询最多扫描 {budget} 条引用边。",
          {
            identity: object.identity,
            budget: heapRelationScanLimit.toLocaleString(),
          },
        );
    }
  })();
  const heapAnalysisActionLabel = (() => {
    switch (heapRelationDirection) {
      case "RETAINED":
        return t("计算 Retained size");
      case "ROOT":
        return t("回溯多条 GC Root 路径");
      case "GRAPH":
        return t("生成多层对象图");
      default:
        return t("开始关系检查");
    }
  })();
  const heapAnalysisSummary = (() => {
    if (heapRelationDirection === "RETAINED" && heapRetainedResult) {
      return heapRetainedResult.exact
        ? t(
            "精确 retained size {bytes} bytes · 支配 {objects} 个对象 · 双遍检查 {edges} 条边",
            {
              bytes: heapRetainedResult.retainedBytes.toLocaleString(),
              objects: heapRetainedResult.candidateObjects.toLocaleString(),
              edges: heapRelationScanned.toLocaleString(),
            },
          )
        : t(
            "候选支配集 {bytes} bytes / {objects} 个对象 · 双遍检查 {edges} 条边",
            {
              bytes: heapRetainedResult.candidateBytes.toLocaleString(),
              objects: heapRetainedResult.candidateObjects.toLocaleString(),
              edges: heapRelationScanned.toLocaleString(),
            },
          );
    }
    if (heapRelationDirection === "ROOT") {
      return t(
        "已检查 {scanned} 条边 · 临时标记 {tagged} 个对象 · 返回 {paths} 条路径 / {nodes} 个节点",
        {
          scanned: heapRelationScanned.toLocaleString(),
          tagged: heapRootTaggedObjects.toLocaleString(),
          paths: heapRootPaths.length,
          nodes: heapRootNodeCount,
        },
      );
    }
    if (heapRelationDirection === "GRAPH" && heapGraphResult) {
      return t(
        "已检查 {scanned} 条边 · {nodes} 个节点 / {edges} 条图边 · {layers} 层",
        {
          scanned: heapGraphResult.scannedEdges.toLocaleString(),
          nodes: heapGraphResult.nodes.length,
          edges: heapGraphResult.edges.length,
          layers: heapGraphLayers.length,
        },
      );
    }
    return t("已检查 {scanned} 条边 · 返回 {count} 条关系", {
      scanned: heapRelationScanned.toLocaleString(),
      count: heapRelations.length,
    });
  })();
  const heapAnalysisStatusState: "ready" | "working" = (() => {
    if (heapRelationDirection === "RETAINED") {
      return heapRetainedResult?.exact ? "ready" : "working";
    }
    if (heapRelationDirection === "ROOT") {
      return heapRootResultComplete ? "ready" : "working";
    }
    return heapRelationTruncated ? "working" : "ready";
  })();
  const heapAnalysisStatusLabel = (() => {
    if (heapRelationDirection === "RETAINED") {
      return heapRetainedResult?.exact
        ? t("精确结果")
        : t("仅候选值，不是精确结果");
    }
    if (heapRelationDirection === "ROOT") {
      return heapRootResultComplete
        ? t("全部路径到达 GC Root")
        : t("{reached}/{count} 条路径到达 GC Root · 结果有界", {
            reached: heapRootReachedCount,
            count: heapRootPaths.length,
          });
    }
    return heapRelationTruncated ? t("达到预算，结果已截断") : t("结果完整");
  })();

  function resetRedefinition(): void {
    setCompiledClass(null);
    setRedefinitionPreview(null);
    setRedefinitionResult(null);
    setRedefinitionConfirmed(false);
    setRestoreConfirmed(false);
  }

  function invalidateClassChangeSetPreview(): void {
    setCompiledClassChangeSet(null);
    setClassChangeSetPreview(null);
    setClassChangeSetResult([]);
    setClassChangeSetConfirmed(false);
    setClassChangeSetRestoreConfirmed(false);
    setClassChangeSetMessage(null);
  }

  function resetClassChangeSet(): void {
    updateClassChangeSetDrafts([]);
    invalidateClassChangeSetPreview();
    setClassChangeSetRollback(null);
    setClassChangeSetBusy(false);
    setClassChangeSetDraftPersistence("idle");
  }

  function resetStaticFields(): void {
    setStaticFields([]);
    setStaticFieldPreview(null);
    setStaticFieldResult(null);
    setStaticFieldConfirmed(false);
    setSelectedStaticField(null);
    setStaticFieldAction(null);
  }

  function resetClassLoaderResourceInspection(className = ""): void {
    setClassLoaderResourceName(
      className ? `${className.replace(/\./gu, "/")}.class` : "",
    );
    setClassLoaderResourceResult(null);
  }

  function resetHeapRelationResults(): void {
    setHeapRelationConfirmed(false);
    setHeapRelations([]);
    setHeapGraphResult(null);
    setHeapRootPaths([]);
    setHeapRetainedResult(null);
    setHeapRelationScanned(0);
    setHeapRootTaggedObjects(0);
    setHeapRootTagConflicts(0);
    setHeapRootPathLimitReached(false);
    setHeapRelationTruncated(false);
    setHeapRelationCompleted(false);
  }

  function clearHeapRetainedRanking(): void {
    setHeapRetainedRankingConfirmed(false);
    setHeapRetainedRankingCompleted(false);
    setHeapRetainedRanking(null);
  }

  function resetHeapRetainedRanking(): void {
    setHeapRetainedRankingInstanceLimit(10);
    setHeapRetainedRankingMaximumNodes(250_000);
    setHeapRetainedRankingMaximumEdges(1_000_000);
    clearHeapRetainedRanking();
  }

  function resetHeapRelations(): void {
    updateHeapRelationObject(null);
    setHeapRelationHistory([]);
    setHeapRelationDirection("OUTGOING");
    setHeapRelationLimit(20);
    setHeapRelationScanLimit(250_000);
    setHeapGraphDirection("OUTGOING");
    setHeapGraphMaximumDepth(3);
    setHeapGraphMaximumNodes(40);
    setHeapGraphMaximumEdgesPerNode(4);
    setHeapRootMaximumPaths(4);
    setHeapRootMaximumDepth(16);
    setHeapRootMaximumNodes(50_000);
    resetHeapRelationResults();
  }

  async function inspectClassLoaderMetaspace(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    if (
      !targetsState.selectedTargetId ||
      !classLoaderMetaspaceAvailable ||
      loadingClassLoaderMetaspace
    ) {
      return;
    }
    setLoadingClassLoaderMetaspace(true);
    setClassLoaderMetaspaceResult(null);
    setErrorMessage(null);
    try {
      const durationMillis = classLoaderMetaspaceDuration;
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "classloader.metaspace",
        parameters: {
          durationMillis: String(durationMillis),
          periodMillis: String(durationMillis <= 500 ? 100 : 250),
          limit: String(classLoaderMetaspaceLimit),
        },
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ??
            result.value?.message ??
            t("无法采集 ClassLoader 元空间"),
        );
        return;
      }
      setClassLoaderMetaspaceResult(
        parseClassLoaderMetaspaceResult(result.value.values),
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("无法采集 ClassLoader 元空间"),
      );
    } finally {
      setLoadingClassLoaderMetaspace(false);
    }
  }

  async function inspectClassLoaderResource(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const selectedClass = selectedRef.current;
    if (
      !targetsState.selectedTargetId ||
      !selectedClass ||
      !classLoaderResourceName.trim()
    ) {
      return;
    }
    const resourceName = classLoaderResourceName.trim();
    setLoadingClassLoaderResources(true);
    setClassLoaderResourceResult(null);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "classloader.resources",
        parameters: {
          name: selectedClass.name,
          classLoader: selectedClass.classLoader,
          resourceName,
        },
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ??
            result.value?.message ??
            t("无法定位 ClassLoader 资源"),
        );
        return;
      }
      const currentSelected = selectedRef.current;
      if (
        result.value.values.selectedClass !== selectedClass.name ||
        result.value.values.classLoader !== selectedClass.classLoader ||
        result.value.values.resourceName !== resourceName ||
        currentSelected?.name !== selectedClass.name ||
        currentSelected.classLoader !== selectedClass.classLoader
      ) {
        throw new Error(t("ClassLoader 资源定位身份不匹配。"));
      }
      setClassLoaderResourceResult(
        parseClassLoaderResourceResult(result.value.values),
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法定位 ClassLoader 资源"),
      );
    } finally {
      setLoadingClassLoaderResources(false);
    }
  }

  async function loadClassLoaders(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const activeConnection = selectConnection(targetsState);
    if (!targetsState.selectedTargetId || activeConnection?.state !== "READY") {
      return;
    }
    setLoadingClassLoaders(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "classloaders.summary",
        parameters: {},
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ??
            result.value?.message ??
            t("无法读取ClassLoader摘要"),
        );
        return;
      }
      const values = result.value.values;
      setBootstrapClasses(Number(values["bootstrap.classes"] ?? 0));
      const grouped = new Map<string, Record<string, string>>();
      for (const [key, value] of Object.entries(values)) {
        const match = /^(loader\.\d{4})\.(.+)$/u.exec(key);
        if (!match?.[1] || !match[2]) {
          continue;
        }
        const group = grouped.get(match[1]) ?? {};
        group[match[2]] = value;
        grouped.set(match[1], group);
      }
      setClassLoaders(
        [...grouped.values()].map((group) => ({
          identity: group.identity ?? "unknown",
          type: group.type ?? "unknown",
          parent: group.parent ?? "bootstrap",
          loadedClasses: Number(group.loadedClasses ?? 0),
          urls: Object.entries(group)
            .filter(([key]) => /^url\.\d{4}$/u.test(key))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, value]) => value),
        })),
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取ClassLoader摘要"),
      );
    } finally {
      setLoadingClassLoaders(false);
    }
  }

  async function load(
    nextOffset = offset,
    nextQuery = queryRef.current,
  ): Promise<void> {
    const requestId = ++classLoadRequestIdRef.current;
    const targetsState = useTargetsStore.getState();
    const activeConnection = selectConnection(targetsState);
    if (!targetsState.selectedTargetId || activeConnection?.state !== "READY") {
      updateClasses([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    updateSelected(null);
    setDetails(null);
    setClassDumpConfirmation(false);
    setDumpedArtifact(null);
    setDecompiledSource(null);
    resetRedefinition();
    setRollback(null);
    setHeapInstances([]);
    setHeapInstanceConfirmed(false);
    setHeapQueryCompleted(false);
    resetHeapRetainedRanking();
    resetHeapRelations();
    resetStaticFields();
    resetClassLoaderResourceInspection();
    try {
      const result = await window.tanwei.listClasses(
        targetsState.selectedTargetId,
        {
          offset: nextOffset,
          limit: PAGE_SIZE,
          query: nextQuery.trim(),
        },
      );
      if (requestId !== classLoadRequestIdRef.current) {
        return;
      }
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法读取已加载类"));
        return;
      }
      setOffset(result.value.offset);
      setTotal(result.value.total);
      updateClasses(result.value.items);
    } catch (error) {
      if (requestId !== classLoadRequestIdRef.current) {
        return;
      }
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取已加载类"),
      );
    } finally {
      if (requestId === classLoadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }

  async function selectClass(item: ClassDescriptor): Promise<void> {
    const targetsState = useTargetsStore.getState();
    updateSelected(item);
    setDetails(null);
    resetRedefinition();
    setRollback(null);
    setHeapInstances([]);
    setHeapInstanceConfirmed(false);
    setHeapQueryCompleted(false);
    resetHeapRetainedRanking();
    resetHeapRelations();
    resetStaticFields();
    resetClassLoaderResourceInspection(item.name);
    if (!targetsState.selectedTargetId) {
      return;
    }
    setLoadingDetails(true);
    try {
      const result = await window.tanwei.getClassDetails(
        targetsState.selectedTargetId,
        item.name,
        item.classLoader,
      );
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法读取类详情"));
        return;
      }
      setDetails(result.value);
      void loadStaticFields(item);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取类详情"),
      );
    } finally {
      setLoadingDetails(false);
    }
  }

  async function loadStaticFields(item: ClassDescriptor): Promise<void> {
    const targetsState = useTargetsStore.getState();
    if (!targetsState.selectedTargetId || !staticFieldInspectionAvailable) {
      return;
    }
    setLoadingStaticFields(true);
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "class.static.fields",
        parameters: {
          name: item.name,
          classLoader: item.classLoader,
        },
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ??
            result.value?.message ??
            t("无法读取静态字段元数据"),
        );
        return;
      }
      const currentSelected = selectedRef.current;
      if (
        currentSelected?.name !== item.name ||
        currentSelected.classLoader !== item.classLoader
      ) {
        return;
      }
      const values = result.value.values;
      const count = Math.min(256, Math.max(0, Number(values.count ?? 0)));
      setStaticFields(
        Array.from(
          { length: Number.isSafeInteger(count) ? count : 0 },
          (_, index): StaticFieldDescriptor | null => {
            const prefix = `field.${String(index).padStart(4, "0")}.`;
            const declaringClass = values[`${prefix}declaringClass`] ?? "";
            const name = values[`${prefix}name`] ?? "";
            const type = values[`${prefix}type`] ?? "";
            if (!declaringClass || !name || !type) {
              return null;
            }
            return {
              declaringClass,
              name,
              type,
              modifiers: values[`${prefix}modifiers`] ?? "",
              enumConstant: values[`${prefix}enumConstant`] === "true",
            };
          },
        ).filter((field): field is StaticFieldDescriptor => field !== null),
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取静态字段元数据"),
      );
    } finally {
      setLoadingStaticFields(false);
    }
  }

  async function previewStaticField(
    field: StaticFieldDescriptor,
  ): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentSelected = selectedRef.current;
    if (!targetsState.selectedTargetId || !currentSelected) {
      return;
    }
    setSelectedStaticField(field);
    setStaticFieldPreview(null);
    setStaticFieldResult(null);
    setStaticFieldConfirmed(false);
    setStaticFieldAction("preview");
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "class.static.read.preview",
        parameters: {
          name: currentSelected.name,
          classLoader: currentSelected.classLoader,
          declaringClass: field.declaringClass,
          fieldName: field.name,
        },
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ??
            result.value?.message ??
            t("无法生成静态字段读取预览"),
        );
        return;
      }
      setStaticFieldPreview(result.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法生成静态字段读取预览"),
      );
    } finally {
      setStaticFieldAction(null);
    }
  }

  async function readStaticField(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentSelected = selectedRef.current;
    if (
      !targetsState.selectedTargetId ||
      !currentSelected ||
      !selectedStaticField ||
      !staticFieldPreview ||
      !staticFieldConfirmed
    ) {
      return;
    }
    setStaticFieldAction("read");
    setErrorMessage(null);
    try {
      const field = selectedStaticField;
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "class.static.read",
        parameters: {
          name: currentSelected.name,
          classLoader: currentSelected.classLoader,
          declaringClass: field.declaringClass,
          fieldName: field.name,
          expectedFingerprint: staticFieldPreview.values.fingerprint ?? "",
          confirmed: "true",
        },
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ?? result.value?.message ?? t("无法读取静态字段"),
        );
        return;
      }
      setStaticFieldResult(result.value);
      setStaticFieldConfirmed(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法读取静态字段"),
      );
    } finally {
      setStaticFieldAction(null);
    }
  }

  function parseHeapObject(
    values: Readonly<Record<string, string>>,
    prefix: string,
  ): HeapInstance | null {
    const type = values[`${prefix}type`] ?? selectedRef.current?.name ?? "";
    const identity = values[`${prefix}identity`] ?? "";
    if (!type || !identity) {
      return null;
    }
    const fieldCount = boundedHeapNumber(values[`${prefix}field.count`], 32);
    const fields = Array.from(
      { length: fieldCount },
      (_, index): HeapInstance["fields"][number] | null => {
        const fieldPrefix = `${prefix}field.${String(index).padStart(4, "0")}.`;
        const name = values[`${fieldPrefix}name`] ?? "";
        if (!name) {
          return null;
        }
        return {
          name,
          value: values[`${fieldPrefix}value`] ?? "",
        };
      },
    ).filter(
      (field): field is HeapInstance["fields"][number] => field !== null,
    );
    const handle = values[`${prefix}handle`] ?? "";
    return {
      handle,
      type,
      identity,
      shallowSize: boundedHeapNumber(
        values[`${prefix}shallowSize`],
        Number.MAX_SAFE_INTEGER,
      ),
      navigable: values[`${prefix}navigable`] === "true" && handle.length > 0,
      fields,
    };
  }

  async function queryHeapInstances(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentSelected = selectedRef.current;
    if (
      !targetsState.selectedTargetId ||
      !currentSelected ||
      !heapInstanceConfirmed
    ) {
      return;
    }
    setQueryingHeapInstances(true);
    setErrorMessage(null);
    setHeapInstances([]);
    setHeapQueryCompleted(false);
    clearHeapRetainedRanking();
    resetHeapRelations();
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "heap.instances",
        parameters: {
          name: currentSelected.name,
          classLoader: currentSelected.classLoader,
          limit: String(heapInstanceLimit),
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
            t("Heap实例查询失败"),
        );
        return;
      }
      const values = response.value.values;
      const count = boundedHeapNumber(values.count, 20);
      setHeapInstances(
        Array.from({ length: count }, (_, index) =>
          parseHeapObject(
            values,
            `instance.${String(index).padStart(4, "0")}.`,
          ),
        ).filter((instance): instance is HeapInstance => instance !== null),
      );
      setHeapQueryCompleted(true);
      setHeapInstanceConfirmed(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("Heap实例查询失败"),
      );
    } finally {
      setQueryingHeapInstances(false);
    }
  }

  function retainedRankingBytes(entry: HeapRetainedRankingEntry): number {
    return heapRetainedRanking?.exact
      ? entry.retainedBytes
      : entry.candidateBytes;
  }

  function inspectHeapRetainedRankingEntry(
    entry: HeapRetainedRankingEntry,
  ): void {
    inspectHeapObject(entry.target);
  }

  async function queryHeapRetainedRanking(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const selectedClass = selectedRef.current;
    if (
      !targetsState.selectedTargetId ||
      !selectedClass ||
      !heapRetainedRankingConfirmed
    ) {
      return;
    }
    setQueryingHeapRetainedRanking(true);
    setErrorMessage(null);
    setHeapInstances([]);
    setHeapQueryCompleted(false);
    clearHeapRetainedRanking();
    resetHeapRelations();
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "heap.retained.ranking",
        parameters: {
          name: selectedClass.name,
          classLoader: selectedClass.classLoader,
          instanceLimit: String(heapRetainedRankingInstanceLimit),
          maximumNodes: String(heapRetainedRankingMaximumNodes),
          maximumEdges: String(heapRetainedRankingMaximumEdges),
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
            t("批量Retained排行查询失败"),
        );
        return;
      }
      const values = response.value.values;
      if (
        values.className !== selectedClass.name ||
        values.classLoader !== selectedClass.classLoader
      ) {
        setErrorMessage(t("Agent返回了无效的批量Retained排行"));
        return;
      }
      const count = boundedHeapNumber(values.count, 20);
      const exact = values.exact === "true";
      const entries = Array.from(
        { length: count },
        (_, index): HeapRetainedRankingEntry | null => {
          const prefix = `entry.${String(index).padStart(4, "0")}.`;
          const target = parseHeapObject(values, prefix);
          const rank = Number(values[`${prefix}rank`] ?? 0);
          const candidateObjects = boundedHeapNumber(
            values[`${prefix}candidateObjects`],
            Number.MAX_SAFE_INTEGER,
          );
          const candidateBytes = boundedHeapNumber(
            values[`${prefix}candidateBytes`],
            Number.MAX_SAFE_INTEGER,
          );
          const retainedBytes = Number(values[`${prefix}retainedBytes`] ?? -1);
          if (
            !target ||
            target.type !== selectedClass.name ||
            !Number.isSafeInteger(rank) ||
            rank < 1 ||
            rank > count ||
            candidateObjects < 1 ||
            candidateBytes < target.shallowSize ||
            !Number.isSafeInteger(retainedBytes) ||
            (exact ? retainedBytes !== candidateBytes : retainedBytes !== -1)
          ) {
            return null;
          }
          return {
            rank,
            candidateObjects,
            candidateBytes,
            retainedBytes,
            target,
          };
        },
      ).filter((entry): entry is HeapRetainedRankingEntry => entry !== null);
      const ranks = new Set(entries.map((entry) => entry.rank));
      const handles = new Set(entries.map((entry) => entry.target.handle));
      const graphNodes = boundedHeapNumber(values.graphNodes, 500_000);
      const graphEdges = boundedHeapNumber(values.graphEdges, 2_000_000);
      const reachableNodes = boundedHeapNumber(values.reachableNodes, 500_000);
      const tagConflicts = boundedHeapNumber(
        values.tagConflicts,
        Number.MAX_SAFE_INTEGER,
      );
      const truncated = values.truncated === "true";
      const weakSemanticsComplete = values.weakSemanticsComplete === "true";
      if (
        entries.length !== count ||
        ranks.size !== count ||
        handles.size !== count ||
        reachableNodes > graphNodes ||
        (exact && (truncated || tagConflicts > 0 || !weakSemanticsComplete))
      ) {
        setErrorMessage(t("Agent返回了无效的批量Retained排行"));
        return;
      }
      setHeapRetainedRanking({
        exact,
        graphNodes,
        graphEdges,
        tagConflicts,
        truncated,
        nodeLimitReached: values.nodeLimitReached === "true",
        edgeLimitReached: values.edgeLimitReached === "true",
        weakSemanticsComplete,
        reachableNodes,
        reachableBytes: boundedHeapNumber(
          values.reachableBytes,
          Number.MAX_SAFE_INTEGER,
        ),
        entries,
      });
      setHeapRetainedRankingCompleted(true);
      setHeapRetainedRankingConfirmed(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("批量Retained排行查询失败"),
      );
    } finally {
      setQueryingHeapRetainedRanking(false);
    }
  }

  function inspectHeapObject(instance: HeapInstance): void {
    if (!instance.navigable) {
      return;
    }
    updateHeapRelationObject(instance);
    setHeapRelationHistory([]);
    resetHeapRelationResults();
  }

  function setHeapRelationDirectionValue(
    direction: "OUTGOING" | "INCOMING" | "GRAPH" | "ROOT" | "RETAINED",
  ): void {
    if (heapRelationDirection === direction) {
      return;
    }
    setHeapRelationDirection(direction);
    resetHeapRelationResults();
  }

  function setHeapGraphDirectionValue(
    direction: "OUTGOING" | "INCOMING",
  ): void {
    if (heapGraphDirection === direction) {
      return;
    }
    setHeapGraphDirection(direction);
    resetHeapRelationResults();
  }

  function changeHeapGraphDirection(value: string): void {
    if (value === "OUTGOING" || value === "INCOMING") {
      setHeapGraphDirectionValue(value);
    }
  }

  function heapGraphEdgesFor(nodeIndex: number): readonly HeapGraphEdge[] {
    return heapGraphEdgesBySource.get(nodeIndex) ?? [];
  }

  function heapGraphTargetFor(edge: HeapGraphEdge): HeapGraphNode | null {
    return heapGraphNodesByIndex.get(edge.target) ?? null;
  }

  function followHeapRetainedContributor(
    contributor: HeapRetainedContributor,
  ): void {
    if (!contributor.target.navigable || !heapRelationObject) {
      return;
    }
    setHeapRelationHistory([
      ...heapRelationHistory.slice(-15),
      heapRelationObject,
    ]);
    updateHeapRelationObject(contributor.target);
    resetHeapRelationResults();
  }

  function followHeapRelation(relation: HeapRelation): void {
    if (!relation.target.navigable || !heapRelationObject) {
      return;
    }
    setHeapRelationHistory([
      ...heapRelationHistory.slice(-15),
      heapRelationObject,
    ]);
    updateHeapRelationObject(relation.target);
    resetHeapRelationResults();
  }

  function followHeapGraphNode(node: HeapGraphNode): void {
    if (!node.target.navigable || !heapRelationObject) {
      return;
    }
    setHeapRelationHistory([
      ...heapRelationHistory.slice(-15),
      heapRelationObject,
    ]);
    updateHeapRelationObject(node.target);
    resetHeapRelationResults();
  }

  function followHeapRootNode(node: HeapRootNode): void {
    if (!node.target.navigable || !heapRelationObject) {
      return;
    }
    setHeapRelationHistory([
      ...heapRelationHistory.slice(-15),
      heapRelationObject,
    ]);
    updateHeapRelationObject(node.target);
    setHeapRelationDirection("OUTGOING");
    resetHeapRelationResults();
  }

  function previousHeapObject(): void {
    const previous = heapRelationHistory[heapRelationHistory.length - 1];
    if (!previous) {
      return;
    }
    setHeapRelationHistory(heapRelationHistory.slice(0, -1));
    updateHeapRelationObject(previous);
    resetHeapRelationResults();
  }

  async function queryHeapRelations(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentObject = heapRelationObjectRef.current;
    if (
      !targetsState.selectedTargetId ||
      !currentObject?.navigable ||
      !heapRelationConfirmed
    ) {
      return;
    }
    setQueryingHeapRelations(true);
    setErrorMessage(null);
    resetHeapRelationResults();
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "heap.relations",
        parameters: {
          objectHandle: currentObject.handle,
          direction: heapRelationDirection,
          limit: String(heapRelationLimit),
          scanLimit: String(heapRelationScanLimit),
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
            t("对象关系查询失败"),
        );
        return;
      }
      const values = response.value.values;
      const rootObject = parseHeapObject(values, "object.");
      if (!rootObject) {
        setErrorMessage(t("Agent返回了无效的对象关系"));
        return;
      }
      const relationCount = boundedHeapNumber(values.count, 50);
      const relations = Array.from(
        { length: relationCount },
        (_, index): HeapRelation | null => {
          const prefix = `relation.${String(index).padStart(4, "0")}.`;
          const target = parseHeapObject(values, prefix);
          if (!target) {
            return null;
          }
          return {
            label: values[`${prefix}label`] ?? t("未知引用"),
            kind: values[`${prefix}kind`] ?? "UNKNOWN",
            index: Number(values[`${prefix}index`] ?? -1),
            target,
          };
        },
      ).filter((relation): relation is HeapRelation => relation !== null);
      updateHeapRelationObject(rootObject);
      setHeapRelations(relations);
      setHeapRelationScanned(boundedHeapNumber(values.scanned, 1_000_000));
      setHeapRelationTruncated(values.truncated === "true");
      setHeapRelationCompleted(true);
      setHeapRelationConfirmed(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("对象关系查询失败"),
      );
    } finally {
      setQueryingHeapRelations(false);
    }
  }

  async function queryHeapObjectGraph(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentObject = heapRelationObjectRef.current;
    if (
      !targetsState.selectedTargetId ||
      !currentObject?.navigable ||
      !heapRelationConfirmed
    ) {
      return;
    }
    setQueryingHeapRelations(true);
    setErrorMessage(null);
    resetHeapRelationResults();
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "heap.object.graph",
        parameters: {
          objectHandle: currentObject.handle,
          direction: heapGraphDirection,
          maximumDepth: String(heapGraphMaximumDepth),
          maximumNodes: String(heapGraphMaximumNodes),
          maximumEdgesPerNode: String(heapGraphMaximumEdgesPerNode),
          scanLimit: String(heapRelationScanLimit),
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
            t("多层对象图查询失败"),
        );
        return;
      }
      const values = response.value.values;
      const direction = values.direction;
      if (direction !== "OUTGOING" && direction !== "INCOMING") {
        setErrorMessage(t("Agent返回了无效的多层对象图"));
        return;
      }
      const rootObject = parseHeapObject(values, "object.");
      const nodeCount = boundedHeapNumber(values["node.count"], 80);
      const edgeCount = boundedHeapNumber(values["edge.count"], 640);
      if (!rootObject || nodeCount < 1) {
        setErrorMessage(t("Agent返回了无效的多层对象图"));
        return;
      }
      const nodes = Array.from(
        { length: nodeCount },
        (_, nodePosition): HeapGraphNode | null => {
          const prefix = `node.${String(nodePosition).padStart(4, "0")}.`;
          const target = parseHeapObject(values, prefix);
          const index = Number(values[`${prefix}index`] ?? -1);
          const depth = Number(values[`${prefix}depth`] ?? -1);
          if (
            !target ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= nodeCount ||
            !Number.isSafeInteger(depth) ||
            depth < 0 ||
            depth > 5
          ) {
            return null;
          }
          return {
            index,
            depth,
            target:
              index === 0 && target.handle === rootObject.handle
                ? rootObject
                : target,
          };
        },
      ).filter((node): node is HeapGraphNode => node !== null);
      const nodeIndexes = new Set(nodes.map((node) => node.index));
      if (
        nodes.length !== nodeCount ||
        nodeIndexes.size !== nodeCount ||
        !nodeIndexes.has(0)
      ) {
        setErrorMessage(t("Agent返回了无效的多层对象图"));
        return;
      }
      const edges = Array.from(
        { length: edgeCount },
        (_, edgePosition): HeapGraphEdge | null => {
          const prefix = `edge.${String(edgePosition).padStart(4, "0")}.`;
          const source = Number(values[`${prefix}source`] ?? -1);
          const target = Number(values[`${prefix}target`] ?? -1);
          const label = values[`${prefix}label`] ?? "";
          const kind = values[`${prefix}kind`] ?? "";
          const index = Number(values[`${prefix}index`] ?? -1);
          if (
            !Number.isSafeInteger(source) ||
            !Number.isSafeInteger(target) ||
            !nodeIndexes.has(source) ||
            !nodeIndexes.has(target) ||
            !label ||
            !kind ||
            !Number.isSafeInteger(index)
          ) {
            return null;
          }
          return { source, target, label, kind, index };
        },
      ).filter((edge): edge is HeapGraphEdge => edge !== null);
      if (edges.length !== edgeCount) {
        setErrorMessage(t("Agent返回了无效的多层对象图"));
        return;
      }
      const graphResult: HeapGraphResult = {
        direction,
        scannedEdges: boundedHeapNumber(values.scannedEdges, 1_000_000),
        taggedObjects: boundedHeapNumber(values.taggedObjects, 100_000),
        tagConflicts: boundedHeapNumber(
          values.tagConflicts,
          Number.MAX_SAFE_INTEGER,
        ),
        truncated: values.truncated === "true",
        nodeLimitReached: values.nodeLimitReached === "true",
        depthLimitReached: values.depthLimitReached === "true",
        branchLimitReached: values.branchLimitReached === "true",
        nodes,
        edges,
      };
      updateHeapRelationObject(rootObject);
      setHeapGraphResult(graphResult);
      setHeapRelationScanned(graphResult.scannedEdges);
      setHeapRootTaggedObjects(graphResult.taggedObjects);
      setHeapRootTagConflicts(graphResult.tagConflicts);
      setHeapRelationTruncated(graphResult.truncated);
      setHeapRelationCompleted(true);
      setHeapRelationConfirmed(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("多层对象图查询失败"),
      );
    } finally {
      setQueryingHeapRelations(false);
    }
  }

  async function queryHeapRootPaths(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentObject = heapRelationObjectRef.current;
    if (
      !targetsState.selectedTargetId ||
      !currentObject?.navigable ||
      !heapRelationConfirmed
    ) {
      return;
    }
    setQueryingHeapRelations(true);
    setErrorMessage(null);
    resetHeapRelationResults();
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "heap.root.paths",
        parameters: {
          objectHandle: currentObject.handle,
          maximumPaths: String(heapRootMaximumPaths),
          maximumDepth: String(heapRootMaximumDepth),
          maximumNodes: String(heapRootMaximumNodes),
          maximumEdges: String(heapRelationScanLimit),
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
            t("多路径GC Root查询失败"),
        );
        return;
      }
      const values = response.value.values;
      const pathCount = boundedHeapNumber(values.count, 8);
      const latestObject = heapRelationObjectRef.current;
      if (!latestObject) {
        setErrorMessage(t("当前对象句柄已失效"));
        return;
      }
      if (pathCount < 1) {
        setErrorMessage(t("Agent返回了无效的多路径GC Root结果"));
        return;
      }
      const paths = Array.from(
        { length: pathCount },
        (_, pathIndex): HeapRootPath | null => {
          const pathPrefix = `path.${String(pathIndex).padStart(4, "0")}.`;
          const nodeCount = boundedHeapNumber(values[`${pathPrefix}count`], 33);
          if (nodeCount < 1) {
            return null;
          }
          const nodes = Array.from(
            { length: nodeCount },
            (_, nodeIndex): HeapRootNode | null => {
              const prefix = `${pathPrefix}node.${String(nodeIndex).padStart(4, "0")}.`;
              const parsed = parseHeapObject(values, prefix);
              if (!parsed) {
                return null;
              }
              const target =
                nodeIndex === 0 && parsed.handle === latestObject.handle
                  ? {
                      ...parsed,
                      fields: latestObject.fields,
                    }
                  : parsed;
              return {
                label: values[`${prefix}relationLabel`] ?? t("未知引用"),
                kind: values[`${prefix}relationKind`] ?? "OTHER",
                index: Number(values[`${prefix}relationIndex`] ?? -1),
                root: values[`${prefix}root`] === "true",
                target,
              };
            },
          ).filter((node): node is HeapRootNode => node !== null);
          if (nodes.length !== nodeCount) {
            return null;
          }
          return {
            rootReached: values[`${pathPrefix}rootReached`] === "true",
            nodes,
          };
        },
      ).filter((path): path is HeapRootPath => path !== null);
      const firstNode = paths[0]?.nodes[0];
      if (paths.length !== pathCount || !firstNode) {
        setErrorMessage(t("Agent返回了无效的多路径GC Root结果"));
        return;
      }
      updateHeapRelationObject(firstNode.target);
      setHeapRootPaths(paths);
      setHeapRelationScanned(boundedHeapNumber(values.scannedEdges, 1_000_000));
      setHeapRootTaggedObjects(
        boundedHeapNumber(values.taggedObjects, 100_000),
      );
      setHeapRootTagConflicts(
        boundedHeapNumber(values.tagConflicts, Number.MAX_SAFE_INTEGER),
      );
      setHeapRootPathLimitReached(values.pathLimitReached === "true");
      setHeapRelationTruncated(values.truncated === "true");
      setHeapRelationCompleted(true);
      setHeapRelationConfirmed(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("多路径GC Root查询失败"),
      );
    } finally {
      setQueryingHeapRelations(false);
    }
  }

  async function queryHeapRetainedSize(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentObject = heapRelationObjectRef.current;
    if (
      !targetsState.selectedTargetId ||
      !currentObject?.navigable ||
      !heapRelationConfirmed
    ) {
      return;
    }
    setQueryingHeapRelations(true);
    setErrorMessage(null);
    resetHeapRelationResults();
    try {
      const response = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "heap.retained",
        parameters: {
          objectHandle: currentObject.handle,
          maximumNodes: String(heapRootMaximumNodes),
          maximumEdges: String(heapRelationScanLimit),
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
            t("Retained size查询失败"),
        );
        return;
      }
      const values = response.value.values;
      const rootObject = parseHeapObject(values, "object.");
      if (!rootObject) {
        setErrorMessage(t("Agent返回了无效的Retained size结果"));
        return;
      }
      const contributorCount = boundedHeapNumber(values.count, 20);
      const contributors = Array.from(
        { length: contributorCount },
        (_, index): HeapRetainedContributor | null => {
          const prefix = `contributor.${String(index).padStart(4, "0")}.`;
          const target = parseHeapObject(values, prefix);
          if (!target) {
            return null;
          }
          return {
            rank: boundedHeapNumber(values[`${prefix}rank`], 20),
            shallowBytes: boundedHeapNumber(
              values[`${prefix}shallowBytes`],
              Number.MAX_SAFE_INTEGER,
            ),
            target,
          };
        },
      ).filter(
        (contributor): contributor is HeapRetainedContributor =>
          contributor !== null,
      );
      if (contributors.length !== contributorCount) {
        setErrorMessage(t("Agent返回了无效的Retained size结果"));
        return;
      }
      const exact = values.exact === "true";
      const closureEdges = boundedHeapNumber(values.closureEdges, 1_000_000);
      const rootEdges = boundedHeapNumber(values.rootEdges, 1_000_000);
      updateHeapRelationObject(rootObject);
      const retainedResult: HeapRetainedResult = {
        exact,
        closureEdges,
        rootEdges,
        taggedObjects: boundedHeapNumber(values.taggedObjects, 100_000),
        tagConflicts: boundedHeapNumber(
          values.tagConflicts,
          Number.MAX_SAFE_INTEGER,
        ),
        closureTruncated: values.closureTruncated === "true",
        rootTruncated: values.rootTruncated === "true",
        weakSemanticsComplete: values.weakSemanticsComplete === "true",
        reachableObjects: boundedHeapNumber(
          values.reachableObjects,
          Number.MAX_SAFE_INTEGER,
        ),
        reachableBytes: boundedHeapNumber(
          values.reachableBytes,
          Number.MAX_SAFE_INTEGER,
        ),
        candidateObjects: boundedHeapNumber(
          values.candidateObjects,
          Number.MAX_SAFE_INTEGER,
        ),
        candidateBytes: boundedHeapNumber(
          values.candidateBytes,
          Number.MAX_SAFE_INTEGER,
        ),
        retainedBytes: exact
          ? boundedHeapNumber(values.retainedBytes, Number.MAX_SAFE_INTEGER)
          : -1,
        contributors,
      };
      setHeapRetainedResult(retainedResult);
      setHeapRelationScanned(
        Math.min(closureEdges + rootEdges, Number.MAX_SAFE_INTEGER),
      );
      setHeapRootTaggedObjects(retainedResult.taggedObjects);
      setHeapRelationTruncated(
        retainedResult.closureTruncated || retainedResult.rootTruncated,
      );
      setHeapRelationCompleted(true);
      setHeapRelationConfirmed(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("Retained size查询失败"),
      );
    } finally {
      setQueryingHeapRelations(false);
    }
  }

  function queryHeapObjectAnalysis(): void {
    if (heapRelationDirection === "GRAPH") {
      void queryHeapObjectGraph();
      return;
    }
    if (heapRelationDirection === "ROOT") {
      void queryHeapRootPaths();
      return;
    }
    if (heapRelationDirection === "RETAINED") {
      void queryHeapRetainedSize();
      return;
    }
    void queryHeapRelations();
  }

  async function compileAndPreviewRedefinition(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentSelected = selectedRef.current;
    if (
      !targetsState.selectedTargetId ||
      !currentSelected ||
      !decompiledSource
    ) {
      return;
    }
    setRedefiningClass(true);
    setErrorMessage(null);
    resetRedefinition();
    try {
      const compiled = await window.tanwei.compileClassSource({
        targetId: targetsState.selectedTargetId,
        className: currentSelected.name,
        classLoader: currentSelected.classLoader,
        source: decompiledSource,
      });
      if (!compiled.ok || !compiled.value) {
        setErrorMessage(compiled.errorMessage ?? t("无法编译编辑后的类"));
        return;
      }
      setCompiledClass(compiled.value);
      const preview = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "class.redefine.preview",
        parameters: {
          name: currentSelected.name,
          classLoader: currentSelected.classLoader,
          bytecodeBase64: compiled.value.bytecodeBase64,
        },
      });
      if (
        !preview.ok ||
        !preview.value ||
        preview.value.status !== "SUCCEEDED"
      ) {
        setErrorMessage(
          preview.errorMessage ??
            preview.value?.message ??
            t("类替换兼容性预检失败"),
        );
        return;
      }
      setRedefinitionPreview(preview.value);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("类替换兼容性预检失败"),
      );
    } finally {
      setRedefiningClass(false);
    }
  }

  async function applyClassRedefinition(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentSelected = selectedRef.current;
    if (
      !targetsState.selectedTargetId ||
      !currentSelected ||
      !compiledClass ||
      !redefinitionPreview ||
      !redefinitionConfirmed
    ) {
      return;
    }
    setRedefiningClass(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "class.redefine",
        parameters: {
          name: currentSelected.name,
          classLoader: currentSelected.classLoader,
          bytecodeBase64: compiledClass.bytecodeBase64,
          expectedCurrentSha256: redefinitionPreview.values.currentSha256 ?? "",
          confirmed: "true",
        },
      });
      setRedefinitionResult(result.value);
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ?? result.value?.message ?? t("运行时类替换失败"),
        );
        return;
      }
      const token = result.value.values.rollbackToken;
      const expectedCurrentSha256 =
        result.value.values.rollbackExpectedCurrentSha256;
      setRollback(
        token && expectedCurrentSha256
          ? { token, expectedCurrentSha256 }
          : null,
      );
      setRedefinitionPreview(null);
      setRedefinitionConfirmed(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("运行时类替换失败"),
      );
    } finally {
      setRedefiningClass(false);
    }
  }

  async function restoreClassDefinition(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    if (!targetsState.selectedTargetId || !rollback || !restoreConfirmed) {
      return;
    }
    setRedefiningClass(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "class.redefine.restore",
        parameters: {
          rollbackToken: rollback.token,
          expectedCurrentSha256: rollback.expectedCurrentSha256,
          confirmed: "true",
        },
      });
      setRedefinitionResult(result.value);
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setErrorMessage(
          result.errorMessage ??
            result.value?.message ??
            t("无法恢复替换前的类定义"),
        );
        return;
      }
      setRollback(null);
      setRestoreConfirmed(false);
      setCompiledClass(null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法恢复替换前的类定义"),
      );
    } finally {
      setRedefiningClass(false);
    }
  }

  function saveCurrentSourceToChangeSet(): void {
    const current = selectedRef.current;
    if (!current || !decompiledSource || classChangeSetRollback) {
      return;
    }
    const existingIndex = classChangeSetDrafts.findIndex(
      (item) =>
        item.className === current.name &&
        item.classLoader === current.classLoader,
    );
    const first = classChangeSetDrafts[0];
    if (first && first.classLoader !== current.classLoader) {
      setClassChangeSetMessage(
        t("多类变更集只接受同一个精确 ClassLoader 下的类。"),
      );
      return;
    }
    if (existingIndex < 0 && classChangeSetDrafts.length >= 8) {
      setClassChangeSetMessage(t("多类变更集最多包含 8 个精确类。"));
      return;
    }
    const sourceBytes = new TextEncoder().encode(decompiledSource).length;
    const existingBytes =
      existingIndex >= 0
        ? new TextEncoder().encode(
            classChangeSetDrafts[existingIndex]?.source ?? "",
          ).length
        : 0;
    if (
      sourceBytes === 0 ||
      sourceBytes > 1024 * 1024 ||
      classChangeSetSourceBytes - existingBytes + sourceBytes > 2 * 1024 * 1024
    ) {
      setClassChangeSetMessage(
        t("单类源码不得超过 1 MiB，变更集源码总量不得超过 2 MiB。"),
      );
      return;
    }
    const next = [...classChangeSetDrafts];
    const draft: ClassChangeSetDraft = {
      className: current.name,
      classLoader: current.classLoader,
      source: decompiledSource,
    };
    if (existingIndex >= 0) {
      next.splice(existingIndex, 1, draft);
    } else {
      next.push(draft);
    }
    persistClassChangeSetDrafts(next);
    invalidateClassChangeSetPreview();
  }

  function removeClassChangeSetDraft(index: number): void {
    if (
      classChangeSetRollback ||
      index < 0 ||
      index >= classChangeSetDrafts.length
    ) {
      return;
    }
    persistClassChangeSetDrafts(
      classChangeSetDrafts.filter((_item, itemIndex) => itemIndex !== index),
    );
    invalidateClassChangeSetPreview();
  }

  function clearClassChangeSetDrafts(): void {
    if (classChangeSetRollback) {
      return;
    }
    persistClassChangeSetDrafts([]);
    invalidateClassChangeSetPreview();
  }

  async function openClassChangeSetDraft(
    draft: ClassChangeSetDraft,
  ): Promise<void> {
    updateQuery(draft.className);
    await load(0, draft.className);
    const match = classesRef.current.find(
      (item) =>
        item.name === draft.className && item.classLoader === draft.classLoader,
    );
    if (!match) {
      setClassChangeSetMessage(t("变更集中的精确类已不在当前目标中。"));
      return;
    }
    await selectClass(match);
    setDecompiledSource(draft.source);
  }

  async function compileAndPreviewClassChangeSet(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentDrafts = classChangeSetDraftsRef.current;
    if (
      !targetsState.selectedTargetId ||
      currentDrafts.length < 2 ||
      classChangeSetRollback
    ) {
      return;
    }
    setClassChangeSetBusy(true);
    setClassChangeSetMessage(null);
    invalidateClassChangeSetPreview();
    try {
      const compiled = await window.tanwei.compileClassChangeSet({
        targetId: targetsState.selectedTargetId,
        items: currentDrafts,
      });
      if (!compiled.ok || !compiled.value) {
        setClassChangeSetMessage(
          compiled.errorMessage ?? t("多类变更集编译失败"),
        );
        return;
      }
      const parameters = buildClassChangeSetParameters(
        currentDrafts,
        compiled.value,
      );
      const preview = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "class.change-set.preview",
        parameters,
      });
      if (
        !preview.ok ||
        !preview.value ||
        preview.value.status !== "SUCCEEDED"
      ) {
        setClassChangeSetMessage(
          preview.errorMessage ??
            preview.value?.message ??
            t("多类变更集预检失败"),
        );
        return;
      }
      setCompiledClassChangeSet(compiled.value);
      setClassChangeSetPreview(
        parseClassChangeSetPreview(
          preview.value.values,
          classChangeSetDraftsRef.current,
        ),
      );
    } catch (error) {
      setClassChangeSetMessage(
        error instanceof Error ? error.message : t("多类变更集预检失败"),
      );
    } finally {
      setClassChangeSetBusy(false);
    }
  }

  async function applyClassChangeSet(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentDrafts = classChangeSetDraftsRef.current;
    if (
      !targetsState.selectedTargetId ||
      !compiledClassChangeSet ||
      !classChangeSetPreview ||
      !classChangeSetConfirmed ||
      classChangeSetRollback
    ) {
      return;
    }
    setClassChangeSetBusy(true);
    setClassChangeSetMessage(null);
    try {
      const parameters = {
        ...buildClassChangeSetParameters(currentDrafts, compiledClassChangeSet),
        expectedFingerprint: classChangeSetPreview.fingerprint,
        confirmed: "true",
      };
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "class.change-set.apply",
        parameters,
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setClassChangeSetMessage(
          result.errorMessage ??
            result.value?.message ??
            t("多类变更集提交失败"),
        );
        return;
      }
      const token = result.value.values.rollbackToken ?? "";
      const expectedCurrentFingerprint =
        result.value.values.rollbackExpectedCurrentFingerprint ?? "";
      if (
        !UUID_PATTERN.test(token) ||
        !/^[a-f0-9]{64}$/u.test(expectedCurrentFingerprint)
      ) {
        throw new Error(t("Agent返回了无效的变更集回滚凭据"));
      }
      setClassChangeSetResult(
        parseClassChangeSetResult(
          result.value.values,
          classChangeSetDraftsRef.current,
        ),
      );
      setClassChangeSetRollback({
        token,
        expectedCurrentFingerprint,
      });
      setClassChangeSetConfirmed(false);
      setClassChangeSetMessage(t("全部类已通过一次 JVM 原子重定义提交。"));
    } catch (error) {
      setClassChangeSetMessage(
        error instanceof Error ? error.message : t("多类变更集提交失败"),
      );
    } finally {
      setClassChangeSetBusy(false);
    }
  }

  async function restoreClassChangeSet(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    if (
      !targetsState.selectedTargetId ||
      !classChangeSetRollback ||
      !classChangeSetRestoreConfirmed
    ) {
      return;
    }
    setClassChangeSetBusy(true);
    setClassChangeSetMessage(null);
    try {
      const result = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "class.change-set.restore",
        parameters: {
          rollbackToken: classChangeSetRollback.token,
          expectedCurrentFingerprint:
            classChangeSetRollback.expectedCurrentFingerprint,
          confirmed: "true",
        },
      });
      if (!result.ok || !result.value || result.value.status !== "SUCCEEDED") {
        setClassChangeSetMessage(
          result.errorMessage ??
            result.value?.message ??
            t("多类变更集回滚失败"),
        );
        return;
      }
      setClassChangeSetResult(
        parseClassChangeSetResult(
          result.value.values,
          classChangeSetDraftsRef.current,
        ),
      );
      setClassChangeSetRollback(null);
      setCompiledClassChangeSet(null);
      setClassChangeSetPreview(null);
      setClassChangeSetRestoreConfirmed(false);
      setClassChangeSetMessage(t("全部类已通过一次 JVM 原子重定义恢复。"));
    } catch (error) {
      setClassChangeSetMessage(
        error instanceof Error ? error.message : t("多类变更集回滚失败"),
      );
    } finally {
      setClassChangeSetBusy(false);
    }
  }

  async function dumpSelectedClass(): Promise<void> {
    const targetsState = useTargetsStore.getState();
    const currentSelected = selectedRef.current;
    if (!targetsState.selectedTargetId || !currentSelected) {
      return;
    }
    setDumpingClass(true);
    setErrorMessage(null);
    setDumpedArtifact(null);
    try {
      const action = await window.tanwei.executeAction({
        targetId: targetsState.selectedTargetId,
        actionId: "class.dump",
        parameters: {
          name: currentSelected.name,
          classLoader: currentSelected.classLoader,
          confirmed: "true",
        },
      });
      if (!action.ok || !action.value || action.value.status !== "SUCCEEDED") {
        setErrorMessage(
          action.errorMessage ??
            action.value?.message ??
            t("无法捕获运行中字节码"),
        );
        return;
      }
      const token = action.value.values.token;
      const expectedSize = Number(action.value.values.size);
      if (!token || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
        setErrorMessage(t("Agent返回的ClassDump描述无效"));
        return;
      }
      const collected = await window.tanwei.collectAgentArtifact({
        targetId: targetsState.selectedTargetId,
        token,
        type: "CLASS_DUMP",
        expectedSize,
      });
      if (!collected.ok || !collected.value) {
        setErrorMessage(collected.errorMessage ?? t("无法保存ClassDump"));
        return;
      }
      setDumpedArtifact(collected.value);
      const decompiled = await window.tanwei.decompileClassArtifact(
        collected.value.id,
      );
      if (!decompiled.ok || !decompiled.value) {
        setErrorMessage(
          decompiled.errorMessage ?? t("ClassDump已保存但反编译失败"),
        );
        return;
      }
      setDecompiledSource(decompiled.value.source);
      setClassDumpConfirmation(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("无法保存ClassDump"),
      );
    } finally {
      setDumpingClass(false);
    }
  }
  function observeMethod(method: ClassDetails["methods"][number]): void {
    const currentSelected = selectedRef.current;
    if (!currentSelected) {
      return;
    }
    useObservationsStore.getState().select({
      className: currentSelected.name,
      classLoader: currentSelected.classLoader,
      method,
    });
    void navigate("/observe");
  }

  function probeMethodLine(method: ClassDetails["methods"][number]): void {
    const currentSelected = selectedRef.current;
    if (!currentSelected) {
      return;
    }
    useObservationsStore.getState().select({
      className: currentSelected.name,
      classLoader: currentSelected.classLoader,
      method,
    });
    void navigate("/line");
  }

  function monitorMethod(method: ClassDetails["methods"][number]): void {
    const currentSelected = selectedRef.current;
    if (!currentSelected) {
      return;
    }
    useObservationsStore.getState().select({
      className: currentSelected.name,
      classLoader: currentSelected.classLoader,
      method,
    });
    void navigate("/monitor");
  }

  function traceMethod(method: ClassDetails["methods"][number]): void {
    const currentSelected = selectedRef.current;
    if (!currentSelected) {
      return;
    }
    useObservationsStore.getState().select({
      className: currentSelected.name,
      classLoader: currentSelected.classLoader,
      method,
    });
    void navigate("/trace");
  }

  async function loadInitialClass(): Promise<void> {
    const classNameParam = searchParams.get("className");
    const requestedClass =
      typeof classNameParam === "string" ? classNameParam.trim() : "";
    const classLoaderParam = searchParams.get("classLoader");
    const requestedLoader =
      typeof classLoaderParam === "string" ? classLoaderParam.trim() : "";
    const queryParam = searchParams.get("query");
    const requestedQuery =
      requestedClass || queryParam?.trim() || queryRef.current;
    if (requestedQuery) {
      updateQuery(requestedQuery);
    }
    await load(0, requestedQuery);
    if (!requestedClass) {
      return;
    }
    const match = classesRef.current.find(
      (item) =>
        item.name === requestedClass &&
        (!requestedLoader || item.classLoader === requestedLoader),
    );
    if (match) {
      await selectClass(match);
      if (searchParams.get("inspect") === "object") {
        const objectHandleParam = searchParams.get("objectHandle");
        const objectHandle =
          typeof objectHandleParam === "string" ? objectHandleParam.trim() : "";
        const objectIdentityParam = searchParams.get("objectIdentity");
        const objectIdentity =
          typeof objectIdentityParam === "string"
            ? objectIdentityParam.trim()
            : "";
        const objectShallowSize = Number(searchParams.get("objectShallowSize"));
        if (
          UUID_PATTERN.test(objectHandle) &&
          objectIdentity &&
          Number.isSafeInteger(objectShallowSize) &&
          objectShallowSize >= 0
        ) {
          inspectHeapObject({
            handle: objectHandle,
            type: requestedClass,
            identity: objectIdentity,
            shallowSize: objectShallowSize,
            navigable: true,
            fields: [],
          });
        }
      }
    }
  }

  useEffect(() => {
    const loadId = classChangeSetDraftLoadIdRef.current + 1;
    classChangeSetDraftLoadIdRef.current = loadId;
    resetClassChangeSet();
    setClassLoaders([]);
    setClassLoaderMetaspaceResult(null);
    if (!selectedTargetId || connection?.state !== "READY") {
      setClassChangeSetDraftsLoading(false);
      return;
    }
    setClassChangeSetDraftsLoading(true);
    void window.tanwei
      .listClassChangeSetDrafts(selectedTargetId)
      .then((result) => {
        if (
          classChangeSetDraftLoadIdRef.current !== loadId ||
          useTargetsStore.getState().selectedTargetId !== selectedTargetId
        ) {
          return;
        }
        if (!result.ok || !result.value) {
          setClassChangeSetMessage(
            result.errorMessage ?? t("无法恢复类变更集草稿"),
          );
          return;
        }
        updateClassChangeSetDrafts(result.value);
        setClassChangeSetDraftPersistence(
          result.value.length > 0 ? "saved" : "idle",
        );
      })
      .catch((error: unknown) => {
        if (classChangeSetDraftLoadIdRef.current === loadId) {
          setClassChangeSetMessage(
            error instanceof Error ? error.message : t("无法恢复类变更集草稿"),
          );
        }
      })
      .finally(() => {
        if (classChangeSetDraftLoadIdRef.current === loadId) {
          setClassChangeSetDraftsLoading(false);
        }
      });
    return () => {
      if (classChangeSetDraftLoadIdRef.current === loadId) {
        classChangeSetDraftLoadIdRef.current += 1;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTargetId, connection?.state]);

  useEffect(() => {
    void loadInitialClass();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="page classes-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">CLASSES</p>
          <h1>{t("类与加载器。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "搜索在 Agent 内完成；每次仅返回一页，并保留相同类名在不同 ClassLoader 中的独立命中。",
          )}
        </p>
      </header>

      {connection?.state !== "READY" ? (
        <Empty className="empty-panel">
          <p className="eyebrow">NO ACTIVE CONNECTION</p>
          <p className="empty-panel__title">{t("连接目标后搜索已加载类。")}</p>
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
          <div className="class-toolbar">
            <Label>
              <span>{t("类名")}</span>
              <Input
                ref={classSearchInputRef}
                defaultValue=""
                type="search"
                placeholder={t("例如 java.util.concurrent")}
                autoComplete="off"
                onKeyUp={(event) => {
                  if (event.key === "Enter") {
                    submitClassSearch();
                  }
                }}
              />
            </Label>
            <Button
              type="button"
              variant="secondary"
              onClick={submitClassSearch}
              aria-busy={Boolean(loading)}
              disabled={Boolean(loading)}
            >
              {Boolean(loading) && <Spinner />}
              {t("搜索")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadClassLoaders()}
              aria-busy={Boolean(loadingClassLoaders)}
              disabled={Boolean(loadingClassLoaders)}
            >
              {Boolean(loadingClassLoaders) && <Spinner />}
              {t("加载器树")}
            </Button>
          </div>

          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          {classLoaders.length > 0 && (
            <section className="loader-panel">
              <header>
                <div>
                  <p className="eyebrow">CLASSLOADER TREE</p>
                  <h2>
                    {t("Bootstrap · {count} 个已加载类", {
                      count: bootstrapClasses,
                    })}
                  </h2>
                </div>
                <StatusPill
                  state="ready"
                  label={t("{count} 个加载器", {
                    count: classLoaders.length + 1,
                  })}
                />
              </header>
              {classLoaders.map((loader) => (
                <Disclosure
                  key={loader.identity}
                  className="loader-row"
                  trigger={
                    <>
                      <span>
                        <strong>{loader.identity}</strong>
                        <small>
                          {t("父级 {parent}", { parent: loader.parent })}
                        </small>
                      </span>
                      <span>
                        {t("{classes} 类 · {urls} URL", {
                          classes: loader.loadedClasses,
                          urls: loader.urls.length,
                        })}
                      </span>
                    </>
                  }
                >
                  <p>{loader.type}</p>
                  {loader.urls.length > 0 ? (
                    <ul>
                      {loader.urls.map((url) => (
                        <li key={url}>{url}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      {t(
                        "该加载器不公开 URL；这在 JDK 9+ 内置加载器中是正常情况。",
                      )}
                    </p>
                  )}
                </Disclosure>
              ))}
            </section>
          )}

          <section className="metaspace-inspector">
            <header>
              <div>
                <p className="eyebrow">CLASSLOADER METASPACE / R1</p>
                <h2>{t("定位占用 Class Metadata 的加载器。")}</h2>
              </div>
              <StatusPill
                state={
                  classLoaderMetaspaceResult
                    ? classLoaderMetaspaceResult.truncated
                      ? "working"
                      : "ready"
                    : classLoaderMetaspaceAvailable
                      ? "idle"
                      : "error"
                }
                label={
                  classLoaderMetaspaceResult
                    ? t("{count} 个加载器", {
                        count: classLoaderMetaspaceResult.totalLoaders,
                      })
                    : classLoaderMetaspaceAvailable
                      ? t("等待采样")
                      : t("能力不可用")
                }
              />
            </header>
            <p>
              {t(
                "临时启用 JFR ClassLoaderStatistics，只读取 ClassLoaderData 的 Metaspace 分配与使用；不会遍历业务对象，也不是 Java Heap retained size。",
              )}
            </p>

            {!classLoaderMetaspaceAvailable ? (
              <div className="metaspace-inspector__unavailable">
                {classLoaderMetaspaceCapability?.reason ??
                  t("当前 JDK 不提供 ClassLoader Metaspace 事件。")}
              </div>
            ) : (
              <>
                <form
                  className="metaspace-inspector__controls"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void inspectClassLoaderMetaspace();
                  }}
                >
                  <Label>
                    <span>{t("采样窗口")}</span>
                    <SelectControl
                      value={classLoaderMetaspaceDuration}
                      onValueChange={(value) =>
                        setClassLoaderMetaspaceDuration(Number(value))
                      }
                    >
                      <SelectControlItem value={500}>500 ms</SelectControlItem>
                      <SelectControlItem value={1000}>1 s</SelectControlItem>
                      <SelectControlItem value={2500}>2.5 s</SelectControlItem>
                    </SelectControl>
                  </Label>
                  <Label>
                    <span>{t("展示上限")}</span>
                    <SelectControl
                      value={classLoaderMetaspaceLimit}
                      onValueChange={(value) =>
                        setClassLoaderMetaspaceLimit(Number(value))
                      }
                    >
                      <SelectControlItem value={20}>Top 20</SelectControlItem>
                      <SelectControlItem value={50}>Top 50</SelectControlItem>
                      <SelectControlItem value={100}>Top 100</SelectControlItem>
                    </SelectControl>
                  </Label>
                  <Button
                    type="submit"
                    variant="outline"
                    aria-busy={Boolean(loadingClassLoaderMetaspace)}
                    disabled={Boolean(loadingClassLoaderMetaspace)}
                  >
                    {Boolean(loadingClassLoaderMetaspace) && <Spinner />}
                    {t("采集元空间占用")}
                  </Button>
                </form>

                {classLoaderMetaspaceResult ? (
                  <>
                    <dl className="metaspace-inspector__summary">
                      <div>
                        <dt>{t("加载器 / 事件")}</dt>
                        <dd>
                          {classLoaderMetaspaceResult.totalLoaders} /{" "}
                          {classLoaderMetaspaceResult.eventCount}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("普通类")}</dt>
                        <dd>
                          {classLoaderMetaspaceResult.totalClassCount.toLocaleString()}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("已使用 / 已分配")}</dt>
                        <dd>
                          {formatMetaspaceBytes(
                            classLoaderMetaspaceResult.totalBlockSize,
                          )}{" "}
                          /{" "}
                          {formatMetaspaceBytes(
                            classLoaderMetaspaceResult.totalChunkSize,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("隐藏类 / 已使用")}</dt>
                        <dd>
                          {classLoaderMetaspaceResult.totalHiddenClassCount.toLocaleString()}{" "}
                          /{" "}
                          {formatMetaspaceBytes(
                            classLoaderMetaspaceResult.totalHiddenBlockSize,
                          )}
                        </dd>
                      </div>
                    </dl>

                    {classLoaderMetaspaceResult.truncated && (
                      <p className="metaspace-inspector__boundary">
                        {t(
                          "列表只保留分配量最大的加载器，汇总仍覆盖本次已读取的全部最新事件。",
                        )}
                      </p>
                    )}

                    {classLoaderMetaspaceResult.rows.length > 0 ? (
                      <div className="metaspace-inspector__table">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>{t("加载器")}</TableHead>
                              <TableHead>{t("类")}</TableHead>
                              <TableHead>{t("已使用")}</TableHead>
                              <TableHead>{t("已分配")}</TableHead>
                              <TableHead>{t("利用率")}</TableHead>
                              <TableHead>{t("隐藏类")}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {classLoaderMetaspaceResult.rows.map((row) => (
                              <TableRow key={row.id}>
                                <TableCell>
                                  <strong>{row.name}</strong>
                                  <code>
                                    {row.type} · {row.id}
                                  </code>
                                  <small>
                                    {t("父级 {parent}", {
                                      parent: row.parentName,
                                    })}
                                  </small>
                                </TableCell>
                                <TableCell>
                                  {row.classCount.toLocaleString()}
                                </TableCell>
                                <TableCell>
                                  {formatMetaspaceBytes(row.blockSize)}
                                </TableCell>
                                <TableCell>
                                  {formatMetaspaceBytes(row.chunkSize)}
                                </TableCell>
                                <TableCell>
                                  {formatMetaspaceUtilization(
                                    row.blockSize,
                                    row.chunkSize,
                                  )}
                                </TableCell>
                                <TableCell>
                                  {row.hiddenClassCount.toLocaleString()} ·{" "}
                                  {formatMetaspaceBytes(row.hiddenBlockSize)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <div className="metaspace-inspector__unavailable">
                        {t("本次窗口没有产生 ClassLoaderStatistics 事件。")}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="metaspace-inspector__empty">
                    <strong>{t("尚未采集元空间样本。")}</strong>
                    <span>
                      {t("选择一个短窗口，结果按已分配 Metaspace 降序排列。")}
                    </span>
                  </div>
                )}
              </>
            )}
          </section>

          <div className="class-workspace">
            <div className="class-results">
              <div className="class-results__heading">
                <span>{t("匹配 {count}", { count: total })}</span>
                <span>
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, total)}
                </span>
              </div>
              {classes.map((item) => (
                <Button
                  variant="ghost"
                  key={`${item.name}:${item.classLoader}`}
                  type="button"
                  className={
                    selected === item
                      ? "class-row class-row--selected"
                      : "class-row"
                  }
                  onClick={() => void selectClass(item)}
                >
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.classLoader}</small>
                  </span>
                  <StatusPill
                    state={item.modifiable ? "ready" : "idle"}
                    label={item.modifiable ? t("可转换") : t("只读")}
                  />
                </Button>
              ))}

              {!loading && classes.length === 0 && (
                <Empty className="empty-panel">
                  <p className="eyebrow">NO CLASSES</p>
                  <p className="empty-panel__title">
                    {t("当前条件没有匹配类。")}
                  </p>
                </Empty>
              )}
            </div>

            <aside className="class-detail">
              {selected ? (
                <>
                  <p className="eyebrow">CLASS IDENTITY</p>
                  <h2>{selected.name}</h2>
                  <dl>
                    <div>
                      <dt>ClassLoader</dt>
                      <dd>{selected.classLoader}</dd>
                    </div>
                    <div>
                      <dt>Module</dt>
                      <dd>{selected.module ?? t("未知 / JDK 8")}</dd>
                    </div>
                    <div>
                      <dt>Instrumentation</dt>
                      <dd>
                        {selected.modifiable ? t("允许转换") : t("不可转换")}
                      </dd>
                    </div>
                    <div>
                      <dt>Code Source</dt>
                      <dd>
                        {details?.codeSource ??
                          (loadingDetails ? t("读取中…") : t("未知"))}
                      </dd>
                    </div>
                    <div>
                      <dt>Modifiers</dt>
                      <dd>{details?.modifiers || t("无")}</dd>
                    </div>
                    <div>
                      <dt>Super Class</dt>
                      <dd>{details?.superClass ?? t("无")}</dd>
                    </div>
                  </dl>
                  <div className="class-detail__actions">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!selected.modifiable}
                      onClick={() => setClassDumpConfirmation(true)}
                    >
                      {t("捕获 Class Dump")}
                    </Button>
                    {details && details.methods.length > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void navigate("/observe")}
                      >
                        {t("进入方法观测")}
                      </Button>
                    )}
                  </div>
                  <section className="classloader-resources">
                    <header>
                      <div>
                        <p className="eyebrow">RESOURCE ORIGIN / R1</p>
                        <h3>{t("沿精确加载器检查资源来源。")}</h3>
                      </div>
                      {classLoaderResourceResult && (
                        <StatusPill
                          state={classLoaderResourceStatus.state}
                          label={classLoaderResourceStatus.label}
                        />
                      )}
                    </header>
                    <p>
                      {t(
                        "只定位资源 URL，不读取内容；最多返回 100 个唯一来源、扫描 1,000 项并等待 2 秒。自定义 ClassLoader 可能执行其资源查找代码。",
                      )}
                    </p>
                    <form
                      className="classloader-resources__form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void inspectClassLoaderResource();
                      }}
                    >
                      <Label>
                        <span>{t("ClassLoader 相对资源名")}</span>
                        <Input
                          value={classLoaderResourceName}
                          onChange={(event) =>
                            setClassLoaderResourceName(event.target.value)
                          }
                          maxLength={1024}
                          autoComplete="off"
                          placeholder={t(
                            "例如 META-INF/services/java.sql.Driver",
                          )}
                        />
                      </Label>
                      <Button
                        type="submit"
                        variant="outline"
                        disabled={
                          Boolean(!classLoaderResourceName.trim()) ||
                          Boolean(loadingClassLoaderResources)
                        }
                        aria-busy={Boolean(loadingClassLoaderResources)}
                      >
                        {Boolean(loadingClassLoaderResources) && <Spinner />}
                        {t("定位可见来源")}
                      </Button>
                    </form>
                    {classLoaderResourceResult && (
                      <div className="classloader-resources__result">
                        <dl>
                          <div>
                            <dt>{t("查找范围")}</dt>
                            <dd>
                              {classLoaderResourceResult.scope ===
                              "SYSTEM_BOOTSTRAP"
                                ? t("Bootstrap / 系统资源")
                                : t("选中加载器及其父级")}
                            </dd>
                          </div>
                          <div>
                            <dt>{t("扫描")}</dt>
                            <dd>
                              {t("{count} 项 · {duration} ms", {
                                count: classLoaderResourceResult.scanned,
                                duration:
                                  classLoaderResourceResult.durationMillis,
                              })}
                            </dd>
                          </div>
                        </dl>
                        {(classLoaderResourceResult.truncated ||
                          classLoaderResourceResult.characterLimitReached) && (
                          <p className="classloader-resources__boundary">
                            {t(
                              "结果已触达扫描、来源或字符预算；缩小资源名后重试。",
                            )}
                          </p>
                        )}
                        {classLoaderResourceResult.resources.length > 0 ? (
                          <ol className="classloader-resources__locations">
                            {classLoaderResourceResult.resources.map(
                              (resource, index) => (
                                <li key={resource.location}>
                                  <span>
                                    {String(index + 1).padStart(2, "0")}
                                  </span>
                                  <div>
                                    <strong>{resource.kind}</strong>
                                    <code>{resource.location}</code>
                                  </div>
                                </li>
                              ),
                            )}
                          </ol>
                        ) : (
                          <p>{t("当前加载器链没有找到该资源。")}</p>
                        )}
                      </div>
                    )}
                  </section>
                  <section className="static-fields">
                    <div className="static-fields__heading">
                      <div>
                        <p className="eyebrow">STATIC FIELDS / R0 → R3</p>
                        <h3>{t("静态字段，先看元数据再读单值。")}</h3>
                      </div>
                      <span>{staticFields.length}</span>
                    </div>
                    <p>
                      {t(
                        "打开类时只枚举字段，不读取值；读取单个字段可能执行声明类的 <clinit>。",
                      )}
                    </p>
                    {staticFieldInspectionAvailable ? (
                      <>
                        {loadingStaticFields ? (
                          <p>{t("读取中…")}</p>
                        ) : staticFields.length > 0 ? (
                          <div className="static-fields__list">
                            {staticFields.map((field) => (
                              <article
                                key={`${field.declaringClass}:${field.name}`}
                                className="static-field"
                              >
                                <div className="static-field__identity">
                                  <span>
                                    <strong>{field.name}</strong>
                                    <small>{field.type}</small>
                                  </span>
                                  <code>{field.modifiers}</code>
                                </div>
                                <small>{field.declaringClass}</small>
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => void previewStaticField(field)}
                                  aria-busy={Boolean(
                                    staticFieldAction === "preview" &&
                                    selectedStaticField === field,
                                  )}
                                  disabled={Boolean(
                                    staticFieldAction === "preview" &&
                                    selectedStaticField === field,
                                  )}
                                >
                                  {Boolean(
                                    staticFieldAction === "preview" &&
                                    selectedStaticField === field,
                                  ) && <Spinner />}
                                  {t("生成读取预览")}
                                </Button>
                                {selectedStaticField === field &&
                                  staticFieldPreview && (
                                    <div className="static-field__preview">
                                      <p>
                                        {t(
                                          "读取可能触发类初始化，并执行任意业务静态初始化代码。",
                                        )}
                                      </p>
                                      <Label>
                                        <Checkbox
                                          checked={staticFieldConfirmed}
                                          onCheckedChange={(event) =>
                                            setStaticFieldConfirmed(
                                              event === true,
                                            )
                                          }
                                        />
                                        <span>
                                          {t(
                                            "我确认读取 {declaringClass}.{fieldName}；此操作可能触发类初始化和业务副作用。",
                                            {
                                              declaringClass:
                                                field.declaringClass,
                                              fieldName: field.name,
                                            },
                                          )}
                                        </span>
                                      </Label>
                                      <Button
                                        type="button"
                                        variant="secondary"
                                        disabled={
                                          Boolean(!staticFieldConfirmed) ||
                                          Boolean(staticFieldAction === "read")
                                        }
                                        onClick={() => void readStaticField()}
                                        aria-busy={Boolean(
                                          staticFieldAction === "read",
                                        )}
                                      >
                                        {Boolean(
                                          staticFieldAction === "read",
                                        ) && <Spinner />}
                                        {t("确认并读取单值")}
                                      </Button>
                                      {staticFieldResult &&
                                        staticFieldResult.values.fieldName ===
                                          field.name && (
                                          <pre>
                                            {staticFieldResult.values.value}
                                          </pre>
                                        )}
                                    </div>
                                  )}
                              </article>
                            ))}
                          </div>
                        ) : (
                          !loadingStaticFields && (
                            <p>{t("当前类没有静态字段。")}</p>
                          )
                        )}
                      </>
                    ) : (
                      <p>
                        {t("当前 Agent 不支持静态字段检查：{reason}", {
                          reason:
                            staticFieldCapability?.reason ?? t("能力不可用"),
                        })}
                      </p>
                    )}
                  </section>
                  <section className="heap-query">
                    <p className="eyebrow">JVMTI HEAP INSTANCES / R2</p>
                    <p>
                      {t(
                        "按精确类扫描存活实例，再用会话弱句柄检查直接引用；字段值有界展示且不会自动写入磁盘。",
                      )}
                    </p>
                    {heapInstanceQueryAvailable ? (
                      <>
                        <Label className="heap-query__limit">
                          <span>{t("实例上限")}</span>
                          <Input
                            value={heapInstanceLimit}
                            onChange={(event) =>
                              setHeapInstanceLimit(Number(event.target.value))
                            }
                            type="number"
                            min="1"
                            max="20"
                          />
                        </Label>
                        <Label className="heap-query__confirmation">
                          <Checkbox
                            checked={heapInstanceConfirmed}
                            onCheckedChange={(event) =>
                              setHeapInstanceConfirmed(event === true)
                            }
                          />
                          <span>
                            {t(
                              "我理解 JVMTI Heap 扫描可能暂停目标，并会在当前页面显示对象字段。",
                            )}
                          </span>
                        </Label>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            Boolean(!heapInstanceConfirmed) ||
                            Boolean(queryingHeapInstances)
                          }
                          onClick={() => void queryHeapInstances()}
                          aria-busy={Boolean(queryingHeapInstances)}
                        >
                          {Boolean(queryingHeapInstances) && <Spinner />}
                          {t("确认并查询实例")}
                        </Button>
                      </>
                    ) : (
                      <p className="heap-query__unavailable">
                        {t("当前目标不支持 Heap 实例查询：{reason}", {
                          reason:
                            heapInstanceCapability?.reason ??
                            t("未提供原生能力"),
                        })}
                      </p>
                    )}
                    {heapInstances.length > 0 ? (
                      <div className="heap-query__results">
                        {heapInstances.map((instance) => (
                          <Disclosure
                            key={instance.identity}
                            trigger={t(
                              "实例 @{identity} · 浅大小 {size} bytes",
                              {
                                identity: instance.identity,
                                size: instance.shallowSize,
                              },
                            )}
                          >
                            <dl>
                              {instance.fields.map((field) => (
                                <div key={field.name}>
                                  <dt>{field.name}</dt>
                                  <dd>{field.value}</dd>
                                </div>
                              ))}
                            </dl>
                            <Button
                              type="button"
                              className="heap-query__inspect"
                              variant="outline"
                              disabled={!instance.navigable}
                              onClick={() => inspectHeapObject(instance)}
                            >
                              {t("检查对象关系")}
                            </Button>
                          </Disclosure>
                        ))}
                      </div>
                    ) : (
                      heapQueryCompleted && (
                        <p className="heap-query__unavailable">
                          {t("当前扫描未找到该精确类型的存活实例。")}
                        </p>
                      )
                    )}
                    {heapInstanceQueryAvailable && (
                      <section
                        className="heap-ranking"
                        aria-labelledby="heap-ranking-title"
                      >
                        <header className="heap-ranking__heading">
                          <div>
                            <p className="eyebrow">
                              WHOLE-HEAP DOMINATORS / R2
                            </p>
                            <h3 id="heap-ranking-title">
                              {t("批量 Retained 排行")}
                            </h3>
                          </div>
                          {heapRetainedRanking && (
                            <StatusPill
                              state={heapRetainedRankingStatusState}
                              label={heapRetainedRankingStatusLabel}
                            />
                          )}
                        </header>
                        <p>
                          {t(
                            "一次强引用图扫描同时计算多个样本对象的支配子树；不会为每个对象重复扫描全堆。",
                          )}
                        </p>
                        <div className="heap-ranking__controls">
                          <Label>
                            <span>{t("样本实例数")}</span>
                            <SelectControl
                              value={heapRetainedRankingInstanceLimit}
                              onValueChange={(value) =>
                                setHeapRetainedRankingInstanceLimit(
                                  Number(value),
                                )
                              }
                            >
                              <SelectControlItem value={3}>3</SelectControlItem>
                              <SelectControlItem value={5}>5</SelectControlItem>
                              <SelectControlItem value={10}>
                                10
                              </SelectControlItem>
                              <SelectControlItem value={20}>
                                20
                              </SelectControlItem>
                            </SelectControl>
                          </Label>
                          <Label>
                            <span>{t("支配图节点预算")}</span>
                            <SelectControl
                              value={heapRetainedRankingMaximumNodes}
                              onValueChange={(value) =>
                                setHeapRetainedRankingMaximumNodes(
                                  Number(value),
                                )
                              }
                            >
                              <SelectControlItem value={100_000}>
                                100,000
                              </SelectControlItem>
                              <SelectControlItem value={250_000}>
                                250,000
                              </SelectControlItem>
                              <SelectControlItem value={500_000}>
                                500,000
                              </SelectControlItem>
                            </SelectControl>
                          </Label>
                          <Label>
                            <span>{t("支配图边预算")}</span>
                            <SelectControl
                              value={heapRetainedRankingMaximumEdges}
                              onValueChange={(value) =>
                                setHeapRetainedRankingMaximumEdges(
                                  Number(value),
                                )
                              }
                            >
                              <SelectControlItem value={250_000}>
                                250,000
                              </SelectControlItem>
                              <SelectControlItem value={1_000_000}>
                                1,000,000
                              </SelectControlItem>
                              <SelectControlItem value={2_000_000}>
                                2,000,000
                              </SelectControlItem>
                            </SelectControl>
                          </Label>
                        </div>
                        <Label className="heap-query__confirmation">
                          <Checkbox
                            checked={heapRetainedRankingConfirmed}
                            onCheckedChange={(event) =>
                              setHeapRetainedRankingConfirmed(event === true)
                            }
                          />
                          <span>
                            {t(
                              "我确认对 {className} 采样最多 {instances} 个实例，并构建最多 {nodes} 个节点、{edges} 条强引用边的全堆支配图。",
                              {
                                className: selected.name,
                                instances: heapRetainedRankingInstanceLimit,
                                nodes:
                                  heapRetainedRankingMaximumNodes.toLocaleString(),
                                edges:
                                  heapRetainedRankingMaximumEdges.toLocaleString(),
                              },
                            )}
                          </span>
                        </Label>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={
                            Boolean(!heapRetainedRankingConfirmed) ||
                            Boolean(queryingHeapRetainedRanking)
                          }
                          onClick={() => void queryHeapRetainedRanking()}
                          aria-busy={Boolean(queryingHeapRetainedRanking)}
                        >
                          {Boolean(queryingHeapRetainedRanking) && <Spinner />}
                          {t("计算样本 Retained 排行")}
                        </Button>
                        {heapRetainedRanking ? (
                          <div className="heap-ranking__result">
                            <div className="heap-ranking__summary">
                              <strong>{heapRetainedRankingSummary}</strong>
                              <span>
                                {t(
                                  "覆盖 {nodes} 个根可达节点 / {bytes} bytes",
                                  {
                                    nodes:
                                      heapRetainedRanking.reachableNodes.toLocaleString(),
                                    bytes:
                                      heapRetainedRanking.reachableBytes.toLocaleString(),
                                  },
                                )}
                              </span>
                            </div>
                            <dl className="heap-ranking__evidence">
                              <div>
                                <dt>{t("节点预算触顶")}</dt>
                                <dd>
                                  {heapRetainedRanking.nodeLimitReached
                                    ? t("是")
                                    : t("否")}
                                </dd>
                              </div>
                              <div>
                                <dt>{t("边预算触顶")}</dt>
                                <dd>
                                  {heapRetainedRanking.edgeLimitReached
                                    ? t("是")
                                    : t("否")}
                                </dd>
                              </div>
                              <div>
                                <dt>{t("标签冲突")}</dt>
                                <dd>
                                  {heapRetainedRanking.tagConflicts.toLocaleString()}
                                </dd>
                              </div>
                              <div>
                                <dt>{t("弱引用语义")}</dt>
                                <dd>
                                  {heapRetainedRanking.weakSemanticsComplete
                                    ? t("完整")
                                    : t("不完整")}
                                </dd>
                              </div>
                            </dl>
                            {!heapRetainedRanking.exact && (
                              <p className="heap-ranking__warning">
                                {t(
                                  "支配图不完整；当前数值只用于候选排序，不会冒充精确 retained size。",
                                )}
                              </p>
                            )}
                            {heapRetainedRanking.entries.length > 0 ? (
                              <div className="heap-ranking__list">
                                {heapRetainedRanking.entries.map((entry) => (
                                  <article
                                    key={`${entry.rank}:${entry.target.handle}`}
                                    className="heap-ranking-card"
                                  >
                                    <div className="heap-ranking-card__heading">
                                      <StatusPill
                                        state={
                                          heapRetainedRanking.exact
                                            ? "ready"
                                            : "working"
                                        }
                                        label={t("排名 #{rank}", {
                                          rank: entry.rank,
                                        })}
                                      />
                                      <code>@{entry.target.identity}</code>
                                    </div>
                                    <strong>{entry.target.type}</strong>
                                    <dl>
                                      <div>
                                        <dt>
                                          {heapRetainedRanking.exact
                                            ? t("精确 Retained")
                                            : t("候选 Retained")}
                                        </dt>
                                        <dd>
                                          {t("{bytes} bytes", {
                                            bytes:
                                              retainedRankingBytes(
                                                entry,
                                              ).toLocaleString(),
                                          })}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>{t("支配对象")}</dt>
                                        <dd>
                                          {t("{count} 个对象", {
                                            count:
                                              entry.candidateObjects.toLocaleString(),
                                          })}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>{t("浅大小")}</dt>
                                        <dd>
                                          {t("{bytes} bytes", {
                                            bytes:
                                              entry.target.shallowSize.toLocaleString(),
                                          })}
                                        </dd>
                                      </div>
                                    </dl>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      disabled={!entry.target.navigable}
                                      onClick={() =>
                                        inspectHeapRetainedRankingEntry(entry)
                                      }
                                    >
                                      {t("检查此对象")}
                                    </Button>
                                  </article>
                                ))}
                              </div>
                            ) : (
                              <p className="heap-query__unavailable">
                                {t("当前精确类型没有可分析的存活实例。")}
                              </p>
                            )}
                          </div>
                        ) : (
                          heapRetainedRankingCompleted && (
                            <p className="heap-query__unavailable">
                              {t("当前精确类型没有可分析的存活实例。")}
                            </p>
                          )
                        )}
                      </section>
                    )}
                    {heapRelationObject && (
                      <section
                        className="heap-relations"
                        aria-labelledby="heap-relation-title"
                      >
                        <header className="heap-relations__heading">
                          <div>
                            <p className="eyebrow">OBJECT RELATIONS / R2</p>
                            <h3 id="heap-relation-title">
                              {t("对象关系检查器")}
                            </h3>
                          </div>
                          {heapRelationHistory.length > 0 && (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={previousHeapObject}
                            >
                              {t("返回上一对象")}
                            </Button>
                          )}
                        </header>
                        <div className="heap-relations__identity">
                          <strong>{heapRelationObject.type}</strong>
                          <code>@{heapRelationObject.identity}</code>
                          <span>
                            {t("浅大小 {size} bytes", {
                              size: heapRelationObject.shallowSize,
                            })}
                          </span>
                        </div>
                        <p className="heap-relations__boundary">
                          {t(
                            "弱句柄不会阻止 GC；新实例扫描会使当前关系导航失效。",
                          )}
                        </p>
                        <Tabs
                          value={heapRelationDirection}
                          onValueChange={(direction) =>
                            setHeapRelationDirectionValue(
                              direction as
                                | "OUTGOING"
                                | "INCOMING"
                                | "GRAPH"
                                | "ROOT"
                                | "RETAINED",
                            )
                          }
                        >
                          <TabsList
                            aria-label={t("引用方向")}
                            className="heap-relations__modes grid h-auto w-full grid-cols-5"
                          >
                            <TabsTrigger value="OUTGOING">
                              {t("出向引用")}
                            </TabsTrigger>
                            <TabsTrigger value="INCOMING">
                              {t("入向引用")}
                            </TabsTrigger>
                            <TabsTrigger value="GRAPH">
                              {t("多层对象图")}
                            </TabsTrigger>
                            <TabsTrigger value="ROOT">
                              {t("GC Root 路径")}
                            </TabsTrigger>
                            <TabsTrigger value="RETAINED">
                              {t("Retained / 支配")}
                            </TabsTrigger>
                          </TabsList>
                        </Tabs>
                        <div className="heap-relations__controls">
                          {(heapRelationDirection === "OUTGOING" ||
                            heapRelationDirection === "INCOMING") && (
                            <Label>
                              <span>{t("关系上限")}</span>
                              <Input
                                value={heapRelationLimit}
                                onChange={(event) =>
                                  setHeapRelationLimit(
                                    Number(event.target.value),
                                  )
                                }
                                type="number"
                                min="1"
                                max="50"
                              />
                            </Label>
                          )}
                          {heapRelationDirection === "GRAPH" && (
                            <Label>
                              <span>{t("图方向")}</span>
                              <SelectControl
                                value={heapGraphDirection}
                                onValueChange={changeHeapGraphDirection}
                              >
                                <SelectControlItem value="OUTGOING">
                                  {t("向下展开出向引用")}
                                </SelectControlItem>
                                <SelectControlItem value="INCOMING">
                                  {t("向上合并保留路径")}
                                </SelectControlItem>
                              </SelectControl>
                            </Label>
                          )}
                          {heapRelationDirection === "GRAPH" && (
                            <Label>
                              <span>{t("最大图深度")}</span>
                              <SelectControl
                                value={heapGraphMaximumDepth}
                                onValueChange={(value) =>
                                  setHeapGraphMaximumDepth(Number(value))
                                }
                              >
                                <SelectControlItem value={2}>
                                  2
                                </SelectControlItem>
                                <SelectControlItem value={3}>
                                  3
                                </SelectControlItem>
                                <SelectControlItem value={4}>
                                  4
                                </SelectControlItem>
                                <SelectControlItem value={5}>
                                  5
                                </SelectControlItem>
                              </SelectControl>
                            </Label>
                          )}
                          {heapRelationDirection === "GRAPH" && (
                            <Label>
                              <span>{t("图节点上限")}</span>
                              <SelectControl
                                value={heapGraphMaximumNodes}
                                onValueChange={(value) =>
                                  setHeapGraphMaximumNodes(Number(value))
                                }
                              >
                                <SelectControlItem value={20}>
                                  20
                                </SelectControlItem>
                                <SelectControlItem value={40}>
                                  40
                                </SelectControlItem>
                                <SelectControlItem value={80}>
                                  80
                                </SelectControlItem>
                              </SelectControl>
                            </Label>
                          )}
                          {heapRelationDirection === "GRAPH" && (
                            <Label>
                              <span>{t("每节点分支上限")}</span>
                              <SelectControl
                                value={heapGraphMaximumEdgesPerNode}
                                onValueChange={(value) =>
                                  setHeapGraphMaximumEdgesPerNode(Number(value))
                                }
                              >
                                <SelectControlItem value={2}>
                                  2
                                </SelectControlItem>
                                <SelectControlItem value={4}>
                                  4
                                </SelectControlItem>
                                <SelectControlItem value={8}>
                                  8
                                </SelectControlItem>
                              </SelectControl>
                            </Label>
                          )}
                          {heapRelationDirection === "ROOT" && (
                            <Label>
                              <span>{t("路径上限")}</span>
                              <SelectControl
                                value={heapRootMaximumPaths}
                                onValueChange={(value) =>
                                  setHeapRootMaximumPaths(Number(value))
                                }
                              >
                                <SelectControlItem value={2}>
                                  2
                                </SelectControlItem>
                                <SelectControlItem value={4}>
                                  4
                                </SelectControlItem>
                                <SelectControlItem value={8}>
                                  8
                                </SelectControlItem>
                              </SelectControl>
                            </Label>
                          )}
                          {heapRelationDirection === "ROOT" && (
                            <Label>
                              <span>{t("最大路径深度")}</span>
                              <Input
                                value={heapRootMaximumDepth}
                                onChange={(event) =>
                                  setHeapRootMaximumDepth(
                                    Number(event.target.value),
                                  )
                                }
                                type="number"
                                min="1"
                                max="32"
                              />
                            </Label>
                          )}
                          {(heapRelationDirection === "ROOT" ||
                            heapRelationDirection === "RETAINED") && (
                            <Label>
                              <span>{t("临时标记对象预算")}</span>
                              <SelectControl
                                value={heapRootMaximumNodes}
                                onValueChange={(value) =>
                                  setHeapRootMaximumNodes(Number(value))
                                }
                              >
                                <SelectControlItem value={10_000}>
                                  10,000
                                </SelectControlItem>
                                <SelectControlItem value={50_000}>
                                  50,000
                                </SelectControlItem>
                                <SelectControlItem value={100_000}>
                                  100,000
                                </SelectControlItem>
                              </SelectControl>
                            </Label>
                          )}
                          {heapRelationDirection !== "OUTGOING" && (
                            <Label>
                              <span>{t("扫描边预算")}</span>
                              <SelectControl
                                value={heapRelationScanLimit}
                                onValueChange={(value) =>
                                  setHeapRelationScanLimit(Number(value))
                                }
                              >
                                <SelectControlItem value={50_000}>
                                  50,000
                                </SelectControlItem>
                                <SelectControlItem value={250_000}>
                                  250,000
                                </SelectControlItem>
                                <SelectControlItem value={1_000_000}>
                                  1,000,000
                                </SelectControlItem>
                              </SelectControl>
                            </Label>
                          )}
                        </div>
                        {heapRelationObject.fields.length > 0 && (
                          <Disclosure
                            className="heap-relations__fields"
                            trigger={t("当前对象字段")}
                          >
                            <dl>
                              {heapRelationObject.fields.map((field) => (
                                <div key={field.name}>
                                  <dt>{field.name}</dt>
                                  <dd>{field.value}</dd>
                                </div>
                              ))}
                            </dl>
                          </Disclosure>
                        )}
                        <Label className="heap-query__confirmation">
                          <Checkbox
                            checked={heapRelationConfirmed}
                            onCheckedChange={(event) =>
                              setHeapRelationConfirmed(event === true)
                            }
                          />
                          <span>{heapAnalysisConfirmation}</span>
                        </Label>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={
                            Boolean(!heapRelationConfirmed) ||
                            Boolean(queryingHeapRelations)
                          }
                          onClick={queryHeapObjectAnalysis}
                          aria-busy={Boolean(queryingHeapRelations)}
                        >
                          {Boolean(queryingHeapRelations) && <Spinner />}
                          {heapAnalysisActionLabel}
                        </Button>
                        {heapRelationCompleted && (
                          <div className="heap-relations__summary">
                            <span>{heapAnalysisSummary}</span>
                            <StatusPill
                              state={heapAnalysisStatusState}
                              label={heapAnalysisStatusLabel}
                            />
                          </div>
                        )}
                        {(heapRelationDirection === "OUTGOING" ||
                          heapRelationDirection === "INCOMING") &&
                          heapRelations.length > 0 && (
                            <div className="heap-relations__list">
                              {heapRelations.map((relation) => (
                                <article
                                  key={`${relation.label}:${relation.target.handle}:${relation.index}`}
                                  className="heap-relation-card"
                                >
                                  <div className="heap-relation-card__heading">
                                    <span>
                                      <strong>{relation.label}</strong>
                                      <small>{relation.kind}</small>
                                    </span>
                                    <code>@{relation.target.identity}</code>
                                  </div>
                                  <p>{relation.target.type}</p>
                                  <span>
                                    {t("浅大小 {size} bytes", {
                                      size: relation.target.shallowSize,
                                    })}
                                  </span>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    disabled={!relation.target.navigable}
                                    onClick={() => followHeapRelation(relation)}
                                  >
                                    {t("沿此对象继续")}
                                  </Button>
                                </article>
                              ))}
                            </div>
                          )}
                        {heapRelationDirection === "GRAPH" &&
                          heapGraphResult && (
                            <div
                              className="heap-object-graph"
                              aria-label={t("多层对象引用图")}
                            >
                              <p className="heap-object-graph__legend">
                                {heapGraphResult.direction === "OUTGOING"
                                  ? t(
                                      "出向图按对象字段逐层展开；重复对象合并为同一节点。",
                                    )
                                  : t(
                                      "入向图合并多条保留路径；重复持有者合并为同一节点。",
                                    )}
                              </p>
                              {heapGraphResult.truncated && (
                                <p className="heap-object-graph__warning">
                                  {t(
                                    "图已在所选预算处停止：节点 {nodes} · 深度 {depth} · 分支 {branches}。",
                                    {
                                      nodes: heapGraphResult.nodeLimitReached
                                        ? t("是")
                                        : t("否"),
                                      depth: heapGraphResult.depthLimitReached
                                        ? t("是")
                                        : t("否"),
                                      branches:
                                        heapGraphResult.branchLimitReached
                                          ? t("是")
                                          : t("否"),
                                    },
                                  )}
                                </p>
                              )}
                              {heapGraphLayers.map((layer) => (
                                <section
                                  key={`graph-layer:${layer.depth}`}
                                  className="heap-object-graph__layer"
                                >
                                  <header className="heap-object-graph__layer-heading">
                                    <strong>
                                      {t("深度 {depth}", {
                                        depth: layer.depth,
                                      })}
                                    </strong>
                                    <small>
                                      {t("{count} 个对象", {
                                        count: layer.nodes.length,
                                      })}
                                    </small>
                                  </header>
                                  <div className="heap-object-graph__nodes">
                                    {layer.nodes.map((node) => (
                                      <article
                                        key={`graph-node:${node.index}:${node.target.handle}`}
                                        className="heap-object-graph__node"
                                      >
                                        <div className="heap-object-graph__node-heading">
                                          <StatusPill
                                            state={
                                              node.index === 0
                                                ? "ready"
                                                : "idle"
                                            }
                                            label={
                                              node.index === 0
                                                ? t("起点对象")
                                                : t("对象 #{index}", {
                                                    index: node.index,
                                                  })
                                            }
                                          />
                                          <code>@{node.target.identity}</code>
                                        </div>
                                        <strong>{node.target.type}</strong>
                                        <span>
                                          {t("浅大小 {size} bytes", {
                                            size: node.target.shallowSize,
                                          })}
                                        </span>
                                        {heapGraphEdgesFor(node.index).length >
                                          0 && (
                                          <ul className="heap-object-graph__edges">
                                            {heapGraphEdgesFor(node.index).map(
                                              (edge) => (
                                                <li
                                                  key={`${edge.source}:${edge.target}:${edge.label}:${edge.index}`}
                                                >
                                                  <span aria-hidden="true">
                                                    →
                                                  </span>
                                                  <span>
                                                    <strong>
                                                      {edge.label}
                                                    </strong>
                                                    <small>{edge.kind}</small>
                                                  </span>
                                                  <code>
                                                    @
                                                    {heapGraphTargetFor(edge)
                                                      ?.target.identity ??
                                                      t("未知对象")}
                                                  </code>
                                                </li>
                                              ),
                                            )}
                                          </ul>
                                        )}
                                        {node.index !== 0 && (
                                          <Button
                                            type="button"
                                            variant="outline"
                                            disabled={!node.target.navigable}
                                            onClick={() =>
                                              followHeapGraphNode(node)
                                            }
                                          >
                                            {t("以此对象为中心")}
                                          </Button>
                                        )}
                                      </article>
                                    ))}
                                  </div>
                                </section>
                              ))}
                            </div>
                          )}
                        {heapRelationDirection === "RETAINED" &&
                          heapRetainedResult && (
                            <div className="heap-retained">
                              <dl className="heap-retained__metrics">
                                <div>
                                  <dt>{t("目标可达闭包")}</dt>
                                  <dd>
                                    {t("{bytes} bytes / {objects} 个对象", {
                                      bytes:
                                        heapRetainedResult.reachableBytes.toLocaleString(),
                                      objects:
                                        heapRetainedResult.reachableObjects.toLocaleString(),
                                    })}
                                  </dd>
                                </div>
                                <div>
                                  <dt>{t("候选支配集")}</dt>
                                  <dd>
                                    {t("{bytes} bytes / {objects} 个对象", {
                                      bytes:
                                        heapRetainedResult.candidateBytes.toLocaleString(),
                                      objects:
                                        heapRetainedResult.candidateObjects.toLocaleString(),
                                    })}
                                  </dd>
                                </div>
                                <div>
                                  <dt>{t("临时标记 / 标签冲突")}</dt>
                                  <dd>
                                    {`${heapRetainedResult.taggedObjects.toLocaleString()} / ${heapRetainedResult.tagConflicts.toLocaleString()}`}
                                  </dd>
                                </div>
                                <div>
                                  <dt>{t("弱引用语义")}</dt>
                                  <dd>
                                    {heapRetainedResult.weakSemanticsComplete
                                      ? t("完整")
                                      : t("不完整")}
                                  </dd>
                                </div>
                              </dl>
                              {!heapRetainedResult.exact && (
                                <p className="heap-retained__warning">
                                  {t(
                                    "扫描达到预算、存在外部标签冲突或弱引用元数据不完整；候选值只用于缩小范围，不会冒充精确 retained size。",
                                  )}
                                </p>
                              )}
                              {heapRetainedResult.contributors.length > 0 && (
                                <div className="heap-relations__list">
                                  {heapRetainedResult.contributors.map(
                                    (contributor) => (
                                      <article
                                        key={`${contributor.rank}:${contributor.target.handle}:${contributor.target.identity}`}
                                        className="heap-relation-card"
                                      >
                                        <div className="heap-relation-card__heading">
                                          <span>
                                            <strong>
                                              {t("浅大小贡献 #{rank}", {
                                                rank: contributor.rank,
                                              })}
                                            </strong>
                                            <small>
                                              {t("{bytes} bytes", {
                                                bytes:
                                                  contributor.shallowBytes.toLocaleString(),
                                              })}
                                            </small>
                                          </span>
                                          <code>
                                            @{contributor.target.identity}
                                          </code>
                                        </div>
                                        <p>{contributor.target.type}</p>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          disabled={
                                            !contributor.target.navigable
                                          }
                                          onClick={() =>
                                            followHeapRetainedContributor(
                                              contributor,
                                            )
                                          }
                                        >
                                          {t("分析此对象")}
                                        </Button>
                                      </article>
                                    ),
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        {heapRelationDirection === "ROOT" &&
                        heapRootPaths.length > 0 ? (
                          <div
                            className="heap-root-paths"
                            aria-label={t("对象到 GC Root 的多条保留路径")}
                          >
                            {heapRootPaths.map((path, pathIndex) => (
                              <section
                                key={`root-path:${pathIndex}`}
                                className="heap-root-path-group"
                              >
                                <header className="heap-root-path-group__heading">
                                  <strong>
                                    {t("路径 {index}", {
                                      index: pathIndex + 1,
                                    })}
                                  </strong>
                                  <StatusPill
                                    state={
                                      path.rootReached ? "ready" : "working"
                                    }
                                    label={
                                      path.rootReached
                                        ? t("已到达 GC Root")
                                        : t("路径在预算处截断")
                                    }
                                  />
                                </header>
                                <ol
                                  className="heap-root-path"
                                  aria-label={t(
                                    "对象到 GC Root 的保留路径 {index}",
                                    { index: pathIndex + 1 },
                                  )}
                                >
                                  {path.nodes.map((node, nodeIndex) => (
                                    <li
                                      key={`${pathIndex}:${node.target.handle}:${nodeIndex}`}
                                    >
                                      <article className="heap-root-node">
                                        <div className="heap-root-node__heading">
                                          <StatusPill
                                            state={node.root ? "ready" : "idle"}
                                            label={
                                              node.root
                                                ? t("GC Root")
                                                : nodeIndex === 0
                                                  ? t("目标对象")
                                                  : t("持有者 {index}", {
                                                      index: nodeIndex,
                                                    })
                                            }
                                          />
                                          <code>@{node.target.identity}</code>
                                        </div>
                                        <strong>{node.target.type}</strong>
                                        <span>
                                          {t("浅大小 {size} bytes", {
                                            size: node.target.shallowSize,
                                          })}
                                        </span>
                                        {nodeIndex > 0 && (
                                          <Button
                                            type="button"
                                            variant="outline"
                                            disabled={!node.target.navigable}
                                            onClick={() =>
                                              followHeapRootNode(node)
                                            }
                                          >
                                            {t("检查此持有者")}
                                          </Button>
                                        )}
                                      </article>
                                      {nodeIndex + 1 < path.nodes.length && (
                                        <div className="heap-root-path__edge">
                                          <span aria-hidden="true">↑</span>
                                          {t("通过 {relation} 持有", {
                                            relation: node.label,
                                          })}
                                        </div>
                                      )}
                                    </li>
                                  ))}
                                </ol>
                              </section>
                            ))}
                          </div>
                        ) : (
                          heapRelationCompleted &&
                          (heapRelationDirection === "OUTGOING" ||
                            heapRelationDirection === "INCOMING") && (
                            <p className="heap-query__unavailable">
                              {t("没有发现符合预算的对象关系。")}
                            </p>
                          )
                        )}
                      </section>
                    )}
                  </section>
                  {classDumpConfirmation && (
                    <div className="class-detail__confirmation">
                      <p>
                        {t(
                          "将对该 ClassLoader 下的精确类执行一次受控重转换并保存运行中字节码。此操作为 R2。",
                        )}
                      </p>
                      <div className="class-detail__actions">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => void dumpSelectedClass()}
                          aria-busy={Boolean(dumpingClass)}
                          disabled={Boolean(dumpingClass)}
                        >
                          {Boolean(dumpingClass) && <Spinner />}
                          {t("确认捕获")}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setClassDumpConfirmation(false)}
                        >
                          {t("取消")}
                        </Button>
                      </div>
                    </div>
                  )}
                  {dumpedArtifact && (
                    <p className="class-detail__artifact">
                      {t("已保存 {name} · SHA-256 {sha256}", {
                        name: dumpedArtifact.name,
                        sha256: dumpedArtifact.sha256,
                      })}
                    </p>
                  )}
                  {decompiledSource && (
                    <Disclosure
                      className="source-view"
                      defaultOpen
                      trigger={t("反编译源码 · CFR 0.152")}
                    >
                      <Textarea
                        value={decompiledSource}
                        onChange={(event) =>
                          setDecompiledSource(event.target.value)
                        }
                        aria-label={t("可编辑类源码")}
                        spellCheck={false}
                      />
                      <section className="redefinition-panel">
                        <p className="eyebrow">IN-MEMORY COMPILE / R3</p>
                        <p>
                          {t(
                            "源码在受限 Host 编译进程中临时编译；预检只允许修改方法体，不允许改变字段、方法签名、父类或接口。",
                          )}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            Boolean(!classRedefinitionAvailable) ||
                            Boolean(redefiningClass)
                          }
                          onClick={() => void compileAndPreviewRedefinition()}
                          aria-busy={Boolean(redefiningClass)}
                        >
                          {Boolean(redefiningClass) && <Spinner />}
                          {t("编译并预检类定义")}
                        </Button>
                        {redefinitionPreview && (
                          <dl>
                            <div>
                              <dt>{t("当前 SHA-256")}</dt>
                              <dd>
                                {redefinitionPreview.values.currentSha256}
                              </dd>
                            </div>
                            <div>
                              <dt>{t("候选 SHA-256")}</dt>
                              <dd>
                                {redefinitionPreview.values.proposedSha256}
                              </dd>
                            </div>
                            <div>
                              <dt>{t("结构兼容")}</dt>
                              <dd>
                                {
                                  redefinitionPreview.values
                                    .structuralCompatible
                                }
                              </dd>
                            </div>
                          </dl>
                        )}
                        {redefinitionPreview && (
                          <>
                            <Label className="redefinition-confirmation">
                              <Checkbox
                                checked={redefinitionConfirmed}
                                onCheckedChange={(event) =>
                                  setRedefinitionConfirmed(event === true)
                                }
                              />
                              <span>
                                {t(
                                  "我已核对精确类、ClassLoader、两个校验值和 R3 影响，并保留本次内存回滚。",
                                )}
                              </span>
                            </Label>
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={
                                Boolean(!redefinitionConfirmed) ||
                                Boolean(redefiningClass)
                              }
                              onClick={() => void applyClassRedefinition()}
                              aria-busy={Boolean(redefiningClass)}
                            >
                              {Boolean(redefiningClass) && <Spinner />}
                              {t("确认替换方法体")}
                            </Button>
                          </>
                        )}
                        {redefinitionResult && (
                          <dl>
                            {Object.entries(redefinitionResult.values).map(
                              ([key, value]) => (
                                <div key={key}>
                                  <dt>{key}</dt>
                                  <dd>{value}</dd>
                                </div>
                              ),
                            )}
                          </dl>
                        )}
                        {rollback && (
                          <>
                            <Label className="redefinition-confirmation">
                              <Checkbox
                                checked={restoreConfirmed}
                                onCheckedChange={(event) =>
                                  setRestoreConfirmed(event === true)
                                }
                              />
                              <span>
                                {t(
                                  "我确认仅在当前校验值仍匹配时恢复本次替换前的类定义。",
                                )}
                              </span>
                            </Label>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={
                                Boolean(!restoreConfirmed) ||
                                Boolean(redefiningClass)
                              }
                              onClick={() => void restoreClassDefinition()}
                              aria-busy={Boolean(redefiningClass)}
                            >
                              {Boolean(redefiningClass) && <Spinner />}
                              {t("恢复替换前定义")}
                            </Button>
                          </>
                        )}
                      </section>
                      <section
                        className="class-change-set"
                        aria-labelledby="class-change-set-title"
                      >
                        <header>
                          <div>
                            <p className="eyebrow">
                              ATOMIC CLASS CHANGE SET / R3
                            </p>
                            <h3 id="class-change-set-title">
                              {t("把关联类作为一个变更集提交。")}
                            </h3>
                            <p>
                              {t(
                                "同一精确 ClassLoader 下选择 2—8 个类；Host 联合编译，Agent 绑定全部校验值并用一次 JVM 重定义整体提交或整体回滚。",
                              )}
                            </p>
                          </div>
                          <StatusPill
                            state={
                              classChangeSetRollback
                                ? "working"
                                : classChangeSetPreview
                                  ? "ready"
                                  : "idle"
                            }
                            label={
                              classChangeSetDraftsLoading
                                ? t("正在恢复本地草稿")
                                : classChangeSetRollback
                                  ? t("已提交，保留整体回滚")
                                  : t("{count}/8 个类", {
                                      count: classChangeSetDrafts.length,
                                    })
                            }
                          />
                        </header>

                        <div className="class-change-set__actions">
                          <Button
                            type="button"
                            variant="outline"
                            disabled={
                              !classRedefinitionAvailable ||
                              !!classChangeSetRollback ||
                              classChangeSetDraftsLoading
                            }
                            onClick={saveCurrentSourceToChangeSet}
                          >
                            {currentClassChangeSetDraft
                              ? t("更新当前类源码")
                              : t("加入当前类")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={
                              classChangeSetDrafts.length === 0 ||
                              !!classChangeSetRollback ||
                              classChangeSetDraftsLoading
                            }
                            onClick={clearClassChangeSetDrafts}
                          >
                            {t("清空变更集")}
                          </Button>
                        </div>

                        {classChangeSetMessage && (
                          <p
                            className="class-change-set__message"
                            role="status"
                          >
                            {t(classChangeSetMessage)}
                          </p>
                        )}

                        {classChangeSetDrafts.length > 0 ? (
                          <ol className="class-change-set__list">
                            {classChangeSetDrafts.map((draft, index) => (
                              <li
                                key={`${draft.className}:${draft.classLoader}`}
                              >
                                <span className="class-change-set__index">
                                  {String(index + 1).padStart(2, "0")}
                                </span>
                                <div>
                                  <strong>{draft.className}</strong>
                                  <code>{draft.classLoader}</code>
                                </div>
                                <div className="class-change-set__row-actions">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() =>
                                      void openClassChangeSetDraft(draft)
                                    }
                                  >
                                    {t("打开源码")}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    disabled={!!classChangeSetRollback}
                                    onClick={() =>
                                      removeClassChangeSetDraft(index)
                                    }
                                  >
                                    {t("移除")}
                                  </Button>
                                </div>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <div className="class-change-set__empty">
                            <strong>{t("变更集还是空的。")}</strong>
                            <span>
                              {t(
                                "编辑当前反编译源码后加入；再搜索、捕获并加入同一 ClassLoader 下的其他类。",
                              )}
                            </span>
                          </div>
                        )}

                        <dl className="class-change-set__bounds">
                          <div>
                            <dt>{t("源码预算")}</dt>
                            <dd>
                              {t("{used} / {maximum}", {
                                used: classChangeSetSourceBytes.toLocaleString(),
                                maximum: (2 * 1024 * 1024).toLocaleString(),
                              })}
                            </dd>
                          </div>
                          <div>
                            <dt>{t("提交语义")}</dt>
                            <dd>{t("一次调用 · 全部成功或不提交")}</dd>
                          </div>
                          <div>
                            <dt>{t("草稿范围")}</dt>
                            <dd>
                              {classChangeSetDraftsLoading
                                ? t("正在恢复本地草稿")
                                : classChangeSetDraftPersistence === "saving"
                                  ? t("正在保存本地草稿")
                                  : classChangeSetDraftPersistence === "saved"
                                    ? t("已保存 · 当前目标 JVM 启动周期")
                                    : classChangeSetDraftPersistence === "error"
                                      ? t("本地草稿保存失败")
                                      : t("此设备 · 当前目标 JVM 启动周期")}
                            </dd>
                          </div>
                        </dl>

                        <Button
                          type="button"
                          variant="secondary"
                          disabled={
                            Boolean(
                              classChangeSetDrafts.length < 2 ||
                              !!classChangeSetRollback,
                            ) || Boolean(classChangeSetBusy)
                          }
                          onClick={() => void compileAndPreviewClassChangeSet()}
                          aria-busy={Boolean(classChangeSetBusy)}
                        >
                          {Boolean(classChangeSetBusy) && <Spinner />}
                          {t("联合编译并预检")}
                        </Button>

                        {classChangeSetPreview && (
                          <>
                            <div className="class-change-set__fingerprint">
                              <span>{t("变更集预检指纹")}</span>
                              <code>{classChangeSetPreview.fingerprint}</code>
                            </div>
                            <div className="class-change-set__evidence">
                              {classChangeSetPreview.items.map((item) => (
                                <article key={item.className}>
                                  <strong>{item.className}</strong>
                                  <span>
                                    {t("{before} → {after} bytes", {
                                      before: item.previousSize,
                                      after: item.currentSize,
                                    })}
                                  </span>
                                  <code>{item.previousSha256}</code>
                                  <code>{item.currentSha256}</code>
                                </article>
                              ))}
                            </div>
                            <Label className="redefinition-confirmation">
                              <Checkbox
                                checked={classChangeSetConfirmed}
                                onCheckedChange={(event) =>
                                  setClassChangeSetConfirmed(event === true)
                                }
                              />
                              <span>
                                {t(
                                  "我已核对全部精确类、ClassLoader、预检指纹和 R3 影响，并保留整体内存回滚。",
                                )}
                              </span>
                            </Label>
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={
                                Boolean(
                                  !classChangeSetConfirmed ||
                                  !!classChangeSetRollback,
                                ) || Boolean(classChangeSetBusy)
                              }
                              onClick={() => void applyClassChangeSet()}
                              aria-busy={Boolean(classChangeSetBusy)}
                            >
                              {Boolean(classChangeSetBusy) && <Spinner />}
                              {t("整体提交变更集")}
                            </Button>
                          </>
                        )}

                        {classChangeSetResult.length > 0 && (
                          <div className="class-change-set__result">
                            {classChangeSetResult.map((item) => (
                              <article key={item.className}>
                                <span>{item.className}</span>
                                <code>
                                  {item.previousSha256} → {item.currentSha256}
                                </code>
                              </article>
                            ))}
                          </div>
                        )}

                        {classChangeSetRollback && (
                          <>
                            <Label className="redefinition-confirmation">
                              <Checkbox
                                checked={classChangeSetRestoreConfirmed}
                                onCheckedChange={(event) =>
                                  setClassChangeSetRestoreConfirmed(
                                    event === true,
                                  )
                                }
                              />
                              <span>
                                {t(
                                  "我确认仅在全部当前校验值仍匹配时，通过一次 JVM 重定义整体恢复这组类。",
                                )}
                              </span>
                            </Label>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={
                                Boolean(!classChangeSetRestoreConfirmed) ||
                                Boolean(classChangeSetBusy)
                              }
                              onClick={() => void restoreClassChangeSet()}
                              aria-busy={Boolean(classChangeSetBusy)}
                            >
                              {Boolean(classChangeSetBusy) && <Spinner />}
                              {t("整体回滚变更集")}
                            </Button>
                          </>
                        )}
                      </section>
                    </Disclosure>
                  )}
                  {details && (
                    <>
                      <p className="eyebrow">INTERFACES / ANNOTATIONS</p>
                      <p className="class-detail__boundary">
                        {t("接口：{interfaces}", {
                          interfaces: details.interfaces.join(", ") || t("无"),
                        })}
                        <br />
                        {t("注解：{annotations}", {
                          annotations:
                            details.annotations.join(", ") || t("无"),
                        })}
                      </p>
                      <p className="eyebrow">
                        METHODS / {details.methods.length}
                      </p>
                      <ul className="method-list">
                        {visibleMethods.map((method, index) => (
                          <li key={`${method.name}:${index}`}>
                            <span className="method-list__signature">
                              <span>
                                {method.modifiers} {method.returnType}
                              </span>
                              <strong>{method.name}</strong>
                              <span>({method.parameterTypes.join(", ")})</span>
                              {method.exceptionTypes.length > 0 && (
                                <small>
                                  throws {method.exceptionTypes.join(", ")}
                                </small>
                              )}
                            </span>
                            <span className="method-list__actions">
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => probeMethodLine(method)}
                              >
                                {t("行探针")}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => traceMethod(method)}
                              >
                                Trace
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => monitorMethod(method)}
                              >
                                {t("监控")}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => observeMethod(method)}
                              >
                                {t("观测")}
                              </Button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <>
                  <p className="eyebrow">NO SELECTION</p>
                  <p className="class-detail__title">
                    {t("选择一个类查看加载器身份。")}
                  </p>
                </>
              )}
            </aside>
          </div>

          <StatePagination
            className="pagination"
            ariaLabel={t("类分页")}
            previousLabel={t("上一页")}
            nextLabel={t("下一页")}
            previousDisabled={offset === 0 || loading}
            nextDisabled={offset + PAGE_SIZE >= total || loading}
            onPrevious={() => void load(Math.max(0, offset - PAGE_SIZE))}
            onNext={() => void load(offset + PAGE_SIZE)}
          />
        </>
      )}
    </section>
  );
}
