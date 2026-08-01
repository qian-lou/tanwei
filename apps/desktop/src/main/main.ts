import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification as ElectronNotification,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import { z } from "zod";
import {
  IPC_CHANNELS,
  type AppExitReason,
  type OperationResult,
  type RuntimeInfo,
} from "../shared/contracts.js";
import { BUILD_METADATA } from "../shared/build-metadata.generated.js";
import { APP_FONT_FAMILY_VALUES } from "../shared/app-fonts.js";
import { verifyPackagedInstallation } from "./component-resolver.js";
import { TargetService } from "./target-service.js";
import { RemoteOrchestrator } from "./remote-orchestrator.js";
import { WorkspaceService } from "./workspace-service.js";
import { openProfileReportWindow } from "./profile-report-window.js";
import { heapHistogramSnapshotSchema } from "./heap-histogram-artifact.js";
import { threadPoolTrendRecordingSchema } from "./thread-pool-trend-artifact.js";
import { jitTrendRecordingSchema } from "./jit-trend-artifact.js";
import {
  createMonitorWindowsArtifactInputSchema,
  createTraceHotspotArtifactInputSchema,
} from "./observation-export-artifact.js";
import { UpdateService } from "./update-service.js";
import {
  SystemNotificationCoordinator,
  type SystemNotificationContent,
  type SystemNotificationGateway,
} from "./system-notification.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
nativeTheme.themeSource = "dark";
const targetService = new TargetService();
const remoteOrchestrator = new RemoteOrchestrator(targetService);
const updateService = new UpdateService();
let workspaceService: WorkspaceService | null = null;
let primaryWindow: BrowserWindow | null = null;
let quitCleanupStarted = false;
let quitApproved = false;
const systemNotificationCoordinator = new SystemNotificationCoordinator();
const activeSystemNotifications = new Set<ElectronNotification>();
const systemNotificationGateway: SystemNotificationGateway = {
  isSupported: () => ElectronNotification.isSupported(),
  show: (content, onClick) => {
    showElectronNotification(content, onClick);
  },
};
const targetIdSchema = z
  .string()
  .max(560)
  .regex(/^(?:local:\d+|remote:(?:ssh|kubernetes|persistent):[a-f0-9]{24})$/u);
const localIdSchema = z.string().uuid();
const compareThreadDumpArtifactsSchema = z
  .object({
    baselineArtifactId: localIdSchema,
    currentArtifactId: localIdSchema,
  })
  .strict();
const createHeapHistogramArtifactSchema = z
  .object({ snapshot: heapHistogramSnapshotSchema })
  .strict();
const createThreadPoolTrendArtifactSchema = z
  .object({ recording: threadPoolTrendRecordingSchema })
  .strict();
const createJitTrendArtifactSchema = z
  .object({
    recording: jitTrendRecordingSchema,
    regressionLabel: z
      .object({
        workloadKey: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .regex(/^[^\u0000-\u001f\u007f]+$/u),
        releaseLabel: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .regex(/^[^\u0000-\u001f\u007f]+$/u),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.recording.regressionIdentity) {
      context.addIssue({
        code: "custom",
        path: ["recording", "regressionIdentity"],
        message: "Regression identity must be derived by the Host",
      });
    }
  });
const compareHeapHistogramArtifactsSchema = z
  .object({
    baselineArtifactId: localIdSchema,
    currentArtifactId: localIdSchema,
  })
  .strict();
const compareThreadPoolTrendArtifactsSchema = z
  .object({
    baselineArtifactId: localIdSchema,
    currentArtifactId: localIdSchema,
  })
  .strict();
const compareJitTrendArtifactsSchema = z
  .object({
    baselineArtifactId: localIdSchema,
    currentArtifactId: localIdSchema,
    mode: z.enum(["SAME_JVM", "CROSS_RELEASE"]).optional(),
  })
  .strict();
const templateIdSchema = z.union([
  localIdSchema,
  z.string().regex(/^plugin:[a-z][a-z0-9-]{1,63}:[a-z][a-z0-9-]{1,63}$/u),
]);
const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u);
const pageRequestSchema = z
  .object({
    offset: z.number().int().min(0).max(1_000_000),
    limit: z.number().int().min(1).max(1_000),
    query: z.string().max(512),
  })
  .strict();
const threadQuerySchema = pageRequestSchema.extend({
  stackDepth: z.number().int().min(0).max(256),
  state: z.enum([
    "",
    "NEW",
    "RUNNABLE",
    "BLOCKED",
    "WAITING",
    "TIMED_WAITING",
    "TERMINATED",
  ]),
});
const threadPoolClassSchema = z.enum([
  "java.util.concurrent.ThreadPoolExecutor",
  "java.util.concurrent.ScheduledThreadPoolExecutor",
  "java.util.concurrent.ForkJoinPool",
]);
const threadPoolIdentityShape = {
  targetId: targetIdSchema,
  poolIdentity: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^(?:ThreadPoolExecutor|ScheduledThreadPoolExecutor|ForkJoinPool)@[0-9a-f]+$/u,
    ),
  poolClassName: threadPoolClassSchema,
};
const threadPoolAliasIdentitySchema = z
  .object(threadPoolIdentityShape)
  .strict()
  .superRefine(validateThreadPoolIdentityClass);
