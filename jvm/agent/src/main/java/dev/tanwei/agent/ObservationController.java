package dev.tanwei.agent;

import dev.tanwei.protocol.v1.ObservationEvent;
import dev.tanwei.protocol.v1.ObservationEventsResponse;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.IllegalClassFormatException;
import java.lang.instrument.Instrumentation;
import java.lang.ref.WeakReference;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.commons.AdviceAdapter;

final class ObservationController implements AutoCloseable {
  private static final int MAXIMUM_TASKS = 32;
  private static final long TERMINAL_RETENTION_MILLIS = 60_000L;
  private static final Type BRIDGE_TYPE =
      Type.getObjectType("dev/tanwei/bootstrap/ObservationBridge");
  private static final org.objectweb.asm.commons.Method ENTER_METHOD =
      new org.objectweb.asm.commons.Method(
          "enter",
          "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Object;[Ljava/lang/Object;)J");
  private static final org.objectweb.asm.commons.Method EXIT_METHOD =
      new org.objectweb.asm.commons.Method(
          "exit", "(Ljava/lang/String;JLjava/lang/Object;Ljava/lang/Throwable;)V");

  private final Instrumentation instrumentation;
  private final RetransformLifecycle retransforms;
  private final ScheduledExecutorService scheduler;
  private final Map<String, ObservationTask> tasks =
      new ConcurrentHashMap<String, ObservationTask>();
  private final SnapshotArchive snapshotArchive = new SnapshotArchive();
  private final Method registerBridge;
  private final Method unregisterBridge;
  private final Method drainBridge;
  private final Method capturedBridge;
  private final Method droppedBridge;
  private final Method inspectReceiverStateBridge;

  ObservationController(
      Instrumentation instrumentation,
      ScheduledExecutorService scheduler,
      RetransformLifecycle retransforms)
      throws ReflectiveOperationException {
    this.instrumentation = instrumentation;
    this.scheduler = scheduler;
    this.retransforms = retransforms;
    Class<?> bridge =
        Class.forName(
            "dev.tanwei.bootstrap.ObservationBridge",
            true,
            ClassLoader.getSystemClassLoader());
    registerBridge =
        bridge.getMethod(
            "register",
            String.class,
            int.class,
            String.class,
            String.class,
            String.class);
    unregisterBridge = bridge.getMethod("unregister", String.class);
    drainBridge = bridge.getMethod("drain", String.class, int.class);
    capturedBridge = bridge.getMethod("captured", String.class);
    droppedBridge = bridge.getMethod("dropped", String.class);
    inspectReceiverStateBridge =
        bridge.getMethod("inspectReceiverState", Object.class);
  }

  StartResult start(
      String requestedTaskId,
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      int maximumEvents,
      long timeoutMillis,
      boolean includeInternal,
      String condition,
      String phases)
      throws Exception {
    purgeTerminalTasks();
    if (tasks.size() >= MAXIMUM_TASKS) {
      throw new IllegalStateException("Too many observation tasks are retained");
    }
    Selection selection =
        resolveSelection(className, classLoader, methodName, parameterTypes);
    Class<?> target = selection.target;
    Method method = selection.method;

    String taskId =
        requestedTaskId == null || requestedTaskId.isEmpty()
            ? UUID.randomUUID().toString()
            : requestedTaskId;
    String rootMethod = method.getName() + Type.getMethodDescriptor(method);
    ObservationTransformer transformer =
        new ObservationTransformer(
            target,
            method.getName(),
            Type.getMethodDescriptor(method),
            taskId,
            includeInternal);
    registerBridge.invoke(
        null,
        taskId,
        maximumEvents,
        rootMethod,
        condition == null ? "" : condition,
        phases == null ? "FINISH" : phases);
    RetransformLifecycle.Lease lease = null;
    try {
      lease =
          retransforms.activate(
              "WATCH:" + taskId, "WATCH", transformer, target);
      ObservationTask task =
          new ObservationTask(
              taskId,
              target,
              lease,
              method.toGenericString(),
              classLoaderName(target),
              method.getName(),
              joinParameterTypes(method),
              Modifier.toString(method.getModifiers()),
              maximumEvents,
              System.currentTimeMillis(),
              timeoutMillis);
      tasks.put(taskId, task);
      scheduler.schedule(
          () -> finish(taskId, "TIMED_OUT"),
          timeoutMillis,
          TimeUnit.MILLISECONDS);
      return new StartResult(taskId, target.getName(), method.toGenericString());
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
        selection.method.toGenericString());
  }

