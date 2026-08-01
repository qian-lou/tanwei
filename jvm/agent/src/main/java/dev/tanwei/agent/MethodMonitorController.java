package dev.tanwei.agent;

import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.IllegalClassFormatException;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.security.ProtectionDomain;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Label;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.commons.AdviceAdapter;

final class MethodMonitorController implements AutoCloseable {
  private static final int MAXIMUM_TASKS = 32;
  private static final int MAXIMUM_WINDOWS = 300;
  private static final long TERMINAL_RETENTION_MILLIS = 60_000L;
  private static final Type BRIDGE_TYPE =
      Type.getObjectType("dev/tanwei/bootstrap/MethodMonitorBridge");
  private static final org.objectweb.asm.commons.Method ENTER_METHOD =
      new org.objectweb.asm.commons.Method("enter", "(Ljava/lang/String;)J");
  private static final org.objectweb.asm.commons.Method EXIT_METHOD =
      new org.objectweb.asm.commons.Method(
          "exit", "(Ljava/lang/String;JLjava/lang/Throwable;)V");

  private final Instrumentation instrumentation;
  private final RetransformLifecycle retransforms;
  private final ScheduledExecutorService scheduler;
  private final Map<String, MonitorTask> tasks =
      new ConcurrentHashMap<String, MonitorTask>();
  private final Method registerBridge;
  private final Method updateMinimumDurationBridge;
  private final Method unregisterBridge;
  private final Method snapshotBridge;

  MethodMonitorController(
      Instrumentation instrumentation,
      ScheduledExecutorService scheduler,
      RetransformLifecycle retransforms)
      throws ReflectiveOperationException {
    this.instrumentation = instrumentation;
    this.scheduler = scheduler;
    this.retransforms = retransforms;
    Class<?> bridge =
        Class.forName(
            "dev.tanwei.bootstrap.MethodMonitorBridge",
            true,
            ClassLoader.getSystemClassLoader());
    registerBridge =
        bridge.getMethod("register", String.class, long.class);
    updateMinimumDurationBridge =
        bridge.getMethod(
            "updateMinimumDuration", String.class, long.class);
    unregisterBridge = bridge.getMethod("unregister", String.class);
    snapshotBridge =
        bridge.getMethod("snapshot", String.class, boolean.class);
  }

  StartResult preview(
      String className,
      String classLoader,
      String methodName,
      String parameterTypes) {
    Selection selection =
        resolveSelection(className, classLoader, methodName, parameterTypes);
    return new StartResult(
        "",
        selection.target.getName(),
        classLoaderName(selection.target),
        selection.method.toGenericString(),
        0L,
        0L);
  }

  StartResult start(
      String requestedTaskId,
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      long intervalMillis,
      long durationMillis,
      long minimumDurationMillis)
      throws Exception {
    if (intervalMillis < 1_000L || intervalMillis > 60_000L) {
      throw new IllegalArgumentException(
          "Monitor interval must be between 1 and 60 seconds");
    }
    if (durationMillis < 10_000L || durationMillis > 28_800_000L) {
      throw new IllegalArgumentException(
          "Monitor duration must be between 10 seconds and 8 hours");
    }
    if (minimumDurationMillis < 0L || minimumDurationMillis > 60_000L) {
      throw new IllegalArgumentException(
          "Minimum monitor duration must be between 0 and 60 seconds");
    }
    purgeTerminalTasks();
    if (tasks.size() >= MAXIMUM_TASKS) {
      throw new IllegalStateException("Too many method monitor tasks are retained");
    }

    Selection selection =
        resolveSelection(className, classLoader, methodName, parameterTypes);
    Class<?> target = selection.target;
    Method method = selection.method;
    String taskId =
        requestedTaskId == null || requestedTaskId.isEmpty()
            ? UUID.randomUUID().toString()
            : requestedTaskId;
    if (tasks.containsKey(taskId)) {
      throw new IllegalStateException("Monitor task identity is already in use");
    }

    MethodMonitorTransformer transformer =
        new MethodMonitorTransformer(
            target,
            method.getName(),
            Type.getMethodDescriptor(method),
            taskId);
    long startedAtEpochMillis = System.currentTimeMillis();
    registerBridge.invoke(
        null,
        taskId,
        Long.valueOf(TimeUnit.MILLISECONDS.toNanos(minimumDurationMillis)));
    RetransformLifecycle.Lease lease = null;
    try {
      lease =
          retransforms.activate(
              "MONITOR:" + taskId, "MONITOR", transformer, target);
      MonitorTask task =
          new MonitorTask(
              taskId,
              target,
              lease,
              method.toGenericString(),
              intervalMillis,
              startedAtEpochMillis,
              durationMillis,
              minimumDurationMillis);
      tasks.put(taskId, task);
      task.windowFuture =
          scheduler.scheduleAtFixedRate(
              () -> captureWindow(taskId),
              intervalMillis,
              intervalMillis,
              TimeUnit.MILLISECONDS);
      scheduler.schedule(
          () -> finish(taskId, "TIMED_OUT"),
          durationMillis,
          TimeUnit.MILLISECONDS);
      return new StartResult(
          taskId,
          target.getName(),
          classLoaderName(target),
          method.toGenericString(),
          intervalMillis,
          task.deadlineEpochMillis);
    } catch (Exception exception) {
      if (lease != null) {
        try {
          lease.rollback();
        } catch (Exception rollbackFailure) {
          exception.addSuppressed(rollbackFailure);
        }
      }
      unregisterBridge.invoke(null, taskId);
      throw exception;
    }
  }

