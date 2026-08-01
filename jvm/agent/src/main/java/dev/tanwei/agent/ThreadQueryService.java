package dev.tanwei.agent;

import dev.tanwei.protocol.v1.ThreadDescriptor;
import dev.tanwei.protocol.v1.ThreadListRequest;
import dev.tanwei.protocol.v1.ThreadListResponse;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

final class ThreadQueryService {
  private static final int DEFAULT_PAGE_SIZE = 100;
  private static final int MAXIMUM_PAGE_SIZE = 1_000;
  private static final int MAXIMUM_STACK_DEPTH = 256;
  private static final int MAXIMUM_ATTRIBUTE_THREADS = 1_000_000;

  private final ThreadDataSource source;

  ThreadQueryService() {
    this(new JvmThreadDataSource(ManagementFactory.getThreadMXBean()));
  }

  ThreadQueryService(ThreadDataSource source) {
    this.source = Objects.requireNonNull(source, "source");
  }

  /**
   * Takes a lightweight metadata snapshot, selects a bounded page, then fetches
   * deep stacks only for rows on that page.
   *
   * <p>Time: O(T log K + K log K + K * D). Space: O(T + K * D), where the
   * O(T) term is the MXBean metadata snapshot and K = min(T, offset + limit).
   */
  ThreadListResponse list(ThreadListRequest request) {
    Objects.requireNonNull(request, "request");
    int offset = Math.max(0, request.getOffset());
    int limit = pageSize(request.getLimit());
    int depth =
        Math.max(0, Math.min(MAXIMUM_STACK_DEPTH, request.getStackDepth()));
    String query =
        safeString(request.getNameQuery()).trim().toLowerCase(Locale.ROOT);
    String stateFilter =
        safeString(request.getStateFilter()).trim().toUpperCase(Locale.ROOT);

    long[] ids = source.allThreadIds();
    if (ids == null) {
      ids = new long[0];
    }
    ThreadInfo[] metadata =
        ids.length == 0 ? new ThreadInfo[0] : source.threadInfo(ids, 0);
    Map<Long, ThreadAttributes> attributes = source.threadAttributes(ids.length);
    if (attributes == null) {
      attributes = Collections.emptyMap();
    }
    Set<Long> deadlocked = source.deadlockedThreadIds();
    if (deadlocked == null) {
      deadlocked = Collections.emptySet();
    }
    boolean cpuTimeAvailable = source.cpuTimeAvailable();
    ThreadPageSelector selector =
        new ThreadPageSelector(offset, limit, ids.length);

    for (int index = 0; index < ids.length; index++) {
      ThreadInfo info =
          metadata != null && index < metadata.length ? metadata[index] : null;
      if (info == null || !matches(info, query, stateFilter)) {
        continue;
      }
      long threadId = info.getThreadId();
      ThreadDescriptor.Builder descriptor =
          ThreadDescriptor.newBuilder()
              .setId(threadId)
              .setName(safeString(info.getThreadName()))
              .setState(info.getThreadState().name())
              .setDeadlocked(deadlocked.contains(threadId))
              .setLockName(safeString(info.getLockName()))
              .setLockOwnerId(Math.max(-1L, info.getLockOwnerId()));
      ThreadAttributes threadAttributes = attributes.get(threadId);
      if (threadAttributes != null) {
        descriptor
            .setDaemon(threadAttributes.isDaemon())
            .setPriority(threadAttributes.getPriority());
      }
      if (cpuTimeAvailable) {
        long cpuTimeNanos = source.cpuTime(threadId);
        if (cpuTimeNanos >= 0L) {
          descriptor
              .setCpuTimeNanos(cpuTimeNanos)
              .setHasCpuTime(true);
        }
      }
      selector.accept(descriptor.build());
    }

    ThreadPageSelector.Page selected = selector.finish();
    List<ThreadDescriptor> page = selected.getThreads();
    if (depth > 0 && !page.isEmpty()) {
      page = enrichStacks(page, depth);
    }
    return ThreadListResponse.newBuilder()
        .setTotal(selected.getTotal())
        .setOffset(offset)
        .addAllThreads(page)
        .build();
  }

