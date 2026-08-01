package dev.tanwei.agent;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

final class JfrController implements AutoCloseable {
  private static final String DEFAULT_RECORDING_NAME =
      "Tanwei Diagnostic Recording";
  private static final int MAXIMUM_RECORDING_NAME_LENGTH = 128;
  private static final String COMPILATION_THRESHOLD_SETTING =
      "jdk.Compilation#threshold";
  private static final String COMPILATION_THRESHOLD = "1 ms";

  private final AgentArtifactRegistry artifacts;
  private final Class<?> recordingType;
  private Object recording;
  private String taskId;
  private long startedAtEpochMillis;
  private long recordingId;
  private String recordingName = "";
  private String configuration = "";
  private long maxAgeMillis;
  private long maxSizeBytes;

  JfrController(AgentArtifactRegistry artifacts) {
    this.artifacts = artifacts;
    this.recordingType = findRecordingType();
  }

  boolean isAvailable() {
    return recordingType != null;
  }

  synchronized String start() {
    return start("PROFILE", 0L, 0L, DEFAULT_RECORDING_NAME);
  }

  synchronized String start(
      String requestedConfiguration,
      long requestedMaxAgeMillis,
      long requestedMaxSizeBytes) {
    return start(
        requestedConfiguration,
        requestedMaxAgeMillis,
        requestedMaxSizeBytes,
        DEFAULT_RECORDING_NAME);
  }

  synchronized String start(
      String requestedConfiguration,
      long requestedMaxAgeMillis,
      long requestedMaxSizeBytes,
      String requestedRecordingName) {
    if (!isAvailable()) {
      throw new IllegalStateException("JFR is not available on this JDK");
    }
    if (recording != null) {
      throw new IllegalStateException("A Tanwei JFR recording is already running");
    }
    String normalizedConfiguration = normalizeConfiguration(requestedConfiguration);
    String normalizedRecordingName = normalizeRecordingName(requestedRecordingName);
    if (requestedMaxAgeMillis < 0L || requestedMaxAgeMillis > 86_400_000L) {
      throw new IllegalArgumentException("JFR maxAgeMillis is outside the supported range");
    }
    if (requestedMaxSizeBytes < 0L || requestedMaxSizeBytes > 10_737_418_240L) {
      throw new IllegalArgumentException("JFR maxSizeBytes is outside the supported range");
    }
    Object nextRecording = null;
    try {
      nextRecording = newRecording(normalizedConfiguration);
      recordingType
          .getMethod("setName", String.class)
          .invoke(nextRecording, normalizedRecordingName);
      recordingType.getMethod("setToDisk", boolean.class).invoke(nextRecording, true);
      if (requestedMaxAgeMillis > 0L) {
        recordingType
            .getMethod("setMaxAge", Duration.class)
            .invoke(nextRecording, Duration.ofMillis(requestedMaxAgeMillis));
      }
      if (requestedMaxSizeBytes > 0L) {
        recordingType
            .getMethod("setMaxSize", long.class)
            .invoke(nextRecording, requestedMaxSizeBytes);
      }
      recordingType.getMethod("start").invoke(nextRecording);
      long nextRecordingId =
          ((Long) recordingType.getMethod("getId").invoke(nextRecording)).longValue();
      recording = nextRecording;
      taskId = UUID.randomUUID().toString();
      startedAtEpochMillis = System.currentTimeMillis();
      recordingId = nextRecordingId;
      recordingName = normalizedRecordingName;
      configuration = normalizedConfiguration;
      maxAgeMillis = requestedMaxAgeMillis;
      maxSizeBytes = requestedMaxSizeBytes;
      return taskId;
    } catch (ReflectiveOperationException exception) {
      closeRecording(nextRecording);
      throw new IllegalStateException("Unable to start JFR recording", unwrap(exception));
    }
  }

  private Object newRecording(String requestedConfiguration)
      throws ReflectiveOperationException {
    Class<?> configurationType = Class.forName("jdk.jfr.Configuration");
    Object configuration =
        configurationType
            .getMethod("getConfiguration", String.class)
            .invoke(null, requestedConfiguration.toLowerCase(java.util.Locale.ROOT));
    @SuppressWarnings("unchecked")
    Map<String, String> settings =
        (Map<String, String>)
            configurationType.getMethod("getSettings").invoke(configuration);
    if (settings == null || settings.isEmpty()) {
      throw new IllegalStateException("JFR configuration is empty");
    }
    Map<String, String> tanweiSettings = new HashMap<>(settings);
    tanweiSettings.put(
        COMPILATION_THRESHOLD_SETTING, COMPILATION_THRESHOLD);
    return recordingType
        .getConstructor(Map.class)
        .newInstance(tanweiSettings);
  }