const threadPoolAliasInputSchema = z
  .object({
    ...threadPoolIdentityShape,
    alias: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
  })
  .strict()
  .superRefine(validateThreadPoolIdentityClass);
const classIdentitySchema = z
  .object({
    name: z.string().min(1).max(1_024),
    classLoader: z.string().min(1).max(4_096),
  })
  .strict();
const compileClassSourceSchema = z
  .object({
    targetId: targetIdSchema,
    className: z
      .string()
      .min(1)
      .max(1_024)
      .regex(/^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*[A-Za-z_$][A-Za-z0-9_$]*$/u),
    classLoader: z.string().min(1).max(4_096),
    source: z
      .string()
      .min(1)
      .max(1024 * 1024),
  })
  .strict();
const compileClassChangeSetSchema = z
  .object({
    targetId: targetIdSchema,
    items: z
      .array(
        z
          .object({
            className: z
              .string()
              .min(1)
              .max(1_024)
              .regex(
                /^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*[A-Za-z_$][A-Za-z0-9_$]*$/u,
              ),
            classLoader: z.string().min(1).max(4_096),
            source: z
              .string()
              .min(1)
              .max(1024 * 1024),
          })
          .strict(),
      )
      .min(2)
      .max(8),
  })
  .strict()
  .superRefine((value, context) => {
    const classLoader = value.items[0]?.classLoader;
    const identities = new Set<string>();
    for (const item of value.items) {
      if (item.classLoader !== classLoader) {
        context.addIssue({
          code: "custom",
          message: "变更集中的类必须来自同一个精确 ClassLoader",
          path: ["items"],
        });
        return;
      }
      const identity = `${item.className}\0${item.classLoader}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "变更集不能包含重复类",
          path: ["items"],
        });
        return;
      }
      identities.add(identity);
    }
  });
const replaceClassChangeSetDraftsSchema = z
  .object({
    targetId: targetIdSchema,
    items: z
      .array(
        z
          .object({
            className: z
              .string()
              .min(1)
              .max(1_024)
              .regex(
                /^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*[A-Za-z_$][A-Za-z0-9_$]*$/u,
              ),
            classLoader: z.string().min(1).max(4_096),
            source: z
              .string()
              .min(1)
              .max(1024 * 1024),
          })
          .strict(),
      )
      .max(8),
  })
  .strict()
  .superRefine((value, context) => {
    const classLoader = value.items[0]?.classLoader;
    const identities = new Set<string>();
    for (const item of value.items) {
      if (item.classLoader !== classLoader) {
        context.addIssue({
          code: "custom",
          message: "类变更集草稿必须来自同一个精确 ClassLoader",
          path: ["items"],
        });
        return;
      }
      const identity = `${item.className}\0${item.classLoader}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "类变更集草稿不能包含重复类",
          path: ["items"],
        });
        return;
      }
      identities.add(identity);
    }
  });
const actionRequestSchema = z
  .object({
    targetId: targetIdSchema,
    actionId: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
    contractVersion: z.string().min(1).max(16).optional(),
    parameters: z.record(z.string().max(128), z.string().max(2_800_000)),
  })
  .strict();
const createCaseSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(20_000),
    tags: z
      .array(z.string().trim().min(1).max(40))
      .max(20)
      .transform((tags) => [...new Set(tags)]),
  })
  .strict();
const actionAuditQuerySchema = z
  .object({
    offset: z.number().int().min(0).max(1_000_000),
    limit: z.number().int().min(1).max(100),
    query: z
      .string()
      .trim()
      .max(256)
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/u.test(value),
        "审计搜索不能包含控制字符",
      ),
    targetId: z.union([z.literal(""), targetIdSchema]),
    status: z.enum(["ALL", "SUCCEEDED", "FAILED"]),
    riskLevel: z.enum(["ALL", "R0", "R1", "R2", "R3", "R4"]),
  })
  .strict();
const saveInvocationSnapshotSchema = z
  .object({
    targetId: targetIdSchema,
    snapshotId: z.number().int().min(1).max(1_000_000_000),
  })
  .strict();
const persistedInvocationSnapshotQuerySchema = z
  .object({
    offset: z.number().int().min(0).max(1_000_000),
    limit: z.number().int().min(1).max(50),
    query: z
      .string()
      .trim()
      .max(256)
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/u.test(value),
        "调用档案搜索不能包含控制字符",
      ),
    targetId: z.union([z.literal(""), targetIdSchema]),
    outcome: z.enum(["ALL", "RETURNED", "THREW"]),
    scope: z.enum(["ROOT", "ALL"]),
  })
  .strict();
const updateCaseEvidenceSchema = z
  .object({
    caseId: localIdSchema,
    artifactIds: z
      .array(localIdSchema)
      .max(500)
      .transform((values) => [...new Set(values)]),
    actionTaskIds: z
      .array(localIdSchema)
      .max(500)
      .transform((values) => [...new Set(values)]),
  })
  .strict();
const collectAgentArtifactSchema = z
  .object({
    targetId: targetIdSchema,
    token: z.string().uuid(),
    type: z.enum(["JFR", "HEAP_DUMP", "PROFILE", "CLASS_DUMP", "THREAD_DUMP"]),
    expectedSize: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024),
  })
  .strict();
