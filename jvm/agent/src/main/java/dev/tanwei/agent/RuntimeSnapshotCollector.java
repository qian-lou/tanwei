package dev.tanwei.agent;

import dev.tanwei.protocol.v1.RuntimeSnapshot;
import java.lang.management.ClassLoadingMXBean;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.lang.management.OperatingSystemMXBean;
import java.lang.management.RuntimeMXBean;
import java.lang.management.ThreadMXBean;
import java.lang.reflect.Method;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

final class RuntimeSnapshotCollector {
  private final RuntimeMXBean runtime = ManagementFactory.getRuntimeMXBean();
  private final MemoryMXBean memory = ManagementFactory.getMemoryMXBean();
  private final ThreadMXBean threads = ManagementFactory.getThreadMXBean();
  private final ClassLoadingMXBean classes = ManagementFactory.getClassLoadingMXBean();
  private final OperatingSystemMXBean operatingSystem =
      ManagementFactory.getOperatingSystemMXBean();
  private final List<GarbageCollectorMXBean> garbageCollectors =
      ManagementFactory.getGarbageCollectorMXBeans();
  private final AtomicLong sequence = new AtomicLong();

  RuntimeSnapshot collect() {
    MemoryUsage heap = memory.getHeapMemoryUsage();
    MemoryUsage nonHeap = memory.getNonHeapMemoryUsage();
    RuntimeSnapshot.Builder snapshot =
        RuntimeSnapshot.newBuilder()
            .setSequence(sequence.incrementAndGet())
            .setCapturedAtEpochMillis(System.currentTimeMillis())
            .setUptimeMillis(runtime.getUptime())
            .setJvmStartTimeEpochMillis(runtime.getStartTime())
            .setHeapUsedBytes(nonNegative(heap.getUsed()))
            .setHeapMaxBytes(nonNegative(heap.getMax()))
            .setNonHeapUsedBytes(nonNegative(nonHeap.getUsed()))
            .setLiveThreads(threads.getThreadCount())
            .setPeakThreads(threads.getPeakThreadCount())
            .setLoadedClasses(classes.getLoadedClassCount());

    long gcCount = 0L;
    long gcTime = 0L;
    for (GarbageCollectorMXBean collector : garbageCollectors) {
      gcCount += nonNegative(collector.getCollectionCount());
      gcTime += nonNegative(collector.getCollectionTime());
    }
    snapshot.setGcCount(gcCount).setGcTimeMillis(gcTime);

    Double processCpu = readProcessCpuLoad(operatingSystem);
    if (processCpu != null) {
      snapshot.setProcessCpuLoad(processCpu.doubleValue()).setHasProcessCpuLoad(true);
    }
    Double systemCpu = readSystemCpuLoad(operatingSystem);
    if (systemCpu != null) {
      snapshot.setSystemCpuLoad(systemCpu.doubleValue()).setHasSystemCpuLoad(true);
    }
    return snapshot.build();
  }

  private static long nonNegative(long value) {
    return value < 0L ? 0L : value;
  }

  private static Double readProcessCpuLoad(OperatingSystemMXBean operatingSystem) {
    try {
      if (operatingSystem instanceof com.sun.management.OperatingSystemMXBean) {
        return validCpuLoad(
            ((com.sun.management.OperatingSystemMXBean) operatingSystem)
                .getProcessCpuLoad());
      }
    } catch (LinkageError | RuntimeException ignored) {
      // Fall through for non-HotSpot or partially available management implementations.
    }
    return readCpuLoadReflectively(operatingSystem, "getProcessCpuLoad");
  }

  private static Double readSystemCpuLoad(OperatingSystemMXBean operatingSystem) {
    try {
      if (operatingSystem instanceof com.sun.management.OperatingSystemMXBean) {
        return validCpuLoad(
            ((com.sun.management.OperatingSystemMXBean) operatingSystem)
                .getSystemCpuLoad());
      }
    } catch (LinkageError | RuntimeException ignored) {
      // Fall through for non-HotSpot or partially available management implementations.
    }
    return readCpuLoadReflectively(operatingSystem, "getSystemCpuLoad");
  }

  private static Double readCpuLoadReflectively(
      OperatingSystemMXBean operatingSystem, String methodName) {
    try {
      Method method = operatingSystem.getClass().getMethod(methodName);
      Object value = method.invoke(operatingSystem);
      if (value instanceof Number) {
        return validCpuLoad(((Number) value).doubleValue());
      }
    } catch (ReflectiveOperationException | RuntimeException ignored) {
      // Unsupported platform/JDK; absence is represented by the has_* field.
    }
    return null;
  }

  private static Double validCpuLoad(double value) {
    return !Double.isNaN(value)
            && !Double.isInfinite(value)
            && value >= 0.0d
            && value <= 1.0d
        ? Double.valueOf(value)
        : null;
  }
}
