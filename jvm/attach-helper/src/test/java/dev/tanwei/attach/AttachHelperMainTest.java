package dev.tanwei.attach;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class AttachHelperMainTest {

  @TempDir Path temporaryDirectory;

  @Test
  void returnsSuccessWhenAgentLoaderCompletes() throws IOException {
    Map<String, String> options = validOptions();

    int exitCode =
        AttachHelperMain.attach(
            options,
            (pid, bootstrapPath, agentArguments) -> assertEquals(42L, pid));

    assertEquals(0, exitCode);
  }

  @Test
  void reportsAgentLoaderFailure() throws IOException {
    Map<String, String> options = validOptions();

    int exitCode =
        AttachHelperMain.attach(
            options,
            (pid, bootstrapPath, agentArguments) -> {
              throw new IOException("failed");
            });

    assertEquals(3, exitCode);
  }

  private Map<String, String> validOptions() throws IOException {
    Path bootstrap = Files.createFile(temporaryDirectory.resolve("bootstrap.jar"));
    Path agent = Files.createFile(temporaryDirectory.resolve("agent.jar"));
    Map<String, String> options = new HashMap<String, String>(8);
    options.put("pid", "42");
    options.put("bootstrap", bootstrap.toString());
    options.put("agent", agent.toString());
    options.put("port", "47881");
    options.put(
        "secret",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    return options;
  }
}
