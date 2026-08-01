package dev.tanwei.bootstrap;

import java.lang.ref.WeakReference;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ObservationBridge {
  private static final int MAXIMUM_ARGUMENTS = 16;
  private static final int MAXIMUM_VALUE_LENGTH = 512;
  private static final int MAXIMUM_CALL_STACK_DEPTH = 12;
  private static final int MAXIMUM_RECEIVER_STATE_FIELDS = 16;
  private static final int MAXIMUM_RECEIVER_SCANNED_FIELDS = 128;
  private static final int MAXIMUM_RECEIVER_HIERARCHY_DEPTH = 6;
  private static final int MAXIMUM_RECEIVER_FIELD_NAME_LENGTH = 256;
  private static final int MAXIMUM_RECEIVER_FIELD_VALUE_LENGTH = 256;
  private static final int MAXIMUM_INVOCATION_VALUE_NODES = 96;
  private static final int MAXIMUM_INVOCATION_VALUE_DEPTH = 3;
  private static final int MAXIMUM_INVOCATION_VALUE_CHILDREN = 16;
  private static final int MAXIMUM_INVOCATION_SCANNED_FIELDS = 256;
  private static final int MAXIMUM_INVOCATION_VALUE_TEXT_LENGTH = 256;
  private static final int MAXIMUM_CONDITION_LENGTH = 512;
  private static final int MAXIMUM_CONDITION_CLAUSES = 4;
  private static final double MAXIMUM_CONDITION_DURATION_MILLIS = 60_000.0d;
  private static final Pattern DURATION_CONDITION =
      Pattern.compile("^durationMs\\s*(>=|>|<=|<|==)\\s*(\\d+(?:\\.\\d+)?)$");
  private static final Pattern THREAD_CONDITION =
      Pattern.compile("^thread\\s*(==|contains)\\s*\"([^\"]{0,128})\"$");
  private static final Pattern ARGUMENT_CONDITION =
      Pattern.compile("^arg(\\d{1,2})\\s*(==|contains)\\s*\"([^\"]{0,256})\"$");
  private static final Pattern OUTCOME_CONDITION =
      Pattern.compile("^outcome\\s*==\\s*\"(RETURNED|THREW)\"$");
  private static final Pattern EXCEPTION_CONDITION =
      Pattern.compile("^exception(?:\\s*(==|contains)\\s*\"([^\"]{1,256})\")?$");
  private static final Pattern RETURN_CONDITION =
      Pattern.compile("^return\\s*(==|contains)\\s*\"([^\"]{0,256})\"$");
  private static final ConcurrentMap<String, TaskState> TASKS =
      new ConcurrentHashMap<String, TaskState>();
  private static final ThreadLocal<Map<String, Deque<Invocation>>> INVOCATIONS =
      new ThreadLocal<Map<String, Deque<Invocation>>>() {
        @Override
        protected Map<String, Deque<Invocation>> initialValue() {
          return new HashMap<String, Deque<Invocation>>();
        }
      };

  private ObservationBridge() {}

  public static void register(
      String taskId,
      int maximumEvents,
      String rootMethod,
      String condition) {
    register(taskId, maximumEvents, rootMethod, condition, "FINISH");
  }

  public static void register(
      String taskId,
      int maximumEvents,
      String rootMethod,
      String condition,
      String phases) {
    if (taskId == null || taskId.isEmpty() || maximumEvents <= 0) {
      throw new IllegalArgumentException("invalid observation task");
    }
    if (rootMethod == null || rootMethod.isEmpty()) {
      throw new IllegalArgumentException("root observation method is required");
    }
    String normalizedCondition = condition == null ? "" : condition.trim();
    List<ConditionClause> conditions = parseConditions(normalizedCondition);
    Set<String> capturePhases = parsePhases(phases);
    if (TASKS.putIfAbsent(
            taskId,
            new TaskState(maximumEvents, rootMethod, conditions, capturePhases))
        != null) {
      throw new IllegalStateException("observation task already exists");
    }
  }

  public static void unregister(String taskId) {
    TASKS.remove(taskId);
  }

  public static long enter(
      String taskId,
      String method,
      Object receiver,
      Object[] arguments) {
    try {
      TaskState state = TASKS.get(taskId);
      if (state == null || state.captured.get() >= state.maximumEvents) {
        return 0L;
      }
      long startedAtNanos = System.nanoTime();
      Map<String, Deque<Invocation>> byTask = INVOCATIONS.get();
      Deque<Invocation> stack = byTask.get(taskId);
      if (stack == null) {
        if (!state.rootMethod.equals(method)) {
          if (byTask.isEmpty()) {
            INVOCATIONS.remove();
          }
          return 0L;
        }
        stack = new ArrayDeque<Invocation>();
        byTask.put(taskId, stack);
      }
      long sequence = state.sequence.getAndIncrement();
      long parentSequence =
          stack.isEmpty() ? -1L : stack.peek().sequence;
      int depth = stack.size();
      Invocation invocation =
          new Invocation(
              sequence,
              parentSequence,
              depth,
              method,
              startedAtNanos,
              receiver == null ? null : new WeakReference<Object>(receiver),
              safeReceiverType(receiver),
              safeArguments(arguments),
              argumentReferences(arguments),
              safeCallStack());
      stack.push(invocation);
      if (state.phases.contains("BEFORE")) {
        captureEvent(state, invocation, "BEFORE", 0L, null, null);
      }
      return sequence + 1L;
    } catch (Throwable ignored) {
      return 0L;
    }
  }

  public static void exit(
      String taskId,
      long startedAtNanos,
      Object returnValue,
      Throwable throwable) {
    if (startedAtNanos == 0L) {
      return;
    }
    try {
      TaskState state = TASKS.get(taskId);
      if (state == null) {
        return;
      }
      List<String> arguments = Collections.emptyList();
      List<String> callStack = Collections.emptyList();
      String method = "";
      long sequence = Math.max(0L, startedAtNanos - 1L);
      long parentSequence = -1L;
      int depth = 0;
      WeakReference<Object> receiverReference = null;
      String receiverType = "";
      Object[] argumentReferences = new Object[0];
      long actualStartedAtNanos = System.nanoTime();
      Map<String, Deque<Invocation>> byTask = INVOCATIONS.get();
      Deque<Invocation> stack = byTask.get(taskId);
      if (stack != null && !stack.isEmpty()) {
        Invocation invocation = stack.pop();
        arguments = invocation.arguments;
        callStack = invocation.callStack;
        method = invocation.method;
        sequence = invocation.sequence;
        parentSequence = invocation.parentSequence;
        depth = invocation.depth;
        receiverReference = invocation.receiverReference;
        receiverType = invocation.receiverType;
        argumentReferences = invocation.argumentReferences;
        actualStartedAtNanos = invocation.startedAtNanos;
        if (stack.isEmpty()) {
          byTask.remove(taskId);
        }
      }
      if (byTask.isEmpty()) {
        INVOCATIONS.remove();
      }
      long durationNanos =
          Math.max(0L, System.nanoTime() - actualStartedAtNanos);
      Invocation completed =
          new Invocation(
              sequence,
              parentSequence,
              depth,
              method,
              actualStartedAtNanos,
              receiverReference,
              receiverType,
              arguments,
              argumentReferences,
              callStack);
      if (throwable == null && state.phases.contains("RETURN")) {
        captureEvent(
            state, completed, "RETURN", durationNanos, returnValue, null);
      } else if (throwable != null && state.phases.contains("THROW")) {
        captureEvent(
            state, completed, "THROW", durationNanos, null, throwable);
      }
      if (state.phases.contains("FINISH")) {
        captureEvent(
            state, completed, "FINISH", durationNanos, returnValue, throwable);
      }
    } catch (Throwable ignored) {
      // Observation must never alter the target method's result or exception.
    }
  }

  public static List<Event> drain(String taskId, int limit) {
    TaskState state = TASKS.get(taskId);
    if (state == null || limit <= 0) {
      return Collections.emptyList();
    }
    List<Event> result = new ArrayList<Event>(Math.min(limit, state.maximumEvents));
    state.events.drainTo(result, limit);
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

  private static boolean captureEvent(
      TaskState state,
      Invocation invocation,
      String phase,
      long durationNanos,
      Object returnValue,
      Throwable throwable) {
    if (!matchesCondition(
        state.conditions,
        phase,
        durationNanos,
        Thread.currentThread().getName(),
        invocation.arguments,
        returnValue,
        throwable)) {
      return false;
    }
    if (!reserveCapture(state)) {
      return false;
    }
    ReceiverState receiverState =
        invocation.depth == 0 && invocation.receiverReference != null
            ? inspectReceiverState(invocation.receiverReference.get())
            : ReceiverState.empty();
    InvocationValues invocationValues =
        captureInvocationValues(
            invocation.argumentReferences,
            returnValue,
            !"BEFORE".equals(phase) && throwable == null);
    Event event =
        new Event(
            state.eventSequence.getAndIncrement(),
            invocation.sequence,
            invocation.parentSequence,
            invocation.depth,
            invocation.method,
            phase,
            System.currentTimeMillis(),
            durationNanos,
            Thread.currentThread().getName(),
            invocation.arguments,
            invocation.callStack,
            invocation.receiverReference,
            invocation.receiverType,
            receiverState,
            invocationValues,
            throwable == null && !"BEFORE".equals(phase)
                ? safeValue(returnValue)
                : "",
            throwable == null ? "" : throwable.getClass().getName(),
            throwable == null ? "" : safeValue(throwable.getMessage()));
    if (!state.events.offer(event)) {
      state.dropped.incrementAndGet();
      return false;
    }
    return true;
  }

  /**
   * Captures only bounded scalar fields without invoking business methods.
   *
   * <p>The returned value never retains the receiver or any referenced object.
   */
  public static ReceiverState inspectReceiverState(Object receiver) {
    if (receiver == null) {
      return ReceiverState.empty();
    }
    try {
      List<Field> candidates = new ArrayList<Field>();
      int scannedFields = 0;
      boolean truncated = false;
      Class<?> current = receiver.getClass();
      int hierarchyDepth = 0;
      while (current != null
          && current != Object.class
          && hierarchyDepth < MAXIMUM_RECEIVER_HIERARCHY_DEPTH) {
        Field[] declared;
        try {
          declared = current.getDeclaredFields();
        } catch (Throwable ignored) {
          return ReceiverState.unavailable();
        }
        for (Field field : declared) {
          if (scannedFields >= MAXIMUM_RECEIVER_SCANNED_FIELDS) {
            truncated = true;
            break;
          }
          scannedFields++;
          int modifiers = field.getModifiers();
          if (!Modifier.isStatic(modifiers)
              && !field.isSynthetic()
              && isSupportedStateType(field.getType())) {
            candidates.add(field);
          }
        }
        if (scannedFields >= MAXIMUM_RECEIVER_SCANNED_FIELDS) {
          break;
        }
        current = current.getSuperclass();
        hierarchyDepth++;
      }
      if (current != null && current != Object.class) {
        truncated = true;
      }
      Collections.sort(
          candidates,
          new Comparator<Field>() {
            @Override
            public int compare(Field left, Field right) {
              return fieldName(left).compareTo(fieldName(right));
            }
          });
      if (candidates.size() > MAXIMUM_RECEIVER_STATE_FIELDS) {
        truncated = true;
      }
      int count = Math.min(candidates.size(), MAXIMUM_RECEIVER_STATE_FIELDS);
      List<String> names = new ArrayList<String>(count);
      List<String> values = new ArrayList<String>(count);
      int unavailableFields = 0;
      for (int index = 0; index < count; index++) {
        Field field = candidates.get(index);
        names.add(bounded(fieldName(field), MAXIMUM_RECEIVER_FIELD_NAME_LENGTH));
        if (isSensitiveField(field.getName())) {
          values.add("<masked>");
          continue;
        }
        boolean accessible = field.isAccessible();
        try {
          if (!accessible) {
            field.setAccessible(true);
          }
          values.add(
              bounded(
                  safeScalarFieldValue(field.get(receiver)),
                  MAXIMUM_RECEIVER_FIELD_VALUE_LENGTH));
        } catch (Throwable ignored) {
          unavailableFields++;
          values.add("<unavailable>");
        } finally {
          if (!accessible) {
            try {
              field.setAccessible(false);
            } catch (Throwable ignored) {
              // Accessibility restoration is best effort on strongly encapsulated runtimes.
            }
          }
        }
      }
      return new ReceiverState(
          true,
          scannedFields,
          unavailableFields,
          truncated,
          names,
          values);
    } catch (Throwable ignored) {
      return ReceiverState.unavailable();
    }
  }

  private static InvocationValues captureInvocationValues(
      Object[] arguments,
      Object returnValue,
      boolean returned) {
    try {
      return new InvocationValueEncoder().encode(
          arguments == null ? new Object[0] : arguments,
          returnValue,
          returned);
    } catch (Throwable ignored) {
      return InvocationValues.unavailable();
    }
  }

  private static Object[] argumentReferences(Object[] arguments) {
    if (arguments == null || arguments.length == 0) {
      return new Object[0];
    }
    int count = Math.min(arguments.length, MAXIMUM_ARGUMENTS);
    Object[] references = new Object[count];
    System.arraycopy(arguments, 0, references, 0, count);
    return references;
  }

  private static final class InvocationValueEncoder {
    private final List<InvocationValueNode> nodes =
        new ArrayList<InvocationValueNode>(MAXIMUM_INVOCATION_VALUE_NODES);
    private final IdentityHashMap<Object, String> seen =
        new IdentityHashMap<Object, String>();
    private int scannedFields;
    private boolean truncated;

    private InvocationValues encode(
        Object[] arguments,
        Object returnValue,
        boolean returned) {
      for (int index = 0; index < arguments.length; index++) {
        append(arguments[index], "arg[" + index + "]", -1, 0);
      }
      if (returned) {
        append(returnValue, "result", -1, 0);
      }
      return new InvocationValues(true, scannedFields, truncated, nodes);
    }

    private void append(
        Object value,
        String path,
        int parentIndex,
        int depth) {
      if (nodes.size() >= MAXIMUM_INVOCATION_VALUE_NODES) {
        truncated = true;
        return;
      }
      if (value == null) {
        addNode(path, parentIndex, depth, "NULL", "", "null", 0, false);
        return;
      }
      Class<?> type;
      try {
        type = value.getClass();
      } catch (Throwable ignored) {
        addNode(
            path,
            parentIndex,
            depth,
            "UNAVAILABLE",
            "",
            "<unavailable>",
            0,
            false);
        return;
      }
      if (isInvocationScalarType(type)) {
        addNode(
            path,
            parentIndex,
            depth,
            "SCALAR",
            safeTypeName(type),
            bounded(
                safeInvocationScalar(value),
                MAXIMUM_INVOCATION_VALUE_TEXT_LENGTH),
            0,
            false);
        return;
      }
      String previousPath = seen.get(value);
      if (previousPath != null) {
        addNode(
            path,
            parentIndex,
            depth,
            "REFERENCE",
            safeTypeName(type),
            bounded(previousPath, MAXIMUM_INVOCATION_VALUE_TEXT_LENGTH),
            0,
            false);
        return;
      }
      seen.put(value, path);
      if (type.isArray()) {
        appendArray(value, type, path, parentIndex, depth);
        return;
      }
      if (isTrustedJdkMapType(type)) {
        appendMap((Map<?, ?>) value, type, path, parentIndex, depth);
        return;
      }
      if (isTrustedJdkCollectionType(type)) {
        appendCollection(
            (Collection<?>) value, type, path, parentIndex, depth);
        return;
      }
      if (isOpaqueInvocationType(type)) {
        addNode(
            path,
            parentIndex,
            depth,
            "OPAQUE",
            safeTypeName(type),
            "<opaque>",
            0,
            false);
        return;
      }
      appendObject(value, type, path, parentIndex, depth);
    }

    private void appendArray(
        Object value,
        Class<?> type,
        String path,
        int parentIndex,
        int depth) {
      int length;
      try {
        length = Array.getLength(value);
      } catch (Throwable ignored) {
        addNode(
            path,
            parentIndex,
            depth,
            "UNAVAILABLE",
            safeTypeName(type),
            "<unavailable>",
            0,
            false);
        return;
      }
      Class<?> component = type.getComponentType();
      if (component == byte.class || component == char.class) {
        addNode(
            path,
            parentIndex,
            depth,
            "MASKED",
            safeTypeName(type),
            "<redacted array>",
            length,
            false);
        return;
      }
      boolean nodeTruncated =
          (depth >= MAXIMUM_INVOCATION_VALUE_DEPTH && length > 0)
              || length > MAXIMUM_INVOCATION_VALUE_CHILDREN;
      int nodeIndex =
          addNode(
              path,
              parentIndex,
              depth,
              "ARRAY",
              safeTypeName(type),
              Integer.toString(length) + " elements",
              length,
              nodeTruncated);
      if (nodeTruncated) {
        truncated = true;
      }
      if (depth >= MAXIMUM_INVOCATION_VALUE_DEPTH) {
        return;
      }
      int limit = Math.min(length, MAXIMUM_INVOCATION_VALUE_CHILDREN);
      for (int index = 0; index < limit; index++) {
        Object item;
        try {
          item = Array.get(value, index);
        } catch (Throwable ignored) {
          addNode(
              path + "[" + index + "]",
              nodeIndex,
              depth + 1,
              "UNAVAILABLE",
              safeTypeName(component),
              "<unavailable>",
              0,
              false);
          continue;
        }
        append(item, path + "[" + index + "]", nodeIndex, depth + 1);
      }
    }

    private void appendCollection(
        Collection<?> collection,
        Class<?> type,
        String path,
        int parentIndex,
        int depth) {
      int size;
      try {
        size = Math.max(0, collection.size());
      } catch (Throwable ignored) {
        addNode(
            path,
            parentIndex,
            depth,
            "UNAVAILABLE",
            safeTypeName(type),
            "<unavailable>",
            0,
            false);
        return;
      }
      boolean nodeTruncated =
          (depth >= MAXIMUM_INVOCATION_VALUE_DEPTH && size > 0)
              || size > MAXIMUM_INVOCATION_VALUE_CHILDREN;
      int nodeIndex =
          addNode(
              path,
              parentIndex,
              depth,
              "COLLECTION",
              safeTypeName(type),
              Integer.toString(size) + " elements",
              size,
              nodeTruncated);
      if (nodeTruncated) {
        truncated = true;
      }
      if (depth >= MAXIMUM_INVOCATION_VALUE_DEPTH || size == 0) {
        return;
      }
      Iterator<?> iterator;
      try {
        iterator = collection.iterator();
      } catch (Throwable ignored) {
        appendUnavailableChild(path + "[0]", nodeIndex, depth + 1, "");
        markNodeTruncated(nodeIndex);
        return;
      }
      int limit = Math.min(size, MAXIMUM_INVOCATION_VALUE_CHILDREN);
      for (int index = 0; index < limit; index++) {
        Object item;
        try {
          if (!iterator.hasNext()) {
            markNodeTruncated(nodeIndex);
            return;
          }
          item = iterator.next();
        } catch (Throwable ignored) {
          appendUnavailableChild(
              path + "[" + index + "]", nodeIndex, depth + 1, "");
          markNodeTruncated(nodeIndex);
          return;
        }
        append(item, path + "[" + index + "]", nodeIndex, depth + 1);
      }
    }

    private void appendMap(
        Map<?, ?> map,
        Class<?> type,
        String path,
        int parentIndex,
        int depth) {
      int size;
      try {
        size = Math.max(0, map.size());
      } catch (Throwable ignored) {
        addNode(
            path,
            parentIndex,
            depth,
            "UNAVAILABLE",
            safeTypeName(type),
            "<unavailable>",
            0,
            false);
        return;
      }
      boolean nodeTruncated =
          (depth >= MAXIMUM_INVOCATION_VALUE_DEPTH && size > 0)
              || size > MAXIMUM_INVOCATION_VALUE_CHILDREN;
      int nodeIndex =
          addNode(
              path,
              parentIndex,
              depth,
              "MAP",
              safeTypeName(type),
              Integer.toString(size) + " entries",
              size,
              nodeTruncated);
      if (nodeTruncated) {
        truncated = true;
      }
      if (depth >= MAXIMUM_INVOCATION_VALUE_DEPTH || size == 0) {
        return;
      }
      Iterator<? extends Map.Entry<?, ?>> iterator;
      try {
        iterator = map.entrySet().iterator();
      } catch (Throwable ignored) {
        appendUnavailableChild(path + "[0]", nodeIndex, depth + 1, "");
        markNodeTruncated(nodeIndex);
        return;
      }
      int limit = Math.min(size, MAXIMUM_INVOCATION_VALUE_CHILDREN);
      for (int index = 0; index < limit; index++) {
        Map.Entry<?, ?> entry;
        try {
          if (!iterator.hasNext()) {
            markNodeTruncated(nodeIndex);
            return;
          }
          entry = iterator.next();
        } catch (Throwable ignored) {
          appendUnavailableChild(
              path + "[" + index + "]", nodeIndex, depth + 1, "");
          markNodeTruncated(nodeIndex);
          return;
        }
        String entryPath = path + "[" + index + "]";
        boolean entryTruncated =
            depth + 1 >= MAXIMUM_INVOCATION_VALUE_DEPTH;
        int entryIndex =
            addNode(
                entryPath,
                nodeIndex,
                depth + 1,
                "ENTRY",
                "java.util.Map.Entry",
                "",
                2,
                entryTruncated);
        if (entryTruncated) {
          truncated = true;
          continue;
        }
        Object key;
        try {
          key = entry.getKey();
          append(key, entryPath + ".key", entryIndex, depth + 2);
        } catch (Throwable ignored) {
          appendUnavailableChild(
              entryPath + ".key", entryIndex, depth + 2, "");
          key = null;
        }
        if (isSensitiveMapKey(key)) {
          addNode(
              entryPath + ".value",
              entryIndex,
              depth + 2,
              "MASKED",
              "",
              "<masked>",
              0,
              false);
          continue;
        }
        try {
          append(
              entry.getValue(),
              entryPath + ".value",
              entryIndex,
              depth + 2);
        } catch (Throwable ignored) {
          appendUnavailableChild(
              entryPath + ".value", entryIndex, depth + 2, "");
        }
      }
    }

    private void appendUnavailableChild(
        String path,
        int parentIndex,
        int depth,
        String typeName) {
      addNode(
          path,
          parentIndex,
          depth,
          "UNAVAILABLE",
          typeName,
          "<unavailable>",
          0,
          false);
    }

    private void markNodeTruncated(int nodeIndex) {
      truncated = true;
      if (nodeIndex < 0 || nodeIndex >= nodes.size()) {
        return;
      }
      InvocationValueNode node = nodes.get(nodeIndex);
      if (node.isTruncated()) {
        return;
      }
      nodes.set(
          nodeIndex,
          new InvocationValueNode(
              node.getPath(),
              node.getParentIndex(),
              node.getDepth(),
              node.getKind(),
              node.getTypeName(),
              node.getValue(),
              node.getChildCount(),
              true));
    }

    private void appendObject(
        Object value,
        Class<?> type,
        String path,
        int parentIndex,
        int depth) {
      List<Field> fields;
      try {
        fields = instanceFields(type);
      } catch (Throwable ignored) {
        addNode(
            path,
            parentIndex,
            depth,
            "UNAVAILABLE",
            safeTypeName(type),
            "<unavailable>",
            0,
            false);
        return;
      }
      boolean nodeTruncated =
          (depth >= MAXIMUM_INVOCATION_VALUE_DEPTH && !fields.isEmpty())
              || fields.size() > MAXIMUM_INVOCATION_VALUE_CHILDREN;
      int nodeIndex =
          addNode(
              path,
              parentIndex,
              depth,
              "OBJECT",
              safeTypeName(type),
              "",
              fields.size(),
              nodeTruncated);
      if (nodeTruncated) {
        truncated = true;
      }
      if (depth >= MAXIMUM_INVOCATION_VALUE_DEPTH) {
        return;
      }
      int limit = Math.min(fields.size(), MAXIMUM_INVOCATION_VALUE_CHILDREN);
      for (int index = 0; index < limit; index++) {
        Field field = fields.get(index);
        String childPath = path + "." + field.getName();
        if (isSensitiveField(field.getName())) {
          addNode(
              childPath,
              nodeIndex,
              depth + 1,
              "MASKED",
              safeTypeName(field.getType()),
              "<masked>",
              0,
              false);
          continue;
        }
        boolean accessible = field.isAccessible();
        try {
          if (!accessible) {
            field.setAccessible(true);
          }
          append(field.get(value), childPath, nodeIndex, depth + 1);
        } catch (Throwable ignored) {
          addNode(
              childPath,
              nodeIndex,
              depth + 1,
              "UNAVAILABLE",
              safeTypeName(field.getType()),
              "<unavailable>",
              0,
              false);
        } finally {
          if (!accessible) {
            try {
              field.setAccessible(false);
            } catch (Throwable ignored) {
              // Accessibility restoration is best effort.
            }
          }
        }
      }
    }

    private List<Field> instanceFields(Class<?> type) {
      List<Field> fields = new ArrayList<Field>();
      Class<?> current = type;
      int hierarchyDepth = 0;
      while (current != null
          && current != Object.class
          && hierarchyDepth < MAXIMUM_RECEIVER_HIERARCHY_DEPTH) {
        Field[] declared = current.getDeclaredFields();
        for (Field field : declared) {
          if (scannedFields >= MAXIMUM_INVOCATION_SCANNED_FIELDS) {
            truncated = true;
            break;
          }
          scannedFields++;
          if (!Modifier.isStatic(field.getModifiers()) && !field.isSynthetic()) {
            fields.add(field);
          }
        }
        if (scannedFields >= MAXIMUM_INVOCATION_SCANNED_FIELDS) {
          break;
        }
        current = current.getSuperclass();
        hierarchyDepth++;
      }
      if (current != null && current != Object.class) {
        truncated = true;
      }
      Collections.sort(
          fields,
          new Comparator<Field>() {
            @Override
            public int compare(Field left, Field right) {
              return fieldName(left).compareTo(fieldName(right));
            }
          });
      return fields;
    }

    private int addNode(
        String path,
        int parentIndex,
        int depth,
        String kind,
        String typeName,
        String value,
        int childCount,
        boolean nodeTruncated) {
      if (nodes.size() >= MAXIMUM_INVOCATION_VALUE_NODES) {
        truncated = true;
        return -1;
      }
      int index = nodes.size();
      nodes.add(
          new InvocationValueNode(
              bounded(path, MAXIMUM_INVOCATION_VALUE_TEXT_LENGTH),
              parentIndex,
              depth,
              kind,
              bounded(typeName, MAXIMUM_INVOCATION_VALUE_TEXT_LENGTH),
              bounded(value, MAXIMUM_INVOCATION_VALUE_TEXT_LENGTH),
              Math.max(0, childCount),
              nodeTruncated));
      return index;
    }
  }

  private static boolean isInvocationScalarType(Class<?> type) {
    return type == String.class
        || type == Boolean.class
        || type == Byte.class
        || type == Short.class
        || type == Integer.class
        || type == Long.class
        || type == Float.class
        || type == Double.class
        || type == Character.class
        || type.isEnum();
  }

  private static String safeInvocationScalar(Object value) {
    return value instanceof Enum<?>
        ? ((Enum<?>) value).name()
        : String.valueOf(value);
  }

  private static boolean isOpaqueInvocationType(Class<?> type) {
    String name = safeTypeName(type);
    return name.startsWith("java.")
        || name.startsWith("javax.")
        || name.startsWith("jdk.")
        || name.startsWith("sun.")
        || name.startsWith("com.sun.");
  }

  private static boolean isTrustedJdkCollectionType(Class<?> type) {
    if (!Collection.class.isAssignableFrom(type) || !isBootstrapType(type)) {
      return false;
    }
    String name = safeTypeName(type);
    if (name.startsWith("java.util.ImmutableCollections$")) {
      return true;
    }
    return "java.util.ArrayList".equals(name)
        || "java.util.LinkedList".equals(name)
        || "java.util.Vector".equals(name)
        || "java.util.Stack".equals(name)
        || "java.util.ArrayDeque".equals(name)
        || "java.util.PriorityQueue".equals(name)
        || "java.util.HashSet".equals(name)
        || "java.util.LinkedHashSet".equals(name)
        || "java.util.TreeSet".equals(name)
        || "java.util.Arrays$ArrayList".equals(name)
        || "java.util.Collections$EmptyList".equals(name)
        || "java.util.Collections$EmptySet".equals(name)
        || "java.util.Collections$EmptyNavigableSet".equals(name)
        || "java.util.Collections$SingletonList".equals(name)
        || "java.util.Collections$SingletonSet".equals(name)
        || "java.util.Collections$CopiesList".equals(name)
        || "java.util.RegularEnumSet".equals(name)
        || "java.util.JumboEnumSet".equals(name)
        || "java.util.concurrent.CopyOnWriteArrayList".equals(name)
        || "java.util.concurrent.CopyOnWriteArraySet".equals(name)
        || "java.util.concurrent.ConcurrentLinkedQueue".equals(name)
        || "java.util.concurrent.ConcurrentLinkedDeque".equals(name)
        || "java.util.concurrent.ArrayBlockingQueue".equals(name)
        || "java.util.concurrent.LinkedBlockingQueue".equals(name)
        || "java.util.concurrent.LinkedBlockingDeque".equals(name)
        || "java.util.concurrent.LinkedTransferQueue".equals(name)
        || "java.util.concurrent.PriorityBlockingQueue".equals(name)
        || "java.util.concurrent.DelayQueue".equals(name)
        || "java.util.concurrent.SynchronousQueue".equals(name);
  }

  private static boolean isTrustedJdkMapType(Class<?> type) {
    if (!Map.class.isAssignableFrom(type) || !isBootstrapType(type)) {
      return false;
    }
    String name = safeTypeName(type);
    if (name.startsWith("java.util.ImmutableCollections$")) {
      return true;
    }
    return "java.util.HashMap".equals(name)
        || "java.util.LinkedHashMap".equals(name)
        || "java.util.TreeMap".equals(name)
        || "java.util.Hashtable".equals(name)
        || "java.util.WeakHashMap".equals(name)
        || "java.util.IdentityHashMap".equals(name)
        || "java.util.EnumMap".equals(name)
        || "java.util.Collections$EmptyMap".equals(name)
        || "java.util.Collections$EmptyNavigableMap".equals(name)
        || "java.util.Collections$SingletonMap".equals(name)
        || "java.util.concurrent.ConcurrentHashMap".equals(name)
        || "java.util.concurrent.ConcurrentSkipListMap".equals(name);
  }

  private static boolean isBootstrapType(Class<?> type) {
    try {
      return type.getClassLoader() == null;
    } catch (Throwable ignored) {
      return false;
    }
  }

  private static boolean isSensitiveMapKey(Object key) {
    if (key instanceof String) {
      return isSensitiveField((String) key);
    }
    if (key instanceof Enum<?>) {
      return isSensitiveField(((Enum<?>) key).name());
    }
    return false;
  }

  private static String safeTypeName(Class<?> type) {
    if (type == null) {
      return "";
    }
    try {
      return type.getTypeName();
    } catch (Throwable ignored) {
      return "<unavailable>";
    }
  }

  private static boolean reserveCapture(TaskState state) {
    while (true) {
      int captured = state.captured.get();
      if (captured >= state.maximumEvents) {
        return false;
      }
      if (state.captured.compareAndSet(captured, captured + 1)) {
        return true;
      }
    }
  }

  private static List<String> safeArguments(Object[] arguments) {
    if (arguments == null || arguments.length == 0) {
      return Collections.emptyList();
    }
    int limit = Math.min(arguments.length, MAXIMUM_ARGUMENTS);
    List<String> values = new ArrayList<String>(limit);
    for (int index = 0; index < limit; index++) {
      values.add(safeValue(arguments[index]));
    }
    if (arguments.length > limit) {
      values.add("<" + (arguments.length - limit) + " more arguments>");
    }
    return values;
  }

  private static List<ConditionClause> parseConditions(String condition) {
    if (condition.isEmpty()) {
      return Collections.emptyList();
    }
    if (condition.length() > MAXIMUM_CONDITION_LENGTH
        || containsControlCharacter(condition)) {
      throw new IllegalArgumentException(
          "Observation condition must be a bounded single-line expression");
    }
    List<String> expressions = splitConditionClauses(condition);
    if (expressions.isEmpty()
        || expressions.size() > MAXIMUM_CONDITION_CLAUSES) {
      throw new IllegalArgumentException(
          "Observation condition supports at most four AND clauses");
    }
    List<ConditionClause> clauses =
        new ArrayList<ConditionClause>(expressions.size());
    for (String expression : expressions) {
      clauses.add(parseConditionClause(expression));
    }
    return Collections.unmodifiableList(clauses);
  }

  private static Set<String> parsePhases(String phases) {
    String value = phases == null ? "" : phases.trim();
    if (value.isEmpty() || value.length() > 64 || containsControlCharacter(value)) {
      throw new IllegalArgumentException("At least one bounded watch phase is required");
    }
    Set<String> result = new LinkedHashSet<String>();
    for (String raw : value.split(",")) {
      String phase = raw.trim().toUpperCase(Locale.ROOT);
      if (!"BEFORE".equals(phase)
          && !"RETURN".equals(phase)
          && !"THROW".equals(phase)
          && !"FINISH".equals(phase)) {
        throw new IllegalArgumentException("Unsupported watch phase: " + phase);
      }
      result.add(phase);
    }
    if (result.isEmpty()) {
      throw new IllegalArgumentException("At least one watch phase is required");
    }
    return Collections.unmodifiableSet(result);
  }

  private static List<String> splitConditionClauses(String condition) {
    List<String> expressions = new ArrayList<String>();
    boolean quoted = false;
    int start = 0;
    for (int index = 0; index < condition.length(); index++) {
      char current = condition.charAt(index);
      if (current == '"') {
        quoted = !quoted;
        continue;
      }
      if (!quoted
          && current == '&'
          && index + 1 < condition.length()
          && condition.charAt(index + 1) == '&') {
        String expression = condition.substring(start, index).trim();
        if (expression.isEmpty()) {
          throw new IllegalArgumentException("Empty observation condition clause");
        }
        expressions.add(expression);
        start = index + 2;
        index++;
      }
    }
    if (quoted) {
      throw new IllegalArgumentException("Unterminated observation condition value");
    }
    String expression = condition.substring(start).trim();
    if (expression.isEmpty()) {
      throw new IllegalArgumentException("Empty observation condition clause");
    }
    expressions.add(expression);
    return expressions;
  }

  private static ConditionClause parseConditionClause(String condition) {
    Matcher duration = DURATION_CONDITION.matcher(condition);
    if (duration.matches()) {
      double expected = Double.parseDouble(duration.group(2));
      if (!Double.isFinite(expected)
          || expected < 0.0d
          || expected > MAXIMUM_CONDITION_DURATION_MILLIS
          || decimalPlaces(duration.group(2)) > 3) {
        throw new IllegalArgumentException("Invalid duration condition value");
      }
      return ConditionClause.duration(duration.group(1), expected);
    }
    Matcher thread = THREAD_CONDITION.matcher(condition);
    if (thread.matches()) {
      return ConditionClause.text(
          ConditionClause.THREAD, thread.group(1), thread.group(2));
    }
    Matcher argument = ARGUMENT_CONDITION.matcher(condition);
    if (argument.matches()) {
      int index = Integer.parseInt(argument.group(1));
      if (index < 0 || index >= MAXIMUM_ARGUMENTS) {
        throw new IllegalArgumentException("Argument condition index is out of bounds");
      }
      return ConditionClause.argument(
          index, argument.group(2), argument.group(3));
    }
    Matcher outcome = OUTCOME_CONDITION.matcher(condition);
    if (outcome.matches()) {
      return ConditionClause.text(
          ConditionClause.OUTCOME, "==", outcome.group(1));
    }
    Matcher exception = EXCEPTION_CONDITION.matcher(condition);
    if (exception.matches()) {
      return ConditionClause.text(
          ConditionClause.EXCEPTION,
          exception.group(1) == null ? "exists" : exception.group(1),
          exception.group(2) == null ? "" : exception.group(2));
    }
    Matcher returnValue = RETURN_CONDITION.matcher(condition);
    if (returnValue.matches()) {
      return ConditionClause.text(
          ConditionClause.RETURN_VALUE,
          returnValue.group(1),
          returnValue.group(2));
    }
    throw new IllegalArgumentException(
        "Unsupported observation condition clause");
  }

  private static int decimalPlaces(String value) {
    int separator = value.indexOf('.');
    return separator < 0 ? 0 : value.length() - separator - 1;
  }

  private static boolean containsControlCharacter(String value) {
    for (int index = 0; index < value.length(); index++) {
      if (Character.isISOControl(value.charAt(index))) {
        return true;
      }
    }
    return false;
  }

  private static boolean matchesCondition(
      List<ConditionClause> conditions,
      String phase,
      long durationNanos,
      String threadName,
      List<String> arguments,
      Object returnValue,
      Throwable throwable) {
    for (ConditionClause condition : conditions) {
      if (!condition.matches(
          phase,
          durationNanos,
          threadName,
          arguments,
          returnValue,
          throwable)) {
        return false;
      }
    }
    return true;
  }

  private static List<String> safeCallStack() {
    try {
      StackTraceElement[] frames = Thread.currentThread().getStackTrace();
      List<String> result =
          new ArrayList<String>(Math.min(frames.length, MAXIMUM_CALL_STACK_DEPTH));
      for (StackTraceElement frame : frames) {
        String className = frame.getClassName();
        if (className.equals(Thread.class.getName())
            || className.equals(ObservationBridge.class.getName())) {
          continue;
        }
        result.add(frame.toString());
        if (result.size() >= MAXIMUM_CALL_STACK_DEPTH) {
          break;
        }
      }
      return result;
    } catch (Throwable ignored) {
      return Collections.emptyList();
    }
  }

  private static String safeValue(Object value) {
    if (value == null) {
      return "null";
    }
    try {
      String typeName = value.getClass().getName();
      boolean scalar =
          value instanceof CharSequence
              || value instanceof Number
              || value instanceof Boolean
              || value instanceof Character
              || value instanceof Enum;
      String rendered = scalar ? String.valueOf(value) : "<" + typeName + ">";
      if (rendered.length() <= MAXIMUM_VALUE_LENGTH) {
        return rendered;
      }
      return rendered.substring(0, MAXIMUM_VALUE_LENGTH) + "…";
    } catch (Throwable ignored) {
      return "<unavailable>";
    }
  }

  private static String safeReceiverType(Object receiver) {
    if (receiver == null) {
      return "";
    }
    try {
      return receiver.getClass().getName();
    } catch (Throwable ignored) {
      return "<unavailable>";
    }
  }

  private static boolean isSupportedStateType(Class<?> type) {
    return type.isPrimitive()
        || type == String.class
        || type == Boolean.class
        || type == Byte.class
        || type == Short.class
        || type == Integer.class
        || type == Long.class
        || type == Float.class
        || type == Double.class
        || type == Character.class
        || type.isEnum();
  }

  private static String safeScalarFieldValue(Object value) {
    if (value == null) {
      return "null";
    }
    if (value instanceof Enum<?>) {
      return ((Enum<?>) value).name();
    }
    return String.valueOf(value);
  }

  private static String fieldName(Field field) {
    return field.getDeclaringClass().getName() + "#" + field.getName();
  }

  private static boolean isSensitiveField(String name) {
    String normalized =
        name == null ? "" : name.toLowerCase(Locale.ROOT);
    return normalized.contains("password")
        || normalized.contains("passwd")
        || normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("credential")
        || normalized.contains("apikey")
        || normalized.contains("api_key")
        || normalized.contains("privatekey");
  }

  private static String bounded(String value, int maximumLength) {
    if (value == null || value.isEmpty()) {
      return "";
    }
    return value.length() <= maximumLength
        ? value
        : value.substring(0, maximumLength) + "…";
  }

  private static final class ConditionClause {
    private static final int DURATION = 0;
    private static final int THREAD = 1;
    private static final int ARGUMENT = 2;
    private static final int OUTCOME = 3;
    private static final int EXCEPTION = 4;
    private static final int RETURN_VALUE = 5;

    private final int subject;
    private final int argumentIndex;
    private final String operator;
    private final String expectedText;
    private final double expectedDurationMillis;

    private ConditionClause(
        int subject,
        int argumentIndex,
        String operator,
        String expectedText,
        double expectedDurationMillis) {
      this.subject = subject;
      this.argumentIndex = argumentIndex;
      this.operator = operator;
      this.expectedText = expectedText;
      this.expectedDurationMillis = expectedDurationMillis;
    }

    private static ConditionClause duration(
        String operator, double expectedDurationMillis) {
      return new ConditionClause(
          DURATION, -1, operator, "", expectedDurationMillis);
    }

    private static ConditionClause text(
        int subject, String operator, String expectedText) {
      return new ConditionClause(
          subject, -1, operator, expectedText, 0.0d);
    }

    private static ConditionClause argument(
        int argumentIndex, String operator, String expectedText) {
      return new ConditionClause(
          ARGUMENT, argumentIndex, operator, expectedText, 0.0d);
    }

    private boolean matches(
        String phase,
        long durationNanos,
        String threadName,
        List<String> arguments,
        Object returnValue,
        Throwable throwable) {
      if (subject == DURATION) {
        double actualDurationMillis = durationNanos / 1_000_000.0d;
        if (">".equals(operator)) {
          return actualDurationMillis > expectedDurationMillis;
        }
        if (">=".equals(operator)) {
          return actualDurationMillis >= expectedDurationMillis;
        }
        if ("<".equals(operator)) {
          return actualDurationMillis < expectedDurationMillis;
        }
        if ("<=".equals(operator)) {
          return actualDurationMillis <= expectedDurationMillis;
        }
        return actualDurationMillis == expectedDurationMillis;
      }
      if (subject == THREAD) {
        return matchesText(threadName);
      }
      if (subject == ARGUMENT) {
        return argumentIndex < arguments.size()
            && matchesText(arguments.get(argumentIndex));
      }
      if (subject == OUTCOME) {
        if ("BEFORE".equals(phase)) {
          return false;
        }
        return throwable == null
            ? "RETURNED".equals(expectedText)
            : "THREW".equals(expectedText);
      }
      if (subject == EXCEPTION) {
        if (throwable == null) {
          return false;
        }
        if ("exists".equals(operator)) {
          return true;
        }
        return matchesText(throwable.getClass().getName());
      }
      if ("BEFORE".equals(phase)) {
        return false;
      }
      return throwable == null && matchesText(safeValue(returnValue));
    }

    private boolean matchesText(String actual) {
      if (actual == null) {
        return false;
      }
      return "contains".equals(operator)
          ? actual.contains(expectedText)
          : actual.equals(expectedText);
    }
  }

  private static final class TaskState {
    private final int maximumEvents;
    private final String rootMethod;
    private final List<ConditionClause> conditions;
    private final Set<String> phases;
    private final ArrayBlockingQueue<Event> events;
    private final AtomicInteger captured = new AtomicInteger();
    private final AtomicInteger dropped = new AtomicInteger();
    private final AtomicLong sequence = new AtomicLong();
    private final AtomicLong eventSequence = new AtomicLong();

    private TaskState(
        int maximumEvents,
        String rootMethod,
        List<ConditionClause> conditions,
        Set<String> phases) {
      this.maximumEvents = maximumEvents;
      this.rootMethod = rootMethod;
      this.conditions = conditions;
      this.phases = phases;
      this.events = new ArrayBlockingQueue<Event>(maximumEvents);
    }
  }

  private static final class Invocation {
    private final long sequence;
    private final long parentSequence;
    private final int depth;
    private final String method;
    private final long startedAtNanos;
    private final WeakReference<Object> receiverReference;
    private final String receiverType;
    private final List<String> arguments;
    private final Object[] argumentReferences;
    private final List<String> callStack;

    private Invocation(
        long sequence,
        long parentSequence,
        int depth,
        String method,
        long startedAtNanos,
        WeakReference<Object> receiverReference,
        String receiverType,
        List<String> arguments,
        Object[] argumentReferences,
        List<String> callStack) {
      this.sequence = sequence;
      this.parentSequence = parentSequence;
      this.depth = depth;
      this.method = method;
      this.startedAtNanos = startedAtNanos;
      this.receiverReference = receiverReference;
      this.receiverType = receiverType;
      this.arguments = arguments;
      this.argumentReferences = argumentReferences;
      this.callStack = callStack;
    }
  }

  public static final class Event {
    private final long eventId;
    private final long sequence;
    private final long parentSequence;
    private final int depth;
    private final String method;
    private final String phase;
    private final long capturedAtEpochMillis;
    private final long durationNanos;
    private final String threadName;
    private final List<String> arguments;
    private final List<String> callStack;
    private final WeakReference<Object> receiverReference;
    private final String receiverType;
    private final ReceiverState receiverState;
    private final InvocationValues invocationValues;
    private final String returnValue;
    private final String exceptionType;
    private final String exceptionMessage;

    private Event(
        long eventId,
        long sequence,
        long parentSequence,
        int depth,
        String method,
        String phase,
        long capturedAtEpochMillis,
        long durationNanos,
        String threadName,
        List<String> arguments,
        List<String> callStack,
        WeakReference<Object> receiverReference,
        String receiverType,
        ReceiverState receiverState,
        InvocationValues invocationValues,
        String returnValue,
        String exceptionType,
        String exceptionMessage) {
      this.eventId = eventId;
      this.sequence = sequence;
      this.parentSequence = parentSequence;
      this.depth = depth;
      this.method = method;
      this.phase = phase;
      this.capturedAtEpochMillis = capturedAtEpochMillis;
      this.durationNanos = durationNanos;
      this.threadName = threadName;
      this.arguments = arguments;
      this.callStack = callStack;
      this.receiverReference = receiverReference;
      this.receiverType = receiverType;
      this.receiverState = receiverState;
      this.invocationValues = invocationValues;
      this.returnValue = returnValue;
      this.exceptionType = exceptionType;
      this.exceptionMessage = exceptionMessage;
    }

    public long getSequence() {
      return sequence;
    }

    public long getEventId() {
      return eventId;
    }

    public long getCapturedAtEpochMillis() {
      return capturedAtEpochMillis;
    }

    public long getParentSequence() {
      return parentSequence;
    }

    public int getDepth() {
      return depth;
    }

    public String getMethod() {
      return method;
    }

    public String getPhase() {
      return phase;
    }

    public long getDurationNanos() {
      return durationNanos;
    }

    public String getThreadName() {
      return threadName;
    }

    public List<String> getArguments() {
      return arguments;
    }

    public List<String> getCallStack() {
      return callStack;
    }

    public WeakReference<Object> getReceiverReference() {
      return receiverReference;
    }

    public String getReceiverType() {
      return receiverType;
    }

    public ReceiverState getReceiverState() {
      return receiverState;
    }

    public InvocationValues getInvocationValues() {
      return invocationValues;
    }

    public String getReturnValue() {
      return returnValue;
    }

    public String getExceptionType() {
      return exceptionType;
    }

    public String getExceptionMessage() {
      return exceptionMessage;
    }
  }

  public static final class ReceiverState {
    private static final ReceiverState EMPTY =
        new ReceiverState(
            true,
            0,
            0,
            false,
            Collections.<String>emptyList(),
            Collections.<String>emptyList());
    private static final ReceiverState UNAVAILABLE =
        new ReceiverState(
            false,
            0,
            0,
            false,
            Collections.<String>emptyList(),
            Collections.<String>emptyList());

    private final boolean available;
    private final int scannedFields;
    private final int unavailableFields;
    private final boolean truncated;
    private final List<String> names;
    private final List<String> values;

    private ReceiverState(
        boolean available,
        int scannedFields,
        int unavailableFields,
        boolean truncated,
        List<String> names,
        List<String> values) {
      this.available = available;
      this.scannedFields = scannedFields;
      this.unavailableFields = unavailableFields;
      this.truncated = truncated;
      this.names = Collections.unmodifiableList(new ArrayList<String>(names));
      this.values = Collections.unmodifiableList(new ArrayList<String>(values));
    }

    private static ReceiverState empty() {
      return EMPTY;
    }

    private static ReceiverState unavailable() {
      return UNAVAILABLE;
    }

    public boolean isAvailable() {
      return available;
    }

    public int getScannedFields() {
      return scannedFields;
    }

    public int getUnavailableFields() {
      return unavailableFields;
    }

    public boolean isTruncated() {
      return truncated;
    }

    public List<String> getNames() {
      return names;
    }

    public List<String> getValues() {
      return values;
    }
  }

  public static final class InvocationValues {
    private static final InvocationValues UNAVAILABLE =
        new InvocationValues(
            false,
            0,
            false,
            Collections.<InvocationValueNode>emptyList());

    private final boolean available;
    private final int scannedFields;
    private final boolean truncated;
    private final List<InvocationValueNode> nodes;

    private InvocationValues(
        boolean available,
        int scannedFields,
        boolean truncated,
        List<InvocationValueNode> nodes) {
      this.available = available;
      this.scannedFields = scannedFields;
      this.truncated = truncated;
      this.nodes =
          Collections.unmodifiableList(
              new ArrayList<InvocationValueNode>(nodes));
    }

    private static InvocationValues unavailable() {
      return UNAVAILABLE;
    }

    public boolean isAvailable() {
      return available;
    }

    public int getScannedFields() {
      return scannedFields;
    }

    public boolean isTruncated() {
      return truncated;
    }

    public List<InvocationValueNode> getNodes() {
      return nodes;
    }
  }

  public static final class InvocationValueNode {
    private final String path;
    private final int parentIndex;
    private final int depth;
    private final String kind;
    private final String typeName;
    private final String value;
    private final int childCount;
    private final boolean truncated;

    private InvocationValueNode(
        String path,
        int parentIndex,
        int depth,
        String kind,
        String typeName,
        String value,
        int childCount,
        boolean truncated) {
      this.path = path;
      this.parentIndex = parentIndex;
      this.depth = depth;
      this.kind = kind;
      this.typeName = typeName;
      this.value = value;
      this.childCount = childCount;
      this.truncated = truncated;
    }

    public String getPath() {
      return path;
    }

    public int getParentIndex() {
      return parentIndex;
    }

    public int getDepth() {
      return depth;
    }

    public String getKind() {
      return kind;
    }

    public String getTypeName() {
      return typeName;
    }

    public String getValue() {
      return value;
    }

    public int getChildCount() {
      return childCount;
    }

    public boolean isTruncated() {
      return truncated;
    }
  }
}
