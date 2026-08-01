import {
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  ActionResult,
  CreateDiagnosticTemplateInput,
  DiagnosticTemplate,
  ImportPreview,
  MultiTargetComparison,
  OperationResult,
  PluginDescriptor,
  TargetComparisonDelta,
  TeamPolicyDescriptor,
} from "../shared/contracts.js";
import {
  diagnosticTemplateSignedPayload,
  pluginPackageSchema,
  publicKeyFingerprint,
  signCanonical,
  teamPolicyPackageSchema,
  verifyDiagnosticTemplate,
  verifyPluginPackage,
  verifyTeamPolicy,
  type PluginPackage,
  type TeamPolicyPackage,
} from "./governance-signatures.js";
import type { LocalStore } from "./local-store.js";
import {
  PolicyError,
  validateDiagnosticTemplateAction,
} from "./policy-engine.js";
import type { TargetService } from "./target-service.js";

const IMPORT_LIMIT_BYTES = 1024 * 1024;
const IMPORT_TTL_MILLIS = 5 * 60_000;
const MAXIMUM_PENDING_IMPORTS = 20;
const PLUGIN_MANIFEST = "tanwei-plugin.json";

interface PendingPluginImport {
  readonly kind: "PLUGIN";
  readonly plugin: PluginPackage;
  readonly descriptor: PluginDescriptor;
  readonly expiresAt: string;
}

interface PendingTeamPolicyImport {
  readonly kind: "TEAM_POLICY";
  readonly policy: TeamPolicyPackage;
  readonly descriptor: TeamPolicyDescriptor;
  readonly expiresAt: string;
}

type PendingImport = PendingPluginImport | PendingTeamPolicyImport;

function success<T>(value: T): OperationResult<T> {
  return {
    ok: true,
    value,
    errorCode: null,
    errorMessage: null,
  };
}

function failure<T>(errorCode: string, errorMessage: string): OperationResult<T> {
  return {
    ok: false,
    value: null,
    errorCode,
    errorMessage,
  };
}

export class GovernanceService {
  readonly #store: LocalStore;
  readonly #targetService: TargetService;
  readonly #pluginsRoot: string;
  readonly #privateKey;
  readonly #publicKey: string;
  readonly #publicKeyFingerprint: string;
  readonly #pending = new Map<string, PendingImport>();

  private constructor(
    store: LocalStore,
    targetService: TargetService,
    pluginsRoot: string,
  ) {
    this.#store = store;
    this.#targetService = targetService;
    this.#pluginsRoot = pluginsRoot;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.#privateKey = privateKey;
    this.#publicKey = publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    this.#publicKeyFingerprint = publicKeyFingerprint(this.#publicKey);
  }

  static async open(
    userDataRoot: string,
    store: LocalStore,
    targetService: TargetService,
  ): Promise<GovernanceService> {
    const pluginsRoot = path.join(userDataRoot, "plugins");
    await mkdir(pluginsRoot, { recursive: true, mode: 0o700 });
    return new GovernanceService(store, targetService, pluginsRoot);
  }

  async compareTargets(
    targetIds: readonly string[],
  ): Promise<OperationResult<MultiTargetComparison>> {
    const uniqueTargetIds = [...new Set(targetIds)];
    if (
      uniqueTargetIds.length < 2 ||
      uniqueTargetIds.length > 8
    ) {
      return failure(
        "INVALID_COMPARISON_TARGETS",
        "多目标对比必须选择 2 至 8 个不同的已连接 JVM",
      );
    }
    const connections = new Map(
      this.#targetService
        .listConnections()
        .map((connection) => [connection.target.id, connection]),
    );
    const selected = uniqueTargetIds.map((targetId) =>
      connections.get(targetId),
    );
    if (selected.some((connection) => connection?.state !== "READY")) {
      return failure(
        "COMPARISON_TARGET_NOT_READY",
        "所有对比目标都必须处于已连接状态",
      );
    }
    const snapshots = await Promise.all(
      uniqueTargetIds.map((targetId) =>
        this.#targetService.getSnapshot(targetId),
      ),
    );
    const failed = snapshots.find(
      (result) => !result.ok || !result.value,
    );
    if (failed) {
      return failure(
        failed.errorCode ?? "COMPARISON_SNAPSHOT_FAILED",
        failed.errorMessage ?? "无法采集多目标对比快照",
      );
    }
    const values = snapshots.map((result) => result.value!);
    const baseline = values[0]!;
    const capturedAt = new Date().toISOString();
    return success({
      capturedAt,
      baselineTargetId: uniqueTargetIds[0]!,
      rows: values.map((snapshot, index) => {
        const connection = selected[index]!;
        return {
          targetId: connection.target.id,
          displayName: connection.target.displayName,
          pid: connection.target.pid,
          javaVersion: connection.javaVersion,
          snapshot,
          deltaFromBaseline: comparisonDelta(snapshot, baseline),
        };
      }),
    });
  }

