package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

final class AgentConfigurationTest {

  @Test
  void parsesValidArguments() {
    AgentConfiguration configuration =
        AgentConfiguration.parse(
            "port=3658;secret=12345678901234567890123456789012");

    assertEquals(3658, configuration.getPort());
    assertEquals(32, configuration.getSecret().length());
  }

  @Test
  void rejectsShortSecret() {
    assertThrows(
        IllegalArgumentException.class,
        () -> AgentConfiguration.parse("port=3658;secret=short"));
  }
}
