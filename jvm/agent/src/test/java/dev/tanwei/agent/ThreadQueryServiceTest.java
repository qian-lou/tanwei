package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tanwei.protocol.v1.ThreadListRequest;
import dev.tanwei.protocol.v1.ThreadListResponse;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

final class ThreadQueryServiceTest {
  @Test
  void fetchesDeepStacksOnlyForTheSelectedPage() throws Exception {
    CountDownLatch started = new CountDownLatch(3);
    CountDownLatch release = new CountDownLatch(1);
    List<Thread> threads = new ArrayList<Thread>();
    for (int index = 0; index < 3; index++) {
      Thread thread =
          new Thread(
              () -> {
                started.countDown();
                try {
                  release.await();
                } catch (InterruptedException interrupted) {
                  Thread.currentThread().interrupt();
                }
              },
              "tanwei-query-" + index);
      thread.setDaemon(true);
      threads.add(thread);
      thread.start();
    }

    try {
      assertTrue(started.await(5L, TimeUnit.SECONDS));
      RecordingThreadDataSource source = new RecordingThreadDataSource(threads);
      source.setCpuTime(threads.get(0).getId(), 300L);
      source.setCpuTime(threads.get(1).getId(), 200L);
      source.setCpuTime(threads.get(2).getId(), 100L);

      ThreadListResponse response =
          new ThreadQueryService(source)
              .list(
                  ThreadListRequest.newBuilder()
                      .setNameQuery("tanwei-query-")
                      .setOffset(1)
                      .setLimit(1)
                      .setStackDepth(8)
                      .build());

      assertEquals(3, response.getTotal());
      assertEquals(1, response.getThreadsCount());
      assertEquals(threads.get(1).getId(), response.getThreads(0).getId());
      assertFalse(response.getThreads(0).getStackList().isEmpty());
      assertEquals(2, source.calls.size());
      assertEquals(0, source.calls.get(0).depth);
      assertArrayEquals(source.ids, source.calls.get(0).ids);
      assertEquals(8, source.calls.get(1).depth);
      assertArrayEquals(
          new long[] {threads.get(1).getId()}, source.calls.get(1).ids);
    } finally {
      release.countDown();
      for (Thread thread : threads) {
        thread.join(5_000L);
      }
    }
  }

  @Test
  void preservesMetadataWhenAThreadExitsBeforeDeepStackCapture()
      throws Exception {
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    Thread thread =
        new Thread(
            () -> {
              started.countDown();
              try {
                release.await();
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              }
            },
            "tanwei-query-exiting");
    thread.setDaemon(true);
    thread.start();
    try {
      assertTrue(started.await(5L, TimeUnit.SECONDS));
      RecordingThreadDataSource source =
          new RecordingThreadDataSource(Collections.singletonList(thread));
      source.exitBeforeDeepCapture = true;

      ThreadListResponse response =
          new ThreadQueryService(source)
              .list(
                  ThreadListRequest.newBuilder()
                      .setLimit(1)
                      .setStackDepth(8)
                      .build());

      assertEquals(1, response.getTotal());
      assertEquals(thread.getId(), response.getThreads(0).getId());
      assertEquals(0, response.getThreads(0).getStackCount());
    } finally {
      release.countDown();
      thread.join(5_000L);
    }
  }

  private static final class RecordingThreadDataSource
      implements ThreadQueryService.ThreadDataSource {
    private final ThreadMXBean bean = ManagementFactory.getThreadMXBean();
    private final long[] ids;
    private final Map<Long, Long> cpuTimes = new HashMap<Long, Long>();
    private final Map<Long, ThreadQueryService.ThreadAttributes> attributes =
        new HashMap<Long, ThreadQueryService.ThreadAttributes>();
    private final List<Call> calls = new ArrayList<Call>();
    private boolean exitBeforeDeepCapture;

    private RecordingThreadDataSource(List<Thread> threads) {
      ids = new long[threads.size()];
      for (int index = 0; index < threads.size(); index++) {
        Thread thread = threads.get(index);
        ids[index] = thread.getId();
        attributes.put(
            thread.getId(),
            new ThreadQueryService.ThreadAttributes(
                thread.isDaemon(), thread.getPriority()));
      }
    }

    private void setCpuTime(long threadId, long cpuTimeNanos) {
      cpuTimes.put(threadId, cpuTimeNanos);
    }

    @Override
    public long[] allThreadIds() {
      return ids.clone();
    }

    @Override
    public ThreadInfo[] threadInfo(long[] requestedIds, int depth) {
      calls.add(new Call(requestedIds.clone(), depth));
      if (exitBeforeDeepCapture && depth > 0) {
        return new ThreadInfo[requestedIds.length];
      }
      return bean.getThreadInfo(requestedIds, depth);
    }

    @Override
    public boolean cpuTimeAvailable() {
      return true;
    }

    @Override
    public long cpuTime(long threadId) {
      Long value = cpuTimes.get(threadId);
      return value == null ? 0L : value.longValue();
    }

    @Override
    public Map<Long, ThreadQueryService.ThreadAttributes> threadAttributes(
        int expectedThreadCount) {
      return attributes;
    }

    @Override
    public Set<Long> deadlockedThreadIds() {
      return Collections.emptySet();
    }
  }

  private static final class Call {
    private final long[] ids;
    private final int depth;

    private Call(long[] ids, int depth) {
      this.ids = ids;
      this.depth = depth;
    }
  }
}
