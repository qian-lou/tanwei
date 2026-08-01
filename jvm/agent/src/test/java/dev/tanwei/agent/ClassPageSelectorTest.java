package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

final class ClassPageSelectorTest {
  @Test
  void retainsOnlyTheRequestedWindowFromFiftyThousandClasses() {
    ClassPageSelector selector = new ClassPageSelector(100, 25, 50_000);

    for (int index = 49_999; index >= 0; index--) {
      selector.accept(String.format("dev.example.Class%05d", index), index);
      assertTrue(selector.retainedCount() <= 125);
    }

    ClassPageSelector.Page page = selector.finish();
    assertEquals(50_000, page.getTotal());
    assertEquals(25, page.getSelections().size());
    assertEquals("dev.example.Class00100", page.getSelections().get(0).getClassName());
    assertEquals("dev.example.Class00124", page.getSelections().get(24).getClassName());
  }

  @Test
  void preservesSnapshotOrderForDuplicateClassNames() {
    ClassPageSelector selector = new ClassPageSelector(0, 3, 3);
    selector.accept("duplicate.Type", 2);
    selector.accept("duplicate.Type", 0);
    selector.accept("duplicate.Type", 1);

    List<ClassPageSelector.Selection> page = selector.finish().getSelections();
    assertEquals(0, page.get(0).getSnapshotIndex());
    assertEquals(1, page.get(1).getSnapshotIndex());
    assertEquals(2, page.get(2).getSnapshotIndex());
  }

  @Test
  void handlesAnExtremeOffsetWithoutIntegerOverflow() {
    ClassPageSelector selector =
        new ClassPageSelector(Integer.MAX_VALUE, 1_000, 50_000);
    selector.accept("example.Type", 0);

    assertTrue(selector.finish().getSelections().isEmpty());
  }
}
