package dev.tanwei.protocol.v1;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import org.junit.jupiter.api.Test;

final class ProtocolDefaultsTest {

  @Test
  void snapshotDistinguishesMissingCpuFromZero() {
    RuntimeSnapshot snapshot =
        RuntimeSnapshot.newBuilder()
            .setProcessCpuLoad(0.0d)
            .setHasProcessCpuLoad(false)
            .setJvmStartTimeEpochMillis(1785450000000L)
            .build();

    assertEquals(0.0d, snapshot.getProcessCpuLoad());
    assertFalse(snapshot.getHasProcessCpuLoad());
    assertEquals(1785450000000L, snapshot.getJvmStartTimeEpochMillis());
  }
}
