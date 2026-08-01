package dev.tanwei.agent;

import java.lang.instrument.Instrumentation;

public final class RuntimeEntrypoint {
  private static final Object LIFECYCLE_LOCK = new Object();
  private static AgentRuntime runtime;

  private RuntimeEntrypoint() {}

  public static void start(String arguments, Instrumentation instrumentation) {
    AgentConfiguration configuration = AgentConfiguration.parse(arguments);
    synchronized (LIFECYCLE_LOCK) {
      stopLocked();
      try {
        runtime =
            new AgentRuntime(
                instrumentation,
                configuration,
                RuntimeEntrypoint::stop);
        System.out.println("[tanwei-agent] Listening on loopback port " + runtime.getPort());
      } catch (Exception exception) {
        runtime = null;
        throw new IllegalStateException("Unable to start Tanwei Agent", exception);
      }
    }
  }

  public static void stop() {
    synchronized (LIFECYCLE_LOCK) {
      stopLocked();
    }
  }

  private static void stopLocked() {
    if (runtime != null) {
      runtime.close();
      runtime = null;
    }
  }
}
