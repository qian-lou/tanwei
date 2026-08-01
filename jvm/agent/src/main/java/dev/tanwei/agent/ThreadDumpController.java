package dev.tanwei.agent;

import java.io.BufferedWriter;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.management.LockInfo;
import java.lang.management.ManagementFactory;
import java.lang.management.MonitorInfo;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class ThreadDumpController {
  static final int MAXIMUM_THREADS = 10_000;
  static final int MAXIMUM_STACK_DEPTH = 512;
  static final long MAXIMUM_BYTES = 32L * 1024L * 1024L;

  Result capture(
      Path output,
      int maximumThreads,
      int maximumStackDepth,
      boolean includeLocks)
      throws IOException {
    if (output == null) {
      throw new IllegalArgumentException("Thread dump output is required");
    }
    if (maximumThreads < 1 || maximumThreads > MAXIMUM_THREADS) {
      throw new IllegalArgumentException(
          "Thread dump maximumThreads must be between 1 and 10000");
    }
    if (maximumStackDepth < 1
        || maximumStackDepth > MAXIMUM_STACK_DEPTH) {
      throw new IllegalArgumentException(
          "Thread dump maximumStackDepth must be between 1 and 512");
    }

    ThreadMXBean threadBean = ManagementFactory.getThreadMXBean();
    long[] allIds = threadBean.getAllThreadIds();
    int selectedCount = Math.min(allIds.length, maximumThreads);
    long[] selectedIds = new long[selectedCount];
    System.arraycopy(allIds, 0, selectedIds, 0, selectedCount);

    boolean monitorsIncluded =
        includeLocks && threadBean.isObjectMonitorUsageSupported();
    boolean synchronizersIncluded =
        includeLocks && threadBean.isSynchronizerUsageSupported();
    ThreadInfo[] infos;
    if (monitorsIncluded || synchronizersIncluded) {
      infos =
          threadBean.getThreadInfo(
              selectedIds,
              monitorsIncluded,
              synchronizersIncluded);
    } else {
      infos =
          threadBean.getThreadInfo(
              selectedIds, maximumStackDepth);
    }
    Set<Long> deadlockedIds = deadlockedThreadIds(threadBean);
    BoundedOutputStream bounded =
        new BoundedOutputStream(
            Files.newOutputStream(output), MAXIMUM_BYTES);
    int writtenThreads = 0;
    try (BufferedWriter writer =
        new BufferedWriter(
            new java.io.OutputStreamWriter(
                bounded, StandardCharsets.UTF_8),
            64 * 1024)) {
      writer.write("Tanwei Thread Dump");
      writer.newLine();
      writer.write("formatVersion=1");
      writer.newLine();
      writer.write("capturedAt=" + Instant.now().toString());
      writer.newLine();
      writer.write("processId=" + currentPid());
      writer.newLine();
      writer.write(
          "jvmStartTimeMillis="
              + ManagementFactory.getRuntimeMXBean().getStartTime());
      writer.newLine();
      writer.write(
          "javaVersion="
              + singleLine(
                  System.getProperty("java.version", "unknown")));
      writer.newLine();
      writer.write("threadsSeen=" + allIds.length);
      writer.newLine();
      writer.write("threadsSelected=" + selectedCount);
      writer.newLine();
      writer.write(
          "truncated="
              + Boolean.toString(allIds.length > selectedCount));
      writer.newLine();
      writer.write(
          "maximumStackDepth=" + maximumStackDepth);
      writer.newLine();
      writer.write(
          "monitorsIncluded="
              + Boolean.toString(monitorsIncluded));
      writer.newLine();
      writer.write(
          "synchronizersIncluded="
              + Boolean.toString(synchronizersIncluded));
      writer.newLine();
      writer.write(
          "deadlockedThreads=" + deadlockedIds.size());
      writer.newLine();
      writer.newLine();

      if (infos != null) {
        for (ThreadInfo info : infos) {
          if (info == null) {
            continue;
          }
          writeThread(
              writer,
              threadBean,
              info,
              maximumStackDepth,
              deadlockedIds.contains(
                  Long.valueOf(info.getThreadId())));
          writtenThreads++;
        }
      }
    }
    return new Result(
        allIds.length,
        writtenThreads,
        allIds.length > selectedCount,
        deadlockedIds.size(),
        monitorsIncluded,
        synchronizersIncluded,
        bounded.getWrittenBytes());
  }

  private static void writeThread(
      BufferedWriter writer,
      ThreadMXBean threadBean,
      ThreadInfo info,
      int maximumStackDepth,
      boolean deadlocked)
      throws IOException {
    long cpuTimeNanos = -1L;
    if (threadBean.isThreadCpuTimeSupported()
        && threadBean.isThreadCpuTimeEnabled()) {
      cpuTimeNanos =
          threadBean.getThreadCpuTime(info.getThreadId());
    }
    writer.write(
        "\""
            + quoted(info.getThreadName())
            + "\" #"
            + info.getThreadId()
            + " state="
            + info.getThreadState().name()
            + " cpuTimeNanos="
            + cpuTimeNanos
            + " deadlocked="
            + deadlocked);
    writer.newLine();
    if (info.getLockName() != null) {
      writer.write("  waitingOn=" + singleLine(info.getLockName()));
      if (info.getLockOwnerId() >= 0L) {
        writer.write(
            " owner=#"
                + info.getLockOwnerId()
                + " \""
                + quoted(info.getLockOwnerName())
                + "\"");
      }
      writer.newLine();
    }
    StackTraceElement[] stack = info.getStackTrace();
    int stackLimit =
        Math.min(stack.length, maximumStackDepth);
    MonitorInfo[] monitors = info.getLockedMonitors();
    Map<Integer, List<MonitorInfo>> monitorsByDepth =
        indexMonitors(monitors);
    for (int index = 0; index < stackLimit; index++) {
      writer.write("    at " + singleLine(stack[index].toString()));
      writer.newLine();
      List<MonitorInfo> frameMonitors =
          monitorsByDepth.get(Integer.valueOf(index));
      if (frameMonitors == null) {
        continue;
      }
      for (MonitorInfo monitor : frameMonitors) {
        writer.write(
            "      - locked "
                + singleLine(monitor.toString()));
        writer.newLine();
      }
    }
    if (stack.length > stackLimit) {
      writer.write(
          "    ... "
              + (stack.length - stackLimit)
              + " frames truncated");
      writer.newLine();
    }
    if (monitors != null && monitors.length > 256) {
      writer.write(
          "    ... "
              + (monitors.length - 256)
              + " monitors truncated");
      writer.newLine();
    }
    LockInfo[] synchronizers =
        info.getLockedSynchronizers();
    if (synchronizers != null
        && synchronizers.length > 0) {
      writer.write("    Locked ownable synchronizers:");
      writer.newLine();
      int limit = Math.min(synchronizers.length, 256);
      for (int index = 0; index < limit; index++) {
        writer.write(
            "      - "
                + singleLine(
                    synchronizers[index].toString()));
        writer.newLine();
      }
      if (synchronizers.length > limit) {
        writer.write(
            "      ... "
                + (synchronizers.length - limit)
                + " synchronizers truncated");
        writer.newLine();
      }
    }
    writer.newLine();
  }

  private static Map<Integer, List<MonitorInfo>> indexMonitors(
      MonitorInfo[] monitors) {
    Map<Integer, List<MonitorInfo>> result =
        new HashMap<Integer, List<MonitorInfo>>();
    if (monitors == null) {
      return result;
    }
    int limit = Math.min(monitors.length, 256);
    for (int index = 0; index < limit; index++) {
      MonitorInfo monitor = monitors[index];
      if (monitor == null || monitor.getLockedStackDepth() < 0) {
        continue;
      }
      Integer depth =
          Integer.valueOf(monitor.getLockedStackDepth());
      List<MonitorInfo> atDepth = result.get(depth);
      if (atDepth == null) {
        atDepth = new ArrayList<MonitorInfo>();
        result.put(depth, atDepth);
      }
      atDepth.add(monitor);
    }
    return result;
  }

  private static Set<Long> deadlockedThreadIds(
      ThreadMXBean threadBean) {
    long[] ids =
        threadBean.isSynchronizerUsageSupported()
            ? threadBean.findDeadlockedThreads()
            : threadBean.findMonitorDeadlockedThreads();
    Set<Long> result = new HashSet<Long>();
    if (ids != null) {
      for (long id : ids) {
        result.add(Long.valueOf(id));
      }
    }
    return result;
  }

  private static String quoted(String value) {
    return singleLine(value).replace('"', '\'');
  }

  private static String singleLine(String value) {
    if (value == null || value.isEmpty()) {
      return "";
    }
    StringBuilder result =
        new StringBuilder(Math.min(value.length(), 1_024));
    for (int index = 0;
        index < value.length() && result.length() < 1_024;
        index++) {
      char character = value.charAt(index);
      result.append(
          character == '\r'
                  || character == '\n'
                  || Character.isISOControl(character)
              ? ' '
              : character);
    }
    return result.toString();
  }

  private static long currentPid() {
    String runtimeName =
        ManagementFactory.getRuntimeMXBean().getName();
    int separator = runtimeName.indexOf('@');
    if (separator > 0) {
      try {
        return Long.parseLong(runtimeName.substring(0, separator));
      } catch (NumberFormatException ignored) {
        // Fall through to the unsupported sentinel.
      }
    }
    return -1L;
  }

  static final class Result {
    private final int threadsSeen;
    private final int threadsWritten;
    private final boolean truncated;
    private final int deadlockedThreads;
    private final boolean monitorsIncluded;
    private final boolean synchronizersIncluded;
    private final long bytesWritten;

    Result(
        int threadsSeen,
        int threadsWritten,
        boolean truncated,
        int deadlockedThreads,
        boolean monitorsIncluded,
        boolean synchronizersIncluded,
        long bytesWritten) {
      this.threadsSeen = threadsSeen;
      this.threadsWritten = threadsWritten;
      this.truncated = truncated;
      this.deadlockedThreads = deadlockedThreads;
      this.monitorsIncluded = monitorsIncluded;
      this.synchronizersIncluded = synchronizersIncluded;
      this.bytesWritten = bytesWritten;
    }

    int getThreadsSeen() {
      return threadsSeen;
    }

    int getThreadsWritten() {
      return threadsWritten;
    }

    boolean isTruncated() {
      return truncated;
    }

    int getDeadlockedThreads() {
      return deadlockedThreads;
    }

    boolean isMonitorsIncluded() {
      return monitorsIncluded;
    }

    boolean isSynchronizersIncluded() {
      return synchronizersIncluded;
    }

    long getBytesWritten() {
      return bytesWritten;
    }
  }

  private static final class BoundedOutputStream
      extends FilterOutputStream {
    private final long maximumBytes;
    private long writtenBytes;

    private BoundedOutputStream(
        OutputStream output, long maximumBytes) {
      super(output);
      this.maximumBytes = maximumBytes;
    }

    @Override
    public void write(int value) throws IOException {
      ensureCapacity(1);
      out.write(value);
      writtenBytes++;
    }

    @Override
    public void write(byte[] buffer, int offset, int length)
        throws IOException {
      if (buffer == null) {
        throw new NullPointerException("buffer");
      }
      if (offset < 0
          || length < 0
          || offset > buffer.length - length) {
        throw new IndexOutOfBoundsException();
      }
      ensureCapacity(length);
      out.write(buffer, offset, length);
      writtenBytes += length;
    }

    private void ensureCapacity(int additionalBytes)
        throws IOException {
      if (additionalBytes < 0
          || writtenBytes
              > maximumBytes - additionalBytes) {
        throw new IOException(
            "Thread dump exceeds the 32 MiB safety limit");
      }
    }

    private long getWrittenBytes() {
      return writtenBytes;
    }
  }
}
