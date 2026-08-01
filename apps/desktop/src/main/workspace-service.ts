import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { shell } from "electron";
import type {
  ActionAuditPage,
  ActionAuditQuery,
  ActionResult,
  ArtifactDescriptor,
  ActionAuditDescriptor,
  AppSettings,
  CaseEvidence,
  CaseExportPreview,
  CompareHeapHistogramArtifactsInput,
  CompareJitTrendArtifactsInput,
  CompareThreadDumpArtifactsInput,
  CompareThreadPoolTrendArtifactsInput,
  CompiledClass,
  CompiledClassChangeSet,
  CompileClassChangeSetItem,
  CompileClassChangeSetInput,
  CompileClassSourceInput,
  CollectAgentArtifactInput,
  CreateHeapHistogramArtifactInput,
  CreateJitTrendArtifactInput,
  CreateThreadPoolTrendArtifactInput,
  CreateTraceHotspotArtifactInput,
  CreateMonitorWindowsArtifactInput,
  CreateDiagnosticTemplateInput,
  CreateCaseInput,
  DiagnosticAlertDescriptor,
  DiagnosticTemplate,
  DiagnosticCase,
  DecompiledSource,
  ImportPreview,
  JfrInspectionReport,
  JitRegressionBaselineIndex,
  JitTrendComparison,
  JitTrendInspectionReport,
  HeapHistogramComparison,
  HeapHistogramInspectionReport,
  MultiTargetComparison,
  ObservationExportInspectionReport,
  ObservationMethodIdentity,
  OperationResult,
  PersistedInvocationSnapshot,
  PersistedInvocationSnapshotPage,
  PersistedInvocationSnapshotQuery,
  PluginDescriptor,
  RuntimeInfo,
  SaveInvocationSnapshotInput,
  TeamPolicyDescriptor,
  ThreadDumpComparison,
  ThreadDumpInspectionReport,
  ThreadPoolTrendComparison,
  ThreadPoolTrendInspectionReport,
  ThreadPoolAliasDescriptor,
  ThreadPoolAliasInput,
  DeleteThreadPoolAliasInput,
  UpdateCaseEvidenceInput,
} from "../shared/contracts.js";
import { GovernanceService } from "./governance-service.js";
import { LocalStore } from "./local-store.js";
import { isPathInsideRoot } from "./profile-report-policy.js";
import { TargetService } from "./target-service.js";
import {
  resolveJavaExecutable,
  resolveJavacExecutable,
  resolveJfrExecutable,
  resolveJvmComponent,
} from "./component-resolver.js";
import { parseJfrReportJson } from "./jfr-report.js";
import { compareThreadDumpReports } from "./thread-dump-comparison.js";
import { parseThreadDumpReport } from "./thread-dump-report.js";
import {
  compareHeapHistogramReports,
  MAXIMUM_HEAP_HISTOGRAM_ARTIFACT_BYTES,
  parseHeapHistogramArtifact,
  serializeHeapHistogramArtifact,
} from "./heap-histogram-artifact.js";
import {
  compareThreadPoolTrendReports,
  MAXIMUM_THREAD_POOL_TREND_ARTIFACT_BYTES,
  parseThreadPoolTrendArtifact,
  serializeThreadPoolTrendArtifact,
} from "./thread-pool-trend-artifact.js";
import {
  compareJitTrendReports,
  MAXIMUM_JIT_TREND_ARTIFACT_BYTES,
  parseJitTrendArtifact,
  serializeJitTrendArtifact,
  summarizeJitTrend,
} from "./jit-trend-artifact.js";
import { createJitDiagnosticAlert } from "./diagnostic-alert.js";
import {
  MAXIMUM_OBSERVATION_EXPORT_ARTIFACT_BYTES,
  parseObservationExportArtifact,
  serializeMonitorWindowsArtifact,
  serializeTraceHotspotArtifact,
} from "./observation-export-artifact.js";

const MINIMUM_FREE_SPACE_BYTES = 100 * 1024 * 1024;
const DECOMPILER_TIMEOUT_MILLIS = 30_000;
const MAXIMUM_DECOMPILED_SOURCE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_CLASS_SOURCE_BYTES = 1024 * 1024;
const MAXIMUM_COMPILED_CLASS_BYTES = 2 * 1024 * 1024;
const MAXIMUM_CLASS_CHANGE_SET_SOURCE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_CLASS_CHANGE_SET_BYTECODE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_PROFILE_REPORT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_JFR_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAXIMUM_JFR_JSON_BYTES = 32 * 1024 * 1024;
const MAXIMUM_THREAD_DUMP_BYTES = 32 * 1024 * 1024;
const JFR_INSPECTION_TIMEOUT_MILLIS = 30_000;
const JFR_INSPECTION_EVENTS = [
  "jdk.CPULoad",
  "jdk.GarbageCollection",
  "jdk.GCPhasePause",
  "jdk.ExecutionSample",
  "jdk.NativeMethodSample",
  "jdk.ObjectAllocationSample",
  "jdk.Compilation",
  "jdk.Deoptimization",
  "jdk.JavaMonitorEnter",
  "jdk.ThreadPark",
  "jdk.ExceptionThrown",
  "jdk.FileRead",
  "jdk.FileWrite",
  "jdk.SocketRead",
  "jdk.SocketWrite",
].join(",");
const execFileAsync = promisify(execFile);

export interface ResolvedProfileReport {
  readonly absolutePath: string;
  readonly name: string;
}

function success<T>(value: T): OperationResult<T> {
  return {
    ok: true,
    value,
    errorCode: null,
    errorMessage: null,
  };
}

function failure<T>(
  errorCode: string,
  errorMessage: string,
): OperationResult<T> {
  return {
    ok: false,
    value: null,
    errorCode,
    errorMessage,
  };
}

function isValidJvmStartTime(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function parsePersistedInvocationSnapshot(
  values: Readonly<Record<string, string>>,
  input: SaveInvocationSnapshotInput,
  jvmStartTimeEpochMillis: number,
  targetCapturedAtEpochMillis: number,
): PersistedInvocationSnapshot {
  const sourceSnapshotId = boundedSnapshotInteger(
    values.snapshotId,
    1,
    1_000_000_000,
    "snapshotId",
  );
  if (sourceSnapshotId !== input.snapshotId) {
    throw new Error("Agent 返回的调用快照身份不匹配");
  }
  if (
    !isValidJvmStartTime(jvmStartTimeEpochMillis) ||
    !Number.isSafeInteger(targetCapturedAtEpochMillis) ||
    targetCapturedAtEpochMillis < jvmStartTimeEpochMillis
  ) {
    throw new Error("目标 JVM 启动身份无效");
  }
  const capturedAtEpochMillis = boundedSnapshotInteger(
    values.capturedAtEpochMillis,
    jvmStartTimeEpochMillis,
    targetCapturedAtEpochMillis + 5_000,
    "capturedAtEpochMillis",
  );
  const outcome = values.outcome;
  if (outcome !== "RETURNED" && outcome !== "THREW") {
    throw new Error("Agent 返回的调用快照结果类型无效");
  }
  const argumentCount = boundedSnapshotInteger(
    values["argument.count"],
    0,
    16,
    "argument.count",
  );
  const stackCount = boundedSnapshotInteger(
    values["stack.count"],
    0,
    12,
    "stack.count",
  );
  const argumentsList = Array.from({ length: argumentCount }, (_, index) =>
    redactedSnapshotText(
      values[`argument.${String(index).padStart(2, "0")}`],
      512,
      `argument.${index}`,
    ),
  );
  const callStack = Array.from({ length: stackCount }, (_, index) =>
    redactedSnapshotText(
      values[`stack.${String(index).padStart(2, "0")}`],
      512,
      `stack.${index}`,
    ),
  );
  const strings = {
    taskId: boundedSnapshotText(values.taskId, 1, 4_096, "taskId"),
    className: boundedSnapshotText(values.className, 1, 4_096, "className"),
    classLoader: redactedSnapshotText(values.classLoader, 4_096, "classLoader"),
    rootMethodName: boundedSnapshotText(
      values.rootMethodName,
      0,
      512,
      "rootMethodName",
    ),
    parameterTypes: boundedSnapshotText(
      values.parameterTypes,
      0,
      4_096,
      "parameterTypes",
    ),
    modifiers: boundedSnapshotText(values.modifiers, 0, 512, "modifiers"),
    method: boundedSnapshotText(values.method, 1, 4_096, "method"),
    threadName: redactedSnapshotText(values.threadName, 512, "threadName"),
    returnValue: redactedSnapshotText(values.returnValue, 512, "returnValue"),
    exceptionType: boundedSnapshotText(
      values.exceptionType,
      0,
      512,
      "exceptionType",
    ),
    exceptionMessage: redactedSnapshotText(
      values.exceptionMessage,
      512,
      "exceptionMessage",
    ),
  };
  const totalCharacters = [
    input.targetId,
    ...Object.values(strings),
    ...argumentsList,
    ...callStack,
  ].reduce((total, value) => total + value.length, 0);
  const estimatedBytes = 512 + totalCharacters * 2;
  if (estimatedBytes > 128 * 1024) {
    throw new Error("调用快照超过桌面持久化单项上限");
  }
  return {
    id: randomUUID(),
    targetId: input.targetId,
    jvmStartTimeEpochMillis,
    sourceSnapshotId,
    ...strings,
    sequence: boundedSnapshotInteger(
      values.sequence,
      0,
      Number.MAX_SAFE_INTEGER,
      "sequence",
    ),
    parentSequence: boundedSnapshotInteger(
      values.parentSequence,
      -1,
      Number.MAX_SAFE_INTEGER,
      "parentSequence",
    ),
    depth: boundedSnapshotInteger(values.depth, 0, 1_024, "depth"),
    capturedAtEpochMillis,
    durationNanos: boundedSnapshotInteger(
      values.durationNanos,
      0,
      Number.MAX_SAFE_INTEGER,
      "durationNanos",
    ),
    outcome,
    arguments: argumentsList,
    callStack,
    replayEligible: values.replayEligible === "true",
    estimatedBytes,
    savedAt: new Date().toISOString(),
  };
}

function boundedSnapshotInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`Agent 返回的调用快照字段 ${field} 无效`);
  }
  return parsed;
}

function boundedSnapshotText(
  value: string | undefined,
  minimumLength: number,
  maximumLength: number,
  field: string,
): string {
  const normalized = value ?? "";
  if (
    normalized.length < minimumLength ||
    normalized.length > maximumLength
  ) {
    throw new Error(`Agent 返回的调用快照字段 ${field} 超出边界`);
  }
  return normalized;
}

function redactedSnapshotText(
  value: string | undefined,
  maximumLength: number,
  field: string,
): string {
  return redactSensitiveText(
    boundedSnapshotText(value, 0, maximumLength, field),
  ).value.slice(0, maximumLength);
}

async function resolveCompilerClassPath(
  targetId: string,
  codeSource: string | null,
): Promise<OperationResult<string | null>> {
  if (!targetId.startsWith("local:") || !codeSource) {
    return success(null);
  }
  try {
    const sourceUrl = new URL(codeSource);
    if (sourceUrl.protocol !== "file:") {
      return success(null);
    }
    const sourcePath = fileURLToPath(sourceUrl);
    if (sourcePath.length > 32_768) {
      return failure(
        "CLASS_COMPILE_CLASSPATH_INVALID",
        "目标类 Code Source 路径超过安全上限",
      );
    }
    const canonicalPath = await realpath(sourcePath);
    const sourceStat = await stat(canonicalPath);
    if (
      !sourceStat.isDirectory() &&
      !(sourceStat.isFile() && /\.(?:jar|zip)$/iu.test(canonicalPath))
    ) {
      return failure(
        "CLASS_COMPILE_CLASSPATH_INVALID",
        "目标类 Code Source 不是可读目录、JAR 或 ZIP",
      );
    }
    return success(canonicalPath);
  } catch (error) {
    return failure(
      "CLASS_COMPILE_CLASSPATH_UNAVAILABLE",
      error instanceof Error
        ? `无法读取目标类 Code Source：${error.message}`
        : "无法读取目标类 Code Source",
    );
  }
}

export class WorkspaceService {
  readonly #store: LocalStore;
  readonly #targetService: TargetService;
  readonly #artifactRoot: string;
  readonly #productVersion: string;
  readonly #governance: GovernanceService;

