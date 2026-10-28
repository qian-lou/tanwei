import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  IPC_CHANNELS,
  type ActionAuditPage,
  type ActionAuditQuery,
  type AppSettings,
  type AppExitReason,
  type ActionRequest,
  type ActionResult,
  type ActionAuditDescriptor,
  type ArtifactDescriptor,
  type ClassDetails,
  type ClassPage,
  type CompiledClass,
  type CompiledClassChangeSet,
  type CompileClassChangeSetItem,
  type CompileClassChangeSetInput,
  type CompileClassSourceInput,
  type CollectAgentArtifactInput,
  type CompareJitTrendArtifactsInput,
  type CreateHeapHistogramArtifactInput,
  type CreateJitTrendArtifactInput,
  type CreateMonitorWindowsArtifactInput,
  type CreateTraceHotspotArtifactInput,
  type CreateThreadPoolTrendArtifactInput,
  type CreateDiagnosticTemplateInput,
  type CreateCaseInput,
  type DiagnosticTemplate,
  type DiagnosticAlertDescriptor,
  type DiagnosticCase,
  type CaseEvidence,
  type CaseExportPreview,
  type CompareThreadDumpArtifactsInput,
  type CompareHeapHistogramArtifactsInput,
  type CompareThreadPoolTrendArtifactsInput,
  type DecompiledSource,
  type ExitImpactSummary,
  type KubernetesContextDescriptor,
  type KubernetesPodDescriptor,
  type KubernetesRemotePreviewInput,
  type ImportPreview,
  type JfrInspectionReport,
  type JitRegressionBaselineIndex,
  type JitTrendComparison,
  type JitTrendInspectionReport,
  type HeapHistogramComparison,
  type HeapHistogramInspectionReport,
  type MultiTargetComparison,
  type OperationResult,
  type ObservationBatch,
  type ObservationExportInspectionReport,
  type PageRequest,
  type PersistedInvocationSnapshot,
  type PersistedInvocationSnapshotPage,
  type PersistedInvocationSnapshotQuery,
  type PersistentRelayPreview,
  type PersistentRelayPreviewInput,
  type PluginDescriptor,
  type RemoteDeploymentPreview,
  type ReplaceClassChangeSetDraftsInput,
  type ResolveAppExitInput,
  type SaveInvocationSnapshotInput,
  type SshRemotePreviewInput,
  type TanweiDesktopApi,
  type TargetConnection,
  type TargetDescriptor,
  type TargetSnapshot,
  type TeamPolicyDescriptor,
  type ThreadDumpComparison,
  type ThreadDumpInspectionReport,
  type ThreadPage,
  type ThreadPoolAliasDescriptor,
  type ThreadPoolAliasInput,
  type DeleteThreadPoolAliasInput,
  type ThreadPoolTrendComparison,
  type ThreadPoolTrendInspectionReport,
  type ThreadQuery,
  type UpdateCaseEvidenceInput,
  type UpdateStatus,
  type RuntimeInfo,
} from "../shared/contracts.js";

type HostListener = (event: unknown, value: unknown) => void;
const subscriptions = new Map<HostListener, { active: boolean; unlisten: UnlistenFn | null }>();
const methods = new Map<string, string>(Object.entries(IPC_CHANNELS).map(([method, channel]) => [channel, method === "runtimeInfo" ? "getRuntimeInfo" : method]));
const hostTransport = {
  invoke: <T,>(channel: string, ...args: unknown[]): Promise<T> => {
    const method = methods.get(channel);
    if (!method) return Promise.reject(new Error("未知桌面接口"));
    return invoke<T>("host_call", { method, args });
  },
  on: (channel: string, listener: HostListener) => {
    const subscription = { active: true, unlisten: null as UnlistenFn | null };
    subscriptions.set(listener, subscription);
    void listen<unknown>(channel, (event) => {
      if (subscription.active) listener(undefined, event.payload);
    }).then((unlisten) => {
      if (subscription.active) subscription.unlisten = unlisten;
      else unlisten();
    }).catch((error: unknown) => {
      subscriptions.delete(listener);
      console.error("桌面事件订阅失败", error);
    });
  },
  removeListener: (_channel: string, listener: HostListener) => {
    const subscription = subscriptions.get(listener);
    if (!subscription) return;
    subscription.active = false;
    subscription.unlisten?.();
    subscriptions.delete(listener);
  },
};

