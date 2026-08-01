package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class JitCompilerInspectorTest {
  @Test
  void mapsStableCompilerSemanticsAndPrefersHotSpotCounters() {
    Map<String, String> counters = new HashMap<String, String>();
    counters.put("vendor.ci.totalCompiles", "4");
    counters.put("java.ci.totalCompiles", "5");
    counters.put("sun.ci.totalCompiles", "6");
    counters.put("sun.ci.standardCompiles", "3");
    counters.put("sun.ci.osrCompiles", "2");
    counters.put("sun.ci.lastMethod", "example.Work::run");
    counters.put("sun.ci.lastSize", "128");

    Map<String, String> semantic =
        JitCompilerInspector.semanticCounters(counters);

    assertEquals("6", semantic.get("metric.totalCompiles"));
    assertEquals("3", semantic.get("metric.standardCompiles"));
    assertEquals("2", semantic.get("metric.osrCompiles"));
    assertEquals("example.Work::run", semantic.get("last.success.method"));
    assertEquals("128", semantic.get("last.success.sizeBytes"));
  }

  @Test
  void omitsMissingAndBlankCounterValues() {
    Map<String, String> counters = new HashMap<String, String>();
    counters.put("sun.ci.totalBailouts", " ");
    counters.put("sun.ci.totalInvalidates", "7");
    counters.put("unrelated.counter", "100");

    Map<String, String> semantic =
        JitCompilerInspector.semanticCounters(counters);

    assertFalse(semantic.containsKey("metric.bailouts"));
    assertEquals("7", semantic.get("metric.invalidations"));
    assertEquals(1, semantic.size());
  }

  @Test
  void reportsCompilerAndCodeCacheEvenWithoutPerfCounterAccess() {
    JitCompilerInspector inspector =
        new JitCompilerInspector(new PerfCounterExplorer(null, -1L));

    Map<String, String> snapshot = inspector.snapshot();

    assertEquals("1", snapshot.get("schemaVersion"));
    assertTrue(
        Long.parseLong(snapshot.get("sampledAtEpochMillis")) > 0L);
    assertTrue(snapshot.containsKey("compiler.available"));
    assertTrue(snapshot.containsKey("compiler.name"));
    assertTrue(
        Integer.parseInt(snapshot.get("codeCache.count"))
            <= JitCompilerInspector.MAXIMUM_CODE_CACHE_POOLS);
    assertEquals("false", snapshot.get("internal.available"));
  }

  @Test
  void recognizesLegacyAndSegmentedCodeCachePoolNames() {
    assertTrue(JitCompilerInspector.isCodeCachePool("Code Cache"));
    assertTrue(
        JitCompilerInspector.isCodeCachePool(
            "CodeHeap 'profiled nmethods'"));
    assertFalse(JitCompilerInspector.isCodeCachePool("G1 Eden Space"));
  }
}
