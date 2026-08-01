package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.management.ManagementFactory;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

final class ThreadLockExplorerTest {
  @Test
  void reportsAContendedMonitorAndItsOwner() throws Exception {
    Object lock = new Object();
    CountDownLatch held = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    Thread holder =
        new Thread(
            () -> {
              synchronized (lock) {
                held.countDown();
                try {
                  release.await();
                } catch (InterruptedException interrupted) {
                  Thread.currentThread().interrupt();
                }
              }
            },
            "tanwei-lock-test-holder");
    Thread waiter =
        new Thread(
            () -> {
              try {
                held.await();
                synchronized (lock) {
                  // The assertion runs while this thread is blocked.
                }
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              }
            },
            "tanwei-lock-test-waiter");
    holder.setDaemon(true);
    waiter.setDaemon(true);
    holder.start();
    waiter.start();
    try {
      assertTrue(held.await(5L, TimeUnit.SECONDS));
      assertTrue(awaitState(waiter, Thread.State.BLOCKED));
      ThreadLockExplorer explorer =
          new ThreadLockExplorer(ManagementFactory.getThreadMXBean());
      Map<String, String> values = explorer.inspect(false, 100);
      assertTrue(values.containsValue("tanwei-lock-test-holder"));
      assertTrue(values.containsValue("tanwei-lock-test-waiter"));
      assertTrue(Integer.parseInt(values.get("edges")) >= 1);
      assertTrue(Integer.parseInt(values.get("waiting")) >= 1);
    } finally {
      release.countDown();
      holder.join(5_000L);
      waiter.join(5_000L);
    }
  }

  private static boolean awaitState(
      Thread thread, Thread.State expected) throws InterruptedException {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5L);
    while (System.nanoTime() < deadline) {
      if (thread.getState() == expected) {
        return true;
      }
      Thread.sleep(10L);
    }
    return false;
  }
}
