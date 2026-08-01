package dev.tanwei.agent;

import dev.tanwei.protocol.v1.ThreadDescriptor;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.PriorityQueue;

final class ThreadPageSelector {
  static final Comparator<ThreadDescriptor> BEST_FIRST =
      Comparator.comparingLong(ThreadDescriptor::getCpuTimeNanos)
          .reversed()
          .thenComparingLong(ThreadDescriptor::getId);

  private final int offset;
  private final int limit;
  private final int retainedLimit;
  private final PriorityQueue<ThreadDescriptor> retained;
  private int total;

  ThreadPageSelector(int offset, int limit, int maximumCandidates) {
    if (offset < 0 || limit < 1 || maximumCandidates < 0) {
      throw new IllegalArgumentException("Thread page bounds are invalid");
    }
    this.offset = offset;
    this.limit = limit;
    long requestedWindow = (long) offset + (long) limit;
    this.retainedLimit =
        (int) Math.min((long) maximumCandidates, requestedWindow);
    this.retained =
        new PriorityQueue<ThreadDescriptor>(
            Math.max(1, retainedLimit), BEST_FIRST.reversed());
  }

  /**
   * Keeps the best K rows while scanning T matches.
   *
   * <p>Time: O(log K) per candidate and O(T log K) overall. Space: O(K).
   */
  void accept(ThreadDescriptor descriptor) {
    Objects.requireNonNull(descriptor, "descriptor");
    total += 1;
    if (retainedLimit == 0) {
      return;
    }
    if (retained.size() < retainedLimit) {
      retained.add(descriptor);
      return;
    }
    ThreadDescriptor worst = retained.peek();
    if (worst != null && BEST_FIRST.compare(descriptor, worst) < 0) {
      retained.poll();
      retained.add(descriptor);
    }
  }

  int retainedCount() {
    return retained.size();
  }

  Page finish() {
    List<ThreadDescriptor> ordered =
        new ArrayList<ThreadDescriptor>(retained);
    ordered.sort(BEST_FIRST);
    int fromIndex = Math.min(offset, ordered.size());
    int toIndex = Math.min(ordered.size(), fromIndex + limit);
    List<ThreadDescriptor> page =
        new ArrayList<ThreadDescriptor>(ordered.subList(fromIndex, toIndex));
    return new Page(total, Collections.unmodifiableList(page));
  }

  static final class Page {
    private final int total;
    private final List<ThreadDescriptor> threads;

    private Page(int total, List<ThreadDescriptor> threads) {
      this.total = total;
      this.threads = threads;
    }

    int getTotal() {
      return total;
    }

    List<ThreadDescriptor> getThreads() {
      return threads;
    }
  }
}
