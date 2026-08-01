package dev.tanwei.agent;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import one.profiler.AsyncProfiler;

/**
 * Lazy async-profiler 4.5 adapter. Merely negotiating capabilities does not
 * extract or load a native library; the first explicit profile task does.
 */
final class NativeProfilerController implements AutoCloseable {
  static final String ENGINE = "ASYNC_PROFILER_4_5";

  private final ScheduledExecutorService scheduler;
  private final AgentArtifactRegistry artifacts;
  private final boolean enabled;
  private final Map<String, NativeTask> tasks =
      new ConcurrentHashMap<String, NativeTask>();
  private volatile AsyncProfiler profiler;
  private volatile NativeTask active;
  private volatile boolean unavailable;

  NativeProfilerController(
      ScheduledExecutorService scheduler,
      AgentArtifactRegistry artifacts) {
    this(scheduler, artifacts, true);
  }

  NativeProfilerController(
      ScheduledExecutorService scheduler,
      AgentArtifactRegistry artifacts,
      boolean enabled) {
    this.scheduler = scheduler;
    this.artifacts = artifacts;
    this.enabled = enabled;
  }

  boolean isPotentiallyAvailable() {
    if (!enabled || unavailable) {
      return false;
    }
    String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    String architecture =
        System.getProperty("os.arch", "").toLowerCase(Locale.ROOT);
    boolean supportedOs = os.contains("linux") || os.contains("mac");
    boolean supportedArchitecture =
        "amd64".equals(architecture)
            || "x86_64".equals(architecture)
            || "aarch64".equals(architecture)
            || "arm64".equals(architecture);
    return supportedOs && supportedArchitecture;
  }

  synchronized SamplingProfilerController.StartResult tryStart(
      String taskId,
      String event,
      long intervalMillis,
      long durationMillis,
      int stackDepth,
      boolean threads,
      List<String> includes,
      List<String> excludes) {
    purgeFinishedTasks();
    if (!isPotentiallyAvailable()) {
      return null;
    }
    if (active != null && !active.finished.get()) {
      throw new IllegalStateException(
          "An async-profiler task is already active");
    }
    AsyncProfiler instance;
    try {
      instance = profiler == null ? AsyncProfiler.getInstance() : profiler;
      String command = startCommand(event, intervalMillis, stackDepth, threads);
      instance.execute(command);
      profiler = instance;
    } catch (Throwable failure) {
      unavailable = true;
      return null;
    }

    long startedAtEpochMillis = System.currentTimeMillis();
    NativeTask task =
        new NativeTask(
            taskId,
            event,
            startedAtEpochMillis,
            startedAtEpochMillis + durationMillis,
            includes,
            excludes);
    tasks.put(taskId, task);
    active = task;
    task.finishFuture =
        scheduler.schedule(
            () -> finish(task, "SUCCEEDED"),
            durationMillis,
            TimeUnit.MILLISECONDS);
    return new SamplingProfilerController.StartResult(
        taskId, event, ENGINE);
  }

  SamplingProfilerController.Result status(String taskId) {
    NativeTask task = tasks.get(taskId);
    return task == null
        ? SamplingProfilerController.Result.unknown(taskId)
        : task.result();
  }

  SamplingProfilerController.Result stop(String taskId) {
    NativeTask task = tasks.get(taskId);
    if (task == null) {
      return SamplingProfilerController.Result.unknown(taskId);
    }
    finish(task, "CANCELLED");
    return task.result();
  }

  synchronized SamplingProfilerController.Result dump(String taskId) {
    NativeTask task = tasks.get(taskId);
    if (task == null) {
      return SamplingProfilerController.Result.unknown(taskId);
    }
    if (task.finished.get() || active != task) {
      throw new IllegalStateException("Profiler task is no longer running");
    }
    Path output = artifacts.allocatePath(".html");
    try {
      AsyncProfiler instance = profiler;
      if (instance == null) {
        throw new IllegalStateException("async-profiler was not initialized");
      }
      task.samples = Math.max(0L, instance.getSamples());
      instance.execute(reportCommand("dump", output, task.includes, task.excludes));
      if (!Files.isRegularFile(output) || Files.size(output) <= 0L) {
        throw new IllegalStateException(
            "async-profiler did not create a live HTML report");
      }
      SamplingProfilerController.ArtifactInfo artifact =
          new SamplingProfilerController.ArtifactInfo(
              artifacts.register(output), Files.size(output));
      return task.result(artifact);
    } catch (Throwable failure) {
      try {
        Files.deleteIfExists(output);
      } catch (Exception ignored) {
        // Agent artifact shutdown performs a second cleanup pass.
      }
      throw new IllegalStateException(
          "Unable to create a live async-profiler report", failure);
    }
  }

  List<SamplingProfilerController.TaskSnapshot> activeTasks() {
    List<SamplingProfilerController.TaskSnapshot> snapshots =
        new ArrayList<SamplingProfilerController.TaskSnapshot>();
    for (NativeTask task : tasks.values()) {
      if (!task.finished.get()) {
        snapshots.add(
            new SamplingProfilerController.TaskSnapshot(
                task.taskId,
                task.event,
                ENGINE,
                task.state,
                task.startedAtEpochMillis,
                task.deadlineEpochMillis,
                currentSamples(task),
                0L));
      }
    }
    return snapshots;
  }

