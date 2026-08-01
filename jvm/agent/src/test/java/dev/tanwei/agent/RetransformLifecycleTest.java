package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Proxy;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class RetransformLifecycleTest {
  @Test
  void serializesOwnershipAndRollsBackExactlyOnce() throws Exception {
    FakeInstrumentation fake = new FakeInstrumentation();
    RetransformLifecycle lifecycle = new RetransformLifecycle(fake.proxy());
    ClassFileTransformer transformer = transformer();

    RetransformLifecycle.Lease lease =
        lifecycle.activate("TRACE:00000000-0000-0000-0000-000000000001", "TRACE", transformer, Fixture.class);

    assertTrue(lifecycle.hasClaim(Fixture.class));
    assertEquals(1, fake.added);
    assertEquals(1, fake.retransforms);
    assertThrows(
        IllegalStateException.class,
        () -> lifecycle.activate("WATCH:other", "WATCH", transformer(), Fixture.class));

    lease.rollback();

    assertFalse(lifecycle.hasClaim(Fixture.class));
    assertEquals(1, fake.removed);
    assertEquals(2, fake.retransforms);
    assertTrue(lifecycle.snapshots().isEmpty());
  }

  @Test
  void failedRollbackKeepsClaimUntilExplicitRetry() throws Exception {
    FakeInstrumentation fake = new FakeInstrumentation();
    RetransformLifecycle lifecycle = new RetransformLifecycle(fake.proxy());
    String owner = "WATCH:00000000-0000-0000-0000-000000000002";
    RetransformLifecycle.Lease lease =
        lifecycle.activate(owner, "WATCH", transformer(), Fixture.class);
    fake.failRetransform = true;

    assertThrows(IllegalStateException.class, lease::rollback);
    assertTrue(lifecycle.hasClaim(Fixture.class));
    assertEquals("ROLLBACK_FAILED", lifecycle.snapshots().get(0).getState());
    assertEquals(1, lifecycle.failedRollbacks().size());

    fake.failRetransform = false;
    assertTrue(lifecycle.retry(owner));
    assertFalse(lifecycle.hasClaim(Fixture.class));
    assertTrue(lifecycle.snapshots().isEmpty());
    assertTrue(lifecycle.failedRollbacks().isEmpty());
  }

  private static ClassFileTransformer transformer() {
    return new ClassFileTransformer() {
      @Override
      public byte[] transform(
          ClassLoader loader,
          String className,
          Class<?> classBeingRedefined,
          ProtectionDomain protectionDomain,
          byte[] classfileBuffer) {
        return null;
      }
    };
  }

  private static final class Fixture {}

  private static final class FakeInstrumentation {
    private final List<ClassFileTransformer> transformers = new ArrayList<ClassFileTransformer>();
    private int added;
    private int removed;
    private int retransforms;
    private boolean failRetransform;

    private Instrumentation proxy() {
      return (Instrumentation)
          Proxy.newProxyInstance(
              Instrumentation.class.getClassLoader(),
              new Class<?>[] {Instrumentation.class},
              (proxy, method, arguments) -> {
                String name = method.getName();
                if ("isModifiableClass".equals(name)
                    || "isRetransformClassesSupported".equals(name)) {
                  return Boolean.TRUE;
                }
                if ("addTransformer".equals(name)) {
                  transformers.add((ClassFileTransformer) arguments[0]);
                  added++;
                  return null;
                }
                if ("removeTransformer".equals(name)) {
                  removed++;
                  return Boolean.valueOf(transformers.remove(arguments[0]));
                }
                if ("retransformClasses".equals(name)) {
                  retransforms++;
                  if (failRetransform) {
                    throw new IllegalStateException("synthetic rollback failure");
                  }
                  return null;
                }
                if (method.getReturnType() == boolean.class) {
                  return Boolean.FALSE;
                }
                if (method.getReturnType() == long.class) {
                  return Long.valueOf(0L);
                }
                if (method.getReturnType() == int.class) {
                  return Integer.valueOf(0);
                }
                return null;
              });
    }
  }
}
