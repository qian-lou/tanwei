package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class TracePathFilterTest {

  @Test
  void appliesIncludeAndExcludeRulesWithExcludePrecedence() {
    TracePathFilter filter =
        TracePathFilter.parse(
            "dev.tanwei.example.service.*\n"
                + "dev.tanwei.example.Repository#load",
            "dev.tanwei.example.service.InternalService\n"
                + "dev.tanwei.example.Repository#load",
            "dev.tanwei.example");

    assertTrue(
        filter.matches(
            "dev.tanwei.example.service.OrderService", "submit"));
    assertFalse(
        filter.matches(
            "dev.tanwei.example.service.InternalService", "submit"));
    assertFalse(
        filter.matches("dev.tanwei.example.Repository", "load"));
    assertFalse(
        filter.matches("dev.tanwei.example.Repository", "save"));
  }

  @Test
  void emptyIncludeRulesAllowEveryPathInsideTheResolvedScope() {
    TracePathFilter filter =
        TracePathFilter.parse(
            "",
            "dev.tanwei.example.SecretService#read",
            "dev.tanwei.example");

    assertTrue(filter.matches("dev.tanwei.example.OrderService", "submit"));
    assertFalse(
        filter.matches("dev.tanwei.example.SecretService", "read"));
  }

  @Test
  void canonicalizesWhitespaceBlankLinesAndDuplicateRules() {
    TracePathFilter filter =
        TracePathFilter.parse(
            "\n dev.tanwei.example.OrderService#submit \n"
                + "dev.tanwei.example.OrderService#submit\n",
            "",
            "dev.tanwei.example");

    assertEquals(
        "dev.tanwei.example.OrderService#submit",
        filter.getIncludeRulesText());
    assertEquals("", filter.getExcludeRulesText());
  }

  @Test
  void rejectsInvalidOrOutOfScopeRules() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            TracePathFilter.parse(
                "dev.other.Service", "", "dev.tanwei.example"));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            TracePathFilter.parse(
                "dev.tanwei.example.*#submit",
                "",
                "dev.tanwei.example"));
  }
}
