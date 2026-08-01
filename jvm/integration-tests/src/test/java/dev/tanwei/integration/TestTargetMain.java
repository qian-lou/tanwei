package dev.tanwei.integration;

import java.lang.management.ManagementFactory;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import javax.management.MBeanServer;
import javax.management.ObjectName;

public final class TestTargetMain {
  private static final Logger INTEGRATION_LOGGER =
      Logger.getLogger("dev.tanwei.integration");
  private static final Object LEGACY_LOGGER = initializeLegacyLogger();
  private static final String STATIC_PROBE = "tanwei-static-probe";
  private static final TestTargetMain INSTANCE_REPLAY_TARGET =
      new TestTargetMain();
  private static final ObservationPayload STRUCTURED_PAYLOAD =
      new ObservationPayload();
  private static final ObservationResult STRUCTURED_RESULT =
      new ObservationResult(STRUCTURED_PAYLOAD);
  private static final Object INTEGRATION_MONITOR = new Object();
  private static final CountDownLatch INTEGRATION_MONITOR_HELD =
      new CountDownLatch(1);
  private static final AtomicInteger WORKER_SEQUENCE =
      new AtomicInteger();
  private static final AtomicInteger SCHEDULER_SEQUENCE =
      new AtomicInteger();
  private static final AtomicLong SCHEDULED_TICKS =
      new AtomicLong();
  private static final AtomicLong CPU_PROBE = new AtomicLong();
  private static final ThreadPoolExecutor INTEGRATION_EXECUTOR =
      new ThreadPoolExecutor(
          2,
          4,
          30L,
          TimeUnit.SECONDS,
          new ArrayBlockingQueue<Runnable>(16),
          daemonThreadFactory(
              "integration-worker-pool-", WORKER_SEQUENCE));
  private static final ThreadPoolExecutor LATENCY_EXECUTOR =
      new ThreadPoolExecutor(
          1,
          1,
          0L,
          TimeUnit.MILLISECONDS,
          new ArrayBlockingQueue<Runnable>(32),
          new LatencyThreadFactory());
  private static final ScheduledThreadPoolExecutor
      INTEGRATION_SCHEDULER =
          new ScheduledThreadPoolExecutor(
              1,
              daemonThreadFactory(
                  "integration-scheduler-", SCHEDULER_SEQUENCE));
  private static final ForkJoinPool INTEGRATION_FORK_JOIN_POOL =
      new ForkJoinPool(
          1,
          new IntegrationForkJoinWorkerFactory(),
          null,
          true);
  private int instanceReplaySequence;

  private TestTargetMain() {}

  public static void main(String[] args) throws Exception {
    System.setProperty("tanwei.integration.mutable", "before");
    System.setProperty("tanwei.integration.visible", "desktop-property");
    System.setProperty(
        "tanwei.integration.password", "never-return-property-secret");
    INTEGRATION_LOGGER.setLevel(Level.INFO);
    registerIntegrationMBean();
    initializeHeapProbes();
    startInterruptibleWorker();
    startCpuProbe();
    startLockContention();
    startThreadPools();
    System.out.println("TANWEI_TEST_TARGET_READY");
    System.out.flush();
    while (!Thread.currentThread().isInterrupted()) {
      if (isVisible("dev.tanwei.bootstrap.TanweiBootstrap")) {
        System.out.println(
            "TANWEI_PRIVATE_VISIBLE="
                + isVisible("dev.tanwei.internal.grpc.BindableService"));
        System.out.flush();
        break;
      }
      Thread.sleep(100L);
    }
    long counter = 0L;
    String previousProbe = "";
    String previousChangeSet = "";
    while (!Thread.currentThread().isInterrupted()) {
      heartbeat("tick-" + counter++);
      INSTANCE_REPLAY_TARGET.instanceHeartbeat("instance-" + counter);
      STRUCTURED_PAYLOAD.update(counter);
      structuredHeartbeat(STRUCTURED_PAYLOAD);
      try {
        unstableHeartbeat(counter % 2L == 0L ? null : "stable");
      } catch (RuntimeException ignored) {
        // Intentionally exercise monitor failure accounting.
      }
      String currentProbe = redefineProbe();
      if (!currentProbe.equals(previousProbe)) {
        System.out.println("TANWEI_REDEFINE=" + currentProbe);
        System.out.flush();
        previousProbe = currentProbe;
      }
      String currentChangeSet =
          currentProbe + "/" + ChangeSetSupport.redefineProbe();
      if (!currentChangeSet.equals(previousChangeSet)) {
        System.out.println("TANWEI_CHANGE_SET=" + currentChangeSet);
        System.out.flush();
        previousChangeSet = currentChangeSet;
      }
      Thread.sleep(100L);
    }
  }

