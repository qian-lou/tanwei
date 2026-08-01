package dev.tanwei.agent;

import java.lang.management.CompilationMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryUsage;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/** Builds a bounded, read-only JIT compiler and code-cache snapshot. */
final class JitCompilerInspector {
  static final int MAXIMUM_CODE_CACHE_POOLS = 8;
  private static final int MAXIMUM_INTERNAL_COUNTERS = 200;
  private static final int MAXIMUM_TEXT_LENGTH = 4_096;
  private static final String[][] SEMANTIC_COUNTERS = {
    {"metric.totalCompiles", "totalCompiles"},
    {"metric.standardCompiles", "standardCompiles"},
    {"metric.osrCompiles", "osrCompiles"},
    {"metric.bailouts", "totalBailouts"},
    {"metric.invalidations", "totalInvalidates"},
    {"metric.nmethodCodeBytes", "nmethodCodeSize"},
    {"metric.nmethodTotalBytes", "nmethodSize"},
    {"last.success.method", "lastMethod"},
    {"last.success.type", "lastType"},
    {"last.success.sizeBytes", "lastSize"},
    {"last.failed.method", "lastFailedMethod"},
    {"last.failed.type", "lastFailedType"},
    {"last.failed.sizeBytes", "lastFailedSize"},
    {"last.invalidated.method", "lastInvalidatedMethod"},
    {"last.invalidated.type", "lastInvalidatedType"},
    {"last.invalidated.sizeBytes", "lastInvalidatedSize"}
  };

  private final PerfCounterExplorer perfCounters;

  JitCompilerInspector(PerfCounterExplorer perfCounters) {
    this.perfCounters = perfCounters;
  }

  Map<String, String> snapshot() {
    Map<String, String> values = new TreeMap<String, String>();
    values.put("schemaVersion", "1");
    values.put("sampledAtEpochMillis", Long.toString(System.currentTimeMillis()));
    addCompiler(values);
    addCodeCache(values);
    addInternalCounters(values);
    return values;
  }

  private static void addCompiler(Map<String, String> values) {
    CompilationMXBean compiler;
    try {
      compiler = ManagementFactory.getCompilationMXBean();
    } catch (RuntimeException unavailable) {
      compiler = null;
    }
    if (compiler == null) {
      values.put("compiler.available", "false");
      values.put("compiler.name", "");
      values.put("compiler.timeSupported", "false");
      return;
    }

    values.put("compiler.available", "true");
    values.put("compiler.name", boundedText(safeCompilerName(compiler)));
    boolean timeSupported = safeTimeSupported(compiler);
    values.put("compiler.timeSupported", Boolean.toString(timeSupported));
    if (timeSupported) {
      long totalTime = safeTotalCompilationTime(compiler);
      if (totalTime >= 0L) {
        values.put("compiler.totalTimeMillis", Long.toString(totalTime));
      }
    }
  }

  private static void addCodeCache(Map<String, String> values) {
    List<MemoryPoolMXBean> codeCachePools = new ArrayList<MemoryPoolMXBean>();
    try {
      for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
        if (pool != null && isCodeCachePool(pool.getName())) {
          codeCachePools.add(pool);
        }
      }
    } catch (RuntimeException ignored) {
      // A partial snapshot is preferable to failing compiler inspection.
    }
    Collections.sort(
        codeCachePools,
        new Comparator<MemoryPoolMXBean>() {
          @Override
          public int compare(MemoryPoolMXBean left, MemoryPoolMXBean right) {
            return safePoolName(left).compareTo(safePoolName(right));
          }
        });

