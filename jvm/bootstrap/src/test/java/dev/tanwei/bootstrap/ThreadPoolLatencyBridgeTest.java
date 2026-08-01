package dev.tanwei.bootstrap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Delayed;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

final class ThreadPoolLatencyBridgeTest {
  private String taskId;

  @AfterEach
  void unregister() {
    ThreadPoolLatencyBridge.unregister(taskId);
  }

  @Test
  void recordsMatchedWaitAndWorkerExecutionWithoutRetainingTaskValues()
      throws Exception {
    taskId = "latency-test";
    Object pool = new Object();
    Runnable task = new SampleTask();
    ThreadPoolLatencyBridge.register(
        taskId, pool, "QUEUE_AND_RUN", 128, 8);

    ThreadPoolLatencyBridge.submit(pool, task);
    Thread.sleep(2L);
    ThreadPoolLatencyBridge.start(pool, task);
    Thread.sleep(2L);
    ThreadPoolLatencyBridge.completeSuccess();

    ThreadPoolLatencyBridge.Snapshot snapshot =
        ThreadPoolLatencyBridge.snapshot(taskId);
    assertEquals(1L, snapshot.getSubmitted());
    assertEquals(1L, snapshot.getStarted());
    assertEquals(1L, snapshot.getCompleted());
    assertEquals(1L, snapshot.getWaitObserved());
    assertEquals(0, snapshot.getPendingTracked());
    assertEquals(0, snapshot.getInFlight());
    assertTrue(snapshot.getWaitDurationNanos() > 0L);
    assertTrue(snapshot.getRunDurationNanos() > 0L);
    assertEquals(1, snapshot.getTaskTypes().length);
    assertEquals(
        SampleTask.class.getName(),
        snapshot.getTaskTypes()[0].getClassName());
  }

  @Test
  void reportsUnmatchedRejectedAndBoundedSubmissionRecords() {
    taskId = "latency-boundary-test";
    Object pool = new Object();
    ThreadPoolLatencyBridge.register(
        taskId, pool, "QUEUE_AND_RUN", 128, 2);

    Runnable rejected = new SampleTask();
    ThreadPoolLatencyBridge.submit(pool, rejected);
    ThreadPoolLatencyBridge.reject(pool, rejected);
    List<Runnable> retained = new ArrayList<Runnable>(130);
    for (int index = 0; index < 130; index++) {
      Runnable queued = new SampleTask();
      retained.add(queued);
      ThreadPoolLatencyBridge.submit(pool, queued);
    }
    ThreadPoolLatencyBridge.start(pool, new SampleTask());
    ThreadPoolLatencyBridge.completeFailure(new IllegalStateException("boom"));

    ThreadPoolLatencyBridge.Snapshot snapshot =
        ThreadPoolLatencyBridge.snapshot(taskId);
    assertEquals(1L, snapshot.getRejected());
    assertEquals(1L, snapshot.getUnmatchedStarts());
    assertEquals(1L, snapshot.getFailures());
    assertEquals(128, snapshot.getPendingTracked());
    assertTrue(snapshot.getDroppedSubmissions() >= 2L);
    assertEquals(130, retained.size());
  }

  @Test
  void recordsRunOnlyExecutionWithoutInventingSubmissionOrWait() {
    taskId = "run-only-test";
    Object pool = new Object();
    Runnable task = new SampleTask();
    ThreadPoolLatencyBridge.register(
        taskId, pool, "RUN_ONLY", 128, 8);

    ThreadPoolLatencyBridge.start(pool, task);
    ThreadPoolLatencyBridge.completeSuccess();

    ThreadPoolLatencyBridge.Snapshot snapshot =
        ThreadPoolLatencyBridge.snapshot(taskId);
    assertEquals(0L, snapshot.getSubmitted());
    assertEquals(1L, snapshot.getStarted());
    assertEquals(1L, snapshot.getCompleted());
    assertEquals(0L, snapshot.getUnmatchedStarts());
    assertEquals(0L, snapshot.getWaitObserved());
    assertEquals(0L, snapshot.getWaitDurationNanos());
    assertEquals(0, snapshot.getPendingTracked());
    assertEquals(1, snapshot.getTaskTypes().length);
  }

  @Test
  void splitsScheduledDelayFromStartLatenessAndWorkerExecution()
      throws Exception {
    taskId = "scheduled-attribution-test";
    Object pool = new Object();
    SampleScheduledTask task = new SampleScheduledTask(5L);
    ThreadPoolLatencyBridge.register(
        taskId, pool, "SCHEDULE_AND_RUN", 128, 8);

    ThreadPoolLatencyBridge.schedule(pool, task);
    Thread.sleep(20L);
    ThreadPoolLatencyBridge.start(pool, task);
    Thread.sleep(2L);
    ThreadPoolLatencyBridge.completeSuccess();

    ThreadPoolLatencyBridge.Snapshot snapshot =
        ThreadPoolLatencyBridge.snapshot(taskId);
    assertEquals(1L, snapshot.getSubmitted());
    assertEquals(1L, snapshot.getScheduleDelayObserved());
    assertTrue(snapshot.getScheduleDelayDurationNanos() > 0L);
    assertEquals(1L, snapshot.getStartLatenessObserved());
    assertTrue(snapshot.getStartLatenessDurationNanos() > 0L);
    assertEquals(0L, snapshot.getWaitObserved());
    assertEquals(0L, snapshot.getWaitDurationNanos());
    assertTrue(snapshot.getRunDurationNanos() > 0L);
    assertEquals(0, snapshot.getPendingTracked());
    assertEquals(
        1L, snapshot.getTaskTypes()[0].getScheduleDelayObserved());
    assertEquals(
        1L, snapshot.getTaskTypes()[0].getStartLatenessObserved());
  }

  private static final class SampleTask implements Runnable {
    @Override
    public void run() {
      // The bridge never invokes tasks; the test drives lifecycle hooks directly.
    }
  }

  private static final class SampleScheduledTask
      implements Runnable, Delayed {
    private final long deadlineNanos;

    private SampleScheduledTask(long delayMillis) {
      deadlineNanos =
          System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(delayMillis);
    }

    @Override
    public long getDelay(TimeUnit unit) {
      return unit.convert(
          deadlineNanos - System.nanoTime(), TimeUnit.NANOSECONDS);
    }

    @Override
    public int compareTo(Delayed other) {
      return Long.compare(
          getDelay(TimeUnit.NANOSECONDS),
          other.getDelay(TimeUnit.NANOSECONDS));
    }

    @Override
    public void run() {
      // The bridge only reads the standard Delayed contract.
    }
  }
}
