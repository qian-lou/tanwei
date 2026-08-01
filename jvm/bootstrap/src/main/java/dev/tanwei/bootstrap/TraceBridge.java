package dev.tanwei.bootstrap;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Bootstrap-visible bridge for bounded cross-class method traces.
 *
 * <p>Methods outside an active root trace perform only a task lookup and a
 * ThreadLocal lookup. Active traces use O(1) enter/exit bookkeeping; completed
 * traces sort at most 512 spans by their pre-order sequence.
 */
public final class TraceBridge {
  private static final ConcurrentMap<String, TaskState> TASKS =
      new ConcurrentHashMap<String, TaskState>();
  private static final ThreadLocal<Map<String, TraceContext>> ACTIVE =
      new ThreadLocal<Map<String, TraceContext>>();

  private TraceBridge() {}

  public static void register(
      String taskId,
      int maximumTraces,
      int maximumDepth,
      int maximumSpans,
      long minimumDurationNanos) {
    if (taskId == null || taskId.trim().isEmpty()) {
      throw new IllegalArgumentException("trace task identity is required");
    }
    if (maximumTraces <= 0
        || maximumDepth <= 0
        || maximumSpans <= 0
        || minimumDurationNanos < 0L) {
      throw new IllegalArgumentException("trace bounds must be positive");
    }
    TaskState previous =
        TASKS.putIfAbsent(
            taskId,
            new TaskState(
                maximumTraces,
                maximumDepth,
                maximumSpans,
                minimumDurationNanos));
    if (previous != null) {
      throw new IllegalStateException("trace task identity is already registered");
    }
  }

  public static void unregister(String taskId) {
    if (taskId != null) {
      TASKS.remove(taskId);
    }
  }

  /**
   * Updates the root-call duration filter without retransformation.
   *
   * <p>The volatile write is observed when a root invocation completes, so an
   * invocation already in flight follows the most recently applied threshold.
   */
  public static long updateMinimumDuration(
      String taskId, long minimumDurationNanos) {
    if (minimumDurationNanos < 0L) {
      throw new IllegalArgumentException(
          "trace minimum duration must not be negative");
    }
    TaskState state = TASKS.get(taskId);
    if (state == null) {
      throw new IllegalStateException("trace task is not registered");
    }
    long previous = state.minimumDurationNanos;
    state.minimumDurationNanos = minimumDurationNanos;
    return previous;
  }

  public static long enter(
      String taskId, String method, boolean rootMethod) {
    return enter(taskId, method, rootMethod, "", -1);
  }

  public static long enter(
      String taskId,
      String method,
      boolean rootMethod,
      String sourceFile,
      int sourceLine) {
    try {
      TaskState state = TASKS.get(taskId);
      if (state == null || state.captured.get() >= state.maximumTraces) {
        return 0L;
      }
      Map<String, TraceContext> byTask = ACTIVE.get();
      TraceContext context = byTask == null ? null : byTask.get(taskId);
      if (context == null) {
        if (!rootMethod) {
          return 0L;
        }
        if (byTask == null) {
          byTask = new HashMap<String, TraceContext>();
          ACTIVE.set(byTask);
        }
        Thread thread = Thread.currentThread();
        context =
            new TraceContext(
                state.traceSequence.getAndIncrement(),
                System.nanoTime(),
                thread.getId(),
                safeThreadName(thread),
                thread.isDaemon(),
                thread.getPriority(),
                safeThreadGroup(thread),
                safeContextClassLoader(thread));
        byTask.put(taskId, context);
      }
      Invocation parent = context.stack.peek();
      String callSiteFile = parent == null ? "" : parent.nextCallSiteFile;
      int callSiteLine = parent == null ? -1 : parent.nextCallSiteLine;
      if (parent != null) {
        parent.nextCallSiteFile = "";
        parent.nextCallSiteLine = -1;
      }
      if (context.stack.size() >= state.maximumDepth
          || context.reservedSpans >= state.maximumSpans) {
        context.truncatedSpans++;
        state.dropped.incrementAndGet();
        return 0L;
      }
      long sequence = context.nextSpanSequence++;
      long parentSequence = parent == null ? -1L : parent.sequence;
      Invocation invocation =
          new Invocation(
              sequence,
              parentSequence,
              context.stack.size(),
              method == null ? "" : method,
              sourceFile == null ? "" : sourceFile,
              sourceLine,
              callSiteFile,
              callSiteLine,
              System.nanoTime());
      context.stack.push(invocation);
      context.reservedSpans++;
      return sequence + 1L;
    } catch (Throwable ignored) {
      return 0L;
    }
  }