  WindowBatch windows(String taskId, long afterSequence, int limit)
      throws Exception {
    MonitorTask task = tasks.get(taskId);
    if (task == null) {
      return WindowBatch.unknown(taskId);
    }
    if (!task.terminal.get()) {
      updateTotals(task, bridgeSnapshot(taskId, false));
    }
    List<WindowSnapshot> selected = new ArrayList<WindowSnapshot>();
    long nextSequence = Math.max(0L, afterSequence);
    synchronized (task) {
      for (WindowSnapshot window : task.windows) {
        if (window.sequence <= afterSequence) {
          continue;
        }
        selected.add(window);
        nextSequence = window.sequence;
        if (selected.size() >= limit) {
          break;
        }
      }
      return new WindowBatch(
          task.taskId,
          task.state,
          task.target.getName(),
          task.method,
          task.startedAtEpochMillis,
          task.deadlineEpochMillis,
          task.intervalMillis,
          task.minimumDurationMillis,
          task.totalCalls,
          task.totalFailures,
          task.totalDurationNanos,
          task.totalMaximumDurationNanos,
          task.totalP95DurationNanos,
          task.totalP99DurationNanos,
          nextSequence,
          selected);
    }
  }

  String cancel(String taskId) {
    MonitorTask task = tasks.get(taskId);
    if (task == null) {
      return "UNKNOWN";
    }
    finish(taskId, "CANCELLED");
    return task.state;
  }

  ThresholdUpdate updateMinimumDuration(
      String taskId, long minimumDurationMillis) throws Exception {
    if (minimumDurationMillis < 0L || minimumDurationMillis > 60_000L) {
      throw new IllegalArgumentException(
          "Minimum monitor duration must be between 0 and 60 seconds");
    }
    MonitorTask task = tasks.get(taskId);
    if (task == null) {
      return ThresholdUpdate.unknown(taskId, minimumDurationMillis);
    }
    synchronized (task) {
      if (task.terminal.get()) {
        throw new IllegalStateException(
            "Only a running monitor task can update its threshold");
      }
      captureWindowLocked(task);
      long previousMinimumDurationMillis = task.minimumDurationMillis;
      updateMinimumDurationBridge.invoke(
          null,
          taskId,
          Long.valueOf(TimeUnit.MILLISECONDS.toNanos(minimumDurationMillis)));
      task.minimumDurationMillis = minimumDurationMillis;
      return new ThresholdUpdate(
          taskId,
          task.state,
          previousMinimumDurationMillis,
          minimumDurationMillis);
    }
  }

  boolean hasActiveTaskFor(Class<?> target) {
    for (MonitorTask task : tasks.values()) {
      if (task.target == target && !task.terminal.get()) {
        return true;
      }
    }
    return false;
  }