  private constructor(
    store: LocalStore,
    targetService: TargetService,
    artifactRoot: string,
    productVersion: string,
    governance: GovernanceService,
  ) {
    this.#store = store;
    this.#targetService = targetService;
    this.#artifactRoot = artifactRoot;
    this.#productVersion = productVersion;
    this.#governance = governance;
  }

  static async open(
    userDataRoot: string,
    targetService: TargetService,
    productVersion = "0.0.0",
  ): Promise<WorkspaceService> {
    const store = await LocalStore.open(
      path.join(userDataRoot, "tanwei.sqlite"),
    );
    const governance = await GovernanceService.open(
      userDataRoot,
      store,
      targetService,
    );
    const service = new WorkspaceService(
      store,
      targetService,
      path.join(userDataRoot, "artifacts"),
      productVersion,
      governance,
    );
    try {
      await mkdir(service.#artifactRoot, { recursive: true });
      await service.#cleanInterruptedArtifacts();
      await service.#cleanExpiredArtifacts();
      targetService.setLocalStore(store);
      return service;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  close(): void {
    this.#targetService.setLocalStore(null);
    this.#store.close();
  }

  listCases(): OperationResult<readonly DiagnosticCase[]> {
    try {
      return success(this.#store.listCases());
    } catch (error) {
      return failure(
        "CASE_LIST_FAILED",
        error instanceof Error ? error.message : "无法读取诊断案例",
      );
    }
  }

  listActionAudits(): OperationResult<readonly ActionAuditDescriptor[]> {
    try {
      return success(this.#store.listActionAudits());
    } catch (error) {
      return failure(
        "ACTION_AUDIT_LIST_FAILED",
        error instanceof Error ? error.message : "无法读取 Action 审计摘要",
      );
    }
  }

  queryActionAudits(
    query: ActionAuditQuery,
  ): OperationResult<ActionAuditPage> {
    try {
      return success(this.#store.queryActionAudits(query));
    } catch (error) {
      return failure(
        "ACTION_AUDIT_QUERY_FAILED",
        error instanceof Error ? error.message : "无法检索 Action 审计记录",
      );
    }
  }

  async saveInvocationSnapshot(
    input: SaveInvocationSnapshotInput,
  ): Promise<OperationResult<PersistedInvocationSnapshot>> {
    try {
      const [detailsResult, targetSnapshotResult] = await Promise.all([
        this.#targetService.executeAction({
          targetId: input.targetId,
          actionId: "snapshot.describe",
          parameters: { snapshotId: String(input.snapshotId) },
        }),
        this.#targetService.getSnapshot(input.targetId),
      ]);
      if (
        !detailsResult.ok ||
        !detailsResult.value ||
        detailsResult.value.status !== "SUCCEEDED"
      ) {
        return failure(
          detailsResult.errorCode ??
            detailsResult.value?.errorCode ??
            "INVOCATION_SNAPSHOT_SOURCE_UNAVAILABLE",
          detailsResult.errorMessage ??
            detailsResult.value?.message ??
            "无法读取待保存的调用快照",
        );
      }
      if (!targetSnapshotResult.ok || !targetSnapshotResult.value) {
        return failure(
          targetSnapshotResult.errorCode ?? "INVOCATION_SNAPSHOT_TARGET_UNAVAILABLE",
          targetSnapshotResult.errorMessage ?? "无法核对调用快照所属 JVM",
        );
      }
      const snapshot = parsePersistedInvocationSnapshot(
        detailsResult.value.values,
        input,
        targetSnapshotResult.value.jvmStartTimeEpochMillis,
        Date.parse(targetSnapshotResult.value.capturedAt),
      );
      return success(this.#store.upsertPersistedInvocationSnapshot(snapshot));
    } catch (error) {
      return failure(
        "INVOCATION_SNAPSHOT_SAVE_FAILED",
        error instanceof Error ? error.message : "无法保存调用快照",
      );
    }
  }

  queryPersistedInvocationSnapshots(
    query: PersistedInvocationSnapshotQuery,
  ): OperationResult<PersistedInvocationSnapshotPage> {
    try {
      return success(this.#store.queryPersistedInvocationSnapshots(query));
    } catch (error) {
      return failure(
        "INVOCATION_SNAPSHOT_QUERY_FAILED",
        error instanceof Error ? error.message : "无法检索桌面调用档案",
      );
    }
  }

  getPersistedInvocationSnapshot(
    snapshotId: string,
  ): OperationResult<PersistedInvocationSnapshot> {
    try {
      const snapshot = this.#store.getPersistedInvocationSnapshot(snapshotId);
      return snapshot
        ? success(snapshot)
        : failure("INVOCATION_SNAPSHOT_NOT_FOUND", "桌面调用档案不存在");
    } catch (error) {
      return failure(
        "INVOCATION_SNAPSHOT_READ_FAILED",
        error instanceof Error ? error.message : "无法读取桌面调用档案",
      );
    }
  }

  deletePersistedInvocationSnapshot(
    snapshotId: string,
    confirmed: boolean,
  ): OperationResult<null> {
    if (!confirmed) {
      return failure(
        "INVOCATION_SNAPSHOT_DELETE_CONFIRMATION_REQUIRED",
        "删除桌面调用档案需要明确确认",
      );
    }
    try {
      return this.#store.deletePersistedInvocationSnapshot(snapshotId)
        ? success(null)
        : failure("INVOCATION_SNAPSHOT_NOT_FOUND", "桌面调用档案不存在");
    } catch (error) {
      return failure(
        "INVOCATION_SNAPSHOT_DELETE_FAILED",
        error instanceof Error ? error.message : "无法删除桌面调用档案",
      );
    }
  }

  getSettings(): OperationResult<AppSettings> {
    try {
      return success(this.#store.getSettings());
    } catch (error) {
      return failure(
        "SETTINGS_READ_FAILED",
        error instanceof Error ? error.message : "无法读取设置",
      );
    }
  }

  updateSettings(settings: AppSettings): OperationResult<AppSettings> {
    try {
      return success(this.#store.updateSettings(settings));
    } catch (error) {
      return failure(
        "SETTINGS_UPDATE_FAILED",
        error instanceof Error ? error.message : "无法保存设置",
      );
    }
  }

  listThreadPoolAliases(
    targetId: string,
    jvmStartTimeEpochMillis: number,
  ): OperationResult<readonly ThreadPoolAliasDescriptor[]> {
    if (!isValidJvmStartTime(jvmStartTimeEpochMillis)) {
      return failure(
        "JVM_IDENTITY_INVALID",
        "JVM 启动时间无效，已拒绝读取线程池别名",
      );
    }
    try {
      return success(
        this.#store.listThreadPoolAliases(targetId, jvmStartTimeEpochMillis),
      );
    } catch (error) {
      return failure(
        "THREAD_POOL_ALIAS_LIST_FAILED",
        error instanceof Error ? error.message : "无法读取线程池别名",
      );
    }
  }

  upsertThreadPoolAlias(
    input: ThreadPoolAliasInput,
    jvmStartTimeEpochMillis: number,
  ): OperationResult<ThreadPoolAliasDescriptor> {
    if (!isValidJvmStartTime(jvmStartTimeEpochMillis)) {
      return failure(
        "JVM_IDENTITY_INVALID",
        "JVM 启动时间无效，已拒绝保存线程池别名",
      );
    }
    try {
      return success(
        this.#store.upsertThreadPoolAlias({
          ...input,
          jvmStartTimeEpochMillis,
          updatedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      return failure(
        "THREAD_POOL_ALIAS_SAVE_FAILED",
        error instanceof Error ? error.message : "无法保存线程池别名",
      );
    }
  }

  deleteThreadPoolAlias(
    input: DeleteThreadPoolAliasInput,
    jvmStartTimeEpochMillis: number,
  ): OperationResult<null> {
    if (!isValidJvmStartTime(jvmStartTimeEpochMillis)) {
      return failure(
        "JVM_IDENTITY_INVALID",
        "JVM 启动时间无效，已拒绝删除线程池别名",
      );
    }
    try {
      this.#store.deleteThreadPoolAlias(
        input.targetId,
        jvmStartTimeEpochMillis,
        input.poolIdentity,
      );
      return success(null);
    } catch (error) {
      return failure(
        "THREAD_POOL_ALIAS_DELETE_FAILED",
        error instanceof Error ? error.message : "无法删除线程池别名",
      );
    }
  }

  listClassChangeSetDrafts(
    targetId: string,
    jvmStartTimeEpochMillis: number,
  ): OperationResult<readonly CompileClassChangeSetItem[]> {
    if (!isValidJvmStartTime(jvmStartTimeEpochMillis)) {
      return failure(
        "JVM_IDENTITY_INVALID",
        "JVM 启动时间无效，已拒绝读取类变更集草稿",
      );
    }
    try {
      this.#store.deleteStaleClassChangeSetDrafts(
        targetId,
        jvmStartTimeEpochMillis,
      );
      return success(
        this.#store.listClassChangeSetDrafts(targetId, jvmStartTimeEpochMillis),
      );
    } catch (error) {
      return failure(
        "CLASS_CHANGE_SET_DRAFT_LIST_FAILED",
        error instanceof Error ? error.message : "无法读取类变更集草稿",
      );
    }
  }

  replaceClassChangeSetDrafts(
    targetId: string,
    items: readonly CompileClassChangeSetItem[],
    jvmStartTimeEpochMillis: number,
  ): OperationResult<readonly CompileClassChangeSetItem[]> {
    if (!isValidJvmStartTime(jvmStartTimeEpochMillis)) {
      return failure(
        "JVM_IDENTITY_INVALID",
        "JVM 启动时间无效，已拒绝保存类变更集草稿",
      );
    }
    if (items.length > 8) {
      return failure(
        "CLASS_CHANGE_SET_DRAFT_SIZE_INVALID",
        "类变更集草稿最多包含 8 个精确类",
      );
    }
    const classLoader = items[0]?.classLoader;
    const identities = new Set<string>();
    let totalSourceBytes = 0;
    for (const item of items) {
      const sourceBytes = Buffer.byteLength(item.source, "utf8");
      totalSourceBytes += sourceBytes;
      if (
        !item.className ||
        item.className.length > 1_024 ||
        !item.classLoader ||
        item.classLoader.length > 4_096 ||
        sourceBytes === 0 ||
        sourceBytes > MAXIMUM_CLASS_SOURCE_BYTES ||
        totalSourceBytes > MAXIMUM_CLASS_CHANGE_SET_SOURCE_BYTES
      ) {
        return failure(
          "CLASS_CHANGE_SET_DRAFT_INVALID",
          "类身份无效，或草稿超过单类 1 MiB、合计 2 MiB 的边界",
        );
      }
      if (item.classLoader !== classLoader) {
        return failure(
          "CLASS_CHANGE_SET_DRAFT_LOADER_MISMATCH",
          "类变更集草稿必须来自同一个精确 ClassLoader",
        );
      }
      const identity = `${item.className}\0${item.classLoader}`;
      if (identities.has(identity)) {
        return failure(
          "CLASS_CHANGE_SET_DRAFT_DUPLICATE",
          "类变更集草稿不能包含重复类",
        );
      }
      identities.add(identity);
    }
    try {
      return success(
        this.#store.replaceClassChangeSetDrafts(
          targetId,
          jvmStartTimeEpochMillis,
          items,
          new Date().toISOString(),
        ),
      );
    } catch (error) {
      return failure(
        "CLASS_CHANGE_SET_DRAFT_SAVE_FAILED",
        error instanceof Error ? error.message : "无法保存类变更集草稿",
      );
    }
  }

  compareTargets(
    targetIds: readonly string[],
  ): Promise<OperationResult<MultiTargetComparison>> {
    return this.#governance.compareTargets(targetIds);
  }

  listDiagnosticTemplates(): Promise<
    OperationResult<readonly DiagnosticTemplate[]>
  > {
    return this.#governance.listDiagnosticTemplates();
  }

  createSignedDiagnosticTemplate(
    input: CreateDiagnosticTemplateInput,
  ): OperationResult<DiagnosticTemplate> {
    return this.#governance.createSignedDiagnosticTemplate(input);
  }

  deleteDiagnosticTemplate(
    templateId: string,
    confirmed: boolean,
  ): OperationResult<null> {
    return this.#governance.deleteDiagnosticTemplate(templateId, confirmed);
  }

  executeDiagnosticTemplate(
    templateId: string,
    targetId: string,
    confirmed: boolean,
  ): Promise<OperationResult<ActionResult>> {
    return this.#governance.executeDiagnosticTemplate(
      templateId,
      targetId,
      confirmed,
    );
  }

  listPlugins(): Promise<OperationResult<readonly PluginDescriptor[]>> {
    return this.#governance.listPlugins();
  }

  previewPluginImport(
    sourcePath: string,
  ): Promise<OperationResult<ImportPreview<PluginDescriptor>>> {
    return this.#governance.previewPluginImport(sourcePath);
  }

  installPlugin(
    previewId: string,
    confirmed: boolean,
  ): Promise<OperationResult<PluginDescriptor>> {
    return this.#governance.installPlugin(previewId, confirmed);
  }

  deletePlugin(
    pluginId: string,
    confirmed: boolean,
  ): Promise<OperationResult<null>> {
    return this.#governance.deletePlugin(pluginId, confirmed);
  }

  previewTeamPolicyImport(
    sourcePath: string,
  ): Promise<OperationResult<ImportPreview<TeamPolicyDescriptor>>> {
    return this.#governance.previewTeamPolicyImport(sourcePath);
  }

  activateTeamPolicy(
    previewId: string,
    confirmed: boolean,
  ): OperationResult<TeamPolicyDescriptor> {
    return this.#governance.activateTeamPolicy(previewId, confirmed);
  }

  getActiveTeamPolicy(): OperationResult<TeamPolicyDescriptor | null> {
    return this.#governance.getActiveTeamPolicy();
  }

  removeTeamPolicy(confirmed: boolean): OperationResult<null> {
    return this.#governance.removeTeamPolicy(confirmed);
  }

  createCase(input: CreateCaseInput): OperationResult<DiagnosticCase> {
    try {
      return success(
        this.#store.createCase(randomUUID(), input, new Date().toISOString()),
      );
    } catch (error) {
      return failure(
        "CASE_CREATE_FAILED",
        error instanceof Error ? error.message : "无法创建诊断案例",
      );
    }
  }

  archiveCase(caseId: string): OperationResult<DiagnosticCase> {
    try {
      const diagnosticCase = this.#store.archiveCase(
        caseId,
        new Date().toISOString(),
      );
      return diagnosticCase
        ? success(diagnosticCase)
        : failure("CASE_NOT_FOUND", "诊断案例不存在");
    } catch (error) {
      return failure(
        "CASE_ARCHIVE_FAILED",
        error instanceof Error ? error.message : "无法归档诊断案例",
      );
    }
  }

  deleteCase(caseId: string, confirmed: boolean): OperationResult<null> {
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "删除案例需要明确确认");
    }
    try {
      return this.#store.deleteCase(caseId)
        ? success(null)
        : failure("CASE_NOT_FOUND", "诊断案例不存在");
    } catch (error) {
      return failure(
        "CASE_DELETE_FAILED",
        error instanceof Error ? error.message : "无法删除诊断案例",
      );
    }
  }

  getCaseEvidence(caseId: string): OperationResult<CaseEvidence> {
    try {
      const evidence = this.#store.getCaseEvidence(caseId);
      return evidence
        ? success(evidence)
        : failure("CASE_NOT_FOUND", "诊断案例不存在");
    } catch (error) {
      return failure(
        "CASE_EVIDENCE_READ_FAILED",
        error instanceof Error ? error.message : "无法读取案例证据",
      );
    }
  }

  updateCaseEvidence(
    input: UpdateCaseEvidenceInput,
  ): OperationResult<CaseEvidence> {
    try {
      const evidence = this.#store.updateCaseEvidence(
        input.caseId,
        [...new Set(input.artifactIds)],
        [...new Set(input.actionTaskIds)],
        new Date().toISOString(),
      );
      return evidence
        ? success(evidence)
        : failure("CASE_NOT_FOUND", "诊断案例不存在");
    } catch (error) {
      return failure(
        "CASE_EVIDENCE_UPDATE_FAILED",
        error instanceof Error ? error.message : "无法固定案例证据",
      );
    }
  }

  previewCaseExport(caseId: string): OperationResult<CaseExportPreview> {
    try {
      const diagnosticCase = this.#store.getCase(caseId);
      const evidence = this.#store.getCaseEvidence(caseId);
      if (!diagnosticCase || !evidence) {
        return failure("CASE_NOT_FOUND", "诊断案例不存在");
      }
      const redacted = redactSensitiveText(diagnosticCase.notes);
      const manifest = this.#caseExportManifest(
        diagnosticCase,
        evidence,
        redacted.value,
      );
      return success({
        diagnosticCase,
        evidence,
        redactedNotes: redacted.value,
        redactionCount: redacted.count,
        manifestBytes: Buffer.byteLength(JSON.stringify(manifest), "utf8"),
        productVersion: this.#productVersion,
        schemaVersion: 1,
      });
    } catch (error) {
      return failure(
        "CASE_EXPORT_PREVIEW_FAILED",
        error instanceof Error ? error.message : "无法生成案例导出预览",
      );
    }
  }

