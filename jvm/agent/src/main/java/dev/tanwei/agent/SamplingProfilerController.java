package dev.tanwei.agent;

import java.lang.management.ManagementFactory;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

final class SamplingProfilerController implements AutoCloseable {
  private static final int MAXIMUM_TASKS = 4;
  static final int DEFAULT_STACK_DEPTH = 256;
  static final int MINIMUM_STACK_DEPTH = 16;
  static final int MAXIMUM_STACK_DEPTH = 2_048;
  private static final int MAXIMUM_FILTERS = 8;
  private static final int MAXIMUM_FILTER_LENGTH = 128;
  private static final int MAXIMUM_UNIQUE_STACKS = 20_000;

  private final ScheduledExecutorService scheduler;
  private final AgentArtifactRegistry artifacts;
  private final ThreadMXBean threadBean = ManagementFactory.getThreadMXBean();
  private final Map<String, ProfileTask> tasks =
      new ConcurrentHashMap<String, ProfileTask>();
  private final Object allocatedThreadBean;
  private final Method allocatedBytesMethod;
  private final NativeProfilerController nativeProfiler;

  SamplingProfilerController(
      ScheduledExecutorService scheduler,
      AgentArtifactRegistry artifacts) {
    this(scheduler, artifacts, true);
  }

  SamplingProfilerController(
      ScheduledExecutorService scheduler,
      AgentArtifactRegistry artifacts,
      boolean nativeProfilerEnabled) {
    this.scheduler = scheduler;
    this.artifacts = artifacts;
    Object allocatedBean = null;
    Method allocatedMethod = null;
    try {
      Class<?> type = Class.forName("com.sun.management.ThreadMXBean");
      if (type.isInstance(threadBean)) {
        allocatedBean = threadBean;
        allocatedMethod = type.getMethod("getThreadAllocatedBytes", long[].class);
      }
    } catch (Exception ignored) {
      // Allocation sampling remains unavailable on this JVM.
    }
    allocatedThreadBean = allocatedBean;
    allocatedBytesMethod = allocatedMethod;
    nativeProfiler =
        new NativeProfilerController(
            scheduler, artifacts, nativeProfilerEnabled);
  }

  boolean supportsAllocation() {
    return allocatedThreadBean != null && allocatedBytesMethod != null;
  }

  boolean supportsNative() {
    return nativeProfiler.isPotentiallyAvailable();
  }

  StartResult start(
      String event,
      long intervalMillis,
      long durationMillis) {
    return start(
        event,
        intervalMillis,
        durationMillis,
        DEFAULT_STACK_DEPTH,
        false,
        "",
        "");
  }

  StartResult start(
      String event,
      long intervalMillis,
      long durationMillis,
      int stackDepth,
      boolean threads,
      String includeRules,
      String excludeRules) {
    purgeFinishedTasks();
    if (tasks.size() >= MAXIMUM_TASKS) {
      throw new IllegalStateException("Too many profiler tasks are active");
    }
    if (stackDepth < MINIMUM_STACK_DEPTH || stackDepth > MAXIMUM_STACK_DEPTH) {
      throw new IllegalArgumentException("stackDepth is outside the supported range");
    }
    List<String> includes = parsePatterns(includeRules, "includeRules");
    List<String> excludes = parsePatterns(excludeRules, "excludeRules");
    String normalizedEvent = event.toUpperCase(Locale.ROOT);
    if (!"CPU".equals(normalizedEvent)
        && !"WALL".equals(normalizedEvent)
        && !"ALLOCATION".equals(normalizedEvent)
        && !"LOCK".equals(normalizedEvent)) {
      throw new IllegalArgumentException("Unsupported profiler event");
    }
    if ("ALLOCATION".equals(normalizedEvent) && !supportsAllocation()) {
      if (!nativeProfiler.isPotentiallyAvailable()) {
        throw new UnsupportedOperationException(
            "Thread allocation counters are unavailable on this JVM");
      }
    }

    String taskId = UUID.randomUUID().toString();
    StartResult nativeStarted =
        nativeProfiler.tryStart(
            taskId,
            normalizedEvent,
            intervalMillis,
            durationMillis,
            stackDepth,
            threads,
            includes,
            excludes);
    if (nativeStarted != null) {
      return nativeStarted;
    }
    if ("ALLOCATION".equals(normalizedEvent) && !supportsAllocation()) {
      throw new UnsupportedOperationException(
          "Allocation profiling is unavailable on this JVM");
    }
    long startedAtEpochMillis = System.currentTimeMillis();
    ProfileTask task =
        new ProfileTask(
            taskId,
            normalizedEvent,
            startedAtEpochMillis,
            startedAtEpochMillis + durationMillis,
            stackDepth,
            threads,
            includes,
            excludes);
    if (tasks.putIfAbsent(taskId, task) != null) {
      throw new IllegalStateException("Profiler task identity collision");
    }
    task.sampleFuture =
        scheduler.scheduleAtFixedRate(
            () -> sample(task),
            0L,
            intervalMillis,
            TimeUnit.MILLISECONDS);
    task.finishFuture =
        scheduler.schedule(
            () -> finish(task, "SUCCEEDED"),
            durationMillis,
            TimeUnit.MILLISECONDS);
    return new StartResult(taskId, normalizedEvent, "JDK_BOUNDED_SAMPLER");
  }