  List<TaskSnapshot> activeTasks() {
    List<TaskSnapshot> snapshots = new ArrayList<TaskSnapshot>();
    for (MonitorTask task : tasks.values()) {
      if (task.terminal.get()) {
        continue;
      }
      try {
        updateTotals(task, bridgeSnapshot(task.taskId, false));
      } catch (Exception ignored) {
        // A temporary metrics read failure must not hide task ownership.
      }
      snapshots.add(
          new TaskSnapshot(
              task.taskId,
              task.target.getName(),
              task.method,
              task.state,
              task.startedAtEpochMillis,
              task.deadlineEpochMillis,
              task.totalCalls,
              task.totalFailures));
    }
    return snapshots;
  }

  private void captureWindow(String taskId) {
    MonitorTask task = tasks.get(taskId);
    if (task == null || task.terminal.get()) {
      return;
    }
    captureWindow(task);
  }

  private void captureWindow(MonitorTask task) {
    try {
      synchronized (task) {
        captureWindowLocked(task);
      }
    } catch (Throwable ignored) {
      // Fixed-rate scheduling must survive a transient reflective read failure.
    }
  }

  private void captureWindowLocked(MonitorTask task) throws Exception {
    BridgeSnapshot snapshot = bridgeSnapshot(task.taskId, true);
    long endedAtEpochMillis = System.currentTimeMillis();
    updateTotals(task, snapshot);
    task.windows.addLast(
        new WindowSnapshot(
            task.nextSequence++,
            task.windowStartedAtEpochMillis,
            endedAtEpochMillis,
            task.minimumDurationMillis,
            snapshot.calls,
            snapshot.failures,
            snapshot.durationNanos,
            snapshot.maximumDurationNanos,
            snapshot.p95DurationNanos,
            snapshot.p99DurationNanos));
    task.windowStartedAtEpochMillis = endedAtEpochMillis;
    while (task.windows.size() > MAXIMUM_WINDOWS) {
      task.windows.removeFirst();
    }
  }

  private static void updateTotals(
      MonitorTask task, BridgeSnapshot snapshot) {
    task.totalCalls = snapshot.totalCalls;
    task.totalFailures = snapshot.totalFailures;
    task.totalDurationNanos = snapshot.totalDurationNanos;
    task.totalMaximumDurationNanos = snapshot.totalMaximumDurationNanos;
    task.totalP95DurationNanos = snapshot.totalP95DurationNanos;
    task.totalP99DurationNanos = snapshot.totalP99DurationNanos;
  }

  private BridgeSnapshot bridgeSnapshot(String taskId, boolean resetWindow)
      throws Exception {
    Object snapshot =
        snapshotBridge.invoke(null, taskId, Boolean.valueOf(resetWindow));
    Class<?> type = snapshot.getClass();
    return new BridgeSnapshot(
        bridgeLong(type, snapshot, "getCalls"),
        bridgeLong(type, snapshot, "getFailures"),
        bridgeLong(type, snapshot, "getDurationNanos"),
        bridgeLong(type, snapshot, "getMaximumDurationNanos"),
        bridgeLong(type, snapshot, "getP95DurationNanos"),
        bridgeLong(type, snapshot, "getP99DurationNanos"),
        bridgeLong(type, snapshot, "getTotalCalls"),
        bridgeLong(type, snapshot, "getTotalFailures"),
        bridgeLong(type, snapshot, "getTotalDurationNanos"),
        bridgeLong(type, snapshot, "getTotalMaximumDurationNanos"),
        bridgeLong(type, snapshot, "getTotalP95DurationNanos"),
        bridgeLong(type, snapshot, "getTotalP99DurationNanos"));
  }

  private static long bridgeLong(
      Class<?> type, Object snapshot, String accessor) throws Exception {
    return ((Long) type.getMethod(accessor).invoke(snapshot)).longValue();
  }

  private void finish(String taskId, String terminalState) {
    MonitorTask task = tasks.get(taskId);
    if (task == null || !task.terminal.compareAndSet(false, true)) {
      return;
    }
    ScheduledFuture<?> windowFuture = task.windowFuture;
    if (windowFuture != null) {
      windowFuture.cancel(false);
    }
    try {
      task.lease.rollback();
      task.state = terminalState;
    } catch (Exception exception) {
      task.state = "FAILED";
    }
    captureWindow(task);
    try {
      unregisterBridge.invoke(null, taskId);
    } catch (Exception ignored) {
      // The transformed class is already detached from this bridge.
    }
    scheduler.schedule(
        () -> cleanupTerminalTask(taskId),
        TERMINAL_RETENTION_MILLIS,
        TimeUnit.MILLISECONDS);
  }

