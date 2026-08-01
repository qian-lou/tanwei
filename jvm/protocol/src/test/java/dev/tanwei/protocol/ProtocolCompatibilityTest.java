package dev.tanwei.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import org.junit.jupiter.api.Test;

final class ProtocolCompatibilityTest {

  @Test
  void matchesTheSharedJavaAndTypeScriptGoldenVectors() throws IOException {
    List<String> rows =
        Files.readAllLines(findGoldenVectors(), StandardCharsets.UTF_8);
    for (String row : rows) {
      if (row.isEmpty() || row.startsWith("#")) {
        continue;
      }
      String[] columns = row.split("\\t", -1);
      assertEquals(4, columns.length, row);
      String client = "<missing>".equals(columns[0]) ? null : columns[0];
      String agent = "<missing>".equals(columns[1]) ? null : columns[1];
      boolean compatible = Boolean.parseBoolean(columns[2]);
      String expectedError = "-".equals(columns[3]) ? null : columns[3];

      assertEquals(compatible, ProtocolCompatibility.isCompatible(client, agent), row);
      assertEquals(expectedError, ProtocolCompatibility.compatibilityError(client, agent), row);
    }
  }

  private static Path findGoldenVectors() {
    Path current = Paths.get("").toAbsolutePath();
    while (current != null) {
      Path candidate = current.resolve("contracts/protocol-compatibility-v1.tsv");
      if (Files.isRegularFile(candidate)) {
        return candidate;
      }
      current = current.getParent();
    }
    throw new IllegalStateException("Cannot locate protocol compatibility golden vectors");
  }
}