  ObservationEventsResponse events(String taskId, int limit) throws Exception {
    ObservationTask task = tasks.get(taskId);
    if (task == null) {
      return ObservationEventsResponse.newBuilder()
          .setTaskId(taskId)
          .setState("UNKNOWN")
          .build();
    }
    int captured = ((Integer) capturedBridge.invoke(null, taskId)).intValue();
    if (captured >= task.maximumEvents && "RUNNING".equals(task.state)) {
      finish(taskId, "SUCCEEDED");
    }
    @SuppressWarnings("unchecked")
    List<Object> bridgeEvents =
        (List<Object>) drainBridge.invoke(null, taskId, limit);
    ObservationEventsResponse.Builder response =
        ObservationEventsResponse.newBuilder()
            .setTaskId(taskId)
            .setState(task.state)
            .setCaptured(captured)
            .setDropped(
                ((Integer) droppedBridge.invoke(null, taskId)).intValue());
    for (Object event : bridgeEvents) {
      ObservationEvent protocolEvent = toProtocolEvent(event);
      archive(
          task,
          protocolEvent,
          receiverReference(event),
          receiverType(event),
          parseReceiverState(
              event.getClass().getMethod("getReceiverState").invoke(event)),
          parseInvocationValues(
              event.getClass().getMethod("getInvocationValues").invoke(event)));
      response.addEvents(protocolEvent);
    }
    return response.build();
  }

  SnapshotArchive.Page snapshots(
      String query, String outcome, String scope, int offset, int limit) {
    return snapshotArchive.list(query, outcome, scope, offset, limit);
  }

  SnapshotArchive.Page snapshots(SnapshotArchive.Filter filter) {
    return snapshotArchive.list(filter);
  }

  SnapshotArchive.Snapshot snapshot(long snapshotId) {
    return snapshotArchive.find(snapshotId);
  }

  boolean deleteSnapshot(long snapshotId) {
    return snapshotArchive.delete(snapshotId);
  }

  ReceiverStateSnapshot receiverState(Object receiver) {
    if (receiver == null) {
      return ReceiverStateSnapshot.empty();
    }
    try {
      return parseReceiverState(
          inspectReceiverStateBridge.invoke(null, receiver));
    } catch (Exception ignored) {
      return ReceiverStateSnapshot.unavailable();
    }
  }

  String cancel(String taskId) {
    ObservationTask task = tasks.get(taskId);
    if (task == null) {
      return "UNKNOWN";
    }
    finish(taskId, "CANCELLED");
    return task.state;
  }

  boolean hasActiveTaskFor(Class<?> target) {
    for (ObservationTask task : tasks.values()) {
      if (task.target == target && !task.terminal.get()) {
        return true;
      }
    }
    return false;
  }

  List<TaskSnapshot> activeTasks() {
    List<TaskSnapshot> snapshots = new ArrayList<TaskSnapshot>();
    for (ObservationTask task : tasks.values()) {
      if (task.terminal.get()) {
        continue;
      }
      int captured = bridgeCount(capturedBridge, task.taskId);
      if (captured >= task.maximumEvents) {
        finish(task.taskId, "SUCCEEDED");
        continue;
      }
      snapshots.add(
          new TaskSnapshot(
              task.taskId,
              task.target.getName(),
              task.method,
              task.state,
              task.startedAtEpochMillis,
              task.deadlineEpochMillis,
              captured,
              task.maximumEvents,
              bridgeCount(droppedBridge, task.taskId)));
    }
    return snapshots;
  }

  private int bridgeCount(Method bridgeMethod, String taskId) {
    try {
      return ((Integer) bridgeMethod.invoke(null, taskId)).intValue();
    } catch (Exception ignored) {
      return 0;
    }
  }

  private void finish(String taskId, String terminalState) {
    ObservationTask task = tasks.get(taskId);
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
    for (Map.Entry<String, ObservationTask> entry : tasks.entrySet()) {
      if (entry.getValue().terminal.get()) {
        cleanupTerminalTask(entry.getKey());
      }
    }
  }

  private void cleanupTerminalTask(String taskId) {
    ObservationTask task = tasks.get(taskId);
    if (task == null || !task.terminal.get() || !tasks.remove(taskId, task)) {
      return;
    }
    archiveRemaining(task);
    try {
      unregisterBridge.invoke(null, taskId);
    } catch (Exception ignored) {
      // A terminal task is already detached from application bytecode.
    }
  }

