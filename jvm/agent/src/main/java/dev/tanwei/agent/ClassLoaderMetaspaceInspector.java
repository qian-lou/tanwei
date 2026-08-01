package dev.tanwei.agent;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class ClassLoaderMetaspaceInspector {
  static final int MINIMUM_DURATION_MILLIS = 250;
  static final int MAXIMUM_DURATION_MILLIS = 3_000;
  static final int MINIMUM_PERIOD_MILLIS = 50;
  static final int MAXIMUM_PERIOD_MILLIS = 1_000;
  static final int MAXIMUM_ROWS = 100;
  private static final int MAXIMUM_EVENTS = 50_000;
  private static final int MAXIMUM_LOADERS = 4_096;
  private static final String EVENT_NAME = "jdk.ClassLoaderStatistics";

  private final boolean available;
  private final String unavailableReason;

  ClassLoaderMetaspaceInspector() {
    String reason = "";
    boolean detected = true;
    try {
      Class.forName("jdk.jfr.Recording");
      Class.forName("jdk.jfr.consumer.RecordedEvent");
      Class.forName("jdk.jfr.consumer.RecordingFile");
    } catch (ClassNotFoundException exception) {
      detected = false;
      reason = "ClassLoader metaspace inspection requires JFR on JDK 11 or later";
    }
    available = detected;
    unavailableReason = reason;
  }

  boolean isAvailable() {
    return available;
  }

  String unavailableReason() {
    return unavailableReason;
  }

  synchronized Result inspect(int durationMillis, int periodMillis, int limit)
      throws Exception {
    validate(durationMillis, periodMillis, limit);
    if (!available) {
      throw new UnsupportedOperationException(unavailableReason);
    }

    Path recordingPath = null;
    Object recording = null;
    long startedAtEpochMillis = System.currentTimeMillis();
    try {
      recordingPath =
          Files.createTempFile("tanwei-classloader-metaspace-", ".jfr");
      Class<?> recordingType = Class.forName("jdk.jfr.Recording");
      recording = recordingType.getConstructor().newInstance();
      Object settings =
          recordingType
              .getMethod("enable", String.class)
              .invoke(recording, EVENT_NAME);
      settings
          .getClass()
          .getMethod("withPeriod", Duration.class)
          .invoke(settings, Duration.ofMillis(periodMillis));
      recordingType.getMethod("start").invoke(recording);
      try {
        Thread.sleep(durationMillis);
      } catch (InterruptedException exception) {
        Thread.currentThread().interrupt();
        throw exception;
      }
      recordingType.getMethod("stop").invoke(recording);
      recordingType.getMethod("dump", Path.class).invoke(recording, recordingPath);
      return readRecording(
          recordingPath,
          startedAtEpochMillis,
          System.currentTimeMillis(),
          durationMillis,
          periodMillis,
          limit);
    } finally {
      closeQuietly(recording);
      if (recordingPath != null) {
        Files.deleteIfExists(recordingPath);
      }
    }
  }

  private static Result readRecording(
      Path recordingPath,
      long startedAtEpochMillis,
      long completedAtEpochMillis,
      int durationMillis,
      int periodMillis,
      int limit)
      throws Exception {
    Class<?> recordingFileType =
        Class.forName("jdk.jfr.consumer.RecordingFile");
    Constructor<?> constructor = recordingFileType.getConstructor(Path.class);
    Object recordingFile = constructor.newInstance(recordingPath);
    Method hasMoreEvents = recordingFileType.getMethod("hasMoreEvents");
    Method readEvent = recordingFileType.getMethod("readEvent");
    Method close = recordingFileType.getMethod("close");
    Class<?> recordedEventType =
        Class.forName("jdk.jfr.consumer.RecordedEvent");
    Method getEventType = recordedEventType.getMethod("getEventType");
    Method getValue = recordedEventType.getMethod("getValue", String.class);
    Method getLong = recordedEventType.getMethod("getLong", String.class);
    Method getStartTime = recordedEventType.getMethod("getStartTime");
    Method getEventTypeName =
        Class.forName("jdk.jfr.EventType").getMethod("getName");

    Map<String, Row> latestByLoader = new LinkedHashMap<String, Row>();
    int eventCount = 0;
    boolean truncated = false;
    try {
      while (Boolean.TRUE.equals(hasMoreEvents.invoke(recordingFile))) {
        if (eventCount >= MAXIMUM_EVENTS) {
          truncated = true;
          break;
        }
        Object event = readEvent.invoke(recordingFile);
        Object eventType = getEventType.invoke(event);
        if (!EVENT_NAME.equals(String.valueOf(getEventTypeName.invoke(eventType)))) {
          continue;
        }
        eventCount++;
        LoaderIdentity loader =
            loaderIdentity(getValue.invoke(event, "classLoader"));
        LoaderIdentity parent =
            loaderIdentity(getValue.invoke(event, "parentClassLoader"));
        if (!latestByLoader.containsKey(loader.id)
            && latestByLoader.size() >= MAXIMUM_LOADERS) {
          truncated = true;
          continue;
        }
        Object startTime = getStartTime.invoke(event);
        long sampledAtEpochMillis =
            startTime instanceof Instant
                ? ((Instant) startTime).toEpochMilli()
                : completedAtEpochMillis;
        latestByLoader.put(
            loader.id,
            new Row(
                loader.id,
                loader.name,
                loader.type,
                parent.id,
                parent.name,
                safeLong(getLong, event, "classCount"),
                safeLong(getLong, event, "chunkSize"),
                safeLong(getLong, event, "blockSize"),
                safeLong(getLong, event, "hiddenClassCount"),
                safeLong(getLong, event, "hiddenChunkSize"),
                hiddenBlockSize(getLong, event),
                sampledAtEpochMillis));
      }
    } finally {
      close.invoke(recordingFile);
    }

    List<Row> ordered = new ArrayList<Row>(latestByLoader.values());
    ordered.sort(
        Comparator.comparingLong(Row::getChunkSize)
            .reversed()
            .thenComparing(Comparator.comparingLong(Row::getBlockSize).reversed())
            .thenComparing(Row::getName)
            .thenComparing(Row::getId));

    long totalClassCount = 0L;
    long totalChunkSize = 0L;
    long totalBlockSize = 0L;
    long totalHiddenClassCount = 0L;
    long totalHiddenChunkSize = 0L;
    long totalHiddenBlockSize = 0L;
    for (Row row : ordered) {
      totalClassCount = saturatedAdd(totalClassCount, row.classCount);
      totalChunkSize = saturatedAdd(totalChunkSize, row.chunkSize);
      totalBlockSize = saturatedAdd(totalBlockSize, row.blockSize);
      totalHiddenClassCount =
          saturatedAdd(totalHiddenClassCount, row.hiddenClassCount);
      totalHiddenChunkSize =
          saturatedAdd(totalHiddenChunkSize, row.hiddenChunkSize);
      totalHiddenBlockSize =
          saturatedAdd(totalHiddenBlockSize, row.hiddenBlockSize);
    }

    int retainedRows = Math.min(limit, ordered.size());
    return new Result(
        startedAtEpochMillis,
        completedAtEpochMillis,
        durationMillis,
        periodMillis,
        eventCount,
        ordered.size(),
        truncated || retainedRows < ordered.size(),
        totalClassCount,
        totalChunkSize,
        totalBlockSize,
        totalHiddenClassCount,
        totalHiddenChunkSize,
        totalHiddenBlockSize,
        new ArrayList<Row>(ordered.subList(0, retainedRows)));
  }

  private static LoaderIdentity loaderIdentity(Object recordedLoader)
      throws Exception {
    if (recordedLoader == null) {
      return new LoaderIdentity("bootstrap", "BootstrapClassLoader", "bootstrap");
    }
    Class<?> type = recordedLoader.getClass();
    long id = ((Long) type.getMethod("getId").invoke(recordedLoader)).longValue();
    Object rawName = type.getMethod("getName").invoke(recordedLoader);
    Object recordedClass = type.getMethod("getType").invoke(recordedLoader);
    String className = "unknown";
    if (recordedClass != null) {
      Object rawClassName =
          recordedClass.getClass().getMethod("getName").invoke(recordedClass);
      if (rawClassName != null && !String.valueOf(rawClassName).isEmpty()) {
        className = String.valueOf(rawClassName);
      }
    }
    String name = rawName == null ? "" : String.valueOf(rawName);
    if (name.isEmpty()) {
      name = className;
    }
    return new LoaderIdentity("jfr:" + id, name, className);
  }

  private static long hiddenBlockSize(Method getLong, Object event) {
    long value = safeLong(getLong, event, "hiddenBlockSize");
    return value > 0L ? value : safeLong(getLong, event, "anonymousBlockSize");
  }

  private static long safeLong(Method getLong, Object event, String field) {
    try {
      Object value = getLong.invoke(event, field);
      return value instanceof Long ? Math.max(0L, ((Long) value).longValue()) : 0L;
    } catch (ReflectiveOperationException ignored) {
      return 0L;
    }
  }

  private static long saturatedAdd(long left, long right) {
    if (right > 0L && left > Long.MAX_VALUE - right) {
      return Long.MAX_VALUE;
    }
    return left + right;
  }

  private static void closeQuietly(Object recording) {
    if (recording == null) {
      return;
    }
    try {
      recording.getClass().getMethod("close").invoke(recording);
    } catch (ReflectiveOperationException ignored) {
      // Best effort: temporary recording resources must not hide the primary failure.
    }
  }

  private static void validate(int durationMillis, int periodMillis, int limit) {
    if (durationMillis < MINIMUM_DURATION_MILLIS
        || durationMillis > MAXIMUM_DURATION_MILLIS) {
      throw new IllegalArgumentException(
          "durationMillis must be between 250 and 3000");
    }
    if (periodMillis < MINIMUM_PERIOD_MILLIS
        || periodMillis > MAXIMUM_PERIOD_MILLIS
        || periodMillis > durationMillis) {
      throw new IllegalArgumentException(
          "periodMillis must be between 50 and 1000 and not exceed durationMillis");
    }
    if (limit < 1 || limit > MAXIMUM_ROWS) {
      throw new IllegalArgumentException("limit must be between 1 and 100");
    }
  }

  private static final class LoaderIdentity {
    private final String id;
    private final String name;
    private final String type;

    private LoaderIdentity(String id, String name, String type) {
      this.id = id;
      this.name = name;
      this.type = type;
    }
  }

  static final class Result {
    private final long startedAtEpochMillis;
    private final long completedAtEpochMillis;
    private final int durationMillis;
    private final int periodMillis;
    private final int eventCount;
    private final int totalLoaders;
    private final boolean truncated;
    private final long totalClassCount;
    private final long totalChunkSize;
    private final long totalBlockSize;
    private final long totalHiddenClassCount;
    private final long totalHiddenChunkSize;
    private final long totalHiddenBlockSize;
    private final List<Row> rows;

    private Result(
        long startedAtEpochMillis,
        long completedAtEpochMillis,
        int durationMillis,
        int periodMillis,
        int eventCount,
        int totalLoaders,
        boolean truncated,
        long totalClassCount,
        long totalChunkSize,
        long totalBlockSize,
        long totalHiddenClassCount,
        long totalHiddenChunkSize,
        long totalHiddenBlockSize,
        List<Row> rows) {
      this.startedAtEpochMillis = startedAtEpochMillis;
      this.completedAtEpochMillis = completedAtEpochMillis;
      this.durationMillis = durationMillis;
      this.periodMillis = periodMillis;
      this.eventCount = eventCount;
      this.totalLoaders = totalLoaders;
      this.truncated = truncated;
      this.totalClassCount = totalClassCount;
      this.totalChunkSize = totalChunkSize;
      this.totalBlockSize = totalBlockSize;
      this.totalHiddenClassCount = totalHiddenClassCount;
      this.totalHiddenChunkSize = totalHiddenChunkSize;
      this.totalHiddenBlockSize = totalHiddenBlockSize;
      this.rows = Collections.unmodifiableList(new ArrayList<Row>(rows));
    }

    long getStartedAtEpochMillis() {
      return startedAtEpochMillis;
    }

    long getCompletedAtEpochMillis() {
      return completedAtEpochMillis;
    }

    int getDurationMillis() {
      return durationMillis;
    }

    int getPeriodMillis() {
      return periodMillis;
    }

    int getEventCount() {
      return eventCount;
    }

    int getTotalLoaders() {
      return totalLoaders;
    }

    boolean isTruncated() {
      return truncated;
    }

    long getTotalClassCount() {
      return totalClassCount;
    }

    long getTotalChunkSize() {
      return totalChunkSize;
    }

    long getTotalBlockSize() {
      return totalBlockSize;
    }

    long getTotalHiddenClassCount() {
      return totalHiddenClassCount;
    }

    long getTotalHiddenChunkSize() {
      return totalHiddenChunkSize;
    }

    long getTotalHiddenBlockSize() {
      return totalHiddenBlockSize;
    }

    List<Row> getRows() {
      return rows;
    }
  }

  static final class Row {
    private final String id;
    private final String name;
    private final String type;
    private final String parentId;
    private final String parentName;
    private final long classCount;
    private final long chunkSize;
    private final long blockSize;
    private final long hiddenClassCount;
    private final long hiddenChunkSize;
    private final long hiddenBlockSize;
    private final long sampledAtEpochMillis;

    private Row(
        String id,
        String name,
        String type,
        String parentId,
        String parentName,
        long classCount,
        long chunkSize,
        long blockSize,
        long hiddenClassCount,
        long hiddenChunkSize,
        long hiddenBlockSize,
        long sampledAtEpochMillis) {
      this.id = id;
      this.name = name;
      this.type = type;
      this.parentId = parentId;
      this.parentName = parentName;
      this.classCount = classCount;
      this.chunkSize = chunkSize;
      this.blockSize = blockSize;
      this.hiddenClassCount = hiddenClassCount;
      this.hiddenChunkSize = hiddenChunkSize;
      this.hiddenBlockSize = hiddenBlockSize;
      this.sampledAtEpochMillis = sampledAtEpochMillis;
    }

    String getId() {
      return id;
    }

    String getName() {
      return name;
    }

    String getType() {
      return type;
    }

    String getParentId() {
      return parentId;
    }

    String getParentName() {
      return parentName;
    }

    long getClassCount() {
      return classCount;
    }

    long getChunkSize() {
      return chunkSize;
    }

    long getBlockSize() {
      return blockSize;
    }

    long getHiddenClassCount() {
      return hiddenClassCount;
    }

    long getHiddenChunkSize() {
      return hiddenChunkSize;
    }

    long getHiddenBlockSize() {
      return hiddenBlockSize;
    }

    long getSampledAtEpochMillis() {
      return sampledAtEpochMillis;
    }
  }
}
