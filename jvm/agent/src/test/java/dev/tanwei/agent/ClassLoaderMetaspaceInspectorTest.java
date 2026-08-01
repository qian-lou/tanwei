package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

final class ClassLoaderMetaspaceInspectorTest {
  @Test
  void samplesLatestClassLoaderDataAndSortsByAllocatedMetaspace()
      throws Exception {
    ClassLoaderMetaspaceInspector inspector =
        new ClassLoaderMetaspaceInspector();
    Assumptions.assumeTrue(inspector.isAvailable());

    ClassLoaderMetaspaceInspector.Result result =
        inspector.inspect(600, 100, 20);

    assertEquals(600, result.getDurationMillis());
    assertEquals(100, result.getPeriodMillis());
    assertTrue(result.getEventCount() > 0);
    assertTrue(result.getTotalLoaders() > 0);
    assertFalse(result.getRows().isEmpty());
    assertTrue(result.getTotalChunkSize() >= result.getTotalBlockSize());
    assertTrue(result.getTotalClassCount() > 0L);
    assertSorted(result.getRows());
    for (ClassLoaderMetaspaceInspector.Row row : result.getRows()) {
      assertFalse(row.getId().isEmpty());
      assertFalse(row.getName().isEmpty());
      assertTrue(row.getChunkSize() >= row.getBlockSize());
      assertTrue(row.getSampledAtEpochMillis() > 0L);
    }
  }

  @Test
  void rejectsUnboundedSamplingParametersBeforeStartingJfr() {
    ClassLoaderMetaspaceInspector inspector =
        new ClassLoaderMetaspaceInspector();

    assertThrows(
        IllegalArgumentException.class,
        () -> inspector.inspect(249, 100, 20));
    assertThrows(
        IllegalArgumentException.class,
        () -> inspector.inspect(500, 501, 20));
    assertThrows(
        IllegalArgumentException.class,
        () -> inspector.inspect(500, 100, 101));
  }

  private static void assertSorted(
      List<ClassLoaderMetaspaceInspector.Row> rows) {
    for (int index = 1; index < rows.size(); index++) {
      ClassLoaderMetaspaceInspector.Row previous = rows.get(index - 1);
      ClassLoaderMetaspaceInspector.Row current = rows.get(index);
      assertTrue(previous.getChunkSize() >= current.getChunkSize());
      if (previous.getChunkSize() == current.getChunkSize()) {
        assertTrue(previous.getBlockSize() >= current.getBlockSize());
      }
    }
  }
}