  async exportCase(
    caseId: string,
    confirmed: boolean,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "案例导出需要确认脱敏预览");
    }
    const diagnosticCase = this.#store.getCase(caseId);
    const evidence = this.#store.getCaseEvidence(caseId);
    if (!diagnosticCase || !evidence) {
      return failure("CASE_NOT_FOUND", "诊断案例不存在");
    }
    const redacted = redactSensitiveText(diagnosticCase.notes);
    const createdAt = new Date().toISOString();
    const manifest = this.#caseExportManifest(
      diagnosticCase,
      evidence,
      redacted.value,
      createdAt,
    );
    const content = Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    return this.#writeBufferArtifact(
      "case",
      "CASE_EXPORT",
      `tanwei-case-${caseId.slice(0, 8)}-${createdAt.replaceAll(/[:.]/gu, "-")}.json`,
      content,
      createdAt,
    );
  }

  async importCase(
    sourcePath: string,
  ): Promise<OperationResult<DiagnosticCase>> {
    try {
      const file = await statFile(sourcePath);
      if (file.size > 10 * 1024 * 1024) {
        return failure("CASE_IMPORT_TOO_LARGE", "案例导入文件不能超过 10 MiB");
      }
      const parsed = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
      const imported = parseCaseExport(parsed);
      return success(
        this.#store.createCase(
          randomUUID(),
          {
            title: imported.title,
            notes: imported.notes,
            tags: [...new Set([...imported.tags, "imported"])],
          },
          new Date().toISOString(),
        ),
      );
    } catch (error) {
      return failure(
        "CASE_IMPORT_FAILED",
        error instanceof Error ? error.message : "无法导入案例",
      );
    }
  }

  generateSupportBundle(
    runtime: RuntimeInfo,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    const createdAt = new Date().toISOString();
    const settings = this.#store.getSettings();
    const content = Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          product: "tanwei",
          generatedAt: createdAt,
          runtime,
          settings: {
            locale: settings.locale,
            fontFamily: settings.fontFamily,
            defaultSamplingIntervalMillis:
              settings.defaultSamplingIntervalMillis,
            artifactQuotaBytes: settings.artifactQuotaBytes,
            retentionDays: settings.retentionDays,
            updatePolicy: settings.updatePolicy,
            maximumRiskLevel: settings.maximumRiskLevel,
            systemNotificationPolicy: settings.systemNotificationPolicy,
          },
          storage: {
            artifactCount: this.#store.listArtifacts().length,
            caseCount: this.#store.listCases().length,
          },
          design: {
            source: "apps/desktop/components.json",
            preset: "shadcn/ui New York neutral dark",
            version: "1.0.0",
          },
          privacy:
            "No paths, credentials, session secrets, environment values, system property values or live object values are included.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return this.#writeBufferArtifact(
      "support",
      "SUPPORT_BUNDLE",
      `tanwei-support-${createdAt.replaceAll(/[:.]/gu, "-")}.json`,
      content,
      createdAt,
    );
  }

  listArtifacts(): OperationResult<readonly ArtifactDescriptor[]> {
    try {
      return success(this.#store.listArtifacts());
    } catch (error) {
      return failure(
        "ARTIFACT_LIST_FAILED",
        error instanceof Error ? error.message : "无法读取制品列表",
      );
    }
  }

  listDiagnosticAlerts(): OperationResult<
    readonly DiagnosticAlertDescriptor[]
  > {
    try {
      return success(this.#store.listDiagnosticAlerts());
    } catch (error) {
      return failure(
        "DIAGNOSTIC_ALERT_LIST_FAILED",
        error instanceof Error ? error.message : "无法读取诊断通知",
      );
    }
  }

  async listJitRegressionBaselines(): Promise<
    OperationResult<JitRegressionBaselineIndex>
  > {
    try {
      const candidates = this.#store
        .listArtifacts()
        .filter(
          (artifact) =>
            artifact.type === "JIT_TREND" && artifact.status === "READY",
        );
      const baselines: JitRegressionBaselineIndex["baselines"][number][] = [];
      let scannedArtifacts = 0;
      for (const artifact of candidates.slice(0, 100)) {
        scannedArtifacts += 1;
        const inspected = await this.inspectJitTrendArtifact(artifact.id);
        const identity = inspected.value?.recording.regressionIdentity;
        if (inspected.ok && inspected.value && identity) {
          baselines.push({
            artifact,
            identity,
            jvmStartTimeEpochMillis:
              inspected.value.recording.jvmStartTimeEpochMillis,
            samplingIntervalMillis:
              inspected.value.recording.samplingIntervalMillis,
            summary: inspected.value.summary,
          });
          if (baselines.length === 50) {
            break;
          }
        }
      }
      return success({
        baselines,
        scannedArtifacts,
        truncated:
          scannedArtifacts < candidates.length || candidates.length > 100,
      });
    } catch (error) {
      return failure(
        "JIT_REGRESSION_BASELINE_LIST_FAILED",
        error instanceof Error ? error.message : "无法读取 JIT 回归基线",
      );
    }
  }

  acknowledgeDiagnosticAlert(
    alertId: string,
  ): OperationResult<DiagnosticAlertDescriptor | null> {
    try {
      return success(
        this.#store.acknowledgeDiagnosticAlert(
          alertId,
          new Date().toISOString(),
        ),
      );
    } catch (error) {
      return failure(
        "DIAGNOSTIC_ALERT_ACKNOWLEDGE_FAILED",
        error instanceof Error ? error.message : "无法标记诊断通知",
      );
    }
  }

  acknowledgeAllDiagnosticAlerts(): OperationResult<number> {
    try {
      return success(
        this.#store.acknowledgeAllDiagnosticAlerts(new Date().toISOString()),
      );
    } catch (error) {
      return failure(
        "DIAGNOSTIC_ALERT_ACKNOWLEDGE_FAILED",
        error instanceof Error ? error.message : "无法标记全部诊断通知",
      );
    }
  }

  async createSnapshotArtifact(
    targetId: string,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    const snapshotResult = await this.#targetService.getSnapshot(targetId);
    if (!snapshotResult.ok || !snapshotResult.value) {
      return failure(
        snapshotResult.errorCode ?? "SNAPSHOT_FAILED",
        snapshotResult.errorMessage ?? "无法采集诊断快照",
      );
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const name = `tanwei-snapshot-${createdAt.replaceAll(/[:.]/gu, "-")}.json`;
    const content = Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          product: "tanwei",
          targetId,
          capturedAt: createdAt,
          snapshot: snapshotResult.value,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const quotaResult = await this.#verifyCapacity(content.byteLength);
    if (!quotaResult.ok) {
      return failure(
        quotaResult.errorCode ?? "ARTIFACT_CAPACITY_CHECK_FAILED",
        quotaResult.errorMessage ?? "无法验证制品存储容量",
      );
    }

    const temporaryPath = path.join(this.#artifactRoot, `.${id}.partial`);
    const finalPath = path.join(this.#artifactRoot, name);
    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fileHandle = await open(temporaryPath, "wx", 0o600);
      await fileHandle.writeFile(content);
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;
      await rename(temporaryPath, finalPath);

      const artifact: ArtifactDescriptor = {
        id,
        targetId,
        type: "SNAPSHOT",
        name,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        status: "READY",
        createdAt,
      };
      try {
        this.#store.insertArtifact(artifact, finalPath);
      } catch (error) {
        await unlink(finalPath).catch(() => undefined);
        throw error;
      }
      return success(artifact);
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      return failure(
        "ARTIFACT_CREATE_FAILED",
        error instanceof Error ? error.message : "无法创建诊断快照制品",
      );
    }
  }

  async createHeapHistogramArtifact(
    input: CreateHeapHistogramArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    try {
      const content = serializeHeapHistogramArtifact(input.snapshot);
      const capturedAt = new Date(input.snapshot.capturedAt).toISOString();
      const timestamp = capturedAt.replaceAll(/[:.]/gu, "-");
      const name = `tanwei-heap-histogram-${timestamp}-${randomUUID().slice(0, 8)}.json`;
      return this.#writeBufferArtifact(
        input.snapshot.targetId,
        "HEAP_HISTOGRAM",
        name,
        content,
        capturedAt,
      );
    } catch (error) {
      return failure(
        "HEAP_HISTOGRAM_ARTIFACT_INVALID",
        error instanceof Error ? error.message : "Heap 直方图快照格式无效",
      );
    }
  }

  async createThreadPoolTrendArtifact(
    input: CreateThreadPoolTrendArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    try {
      const content = serializeThreadPoolTrendArtifact(input.recording);
      const lastSample = input.recording.samples.at(-1);
      if (!lastSample) {
        return failure(
          "THREAD_POOL_TREND_EMPTY",
          "线程池趋势至少需要两个有效样本",
        );
      }
      const snapshot = await this.#targetService.getSnapshot(
        input.recording.targetId,
      );
      if (!snapshot.ok || !snapshot.value) {
        return failure(
          snapshot.errorCode ?? "THREAD_POOL_TREND_TARGET_UNAVAILABLE",
          snapshot.errorMessage ?? "无法核对线程池趋势所属 JVM",
        );
      }
      if (
        snapshot.value.jvmStartTimeEpochMillis !==
        input.recording.jvmStartTimeEpochMillis
      ) {
        return failure(
          "THREAD_POOL_TREND_JVM_RESTARTED",
          "目标 JVM 已重启，已拒绝保存旧周期的线程池趋势",
        );
      }
      const snapshotCapturedAt = Date.parse(snapshot.value.capturedAt);
      if (
        !Number.isFinite(snapshotCapturedAt) ||
        lastSample.capturedAt > snapshotCapturedAt + 5_000
      ) {
        return failure(
          "THREAD_POOL_TREND_TIME_INVALID",
          "线程池趋势时间晚于 Host 当前快照",
        );
      }
      const capturedAt = new Date(lastSample.capturedAt).toISOString();
      const timestamp = capturedAt.replaceAll(/[:.]/gu, "-");
      const poolToken = input.recording.poolIdentity.replace("@", "-");
      const name = `tanwei-thread-pool-trend-${poolToken}-${timestamp}-${randomUUID().slice(0, 8)}.json`;
      return this.#writeBufferArtifact(
        input.recording.targetId,
        "THREAD_POOL_TREND",
        name,
        content,
        capturedAt,
      );
    } catch (error) {
      return failure(
        "THREAD_POOL_TREND_ARTIFACT_INVALID",
        error instanceof Error ? error.message : "线程池趋势格式无效",
      );
    }
  }

  async createJitTrendArtifact(
    input: CreateJitTrendArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    try {
      if (input.recording.regressionIdentity) {
        return failure(
          "JIT_REGRESSION_IDENTITY_UNTRUSTED",
          "跨版本回归身份只能由 Host 从已连接 JVM 推导",
        );
      }
      const lastSample = input.recording.samples.at(-1);
      if (!lastSample) {
        return failure("JIT_TREND_EMPTY", "JIT 趋势至少需要两个有效样本");
      }
      const snapshot = await this.#targetService.getSnapshot(
        input.recording.targetId,
      );
      if (!snapshot.ok || !snapshot.value) {
        return failure(
          snapshot.errorCode ?? "JIT_TREND_TARGET_UNAVAILABLE",
          snapshot.errorMessage ?? "无法核对 JIT 趋势所属 JVM",
        );
      }
      if (
        snapshot.value.jvmStartTimeEpochMillis !==
        input.recording.jvmStartTimeEpochMillis
      ) {
        return failure(
          "JIT_TREND_JVM_RESTARTED",
          "目标 JVM 已重启，已拒绝保存旧周期的 JIT 趋势",
        );
      }
      const snapshotCapturedAt = Date.parse(snapshot.value.capturedAt);
      if (
        !Number.isFinite(snapshotCapturedAt) ||
        lastSample.sampledAtEpochMillis > snapshotCapturedAt + 5_000
      ) {
        return failure(
          "JIT_TREND_TIME_INVALID",
          "JIT 趋势时间晚于 Host 当前快照",
        );
      }
      let storedRecording = input.recording;
      if (input.regressionLabel) {
        const connection = this.#targetService.connection(
          input.recording.targetId,
        );
        const javaVersion =
          connection?.javaVersion?.trim() ||
          connection?.target.javaVersion?.trim() ||
          "";
        const targetMainClass = connection?.target.mainClass.trim() ?? "";
        if (
          connection?.state !== "READY" ||
          !javaVersion ||
          javaVersion.length > 128 ||
          !targetMainClass ||
          targetMainClass.length > 1_024
        ) {
          return failure(
            "JIT_REGRESSION_ENVIRONMENT_UNAVAILABLE",
            "无法核对跨版本基线的 JDK 或主类身份",
          );
        }
        const compilerResult = await this.#targetService.executeAction({
          targetId: input.recording.targetId,
          actionId: "jit.compiler.summary",
          parameters: {},
        });
        const compilerName =
          compilerResult.value?.values["compiler.name"]?.trim() ?? "";
        if (
          !compilerResult.ok ||
          compilerResult.value?.status !== "SUCCEEDED" ||
          compilerResult.value.values["compiler.available"] !== "true" ||
          !compilerName ||
          compilerName.length > 256
        ) {
          return failure(
            "JIT_REGRESSION_COMPILER_UNAVAILABLE",
            "无法核对跨版本基线的 JIT 编译器身份",
          );
        }
        const identitySnapshot = await this.#targetService.getSnapshot(
          input.recording.targetId,
        );
        if (
          !identitySnapshot.ok ||
          identitySnapshot.value?.jvmStartTimeEpochMillis !==
            input.recording.jvmStartTimeEpochMillis
        ) {
          return failure(
            "JIT_REGRESSION_JVM_RESTARTED",
            "核对跨版本环境时目标 JVM 已发生变化",
          );
        }
        storedRecording = {
          ...input.recording,
          regressionIdentity: {
            ...input.regressionLabel,
            targetMainClass,
            javaVersion,
            compilerName,
          },
        };
      }
      const content = serializeJitTrendArtifact(storedRecording);
      const summary = summarizeJitTrend(storedRecording);
      const capturedAt = new Date(
        lastSample.sampledAtEpochMillis,
      ).toISOString();
      const timestamp = capturedAt.replaceAll(/[:.]/gu, "-");
      const name = `tanwei-jit-trend-${timestamp}-${randomUUID().slice(0, 8)}.json`;
      const artifactResult = await this.#writeBufferArtifact(
        input.recording.targetId,
        "JIT_TREND",
        name,
        content,
        capturedAt,
      );
      if (artifactResult.ok && artifactResult.value) {
        try {
          this.#store.insertDiagnosticAlert(
            createJitDiagnosticAlert(
              summary,
              artifactResult.value,
              randomUUID(),
              new Date().toISOString(),
            ),
          );
        } catch {
          // A notification-index failure must not misreport a durable artifact
          // as failed. The artifact remains available in the evidence center.
        }
      }
      return artifactResult;
    } catch (error) {
      return failure(
        "JIT_TREND_ARTIFACT_INVALID",
        error instanceof Error ? error.message : "JIT 趋势格式无效",
      );
    }
  }

  async createTraceHotspotArtifact(
    input: CreateTraceHotspotArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    const context = await this.#resolveObservationExportContext(
      input.targetId,
      input.target,
    );
    if (!context.ok || !context.value) {
      return failure(
        context.errorCode ?? "TRACE_EXPORT_TARGET_INVALID",
        context.errorMessage ?? "无法核对 Trace 导出目标",
      );
    }
    try {
      const content = serializeTraceHotspotArtifact(
        input,
        context.value.jvmStartTimeEpochMillis,
        context.value.exportedAtEpochMillis,
      );
      const timestamp = new Date(context.value.exportedAtEpochMillis)
        .toISOString()
        .replaceAll(/[:.]/gu, "-");
      return this.#writeBufferArtifact(
        input.targetId,
        "TRACE_HOTSPOTS",
        `tanwei-trace-hotspots-${timestamp}-${randomUUID().slice(0, 8)}.json`,
        content,
        new Date(context.value.exportedAtEpochMillis).toISOString(),
      );
    } catch (error) {
      return failure(
        "TRACE_HOTSPOT_ARTIFACT_INVALID",
        error instanceof Error ? error.message : "Trace 热点导出格式无效",
      );
    }
  }

  async createMonitorWindowsArtifact(
    input: CreateMonitorWindowsArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    const context = await this.#resolveObservationExportContext(
      input.targetId,
      input.target,
    );
    if (!context.ok || !context.value) {
      return failure(
        context.errorCode ?? "MONITOR_EXPORT_TARGET_INVALID",
        context.errorMessage ?? "无法核对 Monitor 导出目标",
      );
    }
    try {
      const content = serializeMonitorWindowsArtifact(
        input,
        context.value.jvmStartTimeEpochMillis,
        context.value.exportedAtEpochMillis,
      );
      const timestamp = new Date(context.value.exportedAtEpochMillis)
        .toISOString()
        .replaceAll(/[:.]/gu, "-");
      return this.#writeBufferArtifact(
        input.targetId,
        "MONITOR_WINDOWS",
        `tanwei-monitor-windows-${timestamp}-${randomUUID().slice(0, 8)}.json`,
        content,
        new Date(context.value.exportedAtEpochMillis).toISOString(),
      );
    } catch (error) {
      return failure(
        "MONITOR_WINDOWS_ARTIFACT_INVALID",
        error instanceof Error ? error.message : "Monitor 窗口导出格式无效",
      );
    }
  }

  async #resolveObservationExportContext(
    targetId: string,
    target: ObservationMethodIdentity,
  ): Promise<
    OperationResult<{
      readonly jvmStartTimeEpochMillis: number;
      readonly exportedAtEpochMillis: number;
    }>
  > {
    const [snapshot, details] = await Promise.all([
      this.#targetService.getSnapshot(targetId),
      this.#targetService.getClassDetails(
        targetId,
        target.className,
        target.classLoader,
      ),
    ]);
    if (!snapshot.ok || !snapshot.value) {
      return failure(
        snapshot.errorCode ?? "OBSERVATION_EXPORT_TARGET_UNAVAILABLE",
        snapshot.errorMessage ?? "无法核对观测导出所属 JVM",
      );
    }
    if (!details.ok || !details.value) {
      return failure(
        details.errorCode ?? "OBSERVATION_EXPORT_METHOD_UNAVAILABLE",
        details.errorMessage ?? "无法核对观测导出的精确方法",
      );
    }
    const methodExists = details.value.methods.some(
      (method) =>
        method.name === target.methodName &&
        method.parameterTypes.length === target.parameterTypes.length &&
        method.parameterTypes.every(
          (parameterType, index) =>
            parameterType === target.parameterTypes[index],
        ),
    );
    const exportedAtEpochMillis = Date.parse(snapshot.value.capturedAt);
    if (
      !methodExists ||
      !Number.isSafeInteger(snapshot.value.jvmStartTimeEpochMillis) ||
      snapshot.value.jvmStartTimeEpochMillis <= 0 ||
      !Number.isSafeInteger(exportedAtEpochMillis) ||
      exportedAtEpochMillis < snapshot.value.jvmStartTimeEpochMillis
    ) {
      return failure(
        "OBSERVATION_EXPORT_IDENTITY_MISMATCH",
        "观测导出的类、方法或 JVM 启动周期不再匹配",
      );
    }
    return success({
      jvmStartTimeEpochMillis: snapshot.value.jvmStartTimeEpochMillis,
      exportedAtEpochMillis,
    });
  }

  async #writeBufferArtifact(
    targetId: string,
    type: ArtifactDescriptor["type"],
    name: string,
    content: Buffer,
    createdAt: string,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    const capacity = await this.#verifyCapacity(content.byteLength);
    if (!capacity.ok) {
      return failure(
        capacity.errorCode ?? "ARTIFACT_CAPACITY_CHECK_FAILED",
        capacity.errorMessage ?? "无法验证制品存储容量",
      );
    }
    const id = randomUUID();
    const temporaryPath = path.join(this.#artifactRoot, `.${id}.partial`);
    const finalPath = path.join(this.#artifactRoot, name);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, finalPath);
      const artifact: ArtifactDescriptor = {
        id,
        targetId,
        type,
        name,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        status: "READY",
        createdAt,
      };
      try {
        this.#store.insertArtifact(artifact, finalPath);
      } catch (error) {
        await unlink(finalPath).catch(() => undefined);
        throw error;
      }
      return success(artifact);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      return failure(
        "ARTIFACT_CREATE_FAILED",
        error instanceof Error ? error.message : "无法创建案例导出制品",
      );
    }
  }

  #caseExportManifest(
    diagnosticCase: DiagnosticCase,
    evidence: CaseEvidence,
    redactedNotes: string,
    exportedAt = new Date().toISOString(),
  ): Readonly<Record<string, unknown>> {
    return {
      schemaVersion: 1,
      product: "tanwei",
      productVersion: this.#productVersion,
      exportedAt,
      case: {
        title: diagnosticCase.title,
        notes: redactedNotes,
        tags: diagnosticCase.tags,
        status: diagnosticCase.status,
        createdAt: diagnosticCase.createdAt,
        updatedAt: diagnosticCase.updatedAt,
      },
      evidence: {
        artifacts: evidence.artifacts,
        actions: evidence.actions,
      },
    };
  }

  async collectAgentArtifact(
    input: CollectAgentArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    const quotaResult = await this.#verifyCapacity(input.expectedSize).catch(
      (error: unknown) =>
        failure<null>(
          "ARTIFACT_CAPACITY_CHECK_FAILED",
          error instanceof Error ? error.message : "无法验证制品存储容量",
        ),
    );
    if (!quotaResult.ok) {
      return failure(
        quotaResult.errorCode ?? "ARTIFACT_CAPACITY_CHECK_FAILED",
        quotaResult.errorMessage ?? "无法验证制品存储容量",
      );
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const name = artifactName(input.type, createdAt, id);
    const temporaryPath = path.join(this.#artifactRoot, `.${id}.partial`);
    const finalPath = path.join(this.#artifactRoot, name);
    const hash = createHash("sha256");
    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    let bytesWritten = 0;
    let expectedSequence = 0;
    let renamed = false;

    try {
      fileHandle = await open(temporaryPath, "wx", 0o600);
      for await (const chunk of this.#targetService.downloadArtifact(
        input.targetId,
        input.token,
      )) {
        if (chunk.sequence !== expectedSequence) {
          throw new Error(
            `制品分块序号不连续：预期 ${expectedSequence}，收到 ${chunk.sequence}`,
          );
        }
        expectedSequence += 1;
        bytesWritten += chunk.data.byteLength;
        if (bytesWritten > input.expectedSize) {
          throw new Error("Agent 返回的制品大小超过声明值");
        }
        await fileHandle.writeFile(chunk.data);
        hash.update(chunk.data);
      }
      if (bytesWritten !== input.expectedSize) {
        throw new Error(
          `制品大小不一致：预期 ${input.expectedSize}，收到 ${bytesWritten}`,
        );
      }
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;
      await rename(temporaryPath, finalPath);
      renamed = true;

      const artifact: ArtifactDescriptor = {
        id,
        targetId: input.targetId,
        type: input.type,
        name,
        size: bytesWritten,
        sha256: hash.digest("hex"),
        status: "READY",
        createdAt,
      };
      this.#store.insertArtifact(artifact, finalPath);
      return success(artifact);
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (renamed) {
        await unlink(finalPath).catch(() => undefined);
      }
      return failure(
        "ARTIFACT_COLLECT_FAILED",
        error instanceof Error ? error.message : "无法接收 Agent 制品",
      );
    } finally {
      await this.#targetService
        .deleteRemoteArtifact(input.targetId, input.token)
        .catch(() => undefined);
    }
  }

  async decompileClassArtifact(
    artifactId: string,
  ): Promise<OperationResult<DecompiledSource>> {
    const artifact = this.#store.getArtifact(artifactId);
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (
      !artifact ||
      !artifactPath ||
      artifact.type !== "CLASS_DUMP" ||
      artifact.status !== "READY"
    ) {
      return failure(
        "CLASS_ARTIFACT_NOT_FOUND",
        "Class Dump 制品不存在或尚未就绪",
      );
    }
    if (!this.#isManagedArtifactPath(artifactPath)) {
      return failure("UNSAFE_ARTIFACT_PATH", "Class Dump 路径超出受控目录");
    }
    try {
      const decompiler = await resolveJvmComponent("decompiler");
      const { stdout } = await execFileAsync(
        resolveJavaExecutable(),
        ["-jar", decompiler, "--input", artifactPath],
        {
          timeout: DECOMPILER_TIMEOUT_MILLIS,
          maxBuffer: MAXIMUM_DECOMPILED_SOURCE_BYTES,
          windowsHide: true,
          encoding: "utf8",
        },
      );
      const source = stdout.trim();
      if (!source) {
        return failure("DECOMPILER_EMPTY_RESULT", "反编译器未返回源码");
      }
      return success({
        artifactId,
        source,
        decompiler: "CFR 0.152",
      });
    } catch (error) {
      return failure(
        "DECOMPILATION_FAILED",
        error instanceof Error ? error.message : "无法反编译 Class Dump",
      );
    }
  }

  async compileClassSource(
    input: CompileClassSourceInput,
  ): Promise<OperationResult<CompiledClass>> {
    const connection = this.#targetService.connection(input.targetId);
    if (!connection || connection.state !== "READY") {
      return failure("TARGET_NOT_CONNECTED", "目标 JVM 尚未建立可用连接");
    }
    const sourceBytes = Buffer.byteLength(input.source, "utf8");
    if (sourceBytes === 0 || sourceBytes > MAXIMUM_CLASS_SOURCE_BYTES) {
      return failure(
        "CLASS_SOURCE_SIZE_INVALID",
        "类源码为空或超过 1 MiB 安全上限",
      );
    }
    const targetRelease = javaRelease(connection.javaVersion);
    if (targetRelease === null) {
      return failure(
        "TARGET_JAVA_VERSION_UNKNOWN",
        "无法确定目标 JVM 的 Java 主版本",
      );
    }
    const classDetails = await this.#targetService.getClassDetails(
      input.targetId,
      input.className,
      input.classLoader,
    );
    if (!classDetails.ok || !classDetails.value) {
      return failure(
        "CLASS_IDENTITY_UNAVAILABLE",
        classDetails.errorMessage ?? "无法核对待编译类的精确 ClassLoader",
      );
    }
    const compilerClassPath = await resolveCompilerClassPath(
      input.targetId,
      classDetails.value.codeSource,
    );
    if (!compilerClassPath.ok) {
      return failure(
        compilerClassPath.errorCode ?? "CLASS_COMPILE_CLASSPATH_UNAVAILABLE",
        compilerClassPath.errorMessage ?? "无法读取目标类 Code Source",
      );
    }
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "tanwei-compile-"),
    );
    try {
      const sourcePath =
        path.join(temporaryRoot, "source", ...input.className.split(".")) +
        ".java";
      const outputRoot = path.join(temporaryRoot, "classes");
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await mkdir(outputRoot, { recursive: true });
      await writeFile(sourcePath, input.source, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        const compilerArguments = [
          "-J-Xmx256m",
          "-J-XX:MaxMetaspaceSize=128m",
          "--release",
          String(targetRelease),
          "-encoding",
          "UTF-8",
          "-proc:none",
          "-d",
          outputRoot,
        ];
        if (compilerClassPath.value) {
          compilerArguments.push("-classpath", compilerClassPath.value);
        }
        compilerArguments.push(sourcePath);
        await execFileAsync(resolveJavacExecutable(), compilerArguments, {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
      } catch (error) {
        const compilerError = error as {
          stderr?: string;
          message?: string;
        };
        return failure(
          "CLASS_COMPILATION_FAILED",
          (compilerError.stderr || compilerError.message || "类编译失败")
            .trim()
            .slice(0, 16_384),
        );
      }
      const classPath =
        path.join(outputRoot, ...input.className.split(".")) + ".class";
      const bytecode = await readFile(classPath).catch(() => null);
      if (
        !bytecode ||
        bytecode.length < 8 ||
        bytecode.length > MAXIMUM_COMPILED_CLASS_BYTES
      ) {
        return failure(
          "COMPILED_CLASS_INVALID",
          "编译器未生成精确目标类，或类文件超过 2 MiB 安全上限",
        );
      }
      return success({
        className: input.className,
        targetRelease,
        size: bytecode.length,
        sha256: createHash("sha256").update(bytecode).digest("hex"),
        bytecodeBase64: bytecode.toString("base64"),
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async compileClassChangeSet(
    input: CompileClassChangeSetInput,
  ): Promise<OperationResult<CompiledClassChangeSet>> {
    const connection = this.#targetService.connection(input.targetId);
    if (!connection || connection.state !== "READY") {
      return failure("TARGET_NOT_CONNECTED", "目标 JVM 尚未建立可用连接");
    }
    if (input.items.length < 2 || input.items.length > 8) {
      return failure(
        "CLASS_CHANGE_SET_SIZE_INVALID",
        "多类变更集必须包含 2 到 8 个精确类",
      );
    }
    const classLoader = input.items[0]?.classLoader;
    const identities = new Set<string>();
    let totalSourceBytes = 0;
    for (const item of input.items) {
      const sourceBytes = Buffer.byteLength(item.source, "utf8");
      totalSourceBytes += sourceBytes;
      if (
        sourceBytes === 0 ||
        sourceBytes > MAXIMUM_CLASS_SOURCE_BYTES ||
        totalSourceBytes > MAXIMUM_CLASS_CHANGE_SET_SOURCE_BYTES
      ) {
        return failure(
          "CLASS_CHANGE_SET_SOURCE_SIZE_INVALID",
          "单类源码不得超过 1 MiB，变更集源码总量不得超过 2 MiB",
        );
      }
      if (item.classLoader !== classLoader) {
        return failure(
          "CLASS_CHANGE_SET_LOADER_MISMATCH",
          "变更集中的类必须来自同一个精确 ClassLoader",
        );
      }
      const identity = `${item.className}\0${item.classLoader}`;
      if (identities.has(identity)) {
        return failure("CLASS_CHANGE_SET_DUPLICATE", "变更集不能包含重复类");
      }
      identities.add(identity);
    }
    const targetRelease = javaRelease(connection.javaVersion);
    if (targetRelease === null) {
      return failure(
        "TARGET_JAVA_VERSION_UNKNOWN",
        "无法确定目标 JVM 的 Java 主版本",
      );
    }

    const details = await Promise.all(
      input.items.map((item) =>
        this.#targetService.getClassDetails(
          input.targetId,
          item.className,
          item.classLoader,
        ),
      ),
    );
    for (let index = 0; index < details.length; index += 1) {
      const detail = details[index];
      if (!detail?.ok || !detail.value) {
        return failure(
          "CLASS_CHANGE_SET_IDENTITY_UNAVAILABLE",
          detail?.errorMessage ?? `无法核对变更集中的第 ${index + 1} 个精确类`,
        );
      }
    }
    const classPathResults = await Promise.all(
      details.map((detail) =>
        resolveCompilerClassPath(
          input.targetId,
          detail.value?.codeSource ?? null,
        ),
      ),
    );
    const compilerClassPaths: string[] = [];
    for (const result of classPathResults) {
      if (!result.ok) {
        return failure(
          result.errorCode ?? "CLASS_CHANGE_SET_CLASSPATH_UNAVAILABLE",
          result.errorMessage ?? "无法读取变更集类的 Code Source",
        );
      }
      if (result.value && !compilerClassPaths.includes(result.value)) {
        compilerClassPaths.push(result.value);
      }
    }

    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "tanwei-change-set-"),
    );
    try {
      const sourceRoot = path.join(temporaryRoot, "source");
      const outputRoot = path.join(temporaryRoot, "classes");
      await mkdir(outputRoot, { recursive: true });
      const sourcePaths: string[] = [];
      for (const item of input.items) {
        const sourcePath =
          path.join(sourceRoot, ...item.className.split(".")) + ".java";
        await mkdir(path.dirname(sourcePath), { recursive: true });
        await writeFile(sourcePath, item.source, {
          encoding: "utf8",
          mode: 0o600,
        });
        sourcePaths.push(sourcePath);
      }
      try {
        const compilerArguments = [
          "-J-Xmx256m",
          "-J-XX:MaxMetaspaceSize=128m",
          "--release",
          String(targetRelease),
          "-encoding",
          "UTF-8",
          "-proc:none",
          "-d",
          outputRoot,
        ];
        if (compilerClassPaths.length > 0) {
          compilerArguments.push(
            "-classpath",
            compilerClassPaths.join(path.delimiter),
          );
        }
        compilerArguments.push(...sourcePaths);
        await execFileAsync(resolveJavacExecutable(), compilerArguments, {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
      } catch (error) {
        const compilerError = error as {
          stderr?: string;
          message?: string;
        };
        return failure(
          "CLASS_CHANGE_SET_COMPILATION_FAILED",
          (
            compilerError.stderr ||
            compilerError.message ||
            "多类变更集编译失败"
          )
            .trim()
            .slice(0, 16_384),
        );
      }

      const expectedRelativePaths = new Set(
        input.items.map((item) =>
          path.normalize(path.join(...item.className.split(".")) + ".class"),
        ),
      );
      const generatedEntries = await readdir(outputRoot, {
        recursive: true,
      });
      const generatedClassPaths = generatedEntries
        .filter((entry) => entry.endsWith(".class"))
        .map((entry) => path.normalize(entry));
      if (
        generatedClassPaths.length !== expectedRelativePaths.size ||
        generatedClassPaths.some((entry) => !expectedRelativePaths.has(entry))
      ) {
        return failure(
          "CLASS_CHANGE_SET_UNDECLARED_OUTPUT",
          "编译产生了未声明的附加类；请把内部类或辅助类作为精确变更项单独加入",
        );
      }

      const compiledItems: CompiledClass[] = [];
      let totalSize = 0;
      for (const item of input.items) {
        const classPath =
          path.join(outputRoot, ...item.className.split(".")) + ".class";
        const bytecode = await readFile(classPath).catch(() => null);
        if (
          !bytecode ||
          bytecode.length < 8 ||
          bytecode.length > MAXIMUM_COMPILED_CLASS_BYTES
        ) {
          return failure(
            "COMPILED_CLASS_CHANGE_SET_ITEM_INVALID",
            `编译器未生成精确类 ${item.className}，或类文件超过 2 MiB`,
          );
        }
        totalSize += bytecode.length;
        if (totalSize > MAXIMUM_CLASS_CHANGE_SET_BYTECODE_BYTES) {
          return failure(
            "COMPILED_CLASS_CHANGE_SET_TOO_LARGE",
            "多类变更集编译字节码总量超过 2 MiB 安全上限",
          );
        }
        compiledItems.push({
          className: item.className,
          targetRelease,
          size: bytecode.length,
          sha256: createHash("sha256").update(bytecode).digest("hex"),
          bytecodeBase64: bytecode.toString("base64"),
        });
      }
      return success({
        targetRelease,
        totalSize,
        items: compiledItems,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async deleteArtifact(
    artifactId: string,
    confirmed: boolean,
  ): Promise<OperationResult<null>> {
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "删除制品需要明确确认");
    }
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (!artifactPath) {
      return failure("ARTIFACT_NOT_FOUND", "制品不存在");
    }
    if (!this.#isManagedArtifactPath(artifactPath)) {
      return failure("UNSAFE_ARTIFACT_PATH", "制品路径超出受控目录");
    }
    try {
      await unlink(artifactPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      this.#store.deleteArtifact(artifactId);
      return success(null);
    } catch (error) {
      return failure(
        "ARTIFACT_DELETE_FAILED",
        error instanceof Error ? error.message : "无法删除制品",
      );
    }
  }

  async verifyArtifact(
    artifactId: string,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    const artifact = this.#store.getArtifact(artifactId);
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (!artifact || !artifactPath) {
      return failure("ARTIFACT_NOT_FOUND", "制品不存在");
    }
    if (!this.#isManagedArtifactPath(artifactPath)) {
      return failure("UNSAFE_ARTIFACT_PATH", "制品路径超出受控目录");
    }
    try {
      const fileStat = await statFile(artifactPath);
      if (fileStat.size !== artifact.size) {
        return failure("ARTIFACT_SIZE_MISMATCH", "制品大小与登记信息不一致");
      }
      const actualHash = await hashFile(artifactPath);
      if (actualHash !== artifact.sha256) {
        return failure("ARTIFACT_HASH_MISMATCH", "制品 SHA-256 校验失败");
      }
      return success(artifact);
    } catch (error) {
      return failure(
        "ARTIFACT_VERIFY_FAILED",
        error instanceof Error ? error.message : "无法校验制品",
      );
    }
  }

  async resolveProfileReport(
    artifactId: string,
  ): Promise<OperationResult<ResolvedProfileReport>> {
    const artifact = this.#store.getArtifact(artifactId);
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (
      !artifact ||
      !artifactPath ||
      artifact.type !== "PROFILE" ||
      artifact.status !== "READY"
    ) {
      return failure("PROFILE_REPORT_NOT_FOUND", "性能报告不存在或尚未就绪");
    }
    try {
      const [canonicalRoot, canonicalPath] = await Promise.all([
        realpath(this.#artifactRoot),
        realpath(artifactPath),
      ]);
      if (!isPathInsideRoot(canonicalRoot, canonicalPath)) {
        return failure(
          "UNSAFE_PROFILE_REPORT_PATH",
          "性能报告路径超出受控制品目录",
        );
      }
      if (path.extname(canonicalPath).toLocaleLowerCase() !== ".html") {
        return failure(
          "UNSUPPORTED_PROFILE_REPORT",
          "仅支持打开探微生成的 HTML 性能报告",
        );
      }
      const fileStat = await statFile(canonicalPath);
      if (fileStat.size <= 0 || fileStat.size > MAXIMUM_PROFILE_REPORT_BYTES) {
        return failure(
          "PROFILE_REPORT_SIZE_INVALID",
          "性能报告为空或超过 64 MiB 安全上限",
        );
      }
      if (fileStat.size !== artifact.size) {
        return failure(
          "ARTIFACT_SIZE_MISMATCH",
          "性能报告大小与登记信息不一致",
        );
      }
      const actualHash = await hashFile(canonicalPath);
      if (actualHash !== artifact.sha256) {
        return failure("ARTIFACT_HASH_MISMATCH", "性能报告 SHA-256 校验失败");
      }
      return success({
        absolutePath: canonicalPath,
        name: artifact.name,
      });
    } catch (error) {
      return failure(
        "PROFILE_REPORT_VERIFY_FAILED",
        error instanceof Error ? error.message : "无法校验性能报告",
      );
    }
  }

  async inspectJfrArtifact(
    artifactId: string,
  ): Promise<OperationResult<JfrInspectionReport>> {
    const artifact = this.#store.getArtifact(artifactId);
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (
      !artifact ||
      !artifactPath ||
      artifact.type !== "JFR" ||
      artifact.status !== "READY"
    ) {
      return failure("JFR_ARTIFACT_NOT_FOUND", "JFR 制品不存在或尚未就绪");
    }
    try {
      const [canonicalRoot, canonicalPath] = await Promise.all([
        realpath(this.#artifactRoot),
        realpath(artifactPath),
      ]);
      if (!isPathInsideRoot(canonicalRoot, canonicalPath)) {
        return failure("UNSAFE_JFR_ARTIFACT_PATH", "JFR 路径超出受控制品目录");
      }
      if (path.extname(canonicalPath).toLocaleLowerCase() !== ".jfr") {
        return failure("UNSUPPORTED_JFR_ARTIFACT", "制品不是 JFR 录制文件");
      }
      const fileStat = await statFile(canonicalPath);
      if (fileStat.size <= 0 || fileStat.size > MAXIMUM_JFR_ARTIFACT_BYTES) {
        return failure(
          "JFR_ARTIFACT_SIZE_INVALID",
          "JFR 制品为空或超过 512 MiB 应用内分析上限",
        );
      }
      if (fileStat.size !== artifact.size) {
        return failure(
          "ARTIFACT_SIZE_MISMATCH",
          "JFR 制品大小与登记信息不一致",
        );
      }
      const actualHash = await hashFile(canonicalPath);
      if (actualHash !== artifact.sha256) {
        return failure("ARTIFACT_HASH_MISMATCH", "JFR 制品 SHA-256 校验失败");
      }
      const { stdout } = await execFileAsync(
        resolveJfrExecutable(),
        [
          "print",
          "--json",
          "--events",
          JFR_INSPECTION_EVENTS,
          "--stack-depth",
          "8",
          canonicalPath,
        ],
        {
          timeout: JFR_INSPECTION_TIMEOUT_MILLIS,
          maxBuffer: MAXIMUM_JFR_JSON_BYTES,
          windowsHide: true,
          encoding: "utf8",
        },
      );
      return success(parseJfrReportJson(stdout, artifactId));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "无法解析 JFR 制品";
      return failure(
        "JFR_INSPECTION_FAILED",
        message.includes("maxBuffer")
          ? "JFR 事件输出超过 32 MiB 安全上限；请缩短录制时间"
          : message,
      );
    }
  }

  async inspectThreadDumpArtifact(
    artifactId: string,
  ): Promise<OperationResult<ThreadDumpInspectionReport>> {
    const artifact = this.#store.getArtifact(artifactId);
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (
      !artifact ||
      !artifactPath ||
      artifact.type !== "THREAD_DUMP" ||
      artifact.status !== "READY"
    ) {
      return failure(
        "THREAD_DUMP_ARTIFACT_NOT_FOUND",
        "线程转储不存在或尚未就绪",
      );
    }
    try {
      const [canonicalRoot, canonicalPath] = await Promise.all([
        realpath(this.#artifactRoot),
        realpath(artifactPath),
      ]);
      if (!isPathInsideRoot(canonicalRoot, canonicalPath)) {
        return failure(
          "UNSAFE_THREAD_DUMP_PATH",
          "线程转储路径超出受控制品目录",
        );
      }
      if (path.extname(canonicalPath).toLocaleLowerCase() !== ".txt") {
        return failure(
          "UNSUPPORTED_THREAD_DUMP_ARTIFACT",
          "制品不是探微线程转储文本",
        );
      }
      const fileStat = await statFile(canonicalPath);
      if (fileStat.size <= 0 || fileStat.size > MAXIMUM_THREAD_DUMP_BYTES) {
        return failure(
          "THREAD_DUMP_SIZE_INVALID",
          "线程转储为空或超过 32 MiB 应用内检查上限",
        );
      }
      if (fileStat.size !== artifact.size) {
        return failure(
          "ARTIFACT_SIZE_MISMATCH",
          "线程转储大小与登记信息不一致",
        );
      }
      const actualHash = await hashFile(canonicalPath);
      if (actualHash !== artifact.sha256) {
        return failure("ARTIFACT_HASH_MISMATCH", "线程转储 SHA-256 校验失败");
      }
      const content = await readFile(canonicalPath, "utf8");
      return success(parseThreadDumpReport(content, artifactId));
    } catch (error) {
      return failure(
        "THREAD_DUMP_INSPECTION_FAILED",
        error instanceof Error ? error.message : "无法解析线程转储",
      );
    }
  }

  async compareThreadDumpArtifacts(
    input: CompareThreadDumpArtifactsInput,
  ): Promise<OperationResult<ThreadDumpComparison>> {
    if (input.baselineArtifactId === input.currentArtifactId) {
      return failure(
        "THREAD_DUMP_COMPARISON_REQUIRES_TWO_ARTIFACTS",
        "请选择两份不同的线程转储",
      );
    }
    const baselineArtifact = this.#store.getArtifact(input.baselineArtifactId);
    const currentArtifact = this.#store.getArtifact(input.currentArtifactId);
    if (
      !baselineArtifact ||
      !currentArtifact ||
      baselineArtifact.type !== "THREAD_DUMP" ||
      currentArtifact.type !== "THREAD_DUMP" ||
      baselineArtifact.status !== "READY" ||
      currentArtifact.status !== "READY"
    ) {
      return failure(
        "THREAD_DUMP_COMPARISON_ARTIFACT_NOT_FOUND",
        "对比需要两份已就绪的线程转储",
      );
    }
    if (baselineArtifact.targetId !== currentArtifact.targetId) {
      return failure(
        "THREAD_DUMP_COMPARISON_TARGET_MISMATCH",
        "只能对比同一目标 JVM 的线程转储",
      );
    }
    const baselineCreatedAt = Date.parse(baselineArtifact.createdAt);
    const currentCreatedAt = Date.parse(currentArtifact.createdAt);
    if (
      !Number.isFinite(baselineCreatedAt) ||
      !Number.isFinite(currentCreatedAt) ||
      baselineCreatedAt > currentCreatedAt
    ) {
      return failure(
        "THREAD_DUMP_COMPARISON_ORDER_INVALID",
        "基线线程转储必须早于当前线程转储",
      );
    }

    const [baselineResult, currentResult] = await Promise.all([
      this.inspectThreadDumpArtifact(input.baselineArtifactId),
      this.inspectThreadDumpArtifact(input.currentArtifactId),
    ]);
    if (!baselineResult.ok || !baselineResult.value) {
      return failure(
        baselineResult.errorCode ?? "THREAD_DUMP_BASELINE_INVALID",
        baselineResult.errorMessage ?? "无法读取基线线程转储",
      );
    }
    if (!currentResult.ok || !currentResult.value) {
      return failure(
        currentResult.errorCode ?? "THREAD_DUMP_CURRENT_INVALID",
        currentResult.errorMessage ?? "无法读取当前线程转储",
      );
    }
    try {
      return success(
        compareThreadDumpReports(baselineResult.value, currentResult.value, {
          targetId: baselineArtifact.targetId,
          baselineArtifactId: baselineArtifact.id,
          currentArtifactId: currentArtifact.id,
        }),
      );
    } catch (error) {
      return failure(
        "THREAD_DUMP_COMPARISON_FAILED",
        error instanceof Error ? error.message : "无法对比线程转储",
      );
    }
  }

  async inspectHeapHistogramArtifact(
    artifactId: string,
  ): Promise<OperationResult<HeapHistogramInspectionReport>> {
    const artifact = this.#store.getArtifact(artifactId);
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (
      !artifact ||
      !artifactPath ||
      artifact.type !== "HEAP_HISTOGRAM" ||
      artifact.status !== "READY"
    ) {
      return failure(
        "HEAP_HISTOGRAM_ARTIFACT_NOT_FOUND",
        "Heap 直方图快照不存在或尚未就绪",
      );
    }
    try {
      const [canonicalRoot, canonicalPath] = await Promise.all([
        realpath(this.#artifactRoot),
        realpath(artifactPath),
      ]);
      if (!isPathInsideRoot(canonicalRoot, canonicalPath)) {
        return failure(
          "UNSAFE_HEAP_HISTOGRAM_PATH",
          "Heap 直方图路径超出受控制品目录",
        );
      }
      if (path.extname(canonicalPath).toLocaleLowerCase() !== ".json") {
        return failure(
          "UNSUPPORTED_HEAP_HISTOGRAM_ARTIFACT",
          "制品不是探微 Heap 直方图 JSON",
        );
      }
      const fileStat = await statFile(canonicalPath);
      if (
        fileStat.size <= 0 ||
        fileStat.size > MAXIMUM_HEAP_HISTOGRAM_ARTIFACT_BYTES
      ) {
        return failure(
          "HEAP_HISTOGRAM_SIZE_INVALID",
          "Heap 直方图为空或超过 512 KiB 应用内检查上限",
        );
      }
      if (fileStat.size !== artifact.size) {
        return failure(
          "ARTIFACT_SIZE_MISMATCH",
          "Heap 直方图大小与登记信息不一致",
        );
      }
      const actualHash = await hashFile(canonicalPath);
      if (actualHash !== artifact.sha256) {
        return failure(
          "ARTIFACT_HASH_MISMATCH",
          "Heap 直方图 SHA-256 校验失败",
        );
      }
      const report = parseHeapHistogramArtifact(
        await readFile(canonicalPath, "utf8"),
        artifactId,
      );
      if (
        report.snapshot.targetId !== artifact.targetId ||
        report.snapshot.capturedAt !== Date.parse(artifact.createdAt)
      ) {
        return failure(
          "HEAP_HISTOGRAM_IDENTITY_MISMATCH",
          "Heap 直方图内容与登记的目标或采集时间不一致",
        );
      }
      return success(report);
    } catch (error) {
      return failure(
        "HEAP_HISTOGRAM_INSPECTION_FAILED",
        error instanceof Error ? error.message : "无法解析 Heap 直方图",
      );
    }
  }

  async compareHeapHistogramArtifacts(
    input: CompareHeapHistogramArtifactsInput,
  ): Promise<OperationResult<HeapHistogramComparison>> {
    if (input.baselineArtifactId === input.currentArtifactId) {
      return failure(
        "HEAP_HISTOGRAM_COMPARISON_REQUIRES_TWO_ARTIFACTS",
        "请选择两份不同的 Heap 直方图快照",
      );
    }
    const baselineArtifact = this.#store.getArtifact(input.baselineArtifactId);
    const currentArtifact = this.#store.getArtifact(input.currentArtifactId);
    if (
      !baselineArtifact ||
      !currentArtifact ||
      baselineArtifact.type !== "HEAP_HISTOGRAM" ||
      currentArtifact.type !== "HEAP_HISTOGRAM" ||
      baselineArtifact.status !== "READY" ||
      currentArtifact.status !== "READY"
    ) {
      return failure(
        "HEAP_HISTOGRAM_COMPARISON_ARTIFACT_NOT_FOUND",
        "对比需要两份已就绪的 Heap 直方图快照",
      );
    }
    if (baselineArtifact.targetId !== currentArtifact.targetId) {
      return failure(
        "HEAP_HISTOGRAM_COMPARISON_TARGET_MISMATCH",
        "只能对比同一目标 JVM 的 Heap 直方图",
      );
    }
    const [baselineResult, currentResult] = await Promise.all([
      this.inspectHeapHistogramArtifact(input.baselineArtifactId),
      this.inspectHeapHistogramArtifact(input.currentArtifactId),
    ]);
    if (!baselineResult.ok || !baselineResult.value) {
      return failure(
        baselineResult.errorCode ?? "HEAP_HISTOGRAM_BASELINE_INVALID",
        baselineResult.errorMessage ?? "无法读取基线 Heap 直方图",
      );
    }
    if (!currentResult.ok || !currentResult.value) {
      return failure(
        currentResult.errorCode ?? "HEAP_HISTOGRAM_CURRENT_INVALID",
        currentResult.errorMessage ?? "无法读取当前 Heap 直方图",
      );
    }
    try {
      return success(
        compareHeapHistogramReports(baselineResult.value, currentResult.value, {
          targetId: baselineArtifact.targetId,
          baselineArtifactId: baselineArtifact.id,
          currentArtifactId: currentArtifact.id,
        }),
      );
    } catch (error) {
      return failure(
        "HEAP_HISTOGRAM_COMPARISON_FAILED",
        error instanceof Error ? error.message : "无法对比 Heap 直方图快照",
      );
    }
  }

  async inspectThreadPoolTrendArtifact(
    artifactId: string,
  ): Promise<OperationResult<ThreadPoolTrendInspectionReport>> {
    const artifact = this.#store.getArtifact(artifactId);
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (
      !artifact ||
      !artifactPath ||
      artifact.type !== "THREAD_POOL_TREND" ||
      artifact.status !== "READY"
    ) {
      return failure(
        "THREAD_POOL_TREND_ARTIFACT_NOT_FOUND",
        "线程池趋势制品不存在或尚未就绪",
      );
    }
    try {
      const [canonicalRoot, canonicalPath] = await Promise.all([
        realpath(this.#artifactRoot),
        realpath(artifactPath),
      ]);
      if (!isPathInsideRoot(canonicalRoot, canonicalPath)) {
        return failure(
          "UNSAFE_THREAD_POOL_TREND_PATH",
          "线程池趋势路径超出受控制品目录",
        );
      }
      if (path.extname(canonicalPath).toLocaleLowerCase() !== ".json") {
        return failure(
          "UNSUPPORTED_THREAD_POOL_TREND_ARTIFACT",
          "制品不是探微线程池趋势 JSON",
        );
      }
      const fileStat = await statFile(canonicalPath);
      if (
        fileStat.size <= 0 ||
        fileStat.size > MAXIMUM_THREAD_POOL_TREND_ARTIFACT_BYTES
      ) {
        return failure(
          "THREAD_POOL_TREND_SIZE_INVALID",
          "线程池趋势为空或超过 256 KiB 应用内检查上限",
        );
      }
      if (fileStat.size !== artifact.size) {
        return failure(
          "ARTIFACT_SIZE_MISMATCH",
          "线程池趋势大小与登记信息不一致",
        );
      }
      if ((await hashFile(canonicalPath)) !== artifact.sha256) {
        return failure("ARTIFACT_HASH_MISMATCH", "线程池趋势 SHA-256 校验失败");
      }
      const report = parseThreadPoolTrendArtifact(
        await readFile(canonicalPath, "utf8"),
        artifactId,
      );
      const endedAt = report.recording.samples.at(-1)?.capturedAt;
      if (
        report.recording.targetId !== artifact.targetId ||
        endedAt === undefined ||
        endedAt !== Date.parse(artifact.createdAt)
      ) {
        return failure(
          "THREAD_POOL_TREND_IDENTITY_MISMATCH",
          "线程池趋势内容与登记的目标或结束时间不一致",
        );
      }
      return success(report);
    } catch (error) {
      return failure(
        "THREAD_POOL_TREND_INSPECTION_FAILED",
        error instanceof Error ? error.message : "无法解析线程池趋势",
      );
    }
  }

  async inspectJitTrendArtifact(
    artifactId: string,
  ): Promise<OperationResult<JitTrendInspectionReport>> {
    const artifact = this.#store.getArtifact(artifactId);
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (
      !artifact ||
      !artifactPath ||
      artifact.type !== "JIT_TREND" ||
      artifact.status !== "READY"
    ) {
      return failure(
        "JIT_TREND_ARTIFACT_NOT_FOUND",
        "JIT 趋势制品不存在或尚未就绪",
      );
    }
    try {
      const [canonicalRoot, canonicalPath] = await Promise.all([
        realpath(this.#artifactRoot),
        realpath(artifactPath),
      ]);
      if (!isPathInsideRoot(canonicalRoot, canonicalPath)) {
        return failure("UNSAFE_JIT_TREND_PATH", "JIT 趋势路径超出受控制品目录");
      }
      if (path.extname(canonicalPath).toLocaleLowerCase() !== ".json") {
        return failure(
          "UNSUPPORTED_JIT_TREND_ARTIFACT",
          "制品不是探微 JIT 趋势 JSON",
        );
      }
      const fileStat = await statFile(canonicalPath);
      if (
        fileStat.size <= 0 ||
        fileStat.size > MAXIMUM_JIT_TREND_ARTIFACT_BYTES
      ) {
        return failure(
          "JIT_TREND_SIZE_INVALID",
          "JIT 趋势为空或超过 256 KiB 应用内检查上限",
        );
      }
      if (fileStat.size !== artifact.size) {
        return failure(
          "ARTIFACT_SIZE_MISMATCH",
          "JIT 趋势大小与登记信息不一致",
        );
      }
      if ((await hashFile(canonicalPath)) !== artifact.sha256) {
        return failure("ARTIFACT_HASH_MISMATCH", "JIT 趋势 SHA-256 校验失败");
      }
      const report = parseJitTrendArtifact(
        await readFile(canonicalPath, "utf8"),
        artifactId,
      );
      const endedAt = report.recording.samples.at(-1)?.sampledAtEpochMillis;
      if (
        report.recording.targetId !== artifact.targetId ||
        endedAt === undefined ||
        endedAt !== Date.parse(artifact.createdAt)
      ) {
        return failure(
          "JIT_TREND_IDENTITY_MISMATCH",
          "JIT 趋势内容与登记的目标或结束时间不一致",
        );
      }
      return success(report);
    } catch (error) {
      return failure(
        "JIT_TREND_INSPECTION_FAILED",
        error instanceof Error ? error.message : "无法解析 JIT 趋势",
      );
    }
  }

  async inspectObservationExportArtifact(
    artifactId: string,
  ): Promise<OperationResult<ObservationExportInspectionReport>> {
    const artifact = this.#store.getArtifact(artifactId);
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (
      !artifact ||
      !artifactPath ||
      (artifact.type !== "TRACE_HOTSPOTS" &&
        artifact.type !== "MONITOR_WINDOWS") ||
      artifact.status !== "READY"
    ) {
      return failure(
        "OBSERVATION_EXPORT_ARTIFACT_NOT_FOUND",
        "Trace/Monitor 导出制品不存在或尚未就绪",
      );
    }
    try {
      const [canonicalRoot, canonicalPath] = await Promise.all([
        realpath(this.#artifactRoot),
        realpath(artifactPath),
      ]);
      if (!isPathInsideRoot(canonicalRoot, canonicalPath)) {
        return failure(
          "UNSAFE_OBSERVATION_EXPORT_PATH",
          "Trace/Monitor 导出路径超出受控制品目录",
        );
      }
      if (path.extname(canonicalPath).toLocaleLowerCase() !== ".json") {
        return failure(
          "UNSUPPORTED_OBSERVATION_EXPORT_ARTIFACT",
          "制品不是探微 Trace/Monitor 结构化 JSON",
        );
      }
      const fileStat = await statFile(canonicalPath);
      if (
        fileStat.size <= 0 ||
        fileStat.size > MAXIMUM_OBSERVATION_EXPORT_ARTIFACT_BYTES
      ) {
        return failure(
          "OBSERVATION_EXPORT_SIZE_INVALID",
          "Trace/Monitor 导出为空或超过 512 KiB 检查上限",
        );
      }
      if (fileStat.size !== artifact.size) {
        return failure(
          "ARTIFACT_SIZE_MISMATCH",
          "Trace/Monitor 导出大小与登记信息不一致",
        );
      }
      if ((await hashFile(canonicalPath)) !== artifact.sha256) {
        return failure(
          "ARTIFACT_HASH_MISMATCH",
          "Trace/Monitor 导出 SHA-256 校验失败",
        );
      }
      const report = parseObservationExportArtifact(
        await readFile(canonicalPath, "utf8"),
        artifactId,
      );
      if (
        report.recording.targetId !== artifact.targetId ||
        report.recording.exportedAtEpochMillis !==
          Date.parse(artifact.createdAt) ||
        report.kind !== artifact.type
      ) {
        return failure(
          "OBSERVATION_EXPORT_IDENTITY_MISMATCH",
          "Trace/Monitor 导出内容与登记的类型、目标或时间不一致",
        );
      }
      return success(report);
    } catch (error) {
      return failure(
        "OBSERVATION_EXPORT_INSPECTION_FAILED",
        error instanceof Error ? error.message : "无法解析 Trace/Monitor 导出",
      );
    }
  }

  async compareThreadPoolTrendArtifacts(
    input: CompareThreadPoolTrendArtifactsInput,
  ): Promise<OperationResult<ThreadPoolTrendComparison>> {
    if (input.baselineArtifactId === input.currentArtifactId) {
      return failure(
        "THREAD_POOL_TREND_COMPARISON_REQUIRES_TWO_ARTIFACTS",
        "请选择两份不同的线程池趋势制品",
      );
    }
    const baselineArtifact = this.#store.getArtifact(input.baselineArtifactId);
    const currentArtifact = this.#store.getArtifact(input.currentArtifactId);
    if (
      !baselineArtifact ||
      !currentArtifact ||
      baselineArtifact.type !== "THREAD_POOL_TREND" ||
      currentArtifact.type !== "THREAD_POOL_TREND" ||
      baselineArtifact.status !== "READY" ||
      currentArtifact.status !== "READY"
    ) {
      return failure(
        "THREAD_POOL_TREND_COMPARISON_ARTIFACT_NOT_FOUND",
        "对比需要两份已就绪的线程池趋势制品",
      );
    }
    if (baselineArtifact.targetId !== currentArtifact.targetId) {
      return failure(
        "THREAD_POOL_TREND_COMPARISON_TARGET_MISMATCH",
        "只能对比同一目标 JVM 的线程池趋势",
      );
    }
    const [baselineResult, currentResult] = await Promise.all([
      this.inspectThreadPoolTrendArtifact(input.baselineArtifactId),
      this.inspectThreadPoolTrendArtifact(input.currentArtifactId),
    ]);
    if (!baselineResult.ok || !baselineResult.value) {
      return failure(
        baselineResult.errorCode ?? "THREAD_POOL_TREND_BASELINE_INVALID",
        baselineResult.errorMessage ?? "无法读取基线线程池趋势",
      );
    }
    if (!currentResult.ok || !currentResult.value) {
      return failure(
        currentResult.errorCode ?? "THREAD_POOL_TREND_CURRENT_INVALID",
        currentResult.errorMessage ?? "无法读取当前线程池趋势",
      );
    }
    try {
      return success(
        compareThreadPoolTrendReports(
          baselineResult.value,
          currentResult.value,
          {
            targetId: baselineArtifact.targetId,
            baselineArtifactId: baselineArtifact.id,
            currentArtifactId: currentArtifact.id,
          },
        ),
      );
    } catch (error) {
      return failure(
        "THREAD_POOL_TREND_COMPARISON_FAILED",
        error instanceof Error ? error.message : "无法对比线程池趋势",
      );
    }
  }

  async compareJitTrendArtifacts(
    input: CompareJitTrendArtifactsInput,
  ): Promise<OperationResult<JitTrendComparison>> {
    if (input.baselineArtifactId === input.currentArtifactId) {
      return failure(
        "JIT_TREND_COMPARISON_REQUIRES_TWO_ARTIFACTS",
        "请选择两份不同的 JIT 趋势制品",
      );
    }
    const baselineArtifact = this.#store.getArtifact(input.baselineArtifactId);
    const currentArtifact = this.#store.getArtifact(input.currentArtifactId);
    if (
      !baselineArtifact ||
      !currentArtifact ||
      baselineArtifact.type !== "JIT_TREND" ||
      currentArtifact.type !== "JIT_TREND" ||
      baselineArtifact.status !== "READY" ||
      currentArtifact.status !== "READY"
    ) {
      return failure(
        "JIT_TREND_COMPARISON_ARTIFACT_NOT_FOUND",
        "对比需要两份已就绪的 JIT 趋势制品",
      );
    }
    const mode = input.mode ?? "SAME_JVM";
    if (
      mode === "SAME_JVM" &&
      baselineArtifact.targetId !== currentArtifact.targetId
    ) {
      return failure(
        "JIT_TREND_COMPARISON_TARGET_MISMATCH",
        "只能对比同一目标 JVM 的 JIT 趋势",
      );
    }
    const [baselineResult, currentResult] = await Promise.all([
      this.inspectJitTrendArtifact(input.baselineArtifactId),
      this.inspectJitTrendArtifact(input.currentArtifactId),
    ]);
    if (!baselineResult.ok || !baselineResult.value) {
      return failure(
        baselineResult.errorCode ?? "JIT_TREND_BASELINE_INVALID",
        baselineResult.errorMessage ?? "无法读取基线 JIT 趋势",
      );
    }
    if (!currentResult.ok || !currentResult.value) {
      return failure(
        currentResult.errorCode ?? "JIT_TREND_CURRENT_INVALID",
        currentResult.errorMessage ?? "无法读取当前 JIT 趋势",
      );
    }
    try {
      return success(
        compareJitTrendReports(baselineResult.value, currentResult.value, {
          baselineArtifactId: baselineArtifact.id,
          currentArtifactId: currentArtifact.id,
          mode,
        }),
      );
    } catch (error) {
      return failure(
        "JIT_TREND_COMPARISON_FAILED",
        error instanceof Error ? error.message : "无法对比 JIT 趋势",
      );
    }
  }

  async revealArtifact(
    artifactId: string,
    confirmed: boolean,
  ): Promise<OperationResult<null>> {
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "显示外部文件前需要明确确认");
    }
    const verified = await this.verifyArtifact(artifactId);
    const artifactPath = this.#store.getArtifactPath(artifactId);
    if (!verified.ok || !artifactPath) {
      return failure(
        verified.errorCode ?? "ARTIFACT_NOT_FOUND",
        verified.errorMessage ?? "制品不存在",
      );
    }
    shell.showItemInFolder(artifactPath);
    return success(null);
  }

  async #verifyCapacity(bytesToWrite: number): Promise<OperationResult<null>> {
    const existingBytes = this.#store
      .listArtifacts()
      .filter((artifact) => artifact.status === "READY")
      .reduce((total, artifact) => total + artifact.size, 0);
    if (
      existingBytes + bytesToWrite >
      this.#store.getSettings().artifactQuotaBytes
    ) {
      return failure("ARTIFACT_QUOTA_EXCEEDED", "本地制品配额不足");
    }
    const fileSystem = await statfs(this.#artifactRoot);
    const freeBytes = fileSystem.bavail * fileSystem.bsize;
    if (freeBytes - bytesToWrite < MINIMUM_FREE_SPACE_BYTES) {
      return failure("INSUFFICIENT_DISK_SPACE", "磁盘余量不足，已拒绝创建制品");
    }
    return success(null);
  }

  async #cleanInterruptedArtifacts(): Promise<void> {
    const entries = await readdir(this.#artifactRoot, {
      withFileTypes: true,
    });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() && /^\.[a-f0-9-]{36}\.partial$/u.test(entry.name),
        )
        .map((entry) =>
          unlink(path.join(this.#artifactRoot, entry.name)).catch(
            () => undefined,
          ),
        ),
    );
  }

  async #cleanExpiredArtifacts(): Promise<void> {
    const retentionDays = this.#store.getSettings().retentionDays;
    if (retentionDays <= 0) {
      return;
    }
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1_000;
    for (const artifact of this.#store.listArtifacts()) {
      const createdAt = Date.parse(artifact.createdAt);
      if (!Number.isFinite(createdAt) || createdAt >= cutoff) {
        continue;
      }
      const artifactPath = this.#store.getArtifactPath(artifact.id);
      if (!artifactPath || !this.#isManagedArtifactPath(artifactPath)) {
        continue;
      }
      try {
        await unlink(artifactPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        });
        this.#store.deleteArtifact(artifact.id);
      } catch {
        // Retention cleanup is best effort; a locked file remains registered.
      }
    }
  }

  #isManagedArtifactPath(artifactPath: string): boolean {
    const relative = path.relative(this.#artifactRoot, artifactPath);
    return (
      relative.length > 0 &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep + ".." + path.sep)
    );
  }
}

function artifactName(
  type: CollectAgentArtifactInput["type"],
  createdAt: string,
  id: string,
): string {
  const typeName = type.toLowerCase().replaceAll("_", "-");
  const extensionByType: Readonly<
    Record<CollectAgentArtifactInput["type"], string>
  > = {
    JFR: ".jfr",
    HEAP_DUMP: ".hprof",
    PROFILE: ".html",
    CLASS_DUMP: ".class",
    THREAD_DUMP: ".txt",
  };
  const timestamp = createdAt.replaceAll(/[:.]/gu, "-");
  return `tanwei-${typeName}-${timestamp}-${id.slice(0, 8)}${extensionByType[type]}`;
}

async function statFile(filePath: string): Promise<{ readonly size: number }> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error("制品路径不是普通文件");
  }
  return { size: fileStat.size };
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function javaRelease(version: string | null): number | null {
  if (!version) {
    return null;
  }
  const legacy = /^1\.(\d+)(?:[._-]|$)/u.exec(version.trim());
  const modern = /^(\d+)(?:[._-]|$)/u.exec(version.trim());
  const parsed = Number.parseInt(legacy?.[1] ?? modern?.[1] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 8 && parsed <= 99
    ? parsed
    : null;
}

function redactSensitiveText(value: string): {
  readonly value: string;
  readonly count: number;
} {
  let count = 0;
  const patterns: readonly RegExp[] = [
    /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu,
    /\b(password|passwd|secret|token|credential|api[_-]?key)\b\s*[:=]\s*([^\s,;]+)/giu,
    /\b[A-Fa-f0-9]{32,}\b/gu,
  ];
  let redacted = value;
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, (match, label?: string) => {
      count += 1;
      return label ? `${label}=<redacted>` : "<redacted>";
    });
  }
  return { value: redacted, count };
}

function parseCaseExport(value: unknown): {
  readonly title: string;
  readonly notes: string;
  readonly tags: readonly string[];
} {
  if (!value || typeof value !== "object") {
    throw new Error("案例导入文件不是有效对象");
  }
  const root = value as Record<string, unknown>;
  if (
    root.schemaVersion !== 1 ||
    root.product !== "tanwei" ||
    !root.case ||
    typeof root.case !== "object"
  ) {
    throw new Error("案例导入文件版本或产品标识不受支持");
  }
  const diagnosticCase = root.case as Record<string, unknown>;
  const title =
    typeof diagnosticCase.title === "string" ? diagnosticCase.title.trim() : "";
  const notes =
    typeof diagnosticCase.notes === "string" ? diagnosticCase.notes.trim() : "";
  const tags = Array.isArray(diagnosticCase.tags)
    ? diagnosticCase.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 19)
    : [];
  if (!title || title.length > 200 || notes.length > 20_000) {
    throw new Error("案例导入字段超出允许范围");
  }
  return { title, notes, tags };
}
