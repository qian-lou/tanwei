package dev.tanwei.agent;

import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Array;
import java.lang.reflect.Method;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.ForkJoinTask;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.commons.AdviceAdapter;

final class ThreadPoolLatencyController implements AutoCloseable {
  private static final long MINIMUM_DURATION_MILLIS = 10_000L;
  private static final long MAXIMUM_DURATION_MILLIS = 300_000L;
  private static final int MINIMUM_TRACKED_TASKS = 128;
  private static final int MAXIMUM_TRACKED_TASKS = 4_096;
  private static final int MAXIMUM_TASK_TYPES = 32;
  private static final String QUEUE_AND_RUN = "QUEUE_AND_RUN";
  private static final String SCHEDULE_AND_RUN = "SCHEDULE_AND_RUN";
  private static final String RUN_ONLY = "RUN_ONLY";
  private static final Type BRIDGE_TYPE =
      Type.getObjectType(
          "dev/tanwei/bootstrap/ThreadPoolLatencyBridge");
  private static final org.objectweb.asm.commons.Method SUBMIT_METHOD =
      new org.objectweb.asm.commons.Method(
          "submit", "(Ljava/lang/Object;Ljava/lang/Object;)V");
  private static final org.objectweb.asm.commons.Method SCHEDULE_METHOD =
      new org.objectweb.asm.commons.Method(
          "schedule", "(Ljava/lang/Object;Ljava/lang/Object;)V");
  private static final org.objectweb.asm.commons.Method REJECT_METHOD =
      new org.objectweb.asm.commons.Method(
          "reject", "(Ljava/lang/Object;Ljava/lang/Object;)V");
  private static final org.objectweb.asm.commons.Method START_METHOD =
      new org.objectweb.asm.commons.Method(
          "start", "(Ljava/lang/Object;Ljava/lang/Object;)V");
  private static final org.objectweb.asm.commons.Method START_FORK_JOIN_METHOD =
      new org.objectweb.asm.commons.Method(
          "startForkJoin", "(Ljava/lang/Object;)V");
  private static final org.objectweb.asm.commons.Method COMPLETE_METHOD =
      new org.objectweb.asm.commons.Method(
          "complete", "(Ljava/lang/Throwable;)V");

  private final Instrumentation instrumentation;
  private final RetransformLifecycle retransforms;
  private final HeapInstanceController heapInstances;
  private final ScheduledExecutorService scheduler;
  private final AtomicBoolean closed = new AtomicBoolean();
  private Method registerBridge;
  private Method unregisterBridge;
  private Method snapshotBridge;
  private Session session;

  ThreadPoolLatencyController(
      Instrumentation instrumentation,
      HeapInstanceController heapInstances,
      ScheduledExecutorService scheduler,
      RetransformLifecycle retransforms) {
    if (instrumentation == null
        || heapInstances == null
        || scheduler == null
        || retransforms == null) {
      throw new IllegalArgumentException(
          "Thread-pool latency dependencies are required");
    }
    this.instrumentation = instrumentation;
    this.heapInstances = heapInstances;
    this.scheduler = scheduler;
    this.retransforms = retransforms;
  }

  boolean isAvailable() {
    return instrumentation.isRetransformClassesSupported()
        && (instrumentation.isModifiableClass(ThreadPoolExecutor.class)
            || instrumentation.isModifiableClass(ForkJoinTask.class))
        && heapInstances.isPotentiallyAvailable();
  }

  synchronized StartResult start(
      String poolIdentity,
      String poolClassName,
      long durationMillis,
      int maximumTrackedTasks)
      throws Exception {
    if (closed.get()) {
      throw new IllegalStateException(
          "Thread-pool latency controller is closed");
    }
    if (!isAvailable()) {
      throw new UnsupportedOperationException(
          "JVM does not support thread-pool execution attribution");
    }
    if (durationMillis < MINIMUM_DURATION_MILLIS
        || durationMillis > MAXIMUM_DURATION_MILLIS) {
      throw new IllegalArgumentException(
          "Latency duration must be between 10 and 300 seconds");
    }
    if (maximumTrackedTasks < MINIMUM_TRACKED_TASKS
        || maximumTrackedTasks > MAXIMUM_TRACKED_TASKS) {
      throw new IllegalArgumentException(
          "Tracked task limit must be between 128 and 4096");
    }
    if (session != null && "RUNNING".equals(session.state)) {
      throw new IllegalStateException(
          "A ThreadPoolExecutor latency task is already running");
    }

    PoolPlan plan = poolPlan(poolClassName);
    Object pool =
        heapInstances.resolveExactThreadPool(
            poolIdentity, poolClassName);
    ensureBridgeInstalled();
    String taskId = UUID.randomUUID().toString();
    ThreadPoolLatencyTransformer transformer =
        new ThreadPoolLatencyTransformer(plan.transformKind);
    long startedAtEpochMillis = System.currentTimeMillis();
    registerBridge.invoke(
        null,
        taskId,
        pool,
        plan.attributionMode,
        Integer.valueOf(maximumTrackedTasks),
        Integer.valueOf(MAXIMUM_TASK_TYPES));
    RetransformLifecycle.Lease lease = null;
    try {
      lease =
          retransforms.activate(
              "THREAD_POOL_LATENCY:" + taskId,
              "THREAD_POOL_LATENCY",
              transformer,
              plan.instrumentedClasses);
      transformer.assertComplete();
      Session created =
          new Session(
              taskId,
              poolIdentity,
              poolClassName,
              plan.attributionMode,
              maximumTrackedTasks,
              startedAtEpochMillis,
              durationMillis,
              lease);
      created.deadlineFuture =
          scheduler.schedule(
              () -> finishQuietly(taskId, "TIMED_OUT"),
              durationMillis,
              TimeUnit.MILLISECONDS);
      session = created;
      return created.startResult();
    } catch (Exception failure) {
      if (lease != null) {
        try {
          lease.rollback();
        } catch (Exception rollbackFailure) {
          failure.addSuppressed(rollbackFailure);
        }
      }
      try {
        unregisterBridge.invoke(null, taskId);
      } catch (Exception cleanupFailure) {
        failure.addSuppressed(cleanupFailure);
      }
      throw failure;
    }
  }

