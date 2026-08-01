package dev.tanwei.bootstrap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

final class TraceBridgeTest {
  private static final String TASK_ID = "trace-test";

  @AfterEach
  void unregistersTask() {
    TraceBridge.unregister(TASK_ID);
  }

  @Test
  void capturesOneBoundedNestedTrace() {
    TraceBridge.register(TASK_ID, 2, 4, 8, 0L);

    long outside =
        TraceBridge.enter(TASK_ID, "example.Support#outside()V", false);
    assertEquals(0L, outside);
    long root =
        TraceBridge.enter(
            TASK_ID, "example.Root#run()V", true, "Root.java", 42);
    TraceBridge.callSite(TASK_ID, "Root.java", 47);
    long child =
        TraceBridge.enter(
            TASK_ID, "example.Support#work()V", false, "Support.java", 11);
    TraceBridge.exit(TASK_ID, child, null);
    TraceBridge.exit(TASK_ID, root, null);

    List<TraceBridge.Trace> traces = TraceBridge.drain(TASK_ID, 10);
    assertEquals(1, traces.size());
    TraceBridge.Trace trace = traces.get(0);
    assertEquals(2, trace.getSpans().size());
    assertEquals(0, trace.getSpans().get(0).getDepth());
    assertEquals(1, trace.getSpans().get(1).getDepth());
    assertEquals(0L, trace.getSpans().get(1).getParentSequence());
    assertEquals(Thread.currentThread().getId(), trace.getThreadId());
    assertEquals(Thread.currentThread().getName(), trace.getThreadName());
    assertEquals(Thread.currentThread().isDaemon(), trace.isThreadDaemon());
    assertEquals("Root.java", trace.getSpans().get(0).getSourceFile());
    assertEquals(42, trace.getSpans().get(0).getSourceLine());
    assertEquals("Root.java", trace.getSpans().get(1).getCallSiteFile());
    assertEquals(47, trace.getSpans().get(1).getCallSiteLine());
    assertEquals(1, TraceBridge.captured(TASK_ID));
  }

  @Test
  void recordsFailuresAndTruncatesAtConfiguredDepth() {
    TraceBridge.register(TASK_ID, 1, 2, 8, 0L);

    long root =
        TraceBridge.enter(TASK_ID, "example.Root#run()V", true);
    long child =
        TraceBridge.enter(TASK_ID, "example.Support#work()V", false);
    long truncated =
        TraceBridge.enter(TASK_ID, "example.Repository#load()V", false);
    assertEquals(0L, truncated);
    TraceBridge.exit(
        TASK_ID, child, new IllegalStateException("expected"));
    TraceBridge.exit(TASK_ID, root, null);

    TraceBridge.Trace trace = TraceBridge.drain(TASK_ID, 1).get(0);
    assertEquals(1, trace.getTruncatedSpans());
    assertEquals(
        IllegalStateException.class.getName(),
        trace.getSpans().get(1).getExceptionType());
    assertTrue(TraceBridge.dropped(TASK_ID) >= 1);
  }

  @Test
  void updatesMinimumDurationWithoutReregisteringTheTask() {
    TraceBridge.register(TASK_ID, 2, 4, 8, 0L);

    assertEquals(
        0L,
        TraceBridge.updateMinimumDuration(TASK_ID, 1_000_000_000L));
    long filteredRoot =
        TraceBridge.enter(TASK_ID, "example.Root#filtered()V", true);
    TraceBridge.exit(TASK_ID, filteredRoot, null);
    assertEquals(0, TraceBridge.captured(TASK_ID));

    assertEquals(
        1_000_000_000L,
        TraceBridge.updateMinimumDuration(TASK_ID, 0L));
    long capturedRoot =
        TraceBridge.enter(TASK_ID, "example.Root#captured()V", true);
    TraceBridge.exit(TASK_ID, capturedRoot, null);
    assertEquals(1, TraceBridge.captured(TASK_ID));
    assertEquals(
        "example.Root#captured()V",
        TraceBridge.drain(TASK_ID, 1).get(0).getSpans().get(0).getMethod());

    assertThrows(
        IllegalArgumentException.class,
        () -> TraceBridge.updateMinimumDuration(TASK_ID, -1L));
  }
}