    int count = Math.min(codeCachePools.size(), MAXIMUM_CODE_CACHE_POOLS);
    long totalUsed = 0L;
    long totalCommitted = 0L;
    long totalMaximum = 0L;
    boolean maximumKnown = false;
    boolean maximumComplete = true;
    int visibleCount = 0;
    for (int index = 0; index < count; index++) {
      MemoryPoolMXBean pool = codeCachePools.get(index);
      MemoryUsage usage = safeUsage(pool);
      if (usage == null) {
        continue;
      }
      String prefix = String.format(Locale.ROOT, "codeCache.%02d.", visibleCount);
      values.put(prefix + "name", boundedText(safePoolName(pool)));
      values.put(prefix + "usedBytes", Long.toString(nonNegative(usage.getUsed())));
      values.put(
          prefix + "committedBytes",
          Long.toString(nonNegative(usage.getCommitted())));
      values.put(
          prefix + "maxBytes",
          usage.getMax() < 0L ? "" : Long.toString(usage.getMax()));
      MemoryUsage peak = safePeakUsage(pool);
      values.put(
          prefix + "peakUsedBytes",
          peak == null ? "" : Long.toString(nonNegative(peak.getUsed())));
      totalUsed = saturatedAdd(totalUsed, nonNegative(usage.getUsed()));
      totalCommitted =
          saturatedAdd(totalCommitted, nonNegative(usage.getCommitted()));
      if (usage.getMax() >= 0L) {
        totalMaximum = saturatedAdd(totalMaximum, usage.getMax());
        maximumKnown = true;
      } else {
        maximumComplete = false;
      }
      visibleCount++;
    }
    values.put("codeCache.count", Integer.toString(visibleCount));
    values.put(
        "codeCache.truncated",
        Boolean.toString(codeCachePools.size() > MAXIMUM_CODE_CACHE_POOLS));
    values.put("codeCache.totalUsedBytes", Long.toString(totalUsed));
    values.put("codeCache.totalCommittedBytes", Long.toString(totalCommitted));
    values.put(
        "codeCache.totalMaxBytes",
        maximumKnown ? Long.toString(totalMaximum) : "");
    values.put(
        "codeCache.totalMaxComplete",
        Boolean.toString(visibleCount > 0 && maximumComplete));
  }

  private void addInternalCounters(Map<String, String> values) {
    if (perfCounters == null || !perfCounters.isAvailable()) {
      values.put("internal.available", "false");
      values.put(
          "internal.reason",
          perfCounters == null
              ? "HotSpot PerfCounter access is unavailable"
              : boundedText(perfCounters.unavailableReason()));
      values.put("internal.counterCount", "0");
      values.put("internal.truncated", "false");
      return;
    }
    try {
      PerfCounterExplorer.Page page =
          perfCounters.list(".ci.", "ALL", 0, MAXIMUM_INTERNAL_COUNTERS);
      Map<String, String> counters =
          new LinkedHashMap<String, String>(page.getCounters().size());
      for (PerfCounterExplorer.CounterSnapshot counter : page.getCounters()) {
        counters.put(counter.getName(), counter.getValue());
      }
      values.put("internal.available", "true");
      values.put("internal.reason", "");
      values.put("internal.counterCount", Integer.toString(page.getTotal()));
      values.put(
          "internal.truncated",
          Boolean.toString(
              page.isTruncated() || page.getTotal() > page.getCounters().size()));
      values.putAll(semanticCounters(counters));
    } catch (Exception exception) {
      values.put("internal.available", "false");
      values.put("internal.reason", boundedText(conciseReason(exception)));
      values.put("internal.counterCount", "0");
      values.put("internal.truncated", "false");
    }
  }

  static Map<String, String> semanticCounters(
      Map<String, String> counters) {
    Map<String, String> result = new TreeMap<String, String>();
    if (counters == null || counters.isEmpty()) {
      return result;
    }
    for (String[] mapping : SEMANTIC_COUNTERS) {
      String value = findCounterValue(counters, mapping[1]);
      if (value != null && !value.trim().isEmpty()) {
        result.put(mapping[0], boundedText(value));
      }
    }
    return result;
  }

  private static String findCounterValue(
      Map<String, String> counters, String suffix) {
    String selectedName = null;
    int selectedPriority = Integer.MAX_VALUE;
    for (Map.Entry<String, String> entry : counters.entrySet()) {
      String name = entry.getKey();
      if (name == null
          || !(name.equals(suffix) || name.endsWith("." + suffix))) {
        continue;
      }
      int priority = counterPriority(name);
      if (selectedName == null
          || priority < selectedPriority
          || (priority == selectedPriority
              && name.compareTo(selectedName) < 0)) {
        selectedName = name;
        selectedPriority = priority;
      }
    }
    return selectedName == null ? null : counters.get(selectedName);
  }

  private static int counterPriority(String name) {
    String normalized = name.toLowerCase(Locale.ROOT);
    if (normalized.startsWith("sun.ci.")) {
      return 0;
    }
    if (normalized.startsWith("java.ci.")) {
      return 1;
    }
    if (normalized.startsWith("jdk.ci.")) {
      return 2;
    }
    return 3;
  }

  static boolean isCodeCachePool(String name) {
    String normalized =
        name == null ? "" : name.toLowerCase(Locale.ROOT);
    return normalized.contains("code cache")
        || normalized.contains("codeheap");
  }

  private static String safeCompilerName(CompilationMXBean compiler) {
    try {
      String name = compiler.getName();
      return name == null ? "" : name;
    } catch (RuntimeException ignored) {
      return "";
    }
  }

  private static boolean safeTimeSupported(CompilationMXBean compiler) {
    try {
      return compiler.isCompilationTimeMonitoringSupported();
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  private static long safeTotalCompilationTime(CompilationMXBean compiler) {
    try {
      return compiler.getTotalCompilationTime();
    } catch (RuntimeException ignored) {
      return -1L;
    }
  }

  private static String safePoolName(MemoryPoolMXBean pool) {
    try {
      String name = pool.getName();
      return name == null ? "" : name;
    } catch (RuntimeException ignored) {
      return "";
    }
  }

  private static MemoryUsage safeUsage(MemoryPoolMXBean pool) {
    try {
      return pool.getUsage();
    } catch (RuntimeException ignored) {
      return null;
    }
  }

  private static MemoryUsage safePeakUsage(MemoryPoolMXBean pool) {
    try {
      return pool.getPeakUsage();
    } catch (RuntimeException ignored) {
      return null;
    }
  }

  private static long nonNegative(long value) {
    return Math.max(0L, value);
  }

  private static long saturatedAdd(long left, long right) {
    if (right > 0L && left > Long.MAX_VALUE - right) {
      return Long.MAX_VALUE;
    }
    return left + right;
  }

  private static String boundedText(String value) {
    String safe = value == null ? "" : value;
    return safe.length() <= MAXIMUM_TEXT_LENGTH
        ? safe
        : safe.substring(0, MAXIMUM_TEXT_LENGTH) + "…";
  }

  private static String conciseReason(Throwable exception) {
    String message = exception.getMessage();
    return exception.getClass().getSimpleName()
        + (message == null || message.trim().isEmpty()
            ? ""
            : ": " + message.trim());
  }
}