  private ObservationEvent toProtocolEvent(Object event) throws Exception {
    Class<?> type = event.getClass();
    @SuppressWarnings("unchecked")
    List<String> arguments =
        (List<String>) type.getMethod("getArguments").invoke(event);
    @SuppressWarnings("unchecked")
    List<String> callStack =
        (List<String>) type.getMethod("getCallStack").invoke(event);
    return ObservationEvent.newBuilder()
        .setEventId(((Long) type.getMethod("getEventId").invoke(event)).longValue())
        .setSequence(((Long) type.getMethod("getSequence").invoke(event)).longValue())
        .setParentSequence(
            ((Long) type.getMethod("getParentSequence").invoke(event)).longValue())
        .setDepth(((Integer) type.getMethod("getDepth").invoke(event)).intValue())
        .setMethod((String) type.getMethod("getMethod").invoke(event))
        .setPhase((String) type.getMethod("getPhase").invoke(event))
        .setCapturedAtEpochMillis(
            ((Long) type.getMethod("getCapturedAtEpochMillis").invoke(event))
                .longValue())
        .setDurationNanos(
            ((Long) type.getMethod("getDurationNanos").invoke(event)).longValue())
        .setThreadName((String) type.getMethod("getThreadName").invoke(event))
        .addAllArguments(arguments)
        .addAllCallStack(callStack)
        .setReturnValue((String) type.getMethod("getReturnValue").invoke(event))
        .setExceptionType((String) type.getMethod("getExceptionType").invoke(event))
        .setExceptionMessage(
            (String) type.getMethod("getExceptionMessage").invoke(event))
        .build();
  }

  private static WeakReference<Object> receiverReference(Object event)
      throws ReflectiveOperationException {
    Object reference =
        event.getClass().getMethod("getReceiverReference").invoke(event);
    if (reference == null) {
      return null;
    }
    if (!(reference instanceof WeakReference<?>)) {
      throw new IllegalArgumentException("Observation receiver reference is invalid");
    }
    @SuppressWarnings("unchecked")
    WeakReference<Object> typed = (WeakReference<Object>) reference;
    return typed;
  }

  private static String receiverType(Object event)
      throws ReflectiveOperationException {
    Object value = event.getClass().getMethod("getReceiverType").invoke(event);
    return value instanceof String ? (String) value : "";
  }

  private static ReceiverStateSnapshot parseReceiverState(Object source)
      throws ReflectiveOperationException {
    if (source == null) {
      return ReceiverStateSnapshot.unavailable();
    }
    Class<?> type = source.getClass();
    boolean available =
        ((Boolean) type.getMethod("isAvailable").invoke(source)).booleanValue();
    int scannedFields =
        ((Integer) type.getMethod("getScannedFields").invoke(source)).intValue();
    int unavailableFields =
        ((Integer) type.getMethod("getUnavailableFields").invoke(source)).intValue();
    boolean truncated =
        ((Boolean) type.getMethod("isTruncated").invoke(source)).booleanValue();
    List<String> names = stringList(type.getMethod("getNames").invoke(source));
    List<String> values = stringList(type.getMethod("getValues").invoke(source));
    return ReceiverStateSnapshot.of(
        available,
        scannedFields,
        unavailableFields,
        truncated,
        names,
        values);
  }

  private static List<String> stringList(Object source) {
    if (!(source instanceof List<?>)) {
      throw new IllegalArgumentException("Receiver state list is invalid");
    }
    List<?> raw = (List<?>) source;
    List<String> values = new ArrayList<String>(raw.size());
    for (Object item : raw) {
      if (!(item instanceof String)) {
        throw new IllegalArgumentException("Receiver state value is invalid");
      }
      values.add((String) item);
    }
    return values;
  }