  async listDiagnosticTemplates(): Promise<
    OperationResult<readonly DiagnosticTemplate[]>
  > {
    try {
      const local = this.#store.listDiagnosticTemplates().map((template) => ({
        ...template,
        verified: verifyDiagnosticTemplate(template),
      }));
      const pluginTemplates = (
        await Promise.all(
          (await this.#readPlugins()).map(({ plugin, installedAt }) =>
            this.#pluginTemplates(plugin, installedAt),
          ),
        )
      ).flat();
      return success([...local, ...pluginTemplates]);
    } catch (error) {
      return failure(
        "TEMPLATE_LIST_FAILED",
        error instanceof Error ? error.message : "无法读取诊断模板",
      );
    }
  }

  createSignedDiagnosticTemplate(
    input: CreateDiagnosticTemplateInput,
  ): OperationResult<DiagnosticTemplate> {
    try {
      const action = validateDiagnosticTemplateAction(
        input.actionId,
        input.parameters,
      );
      const unsigned: Omit<
        DiagnosticTemplate,
        "verified" | "signature"
      > = {
        id: randomUUID(),
        name: input.name.trim(),
        description: input.description.trim(),
        actionId: action.actionId,
        parameters: action.parameters,
        riskLevel: action.riskLevel,
        source: "LOCAL",
        signer: "Tanwei local session",
        publicKey: this.#publicKey,
        publicKeyFingerprint: this.#publicKeyFingerprint,
        createdAt: new Date().toISOString(),
      };
      const template: DiagnosticTemplate = {
        ...unsigned,
        signature: signCanonical(
          this.#privateKey,
          diagnosticTemplateSignedPayload(unsigned),
        ),
        verified: true,
      };
      this.#store.insertDiagnosticTemplate(template);
      return success(template);
    } catch (error) {
      return failure(
        error instanceof PolicyError
          ? error.code
          : "TEMPLATE_CREATE_FAILED",
        error instanceof Error ? error.message : "无法创建签名诊断模板",
      );
    }
  }

  deleteDiagnosticTemplate(
    templateId: string,
    confirmed: boolean,
  ): OperationResult<null> {
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "删除诊断模板需要明确确认");
    }
    if (templateId.startsWith("plugin:")) {
      return failure(
        "PLUGIN_TEMPLATE_READ_ONLY",
        "插件模板只可通过卸载对应插件移除",
      );
    }
    try {
      return this.#store.deleteDiagnosticTemplate(templateId)
        ? success(null)
        : failure("TEMPLATE_NOT_FOUND", "诊断模板不存在");
    } catch (error) {
      return failure(
        "TEMPLATE_DELETE_FAILED",
        error instanceof Error ? error.message : "无法删除诊断模板",
      );
    }
  }

  async executeDiagnosticTemplate(
    templateId: string,
    targetId: string,
    confirmed: boolean,
  ): Promise<OperationResult<ActionResult>> {
    try {
      const template = await this.#resolveTemplate(templateId);
      if (!template) {
        return failure("TEMPLATE_NOT_FOUND", "诊断模板不存在");
      }
      if (!template.verified) {
        return failure(
          "TEMPLATE_SIGNATURE_INVALID",
          "诊断模板签名无效，已拒绝执行",
        );
      }
      if (template.riskLevel === "R1" && !confirmed) {
        return failure(
          "CONFIRMATION_REQUIRED",
          "R1 诊断模板需要逐次确认后执行",
        );
      }
      return this.#targetService.executeAction({
        targetId,
        actionId: template.actionId,
        parameters: template.parameters,
      });
    } catch (error) {
      return failure(
        "TEMPLATE_EXECUTION_FAILED",
        error instanceof Error ? error.message : "无法执行诊断模板",
      );
    }
  }

  async listPlugins(): Promise<
    OperationResult<readonly PluginDescriptor[]>
  > {
    try {
      return success(
        (await this.#readPlugins()).map(({ plugin, installedAt }) =>
          pluginDescriptor(plugin, installedAt),
        ),
      );
    } catch (error) {
      return failure(
        "PLUGIN_LIST_FAILED",
        error instanceof Error ? error.message : "无法读取插件目录",
      );
    }
  }

  async previewPluginImport(
    sourcePath: string,
  ): Promise<OperationResult<ImportPreview<PluginDescriptor>>> {
    try {
      const plugin = pluginPackageSchema.parse(
        JSON.parse(await readBoundedJson(sourcePath)),
      );
      if (!verifyPluginPackage(plugin)) {
        return failure(
          "PLUGIN_SIGNATURE_INVALID",
          "插件清单的 Ed25519 签名无效",
        );
      }
      for (const template of plugin.templates) {
        validateDiagnosticTemplateAction(
          template.actionId,
          template.parameters,
        );
      }
      const expiresAt = new Date(
        Date.now() + IMPORT_TTL_MILLIS,
      ).toISOString();
      const previewId = randomUUID();
      const descriptor = pluginDescriptor(plugin, new Date().toISOString());
      this.#remember(previewId, {
        kind: "PLUGIN",
        plugin,
        descriptor,
        expiresAt,
      });
      return success({ previewId, value: descriptor, expiresAt });
    } catch (error) {
      return failure(
        error instanceof PolicyError
          ? error.code
          : "PLUGIN_IMPORT_FAILED",
        error instanceof Error ? error.message : "无法验证插件清单",
      );
    }
  }

  async installPlugin(
    previewId: string,
    confirmed: boolean,
  ): Promise<OperationResult<PluginDescriptor>> {
    const pending = this.#takePending(previewId, "PLUGIN");
    if (!pending.ok || !pending.value) {
      return failure(
        pending.errorCode ?? "PLUGIN_PREVIEW_EXPIRED",
        pending.errorMessage ?? "插件预览已过期",
      );
    }
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "安装插件需要确认签名预览");
    }
    const { plugin, descriptor } = pending.value;
    const pluginDirectory = this.#pluginDirectory(plugin.id);
    const manifestPath = path.join(pluginDirectory, PLUGIN_MANIFEST);
    if (await stat(manifestPath).catch(() => null)) {
      return failure(
        "PLUGIN_ALREADY_INSTALLED",
        "同名插件已安装；请先卸载旧版本再安装",
      );
    }
    const temporaryPath = path.join(
      pluginDirectory,
      `.${randomUUID()}.partial`,
    );
    let pluginDirectoryCreated = false;
    try {
      await mkdir(pluginDirectory, { recursive: false, mode: 0o700 });
      pluginDirectoryCreated = true;
      await writeFile(
        temporaryPath,
        `${JSON.stringify(plugin, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await rename(temporaryPath, manifestPath);
      return success(descriptor);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (pluginDirectoryCreated) {
        await rm(pluginDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      return failure(
        "PLUGIN_INSTALL_FAILED",
        error instanceof Error ? error.message : "无法安装插件",
      );
    }
  }

  async deletePlugin(
    pluginId: string,
    confirmed: boolean,
  ): Promise<OperationResult<null>> {
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "卸载插件需要明确确认");
    }
    const pluginDirectory = this.#pluginDirectory(pluginId);
    const manifestPath = path.join(pluginDirectory, PLUGIN_MANIFEST);
    if (!(await stat(manifestPath).catch(() => null))) {
      return failure("PLUGIN_NOT_FOUND", "插件不存在");
    }
    try {
      await rm(pluginDirectory, { recursive: true, force: false });
      return success(null);
    } catch (error) {
      return failure(
        "PLUGIN_DELETE_FAILED",
        error instanceof Error ? error.message : "无法卸载插件",
      );
    }
  }

  async previewTeamPolicyImport(
    sourcePath: string,
  ): Promise<OperationResult<ImportPreview<TeamPolicyDescriptor>>> {
    try {
      const policy = teamPolicyPackageSchema.parse(
        JSON.parse(await readBoundedJson(sourcePath)),
      );
      if (!verifyTeamPolicy(policy)) {
        return failure(
          "TEAM_POLICY_SIGNATURE_INVALID",
          "团队策略包的 Ed25519 签名无效",
        );
      }
      if (Date.parse(policy.issuedAt) > Date.now() + 5 * 60_000) {
        return failure(
          "TEAM_POLICY_NOT_YET_VALID",
          "团队策略签发时间晚于当前时间",
        );
      }
      if (
        policy.expiresAt &&
        Date.parse(policy.expiresAt) <= Date.now()
      ) {
        return failure("TEAM_POLICY_EXPIRED", "团队策略包已经过期");
      }
      const expiresAt = new Date(
        Date.now() + IMPORT_TTL_MILLIS,
      ).toISOString();
      const previewId = randomUUID();
      const descriptor = teamPolicyDescriptor(policy, null);
      this.#remember(previewId, {
        kind: "TEAM_POLICY",
        policy,
        descriptor,
        expiresAt,
      });
      return success({ previewId, value: descriptor, expiresAt });
    } catch (error) {
      return failure(
        "TEAM_POLICY_IMPORT_FAILED",
        error instanceof Error ? error.message : "无法验证团队策略包",
      );
    }
  }

  activateTeamPolicy(
    previewId: string,
    confirmed: boolean,
  ): OperationResult<TeamPolicyDescriptor> {
    const pending = this.#takePending(previewId, "TEAM_POLICY");
    if (!pending.ok || !pending.value) {
      return failure(
        pending.errorCode ?? "TEAM_POLICY_PREVIEW_EXPIRED",
        pending.errorMessage ?? "团队策略预览已过期",
      );
    }
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "启用团队策略需要确认签名预览");
    }
    try {
      const activatedAt = new Date().toISOString();
      return success(
        this.#store.setActiveTeamPolicy(
          pending.value.descriptor,
          activatedAt,
        ),
      );
    } catch (error) {
      return failure(
        "TEAM_POLICY_ACTIVATION_FAILED",
        error instanceof Error ? error.message : "无法启用团队策略",
      );
    }
  }

  getActiveTeamPolicy(): OperationResult<TeamPolicyDescriptor | null> {
    try {
      const policy = this.#store.getActiveTeamPolicy();
      if (!policy) {
        return success(null);
      }
      const verified =
        verifyTeamPolicy(policy) &&
        publicKeyFingerprint(policy.publicKey) ===
          policy.publicKeyFingerprint;
      return success({ ...policy, verified });
    } catch (error) {
      return failure(
        "TEAM_POLICY_READ_FAILED",
        error instanceof Error ? error.message : "无法读取团队策略",
      );
    }
  }

  removeTeamPolicy(confirmed: boolean): OperationResult<null> {
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "移除团队策略需要明确确认");
    }
    try {
      this.#store.clearActiveTeamPolicy();
      return success(null);
    } catch (error) {
      return failure(
        "TEAM_POLICY_REMOVE_FAILED",
        error instanceof Error ? error.message : "无法移除团队策略",
      );
    }
  }

  async #resolveTemplate(
    templateId: string,
  ): Promise<DiagnosticTemplate | null> {
    const local = this.#store.getDiagnosticTemplate(templateId);
    if (local) {
      return {
        ...local,
        verified: verifyDiagnosticTemplate(local),
      };
    }
    if (!templateId.startsWith("plugin:")) {
      return null;
    }
    const [, pluginId, pluginTemplateId] = templateId.split(":");
    if (!pluginId || !pluginTemplateId) {
      return null;
    }
    const installed = (await this.#readPlugins()).find(
      ({ plugin }) => plugin.id === pluginId,
    );
    if (!installed) {
      return null;
    }
    return (
      this.#pluginTemplates(installed.plugin, installed.installedAt).find(
        (template) => template.id === templateId,
      ) ?? null
    );
  }

  #pluginTemplates(
    plugin: PluginPackage,
    installedAt: string,
  ): readonly DiagnosticTemplate[] {
    const verified = verifyPluginPackage(plugin);
    const fingerprint = publicKeyFingerprint(plugin.publicKey);
    return plugin.templates.map((template) => {
      const action = validateDiagnosticTemplateAction(
        template.actionId,
        template.parameters,
      );
      return {
        id: `plugin:${plugin.id}:${template.id}`,
        name: template.name,
        description: template.description,
        actionId: action.actionId,
        parameters: action.parameters,
        riskLevel: action.riskLevel,
        source: "PLUGIN",
        signer: plugin.publisher,
        publicKey: plugin.publicKey,
        publicKeyFingerprint: fingerprint,
        signature: plugin.signature,
        verified,
        createdAt: installedAt,
      };
    });
  }

  async #readPlugins(): Promise<
    readonly { plugin: PluginPackage; installedAt: string }[]
  > {
    const entries = await readdir(this.#pluginsRoot, {
      withFileTypes: true,
    });
    const plugins: { plugin: PluginPackage; installedAt: string }[] = [];
    for (const entry of entries.slice(0, 100)) {
      if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{1,63}$/u.test(entry.name)) {
        continue;
      }
      const manifestPath = path.join(
        this.#pluginsRoot,
        entry.name,
        PLUGIN_MANIFEST,
      );
      try {
        const file = await stat(manifestPath);
        if (!file.isFile() || file.size > IMPORT_LIMIT_BYTES) {
          continue;
        }
        const plugin = pluginPackageSchema.parse(
          JSON.parse(await readFile(manifestPath, "utf8")),
        );
        if (
          plugin.id === entry.name &&
          verifyPluginPackage(plugin)
        ) {
          plugins.push({
            plugin,
            installedAt: file.mtime.toISOString(),
          });
        }
      } catch {
        // Invalid plugin directories are ignored and never executed.
      }
    }
    return plugins.sort((left, right) =>
      left.plugin.name.localeCompare(right.plugin.name),
    );
  }

  #pluginDirectory(pluginId: string): string {
    if (!/^[a-z][a-z0-9-]{1,63}$/u.test(pluginId)) {
      throw new Error("插件标识无效");
    }
    return path.join(this.#pluginsRoot, pluginId);
  }

  #remember(previewId: string, pending: PendingImport): void {
    this.#prune();
    while (this.#pending.size >= MAXIMUM_PENDING_IMPORTS) {
      const oldest = this.#pending.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.#pending.delete(oldest);
    }
    this.#pending.set(previewId, pending);
  }

  #takePending<TKind extends PendingImport["kind"]>(
    previewId: string,
    kind: TKind,
  ): OperationResult<Extract<PendingImport, { kind: TKind }>> {
    this.#prune();
    const pending = this.#pending.get(previewId);
    this.#pending.delete(previewId);
    if (!pending || pending.kind !== kind) {
      return failure(
        `${kind}_PREVIEW_EXPIRED`,
        "导入预览不存在、已过期或已经使用",
      );
    }
    return success(
      pending as Extract<PendingImport, { kind: TKind }>,
    );
  }

  #prune(): void {
    const now = Date.now();
    for (const [previewId, pending] of this.#pending) {
      if (Date.parse(pending.expiresAt) <= now) {
        this.#pending.delete(previewId);
      }
    }
  }
}

function comparisonDelta(
  snapshot: MultiTargetComparison["rows"][number]["snapshot"],
  baseline: MultiTargetComparison["rows"][number]["snapshot"],
): TargetComparisonDelta {
  return {
    processCpuLoad:
      snapshot.processCpuLoad === null || baseline.processCpuLoad === null
        ? null
        : snapshot.processCpuLoad - baseline.processCpuLoad,
    heapUsedBytes: snapshot.heapUsedBytes - baseline.heapUsedBytes,
    nonHeapUsedBytes:
      snapshot.nonHeapUsedBytes - baseline.nonHeapUsedBytes,
    liveThreads: snapshot.liveThreads - baseline.liveThreads,
    loadedClasses: snapshot.loadedClasses - baseline.loadedClasses,
    gcCount: snapshot.gcCount - baseline.gcCount,
    gcTimeMillis: snapshot.gcTimeMillis - baseline.gcTimeMillis,
  };
}

function pluginDescriptor(
  plugin: PluginPackage,
  installedAt: string,
): PluginDescriptor {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    apiVersion: plugin.apiVersion,
    description: plugin.description,
    publisher: plugin.publisher,
    publicKeyFingerprint: publicKeyFingerprint(plugin.publicKey),
    templateCount: plugin.templates.length,
    verified: verifyPluginPackage(plugin),
    installedAt,
  };
}

function teamPolicyDescriptor(
  policy: TeamPolicyPackage,
  activatedAt: string | null,
): TeamPolicyDescriptor {
  return {
    id: policy.id,
    name: policy.name,
    version: policy.version,
    apiVersion: policy.apiVersion,
    issuedAt: policy.issuedAt,
    expiresAt: policy.expiresAt,
    maximumRiskLevel: policy.maximumRiskLevel,
    deniedActions: policy.deniedActions,
    signer: policy.signer,
    publicKey: policy.publicKey,
    publicKeyFingerprint: publicKeyFingerprint(policy.publicKey),
    signature: policy.signature,
    verified: verifyTeamPolicy(policy),
    activatedAt,
  };
}

async function readBoundedJson(sourcePath: string): Promise<string> {
  const file = await stat(sourcePath);
  if (!file.isFile() || file.size > IMPORT_LIMIT_BYTES) {
    throw new Error("导入文件必须是小于 1 MiB 的普通文件");
  }
  return readFile(sourcePath, "utf8");
}