  private List<ThreadDescriptor> enrichStacks(
      List<ThreadDescriptor> page, int depth) {
    long[] pageIds = new long[page.size()];
    for (int index = 0; index < page.size(); index++) {
      pageIds[index] = page.get(index).getId();
    }
    ThreadInfo[] stackInfos = source.threadInfo(pageIds, depth);
    ArrayList<ThreadDescriptor> enriched =
        new ArrayList<ThreadDescriptor>(page.size());
    for (int index = 0; index < page.size(); index++) {
      ThreadDescriptor.Builder descriptor =
          page.get(index).toBuilder().clearStack();
      ThreadInfo stackInfo =
          stackInfos != null && index < stackInfos.length
              ? stackInfos[index]
              : null;
      if (stackInfo != null) {
        for (StackTraceElement element : stackInfo.getStackTrace()) {
          descriptor.addStack(element.toString());
        }
      }
      enriched.add(descriptor.build());
    }
    return Collections.unmodifiableList(enriched);
  }

  private static boolean matches(
      ThreadInfo info, String query, String stateFilter) {
    return safeString(info.getThreadName())
            .toLowerCase(Locale.ROOT)
            .contains(query)
        && (stateFilter.isEmpty()
            || info.getThreadState().name().equals(stateFilter));
  }

  private static int pageSize(int requested) {
    return requested <= 0
        ? DEFAULT_PAGE_SIZE
        : Math.min(MAXIMUM_PAGE_SIZE, requested);
  }

  private static String safeString(String value) {
    return value == null ? "" : value;
  }

  interface ThreadDataSource {
    long[] allThreadIds();

    ThreadInfo[] threadInfo(long[] ids, int depth);

    boolean cpuTimeAvailable();

    long cpuTime(long threadId);

    Map<Long, ThreadAttributes> threadAttributes(int expectedThreadCount);

    Set<Long> deadlockedThreadIds();
  }

  static final class ThreadAttributes {
    private final boolean daemon;
    private final int priority;

    ThreadAttributes(boolean daemon, int priority) {
      this.daemon = daemon;
      this.priority = priority;
    }

    boolean isDaemon() {
      return daemon;
    }

    int getPriority() {
      return priority;
    }
  }

  private static final class JvmThreadDataSource implements ThreadDataSource {
    private final ThreadMXBean bean;

    private JvmThreadDataSource(ThreadMXBean bean) {
      this.bean = Objects.requireNonNull(bean, "bean");
    }

    @Override
    public long[] allThreadIds() {
      return bean.getAllThreadIds();
    }

    @Override
    public ThreadInfo[] threadInfo(long[] ids, int depth) {
      return bean.getThreadInfo(ids, depth);
    }

    @Override
    public boolean cpuTimeAvailable() {
      return bean.isThreadCpuTimeSupported() && bean.isThreadCpuTimeEnabled();
    }

    @Override
    public long cpuTime(long threadId) {
      return bean.getThreadCpuTime(threadId);
    }

    @Override
    public Map<Long, ThreadAttributes> threadAttributes(
        int expectedThreadCount) {
      ThreadGroup root = Thread.currentThread().getThreadGroup();
      while (root != null && root.getParent() != null) {
        root = root.getParent();
      }
      if (root == null) {
        return Collections.emptyMap();
      }
      int capacity =
          Math.max(
              16,
              Math.min(
                  MAXIMUM_ATTRIBUTE_THREADS,
                  expectedThreadCount >= MAXIMUM_ATTRIBUTE_THREADS - 16
                      ? MAXIMUM_ATTRIBUTE_THREADS
                      : expectedThreadCount + 16));
      Thread[] threads;
      int count;
      do {
        threads = new Thread[capacity];
        count = root.enumerate(threads, true);
        if (count < capacity || capacity == MAXIMUM_ATTRIBUTE_THREADS) {
          break;
        }
        capacity =
            Math.min(
                MAXIMUM_ATTRIBUTE_THREADS,
                Math.max(capacity + 1, capacity * 2));
      } while (true);
      Map<Long, ThreadAttributes> result =
          new HashMap<Long, ThreadAttributes>(Math.max(16, count * 2));
      for (int index = 0; index < count && index < threads.length; index++) {
        Thread thread = threads[index];
        if (thread != null) {
          result.put(
              thread.getId(),
              new ThreadAttributes(thread.isDaemon(), thread.getPriority()));
        }
      }
      return result;
    }

    @Override
    public Set<Long> deadlockedThreadIds() {
      long[] ids = bean.findDeadlockedThreads();
      if (ids == null || ids.length == 0) {
        return Collections.emptySet();
      }
      Set<Long> result = new HashSet<Long>(ids.length);
      for (long id : ids) {
        result.add(id);
      }
      return result;
    }
  }
}
