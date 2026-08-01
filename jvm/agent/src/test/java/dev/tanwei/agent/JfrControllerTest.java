package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

final class JfrControllerTest {
  @Test
  void recordsTheJdkProfileConfigurationInsteadOfAnEmptyRecording()
      throws Exception {
    Assumptions.assumeTrue(
        isPresent("jdk.jfr.Recording")
            && isPresent("jdk.jfr.consumer.RecordingFile"));
    try (AgentArtifactRegistry artifacts = new AgentArtifactRegistry()) {
      JfrController controller = new JfrController(artifacts);
      assertTrue(controller.isAvailable());
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.start("PROFILE", 0L, 0L, " "));
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.start("PROFILE", 0L, 0L, "unsafe\nname"));
      controller.start(
          "PROFILE", 60_000L, 1_048_576L, "checkout-profile");
      assertEquals("PROFILE", controller.currentConfiguration());
      assertEquals("checkout-profile", controller.currentRecordingName());
      assertTrue(controller.currentRecordingId() > 0L);
      assertEquals(60_000L, controller.currentMaxAgeMillis());
      assertEquals(1_048_576L, controller.currentMaxSizeBytes());
      assertEquals(
          "1 ms",
          currentSettings(controller).get("jdk.Compilation#threshold"));
      exerciseApplication();
      Thread.sleep(1_100L);

      JfrController.ArtifactInfo snapshot = controller.dump();
      Path snapshotRecording = artifacts.resolve(snapshot.getToken());
      assertTrue(snapshotRecording != null);
      assertTrue(snapshot.getSize() > 0L);
      assertTrue(snapshot.getName().startsWith("checkout-profile-snapshot-"));
      assertFalse(readEvents(snapshotRecording).isEmpty());
      assertTrue(controller.isRunning());

      JfrController.ArtifactInfo artifact = controller.stop();
      Path recording = artifacts.resolve(artifact.getToken());
      assertTrue(recording != null);
      assertTrue(artifact.getSize() > 0L);
      assertTrue(artifact.getName().startsWith("checkout-profile-"));
      assertFalse(readEvents(recording).isEmpty());
      controller.close();
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, String> currentSettings(
      JfrController controller) throws Exception {
    Field recordingField =
        JfrController.class.getDeclaredField("recording");
    recordingField.setAccessible(true);
    Object recording = recordingField.get(controller);
    Method getSettings = recording.getClass().getMethod("getSettings");
    return (Map<String, String>) getSettings.invoke(recording);
  }

  private static void exerciseApplication() {
    long checksum = 0L;
    for (int index = 0; index < 250_000; index++) {
      checksum += ("tanwei-" + index).hashCode();
    }
    if (checksum == Long.MIN_VALUE) {
      throw new AssertionError("unreachable");
    }
  }

  private static List<?> readEvents(Path recording) throws Exception {
    Class<?> recordingFile =
        Class.forName("jdk.jfr.consumer.RecordingFile");
    Method readAllEvents =
        recordingFile.getMethod("readAllEvents", Path.class);
    return (List<?>) readAllEvents.invoke(null, recording);
  }

  private static boolean isPresent(String className) {
    try {
      Class.forName(className);
      return true;
    } catch (ClassNotFoundException ignored) {
      return false;
    }
  }
}