  private void purgeTerminalTasks() {
    if (tasks.size() < MAXIMUM_TASKS) {
      return;
    }
    for (Map.Entry<String, MonitorTask> entry : tasks.entrySet()) {
      if (entry.getValue().terminal.get()) {
        cleanupTerminalTask(entry.getKey());
      }
    }
  }

  private void cleanupTerminalTask(String taskId) {
    MonitorTask task = tasks.get(taskId);
    if (task != null && task.terminal.get()) {
      tasks.remove(taskId, task);
    }
  }

  private Selection resolveSelection(
      String className,
      String classLoader,
      String methodName,
      String parameterTypes) {
    Class<?> target = findClass(className, classLoader);
    if (target == null) {
      throw new IllegalArgumentException("The selected class is no longer loaded");
    }
    Method method = findMethod(target, methodName, parameterTypes);
    if (method == null) {
      throw new IllegalArgumentException("The selected method signature was not found");
    }
    if (Modifier.isAbstract(method.getModifiers())
        || Modifier.isNative(method.getModifiers())) {
      throw new IllegalArgumentException(
          "Abstract and native methods cannot be monitored");
    }
    if (!instrumentation.isModifiableClass(target)) {
      throw new IllegalStateException("The selected class is not modifiable");
    }
    return new Selection(target, method);
  }

