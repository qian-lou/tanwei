package dev.tanwei.agent;

import dev.tanwei.protocol.v1.ObservationEvent;
import java.lang.ref.WeakReference;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Session-scoped, bounded archive of already-rendered observation events.
 *
 * <p>The archive retains only weak receiver references, so a snapshot never keeps a target
 * object alive. Inserts and oldest-entry eviction are O(1); bounded search is O(N), where N is
 * at most {@value #DEFAULT_MAXIMUM_SNAPSHOTS}.
 */
final class SnapshotArchive {
  static final int DEFAULT_MAXIMUM_SNAPSHOTS = 1_000;
  static final long DEFAULT_MAXIMUM_ESTIMATED_BYTES = 8L * 1_024L * 1_024L;
  static final int MAXIMUM_PAGE_SIZE = 100;
  private static final int MAXIMUM_TEXT_LENGTH = 4_096;
  private static final int MAXIMUM_VALUE_LENGTH = 512;
  private static final int MAXIMUM_ARGUMENTS = 16;
  private static final int MAXIMUM_STACK_DEPTH = 12;

  private final Object lock = new Object();
  private final int maximumSnapshots;
  private final long maximumEstimatedBytes;
  private final AtomicLong nextId = new AtomicLong(1_000L);
  private final Deque<Snapshot> ordered = new ArrayDeque<Snapshot>();
  private final Map<Long, Snapshot> byId = new HashMap<Long, Snapshot>();
  private long estimatedBytes;
  private long evicted;

  SnapshotArchive() {
    this(DEFAULT_MAXIMUM_SNAPSHOTS, DEFAULT_MAXIMUM_ESTIMATED_BYTES);
  }

  SnapshotArchive(int maximumSnapshots, long maximumEstimatedBytes) {
    if (maximumSnapshots < 1 || maximumEstimatedBytes < 1L) {
      throw new IllegalArgumentException("Snapshot archive bounds must be positive");
    }
    this.maximumSnapshots = maximumSnapshots;
    this.maximumEstimatedBytes = maximumEstimatedBytes;
  }

  Snapshot record(
      String taskId,
      String className,
      String classLoader,
      String rootMethodName,
      String parameterTypes,
      String modifiers,
      ObservationEvent event) {
    return record(
        taskId,
        className,
        classLoader,
        rootMethodName,
        parameterTypes,
        modifiers,
        event,
        null,
        "",
        ReceiverStateSnapshot.empty());
  }

  Snapshot record(
      String taskId,
      String className,
      String classLoader,
      String rootMethodName,
      String parameterTypes,
      String modifiers,
      ObservationEvent event,
      WeakReference<Object> receiverReference,
      String receiverType) {
    return record(
        taskId,
        className,
        classLoader,
        rootMethodName,
        parameterTypes,
        modifiers,
        event,
        receiverReference,
        receiverType,
        ReceiverStateSnapshot.empty());
  }

  Snapshot record(
      String taskId,
      String className,
      String classLoader,
      String rootMethodName,
      String parameterTypes,
      String modifiers,
      ObservationEvent event,
      WeakReference<Object> receiverReference,
      String receiverType,
      ReceiverStateSnapshot receiverState) {
    return record(
        taskId,
        className,
        classLoader,
        rootMethodName,
        parameterTypes,
        modifiers,
        event,
        receiverReference,
        receiverType,
        receiverState,
        InvocationValueSnapshot.empty());
  }

  Snapshot record(
      String taskId,
      String className,
      String classLoader,
      String rootMethodName,
      String parameterTypes,
      String modifiers,
      ObservationEvent event,
      WeakReference<Object> receiverReference,
      String receiverType,
      ReceiverStateSnapshot receiverState,
      InvocationValueSnapshot invocationValues) {
    if (event == null) {
      throw new IllegalArgumentException("Observation event is required");
    }
    if (receiverState == null) {
      throw new IllegalArgumentException("Receiver state is required");
    }
    if (invocationValues == null) {
      throw new IllegalArgumentException("Invocation values are required");
    }
    List<String> arguments =
        boundedList(event.getArgumentsList(), MAXIMUM_ARGUMENTS, MAXIMUM_VALUE_LENGTH);
    List<String> callStack =
        boundedList(event.getCallStackList(), MAXIMUM_STACK_DEPTH, MAXIMUM_VALUE_LENGTH);
    Snapshot snapshot =
        new Snapshot(
            nextId.getAndIncrement(),
            bounded(taskId, MAXIMUM_TEXT_LENGTH),
            bounded(className, MAXIMUM_TEXT_LENGTH),
            bounded(classLoader, MAXIMUM_TEXT_LENGTH),
            bounded(rootMethodName, MAXIMUM_VALUE_LENGTH),
            bounded(parameterTypes, MAXIMUM_TEXT_LENGTH),
            bounded(modifiers, MAXIMUM_VALUE_LENGTH),
            event.getSequence(),
            event.getParentSequence(),
            Math.max(0, event.getDepth()),
            bounded(event.getMethod(), MAXIMUM_TEXT_LENGTH),
            normalizePhase(event.getPhase()),
            Math.max(0L, event.getCapturedAtEpochMillis()),
            Math.max(0L, event.getDurationNanos()),
            bounded(event.getThreadName(), MAXIMUM_VALUE_LENGTH),
            arguments,
            callStack,
            receiverReference,
            bounded(receiverType, MAXIMUM_TEXT_LENGTH),
            receiverState,
            invocationValues,
            bounded(event.getReturnValue(), MAXIMUM_VALUE_LENGTH),
            bounded(event.getExceptionType(), MAXIMUM_VALUE_LENGTH),
            bounded(event.getExceptionMessage(), MAXIMUM_VALUE_LENGTH));
    synchronized (lock) {
      ordered.addLast(snapshot);
      byId.put(snapshot.id, snapshot);
      estimatedBytes += snapshot.estimatedBytes;
      evictToBounds();
    }
    return snapshot;
  }

  Page list(
      String query,
      String outcome,
      String scope,
      int offset,
      int limit) {
    return list(
        new Filter(
            query,
            outcome,
            scope,
            "",
            "",
            "ALL",
            0L,
            0L,
            offset,
            limit));
  }

  Page list(Filter filter) {
    if (filter == null) {
      throw new IllegalArgumentException("snapshot filter is required");
    }
    synchronized (lock) {
      int total = 0;
      int returned = 0;
      int threw = 0;
      int root = 0;
      int internal = 0;
      List<Snapshot> items = new ArrayList<Snapshot>(filter.limit);
      Iterator<Snapshot> iterator = ordered.descendingIterator();
      while (iterator.hasNext()) {
        Snapshot snapshot = iterator.next();
        if (!snapshot.matchesQuery(filter.query)
            || !snapshot.matchesTask(filter.taskId)
            || !snapshot.matchesThread(filter.threadQuery)
            || !snapshot.matchesDuration(
                filter.minimumDurationNanos, filter.maximumDurationNanos)
            || !snapshot.matchesReplay(filter.replay)) {
          continue;
        }
        if (snapshot.isThrew()) {
          threw++;
        } else {
          returned++;
        }
        if (snapshot.isRoot()) {
          root++;
        } else {
          internal++;
        }
        if (!snapshot.matchesOutcome(filter.outcome)
            || !snapshot.matchesScope(filter.scope)) {
          continue;
        }
        if (total >= filter.offset && items.size() < filter.limit) {
          items.add(snapshot);
        }
        total++;
      }
      return new Page(
          total,
          filter.offset,
          filter.limit,
          ordered.size(),
          returned,
          threw,
          root,
          internal,
          evicted,
          estimatedBytes,
          items);
    }
  }

  Snapshot find(long snapshotId) {
    synchronized (lock) {
      return byId.get(snapshotId);
    }
  }

  boolean delete(long snapshotId) {
    synchronized (lock) {
      Snapshot snapshot = byId.remove(snapshotId);
      if (snapshot == null) {
        return false;
      }
      ordered.remove(snapshot);
      estimatedBytes = Math.max(0L, estimatedBytes - snapshot.estimatedBytes);
      return true;
    }
  }

  int size() {
    synchronized (lock) {
      return ordered.size();
    }
  }

  void clear() {
    synchronized (lock) {
      ordered.clear();
      byId.clear();
      estimatedBytes = 0L;
    }
  }

  private void evictToBounds() {
    while (ordered.size() > maximumSnapshots
        || estimatedBytes > maximumEstimatedBytes) {
      Snapshot removed = ordered.pollFirst();
      if (removed == null) {
        estimatedBytes = 0L;
        return;
      }
      byId.remove(removed.id);
      estimatedBytes = Math.max(0L, estimatedBytes - removed.estimatedBytes);
      evicted++;
    }
  }

  private static String normalizeOutcome(String outcome) {
    String normalized =
        outcome == null ? "ALL" : outcome.trim().toUpperCase(Locale.ROOT);
    if (!"ALL".equals(normalized)
        && !"RETURNED".equals(normalized)
        && !"THREW".equals(normalized)) {
      throw new IllegalArgumentException("outcome is not supported");
    }
    return normalized;
  }

  private static String normalizeScope(String scope) {
    String normalized =
        scope == null ? "ROOT" : scope.trim().toUpperCase(Locale.ROOT);
    if (!"ROOT".equals(normalized) && !"ALL".equals(normalized)) {
      throw new IllegalArgumentException("scope is not supported");
    }
    return normalized;
  }

  private static String normalizeReplay(String replay) {
    String normalized =
        replay == null ? "ALL" : replay.trim().toUpperCase(Locale.ROOT);
    if (!"ALL".equals(normalized)
        && !"REPLAYABLE".equals(normalized)
        && !"STATIC".equals(normalized)
        && !"INSTANCE".equals(normalized)
        && !"UNAVAILABLE".equals(normalized)) {
      throw new IllegalArgumentException("replay filter is not supported");
    }
    return normalized;
  }

  private static List<String> boundedList(
      List<String> source, int maximumItems, int maximumLength) {
    if (source == null || source.isEmpty()) {
      return Collections.emptyList();
    }
    int count = Math.min(source.size(), maximumItems);
    List<String> result = new ArrayList<String>(count);
    for (int index = 0; index < count; index++) {
      result.add(bounded(source.get(index), maximumLength));
    }
    return Collections.unmodifiableList(result);
  }

  private static String bounded(String value, int maximumLength) {
    if (value == null || value.isEmpty()) {
      return "";
    }
    return value.length() <= maximumLength
        ? value
        : value.substring(0, maximumLength) + "…";
  }

  private static String normalizePhase(String value) {
    return value == null || value.isEmpty() ? "FINISH" : bounded(value, 16);
  }

  static boolean replayEligible(
      int depth,
      String modifiers,
      String parameterTypes,
      List<String> arguments) {
    return replayEligible(
        depth, modifiers, parameterTypes, arguments, false, true);
  }

  private static boolean replayEligible(
      int depth,
      String modifiers,
      String parameterTypes,
      List<String> arguments,
      boolean receiverAvailable,
      boolean requireStatic) {
    if (depth != 0 || arguments == null || arguments.size() > 8) {
      return false;
    }
    List<String> modifierTokens =
        java.util.Arrays.asList(
            (modifiers == null ? "" : modifiers).trim().split("\\s+"));
    if (!modifierTokens.contains("public")
        || modifierTokens.contains("abstract")
        || modifierTokens.contains("native")) {
      return false;
    }
    boolean staticMethod = modifierTokens.contains("static");
    if ((requireStatic && !staticMethod) || (!staticMethod && !receiverAvailable)) {
      return false;
    }
    return argumentsReplayable(parameterTypes, arguments);
  }

  private static boolean argumentsReplayable(
      String parameterTypes, List<String> arguments) {
    if (arguments == null || arguments.size() > 8) {
      return false;
    }
    int parameterCount =
        parameterTypes == null || parameterTypes.isEmpty()
            ? 0
            : parameterTypes.split(",", -1).length;
    if (arguments.size() != parameterCount) {
      return false;
    }
    for (String argument : arguments) {
      if (argument == null
          || "null".equals(argument)
          || argument.endsWith("…")
          || (argument.startsWith("<") && argument.endsWith(">"))) {
        return false;
      }
    }
    return true;
  }

  static final class Filter {
    private static final long MAXIMUM_DURATION_MILLIS = 3_600_000L;

    private final String query;
    private final String outcome;
    private final String scope;
    private final String taskId;
    private final String threadQuery;
    private final String replay;
    private final long minimumDurationNanos;
    private final long maximumDurationNanos;
    private final int offset;
    private final int limit;

    Filter(
        String query,
        String outcome,
        String scope,
        String taskId,
        String threadQuery,
        String replay,
        long minimumDurationMillis,
        long maximumDurationMillis,
        int offset,
        int limit) {
      if (offset < 0 || offset > DEFAULT_MAXIMUM_SNAPSHOTS) {
        throw new IllegalArgumentException("offset is outside the allowed range");
      }
      if (limit < 1 || limit > MAXIMUM_PAGE_SIZE) {
        throw new IllegalArgumentException("limit is outside the allowed range");
      }
      if (minimumDurationMillis < 0L
          || minimumDurationMillis > MAXIMUM_DURATION_MILLIS
          || maximumDurationMillis < 0L
          || maximumDurationMillis > MAXIMUM_DURATION_MILLIS) {
        throw new IllegalArgumentException(
            "duration filter is outside the allowed range");
      }
      if (maximumDurationMillis > 0L
          && maximumDurationMillis < minimumDurationMillis) {
        throw new IllegalArgumentException(
            "maximum duration must be zero or greater than the minimum");
      }
      this.query = normalizeText(query, 256, "query").toLowerCase(Locale.ROOT);
      this.outcome = normalizeOutcome(outcome);
      this.scope = normalizeScope(scope);
      this.taskId = normalizeText(taskId, 128, "taskId");
      this.threadQuery =
          normalizeText(threadQuery, 128, "threadQuery")
              .toLowerCase(Locale.ROOT);
      this.replay = normalizeReplay(replay);
      this.minimumDurationNanos = minimumDurationMillis * 1_000_000L;
      this.maximumDurationNanos = maximumDurationMillis * 1_000_000L;
      this.offset = offset;
      this.limit = limit;
    }

    private static String normalizeText(
        String value, int maximumLength, String label) {
      String normalized = value == null ? "" : value.trim();
      if (normalized.length() > maximumLength
          || normalized.indexOf('\r') >= 0
          || normalized.indexOf('\n') >= 0) {
        throw new IllegalArgumentException(
            label + " exceeds its boundary or contains a line break");
      }
      return normalized;
    }
  }

  static final class Snapshot {
    private final long id;
    private final String taskId;
    private final String className;
    private final String classLoader;
    private final String rootMethodName;
    private final String parameterTypes;
    private final String modifiers;
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
    private final ReceiverStateSnapshot receiverState;
    private final InvocationValueSnapshot invocationValues;
    private final String returnValue;
    private final String exceptionType;
    private final String exceptionMessage;
    private final long estimatedBytes;

    private Snapshot(
        long id,
        String taskId,
        String className,
        String classLoader,
        String rootMethodName,
        String parameterTypes,
        String modifiers,
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
        ReceiverStateSnapshot receiverState,
        InvocationValueSnapshot invocationValues,
        String returnValue,
        String exceptionType,
        String exceptionMessage) {
      this.id = id;
      this.taskId = taskId;
      this.className = className;
      this.classLoader = classLoader;
      this.rootMethodName = rootMethodName;
      this.parameterTypes = parameterTypes;
      this.modifiers = modifiers;
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
      this.estimatedBytes = estimateBytes();
    }

    private long estimateBytes() {
      long characters =
          taskId.length()
              + className.length()
              + classLoader.length()
              + rootMethodName.length()
              + parameterTypes.length()
              + modifiers.length()
              + method.length()
              + phase.length()
              + threadName.length()
              + receiverType.length()
              + returnValue.length()
              + exceptionType.length()
              + exceptionMessage.length();
      for (String argument : arguments) {
        characters += argument.length();
      }
      for (String frame : callStack) {
        characters += frame.length();
      }
      for (ReceiverStateSnapshot.FieldValue field : receiverState.getFields()) {
        characters += field.getName().length() + field.getValue().length();
      }
      characters += invocationValues.estimatedCharacters();
      return 256L + characters * 2L;
    }

    private boolean matchesQuery(String query) {
      if (query.isEmpty()) {
        return true;
      }
      if (className.toLowerCase(Locale.ROOT).contains(query)
          || method.toLowerCase(Locale.ROOT).contains(query)
          || threadName.toLowerCase(Locale.ROOT).contains(query)
          || exceptionType.toLowerCase(Locale.ROOT).contains(query)) {
        return true;
      }
      for (String argument : arguments) {
        if (argument.toLowerCase(Locale.ROOT).contains(query)) {
          return true;
        }
      }
      for (ReceiverStateSnapshot.FieldValue field : receiverState.getFields()) {
        if (field.getName().toLowerCase(Locale.ROOT).contains(query)
            || field.getValue().toLowerCase(Locale.ROOT).contains(query)) {
          return true;
        }
      }
      if (invocationValues.matches(query)) {
        return true;
      }
      return returnValue.toLowerCase(Locale.ROOT).contains(query);
    }

    private boolean matchesTask(String requestedTaskId) {
      return requestedTaskId.isEmpty() || taskId.equals(requestedTaskId);
    }

    private boolean matchesThread(String query) {
      return query.isEmpty()
          || threadName.toLowerCase(Locale.ROOT).contains(query);
    }

    private boolean matchesDuration(long minimumNanos, long maximumNanos) {
      return durationNanos >= minimumNanos
          && (maximumNanos == 0L || durationNanos <= maximumNanos);
    }

    private boolean matchesReplay(String replay) {
      if ("ALL".equals(replay)) {
        return true;
      }
      if ("REPLAYABLE".equals(replay)) {
        return isReplayEligible();
      }
      if ("UNAVAILABLE".equals(replay)) {
        return !isReplayEligible();
      }
      return getReplayMode().equals(replay);
    }

    private boolean matchesOutcome(String outcome) {
      return "ALL".equals(outcome)
          || ("THREW".equals(outcome) && isThrew())
          || ("RETURNED".equals(outcome) && !isThrew());
    }

    private boolean matchesScope(String scope) {
      return "ALL".equals(scope) || isRoot();
    }

    long getId() {
      return id;
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

    String getRootMethodName() {
      return rootMethodName;
    }

    String getParameterTypes() {
      return parameterTypes;
    }

    String getModifiers() {
      return modifiers;
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

    String getPhase() {
      return phase;
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

    List<String> getArguments() {
      return arguments;
    }

    List<String> getCallStack() {
      return callStack;
    }

    String getReceiverType() {
      return receiverType;
    }

    ReceiverStateSnapshot getReceiverState() {
      return receiverState;
    }

    InvocationValueSnapshot getInvocationValues() {
      return invocationValues;
    }

    Object getReceiver() {
      return receiverReference == null ? null : receiverReference.get();
    }

    boolean isReceiverAvailable() {
      return getReceiver() != null;
    }

    String getReturnValue() {
      return returnValue;
    }

    String getExceptionType() {
      return exceptionType;
    }

    String getExceptionMessage() {
      return exceptionMessage;
    }

    boolean isRoot() {
      return depth == 0;
    }

    boolean isThrew() {
      return !exceptionType.isEmpty();
    }

    String getReplayMode() {
      List<String> modifierTokens = modifierTokens();
      if (modifierTokens.contains("static")) {
        return "STATIC";
      }
      return receiverReference != null || !receiverType.isEmpty()
          ? "INSTANCE"
          : "NONE";
    }

    String getReplayDeniedReason() {
      if ("BEFORE".equals(phase)) {
        return "BEFORE_EVENT";
      }
      if (depth != 0) {
        return "NOT_ROOT_CALL";
      }
      List<String> modifierTokens = modifierTokens();
      if (!modifierTokens.contains("public")) {
        return "METHOD_NOT_PUBLIC";
      }
      if (modifierTokens.contains("abstract") || modifierTokens.contains("native")) {
        return "METHOD_NOT_EXECUTABLE";
      }
      if (!argumentsReplayable(parameterTypes, arguments)) {
        return "ARGUMENTS_NOT_REPLAYABLE";
      }
      if (!modifierTokens.contains("static") && !isReceiverAvailable()) {
        return "RECEIVER_EXPIRED";
      }
      return "";
    }

    boolean isReplayEligible() {
      return !"BEFORE".equals(phase)
          && replayEligible(
          depth,
          modifiers,
          parameterTypes,
          arguments,
          isReceiverAvailable(),
          false);
    }

    private List<String> modifierTokens() {
      return java.util.Arrays.asList(modifiers.trim().split("\\s+"));
    }
  }

  static final class Page {
    private final int total;
    private final int offset;
    private final int limit;
    private final int retained;
    private final int returned;
    private final int threw;
    private final int root;
    private final int internal;
    private final long evicted;
    private final long estimatedBytes;
    private final List<Snapshot> items;

    private Page(
        int total,
        int offset,
        int limit,
        int retained,
        int returned,
        int threw,
        int root,
        int internal,
        long evicted,
        long estimatedBytes,
        List<Snapshot> items) {
      this.total = total;
      this.offset = offset;
      this.limit = limit;
      this.retained = retained;
      this.returned = returned;
      this.threw = threw;
      this.root = root;
      this.internal = internal;
      this.evicted = evicted;
      this.estimatedBytes = estimatedBytes;
      this.items = Collections.unmodifiableList(new ArrayList<Snapshot>(items));
    }

    int getTotal() {
      return total;
    }

    int getOffset() {
      return offset;
    }

    int getLimit() {
      return limit;
    }

    int getRetained() {
      return retained;
    }

    int getReturned() {
      return returned;
    }

    int getThrew() {
      return threw;
    }

    int getRoot() {
      return root;
    }

    int getInternal() {
      return internal;
    }

    long getEvicted() {
      return evicted;
    }

    long getEstimatedBytes() {
      return estimatedBytes;
    }

    List<Snapshot> getItems() {
      return items;
    }
  }
}
