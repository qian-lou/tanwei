package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

final class ArthasEcosystemManifestTest {
  @Test
  void publishesTheCompleteArthas432RuntimeCommandBaseline() {
    Set<String> expected =
        new HashSet<String>(
            Arrays.asList(
                "auth", "base64", "bg", "cat", "classloader",
                "classloader-metaspace", "cls", "dashboard", "dump", "echo",
                "exit", "fg", "getstatic", "grep", "heapdump", "help", "history",
                "jad", "jfr", "jobs", "july", "jvm", "keymap", "kill", "line",
                "logger", "mbean", "mc", "memory", "monitor", "ognl",
                "options", "perfcounter", "plaintext", "profiler", "pwd",
                "quit", "redefine", "reset", "retransform", "sc", "session",
                "sm", "stack", "stop", "sysenv", "sysprop", "tee", "thanks", "thread",
                "trace", "tt", "version", "vmoption", "vmtool", "watch", "wc"));
    Set<String> actual = new HashSet<String>();
    for (ArthasEcosystemManifest.Entry entry : ArthasEcosystemManifest.commands()) {
      assertEquals(ArthasEcosystemManifest.COMMAND_SCOPE, entry.getScope());
      assertTrue(actual.add(entry.getCommand()));
      assertTrue(entry.getBoundary().length() <= 512);
    }

    assertEquals("4.3.2", ArthasEcosystemManifest.BASELINE_VERSION);
    assertEquals(57, ArthasEcosystemManifest.commands().size());
    assertEquals(expected, actual);
  }

  @Test
  void publishesUniqueBoundedEcosystemMappingsAndLegacyAlias() {
    Set<String> commands = new HashSet<String>();
    for (ArthasEcosystemManifest.Entry entry : ArthasEcosystemManifest.all()) {
      assertTrue(commands.add(entry.getCommand()));
      assertTrue(entry.getBoundary().length() <= 512);
    }
    assertEquals(9, ArthasEcosystemManifest.ecosystem().size());
    assertEquals("SAFE_SUBSET", ArthasEcosystemManifest.resolve("WATCH").getCompatibility());
    assertEquals("COMMAND", ArthasEcosystemManifest.resolve("memory").getScope());
    assertEquals("ECOSYSTEM", ArthasEcosystemManifest.resolve("mcp-server").getScope());
    assertNotNull(ArthasEcosystemManifest.resolve("telnet/http-api"));
    assertNull(ArthasEcosystemManifest.resolve("unknown"));
  }
}
