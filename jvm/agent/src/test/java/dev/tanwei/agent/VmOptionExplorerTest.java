package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import org.junit.jupiter.api.Test;

final class VmOptionExplorerTest {
  @Test
  void classifiesFiltersAndMasksDangerousCommandValues() throws Exception {
    VmOptionExplorer explorer =
        explorer(
            option("HeapDumpOnOutOfMemoryError", "true", true, "DEFAULT"),
            option("MaxHeapFreeRatio", "70", true, "ERGONOMIC"),
            option("PrintGC", "false", false, "DEFAULT"),
            option("OnError", "curl https://secret.invalid", true, "VM_CREATION"),
            option("TieredCompilation", "true", false, "DEFAULT"));

    VmOptionExplorer.Result result =
        explorer.list(
            "", VmOptionExplorer.Category.ALL, VmOptionExplorer.Mutability.ALL, 0, 20);

    assertEquals(5, result.getOptionCount());
    assertEquals(3, result.getWriteableCount());
    assertEquals(2, result.getReadOnlyCount());
    assertEquals(1, result.getMaskedCount());
    assertEquals(
        VmOptionExplorer.Category.MEMORY,
        entry(result, "MaxHeapFreeRatio").getCategory());
    assertEquals(
        VmOptionExplorer.Category.COMPILER,
        entry(result, "TieredCompilation").getCategory());
    assertEquals("<masked>", entry(result, "OnError").getValue());
    assertFalse(entry(result, "OnError").isMutable());
    assertTrue(entry(result, "MaxHeapFreeRatio").isMutable());
  }

  @Test
  void appliesCategoryMutabilityPaginationAndValueTruncation() throws Exception {
    VmOptionExplorer explorer =
        explorer(
            option("HeapDumpPath", repeat("a", 4_200), true, "MANAGEMENT"),
            option("MaxHeapFreeRatio", "70", true, "DEFAULT"),
            option("MinHeapFreeRatio", "40", true, "ERGONOMIC"),
            option("PrintGC", "false", false, "DEFAULT"));

    VmOptionExplorer.Result page =
        explorer.list(
            "ratio",
            VmOptionExplorer.Category.MEMORY,
            VmOptionExplorer.Mutability.WRITEABLE,
            1,
            1);
    assertEquals(2, page.getTotal());
    assertEquals("MinHeapFreeRatio", page.getEntries().get(0).getName());

    VmOptionExplorer.Entry dumpPath =
        entry(
            explorer.list(
                "dump",
                VmOptionExplorer.Category.ALL,
                VmOptionExplorer.Mutability.ALL,
                0,
                10),
            "HeapDumpPath");
    assertTrue(dumpPath.isTruncated());
    assertEquals(4_200, dumpPath.getValueLength());
    assertFalse(dumpPath.isMutable());
  }

  @Test
  void rejectsInvalidQueriesBoundsAndSourceSnapshots() {
    VmOptionExplorer explorer = explorer(option("PrintGC", "false", false, "DEFAULT"));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            explorer.list(
                "bad\nquery",
                VmOptionExplorer.Category.ALL,
                VmOptionExplorer.Mutability.ALL,
                0,
                10));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            explorer.list(
                "",
                VmOptionExplorer.Category.ALL,
                VmOptionExplorer.Mutability.ALL,
                0,
                201));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new VmOptionExplorer.SourceSnapshot(
                2,
                1,
                0,
                false,
                Collections.singletonList(
                    option("PrintGC", "false", false, "DEFAULT"))));
  }

  private static VmOptionExplorer explorer(VmOptionExplorer.OptionValue... values) {
    return new VmOptionExplorer(
        () ->
            new VmOptionExplorer.SourceSnapshot(
                values.length,
                values.length,
                0,
                false,
                Arrays.asList(values)));
  }

  private static VmOptionExplorer.OptionValue option(
      String name, String value, boolean writeable, String origin) {
    return new VmOptionExplorer.OptionValue(name, value, writeable, origin);
  }

  private static VmOptionExplorer.Entry entry(
      VmOptionExplorer.Result result, String name) {
    return result.getEntries().stream()
        .filter(item -> item.getName().equals(name))
        .findFirst()
        .orElseThrow(() -> new AssertionError("Missing VM option " + name));
  }

  private static String repeat(String value, int count) {
    StringBuilder result = new StringBuilder(value.length() * count);
    for (int index = 0; index < count; index++) {
      result.append(value);
    }
    return result.toString();
  }
}
