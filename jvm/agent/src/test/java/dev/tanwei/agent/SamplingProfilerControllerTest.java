package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import org.junit.jupiter.api.Test;

final class SamplingProfilerControllerTest {
  @Test
  void parsesBoundedUniqueProfilerPatterns() {
    List<String> patterns =
        SamplingProfilerController.parsePatterns(
            "com/example/*\n*Service\ncom/example/*", "includeRules");

    assertEquals(Arrays.asList("com/example/*", "*Service"), patterns);
    assertThrows(
        IllegalArgumentException.class,
        () -> SamplingProfilerController.parsePatterns("com/*/Service", "includeRules"));
    assertThrows(
        IllegalArgumentException.class,
        () -> SamplingProfilerController.parsePatterns("*", "includeRules"));
  }

  @Test
  void appliesIncludeThenExcludeFiltersToCollapsedStacks() {
    String stack = "java.lang.Thread.run;com.example.OrderService.load";

    assertTrue(
        SamplingProfilerController.matchesStackFilters(
            stack,
            Collections.singletonList("com/example/*"),
            Collections.emptyList()));
    assertFalse(
        SamplingProfilerController.matchesStackFilters(
            stack,
            Collections.singletonList("com/example/*"),
            Collections.singletonList("*OrderService.load")));
    assertTrue(
        SamplingProfilerController.matchesStackFilters(
            stack, Collections.emptyList(), Collections.emptyList()));
  }

  @Test
  void dumpsALiveReportWithoutStoppingTheFallbackProfiler() throws Exception {
    ScheduledThreadPoolExecutor scheduler = new ScheduledThreadPoolExecutor(2);
    try (AgentArtifactRegistry artifacts = new AgentArtifactRegistry();
        SamplingProfilerController controller =
            new SamplingProfilerController(scheduler, artifacts, false)) {
      SamplingProfilerController.StartResult started =
          controller.start("WALL", 10L, 2_000L, 64, false, "", "");
      Thread.sleep(100L);

      SamplingProfilerController.Result snapshot =
          controller.dump(started.getTaskId());

      assertEquals("RUNNING", snapshot.getState());
      assertTrue(snapshot.getArtifact() != null);
      Path output = artifacts.resolve(snapshot.getArtifact().getToken());
      assertTrue(output != null && Files.size(output) > 0L);
      assertEquals(
          "RUNNING", controller.status(started.getTaskId()).getState());

      SamplingProfilerController.Result stopped =
          controller.stop(started.getTaskId());
      assertEquals("CANCELLED", stopped.getState());
      assertTrue(stopped.getArtifact() != null);
    } finally {
      scheduler.shutdownNow();
    }
  }
}
