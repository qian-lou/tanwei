package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;

import dev.tanwei.protocol.v1.ClassListRequest;
import dev.tanwei.protocol.v1.ClassListResponse;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

final class ClassQueryServiceTest {
  @Test
  void materializesModifiabilityOnlyForSelectedRows() {
    AtomicInteger modifiableChecks = new AtomicInteger();
    Class<?>[] snapshot =
        new Class<?>[] {Long.class, String.class, Integer.class, Object.class};
    Instrumentation instrumentation = instrumentation(snapshot, modifiableChecks);

    ClassListResponse response =
        new ClassQueryService(instrumentation)
            .list(
                ClassListRequest.newBuilder()
                    .setNameQuery("JAVA.LANG")
                    .setOffset(1)
                    .setLimit(2)
                    .build());

    assertEquals(4, response.getTotalMatches());
    assertEquals(2, response.getClassesCount());
    assertEquals("java.lang.Long", response.getClasses(0).getName());
    assertEquals("java.lang.Object", response.getClasses(1).getName());
    assertEquals(2, modifiableChecks.get());
  }

  private static Instrumentation instrumentation(
      Class<?>[] snapshot, AtomicInteger modifiableChecks) {
    return (Instrumentation)
        Proxy.newProxyInstance(
            ClassQueryServiceTest.class.getClassLoader(),
            new Class<?>[] {Instrumentation.class},
            (proxy, method, arguments) -> {
              if ("getAllLoadedClasses".equals(method.getName())) {
                return snapshot;
              }
              if ("isModifiableClass".equals(method.getName())) {
                modifiableChecks.incrementAndGet();
                return true;
              }
              Class<?> returnType = method.getReturnType();
              if (returnType == boolean.class) {
                return false;
              }
              if (returnType == long.class) {
                return 0L;
              }
              if (returnType == int.class) {
                return 0;
              }
              return null;
            });
  }
}
