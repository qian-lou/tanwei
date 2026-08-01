package dev.tanwei.agent;

import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.IllegalClassFormatException;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
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
import org.objectweb.asm.Label;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;

/** Manages bounded probes at exact source lines in one exact loaded method. */
final class LineProbeController implements AutoCloseable {
  private static final int MAXIMUM_TASKS = 32;
  private static final int MAXIMUM_LOCALS = 32;
  private static final long TERMINAL_RETENTION_MILLIS = 60_000L;
  private static final String BRIDGE_OWNER =
      "dev/tanwei/bootstrap/LineProbeBridge";
  private static final String CAPTURE_DESCRIPTOR =
      "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;I"
          + "[Ljava/lang/String;[Ljava/lang/Object;)V";

  private final Instrumentation instrumentation;
  private final RetransformLifecycle retransforms;
  private final ScheduledExecutorService scheduler;
  private final ClassDumpController classDump;
  private final Map<String, ProbeTask> tasks =
      new ConcurrentHashMap<String, ProbeTask>();
  private final Method registerBridge;
  private final Method unregisterBridge;
  private final Method drainBridge;
  private final Method capturedBridge;
  private final Method droppedBridge;

  LineProbeController(
      Instrumentation instrumentation,
      ScheduledExecutorService scheduler,
      ClassDumpController classDump,
      RetransformLifecycle retransforms)
      throws ReflectiveOperationException {
    this.instrumentation = instrumentation;
    this.scheduler = scheduler;
    this.classDump = classDump;
    this.retransforms = retransforms;
    Class<?> bridge =
        Class.forName(
            "dev.tanwei.bootstrap.LineProbeBridge",
            true,
            ClassLoader.getSystemClassLoader());
    registerBridge = bridge.getMethod("register", String.class, int.class);
    unregisterBridge = bridge.getMethod("unregister", String.class);
    drainBridge = bridge.getMethod("drain", String.class, int.class);
    capturedBridge = bridge.getMethod("captured", String.class);
    droppedBridge = bridge.getMethod("dropped", String.class);
  }

  Preview preview(
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      int lineNumber)
      throws Exception {
    Selection selection =
        resolveSelection(className, classLoader, methodName, parameterTypes);
    ProbePlan plan =
        ProbePlan.inspect(
            classDump.capture(selection.target),
            selection.target,
            selection.method,
            lineNumber);
    return new Preview(
        selection.target.getName(),
        selection.method.toGenericString(),
        plan.sourceFile,
        lineNumber,
        plan.points.size(),
        plan.maximumLocalCount());
  }

