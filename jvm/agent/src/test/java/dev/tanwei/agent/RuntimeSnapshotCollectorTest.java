package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tanwei.protocol.v1.RuntimeSnapshot;
import java.lang.management.ManagementFactory;
import org.junit.jupiter.api.Test;

final class RuntimeSnapshotCollectorTest {

  @Test
  void carriesTheRuntimeMxBeanStartTimeAsStableJvmIdentity() {
    RuntimeSnapshot snapshot = new RuntimeSnapshotCollector().collect();
    long expectedStartTime = ManagementFactory.getRuntimeMXBean().getStartTime();

    assertTrue(snapshot.getJvmStartTimeEpochMillis() > 0L);
    assertEquals(expectedStartTime, snapshot.getJvmStartTimeEpochMillis());
    assertTrue(snapshot.getUptimeMillis() >= 0L);
    assertTrue(snapshot.getCapturedAtEpochMillis() >= expectedStartTime);
  }

  @Test
  void readsProcessCpuLoadThroughThePublicHotSpotMxBeanContract() {
    RuntimeSnapshot snapshot = new RuntimeSnapshotCollector().collect();

    if (ManagementFactory.getOperatingSystemMXBean()
        instanceof com.sun.management.OperatingSystemMXBean) {
      assertTrue(snapshot.getHasProcessCpuLoad());
      assertTrue(snapshot.getProcessCpuLoad() >= 0.0d);
      assertTrue(snapshot.getProcessCpuLoad() <= 1.0d);
    }
  }
}
