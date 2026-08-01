package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import org.junit.jupiter.api.Test;

final class PerfCounterExplorerTest {
  @Test
  void categorizesKnownCounterNamespaces() {
    assertEquals("JAVA", PerfCounterExplorer.categoryOf("java.cls.loadedClasses"));
    assertEquals("SUN", PerfCounterExplorer.categoryOf("sun.gc.collector.0.name"));
    assertEquals("SUN", PerfCounterExplorer.categoryOf("com.sun.management.foo"));
    assertEquals("JDK", PerfCounterExplorer.categoryOf("jdk.compiler.totalTime"));
    assertEquals("OTHER", PerfCounterExplorer.categoryOf("vendor.runtime.value"));
  }

  @Test
  void rendersStringsAndBoundedPrimitiveVectorsWithoutBusinessToString() {
    assertEquals("tanwei", PerfCounterExplorer.renderValue(
        new byte[] {'t', 'a', 'n', 'w', 'e', 'i', 0, 'x'}));
    assertEquals("[1, 2, 3]", PerfCounterExplorer.renderValue(new long[] {1L, 2L, 3L}));
    assertTrue(
        PerfCounterExplorer.renderValue(new Object()).startsWith("<unsupported: "));
  }

  @Test
  void masksCommandLinesAndCredentialLikeCounters() {
    assertTrue(PerfCounterExplorer.isSensitiveCounter("java.rt.vmArgs"));
    assertTrue(PerfCounterExplorer.isSensitiveCounter("java.rt.javaCommand"));
    assertTrue(PerfCounterExplorer.isSensitiveCounter("vendor.apiToken"));
    assertFalse(PerfCounterExplorer.isSensitiveCounter("java.cls.loadedClasses"));
  }

  @Test
  void validatesNamespaceBeforeMatching() {
    assertTrue(
        PerfCounterExplorer.matchesNamespace("java.cls.loadedClasses", "JAVA"));
    assertTrue(
        PerfCounterExplorer.matchesNamespace("sun.gc.collector.0.name", "ALL"));
    assertFalse(
        PerfCounterExplorer.matchesNamespace("sun.gc.collector.0.name", "JDK"));
    assertThrows(
        IllegalArgumentException.class,
        () -> PerfCounterExplorer.matchesNamespace("java.cls.loadedClasses", "VENDOR"));
  }

  @Test
  void validatesBoundedUniqueSnapshotNames() {
    assertEquals(
        Arrays.asList(
            "java.cls.loadedClasses",
            "sun.gc.collector.0.invocations"),
        PerfCounterExplorer.parseSnapshotNames(
            "java.cls.loadedClasses\nsun.gc.collector.0.invocations"));
    assertThrows(
        IllegalArgumentException.class,
        () -> PerfCounterExplorer.parseSnapshotNames(""));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            PerfCounterExplorer.parseSnapshotNames(
                "java.cls.loadedClasses\njava.cls.loadedClasses"));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            PerfCounterExplorer.parseSnapshotNames(
                "a\nb\nc\nd\ne\nf\ng\nh\ni"));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            PerfCounterExplorer.parseSnapshotNames(
                "java.cls.loadedClasses\r"));
  }
}
