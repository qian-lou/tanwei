package dev.tanwei.bootstrap;

import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Delayed;
import java.util.concurrent.ForkJoinWorkerThread;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.LongAccumulator;
import java.util.concurrent.atomic.LongAdder;

/**
 * Bootstrap-visible metrics for one exact JDK executor instance.
 *
 * <p>The transformed JDK path never retains the pool or submitted tasks
 * strongly. Submission storage and task-type cardinality have hard limits;
 * every entry point swallows failures so diagnostics cannot alter target
 * control flow.
 */
public final class ThreadPoolLatencyBridge {
  private static final int HISTOGRAM_BUCKETS = 256;
  private static final int HISTOGRAM_SUB_BUCKETS = 4;
  private static final int MAXIMUM_TEXT_LENGTH = 512;
  private static final String OTHER_TASK_TYPE = "<other>";
  private static final ThreadLocal<Execution> EXECUTIONS =
      new ThreadLocal<Execution>();
  private static volatile State active;

  private ThreadPoolLatencyBridge() {}

  public static synchronized void register(
      String taskId,
      Object pool,
      String attributionMode,
      int maximumTracked,
      int maximumTaskTypes) {
    if (taskId == null || taskId.trim().isEmpty()) {
      throw new IllegalArgumentException("latency task identity is required");
    }
    if (pool == null) {
      throw new IllegalArgumentException("thread pool is required");
    }
    boolean waitSupported;
    boolean scheduleSupported;
    if ("QUEUE_AND_RUN".equals(attributionMode)) {
      waitSupported = true;
      scheduleSupported = false;
    } else if ("SCHEDULE_AND_RUN".equals(attributionMode)) {
      waitSupported = false;
      scheduleSupported = true;
    } else if ("RUN_ONLY".equals(attributionMode)) {
      waitSupported = false;
      scheduleSupported = false;
    } else {
      throw new IllegalArgumentException("attribution mode is invalid");
    }
    if (maximumTracked < 128 || maximumTracked > 4_096) {
      throw new IllegalArgumentException(
          "tracked submission limit must be between 128 and 4096");
    }
    if (maximumTaskTypes < 1 || maximumTaskTypes > 64) {
      throw new IllegalArgumentException(
          "task-type limit must be between 1 and 64");
    }
    if (active != null) {
      throw new IllegalStateException(
          "a thread-pool latency task is already active");
    }
    active =
        new State(
            taskId,
            pool,
            waitSupported,
            scheduleSupported,
            maximumTracked,
            maximumTaskTypes);
  }

  public static synchronized void unregister(String taskId) {
    State state = active;
    if (state != null && state.taskId.equals(taskId)) {
      active = null;
      state.clearSubmissions();
    }
  }

  public static void submit(Object pool, Object task) {
    try {
      State state = matchingState(pool);
      if (state != null && task != null) {
        state.submit(task, System.nanoTime());
      }
    } catch (Throwable ignored) {
      // Diagnostics must never alter executor control flow.
    }
  }

  public static void schedule(Object pool, Object task) {
    try {
      State state = matchingState(pool);
      if (state != null && task instanceof Delayed) {
        long observedAtNanos = System.nanoTime();
        long remainingDelayNanos =
            ((Delayed) task).getDelay(TimeUnit.NANOSECONDS);
        state.schedule(task, observedAtNanos, remainingDelayNanos);
      }
    } catch (Throwable ignored) {
      // Diagnostics must never alter scheduled execution control flow.
    }
  }

  public static void reject(Object pool, Object task) {
    try {
      State state = matchingState(pool);
      if (state != null && task != null) {
        state.reject(task);
      }
    } catch (Throwable ignored) {
      // Diagnostics must never alter rejection behavior.
    }
  }

  public static void start(Object pool, Object task) {
    try {
      State state = matchingState(pool);
      startExecution(state, task);
    } catch (Throwable ignored) {
      // Diagnostics must never prevent task execution.
    }
  }

