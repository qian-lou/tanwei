package dev.tanwei.agent;

import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.IllegalClassFormatException;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
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

final class TraceController implements AutoCloseable {
  static final int MAXIMUM_CLASSES = 64;
  private static final int MAXIMUM_TASKS = 8;
  private static final long TERMINAL_RETENTION_MILLIS = 60_000L;
  private static final Type BRIDGE_TYPE =
      Type.getObjectType("dev/tanwei/bootstrap/TraceBridge");
  private static final org.objectweb.asm.commons.Method ENTER_METHOD =
      new org.objectweb.asm.commons.Method(
          "enter", "(Ljava/lang/String;Ljava/lang/String;ZLjava/lang/String;I)J");
  private static final org.objectweb.asm.commons.Method EXIT_METHOD =
      new org.objectweb.asm.commons.Method(
          "exit", "(Ljava/lang/String;JLjava/lang/Throwable;)V");
  private static final org.objectweb.asm.commons.Method CALL_SITE_METHOD =
      new org.objectweb.asm.commons.Method(
          "callSite", "(Ljava/lang/String;Ljava/lang/String;I)V");

  private final Instrumentation instrumentation;
  private final RetransformLifecycle retransforms;
  private final ScheduledExecutorService scheduler;
  private final Map<String, TraceTask> tasks =
      new ConcurrentHashMap<String, TraceTask>();
  private final Method registerBridge;
  private final Method unregisterBridge;
  private final Method updateMinimumDurationBridge;
  private final Method drainBridge;
  private final Method capturedBridge;
  private final Method droppedBridge;

  TraceController(
      Instrumentation instrumentation,
      ScheduledExecutorService scheduler,
      RetransformLifecycle retransforms)
      throws ReflectiveOperationException {
    this.instrumentation = instrumentation;
    this.scheduler = scheduler;
    this.retransforms = retransforms;
    Class<?> bridge =
        Class.forName(
            "dev.tanwei.bootstrap.TraceBridge",
            true,
            ClassLoader.getSystemClassLoader());
    registerBridge =
        bridge.getMethod(
            "register",
            String.class,
            int.class,
            int.class,
            int.class,
            long.class);
    unregisterBridge = bridge.getMethod("unregister", String.class);
    updateMinimumDurationBridge =
        bridge.getMethod(
            "updateMinimumDuration", String.class, long.class);
    drainBridge = bridge.getMethod("drain", String.class, int.class);
    capturedBridge = bridge.getMethod("captured", String.class);
    droppedBridge = bridge.getMethod("dropped", String.class);
  }

  Preview preview(
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      String scopePrefix,
      String includeRules,
      String excludeRules) {
    Selection selection =
        resolveSelection(className, classLoader, methodName, parameterTypes);
    CandidateSelection candidates =
        resolveCandidates(
            selection.target,
            selection.method,
            scopePrefix,
            includeRules,
            excludeRules);
    return new Preview(
        selection.target.getName(),
        classLoaderName(selection.target),
        selection.method.toGenericString(),
        scopePrefix,
        candidates.filter.getIncludeRulesText(),
        candidates.filter.getExcludeRulesText(),
        classNames(candidates.classes),
        candidates.instrumentedMethodCount,
        candidates.classes.size() <= MAXIMUM_CLASSES);
  }

