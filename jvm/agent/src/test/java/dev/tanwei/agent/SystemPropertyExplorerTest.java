package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class SystemPropertyExplorerTest {
  @Test
  void classifiesSearchesAndMasksSensitiveValues() {
    Map<Object, Object> properties = new LinkedHashMap<Object, Object>();
    properties.put("java.version", "25");
    properties.put("java.vm.name", "OpenJDK VM");
    properties.put("java.class.path", "/app/classes");
    properties.put("os.name", "Mac OS X");
    properties.put("user.language", "zh");
    properties.put("service.mode", "diagnostic");
    properties.put("service.password", "do-not-return-this-value");

    SystemPropertyExplorer.Result result =
        new SystemPropertyExplorer()
            .list(properties, "", SystemPropertyExplorer.Category.ALL, 0, 20);

    assertEquals(7, result.getPropertyCount());
    assertEquals(7, result.getScannedCount());
    assertEquals(6, result.getVisibleCount());
    assertEquals(1, result.getMaskedCount());
    assertEquals(SystemPropertyExplorer.Category.JAVA, entry(result, "java.version").getCategory());
    assertEquals(SystemPropertyExplorer.Category.VM, entry(result, "java.vm.name").getCategory());
    assertEquals(SystemPropertyExplorer.Category.PATH, entry(result, "java.class.path").getCategory());
    assertEquals("<masked>", entry(result, "service.password").getValue());
    assertFalse(entry(result, "service.password").isMutable());
    assertTrue(entry(result, "service.mode").isMutable());
  }

  @Test
  void appliesCategoryQueryPaginationAndValueTruncation() {
    Map<Object, Object> properties = new LinkedHashMap<Object, Object>();
    properties.put("java.home", "/opt/jdk");
    properties.put("user.home", "/Users/demo");
    properties.put("application.home", repeat("a", 4_200));

    SystemPropertyExplorer explorer = new SystemPropertyExplorer();
    SystemPropertyExplorer.Result page =
        explorer.list(properties, "home", SystemPropertyExplorer.Category.PATH, 1, 1);

    assertEquals(3, page.getTotal());
    assertEquals(1, page.getOffset());
    assertEquals("java.home", page.getEntries().get(0).getKey());
    SystemPropertyExplorer.Entry application =
        entry(
            explorer.list(
                properties,
                "application",
                SystemPropertyExplorer.Category.ALL,
                0,
                10),
            "application.home");
    assertTrue(application.isTruncated());
    assertEquals(4_200, application.getValueLength());
    assertEquals(4_097, application.getValue().length());
  }

  @Test
  void rejectsInvalidQueriesAndBoundsWithoutCallingUnknownValues() {
    Map<Object, Object> properties = new LinkedHashMap<Object, Object>();
    properties.put("safe.name", "safe");
    properties.put("invalid\nname", "ignored");
    properties.put("unknown.value", new ExplosiveValue());

    SystemPropertyExplorer explorer = new SystemPropertyExplorer();
    SystemPropertyExplorer.Result result =
        explorer.list(properties, "", SystemPropertyExplorer.Category.ALL, 0, 10);
    assertEquals(2, result.getInvalidCount());
    assertEquals(1, result.getEntries().size());
    assertThrows(
        IllegalArgumentException.class,
        () ->
            explorer.list(
                properties,
                "bad\nquery",
                SystemPropertyExplorer.Category.ALL,
                0,
                10));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            explorer.list(
                properties,
                "",
                SystemPropertyExplorer.Category.ALL,
                0,
                201));
  }

  @Test
  void stopsAtTheHardScanBoundaryAndReportsPartialSourceCoverage() {
    Map<Object, Object> properties = new LinkedHashMap<Object, Object>();
    for (int index = 0;
        index <= SystemPropertyExplorer.MAXIMUM_SCANNED_PROPERTIES;
        index++) {
      properties.put(
          String.format(Locale.ROOT, "application.%05d", index), "value");
    }

    SystemPropertyExplorer.Result result =
        new SystemPropertyExplorer()
            .list(
                properties,
                "",
                SystemPropertyExplorer.Category.APPLICATION,
                0,
                10);

    assertEquals(
        SystemPropertyExplorer.MAXIMUM_SCANNED_PROPERTIES + 1,
        result.getPropertyCount());
    assertEquals(
        SystemPropertyExplorer.MAXIMUM_SCANNED_PROPERTIES,
        result.getScannedCount());
    assertTrue(result.isSourceTruncated());
    assertEquals(
        SystemPropertyExplorer.MAXIMUM_SCANNED_PROPERTIES,
        result.getTotal());
  }

  private static SystemPropertyExplorer.Entry entry(
      SystemPropertyExplorer.Result result, String key) {
    return result.getEntries().stream()
        .filter(item -> item.getKey().equals(key))
        .findFirst()
        .orElseThrow(() -> new AssertionError("Missing system property " + key));
  }

  private static String repeat(String value, int count) {
    StringBuilder result = new StringBuilder(value.length() * count);
    for (int index = 0; index < count; index++) {
      result.append(value);
    }
    return result.toString();
  }

  private static final class ExplosiveValue {
    @Override
    public String toString() {
      throw new AssertionError("Unknown property values must not be stringified");
    }
  }
}