  public static String heartbeat(String value) {
    return decorateTick(value);
  }

  public static String unstableHeartbeat(String value) {
    return value.toUpperCase();
  }

  public synchronized String instanceHeartbeat(String value) {
    instanceReplaySequence++;
    return value + ":" + instanceReplaySequence;
  }

  public static ObservationResult structuredHeartbeat(
      ObservationPayload payload) {
    STRUCTURED_RESULT.lastSequence = payload.sequence;
    return STRUCTURED_RESULT;
  }

  private static String decorateTick(String value) {
    return TraceSupport.decorate(value);
  }

  public static String redefineProbe() {
    return "before";
  }

  private static void registerIntegrationMBean() throws Exception {
    MBeanServer server = ManagementFactory.getPlatformMBeanServer();
    ObjectName name =
        new ObjectName("dev.tanwei.integration:type=Control");
    if (!server.isRegistered(name)) {
      server.registerMBean(new IntegrationControl(), name);
    }
    ObjectName openName =
        new ObjectName("dev.tanwei.integration:type=OpenControl");
    if (!server.isRegistered(openName)) {
      server.registerMBean(new IntegrationOpenControl(), openName);
    }
  }

  private static Object initializeLegacyLogger() {
    try {
      Class<?> loggerType = Class.forName("org.apache.log4j.Logger");
      Object logger =
          loggerType
              .getMethod("getLogger", String.class)
              .invoke(null, "legacy.tanwei.logger");
      Class<?> levelType = Class.forName("org.apache.log4j.Level");
      Object info = levelType.getField("INFO").get(null);
      loggerType.getMethod("setLevel", levelType).invoke(logger, info);
      return logger;
    } catch (ReflectiveOperationException exception) {
      throw new IllegalStateException(
          "Unable to initialize the Log4j 1.x integration logger",
          exception);
    }
  }

  private static boolean isVisible(String className) {
    try {
      ClassLoader.getSystemClassLoader().loadClass(className);
      return true;
    } catch (ClassNotFoundException ignored) {
      return false;
    }
  }

  private static void initializeHeapProbes() {
    try {
      Class.forName("dev.tanwei.integration.HeapProbe");
      Class.forName("dev.tanwei.integration.HeapChain");
    } catch (ClassNotFoundException exception) {
      throw new IllegalStateException(exception);
    }
  }

  private static void startInterruptibleWorker() {
    Thread worker =
        new Thread(
            () -> {
              try {
                while (!Thread.currentThread().isInterrupted()) {
                  Thread.sleep(1_000L);
                }
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              } finally {
                System.out.println("TANWEI_INTERRUPTIBLE_WORKER_STOPPED");
                System.out.flush();
              }
            },
            "integration-interruptible-worker");
    worker.setDaemon(true);
    worker.start();
  }

  private static void startCpuProbe() {
    Thread worker =
        new Thread(
            () -> {
              long value = 1L;
              try {
                while (!Thread.currentThread().isInterrupted()) {
                  long deadline = System.nanoTime() + 5_000_000L;
                  while (System.nanoTime() < deadline) {
                    value = value * 31L + 17L;
                  }
                  CPU_PROBE.lazySet(value);
                  Thread.sleep(45L);
                }
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              }
            },
            "integration-cpu-probe");
    worker.setDaemon(true);
    worker.start();
  }

  private static void startLockContention() {
    Thread holder =
        new Thread(
            () -> {
              synchronized (INTEGRATION_MONITOR) {
                INTEGRATION_MONITOR_HELD.countDown();
                try {
                  while (!Thread.currentThread().isInterrupted()) {
                    Thread.sleep(1_000L);
                  }
                } catch (InterruptedException interrupted) {
                  Thread.currentThread().interrupt();
                }
              }
            },
            "integration-lock-holder");
    holder.setDaemon(true);
    holder.start();

    Thread waiter =
        new Thread(
            () -> {
              try {
                INTEGRATION_MONITOR_HELD.await();
                synchronized (INTEGRATION_MONITOR) {
                  // The E2E target intentionally keeps this monitor contended.
                }
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              }
            },
            "integration-lock-waiter");
    waiter.setDaemon(true);
    waiter.start();
  }

