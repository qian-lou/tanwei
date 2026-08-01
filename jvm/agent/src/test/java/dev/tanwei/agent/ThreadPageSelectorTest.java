package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tanwei.protocol.v1.ThreadDescriptor;
import java.util.List;
import org.junit.jupiter.api.Test;

final class ThreadPageSelectorTest {
  @Test
  void retainsOnlyTheBestBoundedWindowFromTenThousandThreads() {
    ThreadPageSelector selector = new ThreadPageSelector(100, 25, 10_000);
    java.util.ArrayList<ThreadDescriptor> expected =
        new java.util.ArrayList<ThreadDescriptor>(10_000);

    for (int index = 10_000; index >= 1; index--) {
      ThreadDescriptor candidate = descriptor(index, index % 17);
      expected.add(candidate);
      selector.accept(candidate);
      assertTrue(selector.retainedCount() <= 125);
    }

    expected.sort(ThreadPageSelector.BEST_FIRST);
    ThreadPageSelector.Page page = selector.finish();
    assertEquals(10_000, page.getTotal());
    assertEquals(25, page.getThreads().size());
    assertEquals(expected.subList(100, 125), page.getThreads());
    assertOrdered(page.getThreads());
  }

  @Test
  void ordersEqualCpuTimeByStableThreadId() {
    ThreadPageSelector selector = new ThreadPageSelector(0, 3, 3);
    selector.accept(descriptor(30, 7));
    selector.accept(descriptor(10, 7));
    selector.accept(descriptor(20, 7));

    List<ThreadDescriptor> page = selector.finish().getThreads();
    assertEquals(10L, page.get(0).getId());
    assertEquals(20L, page.get(1).getId());
    assertEquals(30L, page.get(2).getId());
  }

  @Test
  void handlesAnExtremeOffsetWithoutIntegerOverflow() {
    ThreadPageSelector selector =
        new ThreadPageSelector(Integer.MAX_VALUE, 1_000, 10_000);
    for (int index = 0; index < 10_000; index++) {
      selector.accept(descriptor(index + 1L, index));
    }

    assertEquals(10_000, selector.retainedCount());
    assertTrue(selector.finish().getThreads().isEmpty());
  }

  private static ThreadDescriptor descriptor(long id, long cpuTimeNanos) {
    return ThreadDescriptor.newBuilder()
        .setId(id)
        .setName("thread-" + id)
        .setCpuTimeNanos(cpuTimeNanos)
        .setHasCpuTime(true)
        .build();
  }

  private static void assertOrdered(List<ThreadDescriptor> threads) {
    for (int index = 1; index < threads.size(); index++) {
      assertTrue(
          ThreadPageSelector.BEST_FIRST.compare(
                  threads.get(index - 1), threads.get(index))
              <= 0);
    }
  }
}