  Result status(String taskId) {
    Result nativeResult = nativeProfiler.status(taskId);
    if (!"UNKNOWN".equals(nativeResult.getState())) {
      return nativeResult;
    }
    ProfileTask task = tasks.get(taskId);
    if (task == null) {
      return Result.unknown(taskId);
    }
    return task.result();
  }

  Result stop(String taskId) {
    Result nativeResult = nativeProfiler.stop(taskId);
    if (!"UNKNOWN".equals(nativeResult.getState())) {
      return nativeResult;
    }
    ProfileTask task = tasks.get(taskId);
    if (task == null) {
      return Result.unknown(taskId);
    }
    finish(task, "CANCELLED");
    return task.result();
  }

  Result dump(String taskId) {
    Result nativeResult = nativeProfiler.dump(taskId);
    if (!"UNKNOWN".equals(nativeResult.getState())) {
      return nativeResult;
    }
    ProfileTask task = tasks.get(taskId);
    if (task == null) {
      return Result.unknown(taskId);
    }
    synchronized (task.reportLock) {
      if (task.finished.get()) {
        throw new IllegalStateException("Profiler task is no longer running");
      }
      try {
        return task.result(createReport(task));
      } catch (Exception exception) {
        throw new IllegalStateException(
            "Unable to create a live profiler report", exception);
      }
    }
  }

  List<TaskSnapshot> activeTasks() {
    List<TaskSnapshot> snapshots =
        new ArrayList<TaskSnapshot>(nativeProfiler.activeTasks());
    for (ProfileTask task : tasks.values()) {
      if (!task.finished.get()) {
        snapshots.add(
            new TaskSnapshot(
                task.taskId,
                task.event,
                "JDK_BOUNDED_SAMPLER",
                task.state,
                task.startedAtEpochMillis,
                task.deadlineEpochMillis,
                task.samples.get(),
                task.dropped.get()));
      }
    }
    return snapshots;
  }

  private void sample(ProfileTask task) {
    if (task.finished.get()) {
      return;
    }
    try {
      long[] ids = threadBean.getAllThreadIds();
      ThreadInfo[] infos = threadBean.getThreadInfo(ids, task.stackDepth);
      long[] allocationBytes =
          "ALLOCATION".equals(task.event)
              ? allocatedBytes(ids)
              : null;
      for (int index = 0; index < infos.length; index++) {
        ThreadInfo info = infos[index];
        if (info == null || info.getStackTrace().length == 0) {
          continue;
        }
        long weight = sampleWeight(task, ids[index], info, allocationBytes, index);
        if (weight <= 0L) {
          continue;
        }
        String stack = collapsedStack(info);
        if (!matchesStackFilters(stack, task.includes, task.excludes)) {
          continue;
        }
        if (task.threads) {
          stack = threadFrame(info) + ';' + stack;
        }
        if (!task.stacks.containsKey(stack)
            && task.stacks.size() >= MAXIMUM_UNIQUE_STACKS) {
          task.dropped.incrementAndGet();
          continue;
        }
        task.stacks.merge(stack, Long.valueOf(weight), Long::sum);
        task.samples.incrementAndGet();
      }
    } catch (Throwable ignored) {
      task.dropped.incrementAndGet();
    }
  }

