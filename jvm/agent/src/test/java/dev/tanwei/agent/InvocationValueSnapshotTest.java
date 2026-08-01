package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import org.junit.jupiter.api.Test;

final class InvocationValueSnapshotTest {
  @Test
  void retainsAndSearchesValidatedStructuredNodes() {
    InvocationValueSnapshot snapshot =
        InvocationValueSnapshot.of(
            true,
            2,
            false,
            Arrays.asList("arg[0]", "arg[0].region"),
            Arrays.asList(-1, 0),
            Arrays.asList(0, 1),
            Arrays.asList("OBJECT", "SCALAR"),
            Arrays.asList("example.Payload", "java.lang.String"),
            Arrays.asList("", "eu-west"),
            Arrays.asList(1, 0),
            Arrays.asList(false, false));

    assertTrue(snapshot.isAvailable());
    assertEquals(2, snapshot.getNodes().size());
    assertTrue(snapshot.matches("region"));
    assertTrue(snapshot.matches("eu-west"));
  }

  @Test
  void rejectsMalformedParentHierarchy() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            InvocationValueSnapshot.of(
                true,
                1,
                false,
                Arrays.asList("arg[0]", "arg[0].field"),
                Arrays.asList(-1, 1),
                Arrays.asList(0, 1),
                Arrays.asList("OBJECT", "SCALAR"),
                Arrays.asList("example.Payload", "java.lang.String"),
                Arrays.asList("", "value"),
                Arrays.asList(1, 0),
                Arrays.asList(false, false)));
  }

  @Test
  void acceptsCollectionMapAndEntryKinds() {
    InvocationValueSnapshot snapshot =
        InvocationValueSnapshot.of(
            true,
            0,
            false,
            Arrays.asList(
                "arg[0]", "arg[0][0]", "arg[0][0].key", "result"),
            Arrays.asList(-1, 0, 1, -1),
            Arrays.asList(0, 1, 2, 0),
            Arrays.asList("MAP", "ENTRY", "SCALAR", "COLLECTION"),
            Arrays.asList(
                "java.util.LinkedHashMap",
                "java.util.Map.Entry",
                "java.lang.String",
                "java.util.ArrayList"),
            Arrays.asList("1 entries", "", "region", "0 elements"),
            Arrays.asList(1, 2, 0, 0),
            Arrays.asList(false, false, false, false));

    assertEquals("MAP", snapshot.getNodes().get(0).getKind());
    assertEquals("ENTRY", snapshot.getNodes().get(1).getKind());
    assertEquals("COLLECTION", snapshot.getNodes().get(3).getKind());
    assertTrue(snapshot.matches("region"));
  }
}