  synchronized Snapshot snapshot(String taskId) throws Exception {
    if (session == null || !session.taskId.equals(taskId)) {
      return Snapshot.unknown(taskId);
    }
    if (session.finalSnapshot != null) {
      return session.finalSnapshot;
    }
    Snapshot snapshot = readSnapshot(session);
    return snapshot;
  }

  synchronized Snapshot stop(String taskId) throws Exception {
    if (session == null || !session.taskId.equals(taskId)) {
      return Snapshot.unknown(taskId);
    }
    finishLocked(session, "CANCELLED");
    return session.finalSnapshot;
  }

  synchronized String cancel(String taskId) {
    if (session == null || !session.taskId.equals(taskId)) {
      return "UNKNOWN";
    }
    finishQuietly(taskId, "CANCELLED");
    return session.state;
  }

  synchronized List<TaskSnapshot> activeTasks() {
    if (session == null || !"RUNNING".equals(session.state)) {
      return Collections.emptyList();
    }
    long completed = 0L;
    long dropped = 0L;
    try {
      Snapshot current = readSnapshot(session);
      completed = current.completed;
      dropped = current.droppedSubmissions;
    } catch (Exception ignored) {
      // Ownership remains visible if a metrics read is temporarily unavailable.
    }
    return Collections.singletonList(
        new TaskSnapshot(
            session.taskId,
            session.poolIdentity,
            session.poolClassName,
            session.state,
            session.startedAtEpochMillis,
            session.deadlineEpochMillis,
            completed,
            session.maximumTrackedTasks,
            dropped));
  }

  @Override
  public synchronized void close() {
    if (!closed.compareAndSet(false, true)) {
      return;
    }
    if (session != null && "RUNNING".equals(session.state)) {
      finishQuietly(session.taskId, "CANCELLED");
    }
  }

  private void finishQuietly(String taskId, String terminalState) {
    synchronized (this) {
      if (session == null
          || !session.taskId.equals(taskId)
          || !"RUNNING".equals(session.state)) {
        return;
      }
      try {
        finishLocked(session, terminalState);
      } catch (Exception failure) {
        session.state = "FAILED";
        session.error =
            failure.getMessage() == null
                ? failure.getClass().getSimpleName()
                : failure.getMessage();
      }
    }
  }

  private void finishLocked(Session current, String terminalState)
      throws Exception {
    if (!"RUNNING".equals(current.state)) {
      return;
    }
    Exception failure = null;
    try {
      current.finalSnapshot = readSnapshot(current, terminalState, "");
    } catch (Exception snapshotFailure) {
      failure = snapshotFailure;
    }
    try {
      unregisterBridge.invoke(null, current.taskId);
    } catch (Exception unregisterFailure) {
      if (failure == null) {
        failure = unregisterFailure;
      }
    }
    try {
      current.lease.rollback();
    } catch (Exception restoreFailure) {
      if (failure == null) {
        failure = restoreFailure;
      }
    }
    if (current.deadlineFuture != null) {
      current.deadlineFuture.cancel(false);
    }
    if (failure != null) {
      current.state = "FAILED";
      current.error =
          failure.getMessage() == null
              ? failure.getClass().getSimpleName()
              : failure.getMessage();
      Snapshot baseline =
          current.finalSnapshot == null
              ? Snapshot.empty(current, "FAILED", current.error)
              : current.finalSnapshot;
      current.finalSnapshot = baseline.withState("FAILED", current.error);
      throw failure;
    }
    current.state = terminalState;
    current.finalSnapshot =
        current.finalSnapshot == null
            ? Snapshot.empty(current, terminalState, "")
            : current.finalSnapshot.withState(terminalState, "");
  }

  private Snapshot readSnapshot(Session current) throws Exception {
    return readSnapshot(current, current.state, current.error);
  }

