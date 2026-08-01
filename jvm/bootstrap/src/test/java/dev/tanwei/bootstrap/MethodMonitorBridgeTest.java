package dev.tanwei.bootstrap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

final class MethodMonitorBridgeTest {
  private static final String TASK_ID = "monitor-test";

  @AfterEach
  void unregistersTask() {
    MethodMonitorBridge.unregister(TASK_ID);
  }

  @Test
  void recordsWindowAndCumulativeMetrics() {
    MethodMonitorBridge.register(TASK_ID);

    long successful = MethodMonitorBridge.enter(TASK_ID);
    MethodMonitorBridge.exit(TASK_ID, successful, null);
    long failed = MethodMonitorBridge.enter(TASK_ID);
    MethodMonitorBridge.exit(
        TASK_ID, failed, new IllegalStateException("expected"));

    MethodMonitorBridge.Snapshot first =
        MethodMonitorBridge.snapshot(TASK_ID, true);
    assertEquals(2L, first.getCalls());
    assertEquals(1L, first.getFailures());
    assertTrue(first.getDurationNanos() >= 0L);
    assertTrue(first.getMaximumDurationNanos() >= 0L);
    assertTrue(first.getP95DurationNanos() > 0L);
    assertTrue(
        first.getP99DurationNanos()
            >= first.getP95DurationNanos());
    assertEquals(2L, first.getTotalCalls());
    assertEquals(1L, first.getTotalFailures());
    assertTrue(first.getTotalP95DurationNanos() > 0L);
    assertTrue(
        first.getTotalP99DurationNanos()
            >= first.getTotalP95DurationNanos());

    MethodMonitorBridge.Snapshot second =
        MethodMonitorBridge.snapshot(TASK_ID, true);
    assertEquals(0L, second.getCalls());
    assertEquals(0L, second.getFailures());
    assertEquals(0L, second.getP95DurationNanos());
    assertEquals(0L, second.getP99DurationNanos());
    assertEquals(2L, second.getTotalCalls());
    assertEquals(1L, second.getTotalFailures());
    assertEquals(
        first.getTotalP95DurationNanos(),
        second.getTotalP95DurationNanos());
  }

  @Test
  void becomesNoopAfterUnregister() {
    MethodMonitorBridge.register(TASK_ID);
    MethodMonitorBridge.unregister(TASK_ID);

    assertEquals(0L, MethodMonitorBridge.enter(TASK_ID));
    assertEquals(
        0L,
        MethodMonitorBridge.snapshot(TASK_ID, false).getTotalCalls());
  }

  @Test
  void updatesMinimumDurationWithoutReregisteringTheTask() {
    MethodMonitorBridge.register(TASK_ID, 1_000_000_000L);

    long filtered = MethodMonitorBridge.enter(TASK_ID);
    MethodMonitorBridge.exit(TASK_ID, filtered, null);
    assertEquals(
        0L,
        MethodMonitorBridge.snapshot(TASK_ID, true).getTotalCalls());

    assertEquals(
        1_000_000_000L,
        MethodMonitorBridge.updateMinimumDuration(TASK_ID, 0L));
    long captured = MethodMonitorBridge.enter(TASK_ID);
    MethodMonitorBridge.exit(TASK_ID, captured, null);
    assertEquals(
        1L,
        MethodMonitorBridge.snapshot(TASK_ID, true).getTotalCalls());
  }

  @Test
  void histogramBucketsAreMonotonicAndNeverUnderReport() {
    long[] durations = {
      1L,
      2L,
      3L,
      4L,
      10L,
      1_000L,
      1_000_000L,
      1_000_000_000L,
      Long.MAX_VALUE
    };
    int previousBucket = -1;
    for (long duration : durations) {
      int bucket = MethodMonitorBridge.histogramBucket(duration);
      assertTrue(bucket >= previousBucket);
      assertTrue(
          MethodMonitorBridge.histogramUpperBoundNanos(bucket)
              >= duration);
      previousBucket = bucket;
    }
  }
}
