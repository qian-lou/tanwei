import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
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
} from "../shared/contracts.js";

const api: TanweiDesktopApi = Object.freeze({
  getRuntimeInfo: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeInfo),
  getSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getSettings) as Promise<
      OperationResult<AppSettings>
    >,
  updateSettings: (settings: AppSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateSettings, settings) as Promise<
      OperationResult<AppSettings>
    >,
  listTargets: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listTargets) as Promise<{
      readonly ok: boolean;
      readonly value: readonly TargetDescriptor[] | null;
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
    }>,
  listConnections: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listConnections) as Promise<
      OperationResult<readonly TargetConnection[]>
    >,
  connectTarget: (targetId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.connectTarget, targetId) as Promise<{
      readonly ok: boolean;
      readonly value: TargetConnection | null;
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
    }>,
  previewSshRemote: (input: SshRemotePreviewInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewSshRemote, input) as Promise<
      OperationResult<RemoteDeploymentPreview>
    >,
  listKubernetesContexts: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listKubernetesContexts) as Promise<
      OperationResult<readonly KubernetesContextDescriptor[]>
    >,
  listKubernetesNamespaces: (context: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.listKubernetesNamespaces,
      context,
    ) as Promise<OperationResult<readonly string[]>>,
  listKubernetesPods: (context: string, namespace: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.listKubernetesPods,
      context,
      namespace,
    ) as Promise<OperationResult<readonly KubernetesPodDescriptor[]>>,
  previewKubernetesRemote: (input: KubernetesRemotePreviewInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewKubernetesRemote, input) as Promise<
      OperationResult<RemoteDeploymentPreview>
    >,
  previewPersistentRelay: (input: PersistentRelayPreviewInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewPersistentRelay, input) as Promise<
      OperationResult<PersistentRelayPreview>
    >,
  deployRemote: (previewId: string, confirmed: boolean) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.deployRemote,
      previewId,
      confirmed,
    ) as Promise<OperationResult<TargetConnection>>,
  cancelRemotePreview: (previewId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelRemotePreview, previewId) as Promise<
      OperationResult<null>
    >,
  disconnectTarget: (targetId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.disconnectTarget, targetId),
  getSnapshot: (targetId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.getSnapshot, targetId) as Promise<
      OperationResult<TargetSnapshot>
    >,
  listThreads: (targetId: string, query: ThreadQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.listThreads, targetId, query) as Promise<
      OperationResult<ThreadPage>
    >,
  listClasses: (targetId: string, query: PageRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.listClasses, targetId, query) as Promise<
      OperationResult<ClassPage>
    >,
  getClassDetails: (targetId: string, name: string, classLoader: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.getClassDetails, targetId, {
      name,
      classLoader,
    }) as Promise<OperationResult<ClassDetails>>,
  executeAction: (request: ActionRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.executeAction, request) as Promise<
      OperationResult<ActionResult>
    >,
  getObservationEvents: (targetId: string, taskId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.getObservationEvents,
      targetId,
      taskId,
    ) as Promise<OperationResult<ObservationBatch>>,
  cancelObservation: (targetId: string, taskId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.cancelObservation,
      targetId,
      taskId,
    ) as Promise<OperationResult<ObservationBatch["state"]>>,
  listThreadPoolAliases: (targetId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.listThreadPoolAliases, targetId) as Promise<
      OperationResult<readonly ThreadPoolAliasDescriptor[]>
    >,
  upsertThreadPoolAlias: (input: ThreadPoolAliasInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.upsertThreadPoolAlias, input) as Promise<
      OperationResult<ThreadPoolAliasDescriptor>
    >,
  deleteThreadPoolAlias: (input: DeleteThreadPoolAliasInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteThreadPoolAlias, input) as Promise<
      OperationResult<null>
    >,
  listArtifacts: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listArtifacts) as Promise<
      OperationResult<readonly ArtifactDescriptor[]>
    >,
  listDiagnosticAlerts: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listDiagnosticAlerts) as Promise<
      OperationResult<readonly DiagnosticAlertDescriptor[]>
    >,
  listJitRegressionBaselines: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listJitRegressionBaselines) as Promise<
      OperationResult<JitRegressionBaselineIndex>
    >,
  acknowledgeDiagnosticAlert: (alertId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.acknowledgeDiagnosticAlert,
      alertId,
    ) as Promise<OperationResult<DiagnosticAlertDescriptor | null>>,
  acknowledgeAllDiagnosticAlerts: () =>
    ipcRenderer.invoke(IPC_CHANNELS.acknowledgeAllDiagnosticAlerts) as Promise<
      OperationResult<number>
    >,
  createSnapshotArtifact: (targetId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.createSnapshotArtifact,
      targetId,
    ) as Promise<OperationResult<ArtifactDescriptor>>,
  createHeapHistogramArtifact: (input: CreateHeapHistogramArtifactInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.createHeapHistogramArtifact,
      input,
    ) as Promise<OperationResult<ArtifactDescriptor>>,
  createThreadPoolTrendArtifact: (input: CreateThreadPoolTrendArtifactInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.createThreadPoolTrendArtifact,
      input,
    ) as Promise<OperationResult<ArtifactDescriptor>>,
  createJitTrendArtifact: (input: CreateJitTrendArtifactInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.createJitTrendArtifact, input) as Promise<
      OperationResult<ArtifactDescriptor>
    >,
  createTraceHotspotArtifact: (input: CreateTraceHotspotArtifactInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.createTraceHotspotArtifact,
      input,
    ) as Promise<OperationResult<ArtifactDescriptor>>,
  createMonitorWindowsArtifact: (input: CreateMonitorWindowsArtifactInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.createMonitorWindowsArtifact,
      input,
    ) as Promise<OperationResult<ArtifactDescriptor>>,
  collectAgentArtifact: (input: CollectAgentArtifactInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.collectAgentArtifact, input) as Promise<
      OperationResult<ArtifactDescriptor>
    >,
  decompileClassArtifact: (artifactId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.decompileClassArtifact,
      artifactId,
    ) as Promise<OperationResult<DecompiledSource>>,
  compileClassSource: (input: CompileClassSourceInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.compileClassSource, input) as Promise<
      OperationResult<CompiledClass>
    >,
  compileClassChangeSet: (input: CompileClassChangeSetInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.compileClassChangeSet, input) as Promise<
      OperationResult<CompiledClassChangeSet>
    >,
  listClassChangeSetDrafts: (targetId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.listClassChangeSetDrafts,
      targetId,
    ) as Promise<OperationResult<readonly CompileClassChangeSetItem[]>>,
  replaceClassChangeSetDrafts: (input: ReplaceClassChangeSetDraftsInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.replaceClassChangeSetDrafts,
      input,
    ) as Promise<OperationResult<readonly CompileClassChangeSetItem[]>>,
  deleteArtifact: (artifactId: string, confirmed: boolean) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.deleteArtifact,
      artifactId,
      confirmed,
    ) as Promise<OperationResult<null>>,
  verifyArtifact: (artifactId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.verifyArtifact, artifactId) as Promise<
      OperationResult<ArtifactDescriptor>
    >,
  openProfileReport: (artifactId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openProfileReport, artifactId) as Promise<
      OperationResult<null>
    >,
  inspectJfrArtifact: (artifactId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.inspectJfrArtifact, artifactId) as Promise<
      OperationResult<JfrInspectionReport>
    >,
  inspectThreadDumpArtifact: (artifactId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.inspectThreadDumpArtifact,
      artifactId,
    ) as Promise<OperationResult<ThreadDumpInspectionReport>>,
  compareThreadDumpArtifacts: (input: CompareThreadDumpArtifactsInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.compareThreadDumpArtifacts,
      input,
    ) as Promise<OperationResult<ThreadDumpComparison>>,
  inspectHeapHistogramArtifact: (artifactId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.inspectHeapHistogramArtifact,
      artifactId,
    ) as Promise<OperationResult<HeapHistogramInspectionReport>>,
  compareHeapHistogramArtifacts: (input: CompareHeapHistogramArtifactsInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.compareHeapHistogramArtifacts,
      input,
    ) as Promise<OperationResult<HeapHistogramComparison>>,
  inspectThreadPoolTrendArtifact: (artifactId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.inspectThreadPoolTrendArtifact,
      artifactId,
    ) as Promise<OperationResult<ThreadPoolTrendInspectionReport>>,
  inspectJitTrendArtifact: (artifactId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.inspectJitTrendArtifact,
      artifactId,
    ) as Promise<OperationResult<JitTrendInspectionReport>>,
  inspectObservationExportArtifact: (artifactId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.inspectObservationExportArtifact,
      artifactId,
    ) as Promise<OperationResult<ObservationExportInspectionReport>>,
  compareThreadPoolTrendArtifacts: (
    input: CompareThreadPoolTrendArtifactsInput,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.compareThreadPoolTrendArtifacts,
      input,
    ) as Promise<OperationResult<ThreadPoolTrendComparison>>,
  compareJitTrendArtifacts: (input: CompareJitTrendArtifactsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.compareJitTrendArtifacts, input) as Promise<
      OperationResult<JitTrendComparison>
    >,
  revealArtifact: (artifactId: string, confirmed: boolean) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.revealArtifact,
      artifactId,
      confirmed,
    ) as Promise<OperationResult<null>>,
  listCases: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listCases) as Promise<
      OperationResult<readonly DiagnosticCase[]>
    >,
  listActionAudits: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listActionAudits) as Promise<
      OperationResult<readonly ActionAuditDescriptor[]>
    >,
  queryActionAudits: (query: ActionAuditQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.queryActionAudits, query) as Promise<
      OperationResult<ActionAuditPage>
    >,
  saveInvocationSnapshot: (input: SaveInvocationSnapshotInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveInvocationSnapshot, input) as Promise<
      OperationResult<PersistedInvocationSnapshot>
    >,
  queryPersistedInvocationSnapshots: (
    query: PersistedInvocationSnapshotQuery,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.queryPersistedInvocationSnapshots,
      query,
    ) as Promise<OperationResult<PersistedInvocationSnapshotPage>>,
  getPersistedInvocationSnapshot: (snapshotId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.getPersistedInvocationSnapshot,
      snapshotId,
    ) as Promise<OperationResult<PersistedInvocationSnapshot>>,
  deletePersistedInvocationSnapshot: (
    snapshotId: string,
    confirmed: boolean,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.deletePersistedInvocationSnapshot,
      snapshotId,
      confirmed,
    ) as Promise<OperationResult<null>>,
  createCase: (input: CreateCaseInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.createCase, input) as Promise<
      OperationResult<DiagnosticCase>
    >,
  archiveCase: (caseId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.archiveCase, caseId) as Promise<
      OperationResult<DiagnosticCase>
    >,
  deleteCase: (caseId: string, confirmed: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteCase, caseId, confirmed) as Promise<
      OperationResult<null>
    >,
  getCaseEvidence: (caseId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.getCaseEvidence, caseId) as Promise<
      OperationResult<CaseEvidence>
    >,
  updateCaseEvidence: (input: UpdateCaseEvidenceInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateCaseEvidence, input) as Promise<
      OperationResult<CaseEvidence>
    >,
  previewCaseExport: (caseId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewCaseExport, caseId) as Promise<
      OperationResult<CaseExportPreview>
    >,
  exportCase: (caseId: string, confirmed: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportCase, caseId, confirmed) as Promise<
      OperationResult<ArtifactDescriptor>
    >,
  importCase: () =>
    ipcRenderer.invoke(IPC_CHANNELS.importCase) as Promise<
      OperationResult<DiagnosticCase | null>
    >,
  generateSupportBundle: () =>
    ipcRenderer.invoke(IPC_CHANNELS.generateSupportBundle) as Promise<
      OperationResult<ArtifactDescriptor>
    >,
  compareTargets: (targetIds: readonly string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.compareTargets, targetIds) as Promise<
      OperationResult<MultiTargetComparison>
    >,
  listDiagnosticTemplates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listDiagnosticTemplates) as Promise<
      OperationResult<readonly DiagnosticTemplate[]>
    >,
  createSignedDiagnosticTemplate: (input: CreateDiagnosticTemplateInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.createSignedDiagnosticTemplate,
      input,
    ) as Promise<OperationResult<DiagnosticTemplate>>,
  deleteDiagnosticTemplate: (templateId: string, confirmed: boolean) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.deleteDiagnosticTemplate,
      templateId,
      confirmed,
    ) as Promise<OperationResult<null>>,
  executeDiagnosticTemplate: (
    templateId: string,
    targetId: string,
    confirmed: boolean,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.executeDiagnosticTemplate,
      templateId,
      targetId,
      confirmed,
    ) as Promise<OperationResult<ActionResult>>,
  listPlugins: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listPlugins) as Promise<
      OperationResult<readonly PluginDescriptor[]>
    >,
  previewPluginImport: () =>
    ipcRenderer.invoke(IPC_CHANNELS.previewPluginImport) as Promise<
      OperationResult<ImportPreview<PluginDescriptor> | null>
    >,
  installPlugin: (previewId: string, confirmed: boolean) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.installPlugin,
      previewId,
      confirmed,
    ) as Promise<OperationResult<PluginDescriptor>>,
  deletePlugin: (pluginId: string, confirmed: boolean) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.deletePlugin,
      pluginId,
      confirmed,
    ) as Promise<OperationResult<null>>,
  previewTeamPolicyImport: () =>
    ipcRenderer.invoke(IPC_CHANNELS.previewTeamPolicyImport) as Promise<
      OperationResult<ImportPreview<TeamPolicyDescriptor> | null>
    >,
  activateTeamPolicy: (previewId: string, confirmed: boolean) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.activateTeamPolicy,
      previewId,
      confirmed,
    ) as Promise<OperationResult<TeamPolicyDescriptor>>,
  getActiveTeamPolicy: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getActiveTeamPolicy) as Promise<
      OperationResult<TeamPolicyDescriptor | null>
    >,
  removeTeamPolicy: (confirmed: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.removeTeamPolicy, confirmed) as Promise<
      OperationResult<null>
    >,
  getUpdateStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getUpdateStatus) as Promise<UpdateStatus>,
  checkForUpdates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates) as Promise<
      OperationResult<UpdateStatus>
    >,
  downloadUpdate: (confirmed: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.downloadUpdate, confirmed) as Promise<
      OperationResult<UpdateStatus>
    >,
  installUpdate: (confirmed: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.installUpdate, confirmed) as Promise<
      OperationResult<null>
    >,
  inspectExitImpact: () =>
    ipcRenderer.invoke(IPC_CHANNELS.inspectExitImpact) as Promise<
      OperationResult<ExitImpactSummary>
    >,
  resolveAppExit: (input: ResolveAppExitInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.resolveAppExit, input) as Promise<
      OperationResult<null>
    >,
  onAppExitRequested: (listener: (reason: AppExitReason) => void) => {
    const handleRequest = (_event: IpcRendererEvent, value: unknown) => {
      if (value === "WINDOW_CLOSE" || value === "APP_QUIT") {
        listener(value);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.appExitRequested, handleRequest);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.appExitRequested, handleRequest);
    };
  },
  onDiagnosticAlertsChanged: (listener: () => void) => {
    const handleChange = () => listener();
    ipcRenderer.on(IPC_CHANNELS.diagnosticAlertsChanged, handleChange);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.diagnosticAlertsChanged,
        handleChange,
      );
    };
  },
  onOpenDiagnosticEvidence: (listener: (artifactId: string) => void) => {
    const handleOpen = (_event: IpcRendererEvent, artifactId: unknown) => {
      if (
        typeof artifactId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          artifactId,
        )
      ) {
        listener(artifactId);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.openDiagnosticEvidence, handleOpen);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.openDiagnosticEvidence,
        handleOpen,
      );
    };
  },
});

contextBridge.exposeInMainWorld("tanwei", api);
