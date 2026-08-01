package dev.tanwei.bootstrap;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.LongAccumulator;
import java.util.concurrent.atomic.LongAdder;

/**
 * A bootstrap-visible, allocation-free method metrics bridge.
 *
 * <p>The transformed application method only performs a map lookup, reads the
 * monotonic clock and updates striped counters. Window resets are deliberately
 * relaxed under concurrency: an invocation finishing exactly on a window
 * boundary may be attributed to either adjacent window, while cumulative
 * counters remain monotonic.
 */
public final class MethodMonitorBridge {
  private static final int HISTOGRAM_BUCKETS = 256;
  private static final int HISTOGRAM_SUB_BUCKETS = 4;
  private static final ConcurrentMap<String, State> TASKS =
      new ConcurrentHashMap<String, State>();

  private MethodMonitorBridge() {}

  public static void register(String taskId) {
    register(taskId, 0L);
  }

  public static void register(
      String taskId, long minimumDurationNanos) {
    if (taskId == null || taskId.trim().isEmpty()) {
      throw new IllegalArgumentException("monitor task identity is required");
    }
    if (minimumDurationNanos < 0L) {
      throw new IllegalArgumentException(
          "minimum monitor duration must not be negative");
    }
    State previous =
        TASKS.putIfAbsent(taskId, new State(minimumDurationNanos));
    if (previous != null) {
      throw new IllegalStateException("monitor task identity is already registered");
    }
  }

  public static long updateMinimumDuration(
      String taskId, long minimumDurationNanos) {
    if (minimumDurationNanos < 0L) {
      throw new IllegalArgumentException(
          "minimum monitor duration must not be negative");
    }
    State state = TASKS.get(taskId);
    if (state == null) {
      throw new IllegalStateException("monitor task identity is not registered");
    }
    long previous = state.minimumDurationNanos;
    state.minimumDurationNanos = minimumDurationNanos;
    return previous;
  }

  public static void unregister(String taskId) {
    if (taskId != null) {
      TASKS.remove(taskId);
    }
  }

  public static long enter(String taskId) {
    try {
      if (!TASKS.containsKey(taskId)) {
        return 0L;
      }
      long startedAtNanos = System.nanoTime();
      return startedAtNanos == 0L ? 1L : startedAtNanos;
    } catch (Throwable ignored) {
      return 0L;
    }
  }

  public static void exit(
      String taskId, long startedAtNanos, Throwable throwable) {
    if (startedAtNanos == 0L) {
      return;
    }
    try {
      State state = TASKS.get(taskId);
      if (state == null) {
        return;
      }
      long durationNanos = System.nanoTime() - startedAtNanos;
      if (durationNanos < 0L) {
        durationNanos = 0L;
      }
      state.record(durationNanos, throwable != null);
    } catch (Throwable ignored) {
      // Diagnostics must never alter application control flow.
    }
  }

  public static Snapshot snapshot(String taskId, boolean resetWindow) {
    State state = TASKS.get(taskId);
    if (state == null) {
      return Snapshot.EMPTY;
    }
    return state.snapshot(resetWindow);
  }

  private static final class State {
    private final LongAdder windowCalls = new LongAdder();
    private final LongAdder windowFailures = new LongAdder();
    private final LongAdder windowDurationNanos = new LongAdder();
    private final LongAccumulator windowMaximumDurationNanos =
        new LongAccumulator(Math::max, 0L);
    private final LongAdder totalCalls = new LongAdder();
    private final LongAdder totalFailures = new LongAdder();
    private final LongAdder totalDurationNanos = new LongAdder();
    private final LongAccumulator totalMaximumDurationNanos =
        new LongAccumulator(Math::max, 0L);
    private final Histogram windowHistogram = new Histogram();
    private final Histogram totalHistogram = new Histogram();
    private volatile long minimumDurationNanos;

    private State(long minimumDurationNanos) {
      this.minimumDurationNanos = minimumDurationNanos;
    }