  public static void startForkJoin(Object task) {
    try {
      Thread thread = Thread.currentThread();
      if (!(thread instanceof ForkJoinWorkerThread)) {
        return;
      }
      ForkJoinWorkerThread worker = (ForkJoinWorkerThread) thread;
      startExecution(matchingState(worker.getPool()), task);
    } catch (Throwable ignored) {
      // Diagnostics must never prevent task execution.
    }
  }

  public static void completeSuccess() {
    complete(null);
  }

  public static void completeFailure(Throwable throwable) {
    complete(throwable);
  }

  public static Snapshot snapshot(String taskId) {
    State state = active;
    if (state == null || taskId == null || !state.taskId.equals(taskId)) {
      return Snapshot.EMPTY;
    }
    return state.snapshot();
  }

  public static void complete(Throwable throwable) {
    try {
      Execution execution = EXECUTIONS.get();
      if (execution == null) {
        return;
      }
      if (execution.previous == null) {
        EXECUTIONS.remove();
      } else {
        EXECUTIONS.set(execution.previous);
      }
      State state = execution.state.get();
      if (state != null) {
        state.recordCompletion(
            execution.taskType,
            nonNegativeDifference(System.nanoTime(), execution.startedAtNanos),
            throwable != null);
      }
    } catch (Throwable ignored) {
      // Diagnostics must never alter task completion.
    }
  }

  private static State matchingState(Object pool) {
    State state = active;
    return state != null && state.pool.get() == pool ? state : null;
  }

  private static void startExecution(State state, Object task) {
    if (state == null || task == null) {
      return;
    }
    long now = System.nanoTime();
    SubmissionTiming timing =
        state.waitSupported || state.scheduleSupported
            ? state.takeSubmission(task)
            : null;
    long waitNanos =
        !state.waitSupported
            ? -1L
            : timing == null
                ? -1L
                : nonNegativeDifference(now, timing.observedAtNanos);
    long startLatenessNanos =
        !state.scheduleSupported
            ? -1L
            : timing == null
                ? -1L
                : nonNegativeDifference(now, timing.readyAtNanos);
    String taskType = boundedClassName(task);
    Execution previous = EXECUTIONS.get();
    if (previous != null && previous.state.get() != state) {
      previous = null;
    }
    EXECUTIONS.set(new Execution(state, taskType, now, previous));
    state.recordStart(taskType, waitNanos, startLatenessNanos);
  }

  private static String boundedClassName(Object value) {
    String name = value.getClass().getName();
    return name.length() <= MAXIMUM_TEXT_LENGTH
        ? name
        : name.substring(0, MAXIMUM_TEXT_LENGTH);
  }

  private static long nonNegativeDifference(long end, long start) {
    long difference = end - start;
    return difference < 0L ? 0L : difference;
  }

  private static long saturatingAdd(long left, long right) {
    if (right > 0L && left > Long.MAX_VALUE - right) {
      return Long.MAX_VALUE;
    }
    if (right < 0L && left < Long.MIN_VALUE - right) {
      return Long.MIN_VALUE;
    }
    return left + right;
  }