  synchronized ArtifactInfo stop() {
    if (recording == null) {
      throw new IllegalStateException("No Tanwei JFR recording is running");
    }
    Path output = artifacts.allocatePath(".jfr");
    Object current = recording;
    String currentRecordingName = recordingName;
    clearCurrentRecording();
    try {
      recordingType.getMethod("stop").invoke(current);
      recordingType.getMethod("dump", Path.class).invoke(current, output);
      recordingType.getMethod("close").invoke(current);
      String token = artifacts.register(output);
      return new ArtifactInfo(
          token,
          artifactName(currentRecordingName, "-"),
          Files.size(output));
    } catch (Exception exception) {
      closeRecording(current);
      try {
        Files.deleteIfExists(output);
      } catch (Exception ignored) {
        // The primary JFR failure is retained.
      }
      throw new IllegalStateException("Unable to stop and dump JFR recording", unwrap(exception));
    }
  }

  synchronized ArtifactInfo dump() {
    if (recording == null) {
      throw new IllegalStateException("No Tanwei JFR recording is running");
    }
    return dumpRecording(
        recording, artifactStem(recordingName) + "-snapshot-");
  }

  private ArtifactInfo dumpRecording(Object current, String namePrefix) {
    Path output = artifacts.allocatePath(".jfr");
    try {
      recordingType.getMethod("dump", Path.class).invoke(current, output);
      if (!Files.isRegularFile(output) || Files.size(output) <= 0L) {
        throw new IllegalStateException("JFR did not create a recording artifact");
      }
      String token = artifacts.register(output);
      return new ArtifactInfo(
          token,
          namePrefix + System.currentTimeMillis() + ".jfr",
          Files.size(output));
    } catch (Exception exception) {
      try {
        Files.deleteIfExists(output);
      } catch (Exception ignored) {
        // The primary JFR failure is retained.
      }
      throw new IllegalStateException("Unable to dump JFR recording", unwrap(exception));
    }
  }

  synchronized boolean isRunning() {
    return recording != null;
  }

  synchronized String currentTaskId() {
    return taskId == null ? "" : taskId;
  }

  synchronized long startedAtEpochMillis() {
    return startedAtEpochMillis;
  }

  synchronized long currentRecordingId() {
    return recordingId;
  }

  synchronized String currentRecordingName() {
    return recordingName;
  }

  synchronized String currentConfiguration() {
    return configuration;
  }

  synchronized long currentMaxAgeMillis() {
    return maxAgeMillis;
  }

  synchronized long currentMaxSizeBytes() {
    return maxSizeBytes;
  }

  @Override
  public synchronized void close() {
    if (recording != null) {
      closeRecording(recording);
      clearCurrentRecording();
    }
  }

  private void closeRecording(Object value) {
    if (value == null || recordingType == null) {
      return;
    }
    try {
      Method close = recordingType.getMethod("close");
      close.invoke(value);
    } catch (Exception ignored) {
      // Shutdown cannot recover a failed JFR close.
    }
  }

  private static Class<?> findRecordingType() {
    try {
      return Class.forName("jdk.jfr.Recording");
    } catch (ClassNotFoundException ignored) {
      return null;
    }
  }

  private static String normalizeConfiguration(String value) {
    String normalized =
        value == null ? "PROFILE" : value.trim().toUpperCase(java.util.Locale.ROOT);
    if (!"PROFILE".equals(normalized) && !"DEFAULT".equals(normalized)) {
      throw new IllegalArgumentException("Unsupported JFR configuration");
    }
    return normalized;
  }

  private static String normalizeRecordingName(String value) {
    String normalized = value == null ? DEFAULT_RECORDING_NAME : value.trim();
    if (normalized.isEmpty()
        || normalized.length() > MAXIMUM_RECORDING_NAME_LENGTH) {
      throw new IllegalArgumentException(
          "JFR recording name is outside the supported range");
    }
    for (int index = 0; index < normalized.length(); index++) {
      if (Character.isISOControl(normalized.charAt(index))) {
        throw new IllegalArgumentException(
            "JFR recording name contains a control character");
      }
    }
    return normalized;
  }

  private static String artifactName(String name, String infix) {
    return artifactStem(name)
        + infix
        + System.currentTimeMillis()
        + ".jfr";
  }

  private static String artifactStem(String name) {
    StringBuilder result = new StringBuilder();
    String source = name == null ? "" : name;
    for (int index = 0; index < source.length() && result.length() < 64; index++) {
      char value = source.charAt(index);
      result.append(
          Character.isLetterOrDigit(value) || value == '-' || value == '_'
              ? value
              : '_');
    }
    return result.length() == 0 ? "tanwei-recording" : result.toString();
  }

  private void clearCurrentRecording() {
    recording = null;
    taskId = null;
    startedAtEpochMillis = 0L;
    recordingId = 0L;
    recordingName = "";
    configuration = "";
    maxAgeMillis = 0L;
    maxSizeBytes = 0L;
  }

  private static Throwable unwrap(Exception exception) {
    return exception instanceof InvocationTargetException
        ? ((InvocationTargetException) exception).getTargetException()
        : exception;
  }

  static final class ArtifactInfo {
    private final String token;
    private final String name;
    private final long size;

    private ArtifactInfo(String token, String name, long size) {
      this.token = token;
      this.name = name;
      this.size = size;
    }

    String getToken() {
      return token;
    }

    String getName() {
      return name;
    }

    long getSize() {
      return size;
    }
  }
}