    private void record(long durationNanos, boolean failed) {
      if (durationNanos < minimumDurationNanos) {
        return;
      }
      windowCalls.increment();
      totalCalls.increment();
      if (failed) {
        windowFailures.increment();
        totalFailures.increment();
      }
      windowDurationNanos.add(durationNanos);
      totalDurationNanos.add(durationNanos);
      windowMaximumDurationNanos.accumulate(durationNanos);
      totalMaximumDurationNanos.accumulate(durationNanos);
      windowHistogram.record(durationNanos);
      totalHistogram.record(durationNanos);
    }

    private Snapshot snapshot(boolean resetWindow) {
      long calls =
          resetWindow ? windowCalls.sumThenReset() : windowCalls.sum();
      long failures =
          resetWindow ? windowFailures.sumThenReset() : windowFailures.sum();
      long durationNanos =
          resetWindow
              ? windowDurationNanos.sumThenReset()
              : windowDurationNanos.sum();
      long maximumDurationNanos =
          resetWindow
              ? windowMaximumDurationNanos.getThenReset()
              : windowMaximumDurationNanos.get();
      long[] windowDistribution =
          windowHistogram.snapshot(resetWindow);
      long[] totalDistribution = totalHistogram.snapshot(false);
      return new Snapshot(
          calls,
          Math.min(calls, failures),
          durationNanos,
          maximumDurationNanos,
          percentileNanos(windowDistribution, 95),
          percentileNanos(windowDistribution, 99),
          totalCalls.sum(),
          totalFailures.sum(),
          totalDurationNanos.sum(),
          totalMaximumDurationNanos.get(),
          percentileNanos(totalDistribution, 95),
          percentileNanos(totalDistribution, 99));
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

    private long[] snapshot(boolean reset) {
      long[] result = new long[buckets.length];
      for (int index = 0; index < buckets.length; index++) {
        result[index] =
            reset
                ? buckets[index].sumThenReset()
                : buckets[index].sum();
      }
      return result;
    }
  }

  static int histogramBucket(long durationNanos) {
    if (durationNanos <= 1L) {
      return 0;
    }
    int exponent =
        63 - Long.numberOfLeadingZeros(durationNanos);
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

  static long histogramUpperBoundNanos(int bucket) {
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
        (base * (subBucket + 1L)
                + HISTOGRAM_SUB_BUCKETS
                - 1L)
            / HISTOGRAM_SUB_BUCKETS;
    return base + increment;
  }

  private static long percentileNanos(
      long[] distribution, int percentile) {
    long count = 0L;
    for (long value : distribution) {
      count += value;
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
      cumulative += distribution[index];
      if (cumulative >= rank) {
        return histogramUpperBoundNanos(index);
      }
    }
    return histogramUpperBoundNanos(distribution.length - 1);
  }

  public static final class Snapshot {
    private static final Snapshot EMPTY =
        new Snapshot(
            0L, 0L, 0L, 0L, 0L, 0L,
            0L, 0L, 0L, 0L, 0L, 0L);

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

    private Snapshot(
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

    public long getCalls() {
      return calls;
    }

    public long getFailures() {
      return failures;
    }

    public long getDurationNanos() {
      return durationNanos;
    }

    public long getMaximumDurationNanos() {
      return maximumDurationNanos;
    }

    public long getP95DurationNanos() {
      return p95DurationNanos;
    }

    public long getP99DurationNanos() {
      return p99DurationNanos;
    }

    public long getTotalCalls() {
      return totalCalls;
    }

    public long getTotalFailures() {
      return totalFailures;
    }

    public long getTotalDurationNanos() {
      return totalDurationNanos;
    }

    public long getTotalMaximumDurationNanos() {
      return totalMaximumDurationNanos;
    }

    public long getTotalP95DurationNanos() {
      return totalP95DurationNanos;
    }

    public long getTotalP99DurationNanos() {
      return totalP99DurationNanos;
    }
  }
}