  private long sampleWeight(
      ProfileTask task,
      long threadId,
      ThreadInfo info,
      long[] allocationBytes,
      int index) {
    if ("CPU".equals(task.event)) {
      return info.getThreadState() == Thread.State.RUNNABLE ? 1L : 0L;
    }
    if ("LOCK".equals(task.event)) {
      Thread.State state = info.getThreadState();
      return state == Thread.State.BLOCKED
              || state == Thread.State.WAITING
              || state == Thread.State.TIMED_WAITING
          ? 1L
          : 0L;
    }
    if ("ALLOCATION".equals(task.event)) {
      if (allocationBytes == null || index >= allocationBytes.length) {
        return 0L;
      }
      long current = allocationBytes[index];
      Long previous = task.allocatedBytes.put(threadId, Long.valueOf(current));
      return previous == null || current < previous.longValue()
          ? 0L
          : current - previous.longValue();
    }
    return 1L;
  }

  private long[] allocatedBytes(long[] threadIds) throws Exception {
    Object value =
        allocatedBytesMethod.invoke(
            allocatedThreadBean,
            new Object[] {threadIds});
    return (long[]) value;
  }

  private static String collapsedStack(ThreadInfo info) {
    StringBuilder result = new StringBuilder();
    StackTraceElement[] frames = info.getStackTrace();
    for (int index = frames.length - 1; index >= 0; index--) {
      if (result.length() > 0) {
        result.append(';');
      }
      StackTraceElement frame = frames[index];
      result
          .append(frame.getClassName())
          .append('.')
          .append(frame.getMethodName());
    }
    return result.toString();
  }

  private static String threadFrame(ThreadInfo info) {
    String name = info.getThreadName();
    if (name == null || name.isEmpty()) {
      name = "unnamed";
    }
    name = name.replace(';', '_').replace('\n', '_').replace('\r', '_');
    if (name.length() > 128) {
      name = name.substring(0, 128);
    }
    return "[thread=" + name + '#' + info.getThreadId() + ']';
  }

  static List<String> parsePatterns(String rawRules, String name) {
    if (rawRules == null || rawRules.trim().isEmpty()) {
      return Collections.emptyList();
    }
    String[] lines = rawRules.split("\\r?\\n", -1);
    Set<String> unique = new LinkedHashSet<String>();
    for (String line : lines) {
      String pattern = line.trim();
      if (pattern.isEmpty()) {
        continue;
      }
      if (pattern.length() > MAXIMUM_FILTER_LENGTH
          || pattern.indexOf(',') >= 0
          || containsControlCharacter(pattern)) {
        throw new IllegalArgumentException(name + " contains an invalid pattern");
      }
      int firstWildcard = pattern.indexOf('*');
      if (firstWildcard > 0 && firstWildcard < pattern.length() - 1) {
        throw new IllegalArgumentException(
            name + " only supports a wildcard at the start or end");
      }
      int secondWildcard =
          firstWildcard < 0 ? -1 : pattern.indexOf('*', firstWildcard + 1);
      if (secondWildcard >= 0 && secondWildcard != pattern.length() - 1) {
        throw new IllegalArgumentException(
            name + " only supports a wildcard at the start or end");
      }
      if ("*".equals(pattern)) {
        throw new IllegalArgumentException(name + " cannot contain a catch-all pattern");
      }
      unique.add(pattern);
      if (unique.size() > MAXIMUM_FILTERS) {
        throw new IllegalArgumentException(name + " contains too many patterns");
      }
    }
    return Collections.unmodifiableList(new ArrayList<String>(unique));
  }

  private static boolean containsControlCharacter(String value) {
    for (int index = 0; index < value.length(); index++) {
      if (Character.isISOControl(value.charAt(index))) {
        return true;
      }
    }
    return false;
  }

  static boolean matchesStackFilters(
      String stack, List<String> includes, List<String> excludes) {
    String slashStack = stack.replace('.', '/');
    boolean included = includes.isEmpty();
    for (String pattern : includes) {
      if (globMatches(stack, pattern) || globMatches(slashStack, pattern)) {
        included = true;
        break;
      }
    }
    if (!included) {
      return false;
    }
    for (String pattern : excludes) {
      if (globMatches(stack, pattern) || globMatches(slashStack, pattern)) {
        return false;
      }
    }
    return true;
  }

