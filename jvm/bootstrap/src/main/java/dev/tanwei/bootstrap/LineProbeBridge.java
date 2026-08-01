package dev.tanwei.bootstrap;

import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** Bootstrap-visible bridge for bounded source-line probes. */
public final class LineProbeBridge {
  private static final int MAXIMUM_LOCALS = 32;
  private static final int MAXIMUM_STACK_DEPTH = 12;
  private static final int MAXIMUM_VALUE_LENGTH = 256;
  private static final Map<String, TaskState> TASKS =
      new ConcurrentHashMap<String, TaskState>();

  private LineProbeBridge() {}

  public static void register(String taskId, int maximumEvents) {
    if (taskId == null || taskId.isEmpty()) {
      throw new IllegalArgumentException("line probe task identity is required");
    }
    if (maximumEvents < 1 || maximumEvents > 100) {
      throw new IllegalArgumentException(
          "line probe maximum events must be between 1 and 100");
    }
    TaskState previous =
        TASKS.putIfAbsent(taskId, new TaskState(maximumEvents));
    if (previous != null) {
      throw new IllegalStateException(
          "line probe task identity is already registered");
    }
  }

  public static void unregister(String taskId) {
    if (taskId != null) {
      TASKS.remove(taskId);
    }
  }

  /**
   * Captures one bounded event without allowing diagnostics failures to affect
   * the instrumented application.
   */
  public static void capture(
      String taskId,
      String className,
      String method,
      int lineNumber,
      String[] localNames,
      Object[] localValues) {
    try {
      TaskState state = TASKS.get(taskId);
      if (state == null || state.exhausted) {
        return;
      }
      int sequence = state.claimSequence();
      if (sequence < 0) {
        return;
      }
      Event event =
          new Event(
              sequence,
              System.currentTimeMillis(),
              Thread.currentThread().getName(),
              safeText(className, 1_024),
              safeText(method, 1_024),
              lineNumber,
              snapshotLocals(localNames, localValues),
              captureStack());
      if (!state.events.offer(event)) {
        state.dropped.incrementAndGet();
      } else {
        state.captured.incrementAndGet();
      }
    } catch (Throwable ignored) {
      // A diagnostic probe must never change application behavior.
    }
  }

  public static List<Event> drain(String taskId, int limit) {
    TaskState state = TASKS.get(taskId);
    if (state == null || limit < 1) {
      return Collections.emptyList();
    }
    int boundedLimit = Math.min(100, limit);
    List<Event> result = new ArrayList<Event>(boundedLimit);
    state.events.drainTo(result, boundedLimit);
    return result;
  }

  public static int captured(String taskId) {
    TaskState state = TASKS.get(taskId);
    return state == null ? 0 : state.captured.get();
  }

  public static int dropped(String taskId) {
    TaskState state = TASKS.get(taskId);
    return state == null ? 0 : state.dropped.get();
  }

  private static List<LocalValue> snapshotLocals(
      String[] localNames, Object[] localValues) {
    if (localNames == null || localValues == null) {
      return Collections.emptyList();
    }
    int count =
        Math.min(
            MAXIMUM_LOCALS,
            Math.min(localNames.length, localValues.length));
    List<LocalValue> locals = new ArrayList<LocalValue>(count);
    for (int index = 0; index < count; index++) {
      String name = safeText(localNames[index], 128);
      locals.add(
          new LocalValue(
              name,
              sensitiveName(name)
                  ? "[REDACTED]"
                  : safeValue(localValues[index])));
    }
    return Collections.unmodifiableList(locals);
  }

  private static String safeValue(Object value) {
    if (value == null) {
      return "null";
    }
    if (value instanceof String) {
      return safeText((String) value, MAXIMUM_VALUE_LENGTH);
    }
    if (value instanceof Boolean
        || value instanceof Byte
        || value instanceof Short
        || value instanceof Integer
        || value instanceof Long
        || value instanceof Float
        || value instanceof Double
        || value instanceof Character) {
      return safeText(String.valueOf(value), MAXIMUM_VALUE_LENGTH);
    }
    if (value instanceof Enum<?>) {
      Enum<?> enumValue = (Enum<?>) value;
      return enumValue.getDeclaringClass().getName() + "." + enumValue.name();
    }
    if (value instanceof Class<?>) {
      return ((Class<?>) value).getName();
    }
    Class<?> type = value.getClass();
    if (type.isArray()) {
      return type.getTypeName() + "[length=" + Array.getLength(value) + "]";
    }
    return type.getName()
        + "@"
        + Integer.toHexString(System.identityHashCode(value));
  }

  private static List<String> captureStack() {
    StackTraceElement[] stack = Thread.currentThread().getStackTrace();
    List<String> result = new ArrayList<String>(MAXIMUM_STACK_DEPTH);
    for (StackTraceElement frame : stack) {
      String owner = frame.getClassName();
      if (owner.equals(Thread.class.getName())
          || owner.equals(LineProbeBridge.class.getName())) {
        continue;
      }
      result.add(frame.toString());
      if (result.size() >= MAXIMUM_STACK_DEPTH) {
        break;
      }
    }
    return Collections.unmodifiableList(result);
  }

  private static boolean sensitiveName(String name) {
    String normalized = name.toLowerCase(java.util.Locale.ROOT);
    return normalized.contains("password")
        || normalized.contains("passwd")
        || normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("credential")
        || normalized.contains("authorization")
        || normalized.contains("cookie")
        || normalized.equals("key")
        || normalized.endsWith("key");
  }

  private static String safeText(String value, int maximumLength) {
    if (value == null) {
      return "";
    }
    if (value.length() <= maximumLength) {
      return value;
    }
    return value.substring(0, maximumLength - 1) + "…";
  }

  private static final class TaskState {
    private final int maximumEvents;
    private final AtomicInteger claimed = new AtomicInteger();
    private final AtomicInteger captured = new AtomicInteger();
    private final AtomicInteger dropped = new AtomicInteger();
    private final ArrayBlockingQueue<Event> events;
    private volatile boolean exhausted;

    private TaskState(int maximumEvents) {
      this.maximumEvents = maximumEvents;
      this.events = new ArrayBlockingQueue<Event>(maximumEvents);
    }

    private int claimSequence() {
      while (true) {
        int current = claimed.get();
        if (current >= maximumEvents) {
          exhausted = true;
          return -1;
        }
        if (claimed.compareAndSet(current, current + 1)) {
          if (current + 1 >= maximumEvents) {
            exhausted = true;
          }
          return current + 1;
        }
      }
    }
  }

  public static final class LocalValue {
    private final String name;
    private final String value;

    private LocalValue(String name, String value) {
      this.name = name;
      this.value = value;
    }

    public String getName() {
      return name;
    }

    public String getValue() {
      return value;
    }
  }

  public static final class Event {
    private final int sequence;
    private final long capturedAtEpochMillis;
    private final String threadName;
    private final String className;
    private final String method;
    private final int lineNumber;
    private final List<LocalValue> locals;
    private final List<String> callStack;

    private Event(
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
      this.locals = locals;
      this.callStack = callStack;
    }

    public int getSequence() {
      return sequence;
    }

    public long getCapturedAtEpochMillis() {
      return capturedAtEpochMillis;
    }

    public String getThreadName() {
      return threadName;
    }

    public String getClassName() {
      return className;
    }

    public String getMethod() {
      return method;
    }

    public int getLineNumber() {
      return lineNumber;
    }

    public List<LocalValue> getLocals() {
      return locals;
    }

    public List<String> getCallStack() {
      return callStack;
    }
  }
}