  StartResult start(
      String requestedTaskId,
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      int lineNumber,
      int maximumEvents,
      long timeoutMillis)
      throws Exception {
    purgeTerminalTasks();
    if (tasks.size() >= MAXIMUM_TASKS) {
      throw new IllegalStateException("Too many line probe tasks are retained");
    }
    Selection selection =
        resolveSelection(className, classLoader, methodName, parameterTypes);
    ProbePlan plan =
        ProbePlan.inspect(
            classDump.capture(selection.target),
            selection.target,
            selection.method,
            lineNumber);
    String taskId =
        requestedTaskId == null || requestedTaskId.isEmpty()
            ? UUID.randomUUID().toString()
            : requestedTaskId;
    LineProbeTransformer transformer =
        new LineProbeTransformer(selection.target, taskId, plan);
    long startedAtEpochMillis = System.currentTimeMillis();
    registerBridge.invoke(null, taskId, Integer.valueOf(maximumEvents));
    RetransformLifecycle.Lease lease = null;
    try {
      lease =
          retransforms.activate(
              "LINE:" + taskId, "LINE", transformer, selection.target);
      ProbeTask task =
          new ProbeTask(
              taskId,
              selection.target,
              lease,
              selection.method.toGenericString(),
              lineNumber,
              maximumEvents,
              startedAtEpochMillis,
              startedAtEpochMillis + timeoutMillis);
      tasks.put(taskId, task);
      scheduler.schedule(
          () -> finish(taskId, "TIMED_OUT"),
          timeoutMillis,
          TimeUnit.MILLISECONDS);
      return new StartResult(
          taskId,
          selection.target.getName(),
          selection.method.toGenericString(),
          plan.sourceFile,
          lineNumber,
          plan.points.size(),
          plan.maximumLocalCount(),
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

  EventBatch events(String taskId, int limit) throws Exception {
    ProbeTask task = tasks.get(taskId);
    if (task == null) {
      return EventBatch.unknown(taskId);
    }
    int captured = bridgeCount(capturedBridge, taskId);
    if (captured >= task.maximumEvents && "RUNNING".equals(task.state)) {
      finish(taskId, "SUCCEEDED");
    }
    @SuppressWarnings("unchecked")
    List<Object> bridgeEvents =
        (List<Object>) drainBridge.invoke(null, taskId, Integer.valueOf(limit));
    List<ProbeEvent> events =
        new ArrayList<ProbeEvent>(bridgeEvents.size());
    for (Object event : bridgeEvents) {
      events.add(parseEvent(event));
    }
    return new EventBatch(
        taskId,
        task.state,
        captured,
        bridgeCount(droppedBridge, taskId),
        task.className,
        task.method,
        task.lineNumber,
        events);
  }

  String cancel(String taskId) {
    ProbeTask task = tasks.get(taskId);
    if (task == null) {
      return "UNKNOWN";
    }
    finish(taskId, "CANCELLED");
    return task.state;
  }

  boolean hasActiveTaskFor(Class<?> target) {
    for (ProbeTask task : tasks.values()) {
      if (task.target == target && !task.terminal.get()) {
        return true;
      }
    }
    return false;
  }

  List<TaskSnapshot> activeTasks() {
    List<TaskSnapshot> snapshots = new ArrayList<TaskSnapshot>();
    for (ProbeTask task : tasks.values()) {
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
              task.className,
              task.method,
              task.lineNumber,
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
    ProbeTask task = tasks.get(taskId);
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
    for (Map.Entry<String, ProbeTask> entry : tasks.entrySet()) {
      if (entry.getValue().terminal.get()) {
        cleanupTerminalTask(entry.getKey());
      }
    }
  }

  private void cleanupTerminalTask(String taskId) {
    ProbeTask task = tasks.get(taskId);
    if (task == null || !task.terminal.get() || !tasks.remove(taskId, task)) {
      return;
    }
    try {
      unregisterBridge.invoke(null, taskId);
    } catch (Exception ignored) {
      // The task is already detached from application bytecode.
    }
  }

  private ProbeEvent parseEvent(Object source) throws Exception {
    Class<?> type = source.getClass();
    @SuppressWarnings("unchecked")
    List<Object> rawLocals =
        (List<Object>) type.getMethod("getLocals").invoke(source);
    List<LocalValue> locals = new ArrayList<LocalValue>(rawLocals.size());
    for (Object rawLocal : rawLocals) {
      Class<?> localType = rawLocal.getClass();
      locals.add(
          new LocalValue(
              (String) localType.getMethod("getName").invoke(rawLocal),
              (String) localType.getMethod("getValue").invoke(rawLocal)));
    }
    @SuppressWarnings("unchecked")
    List<String> callStack =
        (List<String>) type.getMethod("getCallStack").invoke(source);
    return new ProbeEvent(
        ((Integer) type.getMethod("getSequence").invoke(source)).intValue(),
        ((Long) type.getMethod("getCapturedAtEpochMillis").invoke(source))
            .longValue(),
        (String) type.getMethod("getThreadName").invoke(source),
        (String) type.getMethod("getClassName").invoke(source),
        (String) type.getMethod("getMethod").invoke(source),
        ((Integer) type.getMethod("getLineNumber").invoke(source)).intValue(),
        locals,
        new ArrayList<String>(callStack));
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
      throw new IllegalArgumentException(
          "The selected method signature was not found");
    }
    if (Modifier.isAbstract(method.getModifiers())
        || Modifier.isNative(method.getModifiers())) {
      throw new IllegalArgumentException(
          "Abstract and native methods cannot host line probes");
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
      try {
        unregisterBridge.invoke(null, taskId);
      } catch (Exception ignored) {
        // Shutdown must continue after bridge cleanup failure.
      }
    }
    tasks.clear();
  }

  static class Preview {
    private final String className;
    private final String method;
    private final String sourceFile;
    private final int lineNumber;
    private final int probePointCount;
    private final int maximumLocalCount;

    private Preview(
        String className,
        String method,
        String sourceFile,
        int lineNumber,
        int probePointCount,
        int maximumLocalCount) {
      this.className = className;
      this.method = method;
      this.sourceFile = sourceFile;
      this.lineNumber = lineNumber;
      this.probePointCount = probePointCount;
      this.maximumLocalCount = maximumLocalCount;
    }

    String getClassName() {
      return className;
    }

    String getMethod() {
      return method;
    }

    String getSourceFile() {
      return sourceFile;
    }

    int getLineNumber() {
      return lineNumber;
    }

    int getProbePointCount() {
      return probePointCount;
    }

    int getMaximumLocalCount() {
      return maximumLocalCount;
    }
  }

  static final class StartResult extends Preview {
    private final String taskId;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;

    private StartResult(
        String taskId,
        String className,
        String method,
        String sourceFile,
        int lineNumber,
        int probePointCount,
        int maximumLocalCount,
        long startedAtEpochMillis,
        long deadlineEpochMillis) {
      super(
          className,
          method,
          sourceFile,
          lineNumber,
          probePointCount,
          maximumLocalCount);
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
    private final String className;
    private final String method;
    private final int lineNumber;
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
        int lineNumber,
        String state,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        int captured,
        int maximumEvents,
        int dropped) {
      this.taskId = taskId;
      this.className = className;
      this.method = method;
      this.lineNumber = lineNumber;
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

    int getLineNumber() {
      return lineNumber;
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

  static final class EventBatch {
    private final String taskId;
    private final String state;
    private final int captured;
    private final int dropped;
    private final String className;
    private final String method;
    private final int lineNumber;
    private final List<ProbeEvent> events;

    private EventBatch(
        String taskId,
        String state,
        int captured,
        int dropped,
        String className,
        String method,
        int lineNumber,
        List<ProbeEvent> events) {
      this.taskId = taskId;
      this.state = state;
      this.captured = captured;
      this.dropped = dropped;
      this.className = className;
      this.method = method;
      this.lineNumber = lineNumber;
      this.events = Collections.unmodifiableList(events);
    }

    private static EventBatch unknown(String taskId) {
      return new EventBatch(
          taskId,
          "UNKNOWN",
          0,
          0,
          "",
          "",
          0,
          Collections.<ProbeEvent>emptyList());
    }

    String getTaskId() {
      return taskId;
    }

    String getState() {
      return state;
    }

    int getCaptured() {
      return captured;
    }

    int getDropped() {
      return dropped;
    }

    String getClassName() {
      return className;
    }

    String getMethod() {
      return method;
    }

    int getLineNumber() {
      return lineNumber;
    }

    List<ProbeEvent> getEvents() {
      return events;
    }
  }

  static final class ProbeEvent {
    private final int sequence;
    private final long capturedAtEpochMillis;
    private final String threadName;
    private final String className;
    private final String method;
    private final int lineNumber;
    private final List<LocalValue> locals;
    private final List<String> callStack;

    private ProbeEvent(
        int sequence,
        long capturedAtEpochMillis,
        String threadName,
        String className,
        String method,
        int lineNumber,
        List<LocalValue> locals,
        List<String> callStack) {
      this.sequence = sequence;
      this.capturedAtEpochMillis = capturedAtEpochMillis;
      this.threadName = threadName;
      this.className = className;
      this.method = method;
      this.lineNumber = lineNumber;
      this.locals = Collections.unmodifiableList(locals);
      this.callStack = Collections.unmodifiableList(callStack);
    }

    int getSequence() {
      return sequence;
    }

    long getCapturedAtEpochMillis() {
      return capturedAtEpochMillis;
    }

    String getThreadName() {
      return threadName;
    }

    String getClassName() {
      return className;
    }

    String getMethod() {
      return method;
    }

    int getLineNumber() {
      return lineNumber;
    }

    List<LocalValue> getLocals() {
      return locals;
    }

    List<String> getCallStack() {
      return callStack;
    }
  }

  static final class LocalValue {
    private final String name;
    private final String value;

    private LocalValue(String name, String value) {
      this.name = name;
      this.value = value;
    }

    String getName() {
      return name;
    }

    String getValue() {
      return value;
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

  private static final class ProbeTask {
    private final String taskId;
    private final Class<?> target;
    private final RetransformLifecycle.Lease lease;
    private final String className;
    private final String method;
    private final int lineNumber;
    private final int maximumEvents;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final AtomicBoolean terminal = new AtomicBoolean();
    private volatile String state = "RUNNING";

    private ProbeTask(
        String taskId,
        Class<?> target,
        RetransformLifecycle.Lease lease,
        String method,
        int lineNumber,
        int maximumEvents,
        long startedAtEpochMillis,
        long deadlineEpochMillis) {
      this.taskId = taskId;
      this.target = target;
      this.lease = lease;
      this.className = target.getName();
      this.method = method;
      this.lineNumber = lineNumber;
      this.maximumEvents = maximumEvents;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
    }
  }

  static final class ProbePlan {
    private final String className;
    private final String methodName;
    private final String methodDescriptor;
    private final String methodIdentity;
    private final String sourceFile;
    private final int lineNumber;
    private final List<ProbePoint> points;

    private ProbePlan(
        String className,
        String methodName,
        String methodDescriptor,
        String methodIdentity,
        String sourceFile,
        int lineNumber,
        List<ProbePoint> points) {
      this.className = className;
      this.methodName = methodName;
      this.methodDescriptor = methodDescriptor;
      this.methodIdentity = methodIdentity;
      this.sourceFile = sourceFile;
      this.lineNumber = lineNumber;
      this.points = points;
    }

    static ProbePlan inspect(
        byte[] bytecode, Class<?> target, Method method, int lineNumber) {
      if (lineNumber < 1 || lineNumber > 1_000_000) {
        throw new IllegalArgumentException(
            "Line number must be between 1 and 1000000");
      }
      String descriptor = Type.getMethodDescriptor(method);
      MetadataVisitor visitor =
          new MetadataVisitor(
              target.getName(),
              method.getName(),
              descriptor,
              lineNumber);
      new ClassReader(bytecode).accept(visitor, ClassReader.SKIP_FRAMES);
      List<ProbePoint> points = visitor.buildPoints();
      if (points.isEmpty()) {
        String range =
            visitor.minimumLine == Integer.MAX_VALUE
                ? "no source line table is available"
                : "available method lines are "
                    + visitor.minimumLine
                    + "-"
                    + visitor.maximumLine;
        throw new IllegalArgumentException(
            "Selected source line was not found; " + range);
      }
      return new ProbePlan(
          target.getName(),
          method.getName(),
          descriptor,
          method.getName() + descriptor,
          visitor.sourceFile,
          lineNumber,
          points);
    }

    int maximumLocalCount() {
      int maximum = 0;
      for (ProbePoint point : points) {
        maximum = Math.max(maximum, point.locals.size());
      }
      return maximum;
    }

    int pointCount() {
      return points.size();
    }

    String sourceFile() {
      return sourceFile;
    }
  }

  private static final class MetadataVisitor extends ClassVisitor {
    private final String className;
    private final String methodName;
    private final String methodDescriptor;
    private final int targetLine;
    private final List<LineLocation> locations = new ArrayList<LineLocation>();
    private final List<LocalRange> localRanges = new ArrayList<LocalRange>();
    private int methodAccess;
    private int minimumLine = Integer.MAX_VALUE;
    private int maximumLine = Integer.MIN_VALUE;
    private String sourceFile = "";

    private MetadataVisitor(
        String className,
        String methodName,
        String methodDescriptor,
        int targetLine) {
      super(Opcodes.ASM9);
      this.className = className;
      this.methodName = methodName;
      this.methodDescriptor = methodDescriptor;
      this.targetLine = targetLine;
    }

    @Override
    public void visitSource(String source, String debug) {
      sourceFile = source == null ? "" : source;
    }

    @Override
    public MethodVisitor visitMethod(
        int access,
        String name,
        String descriptor,
        String signature,
        String[] exceptions) {
      if (!methodName.equals(name) || !methodDescriptor.equals(descriptor)) {
        return null;
      }
      methodAccess = access;
      return new MethodVisitor(Opcodes.ASM9) {
        private final Map<Label, Integer> labelPositions =
            new IdentityHashMap<Label, Integer>();
        private int instructionPosition;

        @Override
        public void visitLabel(Label label) {
          labelPositions.put(label, Integer.valueOf(instructionPosition));
        }

        @Override
        public void visitLineNumber(int line, Label start) {
          minimumLine = Math.min(minimumLine, line);
          maximumLine = Math.max(maximumLine, line);
          if (line == targetLine) {
            locations.add(new LineLocation(instructionPosition));
          }
        }

        @Override
        public void visitLocalVariable(
            String name,
            String descriptor,
            String signature,
            Label start,
            Label end,
            int index) {
          localRanges.add(
              new LocalRange(
                  name,
                  descriptor,
                  index,
                  positionOf(start),
                  positionOf(end)));
        }

        @Override
        public void visitInsn(int opcode) {
          instructionPosition++;
        }

        @Override
        public void visitIntInsn(int opcode, int operand) {
          instructionPosition++;
        }

        @Override
        public void visitVarInsn(int opcode, int varIndex) {
          instructionPosition++;
        }

        @Override
        public void visitTypeInsn(int opcode, String type) {
          instructionPosition++;
        }

        @Override
        public void visitFieldInsn(
            int opcode, String owner, String name, String descriptor) {
          instructionPosition++;
        }

        @Override
        public void visitMethodInsn(
            int opcode,
            String owner,
            String name,
            String descriptor,
            boolean isInterface) {
          instructionPosition++;
        }

        @Override
        public void visitInvokeDynamicInsn(
            String name,
            String descriptor,
            org.objectweb.asm.Handle bootstrapMethodHandle,
            Object... bootstrapMethodArguments) {
          instructionPosition++;
        }

        @Override
        public void visitJumpInsn(int opcode, Label label) {
          instructionPosition++;
        }

        @Override
        public void visitLdcInsn(Object value) {
          instructionPosition++;
        }

        @Override
        public void visitIincInsn(int varIndex, int increment) {
          instructionPosition++;
        }

        @Override
        public void visitTableSwitchInsn(
            int minimum, int maximum, Label defaultLabel, Label... labels) {
          instructionPosition++;
        }

        @Override
        public void visitLookupSwitchInsn(
            Label defaultLabel, int[] keys, Label[] labels) {
          instructionPosition++;
        }

        @Override
        public void visitMultiANewArrayInsn(String descriptor, int dimensions) {
          instructionPosition++;
        }

        private int positionOf(Label label) {
          Integer position = labelPositions.get(label);
          return position == null ? -1 : position.intValue();
        }
      };
    }

    private List<ProbePoint> buildPoints() {
      List<ProbePoint> result = new ArrayList<ProbePoint>(locations.size());
      for (LineLocation location : locations) {
        LinkedHashMap<Integer, LocalSlot> locals =
            syntheticArguments(methodAccess, className, methodDescriptor);
        for (LocalRange range : localRanges) {
          if (range.startOffset <= location.offset
              && location.offset < range.endOffset) {
            locals.put(
                Integer.valueOf(range.index),
                new LocalSlot(range.name, range.descriptor, range.index));
          }
        }
        List<LocalSlot> sorted = new ArrayList<LocalSlot>(locals.values());
        sorted.sort(
            Comparator.comparingInt((LocalSlot local) -> local.index)
                .thenComparing(local -> local.name));
        if (sorted.size() > MAXIMUM_LOCALS) {
          sorted = new ArrayList<LocalSlot>(sorted.subList(0, MAXIMUM_LOCALS));
        }
        result.add(new ProbePoint(sorted));
      }
      return result;
    }

    private static LinkedHashMap<Integer, LocalSlot> syntheticArguments(
        int access, String className, String methodDescriptor) {
      LinkedHashMap<Integer, LocalSlot> result =
          new LinkedHashMap<Integer, LocalSlot>();
      int slot = 0;
      if ((access & Opcodes.ACC_STATIC) == 0) {
        result.put(
            Integer.valueOf(0),
            new LocalSlot(
                "this", "L" + className.replace('.', '/') + ";", 0));
        slot = 1;
      }
      Type[] argumentTypes = Type.getArgumentTypes(methodDescriptor);
      for (int index = 0; index < argumentTypes.length; index++) {
        Type type = argumentTypes[index];
        result.put(
            Integer.valueOf(slot),
            new LocalSlot("arg" + index, type.getDescriptor(), slot));
        slot += type.getSize();
      }
      return result;
    }
  }

  private static final class LineLocation {
    private final int offset;

    private LineLocation(int offset) {
      this.offset = offset;
    }
  }

  private static final class LocalRange {
    private final String name;
    private final String descriptor;
    private final int index;
    private final int startOffset;
    private final int endOffset;

    private LocalRange(
        String name,
        String descriptor,
        int index,
        int startOffset,
        int endOffset) {
      this.name = name;
      this.descriptor = descriptor;
      this.index = index;
      this.startOffset = startOffset;
      this.endOffset = endOffset;
    }
  }

  private static final class ProbePoint {
    private final List<LocalSlot> locals;

    private ProbePoint(List<LocalSlot> locals) {
      this.locals = Collections.unmodifiableList(locals);
    }
  }

  private static final class LocalSlot {
    private final String name;
    private final String descriptor;
    private final int index;

    private LocalSlot(String name, String descriptor, int index) {
      this.name = name == null ? "local" + index : name;
      this.descriptor = descriptor;
      this.index = index;
    }
  }

  static final class LineProbeTransformer
      implements ClassFileTransformer {
    private final Class<?> target;
    private final String taskId;
    private final ProbePlan plan;

    LineProbeTransformer(
        Class<?> target, String taskId, ProbePlan plan) {
      this.target = target;
      this.taskId = taskId;
      this.plan = plan;
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
                if (!plan.methodName.equals(name)
                    || !plan.methodDescriptor.equals(descriptor)) {
                  return delegate;
                }
                return new ProbeMethodVisitor(delegate, taskId, plan);
              }
            };
        reader.accept(visitor, ClassReader.EXPAND_FRAMES);
        return writer.toByteArray();
      } catch (RuntimeException exception) {
        throw new IllegalClassFormatException(exception.getMessage());
      }
    }
  }

  private static final class ProbeMethodVisitor extends MethodVisitor {
    private final String taskId;
    private final ProbePlan plan;
    private int targetLineOccurrence;

    private ProbeMethodVisitor(
        MethodVisitor delegate, String taskId, ProbePlan plan) {
      super(Opcodes.ASM9, delegate);
      this.taskId = taskId;
      this.plan = plan;
    }

    @Override
    public void visitLineNumber(int line, Label start) {
      super.visitLineNumber(line, start);
      if (line != plan.lineNumber) {
        return;
      }
      if (targetLineOccurrence < plan.points.size()) {
        emitCapture(plan.points.get(targetLineOccurrence));
      }
      targetLineOccurrence++;
    }

    private void emitCapture(ProbePoint point) {
      mv.visitLdcInsn(taskId);
      mv.visitLdcInsn(plan.className);
      mv.visitLdcInsn(plan.methodIdentity);
      pushInt(mv, plan.lineNumber);
      emitNames(point.locals);
      emitValues(point.locals);
      mv.visitMethodInsn(
          Opcodes.INVOKESTATIC,
          BRIDGE_OWNER,
          "capture",
          CAPTURE_DESCRIPTOR,
          false);
    }

    private void emitNames(List<LocalSlot> locals) {
      pushInt(mv, locals.size());
      mv.visitTypeInsn(Opcodes.ANEWARRAY, "java/lang/String");
      for (int index = 0; index < locals.size(); index++) {
        mv.visitInsn(Opcodes.DUP);
        pushInt(mv, index);
        mv.visitLdcInsn(locals.get(index).name);
        mv.visitInsn(Opcodes.AASTORE);
      }
    }

    private void emitValues(List<LocalSlot> locals) {
      pushInt(mv, locals.size());
      mv.visitTypeInsn(Opcodes.ANEWARRAY, "java/lang/Object");
      for (int index = 0; index < locals.size(); index++) {
        LocalSlot local = locals.get(index);
        Type type = Type.getType(local.descriptor);
        mv.visitInsn(Opcodes.DUP);
        pushInt(mv, index);
        mv.visitVarInsn(type.getOpcode(Opcodes.ILOAD), local.index);
        box(mv, type);
        mv.visitInsn(Opcodes.AASTORE);
      }
    }
  }

  private static void pushInt(MethodVisitor visitor, int value) {
    if (value >= -1 && value <= 5) {
      visitor.visitInsn(Opcodes.ICONST_0 + value);
    } else if (value >= Byte.MIN_VALUE && value <= Byte.MAX_VALUE) {
      visitor.visitIntInsn(Opcodes.BIPUSH, value);
    } else if (value >= Short.MIN_VALUE && value <= Short.MAX_VALUE) {
      visitor.visitIntInsn(Opcodes.SIPUSH, value);
    } else {
      visitor.visitLdcInsn(Integer.valueOf(value));
    }
  }

  private static void box(MethodVisitor visitor, Type type) {
    switch (type.getSort()) {
      case Type.BOOLEAN:
        invokeValueOf(visitor, "java/lang/Boolean", "(Z)Ljava/lang/Boolean;");
        return;
      case Type.CHAR:
        invokeValueOf(visitor, "java/lang/Character", "(C)Ljava/lang/Character;");
        return;
      case Type.BYTE:
        invokeValueOf(visitor, "java/lang/Byte", "(B)Ljava/lang/Byte;");
        return;
      case Type.SHORT:
        invokeValueOf(visitor, "java/lang/Short", "(S)Ljava/lang/Short;");
        return;
      case Type.INT:
        invokeValueOf(visitor, "java/lang/Integer", "(I)Ljava/lang/Integer;");
        return;
      case Type.FLOAT:
        invokeValueOf(visitor, "java/lang/Float", "(F)Ljava/lang/Float;");
        return;
      case Type.LONG:
        invokeValueOf(visitor, "java/lang/Long", "(J)Ljava/lang/Long;");
        return;
      case Type.DOUBLE:
        invokeValueOf(visitor, "java/lang/Double", "(D)Ljava/lang/Double;");
        return;
      case Type.ARRAY:
      case Type.OBJECT:
        return;
      default:
        throw new IllegalArgumentException(
            "Unsupported local variable descriptor: " + type.getDescriptor());
    }
  }

  private static void invokeValueOf(
      MethodVisitor visitor, String owner, String descriptor) {
    visitor.visitMethodInsn(
        Opcodes.INVOKESTATIC, owner, "valueOf", descriptor, false);
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
}