  private long currentSamples(NativeTask task) {
    if (task.finished.get()) {
      return task.samples;
    }
    try {
      return Math.max(0L, AsyncProfiler.getInstance().getSamples());
    } catch (Throwable ignored) {
      return 0L;
    }
  }

  private synchronized void finish(
      NativeTask task,
      String requestedState) {
    if (!task.finished.compareAndSet(false, true)) {
      return;
    }
    if (task.finishFuture != null) {
      task.finishFuture.cancel(false);
    }
    Path output = artifacts.allocatePath(".html");
    try {
      AsyncProfiler instance = profiler;
      if (instance == null) {
        throw new IllegalStateException("async-profiler was not initialized");
      }
      task.samples = Math.max(0L, instance.getSamples());
      instance.execute(reportCommand("stop", output, task.includes, task.excludes));
      if (!Files.isRegularFile(output) || Files.size(output) <= 0L) {
        throw new IllegalStateException(
            "async-profiler did not create an HTML report");
      }
      String token = artifacts.register(output);
      task.artifact =
          new SamplingProfilerController.ArtifactInfo(
              token, Files.size(output));
      task.state = requestedState;
    } catch (Throwable failure) {
      try {
        AsyncProfiler instance = profiler;
        if (instance != null) {
          instance.stop();
        }
      } catch (Throwable ignored) {
        // The primary profiler failure remains authoritative.
      }
      try {
        Files.deleteIfExists(output);
      } catch (Exception ignored) {
        // Agent artifact shutdown performs a second cleanup pass.
      }
      task.state = "FAILED";
      task.error =
          failure.getMessage() == null
              ? failure.getClass().getSimpleName()
              : failure.getMessage();
    } finally {
      if (active == task) {
        active = null;
      }
    }
  }

  private void purgeFinishedTasks() {
    for (Map.Entry<String, NativeTask> entry : tasks.entrySet()) {
      if (entry.getValue().finished.get()) {
        tasks.remove(entry.getKey(), entry.getValue());
      }
    }
  }

  private static String startCommand(
      String event,
      long intervalMillis,
      int stackDepth,
      boolean threads) {
    String suffix = ",jstackdepth=" + stackDepth + (threads ? ",threads" : "");
    if ("CPU".equals(event)) {
      return "start,event=cpu,interval=" + intervalMillis + "ms" + suffix;
    }
    if ("WALL".equals(event)) {
      return "start,event=wall,interval=" + intervalMillis + "ms" + suffix;
    }
    if ("ALLOCATION".equals(event)) {
      return "start,event=alloc" + suffix;
    }
    if ("LOCK".equals(event)) {
      return "start,event=lock" + suffix;
    }
    throw new IllegalArgumentException("Unsupported profiler event");
  }

  private static String reportCommand(
      String action,
      Path output,
      List<String> includes,
      List<String> excludes) {
    StringBuilder command = new StringBuilder(action).append(",file=")
        .append(safeOutputPath(output));
    for (String include : includes) {
      command.append(",include=").append(include);
    }
    for (String exclude : excludes) {
      command.append(",exclude=").append(exclude);
    }
    return command.toString();
  }

  private static String safeOutputPath(Path output) {
    String value = output.toAbsolutePath().normalize().toString();
    if (value.indexOf(',') >= 0
        || value.indexOf('\n') >= 0
        || value.indexOf('\r') >= 0) {
      throw new IllegalStateException(
          "Profiler output path contains unsupported characters");
    }
    return value;
  }

  @Override
  public synchronized void close() {
    NativeTask running = active;
    if (running != null) {
      finish(running, "CANCELLED");
    }
    tasks.clear();
    active = null;
  }

  private static final class NativeTask {
    private final String taskId;
    private final String event;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final List<String> includes;
    private final List<String> excludes;
    private final AtomicBoolean finished = new AtomicBoolean();
    private volatile String state = "RUNNING";
    private volatile String error = "";
    private volatile long samples;
    private volatile SamplingProfilerController.ArtifactInfo artifact;
    private volatile ScheduledFuture<?> finishFuture;

    private NativeTask(
        String taskId,
        String event,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        List<String> includes,
        List<String> excludes) {
      this.taskId = taskId;
      this.event = event;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.includes = includes;
      this.excludes = excludes;
    }

    private SamplingProfilerController.Result result() {
      return result(artifact);
    }

    private SamplingProfilerController.Result result(
        SamplingProfilerController.ArtifactInfo resultArtifact) {
      long currentSamples = samples;
      if (!finished.get()) {
        try {
          currentSamples = Math.max(0L, AsyncProfiler.getInstance().getSamples());
        } catch (Throwable ignored) {
          // Status remains usable if a native counter is temporarily unavailable.
        }
      }
      return new SamplingProfilerController.Result(
          taskId,
          state,
          event,
          currentSamples,
          0L,
          resultArtifact,
          error,
          ENGINE);
    }
  }
}