  public static void exit(
      String taskId, long token, Throwable throwable) {
    if (token == 0L) {
      return;
    }
    try {
      Map<String, TraceContext> byTask = ACTIVE.get();
      TraceContext context = byTask == null ? null : byTask.get(taskId);
      if (context == null || context.stack.isEmpty()) {
        cleanupThreadLocal(byTask);
        return;
      }
      Invocation invocation = context.stack.pop();
      if (invocation.sequence + 1L != token) {
        byTask.remove(taskId);
        cleanupThreadLocal(byTask);
        TaskState mismatched = TASKS.get(taskId);
        if (mismatched != null) {
          mismatched.dropped.incrementAndGet();
        }
        return;
      }
      long durationNanos =
          Math.max(0L, System.nanoTime() - invocation.startedAtNanos);
      context.spans.add(
          new Span(
              invocation.sequence,
              invocation.parentSequence,
              invocation.depth,
              invocation.method,
              invocation.sourceFile,
              invocation.sourceLine,
              invocation.callSiteFile,
              invocation.callSiteLine,
              durationNanos,
              throwable == null ? "" : throwable.getClass().getName(),
              throwable == null ? "" : safeMessage(throwable)));
      if (!context.stack.isEmpty()) {
        return;
      }

      byTask.remove(taskId);
      cleanupThreadLocal(byTask);
      TaskState state = TASKS.get(taskId);
      if (state == null) {
        return;
      }
      long traceDurationNanos =
          Math.max(0L, System.nanoTime() - context.startedAtNanos);
      if (traceDurationNanos < state.minimumDurationNanos
          || !reserveCapture(state)) {
        return;
      }
      Collections.sort(
          context.spans,
          Comparator.comparingLong(Span::getSequence));
      Trace trace =
          new Trace(
              context.traceId,
              System.currentTimeMillis(),
              traceDurationNanos,
              context.threadId,
              context.threadName,
              context.threadDaemon,
              context.threadPriority,
              context.threadGroup,
              context.contextClassLoader,
              context.truncatedSpans,
              context.spans);
      if (!state.traces.offer(trace)) {
        state.dropped.incrementAndGet();
      }
    } catch (Throwable ignored) {
      // Trace collection must never alter target method control flow.
    }
  }

  /** Records the exact direct-call source location for the next traced child. */
  public static void callSite(
      String taskId, String sourceFile, int sourceLine) {
    try {
      if (!TASKS.containsKey(taskId)) {
        return;
      }
      Map<String, TraceContext> byTask = ACTIVE.get();
      TraceContext context = byTask == null ? null : byTask.get(taskId);
      if (context == null || context.stack.isEmpty()) {
        return;
      }
      Invocation invocation = context.stack.peek();
      invocation.nextCallSiteFile = sourceFile == null ? "" : sourceFile;
      invocation.nextCallSiteLine = sourceLine;
    } catch (Throwable ignored) {
      // Call-site collection must never alter target method control flow.
    }
  }

  public static List<Trace> drain(String taskId, int limit) {
    TaskState state = TASKS.get(taskId);
    if (state == null || limit <= 0) {
      return Collections.emptyList();
    }
    List<Trace> traces =
        new ArrayList<Trace>(Math.min(limit, state.maximumTraces));
    state.traces.drainTo(traces, limit);
    return traces;
  }

  public static int captured(String taskId) {
    TaskState state = TASKS.get(taskId);
    return state == null ? 0 : state.captured.get();
  }

  public static int dropped(String taskId) {
    TaskState state = TASKS.get(taskId);
    return state == null ? 0 : state.dropped.get();
  }

  private static boolean reserveCapture(TaskState state) {
    while (true) {
      int captured = state.captured.get();
      if (captured >= state.maximumTraces) {
        return false;
      }
      if (state.captured.compareAndSet(captured, captured + 1)) {
        return true;
      }
    }
  }

  private static void cleanupThreadLocal(
      Map<String, TraceContext> byTask) {
    if (byTask != null && byTask.isEmpty()) {
      ACTIVE.remove();
    }
  }

  private static String safeMessage(Throwable throwable) {
    try {
      String message = throwable.getMessage();
      if (message == null) {
        return "";
      }
      return message.length() <= 256
          ? message
          : message.substring(0, 256) + "…";
    } catch (Throwable ignored) {
      return "";
    }
  }

  private static String safeThreadName(Thread thread) {
    try {
      return bounded(thread.getName(), 256);
    } catch (Throwable ignored) {
      return "";
    }
  }

  private static String safeThreadGroup(Thread thread) {
    try {
      ThreadGroup group = thread.getThreadGroup();
      return group == null ? "" : bounded(group.getName(), 256);
    } catch (Throwable ignored) {
      return "";
    }
  }

