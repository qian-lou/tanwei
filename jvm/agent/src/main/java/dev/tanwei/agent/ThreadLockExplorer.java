package dev.tanwei.agent;

import java.lang.management.LockInfo;
import java.lang.management.ManagementFactory;
import java.lang.management.MonitorInfo;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

final class ThreadLockExplorer {
  private static final int MAXIMUM_NODES = 500;
  private static final int MAXIMUM_LOCKS_PER_THREAD = 32;

  private final ThreadMXBean threadBean;

  ThreadLockExplorer() {
    this(ManagementFactory.getThreadMXBean());
  }

  ThreadLockExplorer(ThreadMXBean threadBean) {
    if (threadBean == null) {
      throw new IllegalArgumentException("ThreadMXBean is required");
    }
    this.threadBean = threadBean;
  }

  Map<String, String> inspect(boolean includeUncontended, int requestedMaximum) {
    int maximumNodes = Math.max(1, Math.min(MAXIMUM_NODES, requestedMaximum));
    boolean monitorsSupported = threadBean.isObjectMonitorUsageSupported();
    boolean synchronizersSupported = threadBean.isSynchronizerUsageSupported();
    ThreadInfo[] dumped =
        threadBean.dumpAllThreads(monitorsSupported, synchronizersSupported);
    Map<Long, ThreadInfo> byId =
        new HashMap<Long, ThreadInfo>(Math.max(16, dumped.length * 2));
    for (ThreadInfo info : dumped) {
      if (info != null) {
        byId.put(info.getThreadId(), info);
      }
    }

    Set<Long> deadlocked = deadlockedThreadIds();
    Set<Long> relatedIds = new HashSet<Long>();
    Set<Long> ownerIds = new HashSet<Long>();
    int waitingCount = 0;
    int heldLockCount = 0;
    for (ThreadInfo info : byId.values()) {
      boolean waiting = info.getLockInfo() != null;
      int heldLocks =
          safeMonitors(info).length + safeSynchronizers(info).length;
      if (waiting) {
        waitingCount++;
      }
      heldLockCount += heldLocks;
      if (waiting || deadlocked.contains(info.getThreadId())
          || (includeUncontended && heldLocks > 0)) {
        relatedIds.add(info.getThreadId());
      }
      if (info.getLockOwnerId() >= 0L) {
        ownerIds.add(info.getLockOwnerId());
      }
    }
    relatedIds.addAll(ownerIds);

    List<ThreadInfo> related =
        new ArrayList<ThreadInfo>(relatedIds.size());
    for (Long id : relatedIds) {
      ThreadInfo info = byId.get(id);
      if (info != null) {
        related.add(info);
      }
    }
    related.sort(
        Comparator.comparing(
                (ThreadInfo info) -> !deadlocked.contains(info.getThreadId()))
            .thenComparing(info -> info.getLockInfo() == null)
            .thenComparing(info -> !ownerIds.contains(info.getThreadId()))
            .thenComparingLong(ThreadInfo::getThreadId));

    int resultCount = Math.min(maximumNodes, related.size());
    List<ThreadInfo> result =
        related.subList(0, resultCount);
    Set<Long> resultIds = new HashSet<Long>(resultCount);
    for (ThreadInfo info : result) {
      resultIds.add(info.getThreadId());
    }

    int edgeCount = 0;
    for (ThreadInfo info : result) {
      if (info.getLockOwnerId() >= 0L
          && resultIds.contains(info.getLockOwnerId())) {
        edgeCount++;
      }
    }

    Map<String, String> values = new TreeMap<String, String>();
    values.put("scanned", Integer.toString(byId.size()));
    values.put("related", Integer.toString(related.size()));
    values.put("count", Integer.toString(resultCount));
    values.put("truncated", Integer.toString(related.size() - resultCount));
    values.put("waiting", Integer.toString(waitingCount));
    values.put("heldLocks", Integer.toString(heldLockCount));
    values.put("deadlocked", Integer.toString(deadlocked.size()));
    values.put("edges", Integer.toString(edgeCount));
    values.put("monitorUsageSupported", Boolean.toString(monitorsSupported));
    values.put(
        "synchronizerUsageSupported",
        Boolean.toString(synchronizersSupported));
    values.put("includeUncontended", Boolean.toString(includeUncontended));
    for (int index = 0; index < result.size(); index++) {
      addThreadValues(
          values,
          "node." + String.format(Locale.ROOT, "%04d", index) + ".",
          result.get(index),
          deadlocked);
    }
    return values;
  }