  private static boolean globMatches(String value, String pattern) {
    boolean prefixWildcard = pattern.charAt(0) == '*';
    boolean suffixWildcard = pattern.charAt(pattern.length() - 1) == '*';
    int from = prefixWildcard ? 1 : 0;
    int to = suffixWildcard ? pattern.length() - 1 : pattern.length();
    String needle = pattern.substring(from, to);
    if (prefixWildcard && suffixWildcard) {
      return value.contains(needle);
    }
    if (prefixWildcard) {
      return value.endsWith(needle);
    }
    if (suffixWildcard) {
      return value.startsWith(needle) || value.contains(';' + needle);
    }
    return value.equals(needle) || value.contains(';' + needle + ';')
        || value.endsWith(';' + needle);
  }

  private void finish(ProfileTask task, String requestedState) {
    if (!task.finished.compareAndSet(false, true)) {
      return;
    }
    task.sampleFuture.cancel(false);
    if (task.finishFuture != null) {
      task.finishFuture.cancel(false);
    }
    try {
      synchronized (task.reportLock) {
        task.artifact = createReport(task);
      }
      task.state = requestedState;
    } catch (Exception exception) {
      task.state = "FAILED";
      task.error = exception.getMessage() == null
          ? "Unable to create profiler report"
          : exception.getMessage();
    }
  }

  private ArtifactInfo createReport(ProfileTask task) throws Exception {
    List<Map.Entry<String, Long>> entries =
        new ArrayList<Map.Entry<String, Long>>(task.stacks.entrySet());
    entries.sort(
        Map.Entry.<String, Long>comparingByValue()
            .reversed()
            .thenComparing(Map.Entry::getKey));
    long totalWeight = 0L;
    for (Map.Entry<String, Long> entry : entries) {
      totalWeight += entry.getValue().longValue();
    }

    StringBuilder rows = new StringBuilder();
    int limit = Math.min(entries.size(), 2_000);
    for (int index = 0; index < limit; index++) {
      Map.Entry<String, Long> entry = entries.get(index);
      double percent =
          totalWeight == 0L
              ? 0.0d
              : entry.getValue().doubleValue() * 100.0d / totalWeight;
      rows
          .append("<tr><td>")
          .append(index + 1)
          .append("</td><td><code>")
          .append(escapeHtml(entry.getKey()))
          .append("</code></td><td>")
          .append(entry.getValue())
          .append("</td><td>")
          .append(String.format(java.util.Locale.ROOT, "%.2f%%", percent))
          .append("</td></tr>");
    }
    String html =
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">"
            + "<meta name=\"viewport\" content=\"width=device-width\">"
            + "<title>探微 "
            + escapeHtml(task.event)
            + " Profile</title><style>"
            + "body{margin:0;padding:32px;background:#faf9f5;color:#141413;"
            + "font-family:Arial,sans-serif}main{max-width:1200px;margin:auto}"
            + "h1,code{font-family:monospace}table{width:100%;border-collapse:collapse}"
            + "th,td{padding:12px;border:1px solid #141413;text-align:left}"
            + "thead{background:#141413;color:#faf9f5}code{overflow-wrap:anywhere}"
            + "</style><main><p>TANWEI / BOUNDED SAMPLER</p><h1>"
            + escapeHtml(task.event)
            + " Profile</h1><p>Task "
            + escapeHtml(task.taskId)
            + " · samples "
            + task.samples.get()
            + " · dropped "
            + task.dropped.get()
            + " · stack depth "
            + task.stackDepth
            + " · threads "
            + task.threads
            + " · include "
            + escapeHtml(task.includes.toString())
            + " · exclude "
            + escapeHtml(task.excludes.toString())
            + "</p><table><thead><tr><th>#</th><th>Collapsed stack</th>"
            + "<th>Weight</th><th>Share</th></tr></thead><tbody>"
            + rows
            + "</tbody></table></main></html>";
    Path output = artifacts.allocatePath(".html");
    Files.write(output, html.getBytes(StandardCharsets.UTF_8));
    String token = artifacts.register(output);
    return new ArtifactInfo(token, Files.size(output));
  }

  private void purgeFinishedTasks() {
    for (Map.Entry<String, ProfileTask> entry : tasks.entrySet()) {
      if (entry.getValue().finished.get()) {
        tasks.remove(entry.getKey(), entry.getValue());
      }
    }
  }

  private static String escapeHtml(String value) {
    return value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;");
  }