  private static final class State {
    private final String taskId;
    private final WeakReference<Object> pool;
    private final boolean waitSupported;
    private final boolean scheduleSupported;
    private final int maximumTracked;
    private final int maximumTaskTypes;
    private final Object submissionLock = new Object();
    private final ReferenceQueue<Object> collectedTasks =
        new ReferenceQueue<Object>();
    private final Map<IdentityWeakReference, ArrayDeque<SubmissionTiming>>
        submissions =
            new HashMap<
                IdentityWeakReference, ArrayDeque<SubmissionTiming>>();
    private final Object taskTypeLock = new Object();
    private final ConcurrentMap<String, TypeState> taskTypes =
        new ConcurrentHashMap<String, TypeState>();
    private final LongAdder submitted = new LongAdder();
    private final LongAdder started = new LongAdder();
    private final LongAdder completed = new LongAdder();
    private final LongAdder failures = new LongAdder();
    private final LongAdder rejected = new LongAdder();
    private final LongAdder unmatchedStarts = new LongAdder();
    private final LongAdder droppedSubmissions = new LongAdder();
    private final LongAdder orphanedSubmissions = new LongAdder();
    private final AtomicInteger tracked = new AtomicInteger();
    private final AtomicInteger inFlight = new AtomicInteger();
    private final LongAdder waitObserved = new LongAdder();
    private final LongAdder waitDurationNanos = new LongAdder();
    private final LongAccumulator waitMaximumNanos =
        new LongAccumulator(Math::max, 0L);
    private final Histogram waitHistogram = new Histogram();
    private final LongAdder scheduleDelayObserved = new LongAdder();
    private final LongAdder scheduleDelayDurationNanos = new LongAdder();
    private final LongAccumulator scheduleDelayMaximumNanos =
        new LongAccumulator(Math::max, 0L);
    private final Histogram scheduleDelayHistogram = new Histogram();
    private final LongAdder startLatenessObserved = new LongAdder();
    private final LongAdder startLatenessDurationNanos = new LongAdder();
    private final LongAccumulator startLatenessMaximumNanos =
        new LongAccumulator(Math::max, 0L);
    private final Histogram startLatenessHistogram = new Histogram();
    private final LongAdder runDurationNanos = new LongAdder();
    private final LongAccumulator runMaximumNanos =
        new LongAccumulator(Math::max, 0L);
    private final Histogram runHistogram = new Histogram();

    private State(
        String taskId,
        Object pool,
        boolean waitSupported,
        boolean scheduleSupported,
        int maximumTracked,
        int maximumTaskTypes) {
      this.taskId = taskId;
      this.pool = new WeakReference<Object>(pool);
      this.waitSupported = waitSupported;
      this.scheduleSupported = scheduleSupported;
      this.maximumTracked = maximumTracked;
      this.maximumTaskTypes = maximumTaskTypes;
    }

    private void submit(Object task, long submittedAtNanos) {
      submitted.increment();
      trackSubmission(task, SubmissionTiming.queued(submittedAtNanos));
    }

    private void schedule(
        Object task, long observedAtNanos, long remainingDelayNanos) {
      if (!scheduleSupported) {
        return;
      }
      submitted.increment();
      long requestedDelayNanos = Math.max(0L, remainingDelayNanos);
      scheduleDelayObserved.increment();
      scheduleDelayDurationNanos.add(requestedDelayNanos);
      scheduleDelayMaximumNanos.accumulate(requestedDelayNanos);
      scheduleDelayHistogram.record(requestedDelayNanos);
      TypeState type = typeState(boundedClassName(task));
      type.scheduleDelayObserved.increment();
      type.scheduleDelayDurationNanos.add(requestedDelayNanos);
      type.scheduleDelayMaximumNanos.accumulate(requestedDelayNanos);
      trackSubmission(
          task,
          SubmissionTiming.scheduled(
              observedAtNanos, remainingDelayNanos));
    }

    private void trackSubmission(
        Object task, SubmissionTiming timing) {
      synchronized (submissionLock) {
        drainCollectedTasks();
        if (tracked.get() >= maximumTracked) {
          droppedSubmissions.increment();
          return;
        }
        IdentityWeakReference lookup = new IdentityWeakReference(task, null);
        ArrayDeque<SubmissionTiming> times = submissions.get(lookup);
        if (times == null) {
          times = new ArrayDeque<SubmissionTiming>();
          submissions.put(
              new IdentityWeakReference(task, collectedTasks), times);
        }
        times.addLast(timing);
        tracked.incrementAndGet();
      }
    }

    private void reject(Object task) {
      rejected.increment();
      takeSubmission(task);
    }

    private SubmissionTiming takeSubmission(Object task) {
      synchronized (submissionLock) {
        drainCollectedTasks();
        IdentityWeakReference lookup = new IdentityWeakReference(task, null);
        ArrayDeque<SubmissionTiming> times = submissions.get(lookup);
        if (times == null || times.isEmpty()) {
          return null;
        }
        SubmissionTiming value = times.removeFirst();
        tracked.decrementAndGet();
        if (times.isEmpty()) {
          submissions.remove(lookup);
        }
        return value;
      }
    }

