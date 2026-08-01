package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.instrument.Instrumentation;
import java.lang.reflect.Proxy;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class StaticFieldExplorerTest {
  @Test
  void listsMetadataWithoutReadingValuesAndReadsOneConfirmedSelection()
      throws Exception {
    StaticFieldExplorer explorer =
        new StaticFieldExplorer(instrumentationFor(Sample.class));
    String classLoader = Sample.class.getClassLoader().toString();

    Map<String, String> listed =
        explorer.list(Sample.class.getName(), classLoader);
    assertEquals("2", listed.get("count"));
    assertTrue(listed.containsValue("TEXT"));
    assertTrue(listed.containsValue("OBJECT"));
    assertTrue(!listed.containsValue("visible-value"));

    Map<String, String> preview =
        explorer.preview(
            Sample.class.getName(),
            classLoader,
            Sample.class.getName(),
            "TEXT");
    Map<String, String> result =
        explorer.read(
            Sample.class.getName(),
            classLoader,
            Sample.class.getName(),
            "TEXT",
            preview.get("fingerprint"));
    assertEquals("visible-value", result.get("value"));
    assertEquals(String.class.getName(), result.get("valueClass"));
  }

  @Test
  void rejectsAStaleFingerprintAndDoesNotCallArbitraryObjectToString()
      throws Exception {
    StaticFieldExplorer explorer =
        new StaticFieldExplorer(instrumentationFor(Sample.class));
    String classLoader = Sample.class.getClassLoader().toString();

    assertThrows(
        StaticFieldExplorer.StaleSelectionException.class,
        () ->
            explorer.read(
                Sample.class.getName(),
                classLoader,
                Sample.class.getName(),
                "OBJECT",
                "0000000000000000000000000000000000000000000000000000000000000000"));
    Map<String, String> preview =
        explorer.preview(
            Sample.class.getName(),
            classLoader,
            Sample.class.getName(),
            "OBJECT");
    Map<String, String> result =
        explorer.read(
            Sample.class.getName(),
            classLoader,
            Sample.class.getName(),
            "OBJECT",
            preview.get("fingerprint"));
    assertTrue(result.get("value").startsWith("<java.lang.Object@"));
  }

  private static Instrumentation instrumentationFor(Class<?> type) {
    return (Instrumentation)
        Proxy.newProxyInstance(
            StaticFieldExplorerTest.class.getClassLoader(),
            new Class<?>[] {Instrumentation.class},
            (proxy, method, arguments) -> {
              if ("getAllLoadedClasses".equals(method.getName())) {
                return new Class<?>[] {type};
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

  private static final class Sample {
    private static final String TEXT = "visible-value";
    private static final Object OBJECT = new Object();
    private final int ignored = 1;
  }
}