const appSettingsSchema = z
  .object({
    locale: z.enum(["zh-CN", "en-US"]),
    fontFamily: z.enum(APP_FONT_FAMILY_VALUES),
    defaultSamplingIntervalMillis: z.union([
      z.literal(1_000),
      z.literal(2_000),
      z.literal(5_000),
      z.literal(10_000),
    ]),
    artifactQuotaBytes: z
      .number()
      .int()
      .min(100 * 1024 * 1024)
      .max(1024 * 1024 * 1024 * 1024),
    retentionDays: z.number().int().min(0).max(3_650),
    updatePolicy: z.enum(["NOTIFY", "MANUAL"]),
    maximumRiskLevel: z.enum(["R2", "R3", "R4"]),
    systemNotificationPolicy: z.enum([
      "OFF",
      "CRITICAL_ONLY",
      "WARNING_AND_CRITICAL",
    ]),
  })
  .strict();
const sshAuthenticationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("PASSWORD"),
      password: z.string().min(1).max(65_536),
    })
    .strict(),
  z
    .object({
      kind: z.literal("PRIVATE_KEY"),
      privateKey: z
        .string()
        .min(1)
        .max(1024 * 1024),
      passphrase: z.string().max(65_536),
    })
    .strict(),
]);
const sshRemotePreviewSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9._:[\]-]+$/u),
    port: z.number().int().min(1).max(65_535),
    username: z.string().trim().min(1).max(128),
    authentication: sshAuthenticationSchema,
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const kubernetesContextSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const kubernetesResourceSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9._:/@-]+$/u);
const kubernetesRemotePreviewSchema = z
  .object({
    context: kubernetesContextSchema,
    namespace: kubernetesResourceSchema,
    pod: kubernetesResourceSchema,
    container: kubernetesResourceSchema,
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const persistentRelayPreviewSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9._:[\]-]+$/u),
    port: z.number().int().min(1).max(65_535),
    serverName: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9._-]+$/u),
    caCertificate: z
      .string()
      .min(80)
      .max(1024 * 1024),
    clientCertificate: z
      .string()
      .min(80)
      .max(1024 * 1024),
    clientPrivateKey: z
      .string()
      .min(80)
      .max(1024 * 1024),
    sessionSecret: z.string().regex(/^[a-f0-9]{64}$/u),
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    displayName: z.string().trim().max(200),
  })
  .strict();
const comparisonTargetsSchema = z
  .array(targetIdSchema)
  .min(2)
  .max(8)
  .refine(
    (values) => new Set(values).size === values.length,
    "对比目标不能重复",
  );
const createDiagnosticTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000),
    actionId: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u),
    parameters: z.record(z.string().min(1).max(128), z.string().max(4_096)),
  })
  .strict();
const resolveAppExitSchema = z
  .object({
    reason: z.enum(["WINDOW_CLOSE", "APP_QUIT"]),
    mode: z.enum(["CLOSE_WINDOW", "QUIT_APP"]),
  })
  .strict();

if (
  process.env.TANWEI_E2E === "1" &&
  process.env.TANWEI_USER_DATA_DIR?.trim()
) {
  app.setPath("userData", path.resolve(process.env.TANWEI_USER_DATA_DIR));
}

function validateTargetId(
  _event: IpcMainInvokeEvent,
  targetId: unknown,
): string {
  return targetIdSchema.parse(targetId);
}

function operationSuccess<T>(value: T): OperationResult<T> {
  return {
    ok: true,
    value,
    errorCode: null,
    errorMessage: null,
  };
}