    private void drainCollectedTasks() {
      IdentityWeakReference reference;
      while ((reference =
              (IdentityWeakReference) collectedTasks.poll())
          != null) {
        ArrayDeque<SubmissionTiming> times = submissions.remove(reference);
        if (times != null && !times.isEmpty()) {
          int count = times.size();
          tracked.addAndGet(-count);
          orphanedSubmissions.add(count);
        }
      }
    }

    private void clearSubmissions() {
      synchronized (submissionLock) {
        drainCollectedTasks();
        int remaining = tracked.getAndSet(0);
        if (remaining > 0) {
          orphanedSubmissions.add(remaining);
        }
        submissions.clear();
        while (collectedTasks.poll() != null) {
          // Fully drain references owned by this bounded state.
        }
      }
    }

    private void recordStart(
        String taskType, long waitNanos, long startLatenessNanos) {
      started.increment();
      inFlight.incrementAndGet();
      TypeState type = typeState(taskType);
      type.started.increment();
      if (waitNanos < 0L && startLatenessNanos < 0L) {
        if (waitSupported || scheduleSupported) {
          unmatchedStarts.increment();
        }
        return;
      }
      if (waitNanos >= 0L) {
        waitObserved.increment();
        waitDurationNanos.add(waitNanos);
        waitMaximumNanos.accumulate(waitNanos);
        waitHistogram.record(waitNanos);
        type.waitObserved.increment();
        type.waitDurationNanos.add(waitNanos);
        type.waitMaximumNanos.accumulate(waitNanos);
      }
      if (startLatenessNanos >= 0L) {
        startLatenessObserved.increment();
        startLatenessDurationNanos.add(startLatenessNanos);
        startLatenessMaximumNanos.accumulate(startLatenessNanos);
        startLatenessHistogram.record(startLatenessNanos);
        type.startLatenessObserved.increment();
        type.startLatenessDurationNanos.add(startLatenessNanos);
        type.startLatenessMaximumNanos.accumulate(startLatenessNanos);
      }
    }

    private void recordCompletion(
        String taskType, long runNanos, boolean failed) {
      completed.increment();
      decrementNonNegative(inFlight);
      runDurationNanos.add(runNanos);
      runMaximumNanos.accumulate(runNanos);
      runHistogram.record(runNanos);
      if (failed) {
        failures.increment();
      }
      TypeState type = typeState(taskType);
      type.completed.increment();
      type.runDurationNanos.add(runNanos);
      type.runMaximumNanos.accumulate(runNanos);
      if (failed) {
        type.failures.increment();
      }
    }

    private TypeState typeState(String taskType) {
      TypeState existing = taskTypes.get(taskType);
      if (existing != null) {
        return existing;
      }
      synchronized (taskTypeLock) {
        existing = taskTypes.get(taskType);
        if (existing != null) {
          return existing;
        }
        String selected =
            taskTypes.size() < maximumTaskTypes
                ? taskType
                : OTHER_TASK_TYPE;
        existing = taskTypes.get(selected);
        if (existing == null) {
          existing = new TypeState(selected);
          taskTypes.put(selected, existing);
        }
        return existing;
      }
    }

