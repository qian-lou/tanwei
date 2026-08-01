package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class ThreadDumpControllerTest {
  @Test
  void writesABoundedParseableThreadDump() throws Exception {
    Path output = Files.createTempFile("tanwei-thread-dump-", ".txt");
    try {
      ThreadDumpController.Result result =
          new ThreadDumpController()
              .capture(output, 10_000, 64, true);
      String content =
          new String(
              Files.readAllBytes(output),
              StandardCharsets.UTF_8);

      assertTrue(content.startsWith("Tanwei Thread Dump\n"));
      assertTrue(content.contains("formatVersion=1\n"));
      assertTrue(content.contains("capturedAt="));
      assertTrue(content.contains("jvmStartTimeMillis="));
      assertTrue(content.contains("threadsSeen="));
      assertTrue(content.contains("state="));
      assertTrue(content.contains("    at "));
      assertTrue(result.getThreadsSeen() >= result.getThreadsWritten());
      assertTrue(result.getThreadsWritten() > 0);
      assertEquals(Files.size(output), result.getBytesWritten());
    } finally {
      Files.deleteIfExists(output);
    }
  }

  @Test
  void rejectsUnboundedCaptureRequests() throws Exception {
    Path output = Files.createTempFile("tanwei-thread-dump-", ".txt");
    ThreadDumpController controller =
        new ThreadDumpController();
    try {
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.capture(output, 0, 64, false));
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.capture(output, 10_001, 64, false));
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.capture(output, 100, 0, false));
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.capture(output, 100, 513, false));
    } finally {
      Files.deleteIfExists(output);
    }
  }
}