function operationFailure<T>(
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

function validateThreadPoolIdentityClass(
  value: {
    readonly poolIdentity: string;
    readonly poolClassName:
      | "java.util.concurrent.ThreadPoolExecutor"
      | "java.util.concurrent.ScheduledThreadPoolExecutor"
      | "java.util.concurrent.ForkJoinPool";
  },
  context: z.RefinementCtx,
): void {
  const expectedPrefix =
    value.poolClassName === "java.util.concurrent.ThreadPoolExecutor"
      ? "ThreadPoolExecutor@"
      : value.poolClassName ===
          "java.util.concurrent.ScheduledThreadPoolExecutor"
        ? "ScheduledThreadPoolExecutor@"
        : "ForkJoinPool@";
  if (!value.poolIdentity.startsWith(expectedPrefix)) {
    context.addIssue({
      code: "custom",
      message: "线程池身份与类型不匹配",
      path: ["poolIdentity"],
    });
  }
}

async function resolveJvmStartTimeEpochMillis(
  targetId: string,
): Promise<OperationResult<number>> {
  const snapshot = await targetService.getSnapshot(targetId);
  if (!snapshot.ok || !snapshot.value) {
    return operationFailure(
      snapshot.errorCode ?? "JVM_IDENTITY_UNAVAILABLE",
      snapshot.errorMessage ?? "无法读取 JVM 启动身份",
    );
  }
  const value = snapshot.value.jvmStartTimeEpochMillis;
  if (!Number.isSafeInteger(value) || value <= 0) {
    return operationFailure(
      "JVM_IDENTITY_UNAVAILABLE",
      "目标 JVM 未提供可信启动时间，已拒绝读写目标绑定的本地数据",
    );
  }
  return operationSuccess(value);
}

function sendExitRequest(owner: BrowserWindow, reason: AppExitReason): boolean {
  if (owner.isDestroyed() || owner.webContents.isDestroyed()) {
    return false;
  }
  if (reason === "APP_QUIT" && !owner.isVisible()) {
    owner.show();
    owner.focus();
  }
  owner.webContents.send(IPC_CHANNELS.appExitRequested, reason);
  return true;
}

function showElectronNotification(
  content: SystemNotificationContent,
  onClick: () => void,
): void {
  const notification = new ElectronNotification({
    title: content.title,
    body: content.body,
    silent: false,
  });
  const release = (): void => {
    activeSystemNotifications.delete(notification);
  };
  activeSystemNotifications.add(notification);
  notification.once("click", () => {
    onClick();
    notification.close();
  });
  notification.once("close", release);
  notification.once("failed", release);
  try {
    notification.show();
  } catch (error) {
    release();
    throw error;
  }
}

function deliverSystemNotificationForArtifact(
  workspace: WorkspaceService,
  artifactId: string,
): void {
  const settings = workspace.getSettings();
  const alerts = workspace.listDiagnosticAlerts();
  if (!settings.ok || !settings.value || !alerts.ok || !alerts.value) {
    return;
  }
  const alert = alerts.value.find(
    (candidate) => candidate.artifactId === artifactId,
  );
  if (!alert) {
    return;
  }
  const owner = primaryWindow;
  systemNotificationCoordinator.deliver({
    alert,
    policy: settings.value.systemNotificationPolicy,
    locale: settings.value.locale,
    window: {
      visible: Boolean(owner && !owner.isDestroyed() && owner.isVisible()),
      focused: Boolean(owner && !owner.isDestroyed() && owner.isFocused()),
      minimized: Boolean(owner && !owner.isDestroyed() && owner.isMinimized()),
    },
    gateway: systemNotificationGateway,
    onClick: (clickedAlert) => {
      workspace.acknowledgeDiagnosticAlert(clickedAlert.id);
      sendDiagnosticAlertsChanged();
      if (clickedAlert.artifactId) {
        openDiagnosticEvidence(clickedAlert.artifactId);
      }
    },
  });
}

function sendDiagnosticAlertsChanged(): void {
  const owner = primaryWindow;
  if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) {
    owner.webContents.send(IPC_CHANNELS.diagnosticAlertsChanged);
  }
}

function openDiagnosticEvidence(artifactId: string): void {
  const owner = primaryWindow;
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) {
    return;
  }
  if (owner.isMinimized()) {
    owner.restore();
  }
  if (!owner.isVisible()) {
    owner.show();
  }
  owner.focus();
  const send = (): void => {
    if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) {
      owner.webContents.send(IPC_CHANNELS.openDiagnosticEvidence, artifactId);
    }
  };
  if (owner.webContents.isLoadingMainFrame()) {
    owner.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function startQuitCleanup(): void {
  if (quitCleanupStarted) {
    return;
  }
  quitCleanupStarted = true;
  void targetService.closeAll().finally(() => {
    try {
      workspaceService?.close();
      workspaceService = null;
    } finally {
      app.quit();
    }
  });
}

function runtimeInfo(): RuntimeInfo {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    architecture: process.arch,
    electronVersion: process.versions.electron ?? "unknown",
    chromeVersion: process.versions.chrome ?? "unknown",
    nodeVersion: process.versions.node,
    components: {
      host: app.getVersion(),
      agent: BUILD_METADATA.productVersion,
      protocol: BUILD_METADATA.protocolVersion,
      relay: BUILD_METADATA.productVersion,
      decompiler: "CFR " + BUILD_METADATA.decompilerVersion,
      profiler:
        "async-profiler " +
        BUILD_METADATA.asyncProfilerVersion +
        " / Tanwei bounded fallback " +
        BUILD_METADATA.boundedProfilerVersion,
    },
  };
}

async function chooseJsonFile(
  event: IpcMainInvokeEvent,
  title: string,
  filterName: string,
): Promise<string | null> {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: OpenDialogOptions = {
    title,
    properties: ["openFile"],
    filters: [{ name: filterName, extensions: ["json"] }],
  };
  const selection = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  return selection.canceled ? null : (selection.filePaths[0] ?? null);
}

