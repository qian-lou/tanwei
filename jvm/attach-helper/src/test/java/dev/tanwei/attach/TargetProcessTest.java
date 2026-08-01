package dev.tanwei.attach;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class TargetProcessTest {

  @Test
  void separatesMainClassAndQuotedArguments() {
    TargetProcess target =
        new TargetProcess(42L, "sample.Main --name \"hello world\"", true, null);

    assertEquals("sample.Main", target.getMainClass());
    assertEquals(2, target.getArguments().size());
    assertEquals("hello world", target.getArguments().get(1));
    assertTrue(target.isAttachable());
  }
}