  StartResult start(
      String requestedTaskId,
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      String scopePrefix,
      String includeRules,
      String excludeRules,
      int maximumTraces,
      int maximumDepth,
      int maximumSpans,
      long minimumDurationMillis,
      long timeoutMillis)
      throws Exception {
    validateBounds(
        maximumTraces,
        maximumDepth,
        maximumSpans,
        minimumDurationMillis,
        timeoutMillis);
    purgeTerminalTasks();
    if (tasks.size() >= MAXIMUM_TASKS) {
      throw new IllegalStateException("Too many cross-class trace tasks are retained");
    }
    Selection selection =
        resolveSelection(className, classLoader, methodName, parameterTypes);
    CandidateSelection candidates =
        resolveCandidates(
            selection.target,
            selection.method,
            scopePrefix,
            includeRules,
            excludeRules);
    if (candidates.classes.size() > MAXIMUM_CLASSES) {
      throw new IllegalArgumentException(
          "Trace scope matches more than "
              + MAXIMUM_CLASSES
              + " modifiable classes; narrow the package prefix");
    }
    ensureNoActiveOverlap(candidates.classes);

    String taskId =
        requestedTaskId == null || requestedTaskId.isEmpty()
            ? UUID.randomUUID().toString()
            : requestedTaskId;
    if (tasks.containsKey(taskId)) {
      throw new IllegalStateException("Trace task identity is already in use");
    }
    TraceTransformer transformer =
        new TraceTransformer(
            candidates.classes,
            selection.target,
            selection.method.getName(),
            Type.getMethodDescriptor(selection.method),
            taskId,
            candidates.filter);
    long startedAtEpochMillis = System.currentTimeMillis();
    registerBridge.invoke(
        null,
        taskId,
        Integer.valueOf(maximumTraces),
        Integer.valueOf(maximumDepth),
        Integer.valueOf(maximumSpans),
        Long.valueOf(TimeUnit.MILLISECONDS.toNanos(minimumDurationMillis)));
    RetransformLifecycle.Lease lease = null;
    try {
      lease =
          retransforms.activate(
              "TRACE:" + taskId,
              "TRACE",
              transformer,
              candidates.classes.toArray(
                  new Class<?>[candidates.classes.size()]));
      TraceTask task =
          new TraceTask(
              taskId,
              candidates.classes,
              lease,
              selection.target.getName(),
              selection.method.toGenericString(),
              scopePrefix,
              candidates.filter.getIncludeRulesText(),
              candidates.filter.getExcludeRulesText(),
              candidates.instrumentedMethodCount,
              maximumTraces,
              minimumDurationMillis,
              startedAtEpochMillis,
              timeoutMillis);
      tasks.put(taskId, task);
      scheduler.schedule(
          () -> finish(taskId, "TIMED_OUT"),
          timeoutMillis,
          TimeUnit.MILLISECONDS);
      return new StartResult(
          taskId,
          selection.target.getName(),
          classLoaderName(selection.target),
          selection.method.toGenericString(),
          scopePrefix,
          candidates.filter.getIncludeRulesText(),
          candidates.filter.getExcludeRulesText(),
          classNames(candidates.classes),
          candidates.instrumentedMethodCount,
          startedAtEpochMillis,
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

  TraceBatch events(String taskId, int limit) throws Exception {
    TraceTask task = tasks.get(taskId);
    if (task == null) {
      return TraceBatch.unknown(taskId);
    }
    int captured = bridgeCount(capturedBridge, taskId);
    if (captured >= task.maximumTraces && !task.terminal.get()) {
      finish(taskId, "SUCCEEDED");
    }
    @SuppressWarnings("unchecked")
    List<Object> bridgeTraces =
        (List<Object>) drainBridge.invoke(null, taskId, Integer.valueOf(limit));
    List<TraceSnapshot> traces =
        new ArrayList<TraceSnapshot>(bridgeTraces.size());
    for (Object trace : bridgeTraces) {
      traces.add(toSnapshot(trace));
    }
    return new TraceBatch(
        task.taskId,
        task.state,
        task.rootClassName,
        task.rootMethod,
        task.scopePrefix,
        task.includeRules,
        task.excludeRules,
        task.classes.size(),
        task.instrumentedMethodCount,
        captured,
        task.maximumTraces,
        task.minimumDurationMillis,
        bridgeCount(droppedBridge, taskId),
        traces);
  }

  ThresholdUpdate updateMinimumDuration(
      String taskId, long minimumDurationMillis) throws Exception {
    if (minimumDurationMillis < 0L || minimumDurationMillis > 60_000L) {
      throw new IllegalArgumentException(
          "Trace minimum duration must be between 0 and 60000 milliseconds");
    }
    TraceTask task = tasks.get(taskId);
    if (task == null) {
      return ThresholdUpdate.unknown(taskId);
    }
    if (task.terminal.get()) {
      throw new IllegalStateException(
          "Trace minimum duration can only be updated while the task is running");
    }
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

  String cancel(String taskId) {
    TraceTask task = tasks.get(taskId);
    if (task == null) {
      return "UNKNOWN";
    }
    finish(taskId, "CANCELLED");
    return task.state;
  }

  boolean hasActiveTaskFor(Class<?> target) {
    for (TraceTask task : tasks.values()) {
      if (!task.terminal.get() && task.classes.contains(target)) {
        return true;
      }
    }
    return false;
  }

  List<TaskSnapshot> activeTasks() {
    List<TaskSnapshot> snapshots = new ArrayList<TaskSnapshot>();
    for (TraceTask task : tasks.values()) {
      if (task.terminal.get()) {
        continue;
      }
      int captured = bridgeCount(capturedBridge, task.taskId);
      if (captured >= task.maximumTraces) {
        finish(task.taskId, "SUCCEEDED");
        continue;
      }
      snapshots.add(
          new TaskSnapshot(
              task.taskId,
              task.state,
              task.rootClassName,
              task.rootMethod,
              task.startedAtEpochMillis,
              task.deadlineEpochMillis,
              captured,
              task.maximumTraces,
              bridgeCount(droppedBridge, task.taskId)));
    }
    return snapshots;
  }

  private void ensureNoActiveOverlap(List<Class<?>> candidates) {
    for (TraceTask task : tasks.values()) {
      if (task.terminal.get()) {
        continue;
      }
      for (Class<?> candidate : candidates) {
        if (task.classes.contains(candidate)) {
          throw new IllegalStateException(
              "An active cross-class trace already instruments part of this scope");
        }
      }
    }
  }

  private int bridgeCount(Method bridgeMethod, String taskId) {
    try {
      return ((Integer) bridgeMethod.invoke(null, taskId)).intValue();
    } catch (Exception ignored) {
      return 0;
    }
  }

  private TraceSnapshot toSnapshot(Object trace) throws Exception {
    Class<?> type = trace.getClass();
    @SuppressWarnings("unchecked")
    List<Object> bridgeSpans =
        (List<Object>) type.getMethod("getSpans").invoke(trace);
    List<SpanSnapshot> spans =
        new ArrayList<SpanSnapshot>(bridgeSpans.size());
    for (Object span : bridgeSpans) {
      Class<?> spanType = span.getClass();
      spans.add(
          new SpanSnapshot(
              bridgeLong(spanType, span, "getSequence"),
              bridgeLong(spanType, span, "getParentSequence"),
              ((Integer) spanType.getMethod("getDepth").invoke(span)).intValue(),
              (String) spanType.getMethod("getMethod").invoke(span),
              (String) spanType.getMethod("getSourceFile").invoke(span),
              ((Integer) spanType.getMethod("getSourceLine").invoke(span)).intValue(),
              (String) spanType.getMethod("getCallSiteFile").invoke(span),
              ((Integer) spanType.getMethod("getCallSiteLine").invoke(span)).intValue(),
              bridgeLong(spanType, span, "getDurationNanos"),
              (String) spanType.getMethod("getExceptionType").invoke(span),
              (String) spanType.getMethod("getExceptionMessage").invoke(span)));
    }
    return new TraceSnapshot(
        bridgeLong(type, trace, "getTraceId"),
        bridgeLong(type, trace, "getCapturedAtEpochMillis"),
        bridgeLong(type, trace, "getDurationNanos"),
        bridgeLong(type, trace, "getThreadId"),
        (String) type.getMethod("getThreadName").invoke(trace),
        ((Boolean) type.getMethod("isThreadDaemon").invoke(trace)).booleanValue(),
        ((Integer) type.getMethod("getThreadPriority").invoke(trace)).intValue(),
        (String) type.getMethod("getThreadGroup").invoke(trace),
        (String) type.getMethod("getContextClassLoader").invoke(trace),
        ((Integer) type.getMethod("getTruncatedSpans").invoke(trace)).intValue(),
        spans);
  }

  private static long bridgeLong(
      Class<?> type, Object target, String accessor) throws Exception {
    return ((Long) type.getMethod(accessor).invoke(target)).longValue();
  }

  private void finish(String taskId, String terminalState) {
    TraceTask task = tasks.get(taskId);
    if (task == null || !task.terminal.compareAndSet(false, true)) {
      return;
    }
    try {
      task.lease.rollback();
      task.state = terminalState;
    } catch (Exception exception) {
      task.state = "FAILED";
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
    for (Map.Entry<String, TraceTask> entry : tasks.entrySet()) {
      if (entry.getValue().terminal.get()) {
        cleanupTerminalTask(entry.getKey());
      }
    }
  }

  private void cleanupTerminalTask(String taskId) {
    TraceTask task = tasks.get(taskId);
    if (task == null || !task.terminal.get() || !tasks.remove(taskId, task)) {
      return;
    }
    try {
      unregisterBridge.invoke(null, taskId);
    } catch (Exception ignored) {
      // The task is already detached from application bytecode.
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
    if (target.getClassLoader() == null) {
      throw new IllegalArgumentException(
          "Bootstrap classes cannot be used as cross-class trace roots");
    }
    if (target.isInterface()) {
      throw new IllegalArgumentException(
          "Cross-class trace roots must be concrete classes");
    }
    Method method = findMethod(target, methodName, parameterTypes);
    if (method == null) {
      throw new IllegalArgumentException("The selected method signature was not found");
    }
    if (Modifier.isAbstract(method.getModifiers())
        || Modifier.isNative(method.getModifiers())) {
      throw new IllegalArgumentException(
          "Abstract and native methods cannot be traced");
    }
    if (!instrumentation.isModifiableClass(target)) {
      throw new IllegalStateException("The selected class is not modifiable");
    }
    return new Selection(target, method);
  }

  private CandidateSelection resolveCandidates(
      Class<?> rootClass,
      Method rootMethod,
      String scopePrefix,
      String includeRules,
      String excludeRules) {
    validateScope(rootClass, scopePrefix);
    TracePathFilter filter =
        TracePathFilter.parse(includeRules, excludeRules, scopePrefix);
    ClassLoader rootLoader = rootClass.getClassLoader();
    List<Class<?>> candidates = new ArrayList<Class<?>>();
    int instrumentedMethodCount = 0;
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      String name = type.getName();
      if (type.getClassLoader() != rootLoader
          || !name.startsWith(scopePrefix + ".")
          || name.contains("$$Lambda$")
          || type.isArray()
          || type.isPrimitive()
          || type.isInterface()
          || type.isSynthetic()
          || !instrumentation.isModifiableClass(type)) {
        continue;
      }
      int matchedMethods =
          countInstrumentedMethods(type, rootClass, rootMethod, filter);
      if (matchedMethods == 0) {
        continue;
      }
      candidates.add(type);
      instrumentedMethodCount += matchedMethods;
    }
    candidates.sort(
        (left, right) -> {
          int byName = left.getName().compareTo(right.getName());
          return byName != 0
              ? byName
              : Integer.compare(
                  System.identityHashCode(left),
                  System.identityHashCode(right));
        });
    if (!candidates.contains(rootClass)) {
      throw new IllegalStateException(
          "The selected root class is outside the modifiable trace scope");
    }
    return new CandidateSelection(
        candidates, filter, instrumentedMethodCount);
  }

  private static int countInstrumentedMethods(
      Class<?> type,
      Class<?> rootClass,
      Method rootMethod,
      TracePathFilter filter) {
    try {
      int count = 0;
      for (Method method : type.getDeclaredMethods()) {
        int modifiers = method.getModifiers();
        if (Modifier.isAbstract(modifiers)
            || Modifier.isNative(modifiers)
            || method.isSynthetic()
            || method.isBridge()) {
          continue;
        }
        boolean root =
            type == rootClass
                && method.getName().equals(rootMethod.getName())
                && Type.getMethodDescriptor(method)
                    .equals(Type.getMethodDescriptor(rootMethod));
        if (root || filter.matches(type.getName(), method.getName())) {
          count++;
        }
      }
      return count;
    } catch (LinkageError | SecurityException ignored) {
      return type == rootClass ? 1 : 0;
    }
  }

  private static void validateScope(Class<?> rootClass, String scopePrefix) {
    if (scopePrefix == null
        || scopePrefix.length() < 3
        || scopePrefix.length() > 512
        || scopePrefix.indexOf('.') < 1
        || !rootClass.getName().startsWith(scopePrefix + ".")) {
      throw new IllegalArgumentException(
          "Trace scope must be a package prefix containing the selected root class");
    }
    if (scopePrefix.startsWith("java.")
        || scopePrefix.startsWith("javax.")
        || scopePrefix.startsWith("jdk.")
        || scopePrefix.startsWith("sun.")
        || scopePrefix.startsWith("com.sun.")) {
      throw new IllegalArgumentException("JDK packages cannot be traced");
    }
    String[] segments = scopePrefix.split("\\.");
    for (String segment : segments) {
      if (segment.isEmpty()
          || !Character.isJavaIdentifierStart(segment.charAt(0))) {
        throw new IllegalArgumentException("Trace scope is not a valid package prefix");
      }
      for (int index = 1; index < segment.length(); index++) {
        if (!Character.isJavaIdentifierPart(segment.charAt(index))) {
          throw new IllegalArgumentException(
              "Trace scope is not a valid package prefix");
        }
      }
    }
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

  private static List<String> classNames(List<Class<?>> classes) {
    List<String> names = new ArrayList<String>(classes.size());
    for (Class<?> type : classes) {
      names.add(type.getName());
    }
    return Collections.unmodifiableList(names);
  }

  private static void validateBounds(
      int maximumTraces,
      int maximumDepth,
      int maximumSpans,
      long minimumDurationMillis,
      long timeoutMillis) {
    if (maximumTraces < 1 || maximumTraces > 20) {
      throw new IllegalArgumentException("maximumTraces must be between 1 and 20");
    }
    if (maximumDepth < 1 || maximumDepth > 32) {
      throw new IllegalArgumentException("maximumDepth must be between 1 and 32");
    }
    if (maximumSpans < 16 || maximumSpans > 512) {
      throw new IllegalArgumentException("maximumSpans must be between 16 and 512");
    }
    if (minimumDurationMillis < 0L || minimumDurationMillis > 60_000L) {
      throw new IllegalArgumentException(
          "minimumDurationMillis must be between 0 and 60000");
    }
    if (timeoutMillis < 1_000L || timeoutMillis > 60_000L) {
      throw new IllegalArgumentException("timeoutMillis must be between 1000 and 60000");
    }
  }

  @Override
  public void close() {
    for (String taskId : new ArrayList<String>(tasks.keySet())) {
      finish(taskId, "CANCELLED");
    }
  }

  static class Preview {
    private final String className;
    private final String classLoader;
    private final String method;
    private final String scopePrefix;
    private final String includeRules;
    private final String excludeRules;
    private final List<String> classes;
    private final int instrumentedMethodCount;
    private final boolean withinLimit;

    private Preview(
        String className,
        String classLoader,
        String method,
        String scopePrefix,
        String includeRules,
        String excludeRules,
        List<String> classes,
        int instrumentedMethodCount,
        boolean withinLimit) {
      this.className = className;
      this.classLoader = classLoader;
      this.method = method;
      this.scopePrefix = scopePrefix;
      this.includeRules = includeRules;
      this.excludeRules = excludeRules;
      this.classes = classes;
      this.instrumentedMethodCount = instrumentedMethodCount;
      this.withinLimit = withinLimit;
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

    String getScopePrefix() {
      return scopePrefix;
    }

    String getIncludeRules() {
      return includeRules;
    }

    String getExcludeRules() {
      return excludeRules;
    }

    List<String> getClasses() {
      return classes;
    }

    int getInstrumentedMethodCount() {
      return instrumentedMethodCount;
    }

    boolean isWithinLimit() {
      return withinLimit;
    }
  }

  static final class StartResult extends Preview {
    private final String taskId;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;

    private StartResult(
        String taskId,
        String className,
        String classLoader,
        String method,
        String scopePrefix,
        String includeRules,
        String excludeRules,
        List<String> classes,
        int instrumentedMethodCount,
        long startedAtEpochMillis,
        long deadlineEpochMillis) {
      super(
          className,
          classLoader,
          method,
          scopePrefix,
          includeRules,
          excludeRules,
          classes,
          instrumentedMethodCount,
          true);
      this.taskId = taskId;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
    }

    String getTaskId() {
      return taskId;
    }

    long getStartedAtEpochMillis() {
      return startedAtEpochMillis;
    }

    long getDeadlineEpochMillis() {
      return deadlineEpochMillis;
    }
  }

  static final class TaskSnapshot {
    private final String taskId;
    private final String state;
    private final String className;
    private final String method;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final int captured;
    private final int maximumTraces;
    private final int dropped;

    private TaskSnapshot(
        String taskId,
        String state,
        String className,
        String method,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        int captured,
        int maximumTraces,
        int dropped) {
      this.taskId = taskId;
      this.state = state;
      this.className = className;
      this.method = method;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.captured = captured;
      this.maximumTraces = maximumTraces;
      this.dropped = dropped;
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

    int getCaptured() {
      return captured;
    }

    int getMaximumTraces() {
      return maximumTraces;
    }

    int getDropped() {
      return dropped;
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

    private static ThresholdUpdate unknown(String taskId) {
      return new ThresholdUpdate(taskId, "UNKNOWN", 0L, 0L);
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

  static final class TraceBatch {
    private final String taskId;
    private final String state;
    private final String rootClassName;
    private final String rootMethod;
    private final String scopePrefix;
    private final String includeRules;
    private final String excludeRules;
    private final int classCount;
    private final int instrumentedMethodCount;
    private final int captured;
    private final int maximumTraces;
    private final long minimumDurationMillis;
    private final int dropped;
    private final List<TraceSnapshot> traces;

    private TraceBatch(
        String taskId,
        String state,
        String rootClassName,
        String rootMethod,
        String scopePrefix,
        String includeRules,
        String excludeRules,
        int classCount,
        int instrumentedMethodCount,
        int captured,
        int maximumTraces,
        long minimumDurationMillis,
        int dropped,
        List<TraceSnapshot> traces) {
      this.taskId = taskId;
      this.state = state;
      this.rootClassName = rootClassName;
      this.rootMethod = rootMethod;
      this.scopePrefix = scopePrefix;
      this.includeRules = includeRules;
      this.excludeRules = excludeRules;
      this.classCount = classCount;
      this.instrumentedMethodCount = instrumentedMethodCount;
      this.captured = captured;
      this.maximumTraces = maximumTraces;
      this.minimumDurationMillis = minimumDurationMillis;
      this.dropped = dropped;
      this.traces = Collections.unmodifiableList(traces);
    }

    private static TraceBatch unknown(String taskId) {
      return new TraceBatch(
          taskId,
          "UNKNOWN",
          "",
          "",
          "",
          "",
          "",
          0,
          0,
          0,
          0,
          0L,
          0,
          Collections.<TraceSnapshot>emptyList());
    }

    String getTaskId() {
      return taskId;
    }

    String getState() {
      return state;
    }

    String getRootClassName() {
      return rootClassName;
    }

    String getRootMethod() {
      return rootMethod;
    }

    String getScopePrefix() {
      return scopePrefix;
    }

    String getIncludeRules() {
      return includeRules;
    }

    String getExcludeRules() {
      return excludeRules;
    }

    int getClassCount() {
      return classCount;
    }

    int getInstrumentedMethodCount() {
      return instrumentedMethodCount;
    }

    int getCaptured() {
      return captured;
    }

    int getMaximumTraces() {
      return maximumTraces;
    }

    long getMinimumDurationMillis() {
      return minimumDurationMillis;
    }

    int getDropped() {
      return dropped;
    }

    List<TraceSnapshot> getTraces() {
      return traces;
    }
  }

  static final class TraceSnapshot {
    private final long traceId;
    private final long capturedAtEpochMillis;
    private final long durationNanos;
    private final long threadId;
    private final String threadName;
    private final boolean threadDaemon;
    private final int threadPriority;
    private final String threadGroup;
    private final String contextClassLoader;
    private final int truncatedSpans;
    private final List<SpanSnapshot> spans;

    private TraceSnapshot(
        long traceId,
        long capturedAtEpochMillis,
        long durationNanos,
        long threadId,
        String threadName,
        boolean threadDaemon,
        int threadPriority,
        String threadGroup,
        String contextClassLoader,
        int truncatedSpans,
        List<SpanSnapshot> spans) {
      this.traceId = traceId;
      this.capturedAtEpochMillis = capturedAtEpochMillis;
      this.durationNanos = durationNanos;
      this.threadId = threadId;
      this.threadName = threadName;
      this.threadDaemon = threadDaemon;
      this.threadPriority = threadPriority;
      this.threadGroup = threadGroup;
      this.contextClassLoader = contextClassLoader;
      this.truncatedSpans = truncatedSpans;
      this.spans = Collections.unmodifiableList(spans);
    }

    long getTraceId() {
      return traceId;
    }

    long getCapturedAtEpochMillis() {
      return capturedAtEpochMillis;
    }

    long getDurationNanos() {
      return durationNanos;
    }

    String getThreadName() {
      return threadName;
    }

    long getThreadId() {
      return threadId;
    }

    boolean isThreadDaemon() {
      return threadDaemon;
    }

    int getThreadPriority() {
      return threadPriority;
    }

    String getThreadGroup() {
      return threadGroup;
    }

    String getContextClassLoader() {
      return contextClassLoader;
    }

    int getTruncatedSpans() {
      return truncatedSpans;
    }

    List<SpanSnapshot> getSpans() {
      return spans;
    }
  }

  static final class SpanSnapshot {
    private final long sequence;
    private final long parentSequence;
    private final int depth;
    private final String method;
    private final String sourceFile;
    private final int sourceLine;
    private final String callSiteFile;
    private final int callSiteLine;
    private final long durationNanos;
    private final String exceptionType;
    private final String exceptionMessage;

    private SpanSnapshot(
        long sequence,
        long parentSequence,
        int depth,
        String method,
        String sourceFile,
        int sourceLine,
        String callSiteFile,
        int callSiteLine,
        long durationNanos,
        String exceptionType,
        String exceptionMessage) {
      this.sequence = sequence;
      this.parentSequence = parentSequence;
      this.depth = depth;
      this.method = method;
      this.sourceFile = sourceFile;
      this.sourceLine = sourceLine;
      this.callSiteFile = callSiteFile;
      this.callSiteLine = callSiteLine;
      this.durationNanos = durationNanos;
      this.exceptionType = exceptionType;
      this.exceptionMessage = exceptionMessage;
    }

    long getSequence() {
      return sequence;
    }

    long getParentSequence() {
      return parentSequence;
    }

    int getDepth() {
      return depth;
    }

    String getMethod() {
      return method;
    }

    String getSourceFile() {
      return sourceFile;
    }

    int getSourceLine() {
      return sourceLine;
    }

    String getCallSiteFile() {
      return callSiteFile;
    }

    int getCallSiteLine() {
      return callSiteLine;
    }

    long getDurationNanos() {
      return durationNanos;
    }

    String getExceptionType() {
      return exceptionType;
    }

    String getExceptionMessage() {
      return exceptionMessage;
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

  private static final class CandidateSelection {
    private final List<Class<?>> classes;
    private final TracePathFilter filter;
    private final int instrumentedMethodCount;

    private CandidateSelection(
        List<Class<?>> classes,
        TracePathFilter filter,
        int instrumentedMethodCount) {
      this.classes = classes;
      this.filter = filter;
      this.instrumentedMethodCount = instrumentedMethodCount;
    }
  }

  private static final class TraceTask {
    private final String taskId;
    private final List<Class<?>> classes;
    private final RetransformLifecycle.Lease lease;
    private final String rootClassName;
    private final String rootMethod;
    private final String scopePrefix;
    private final String includeRules;
    private final String excludeRules;
    private final int instrumentedMethodCount;
    private final int maximumTraces;
    private volatile long minimumDurationMillis;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final AtomicBoolean terminal = new AtomicBoolean();
    private volatile String state = "RUNNING";

    private TraceTask(
        String taskId,
        List<Class<?>> classes,
        RetransformLifecycle.Lease lease,
        String rootClassName,
        String rootMethod,
        String scopePrefix,
        String includeRules,
        String excludeRules,
        int instrumentedMethodCount,
        int maximumTraces,
        long minimumDurationMillis,
        long startedAtEpochMillis,
        long timeoutMillis) {
      this.taskId = taskId;
      this.classes =
          Collections.unmodifiableList(new ArrayList<Class<?>>(classes));
      this.lease = lease;
      this.rootClassName = rootClassName;
      this.rootMethod = rootMethod;
      this.scopePrefix = scopePrefix;
      this.includeRules = includeRules;
      this.excludeRules = excludeRules;
      this.instrumentedMethodCount = instrumentedMethodCount;
      this.maximumTraces = maximumTraces;
      this.minimumDurationMillis = minimumDurationMillis;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = startedAtEpochMillis + timeoutMillis;
    }
  }

  private static final class TraceTransformer
      implements ClassFileTransformer {
    private final Set<Class<?>> targets;
    private final Class<?> rootTarget;
    private final String rootMethodName;
    private final String rootMethodDescriptor;
    private final String taskId;
    private final TracePathFilter filter;
    private final Set<String> instrumentedMethods;

    private TraceTransformer(
        List<Class<?>> targets,
        Class<?> rootTarget,
        String rootMethodName,
        String rootMethodDescriptor,
        String taskId,
        TracePathFilter filter) {
      Set<Class<?>> identities =
          Collections.newSetFromMap(new IdentityHashMap<Class<?>, Boolean>());
      identities.addAll(targets);
      this.targets = identities;
      this.rootTarget = rootTarget;
      this.rootMethodName = rootMethodName;
      this.rootMethodDescriptor = rootMethodDescriptor;
      this.taskId = taskId;
      this.filter = filter;
      this.instrumentedMethods =
          instrumentedMethodIdentities(
              targets,
              rootTarget,
              rootMethodName,
              rootMethodDescriptor,
              filter);
    }

    @Override
    public byte[] transform(
        ClassLoader loader,
        String className,
        Class<?> classBeingRedefined,
        ProtectionDomain protectionDomain,
        byte[] classfileBuffer)
        throws IllegalClassFormatException {
      if (classBeingRedefined == null || !targets.contains(classBeingRedefined)) {
        return null;
      }
      try {
        ClassReader reader = new ClassReader(classfileBuffer);
        ClassWriter writer = new LoaderAwareClassWriter(reader, loader);
        String owner = classBeingRedefined.getName();
        Map<String, Integer> firstLines = firstSourceLines(reader);
        ClassVisitor visitor =
            new ClassVisitor(Opcodes.ASM9, writer) {
              private String sourceFile = "";

              @Override
              public void visitSource(String source, String debug) {
                sourceFile = source == null ? "" : source;
                super.visitSource(source, debug);
              }

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
                if (name.startsWith("<")
                    || (access
                            & (Opcodes.ACC_ABSTRACT
                                | Opcodes.ACC_NATIVE
                                | Opcodes.ACC_SYNTHETIC
                                | Opcodes.ACC_BRIDGE))
                        != 0) {
                  return delegate;
                }
                boolean root =
                    classBeingRedefined == rootTarget
                        && rootMethodName.equals(name)
                        && rootMethodDescriptor.equals(descriptor);
                if (!root && !filter.matches(owner, name)) {
                  return delegate;
                }
                return new TraceAdvice(
                    delegate,
                    access,
                    name,
                    descriptor,
                    taskId,
                    owner + "#" + name + descriptor,
                    sourceFile,
                    firstLines.getOrDefault(name + descriptor, Integer.valueOf(-1)),
                    instrumentedMethods,
                    root);
              }
            };
        reader.accept(visitor, ClassReader.EXPAND_FRAMES);
        return writer.toByteArray();
      } catch (RuntimeException exception) {
        throw new IllegalClassFormatException(exception.getMessage());
      }
    }

    private static Map<String, Integer> firstSourceLines(ClassReader reader) {
      Map<String, Integer> lines = new HashMap<String, Integer>();
      reader.accept(
          new ClassVisitor(Opcodes.ASM9) {
            @Override
            public MethodVisitor visitMethod(
                int access,
                String name,
                String descriptor,
                String signature,
                String[] exceptions) {
              String identity = name + descriptor;
              return new MethodVisitor(Opcodes.ASM9) {
                @Override
                public void visitLineNumber(int line, Label start) {
                  if (!lines.containsKey(identity)) {
                    lines.put(identity, Integer.valueOf(line));
                  }
                }
              };
            }
          },
          ClassReader.SKIP_FRAMES);
      return lines;
    }

    private static Set<String> instrumentedMethodIdentities(
        List<Class<?>> targets,
        Class<?> rootTarget,
        String rootMethodName,
        String rootMethodDescriptor,
        TracePathFilter filter) {
      Set<String> result = new HashSet<String>();
      for (Class<?> target : targets) {
        try {
          for (Method method : target.getDeclaredMethods()) {
            int modifiers = method.getModifiers();
            if (Modifier.isAbstract(modifiers)
                || Modifier.isNative(modifiers)
                || method.isSynthetic()
                || method.isBridge()) {
              continue;
            }
            String descriptor = Type.getMethodDescriptor(method);
            boolean root =
                target == rootTarget
                    && rootMethodName.equals(method.getName())
                    && rootMethodDescriptor.equals(descriptor);
            if (root || filter.matches(target.getName(), method.getName())) {
              result.add(
                  Type.getInternalName(target)
                      + '#'
                      + method.getName()
                      + descriptor);
            }
          }
        } catch (LinkageError | SecurityException ignored) {
          // Candidate selection already applies the same defensive boundary.
        }
      }
      return Collections.unmodifiableSet(result);
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

  private static final class TraceAdvice extends AdviceAdapter {
    private final String taskId;
    private final String methodIdentity;
    private final String sourceFile;
    private final int sourceLine;
    private final Set<String> instrumentedMethods;
    private final boolean root;
    private final Label tryStart = new Label();
    private final Label tryEnd = new Label();
    private int tokenLocal;
    private int currentLine = -1;

    private TraceAdvice(
        MethodVisitor delegate,
        int access,
        String name,
        String descriptor,
        String taskId,
        String methodIdentity,
        String sourceFile,
        int sourceLine,
        Set<String> instrumentedMethods,
        boolean root) {
      super(Opcodes.ASM9, delegate, access, name, descriptor);
      this.taskId = taskId;
      this.methodIdentity = methodIdentity;
      this.sourceFile = sourceFile;
      this.sourceLine = sourceLine;
      this.instrumentedMethods = instrumentedMethods;
      this.root = root;
    }

    @Override
    public void visitLineNumber(int line, Label start) {
      currentLine = line;
      super.visitLineNumber(line, start);
    }

    @Override
    public void visitMethodInsn(
        int opcode,
        String owner,
        String name,
        String descriptor,
        boolean isInterface) {
      if (instrumentedMethods.contains(owner + '#' + name + descriptor)) {
        push(taskId);
        push(sourceFile);
        push(currentLine);
        invokeStatic(BRIDGE_TYPE, CALL_SITE_METHOD);
      }
      super.visitMethodInsn(opcode, owner, name, descriptor, isInterface);
    }

    @Override
    protected void onMethodEnter() {
      push(taskId);
      push(methodIdentity);
      push(root);
      push(sourceFile);
      push(sourceLine);
      invokeStatic(BRIDGE_TYPE, ENTER_METHOD);
      tokenLocal = newLocal(Type.LONG_TYPE);
      storeLocal(tokenLocal);
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
      loadLocal(tokenLocal);
      if (throwableLocal < 0) {
        visitInsn(Opcodes.ACONST_NULL);
      } else {
        loadLocal(throwableLocal);
      }
      invokeStatic(BRIDGE_TYPE, EXIT_METHOD);
    }
  }
}