  private static void startThreadPools() {
    INTEGRATION_EXECUTOR.prestartAllCoreThreads();
    INTEGRATION_EXECUTOR.execute(new SlowDatabaseWorker());
    INTEGRATION_EXECUTOR.execute(new SlowHttpWorker());
    INTEGRATION_EXECUTOR.execute(new DatabaseBacklogTask());
    INTEGRATION_EXECUTOR.execute(new DatabaseBacklogTask());
    INTEGRATION_EXECUTOR.execute(new HttpBacklogTask());
    INTEGRATION_SCHEDULER.prestartAllCoreThreads();
    INTEGRATION_SCHEDULER.scheduleAtFixedRate(
        new MeasuredScheduledTask(SCHEDULED_TICKS),
        0L,
        100L,
        TimeUnit.MILLISECONDS);
    Thread forkJoinProducer =
        new Thread(
            () -> {
              try {
                while (!Thread.currentThread().isInterrupted()) {
                  INTEGRATION_FORK_JOIN_POOL.execute(
                      new MeasuredForkJoinTask());
                  Thread.sleep(100L);
                }
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              }
            },
            "integration-forkjoin-producer");
    forkJoinProducer.setDaemon(true);
    forkJoinProducer.start();
    LATENCY_EXECUTOR.prestartAllCoreThreads();
    Thread producer =
        new Thread(
            () -> {
              try {
                while (!Thread.currentThread().isInterrupted()) {
                  LATENCY_EXECUTOR.execute(new MeasuredLatencyTask());
                  LATENCY_EXECUTOR.execute(new MeasuredLatencyTask());
                  LATENCY_EXECUTOR.execute(new MeasuredLatencyTask());
                  Thread.sleep(250L);
                }
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              }
            },
            "integration-latency-producer");
    producer.setDaemon(true);
    producer.start();
  }


  private static ThreadFactory daemonThreadFactory(
      String prefix, AtomicInteger sequence) {
    return task -> {
      Thread thread =
          new Thread(task, prefix + sequence.incrementAndGet());
      thread.setDaemon(true);
      return thread;
    };
  }

}

final class TraceSupport {
  private TraceSupport() {}

  static String decorate(String value) {
    return normalize(value);
  }

  private static String normalize(String value) {
    return value.toUpperCase();
  }

}

final class ChangeSetSupport {
  private ChangeSetSupport() {}

  static String redefineProbe() {
    return "support-before";
  }
}

final class HeapProbe {
  private static final int MAXIMUM_GROWTH_PROBES = 10_000;
  private static final HeapProbe[] RETAINED = {
    new HeapProbe("alpha", 11),
    new HeapProbe("beta", 22),
    new HeapProbe("gamma", 33)
  };
  private static final HeapProbe[] DIRECT_ALIASES = {
    RETAINED[0], RETAINED[1], RETAINED[2]
  };
  private static final HeapProbe[] GROWTH =
      new HeapProbe[MAXIMUM_GROWTH_PROBES];
  private static int growthCount;
  private final String label;
  private final int value;
  private final HeapLeaf leaf;

  HeapProbe(String label, int value) {
    this.label = label;
    this.value = value;
    this.leaf = new HeapLeaf(label + "-leaf");
  }

  static synchronized int retainGrowth(int requestedCount) {
    if (requestedCount < 1 || requestedCount > 100) {
      throw new IllegalArgumentException(
          "Growth count must be between 1 and 100");
    }
    int available = GROWTH.length - growthCount;
    int retained = Math.min(requestedCount, available);
    for (int offset = 0; offset < retained; offset++) {
      int index = growthCount + offset;
      GROWTH[index] = new HeapProbe("growth-" + index, index);
    }
    growthCount += retained;
    return retained;
  }
}

final class HeapLeaf {
  private final String label;

  HeapLeaf(String label) {
    this.label = label;
  }
}

final class HeapChain {
  private static final HeapChain ROOT =
      new HeapChain(new HeapChain(null));
  private final HeapChain child;

  HeapChain(HeapChain child) {
    this.child = child;
  }
}
