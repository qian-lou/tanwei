package dev.tanwei.integration;

import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.ForkJoinWorkerThread;
import java.util.concurrent.RecursiveAction;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

final class ThreadPoolEvidenceTasks {
  private ThreadPoolEvidenceTasks() {}

  static void holdWorkerForDownstreamDependency() {
    try {
      while (!Thread.currentThread().isInterrupted()) {
        Thread.sleep(250L);
      }
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }
}

final class SlowDatabaseWorker implements Runnable {
  @Override
  public void run() {
    ThreadPoolEvidenceTasks.holdWorkerForDownstreamDependency();
  }
}

final class SlowHttpWorker implements Runnable {
  @Override
  public void run() {
    ThreadPoolEvidenceTasks.holdWorkerForDownstreamDependency();
  }
}

final class DatabaseBacklogTask implements Runnable {
  @Override
  public void run() {
    // This task intentionally remains queued for diagnostics.
  }
}

final class HttpBacklogTask implements Runnable {
  @Override
  public void run() {
    // This task intentionally remains queued for diagnostics.
  }
}

final class LatencyThreadFactory implements ThreadFactory {
  private final AtomicInteger sequence = new AtomicInteger();

  @Override
  public Thread newThread(Runnable task) {
    Thread thread =
        new Thread(task, "latency-worker-pool-" + sequence.incrementAndGet());
    thread.setDaemon(true);
    return thread;
  }
}

final class MeasuredLatencyTask implements Runnable {
  @Override
  public void run() {
    try {
      Thread.sleep(60L);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }
}

final class MeasuredScheduledTask implements Runnable {
  private final AtomicLong ticks;

  MeasuredScheduledTask(AtomicLong ticks) {
    this.ticks = ticks;
  }

  @Override
  public void run() {
    ticks.incrementAndGet();
    try {
      Thread.sleep(25L);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }
}

final class IntegrationForkJoinWorkerFactory
    implements ForkJoinPool.ForkJoinWorkerThreadFactory {
  private final AtomicInteger sequence = new AtomicInteger();

  @Override
  public ForkJoinWorkerThread newThread(ForkJoinPool pool) {
    return new IntegrationForkJoinWorker(
        pool, sequence.incrementAndGet());
  }
}

final class IntegrationForkJoinWorker extends ForkJoinWorkerThread {
  IntegrationForkJoinWorker(ForkJoinPool pool, int sequence) {
    super(pool);
    setName("integration-forkjoin-pool-" + sequence);
    setDaemon(true);
  }
}

final class MeasuredForkJoinTask extends RecursiveAction {
  @Override
  protected void compute() {
    try {
      Thread.sleep(35L);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }
}