  private static InvocationValueSnapshot parseInvocationValues(Object source)
      throws ReflectiveOperationException {
    if (source == null) {
      return InvocationValueSnapshot.unavailable();
    }
    Class<?> type = source.getClass();
    boolean available =
        ((Boolean) type.getMethod("isAvailable").invoke(source)).booleanValue();
    int scannedFields =
        ((Integer) type.getMethod("getScannedFields").invoke(source)).intValue();
    boolean truncated =
        ((Boolean) type.getMethod("isTruncated").invoke(source)).booleanValue();
    Object rawNodes = type.getMethod("getNodes").invoke(source);
    if (!(rawNodes instanceof List<?>)) {
      throw new IllegalArgumentException("Invocation value nodes are invalid");
    }
    List<?> nodes = (List<?>) rawNodes;
    List<String> paths = new ArrayList<String>(nodes.size());
    List<Integer> parentIndices = new ArrayList<Integer>(nodes.size());
    List<Integer> depths = new ArrayList<Integer>(nodes.size());
    List<String> kinds = new ArrayList<String>(nodes.size());
    List<String> typeNames = new ArrayList<String>(nodes.size());
    List<String> values = new ArrayList<String>(nodes.size());
    List<Integer> childCounts = new ArrayList<Integer>(nodes.size());
    List<Boolean> nodeTruncated = new ArrayList<Boolean>(nodes.size());
    for (Object node : nodes) {
      if (node == null) {
        throw new IllegalArgumentException("Invocation value node is required");
      }
      Class<?> nodeType = node.getClass();
      paths.add((String) nodeType.getMethod("getPath").invoke(node));
      parentIndices.add(
          (Integer) nodeType.getMethod("getParentIndex").invoke(node));
      depths.add((Integer) nodeType.getMethod("getDepth").invoke(node));
      kinds.add((String) nodeType.getMethod("getKind").invoke(node));
      typeNames.add((String) nodeType.getMethod("getTypeName").invoke(node));
      values.add((String) nodeType.getMethod("getValue").invoke(node));
      childCounts.add(
          (Integer) nodeType.getMethod("getChildCount").invoke(node));
      nodeTruncated.add(
          (Boolean) nodeType.getMethod("isTruncated").invoke(node));
    }
    return InvocationValueSnapshot.of(
        available,
        scannedFields,
        truncated,
        paths,
        parentIndices,
        depths,
        kinds,
        typeNames,
        values,
        childCounts,
        nodeTruncated);
  }

  private void archive(
      ObservationTask task,
      ObservationEvent event,
      WeakReference<Object> receiverReference,
      String receiverType,
      ReceiverStateSnapshot receiverState,
      InvocationValueSnapshot invocationValues) {
    snapshotArchive.record(
        task.taskId,
        task.target.getName(),
        task.classLoader,
        task.rootMethodName,
        task.parameterTypes,
        task.modifiers,
        event,
        receiverReference,
        receiverType,
        receiverState,
        invocationValues);
  }

