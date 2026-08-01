package dev.tanwei.bootstrap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

final class LineProbeBridgeTest {
  @Test
  void capturesBoundedSafeLocalSnapshotsWithoutCallingApplicationToString() {
    String taskId = UUID.randomUUID().toString();
    LineProbeBridge.register(taskId, 2);
    try {
      LineProbeBridge.capture(
          taskId,
          "example.OrderService",
          "submit(Ljava/lang/String;)V",
          42,
          new String[] {"password", "payload", "samples"},
          new Object[] {"never-return-this", new PoisonValue(), new int[] {3, 5}});

      List<LineProbeBridge.Event> events = LineProbeBridge.drain(taskId, 10);
      assertEquals(1, events.size());
      LineProbeBridge.Event event = events.get(0);
      assertEquals(42, event.getLineNumber());
      assertEquals("[REDACTED]", event.getLocals().get(0).getValue());
      assertTrue(
          event.getLocals().get(1).getValue().startsWith(
              PoisonValue.class.getName() + "@"));
      assertEquals("int[][length=2]", event.getLocals().get(2).getValue());
      assertTrue(event.getCallStack().size() <= 12);
      assertEquals(1, LineProbeBridge.captured(taskId));
      assertEquals(0, LineProbeBridge.dropped(taskId));
    } finally {
      LineProbeBridge.unregister(taskId);
    }
  }

  @Test
  void rejectsDuplicateTasksAndSuppressesHotCallsAfterTheConfiguredBudget() {
    String taskId = UUID.randomUUID().toString();
    LineProbeBridge.register(taskId, 1);
    try {
      assertThrows(
          IllegalStateException.class,
          () -> LineProbeBridge.register(taskId, 1));
      LineProbeBridge.capture(
          taskId, "example.Probe", "run()V", 7, new String[0], new Object[0]);
      LineProbeBridge.capture(
          taskId, "example.Probe", "run()V", 7, new String[0], new Object[0]);
      assertEquals(1, LineProbeBridge.captured(taskId));
      assertEquals(0, LineProbeBridge.dropped(taskId));
      assertEquals(1, LineProbeBridge.drain(taskId, 10).size());
    } finally {
      LineProbeBridge.unregister(taskId);
    }
    assertEquals(0, LineProbeBridge.captured(taskId));
  }

  private static final class PoisonValue {
    @Override
    public String toString() {
      throw new AssertionError("line probes must not call application toString");
    }
  }
}