  @Override
  public void close() {
    nativeProfiler.close();
    for (ProfileTask task : tasks.values()) {
      finish(task, "CANCELLED");
    }
    tasks.clear();
  }

  static final class StartResult {
    private final String taskId;
    private final String event;
    private final String engine;

    StartResult(String taskId, String event, String engine) {
      this.taskId = taskId;
      this.event = event;
      this.engine = engine;
    }

    String getTaskId() {
      return taskId;
    }

    String getEvent() {
      return event;
    }

    String getEngine() {
      return engine;
    }
  }

  static final class TaskSnapshot {
    private final String taskId;
    private final String event;
    private final String engine;
    private final String state;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final long samples;
    private final long dropped;

    TaskSnapshot(
        String taskId,
        String event,
        String engine,
        String state,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        long samples,
        long dropped) {
      this.taskId = taskId;
      this.event = event;
      this.engine = engine;
      this.state = state;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.samples = samples;
      this.dropped = dropped;
    }

    String getTaskId() {
      return taskId;
    }

    String getEvent() {
      return event;
    }

    String getEngine() {
      return engine;
    }

    String getState() {
      return state;
    }

    long getStartedAtEpochMillis() {
      return startedAtEpochMillis;
    }

    long getDeadlineEpochMillis() {
      return deadlineEpochMillis;
    }

    long getSamples() {
      return samples;
    }

    long getDropped() {
      return dropped;
    }
  }

  static final class Result {
    private final String taskId;
    private final String state;
    private final String event;
    private final long samples;
    private final long dropped;
    private final ArtifactInfo artifact;
    private final String error;
    private final String engine;

    Result(
        String taskId,
        String state,
        String event,
        long samples,
        long dropped,
        ArtifactInfo artifact,
        String error,
        String engine) {
      this.taskId = taskId;
      this.state = state;
      this.event = event;
      this.samples = samples;
      this.dropped = dropped;
      this.artifact = artifact;
      this.error = error;
      this.engine = engine;
    }

    static Result unknown(String taskId) {
      return new Result(
          taskId, "UNKNOWN", "", 0L, 0L, null, "", "");
    }

    String getTaskId() {
      return taskId;
    }

    String getState() {
      return state;
    }

    String getEvent() {
      return event;
    }

    long getSamples() {
      return samples;
    }

    long getDropped() {
      return dropped;
    }

    ArtifactInfo getArtifact() {
      return artifact;
    }

    String getError() {
      return error;
    }

    String getEngine() {
      return engine;
    }
  }

  static final class ArtifactInfo {
    private final String token;
    private final long size;

    ArtifactInfo(String token, long size) {
      this.token = token;
      this.size = size;
    }

    String getToken() {
      return token;
    }

    long getSize() {
      return size;
    }
  }

  private static final class ProfileTask {
    private final String taskId;
    private final String event;
    private final long startedAtEpochMillis;
    private final long deadlineEpochMillis;
    private final int stackDepth;
    private final boolean threads;
    private final List<String> includes;
    private final List<String> excludes;
    private final Map<String, Long> stacks =
        new ConcurrentHashMap<String, Long>();
    private final Map<Long, Long> allocatedBytes =
        new HashMap<Long, Long>();
    private final AtomicLong samples = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong();
    private final AtomicBoolean finished = new AtomicBoolean();
    private final Object reportLock = new Object();
    private volatile String state = "RUNNING";
    private volatile String error = "";
    private volatile ArtifactInfo artifact;
    private volatile ScheduledFuture<?> sampleFuture;
    private volatile ScheduledFuture<?> finishFuture;

    private ProfileTask(
        String taskId,
        String event,
        long startedAtEpochMillis,
        long deadlineEpochMillis,
        int stackDepth,
        boolean threads,
        List<String> includes,
        List<String> excludes) {
      this.taskId = taskId;
      this.event = event;
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.deadlineEpochMillis = deadlineEpochMillis;
      this.stackDepth = stackDepth;
      this.threads = threads;
      this.includes = includes;
      this.excludes = excludes;
    }

    private Result result() {
      return result(artifact);
    }

    private Result result(ArtifactInfo resultArtifact) {
      return new Result(
          taskId,
          state,
          event,
          samples.get(),
          dropped.get(),
          resultArtifact,
          error,
          "JDK_BOUNDED_SAMPLER");
    }
  }
}