  private void archiveRemaining(ObservationTask task) {
    try {
      @SuppressWarnings("unchecked")
      List<Object> remaining =
          (List<Object>) drainBridge.invoke(null, task.taskId, task.maximumEvents);
      for (Object event : remaining) {
        try {
          archive(
              task,
              toProtocolEvent(event),
              receiverReference(event),
              receiverType(event),
              parseReceiverState(
                  event.getClass().getMethod("getReceiverState").invoke(event)),
              parseInvocationValues(
                  event.getClass().getMethod("getInvocationValues").invoke(event)));
        } catch (Exception ignored) {
          // One malformed event must not prevent retention of other snapshots.
        }
      }
    } catch (Exception ignored) {
      // Terminal cleanup must always be able to unregister the bridge.
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
      throw new IllegalArgumentException("Abstract and native methods cannot be observed");
    }
    if (!instrumentation.isModifiableClass(target)) {
      throw new IllegalStateException("The selected class is not modifiable");
    }
    return new Selection(target, method);
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
      ObservationTask task = tasks.get(taskId);
      if (task != null) {
        archiveRemaining(task);
      }
      try {
        unregisterBridge.invoke(null, taskId);
      } catch (Exception ignored) {
        // Shutdown still removes all registered transformers.
      }
    }
    tasks.clear();
    snapshotArchive.clear();
  }

  static final class StartResult {
    private final String taskId;
    private final String className;
    private final String method;

    private StartResult(String taskId, String className, String method) {
      this.taskId = taskId;
      this.className = className;
      this.method = method;
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
  }

  static final class TaskSnapshot {
    private final String taskId;
    private final String className;
    private final String method;
    private final String state;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final int captured;
    private final int maximumEvents;
    private final int dropped;

    private TaskSnapshot(
        String taskId,
        String className,
        String method,
        String state,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        int captured,
        int maximumEvents,
        int dropped) {
      this.taskId = taskId;
      this.className = className;
      this.method = method;
      this.state = state;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.captured = captured;
      this.maximumEvents = maximumEvents;
      this.dropped = dropped;
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

    int getCaptured() {
      return captured;
    }

    int getMaximumEvents() {
      return maximumEvents;
    }

    int getDropped() {
      return dropped;
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

  private static final class ObservationTask {
    private final String taskId;
    private final Class<?> target;
    private final RetransformLifecycle.Lease lease;
    private final String method;
    private final String classLoader;
    private final String rootMethodName;
    private final String parameterTypes;
    private final String modifiers;
    private final int maximumEvents;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final AtomicBoolean terminal = new AtomicBoolean();
    private volatile String state = "RUNNING";

    private ObservationTask(
        String taskId,
        Class<?> target,
        RetransformLifecycle.Lease lease,
        String method,
        String classLoader,
        String rootMethodName,
        String parameterTypes,
        String modifiers,
        int maximumEvents,
        long startedAtEpochMillis,
        long timeoutMillis) {
      this.taskId = taskId;
      this.target = target;
      this.lease = lease;
      this.method = method;
      this.classLoader = classLoader;
      this.rootMethodName = rootMethodName;
      this.parameterTypes = parameterTypes;
      this.modifiers = modifiers;
      this.maximumEvents = maximumEvents;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = startedAtEpochMillis + timeoutMillis;
    }
  }

  private static final class ObservationTransformer
      implements ClassFileTransformer {
    private final Class<?> target;
    private final String methodName;
    private final String methodDescriptor;
    private final String taskId;
    private final boolean includeInternal;

    private ObservationTransformer(
        Class<?> target,
        String methodName,
        String methodDescriptor,
        String taskId,
        boolean includeInternal) {
      this.target = target;
      this.methodName = methodName;
      this.methodDescriptor = methodDescriptor;
      this.taskId = taskId;
      this.includeInternal = includeInternal;
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
                boolean rootMethod =
                    methodName.equals(name) && methodDescriptor.equals(descriptor);
                boolean internalMethod =
                    includeInternal
                        && !name.startsWith("<")
                        && (access & (Opcodes.ACC_ABSTRACT | Opcodes.ACC_NATIVE)) == 0;
                if (!rootMethod && !internalMethod) {
                  return delegate;
                }
                return new ObservationAdvice(
                    delegate,
                    access,
                    name,
                    descriptor,
                    taskId,
                    name + descriptor);
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

    private LoaderAwareClassWriter(ClassReader reader, ClassLoader targetLoader) {
      super(reader, ClassWriter.COMPUTE_FRAMES | ClassWriter.COMPUTE_MAXS);
      this.targetLoader = targetLoader;
    }

    @Override
    protected String getCommonSuperClass(String leftName, String rightName) {
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

  private static final class ObservationAdvice extends AdviceAdapter {
    private final String taskId;
    private final String methodIdentity;
    private final Type returnType;
    private int startLocal;

    private ObservationAdvice(
        MethodVisitor delegate,
        int access,
        String name,
        String descriptor,
        String taskId,
        String methodIdentity) {
      super(Opcodes.ASM9, delegate, access, name, descriptor);
      this.taskId = taskId;
      this.methodIdentity = methodIdentity;
      this.returnType = Type.getReturnType(descriptor);
    }

    @Override
    protected void onMethodEnter() {
      push(taskId);
      push(methodIdentity);
      if ((methodAccess & Opcodes.ACC_STATIC) == 0) {
        loadThis();
      } else {
        visitInsn(Opcodes.ACONST_NULL);
      }
      loadArgArray();
      invokeStatic(BRIDGE_TYPE, ENTER_METHOD);
      startLocal = newLocal(Type.LONG_TYPE);
      storeLocal(startLocal);
    }

    @Override
    protected void onMethodExit(int opcode) {
      if (opcode == Opcodes.ATHROW) {
        int throwableLocal = newLocal(Type.getType(Throwable.class));
        storeLocal(throwableLocal);
        emitExit(null, throwableLocal);
        loadLocal(throwableLocal);
        return;
      }
      if (opcode == Opcodes.RETURN) {
        emitExit(null, -1);
        return;
      }
      int resultLocal = newLocal(returnType);
      storeLocal(resultLocal);
      emitExit(resultLocal, -1);
      loadLocal(resultLocal);
    }

    private void emitExit(Integer resultLocal, int throwableLocal) {
      push(taskId);
      loadLocal(startLocal);
      if (resultLocal == null) {
        visitInsn(Opcodes.ACONST_NULL);
      } else {
        loadLocal(resultLocal.intValue());
        box(returnType);
      }
      if (throwableLocal < 0) {
        visitInsn(Opcodes.ACONST_NULL);
      } else {
        loadLocal(throwableLocal);
      }
      invokeStatic(BRIDGE_TYPE, EXIT_METHOD);
    }
  }
}
