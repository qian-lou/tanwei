package dev.tanwei.bootstrap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class ObservationBridgeTest {
  @Test
  void carriesInstanceReceiverAsWeakReference() {
    String taskId = "receiver-test";
    String method = "example.Probe#echo(Ljava/lang/String;)Ljava/lang/String;";
    ReceiverProbe receiver = new ReceiverProbe();
    ObservationBridge.register(taskId, 1, method, "");
    try {
      long token =
          ObservationBridge.enter(
              taskId, method, receiver, new Object[] {"captured"});
      receiver.value = 9;
      ObservationBridge.exit(taskId, token, "CAPTURED", null);

      List<ObservationBridge.Event> events = ObservationBridge.drain(taskId, 1);

      assertEquals(1, events.size());
      assertEquals(ReceiverProbe.class.getName(), events.get(0).getReceiverType());
      WeakReference<Object> reference = events.get(0).getReceiverReference();
      assertSame(receiver, reference.get());
      ObservationBridge.ReceiverState state =
          events.get(0).getReceiverState();
      assertEquals(true, state.isAvailable());
      assertEquals(3, state.getScannedFields());
      assertEquals(2, state.getNames().size());
      assertEquals(
          "9",
          state
              .getValues()
              .get(
                  state
                      .getNames()
                      .indexOf(ReceiverProbe.class.getName() + "#value")));
      assertEquals(
          "<masked>",
          state
              .getValues()
              .get(
                  state
                      .getNames()
                      .indexOf(ReceiverProbe.class.getName() + "#apiToken")));
      reference.clear();
      assertNull(reference.get());
    } finally {
      ObservationBridge.unregister(taskId);
    }
  }

  @Test
  void capturesBoundedStructuredArgumentsWithoutCallingBusinessToString() {
    String taskId = "structured-values-test";
    String method = "example.Probe#inspect(Lexample/Payload;)Lexample/Result;";
    StructuredPayload payload = new StructuredPayload();
    StructuredResult result = new StructuredResult(payload);
    ObservationBridge.register(taskId, 1, method, "");
    try {
      long token =
          ObservationBridge.enter(taskId, method, null, new Object[] {payload});
      ObservationBridge.exit(taskId, token, result, null);

      ObservationBridge.InvocationValues values =
          ObservationBridge.drain(taskId, 1).get(0).getInvocationValues();

      assertTrue(values.isAvailable());
      assertFalse(values.isTruncated());
      assertEquals("eu-west", node(values, "arg[0].detail.region").getValue());
      assertEquals("<masked>", node(values, "arg[0].apiToken").getValue());
      assertEquals("ARRAY", node(values, "arg[0].samples").getKind());
      assertEquals("COLLECTION", node(values, "arg[0].items").getKind());
      assertEquals("alpha", node(values, "arg[0].items[0]").getValue());
      assertEquals("MAP", node(values, "arg[0].attributes").getKind());
      assertEquals("ENTRY", node(values, "arg[0].attributes[0]").getKind());
      assertEquals(
          "<masked>",
          node(values, "arg[0].attributes[1].value").getValue());
      assertEquals("REFERENCE", node(values, "arg[0].self").getKind());
      assertEquals("arg[0]", node(values, "arg[0].self").getValue());
      assertEquals("REFERENCE", node(values, "result.payload").getKind());
      assertEquals("arg[0]", node(values, "result.payload").getValue());
      assertFalse(payload.poison.toStringCalled);
      assertFalse(payload.unsafeItems.iteratorCalled);
      assertFalse(payload.unsafeItems.sizeCalled);
    } finally {
      ObservationBridge.unregister(taskId);
    }
  }

  @Test
  void truncatesTrustedJdkCollectionsAtTheSharedChildBudget() {
    String taskId = "bounded-collection-test";
    String method = "example.Probe#inspect(Ljava/util/List;)V";
    List<Integer> items = new ArrayList<Integer>();
    for (int index = 0; index < 20; index++) {
      items.add(Integer.valueOf(index));
    }
    ObservationBridge.register(taskId, 1, method, "");
    try {
      long token =
          ObservationBridge.enter(taskId, method, null, new Object[] {items});
      ObservationBridge.exit(taskId, token, null, null);

      ObservationBridge.InvocationValues values =
          ObservationBridge.drain(taskId, 1).get(0).getInvocationValues();

      ObservationBridge.InvocationValueNode collection = node(values, "arg[0]");
      assertTrue(values.isTruncated());
      assertEquals("COLLECTION", collection.getKind());
      assertEquals(20, collection.getChildCount());
      assertTrue(collection.isTruncated());
      assertEquals(16, directChildren(values, "arg[0]"));
    } finally {
      ObservationBridge.unregister(taskId);
    }
  }

  @Test
  void matchesEveryCompiledConditionClauseBeforeReservingAnEvent() {
    String taskId = "combined-condition-test";
    String method = "example.Probe#accept(Ljava/lang/String;)Ljava/lang/String;";
    ObservationBridge.register(
        taskId,
        1,
        method,
        "durationMs >= 0"
            + " && arg0 contains \"order-\""
            + " && outcome == \"RETURNED\""
            + " && return == \"accepted\"");
    try {
      long rejected =
          ObservationBridge.enter(taskId, method, null, new Object[] {"skip"});
      ObservationBridge.exit(taskId, rejected, "accepted", null);
      assertTrue(ObservationBridge.drain(taskId, 1).isEmpty());

      long accepted =
          ObservationBridge.enter(
              taskId, method, null, new Object[] {"order-42"});
      ObservationBridge.exit(taskId, accepted, "accepted", null);

      List<ObservationBridge.Event> events = ObservationBridge.drain(taskId, 1);
      assertEquals(1, events.size());
      assertEquals("order-42", events.get(0).getArguments().get(0));
    } finally {
      ObservationBridge.unregister(taskId);
    }
  }

  @Test
  void matchesThrownOutcomeAndExceptionTypeWithoutEvaluatingCode() {
    String taskId = "exception-condition-test";
    String method = "example.Probe#fail()V";
    ObservationBridge.register(
        taskId,
        1,
        method,
        "outcome == \"THREW\""
            + " && exception contains \"IllegalStateException\"");
    try {
      long token = ObservationBridge.enter(taskId, method, null, new Object[0]);
      ObservationBridge.exit(
          taskId, token, null, new IllegalStateException("expected"));

      assertEquals(1, ObservationBridge.drain(taskId, 1).size());
    } finally {
      ObservationBridge.unregister(taskId);
    }
  }

  @Test
  void capturesIndependentBeforeReturnThrowAndFinishWatchPhases() {
    String successTask = "watch-phases-success";
    String failureTask = "watch-phases-failure";
    String method = "example.Probe#run(Ljava/lang/String;)Ljava/lang/String;";
    ObservationBridge.register(
        successTask, 4, method, "arg0 == \"before\"", "BEFORE,RETURN,FINISH");
    ObservationBridge.register(
        failureTask, 3, method, "exception", "BEFORE,THROW,FINISH");
    try {
      long returned =
          ObservationBridge.enter(
              successTask, method, null, new Object[] {"before"});
      ObservationBridge.exit(successTask, returned, "after", null);

      List<ObservationBridge.Event> success =
          ObservationBridge.drain(successTask, 4);
      assertEquals(3, success.size());
      assertEquals("BEFORE", success.get(0).getPhase());
      assertEquals("RETURN", success.get(1).getPhase());
      assertEquals("FINISH", success.get(2).getPhase());
      assertEquals(success.get(0).getSequence(), success.get(1).getSequence());
      assertTrue(success.get(0).getEventId() < success.get(1).getEventId());
      assertEquals("before", success.get(0).getArguments().get(0));
      assertEquals("after", success.get(1).getReturnValue());

      long threw =
          ObservationBridge.enter(
              failureTask, method, null, new Object[] {"failure"});
      ObservationBridge.exit(
          failureTask, threw, null, new IllegalStateException("expected"));

      List<ObservationBridge.Event> failure =
          ObservationBridge.drain(failureTask, 3);
      assertEquals(2, failure.size());
      assertEquals("THROW", failure.get(0).getPhase());
      assertEquals("FINISH", failure.get(1).getPhase());
      assertEquals(2, ObservationBridge.captured(failureTask));
    } finally {
      ObservationBridge.unregister(successTask);
      ObservationBridge.unregister(failureTask);
    }
  }

  @Test
  void rejectsUnsafeOrUnboundedConditionGrammarAtRegistration() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            ObservationBridge.register(
                "invalid-or", 1, "example.Probe#run()V", "exception || true"));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            ObservationBridge.register(
                "invalid-argument",
                1,
                "example.Probe#run()V",
                "arg16 == \"value\""));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            ObservationBridge.register(
                "too-many-clauses",
                1,
                "example.Probe#run()V",
                "durationMs >= 0"
                    + " && durationMs < 1"
                    + " && thread contains \"main\""
                    + " && outcome == \"RETURNED\""
                    + " && exception"));
  }

  private static ObservationBridge.InvocationValueNode node(
      ObservationBridge.InvocationValues values, String path) {
    for (ObservationBridge.InvocationValueNode node : values.getNodes()) {
      if (path.equals(node.getPath())) {
        return node;
      }
    }
    throw new AssertionError("Missing invocation value node " + path);
  }

  private static int directChildren(
      ObservationBridge.InvocationValues values, String path) {
    int count = 0;
    for (ObservationBridge.InvocationValueNode node : values.getNodes()) {
      if (node.getPath().startsWith(path + "[") && node.getDepth() == 1) {
        count++;
      }
    }
    return count;
  }

  private static final class ReceiverProbe {
    private int value = 7;
    private String apiToken = "never-return-this-secret";
    private Object nested = new Object();
  }

  private static final class StructuredPayload {
    private final String apiToken = "never-return-this-secret";
    private final Map<String, Object> attributes =
        new LinkedHashMap<String, Object>();
    private final StructuredDetail detail = new StructuredDetail();
    private final List<Object> items = new ArrayList<Object>();
    private final PoisonValue poison = new PoisonValue();
    private final int[] samples = new int[] {3, 5, 8};
    private final StructuredPayload self = this;
    private final PoisonList unsafeItems = new PoisonList();

    private StructuredPayload() {
      attributes.put("region", "eu-west");
      attributes.put("apiToken", "never-return-this-secret");
      items.add("alpha");
      items.add(poison);
      unsafeItems.add("must-not-iterate");
    }
  }

  private static final class StructuredDetail {
    private final boolean healthy = true;
    private final String region = "eu-west";
  }

  private static final class StructuredResult {
    private final StructuredPayload payload;
    private final String status = "accepted";

    private StructuredResult(StructuredPayload payload) {
      this.payload = payload;
    }
  }

  private static final class PoisonValue {
    private boolean toStringCalled;

    @Override
    public String toString() {
      toStringCalled = true;
      throw new AssertionError("Business toString must not be called");
    }
  }

  private static final class PoisonList extends ArrayList<String> {
    private boolean iteratorCalled;
    private boolean sizeCalled;

    @Override
    public Iterator<String> iterator() {
      iteratorCalled = true;
      throw new AssertionError("Business iterator must not be called");
    }

    @Override
    public int size() {
      sizeCalled = true;
      throw new AssertionError("Business size must not be called");
    }
  }
}