    private Snapshot snapshot() {
      synchronized (submissionLock) {
        drainCollectedTasks();
      }
      List<TypeSnapshot> types =
          new ArrayList<TypeSnapshot>(taskTypes.size());
      for (TypeState type : taskTypes.values()) {
        types.add(type.snapshot());
      }
      Collections.sort(
          types,
          new Comparator<TypeSnapshot>() {
            @Override
            public int compare(TypeSnapshot left, TypeSnapshot right) {
              int byRun =
                  Long.compare(
                      right.runDurationNanos,
                      left.runDurationNanos);
              if (byRun != 0) {
                return byRun;
              }
              int byWait =
                  Long.compare(
                      right.waitDurationNanos,
                      left.waitDurationNanos);
              return byWait != 0
                  ? byWait
                  : left.className.compareTo(right.className);
            }
          });
      long[] waitDistribution = waitHistogram.snapshot();
      long[] scheduleDelayDistribution = scheduleDelayHistogram.snapshot();
      long[] startLatenessDistribution = startLatenessHistogram.snapshot();
      long[] runDistribution = runHistogram.snapshot();
      long failureCount = failures.sum();
      long completedCount = completed.sum();
      long waitObservedCount = waitObserved.sum();
      long unmatchedStartCount = unmatchedStarts.sum();
      long startedCount = started.sum();
      long submittedCount = submitted.sum();
      return new Snapshot(
          taskId,
          submittedCount,
          startedCount,
          completedCount,
          failureCount,
          rejected.sum(),
          unmatchedStartCount,
          droppedSubmissions.sum(),
          orphanedSubmissions.sum(),
          Math.max(0, tracked.get()),
          Math.max(0, inFlight.get()),
          waitObservedCount,
          waitDurationNanos.sum(),
          waitMaximumNanos.get(),
          percentileNanos(waitDistribution, 95),
          percentileNanos(waitDistribution, 99),
          scheduleDelayObserved.sum(),
          scheduleDelayDurationNanos.sum(),
          scheduleDelayMaximumNanos.get(),
          percentileNanos(scheduleDelayDistribution, 95),
          percentileNanos(scheduleDelayDistribution, 99),
          startLatenessObserved.sum(),
          startLatenessDurationNanos.sum(),
          startLatenessMaximumNanos.get(),
          percentileNanos(startLatenessDistribution, 95),
          percentileNanos(startLatenessDistribution, 99),
          runDurationNanos.sum(),
          runMaximumNanos.get(),
          percentileNanos(runDistribution, 95),
          percentileNanos(runDistribution, 99),
          types.toArray(new TypeSnapshot[types.size()]));
    }
  }

  private static void decrementNonNegative(AtomicInteger value) {
    while (true) {
      int current = value.get();
      if (current <= 0 || value.compareAndSet(current, current - 1)) {
        return;
      }
    }
  }

  private static final class SubmissionTiming {
    private final long observedAtNanos;
    private final long readyAtNanos;

    private SubmissionTiming(long observedAtNanos, long readyAtNanos) {
      this.observedAtNanos = observedAtNanos;
      this.readyAtNanos = readyAtNanos;
    }

    private static SubmissionTiming queued(long submittedAtNanos) {
      return new SubmissionTiming(submittedAtNanos, submittedAtNanos);
    }

    private static SubmissionTiming scheduled(
        long observedAtNanos, long remainingDelayNanos) {
      return new SubmissionTiming(
          observedAtNanos,
          saturatingAdd(observedAtNanos, remainingDelayNanos));
    }
  }

  private static final class IdentityWeakReference
      extends WeakReference<Object> {
    private final int identityHash;

    private IdentityWeakReference(
        Object value, ReferenceQueue<Object> queue) {
      super(value, queue);
      identityHash = System.identityHashCode(value);
    }

    @Override
    public int hashCode() {
      return identityHash;
    }

    @Override
    public boolean equals(Object other) {
      if (this == other) {
        return true;
      }
      if (!(other instanceof IdentityWeakReference)) {
        return false;
      }
      Object left = get();
      Object right = ((IdentityWeakReference) other).get();
      return left != null && left == right;
    }
  }

  private static final class Execution {
    private final WeakReference<State> state;
    private final String taskType;
    private final long startedAtNanos;
    private final Execution previous;

    private Execution(
        State state,
        String taskType,
        long startedAtNanos,
        Execution previous) {
      this.state = new WeakReference<State>(state);
      this.taskType = taskType;
      this.startedAtNanos = startedAtNanos;
      this.previous = previous;
    }
  }

