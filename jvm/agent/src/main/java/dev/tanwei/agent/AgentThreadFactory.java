package dev.tanwei.agent;

import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

final class AgentThreadFactory implements ThreadFactory {
  private final String prefix;
  private final AtomicInteger sequence = new AtomicInteger();

  AgentThreadFactory(String prefix) {
    this.prefix = prefix;
  }

  @Override
  public Thread newThread(Runnable runnable) {
    Thread thread = new Thread(runnable, prefix + '-' + sequence.incrementAndGet());
    thread.setDaemon(true);
    thread.setUncaughtExceptionHandler(
        (ignored, error) ->
            System.err.println("[tanwei-agent] Uncaught task error: " + error.getClass().getName()));
    return thread;
  }
}