const api: TanweiDesktopApi = Object.freeze<TanweiDesktopApi>({
  getRuntimeInfo: () => hostTransport.invoke<RuntimeInfo>(IPC_CHANNELS.runtimeInfo),
  getSettings: () =>
    hostTransport.invoke(IPC_CHANNELS.getSettings) as Promise<
      OperationResult<AppSettings>
    >,
  updateSettings: (settings: AppSettings) =>
    hostTransport.invoke(IPC_CHANNELS.updateSettings, settings) as Promise<
      OperationResult<AppSettings>
    >,
  listTargets: () =>
    hostTransport.invoke(IPC_CHANNELS.listTargets) as Promise<{
      readonly ok: boolean;
      readonly value: readonly TargetDescriptor[] | null;
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
    }>,
  listConnections: () =>
    hostTransport.invoke(IPC_CHANNELS.listConnections) as Promise<
      OperationResult<readonly TargetConnection[]>
    >,
  connectTarget: (targetId: string) =>
    hostTransport.invoke(IPC_CHANNELS.connectTarget, targetId) as Promise<{
      readonly ok: boolean;
      readonly value: TargetConnection | null;
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
    }>,
  previewSshRemote: (input: SshRemotePreviewInput) =>
    hostTransport.invoke(IPC_CHANNELS.previewSshRemote, input) as Promise<
      OperationResult<RemoteDeploymentPreview>
    >,
  listKubernetesContexts: () =>
    hostTransport.invoke(IPC_CHANNELS.listKubernetesContexts) as Promise<
      OperationResult<readonly KubernetesContextDescriptor[]>
    >,
  listKubernetesNamespaces: (context: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.listKubernetesNamespaces,
      context,
    ) as Promise<OperationResult<readonly string[]>>,
  listKubernetesPods: (context: string, namespace: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.listKubernetesPods,
      context,
      namespace,
    ) as Promise<OperationResult<readonly KubernetesPodDescriptor[]>>,
  previewKubernetesRemote: (input: KubernetesRemotePreviewInput) =>
    hostTransport.invoke(IPC_CHANNELS.previewKubernetesRemote, input) as Promise<
      OperationResult<RemoteDeploymentPreview>
    >,
  previewPersistentRelay: (input: PersistentRelayPreviewInput) =>
    hostTransport.invoke(IPC_CHANNELS.previewPersistentRelay, input) as Promise<
      OperationResult<PersistentRelayPreview>
    >,
  deployRemote: (previewId: string, confirmed: boolean) =>
    hostTransport.invoke(
      IPC_CHANNELS.deployRemote,
      previewId,
      confirmed,
    ) as Promise<OperationResult<TargetConnection>>,
  cancelRemotePreview: (previewId: string) =>
    hostTransport.invoke(IPC_CHANNELS.cancelRemotePreview, previewId) as Promise<
      OperationResult<null>
    >,
  disconnectTarget: (targetId: string) =>
    hostTransport.invoke(IPC_CHANNELS.disconnectTarget, targetId),
  getSnapshot: (targetId: string) =>
    hostTransport.invoke(IPC_CHANNELS.getSnapshot, targetId) as Promise<
      OperationResult<TargetSnapshot>
    >,
  listThreads: (targetId: string, query: ThreadQuery) =>
    hostTransport.invoke(IPC_CHANNELS.listThreads, targetId, query) as Promise<
      OperationResult<ThreadPage>
    >,
  listClasses: (targetId: string, query: PageRequest) =>
    hostTransport.invoke(IPC_CHANNELS.listClasses, targetId, query) as Promise<
      OperationResult<ClassPage>
    >,
  getClassDetails: (targetId: string, name: string, classLoader: string) =>
    hostTransport.invoke(IPC_CHANNELS.getClassDetails, targetId, {
      name,
      classLoader,
    }) as Promise<OperationResult<ClassDetails>>,
  executeAction: (request: ActionRequest) =>
    hostTransport.invoke(IPC_CHANNELS.executeAction, request) as Promise<
      OperationResult<ActionResult>
    >,
  getObservationEvents: (targetId: string, taskId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.getObservationEvents,
      targetId,
      taskId,
    ) as Promise<OperationResult<ObservationBatch>>,
  cancelObservation: (targetId: string, taskId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.cancelObservation,
      targetId,
      taskId,
    ) as Promise<OperationResult<ObservationBatch["state"]>>,
  listThreadPoolAliases: (targetId: string) =>
    hostTransport.invoke(IPC_CHANNELS.listThreadPoolAliases, targetId) as Promise<
      OperationResult<readonly ThreadPoolAliasDescriptor[]>
    >,
  upsertThreadPoolAlias: (input: ThreadPoolAliasInput) =>
    hostTransport.invoke(IPC_CHANNELS.upsertThreadPoolAlias, input) as Promise<
      OperationResult<ThreadPoolAliasDescriptor>
    >,
  deleteThreadPoolAlias: (input: DeleteThreadPoolAliasInput) =>
    hostTransport.invoke(IPC_CHANNELS.deleteThreadPoolAlias, input) as Promise<
      OperationResult<null>
    >,
  listArtifacts: () =>
    hostTransport.invoke(IPC_CHANNELS.listArtifacts) as Promise<
      OperationResult<readonly ArtifactDescriptor[]>
    >,
  listDiagnosticAlerts: () =>
    hostTransport.invoke(IPC_CHANNELS.listDiagnosticAlerts) as Promise<
      OperationResult<readonly DiagnosticAlertDescriptor[]>
    >,
  listJitRegressionBaselines: () =>
    hostTransport.invoke(IPC_CHANNELS.listJitRegressionBaselines) as Promise<
      OperationResult<JitRegressionBaselineIndex>
    >,
  acknowledgeDiagnosticAlert: (alertId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.acknowledgeDiagnosticAlert,
      alertId,
    ) as Promise<OperationResult<DiagnosticAlertDescriptor | null>>,
  acknowledgeAllDiagnosticAlerts: () =>
    hostTransport.invoke(IPC_CHANNELS.acknowledgeAllDiagnosticAlerts) as Promise<
      OperationResult<number>
    >,
  createSnapshotArtifact: (targetId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.createSnapshotArtifact,
      targetId,
    ) as Promise<OperationResult<ArtifactDescriptor>>,
  createHeapHistogramArtifact: (input: CreateHeapHistogramArtifactInput) =>
    hostTransport.invoke(
      IPC_CHANNELS.createHeapHistogramArtifact,
      input,
    ) as Promise<OperationResult<ArtifactDescriptor>>,
  createThreadPoolTrendArtifact: (input: CreateThreadPoolTrendArtifactInput) =>
    hostTransport.invoke(
      IPC_CHANNELS.createThreadPoolTrendArtifact,
      input,
    ) as Promise<OperationResult<ArtifactDescriptor>>,
  createJitTrendArtifact: (input: CreateJitTrendArtifactInput) =>
    hostTransport.invoke(IPC_CHANNELS.createJitTrendArtifact, input) as Promise<
      OperationResult<ArtifactDescriptor>
    >,
  createTraceHotspotArtifact: (input: CreateTraceHotspotArtifactInput) =>
    hostTransport.invoke(
      IPC_CHANNELS.createTraceHotspotArtifact,
      input,
    ) as Promise<OperationResult<ArtifactDescriptor>>,
  createMonitorWindowsArtifact: (input: CreateMonitorWindowsArtifactInput) =>
    hostTransport.invoke(
      IPC_CHANNELS.createMonitorWindowsArtifact,
      input,
    ) as Promise<OperationResult<ArtifactDescriptor>>,
  collectAgentArtifact: (input: CollectAgentArtifactInput) =>
    hostTransport.invoke(IPC_CHANNELS.collectAgentArtifact, input) as Promise<
      OperationResult<ArtifactDescriptor>
    >,
  decompileClassArtifact: (artifactId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.decompileClassArtifact,
      artifactId,
    ) as Promise<OperationResult<DecompiledSource>>,
  compileClassSource: (input: CompileClassSourceInput) =>
    hostTransport.invoke(IPC_CHANNELS.compileClassSource, input) as Promise<
      OperationResult<CompiledClass>
    >,
  compileClassChangeSet: (input: CompileClassChangeSetInput) =>
    hostTransport.invoke(IPC_CHANNELS.compileClassChangeSet, input) as Promise<
      OperationResult<CompiledClassChangeSet>
    >,
  listClassChangeSetDrafts: (targetId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.listClassChangeSetDrafts,
      targetId,
    ) as Promise<OperationResult<readonly CompileClassChangeSetItem[]>>,
  replaceClassChangeSetDrafts: (input: ReplaceClassChangeSetDraftsInput) =>
    hostTransport.invoke(
      IPC_CHANNELS.replaceClassChangeSetDrafts,
      input,
    ) as Promise<OperationResult<readonly CompileClassChangeSetItem[]>>,
  deleteArtifact: (artifactId: string, confirmed: boolean) =>
    hostTransport.invoke(
      IPC_CHANNELS.deleteArtifact,
      artifactId,
      confirmed,
    ) as Promise<OperationResult<null>>,
  verifyArtifact: (artifactId: string) =>
    hostTransport.invoke(IPC_CHANNELS.verifyArtifact, artifactId) as Promise<
      OperationResult<ArtifactDescriptor>
    >,
  openProfileReport: (artifactId: string) =>
    hostTransport.invoke(IPC_CHANNELS.openProfileReport, artifactId) as Promise<
      OperationResult<null>
    >,
  inspectJfrArtifact: (artifactId: string) =>
    hostTransport.invoke(IPC_CHANNELS.inspectJfrArtifact, artifactId) as Promise<
      OperationResult<JfrInspectionReport>
    >,
  inspectThreadDumpArtifact: (artifactId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.inspectThreadDumpArtifact,
      artifactId,
    ) as Promise<OperationResult<ThreadDumpInspectionReport>>,
  compareThreadDumpArtifacts: (input: CompareThreadDumpArtifactsInput) =>
    hostTransport.invoke(
      IPC_CHANNELS.compareThreadDumpArtifacts,
      input,
    ) as Promise<OperationResult<ThreadDumpComparison>>,
  inspectHeapHistogramArtifact: (artifactId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.inspectHeapHistogramArtifact,
      artifactId,
    ) as Promise<OperationResult<HeapHistogramInspectionReport>>,
  compareHeapHistogramArtifacts: (input: CompareHeapHistogramArtifactsInput) =>
    hostTransport.invoke(
      IPC_CHANNELS.compareHeapHistogramArtifacts,
      input,
    ) as Promise<OperationResult<HeapHistogramComparison>>,
  inspectThreadPoolTrendArtifact: (artifactId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.inspectThreadPoolTrendArtifact,
      artifactId,
    ) as Promise<OperationResult<ThreadPoolTrendInspectionReport>>,
  inspectJitTrendArtifact: (artifactId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.inspectJitTrendArtifact,
      artifactId,
    ) as Promise<OperationResult<JitTrendInspectionReport>>,
  inspectObservationExportArtifact: (artifactId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.inspectObservationExportArtifact,
      artifactId,
    ) as Promise<OperationResult<ObservationExportInspectionReport>>,
  compareThreadPoolTrendArtifacts: (
    input: CompareThreadPoolTrendArtifactsInput,
  ) =>
    hostTransport.invoke(
      IPC_CHANNELS.compareThreadPoolTrendArtifacts,
      input,
    ) as Promise<OperationResult<ThreadPoolTrendComparison>>,
  compareJitTrendArtifacts: (input: CompareJitTrendArtifactsInput) =>
    hostTransport.invoke(IPC_CHANNELS.compareJitTrendArtifacts, input) as Promise<
      OperationResult<JitTrendComparison>
    >,
  revealArtifact: (artifactId: string, confirmed: boolean) =>
    hostTransport.invoke(
      IPC_CHANNELS.revealArtifact,
      artifactId,
      confirmed,
    ) as Promise<OperationResult<null>>,
  listCases: () =>
    hostTransport.invoke(IPC_CHANNELS.listCases) as Promise<
      OperationResult<readonly DiagnosticCase[]>
    >,
  listActionAudits: () =>
    hostTransport.invoke(IPC_CHANNELS.listActionAudits) as Promise<
      OperationResult<readonly ActionAuditDescriptor[]>
    >,
  queryActionAudits: (query: ActionAuditQuery) =>
    hostTransport.invoke(IPC_CHANNELS.queryActionAudits, query) as Promise<
      OperationResult<ActionAuditPage>
    >,
  saveInvocationSnapshot: (input: SaveInvocationSnapshotInput) =>
    hostTransport.invoke(IPC_CHANNELS.saveInvocationSnapshot, input) as Promise<
      OperationResult<PersistedInvocationSnapshot>
    >,
  queryPersistedInvocationSnapshots: (
    query: PersistedInvocationSnapshotQuery,
  ) =>
    hostTransport.invoke(
      IPC_CHANNELS.queryPersistedInvocationSnapshots,
      query,
    ) as Promise<OperationResult<PersistedInvocationSnapshotPage>>,
  getPersistedInvocationSnapshot: (snapshotId: string) =>
    hostTransport.invoke(
      IPC_CHANNELS.getPersistedInvocationSnapshot,
      snapshotId,
    ) as Promise<OperationResult<PersistedInvocationSnapshot>>,
  deletePersistedInvocationSnapshot: (
    snapshotId: string,
    confirmed: boolean,
  ) =>
    hostTransport.invoke(
      IPC_CHANNELS.deletePersistedInvocationSnapshot,
      snapshotId,
      confirmed,
    ) as Promise<OperationResult<null>>,
  createCase: (input: CreateCaseInput) =>
    hostTransport.invoke(IPC_CHANNELS.createCase, input) as Promise<
      OperationResult<DiagnosticCase>
    >,
  archiveCase: (caseId: string) =>
    hostTransport.invoke(IPC_CHANNELS.archiveCase, caseId) as Promise<
      OperationResult<DiagnosticCase>
    >,
  deleteCase: (caseId: string, confirmed: boolean) =>
    hostTransport.invoke(IPC_CHANNELS.deleteCase, caseId, confirmed) as Promise<
      OperationResult<null>
    >,
  getCaseEvidence: (caseId: string) =>
    hostTransport.invoke(IPC_CHANNELS.getCaseEvidence, caseId) as Promise<
      OperationResult<CaseEvidence>
    >,
  updateCaseEvidence: (input: UpdateCaseEvidenceInput) =>
    hostTransport.invoke(IPC_CHANNELS.updateCaseEvidence, input) as Promise<
      OperationResult<CaseEvidence>
    >,
  previewCaseExport: (caseId: string) =>
    hostTransport.invoke(IPC_CHANNELS.previewCaseExport, caseId) as Promise<
      OperationResult<CaseExportPreview>
    >,
  exportCase: (caseId: string, confirmed: boolean) =>
    hostTransport.invoke(IPC_CHANNELS.exportCase, caseId, confirmed) as Promise<
      OperationResult<ArtifactDescriptor>
    >,
  importCase: () =>
    hostTransport.invoke(IPC_CHANNELS.importCase) as Promise<
      OperationResult<DiagnosticCase | null>
    >,
  generateSupportBundle: () =>
    hostTransport.invoke(IPC_CHANNELS.generateSupportBundle) as Promise<
      OperationResult<ArtifactDescriptor>
    >,
  compareTargets: (targetIds: readonly string[]) =>
    hostTransport.invoke(IPC_CHANNELS.compareTargets, targetIds) as Promise<
      OperationResult<MultiTargetComparison>
    >,
  listDiagnosticTemplates: () =>
    hostTransport.invoke(IPC_CHANNELS.listDiagnosticTemplates) as Promise<
      OperationResult<readonly DiagnosticTemplate[]>
    >,
  createSignedDiagnosticTemplate: (input: CreateDiagnosticTemplateInput) =>
    hostTransport.invoke(
      IPC_CHANNELS.createSignedDiagnosticTemplate,
      input,
    ) as Promise<OperationResult<DiagnosticTemplate>>,
  deleteDiagnosticTemplate: (templateId: string, confirmed: boolean) =>
    hostTransport.invoke(
      IPC_CHANNELS.deleteDiagnosticTemplate,
      templateId,
      confirmed,
    ) as Promise<OperationResult<null>>,
  executeDiagnosticTemplate: (
    templateId: string,
    targetId: string,
    confirmed: boolean,
  ) =>
    hostTransport.invoke(
      IPC_CHANNELS.executeDiagnosticTemplate,
      templateId,
      targetId,
      confirmed,
    ) as Promise<OperationResult<ActionResult>>,
  listPlugins: () =>
    hostTransport.invoke(IPC_CHANNELS.listPlugins) as Promise<
      OperationResult<readonly PluginDescriptor[]>
    >,
  previewPluginImport: () =>
    hostTransport.invoke(IPC_CHANNELS.previewPluginImport) as Promise<
      OperationResult<ImportPreview<PluginDescriptor> | null>
    >,
  installPlugin: (previewId: string, confirmed: boolean) =>
    hostTransport.invoke(
      IPC_CHANNELS.installPlugin,
      previewId,
      confirmed,
    ) as Promise<OperationResult<PluginDescriptor>>,
  deletePlugin: (pluginId: string, confirmed: boolean) =>
    hostTransport.invoke(
      IPC_CHANNELS.deletePlugin,
      pluginId,
      confirmed,
    ) as Promise<OperationResult<null>>,
  previewTeamPolicyImport: () =>
    hostTransport.invoke(IPC_CHANNELS.previewTeamPolicyImport) as Promise<
      OperationResult<ImportPreview<TeamPolicyDescriptor> | null>
    >,
  activateTeamPolicy: (previewId: string, confirmed: boolean) =>
    hostTransport.invoke(
      IPC_CHANNELS.activateTeamPolicy,
      previewId,
      confirmed,
    ) as Promise<OperationResult<TeamPolicyDescriptor>>,
  getActiveTeamPolicy: () =>
    hostTransport.invoke(IPC_CHANNELS.getActiveTeamPolicy) as Promise<
      OperationResult<TeamPolicyDescriptor | null>
    >,
  removeTeamPolicy: (confirmed: boolean) =>
    hostTransport.invoke(IPC_CHANNELS.removeTeamPolicy, confirmed) as Promise<
      OperationResult<null>
    >,
  getUpdateStatus: () =>
    hostTransport.invoke(IPC_CHANNELS.getUpdateStatus) as Promise<UpdateStatus>,
  checkForUpdates: () =>
    hostTransport.invoke(IPC_CHANNELS.checkForUpdates) as Promise<
      OperationResult<UpdateStatus>
    >,
  downloadUpdate: (confirmed: boolean) =>
    hostTransport.invoke(IPC_CHANNELS.downloadUpdate, confirmed) as Promise<
      OperationResult<UpdateStatus>
    >,
  installUpdate: (confirmed: boolean) =>
    hostTransport.invoke(IPC_CHANNELS.installUpdate, confirmed) as Promise<
      OperationResult<null>
    >,
  inspectExitImpact: () =>
    hostTransport.invoke(IPC_CHANNELS.inspectExitImpact) as Promise<
      OperationResult<ExitImpactSummary>
    >,
  resolveAppExit: (input: ResolveAppExitInput) =>
    hostTransport.invoke(IPC_CHANNELS.resolveAppExit, input) as Promise<
      OperationResult<null>
    >,
  onAppExitRequested: (listener: (reason: AppExitReason) => void) => {
    const handleRequest = (_event: unknown, value: unknown) => {
      if (value === "WINDOW_CLOSE" || value === "APP_QUIT") {
        listener(value);
      }
    };
    hostTransport.on(IPC_CHANNELS.appExitRequested, handleRequest);
    return () => {
      hostTransport.removeListener(IPC_CHANNELS.appExitRequested, handleRequest);
    };
  },
  onDiagnosticAlertsChanged: (listener: () => void) => {
    const handleChange = () => listener();
    hostTransport.on(IPC_CHANNELS.diagnosticAlertsChanged, handleChange);
    return () => {
      hostTransport.removeListener(
        IPC_CHANNELS.diagnosticAlertsChanged,
        handleChange,
      );
    };
  },
  onOpenDiagnosticEvidence: (listener: (artifactId: string) => void) => {
    const handleOpen = (_event: unknown, artifactId: unknown) => {
      if (
        typeof artifactId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          artifactId,
        )
      ) {
        listener(artifactId);
      }
    };
    hostTransport.on(IPC_CHANNELS.openDiagnosticEvidence, handleOpen);
    return () => {
      hostTransport.removeListener(
        IPC_CHANNELS.openDiagnosticEvidence,
        handleOpen,
      );
    };
  },
});

Object.defineProperty(window, "tanwei", { value: api, writable: false, configurable: false });