  private Snapshot readSnapshot(
      Session current, String state, String error) throws Exception {
    Object bridgeSnapshot =
        snapshotBridge.invoke(null, current.taskId);
    Class<?> type = bridgeSnapshot.getClass();
    Object typeArray =
        type.getMethod("getTaskTypes").invoke(bridgeSnapshot);
    int typeCount = Math.min(MAXIMUM_TASK_TYPES + 1, Array.getLength(typeArray));
    List<TypeSnapshot> taskTypes =
        new ArrayList<TypeSnapshot>(typeCount);
    for (int index = 0; index < typeCount; index++) {
      Object value = Array.get(typeArray, index);
      Class<?> valueType = value.getClass();
      taskTypes.add(
          new TypeSnapshot(
              bridgeString(valueType, value, "getClassName"),
              bridgeLong(valueType, value, "getStarted"),
              bridgeLong(valueType, value, "getCompleted"),
              bridgeLong(valueType, value, "getFailures"),
              bridgeLong(valueType, value, "getWaitObserved"),
              bridgeLong(valueType, value, "getWaitDurationNanos"),
              bridgeLong(valueType, value, "getWaitMaximumNanos"),
              bridgeLong(valueType, value, "getScheduleDelayObserved"),
              bridgeLong(valueType, value, "getScheduleDelayDurationNanos"),
              bridgeLong(valueType, value, "getScheduleDelayMaximumNanos"),
              bridgeLong(valueType, value, "getStartLatenessObserved"),
              bridgeLong(valueType, value, "getStartLatenessDurationNanos"),
              bridgeLong(valueType, value, "getStartLatenessMaximumNanos"),
              bridgeLong(valueType, value, "getRunDurationNanos"),
              bridgeLong(valueType, value, "getRunMaximumNanos")));
    }
    Collections.sort(
        taskTypes,
        Comparator.comparingLong(TypeSnapshot::getRunDurationNanos)
            .reversed()
            .thenComparing(
                Comparator.comparingLong(
                        TypeSnapshot::getWaitDurationNanos)
                    .reversed())
            .thenComparing(TypeSnapshot::getClassName));
    return new Snapshot(
        current.taskId,
        state,
        error,
        current.poolIdentity,
        current.poolClassName,
        current.attributionMode,
        current.startedAtEpochMillis,
        current.deadlineEpochMillis,
        current.maximumTrackedTasks,
        bridgeLong(type, bridgeSnapshot, "getSubmitted"),
        bridgeLong(type, bridgeSnapshot, "getStarted"),
        bridgeLong(type, bridgeSnapshot, "getCompleted"),
        bridgeLong(type, bridgeSnapshot, "getFailures"),
        bridgeLong(type, bridgeSnapshot, "getRejected"),
        bridgeLong(type, bridgeSnapshot, "getUnmatchedStarts"),
        bridgeLong(type, bridgeSnapshot, "getDroppedSubmissions"),
        bridgeLong(type, bridgeSnapshot, "getOrphanedSubmissions"),
        safeInt(bridgeLong(type, bridgeSnapshot, "getPendingTracked")),
        safeInt(bridgeLong(type, bridgeSnapshot, "getInFlight")),
        bridgeLong(type, bridgeSnapshot, "getWaitObserved"),
        bridgeLong(type, bridgeSnapshot, "getWaitDurationNanos"),
        bridgeLong(type, bridgeSnapshot, "getWaitMaximumNanos"),
        bridgeLong(type, bridgeSnapshot, "getWaitP95Nanos"),
        bridgeLong(type, bridgeSnapshot, "getWaitP99Nanos"),
        bridgeLong(type, bridgeSnapshot, "getScheduleDelayObserved"),
        bridgeLong(type, bridgeSnapshot, "getScheduleDelayDurationNanos"),
        bridgeLong(type, bridgeSnapshot, "getScheduleDelayMaximumNanos"),
        bridgeLong(type, bridgeSnapshot, "getScheduleDelayP95Nanos"),
        bridgeLong(type, bridgeSnapshot, "getScheduleDelayP99Nanos"),
        bridgeLong(type, bridgeSnapshot, "getStartLatenessObserved"),
        bridgeLong(type, bridgeSnapshot, "getStartLatenessDurationNanos"),
        bridgeLong(type, bridgeSnapshot, "getStartLatenessMaximumNanos"),
        bridgeLong(type, bridgeSnapshot, "getStartLatenessP95Nanos"),
        bridgeLong(type, bridgeSnapshot, "getStartLatenessP99Nanos"),
        bridgeLong(type, bridgeSnapshot, "getRunDurationNanos"),
        bridgeLong(type, bridgeSnapshot, "getRunMaximumNanos"),
        bridgeLong(type, bridgeSnapshot, "getRunP95Nanos"),
        bridgeLong(type, bridgeSnapshot, "getRunP99Nanos"),
        taskTypes);
  }

  private void ensureBridgeInstalled() throws Exception {
    if (registerBridge != null) {
      return;
    }
    Class<?> bootstrap =
        Class.forName(
            "dev.tanwei.bootstrap.TanweiBootstrap",
            true,
            ClassLoader.getSystemClassLoader());
    bootstrap
        .getMethod("installBootstrapBridge", Instrumentation.class)
        .invoke(null, instrumentation);
    Class<?> bridge =
        Class.forName(
            "dev.tanwei.bootstrap.ThreadPoolLatencyBridge", true, null);
    registerBridge =
        bridge.getMethod(
            "register",
            String.class,
            Object.class,
            String.class,
            int.class,
            int.class);
    unregisterBridge = bridge.getMethod("unregister", String.class);
    snapshotBridge = bridge.getMethod("snapshot", String.class);
  }