  private static String safeContextClassLoader(Thread thread) {
    try {
      ClassLoader loader = thread.getContextClassLoader();
      return loader == null ? "bootstrap" : bounded(loader.toString(), 512);
    } catch (Throwable ignored) {
      return "";
    }
  }

  private static String bounded(String value, int maximumLength) {
    if (value == null) {
      return "";
    }
    return value.length() <= maximumLength
        ? value
        : value.substring(0, maximumLength) + "…";
  }

  private static final class TaskState {
    private final int maximumTraces;
    private final int maximumDepth;
    private final int maximumSpans;
    private volatile long minimumDurationNanos;
    private final ArrayBlockingQueue<Trace> traces;
    private final AtomicInteger captured = new AtomicInteger();
    private final AtomicInteger dropped = new AtomicInteger();
    private final AtomicLong traceSequence = new AtomicLong(1L);

    private TaskState(
        int maximumTraces,
        int maximumDepth,
        int maximumSpans,
        long minimumDurationNanos) {
      this.maximumTraces = maximumTraces;
      this.maximumDepth = maximumDepth;
      this.maximumSpans = maximumSpans;
      this.minimumDurationNanos = minimumDurationNanos;
      this.traces = new ArrayBlockingQueue<Trace>(maximumTraces);
    }
  }

  private static final class TraceContext {
    private final long traceId;
    private final long startedAtNanos;
    private final long threadId;
    private final String threadName;
    private final boolean threadDaemon;
    private final int threadPriority;
    private final String threadGroup;
    private final String contextClassLoader;
    private final Deque<Invocation> stack = new ArrayDeque<Invocation>();
    private final List<Span> spans = new ArrayList<Span>();
    private long nextSpanSequence;
    private int reservedSpans;
    private int truncatedSpans;

    private TraceContext(
        long traceId,
        long startedAtNanos,
        long threadId,
        String threadName,
        boolean threadDaemon,
        int threadPriority,
        String threadGroup,
        String contextClassLoader) {
      this.traceId = traceId;
      this.startedAtNanos = startedAtNanos;
      this.threadId = threadId;
      this.threadName = threadName;
      this.threadDaemon = threadDaemon;
      this.threadPriority = threadPriority;
      this.threadGroup = threadGroup;
      this.contextClassLoader = contextClassLoader;
    }
  }

  private static final class Invocation {
    private final long sequence;
    private final long parentSequence;
    private final int depth;
    private final String method;
    private final String sourceFile;
    private final int sourceLine;
    private final String callSiteFile;
    private final int callSiteLine;
    private final long startedAtNanos;
    private String nextCallSiteFile = "";
    private int nextCallSiteLine = -1;

    private Invocation(
        long sequence,
        long parentSequence,
        int depth,
        String method,
        String sourceFile,
        int sourceLine,
        String callSiteFile,
        int callSiteLine,
        long startedAtNanos) {
      this.sequence = sequence;
      this.parentSequence = parentSequence;
      this.depth = depth;
      this.method = method;
      this.sourceFile = sourceFile;
      this.sourceLine = sourceLine;
      this.callSiteFile = callSiteFile;
      this.callSiteLine = callSiteLine;
      this.startedAtNanos = startedAtNanos;
    }
  }

  public static final class Trace {
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
    private final List<Span> spans;

    private Trace(
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
        List<Span> spans) {
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
      this.spans =
          Collections.unmodifiableList(new ArrayList<Span>(spans));
    }

    public long getTraceId() {
      return traceId;
    }

    public long getCapturedAtEpochMillis() {
      return capturedAtEpochMillis;
    }

    public long getDurationNanos() {
      return durationNanos;
    }

    public String getThreadName() {
      return threadName;
    }

    public long getThreadId() {
      return threadId;
    }

    public boolean isThreadDaemon() {
      return threadDaemon;
    }

    public int getThreadPriority() {
      return threadPriority;
    }

    public String getThreadGroup() {
      return threadGroup;
    }

    public String getContextClassLoader() {
      return contextClassLoader;
    }

    public int getTruncatedSpans() {
      return truncatedSpans;
    }

    public List<Span> getSpans() {
      return spans;
    }
  }

  public static final class Span {
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

    private Span(
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

    public long getSequence() {
      return sequence;
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

    public long getDurationNanos() {
      return durationNanos;
    }

    public String getSourceFile() {
      return sourceFile;
    }

    public int getSourceLine() {
      return sourceLine;
    }

    public String getCallSiteFile() {
      return callSiteFile;
    }

    public int getCallSiteLine() {
      return callSiteLine;
    }

    public String getExceptionType() {
      return exceptionType;
    }

    public String getExceptionMessage() {
      return exceptionMessage;
    }
  }
}