  private static final class TypeState {
    private final String className;
    private final LongAdder started = new LongAdder();
    private final LongAdder completed = new LongAdder();
    private final LongAdder failures = new LongAdder();
    private final LongAdder waitObserved = new LongAdder();
    private final LongAdder waitDurationNanos = new LongAdder();
    private final LongAccumulator waitMaximumNanos =
        new LongAccumulator(Math::max, 0L);
    private final LongAdder scheduleDelayObserved = new LongAdder();
    private final LongAdder scheduleDelayDurationNanos = new LongAdder();
    private final LongAccumulator scheduleDelayMaximumNanos =
        new LongAccumulator(Math::max, 0L);
    private final LongAdder startLatenessObserved = new LongAdder();
    private final LongAdder startLatenessDurationNanos = new LongAdder();
    private final LongAccumulator startLatenessMaximumNanos =
        new LongAccumulator(Math::max, 0L);
    private final LongAdder runDurationNanos = new LongAdder();
    private final LongAccumulator runMaximumNanos =
        new LongAccumulator(Math::max, 0L);

    private TypeState(String className) {
      this.className = className;
    }

    private TypeSnapshot snapshot() {
      long failureCount = failures.sum();
      long completedCount = completed.sum();
      long waitObservedCount = waitObserved.sum();
      long startedCount = started.sum();
      return new TypeSnapshot(
          className,
          startedCount,
          completedCount,
          failureCount,
          waitObservedCount,
          waitDurationNanos.sum(),
          waitMaximumNanos.get(),
          scheduleDelayObserved.sum(),
          scheduleDelayDurationNanos.sum(),
          scheduleDelayMaximumNanos.get(),
          startLatenessObserved.sum(),
          startLatenessDurationNanos.sum(),
          startLatenessMaximumNanos.get(),
          runDurationNanos.sum(),
          runMaximumNanos.get());
    }
  }

  private static final class Histogram {
    private final LongAdder[] buckets =
        new LongAdder[HISTOGRAM_BUCKETS];

    private Histogram() {
      for (int index = 0; index < buckets.length; index++) {
        buckets[index] = new LongAdder();
      }
    }

    private void record(long durationNanos) {
      buckets[histogramBucket(durationNanos)].increment();
    }

    private long[] snapshot() {
      long[] result = new long[buckets.length];
      for (int index = 0; index < buckets.length; index++) {
        result[index] = buckets[index].sum();
      }
      return result;
    }
  }

  private static int histogramBucket(long durationNanos) {
    if (durationNanos <= 1L) {
      return 0;
    }
    int exponent = 63 - Long.numberOfLeadingZeros(durationNanos);
    long base = 1L << exponent;
    long offset = durationNanos - base;
    int subBucket =
        exponent < 2
            ? (int) ((offset * HISTOGRAM_SUB_BUCKETS) / base)
            : (int) (offset >>> (exponent - 2));
    return Math.min(
        HISTOGRAM_BUCKETS - 1,
        exponent * HISTOGRAM_SUB_BUCKETS
            + Math.min(HISTOGRAM_SUB_BUCKETS - 1, subBucket));
  }

  private static long histogramUpperBoundNanos(int bucket) {
    if (bucket <= 0) {
      return 1L;
    }
    int bounded = Math.min(HISTOGRAM_BUCKETS - 1, bucket);
    int exponent = bounded / HISTOGRAM_SUB_BUCKETS;
    int subBucket = bounded % HISTOGRAM_SUB_BUCKETS;
    if (exponent >= 62) {
      return Long.MAX_VALUE;
    }
    long base = 1L << exponent;
    long increment =
        (base * (subBucket + 1L) + HISTOGRAM_SUB_BUCKETS - 1L)
            / HISTOGRAM_SUB_BUCKETS;
    return saturatingAdd(base, increment);
  }

