import type { AppFontFamily } from "./app-fonts.js";

export type { AppFontFamily } from "./app-fonts.js";

export type ConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "READY"
  | "DEGRADED"
  | "RECONNECTING"
  | "CLOSING";

export type CapabilityState = "AVAILABLE" | "UNSUPPORTED" | "RESTRICTED";
export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";

export type DesktopPlatform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd";

export interface RuntimeInfo {
  readonly appVersion: string;
  readonly platform: DesktopPlatform;
  readonly architecture: string;
  readonly tauriVersion: string;
  readonly webviewEngine: string;
  readonly components: Readonly<Record<string, string>>;
}

export type SystemNotificationPolicy =
  "OFF" | "CRITICAL_ONLY" | "WARNING_AND_CRITICAL";

export interface AppSettings {
  readonly locale: "zh-CN" | "en-US";
  readonly fontFamily: AppFontFamily;
  readonly defaultSamplingIntervalMillis: 1_000 | 2_000 | 5_000 | 10_000;
  readonly artifactQuotaBytes: number;
  readonly retentionDays: number;
  readonly updatePolicy: "NOTIFY" | "MANUAL";
  readonly maximumRiskLevel: "R2" | "R3" | "R4";
  readonly systemNotificationPolicy: SystemNotificationPolicy;
}

export interface UpdateStatus {
  readonly state:
    | "NOT_CONFIGURED"
    | "IDLE"
    | "CHECKING"
    | "AVAILABLE"
    | "DOWNLOADING"
    | "DOWNLOADED"
    | "UP_TO_DATE"
    | "FAILED";
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  readonly releaseName: string | null;
  readonly releaseNotes: string | null;
  readonly progressPercent: number | null;
  readonly errorMessage: string | null;
}

export interface TargetDescriptor {
  readonly id: string;
  readonly pid: number;
  readonly displayName: string;
  readonly mainClass: string;
  readonly arguments: readonly string[];
  readonly javaPath: string | null;
  readonly javaVersion: string | null;
  readonly user: string | null;
  readonly startTime: string | null;
  readonly attachable: boolean;
  readonly attachReason: string | null;
}

export interface TargetSnapshot {
  readonly targetId: string;
  readonly capturedAt: string;
  readonly uptimeMillis: number;
  readonly jvmStartTimeEpochMillis: number;
  readonly processCpuLoad: number | null;
  readonly systemCpuLoad: number | null;
  readonly heapUsedBytes: number;
  readonly heapMaxBytes: number;
  readonly nonHeapUsedBytes: number;
  readonly liveThreads: number;
  readonly peakThreads: number;
  readonly loadedClasses: number;
  readonly gcCount: number;
  readonly gcTimeMillis: number;
}