  private Class<?> findClass(String name, String classLoader) {
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      if (type.getName().equals(name)
          && classLoaderName(type).equals(classLoader)) {
        return type;
      }
    }
    return null;
  }

  private static Method findMethod(
      Class<?> target, String methodName, String parameterTypes) {
    for (Method method : target.getDeclaredMethods()) {
      if (method.getName().equals(methodName)
          && joinParameterTypes(method).equals(parameterTypes)) {
        return method;
      }
    }
    return null;
  }

  private static String joinParameterTypes(Method method) {
    Class<?>[] types = method.getParameterTypes();
    if (types.length == 0) {
      return "";
    }
    List<String> names = new ArrayList<String>(types.length);
    for (Class<?> type : types) {
      names.add(type.getTypeName());
    }
    return String.join(",", names);
  }

  private static String classLoaderName(Class<?> type) {
    ClassLoader loader = type.getClassLoader();
    return loader == null ? "bootstrap" : loader.toString();
  }

  @Override
  public void close() {
    for (String taskId : new ArrayList<String>(tasks.keySet())) {
      finish(taskId, "CANCELLED");
    }
  }

  static final class StartResult {
    private final String taskId;
    private final String className;
    private final String classLoader;
    private final String method;
    private final long intervalMillis;
    private final long deadlineEpochMillis;

    private StartResult(
        String taskId,
        String className,
        String classLoader,
        String method,
        long intervalMillis,
        long deadlineEpochMillis) {
      this.taskId = taskId;
      this.className = className;
      this.classLoader = classLoader;
      this.method = method;
      this.intervalMillis = intervalMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
    }

    String getTaskId() {
      return taskId;
    }

    String getClassName() {
      return className;
    }

    String getClassLoader() {
      return classLoader;
    }

    String getMethod() {
      return method;
    }

    long getIntervalMillis() {
      return intervalMillis;
    }

    long getDeadlineEpochMillis() {
      return deadlineEpochMillis;
    }
  }

  static final class ThresholdUpdate {
    private final String taskId;
    private final String state;
    private final long previousMinimumDurationMillis;
    private final long minimumDurationMillis;

    private ThresholdUpdate(
        String taskId,
        String state,
        long previousMinimumDurationMillis,
        long minimumDurationMillis) {
      this.taskId = taskId;
      this.state = state;
      this.previousMinimumDurationMillis = previousMinimumDurationMillis;
      this.minimumDurationMillis = minimumDurationMillis;
    }

    private static ThresholdUpdate unknown(
        String taskId, long minimumDurationMillis) {
      return new ThresholdUpdate(
          taskId, "UNKNOWN", 0L, minimumDurationMillis);
    }

    String getTaskId() {
      return taskId;
    }

    String getState() {
      return state;
    }

    long getPreviousMinimumDurationMillis() {
      return previousMinimumDurationMillis;
    }

    long getMinimumDurationMillis() {
      return minimumDurationMillis;
    }
  }

  static final class TaskSnapshot {
    private final String taskId;
    private final String className;
    private final String method;
    private final String state;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final long calls;
    private final long failures;

    private TaskSnapshot(
        String taskId,
        String className,
        String method,
        String state,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        long calls,
        long failures) {
      this.taskId = taskId;
      this.className = className;
      this.method = method;
      this.state = state;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.calls = calls;
      this.failures = failures;
    }

    String getTaskId() {
      return taskId;
    }

    String getClassName() {
      return className;
    }

    String getMethod() {
      return method;
    }

    String getState() {
      return state;
    }

    long getStartedAtEpochMillis() {
      return startedAtEpochMillis;
    }

    long getDeadlineEpochMillis() {
      return deadlineEpochMillis;
    }

    long getCalls() {
      return calls;
    }

    long getFailures() {
      return failures;
    }
  }

  static final class WindowBatch {
    private final String taskId;
    private final String state;
    private final String className;
    private final String method;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final long intervalMillis;
    private final long minimumDurationMillis;
    private final long totalCalls;
    private final long totalFailures;
    private final long totalDurationNanos;
    private final long totalMaximumDurationNanos;
    private final long totalP95DurationNanos;
    private final long totalP99DurationNanos;
    private final long nextSequence;
    private final List<WindowSnapshot> windows;

    private WindowBatch(
        String taskId,
        String state,
        String className,
        String method,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        long intervalMillis,
        long minimumDurationMillis,
        long totalCalls,
        long totalFailures,
        long totalDurationNanos,
        long totalMaximumDurationNanos,
        long totalP95DurationNanos,
        long totalP99DurationNanos,
        long nextSequence,
        List<WindowSnapshot> windows) {
      this.taskId = taskId;
      this.state = state;
      this.className = className;
      this.method = method;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.intervalMillis = intervalMillis;
      this.minimumDurationMillis = minimumDurationMillis;
      this.totalCalls = totalCalls;
      this.totalFailures = totalFailures;
      this.totalDurationNanos = totalDurationNanos;
      this.totalMaximumDurationNanos = totalMaximumDurationNanos;
      this.totalP95DurationNanos = totalP95DurationNanos;
      this.totalP99DurationNanos = totalP99DurationNanos;
      this.nextSequence = nextSequence;
      this.windows = Collections.unmodifiableList(windows);
    }

    private static WindowBatch unknown(String taskId) {
      return new WindowBatch(
          taskId,
          "UNKNOWN",
          "",
          "",
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
          Collections.<WindowSnapshot>emptyList());
    }

    String getTaskId() {
      return taskId;
    }

    String getState() {
      return state;
    }

    String getClassName() {
      return className;
    }

    String getMethod() {
      return method;
    }

    long getStartedAtEpochMillis() {
      return startedAtEpochMillis;
    }

    long getDeadlineEpochMillis() {
      return deadlineEpochMillis;
    }

    long getIntervalMillis() {
      return intervalMillis;
    }

    long getMinimumDurationMillis() {
      return minimumDurationMillis;
    }

    long getTotalCalls() {
      return totalCalls;
    }

    long getTotalFailures() {
      return totalFailures;
    }

    long getTotalDurationNanos() {
      return totalDurationNanos;
    }

    long getTotalMaximumDurationNanos() {
      return totalMaximumDurationNanos;
    }

    long getTotalP95DurationNanos() {
      return totalP95DurationNanos;
    }

    long getTotalP99DurationNanos() {
      return totalP99DurationNanos;
    }

    long getNextSequence() {
      return nextSequence;
    }

    List<WindowSnapshot> getWindows() {
      return windows;
    }
  }

  static final class WindowSnapshot {
    private final long sequence;
    private final long startedAtEpochMillis;
    private final long endedAtEpochMillis;
    private final long minimumDurationMillis;
    private final long calls;
    private final long failures;
    private final long durationNanos;
    private final long maximumDurationNanos;
    private final long p95DurationNanos;
    private final long p99DurationNanos;

    private WindowSnapshot(
        long sequence,
        long startedAtEpochMillis,
        long endedAtEpochMillis,
        long minimumDurationMillis,
        long calls,
        long failures,
        long durationNanos,
        long maximumDurationNanos,
        long p95DurationNanos,
        long p99DurationNanos) {
      this.sequence = sequence;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.endedAtEpochMillis = endedAtEpochMillis;
      this.minimumDurationMillis = minimumDurationMillis;
      this.calls = calls;
      this.failures = failures;
      this.durationNanos = durationNanos;
      this.maximumDurationNanos = maximumDurationNanos;
      this.p95DurationNanos = p95DurationNanos;
      this.p99DurationNanos = p99DurationNanos;
    }

    long getSequence() {
      return sequence;
    }

    long getStartedAtEpochMillis() {
      return startedAtEpochMillis;
    }

    long getEndedAtEpochMillis() {
      return endedAtEpochMillis;
    }

    long getMinimumDurationMillis() {
      return minimumDurationMillis;
    }

    long getCalls() {
      return calls;
    }

    long getFailures() {
      return failures;
    }

    long getDurationNanos() {
      return durationNanos;
    }

    long getMaximumDurationNanos() {
      return maximumDurationNanos;
    }

    long getP95DurationNanos() {
      return p95DurationNanos;
    }

    long getP99DurationNanos() {
      return p99DurationNanos;
    }
  }

  private static final class BridgeSnapshot {
    private final long calls;
    private final long failures;
    private final long durationNanos;
    private final long maximumDurationNanos;
    private final long p95DurationNanos;
    private final long p99DurationNanos;
    private final long totalCalls;
    private final long totalFailures;
    private final long totalDurationNanos;
    private final long totalMaximumDurationNanos;
    private final long totalP95DurationNanos;
    private final long totalP99DurationNanos;

    private BridgeSnapshot(
        long calls,
        long failures,
        long durationNanos,
        long maximumDurationNanos,
        long p95DurationNanos,
        long p99DurationNanos,
        long totalCalls,
        long totalFailures,
        long totalDurationNanos,
        long totalMaximumDurationNanos,
        long totalP95DurationNanos,
        long totalP99DurationNanos) {
      this.calls = calls;
      this.failures = failures;
      this.durationNanos = durationNanos;
      this.maximumDurationNanos = maximumDurationNanos;
      this.p95DurationNanos = p95DurationNanos;
      this.p99DurationNanos = p99DurationNanos;
      this.totalCalls = totalCalls;
      this.totalFailures = totalFailures;
      this.totalDurationNanos = totalDurationNanos;
      this.totalMaximumDurationNanos = totalMaximumDurationNanos;
      this.totalP95DurationNanos = totalP95DurationNanos;
      this.totalP99DurationNanos = totalP99DurationNanos;
    }
  }

  private static final class Selection {
    private final Class<?> target;
    private final Method method;

    private Selection(Class<?> target, Method method) {
      this.target = target;
      this.method = method;
    }
  }

  private static final class MonitorTask {
    private final String taskId;
    private final Class<?> target;
    private final RetransformLifecycle.Lease lease;
    private final String method;
    private final long intervalMillis;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private volatile long minimumDurationMillis;
    private final AtomicBoolean terminal = new AtomicBoolean();
    private final Deque<WindowSnapshot> windows =
        new ArrayDeque<WindowSnapshot>();
    private volatile ScheduledFuture<?> windowFuture;
    private volatile String state = "RUNNING";
    private long nextSequence = 1L;
    private long windowStartedAtEpochMillis;
    private volatile long totalCalls;
    private volatile long totalFailures;
    private volatile long totalDurationNanos;
    private volatile long totalMaximumDurationNanos;
    private volatile long totalP95DurationNanos;
    private volatile long totalP99DurationNanos;

    private MonitorTask(
        String taskId,
        Class<?> target,
        RetransformLifecycle.Lease lease,
        String method,
        long intervalMillis,
        long startedAtEpochMillis,
        long durationMillis,
        long minimumDurationMillis) {
      this.taskId = taskId;
      this.target = target;
      this.lease = lease;
      this.method = method;
      this.intervalMillis = intervalMillis;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = startedAtEpochMillis + durationMillis;
      this.minimumDurationMillis = minimumDurationMillis;
      this.windowStartedAtEpochMillis = startedAtEpochMillis;
    }
  }

  private static final class MethodMonitorTransformer
      implements ClassFileTransformer {
    private final Class<?> target;
    private final String methodName;
    private final String methodDescriptor;
    private final String taskId;

    private MethodMonitorTransformer(
        Class<?> target,
        String methodName,
        String methodDescriptor,
        String taskId) {
      this.target = target;
      this.methodName = methodName;
      this.methodDescriptor = methodDescriptor;
      this.taskId = taskId;
    }

    @Override
    public byte[] transform(
        ClassLoader loader,
        String className,
        Class<?> classBeingRedefined,
        ProtectionDomain protectionDomain,
        byte[] classfileBuffer)
        throws IllegalClassFormatException {
      if (classBeingRedefined != target) {
        return null;
      }
      try {
        ClassReader reader = new ClassReader(classfileBuffer);
        ClassWriter writer = new LoaderAwareClassWriter(reader, loader);
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
                if (!methodName.equals(name)
                    || !methodDescriptor.equals(descriptor)) {
                  return delegate;
                }
                return new MethodMonitorAdvice(
                    delegate, access, name, descriptor, taskId);
              }
            };
        reader.accept(visitor, ClassReader.EXPAND_FRAMES);
        return writer.toByteArray();
      } catch (RuntimeException exception) {
        throw new IllegalClassFormatException(exception.getMessage());
      }
    }
  }

  private static final class LoaderAwareClassWriter extends ClassWriter {
    private final ClassLoader targetLoader;

    private LoaderAwareClassWriter(
        ClassReader reader, ClassLoader targetLoader) {
      super(reader, ClassWriter.COMPUTE_FRAMES | ClassWriter.COMPUTE_MAXS);
      this.targetLoader = targetLoader;
    }

    @Override
    protected String getCommonSuperClass(
        String leftName, String rightName) {
      try {
        Class<?> left =
            Class.forName(leftName.replace('/', '.'), false, targetLoader);
        Class<?> right =
            Class.forName(rightName.replace('/', '.'), false, targetLoader);
        if (left.isAssignableFrom(right)) {
          return leftName;
        }
        if (right.isAssignableFrom(left)) {
          return rightName;
        }
        if (left.isInterface() || right.isInterface()) {
          return "java/lang/Object";
        }
        do {
          left = left.getSuperclass();
        } while (left != null && !left.isAssignableFrom(right));
        return left == null
            ? "java/lang/Object"
            : left.getName().replace('.', '/');
      } catch (Throwable ignored) {
        return "java/lang/Object";
      }
    }
  }

  private static final class MethodMonitorAdvice extends AdviceAdapter {
    private final String taskId;
    private final Label tryStart = new Label();
    private final Label tryEnd = new Label();
    private int startLocal;

    private MethodMonitorAdvice(
        MethodVisitor delegate,
        int access,
        String name,
        String descriptor,
        String taskId) {
      super(Opcodes.ASM9, delegate, access, name, descriptor);
      this.taskId = taskId;
    }

    @Override
    protected void onMethodEnter() {
      push(taskId);
      invokeStatic(BRIDGE_TYPE, ENTER_METHOD);
      startLocal = newLocal(Type.LONG_TYPE);
      storeLocal(startLocal);
      mark(tryStart);
    }

    @Override
    protected void onMethodExit(int opcode) {
      if (opcode == Opcodes.ATHROW) {
        return;
      }
      emitExit(-1);
    }

    @Override
    public void visitMaxs(int maximumStack, int maximumLocals) {
      mark(tryEnd);
      visitTryCatchBlock(
          tryStart,
          tryEnd,
          tryEnd,
          Type.getInternalName(Throwable.class));
      int throwableLocal = newLocal(Type.getType(Throwable.class));
      storeLocal(throwableLocal);
      emitExit(throwableLocal);
      loadLocal(throwableLocal);
      throwException();
      super.visitMaxs(maximumStack, maximumLocals);
    }

    private void emitExit(int throwableLocal) {
      push(taskId);
      loadLocal(startLocal);
      if (throwableLocal < 0) {
        visitInsn(Opcodes.ACONST_NULL);
      } else {
        loadLocal(throwableLocal);
      }
      invokeStatic(BRIDGE_TYPE, EXIT_METHOD);
    }
  }
}