  private static long percentileNanos(
      long[] distribution, int percentile) {
    long count = 0L;
    for (long value : distribution) {
      count = saturatingAdd(count, value);
    }
    if (count <= 0L) {
      return 0L;
    }
    long rank =
        Math.max(
            1L,
            (long) Math.ceil(count * (percentile / 100.0d)));
    long cumulative = 0L;
    for (int index = 0; index < distribution.length; index++) {
      cumulative = saturatingAdd(cumulative, distribution[index]);
      if (cumulative >= rank) {
        return histogramUpperBoundNanos(index);
      }
    }
    return histogramUpperBoundNanos(distribution.length - 1);
  }

  public static final class Snapshot {
    private static final Snapshot EMPTY =
        new Snapshot(
            "",
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
            new TypeSnapshot[0]);

    private final String taskId;
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
    private final TypeSnapshot[] taskTypes;

    private Snapshot(
        String taskId,
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
        TypeSnapshot[] taskTypes) {
      this.taskId = taskId;
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
      this.taskTypes = taskTypes.clone();
    }

    public String getTaskId() { return taskId; }
    public long getSubmitted() { return submitted; }
    public long getStarted() { return started; }
    public long getCompleted() { return completed; }
    public long getFailures() { return failures; }
    public long getRejected() { return rejected; }
    public long getUnmatchedStarts() { return unmatchedStarts; }
    public long getDroppedSubmissions() { return droppedSubmissions; }
    public long getOrphanedSubmissions() { return orphanedSubmissions; }
    public int getPendingTracked() { return pendingTracked; }
    public int getInFlight() { return inFlight; }
    public long getWaitObserved() { return waitObserved; }
    public long getWaitDurationNanos() { return waitDurationNanos; }
    public long getWaitMaximumNanos() { return waitMaximumNanos; }
    public long getWaitP95Nanos() { return waitP95Nanos; }
    public long getWaitP99Nanos() { return waitP99Nanos; }
    public long getScheduleDelayObserved() { return scheduleDelayObserved; }
    public long getScheduleDelayDurationNanos() { return scheduleDelayDurationNanos; }
    public long getScheduleDelayMaximumNanos() { return scheduleDelayMaximumNanos; }
    public long getScheduleDelayP95Nanos() { return scheduleDelayP95Nanos; }
    public long getScheduleDelayP99Nanos() { return scheduleDelayP99Nanos; }
    public long getStartLatenessObserved() { return startLatenessObserved; }
    public long getStartLatenessDurationNanos() { return startLatenessDurationNanos; }
    public long getStartLatenessMaximumNanos() { return startLatenessMaximumNanos; }
    public long getStartLatenessP95Nanos() { return startLatenessP95Nanos; }
    public long getStartLatenessP99Nanos() { return startLatenessP99Nanos; }
    public long getRunDurationNanos() { return runDurationNanos; }
    public long getRunMaximumNanos() { return runMaximumNanos; }
    public long getRunP95Nanos() { return runP95Nanos; }
    public long getRunP99Nanos() { return runP99Nanos; }
    public TypeSnapshot[] getTaskTypes() { return taskTypes.clone(); }
  }

  public static final class TypeSnapshot {
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

    public String getClassName() { return className; }
    public long getStarted() { return started; }
    public long getCompleted() { return completed; }
    public long getFailures() { return failures; }
    public long getWaitObserved() { return waitObserved; }
    public long getWaitDurationNanos() { return waitDurationNanos; }
    public long getWaitMaximumNanos() { return waitMaximumNanos; }
    public long getScheduleDelayObserved() { return scheduleDelayObserved; }
    public long getScheduleDelayDurationNanos() { return scheduleDelayDurationNanos; }
    public long getScheduleDelayMaximumNanos() { return scheduleDelayMaximumNanos; }
    public long getStartLatenessObserved() { return startLatenessObserved; }
    public long getStartLatenessDurationNanos() { return startLatenessDurationNanos; }
    public long getStartLatenessMaximumNanos() { return startLatenessMaximumNanos; }
    public long getRunDurationNanos() { return runDurationNanos; }
    public long getRunMaximumNanos() { return runMaximumNanos; }
  }
}