export interface TargetConnection {
  readonly target: TargetDescriptor;
  readonly state: ConnectionState;
  readonly protocolVersion: string | null;
  readonly agentVersion: string | null;
  readonly javaVersion: string | null;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly connectedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export type SupportedThreadPoolClass =
  | "java.util.concurrent.ThreadPoolExecutor"
  | "java.util.concurrent.ScheduledThreadPoolExecutor"
  | "java.util.concurrent.ForkJoinPool";

export interface ThreadPoolAliasDescriptor {
  readonly targetId: string;
  readonly jvmStartTimeEpochMillis: number;
  readonly poolIdentity: string;
  readonly poolClassName: SupportedThreadPoolClass;
  readonly alias: string;
  readonly updatedAt: string;
}

export interface ThreadPoolAliasInput {
  readonly targetId: string;
  readonly poolIdentity: string;
  readonly poolClassName: SupportedThreadPoolClass;
  readonly alias: string;
}

export type DeleteThreadPoolAliasInput = Omit<ThreadPoolAliasInput, "alias">;

export interface CapabilityDescriptor {
  readonly id: string;
  readonly state: CapabilityState;
  readonly reason: string | null;
}

export interface PageRequest {
  readonly offset: number;
  readonly limit: number;
  readonly query: string;
}

export interface ThreadQuery extends PageRequest {
  readonly stackDepth: number;
  readonly state:
    | ""
    | "NEW"
    | "RUNNABLE"
    | "BLOCKED"
    | "WAITING"
    | "TIMED_WAITING"
    | "TERMINATED";
}

export interface ThreadDescriptor {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly daemon: boolean;
  readonly priority: number;
  readonly cpuTimeNanos: number | null;
  readonly deadlocked: boolean;
  readonly lockName: string | null;
  readonly lockOwnerId: number | null;
  readonly stack: readonly string[];
}

export interface ThreadPage {
  readonly total: number;
  readonly offset: number;
  readonly items: readonly ThreadDescriptor[];
}

export interface ClassDescriptor {
  readonly name: string;
  readonly classLoader: string;
  readonly module: string | null;
  readonly modifiable: boolean;
}

export interface ClassPage {
  readonly total: number;
  readonly offset: number;
  readonly items: readonly ClassDescriptor[];
}

export interface MethodDescriptor {
  readonly name: string;
  readonly returnType: string;
  readonly parameterTypes: readonly string[];
  readonly exceptionTypes: readonly string[];
  readonly modifiers: string;
  readonly annotations: readonly string[];
}

export interface ClassDetails {
  readonly name: string;
  readonly classLoader: string;
  readonly codeSource: string | null;
  readonly modifiers: string;
  readonly superClass: string | null;
  readonly interfaces: readonly string[];
  readonly annotations: readonly string[];
  readonly methods: readonly MethodDescriptor[];
}

export interface ActionRequest {
  readonly targetId: string;
  readonly actionId: string;
  readonly contractVersion?: "1.0" | (string & {}) | undefined;
  readonly parameters: Readonly<Record<string, string>>;
}

export interface ActionResult {
  readonly actionId: string;
  readonly taskId: string;
  readonly targetId: string;
  readonly riskLevel: RiskLevel;
  readonly status: "SUCCEEDED" | "FAILED";
  readonly errorCode: string | null;
  readonly message: string | null;
  readonly values: Readonly<Record<string, string>>;
  readonly completedAt: string;
}

export interface ObservationEvent {
  readonly eventId: number;
  readonly sequence: number;
  readonly parentSequence: number | null;
  readonly depth: number;
  readonly method: string;
  readonly phase: "BEFORE" | "RETURN" | "THROW" | "FINISH";
  readonly capturedAt: string;
  readonly durationNanos: number;
  readonly threadName: string;
  readonly arguments: readonly string[];
  readonly callStack: readonly string[];
  readonly returnValue: string | null;
  readonly exceptionType: string | null;
  readonly exceptionMessage: string | null;
}

export interface ObservationBatch {
  readonly taskId: string;
  readonly state:
    "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "UNKNOWN";
  readonly captured: number;
  readonly dropped: number;
  readonly events: readonly ObservationEvent[];
}

export type ObservationTaskState = ObservationBatch["state"];

export interface ObservationMethodIdentity {
  readonly className: string;
  readonly classLoader: string;
  readonly methodName: string;
  readonly parameterTypes: readonly string[];
}

export interface TraceExportSpan {
  readonly sequence: number;
  readonly parentSequence: number | null;
  readonly method: string;
  readonly durationNanos: number;
  readonly exceptionType: string | null;
}

export interface TraceExportTrace {
  readonly traceId: number;
  readonly capturedAtEpochMillis: number;
  readonly durationNanos: number;
  readonly truncatedSpans: number;
  readonly spans: readonly TraceExportSpan[];
}

export interface TraceHotspotRow {
  readonly method: string;
  readonly calls: number;
  readonly errors: number;
  readonly totalDurationNanos: number;
  readonly selfDurationNanos: number;
  readonly averageDurationNanos: number;
  readonly maximumDurationNanos: number;
  readonly selfSharePercent: number;
}

export interface CreateTraceHotspotArtifactInput {
  readonly targetId: string;
  readonly taskId: string;
  readonly taskState: ObservationTaskState;
  readonly target: ObservationMethodIdentity;
  readonly rootMethod: string;
  readonly scopePrefix: string;
  readonly includeRules: readonly string[];
  readonly excludeRules: readonly string[];
  readonly dropped: number;
  readonly traces: readonly TraceExportTrace[];
}

export interface TraceHotspotRecording {
  readonly targetId: string;
  readonly jvmStartTimeEpochMillis: number;
  readonly exportedAtEpochMillis: number;
  readonly taskId: string;
  readonly taskState: ObservationTaskState;
  readonly target: ObservationMethodIdentity;
  readonly rootMethod: string;
  readonly scopePrefix: string;
  readonly includeRules: readonly string[];
  readonly excludeRules: readonly string[];
  readonly firstCapturedAtEpochMillis: number;
  readonly lastCapturedAtEpochMillis: number;
  readonly traceCount: number;
  readonly spanCount: number;
  readonly dropped: number;
  readonly truncatedSpans: number;
  readonly hotspots: readonly TraceHotspotRow[];
}

export interface TraceHotspotInspectionReport {
  readonly kind: "TRACE_HOTSPOTS";
  readonly artifactId: string;
  readonly schemaVersion: 1;
  readonly recording: TraceHotspotRecording;
}

export interface MonitorWindowSample {
  readonly sequence: number;
  readonly startedAtEpochMillis: number;
  readonly endedAtEpochMillis: number;
  readonly minimumDurationMillis: number;
  readonly calls: number;
  readonly failures: number;
  readonly durationNanos: number;
  readonly maximumDurationNanos: number;
  readonly p95DurationNanos: number;
  readonly p99DurationNanos: number;
}

export interface CreateMonitorWindowsArtifactInput {
  readonly targetId: string;
  readonly taskId: string;
  readonly taskState: ObservationTaskState;
  readonly target: ObservationMethodIdentity;
  readonly method: string;
  readonly intervalMillis: number;
  readonly windows: readonly MonitorWindowSample[];
}

export interface MonitorWindowSummary {
  readonly windowCount: number;
  readonly totalCalls: number;
  readonly totalFailures: number;
  readonly totalDurationNanos: number;
  readonly averageDurationNanos: number;
  readonly maximumDurationNanos: number;
  readonly maximumP95DurationNanos: number;
  readonly maximumP99DurationNanos: number;
}

export interface MonitorWindowsRecording {
  readonly targetId: string;
  readonly jvmStartTimeEpochMillis: number;
  readonly exportedAtEpochMillis: number;
  readonly taskId: string;
  readonly taskState: ObservationTaskState;
  readonly target: ObservationMethodIdentity;
  readonly method: string;
  readonly intervalMillis: number;
  readonly windows: readonly MonitorWindowSample[];
  readonly summary: MonitorWindowSummary;
}

export interface MonitorWindowsInspectionReport {
  readonly kind: "MONITOR_WINDOWS";
  readonly artifactId: string;
  readonly schemaVersion: 1;
  readonly recording: MonitorWindowsRecording;
}

export type ObservationExportInspectionReport =
  TraceHotspotInspectionReport | MonitorWindowsInspectionReport;

export type ArtifactType =
  | "SNAPSHOT"
  | "HEAP_HISTOGRAM"
  | "THREAD_POOL_TREND"
  | "JIT_TREND"
  | "TRACE_HOTSPOTS"
  | "MONITOR_WINDOWS"
  | "THREAD_DUMP"
  | "CLASS_DUMP"
  | "JFR"
  | "HEAP_DUMP"
  | "PROFILE"
  | "CASE_EXPORT"
  | "SUPPORT_BUNDLE";

export type ArtifactStatus = "CREATING" | "READY" | "FAILED" | "CANCELLED";

export interface ArtifactDescriptor {
  readonly id: string;
  readonly targetId: string;
  readonly type: ArtifactType;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly status: ArtifactStatus;
  readonly createdAt: string;
}

export interface HeapHistogramRow {
  readonly className: string;
  readonly classLoader: string;
  readonly instanceCount: number;
  readonly shallowBytes: number;
  readonly averageShallowBytes: number;
}

export interface HeapHistogramSnapshot {
  readonly targetId: string;
  readonly targetStartTime: string | null;
  readonly capturedAt: number;
  readonly query: string;
  readonly limit: number;
  readonly scanLimit: number;
  readonly scanComplete: boolean;
  readonly rowsComplete: boolean;
  readonly accountedObjects: number;
  readonly accountedBytes: number;
  readonly rows: readonly HeapHistogramRow[];
}

export interface CreateHeapHistogramArtifactInput {
  readonly snapshot: HeapHistogramSnapshot;
}

export interface HeapHistogramInspectionReport {
  readonly artifactId: string;
  readonly schemaVersion: 1;
  readonly snapshot: HeapHistogramSnapshot;
}

export interface CompareHeapHistogramArtifactsInput {
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
}

export interface HeapHistogramDeltaRow {
  readonly className: string;
  readonly classLoader: string;
  readonly baselineInstances: number;
  readonly currentInstances: number;
  readonly instanceDelta: number;
  readonly baselineShallowBytes: number;
  readonly currentShallowBytes: number;
  readonly shallowBytesDelta: number;
  readonly kind: "GROWTH" | "RELEASE" | "STABLE";
}

export interface HeapHistogramDiff {
  readonly exactRowCoverage: boolean;
  readonly totalsComparable: boolean;
  readonly instanceDelta: number | null;
  readonly shallowBytesDelta: number | null;
  readonly growingClasses: number;
  readonly releasedClasses: number;
  readonly stableClasses: number;
  readonly unmatchedBaselineRows: number;
  readonly unmatchedCurrentRows: number;
  readonly rows: readonly HeapHistogramDeltaRow[];
}

export interface HeapHistogramComparison extends HeapHistogramDiff {
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
  readonly targetId: string;
  readonly targetStartTime: string;
  readonly baselineCapturedAt: number;
  readonly currentCapturedAt: number;
  readonly intervalMillis: number;
  readonly query: string;
  readonly limit: number;
  readonly scanLimit: number;
}

export type ThreadPoolKind = "THREAD_POOL" | "SCHEDULED" | "FORK_JOIN";

export type ThreadPoolRuntimeState =
  "RUNNING" | "QUIESCENT" | "SHUTDOWN" | "TERMINATING" | "TERMINATED";

export interface ThreadPoolTrendSample {
  readonly capturedAt: number;
  readonly state: ThreadPoolRuntimeState;
  readonly configuredSize: number | null;
  readonly poolSize: number | null;
  readonly activeCount: number | null;
  readonly maximumSize: number | null;
  readonly queuedTasks: number | null;
  readonly remainingQueueCapacity: number | null;
  readonly completedTasks: number | null;
  readonly queuedSubmissions: number | null;
  readonly runningCount: number | null;
  readonly stealCount: number | null;
}

export interface ThreadPoolTrendRecording {
  readonly targetId: string;
  readonly jvmStartTimeEpochMillis: number;
  readonly poolIdentity: string;
  readonly poolClassName: SupportedThreadPoolClass;
  readonly poolKind: ThreadPoolKind;
  readonly alias: string | null;
  readonly samplingIntervalMillis: 2_000 | 5_000 | 10_000 | 30_000;
  readonly samples: readonly ThreadPoolTrendSample[];
}

export interface CreateThreadPoolTrendArtifactInput {
  readonly recording: ThreadPoolTrendRecording;
}

export interface ThreadPoolTrendSummary {
  readonly sampleCount: number;
  readonly durationMillis: number;
  readonly initialQueue: number;
  readonly currentQueue: number;
  readonly queueDelta: number;
  readonly peakQueue: number;
  readonly queueGrowthIntervals: number;
  readonly averageUtilizationPercent: number | null;
  readonly peakUtilizationPercent: number | null;
  readonly saturatedSamples: number;
  readonly completedTaskDelta: number | null;
  readonly throughputPerSecond: number | null;
  readonly stealDelta: number | null;
  readonly terminalStateSeen: boolean;
  readonly starvationLikely: boolean;
}

export interface ThreadPoolTrendInspectionReport {
  readonly artifactId: string;
  readonly schemaVersion: 1;
  readonly recording: ThreadPoolTrendRecording;
  readonly summary: ThreadPoolTrendSummary;
}

export interface CompareThreadPoolTrendArtifactsInput {
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
}

export interface ThreadPoolTrendComparison {
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
  readonly targetId: string;
  readonly jvmStartTimeEpochMillis: number;
  readonly poolIdentity: string;
  readonly poolClassName: SupportedThreadPoolClass;
  readonly poolKind: ThreadPoolKind;
  readonly baselineStartedAt: number;
  readonly baselineEndedAt: number;
  readonly currentStartedAt: number;
  readonly currentEndedAt: number;
  readonly intervalMillis: number;
  readonly baseline: ThreadPoolTrendSummary;
  readonly current: ThreadPoolTrendSummary;
  readonly peakQueueDelta: number;
  readonly endingQueueDelta: number;
  readonly averageUtilizationDelta: number | null;
  readonly throughputDelta: number | null;
  readonly starvationChanged: boolean;
}

export type CodeCacheCapacityKind = "MAX" | "COMMITTED";

export type CodeCachePressureState =
  "NORMAL" | "ELEVATED" | "HIGH" | "EXHAUSTED";

export interface JitTrendSample {
  readonly sampledAtEpochMillis: number;
  readonly totalCompiles: number | null;
  readonly standardCompiles: number | null;
  readonly osrCompiles: number | null;
  readonly bailouts: number | null;
  readonly invalidations: number | null;
  readonly compilerTimeMillis: number | null;
  readonly codeCacheUsedBytes: number;
  readonly codeCacheCapacityBytes: number;
  readonly codeCacheCapacityKind: CodeCacheCapacityKind;
}

export interface JitRegressionLabelInput {
  readonly workloadKey: string;
  readonly releaseLabel: string;
}

export interface JitRegressionIdentity extends JitRegressionLabelInput {
  readonly targetMainClass: string;
  readonly javaVersion: string;
  readonly compilerName: string;
}

export interface JitTrendRecording {
  readonly targetId: string;
  readonly jvmStartTimeEpochMillis: number;
  readonly samplingIntervalMillis: 1_000 | 2_000 | 5_000 | 10_000;
  readonly samples: readonly JitTrendSample[];
  readonly regressionIdentity?: JitRegressionIdentity;
}

export interface CreateJitTrendArtifactInput {
  readonly recording: JitTrendRecording;
  readonly regressionLabel: JitRegressionLabelInput | null;
}

export interface JitTrendSummary {
  readonly sampleCount: number;
  readonly durationMillis: number;
  readonly compileDelta: number | null;
  readonly standardCompileDelta: number | null;
  readonly osrCompileDelta: number | null;
  readonly failureDelta: number | null;
  readonly compilesPerSecond: number | null;
  readonly failuresPerSecond: number | null;
  readonly compilationTimePercent: number | null;
  readonly initialCodeCacheUsedBytes: number;
  readonly endingCodeCacheUsedBytes: number;
  readonly peakCodeCacheUsedBytes: number;
  readonly codeCacheGrowthBytes: number;
  readonly endingCodeCachePercent: number;
  readonly peakCodeCachePercent: number;
  readonly codeCachePressure: CodeCachePressureState;
  readonly codeCacheCapacityKind: CodeCacheCapacityKind;
}

export interface JitTrendInspectionReport {
  readonly artifactId: string;
  readonly schemaVersion: 1 | 2;
  readonly recording: JitTrendRecording;
  readonly summary: JitTrendSummary;
}

export interface JitRegressionBaselineDescriptor {
  readonly artifact: ArtifactDescriptor;
  readonly identity: JitRegressionIdentity;
  readonly jvmStartTimeEpochMillis: number;
  readonly samplingIntervalMillis: JitTrendRecording["samplingIntervalMillis"];
  readonly summary: JitTrendSummary;
}

export interface JitRegressionBaselineIndex {
  readonly baselines: readonly JitRegressionBaselineDescriptor[];
  readonly scannedArtifacts: number;
  readonly truncated: boolean;
}

export type JitTrendComparisonMode = "SAME_JVM" | "CROSS_RELEASE";

export interface CompareJitTrendArtifactsInput {
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
  readonly mode?: JitTrendComparisonMode;
}

export interface JitTrendComparison {
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
  readonly mode: JitTrendComparisonMode;
  readonly baselineTargetId: string;
  readonly currentTargetId: string;
  readonly baselineJvmStartTimeEpochMillis: number;
  readonly currentJvmStartTimeEpochMillis: number;
  readonly baselineIdentity: JitRegressionIdentity | null;
  readonly currentIdentity: JitRegressionIdentity | null;
  readonly baselineStartedAt: number;
  readonly baselineEndedAt: number;
  readonly currentStartedAt: number;
  readonly currentEndedAt: number;
  readonly intervalMillis: number;
  readonly baseline: JitTrendSummary;
  readonly current: JitTrendSummary;
  readonly compileRateDelta: number | null;
  readonly failureRateDelta: number | null;
  readonly compilationTimePercentDelta: number | null;
  readonly endingCodeCachePercentDelta: number;
  readonly peakCodeCachePercentDelta: number;
  readonly codeCacheGrowthDeltaBytes: number;
  readonly pressureChanged: boolean;
}

export type DiagnosticAlertKind = "JIT_BASELINE_READY" | "CODE_CACHE_PRESSURE";

export type DiagnosticAlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface DiagnosticAlertDescriptor {
  readonly id: string;
  readonly targetId: string;
  readonly kind: DiagnosticAlertKind;
  readonly severity: DiagnosticAlertSeverity;
  readonly artifactId: string | null;
  readonly codeCachePercent: number;
  readonly codeCachePressure: CodeCachePressureState;
  readonly codeCacheCapacityKind: CodeCacheCapacityKind;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}

export interface JfrEventTypeSummary {
  readonly type: string;
  readonly count: number;
}

export interface JfrHotMethodSummary {
  readonly method: string;
  readonly samples: number;
  readonly sharePercent: number;
}

export interface JfrAllocationSummary {
  readonly className: string;
  readonly samples: number;
  readonly estimatedBytes: number;
}

export interface JfrCpuSample {
  readonly capturedAt: string;
  readonly jvmUser: number;
  readonly jvmSystem: number;
  readonly machineTotal: number;
}

export interface JfrGcPauseSummary {
  readonly capturedAt: string;
  readonly name: string;
  readonly cause: string;
  readonly durationMillis: number;
}

export interface JfrCompilationSummary {
  readonly method: string;
  readonly compiler: "C1" | "C2" | "OTHER";
  readonly compileLevel: number | null;
  readonly compilations: number;
  readonly osrCompilations: number;
  readonly succeededCompilations: number;
  readonly failedCompilations: number;
  readonly unknownOutcomeCompilations: number;
  readonly totalDurationMillis: number;
  readonly maximumDurationMillis: number;
  readonly codeBytes: number;
  readonly inlinedBytes: number;
}

export interface JfrCompilerTierSummary {
  readonly compiler: "C1" | "C2" | "OTHER";
  readonly compilations: number;
  readonly osrCompilations: number;
  readonly failedCompilations: number;
  readonly totalDurationMillis: number;
  readonly codeBytes: number;
}

export interface JfrDeoptimizationSummary {
  readonly method: string;
  readonly compiler: "C1" | "C2" | "OTHER";
  readonly reason: string;
  readonly action: string;
  readonly count: number;
}

export interface JfrInspectionReport {
  readonly artifactId: string;
  readonly eventCount: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMillis: number;
  readonly eventTypes: readonly JfrEventTypeSummary[];
  readonly hotMethods: readonly JfrHotMethodSummary[];
  readonly allocations: readonly JfrAllocationSummary[];
  readonly cpuSamples: readonly JfrCpuSample[];
  readonly gcPauses: readonly JfrGcPauseSummary[];
  readonly compilationCount: number;
  readonly deoptimizationCount: number;
  readonly compilationDurationMillis: number;
  readonly compiledCodeBytes: number;
  readonly compilations: readonly JfrCompilationSummary[];
  readonly compilerTiers: readonly JfrCompilerTierSummary[];
  readonly deoptimizations: readonly JfrDeoptimizationSummary[];
  readonly truncated: boolean;
}

export interface CollectAgentArtifactInput {
  readonly targetId: string;
  readonly token: string;
  readonly type: "JFR" | "HEAP_DUMP" | "PROFILE" | "CLASS_DUMP" | "THREAD_DUMP";
  readonly expectedSize: number;
}

export interface ThreadDumpThread {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly cpuTimeNanos: string | null;
  readonly deadlocked: boolean;
  readonly waitingOn: string | null;
  readonly lockOwnerId: string | null;
  readonly lockOwnerName: string | null;
  readonly stack: readonly string[];
  readonly monitors: readonly string[];
  readonly synchronizers: readonly string[];
}

export interface ThreadDumpInspectionReport {
  readonly artifactId: string;
  readonly capturedAt: string | null;
  readonly processId: number | null;
  readonly jvmStartTimeMillis: string | null;
  readonly javaVersion: string;
  readonly threadsSeen: number;
  readonly threadsSelected: number;
  readonly maximumStackDepth: number;
  readonly truncated: boolean;
  readonly monitorsIncluded: boolean;
  readonly synchronizersIncluded: boolean;
  readonly deadlockedThreads: number;
  readonly stateCounts: Readonly<Record<string, number>>;
  readonly threads: readonly ThreadDumpThread[];
}

export interface CompareThreadDumpArtifactsInput {
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
}

export type ThreadDumpChangeKind =
  "ADDED" | "REMOVED" | "CHANGED" | "UNCHANGED";

export interface ThreadDumpThreadChange {
  readonly id: string;
  readonly name: string;
  readonly kind: ThreadDumpChangeKind;
  readonly baselineState: string | null;
  readonly currentState: string | null;
  readonly baselineWaitingOn: string | null;
  readonly currentWaitingOn: string | null;
  readonly baselineLockOwnerId: string | null;
  readonly baselineLockOwnerName: string | null;
  readonly currentLockOwnerId: string | null;
  readonly currentLockOwnerName: string | null;
  readonly baselineTopFrame: string | null;
  readonly currentTopFrame: string | null;
  readonly cpuDeltaNanos: string | null;
  readonly stateChanged: boolean;
  readonly waitChanged: boolean;
  readonly stackChanged: boolean;
  readonly locksChanged: boolean;
  readonly newlyDeadlocked: boolean;
  readonly recoveredDeadlocked: boolean;
}

export interface ThreadDumpComparisonSummary {
  readonly baselineThreads: number;
  readonly currentThreads: number;
  readonly persistedThreads: number;
  readonly addedThreads: number;
  readonly removedThreads: number;
  readonly changedThreads: number;
  readonly unchangedThreads: number;
  readonly stateChanges: number;
  readonly waitChanges: number;
  readonly stackChanges: number;
  readonly lockChanges: number;
  readonly newlyDeadlocked: number;
  readonly recoveredDeadlocked: number;
}

export interface ThreadDumpComparison {
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
  readonly targetId: string;
  readonly processId: number | null;
  readonly baselineCapturedAt: string | null;
  readonly currentCapturedAt: string | null;
  readonly intervalMillis: number | null;
  readonly baselineTruncated: boolean;
  readonly currentTruncated: boolean;
  readonly summary: ThreadDumpComparisonSummary;
  readonly threads: readonly ThreadDumpThreadChange[];
}

export interface DecompiledSource {
  readonly artifactId: string;
  readonly source: string;
  readonly decompiler: "CFR 0.152";
}

export interface CompileClassSourceInput {
  readonly targetId: string;
  readonly className: string;
  readonly classLoader: string;
  readonly source: string;
}

export interface CompiledClass {
  readonly className: string;
  readonly targetRelease: number;
  readonly size: number;
  readonly sha256: string;
  readonly bytecodeBase64: string;
}

export interface CompileClassChangeSetItem {
  readonly className: string;
  readonly classLoader: string;
  readonly source: string;
}

export interface CompileClassChangeSetInput {
  readonly targetId: string;
  readonly items: readonly CompileClassChangeSetItem[];
}

export interface ReplaceClassChangeSetDraftsInput {
  readonly targetId: string;
  readonly items: readonly CompileClassChangeSetItem[];
}

export interface CompiledClassChangeSet {
  readonly targetRelease: number;
  readonly totalSize: number;
  readonly items: readonly CompiledClass[];
}

export type CaseStatus = "OPEN" | "ARCHIVED";

export interface DiagnosticCase {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly tags: readonly string[];
  readonly status: CaseStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateCaseInput {
  readonly title: string;
  readonly notes: string;
  readonly tags: readonly string[];
}

export interface ActionAuditDescriptor {
  readonly taskId: string;
  readonly targetId: string;
  readonly actionId: string;
  readonly riskLevel: RiskLevel;
  readonly status: "SUCCEEDED" | "FAILED";
  readonly errorCode: string | null;
  readonly valueKeys: readonly string[];
  readonly completedAt: string;
}

export interface ActionAuditQuery {
  readonly offset: number;
  readonly limit: number;
  readonly query: string;
  readonly targetId: string;
  readonly status: "ALL" | "SUCCEEDED" | "FAILED";
  readonly riskLevel: "ALL" | RiskLevel;
}

export interface ActionAuditPage {
  readonly total: number;
  readonly retained: number;
  readonly offset: number;
  readonly limit: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly items: readonly ActionAuditDescriptor[];
}

export type InvocationSnapshotOutcome = "RETURNED" | "THREW";

export interface PersistedInvocationSnapshotSummary {
  readonly id: string;
  readonly targetId: string;
  readonly jvmStartTimeEpochMillis: number;
  readonly sourceSnapshotId: number;
  readonly taskId: string;
  readonly className: string;
  readonly sequence: number;
  readonly depth: number;
  readonly method: string;
  readonly capturedAtEpochMillis: number;
  readonly durationNanos: number;
  readonly threadName: string;
  readonly outcome: InvocationSnapshotOutcome;
  readonly exceptionType: string;
  readonly replayEligible: boolean;
  readonly estimatedBytes: number;
  readonly savedAt: string;
}

export interface PersistedInvocationSnapshot
  extends PersistedInvocationSnapshotSummary {
  readonly classLoader: string;
  readonly rootMethodName: string;
  readonly parameterTypes: string;
  readonly modifiers: string;
  readonly parentSequence: number;
  readonly returnValue: string;
  readonly exceptionMessage: string;
  readonly arguments: readonly string[];
  readonly callStack: readonly string[];
}

export interface SaveInvocationSnapshotInput {
  readonly targetId: string;
  readonly snapshotId: number;
}

export interface PersistedInvocationSnapshotQuery {
  readonly offset: number;
  readonly limit: number;
  readonly query: string;
  readonly targetId: string;
  readonly outcome: "ALL" | InvocationSnapshotOutcome;
  readonly scope: "ROOT" | "ALL";
}

export interface PersistedInvocationSnapshotPage {
  readonly total: number;
  readonly retained: number;
  readonly offset: number;
  readonly limit: number;
  readonly returned: number;
  readonly threw: number;
  readonly root: number;
  readonly internal: number;
  readonly estimatedBytes: number;
  readonly items: readonly PersistedInvocationSnapshotSummary[];
}

export interface CaseEvidence {
  readonly caseId: string;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly actions: readonly ActionAuditDescriptor[];
}

export interface UpdateCaseEvidenceInput {
  readonly caseId: string;
  readonly artifactIds: readonly string[];
  readonly actionTaskIds: readonly string[];
}

export interface CaseExportPreview {
  readonly diagnosticCase: DiagnosticCase;
  readonly evidence: CaseEvidence;
  readonly redactedNotes: string;
  readonly redactionCount: number;
  readonly manifestBytes: number;
  readonly productVersion: string;
  readonly schemaVersion: 1;
}

export interface OperationResult<T> {
  readonly ok: boolean;
  readonly value: T | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export type AppExitReason = "WINDOW_CLOSE" | "APP_QUIT";
export type AppExitMode = "CLOSE_WINDOW" | "QUIT_APP";

export interface ExitImpactTarget {
  readonly targetId: string;
  readonly displayName: string;
  readonly pid: number;
  readonly state: "INSPECTED" | "FAILED";
  readonly taskCount: number;
  readonly classCount: number;
  readonly rollbackCount: number;
  readonly artifactPotentialCount: number;
  readonly errorMessage: string | null;
}

export interface ExitImpactSummary {
  readonly inspectedAt: string;
  readonly connectionCount: number;
  readonly inspectedCount: number;
  readonly failedCount: number;
  readonly taskCount: number;
  readonly classCount: number;
  readonly rollbackCount: number;
  readonly artifactPotentialCount: number;
  readonly targets: readonly ExitImpactTarget[];
}

export interface ResolveAppExitInput {
  readonly reason: AppExitReason;
  readonly mode: AppExitMode;
}

export interface SshPasswordAuthentication {
  readonly kind: "PASSWORD";
  readonly password: string;
}

export interface SshPrivateKeyAuthentication {
  readonly kind: "PRIVATE_KEY";
  readonly privateKey: string;
  readonly passphrase: string;
}

export interface SshRemotePreviewInput {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authentication:
    SshPasswordAuthentication | SshPrivateKeyAuthentication;
  readonly pid: number;
}

export interface KubernetesRemotePreviewInput {
  readonly context: string;
  readonly namespace: string;
  readonly pod: string;
  readonly container: string;
  readonly pid: number;
}

export interface RemoteDeploymentFile {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface RemoteDeploymentPreview {
  readonly id: string;
  readonly mode: "SSH" | "KUBERNETES";
  readonly destination: string;
  readonly platform: "linux" | "darwin";
  readonly architecture: "x64" | "arm64";
  readonly javaVersion: string;
  readonly fingerprint: string | null;
  readonly files: readonly RemoteDeploymentFile[];
  readonly commands: readonly string[];
  readonly remoteDirectory: string;
  readonly riskLevel: "R2";
  readonly expiresAt: string;
}

export interface PersistentRelayPreviewInput {
  readonly host: string;
  readonly port: number;
  readonly serverName: string;
  readonly caCertificate: string;
  readonly clientCertificate: string;
  readonly clientPrivateKey: string;
  readonly sessionSecret: string;
  readonly pid: number;
  readonly displayName: string;
}

export interface PersistentRelayPreview {
  readonly id: string;
  readonly mode: "PERSISTENT";
  readonly destination: string;
  readonly serverName: string;
  readonly pid: number;
  readonly caFingerprint: string;
  readonly clientFingerprint: string;
  readonly riskLevel: "R2";
  readonly expiresAt: string;
}

export interface KubernetesContextDescriptor {
  readonly name: string;
  readonly cluster: string;
  readonly user: string;
  readonly current: boolean;
}

export interface KubernetesPodDescriptor {
  readonly name: string;
  readonly phase: string;
  readonly nodeName: string | null;
  readonly containers: readonly string[];
}

export interface TargetComparisonDelta {
  readonly processCpuLoad: number | null;
  readonly heapUsedBytes: number;
  readonly nonHeapUsedBytes: number;
  readonly liveThreads: number;
  readonly loadedClasses: number;
  readonly gcCount: number;
  readonly gcTimeMillis: number;
}

export interface TargetComparisonRow {
  readonly targetId: string;
  readonly displayName: string;
  readonly pid: number;
  readonly javaVersion: string | null;
  readonly snapshot: TargetSnapshot;
  readonly deltaFromBaseline: TargetComparisonDelta;
}

export interface MultiTargetComparison {
  readonly capturedAt: string;
  readonly baselineTargetId: string;
  readonly rows: readonly TargetComparisonRow[];
}

export interface CreateDiagnosticTemplateInput {
  readonly name: string;
  readonly description: string;
  readonly actionId: string;
  readonly parameters: Readonly<Record<string, string>>;
}

export interface DiagnosticTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly actionId: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly riskLevel: "R0" | "R1";
  readonly source: "LOCAL" | "PLUGIN";
  readonly signer: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly signature: string;
  readonly verified: boolean;
  readonly createdAt: string;
}

export interface PluginDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: "tanwei.dev/plugin/v1";
  readonly description: string;
  readonly publisher: string;
  readonly publicKeyFingerprint: string;
  readonly templateCount: number;
  readonly verified: boolean;
  readonly installedAt: string;
}

export interface ImportPreview<T> {
  readonly previewId: string;
  readonly value: T;
  readonly expiresAt: string;
}

export interface TeamPolicyDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: "tanwei.dev/team-policy/v1";
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly maximumRiskLevel: RiskLevel;
  readonly deniedActions: readonly string[];
  readonly signer: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly signature: string;
  readonly verified: boolean;
  readonly activatedAt: string | null;
}

export interface TanweiDesktopApi {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  getSettings(): Promise<OperationResult<AppSettings>>;
  updateSettings(settings: AppSettings): Promise<OperationResult<AppSettings>>;
  listTargets(): Promise<OperationResult<readonly TargetDescriptor[]>>;
  listConnections(): Promise<OperationResult<readonly TargetConnection[]>>;
  connectTarget(targetId: string): Promise<OperationResult<TargetConnection>>;
  previewSshRemote(
    input: SshRemotePreviewInput,
  ): Promise<OperationResult<RemoteDeploymentPreview>>;
  listKubernetesContexts(): Promise<
    OperationResult<readonly KubernetesContextDescriptor[]>
  >;
  listKubernetesNamespaces(
    context: string,
  ): Promise<OperationResult<readonly string[]>>;
  listKubernetesPods(
    context: string,
    namespace: string,
  ): Promise<OperationResult<readonly KubernetesPodDescriptor[]>>;
  previewKubernetesRemote(
    input: KubernetesRemotePreviewInput,
  ): Promise<OperationResult<RemoteDeploymentPreview>>;
  previewPersistentRelay(
    input: PersistentRelayPreviewInput,
  ): Promise<OperationResult<PersistentRelayPreview>>;
  deployRemote(
    previewId: string,
    confirmed: boolean,
  ): Promise<OperationResult<TargetConnection>>;
  cancelRemotePreview(previewId: string): Promise<OperationResult<null>>;
  disconnectTarget(targetId: string): Promise<OperationResult<null>>;
  getSnapshot(targetId: string): Promise<OperationResult<TargetSnapshot>>;
  listThreads(
    targetId: string,
    query: ThreadQuery,
  ): Promise<OperationResult<ThreadPage>>;
  listClasses(
    targetId: string,
    query: PageRequest,
  ): Promise<OperationResult<ClassPage>>;
  getClassDetails(
    targetId: string,
    name: string,
    classLoader: string,
  ): Promise<OperationResult<ClassDetails>>;
  executeAction(request: ActionRequest): Promise<OperationResult<ActionResult>>;
  getObservationEvents(
    targetId: string,
    taskId: string,
  ): Promise<OperationResult<ObservationBatch>>;
  cancelObservation(
    targetId: string,
    taskId: string,
  ): Promise<OperationResult<ObservationBatch["state"]>>;
  listThreadPoolAliases(
    targetId: string,
  ): Promise<OperationResult<readonly ThreadPoolAliasDescriptor[]>>;
  upsertThreadPoolAlias(
    input: ThreadPoolAliasInput,
  ): Promise<OperationResult<ThreadPoolAliasDescriptor>>;
  deleteThreadPoolAlias(
    input: DeleteThreadPoolAliasInput,
  ): Promise<OperationResult<null>>;
  listArtifacts(): Promise<OperationResult<readonly ArtifactDescriptor[]>>;
  listDiagnosticAlerts(): Promise<
    OperationResult<readonly DiagnosticAlertDescriptor[]>
  >;
  listJitRegressionBaselines(): Promise<
    OperationResult<JitRegressionBaselineIndex>
  >;
  acknowledgeDiagnosticAlert(
    alertId: string,
  ): Promise<OperationResult<DiagnosticAlertDescriptor | null>>;
  acknowledgeAllDiagnosticAlerts(): Promise<OperationResult<number>>;
  createSnapshotArtifact(
    targetId: string,
  ): Promise<OperationResult<ArtifactDescriptor>>;
  createHeapHistogramArtifact(
    input: CreateHeapHistogramArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>>;
  createThreadPoolTrendArtifact(
    input: CreateThreadPoolTrendArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>>;
  createJitTrendArtifact(
    input: CreateJitTrendArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>>;
  createTraceHotspotArtifact(
    input: CreateTraceHotspotArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>>;
  createMonitorWindowsArtifact(
    input: CreateMonitorWindowsArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>>;
  collectAgentArtifact(
    input: CollectAgentArtifactInput,
  ): Promise<OperationResult<ArtifactDescriptor>>;
  decompileClassArtifact(
    artifactId: string,
  ): Promise<OperationResult<DecompiledSource>>;
  compileClassSource(
    input: CompileClassSourceInput,
  ): Promise<OperationResult<CompiledClass>>;
  compileClassChangeSet(
    input: CompileClassChangeSetInput,
  ): Promise<OperationResult<CompiledClassChangeSet>>;
  listClassChangeSetDrafts(
    targetId: string,
  ): Promise<OperationResult<readonly CompileClassChangeSetItem[]>>;
  replaceClassChangeSetDrafts(
    input: ReplaceClassChangeSetDraftsInput,
  ): Promise<OperationResult<readonly CompileClassChangeSetItem[]>>;
  deleteArtifact(
    artifactId: string,
    confirmed: boolean,
  ): Promise<OperationResult<null>>;
  verifyArtifact(
    artifactId: string,
  ): Promise<OperationResult<ArtifactDescriptor>>;
  openProfileReport(artifactId: string): Promise<OperationResult<null>>;
  inspectJfrArtifact(
    artifactId: string,
  ): Promise<OperationResult<JfrInspectionReport>>;
  inspectThreadDumpArtifact(
    artifactId: string,
  ): Promise<OperationResult<ThreadDumpInspectionReport>>;
  compareThreadDumpArtifacts(
    input: CompareThreadDumpArtifactsInput,
  ): Promise<OperationResult<ThreadDumpComparison>>;
  inspectHeapHistogramArtifact(
    artifactId: string,
  ): Promise<OperationResult<HeapHistogramInspectionReport>>;
  compareHeapHistogramArtifacts(
    input: CompareHeapHistogramArtifactsInput,
  ): Promise<OperationResult<HeapHistogramComparison>>;
  inspectThreadPoolTrendArtifact(
    artifactId: string,
  ): Promise<OperationResult<ThreadPoolTrendInspectionReport>>;
  inspectJitTrendArtifact(
    artifactId: string,
  ): Promise<OperationResult<JitTrendInspectionReport>>;
  inspectObservationExportArtifact(
    artifactId: string,
  ): Promise<OperationResult<ObservationExportInspectionReport>>;
  compareThreadPoolTrendArtifacts(
    input: CompareThreadPoolTrendArtifactsInput,
  ): Promise<OperationResult<ThreadPoolTrendComparison>>;
  compareJitTrendArtifacts(
    input: CompareJitTrendArtifactsInput,
  ): Promise<OperationResult<JitTrendComparison>>;
  revealArtifact(
    artifactId: string,
    confirmed: boolean,
  ): Promise<OperationResult<null>>;
  listCases(): Promise<OperationResult<readonly DiagnosticCase[]>>;
  listActionAudits(): Promise<
    OperationResult<readonly ActionAuditDescriptor[]>
  >;
  queryActionAudits(
    query: ActionAuditQuery,
  ): Promise<OperationResult<ActionAuditPage>>;
  saveInvocationSnapshot(
    input: SaveInvocationSnapshotInput,
  ): Promise<OperationResult<PersistedInvocationSnapshot>>;
  queryPersistedInvocationSnapshots(
    query: PersistedInvocationSnapshotQuery,
  ): Promise<OperationResult<PersistedInvocationSnapshotPage>>;
  getPersistedInvocationSnapshot(
    snapshotId: string,
  ): Promise<OperationResult<PersistedInvocationSnapshot>>;
  deletePersistedInvocationSnapshot(
    snapshotId: string,
    confirmed: boolean,
  ): Promise<OperationResult<null>>;
  createCase(input: CreateCaseInput): Promise<OperationResult<DiagnosticCase>>;
  archiveCase(caseId: string): Promise<OperationResult<DiagnosticCase>>;
  deleteCase(
    caseId: string,
    confirmed: boolean,
  ): Promise<OperationResult<null>>;
  getCaseEvidence(caseId: string): Promise<OperationResult<CaseEvidence>>;
  updateCaseEvidence(
    input: UpdateCaseEvidenceInput,
  ): Promise<OperationResult<CaseEvidence>>;
  previewCaseExport(
    caseId: string,
  ): Promise<OperationResult<CaseExportPreview>>;
  exportCase(
    caseId: string,
    confirmed: boolean,
  ): Promise<OperationResult<ArtifactDescriptor>>;
  importCase(): Promise<OperationResult<DiagnosticCase | null>>;
  generateSupportBundle(): Promise<OperationResult<ArtifactDescriptor>>;
  compareTargets(
    targetIds: readonly string[],
  ): Promise<OperationResult<MultiTargetComparison>>;
  listDiagnosticTemplates(): Promise<
    OperationResult<readonly DiagnosticTemplate[]>
  >;
  createSignedDiagnosticTemplate(
    input: CreateDiagnosticTemplateInput,
  ): Promise<OperationResult<DiagnosticTemplate>>;
  deleteDiagnosticTemplate(
    templateId: string,
    confirmed: boolean,
  ): Promise<OperationResult<null>>;
  executeDiagnosticTemplate(
    templateId: string,
    targetId: string,
    confirmed: boolean,
  ): Promise<OperationResult<ActionResult>>;
  listPlugins(): Promise<OperationResult<readonly PluginDescriptor[]>>;
  previewPluginImport(): Promise<
    OperationResult<ImportPreview<PluginDescriptor> | null>
  >;
  installPlugin(
    previewId: string,
    confirmed: boolean,
  ): Promise<OperationResult<PluginDescriptor>>;
  deletePlugin(
    pluginId: string,
    confirmed: boolean,
  ): Promise<OperationResult<null>>;
  previewTeamPolicyImport(): Promise<
    OperationResult<ImportPreview<TeamPolicyDescriptor> | null>
  >;
  activateTeamPolicy(
    previewId: string,
    confirmed: boolean,
  ): Promise<OperationResult<TeamPolicyDescriptor>>;
  getActiveTeamPolicy(): Promise<OperationResult<TeamPolicyDescriptor | null>>;
  removeTeamPolicy(confirmed: boolean): Promise<OperationResult<null>>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<OperationResult<UpdateStatus>>;
  downloadUpdate(confirmed: boolean): Promise<OperationResult<UpdateStatus>>;
  installUpdate(confirmed: boolean): Promise<OperationResult<null>>;
  inspectExitImpact(): Promise<OperationResult<ExitImpactSummary>>;
  resolveAppExit(input: ResolveAppExitInput): Promise<OperationResult<null>>;
  onAppExitRequested(listener: (reason: AppExitReason) => void): () => void;
  onDiagnosticAlertsChanged(listener: () => void): () => void;
  onOpenDiagnosticEvidence(listener: (artifactId: string) => void): () => void;
}

export const IPC_CHANNELS = {
  runtimeInfo: "tanwei:runtime-info",
  getSettings: "tanwei:get-settings",
  updateSettings: "tanwei:update-settings",
  listTargets: "tanwei:list-targets",
  listConnections: "tanwei:list-connections",
  connectTarget: "tanwei:connect-target",
  previewSshRemote: "tanwei:preview-ssh-remote",
  listKubernetesContexts: "tanwei:list-kubernetes-contexts",
  listKubernetesNamespaces: "tanwei:list-kubernetes-namespaces",
  listKubernetesPods: "tanwei:list-kubernetes-pods",
  previewKubernetesRemote: "tanwei:preview-kubernetes-remote",
  previewPersistentRelay: "tanwei:preview-persistent-relay",
  deployRemote: "tanwei:deploy-remote",
  cancelRemotePreview: "tanwei:cancel-remote-preview",
  disconnectTarget: "tanwei:disconnect-target",
  getSnapshot: "tanwei:get-snapshot",
  listThreads: "tanwei:list-threads",
  listClasses: "tanwei:list-classes",
  getClassDetails: "tanwei:get-class-details",
  executeAction: "tanwei:execute-action",
  getObservationEvents: "tanwei:get-observation-events",
  cancelObservation: "tanwei:cancel-observation",
  listThreadPoolAliases: "tanwei:list-thread-pool-aliases",
  upsertThreadPoolAlias: "tanwei:upsert-thread-pool-alias",
  deleteThreadPoolAlias: "tanwei:delete-thread-pool-alias",
  listArtifacts: "tanwei:list-artifacts",
  listDiagnosticAlerts: "tanwei:list-diagnostic-alerts",
  listJitRegressionBaselines: "tanwei:list-jit-regression-baselines",
  acknowledgeDiagnosticAlert: "tanwei:acknowledge-diagnostic-alert",
  acknowledgeAllDiagnosticAlerts: "tanwei:acknowledge-all-diagnostic-alerts",
  diagnosticAlertsChanged: "tanwei:diagnostic-alerts-changed",
  openDiagnosticEvidence: "tanwei:open-diagnostic-evidence",
  createSnapshotArtifact: "tanwei:create-snapshot-artifact",
  createHeapHistogramArtifact: "tanwei:create-heap-histogram-artifact",
  createThreadPoolTrendArtifact: "tanwei:create-thread-pool-trend-artifact",
  createJitTrendArtifact: "tanwei:create-jit-trend-artifact",
  createTraceHotspotArtifact: "tanwei:create-trace-hotspot-artifact",
  createMonitorWindowsArtifact: "tanwei:create-monitor-windows-artifact",
  collectAgentArtifact: "tanwei:collect-agent-artifact",
  decompileClassArtifact: "tanwei:decompile-class-artifact",
  compileClassSource: "tanwei:compile-class-source",
  compileClassChangeSet: "tanwei:compile-class-change-set",
  listClassChangeSetDrafts: "tanwei:list-class-change-set-drafts",
  replaceClassChangeSetDrafts: "tanwei:replace-class-change-set-drafts",
  deleteArtifact: "tanwei:delete-artifact",
  verifyArtifact: "tanwei:verify-artifact",
  openProfileReport: "tanwei:open-profile-report",
  inspectJfrArtifact: "tanwei:inspect-jfr-artifact",
  inspectThreadDumpArtifact: "tanwei:inspect-thread-dump-artifact",
  compareThreadDumpArtifacts: "tanwei:compare-thread-dump-artifacts",
  inspectHeapHistogramArtifact: "tanwei:inspect-heap-histogram-artifact",
  compareHeapHistogramArtifacts: "tanwei:compare-heap-histogram-artifacts",
  inspectThreadPoolTrendArtifact: "tanwei:inspect-thread-pool-trend-artifact",
  inspectJitTrendArtifact: "tanwei:inspect-jit-trend-artifact",
  inspectObservationExportArtifact:
    "tanwei:inspect-observation-export-artifact",
  compareThreadPoolTrendArtifacts: "tanwei:compare-thread-pool-trend-artifacts",
  compareJitTrendArtifacts: "tanwei:compare-jit-trend-artifacts",
  revealArtifact: "tanwei:reveal-artifact",
  listCases: "tanwei:list-cases",
  listActionAudits: "tanwei:list-action-audits",
  queryActionAudits: "tanwei:query-action-audits",
  saveInvocationSnapshot: "tanwei:save-invocation-snapshot",
  queryPersistedInvocationSnapshots:
    "tanwei:query-persisted-invocation-snapshots",
  getPersistedInvocationSnapshot:
    "tanwei:get-persisted-invocation-snapshot",
  deletePersistedInvocationSnapshot:
    "tanwei:delete-persisted-invocation-snapshot",
  createCase: "tanwei:create-case",
  archiveCase: "tanwei:archive-case",
  deleteCase: "tanwei:delete-case",
  getCaseEvidence: "tanwei:get-case-evidence",
  updateCaseEvidence: "tanwei:update-case-evidence",
  previewCaseExport: "tanwei:preview-case-export",
  exportCase: "tanwei:export-case",
  importCase: "tanwei:import-case",
  generateSupportBundle: "tanwei:generate-support-bundle",
  compareTargets: "tanwei:compare-targets",
  listDiagnosticTemplates: "tanwei:list-diagnostic-templates",
  createSignedDiagnosticTemplate: "tanwei:create-signed-diagnostic-template",
  deleteDiagnosticTemplate: "tanwei:delete-diagnostic-template",
  executeDiagnosticTemplate: "tanwei:execute-diagnostic-template",
  listPlugins: "tanwei:list-plugins",
  previewPluginImport: "tanwei:preview-plugin-import",
  installPlugin: "tanwei:install-plugin",
  deletePlugin: "tanwei:delete-plugin",
  previewTeamPolicyImport: "tanwei:preview-team-policy-import",
  activateTeamPolicy: "tanwei:activate-team-policy",
  getActiveTeamPolicy: "tanwei:get-active-team-policy",
  removeTeamPolicy: "tanwei:remove-team-policy",
  getUpdateStatus: "tanwei:get-update-status",
  checkForUpdates: "tanwei:check-for-updates",
  downloadUpdate: "tanwei:download-update",
  installUpdate: "tanwei:install-update",
  inspectExitImpact: "tanwei:inspect-exit-impact",
  resolveAppExit: "tanwei:resolve-app-exit",
  appExitRequested: "tanwei:app-exit-requested",
} as const;
