package dev.tanwei.agent;

import dev.tanwei.protocol.BuildMetadata;
import dev.tanwei.protocol.ProtocolCompatibility;
import dev.tanwei.protocol.v1.ActionRequest;
import dev.tanwei.protocol.v1.ActionResponse;
import dev.tanwei.protocol.v1.ArtifactChunk;
import dev.tanwei.protocol.v1.ArtifactDownloadRequest;
import dev.tanwei.protocol.v1.CapabilitiesRequest;
import dev.tanwei.protocol.v1.CapabilitiesResponse;
import dev.tanwei.protocol.v1.Capability;
import dev.tanwei.protocol.v1.ClassDescriptor;
import dev.tanwei.protocol.v1.ClassDetailsRequest;
import dev.tanwei.protocol.v1.ClassDetailsResponse;
import dev.tanwei.protocol.v1.ClassListRequest;
import dev.tanwei.protocol.v1.ClassListResponse;
import dev.tanwei.protocol.v1.DiagnosticServiceGrpc;
import dev.tanwei.protocol.v1.MetricStreamRequest;
import dev.tanwei.protocol.v1.MethodDescriptor;
import dev.tanwei.protocol.v1.ObservationEventsRequest;
import dev.tanwei.protocol.v1.ObservationEventsResponse;
import dev.tanwei.protocol.v1.ObservationTaskRequest;
import dev.tanwei.protocol.v1.ObservationTaskResponse;
import dev.tanwei.protocol.v1.RemoteArtifactRequest;
import dev.tanwei.protocol.v1.RemoteArtifactResponse;
import dev.tanwei.protocol.v1.RuntimeSnapshot;
import dev.tanwei.protocol.v1.ShutdownRequest;
import dev.tanwei.protocol.v1.ShutdownResponse;
import dev.tanwei.protocol.v1.SnapshotRequest;
import dev.tanwei.protocol.v1.ThreadListRequest;
import dev.tanwei.protocol.v1.ThreadListResponse;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.grpc.Status;
import com.google.protobuf.ByteString;
import java.io.BufferedInputStream;
import java.io.IOException;
import java.lang.instrument.Instrumentation;
import java.lang.annotation.Annotation;
import java.lang.reflect.Modifier;
import java.lang.management.ManagementFactory;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.MemoryPoolMXBean;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.net.URL;
import java.net.URLClassLoader;
import java.security.MessageDigest;
import java.util.IdentityHashMap;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.Enumeration;
import java.util.Objects;
import java.util.logging.LogManager;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class DiagnosticApplicationService extends DiagnosticServiceGrpc.DiagnosticServiceImplBase
    implements AutoCloseable {
  private static final String AGENT_VERSION = BuildMetadata.PRODUCT_VERSION;
  private static final int DEFAULT_PAGE_SIZE = 100;
  private static final int MAXIMUM_PAGE_SIZE = 1_000;
  private static final long MINIMUM_STREAM_INTERVAL_MILLIS = 250L;
  private static final long MAXIMUM_STREAM_INTERVAL_MILLIS = 60_000L;
  private static final int MAXIMUM_PROPERTY_VALUE_LENGTH = 4_096;
  private static final int MAXIMUM_METHODS_PER_CLASS = 2_000;
  private static final int ARTIFACT_CHUNK_SIZE = 64 * 1_024;

  private final Instrumentation instrumentation;
  private final ClassQueryService classQueries;
  private final RetransformLifecycle retransforms;
  private final ScheduledExecutorService scheduler;
  private final Runnable shutdownCallback;
  private final RuntimeSnapshotCollector snapshotCollector = new RuntimeSnapshotCollector();
  private final AgentArtifactRegistry artifacts;
  private final JfrController jfr;
  private final ClassDumpController classDump;
  private final ClassRedefinitionController classRedefinition;
  private final ClassLoaderResourceExplorer classLoaderResources;
  private final ClassLoaderMetaspaceInspector classLoaderMetaspace;
  private final StaticFieldExplorer staticFields;
  private final HeapInstanceController heapInstances;
  private final ThreadPoolLatencyController threadPoolLatency;
  private final InvocationReplayController invocationReplay;
  private final ObservationController observations;
  private final LineProbeController lineProbes;
  private final MethodMonitorController monitors;
  private final TraceController traces;
  private final SamplingProfilerController profiler;
  private final MBeanExplorer mbeans = new MBeanExplorer();
  private final ThreadLockExplorer threadLocks = new ThreadLockExplorer();
  private final ThreadQueryService threadQueries = new ThreadQueryService();
  private final ThreadDumpController threadDumps =
      new ThreadDumpController();
  private final LoggerExplorer loggers;
  private final PerfCounterExplorer perfCounters;
  private final JitCompilerInspector jitCompiler;
  private final EnvironmentExplorer environment = new EnvironmentExplorer();
  private final SystemPropertyExplorer systemPropertyExplorer =
      new SystemPropertyExplorer();
  private final VmOptionExplorer vmOptionExplorer = new VmOptionExplorer();

  DiagnosticApplicationService(
      Instrumentation instrumentation,
      ScheduledExecutorService scheduler,
      Runnable shutdownCallback)
      throws Exception {
    this.instrumentation = instrumentation;
    this.classQueries = new ClassQueryService(instrumentation);
    this.scheduler = scheduler;
    this.shutdownCallback = shutdownCallback;
    this.artifacts = new AgentArtifactRegistry();
    this.retransforms = new RetransformLifecycle(instrumentation);
    this.jfr = new JfrController(artifacts);
    this.classDump = new ClassDumpController(instrumentation, artifacts);
    this.lineProbes =
        new LineProbeController(
            instrumentation, scheduler, classDump, retransforms);
    this.classRedefinition =
        new ClassRedefinitionController(instrumentation, classDump);
    this.classLoaderResources =
        new ClassLoaderResourceExplorer(instrumentation);
    this.classLoaderMetaspace = new ClassLoaderMetaspaceInspector();
    this.staticFields = new StaticFieldExplorer(instrumentation);
    this.heapInstances = new HeapInstanceController(instrumentation);
    this.threadPoolLatency =
        new ThreadPoolLatencyController(
            instrumentation, heapInstances, scheduler, retransforms);
    this.observations =
        new ObservationController(instrumentation, scheduler, retransforms);
    this.invocationReplay =
        new InvocationReplayController(
            instrumentation, observations::receiverState);
    this.monitors =
        new MethodMonitorController(instrumentation, scheduler, retransforms);
    this.traces = new TraceController(instrumentation, scheduler, retransforms);
    this.profiler = new SamplingProfilerController(scheduler, artifacts);
    this.loggers = new LoggerExplorer(instrumentation);
    this.perfCounters = new PerfCounterExplorer(instrumentation, currentPid());
    this.jitCompiler = new JitCompilerInspector(perfCounters);
  }

  @Override
  public void getCapabilities(
      CapabilitiesRequest request, StreamObserver<CapabilitiesResponse> responseObserver) {
    String protocolError =
        ProtocolCompatibility.compatibilityError(
            request.getClientProtocolVersion(), ProtocolCompatibility.CURRENT_VERSION);
    if (protocolError != null) {
      responseObserver.onError(
          Status.FAILED_PRECONDITION
              .withDescription(
                  protocolError
                      + ": Host protocol "
                      + request.getClientProtocolVersion()
                      + " is incompatible with Agent protocol "
                      + ProtocolCompatibility.CURRENT_VERSION)
              .asRuntimeException());
      return;
    }
    CapabilitiesResponse response =
        CapabilitiesResponse.newBuilder()
            .setProtocolVersion(ProtocolCompatibility.CURRENT_VERSION)
            .setAgentVersion(AGENT_VERSION)
            .setProcessId(currentPid())
            .setJavaVersion(System.getProperty("java.version", "unknown"))
            .addCapabilities(capability("overview", "AVAILABLE", ""))
            .addCapabilities(capability("threads", "AVAILABLE", ""))
            .addCapabilities(
                capability(
                    "thread-locks",
                    "AVAILABLE",
                    "Bounded monitor and ownable-synchronizer relationship inspection"))
            .addCapabilities(
                capability(
                    "thread-pools",
                    heapInstances.isPotentiallyAvailable()
                        ? "AVAILABLE"
                        : "UNSUPPORTED",
                    heapInstances.isPotentiallyAvailable()
                        ? "Bounded exact JDK executor discovery with runtime counters"
                        : heapInstances.unavailableReason()))
            .addCapabilities(
                capability(
                    "thread-pool-latency",
                    threadPoolLatency.isAvailable()
                        ? "AVAILABLE"
                        : "UNSUPPORTED",
                    threadPoolLatency.isAvailable()
                        ? "Bounded opt-in queue-wait and worker-execution attribution for one exact ThreadPoolExecutor"
                        : "JVM does not support exact ThreadPoolExecutor latency attribution"))
            .addCapabilities(
                capability(
                    "thread-dump",
                    "AVAILABLE",
                    "Bounded UTF-8 thread dump artifact with optional monitor and synchronizer details"))
            .addCapabilities(
                capability(
                    "thread-control",
                    "AVAILABLE",
                    "Exact thread interrupt with preview, identity check and protected-thread denylist"))
            .addCapabilities(capability("classes", "AVAILABLE", ""))
            .addCapabilities(
                capability(
                    "static-fields",
                    "AVAILABLE",
                    "Metadata-first static field inspection with confirmed bounded single-value reads"))
            .addCapabilities(
                capability(
                    "classloaders",
                    "AVAILABLE",
                    "Loaded-class ownership plus bounded exact-loader resource conflict lookup"))
            .addCapabilities(
                capability(
                    "classloader-metaspace",
                    classLoaderMetaspace.isAvailable()
                        ? "AVAILABLE"
                        : "UNSUPPORTED",
                    classLoaderMetaspace.isAvailable()
                        ? "Bounded JFR ClassLoaderData metaspace allocation and usage inspection"
                        : classLoaderMetaspace.unavailableReason()))
            .addCapabilities(
                capability(
                    "runtime",
                    "AVAILABLE",
                    "JVM facts plus bounded searchable system-property, environment and HotSpot VM-option inspectors"))
            .addCapabilities(
                capability(
                    "perfcounters",
                    perfCounters.isAvailable() ? "AVAILABLE" : "UNSUPPORTED",
                    perfCounters.isAvailable()
                        ? "Bounded read-only HotSpot performance counter inspection and exact multi-counter snapshots"
                        : perfCounters.unavailableReason()))
            .addCapabilities(
                capability(
                    "tasks",
                    "AVAILABLE",
                    "Unified listing, exact cancellation and fingerprinted reset of Tanwei-owned tasks and class replacements"))
            .addCapabilities(
                capability(
                    "arthas-ecosystem",
                    "AVAILABLE",
                    "Versioned machine-readable Arthas command mapping over authenticated Tanwei gRPC actions; not Telnet/HTTP wire-compatible"))
            .addCapabilities(
                capability(
                    "mbeans",
                    "AVAILABLE",
                    "Search, metadata, bounded structured OpenType reads and writes, fingerprinted scalar writes and operation invocation"))
            .addCapabilities(
                capability(
                    "loggers",
                    "AVAILABLE",
                    "JUL, loaded Logback and loaded Log4j2 inspection plus fingerprinted framework-native level changes"))
            .addCapabilities(
                capability(
                    "runtime-mutation",
                    "AVAILABLE",
                    "Existing non-sensitive system properties, framework-native logger levels, writeable HotSpot VM options and explicit GC"))
            .addCapabilities(
                capability(
                    "jfr",
                    jfr.isAvailable() ? "AVAILABLE" : "UNSUPPORTED",
                    jfr.isAvailable() ? "" : "JFR requires JDK 11 or later"))
            .addCapabilities(capability("heap-dump", "AVAILABLE", ""))
            .addCapabilities(
                capability(
                    "class-dump",
                    classDump.isAvailable() ? "AVAILABLE" : "UNSUPPORTED",
                    classDump.isAvailable()
                        ? ""
                        : "JVM does not support class retransformation"))
            .addCapabilities(
                capability(
                    "class-redefine",
                    classRedefinition.isAvailable() ? "AVAILABLE" : "UNSUPPORTED",
                    classRedefinition.isAvailable()
                        ? "Method-body replacement with schema validation and bounded in-memory rollback"
                        : "JVM does not support class redefinition"))
            .addCapabilities(
                capability(
                    "invoke-replay",
                    "AVAILABLE",
                    "Double-confirmed replay for public static methods with scalar arguments"))
            .addCapabilities(
                capability(
                    "heap-instances",
                    heapInstances.isPotentiallyAvailable()
                        ? "AVAILABLE"
                        : "UNSUPPORTED",
                    heapInstances.isPotentiallyAvailable()
                        ? "Bounded JVMTI heap histogram, class-level retained unions, an interactive dominator tree, exact-class instances, opaque session handles, multi-layer object graphs, multi-path GC Root analysis, per-object retained size and shared-scan retained-size rankings"
                        : heapInstances.unavailableReason()))
            .addCapabilities(
                capability(
                    "observe",
                    instrumentation.isRetransformClassesSupported()
                        ? "AVAILABLE"
                        : "UNSUPPORTED",
                    instrumentation.isRetransformClassesSupported()
                        ? ""
                        : "JVM does not support class retransformation"))
            .addCapabilities(
                capability(
                    "line-probe",
                    classDump.isAvailable() ? "AVAILABLE" : "UNSUPPORTED",
                    classDump.isAvailable()
                        ? "Bounded exact source-line probes with safe local-variable and caller-stack snapshots"
                        : "JVM does not support class retransformation"))
            .addCapabilities(
                capability(
                    "snapshots",
                    "AVAILABLE",
                    "Session-scoped bounded index of rendered observation snapshots without target object retention"))
            .addCapabilities(
                capability(
                    "monitor",
                    instrumentation.isRetransformClassesSupported()
                        ? "AVAILABLE"
                        : "UNSUPPORTED",
                    instrumentation.isRetransformClassesSupported()
                        ? "Bounded periodic call, failure, average, P95, P99 and maximum latency windows for one exact method"
                        : "JVM does not support class retransformation"))
            .addCapabilities(
                capability(
                    "trace",
                    instrumentation.isRetransformClassesSupported()
                        ? "AVAILABLE"
                        : "UNSUPPORTED",
                    instrumentation.isRetransformClassesSupported()
                        ? "Bounded cross-class call trees with declarative include/exclude path filters within one ClassLoader and package scope"
                        : "JVM does not support class retransformation"))
            .addCapabilities(
                capability(
                    "retransform",
                    instrumentation.isRetransformClassesSupported() ? "AVAILABLE" : "UNSUPPORTED",
                    instrumentation.isRetransformClassesSupported()
                        ? "Serialized class ownership, exact rollback, failed-rollback retention and explicit recovery"
                        : "JVM does not support retransformation"))
            .addCapabilities(
                capability(
                    "profiler",
                    "AVAILABLE",
                    profiler.supportsNative()
                        ? "async-profiler 4.5: CPU, Wall, Allocation and Lock; lazy native loading"
                        : profiler.supportsAllocation()
                            ? "JDK fallback: CPU, Wall, Allocation and Lock bounded sampling"
                            : "JDK fallback: CPU, Wall and Lock bounded sampling; allocation unavailable"))
            .build();
    responseObserver.onNext(response);
    responseObserver.onCompleted();
  }

  @Override
  public void getSnapshot(
      SnapshotRequest request, StreamObserver<RuntimeSnapshot> responseObserver) {
    responseObserver.onNext(snapshotCollector.collect());
    responseObserver.onCompleted();
  }

  @Override
  public void streamMetrics(
      MetricStreamRequest request, StreamObserver<RuntimeSnapshot> responseObserver) {
    final long interval =
        Math.max(
            MINIMUM_STREAM_INTERVAL_MILLIS,
            Math.min(MAXIMUM_STREAM_INTERVAL_MILLIS, request.getIntervalMillis()));
    final int maximumEvents = request.getMaxEvents() <= 0 ? 300 : request.getMaxEvents();
    final AtomicInteger emitted = new AtomicInteger();
    final ScheduledFuture<?>[] taskReference = new ScheduledFuture<?>[1];

    Runnable task =
        () -> {
          if (emitted.incrementAndGet() > maximumEvents) {
            ScheduledFuture<?> taskFuture = taskReference[0];
            if (taskFuture != null) {
              taskFuture.cancel(false);
            }
            responseObserver.onCompleted();
            return;
          }
          try {
            responseObserver.onNext(snapshotCollector.collect());
          } catch (RuntimeException exception) {
            ScheduledFuture<?> taskFuture = taskReference[0];
            if (taskFuture != null) {
              taskFuture.cancel(false);
            }
          }
        };
    taskReference[0] =
        scheduler.scheduleAtFixedRate(task, 0L, interval, TimeUnit.MILLISECONDS);

    if (responseObserver instanceof ServerCallStreamObserver) {
      @SuppressWarnings("unchecked")
      ServerCallStreamObserver<RuntimeSnapshot> serverObserver =
          (ServerCallStreamObserver<RuntimeSnapshot>) responseObserver;
      serverObserver.setOnCancelHandler(() -> taskReference[0].cancel(false));
    }
  }

  @Override
  public void listThreads(
      ThreadListRequest request, StreamObserver<ThreadListResponse> responseObserver) {
    responseObserver.onNext(threadQueries.list(request));
    responseObserver.onCompleted();
  }

  @Override
  public void listClasses(
      ClassListRequest request, StreamObserver<ClassListResponse> responseObserver) {
    responseObserver.onNext(classQueries.list(request));
    responseObserver.onCompleted();
  }

  @Override
  public void getClassDetails(
      ClassDetailsRequest request,
      StreamObserver<ClassDetailsResponse> responseObserver) {
    Class<?> matched = null;
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      if (type.getName().equals(request.getName())
          && classLoaderName(type).equals(request.getClassLoader())) {
        matched = type;
        break;
      }
    }
    if (matched == null) {
      responseObserver.onNext(
          ClassDetailsResponse.newBuilder()
              .setFound(false)
              .setErrorCode("CLASS_NOT_FOUND")
              .build());
      responseObserver.onCompleted();
      return;
    }

    ClassDetailsResponse.Builder response =
        ClassDetailsResponse.newBuilder()
            .setFound(true)
            .setName(matched.getName())
            .setClassLoader(classLoaderName(matched))
            .setCodeSource(codeSource(matched))
            .setModifiers(Modifier.toString(matched.getModifiers()));
    if (matched.getSuperclass() != null) {
      response.setSuperClass(matched.getSuperclass().getTypeName());
    }
    for (Class<?> implemented : matched.getInterfaces()) {
      response.addInterfaces(implemented.getTypeName());
    }
    addAnnotations(response, safeAnnotations(matched));

    List<java.lang.reflect.Method> methods =
        new ArrayList<java.lang.reflect.Method>();
    Collections.addAll(methods, matched.getDeclaredMethods());
    methods.sort(
        Comparator.comparing(java.lang.reflect.Method::getName)
            .thenComparing(java.lang.reflect.Method::toGenericString));
    int limit = Math.min(methods.size(), MAXIMUM_METHODS_PER_CLASS);
    for (int index = 0; index < limit; index++) {
      response.addMethods(methodDescriptor(methods.get(index)));
    }
    responseObserver.onNext(response.build());
    responseObserver.onCompleted();
  }

  @Override
  public void executeAction(
      ActionRequest request, StreamObserver<ActionResponse> responseObserver) {
    ActionResponse response;
    switch (request.getActionId()) {
      case "jvm.info":
        response =
            ActionResponse.newBuilder()
                .setStatus("SUCCEEDED")
                .putValues("java.version", System.getProperty("java.version", "unknown"))
                .putValues("java.vendor", System.getProperty("java.vendor", "unknown"))
                .putValues("vm.name", System.getProperty("java.vm.name", "unknown"))
                .build();
        break;
      case "jvm.arguments":
        response =
            actionValues(
                indexedValues(
                    ManagementFactory.getRuntimeMXBean().getInputArguments()));
        break;
      case "system.properties":
        response = actionValues(systemProperties());
        break;
      case "system.property.list":
        response = listSystemProperties(request);
        break;
      case "environment.summary":
        response = actionValues(environmentSummary());
        break;
      case "environment.list":
        response = listEnvironment(request);
        break;
      case "memory.pools":
        response = actionValues(memoryPools());
        break;
      case "gc.collectors":
        response = actionValues(garbageCollectors());
        break;
      case "jit.compiler.summary":
        response = actionValues(jitCompiler.snapshot());
        break;
      case "perfcounter.list":
        response = listPerfCounters(request);
        break;
      case "perfcounter.snapshot":
        response = snapshotPerfCounters(request);
        break;
      case "mbeans.summary":
        response = actionValues(mbeanSummary());
        break;
      case "mbean.list":
        response = listMBeans(request);
        break;
      case "mbean.describe":
        response = describeMBean(request);
        break;
      case "mbean.attribute.read":
        response = readMBeanAttribute(request);
        break;
      case "mbean.attribute.write.preview":
        response = previewMBeanAttributeWrite(request);
        break;
      case "mbean.attribute.write":
        response = writeMBeanAttribute(request);
        break;
      case "mbean.operation.preview":
        response = previewMBeanOperation(request);
        break;
      case "mbean.operation.invoke":
        response = invokeMBeanOperation(request);
        break;
      case "thread.interrupt.preview":
        response = previewThreadInterrupt(request);
        break;
      case "thread.interrupt":
        response = interruptThread(request);
        break;
      case "thread.locks":
        response = inspectThreadLocks(request);
        break;
      case "thread.pools":
        response = inspectThreadPools(request);
        break;
      case "thread.pool.latency.start":
        response = startThreadPoolLatency(request);
        break;
      case "thread.pool.latency.snapshot":
        response = snapshotThreadPoolLatency(request);
        break;
      case "thread.pool.latency.stop":
        response = stopThreadPoolLatency(request);
        break;
      case "thread.dump":
        response = createThreadDump(request);
        break;
      case "vm.options":
        response = actionValues(vmOptions());
        break;
      case "vm.option.list":
        response = listVmOptions(request);
        break;
      case "logging.summary":
        response = actionValues(loggingSummary());
        break;
      case "logger.list":
        response = listLoggers(request);
        break;
      case "logger.describe":
        response = describeLogger(request);
        break;
      case "logger.level.preview":
        response = previewLoggerLevel(request);
        break;
      case "logger.level.set":
        response = setLoggerLevel(request);
        break;
      case "system.property.set":
        response = setSystemProperty(request);
        break;
      case "logging.set":
        response = setLoggingLevel(request);
        break;
      case "vm.option.set":
        response = setVmOption(request);
        break;
      case "gc.run":
        response = requestGarbageCollection(request);
        break;
      case "classloaders.summary":
        response = actionValues(classLoaderSummary());
        break;
      case "classloader.metaspace":
        response = inspectClassLoaderMetaspace(request);
        break;
      case "tasks.list":
        response = listActiveTasks();
        break;
      case "tasks.cancel":
        response = cancelActiveTask(request);
        break;
      case "session.reset.preview":
        response = previewSessionReset();
        break;
      case "session.reset":
        response = resetSession(request);
        break;
      case "retransform.status":
        response = retransformStatus();
        break;
      case "retransform.retry":
        response = retryRetransformRollback(request);
        break;
      case "arthas.compatibility":
        response = arthasCompatibility();
        break;
      case "arthas.resolve":
        response = resolveArthasCommand(request);
        break;
      case "trace.preview":
        response = previewTrace(request);
        break;
      case "trace.start":
        response = startTrace(request);
        break;
      case "trace.threshold.update":
        response = updateTraceThreshold(request);
        break;
      case "trace.events":
        response = traceEvents(request);
        break;
      case "monitor.preview":
        response = previewMethodMonitor(request);
        break;
      case "monitor.start":
        response = startMethodMonitor(request);
        break;
      case "monitor.threshold.update":
        response = updateMethodMonitorThreshold(request);
        break;
      case "monitor.windows":
        response = methodMonitorWindows(request);
        break;
      case "profile.start":
        response = startProfile(request);
        break;
      case "profile.status":
        response = profileResult(
            profiler.status(request.getParametersOrDefault("taskId", "")));
        break;
      case "profile.dump":
        response = dumpProfile(request);
        break;
      case "profile.stop":
        response = profileResult(
            profiler.stop(request.getParametersOrDefault("taskId", "")));
        break;
      case "jfr.status":
        response = jfrStatus();
        break;
      case "jfr.start":
        response = startJfr(request);
        break;
      case "jfr.dump":
        response = dumpJfr();
        break;
      case "jfr.stop":
        response = stopJfr();
        break;
      case "heap.dump":
        response = createHeapDump(request);
        break;
      case "heap.histogram":
        response = queryHeapHistogram(request);
        break;
      case "heap.retained.classes":
        response = queryClassRetainedHistogram(request);
        break;
      case "heap.dominator.tree":
        response = queryHeapDominatorTree(request);
        break;
      case "heap.instances":
        response = queryHeapInstances(request);
        break;
      case "heap.relations":
        response = queryHeapRelations(request);
        break;
      case "heap.object.graph":
        response = queryHeapObjectGraph(request);
        break;
      case "heap.root.path":
        response = queryHeapRootPath(request);
        break;
      case "heap.root.paths":
        response = queryHeapRootPaths(request);
        break;
      case "heap.retained":
        response = queryHeapRetainedSize(request);
        break;
      case "heap.retained.ranking":
        response = queryHeapRetainedRanking(request);
        break;
      case "class.static.fields":
        response = listStaticFields(request);
        break;
      case "classloader.resources":
        response = inspectClassLoaderResources(request);
        break;
      case "class.static.read.preview":
        response = previewStaticFieldRead(request);
        break;
      case "class.static.read":
        response = readStaticField(request);
        break;
      case "class.dump":
        response = dumpClass(request);
        break;
      case "class.redefine.preview":
        response = previewClassRedefinition(request);
        break;
      case "class.redefine":
        response = redefineClass(request);
        break;
      case "class.redefine.restore":
        response = restoreClassDefinition(request);
        break;
      case "class.change-set.preview":
        response = previewClassChangeSet(request);
        break;
      case "class.change-set.apply":
        response = applyClassChangeSet(request);
        break;
      case "class.change-set.restore":
        response = restoreClassChangeSet(request);
        break;
      case "snapshot.list":
        response = listSnapshots(request);
        break;
      case "snapshot.describe":
        response = describeSnapshot(request);
        break;
      case "snapshot.delete":
        response = deleteSnapshot(request);
        break;
      case "observe.preview":
        response = previewObservation(request);
        break;
      case "observe.start":
        response = startObservation(request);
        break;
      case "line.preview":
        response = previewLineProbe(request);
        break;
      case "line.start":
        response = startLineProbe(request);
        break;
      case "line.events":
        response = lineProbeEvents(request);
        break;
      case "invoke.replay.preview":
        response = previewInvocationReplay(request);
        break;
      case "invoke.replay":
        response = invokeReplay(request);
        break;
      default:
        response =
            ActionResponse.newBuilder()
                .setStatus("FAILED")
                .setErrorCode("UNSUPPORTED_ACTION")
                .setMessage("Action is not available in this Agent version")
                .build();
    }
    responseObserver.onNext(response);
    responseObserver.onCompleted();
  }

  @Override
  public void downloadArtifact(
      ArtifactDownloadRequest request, StreamObserver<ArtifactChunk> responseObserver) {
    Path artifactPath = artifacts.resolve(request.getToken());
    if (artifactPath == null) {
      responseObserver.onError(
          Status.NOT_FOUND
              .withDescription("Artifact token was not found")
              .asRuntimeException());
      return;
    }

    byte[] buffer = new byte[ARTIFACT_CHUNK_SIZE];
    long sequence = 0L;
    try (BufferedInputStream input =
        new BufferedInputStream(Files.newInputStream(artifactPath), ARTIFACT_CHUNK_SIZE)) {
      int length;
      while ((length = input.read(buffer)) >= 0) {
        if (length == 0) {
          continue;
        }
        responseObserver.onNext(
            ArtifactChunk.newBuilder()
                .setSequence(sequence++)
                .setData(ByteString.copyFrom(buffer, 0, length))
                .build());
      }
      responseObserver.onCompleted();
    } catch (IOException exception) {
      responseObserver.onError(
          Status.INTERNAL
              .withDescription("Unable to read the temporary artifact")
              .withCause(exception)
              .asRuntimeException());
    }
  }

  @Override
  public void deleteArtifact(
      RemoteArtifactRequest request, StreamObserver<RemoteArtifactResponse> responseObserver) {
    try {
      responseObserver.onNext(
          RemoteArtifactResponse.newBuilder()
              .setDeleted(artifacts.delete(request.getToken()))
              .build());
      responseObserver.onCompleted();
    } catch (IOException exception) {
      responseObserver.onError(
          Status.INTERNAL
              .withDescription("Unable to delete the temporary artifact")
              .withCause(exception)
              .asRuntimeException());
    }
  }

  @Override
  public void getObservationEvents(
      ObservationEventsRequest request,
      StreamObserver<ObservationEventsResponse> responseObserver) {
    try {
      responseObserver.onNext(
          observations.events(
              request.getTaskId(),
              Math.max(1, Math.min(100, request.getLimit()))));
      responseObserver.onCompleted();
    } catch (Exception exception) {
      responseObserver.onError(
          Status.INTERNAL
              .withDescription("Unable to read observation events")
              .withCause(exception)
              .asRuntimeException());
    }
  }

  @Override
  public void cancelObservation(
      ObservationTaskRequest request,
      StreamObserver<ObservationTaskResponse> responseObserver) {
    responseObserver.onNext(
        ObservationTaskResponse.newBuilder()
            .setTaskId(request.getTaskId())
            .setState(observations.cancel(request.getTaskId()))
            .build());
    responseObserver.onCompleted();
  }

  @Override
  public void shutdown(
      ShutdownRequest request, StreamObserver<ShutdownResponse> responseObserver) {
    responseObserver.onNext(ShutdownResponse.newBuilder().setAccepted(true).build());
    responseObserver.onCompleted();
    scheduler.schedule(shutdownCallback, 100L, TimeUnit.MILLISECONDS);
  }

  @Override
  public void close() {
    profiler.close();
    traces.close();
    monitors.close();
    lineProbes.close();
    observations.close();
    threadPoolLatency.close();
    retransforms.close();
    jfr.close();
    classRedefinition.close();
    classLoaderResources.close();
    heapInstances.close();
    invocationReplay.close();
    mbeans.close();
    artifacts.close();
  }

  private ActionResponse startJfr(ActionRequest request) {
    try {
      long maxAgeMillis =
          boundedLong(
              request.getParametersOrDefault("maxAgeMillis", "0"),
              0L,
              86_400_000L,
              "maxAgeMillis");
      long maxSizeBytes =
          boundedLong(
              request.getParametersOrDefault("maxSizeBytes", "0"),
              0L,
              10_737_418_240L,
              "maxSizeBytes");
      String taskId =
          jfr.start(
              request.getParametersOrDefault("configuration", "PROFILE"),
              maxAgeMillis,
              maxSizeBytes,
              request.getParametersOrDefault(
                  "recordingName", "Tanwei Diagnostic Recording"));
      Map<String, String> values = new TreeMap<String, String>();
      values.put("kind", "JFR");
      values.put("taskId", taskId);
      values.put("running", "true");
      values.put(
          "startedAtEpochMillis",
          Long.toString(jfr.startedAtEpochMillis()));
      putJfrConfiguration(values);
      return actionValues(values);
    } catch (RuntimeException exception) {
      return actionFailure("JFR_START_FAILED", exception);
    }
  }

  private ActionResponse jfrStatus() {
    Map<String, String> values = new TreeMap<String, String>();
    values.put("kind", "JFR");
    values.put("running", Boolean.toString(jfr.isRunning()));
    values.put("taskId", jfr.currentTaskId());
    values.put(
        "startedAtEpochMillis",
        Long.toString(jfr.startedAtEpochMillis()));
    putJfrConfiguration(values);
    return actionValues(values);
  }

  private ActionResponse retransformStatus() {
    List<RetransformLifecycle.Snapshot> snapshots = retransforms.snapshots();
    Map<String, String> values = new TreeMap<String, String>();
    values.put("total", Integer.toString(snapshots.size()));
    int failed = 0;
    for (int index = 0; index < snapshots.size(); index++) {
      RetransformLifecycle.Snapshot snapshot = snapshots.get(index);
      if ("ROLLBACK_FAILED".equals(snapshot.getState())) {
        failed++;
      }
      String prefix = String.format(Locale.ROOT, "owner.%04d.", index);
      values.put(prefix + "ownerId", snapshot.getOwnerId());
      values.put(prefix + "kind", snapshot.getKind());
      values.put(prefix + "state", snapshot.getState());
      values.put(prefix + "error", trimValue(snapshot.getError()));
      values.put(prefix + "class.count", Integer.toString(snapshot.getClassNames().size()));
      for (int classIndex = 0;
          classIndex < snapshot.getClassNames().size();
          classIndex++) {
        values.put(
            prefix + String.format(Locale.ROOT, "class.%04d.name", classIndex),
            snapshot.getClassNames().get(classIndex));
      }
    }
    values.put("failed", Integer.toString(failed));
    values.put(
        "boundary",
        "ROLLBACK_FAILED owners retain class claims until an explicit retry succeeds");
    return actionValues(values);
  }

  private ActionResponse retryRetransformRollback(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    String ownerId = request.getParametersOrDefault("ownerId", "");
    try {
      if (!retransforms.retry(ownerId)) {
        return actionError("RETRANSFORM_OWNER_NOT_FOUND", "Retransformation owner was not found");
      }
      Map<String, String> values = new TreeMap<String, String>();
      values.put("ownerId", ownerId);
      values.put("state", "ROLLED_BACK");
      values.put("claimReleased", "true");
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("RETRANSFORM_RETRY_FAILED", exception);
    }
  }

  private ActionResponse arthasCompatibility() {
    List<ArthasEcosystemManifest.Entry> entries = ArthasEcosystemManifest.all();
    Map<String, String> values = arthasProtocolValues();
    values.put("mapping.count", Integer.toString(entries.size()));
    values.put(
        "command.count",
        Integer.toString(ArthasEcosystemManifest.commands().size()));
    values.put(
        "ecosystem.count",
        Integer.toString(ArthasEcosystemManifest.ecosystem().size()));
    for (int index = 0; index < entries.size(); index++) {
      putArthasMapping(values, String.format(Locale.ROOT, "mapping.%04d.", index), entries.get(index));
    }
    return actionValues(values);
  }

  private ActionResponse resolveArthasCommand(ActionRequest request) {
    ArthasEcosystemManifest.Entry entry =
        ArthasEcosystemManifest.resolve(request.getParametersOrDefault("command", ""));
    if (entry == null) {
      return actionError("ARTHAS_COMMAND_NOT_MAPPED", "Arthas command is not present in the compatibility manifest");
    }
    Map<String, String> values = arthasProtocolValues();
    putArthasMapping(values, "mapping.", entry);
    return actionValues(values);
  }

  private static Map<String, String> arthasProtocolValues() {
    Map<String, String> values = new TreeMap<String, String>();
    values.put("schema", "tanwei.arthas-ecosystem.v1");
    values.put("baseline.version", ArthasEcosystemManifest.BASELINE_VERSION);
    values.put("transport", "authenticated-loopback-grpc");
    values.put("rpc", "tanwei.protocol.v1.DiagnosticService/ExecuteAction");
    values.put("wireCompatible", "false");
    values.put("arbitraryCommandExecution", "false");
    return values;
  }

  private static void putArthasMapping(
      Map<String, String> values,
      String prefix,
      ArthasEcosystemManifest.Entry entry) {
    values.put(prefix + "scope", entry.getScope());
    values.put(prefix + "command", entry.getCommand());
    values.put(prefix + "compatibility", entry.getCompatibility());
    values.put(prefix + "capability", entry.getCapability());
    values.put(prefix + "actionIds", entry.getActionIds());
    values.put(prefix + "boundary", entry.getBoundary());
  }

  private ActionResponse dumpJfr() {
    try {
      String taskId = jfr.currentTaskId();
      JfrController.ArtifactInfo artifact = jfr.dump();
      Map<String, String> values = new TreeMap<String, String>();
      values.put("kind", "JFR");
      values.put("taskId", taskId);
      values.put("state", "RUNNING");
      values.put("running", "true");
      values.put("token", artifact.getToken());
      values.put("name", artifact.getName());
      values.put("size", Long.toString(artifact.getSize()));
      values.put("type", "JFR");
      putJfrConfiguration(values);
      return actionValues(values);
    } catch (RuntimeException exception) {
      return actionFailure("JFR_DUMP_FAILED", exception);
    }
  }

  private void putJfrConfiguration(Map<String, String> values) {
    values.put("recordingId", Long.toString(jfr.currentRecordingId()));
    values.put("recordingName", jfr.currentRecordingName());
    values.put("configuration", jfr.currentConfiguration());
    values.put("maxAgeMillis", Long.toString(jfr.currentMaxAgeMillis()));
    values.put("maxSizeBytes", Long.toString(jfr.currentMaxSizeBytes()));
  }

  private ActionResponse listActiveTasks() {
    try {
      List<ActiveTaskSummary> tasks = activeTaskSummaries();

      Map<String, String> values = new TreeMap<String, String>();
      values.put("total", Integer.toString(tasks.size()));
      for (int index = 0; index < tasks.size(); index++) {
        ActiveTaskSummary task = tasks.get(index);
        String prefix = String.format(Locale.ROOT, "task.%04d.", index);
        values.put(prefix + "kind", task.kind);
        values.put(prefix + "taskId", task.taskId);
        values.put(prefix + "state", task.state);
        values.put(prefix + "title", trimValue(task.title));
        values.put(prefix + "detail", trimValue(task.detail));
        values.put(
            prefix + "startedAtEpochMillis",
            Long.toString(task.startedAtEpochMillis));
        values.put(
            prefix + "deadlineEpochMillis",
            Long.toString(task.deadlineEpochMillis));
        values.put(prefix + "current", Long.toString(task.current));
        values.put(prefix + "maximum", Long.toString(task.maximum));
        values.put(prefix + "dropped", Long.toString(task.dropped));
      }
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("TASK_LIST_FAILED", exception);
    }
  }

  private List<ActiveTaskSummary> activeTaskSummaries() {
    List<ActiveTaskSummary> tasks = new ArrayList<ActiveTaskSummary>();
    for (ObservationController.TaskSnapshot task : observations.activeTasks()) {
      tasks.add(
          new ActiveTaskSummary(
              "OBSERVATION",
              task.getTaskId(),
              task.getState(),
              task.getClassName(),
              task.getMethod(),
              task.getStartedAtEpochMillis(),
              task.getDeadlineEpochMillis(),
              task.getCaptured(),
              task.getMaximumEvents(),
              task.getDropped()));
    }
    for (LineProbeController.TaskSnapshot task : lineProbes.activeTasks()) {
      tasks.add(
          new ActiveTaskSummary(
              "LINE",
              task.getTaskId(),
              task.getState(),
              task.getClassName() + ":" + task.getLineNumber(),
              task.getMethod(),
              task.getStartedAtEpochMillis(),
              task.getDeadlineEpochMillis(),
              task.getCaptured(),
              task.getMaximumEvents(),
              task.getDropped()));
    }
    for (MethodMonitorController.TaskSnapshot task : monitors.activeTasks()) {
      tasks.add(
          new ActiveTaskSummary(
              "MONITOR",
              task.getTaskId(),
              task.getState(),
              task.getClassName(),
              task.getMethod(),
              task.getStartedAtEpochMillis(),
              task.getDeadlineEpochMillis(),
              task.getCalls(),
              0L,
              task.getFailures()));
    }
    for (TraceController.TaskSnapshot task : traces.activeTasks()) {
      tasks.add(
          new ActiveTaskSummary(
              "TRACE",
              task.getTaskId(),
              task.getState(),
              task.getClassName(),
              task.getMethod(),
              task.getStartedAtEpochMillis(),
              task.getDeadlineEpochMillis(),
              task.getCaptured(),
              task.getMaximumTraces(),
              task.getDropped()));
    }
    for (ThreadPoolLatencyController.TaskSnapshot task :
        threadPoolLatency.activeTasks()) {
      tasks.add(
          new ActiveTaskSummary(
              "THREAD_POOL_LATENCY",
              task.getTaskId(),
              task.getState(),
              task.getPoolIdentity(),
              task.getPoolClassName(),
              task.getStartedAtEpochMillis(),
              task.getDeadlineEpochMillis(),
              task.getCompleted(),
              task.getMaximumTrackedTasks(),
              task.getDropped()));
    }
    for (SamplingProfilerController.TaskSnapshot task : profiler.activeTasks()) {
      tasks.add(
          new ActiveTaskSummary(
              "PROFILE",
              task.getTaskId(),
              task.getState(),
              task.getEvent() + " Profile",
              task.getEngine(),
              task.getStartedAtEpochMillis(),
              task.getDeadlineEpochMillis(),
              task.getSamples(),
              0L,
              task.getDropped()));
    }
    if (jfr.isRunning()) {
      tasks.add(
          new ActiveTaskSummary(
              "JFR",
              jfr.currentTaskId(),
              "RUNNING",
              jfr.currentRecordingName(),
              "JDK Flight Recorder",
              jfr.startedAtEpochMillis(),
              0L,
              0L,
              0L,
              0L));
    }
    tasks.sort(
        Comparator.comparingLong(ActiveTaskSummary::getStartedAtEpochMillis)
            .reversed()
            .thenComparing(ActiveTaskSummary::getTaskId));
    return tasks;
  }

  private ActionResponse cancelActiveTask(ActionRequest request) {
    if (!"true".equals(request.getParametersOrDefault("confirmed", "false"))) {
      return actionError(
          "CONFIRMATION_REQUIRED",
          "Task cancellation requires explicit confirmation");
    }
    String kind =
        request.getParametersOrDefault("kind", "").toUpperCase(Locale.ROOT);
    String taskId = request.getParametersOrDefault("taskId", "");
    if (taskId.isEmpty()) {
      return actionError("TASK_ID_REQUIRED", "Task identity is required");
    }
    switch (kind) {
      case "OBSERVATION":
        String observationState = observations.cancel(taskId);
        if ("UNKNOWN".equals(observationState)) {
          return taskNotFound(taskId);
        }
        Map<String, String> observationValues =
            new TreeMap<String, String>();
        observationValues.put("kind", "OBSERVATION");
        observationValues.put("taskId", taskId);
        observationValues.put("state", observationState);
        return actionValues(observationValues);
      case "LINE":
        String lineState = lineProbes.cancel(taskId);
        if ("UNKNOWN".equals(lineState)) {
          return taskNotFound(taskId);
        }
        Map<String, String> lineValues = new TreeMap<String, String>();
        lineValues.put("kind", "LINE");
        lineValues.put("taskId", taskId);
        lineValues.put("state", lineState);
        return actionValues(lineValues);
      case "MONITOR":
        String monitorState = monitors.cancel(taskId);
        if ("UNKNOWN".equals(monitorState)) {
          return taskNotFound(taskId);
        }
        Map<String, String> monitorValues =
            new TreeMap<String, String>();
        monitorValues.put("kind", "MONITOR");
        monitorValues.put("taskId", taskId);
        monitorValues.put("state", monitorState);
        return actionValues(monitorValues);
      case "TRACE":
        String traceState = traces.cancel(taskId);
        if ("UNKNOWN".equals(traceState)) {
          return taskNotFound(taskId);
        }
        Map<String, String> traceValues =
            new TreeMap<String, String>();
        traceValues.put("kind", "TRACE");
        traceValues.put("taskId", taskId);
        traceValues.put("state", traceState);
        return actionValues(traceValues);
      case "THREAD_POOL_LATENCY":
        String latencyState = threadPoolLatency.cancel(taskId);
        if ("UNKNOWN".equals(latencyState)) {
          return taskNotFound(taskId);
        }
        Map<String, String> latencyValues =
            new TreeMap<String, String>();
        latencyValues.put("kind", "THREAD_POOL_LATENCY");
        latencyValues.put("taskId", taskId);
        latencyValues.put("state", latencyState);
        return actionValues(latencyValues);
      case "PROFILE":
        SamplingProfilerController.Result result = profiler.stop(taskId);
        if ("UNKNOWN".equals(result.getState())) {
          return taskNotFound(taskId);
        }
        return profileResult(result);
      case "JFR":
        if (!jfr.isRunning() || !taskId.equals(jfr.currentTaskId())) {
          return taskNotFound(taskId);
        }
        return stopJfr("CANCELLED");
      default:
        return actionError(
            "TASK_KIND_INVALID",
            "Task kind must be OBSERVATION, LINE, MONITOR, TRACE, THREAD_POOL_LATENCY, PROFILE or JFR");
    }
  }

  private static ActionResponse taskNotFound(String taskId) {
    return actionError(
        "TASK_NOT_FOUND",
        "Active Tanwei task was not found: " + taskId);
  }

  private ActionResponse previewSessionReset() {
    try {
      SessionResetState state = captureSessionResetState();
      Map<String, String> values = sessionResetPreviewValues(state);
      values.put(
          "boundary",
          "Only Tanwei-owned active tasks, failed probe rollbacks and retained class replacement rollbacks are included");
      values.put(
          "excluded",
          "System properties, logger levels, VM options, MBean values and third-party instrumentation are never changed");
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("SESSION_RESET_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse resetSession(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, true);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      SessionResetState state = captureSessionResetState();
      String expectedFingerprint =
          request.getParametersOrDefault("expectedFingerprint", "");
      if (!state.fingerprint.equals(expectedFingerprint)) {
        return ActionResponse.newBuilder()
            .setStatus("FAILED")
            .setErrorCode("STALE_SESSION_STATE")
            .setMessage(
                "Tanwei-managed session state changed after preview; scan again before resetting")
            .putValues("actualFingerprint", state.fingerprint)
            .build();
      }

      Map<String, String> values = new TreeMap<String, String>();
      int itemIndex = 0;
      int artifactIndex = 0;
      int succeeded = 0;
      int failed = 0;
      for (ActiveTaskSummary task : state.tasks) {
        String itemPrefix =
            String.format(Locale.ROOT, "item.%04d.", itemIndex++);
        values.put(itemPrefix + "kind", task.kind);
        values.put(itemPrefix + "identity", task.taskId);
        values.put(itemPrefix + "title", trimValue(task.title));
        try {
          String terminalState;
          if ("OBSERVATION".equals(task.kind)) {
            terminalState = observations.cancel(task.taskId);
          } else if ("LINE".equals(task.kind)) {
            terminalState = lineProbes.cancel(task.taskId);
          } else if ("MONITOR".equals(task.kind)) {
            terminalState = monitors.cancel(task.taskId);
          } else if ("TRACE".equals(task.kind)) {
            terminalState = traces.cancel(task.taskId);
          } else if ("THREAD_POOL_LATENCY".equals(task.kind)) {
            terminalState = threadPoolLatency.cancel(task.taskId);
          } else if ("PROFILE".equals(task.kind)) {
            SamplingProfilerController.Result result =
                profiler.stop(task.taskId);
            terminalState = result.getState();
            SamplingProfilerController.ArtifactInfo artifact =
                result.getArtifact();
            if (artifact != null) {
              String artifactPrefix =
                  String.format(
                      Locale.ROOT, "artifact.%04d.", artifactIndex++);
              values.put(artifactPrefix + "token", artifact.getToken());
              values.put(
                  artifactPrefix + "size",
                  Long.toString(artifact.getSize()));
              values.put(artifactPrefix + "type", "PROFILE");
            }
          } else if ("JFR".equals(task.kind)) {
            if (!jfr.isRunning()
                || !task.taskId.equals(jfr.currentTaskId())) {
              terminalState = "UNKNOWN";
            } else {
              JfrController.ArtifactInfo artifact = jfr.stop();
              terminalState = "CANCELLED";
              String artifactPrefix =
                  String.format(
                      Locale.ROOT, "artifact.%04d.", artifactIndex++);
              values.put(artifactPrefix + "token", artifact.getToken());
              values.put(
                  artifactPrefix + "size",
                  Long.toString(artifact.getSize()));
              values.put(artifactPrefix + "type", "JFR");
            }
          } else {
            terminalState = "UNKNOWN";
          }
          if ("UNKNOWN".equals(terminalState)
              || "FAILED".equals(terminalState)) {
            failed++;
            values.put(itemPrefix + "state", "FAILED");
            values.put(
                itemPrefix + "error",
                "The exact active task was no longer available");
          } else {
            succeeded++;
            values.put(itemPrefix + "state", terminalState);
          }
        } catch (RuntimeException exception) {
          failed++;
          values.put(itemPrefix + "state", "FAILED");
          values.put(
              itemPrefix + "error",
              trimValue(
                  exception.getMessage() == null
                      ? exception.getClass().getSimpleName()
                      : exception.getMessage()));
        }
      }

      List<RetransformLifecycle.Snapshot> failedRetransforms =
          retransforms.failedRollbacks();
      for (RetransformLifecycle.Snapshot snapshot : failedRetransforms) {
        String itemPrefix =
            String.format(Locale.ROOT, "item.%04d.", itemIndex++);
        values.put(itemPrefix + "kind", "RETRANSFORM_ROLLBACK");
        values.put(itemPrefix + "identity", snapshot.getOwnerId());
        values.put(itemPrefix + "title", snapshot.getKind());
        try {
          if (retransforms.retry(snapshot.getOwnerId())) {
            succeeded++;
            values.put(itemPrefix + "state", "ROLLED_BACK");
          } else {
            failed++;
            values.put(itemPrefix + "state", "FAILED");
            values.put(
                itemPrefix + "error",
                "The failed retransformation owner was no longer available");
          }
        } catch (Exception exception) {
          failed++;
          values.put(itemPrefix + "state", "FAILED");
          values.put(
              itemPrefix + "error",
              trimValue(
                  exception.getMessage() == null
                      ? exception.getClass().getSimpleName()
                      : exception.getMessage()));
        }
      }

      ClassRedefinitionController.ResetResult classReset =
          classRedefinition.restoreAll();
      for (ClassRedefinitionController.ResetItem item :
          classReset.getItems()) {
        String itemPrefix =
            String.format(Locale.ROOT, "item.%04d.", itemIndex++);
        values.put(itemPrefix + "kind", "CLASS_REDEFINITION");
        values.put(itemPrefix + "identity", trimValue(item.getClassName()));
        values.put(itemPrefix + "title", trimValue(item.getClassLoader()));
        values.put(itemPrefix + "state", item.getState());
        values.put(
            itemPrefix + "rollbackCount",
            Integer.toString(item.getRollbackCount()));
        if ("RESTORED".equals(item.getState())) {
          succeeded++;
          values.put(
              itemPrefix + "previousSha256",
              item.getPreviousSha256());
          values.put(
              itemPrefix + "restoredSha256",
              item.getCurrentSha256());
        } else {
          failed++;
          if (!item.getPreviousSha256().isEmpty()) {
            values.put(
                itemPrefix + "actualSha256",
                item.getPreviousSha256());
          }
          values.put(itemPrefix + "error", trimValue(item.getError()));
        }
      }

      int remainingTasks = activeTaskSummaries().size();
      int remainingClasses = classRedefinition.resetSnapshots().size();
      int remainingRetransforms = retransforms.snapshots().size();
      values.put(
          "outcome",
          failed == 0
                  && remainingTasks == 0
                  && remainingClasses == 0
                  && remainingRetransforms == 0
              ? "RESET"
              : "PARTIAL");
      values.put("item.total", Integer.toString(itemIndex));
      values.put("artifact.total", Integer.toString(artifactIndex));
      values.put("succeeded", Integer.toString(succeeded));
      values.put("failed", Integer.toString(failed));
      values.put("remainingTaskCount", Integer.toString(remainingTasks));
      values.put(
          "remainingClassCount", Integer.toString(remainingClasses));
      values.put(
          "remainingRetransformCount",
          Integer.toString(remainingRetransforms));
      values.put(
          "boundary",
          "System properties, logger levels, VM options, MBean values and third-party instrumentation were not changed");
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("SESSION_RESET_FAILED", exception);
    }
  }

  private SessionResetState captureSessionResetState() throws Exception {
    List<ActiveTaskSummary> tasks = activeTaskSummaries();
    List<ClassRedefinitionController.ResetSnapshot> classes =
        classRedefinition.resetSnapshots();
    List<RetransformLifecycle.Snapshot> failedRetransforms =
        retransforms.failedRollbacks();
    List<ActiveTaskSummary> fingerprintTasks =
        new ArrayList<ActiveTaskSummary>(tasks);
    fingerprintTasks.sort(
        Comparator.comparing((ActiveTaskSummary task) -> task.kind)
            .thenComparing(task -> task.taskId));
    List<ClassRedefinitionController.ResetSnapshot> fingerprintClasses =
        new ArrayList<ClassRedefinitionController.ResetSnapshot>(classes);
    fingerprintClasses.sort(
        Comparator.comparing(
                ClassRedefinitionController.ResetSnapshot::getClassName)
            .thenComparing(
                ClassRedefinitionController.ResetSnapshot::getClassLoader));
    List<RetransformLifecycle.Snapshot> fingerprintRetransforms =
        new ArrayList<RetransformLifecycle.Snapshot>(failedRetransforms);
    fingerprintRetransforms.sort(
        Comparator.comparing(RetransformLifecycle.Snapshot::getOwnerId));
    StringBuilder identity = new StringBuilder("tanwei-session-reset-v2\n");
    for (ActiveTaskSummary task : fingerprintTasks) {
      identity
          .append("task|")
          .append(task.kind)
          .append('|')
          .append(task.taskId)
          .append('\n');
    }
    for (ClassRedefinitionController.ResetSnapshot item :
        fingerprintClasses) {
      identity
          .append("class|")
          .append(item.getClassName())
          .append('|')
          .append(item.getClassLoader())
          .append('|')
          .append(item.getBaselineSha256())
          .append('|')
          .append(item.getExpectedCurrentSha256())
          .append('|')
          .append(item.getRollbackCount())
          .append('\n');
    }
    for (RetransformLifecycle.Snapshot snapshot : fingerprintRetransforms) {
      identity
          .append("retransform|")
          .append(snapshot.getOwnerId())
          .append('|')
          .append(snapshot.getKind())
          .append('|')
          .append(snapshot.getState())
          .append('|')
          .append(snapshot.getClassNames())
          .append('\n');
    }
    return new SessionResetState(
        tasks,
        classes,
        failedRetransforms,
        sha256Text(identity.toString()));
  }

  private static Map<String, String> sessionResetPreviewValues(
      SessionResetState state) throws Exception {
    Map<String, String> values = new TreeMap<String, String>();
    values.put("fingerprint", state.fingerprint);
    values.put("task.total", Integer.toString(state.tasks.size()));
    values.put("class.total", Integer.toString(state.classes.size()));
    values.put(
        "retransform.total",
        Integer.toString(state.failedRetransforms.size()));
    int rollbackCount = 0;
    int artifactTaskCount = 0;
    for (ActiveTaskSummary task : state.tasks) {
      if ("PROFILE".equals(task.kind) || "JFR".equals(task.kind)) {
        artifactTaskCount++;
      }
    }
    for (ClassRedefinitionController.ResetSnapshot item : state.classes) {
      rollbackCount += item.getRollbackCount();
    }
    values.put("rollback.total", Integer.toString(rollbackCount));
    values.put(
        "artifactPotential.total",
        Integer.toString(artifactTaskCount));
    for (int index = 0; index < state.tasks.size(); index++) {
      ActiveTaskSummary task = state.tasks.get(index);
      String prefix =
          String.format(Locale.ROOT, "task.%04d.", index);
      values.put(prefix + "kind", task.kind);
      values.put(prefix + "taskId", task.taskId);
      values.put(prefix + "title", trimValue(task.title));
      values.put(prefix + "detail", trimValue(task.detail));
    }
    for (int index = 0; index < state.classes.size(); index++) {
      ClassRedefinitionController.ResetSnapshot item =
          state.classes.get(index);
      String prefix =
          String.format(Locale.ROOT, "class.%04d.", index);
      values.put(prefix + "name", item.getClassName());
      values.put(prefix + "classLoader", trimValue(item.getClassLoader()));
      values.put(
          prefix + "rollbackCount",
          Integer.toString(item.getRollbackCount()));
      values.put(
          prefix + "baselineSha256",
          item.getBaselineSha256());
      values.put(
          prefix + "expectedCurrentSha256",
          item.getExpectedCurrentSha256());
    }
    for (int index = 0; index < state.failedRetransforms.size(); index++) {
      RetransformLifecycle.Snapshot snapshot =
          state.failedRetransforms.get(index);
      String prefix =
          String.format(Locale.ROOT, "retransform.%04d.", index);
      values.put(prefix + "ownerId", snapshot.getOwnerId());
      values.put(prefix + "kind", snapshot.getKind());
      values.put(prefix + "error", trimValue(snapshot.getError()));
      values.put(
          prefix + "class.count",
          Integer.toString(snapshot.getClassNames().size()));
      for (int classIndex = 0;
          classIndex < snapshot.getClassNames().size();
          classIndex++) {
        values.put(
            prefix
                + String.format(
                    Locale.ROOT, "class.%04d.name", classIndex),
            snapshot.getClassNames().get(classIndex));
      }
    }
    return values;
  }

  private static String sha256Text(String value) throws Exception {
    byte[] digest =
        MessageDigest.getInstance("SHA-256")
            .digest(value.getBytes(StandardCharsets.UTF_8));
    StringBuilder result = new StringBuilder(digest.length * 2);
    for (byte item : digest) {
      result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
    }
    return result.toString();
  }

  private ActionResponse listMBeans(ActionRequest request) {
    try {
      int offset =
          boundedInt(
              request.getParametersOrDefault("offset", "0"),
              0,
              100_000,
              "offset");
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "50"),
              1,
              100,
              "limit");
      return actionValues(
          mbeans.list(
              request.getParametersOrDefault("query", ""),
              offset,
              limit));
    } catch (Exception exception) {
      return actionFailure("MBEAN_LIST_FAILED", exception);
    }
  }

  private ActionResponse listPerfCounters(ActionRequest request) {
    if (!perfCounters.isAvailable()) {
      return actionError(
          "PERFCOUNTERS_UNAVAILABLE",
          perfCounters.unavailableReason());
    }
    try {
      String query = request.getParametersOrDefault("query", "");
      if (query.length() > 256 || query.indexOf('\r') >= 0 || query.indexOf('\n') >= 0) {
        throw new IllegalArgumentException(
            "query must not exceed 256 characters or contain line breaks");
      }
      int offset =
          boundedInt(
              request.getParametersOrDefault("offset", "0"),
              0,
              PerfCounterExplorer.MAXIMUM_SCANNED_COUNTERS,
              "offset");
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "50"),
              1,
              PerfCounterExplorer.MAXIMUM_PAGE_SIZE,
              "limit");
      PerfCounterExplorer.Page page =
          perfCounters.list(
              query,
              request.getParametersOrDefault("namespace", "ALL"),
              offset,
              limit);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("total", Integer.toString(page.getTotal()));
      values.put("offset", Integer.toString(page.getOffset()));
      values.put("limit", Integer.toString(page.getLimit()));
      values.put("count", Integer.toString(page.getCounters().size()));
      values.put(
          "hasMore",
          Boolean.toString(
              page.getOffset() + page.getCounters().size() < page.getTotal()));
      values.put("truncated", Boolean.toString(page.isTruncated()));
      values.put(
          "sampledAtEpochMillis",
          Long.toString(page.getSampledAtEpochMillis()));
      values.put("category.JAVA", Integer.toString(page.getJavaCount()));
      values.put("category.SUN", Integer.toString(page.getSunCount()));
      values.put("category.JDK", Integer.toString(page.getJdkCount()));
      values.put("category.OTHER", Integer.toString(page.getOtherCount()));
      for (int index = 0; index < page.getCounters().size(); index++) {
        PerfCounterExplorer.CounterSnapshot counter =
            page.getCounters().get(index);
        String prefix =
            String.format(Locale.ROOT, "counter.%04d.", index);
        values.put(prefix + "name", counter.getName());
        values.put(prefix + "category", counter.getCategory());
        values.put(prefix + "units", counter.getUnits());
        values.put(prefix + "variability", counter.getVariability());
        values.put(prefix + "value", counter.getValue());
        values.put(prefix + "valueType", counter.getValueType());
        values.put(prefix + "internal", Boolean.toString(counter.isInternal()));
        values.put(prefix + "vectorLength", Integer.toString(counter.getVectorLength()));
      }
      return actionValues(values);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_PERFCOUNTER_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("PERFCOUNTER_LIST_FAILED", exception);
    }
  }

  private ActionResponse snapshotPerfCounters(ActionRequest request) {
    if (!perfCounters.isAvailable()) {
      return actionError(
          "PERFCOUNTERS_UNAVAILABLE",
          perfCounters.unavailableReason());
    }
    try {
      PerfCounterExplorer.CounterBatch batch =
          perfCounters.snapshot(
              request.getParametersOrDefault("names", ""));
      Map<String, String> values = new TreeMap<String, String>();
      values.put(
          "sampledAtEpochMillis",
          Long.toString(batch.getSampledAtEpochMillis()));
      values.put(
          "scannedCounters",
          Integer.toString(batch.getScannedCounters()));
      values.put("truncated", Boolean.toString(batch.isTruncated()));
      values.put(
          "requestedCount",
          Integer.toString(
              batch.getCounters().size() + batch.getMissingNames().size()));
      values.put("count", Integer.toString(batch.getCounters().size()));
      values.put(
          "missingCount",
          Integer.toString(batch.getMissingNames().size()));
      for (int index = 0; index < batch.getCounters().size(); index++) {
        PerfCounterExplorer.CounterSnapshot counter =
            batch.getCounters().get(index);
        String prefix =
            String.format(Locale.ROOT, "counter.%04d.", index);
        values.put(prefix + "name", counter.getName());
        values.put(prefix + "category", counter.getCategory());
        values.put(prefix + "units", counter.getUnits());
        values.put(prefix + "variability", counter.getVariability());
        values.put(prefix + "value", counter.getValue());
        values.put(prefix + "valueType", counter.getValueType());
        values.put(
            prefix + "internal",
            Boolean.toString(counter.isInternal()));
        values.put(
            prefix + "vectorLength",
            Integer.toString(counter.getVectorLength()));
      }
      for (int index = 0; index < batch.getMissingNames().size(); index++) {
        values.put(
            String.format(Locale.ROOT, "missing.%04d", index),
            batch.getMissingNames().get(index));
      }
      return actionValues(values);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_PERFCOUNTER_SNAPSHOT", exception);
    } catch (Exception exception) {
      return actionFailure("PERFCOUNTER_SNAPSHOT_FAILED", exception);
    }
  }

  private ActionResponse listLoggers(ActionRequest request) {
    try {
      int offset =
          boundedInt(
              request.getParametersOrDefault("offset", "0"),
              0,
              100_000,
              "offset");
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "50"),
              1,
              100,
              "limit");
      return actionValues(
          loggers.list(
              request.getParametersOrDefault("query", ""),
              request.getParametersOrDefault("framework", "ALL"),
              offset,
              limit));
    } catch (Exception exception) {
      return actionFailure("LOGGER_LIST_FAILED", exception);
    }
  }

  private ActionResponse describeLogger(ActionRequest request) {
    try {
      return actionValues(
          loggers.describe(
              request.getParametersOrDefault("framework", ""),
              request.getParametersOrDefault("contextId", ""),
              request.getParametersOrDefault("name", "")));
    } catch (IllegalArgumentException exception) {
      return actionFailure("LOGGER_NOT_FOUND", exception);
    } catch (Exception exception) {
      return actionFailure("LOGGER_DESCRIBE_FAILED", exception);
    }
  }

  private ActionResponse previewLoggerLevel(
      ActionRequest request) {
    try {
      return actionValues(
          loggers.previewLevelChange(
              request.getParametersOrDefault("framework", ""),
              request.getParametersOrDefault("contextId", ""),
              request.getParametersOrDefault("name", ""),
              request.getParametersOrDefault("newLevel", "")));
    } catch (IllegalArgumentException exception) {
      return actionFailure(
          "INVALID_LOGGER_LEVEL_PREVIEW", exception);
    } catch (Exception exception) {
      return actionFailure(
          "LOGGER_LEVEL_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse setLoggerLevel(
      ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      return actionValues(
          loggers.setLevel(
              request.getParametersOrDefault("framework", ""),
              request.getParametersOrDefault("contextId", ""),
              request.getParametersOrDefault("name", ""),
              request.getParametersOrDefault("newLevel", ""),
              request.getParametersOrDefault(
                  "expectedFingerprint", "")));
    } catch (
        LoggerExplorer.StaleLoggerLevelException exception) {
      return actionFailure(
          "LOGGER_LEVEL_STALE", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure(
          "INVALID_LOGGER_LEVEL_CHANGE", exception);
    } catch (Exception exception) {
      return actionFailure(
          "LOGGER_LEVEL_CHANGE_FAILED", exception);
    }
  }

  private ActionResponse describeMBean(ActionRequest request) {
    try {
      return actionValues(
          mbeans.describe(
              request.getParametersOrDefault("objectName", "")));
    } catch (javax.management.InstanceNotFoundException exception) {
      return actionFailure("MBEAN_NOT_FOUND", exception);
    } catch (Exception exception) {
      return actionFailure("MBEAN_DESCRIBE_FAILED", exception);
    }
  }

  private ActionResponse readMBeanAttribute(ActionRequest request) {
    try {
      return actionValues(
          mbeans.readAttribute(
              request.getParametersOrDefault("objectName", ""),
              request.getParametersOrDefault("attribute", "")));
    } catch (javax.management.InstanceNotFoundException exception) {
      return actionFailure("MBEAN_NOT_FOUND", exception);
    } catch (Exception exception) {
      return actionFailure("MBEAN_ATTRIBUTE_READ_FAILED", exception);
    }
  }

  private ActionResponse previewMBeanAttributeWrite(ActionRequest request) {
    try {
      MBeanExplorer.AttributeWritePreview preview =
          mbeans.previewAttributeWrite(
              request.getParametersOrDefault("objectName", ""),
              request.getParametersOrDefault("attribute", ""),
              request.getParametersOrDefault("proposedValue", ""),
              request.getParametersOrDefault("valueFormat", ""));
      Map<String, String> values = new TreeMap<String, String>();
      values.put("fingerprint", preview.getFingerprint());
      values.put("objectName", preview.getObjectName());
      values.put("attribute", preview.getAttribute());
      values.put("type", preview.getType());
      values.put("oldValue", preview.getOldValue());
      values.put("proposedValue", preview.getProposedValue());
      values.put(
          "restoreSupported",
          Boolean.toString(preview.isRestoreSupported()));
      values.put("valueFormat", preview.getValueFormat());
      values.put("valueSchema", preview.getValueSchema());
      values.put("risk", "R4");
      values.put(
          "boundary",
          "The MBean setter may have irreversible side effects; the current value is checked again immediately before writing");
      return actionValues(values);
    } catch (javax.management.InstanceNotFoundException exception) {
      return actionFailure("MBEAN_NOT_FOUND", exception);
    } catch (Exception exception) {
      return actionFailure("MBEAN_ATTRIBUTE_WRITE_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse writeMBeanAttribute(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, true);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      MBeanExplorer.AttributeWriteResult result =
          mbeans.writeAttribute(
              request.getParametersOrDefault("objectName", ""),
              request.getParametersOrDefault("attribute", ""),
              request.getParametersOrDefault("proposedValue", ""),
              request.getParametersOrDefault("valueFormat", ""),
              request.getParametersOrDefault("expectedFingerprint", ""));
      Map<String, String> values = new TreeMap<String, String>();
      values.put("objectName", result.getObjectName());
      values.put("attribute", result.getAttribute());
      values.put("type", result.getType());
      values.put("oldValue", result.getOldValue());
      values.put("newValue", result.getNewValue());
      values.put(
          "restoreSupported",
          Boolean.toString(result.isRestoreSupported()));
      values.put("valueFormat", result.getValueFormat());
      values.put("valueSchema", result.getValueSchema());
      values.put(
          "durationMillis", Long.toString(result.getDurationMillis()));
      values.put(
          "fingerprint",
          request.getParametersOrDefault("expectedFingerprint", ""));
      return actionValues(values);
    } catch (MBeanExplorer.StaleAttributeWriteException exception) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("STALE_MBEAN_ATTRIBUTE_PREVIEW")
          .setMessage(exception.getMessage())
          .putValues("actualFingerprint", exception.getActualFingerprint())
          .build();
    } catch (MBeanExplorer.AttributeWriteTimeoutException exception) {
      return actionFailure(
          "MBEAN_ATTRIBUTE_WRITE_TIMEOUT_MAY_CONTINUE", exception);
    } catch (javax.management.InstanceNotFoundException exception) {
      return actionFailure("MBEAN_NOT_FOUND", exception);
    } catch (Exception exception) {
      return actionFailure("MBEAN_ATTRIBUTE_WRITE_FAILED", exception);
    }
  }

  private ActionResponse previewMBeanOperation(ActionRequest request) {
    try {
      MBeanExplorer.Preview preview =
          mbeans.previewOperation(
              request.getParametersOrDefault("objectName", ""),
              request.getParametersOrDefault("operation", ""),
              request.getParametersOrDefault("parameterTypes", ""),
              mbeanArguments(request),
              mbeanArgumentFormats(request));
      Map<String, String> values = new TreeMap<String, String>();
      values.put("fingerprint", preview.getFingerprint());
      values.put("objectName", preview.getObjectName());
      values.put("operation", preview.getOperation());
      values.put("parameterTypes", preview.getParameterTypes());
      values.put("returnType", preview.getReturnType());
      values.put("impact", preview.getImpact());
      values.put("invocation", preview.getInvocation());
      values.put(
          "argument.count", Integer.toString(preview.getArgumentCount()));
      for (int index = 0; index < preview.getArgumentCount(); index++) {
        String prefix =
            "argument." + String.format(Locale.ROOT, "%02d", index) + ".";
        values.put(prefix + "format", preview.getArgumentFormat(index));
        values.put(prefix + "schema", preview.getArgumentSchema(index));
        values.put(prefix + "value", preview.getArgumentValue(index));
      }
      values.put("risk", "R4");
      values.put(
          "boundary",
          "MBean code may cause irreversible side effects; a 3 second timeout cannot guarantee termination");
      return actionValues(values);
    } catch (javax.management.InstanceNotFoundException exception) {
      return actionFailure("MBEAN_NOT_FOUND", exception);
    } catch (Exception exception) {
      return actionFailure("MBEAN_OPERATION_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse invokeMBeanOperation(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, true);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      MBeanExplorer.InvocationResult result =
          mbeans.invokeOperation(
              request.getParametersOrDefault("objectName", ""),
              request.getParametersOrDefault("operation", ""),
              request.getParametersOrDefault("parameterTypes", ""),
              mbeanArguments(request),
              mbeanArgumentFormats(request),
              request.getParametersOrDefault("expectedFingerprint", ""));
      Map<String, String> values = new TreeMap<String, String>();
      values.put("objectName", request.getParametersOrDefault("objectName", ""));
      values.put("operation", request.getParametersOrDefault("operation", ""));
      values.put("outcome", result.getOutcome());
      values.put("valueClass", result.getValueClass());
      values.put("returnValue", result.getReturnValue());
      values.put("exceptionType", result.getExceptionType());
      values.put("exceptionMessage", result.getExceptionMessage());
      values.put("durationMillis", Long.toString(result.getDurationMillis()));
      values.put(
          "fingerprint",
          request.getParametersOrDefault("expectedFingerprint", ""));
      return actionValues(values);
    } catch (MBeanExplorer.StaleOperationException exception) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("STALE_MBEAN_OPERATION_PREVIEW")
          .setMessage(exception.getMessage())
          .putValues("actualFingerprint", exception.getActualFingerprint())
          .build();
    } catch (MBeanExplorer.OperationTimeoutException exception) {
      return actionFailure("MBEAN_OPERATION_TIMEOUT_MAY_CONTINUE", exception);
    } catch (javax.management.InstanceNotFoundException exception) {
      return actionFailure("MBEAN_NOT_FOUND", exception);
    } catch (Exception exception) {
      return actionFailure("MBEAN_OPERATION_INVOKE_FAILED", exception);
    }
  }

  private static List<String> mbeanArguments(ActionRequest request) {
    int count =
        boundedInt(
            request.getParametersOrDefault("argumentCount", "0"),
            0,
            8,
            "argumentCount");
    List<String> arguments = new ArrayList<String>(count);
    for (int index = 0; index < count; index++) {
      String key = "argument" + index;
      if (!request.getParametersMap().containsKey(key)) {
        throw new IllegalArgumentException(
            "Missing MBean operation argument " + index);
      }
      arguments.add(request.getParametersOrDefault(key, ""));
    }
    return arguments;
  }

  private static List<String> mbeanArgumentFormats(ActionRequest request) {
    int count =
        boundedInt(
            request.getParametersOrDefault("argumentCount", "0"),
            0,
            8,
            "argumentCount");
    boolean formatProvided = false;
    for (int index = 0; index < count; index++) {
      if (request.getParametersMap().containsKey("argumentFormat" + index)) {
        formatProvided = true;
        break;
      }
    }
    if (!formatProvided) {
      return Collections.emptyList();
    }
    List<String> formats = new ArrayList<String>(count);
    for (int index = 0; index < count; index++) {
      String key = "argumentFormat" + index;
      if (!request.getParametersMap().containsKey(key)) {
        throw new IllegalArgumentException(
            "Missing MBean operation argument format " + index);
      }
      formats.add(request.getParametersOrDefault(key, ""));
    }
    return formats;
  }

  private ActionResponse previewThreadInterrupt(ActionRequest request) {
    try {
      long threadId =
          positiveLong(
              request.getParametersOrDefault("threadId", ""),
              "threadId");
      Thread thread = liveThreadsById().get(threadId);
      if (thread == null || !thread.isAlive()) {
        return actionError(
            "THREAD_NOT_FOUND",
            "The selected thread is no longer alive");
      }
      String protectedReason = protectedThreadReason(thread);
      if (!protectedReason.isEmpty()) {
        return actionError("THREAD_INTERRUPT_DENIED", protectedReason);
      }
      Map<String, String> values = new TreeMap<String, String>();
      values.put("threadId", Long.toString(thread.getId()));
      values.put("name", trimValue(thread.getName()));
      values.put("state", thread.getState().name());
      values.put("daemon", Boolean.toString(thread.isDaemon()));
      StackTraceElement[] stack = thread.getStackTrace();
      values.put("stackTop", stack.length == 0 ? "" : trimValue(stack[0].toString()));
      values.put(
          "boundary",
          "Interrupt only sets the Java interruption signal; target code may ignore or clear it");
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("THREAD_INTERRUPT_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse inspectThreadLocks(ActionRequest request) {
    try {
      int maximumNodes =
          boundedInt(
              request.getParametersOrDefault("maximumNodes", "200"),
              1,
              500,
              "maximumNodes");
      boolean includeUncontended =
          "true".equals(
              request.getParametersOrDefault("includeUncontended", "false"));
      return actionValues(
          threadLocks.inspect(includeUncontended, maximumNodes));
    } catch (Exception exception) {
      return actionFailure("THREAD_LOCK_INSPECTION_FAILED", exception);
    }
  }

  private ActionResponse inspectThreadPools(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "12"),
              3,
              20,
              "limit");
      int memberLimit =
          boundedInt(
              request.getParametersOrDefault("memberLimit", "100"),
              10,
              200,
              "memberLimit");
      String includeEvidenceParameter =
          request.getParametersOrDefault("includeEvidence", "false");
      if (!"true".equals(includeEvidenceParameter)
          && !"false".equals(includeEvidenceParameter)) {
        throw new IllegalArgumentException(
            "includeEvidence must be true or false");
      }
      boolean includeEvidence =
          "true".equals(includeEvidenceParameter);
      int queueTaskLimit =
          boundedInt(
              request.getParametersOrDefault("queueTaskLimit", "100"),
              10,
              200,
              "queueTaskLimit");
      HeapInstanceController.ThreadPoolResult result =
          heapInstances.threadPools(
              limit,
              memberLimit,
              includeEvidence,
              queueTaskLimit);
      Map<String, String> values = new TreeMap<String, String>();
      values.put(
          "queriedTypes",
          Integer.toString(result.getQueriedTypes()));
      values.put(
          "requestedLimit",
          Integer.toString(result.getRequestedLimit()));
      values.put(
          "requestedMemberLimit",
          Integer.toString(result.getRequestedMemberLimit()));
      values.put("includeEvidence", Boolean.toString(includeEvidence));
      values.put(
          "requestedQueueTaskLimit", Integer.toString(queueTaskLimit));
      values.put(
          "truncated",
          Boolean.toString(result.isTruncated()));
      values.put(
          "scannedThreads",
          Integer.toString(result.getScannedThreads()));
      values.put(
          "threadEnumerationTruncated",
          Boolean.toString(result.isThreadEnumerationTruncated()));
      values.put(
          "discoveredMembers",
          Integer.toString(result.getDiscoveredMembers()));
      values.put(
          "returnedMembers",
          Integer.toString(result.getReturnedMembers()));
      values.put("count", Integer.toString(result.getPools().size()));
      values.put(
          "boundary",
          "Bounded exact-class JVMTI scan for JDK executors; members use exact Worker.thread or ForkJoinWorkerThread.getPool identity, never name heuristics; optional evidence reads only bounded member stacks and known JDK queue iterators without invoking task methods; custom subclasses and pre-tagged objects are omitted");
      for (int index = 0; index < result.getPools().size(); index++) {
        HeapInstanceController.ThreadPoolRow pool =
            result.getPools().get(index);
        String prefix =
            String.format(Locale.ROOT, "pool.%04d.", index);
        values.put(prefix + "kind", pool.getKind());
        values.put(prefix + "className", trimValue(pool.getClassName()));
        values.put(prefix + "identity", trimValue(pool.getIdentity()));
        values.put(prefix + "state", pool.getState());
        values.put(
            prefix + "configuredSize",
            Long.toString(pool.getConfiguredSize()));
        values.put(prefix + "poolSize", Long.toString(pool.getPoolSize()));
        values.put(
            prefix + "activeCount",
            Long.toString(pool.getActiveCount()));
        values.put(
            prefix + "maximumSize",
            Long.toString(pool.getMaximumSize()));
        values.put(
            prefix + "largestSize",
            Long.toString(pool.getLargestSize()));
        values.put(
            prefix + "completedTasks",
            Long.toString(pool.getCompletedTasks()));
        values.put(
            prefix + "queuedTasks",
            Long.toString(pool.getQueuedTasks()));
        values.put(
            prefix + "remainingQueueCapacity",
            Long.toString(pool.getRemainingQueueCapacity()));
        values.put(prefix + "queueType", trimValue(pool.getQueueType()));
        values.put(
            prefix + "queuedSubmissions",
            Long.toString(pool.getQueuedSubmissions()));
        values.put(
            prefix + "runningCount",
            Long.toString(pool.getRunningCount()));
        values.put(
            prefix + "stealCount",
            Long.toString(pool.getStealCount()));
        values.put(
            prefix + "threadFactoryType",
            trimValue(pool.getThreadFactoryType()));
        values.put(
            prefix + "rejectionHandlerType",
            trimValue(pool.getRejectionHandlerType()));
        values.put(
            prefix + "queueInspectionAvailable",
            Boolean.toString(pool.isQueueInspectionAvailable()));
        values.put(
            prefix + "queueInspectionIssue",
            pool.getQueueInspectionIssue());
        values.put(
            prefix + "queueTasksScanned",
            Integer.toString(pool.getQueueTasksScanned()));
        values.put(
            prefix + "queueTasksTruncated",
            Boolean.toString(pool.isQueueTasksTruncated()));
        values.put(
            prefix + "queueTaskTypeCount",
            Integer.toString(pool.getQueueTaskTypes().size()));
        for (int taskTypeIndex = 0;
            taskTypeIndex < pool.getQueueTaskTypes().size();
            taskTypeIndex++) {
          HeapInstanceController.ThreadPoolTaskType taskType =
              pool.getQueueTaskTypes().get(taskTypeIndex);
          String taskTypePrefix =
              prefix
                  + String.format(
                      Locale.ROOT, "queueTaskType.%03d.", taskTypeIndex);
          values.put(
              taskTypePrefix + "className",
              trimValue(taskType.getClassName()));
          values.put(
              taskTypePrefix + "count",
              Integer.toString(taskType.getCount()));
        }
        values.put(
            prefix + "membershipAvailable",
            Boolean.toString(pool.isMembershipAvailable()));
        values.put(
            prefix + "membershipIssue",
            pool.getMembershipIssue());
        values.put(
            prefix + "memberCount",
            Integer.toString(pool.getMemberCount()));
        values.put(
            prefix + "returnedMemberCount",
            Integer.toString(pool.getMembers().size()));
        values.put(
            prefix + "membersTruncated",
            Boolean.toString(pool.isMembersTruncated()));
        for (int memberIndex = 0;
            memberIndex < pool.getMembers().size();
            memberIndex++) {
          HeapInstanceController.ThreadPoolMember member =
              pool.getMembers().get(memberIndex);
          String memberPrefix =
              prefix
                  + String.format(
                      Locale.ROOT, "member.%03d.", memberIndex);
          values.put(
              memberPrefix + "threadId",
              Long.toString(member.getThreadId()));
          values.put(memberPrefix + "name", trimValue(member.getName()));
          values.put(
              memberPrefix + "groupName",
              trimValue(member.getGroupName()));
          values.put(memberPrefix + "state", member.getState());
          values.put(
              memberPrefix + "daemon",
              Boolean.toString(member.isDaemon()));
          values.put(
              memberPrefix + "priority",
              Integer.toString(member.getPriority()));
          values.put(
              memberPrefix + "topFrame",
              trimValue(member.getTopFrame()));
          values.put(
              memberPrefix + "applicationFrame",
              trimValue(member.getApplicationFrame()));
          values.put(
              memberPrefix + "blockerType",
              trimValue(member.getBlockerType()));
        }
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("THREAD_POOLS_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_THREAD_POOL_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("THREAD_POOL_INSPECTION_FAILED", exception);
    }
  }

  private ActionResponse startThreadPoolLatency(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      long durationMillis =
          boundedLong(
              request.getParametersOrDefault("durationMillis", "30000"),
              10_000L,
              300_000L,
              "durationMillis");
      int maximumTrackedTasks =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumTrackedTasks", "1024"),
              128,
              4_096,
              "maximumTrackedTasks");
      ThreadPoolLatencyController.StartResult started =
          threadPoolLatency.start(
              request.getParametersOrDefault("poolIdentity", ""),
              request.getParametersOrDefault("poolClassName", ""),
              durationMillis,
              maximumTrackedTasks);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("kind", "THREAD_POOL_LATENCY");
      values.put("taskId", started.getTaskId());
      values.put("state", "RUNNING");
      values.put("poolIdentity", started.getPoolIdentity());
      values.put("poolClassName", started.getPoolClassName());
      values.put("attributionMode", started.getAttributionMode());
      values.put(
          "startedAtEpochMillis",
          Long.toString(started.getStartedAtEpochMillis()));
      values.put(
          "deadlineEpochMillis",
          Long.toString(started.getDeadlineEpochMillis()));
      values.put(
          "maximumTrackedTasks",
          Integer.toString(started.getMaximumTrackedTasks()));
      values.put(
          "boundary",
          threadPoolLatencyBoundary(
              started.getPoolClassName(), started.getAttributionMode()));
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("THREAD_POOL_LATENCY_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_THREAD_POOL_LATENCY_REQUEST", exception);
    } catch (Exception exception) {
      return actionFailure("THREAD_POOL_LATENCY_START_FAILED", exception);
    }
  }

  private ActionResponse snapshotThreadPoolLatency(ActionRequest request) {
    try {
      ThreadPoolLatencyController.Snapshot snapshot =
          threadPoolLatency.snapshot(
              request.getParametersOrDefault("taskId", ""));
      if ("UNKNOWN".equals(snapshot.getState())) {
        return taskNotFound(
            request.getParametersOrDefault("taskId", ""));
      }
      return actionValues(threadPoolLatencyValues(snapshot));
    } catch (Exception exception) {
      return actionFailure("THREAD_POOL_LATENCY_SNAPSHOT_FAILED", exception);
    }
  }

  private ActionResponse stopThreadPoolLatency(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      ThreadPoolLatencyController.Snapshot snapshot =
          threadPoolLatency.stop(
              request.getParametersOrDefault("taskId", ""));
      if ("UNKNOWN".equals(snapshot.getState())) {
        return taskNotFound(
            request.getParametersOrDefault("taskId", ""));
      }
      return actionValues(threadPoolLatencyValues(snapshot));
    } catch (Exception exception) {
      return actionFailure("THREAD_POOL_LATENCY_STOP_FAILED", exception);
    }
  }

  private static Map<String, String> threadPoolLatencyValues(
      ThreadPoolLatencyController.Snapshot snapshot) {
    Map<String, String> values = new TreeMap<String, String>();
    values.put("kind", "THREAD_POOL_LATENCY");
    values.put("taskId", snapshot.getTaskId());
    values.put("state", snapshot.getState());
    values.put("error", trimValue(snapshot.getError()));
    values.put("poolIdentity", snapshot.getPoolIdentity());
    values.put("poolClassName", snapshot.getPoolClassName());
    values.put("attributionMode", snapshot.getAttributionMode());
    values.put(
        "startedAtEpochMillis",
        Long.toString(snapshot.getStartedAtEpochMillis()));
    values.put(
        "deadlineEpochMillis",
        Long.toString(snapshot.getDeadlineEpochMillis()));
    values.put(
        "maximumTrackedTasks",
        Integer.toString(snapshot.getMaximumTrackedTasks()));
    values.put("submitted", Long.toString(snapshot.getSubmitted()));
    values.put("started", Long.toString(snapshot.getStarted()));
    values.put("completed", Long.toString(snapshot.getCompleted()));
    values.put("failures", Long.toString(snapshot.getFailures()));
    values.put("rejected", Long.toString(snapshot.getRejected()));
    values.put(
        "unmatchedStarts", Long.toString(snapshot.getUnmatchedStarts()));
    values.put(
        "droppedSubmissions",
        Long.toString(snapshot.getDroppedSubmissions()));
    values.put(
        "orphanedSubmissions",
        Long.toString(snapshot.getOrphanedSubmissions()));
    values.put(
        "pendingTracked", Integer.toString(snapshot.getPendingTracked()));
    values.put("inFlight", Integer.toString(snapshot.getInFlight()));
    values.put(
        "waitObserved", Long.toString(snapshot.getWaitObserved()));
    values.put(
        "waitDurationNanos",
        Long.toString(snapshot.getWaitDurationNanos()));
    values.put(
        "waitMaximumNanos",
        Long.toString(snapshot.getWaitMaximumNanos()));
    values.put(
        "waitP95Nanos", Long.toString(snapshot.getWaitP95Nanos()));
    values.put(
        "waitP99Nanos", Long.toString(snapshot.getWaitP99Nanos()));
    values.put(
        "scheduleDelayObserved",
        Long.toString(snapshot.getScheduleDelayObserved()));
    values.put(
        "scheduleDelayDurationNanos",
        Long.toString(snapshot.getScheduleDelayDurationNanos()));
    values.put(
        "scheduleDelayMaximumNanos",
        Long.toString(snapshot.getScheduleDelayMaximumNanos()));
    values.put(
        "scheduleDelayP95Nanos",
        Long.toString(snapshot.getScheduleDelayP95Nanos()));
    values.put(
        "scheduleDelayP99Nanos",
        Long.toString(snapshot.getScheduleDelayP99Nanos()));
    values.put(
        "startLatenessObserved",
        Long.toString(snapshot.getStartLatenessObserved()));
    values.put(
        "startLatenessDurationNanos",
        Long.toString(snapshot.getStartLatenessDurationNanos()));
    values.put(
        "startLatenessMaximumNanos",
        Long.toString(snapshot.getStartLatenessMaximumNanos()));
    values.put(
        "startLatenessP95Nanos",
        Long.toString(snapshot.getStartLatenessP95Nanos()));
    values.put(
        "startLatenessP99Nanos",
        Long.toString(snapshot.getStartLatenessP99Nanos()));
    values.put(
        "runDurationNanos",
        Long.toString(snapshot.getRunDurationNanos()));
    values.put(
        "runMaximumNanos",
        Long.toString(snapshot.getRunMaximumNanos()));
    values.put(
        "runP95Nanos", Long.toString(snapshot.getRunP95Nanos()));
    values.put(
        "runP99Nanos", Long.toString(snapshot.getRunP99Nanos()));
    values.put(
        "taskTypeCount", Integer.toString(snapshot.getTaskTypes().size()));
    for (int index = 0; index < snapshot.getTaskTypes().size(); index++) {
      ThreadPoolLatencyController.TypeSnapshot taskType =
          snapshot.getTaskTypes().get(index);
      String prefix =
          String.format(Locale.ROOT, "taskType.%03d.", index);
      values.put(prefix + "className", trimValue(taskType.getClassName()));
      values.put(prefix + "started", Long.toString(taskType.getStarted()));
      values.put(
          prefix + "completed", Long.toString(taskType.getCompleted()));
      values.put(prefix + "failures", Long.toString(taskType.getFailures()));
      values.put(
          prefix + "waitObserved",
          Long.toString(taskType.getWaitObserved()));
      values.put(
          prefix + "waitDurationNanos",
          Long.toString(taskType.getWaitDurationNanos()));
      values.put(
          prefix + "waitMaximumNanos",
          Long.toString(taskType.getWaitMaximumNanos()));
      values.put(
          prefix + "scheduleDelayObserved",
          Long.toString(taskType.getScheduleDelayObserved()));
      values.put(
          prefix + "scheduleDelayDurationNanos",
          Long.toString(taskType.getScheduleDelayDurationNanos()));
      values.put(
          prefix + "scheduleDelayMaximumNanos",
          Long.toString(taskType.getScheduleDelayMaximumNanos()));
      values.put(
          prefix + "startLatenessObserved",
          Long.toString(taskType.getStartLatenessObserved()));
      values.put(
          prefix + "startLatenessDurationNanos",
          Long.toString(taskType.getStartLatenessDurationNanos()));
      values.put(
          prefix + "startLatenessMaximumNanos",
          Long.toString(taskType.getStartLatenessMaximumNanos()));
      values.put(
          prefix + "runDurationNanos",
          Long.toString(taskType.getRunDurationNanos()));
      values.put(
          prefix + "runMaximumNanos",
          Long.toString(taskType.getRunMaximumNanos()));
    }
    values.put(
        "boundary",
        threadPoolLatencyBoundary(
            snapshot.getPoolClassName(), snapshot.getAttributionMode()));
    return values;
  }

  private static String threadPoolLatencyBoundary(
      String poolClassName, String attributionMode) {
    if ("QUEUE_AND_RUN".equals(attributionMode)) {
      return "One exact ThreadPoolExecutor only; queue wait requires a matched submission observed after probe start, CallerRuns execution is excluded, runtime task classes are exact, and bounded or unmatched records are reported instead of extrapolated";
    }
    if ("SCHEDULE_AND_RUN".equals(attributionMode)
        && "java.util.concurrent.ScheduledThreadPoolExecutor"
            .equals(poolClassName)) {
      return "One exact ScheduledThreadPoolExecutor only; delayedExecute and periodic re-enqueue observations separate remaining planned delay from worker start lateness after the task becomes ready and from execution time, the first run of pre-existing tasks remains unmatched, runtime types expose the JDK scheduled-task wrapper, and failures mean uncaught worker failures only";
    }
    return "One exact ForkJoinPool only; doExec time is measured only on workers owned by that pool, external help or join execution and queue wait are excluded, and failures mean uncaught doExec failures only";
  }

  private ActionResponse createThreadDump(ActionRequest request) {
    Path output = artifacts.allocatePath(".txt");
    try {
      int maximumThreads =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumThreads", "10000"),
              1,
              ThreadDumpController.MAXIMUM_THREADS,
              "maximumThreads");
      int maximumStackDepth =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumStackDepth", "256"),
              1,
              ThreadDumpController.MAXIMUM_STACK_DEPTH,
              "maximumStackDepth");
      boolean includeLocks =
          "true".equals(
              request.getParametersOrDefault(
                  "includeLocks", "true"));
      ThreadDumpController.Result result =
          threadDumps.capture(
              output,
              maximumThreads,
              maximumStackDepth,
              includeLocks);
      String token = artifacts.register(output);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("token", token);
      values.put(
          "name",
          "tanwei-thread-"
              + System.currentTimeMillis()
              + ".txt");
      values.put(
          "size",
          Long.toString(result.getBytesWritten()));
      values.put("type", "THREAD_DUMP");
      values.put(
          "threadsSeen",
          Integer.toString(result.getThreadsSeen()));
      values.put(
          "threadsWritten",
          Integer.toString(result.getThreadsWritten()));
      values.put(
          "truncated",
          Boolean.toString(result.isTruncated()));
      values.put(
          "deadlockedThreads",
          Integer.toString(result.getDeadlockedThreads()));
      values.put(
          "monitorsIncluded",
          Boolean.toString(result.isMonitorsIncluded()));
      values.put(
          "synchronizersIncluded",
          Boolean.toString(
              result.isSynchronizersIncluded()));
      values.put(
          "boundary",
          "Single bounded UTF-8 snapshot; maximum 10000 threads, 512 frames per thread and 32 MiB");
      return actionValues(values);
    } catch (IllegalArgumentException exception) {
      deleteBestEffort(output);
      return actionFailure(
          "INVALID_THREAD_DUMP_REQUEST", exception);
    } catch (Exception exception) {
      deleteBestEffort(output);
      return actionFailure("THREAD_DUMP_FAILED", exception);
    }
  }

  private static void deleteBestEffort(Path path) {
    try {
      Files.deleteIfExists(path);
    } catch (IOException ignored) {
      // The original action failure remains authoritative.
    }
  }

  private ActionResponse interruptThread(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, true);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      long threadId =
          positiveLong(
              request.getParametersOrDefault("threadId", ""),
              "threadId");
      String expectedName =
          request.getParametersOrDefault("expectedName", "");
      Thread thread = liveThreadsById().get(threadId);
      if (thread == null || !thread.isAlive()) {
        return actionError(
            "THREAD_NOT_FOUND",
            "The selected thread is no longer alive");
      }
      if (!thread.getName().equals(expectedName)) {
        return actionError(
            "THREAD_IDENTITY_CHANGED",
            "The selected thread identity no longer matches the preview");
      }
      String protectedReason = protectedThreadReason(thread);
      if (!protectedReason.isEmpty()) {
        return actionError("THREAD_INTERRUPT_DENIED", protectedReason);
      }
      String stateBefore = thread.getState().name();
      thread.interrupt();
      Map<String, String> values = new TreeMap<String, String>();
      values.put("threadId", Long.toString(threadId));
      values.put("name", trimValue(thread.getName()));
      values.put("stateBefore", stateBefore);
      values.put("stateAfterSignal", thread.getState().name());
      values.put("interruptSent", "true");
      values.put(
          "boundary",
          "Signal sent; interruption does not guarantee that target code stops");
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("THREAD_INTERRUPT_FAILED", exception);
    }
  }

  private static long positiveLong(String rawValue, String name) {
    try {
      long parsed = Long.parseLong(rawValue);
      if (parsed <= 0L) {
        throw new IllegalArgumentException(name + " must be positive");
      }
      return parsed;
    } catch (NumberFormatException exception) {
      throw new IllegalArgumentException(name + " must be an integer", exception);
    }
  }

  private static String protectedThreadReason(Thread thread) {
    if (thread == Thread.currentThread()) {
      return "The Agent request thread cannot interrupt itself";
    }
    String normalized = thread.getName().toLowerCase(Locale.ROOT);
    if (normalized.startsWith("tanwei-")
        || normalized.equals("attach listener")
        || normalized.equals("reference handler")
        || normalized.equals("finalizer")
        || normalized.equals("signal dispatcher")
        || normalized.equals("notification thread")
        || normalized.equals("common-cleaner")) {
      return "JVM and Tanwei infrastructure threads cannot be interrupted";
    }
    return "";
  }

  private ActionResponse stopJfr() {
    return stopJfr("SUCCEEDED");
  }

  private ActionResponse stopJfr(String terminalState) {
    try {
      String taskId = jfr.currentTaskId();
      long recordingId = jfr.currentRecordingId();
      String recordingName = jfr.currentRecordingName();
      String configuration = jfr.currentConfiguration();
      long maxAgeMillis = jfr.currentMaxAgeMillis();
      long maxSizeBytes = jfr.currentMaxSizeBytes();
      JfrController.ArtifactInfo artifact = jfr.stop();
      Map<String, String> values = new TreeMap<String, String>();
      values.put("kind", "JFR");
      values.put("taskId", taskId);
      values.put("state", terminalState);
      values.put("token", artifact.getToken());
      values.put("name", artifact.getName());
      values.put("size", Long.toString(artifact.getSize()));
      values.put("type", "JFR");
      values.put("recordingId", Long.toString(recordingId));
      values.put("recordingName", recordingName);
      values.put("configuration", configuration);
      values.put("maxAgeMillis", Long.toString(maxAgeMillis));
      values.put("maxSizeBytes", Long.toString(maxSizeBytes));
      return actionValues(values);
    } catch (RuntimeException exception) {
      return actionFailure("JFR_STOP_FAILED", exception);
    }
  }

  private ActionResponse createHeapDump(ActionRequest request) {
    if (!"true".equals(request.getParametersOrDefault("confirmed", "false"))) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("CONFIRMATION_REQUIRED")
          .setMessage("Heap dump requires explicit confirmation")
          .build();
    }

    Path output = artifacts.allocatePath(".hprof");
    try {
      dumpHeap(
          output,
          !"false".equals(request.getParametersOrDefault("live", "true")));
      String token = artifacts.register(output);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("token", token);
      values.put("name", "tanwei-heap-" + System.currentTimeMillis() + ".hprof");
      values.put("size", Long.toString(Files.size(output)));
      values.put("type", "HEAP_DUMP");
      return actionValues(values);
    } catch (Exception exception) {
      try {
        Files.deleteIfExists(output);
      } catch (IOException ignored) {
        // The primary heap dump failure is retained.
      }
      return actionFailure("HEAP_DUMP_FAILED", exception);
    }
  }

  private ActionResponse queryHeapInstances(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "10"),
              1,
              20,
              "limit");
      HeapInstanceController.QueryResult result =
          heapInstances.query(
              request.getParametersOrDefault("name", ""),
              request.getParametersOrDefault("classLoader", ""),
              limit);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("className", result.getClassName());
      values.put("classLoader", result.getClassLoader());
      values.put("requestedLimit", Integer.toString(result.getRequestedLimit()));
      values.put("count", Integer.toString(result.getInstances().size()));
      values.put(
          "boundary",
          "Exact-class JVMTI scan; values are bounded, transient and never persisted automatically");
      for (int instanceIndex = 0;
          instanceIndex < result.getInstances().size();
          instanceIndex++) {
        HeapInstanceController.Instance instance =
            result.getInstances().get(instanceIndex);
        String prefix =
            "instance."
                + String.format(Locale.ROOT, "%04d", instanceIndex)
                + ".";
        putHeapInstance(values, prefix, instance, true);
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("HEAP_INSTANCES_UNSUPPORTED", exception);
    } catch (Exception exception) {
      return actionFailure("HEAP_INSTANCE_QUERY_FAILED", exception);
    }
  }

  private ActionResponse queryHeapHistogram(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "100"),
              1,
              200,
              "limit");
      int scanLimit =
          boundedInt(
              request.getParametersOrDefault("scanLimit", "1000000"),
              10_000,
              5_000_000,
              "scanLimit");
      HeapInstanceController.HistogramResult result =
          heapInstances.histogram(
              limit,
              scanLimit,
              request.getParametersOrDefault("query", ""));
      Map<String, String> values = new TreeMap<String, String>();
      values.put(
          "loadedClasses",
          Integer.toString(result.getLoadedClasses()));
      values.put(
          "candidateClasses",
          Integer.toString(result.getCandidateClasses()));
      values.put(
          "nonEmptyClasses",
          Integer.toString(result.getNonEmptyClasses()));
      values.put(
          "skippedTaggedClasses",
          Integer.toString(result.getSkippedTaggedClasses()));
      values.put(
          "scannedObjects",
          Integer.toString(result.getScannedObjects()));
      values.put("truncated", Boolean.toString(result.isTruncated()));
      values.put(
          "classSelectionTruncated",
          Boolean.toString(result.isClassSelectionTruncated()));
      values.put(
          "accountedObjects",
          Long.toString(result.getAccountedObjects()));
      values.put(
          "accountedBytes",
          Long.toString(result.getAccountedBytes()));
      values.put("count", Integer.toString(result.getRows().size()));
      values.put(
          "boundary",
          "One bounded JVMTI heap iteration; shallow bytes only, not retained size; temporary class tags are removed before return and pre-tagged classes are omitted");
      for (int rowIndex = 0;
          rowIndex < result.getRows().size();
          rowIndex++) {
        HeapInstanceController.HistogramRow row =
            result.getRows().get(rowIndex);
        String prefix =
            "row."
                + String.format(Locale.ROOT, "%04d", rowIndex)
                + ".";
        values.put(prefix + "className", trimValue(row.getClassName()));
        values.put(prefix + "classLoader", trimValue(row.getClassLoader()));
        values.put(
            prefix + "instanceCount",
            Long.toString(row.getInstanceCount()));
        values.put(
            prefix + "shallowBytes",
            Long.toString(row.getShallowBytes()));
        values.put(
            prefix + "averageShallowBytes",
            Long.toString(row.getAverageShallowBytes()));
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("HEAP_HISTOGRAM_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_HEAP_HISTOGRAM_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("HEAP_HISTOGRAM_QUERY_FAILED", exception);
    }
  }

  private ActionResponse queryClassRetainedHistogram(
      ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "50"),
              1,
              200,
              "limit");
      int maximumNodes =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumNodes", "250000"),
              10_000,
              500_000,
              "maximumNodes");
      int maximumEdges =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumEdges", "1000000"),
              10_000,
              2_000_000,
              "maximumEdges");
      HeapInstanceController.ClassRetainedHistogramResult result =
          heapInstances.classRetainedHistogram(
              limit,
              maximumNodes,
              maximumEdges,
              request.getParametersOrDefault("query", ""));
      Map<String, String> values = new TreeMap<String, String>();
      values.put(
          "loadedClasses",
          Integer.toString(result.getLoadedClasses()));
      values.put(
          "selectedClasses",
          Integer.toString(result.getSelectedClasses()));
      values.put(
          "taggedClasses",
          Integer.toString(result.getTaggedClasses()));
      values.put(
          "skippedTaggedClasses",
          Integer.toString(result.getSkippedTaggedClasses()));
      values.put(
          "graphNodes",
          Integer.toString(result.getGraphNodes()));
      values.put(
          "graphEdges",
          Integer.toString(result.getGraphEdges()));
      values.put(
          "tagConflicts",
          Long.toString(result.getTagConflicts()));
      values.put(
          "truncated",
          Boolean.toString(result.isTruncated()));
      values.put(
          "nodeLimitReached",
          Boolean.toString(result.isNodeLimitReached()));
      values.put(
          "edgeLimitReached",
          Boolean.toString(result.isEdgeLimitReached()));
      values.put(
          "weakSemanticsComplete",
          Boolean.toString(result.isWeakSemanticsComplete()));
      values.put(
          "classSelectionComplete",
          Boolean.toString(result.isClassSelectionComplete()));
      values.put("exact", Boolean.toString(result.isExact()));
      values.put(
          "reachableNodes",
          Integer.toString(result.getReachableNodes()));
      values.put(
          "reachableBytes",
          Long.toString(result.getReachableBytes()));
      values.put(
          "accountedObjects",
          Long.toString(result.getAccountedObjects()));
      values.put(
          "accountedShallowBytes",
          Long.toString(result.getAccountedShallowBytes()));
      values.put("count", Integer.toString(result.getRows().size()));
      values.put(
          "boundary",
          "One bounded whole-heap strong-reference graph and one Lengauer-Tarjan dominator pass; each class retained value is the union of its topmost same-class dominator subtrees, so nested same-class instances are not double-counted; exact values require complete class and weak-reference metadata, no tag conflicts and no graph truncation");
      for (int rowIndex = 0;
          rowIndex < result.getRows().size();
          rowIndex++) {
        HeapInstanceController.ClassRetainedRow row =
            result.getRows().get(rowIndex);
        String prefix =
            "row."
                + String.format(Locale.ROOT, "%04d", rowIndex)
                + ".";
        values.put(prefix + "rank", Integer.toString(row.getRank()));
        values.put(prefix + "className", trimValue(row.getClassName()));
        values.put(
            prefix + "classLoader",
            trimValue(row.getClassLoader()));
        values.put(
            prefix + "instanceCount",
            Long.toString(row.getInstanceCount()));
        values.put(
            prefix + "shallowBytes",
            Long.toString(row.getShallowBytes()));
        values.put(
            prefix + "candidateRetainedObjects",
            Long.toString(row.getCandidateRetainedObjects()));
        values.put(
            prefix + "candidateRetainedBytes",
            Long.toString(row.getCandidateRetainedBytes()));
        values.put(
            prefix + "retainedBytes",
            Long.toString(row.getRetainedBytes()));
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure(
          "HEAP_CLASS_RETAINED_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure(
          "INVALID_HEAP_CLASS_RETAINED_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure(
          "HEAP_CLASS_RETAINED_QUERY_FAILED", exception);
    }
  }

  private ActionResponse queryHeapDominatorTree(
      ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int maximumDepth =
          boundedInt(
              request.getParametersOrDefault("maximumDepth", "4"),
              1,
              8,
              "maximumDepth");
      int maximumViewNodes =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumViewNodes", "80"),
              10,
              200,
              "maximumViewNodes");
      int rootLimit =
          boundedInt(
              request.getParametersOrDefault("rootLimit", "10"),
              1,
              20,
              "rootLimit");
      int branchLimit =
          boundedInt(
              request.getParametersOrDefault("branchLimit", "5"),
              1,
              20,
              "branchLimit");
      int maximumNodes =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumNodes", "250000"),
              10_000,
              500_000,
              "maximumNodes");
      int maximumEdges =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumEdges", "1000000"),
              10_000,
              2_000_000,
              "maximumEdges");
      HeapInstanceController.DominatorTreeResult result =
          heapInstances.dominatorTree(
              maximumDepth,
              maximumViewNodes,
              rootLimit,
              branchLimit,
              maximumNodes,
              maximumEdges);
      Map<String, String> values = new TreeMap<String, String>();
      values.put(
          "graphNodes",
          Integer.toString(result.getGraphNodes()));
      values.put(
          "graphEdges",
          Integer.toString(result.getGraphEdges()));
      values.put(
          "tagConflicts",
          Long.toString(result.getTagConflicts()));
      values.put(
          "truncated",
          Boolean.toString(result.isTruncated()));
      values.put(
          "nodeLimitReached",
          Boolean.toString(result.isNodeLimitReached()));
      values.put(
          "edgeLimitReached",
          Boolean.toString(result.isEdgeLimitReached()));
      values.put(
          "taggedClasses",
          Integer.toString(result.getTaggedClasses()));
      values.put(
          "skippedTaggedClasses",
          Integer.toString(result.getSkippedTaggedClasses()));
      values.put(
          "weakSemanticsComplete",
          Boolean.toString(result.isWeakSemanticsComplete()));
      values.put(
          "classSelectionComplete",
          Boolean.toString(result.isClassSelectionComplete()));
      values.put("exact", Boolean.toString(result.isExact()));
      values.put(
          "reachableNodes",
          Integer.toString(result.getReachableNodes()));
      values.put(
          "reachableBytes",
          Long.toString(result.getReachableBytes()));
      values.put(
          "viewTruncated",
          Boolean.toString(result.isViewTruncated()));
      values.put(
          "rootChildren",
          Integer.toString(result.getRootChildren()));
      values.put(
          "maximumDepth",
          Integer.toString(result.getMaximumDepth()));
      values.put(
          "maximumViewNodes",
          Integer.toString(result.getMaximumViewNodes()));
      values.put(
          "rootLimit",
          Integer.toString(result.getRootLimit()));
      values.put(
          "branchLimit",
          Integer.toString(result.getBranchLimit()));
      values.put(
          "count",
          Integer.toString(result.getNodes().size()));
      values.put(
          "boundary",
          "One bounded whole-heap strong-reference graph and one Lengauer-Tarjan dominator pass; the view starts at the virtual GC Root and keeps the largest retained children per level, bounded by depth, total view nodes, roots and branches; exact retained values describe the complete graph while viewTruncated describes presentation pruning");
      for (int nodeIndex = 0;
          nodeIndex < result.getNodes().size();
          nodeIndex++) {
        HeapInstanceController.DominatorTreeNode node =
            result.getNodes().get(nodeIndex);
        String prefix =
            "node."
                + String.format(Locale.ROOT, "%04d", nodeIndex)
                + ".";
        values.put(
            prefix + "index",
            Integer.toString(node.getIndex()));
        values.put(
            prefix + "parentIndex",
            Integer.toString(node.getParentIndex()));
        values.put(
            prefix + "depth",
            Integer.toString(node.getDepth()));
        values.put(
            prefix + "shallowBytes",
            Long.toString(node.getShallowBytes()));
        values.put(
            prefix + "retainedObjects",
            Long.toString(node.getRetainedObjects()));
        values.put(
            prefix + "candidateRetainedBytes",
            Long.toString(node.getCandidateRetainedBytes()));
        values.put(
            prefix + "retainedBytes",
            Long.toString(node.getRetainedBytes()));
        values.put(
            prefix + "directChildren",
            Integer.toString(node.getDirectChildren()));
        values.put(
            prefix + "displayedChildren",
            Integer.toString(node.getDisplayedChildren()));
        values.put(
            prefix + "classLoader",
            trimValue(node.getClassLoader()));
        putHeapInstance(values, prefix, node.getObject(), false);
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure(
          "HEAP_DOMINATOR_TREE_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure(
          "INVALID_HEAP_DOMINATOR_TREE_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure(
          "HEAP_DOMINATOR_TREE_QUERY_FAILED", exception);
    }
  }

  private ActionResponse queryHeapRelations(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "20"),
              1,
              50,
              "limit");
      int scanLimit =
          boundedInt(
              request.getParametersOrDefault("scanLimit", "250000"),
              1_000,
              1_000_000,
              "scanLimit");
      HeapInstanceController.RelationResult result =
          heapInstances.relations(
              request.getParametersOrDefault("objectHandle", ""),
              request.getParametersOrDefault("direction", ""),
              limit,
              scanLimit);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("direction", result.getDirection());
      values.put("scanned", Integer.toString(result.getScanned()));
      values.put("truncated", Boolean.toString(result.isTruncated()));
      values.put("count", Integer.toString(result.getRelations().size()));
      values.put(
          "boundary",
          "Session-only weak JVMTI tags; no business object is strongly retained; incoming traversal stops at the edge budget");
      putHeapInstance(values, "object.", result.getObject(), true);
      for (int relationIndex = 0;
          relationIndex < result.getRelations().size();
          relationIndex++) {
        HeapInstanceController.Relation relation =
            result.getRelations().get(relationIndex);
        String prefix =
            "relation."
                + String.format(Locale.ROOT, "%04d", relationIndex)
                + ".";
        values.put(prefix + "label", trimValue(relation.getLabel()));
        values.put(prefix + "kind", relation.getKind());
        values.put(prefix + "index", Integer.toString(relation.getIndex()));
        putHeapInstance(values, prefix, relation.getTarget(), false);
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("HEAP_RELATIONS_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_HEAP_RELATION_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("HEAP_RELATION_QUERY_FAILED", exception);
    }
  }

  private ActionResponse queryHeapObjectGraph(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int maximumDepth =
          boundedInt(
              request.getParametersOrDefault("maximumDepth", "3"),
              1,
              5,
              "maximumDepth");
      int maximumNodes =
          boundedInt(
              request.getParametersOrDefault("maximumNodes", "40"),
              2,
              80,
              "maximumNodes");
      int maximumEdgesPerNode =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumEdgesPerNode", "4"),
              1,
              8,
              "maximumEdgesPerNode");
      int scanLimit =
          boundedInt(
              request.getParametersOrDefault("scanLimit", "250000"),
              1_000,
              1_000_000,
              "scanLimit");
      HeapInstanceController.ObjectGraphResult result =
          heapInstances.objectGraph(
              request.getParametersOrDefault("objectHandle", ""),
              request.getParametersOrDefault("direction", ""),
              maximumDepth,
              maximumNodes,
              maximumEdgesPerNode,
              scanLimit);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("direction", result.getDirection());
      values.put(
          "scannedEdges",
          Long.toString(result.getScannedEdges()));
      values.put(
          "taggedObjects",
          Integer.toString(result.getTaggedObjects()));
      values.put(
          "tagConflicts",
          Long.toString(result.getTagConflicts()));
      values.put("truncated", Boolean.toString(result.isTruncated()));
      values.put(
          "nodeLimitReached",
          Boolean.toString(result.isNodeLimitReached()));
      values.put(
          "depthLimitReached",
          Boolean.toString(result.isDepthLimitReached()));
      values.put(
          "branchLimitReached",
          Boolean.toString(result.isBranchLimitReached()));
      values.put(
          "node.count",
          Integer.toString(result.getNodes().size()));
      values.put(
          "edge.count",
          Integer.toString(result.getEdges().size()));
      values.put(
          "boundary",
          "Outgoing graphs use bounded reflective breadth-first traversal; incoming graphs merge up to eight cycle-safe retention paths from one bounded JVMTI pass; nodes are deduplicated by opaque session handle and no object is persisted");
      putHeapInstance(values, "object.", result.getObject(), true);
      for (int nodeIndex = 0;
          nodeIndex < result.getNodes().size();
          nodeIndex++) {
        HeapInstanceController.GraphNode node =
            result.getNodes().get(nodeIndex);
        String prefix =
            "node."
                + String.format(Locale.ROOT, "%04d", nodeIndex)
                + ".";
        values.put(prefix + "index", Integer.toString(node.getIndex()));
        values.put(prefix + "depth", Integer.toString(node.getDepth()));
        putHeapInstance(values, prefix, node.getObject(), false);
      }
      for (int edgeIndex = 0;
          edgeIndex < result.getEdges().size();
          edgeIndex++) {
        HeapInstanceController.GraphEdge edge =
            result.getEdges().get(edgeIndex);
        String prefix =
            "edge."
                + String.format(Locale.ROOT, "%04d", edgeIndex)
                + ".";
        values.put(
            prefix + "source",
            Integer.toString(edge.getSource()));
        values.put(
            prefix + "target",
            Integer.toString(edge.getTarget()));
        values.put(prefix + "label", trimValue(edge.getLabel()));
        values.put(prefix + "kind", edge.getKind());
        values.put(prefix + "index", Integer.toString(edge.getIndex()));
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("HEAP_OBJECT_GRAPH_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_HEAP_OBJECT_GRAPH_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("HEAP_OBJECT_GRAPH_QUERY_FAILED", exception);
    }
  }

  private ActionResponse queryHeapRootPath(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int maximumDepth =
          boundedInt(
              request.getParametersOrDefault("maximumDepth", "16"),
              1,
              32,
              "maximumDepth");
      int maximumNodes =
          boundedInt(
              request.getParametersOrDefault("maximumNodes", "50000"),
              1_000,
              100_000,
              "maximumNodes");
      int maximumEdges =
          boundedInt(
              request.getParametersOrDefault("maximumEdges", "250000"),
              1_000,
              1_000_000,
              "maximumEdges");
      HeapInstanceController.RootPathResult result =
          heapInstances.rootPath(
              request.getParametersOrDefault("objectHandle", ""),
              maximumDepth,
              maximumNodes,
              maximumEdges);
      Map<String, String> values = new TreeMap<String, String>();
      values.put(
          "scannedEdges",
          Integer.toString(result.getScannedEdges()));
      values.put(
          "taggedObjects",
          Integer.toString(result.getTaggedObjects()));
      values.put("truncated", Boolean.toString(result.isTruncated()));
      values.put(
          "rootReached",
          Boolean.toString(result.isRootReached()));
      values.put("count", Integer.toString(result.getNodes().size()));
      values.put(
          "boundary",
          "One bounded JVMTI FollowReferences pass; temporary scan tags are removed before return; no business object is retained");
      for (int nodeIndex = 0;
          nodeIndex < result.getNodes().size();
          nodeIndex++) {
        HeapInstanceController.RootPathNode node =
            result.getNodes().get(nodeIndex);
        String prefix =
            "node."
                + String.format(Locale.ROOT, "%04d", nodeIndex)
                + ".";
        values.put(
            prefix + "relationLabel",
            trimValue(node.getRelationLabel()));
        values.put(prefix + "relationKind", node.getRelationKind());
        values.put(
            prefix + "relationIndex",
            Integer.toString(node.getRelationIndex()));
        values.put(prefix + "root", Boolean.toString(node.isRoot()));
        putHeapInstance(values, prefix, node.getObject(), false);
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("HEAP_ROOT_PATH_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_HEAP_ROOT_PATH_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("HEAP_ROOT_PATH_QUERY_FAILED", exception);
    }
  }

  private ActionResponse queryHeapRootPaths(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int maximumPaths =
          boundedInt(
              request.getParametersOrDefault("maximumPaths", "4"),
              1,
              8,
              "maximumPaths");
      int maximumDepth =
          boundedInt(
              request.getParametersOrDefault("maximumDepth", "16"),
              1,
              32,
              "maximumDepth");
      int maximumNodes =
          boundedInt(
              request.getParametersOrDefault("maximumNodes", "50000"),
              1_000,
              100_000,
              "maximumNodes");
      int maximumEdges =
          boundedInt(
              request.getParametersOrDefault("maximumEdges", "250000"),
              1_000,
              1_000_000,
              "maximumEdges");
      HeapInstanceController.RootPathsResult result =
          heapInstances.rootPaths(
              request.getParametersOrDefault("objectHandle", ""),
              maximumPaths,
              maximumDepth,
              maximumNodes,
              maximumEdges);
      Map<String, String> values = new TreeMap<String, String>();
      values.put(
          "scannedEdges",
          Long.toString(result.getScannedEdges()));
      values.put(
          "taggedObjects",
          Integer.toString(result.getTaggedObjects()));
      values.put(
          "tagConflicts",
          Long.toString(result.getTagConflicts()));
      values.put(
          "truncated",
          Boolean.toString(result.isTruncated()));
      values.put(
          "pathLimitReached",
          Boolean.toString(result.isPathLimitReached()));
      values.put(
          "count",
          Integer.toString(result.getPaths().size()));
      values.put(
          "boundary",
          "One bounded JVMTI FollowReferences pass records up to eight parent alternatives per relevant object and enumerates at most eight cycle-safe paths; temporary tags are removed before return and truncation covers scan, node, depth, tag-conflict, parent-branch and path-count limits");
      for (int pathIndex = 0;
          pathIndex < result.getPaths().size();
          pathIndex++) {
        HeapInstanceController.RootPath path =
            result.getPaths().get(pathIndex);
        String pathPrefix =
            "path."
                + String.format(Locale.ROOT, "%04d", pathIndex)
                + ".";
        values.put(
            pathPrefix + "rootReached",
            Boolean.toString(path.isRootReached()));
        values.put(
            pathPrefix + "count",
            Integer.toString(path.getNodes().size()));
        for (int nodeIndex = 0;
            nodeIndex < path.getNodes().size();
            nodeIndex++) {
          HeapInstanceController.RootPathNode node =
              path.getNodes().get(nodeIndex);
          String nodePrefix =
              pathPrefix
                  + "node."
                  + String.format(Locale.ROOT, "%04d", nodeIndex)
                  + ".";
          values.put(
              nodePrefix + "relationLabel",
              trimValue(node.getRelationLabel()));
          values.put(
              nodePrefix + "relationKind",
              node.getRelationKind());
          values.put(
              nodePrefix + "relationIndex",
              Integer.toString(node.getRelationIndex()));
          values.put(
              nodePrefix + "root",
              Boolean.toString(node.isRoot()));
          putHeapInstance(
              values, nodePrefix, node.getObject(), false);
        }
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("HEAP_ROOT_PATHS_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_HEAP_ROOT_PATHS_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("HEAP_ROOT_PATHS_QUERY_FAILED", exception);
    }
  }

  private ActionResponse queryHeapRetainedSize(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int maximumNodes =
          boundedInt(
              request.getParametersOrDefault("maximumNodes", "50000"),
              1_000,
              100_000,
              "maximumNodes");
      int maximumEdges =
          boundedInt(
              request.getParametersOrDefault("maximumEdges", "250000"),
              1_000,
              1_000_000,
              "maximumEdges");
      HeapInstanceController.RetainedSizeResult result =
          heapInstances.retainedSize(
              request.getParametersOrDefault("objectHandle", ""),
              maximumNodes,
              maximumEdges);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("closureEdges", Long.toString(result.getClosureEdges()));
      values.put("rootEdges", Long.toString(result.getRootEdges()));
      values.put(
          "taggedObjects",
          Integer.toString(result.getTaggedObjects()));
      values.put("tagConflicts", Long.toString(result.getTagConflicts()));
      values.put(
          "closureTruncated",
          Boolean.toString(result.isClosureTruncated()));
      values.put(
          "rootTruncated",
          Boolean.toString(result.isRootTruncated()));
      values.put(
          "referenceClasses",
          Integer.toString(result.getReferenceClasses()));
      values.put(
          "weakSemanticsComplete",
          Boolean.toString(result.isWeakSemanticsComplete()));
      values.put("exact", Boolean.toString(result.isExact()));
      values.put(
          "reachableObjects",
          Long.toString(result.getReachableObjects()));
      values.put(
          "reachableBytes",
          Long.toString(result.getReachableBytes()));
      values.put(
          "candidateObjects",
          Long.toString(result.getCandidateObjects()));
      values.put(
          "candidateBytes",
          Long.toString(result.getCandidateBytes()));
      values.put(
          "retainedBytes",
          Long.toString(result.getRetainedBytes()));
      values.put(
          "count",
          Integer.toString(result.getContributors().size()));
      values.put(
          "boundary",
          "Two bounded JVMTI strong-reference passes; Reference.referent and object-to-class edges are pruned; retainedBytes is exact only when both passes finish without tag conflicts and weak-reference metadata is complete, otherwise it is -1 and candidateBytes is not presented as exact");
      putHeapInstance(values, "object.", result.getObject(), true);
      for (int contributorIndex = 0;
          contributorIndex < result.getContributors().size();
          contributorIndex++) {
        HeapInstanceController.RetainedContributor contributor =
            result.getContributors().get(contributorIndex);
        String prefix =
            "contributor."
                + String.format(Locale.ROOT, "%04d", contributorIndex)
                + ".";
        values.put(
            prefix + "rank",
            Integer.toString(contributor.getRank()));
        values.put(
            prefix + "shallowBytes",
            Long.toString(contributor.getShallowBytes()));
        putHeapInstance(values, prefix, contributor.getObject(), false);
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("HEAP_RETAINED_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_HEAP_RETAINED_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("HEAP_RETAINED_QUERY_FAILED", exception);
    }
  }

  private ActionResponse queryHeapRetainedRanking(
      ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      int instanceLimit =
          boundedInt(
              request.getParametersOrDefault("instanceLimit", "10"),
              1,
              20,
              "instanceLimit");
      int maximumNodes =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumNodes", "250000"),
              10_000,
              500_000,
              "maximumNodes");
      int maximumEdges =
          boundedInt(
              request.getParametersOrDefault(
                  "maximumEdges", "1000000"),
              10_000,
              2_000_000,
              "maximumEdges");
      HeapInstanceController.RetainedRankingResult result =
          heapInstances.retainedRanking(
              request.getParametersOrDefault("name", ""),
              request.getParametersOrDefault("classLoader", ""),
              instanceLimit,
              maximumNodes,
              maximumEdges);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("className", result.getClassName());
      values.put("classLoader", result.getClassLoader());
      values.put(
          "requestedInstances",
          Integer.toString(result.getRequestedInstances()));
      values.put(
          "graphNodes",
          Integer.toString(result.getGraphNodes()));
      values.put(
          "graphEdges",
          Integer.toString(result.getGraphEdges()));
      values.put(
          "tagConflicts",
          Long.toString(result.getTagConflicts()));
      values.put(
          "truncated",
          Boolean.toString(result.isTruncated()));
      values.put(
          "nodeLimitReached",
          Boolean.toString(result.isNodeLimitReached()));
      values.put(
          "edgeLimitReached",
          Boolean.toString(result.isEdgeLimitReached()));
      values.put(
          "referenceClasses",
          Integer.toString(result.getReferenceClasses()));
      values.put(
          "weakSemanticsComplete",
          Boolean.toString(result.isWeakSemanticsComplete()));
      values.put("exact", Boolean.toString(result.isExact()));
      values.put(
          "reachableNodes",
          Integer.toString(result.getReachableNodes()));
      values.put(
          "reachableBytes",
          Long.toString(result.getReachableBytes()));
      values.put(
          "count",
          Integer.toString(result.getEntries().size()));
      values.put(
          "boundary",
          "One bounded whole-heap strong-reference graph and a near-linear Lengauer-Tarjan dominator pass are shared by all sampled instances; Reference.referent and object-to-class edges are pruned; retainedBytes is exact only for a complete graph with complete weak-reference metadata and no tag conflicts, otherwise entries are candidates");
      for (int entryIndex = 0;
          entryIndex < result.getEntries().size();
          entryIndex++) {
        HeapInstanceController.RetainedRankingEntry entry =
            result.getEntries().get(entryIndex);
        String prefix =
            "entry."
                + String.format(Locale.ROOT, "%04d", entryIndex)
                + ".";
        values.put(
            prefix + "rank",
            Integer.toString(entry.getRank()));
        values.put(
            prefix + "candidateObjects",
            Long.toString(entry.getCandidateObjects()));
        values.put(
            prefix + "candidateBytes",
            Long.toString(entry.getCandidateBytes()));
        values.put(
            prefix + "retainedBytes",
            Long.toString(entry.getRetainedBytes()));
        putHeapInstance(
            values, prefix, entry.getObject(), false);
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure(
          "HEAP_RETAINED_RANKING_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure(
          "INVALID_HEAP_RETAINED_RANKING_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure(
          "HEAP_RETAINED_RANKING_QUERY_FAILED", exception);
    }
  }

  private static void putHeapInstance(
      Map<String, String> values,
      String prefix,
      HeapInstanceController.Instance instance,
      boolean includeFields) {
    values.put(prefix + "handle", instance.getHandle());
    values.put(prefix + "type", instance.getType());
    values.put(prefix + "identity", instance.getIdentity());
    values.put(
        prefix + "shallowSize",
        Long.toString(instance.getShallowSize()));
    values.put(
        prefix + "navigable",
        Boolean.toString(instance.isNavigable()));
    Map<String, String> fields = instance.getFields();
    values.put(
        prefix + "field.count",
        Integer.toString(includeFields ? fields.size() : 0));
    if (!includeFields) {
      return;
    }
    int fieldIndex = 0;
    for (Map.Entry<String, String> field : fields.entrySet()) {
      String fieldPrefix =
          prefix
              + "field."
              + String.format(Locale.ROOT, "%04d", fieldIndex++)
              + ".";
      values.put(fieldPrefix + "name", trimValue(field.getKey()));
      values.put(fieldPrefix + "value", trimValue(field.getValue()));
    }
  }

  private ActionResponse listStaticFields(ActionRequest request) {
    try {
      return actionValues(
          staticFields.list(
              request.getParametersOrDefault("name", ""),
              request.getParametersOrDefault("classLoader", "")));
    } catch (Exception exception) {
      return actionFailure("STATIC_FIELD_LIST_FAILED", exception);
    }
  }

  private ActionResponse inspectClassLoaderResources(
      ActionRequest request) {
    try {
      return actionValues(
          classLoaderResources.inspect(
              request.getParametersOrDefault("name", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("resourceName", "")));
    } catch (IllegalArgumentException exception) {
      return actionFailure(
          "INVALID_CLASSLOADER_RESOURCE_LOOKUP", exception);
    } catch (
        ClassLoaderResourceExplorer.ResourceLookupTimeoutException
            exception) {
      return actionFailure(
          "CLASSLOADER_RESOURCE_LOOKUP_TIMED_OUT", exception);
    } catch (Exception exception) {
      return actionFailure(
          "CLASSLOADER_RESOURCE_LOOKUP_FAILED", exception);
    }
  }

  private ActionResponse previewStaticFieldRead(ActionRequest request) {
    try {
      return actionValues(
          staticFields.preview(
              request.getParametersOrDefault("name", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("declaringClass", ""),
              request.getParametersOrDefault("fieldName", "")));
    } catch (Exception exception) {
      return actionFailure("STATIC_FIELD_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse readStaticField(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      return actionValues(
          staticFields.read(
              request.getParametersOrDefault("name", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("declaringClass", ""),
              request.getParametersOrDefault("fieldName", ""),
              request.getParametersOrDefault("expectedFingerprint", "")));
    } catch (StaticFieldExplorer.StaleSelectionException exception) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("STALE_STATIC_FIELD")
          .setMessage(exception.getMessage())
          .putValues("actualFingerprint", exception.getActualFingerprint())
          .build();
    } catch (Exception exception) {
      return actionFailure("STATIC_FIELD_READ_FAILED", exception);
    }
  }

  private ActionResponse dumpClass(ActionRequest request) {
    if (!"true".equals(request.getParametersOrDefault("confirmed", "false"))) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("CONFIRMATION_REQUIRED")
          .setMessage("Class dump requires explicit confirmation")
          .build();
    }
    String className = request.getParametersOrDefault("name", "");
    String classLoader = request.getParametersOrDefault("classLoader", "");
    Class<?> matched = findLoadedClass(className, classLoader);
    if (matched == null) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("CLASS_NOT_FOUND")
          .setMessage("The selected class or ClassLoader is no longer available")
          .build();
    }
    try {
      ClassDumpController.ArtifactInfo artifact = classDump.dump(matched);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("token", artifact.getToken());
      values.put("name", artifact.getName());
      values.put("size", Long.toString(artifact.getSize()));
      values.put("type", "CLASS_DUMP");
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("CLASS_DUMP_FAILED", exception);
    }
  }

  private ActionResponse previewClassRedefinition(ActionRequest request) {
    Class<?> matched =
        findLoadedClass(
            request.getParametersOrDefault("name", ""),
            request.getParametersOrDefault("classLoader", ""));
    if (matched == null) {
      return actionError(
          "CLASS_NOT_FOUND",
          "The selected class or ClassLoader is no longer available");
    }
    if (retransforms.hasClaim(matched)) {
      return actionError(
          "CLASS_HAS_ACTIVE_INSTRUMENTATION",
          "Release the active retransformation owner for this class before replacement");
    }
    try {
      ClassRedefinitionController.Preview preview =
          classRedefinition.preview(
              matched,
              request.getParametersOrDefault("bytecodeBase64", ""));
      Map<String, String> values = new TreeMap<String, String>();
      values.put("className", matched.getName());
      values.put("classLoader", classLoaderName(matched));
      values.put("currentSha256", preview.getCurrentSha256());
      values.put("proposedSha256", preview.getProposedSha256());
      values.put("currentSize", Integer.toString(preview.getCurrentSize()));
      values.put("proposedSize", Integer.toString(preview.getProposedSize()));
      values.put("structuralCompatible", "true");
      values.put("boundary", "Only method bodies may change");
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("CLASS_REDEFINE_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse redefineClass(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    Class<?> matched =
        findLoadedClass(
            request.getParametersOrDefault("name", ""),
            request.getParametersOrDefault("classLoader", ""));
    if (matched == null) {
      return actionError(
          "CLASS_NOT_FOUND",
          "The selected class or ClassLoader is no longer available");
    }
    if (retransforms.hasClaim(matched)) {
      return actionError(
          "CLASS_HAS_ACTIVE_INSTRUMENTATION",
          "Release the active retransformation owner for this class before replacement");
    }
    try {
      ClassRedefinitionController.Result result =
          classRedefinition.redefine(
              matched,
              request.getParametersOrDefault("bytecodeBase64", ""),
              request.getParametersOrDefault("expectedCurrentSha256", ""));
      return classRedefinitionValues(result);
    } catch (ClassRedefinitionController.StaleDefinitionException exception) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("STALE_CLASS_DEFINITION")
          .setMessage(exception.getMessage())
          .putValues("actualSha256", exception.getActualSha256())
          .build();
    } catch (Exception exception) {
      return actionFailure("CLASS_REDEFINE_FAILED", exception);
    }
  }

  private ActionResponse restoreClassDefinition(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      ClassRedefinitionController.Result result =
          classRedefinition.restore(
              request.getParametersOrDefault("rollbackToken", ""),
              request.getParametersOrDefault("expectedCurrentSha256", ""));
      return classRedefinitionValues(result);
    } catch (ClassRedefinitionController.StaleDefinitionException exception) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("STALE_CLASS_DEFINITION")
          .setMessage(exception.getMessage())
          .putValues("actualSha256", exception.getActualSha256())
          .build();
    } catch (Exception exception) {
      return actionFailure("CLASS_RESTORE_FAILED", exception);
    }
  }

  private static ActionResponse classRedefinitionValues(
      ClassRedefinitionController.Result result) {
    Map<String, String> values = new TreeMap<String, String>();
    values.put("previousSha256", result.getPreviousSha256());
    values.put("currentSha256", result.getCurrentSha256());
    values.put("previousSize", Integer.toString(result.getPreviousSize()));
    values.put("currentSize", Integer.toString(result.getCurrentSize()));
    if (!result.getRollbackToken().isEmpty()) {
      values.put("rollbackToken", result.getRollbackToken());
      values.put("rollbackExpectedCurrentSha256", result.getCurrentSha256());
    }
    return actionValues(values);
  }

  private ActionResponse previewClassChangeSet(ActionRequest request) {
    try {
      ClassChangeSetInput input = classChangeSetInput(request);
      ClassRedefinitionController.BatchPreview preview =
          classRedefinition.previewBatch(
              input.targets, input.encodedBytecodes);
      Map<String, String> values = new TreeMap<String, String>();
      values.put(
          "count", Integer.toString(preview.getItems().size()));
      values.put("fingerprint", preview.getFingerprint());
      values.put("structuralCompatible", "true");
      values.put(
          "boundary",
          "2 to 8 classes, one exact ClassLoader, 2 MiB total; only method bodies may change");
      for (int index = 0;
          index < preview.getItems().size();
          index++) {
        ClassRedefinitionController.BatchPreviewItem item =
            preview.getItems().get(index);
        String prefix = String.format(
            java.util.Locale.ROOT, "item.%02d.", index);
        values.put(prefix + "className", item.getClassName());
        values.put(prefix + "classLoader", item.getClassLoader());
        values.put(
            prefix + "currentSha256", item.getCurrentSha256());
        values.put(
            prefix + "proposedSha256", item.getProposedSha256());
        values.put(
            prefix + "currentSize",
            Integer.toString(item.getCurrentSize()));
        values.put(
            prefix + "proposedSize",
            Integer.toString(item.getProposedSize()));
      }
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure(
          "CLASS_CHANGE_SET_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse applyClassChangeSet(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      ClassChangeSetInput input = classChangeSetInput(request);
      ClassRedefinitionController.BatchResult result =
          classRedefinition.redefineBatch(
              input.targets,
              input.encodedBytecodes,
              request.getParametersOrDefault(
                  "expectedFingerprint", ""));
      return classChangeSetResultValues(result);
    } catch (ClassRedefinitionController.StaleChangeSetException exception) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("STALE_CLASS_CHANGE_SET")
          .setMessage(exception.getMessage())
          .putValues(
              "actualFingerprint",
              exception.getActualFingerprint())
          .build();
    } catch (Exception exception) {
      return actionFailure("CLASS_CHANGE_SET_APPLY_FAILED", exception);
    }
  }

  private ActionResponse restoreClassChangeSet(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      ClassRedefinitionController.BatchResult result =
          classRedefinition.restoreBatch(
              request.getParametersOrDefault("rollbackToken", ""),
              request.getParametersOrDefault(
                  "expectedCurrentFingerprint", ""));
      return classChangeSetResultValues(result);
    } catch (ClassRedefinitionController.StaleChangeSetException exception) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("STALE_CLASS_CHANGE_SET")
          .setMessage(exception.getMessage())
          .putValues(
              "actualFingerprint",
              exception.getActualFingerprint())
          .build();
    } catch (Exception exception) {
      return actionFailure(
          "CLASS_CHANGE_SET_RESTORE_FAILED", exception);
    }
  }

  private ClassChangeSetInput classChangeSetInput(
      ActionRequest request) {
    int count =
        boundedInt(
            request.getParametersOrDefault("count", ""),
            2,
            8,
            "count");
    List<Class<?>> targets = new ArrayList<Class<?>>(count);
    List<String> encodedBytecodes =
        new ArrayList<String>(count);
    for (int index = 0; index < count; index++) {
      String name =
          request.getParametersOrDefault(
              "item" + index + "Name", "");
      String classLoader =
          request.getParametersOrDefault(
              "item" + index + "ClassLoader", "");
      Class<?> matched = findLoadedClass(name, classLoader);
      if (matched == null) {
        throw new IllegalArgumentException(
            "Change-set class "
                + index
                + " or its exact ClassLoader is no longer available");
      }
      if (retransforms.hasClaim(matched)) {
        throw new IllegalStateException(
            "Release the active retransformation owner for "
                + name
                + " before applying the change set");
      }
      targets.add(matched);
      encodedBytecodes.add(
          request.getParametersOrDefault(
              "item" + index + "BytecodeBase64", ""));
    }
    return new ClassChangeSetInput(targets, encodedBytecodes);
  }

  private static ActionResponse classChangeSetResultValues(
      ClassRedefinitionController.BatchResult result) {
    Map<String, String> values = new TreeMap<String, String>();
    values.put(
        "count", Integer.toString(result.getItems().size()));
    if (!result.getRollbackToken().isEmpty()) {
      values.put("rollbackToken", result.getRollbackToken());
      values.put(
          "rollbackExpectedCurrentFingerprint",
          result.getExpectedCurrentFingerprint());
    }
    for (int index = 0;
        index < result.getItems().size();
        index++) {
      ClassRedefinitionController.BatchResultItem item =
          result.getItems().get(index);
      String prefix = String.format(
          java.util.Locale.ROOT, "item.%02d.", index);
      values.put(prefix + "className", item.getClassName());
      values.put(prefix + "classLoader", item.getClassLoader());
      values.put(
          prefix + "previousSha256", item.getPreviousSha256());
      values.put(
          prefix + "currentSha256", item.getCurrentSha256());
      values.put(
          prefix + "previousSize",
          Integer.toString(item.getPreviousSize()));
      values.put(
          prefix + "currentSize",
          Integer.toString(item.getCurrentSize()));
    }
    return actionValues(values);
  }

  private ActionResponse previewObservation(ActionRequest request) {
    try {
      ObservationController.StartResult preview =
          observations.preview(
              request.getParametersOrDefault("className", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("methodName", ""),
              request.getParametersOrDefault("parameterTypes", ""));
      Map<String, String> values = new TreeMap<String, String>();
      values.put("matchCount", "1");
      values.put("className", preview.getClassName());
      values.put("method", preview.getMethod());
      return actionValues(values);
    } catch (RuntimeException exception) {
      return actionFailure("OBSERVATION_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse listSnapshots(ActionRequest request) {
    try {
      int offset =
          boundedInt(
              request.getParametersOrDefault("offset", "0"),
              0,
              SnapshotArchive.DEFAULT_MAXIMUM_SNAPSHOTS,
              "offset");
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "50"),
              1,
              SnapshotArchive.MAXIMUM_PAGE_SIZE,
              "limit");
      long minimumDurationMillis =
          boundedLong(
              request.getParametersOrDefault("minimumDurationMillis", "0"),
              0L,
              3_600_000L,
              "minimumDurationMillis");
      long maximumDurationMillis =
          boundedLong(
              request.getParametersOrDefault("maximumDurationMillis", "0"),
              0L,
              3_600_000L,
              "maximumDurationMillis");
      SnapshotArchive.Page page =
          observations.snapshots(
              new SnapshotArchive.Filter(
                  request.getParametersOrDefault("query", ""),
                  request.getParametersOrDefault("outcome", "ALL"),
                  request.getParametersOrDefault("scope", "ROOT"),
                  request.getParametersOrDefault("taskId", ""),
                  request.getParametersOrDefault("threadQuery", ""),
                  request.getParametersOrDefault("replay", "ALL"),
                  minimumDurationMillis,
                  maximumDurationMillis,
                  offset,
                  limit));
      Map<String, String> values = new TreeMap<String, String>();
      values.put("total", Integer.toString(page.getTotal()));
      values.put("offset", Integer.toString(page.getOffset()));
      values.put("limit", Integer.toString(page.getLimit()));
      values.put("count", Integer.toString(page.getItems().size()));
      values.put("retained", Integer.toString(page.getRetained()));
      values.put("returned", Integer.toString(page.getReturned()));
      values.put("threw", Integer.toString(page.getThrew()));
      values.put("root", Integer.toString(page.getRoot()));
      values.put("internal", Integer.toString(page.getInternal()));
      values.put("evicted", Long.toString(page.getEvicted()));
      values.put("estimatedBytes", Long.toString(page.getEstimatedBytes()));
      for (int index = 0; index < page.getItems().size(); index++) {
        putSnapshotSummary(
            values,
            String.format(Locale.ROOT, "snapshot.%04d.", index),
            page.getItems().get(index));
      }
      return actionValues(values);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_SNAPSHOT_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("SNAPSHOT_LIST_FAILED", exception);
    }
  }

  private ActionResponse describeSnapshot(ActionRequest request) {
    try {
      long snapshotId =
          positiveLong(
              request.getParametersOrDefault("snapshotId", ""),
              "snapshotId");
      SnapshotArchive.Snapshot snapshot = observations.snapshot(snapshotId);
      if (snapshot == null) {
        return actionError(
            "SNAPSHOT_NOT_FOUND",
            "The selected invocation snapshot is no longer retained");
      }
      Map<String, String> values = new TreeMap<String, String>();
      putSnapshotSummary(values, "", snapshot);
      values.put("classLoader", snapshot.getClassLoader());
      values.put("rootMethodName", snapshot.getRootMethodName());
      values.put("parameterTypes", snapshot.getParameterTypes());
      values.put("modifiers", snapshot.getModifiers());
      values.put("parentSequence", Long.toString(snapshot.getParentSequence()));
      values.put("returnValue", snapshot.getReturnValue());
      values.put("exceptionMessage", snapshot.getExceptionMessage());
      values.put("argument.count", Integer.toString(snapshot.getArguments().size()));
      for (int index = 0; index < snapshot.getArguments().size(); index++) {
        values.put(
            String.format(Locale.ROOT, "argument.%02d", index),
            snapshot.getArguments().get(index));
      }
      values.put("stack.count", Integer.toString(snapshot.getCallStack().size()));
      for (int index = 0; index < snapshot.getCallStack().size(); index++) {
        values.put(
            String.format(Locale.ROOT, "stack.%02d", index),
            snapshot.getCallStack().get(index));
      }
      putReceiverState(
          values, "receiverState.", snapshot.getReceiverState());
      putInvocationValues(
          values, "invocationValue.", snapshot.getInvocationValues());
      return actionValues(values);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_SNAPSHOT_ID", exception);
    } catch (Exception exception) {
      return actionFailure("SNAPSHOT_DESCRIBE_FAILED", exception);
    }
  }

  private ActionResponse deleteSnapshot(ActionRequest request) {
    try {
      long snapshotId =
          positiveLong(
              request.getParametersOrDefault("snapshotId", ""),
              "snapshotId");
      if (!observations.deleteSnapshot(snapshotId)) {
        return actionError(
            "SNAPSHOT_NOT_FOUND",
            "The selected invocation snapshot is no longer retained");
      }
      Map<String, String> values = new TreeMap<String, String>();
      values.put("snapshotId", Long.toString(snapshotId));
      values.put("deleted", "true");
      return actionValues(values);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_SNAPSHOT_ID", exception);
    }
  }

  private static void putSnapshotSummary(
      Map<String, String> values,
      String prefix,
      SnapshotArchive.Snapshot snapshot) {
    values.put(prefix + "snapshotId", Long.toString(snapshot.getId()));
    values.put(prefix + "taskId", snapshot.getTaskId());
    values.put(prefix + "className", snapshot.getClassName());
    values.put(prefix + "sequence", Long.toString(snapshot.getSequence()));
    values.put(prefix + "depth", Integer.toString(snapshot.getDepth()));
    values.put(prefix + "method", snapshot.getMethod());
    values.put(prefix + "phase", snapshot.getPhase());
    values.put(
        prefix + "capturedAtEpochMillis",
        Long.toString(snapshot.getCapturedAtEpochMillis()));
    values.put(
        prefix + "durationNanos",
        Long.toString(snapshot.getDurationNanos()));
    values.put(prefix + "threadName", snapshot.getThreadName());
    values.put(prefix + "outcome", snapshot.isThrew() ? "THREW" : "RETURNED");
    values.put(prefix + "exceptionType", snapshot.getExceptionType());
    values.put(
        prefix + "replayEligible",
        Boolean.toString(snapshot.isReplayEligible()));
    values.put(prefix + "replayMode", snapshot.getReplayMode());
    values.put(prefix + "receiverType", snapshot.getReceiverType());
    values.put(
        prefix + "receiverAvailable",
        Boolean.toString(snapshot.isReceiverAvailable()));
    values.put(
        prefix + "replayDeniedReason",
        snapshot.getReplayDeniedReason());
  }

  private ActionResponse startObservation(ActionRequest request) {
    if (!"true".equals(request.getParametersOrDefault("confirmed", "false"))) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("CONFIRMATION_REQUIRED")
          .setMessage("Method observation requires explicit confirmation")
          .build();
    }
    try {
      int maximumEvents =
          boundedInt(
              request.getParametersOrDefault("maximumEvents", "20"),
              1,
              100,
              "maximumEvents");
      long timeoutMillis =
          boundedLong(
              request.getParametersOrDefault("timeoutMillis", "30000"),
              1_000L,
              60_000L,
              "timeoutMillis");
      boolean includeInternal =
          "true".equals(
              request.getParametersOrDefault("includeInternal", "false"));
      String condition =
          request.getParametersOrDefault("condition", "").trim();
      String phases =
          normalizedWatchPhases(
              request.getParametersOrDefault("phases", "FINISH"));
      ObservationController.StartResult started =
          observations.start(
              request.getContext().getTaskId(),
              request.getParametersOrDefault("className", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("methodName", ""),
              request.getParametersOrDefault("parameterTypes", ""),
              maximumEvents,
              timeoutMillis,
              includeInternal,
              condition,
              phases);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("kind", "OBSERVATION");
      values.put("taskId", started.getTaskId());
      values.put("className", started.getClassName());
      values.put("method", started.getMethod());
      values.put("maximumEvents", Integer.toString(maximumEvents));
      values.put("timeoutMillis", Long.toString(timeoutMillis));
      values.put("includeInternal", Boolean.toString(includeInternal));
      values.put("condition", condition);
      values.put("phases", phases);
      return actionValues(values);
    } catch (Throwable throwable) {
      return actionFailure("OBSERVATION_START_FAILED", throwable);
    }
  }

  private ActionResponse previewLineProbe(ActionRequest request) {
    try {
      int lineNumber =
          boundedInt(
              request.getParametersOrDefault("lineNumber", ""),
              1,
              1_000_000,
              "lineNumber");
      LineProbeController.Preview preview =
          lineProbes.preview(
              request.getParametersOrDefault("className", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("methodName", ""),
              request.getParametersOrDefault("parameterTypes", ""),
              lineNumber);
      Map<String, String> values = lineProbeSelectionValues(preview);
      values.put("matchCount", "1");
      values.put(
          "boundary",
          "One exact loaded class, ClassLoader, method signature and source line; local values are bounded and rendered without arbitrary toString calls");
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("LINE_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse startLineProbe(ActionRequest request) {
    if (!"true".equals(request.getParametersOrDefault("confirmed", "false"))) {
      return actionError(
          "CONFIRMATION_REQUIRED",
          "Source-line probing requires explicit confirmation");
    }
    try {
      int lineNumber =
          boundedInt(
              request.getParametersOrDefault("lineNumber", ""),
              1,
              1_000_000,
              "lineNumber");
      int maximumEvents =
          boundedInt(
              request.getParametersOrDefault("maximumEvents", "20"),
              1,
              100,
              "maximumEvents");
      long timeoutMillis =
          boundedLong(
              request.getParametersOrDefault("timeoutMillis", "30000"),
              1_000L,
              60_000L,
              "timeoutMillis");
      LineProbeController.StartResult started =
          lineProbes.start(
              request.getContext().getTaskId(),
              request.getParametersOrDefault("className", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("methodName", ""),
              request.getParametersOrDefault("parameterTypes", ""),
              lineNumber,
              maximumEvents,
              timeoutMillis);
      Map<String, String> values = lineProbeSelectionValues(started);
      values.put("kind", "LINE");
      values.put("taskId", started.getTaskId());
      values.put("maximumEvents", Integer.toString(maximumEvents));
      values.put("timeoutMillis", Long.toString(timeoutMillis));
      values.put(
          "startedAtEpochMillis",
          Long.toString(started.getStartedAtEpochMillis()));
      values.put(
          "deadlineEpochMillis",
          Long.toString(started.getDeadlineEpochMillis()));
      return actionValues(values);
    } catch (Throwable throwable) {
      return actionFailure("LINE_START_FAILED", throwable);
    }
  }

  private ActionResponse lineProbeEvents(ActionRequest request) {
    try {
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "20"),
              1,
              100,
              "limit");
      LineProbeController.EventBatch batch =
          lineProbes.events(
              request.getParametersOrDefault("taskId", ""), limit);
      if ("UNKNOWN".equals(batch.getState())) {
        return taskNotFound(batch.getTaskId());
      }
      Map<String, String> values = new TreeMap<String, String>();
      values.put("kind", "LINE");
      values.put("taskId", batch.getTaskId());
      values.put("state", batch.getState());
      values.put("captured", Integer.toString(batch.getCaptured()));
      values.put("dropped", Integer.toString(batch.getDropped()));
      values.put("className", batch.getClassName());
      values.put("method", batch.getMethod());
      values.put("lineNumber", Integer.toString(batch.getLineNumber()));
      values.put("event.count", Integer.toString(batch.getEvents().size()));
      for (int eventIndex = 0;
          eventIndex < batch.getEvents().size();
          eventIndex++) {
        LineProbeController.ProbeEvent event =
            batch.getEvents().get(eventIndex);
        String eventPrefix =
            String.format(Locale.ROOT, "event.%04d.", eventIndex);
        values.put(
            eventPrefix + "sequence", Integer.toString(event.getSequence()));
        values.put(
            eventPrefix + "capturedAtEpochMillis",
            Long.toString(event.getCapturedAtEpochMillis()));
        values.put(eventPrefix + "threadName", event.getThreadName());
        values.put(eventPrefix + "className", event.getClassName());
        values.put(eventPrefix + "method", event.getMethod());
        values.put(
            eventPrefix + "lineNumber",
            Integer.toString(event.getLineNumber()));
        values.put(
            eventPrefix + "local.count",
            Integer.toString(event.getLocals().size()));
        for (int localIndex = 0;
            localIndex < event.getLocals().size();
            localIndex++) {
          LineProbeController.LocalValue local =
              event.getLocals().get(localIndex);
          String localPrefix =
              eventPrefix
                  + String.format(Locale.ROOT, "local.%02d.", localIndex);
          values.put(localPrefix + "name", local.getName());
          values.put(localPrefix + "value", local.getValue());
        }
        values.put(
            eventPrefix + "stack.count",
            Integer.toString(event.getCallStack().size()));
        for (int stackIndex = 0;
            stackIndex < event.getCallStack().size();
            stackIndex++) {
          values.put(
              eventPrefix
                  + String.format(Locale.ROOT, "stack.%02d", stackIndex),
              event.getCallStack().get(stackIndex));
        }
      }
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("LINE_EVENTS_FAILED", exception);
    }
  }

  private static Map<String, String> lineProbeSelectionValues(
      LineProbeController.Preview preview) {
    Map<String, String> values = new TreeMap<String, String>();
    values.put("className", preview.getClassName());
    values.put("method", preview.getMethod());
    values.put("sourceFile", preview.getSourceFile());
    values.put("lineNumber", Integer.toString(preview.getLineNumber()));
    values.put(
        "probePointCount", Integer.toString(preview.getProbePointCount()));
    values.put(
        "maximumLocalCount",
        Integer.toString(preview.getMaximumLocalCount()));
    return values;
  }

  private ActionResponse previewTrace(ActionRequest request) {
    try {
      TraceController.Preview preview =
          traces.preview(
              request.getParametersOrDefault("className", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("methodName", ""),
              request.getParametersOrDefault("parameterTypes", ""),
              request.getParametersOrDefault("scopePrefix", ""),
              request.getParametersOrDefault("includeRules", ""),
              request.getParametersOrDefault("excludeRules", ""));
      Map<String, String> values = traceSelectionValues(preview);
      values.put("matchCount", "1");
      values.put(
          "classLimit", Integer.toString(TraceController.MAXIMUM_CLASSES));
      values.put("withinLimit", Boolean.toString(preview.isWithinLimit()));
      values.put(
          "boundary",
          "Already-loaded, modifiable concrete classes and methods selected by declarative path rules in the same ClassLoader and package prefix only");
      return actionValues(values);
    } catch (RuntimeException exception) {
      return actionFailure("TRACE_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse startTrace(ActionRequest request) {
    if (!"true".equals(request.getParametersOrDefault("confirmed", "false"))) {
      return actionError(
          "CONFIRMATION_REQUIRED",
          "Cross-class trace requires explicit confirmation");
    }
    try {
      int maximumTraces =
          boundedInt(
              request.getParametersOrDefault("maximumTraces", "5"),
              1,
              20,
              "maximumTraces");
      int maximumDepth =
          boundedInt(
              request.getParametersOrDefault("maximumDepth", "12"),
              1,
              32,
              "maximumDepth");
      int maximumSpans =
          boundedInt(
              request.getParametersOrDefault("maximumSpans", "256"),
              16,
              512,
              "maximumSpans");
      long minimumDurationMillis =
          boundedLong(
              request.getParametersOrDefault("minimumDurationMillis", "0"),
              0L,
              60_000L,
              "minimumDurationMillis");
      long timeoutMillis =
          boundedLong(
              request.getParametersOrDefault("timeoutMillis", "15000"),
              1_000L,
              60_000L,
              "timeoutMillis");
      TraceController.StartResult started =
          traces.start(
              request.getContext().getTaskId(),
              request.getParametersOrDefault("className", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("methodName", ""),
              request.getParametersOrDefault("parameterTypes", ""),
              request.getParametersOrDefault("scopePrefix", ""),
              request.getParametersOrDefault("includeRules", ""),
              request.getParametersOrDefault("excludeRules", ""),
              maximumTraces,
              maximumDepth,
              maximumSpans,
              minimumDurationMillis,
              timeoutMillis);
      Map<String, String> values = traceSelectionValues(started);
      values.put("kind", "TRACE");
      values.put("taskId", started.getTaskId());
      values.put("maximumTraces", Integer.toString(maximumTraces));
      values.put("maximumDepth", Integer.toString(maximumDepth));
      values.put("maximumSpans", Integer.toString(maximumSpans));
      values.put(
          "minimumDurationMillis",
          Long.toString(minimumDurationMillis));
      values.put("timeoutMillis", Long.toString(timeoutMillis));
      values.put(
          "startedAtEpochMillis",
          Long.toString(started.getStartedAtEpochMillis()));
      values.put(
          "deadlineEpochMillis",
          Long.toString(started.getDeadlineEpochMillis()));
      return actionValues(values);
    } catch (Throwable throwable) {
      return actionFailure("TRACE_START_FAILED", throwable);
    }
  }

  private ActionResponse traceEvents(ActionRequest request) {
    try {
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "5"),
              1,
              5,
              "limit");
      TraceController.TraceBatch batch =
          traces.events(
              request.getParametersOrDefault("taskId", ""),
              limit);
      if ("UNKNOWN".equals(batch.getState())) {
        return taskNotFound(batch.getTaskId());
      }
      Map<String, String> values = new TreeMap<String, String>();
      values.put("taskId", batch.getTaskId());
      values.put("state", batch.getState());
      values.put("rootClassName", batch.getRootClassName());
      values.put("rootMethod", batch.getRootMethod());
      values.put("scopePrefix", batch.getScopePrefix());
      values.put("includeRules", batch.getIncludeRules());
      values.put("excludeRules", batch.getExcludeRules());
      values.put("classCount", Integer.toString(batch.getClassCount()));
      values.put(
          "instrumentedMethodCount",
          Integer.toString(batch.getInstrumentedMethodCount()));
      values.put("captured", Integer.toString(batch.getCaptured()));
      values.put(
          "maximumTraces", Integer.toString(batch.getMaximumTraces()));
      values.put(
          "minimumDurationMillis",
          Long.toString(batch.getMinimumDurationMillis()));
      values.put("dropped", Integer.toString(batch.getDropped()));
      values.put(
          "trace.count", Integer.toString(batch.getTraces().size()));
      for (int traceIndex = 0;
          traceIndex < batch.getTraces().size();
          traceIndex++) {
        TraceController.TraceSnapshot trace =
            batch.getTraces().get(traceIndex);
        String tracePrefix =
            String.format(Locale.ROOT, "trace.%04d.", traceIndex);
        values.put(
            tracePrefix + "traceId", Long.toString(trace.getTraceId()));
        values.put(
            tracePrefix + "capturedAtEpochMillis",
            Long.toString(trace.getCapturedAtEpochMillis()));
        values.put(
            tracePrefix + "durationNanos",
            Long.toString(trace.getDurationNanos()));
        values.put(tracePrefix + "threadId", Long.toString(trace.getThreadId()));
        values.put(tracePrefix + "threadName", trace.getThreadName());
        values.put(
            tracePrefix + "threadDaemon", Boolean.toString(trace.isThreadDaemon()));
        values.put(
            tracePrefix + "threadPriority", Integer.toString(trace.getThreadPriority()));
        values.put(tracePrefix + "threadGroup", trace.getThreadGroup());
        values.put(
            tracePrefix + "contextClassLoader", trace.getContextClassLoader());
        values.put(
            tracePrefix + "truncatedSpans",
            Integer.toString(trace.getTruncatedSpans()));
        values.put(
            tracePrefix + "span.count",
            Integer.toString(trace.getSpans().size()));
        for (int spanIndex = 0;
            spanIndex < trace.getSpans().size();
            spanIndex++) {
          TraceController.SpanSnapshot span =
              trace.getSpans().get(spanIndex);
          String spanPrefix =
              tracePrefix
                  + String.format(Locale.ROOT, "span.%04d.", spanIndex);
          values.put(
              spanPrefix + "sequence",
              Long.toString(span.getSequence()));
          values.put(
              spanPrefix + "parentSequence",
              Long.toString(span.getParentSequence()));
          values.put(
              spanPrefix + "depth", Integer.toString(span.getDepth()));
          values.put(spanPrefix + "method", span.getMethod());
          values.put(spanPrefix + "sourceFile", span.getSourceFile());
          values.put(
              spanPrefix + "sourceLine", Integer.toString(span.getSourceLine()));
          values.put(spanPrefix + "callSiteFile", span.getCallSiteFile());
          values.put(
              spanPrefix + "callSiteLine", Integer.toString(span.getCallSiteLine()));
          values.put(
              spanPrefix + "durationNanos",
              Long.toString(span.getDurationNanos()));
          values.put(spanPrefix + "exceptionType", span.getExceptionType());
          values.put(
              spanPrefix + "exceptionMessage",
              span.getExceptionMessage());
        }
      }
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("TRACE_EVENTS_FAILED", exception);
    }
  }

  private ActionResponse updateTraceThreshold(ActionRequest request) {
    if (!"true".equals(request.getParametersOrDefault("confirmed", "false"))) {
      return actionError(
          "CONFIRMATION_REQUIRED",
          "Trace threshold update requires explicit confirmation");
    }
    try {
      long minimumDurationMillis =
          boundedLong(
              request.getParametersOrDefault("minimumDurationMillis", "0"),
              0L,
              60_000L,
              "minimumDurationMillis");
      TraceController.ThresholdUpdate update =
          traces.updateMinimumDuration(
              request.getParametersOrDefault("taskId", ""),
              minimumDurationMillis);
      if ("UNKNOWN".equals(update.getState())) {
        return taskNotFound(update.getTaskId());
      }
      Map<String, String> values = new TreeMap<String, String>();
      values.put("kind", "TRACE");
      values.put("taskId", update.getTaskId());
      values.put("state", update.getState());
      values.put(
          "previousMinimumDurationMillis",
          Long.toString(update.getPreviousMinimumDurationMillis()));
      values.put(
          "minimumDurationMillis",
          Long.toString(update.getMinimumDurationMillis()));
      values.put(
          "boundary",
          "Applies at root completion without retransformation; completed traces are unchanged");
      return actionValues(values);
    } catch (Throwable throwable) {
      return actionFailure("TRACE_THRESHOLD_UPDATE_FAILED", throwable);
    }
  }

  private static Map<String, String> traceSelectionValues(
      TraceController.Preview preview) {
    Map<String, String> values = new TreeMap<String, String>();
    values.put("className", preview.getClassName());
    values.put("classLoader", preview.getClassLoader());
    values.put("method", preview.getMethod());
    values.put("scopePrefix", preview.getScopePrefix());
    values.put("includeRules", preview.getIncludeRules());
    values.put("excludeRules", preview.getExcludeRules());
    values.put(
        "instrumentedMethodCount",
        Integer.toString(preview.getInstrumentedMethodCount()));
    values.put(
        "class.count", Integer.toString(preview.getClasses().size()));
    for (int index = 0; index < preview.getClasses().size(); index++) {
      values.put(
          String.format(Locale.ROOT, "class.%04d.name", index),
          preview.getClasses().get(index));
    }
    return values;
  }

  private ActionResponse previewMethodMonitor(ActionRequest request) {
    try {
      MethodMonitorController.StartResult preview =
          monitors.preview(
              request.getParametersOrDefault("className", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("methodName", ""),
              request.getParametersOrDefault("parameterTypes", ""));
      Map<String, String> values = new TreeMap<String, String>();
      values.put("matchCount", "1");
      values.put("className", preview.getClassName());
      values.put("classLoader", preview.getClassLoader());
      values.put("method", preview.getMethod());
      values.put(
          "boundary",
          "Exact method only; each completed invocation contributes count, failure and duration metrics");
      return actionValues(values);
    } catch (RuntimeException exception) {
      return actionFailure("MONITOR_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse startMethodMonitor(ActionRequest request) {
    if (!"true".equals(request.getParametersOrDefault("confirmed", "false"))) {
      return actionError(
          "CONFIRMATION_REQUIRED",
          "Method monitoring requires explicit confirmation");
    }
    try {
      long intervalMillis =
          boundedLong(
              request.getParametersOrDefault("intervalMillis", "5000"),
              1_000L,
              60_000L,
              "intervalMillis");
      long durationMillis =
          boundedLong(
              request.getParametersOrDefault("durationMillis", "300000"),
              10_000L,
              28_800_000L,
              "durationMillis");
      long minimumDurationMillis =
          boundedLong(
              request.getParametersOrDefault(
                  "minimumDurationMillis", "0"),
              0L,
              60_000L,
              "minimumDurationMillis");
      MethodMonitorController.StartResult started =
          monitors.start(
              request.getContext().getTaskId(),
              request.getParametersOrDefault("className", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("methodName", ""),
              request.getParametersOrDefault("parameterTypes", ""),
              intervalMillis,
              durationMillis,
              minimumDurationMillis);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("kind", "MONITOR");
      values.put("taskId", started.getTaskId());
      values.put("className", started.getClassName());
      values.put("classLoader", started.getClassLoader());
      values.put("method", started.getMethod());
      values.put("intervalMillis", Long.toString(started.getIntervalMillis()));
      values.put(
          "minimumDurationMillis",
          Long.toString(minimumDurationMillis));
      values.put(
          "deadlineEpochMillis",
          Long.toString(started.getDeadlineEpochMillis()));
      return actionValues(values);
    } catch (Throwable throwable) {
      return actionFailure("MONITOR_START_FAILED", throwable);
    }
  }

  private ActionResponse updateMethodMonitorThreshold(
      ActionRequest request) {
    if (!"true".equals(request.getParametersOrDefault("confirmed", "false"))) {
      return actionError(
          "CONFIRMATION_REQUIRED",
          "Monitor threshold update requires explicit confirmation");
    }
    try {
      long minimumDurationMillis =
          boundedLong(
              request.getParametersOrDefault(
                  "minimumDurationMillis", "0"),
              0L,
              60_000L,
              "minimumDurationMillis");
      MethodMonitorController.ThresholdUpdate update =
          monitors.updateMinimumDuration(
              request.getParametersOrDefault("taskId", ""),
              minimumDurationMillis);
      if ("UNKNOWN".equals(update.getState())) {
        return taskNotFound(update.getTaskId());
      }
      Map<String, String> values = new TreeMap<String, String>();
      values.put("kind", "MONITOR");
      values.put("taskId", update.getTaskId());
      values.put("state", update.getState());
      values.put(
          "previousMinimumDurationMillis",
          Long.toString(update.getPreviousMinimumDurationMillis()));
      values.put(
          "minimumDurationMillis",
          Long.toString(update.getMinimumDurationMillis()));
      values.put(
          "boundary",
          "Closes the current window before applying the threshold without retransformation; older windows retain their threshold");
      return actionValues(values);
    } catch (Throwable throwable) {
      return actionFailure(
          "MONITOR_THRESHOLD_UPDATE_FAILED", throwable);
    }
  }

  private ActionResponse methodMonitorWindows(ActionRequest request) {
    try {
      long afterSequence =
          boundedLong(
              request.getParametersOrDefault("afterSequence", "0"),
              0L,
              1_000_000_000L,
              "afterSequence");
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "100"),
              1,
              100,
              "limit");
      MethodMonitorController.WindowBatch batch =
          monitors.windows(
              request.getParametersOrDefault("taskId", ""),
              afterSequence,
              limit);
      if ("UNKNOWN".equals(batch.getState())) {
        return taskNotFound(batch.getTaskId());
      }
      Map<String, String> values = new TreeMap<String, String>();
      values.put("taskId", batch.getTaskId());
      values.put("state", batch.getState());
      values.put("className", batch.getClassName());
      values.put("method", batch.getMethod());
      values.put(
          "startedAtEpochMillis",
          Long.toString(batch.getStartedAtEpochMillis()));
      values.put(
          "deadlineEpochMillis",
          Long.toString(batch.getDeadlineEpochMillis()));
      values.put(
          "intervalMillis", Long.toString(batch.getIntervalMillis()));
      values.put(
          "minimumDurationMillis",
          Long.toString(batch.getMinimumDurationMillis()));
      values.put("totalCalls", Long.toString(batch.getTotalCalls()));
      values.put("totalFailures", Long.toString(batch.getTotalFailures()));
      values.put(
          "totalDurationNanos",
          Long.toString(batch.getTotalDurationNanos()));
      values.put(
          "totalMaximumDurationNanos",
          Long.toString(batch.getTotalMaximumDurationNanos()));
      values.put(
          "totalP95DurationNanos",
          Long.toString(batch.getTotalP95DurationNanos()));
      values.put(
          "totalP99DurationNanos",
          Long.toString(batch.getTotalP99DurationNanos()));
      values.put(
          "nextSequence", Long.toString(batch.getNextSequence()));
      values.put(
          "window.count", Integer.toString(batch.getWindows().size()));
      for (int index = 0; index < batch.getWindows().size(); index++) {
        MethodMonitorController.WindowSnapshot window =
            batch.getWindows().get(index);
        String prefix =
            String.format(Locale.ROOT, "window.%04d.", index);
        values.put(prefix + "sequence", Long.toString(window.getSequence()));
        values.put(
            prefix + "startedAtEpochMillis",
            Long.toString(window.getStartedAtEpochMillis()));
        values.put(
            prefix + "endedAtEpochMillis",
            Long.toString(window.getEndedAtEpochMillis()));
        values.put(
            prefix + "minimumDurationMillis",
            Long.toString(window.getMinimumDurationMillis()));
        values.put(prefix + "calls", Long.toString(window.getCalls()));
        values.put(
            prefix + "failures", Long.toString(window.getFailures()));
        values.put(
            prefix + "durationNanos",
            Long.toString(window.getDurationNanos()));
        values.put(
            prefix + "maximumDurationNanos",
            Long.toString(window.getMaximumDurationNanos()));
        values.put(
            prefix + "p95DurationNanos",
            Long.toString(window.getP95DurationNanos()));
        values.put(
            prefix + "p99DurationNanos",
            Long.toString(window.getP99DurationNanos()));
      }
      return actionValues(values);
    } catch (Exception exception) {
      return actionFailure("MONITOR_WINDOWS_FAILED", exception);
    }
  }

  private ActionResponse previewInvocationReplay(ActionRequest request) {
    try {
      List<String> arguments = replayArguments(request);
      ReplaySnapshotContext snapshotContext =
          replaySnapshotContext(request, arguments);
      InvocationReplayController.Preview preview =
          invocationReplay.preview(
              request.getParametersOrDefault("className", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("methodName", ""),
              request.getParametersOrDefault("parameterTypes", ""),
              arguments,
              snapshotContext.snapshotId,
              snapshotContext.receiver);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("fingerprint", preview.getFingerprint());
      values.put("className", preview.getClassName());
      values.put("classLoader", preview.getClassLoader());
      values.put("method", preview.getMethod());
      values.put("invocation", preview.getInvocation());
      values.put("returnType", preview.getReturnType());
      values.put("replayMode", preview.getReplayMode());
      values.put("receiverType", preview.getReceiverType());
      values.put("snapshotId", Long.toString(snapshotContext.snapshotId));
      ReceiverStateSnapshot capturedState =
          snapshotContext.snapshot == null
              ? ReceiverStateSnapshot.empty()
              : snapshotContext.snapshot.getReceiverState();
      putReceiverState(values, "capturedState.", capturedState);
      putReceiverState(
          values, "currentState.", preview.getReceiverState());
      putReceiverStateChanges(
          values,
          "stateDrift.",
          capturedState.changesTo(preview.getReceiverState()));
      values.put("risk", "R4");
      values.put(
          "boundary",
          "Target code may cause irreversible business side effects; receiver evidence includes at most 16 scalar fields and concurrent writes cannot be attributed solely to replay; timeout cannot guarantee termination");
      return actionValues(values);
    } catch (InvocationReplayController.ReceiverExpiredException exception) {
      return actionFailure("REPLAY_RECEIVER_EXPIRED", exception);
    } catch (Exception exception) {
      return actionFailure("INVOCATION_REPLAY_PREVIEW_FAILED", exception);
    }
  }

  private ActionResponse invokeReplay(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, true);
    if (confirmation != null) {
      return confirmation;
    }
    try {
      List<String> arguments = replayArguments(request);
      ReplaySnapshotContext snapshotContext =
          replaySnapshotContext(request, arguments);
      InvocationReplayController.Result result =
          invocationReplay.invoke(
              request.getParametersOrDefault("className", ""),
              request.getParametersOrDefault("classLoader", ""),
              request.getParametersOrDefault("methodName", ""),
              request.getParametersOrDefault("parameterTypes", ""),
              arguments,
              request.getParametersOrDefault("expectedFingerprint", ""),
              snapshotContext.snapshotId,
              snapshotContext.receiver);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("outcome", result.getOutcome());
      values.put("returnValue", result.getReturnValue());
      values.put("exceptionType", result.getExceptionType());
      values.put("exceptionMessage", result.getExceptionMessage());
      values.put("fingerprint", request.getParametersOrDefault("expectedFingerprint", ""));
      putReceiverState(
          values,
          "beforeState.",
          result.getBeforeReceiverState());
      putReceiverState(
          values,
          "afterState.",
          result.getAfterReceiverState());
      putReceiverStateChanges(
          values,
          "stateChange.",
          result
              .getBeforeReceiverState()
              .changesTo(result.getAfterReceiverState()));
      return actionValues(values);
    } catch (InvocationReplayController.StaleReplayException exception) {
      return ActionResponse.newBuilder()
          .setStatus("FAILED")
          .setErrorCode("STALE_REPLAY_PREVIEW")
          .setMessage(exception.getMessage())
          .putValues("actualFingerprint", exception.getActualFingerprint())
          .build();
    } catch (InvocationReplayController.ReplayTimeoutException exception) {
      return actionFailure("INVOCATION_TIMEOUT_MAY_CONTINUE", exception);
    } catch (InvocationReplayController.ReceiverExpiredException exception) {
      return actionFailure("REPLAY_RECEIVER_EXPIRED", exception);
    } catch (Exception exception) {
      return actionFailure("INVOCATION_REPLAY_FAILED", exception);
    }
  }

  private ReplaySnapshotContext replaySnapshotContext(
      ActionRequest request, List<String> arguments) {
    String rawSnapshotId =
        request.getParametersOrDefault("snapshotId", "").trim();
    String requestedMode =
        request.getParametersOrDefault("replayMode", "").trim();
    if (rawSnapshotId.isEmpty()) {
      if ("INSTANCE".equals(requestedMode)) {
        throw new IllegalArgumentException(
            "Instance replay requires a live snapshot id");
      }
      return ReplaySnapshotContext.directStatic();
    }
    long snapshotId = positiveLong(rawSnapshotId, "snapshotId");
    SnapshotArchive.Snapshot snapshot = observations.snapshot(snapshotId);
    if (snapshot == null) {
      throw new IllegalArgumentException(
          "The originating replay snapshot is no longer retained");
    }
    if (!snapshot.getClassName().equals(
            request.getParametersOrDefault("className", ""))
        || !snapshot.getClassLoader().equals(
            request.getParametersOrDefault("classLoader", ""))
        || !snapshot.getRootMethodName().equals(
            request.getParametersOrDefault("methodName", ""))
        || !snapshot.getParameterTypes().equals(
            request.getParametersOrDefault("parameterTypes", ""))
        || !snapshot.getArguments().equals(arguments)) {
      throw new IllegalArgumentException(
          "Replay request no longer matches the originating snapshot");
    }
    String replayMode = snapshot.getReplayMode();
    if (!requestedMode.isEmpty() && !requestedMode.equals(replayMode)) {
      throw new IllegalArgumentException(
          "Replay mode no longer matches the originating snapshot");
    }
    if (!snapshot.isReplayEligible()) {
      if ("RECEIVER_EXPIRED".equals(snapshot.getReplayDeniedReason())) {
        throw new InvocationReplayController.ReceiverExpiredException();
      }
      throw new IllegalArgumentException(
          "Snapshot is not replayable: " + snapshot.getReplayDeniedReason());
    }
    Object receiver = "INSTANCE".equals(replayMode) ? snapshot.getReceiver() : null;
    if ("INSTANCE".equals(replayMode) && receiver == null) {
      throw new InvocationReplayController.ReceiverExpiredException();
    }
    return new ReplaySnapshotContext(snapshotId, receiver, snapshot);
  }

  private static void putReceiverState(
      Map<String, String> values,
      String prefix,
      ReceiverStateSnapshot state) {
    ReceiverStateSnapshot safeState =
        state == null ? ReceiverStateSnapshot.unavailable() : state;
    values.put(prefix + "available", Boolean.toString(safeState.isAvailable()));
    values.put(
        prefix + "scannedFields",
        Integer.toString(safeState.getScannedFields()));
    values.put(
        prefix + "unavailableFields",
        Integer.toString(safeState.getUnavailableFields()));
    values.put(prefix + "truncated", Boolean.toString(safeState.isTruncated()));
    values.put(prefix + "count", Integer.toString(safeState.getFields().size()));
    for (int index = 0; index < safeState.getFields().size(); index++) {
      ReceiverStateSnapshot.FieldValue field = safeState.getFields().get(index);
      String fieldPrefix =
          prefix + String.format(Locale.ROOT, "%02d.", index);
      values.put(fieldPrefix + "name", field.getName());
      values.put(fieldPrefix + "value", field.getValue());
    }
  }

  private static void putReceiverStateChanges(
      Map<String, String> values,
      String prefix,
      List<ReceiverStateSnapshot.Change> changes) {
    List<ReceiverStateSnapshot.Change> safeChanges =
        changes == null
            ? Collections.<ReceiverStateSnapshot.Change>emptyList()
            : changes;
    values.put(prefix + "count", Integer.toString(safeChanges.size()));
    for (int index = 0; index < safeChanges.size(); index++) {
      ReceiverStateSnapshot.Change change = safeChanges.get(index);
      String changePrefix =
          prefix + String.format(Locale.ROOT, "%02d.", index);
      values.put(changePrefix + "name", change.getName());
      values.put(changePrefix + "before", change.getBefore());
      values.put(changePrefix + "after", change.getAfter());
      values.put(changePrefix + "kind", change.getKind());
    }
  }

  private static void putInvocationValues(
      Map<String, String> values,
      String prefix,
      InvocationValueSnapshot snapshot) {
    InvocationValueSnapshot safeSnapshot =
        snapshot == null ? InvocationValueSnapshot.unavailable() : snapshot;
    values.put(
        prefix + "available", Boolean.toString(safeSnapshot.isAvailable()));
    values.put(
        prefix + "scannedFields",
        Integer.toString(safeSnapshot.getScannedFields()));
    values.put(
        prefix + "truncated", Boolean.toString(safeSnapshot.isTruncated()));
    values.put(prefix + "count", Integer.toString(safeSnapshot.getNodes().size()));
    for (int index = 0; index < safeSnapshot.getNodes().size(); index++) {
      InvocationValueSnapshot.Node node = safeSnapshot.getNodes().get(index);
      String nodePrefix =
          prefix + String.format(Locale.ROOT, "%03d.", index);
      values.put(nodePrefix + "path", node.getPath());
      values.put(nodePrefix + "parentIndex", Integer.toString(node.getParentIndex()));
      values.put(nodePrefix + "depth", Integer.toString(node.getDepth()));
      values.put(nodePrefix + "kind", node.getKind());
      values.put(nodePrefix + "typeName", node.getTypeName());
      values.put(nodePrefix + "value", node.getValue());
      values.put(nodePrefix + "childCount", Integer.toString(node.getChildCount()));
      values.put(nodePrefix + "truncated", Boolean.toString(node.isTruncated()));
    }
  }

  private static List<String> replayArguments(ActionRequest request) {
    int count =
        boundedInt(
            request.getParametersOrDefault("argumentCount", "0"),
            0,
            8,
            "argumentCount");
    List<String> arguments = new ArrayList<String>(count);
    for (int index = 0; index < count; index++) {
      String key = "argument" + index;
      if (!request.getParametersMap().containsKey(key)) {
        throw new IllegalArgumentException("Missing replay argument " + index);
      }
      arguments.add(request.getParametersOrDefault(key, ""));
    }
    return arguments;
  }

  private ActionResponse startProfile(ActionRequest request) {
    try {
      long intervalMillis =
          boundedLong(
              request.getParametersOrDefault("intervalMillis", "20"),
              10L,
              1_000L,
              "intervalMillis");
      long durationMillis =
          boundedLong(
              request.getParametersOrDefault("durationMillis", "30000"),
              1_000L,
              60_000L,
              "durationMillis");
      int stackDepth =
          boundedInt(
              request.getParametersOrDefault("stackDepth", "256"),
              SamplingProfilerController.MINIMUM_STACK_DEPTH,
              SamplingProfilerController.MAXIMUM_STACK_DEPTH,
              "stackDepth");
      String threadsValue = request.getParametersOrDefault("threads", "false");
      if (!"true".equals(threadsValue) && !"false".equals(threadsValue)) {
        throw new IllegalArgumentException("threads must be true or false");
      }
      boolean threads = Boolean.parseBoolean(threadsValue);
      String includeRules = request.getParametersOrDefault("includeRules", "");
      String excludeRules = request.getParametersOrDefault("excludeRules", "");
      SamplingProfilerController.StartResult started =
          profiler.start(
              request.getParametersOrDefault("event", "CPU"),
              intervalMillis,
              durationMillis,
              stackDepth,
              threads,
              includeRules,
              excludeRules);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("kind", "PROFILE");
      values.put("taskId", started.getTaskId());
      values.put("event", started.getEvent());
      values.put("state", "RUNNING");
      values.put("intervalMillis", Long.toString(intervalMillis));
      values.put("durationMillis", Long.toString(durationMillis));
      values.put("stackDepth", Integer.toString(stackDepth));
      values.put("threads", Boolean.toString(threads));
      values.put("includeRules", includeRules);
      values.put("excludeRules", excludeRules);
      values.put("engine", started.getEngine());
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("PROFILER_EVENT_UNSUPPORTED", exception);
    } catch (Exception exception) {
      return actionFailure("PROFILER_START_FAILED", exception);
    }
  }

  private static ActionResponse profileResult(
      SamplingProfilerController.Result result) {
    Map<String, String> values = new TreeMap<String, String>();
    values.put("kind", "PROFILE");
    values.put("taskId", result.getTaskId());
    values.put("state", result.getState());
    values.put("event", result.getEvent());
    values.put("samples", Long.toString(result.getSamples()));
    values.put("dropped", Long.toString(result.getDropped()));
    values.put("engine", result.getEngine());
    if (!result.getError().isEmpty()) {
      values.put("error", trimValue(result.getError()));
    }
    SamplingProfilerController.ArtifactInfo artifact = result.getArtifact();
    if (artifact != null) {
      values.put("token", artifact.getToken());
      values.put("size", Long.toString(artifact.getSize()));
      values.put("type", "PROFILE");
    }
    return actionValues(values);
  }

  private ActionResponse dumpProfile(ActionRequest request) {
    String taskId = request.getParametersOrDefault("taskId", "");
    try {
      SamplingProfilerController.Result result = profiler.dump(taskId);
      if ("UNKNOWN".equals(result.getState())) {
        return taskNotFound(taskId);
      }
      return profileResult(result);
    } catch (RuntimeException exception) {
      return actionFailure("PROFILER_DUMP_FAILED", exception);
    }
  }

  private Class<?> findLoadedClass(String name, String classLoader) {
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      if (type.getName().equals(name)
          && classLoaderName(type).equals(classLoader)) {
        return type;
      }
    }
    return null;
  }

  private static void dumpHeap(Path output, boolean live) throws Exception {
    javax.management.MBeanServer server = ManagementFactory.getPlatformMBeanServer();
    javax.management.ObjectName diagnostic =
        new javax.management.ObjectName(
            "com.sun.management:type=HotSpotDiagnostic");
    server.invoke(
        diagnostic,
        "dumpHeap",
        new Object[] {output.toString(), Boolean.valueOf(live)},
        new String[] {String.class.getName(), boolean.class.getName()});
  }

  private static ActionResponse actionFailure(String code, Throwable throwable) {
    String message = throwable.getMessage();
    String detail =
        message == null || message.trim().isEmpty()
            ? throwable.getClass().getName()
            : throwable.getClass().getName() + ": " + message;
    return ActionResponse.newBuilder()
        .setStatus("FAILED")
        .setErrorCode(code)
        .setMessage(trimValue(detail))
        .build();
  }

  private static ActionResponse setSystemProperty(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    String name = request.getParametersOrDefault("name", "").trim();
    String newValue = request.getParametersOrDefault("newValue", "");
    String expectedOldValue =
        request.getParametersOrDefault("expectedOldValue", "");
    if (!name.matches("[A-Za-z0-9_.-]{1,256}") || isSensitiveKey(name)) {
      return actionError(
          "PROPERTY_NOT_ALLOWED",
          "Only existing non-sensitive system properties with safe names can be changed");
    }
    if (newValue.length() > MAXIMUM_PROPERTY_VALUE_LENGTH) {
      return actionError("INVALID_VALUE", "System property value is too long");
    }
    try {
      String oldValue = System.getProperty(name);
      if (oldValue == null) {
        return actionError(
            "PROPERTY_NOT_FOUND", "The system property must already exist");
      }
      if (!Objects.equals(oldValue, expectedOldValue)) {
        return staleValue(oldValue);
      }
      System.setProperty(name, newValue);
      return mutationValues(
          "system.property.set", name, oldValue, newValue);
    } catch (SecurityException exception) {
      return actionFailure("PROPERTY_SET_FAILED", exception);
    }
  }

  private static ActionResponse setLoggingLevel(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    String requestedName = request.getParametersOrDefault("name", "").trim();
    String loggerName = "<root>".equals(requestedName) ? "" : requestedName;
    String newValue =
        request.getParametersOrDefault("newValue", "").trim().toUpperCase(Locale.ROOT);
    String expectedOldValue =
        request.getParametersOrDefault("expectedOldValue", "");
    if (loggerName.length() > 512
        || loggerName.indexOf('\n') >= 0
        || loggerName.indexOf('\r') >= 0) {
      return actionError("INVALID_LOGGER", "Logger name is invalid");
    }
    Logger logger = LogManager.getLogManager().getLogger(loggerName);
    if (logger == null) {
      return actionError("LOGGER_NOT_FOUND", "The selected JUL logger no longer exists");
    }
    String oldValue =
        logger.getLevel() == null ? "<inherited>" : logger.getLevel().getName();
    if (!Objects.equals(oldValue, expectedOldValue)) {
      return staleValue(oldValue);
    }
    try {
      Level level = "<INHERITED>".equals(newValue) ? null : Level.parse(newValue);
      logger.setLevel(level);
      String appliedValue =
          logger.getLevel() == null ? "<inherited>" : logger.getLevel().getName();
      return mutationValues(
          "logging.set",
          requestedName.isEmpty() ? "<root>" : requestedName,
          oldValue,
          appliedValue);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_LOG_LEVEL", exception);
    } catch (SecurityException exception) {
      return actionFailure("LOGGING_SET_FAILED", exception);
    }
  }

  private static ActionResponse setVmOption(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, false);
    if (confirmation != null) {
      return confirmation;
    }
    String name = request.getParametersOrDefault("name", "").trim();
    String newValue = request.getParametersOrDefault("newValue", "").trim();
    String expectedOldValue =
        request.getParametersOrDefault("expectedOldValue", "");
    if (!name.matches("[A-Za-z][A-Za-z0-9_]{0,127}")
        || VmOptionExplorer.isSensitiveName(name)
        || newValue.length() > 1_024
        || newValue.indexOf('\n') >= 0
        || newValue.indexOf('\r') >= 0) {
      return actionError("INVALID_VM_OPTION", "VM option name or value is invalid");
    }
    try {
      Class<?> diagnosticType =
          Class.forName("com.sun.management.HotSpotDiagnosticMXBean");
      @SuppressWarnings({"rawtypes", "unchecked"})
      Object diagnostic =
          ManagementFactory.getPlatformMXBean((Class) diagnosticType);
      if (diagnostic == null) {
        return actionError(
            "VM_OPTIONS_UNSUPPORTED", "HotSpot diagnostic options are unavailable");
      }
      Object option =
          diagnosticType.getMethod("getVMOption", String.class).invoke(diagnostic, name);
      Class<?> optionType = option.getClass();
      boolean writeable =
          ((Boolean) optionType.getMethod("isWriteable").invoke(option)).booleanValue();
      if (!writeable) {
        return actionError(
            "VM_OPTION_READ_ONLY", "The selected VM option is not writeable");
      }
      String oldValue =
          String.valueOf(optionType.getMethod("getValue").invoke(option));
      if (!Objects.equals(oldValue, expectedOldValue)) {
        return staleValue(oldValue);
      }
      diagnosticType
          .getMethod("setVMOption", String.class, String.class)
          .invoke(diagnostic, name, newValue);
      Object updated =
          diagnosticType.getMethod("getVMOption", String.class).invoke(diagnostic, name);
      String appliedValue =
          String.valueOf(updated.getClass().getMethod("getValue").invoke(updated));
      return mutationValues("vm.option.set", name, oldValue, appliedValue);
    } catch (Exception exception) {
      return actionFailure("VM_OPTION_SET_FAILED", exception);
    }
  }

  private static ActionResponse requestGarbageCollection(ActionRequest request) {
    ActionResponse confirmation = requireConfirmation(request, true);
    if (confirmation != null) {
      return confirmation;
    }
    long startedAt = System.currentTimeMillis();
    try {
      System.gc();
      Map<String, String> values = new TreeMap<String, String>();
      values.put("requestedAtEpochMillis", Long.toString(startedAt));
      values.put("completedAtEpochMillis", Long.toString(System.currentTimeMillis()));
      values.put(
          "boundary",
          "System.gc() is a request; the JVM may ignore it or choose its own collection behavior");
      return actionValues(values);
    } catch (RuntimeException exception) {
      return actionFailure("GC_REQUEST_FAILED", exception);
    }
  }

  private static ActionResponse requireConfirmation(
      ActionRequest request, boolean secondary) {
    boolean primary =
        "true".equals(request.getParametersOrDefault("confirmed", "false"));
    boolean second =
        !secondary
            || "true".equals(
                request.getParametersOrDefault("confirmedSecondary", "false"));
    if (primary && second) {
      return null;
    }
    return actionError(
        "CONFIRMATION_REQUIRED",
        secondary
            ? "This process-level action requires two explicit confirmations"
            : "This runtime mutation requires explicit confirmation");
  }

  private static ActionResponse staleValue(String actualValue) {
    return ActionResponse.newBuilder()
        .setStatus("FAILED")
        .setErrorCode("STALE_OLD_VALUE")
        .setMessage("The value changed after preview; refresh before retrying")
        .putValues("actualValue", trimValue(actualValue))
        .build();
  }

  private static ActionResponse mutationValues(
      String actionId, String name, String oldValue, String newValue) {
    Map<String, String> values = new TreeMap<String, String>();
    values.put("name", name);
    values.put("oldValue", trimValue(oldValue));
    values.put("newValue", trimValue(newValue));
    values.put("restoreActionId", actionId);
    values.put("restoreExpectedOldValue", trimValue(newValue));
    values.put("restoreNewValue", trimValue(oldValue));
    return actionValues(values);
  }

  private static ActionResponse actionError(String code, String message) {
    return ActionResponse.newBuilder()
        .setStatus("FAILED")
        .setErrorCode(code)
        .setMessage(message)
        .build();
  }

  private static int boundedInt(
      String value, int minimum, int maximum, String name) {
    long parsed = boundedLong(value, minimum, maximum, name);
    return (int) parsed;
  }

  private static long boundedLong(
      String value, long minimum, long maximum, String name) {
    try {
      long parsed = Long.parseLong(value);
      if (parsed < minimum || parsed > maximum) {
        throw new IllegalArgumentException(name + " is outside the allowed range");
      }
      return parsed;
    } catch (NumberFormatException exception) {
      throw new IllegalArgumentException(name + " must be an integer", exception);
    }
  }

  private static String normalizedWatchPhases(String value) {
    if (value == null || value.length() > 64) {
      throw new IllegalArgumentException("Watch phases are outside the allowed range");
    }
    Set<String> requested = new HashSet<String>();
    for (String raw : value.split(",")) {
      String phase = raw.trim().toUpperCase(Locale.ROOT);
      if (!"BEFORE".equals(phase)
          && !"RETURN".equals(phase)
          && !"THROW".equals(phase)
          && !"FINISH".equals(phase)) {
        throw new IllegalArgumentException("Unsupported watch phase: " + phase);
      }
      requested.add(phase);
    }
    if (requested.isEmpty()) {
      throw new IllegalArgumentException("At least one watch phase is required");
    }
    List<String> ordered = new ArrayList<String>(4);
    for (String phase : new String[] {"BEFORE", "RETURN", "THROW", "FINISH"}) {
      if (requested.contains(phase)) {
        ordered.add(phase);
      }
    }
    return String.join(",", ordered);
  }

  private static Capability capability(String id, String state, String reason) {
    return Capability.newBuilder().setId(id).setState(state).setReason(reason).build();
  }

  private static String classLoaderName(Class<?> type) {
    ClassLoader loader = type.getClassLoader();
    return loader == null ? "bootstrap" : loader.toString();
  }

  private static String codeSource(Class<?> type) {
    try {
      if (type.getProtectionDomain() == null
          || type.getProtectionDomain().getCodeSource() == null
          || type.getProtectionDomain().getCodeSource().getLocation() == null) {
        return "";
      }
      return type.getProtectionDomain().getCodeSource().getLocation().toString();
    } catch (SecurityException ignored) {
      return "";
    }
  }

  private static MethodDescriptor methodDescriptor(java.lang.reflect.Method method) {
    MethodDescriptor.Builder descriptor =
        MethodDescriptor.newBuilder()
            .setName(method.getName())
            .setReturnType(method.getReturnType().getTypeName())
            .setModifiers(Modifier.toString(method.getModifiers()));
    for (Class<?> parameterType : method.getParameterTypes()) {
      descriptor.addParameterTypes(parameterType.getTypeName());
    }
    for (Class<?> exceptionType : method.getExceptionTypes()) {
      descriptor.addExceptionTypes(exceptionType.getTypeName());
    }
    for (Annotation annotation : safeAnnotations(method)) {
      descriptor.addAnnotations(annotation.annotationType().getName());
    }
    return descriptor.build();
  }

  private static Annotation[] safeAnnotations(java.lang.reflect.Method method) {
    try {
      return method.getDeclaredAnnotations();
    } catch (LinkageError ignored) {
      return new Annotation[0];
    } catch (RuntimeException ignored) {
      return new Annotation[0];
    }
  }

  private static Annotation[] safeAnnotations(Class<?> type) {
    try {
      return type.getDeclaredAnnotations();
    } catch (LinkageError ignored) {
      return new Annotation[0];
    } catch (RuntimeException ignored) {
      return new Annotation[0];
    }
  }

  private static void addAnnotations(
      ClassDetailsResponse.Builder response, Annotation[] annotations) {
    for (Annotation annotation : annotations) {
      response.addAnnotations(annotation.annotationType().getName());
    }
  }

  private static ActionResponse actionValues(Map<String, String> values) {
    return ActionResponse.newBuilder()
        .setStatus("SUCCEEDED")
        .putAllValues(values)
        .build();
  }

  private static Map<String, String> indexedValues(List<String> values) {
    Map<String, String> result = new TreeMap<String, String>();
    for (int index = 0; index < values.size(); index++) {
      result.put(String.format(Locale.ROOT, "%04d", index), trimValue(values.get(index)));
    }
    return result;
  }

  private static Map<String, String> systemProperties() {
    Map<String, String> result = new TreeMap<String, String>();
    for (Map.Entry<Object, Object> entry : systemPropertySnapshot().entrySet()) {
      if (!(entry.getKey() instanceof String)
          || !(entry.getValue() instanceof String)) {
        continue;
      }
      String key = (String) entry.getKey();
      result.put(
          key,
          isSensitiveKey(key) ? "<masked>" : trimValue((String) entry.getValue()));
    }
    return result;
  }

  private ActionResponse listSystemProperties(ActionRequest request) {
    try {
      String query = request.getParametersOrDefault("query", "");
      SystemPropertyExplorer.Category category =
          SystemPropertyExplorer.Category.valueOf(
              request
                  .getParametersOrDefault("category", "ALL")
                  .toUpperCase(Locale.ROOT));
      int offset =
          boundedInt(
              request.getParametersOrDefault("offset", "0"),
              0,
              SystemPropertyExplorer.MAXIMUM_OFFSET,
              "offset");
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "50"),
              1,
              SystemPropertyExplorer.MAXIMUM_PAGE_SIZE,
              "limit");
      SystemPropertyExplorer.Result page =
          systemPropertyExplorer.list(
              systemPropertySnapshot(), query, category, offset, limit);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("propertyCount", Integer.toString(page.getPropertyCount()));
      values.put("scannedCount", Integer.toString(page.getScannedCount()));
      values.put("visibleCount", Integer.toString(page.getVisibleCount()));
      values.put("maskedCount", Integer.toString(page.getMaskedCount()));
      values.put("invalidCount", Integer.toString(page.getInvalidCount()));
      values.put("sourceTruncated", Boolean.toString(page.isSourceTruncated()));
      values.put("total", Integer.toString(page.getTotal()));
      values.put("offset", Integer.toString(page.getOffset()));
      values.put("limit", Integer.toString(page.getLimit()));
      values.put("count", Integer.toString(page.getEntries().size()));
      for (int index = 0; index < page.getEntries().size(); index++) {
        SystemPropertyExplorer.Entry entry = page.getEntries().get(index);
        String prefix = String.format(Locale.ROOT, "property.%04d.", index);
        values.put(prefix + "key", entry.getKey());
        values.put(prefix + "value", entry.getValue());
        values.put(prefix + "category", entry.getCategory().name());
        values.put(prefix + "visibility", entry.getVisibility().name());
        values.put(prefix + "valueLength", Integer.toString(entry.getValueLength()));
        values.put(prefix + "truncated", Boolean.toString(entry.isTruncated()));
        values.put(prefix + "mutable", Boolean.toString(entry.isMutable()));
      }
      return actionValues(values);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_SYSTEM_PROPERTY_QUERY", exception);
    } catch (SecurityException exception) {
      return actionFailure("SYSTEM_PROPERTY_ACCESS_DENIED", exception);
    }
  }

  private static Map<Object, Object> systemPropertySnapshot() {
    java.util.Properties properties = System.getProperties();
    synchronized (properties) {
      return new HashMap<Object, Object>(properties);
    }
  }

  private ActionResponse listEnvironment(ActionRequest request) {
    try {
      String query = request.getParametersOrDefault("query", "");
      EnvironmentExplorer.Category category =
          EnvironmentExplorer.Category.valueOf(
              request
                  .getParametersOrDefault("category", "ALL")
                  .toUpperCase(Locale.ROOT));
      int offset =
          boundedInt(
              request.getParametersOrDefault("offset", "0"),
              0,
              EnvironmentExplorer.MAXIMUM_OFFSET,
              "offset");
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "50"),
              1,
              EnvironmentExplorer.MAXIMUM_PAGE_SIZE,
              "limit");
      EnvironmentExplorer.Result page =
          environment.list(System.getenv(), query, category, offset, limit);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("environmentCount", Integer.toString(page.getEnvironmentCount()));
      values.put("visibleCount", Integer.toString(page.getVisibleCount()));
      values.put("maskedCount", Integer.toString(page.getMaskedCount()));
      values.put("invalidCount", Integer.toString(page.getInvalidCount()));
      values.put("total", Integer.toString(page.getTotal()));
      values.put("offset", Integer.toString(page.getOffset()));
      values.put("limit", Integer.toString(page.getLimit()));
      values.put("count", Integer.toString(page.getEntries().size()));
      for (int index = 0; index < page.getEntries().size(); index++) {
        EnvironmentExplorer.Entry entry = page.getEntries().get(index);
        String prefix = String.format(Locale.ROOT, "environment.%04d.", index);
        values.put(prefix + "key", entry.getKey());
        values.put(prefix + "value", entry.getValue());
        values.put(prefix + "category", entry.getCategory().name());
        values.put(prefix + "visibility", entry.getVisibility().name());
        values.put(prefix + "valueLength", Integer.toString(entry.getValueLength()));
        values.put(prefix + "truncated", Boolean.toString(entry.isTruncated()));
      }
      return actionValues(values);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_ENVIRONMENT_QUERY", exception);
    } catch (SecurityException exception) {
      return actionFailure("ENVIRONMENT_ACCESS_DENIED", exception);
    }
  }

  private static Map<String, String> environmentSummary() {
    Map<String, String> result = new TreeMap<String, String>();
    for (Map.Entry<String, String> entry : System.getenv().entrySet()) {
      String key = entry.getKey();
      String normalized = key.toUpperCase(Locale.ROOT);
      boolean safe =
          "JAVA_HOME".equals(normalized)
              || "LANG".equals(normalized)
              || "LC_ALL".equals(normalized)
              || "PATH".equals(normalized)
              || "TZ".equals(normalized);
      result.put(
          key,
          safe && !isSensitiveKey(key) ? trimValue(entry.getValue()) : "<masked>");
    }
    return result;
  }

  private static Map<String, String> memoryPools() {
    Map<String, String> result = new TreeMap<String, String>();
    for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
      String prefix = pool.getName() + ".";
      result.put(prefix + "type", pool.getType().name());
      if (pool.getUsage() != null) {
        result.put(prefix + "used", Long.toString(pool.getUsage().getUsed()));
        result.put(prefix + "committed", Long.toString(pool.getUsage().getCommitted()));
        result.put(prefix + "max", Long.toString(pool.getUsage().getMax()));
      }
    }
    return result;
  }

  private static Map<String, String> garbageCollectors() {
    Map<String, String> result = new TreeMap<String, String>();
    for (GarbageCollectorMXBean collector : ManagementFactory.getGarbageCollectorMXBeans()) {
      String prefix = collector.getName() + ".";
      result.put(prefix + "count", Long.toString(collector.getCollectionCount()));
      result.put(prefix + "timeMillis", Long.toString(collector.getCollectionTime()));
      result.put(prefix + "pools", String.join(",", collector.getMemoryPoolNames()));
    }
    return result;
  }

  private static Map<String, String> mbeanSummary() {
    Map<String, String> result = new TreeMap<String, String>();
    javax.management.MBeanServer server =
        ManagementFactory.getPlatformMBeanServer();
    result.put("total", Integer.toString(server.getMBeanCount()));
    for (String domain : server.getDomains()) {
      try {
        int count =
            server
                .queryNames(
                    new javax.management.ObjectName(domain + ":*"), null)
                .size();
        result.put("domain." + domain, Integer.toString(count));
      } catch (javax.management.MalformedObjectNameException ignored) {
        result.put("domain." + domain, "unavailable");
      }
    }
    return result;
  }

  private static Map<String, String> vmOptions() {
    Map<String, String> result = new TreeMap<String, String>();
    try {
      Class<?> diagnosticType =
          Class.forName("com.sun.management.HotSpotDiagnosticMXBean");
      @SuppressWarnings({"rawtypes", "unchecked"})
      Object diagnostic =
          ManagementFactory.getPlatformMXBean((Class) diagnosticType);
      if (diagnostic == null) {
        result.put("status", "unsupported");
        return result;
      }
      @SuppressWarnings("unchecked")
      List<Object> options =
          (List<Object>)
              diagnosticType
                  .getMethod("getDiagnosticOptions")
                  .invoke(diagnostic);
      for (Object option : options) {
        if (option == null) {
          continue;
        }
        Class<?> optionType = option.getClass();
        Object rawName = optionType.getMethod("getName").invoke(option);
        Object rawValue = optionType.getMethod("getValue").invoke(option);
        Object rawWriteable =
            optionType.getMethod("isWriteable").invoke(option);
        if (!(rawName instanceof String)
            || !(rawValue instanceof String)
            || !(rawWriteable instanceof Boolean)) {
          continue;
        }
        String name = (String) rawName;
        String value =
            VmOptionExplorer.isSensitiveName(name)
                ? "<masked>"
                : trimValue((String) rawValue);
        boolean writeable = ((Boolean) rawWriteable).booleanValue();
        Object origin = optionType.getMethod("getOrigin").invoke(option);
        String originName =
            origin instanceof Enum<?> ? ((Enum<?>) origin).name() : "OTHER";
        result.put(
            name,
            value
                + " | writeable="
                + writeable
                + " | origin="
                + originName);
      }
    } catch (Exception exception) {
      result.put("status", "unsupported");
      result.put("reason", trimValue(String.valueOf(exception.getMessage())));
    }
    return result;
  }

  private ActionResponse listVmOptions(ActionRequest request) {
    try {
      String query = request.getParametersOrDefault("query", "");
      VmOptionExplorer.Category category =
          VmOptionExplorer.Category.valueOf(
              request
                  .getParametersOrDefault("category", "ALL")
                  .toUpperCase(Locale.ROOT));
      VmOptionExplorer.Mutability mutability =
          VmOptionExplorer.Mutability.valueOf(
              request
                  .getParametersOrDefault("mutability", "ALL")
                  .toUpperCase(Locale.ROOT));
      int offset =
          boundedInt(
              request.getParametersOrDefault("offset", "0"),
              0,
              VmOptionExplorer.MAXIMUM_OFFSET,
              "offset");
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "50"),
              1,
              VmOptionExplorer.MAXIMUM_PAGE_SIZE,
              "limit");
      VmOptionExplorer.Result page =
          vmOptionExplorer.list(query, category, mutability, offset, limit);
      Map<String, String> values = new TreeMap<String, String>();
      values.put("optionCount", Integer.toString(page.getOptionCount()));
      values.put("scannedCount", Integer.toString(page.getScannedCount()));
      values.put("writeableCount", Integer.toString(page.getWriteableCount()));
      values.put("readOnlyCount", Integer.toString(page.getReadOnlyCount()));
      values.put("maskedCount", Integer.toString(page.getMaskedCount()));
      values.put("invalidCount", Integer.toString(page.getInvalidCount()));
      values.put("sourceTruncated", Boolean.toString(page.isSourceTruncated()));
      values.put("total", Integer.toString(page.getTotal()));
      values.put("offset", Integer.toString(page.getOffset()));
      values.put("limit", Integer.toString(page.getLimit()));
      values.put("count", Integer.toString(page.getEntries().size()));
      for (int index = 0; index < page.getEntries().size(); index++) {
        VmOptionExplorer.Entry entry = page.getEntries().get(index);
        String prefix = String.format(Locale.ROOT, "option.%04d.", index);
        values.put(prefix + "name", entry.getName());
        values.put(prefix + "value", entry.getValue());
        values.put(prefix + "category", entry.getCategory().name());
        values.put(prefix + "origin", entry.getOrigin());
        values.put(prefix + "visibility", entry.getVisibility().name());
        values.put(prefix + "writeable", Boolean.toString(entry.isWriteable()));
        values.put(prefix + "valueLength", Integer.toString(entry.getValueLength()));
        values.put(prefix + "truncated", Boolean.toString(entry.isTruncated()));
        values.put(prefix + "mutable", Boolean.toString(entry.isMutable()));
      }
      return actionValues(values);
    } catch (UnsupportedOperationException exception) {
      return actionFailure("VM_OPTIONS_UNSUPPORTED", exception);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_VM_OPTION_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("VM_OPTION_QUERY_FAILED", exception);
    }
  }

  private static Map<String, String> loggingSummary() {
    Map<String, String> result = new TreeMap<String, String>();
    LogManager manager = LogManager.getLogManager();
    Enumeration<String> names = manager.getLoggerNames();
    while (names.hasMoreElements()) {
      String name = names.nextElement();
      Logger logger = manager.getLogger(name);
      if (logger != null) {
        result.put(
            name.isEmpty() ? "<root>" : name,
            logger.getLevel() == null
                ? "<inherited>"
                : logger.getLevel().getName());
      }
    }
    return result;
  }

  private ActionResponse inspectClassLoaderMetaspace(ActionRequest request) {
    if (!classLoaderMetaspace.isAvailable()) {
      return actionError(
          "CLASSLOADER_METASPACE_UNSUPPORTED",
          classLoaderMetaspace.unavailableReason());
    }
    try {
      int durationMillis =
          boundedInt(
              request.getParametersOrDefault("durationMillis", "1000"),
              ClassLoaderMetaspaceInspector.MINIMUM_DURATION_MILLIS,
              ClassLoaderMetaspaceInspector.MAXIMUM_DURATION_MILLIS,
              "durationMillis");
      int periodMillis =
          boundedInt(
              request.getParametersOrDefault("periodMillis", "250"),
              ClassLoaderMetaspaceInspector.MINIMUM_PERIOD_MILLIS,
              ClassLoaderMetaspaceInspector.MAXIMUM_PERIOD_MILLIS,
              "periodMillis");
      int limit =
          boundedInt(
              request.getParametersOrDefault("limit", "50"),
              1,
              ClassLoaderMetaspaceInspector.MAXIMUM_ROWS,
              "limit");
      ClassLoaderMetaspaceInspector.Result sample =
          classLoaderMetaspace.inspect(durationMillis, periodMillis, limit);
      Map<String, String> values = new TreeMap<String, String>();
      values.put(
          "startedAtEpochMillis",
          Long.toString(sample.getStartedAtEpochMillis()));
      values.put(
          "completedAtEpochMillis",
          Long.toString(sample.getCompletedAtEpochMillis()));
      values.put("durationMillis", Integer.toString(sample.getDurationMillis()));
      values.put("periodMillis", Integer.toString(sample.getPeriodMillis()));
      values.put("eventCount", Integer.toString(sample.getEventCount()));
      values.put("totalLoaders", Integer.toString(sample.getTotalLoaders()));
      values.put("count", Integer.toString(sample.getRows().size()));
      values.put("truncated", Boolean.toString(sample.isTruncated()));
      values.put("totalClassCount", Long.toString(sample.getTotalClassCount()));
      values.put("totalChunkSize", Long.toString(sample.getTotalChunkSize()));
      values.put("totalBlockSize", Long.toString(sample.getTotalBlockSize()));
      values.put(
          "totalHiddenClassCount",
          Long.toString(sample.getTotalHiddenClassCount()));
      values.put(
          "totalHiddenChunkSize",
          Long.toString(sample.getTotalHiddenChunkSize()));
      values.put(
          "totalHiddenBlockSize",
          Long.toString(sample.getTotalHiddenBlockSize()));
      for (int index = 0; index < sample.getRows().size(); index++) {
        ClassLoaderMetaspaceInspector.Row row = sample.getRows().get(index);
        String prefix = String.format(Locale.ROOT, "loader.%04d.", index);
        values.put(prefix + "id", trimValue(row.getId()));
        values.put(prefix + "name", trimValue(row.getName()));
        values.put(prefix + "type", trimValue(row.getType()));
        values.put(prefix + "parentId", trimValue(row.getParentId()));
        values.put(prefix + "parentName", trimValue(row.getParentName()));
        values.put(prefix + "classCount", Long.toString(row.getClassCount()));
        values.put(prefix + "chunkSize", Long.toString(row.getChunkSize()));
        values.put(prefix + "blockSize", Long.toString(row.getBlockSize()));
        values.put(
            prefix + "hiddenClassCount",
            Long.toString(row.getHiddenClassCount()));
        values.put(
            prefix + "hiddenChunkSize",
            Long.toString(row.getHiddenChunkSize()));
        values.put(
            prefix + "hiddenBlockSize",
            Long.toString(row.getHiddenBlockSize()));
        values.put(
            prefix + "sampledAtEpochMillis",
            Long.toString(row.getSampledAtEpochMillis()));
      }
      return actionValues(values);
    } catch (IllegalArgumentException exception) {
      return actionFailure("INVALID_CLASSLOADER_METASPACE_QUERY", exception);
    } catch (Exception exception) {
      return actionFailure("CLASSLOADER_METASPACE_FAILED", exception);
    }
  }

  private Map<String, String> classLoaderSummary() {
    Map<ClassLoader, LoaderSummary> summaries =
        new IdentityHashMap<ClassLoader, LoaderSummary>();
    int bootstrapClasses = 0;
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      ClassLoader loader = type.getClassLoader();
      if (loader == null) {
        bootstrapClasses++;
        continue;
      }
      LoaderSummary summary = summaries.get(loader);
      if (summary == null) {
        summary = new LoaderSummary(loader);
        summaries.put(loader, summary);
      }
      summary.loadedClasses++;
      ClassLoader parent = loader.getParent();
      while (parent != null) {
        if (!summaries.containsKey(parent)) {
          summaries.put(parent, new LoaderSummary(parent));
        }
        parent = parent.getParent();
      }
    }

    List<LoaderSummary> ordered =
        new ArrayList<LoaderSummary>(summaries.values());
    ordered.sort(Comparator.comparing(LoaderSummary::identity));
    Map<String, String> result = new TreeMap<String, String>();
    result.put("bootstrap.classes", Integer.toString(bootstrapClasses));
    result.put("total", Integer.toString(ordered.size() + 1));
    for (int index = 0; index < ordered.size(); index++) {
      LoaderSummary summary = ordered.get(index);
      String prefix = String.format(Locale.ROOT, "loader.%04d.", index);
      result.put(prefix + "identity", summary.identity());
      result.put(prefix + "type", summary.loader.getClass().getName());
      result.put(
          prefix + "parent",
          summary.loader.getParent() == null
              ? "bootstrap"
              : loaderIdentity(summary.loader.getParent()));
      result.put(prefix + "loadedClasses", Integer.toString(summary.loadedClasses));
      List<String> urls = loaderUrls(summary.loader);
      result.put(prefix + "urlCount", Integer.toString(urls.size()));
      for (int urlIndex = 0; urlIndex < urls.size(); urlIndex++) {
        result.put(
            prefix + String.format(Locale.ROOT, "url.%04d", urlIndex),
            trimValue(urls.get(urlIndex)));
      }
    }
    return result;
  }

  private static List<String> loaderUrls(ClassLoader loader) {
    if (!(loader instanceof URLClassLoader)) {
      return Collections.emptyList();
    }
    URL[] urls = ((URLClassLoader) loader).getURLs();
    List<String> result = new ArrayList<String>(urls.length);
    for (URL url : urls) {
      result.add(url.toString());
    }
    return result;
  }

  private static String loaderIdentity(ClassLoader loader) {
    return loader.getClass().getName()
        + "@"
        + Integer.toHexString(System.identityHashCode(loader));
  }

  private static final class ReplaySnapshotContext {
    private final long snapshotId;
    private final Object receiver;
    private final SnapshotArchive.Snapshot snapshot;

    private ReplaySnapshotContext(
        long snapshotId,
        Object receiver,
        SnapshotArchive.Snapshot snapshot) {
      this.snapshotId = snapshotId;
      this.receiver = receiver;
      this.snapshot = snapshot;
    }

    private static ReplaySnapshotContext directStatic() {
      return new ReplaySnapshotContext(0L, null, null);
    }
  }

  private static final class LoaderSummary {
    private final ClassLoader loader;
    private int loadedClasses;

    private LoaderSummary(ClassLoader loader) {
      this.loader = loader;
    }

    private String identity() {
      return loaderIdentity(loader);
    }
  }

  private static final class ClassChangeSetInput {
    private final List<Class<?>> targets;
    private final List<String> encodedBytecodes;

    private ClassChangeSetInput(
        List<Class<?>> targets,
        List<String> encodedBytecodes) {
      this.targets =
          Collections.unmodifiableList(
              new ArrayList<Class<?>>(targets));
      this.encodedBytecodes =
          Collections.unmodifiableList(
              new ArrayList<String>(encodedBytecodes));
    }
  }

  private static final class ActiveTaskSummary {
    private final String kind;
    private final String taskId;
    private final String state;
    private final String title;
    private final String detail;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final long current;
    private final long maximum;
    private final long dropped;

    private ActiveTaskSummary(
        String kind,
        String taskId,
        String state,
        String title,
        String detail,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        long current,
        long maximum,
        long dropped) {
      this.kind = kind;
      this.taskId = taskId;
      this.state = state;
      this.title = title;
      this.detail = detail;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.current = current;
      this.maximum = maximum;
      this.dropped = dropped;
    }

    private long getStartedAtEpochMillis() {
      return startedAtEpochMillis;
    }

    private String getTaskId() {
      return taskId;
    }
  }

  private static final class SessionResetState {
    private final List<ActiveTaskSummary> tasks;
    private final List<ClassRedefinitionController.ResetSnapshot> classes;
    private final List<RetransformLifecycle.Snapshot> failedRetransforms;
    private final String fingerprint;

    private SessionResetState(
        List<ActiveTaskSummary> tasks,
        List<ClassRedefinitionController.ResetSnapshot> classes,
        List<RetransformLifecycle.Snapshot> failedRetransforms,
        String fingerprint) {
      this.tasks =
          Collections.unmodifiableList(
              new ArrayList<ActiveTaskSummary>(tasks));
      this.classes =
          Collections.unmodifiableList(
              new ArrayList<ClassRedefinitionController.ResetSnapshot>(
                  classes));
      this.failedRetransforms =
          Collections.unmodifiableList(
              new ArrayList<RetransformLifecycle.Snapshot>(
                  failedRetransforms));
      this.fingerprint = fingerprint;
    }
  }

  private static boolean isSensitiveKey(String key) {
    return SystemPropertyExplorer.isSensitiveKey(key);
  }

  private static String trimValue(String value) {
    if (value.length() <= MAXIMUM_PROPERTY_VALUE_LENGTH) {
      return value;
    }
    return value.substring(0, MAXIMUM_PROPERTY_VALUE_LENGTH) + "…";
  }

  private static int pageSize(int requested) {
    return requested <= 0
        ? DEFAULT_PAGE_SIZE
        : Math.min(MAXIMUM_PAGE_SIZE, requested);
  }

  private static long currentPid() {
    String name = ManagementFactory.getRuntimeMXBean().getName();
    int separator = name.indexOf('@');
    String value = separator > 0 ? name.substring(0, separator) : name;
    try {
      return Long.parseLong(value);
    } catch (NumberFormatException ignored) {
      return -1L;
    }
  }

  private static Map<Long, Thread> liveThreadsById() {
    Map<Long, Thread> result = new HashMap<Long, Thread>();
    for (Thread thread : Thread.getAllStackTraces().keySet()) {
      result.put(thread.getId(), thread);
    }
    return result;
  }

}