  private PoolPlan poolPlan(String poolClassName) {
    if (ThreadPoolExecutor.class.getName().equals(poolClassName)) {
      return checkedPlan(
          QUEUE_AND_RUN,
          TransformKind.THREAD_POOL_QUEUE_AND_RUN,
          ThreadPoolExecutor.class);
    }
    if (ScheduledThreadPoolExecutor.class.getName().equals(poolClassName)) {
      return checkedPlan(
          SCHEDULE_AND_RUN,
          TransformKind.THREAD_POOL_SCHEDULE_AND_RUN,
          ScheduledThreadPoolExecutor.class,
          ThreadPoolExecutor.class);
    }
    if (ForkJoinPool.class.getName().equals(poolClassName)) {
      return checkedPlan(
          RUN_ONLY,
          TransformKind.FORK_JOIN_RUN_ONLY,
          ForkJoinTask.class);
    }
    throw new IllegalArgumentException("Thread-pool class is unsupported");
  }

  private PoolPlan checkedPlan(
      String attributionMode,
      TransformKind transformKind,
      Class<?>... instrumentedClasses) {
    if (instrumentedClasses == null || instrumentedClasses.length == 0) {
      throw new IllegalArgumentException("Instrumented classes are required");
    }
    for (Class<?> instrumentedClass : instrumentedClasses) {
      if (instrumentedClass == null
          || !instrumentation.isModifiableClass(instrumentedClass)) {
        throw new UnsupportedOperationException(
            "JVM cannot instrument "
                + (instrumentedClass == null
                    ? "an unknown class"
                    : instrumentedClass.getName()));
      }
    }
    return new PoolPlan(
        attributionMode,
        transformKind,
        instrumentedClasses);
  }

  private static long bridgeLong(
      Class<?> type, Object value, String methodName) throws Exception {
    Object result = type.getMethod(methodName).invoke(value);
    return result instanceof Number
        ? Math.max(0L, ((Number) result).longValue())
        : 0L;
  }

  private static String bridgeString(
      Class<?> type, Object value, String methodName) throws Exception {
    Object result = type.getMethod(methodName).invoke(value);
    return result instanceof String ? (String) result : "";
  }

