package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class EnvironmentExplorerTest {
  @Test
  void classifiesSearchesAndMasksEverythingOutsideTheSafeAllowlist() {
    Map<String, String> environment = new LinkedHashMap<String, String>();
    environment.put("PATH", "/usr/bin:/bin");
    environment.put("JAVA_HOME", "/opt/jdk");
    environment.put("LANG", "zh_CN.UTF-8");
    environment.put("PWD", "/srv/app");
    environment.put("SERVICE_TOKEN", "do-not-return-this-value");
    environment.put("DATABASE_URL", "jdbc:test");
    environment.put("DB_PASSWORD", "secret");

    EnvironmentExplorer.Result result =
        new EnvironmentExplorer()
            .list(environment, "", EnvironmentExplorer.Category.ALL, 0, 20);

    assertEquals(7, result.getEnvironmentCount());
    assertEquals(4, result.getVisibleCount());
    assertEquals(3, result.getMaskedCount());
    assertEquals(7, result.getTotal());
    assertEquals("DATABASE_URL", result.getEntries().get(0).getKey());
    assertEquals(
        "<masked>",
        entry(result, "DATABASE_URL").getValue());
    assertEquals(
        EnvironmentExplorer.Visibility.MASKED,
        entry(result, "SERVICE_TOKEN").getVisibility());
    assertEquals(
        "/usr/bin:/bin",
        entry(result, "PATH").getValue());
    assertEquals("/srv/app", entry(result, "PWD").getValue());
    assertEquals(
        EnvironmentExplorer.Category.JAVA,
        entry(result, "JAVA_HOME").getCategory());
  }

  @Test
  void appliesCategoryQueryPaginationAndVisibleValueTruncation() {
    Map<String, String> environment = new LinkedHashMap<String, String>();
    environment.put("PATH", repeat("a", 4_200));
    environment.put("CLASSPATH", "/app/classes");
    environment.put("JAVA_HOME", "/opt/jdk");
    environment.put("MAVEN_HOME", "/opt/maven");

    EnvironmentExplorer explorer = new EnvironmentExplorer();
    EnvironmentExplorer.Result javaPage =
        explorer.list(environment, "home", EnvironmentExplorer.Category.JAVA, 1, 1);
    assertEquals(2, javaPage.getTotal());
    assertEquals(1, javaPage.getOffset());
    assertEquals("MAVEN_HOME", javaPage.getEntries().get(0).getKey());

    EnvironmentExplorer.Result path =
        explorer.list(environment, "path", EnvironmentExplorer.Category.ALL, 0, 10);
    assertEquals(2, path.getTotal());
    EnvironmentExplorer.Entry pathEntry = entry(path, "PATH");
    assertTrue(pathEntry.isTruncated());
    assertEquals(4_200, pathEntry.getValueLength());
    assertEquals(4_097, pathEntry.getValue().length());
    assertTrue(pathEntry.getValue().endsWith("…"));
  }

  @Test
  void rejectsControlCharactersAndCountsInvalidRuntimeEntries() {
    Map<String, String> environment = new LinkedHashMap<String, String>();
    environment.put("PATH", "/bin");
    environment.put("INVALID\nKEY", "ignored");

    EnvironmentExplorer explorer = new EnvironmentExplorer();
    EnvironmentExplorer.Result result =
        explorer.list(environment, "", EnvironmentExplorer.Category.ALL, 0, 10);
    assertEquals(1, result.getInvalidCount());
    assertFalse(result.getEntries().isEmpty());
    assertThrows(
        IllegalArgumentException.class,
        () ->
            explorer.list(
                environment,
                "bad\nquery",
                EnvironmentExplorer.Category.ALL,
                0,
                10));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            explorer.list(
                environment,
                "",
                EnvironmentExplorer.Category.ALL,
                0,
                201));
  }

  private static EnvironmentExplorer.Entry entry(
      EnvironmentExplorer.Result result, String key) {
    return result.getEntries().stream()
        .filter(item -> item.getKey().equals(key))
        .findFirst()
        .orElseThrow(() -> new AssertionError("Missing environment entry " + key));
  }

  private static String repeat(String value, int count) {
    StringBuilder result = new StringBuilder(value.length() * count);
    for (int index = 0; index < count; index++) {
      result.append(value);
    }
    return result.toString();
  }
}
