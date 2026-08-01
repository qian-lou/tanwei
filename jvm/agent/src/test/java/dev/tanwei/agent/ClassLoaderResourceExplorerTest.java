package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.instrument.Instrumentation;
import java.lang.reflect.Proxy;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class ClassLoaderResourceExplorerTest {
  @TempDir Path temporaryDirectory;

  @Test
  void resolvesOneResourceThroughTheExactLoadedClassIdentity()
      throws Exception {
    Instrumentation instrumentation =
        instrumentation(ClassLoaderResourceExplorerTest.class);
    ClassLoaderResourceExplorer explorer =
        new ClassLoaderResourceExplorer(instrumentation);
    try {
      ClassLoader loader =
          ClassLoaderResourceExplorerTest.class.getClassLoader();
      Map<String, String> result =
          explorer.inspect(
              ClassLoaderResourceExplorerTest.class.getName(),
              loader.toString(),
              "dev/tanwei/agent/ClassLoaderResourceExplorerTest.class");

      assertEquals(
          ClassLoaderResourceExplorerTest.class.getName(),
          result.get("selectedClass"));
      assertTrue(Integer.parseInt(result.get("count")) >= 1);
      assertEquals("false", result.get("truncated"));
    } finally {
      explorer.close();
    }
  }

  @Test
  void reportsDuplicateVisibleResourcesWithoutReadingTheirContent()
      throws Exception {
    Path first = temporaryDirectory.resolve("first");
    Path second = temporaryDirectory.resolve("second");
    Path resource = Paths.get("config", "probe.txt");
    Files.createDirectories(first.resolve(resource).getParent());
    Files.createDirectories(second.resolve(resource).getParent());
    Files.write(
        first.resolve(resource),
        "first".getBytes(StandardCharsets.UTF_8));
    Files.write(
        second.resolve(resource),
        "second".getBytes(StandardCharsets.UTF_8));

    ClassLoaderResourceExplorer explorer =
        new ClassLoaderResourceExplorer(
            instrumentation(ClassLoaderResourceExplorerTest.class));
    try (URLClassLoader loader =
        new URLClassLoader(
            new java.net.URL[] {
              first.toUri().toURL(), second.toUri().toURL()
            },
            null)) {
      Map<String, String> result =
          explorer.lookupSelected(
              loader, "probe", loader.toString(), "config/probe.txt");

      assertEquals("2", result.get("count"));
      assertEquals("FILE", result.get("resource.0000.kind"));
      assertEquals("FILE", result.get("resource.0001.kind"));
      assertTrue(
          result.get("resource.0000.location").contains("/first/"));
      assertTrue(
          result.get("resource.0001.location").contains("/second/"));
    } finally {
      explorer.close();
    }
  }

  @Test
  void rejectsAbsoluteAndTraversalResourceNames() {
    ClassLoaderResourceExplorer explorer =
        new ClassLoaderResourceExplorer(
            instrumentation(ClassLoaderResourceExplorerTest.class));
    try {
      ClassLoader loader =
          ClassLoaderResourceExplorerTest.class.getClassLoader();
      assertThrows(
          IllegalArgumentException.class,
          () ->
              explorer.lookupSelected(
                  loader, "probe", loader.toString(), "../secret"));
      assertThrows(
          IllegalArgumentException.class,
          () ->
              explorer.lookupSelected(
                  loader, "probe", loader.toString(), "/absolute"));
    } finally {
      explorer.close();
    }
  }

  private static Instrumentation instrumentation(Class<?>... loadedClasses) {
    return (Instrumentation)
        Proxy.newProxyInstance(
            ClassLoaderResourceExplorerTest.class.getClassLoader(),
            new Class<?>[] {Instrumentation.class},
            (proxy, method, arguments) -> {
              if ("getAllLoadedClasses".equals(method.getName())) {
                return loadedClasses;
              }
              throw new UnsupportedOperationException(method.getName());
            });
  }
}