  private static int safeInt(long value) {
    return value >= Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) value;
  }

  static final class StartResult {
    private final String taskId;
    private final String poolIdentity;
    private final String poolClassName;
    private final String attributionMode;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final int maximumTrackedTasks;

    private StartResult(
        String taskId,
        String poolIdentity,
        String poolClassName,
        String attributionMode,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        int maximumTrackedTasks) {
      this.taskId = taskId;
      this.poolIdentity = poolIdentity;
      this.poolClassName = poolClassName;
      this.attributionMode = attributionMode;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.maximumTrackedTasks = maximumTrackedTasks;
    }

    String getTaskId() { return taskId; }
    String getPoolIdentity() { return poolIdentity; }
    String getPoolClassName() { return poolClassName; }
    String getAttributionMode() { return attributionMode; }
    long getStartedAtEpochMillis() { return startedAtEpochMillis; }
    long getDeadlineEpochMillis() { return deadlineEpochMillis; }
    int getMaximumTrackedTasks() { return maximumTrackedTasks; }
  }

  static final class Snapshot {
    private final String taskId;
    private final String state;
    private final String error;
    private final String poolIdentity;
    private final String poolClassName;
    private final String attributionMode;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final int maximumTrackedTasks;
    private final long submitted;
    private final long started;
    private final long completed;
    private final long failures;
    private final long rejected;
    private final long unmatchedStarts;
    private final long droppedSubmissions;
    private final long orphanedSubmissions;
    private final int pendingTracked;
    private final int inFlight;
    private final long waitObserved;
    private final long waitDurationNanos;
    private final long waitMaximumNanos;
    private final long waitP95Nanos;
    private final long waitP99Nanos;
    private final long scheduleDelayObserved;
    private final long scheduleDelayDurationNanos;
    private final long scheduleDelayMaximumNanos;
    private final long scheduleDelayP95Nanos;
    private final long scheduleDelayP99Nanos;
    private final long startLatenessObserved;
    private final long startLatenessDurationNanos;
    private final long startLatenessMaximumNanos;
    private final long startLatenessP95Nanos;
    private final long startLatenessP99Nanos;
    private final long runDurationNanos;
    private final long runMaximumNanos;
    private final long runP95Nanos;
    private final long runP99Nanos;
    private final List<TypeSnapshot> taskTypes;

    private Snapshot(
        String taskId,
        String state,
        String error,
        String poolIdentity,
        String poolClassName,
        String attributionMode,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        int maximumTrackedTasks,
        long submitted,
        long started,
        long completed,
        long failures,
        long rejected,
        long unmatchedStarts,
        long droppedSubmissions,
        long orphanedSubmissions,
        int pendingTracked,
        int inFlight,
        long waitObserved,
        long waitDurationNanos,
        long waitMaximumNanos,
        long waitP95Nanos,
        long waitP99Nanos,
        long scheduleDelayObserved,
        long scheduleDelayDurationNanos,
        long scheduleDelayMaximumNanos,
        long scheduleDelayP95Nanos,
        long scheduleDelayP99Nanos,
        long startLatenessObserved,
        long startLatenessDurationNanos,
        long startLatenessMaximumNanos,
        long startLatenessP95Nanos,
        long startLatenessP99Nanos,
        long runDurationNanos,
        long runMaximumNanos,
        long runP95Nanos,
        long runP99Nanos,
        List<TypeSnapshot> taskTypes) {
      this.taskId = taskId;
      this.state = state;
      this.error = error;
      this.poolIdentity = poolIdentity;
      this.poolClassName = poolClassName;
      this.attributionMode = attributionMode;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.maximumTrackedTasks = maximumTrackedTasks;
      this.submitted = submitted;
      this.started = started;
      this.completed = completed;
      this.failures = failures;
      this.rejected = rejected;
      this.unmatchedStarts = unmatchedStarts;
      this.droppedSubmissions = droppedSubmissions;
      this.orphanedSubmissions = orphanedSubmissions;
      this.pendingTracked = pendingTracked;
      this.inFlight = inFlight;
      this.waitObserved = waitObserved;
      this.waitDurationNanos = waitDurationNanos;
      this.waitMaximumNanos = waitMaximumNanos;
      this.waitP95Nanos = waitP95Nanos;
      this.waitP99Nanos = waitP99Nanos;
      this.scheduleDelayObserved = scheduleDelayObserved;
      this.scheduleDelayDurationNanos = scheduleDelayDurationNanos;
      this.scheduleDelayMaximumNanos = scheduleDelayMaximumNanos;
      this.scheduleDelayP95Nanos = scheduleDelayP95Nanos;
      this.scheduleDelayP99Nanos = scheduleDelayP99Nanos;
      this.startLatenessObserved = startLatenessObserved;
      this.startLatenessDurationNanos = startLatenessDurationNanos;
      this.startLatenessMaximumNanos = startLatenessMaximumNanos;
      this.startLatenessP95Nanos = startLatenessP95Nanos;
      this.startLatenessP99Nanos = startLatenessP99Nanos;
      this.runDurationNanos = runDurationNanos;
      this.runMaximumNanos = runMaximumNanos;
      this.runP95Nanos = runP95Nanos;
      this.runP99Nanos = runP99Nanos;
      this.taskTypes =
          Collections.unmodifiableList(
              new ArrayList<TypeSnapshot>(taskTypes));
    }

    static Snapshot unknown(String taskId) {
      return new Snapshot(
          taskId == null ? "" : taskId,
          "UNKNOWN",
          "",
          "",
          "",
          "",
          0L,
          0L,
          0,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0,
          0,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          0L,
          Collections.<TypeSnapshot>emptyList());
    }

    static Snapshot empty(Session session, String state, String error) {
      Snapshot empty = unknown(session.taskId);
      return new Snapshot(
          session.taskId,
          state,
          error,
          session.poolIdentity,
          session.poolClassName,
          session.attributionMode,
          session.startedAtEpochMillis,
          session.deadlineEpochMillis,
          session.maximumTrackedTasks,
          empty.submitted,
          empty.started,
          empty.completed,
          empty.failures,
          empty.rejected,
          empty.unmatchedStarts,
          empty.droppedSubmissions,
          empty.orphanedSubmissions,
          empty.pendingTracked,
          empty.inFlight,
          empty.waitObserved,
          empty.waitDurationNanos,
          empty.waitMaximumNanos,
          empty.waitP95Nanos,
          empty.waitP99Nanos,
          empty.scheduleDelayObserved,
          empty.scheduleDelayDurationNanos,
          empty.scheduleDelayMaximumNanos,
          empty.scheduleDelayP95Nanos,
          empty.scheduleDelayP99Nanos,
          empty.startLatenessObserved,
          empty.startLatenessDurationNanos,
          empty.startLatenessMaximumNanos,
          empty.startLatenessP95Nanos,
          empty.startLatenessP99Nanos,
          empty.runDurationNanos,
          empty.runMaximumNanos,
          empty.runP95Nanos,
          empty.runP99Nanos,
          empty.taskTypes);
    }

    Snapshot withState(String nextState, String nextError) {
      return new Snapshot(
          taskId,
          nextState,
          nextError,
          poolIdentity,
          poolClassName,
          attributionMode,
          startedAtEpochMillis,
          deadlineEpochMillis,
          maximumTrackedTasks,
          submitted,
          started,
          completed,
          failures,
          rejected,
          unmatchedStarts,
          droppedSubmissions,
          orphanedSubmissions,
          pendingTracked,
          inFlight,
          waitObserved,
          waitDurationNanos,
          waitMaximumNanos,
          waitP95Nanos,
          waitP99Nanos,
          scheduleDelayObserved,
          scheduleDelayDurationNanos,
          scheduleDelayMaximumNanos,
          scheduleDelayP95Nanos,
          scheduleDelayP99Nanos,
          startLatenessObserved,
          startLatenessDurationNanos,
          startLatenessMaximumNanos,
          startLatenessP95Nanos,
          startLatenessP99Nanos,
          runDurationNanos,
          runMaximumNanos,
          runP95Nanos,
          runP99Nanos,
          taskTypes);
    }

    String getTaskId() { return taskId; }
    String getState() { return state; }
    String getError() { return error; }
    String getPoolIdentity() { return poolIdentity; }
    String getPoolClassName() { return poolClassName; }
    String getAttributionMode() { return attributionMode; }
    long getStartedAtEpochMillis() { return startedAtEpochMillis; }
    long getDeadlineEpochMillis() { return deadlineEpochMillis; }
    int getMaximumTrackedTasks() { return maximumTrackedTasks; }
    long getSubmitted() { return submitted; }
    long getStarted() { return started; }
    long getCompleted() { return completed; }
    long getFailures() { return failures; }
    long getRejected() { return rejected; }
    long getUnmatchedStarts() { return unmatchedStarts; }
    long getDroppedSubmissions() { return droppedSubmissions; }
    long getOrphanedSubmissions() { return orphanedSubmissions; }
    int getPendingTracked() { return pendingTracked; }
    int getInFlight() { return inFlight; }
    long getWaitObserved() { return waitObserved; }
    long getWaitDurationNanos() { return waitDurationNanos; }
    long getWaitMaximumNanos() { return waitMaximumNanos; }
    long getWaitP95Nanos() { return waitP95Nanos; }
    long getWaitP99Nanos() { return waitP99Nanos; }
    long getScheduleDelayObserved() { return scheduleDelayObserved; }
    long getScheduleDelayDurationNanos() { return scheduleDelayDurationNanos; }
    long getScheduleDelayMaximumNanos() { return scheduleDelayMaximumNanos; }
    long getScheduleDelayP95Nanos() { return scheduleDelayP95Nanos; }
    long getScheduleDelayP99Nanos() { return scheduleDelayP99Nanos; }
    long getStartLatenessObserved() { return startLatenessObserved; }
    long getStartLatenessDurationNanos() { return startLatenessDurationNanos; }
    long getStartLatenessMaximumNanos() { return startLatenessMaximumNanos; }
    long getStartLatenessP95Nanos() { return startLatenessP95Nanos; }
    long getStartLatenessP99Nanos() { return startLatenessP99Nanos; }
    long getRunDurationNanos() { return runDurationNanos; }
    long getRunMaximumNanos() { return runMaximumNanos; }
    long getRunP95Nanos() { return runP95Nanos; }
    long getRunP99Nanos() { return runP99Nanos; }
    List<TypeSnapshot> getTaskTypes() { return taskTypes; }
  }

  static final class TypeSnapshot {
    private final String className;
    private final long started;
    private final long completed;
    private final long failures;
    private final long waitObserved;
    private final long waitDurationNanos;
    private final long waitMaximumNanos;
    private final long scheduleDelayObserved;
    private final long scheduleDelayDurationNanos;
    private final long scheduleDelayMaximumNanos;
    private final long startLatenessObserved;
    private final long startLatenessDurationNanos;
    private final long startLatenessMaximumNanos;
    private final long runDurationNanos;
    private final long runMaximumNanos;

    private TypeSnapshot(
        String className,
        long started,
        long completed,
        long failures,
        long waitObserved,
        long waitDurationNanos,
        long waitMaximumNanos,
        long scheduleDelayObserved,
        long scheduleDelayDurationNanos,
        long scheduleDelayMaximumNanos,
        long startLatenessObserved,
        long startLatenessDurationNanos,
        long startLatenessMaximumNanos,
        long runDurationNanos,
        long runMaximumNanos) {
      this.className = className;
      this.started = started;
      this.completed = completed;
      this.failures = failures;
      this.waitObserved = waitObserved;
      this.waitDurationNanos = waitDurationNanos;
      this.waitMaximumNanos = waitMaximumNanos;
      this.scheduleDelayObserved = scheduleDelayObserved;
      this.scheduleDelayDurationNanos = scheduleDelayDurationNanos;
      this.scheduleDelayMaximumNanos = scheduleDelayMaximumNanos;
      this.startLatenessObserved = startLatenessObserved;
      this.startLatenessDurationNanos = startLatenessDurationNanos;
      this.startLatenessMaximumNanos = startLatenessMaximumNanos;
      this.runDurationNanos = runDurationNanos;
      this.runMaximumNanos = runMaximumNanos;
    }

    String getClassName() { return className; }
    long getStarted() { return started; }
    long getCompleted() { return completed; }
    long getFailures() { return failures; }
    long getWaitObserved() { return waitObserved; }
    long getWaitDurationNanos() { return waitDurationNanos; }
    long getWaitMaximumNanos() { return waitMaximumNanos; }
    long getScheduleDelayObserved() { return scheduleDelayObserved; }
    long getScheduleDelayDurationNanos() { return scheduleDelayDurationNanos; }
    long getScheduleDelayMaximumNanos() { return scheduleDelayMaximumNanos; }
    long getStartLatenessObserved() { return startLatenessObserved; }
    long getStartLatenessDurationNanos() { return startLatenessDurationNanos; }
    long getStartLatenessMaximumNanos() { return startLatenessMaximumNanos; }
    long getRunDurationNanos() { return runDurationNanos; }
    long getRunMaximumNanos() { return runMaximumNanos; }
  }

  static final class TaskSnapshot {
    private final String taskId;
    private final String poolIdentity;
    private final String poolClassName;
    private final String state;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final long completed;
    private final long maximumTrackedTasks;
    private final long dropped;

    private TaskSnapshot(
        String taskId,
        String poolIdentity,
        String poolClassName,
        String state,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        long completed,
        long maximumTrackedTasks,
        long dropped) {
      this.taskId = taskId;
      this.poolIdentity = poolIdentity;
      this.poolClassName = poolClassName;
      this.state = state;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.completed = completed;
      this.maximumTrackedTasks = maximumTrackedTasks;
      this.dropped = dropped;
    }

    String getTaskId() { return taskId; }
    String getPoolIdentity() { return poolIdentity; }
    String getPoolClassName() { return poolClassName; }
    String getState() { return state; }
    long getStartedAtEpochMillis() { return startedAtEpochMillis; }
    long getDeadlineEpochMillis() { return deadlineEpochMillis; }
    long getCompleted() { return completed; }
    long getMaximumTrackedTasks() { return maximumTrackedTasks; }
    long getDropped() { return dropped; }
  }

  private static final class Session {
    private final String taskId;
    private final String poolIdentity;
    private final String poolClassName;
    private final String attributionMode;
    private final int maximumTrackedTasks;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final RetransformLifecycle.Lease lease;
    private volatile String state = "RUNNING";
    private volatile String error = "";
    private volatile ScheduledFuture<?> deadlineFuture;
    private volatile Snapshot finalSnapshot;

    private Session(
        String taskId,
        String poolIdentity,
        String poolClassName,
        String attributionMode,
        int maximumTrackedTasks,
        long startedAtEpochMillis,
        long durationMillis,
        RetransformLifecycle.Lease lease) {
      this.taskId = taskId;
      this.poolIdentity = poolIdentity;
      this.poolClassName = poolClassName;
      this.attributionMode = attributionMode;
      this.maximumTrackedTasks = maximumTrackedTasks;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = startedAtEpochMillis + durationMillis;
      this.lease = lease;
    }

    private StartResult startResult() {
      return new StartResult(
          taskId,
          poolIdentity,
          poolClassName,
          attributionMode,
          startedAtEpochMillis,
          deadlineEpochMillis,
          maximumTrackedTasks);
    }
  }

  private enum TransformKind {
    THREAD_POOL_QUEUE_AND_RUN,
    THREAD_POOL_SCHEDULE_AND_RUN,
    FORK_JOIN_RUN_ONLY
  }

  private static final class PoolPlan {
    private final String attributionMode;
    private final TransformKind transformKind;
    private final Class<?>[] instrumentedClasses;

    private PoolPlan(
        String attributionMode,
        TransformKind transformKind,
        Class<?>[] instrumentedClasses) {
      this.attributionMode = attributionMode;
      this.transformKind = transformKind;
      this.instrumentedClasses = instrumentedClasses.clone();
    }
  }

  private static final class ThreadPoolLatencyTransformer
      implements ClassFileTransformer {
    private final TransformKind kind;
    private volatile boolean transformed;
    private volatile boolean executeFound;
    private volatile boolean delayedExecuteFound;
    private volatile boolean periodicReexecuteFound;
    private volatile boolean rejectFound;
    private volatile boolean beforeExecuteFound;
    private volatile boolean afterExecuteFound;
    private volatile boolean forkJoinDoExecFound;

    private ThreadPoolLatencyTransformer(TransformKind kind) {
      if (kind == null) {
        throw new IllegalArgumentException("transform kind is required");
      }
      this.kind = kind;
    }

    @Override
    public byte[] transform(
        ClassLoader loader,
        String className,
        Class<?> classBeingRedefined,
        ProtectionDomain protectionDomain,
        byte[] classfileBuffer) {
      if (classfileBuffer == null) {
        return null;
      }
      if (kind == TransformKind.FORK_JOIN_RUN_ONLY) {
        return transformForkJoin(className, classfileBuffer);
      }
      if (kind == TransformKind.THREAD_POOL_SCHEDULE_AND_RUN
          && "java/util/concurrent/ScheduledThreadPoolExecutor"
              .equals(className)) {
        return transformScheduledThreadPool(classfileBuffer);
      }
      return transformThreadPool(className, classfileBuffer);
    }

    private byte[] transformScheduledThreadPool(byte[] classfileBuffer) {
      ClassReader reader = new ClassReader(classfileBuffer);
      ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
      ClassVisitor visitor =
          new ClassVisitor(Opcodes.ASM9, writer) {
            @Override
            public MethodVisitor visitMethod(
                int access,
                String name,
                String descriptor,
                String signature,
                String[] exceptions) {
              MethodVisitor delegate =
                  super.visitMethod(
                      access, name, descriptor, signature, exceptions);
              if ("(Ljava/util/concurrent/RunnableScheduledFuture;)V"
                  .equals(descriptor)) {
                if ("delayedExecute".equals(name)) {
                  delayedExecuteFound = true;
                } else if ("reExecutePeriodic".equals(name)) {
                  periodicReexecuteFound = true;
                } else {
                  return delegate;
                }
                return new EntryAdvice(
                    delegate,
                    access,
                    name,
                    descriptor,
                    SCHEDULE_METHOD);
              }
              return delegate;
            }
          };
      reader.accept(visitor, ClassReader.EXPAND_FRAMES);
      transformed = true;
      return writer.toByteArray();
    }

    private byte[] transformThreadPool(
        String className, byte[] classfileBuffer) {
      if (!"java/util/concurrent/ThreadPoolExecutor".equals(className)) {
        return null;
      }
      ClassReader reader = new ClassReader(classfileBuffer);
      ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
      ClassVisitor visitor =
          new ClassVisitor(Opcodes.ASM9, writer) {
            @Override
            public MethodVisitor visitMethod(
                int access,
                String name,
                String descriptor,
                String signature,
                String[] exceptions) {
              MethodVisitor delegate =
                  super.visitMethod(
                      access, name, descriptor, signature, exceptions);
              if (kind == TransformKind.THREAD_POOL_QUEUE_AND_RUN
                  && "execute".equals(name)
                  && "(Ljava/lang/Runnable;)V".equals(descriptor)) {
                executeFound = true;
                return new EntryAdvice(
                    delegate,
                    access,
                    name,
                    descriptor,
                    SUBMIT_METHOD);
              }
              if ((kind == TransformKind.THREAD_POOL_QUEUE_AND_RUN
                      || kind == TransformKind.THREAD_POOL_SCHEDULE_AND_RUN)
                  && "reject".equals(name)
                  && "(Ljava/lang/Runnable;)V".equals(descriptor)) {
                rejectFound = true;
                return new EntryAdvice(
                    delegate,
                    access,
                    name,
                    descriptor,
                    REJECT_METHOD);
              }
              if ("beforeExecute".equals(name)
                  && "(Ljava/lang/Thread;Ljava/lang/Runnable;)V"
                      .equals(descriptor)) {
                beforeExecuteFound = true;
                return new BeforeExecuteAdvice(
                    delegate, access, name, descriptor);
              }
              if ("afterExecute".equals(name)
                  && "(Ljava/lang/Runnable;Ljava/lang/Throwable;)V"
                      .equals(descriptor)) {
                afterExecuteFound = true;
                return new AfterExecuteAdvice(
                    delegate, access, name, descriptor);
              }
              return delegate;
            }
          };
      reader.accept(visitor, ClassReader.EXPAND_FRAMES);
      transformed = true;
      return writer.toByteArray();
    }

    private byte[] transformForkJoin(
        String className, byte[] classfileBuffer) {
      if (!"java/util/concurrent/ForkJoinTask".equals(className)) {
        return null;
      }
      ClassReader reader = new ClassReader(classfileBuffer);
      ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
      ClassVisitor visitor =
          new ClassVisitor(Opcodes.ASM9, writer) {
            @Override
            public MethodVisitor visitMethod(
                int access,
                String name,
                String descriptor,
                String signature,
                String[] exceptions) {
              MethodVisitor delegate =
                  super.visitMethod(
                      access, name, descriptor, signature, exceptions);
              if ("doExec".equals(name)
                  && ("()I".equals(descriptor)
                      || "()V".equals(descriptor))) {
                forkJoinDoExecFound = true;
                return new ForkJoinExecuteAdvice(
                    delegate, access, name, descriptor);
              }
              return delegate;
            }
          };
      reader.accept(visitor, ClassReader.EXPAND_FRAMES);
      transformed = true;
      return writer.toByteArray();
    }

    private void assertComplete() {
      boolean complete;
      if (kind == TransformKind.FORK_JOIN_RUN_ONLY) {
        complete = transformed && forkJoinDoExecFound;
      } else {
        boolean submissionHooks;
        if (kind == TransformKind.THREAD_POOL_QUEUE_AND_RUN) {
          submissionHooks = executeFound && rejectFound;
        } else {
          submissionHooks =
              delayedExecuteFound && periodicReexecuteFound && rejectFound;
        }
        complete =
            transformed
                && submissionHooks
                && beforeExecuteFound
                && afterExecuteFound;
      }
      if (!complete) {
        throw new IllegalStateException(
            "Current JDK bytecode does not expose the required thread-pool attribution hooks");
      }
    }
  }

  private static final class ForkJoinExecuteAdvice extends AdviceAdapter {
    private ForkJoinExecuteAdvice(
        MethodVisitor delegate,
        int access,
        String name,
        String descriptor) {
      super(Opcodes.ASM9, delegate, access, name, descriptor);
    }

    @Override
    protected void onMethodEnter() {
      loadThis();
      invokeStatic(BRIDGE_TYPE, START_FORK_JOIN_METHOD);
    }

    @Override
    protected void onMethodExit(int opcode) {
      if (opcode == Opcodes.ATHROW) {
        dup();
        invokeStatic(BRIDGE_TYPE, COMPLETE_METHOD);
      } else if (opcode == Opcodes.IRETURN || opcode == Opcodes.RETURN) {
        visitInsn(Opcodes.ACONST_NULL);
        invokeStatic(BRIDGE_TYPE, COMPLETE_METHOD);
      }
    }
  }

  private static final class EntryAdvice extends AdviceAdapter {
    private final org.objectweb.asm.commons.Method bridgeMethod;

    private EntryAdvice(
        MethodVisitor delegate,
        int access,
        String name,
        String descriptor,
        org.objectweb.asm.commons.Method bridgeMethod) {
      super(Opcodes.ASM9, delegate, access, name, descriptor);
      this.bridgeMethod = bridgeMethod;
    }

    @Override
    protected void onMethodEnter() {
      loadThis();
      loadArg(0);
      invokeStatic(BRIDGE_TYPE, bridgeMethod);
    }
  }

  private static final class BeforeExecuteAdvice extends AdviceAdapter {
    private BeforeExecuteAdvice(
        MethodVisitor delegate,
        int access,
        String name,
        String descriptor) {
      super(Opcodes.ASM9, delegate, access, name, descriptor);
    }

    @Override
    protected void onMethodEnter() {
      loadThis();
      loadArg(1);
      invokeStatic(BRIDGE_TYPE, START_METHOD);
    }
  }

  private static final class AfterExecuteAdvice extends AdviceAdapter {
    private AfterExecuteAdvice(
        MethodVisitor delegate,
        int access,
        String name,
        String descriptor) {
      super(Opcodes.ASM9, delegate, access, name, descriptor);
    }

    @Override
    protected void onMethodEnter() {
      loadArg(1);
      invokeStatic(BRIDGE_TYPE, COMPLETE_METHOD);
    }
  }
}