function registerIpcHandlers(workspace: WorkspaceService): void {
  ipcMain.handle(IPC_CHANNELS.runtimeInfo, runtimeInfo);
  ipcMain.handle(IPC_CHANNELS.getSettings, () => workspace.getSettings());
  ipcMain.handle(IPC_CHANNELS.updateSettings, (_event, settings: unknown) =>
    workspace.updateSettings(appSettingsSchema.parse(settings)),
  );
  ipcMain.handle(IPC_CHANNELS.listTargets, () => targetService.listTargets());
  ipcMain.handle(IPC_CHANNELS.listConnections, () => ({
    ok: true,
    value: targetService.listConnections(),
    errorCode: null,
    errorMessage: null,
  }));
  ipcMain.handle(IPC_CHANNELS.previewSshRemote, (_event, input: unknown) =>
    remoteOrchestrator.previewSsh(sshRemotePreviewSchema.parse(input)),
  );
  ipcMain.handle(IPC_CHANNELS.listKubernetesContexts, () =>
    remoteOrchestrator.listKubernetesContexts(),
  );
  ipcMain.handle(
    IPC_CHANNELS.listKubernetesNamespaces,
    (_event, context: unknown) =>
      remoteOrchestrator.listKubernetesNamespaces(
        kubernetesContextSchema.parse(context),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.listKubernetesPods,
    (_event, context: unknown, namespace: unknown) =>
      remoteOrchestrator.listKubernetesPods(
        kubernetesContextSchema.parse(context),
        kubernetesResourceSchema.parse(namespace),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.previewKubernetesRemote,
    (_event, input: unknown) =>
      remoteOrchestrator.previewKubernetes(
        kubernetesRemotePreviewSchema.parse(input),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.previewPersistentRelay,
    (_event, input: unknown) =>
      remoteOrchestrator.previewPersistent(
        persistentRelayPreviewSchema.parse(input),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.deployRemote,
    (_event, previewId: unknown, confirmed: unknown) =>
      remoteOrchestrator.deploy(
        localIdSchema.parse(previewId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.cancelRemotePreview,
    (_event, previewId: unknown) =>
      remoteOrchestrator.discard(localIdSchema.parse(previewId)),
  );
  ipcMain.handle(IPC_CHANNELS.connectTarget, (event, targetId: unknown) =>
    targetService.connectTarget(validateTargetId(event, targetId)),
  );
  ipcMain.handle(IPC_CHANNELS.disconnectTarget, (event, targetId: unknown) =>
    targetService.disconnectTarget(validateTargetId(event, targetId)),
  );
  ipcMain.handle(IPC_CHANNELS.getSnapshot, (event, targetId: unknown) =>
    targetService.getSnapshot(validateTargetId(event, targetId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.listThreads,
    (event, targetId: unknown, query: unknown) =>
      targetService.listThreads(
        validateTargetId(event, targetId),
        threadQuerySchema.parse(query),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.listClasses,
    (event, targetId: unknown, query: unknown) =>
      targetService.listClasses(
        validateTargetId(event, targetId),
        pageRequestSchema.parse(query),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.getClassDetails,
    (event, targetId: unknown, identity: unknown) => {
      const parsedIdentity = classIdentitySchema.parse(identity);
      return targetService.getClassDetails(
        validateTargetId(event, targetId),
        parsedIdentity.name,
        parsedIdentity.classLoader,
      );
    },
  );
  ipcMain.handle(IPC_CHANNELS.executeAction, (_event, request: unknown) => {
    const parsed = actionRequestSchema.safeParse(request);
    return parsed.success
      ? targetService.executeAction(parsed.data)
      : {
          ok: false,
          value: null,
          errorCode: "ACTION_REQUEST_INVALID",
          errorMessage: "Action 请求缺少必填字段或字段格式无效",
        };
  });
  ipcMain.handle(
    IPC_CHANNELS.getObservationEvents,
    (event, targetId: unknown, taskId: unknown) =>
      targetService.getObservationEvents(
        validateTargetId(event, targetId),
        localIdSchema.parse(taskId),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.cancelObservation,
    (event, targetId: unknown, taskId: unknown) =>
      targetService.cancelObservation(
        validateTargetId(event, targetId),
        localIdSchema.parse(taskId),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.listThreadPoolAliases,
    async (event, targetId: unknown) => {
      const validatedTargetId = validateTargetId(event, targetId);
      const identity = await resolveJvmStartTimeEpochMillis(validatedTargetId);
      return identity.ok && identity.value !== null
        ? workspace.listThreadPoolAliases(validatedTargetId, identity.value)
        : identity;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.upsertThreadPoolAlias,
    async (_event, input: unknown) => {
      const validated = threadPoolAliasInputSchema.parse(input);
      const identity = await resolveJvmStartTimeEpochMillis(validated.targetId);
      return identity.ok && identity.value !== null
        ? workspace.upsertThreadPoolAlias(validated, identity.value)
        : identity;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.deleteThreadPoolAlias,
    async (_event, input: unknown) => {
      const validated = threadPoolAliasIdentitySchema.parse(input);
      const identity = await resolveJvmStartTimeEpochMillis(validated.targetId);
      return identity.ok && identity.value !== null
        ? workspace.deleteThreadPoolAlias(validated, identity.value)
        : identity;
    },
  );
  ipcMain.handle(IPC_CHANNELS.listArtifacts, () => workspace.listArtifacts());
  ipcMain.handle(IPC_CHANNELS.listDiagnosticAlerts, () =>
    workspace.listDiagnosticAlerts(),
  );
  ipcMain.handle(IPC_CHANNELS.listJitRegressionBaselines, () =>
    workspace.listJitRegressionBaselines(),
  );
  ipcMain.handle(
    IPC_CHANNELS.acknowledgeDiagnosticAlert,
    (event, alertId: unknown) => {
      const result = workspace.acknowledgeDiagnosticAlert(
        localIdSchema.parse(alertId),
      );
      if (result.ok && !event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.diagnosticAlertsChanged);
      }
      return result;
    },
  );
  ipcMain.handle(IPC_CHANNELS.acknowledgeAllDiagnosticAlerts, (event) => {
    const result = workspace.acknowledgeAllDiagnosticAlerts();
    if (result.ok && !event.sender.isDestroyed()) {
      event.sender.send(IPC_CHANNELS.diagnosticAlertsChanged);
    }
    return result;
  });
  ipcMain.handle(
    IPC_CHANNELS.createSnapshotArtifact,
    (event, targetId: unknown) =>
      workspace.createSnapshotArtifact(validateTargetId(event, targetId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.createHeapHistogramArtifact,
    (_event, input: unknown) => {
      const validated = createHeapHistogramArtifactSchema.parse(input);
      validateTargetId(_event, validated.snapshot.targetId);
      return workspace.createHeapHistogramArtifact(validated);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.createThreadPoolTrendArtifact,
    (_event, input: unknown) => {
      const validated = createThreadPoolTrendArtifactSchema.parse(input);
      validateTargetId(_event, validated.recording.targetId);
      return workspace.createThreadPoolTrendArtifact(validated);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.createJitTrendArtifact,
    async (event, input: unknown) => {
      const validated = createJitTrendArtifactSchema.parse(input);
      validateTargetId(event, validated.recording.targetId);
      const { regressionIdentity, ...recording } = validated.recording;
      const result = await workspace.createJitTrendArtifact({
        recording: regressionIdentity
          ? { ...recording, regressionIdentity }
          : recording,
        regressionLabel: validated.regressionLabel,
      });
      if (result.ok && !event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.diagnosticAlertsChanged);
      }
      if (result.ok && result.value) {
        deliverSystemNotificationForArtifact(workspace, result.value.id);
      }
      return result;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.createTraceHotspotArtifact,
    (event, input: unknown) => {
      const validated = createTraceHotspotArtifactInputSchema.parse(input);
      validateTargetId(event, validated.targetId);
      return workspace.createTraceHotspotArtifact(validated);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.createMonitorWindowsArtifact,
    (event, input: unknown) => {
      const validated = createMonitorWindowsArtifactInputSchema.parse(input);
      validateTargetId(event, validated.targetId);
      return workspace.createMonitorWindowsArtifact(validated);
    },
  );
  ipcMain.handle(IPC_CHANNELS.collectAgentArtifact, (_event, input: unknown) =>
    workspace.collectAgentArtifact(collectAgentArtifactSchema.parse(input)),
  );
  ipcMain.handle(
    IPC_CHANNELS.decompileClassArtifact,
    (_event, artifactId: unknown) =>
      workspace.decompileClassArtifact(localIdSchema.parse(artifactId)),
  );
  ipcMain.handle(IPC_CHANNELS.compileClassSource, (_event, input: unknown) =>
    workspace.compileClassSource(compileClassSourceSchema.parse(input)),
  );
  ipcMain.handle(IPC_CHANNELS.compileClassChangeSet, (_event, input: unknown) =>
    workspace.compileClassChangeSet(compileClassChangeSetSchema.parse(input)),
  );
  ipcMain.handle(
    IPC_CHANNELS.listClassChangeSetDrafts,
    async (event, targetId: unknown) => {
      const validatedTargetId = validateTargetId(event, targetId);
      const identity = await resolveJvmStartTimeEpochMillis(validatedTargetId);
      return identity.ok && identity.value !== null
        ? workspace.listClassChangeSetDrafts(validatedTargetId, identity.value)
        : identity;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.replaceClassChangeSetDrafts,
    async (_event, input: unknown) => {
      const validated = replaceClassChangeSetDraftsSchema.parse(input);
      const identity = await resolveJvmStartTimeEpochMillis(validated.targetId);
      return identity.ok && identity.value !== null
        ? workspace.replaceClassChangeSetDrafts(
            validated.targetId,
            validated.items,
            identity.value,
          )
        : identity;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.deleteArtifact,
    (_event, artifactId: unknown, confirmed: unknown) =>
      workspace.deleteArtifact(
        localIdSchema.parse(artifactId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.verifyArtifact, (_event, artifactId: unknown) =>
    workspace.verifyArtifact(localIdSchema.parse(artifactId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.openProfileReport,
    async (event, artifactId: unknown) => {
      const resolved = await workspace.resolveProfileReport(
        localIdSchema.parse(artifactId),
      );
      if (!resolved.ok || !resolved.value) {
        return {
          ok: false,
          value: null,
          errorCode: resolved.errorCode,
          errorMessage: resolved.errorMessage,
        };
      }
      try {
        const settings = workspace.getSettings();
        await openProfileReportWindow(
          resolved.value,
          BrowserWindow.fromWebContents(event.sender),
          settings.ok && settings.value
            ? settings.value.fontFamily
            : undefined,
        );
        return {
          ok: true,
          value: null,
          errorCode: null,
          errorMessage: null,
        };
      } catch (error) {
        return {
          ok: false,
          value: null,
          errorCode: "PROFILE_REPORT_OPEN_FAILED",
          errorMessage:
            error instanceof Error ? error.message : "无法打开性能报告",
        };
      }
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.inspectJfrArtifact,
    (_event, artifactId: unknown) =>
      workspace.inspectJfrArtifact(localIdSchema.parse(artifactId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.inspectThreadDumpArtifact,
    (_event, artifactId: unknown) =>
      workspace.inspectThreadDumpArtifact(localIdSchema.parse(artifactId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.compareThreadDumpArtifacts,
    (_event, input: unknown) =>
      workspace.compareThreadDumpArtifacts(
        compareThreadDumpArtifactsSchema.parse(input),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.inspectHeapHistogramArtifact,
    (_event, artifactId: unknown) =>
      workspace.inspectHeapHistogramArtifact(localIdSchema.parse(artifactId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.compareHeapHistogramArtifacts,
    (_event, input: unknown) =>
      workspace.compareHeapHistogramArtifacts(
        compareHeapHistogramArtifactsSchema.parse(input),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.inspectThreadPoolTrendArtifact,
    (_event, artifactId: unknown) =>
      workspace.inspectThreadPoolTrendArtifact(localIdSchema.parse(artifactId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.inspectJitTrendArtifact,
    (_event, artifactId: unknown) =>
      workspace.inspectJitTrendArtifact(localIdSchema.parse(artifactId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.inspectObservationExportArtifact,
    (_event, artifactId: unknown) =>
      workspace.inspectObservationExportArtifact(
        localIdSchema.parse(artifactId),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.compareThreadPoolTrendArtifacts,
    (_event, input: unknown) =>
      workspace.compareThreadPoolTrendArtifacts(
        compareThreadPoolTrendArtifactsSchema.parse(input),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.compareJitTrendArtifacts,
    (_event, input: unknown) => {
      const validated = compareJitTrendArtifactsSchema.parse(input);
      const { mode, ...artifactIds } = validated;
      return workspace.compareJitTrendArtifacts(
        mode ? { ...artifactIds, mode } : artifactIds,
      );
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.revealArtifact,
    (_event, artifactId: unknown, confirmed: unknown) =>
      workspace.revealArtifact(
        localIdSchema.parse(artifactId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.listCases, () => workspace.listCases());
  ipcMain.handle(IPC_CHANNELS.listActionAudits, () =>
    workspace.listActionAudits(),
  );
  ipcMain.handle(IPC_CHANNELS.queryActionAudits, (_event, query: unknown) =>
    workspace.queryActionAudits(actionAuditQuerySchema.parse(query)),
  );
  ipcMain.handle(
    IPC_CHANNELS.saveInvocationSnapshot,
    (_event, input: unknown) =>
      workspace.saveInvocationSnapshot(
        saveInvocationSnapshotSchema.parse(input),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.queryPersistedInvocationSnapshots,
    (_event, query: unknown) =>
      workspace.queryPersistedInvocationSnapshots(
        persistedInvocationSnapshotQuerySchema.parse(query),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.getPersistedInvocationSnapshot,
    (_event, snapshotId: unknown) =>
      workspace.getPersistedInvocationSnapshot(
        localIdSchema.parse(snapshotId),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.deletePersistedInvocationSnapshot,
    (_event, snapshotId: unknown, confirmed: unknown) =>
      workspace.deletePersistedInvocationSnapshot(
        localIdSchema.parse(snapshotId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.createCase, (_event, input: unknown) =>
    workspace.createCase(createCaseSchema.parse(input)),
  );
  ipcMain.handle(IPC_CHANNELS.archiveCase, (_event, caseId: unknown) =>
    workspace.archiveCase(localIdSchema.parse(caseId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.deleteCase,
    (_event, caseId: unknown, confirmed: unknown) =>
      workspace.deleteCase(
        localIdSchema.parse(caseId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.getCaseEvidence, (_event, caseId: unknown) =>
    workspace.getCaseEvidence(localIdSchema.parse(caseId)),
  );
  ipcMain.handle(IPC_CHANNELS.updateCaseEvidence, (_event, input: unknown) =>
    workspace.updateCaseEvidence(updateCaseEvidenceSchema.parse(input)),
  );
  ipcMain.handle(IPC_CHANNELS.previewCaseExport, (_event, caseId: unknown) =>
    workspace.previewCaseExport(localIdSchema.parse(caseId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.exportCase,
    (_event, caseId: unknown, confirmed: unknown) =>
      workspace.exportCase(
        localIdSchema.parse(caseId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.importCase, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "导入探微诊断案例",
      properties: ["openFile"],
      filters: [{ name: "Tanwei Case", extensions: ["json"] }],
    };
    const selection = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths[0]) {
      return {
        ok: true,
        value: null,
        errorCode: null,
        errorMessage: null,
      };
    }
    return workspace.importCase(selection.filePaths[0]);
  });
  ipcMain.handle(IPC_CHANNELS.generateSupportBundle, () =>
    workspace.generateSupportBundle(runtimeInfo()),
  );
  ipcMain.handle(IPC_CHANNELS.compareTargets, (_event, targetIds: unknown) =>
    workspace.compareTargets(comparisonTargetsSchema.parse(targetIds)),
  );
  ipcMain.handle(IPC_CHANNELS.listDiagnosticTemplates, () =>
    workspace.listDiagnosticTemplates(),
  );
  ipcMain.handle(
    IPC_CHANNELS.createSignedDiagnosticTemplate,
    (_event, input: unknown) =>
      workspace.createSignedDiagnosticTemplate(
        createDiagnosticTemplateSchema.parse(input),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.deleteDiagnosticTemplate,
    (_event, templateId: unknown, confirmed: unknown) =>
      workspace.deleteDiagnosticTemplate(
        templateIdSchema.parse(templateId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.executeDiagnosticTemplate,
    (_event, templateId: unknown, targetId: unknown, confirmed: unknown) =>
      workspace.executeDiagnosticTemplate(
        templateIdSchema.parse(templateId),
        targetIdSchema.parse(targetId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.listPlugins, () => workspace.listPlugins());
  ipcMain.handle(IPC_CHANNELS.previewPluginImport, async (event) => {
    const sourcePath = await chooseJsonFile(
      event,
      "导入探微签名插件",
      "Tanwei Plugin",
    );
    return sourcePath
      ? workspace.previewPluginImport(sourcePath)
      : {
          ok: true,
          value: null,
          errorCode: null,
          errorMessage: null,
        };
  });
  ipcMain.handle(
    IPC_CHANNELS.installPlugin,
    (_event, previewId: unknown, confirmed: unknown) =>
      workspace.installPlugin(
        localIdSchema.parse(previewId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.deletePlugin,
    (_event, pluginId: unknown, confirmed: unknown) =>
      workspace.deletePlugin(
        pluginIdSchema.parse(pluginId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.previewTeamPolicyImport, async (event) => {
    const sourcePath = await chooseJsonFile(
      event,
      "导入探微团队策略",
      "Tanwei Team Policy",
    );
    return sourcePath
      ? workspace.previewTeamPolicyImport(sourcePath)
      : {
          ok: true,
          value: null,
          errorCode: null,
          errorMessage: null,
        };
  });
  ipcMain.handle(
    IPC_CHANNELS.activateTeamPolicy,
    (_event, previewId: unknown, confirmed: unknown) =>
      workspace.activateTeamPolicy(
        localIdSchema.parse(previewId),
        z.boolean().parse(confirmed),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.getActiveTeamPolicy, () =>
    workspace.getActiveTeamPolicy(),
  );
  ipcMain.handle(IPC_CHANNELS.removeTeamPolicy, (_event, confirmed: unknown) =>
    workspace.removeTeamPolicy(z.boolean().parse(confirmed)),
  );
  ipcMain.handle(IPC_CHANNELS.getUpdateStatus, () => updateService.status());
  ipcMain.handle(IPC_CHANNELS.checkForUpdates, () => updateService.check());
  ipcMain.handle(IPC_CHANNELS.downloadUpdate, (_event, confirmed: unknown) =>
    updateService.download(z.boolean().parse(confirmed)),
  );
  ipcMain.handle(IPC_CHANNELS.installUpdate, (_event, confirmed: unknown) =>
    updateService.install(z.boolean().parse(confirmed)),
  );
  ipcMain.handle(IPC_CHANNELS.inspectExitImpact, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) {
      return operationFailure(
        "EXIT_OWNER_NOT_FOUND",
        "无法确认发起退出检查的桌面窗口",
      );
    }
    return targetService.inspectExitImpact();
  });
  ipcMain.handle(
    IPC_CHANNELS.resolveAppExit,
    (event, input: unknown): OperationResult<null> => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed()) {
        return operationFailure(
          "EXIT_OWNER_NOT_FOUND",
          "无法确认发起退出操作的桌面窗口",
        );
      }
      const resolution = resolveAppExitSchema.parse(input);
      if (resolution.mode === "CLOSE_WINDOW") {
        if (
          resolution.reason !== "WINDOW_CLOSE" ||
          process.platform !== "darwin"
        ) {
          return operationFailure(
            "INVALID_EXIT_RESOLUTION",
            "当前平台不支持仅关闭诊断窗口",
          );
        }
        owner.hide();
        return operationSuccess(null);
      }

      quitApproved = true;
      app.quit();
      return operationSuccess(null);
    },
  );
}

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 680,
    backgroundColor: "#0a0a0a",
    title: "探微 — JVM Runtime Workbench",
    show: false,
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  primaryWindow = mainWindow;

  mainWindow.webContents.setWindowOpenHandler(() => {
    // External navigation is fail-closed. A future external-link IPC must
    // present an explicit destination preview before calling shell.openExternal.
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowedOrigin = process.env.VITE_DEV_SERVER_URL;
    if (!allowedOrigin || !url.startsWith(allowedOrigin)) {
      event.preventDefault();
    }
  });

  mainWindow.on("close", (event) => {
    if (quitApproved || quitCleanupStarted) {
      return;
    }
    event.preventDefault();
    sendExitRequest(mainWindow, "WINDOW_CLOSE");
  });
  mainWindow.on("closed", () => {
    if (primaryWindow === mainWindow) {
      primaryWindow = null;
    }
  });

  const showMainWindow = (): void => {
    if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  };
  mainWindow.once("ready-to-show", showMainWindow);

  const developmentServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentServerUrl) {
    await mainWindow.loadURL(developmentServerUrl);
  } else {
    await mainWindow.loadFile(
      path.join(currentDirectory, "../renderer/index.html"),
    );
  }
  showMainWindow();
}

app
  .whenReady()
  .then(async () => {
    await verifyPackagedInstallation();
    await updateService.initialize();
    workspaceService = await WorkspaceService.open(
      app.getPath("userData"),
      targetService,
      app.getVersion(),
    );
    registerIpcHandlers(workspaceService);
    await createWindow();

    app.on("activate", () => {
      if (!primaryWindow || primaryWindow.isDestroyed()) {
        void createWindow();
      } else {
        primaryWindow.show();
      }
    });
  })
  .catch((error: unknown) => {
    dialog.showErrorBox(
      "探微无法安全启动",
      error instanceof Error ? error.message : "启动完整性校验失败",
    );
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (quitCleanupStarted) {
    return;
  }
  event.preventDefault();
  if (!quitApproved) {
    const owner = primaryWindow;
    if (owner && sendExitRequest(owner, "APP_QUIT")) {
      return;
    }
    quitApproved = true;
  }
  startQuitCleanup();
});