  private static void addThreadValues(
      Map<String, String> values,
      String prefix,
      ThreadInfo info,
      Set<Long> deadlocked) {
    values.put(prefix + "id", Long.toString(info.getThreadId()));
    values.put(prefix + "name", bounded(info.getThreadName()));
    values.put(prefix + "state", info.getThreadState().name());
    values.put(
        prefix + "deadlocked",
        Boolean.toString(deadlocked.contains(info.getThreadId())));
    values.put(
        prefix + "waitingLock",
        info.getLockInfo() == null ? "" : bounded(info.getLockInfo().toString()));
    values.put(prefix + "ownerId", Long.toString(info.getLockOwnerId()));
    values.put(
        prefix + "ownerName",
        info.getLockOwnerName() == null ? "" : bounded(info.getLockOwnerName()));
    StackTraceElement[] stack = info.getStackTrace();
    values.put(
        prefix + "stackTop",
        stack.length == 0 ? "" : bounded(stack[0].toString()));

    MonitorInfo[] monitors = safeMonitors(info);
    int monitorCount = Math.min(monitors.length, MAXIMUM_LOCKS_PER_THREAD);
    values.put(prefix + "monitor.total", Integer.toString(monitors.length));
    values.put(prefix + "monitor.count", Integer.toString(monitorCount));
    for (int index = 0; index < monitorCount; index++) {
      MonitorInfo monitor = monitors[index];
      String lockPrefix =
          prefix
              + "monitor."
              + String.format(Locale.ROOT, "%04d", index)
              + ".";
      values.put(lockPrefix + "lock", bounded(monitor.toString()));
      values.put(
          lockPrefix + "depth",
          Integer.toString(monitor.getLockedStackDepth()));
      values.put(
          lockPrefix + "frame",
          monitor.getLockedStackFrame() == null
              ? ""
              : bounded(monitor.getLockedStackFrame().toString()));
    }

    LockInfo[] synchronizers = safeSynchronizers(info);
    int synchronizerCount =
        Math.min(synchronizers.length, MAXIMUM_LOCKS_PER_THREAD);
    values.put(
        prefix + "synchronizer.total",
        Integer.toString(synchronizers.length));
    values.put(
        prefix + "synchronizer.count",
        Integer.toString(synchronizerCount));
    for (int index = 0; index < synchronizerCount; index++) {
      values.put(
          prefix
              + "synchronizer."
              + String.format(Locale.ROOT, "%04d", index)
              + ".lock",
          bounded(synchronizers[index].toString()));
    }
  }

  private Set<Long> deadlockedThreadIds() {
    long[] ids = threadBean.findDeadlockedThreads();
    if (ids == null || ids.length == 0) {
      return Collections.emptySet();
    }
    Set<Long> result = new HashSet<Long>(ids.length);
    for (long id : ids) {
      result.add(id);
    }
    return result;
  }

  private static MonitorInfo[] safeMonitors(ThreadInfo info) {
    MonitorInfo[] monitors = info.getLockedMonitors();
    return monitors == null ? new MonitorInfo[0] : monitors;
  }

  private static LockInfo[] safeSynchronizers(ThreadInfo info) {
    LockInfo[] synchronizers = info.getLockedSynchronizers();
    return synchronizers == null ? new LockInfo[0] : synchronizers;
  }

  private static String bounded(String value) {
    if (value == null) {
      return "";
    }
    return value.length() <= 4_096
        ? value
        : value.substring(0, 4_096) + "…";
  }
}
