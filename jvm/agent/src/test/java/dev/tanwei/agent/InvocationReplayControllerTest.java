package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.lang.instrument.Instrumentation;
import java.lang.reflect.Proxy;
import java.util.Collections;
import org.junit.jupiter.api.Test;

final class InvocationReplayControllerTest {
  @Test
  void replaysOnExactOriginalInstance() throws Exception {
    ReplayProbe receiver = new ReplayProbe(3);
    try (InvocationReplayController controller =
        new InvocationReplayController(instrumentation(), stateCapture())) {
      InvocationReplayController.Preview preview =
          controller.preview(
              ReplayProbe.class.getName(),
              ReplayProbe.class.getClassLoader().toString(),
              "increment",
              "int",
              Collections.singletonList("2"),
              1001L,
              receiver);

      InvocationReplayController.Result result =
          controller.invoke(
              ReplayProbe.class.getName(),
              ReplayProbe.class.getClassLoader().toString(),
              "increment",
              "int",
              Collections.singletonList("2"),
              preview.getFingerprint(),
              1001L,
              receiver);

      assertEquals("INSTANCE", preview.getReplayMode());
      assertEquals(ReplayProbe.class.getName(), preview.getReceiverType());
      assertEquals(
          "3", preview.getReceiverState().getFields().get(0).getValue());
      assertEquals("RETURNED", result.getOutcome());
      assertEquals("5", result.getReturnValue());
      assertEquals(
          "3",
          result.getBeforeReceiverState().getFields().get(0).getValue());
      assertEquals(
          "5",
          result.getAfterReceiverState().getFields().get(0).getValue());
      assertEquals(
          "CHANGED",
          result
              .getBeforeReceiverState()
              .changesTo(result.getAfterReceiverState())
              .get(0)
              .getKind());
      assertEquals(5, receiver.value);
    }
  }

  @Test
  void keepsDirectStaticReplayBackwardCompatible() throws Exception {
    try (InvocationReplayController controller =
        new InvocationReplayController(instrumentation())) {
      InvocationReplayController.Preview preview =
          controller.preview(
              ReplayProbe.class.getName(),
              ReplayProbe.class.getClassLoader().toString(),
              "upper",
              "java.lang.String",
              Collections.singletonList("desktop"));
      InvocationReplayController.Result result =
          controller.invoke(
              ReplayProbe.class.getName(),
              ReplayProbe.class.getClassLoader().toString(),
              "upper",
              "java.lang.String",
              Collections.singletonList("desktop"),
              preview.getFingerprint());

      assertEquals("STATIC", preview.getReplayMode());
      assertEquals("DESKTOP", result.getReturnValue());
    }
  }

  @Test
  void rejectsInstanceReplayAfterReceiverExpires() {
    try (InvocationReplayController controller =
        new InvocationReplayController(instrumentation())) {
      assertThrows(
          InvocationReplayController.ReceiverExpiredException.class,
          () ->
              controller.preview(
                  ReplayProbe.class.getName(),
                  ReplayProbe.class.getClassLoader().toString(),
                  "increment",
                  "int",
                  Collections.singletonList("1"),
                  1002L,
                  null));
    }
  }

  private static Instrumentation instrumentation() {
    return (Instrumentation)
        Proxy.newProxyInstance(
            InvocationReplayControllerTest.class.getClassLoader(),
            new Class<?>[] {Instrumentation.class},
            (proxy, method, arguments) -> {
              if ("getAllLoadedClasses".equals(method.getName())) {
                return new Class<?>[] {ReplayProbe.class};
              }
              Class<?> returnType = method.getReturnType();
              if (returnType == boolean.class) {
                return Boolean.FALSE;
              }
              if (returnType == long.class) {
                return Long.valueOf(0L);
              }
              if (returnType == int.class) {
                return Integer.valueOf(0);
              }
              return null;
            });
  }

  private static InvocationReplayController.ReceiverStateCapture stateCapture() {
    return receiver -> {
      ReplayProbe probe = (ReplayProbe) receiver;
      return ReceiverStateSnapshot.of(
          true,
          1,
          0,
          false,
          Collections.singletonList(ReplayProbe.class.getName() + "#value"),
          Collections.singletonList(Integer.toString(probe.value)));
    };
  }

  public static final class ReplayProbe {
    private int value;

    ReplayProbe(int value) {
      this.value = value;
    }

    public int increment(int amount) {
      value += amount;
      return value;
    }

    public static String upper(String value) {
      return value.toUpperCase(java.util.Locale.ROOT);
    }
  }
}
