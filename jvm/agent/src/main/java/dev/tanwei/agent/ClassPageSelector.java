package dev.tanwei.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.PriorityQueue;

final class ClassPageSelector {
  static final Comparator<Selection> BEST_FIRST =
      Comparator.comparing(Selection::getClassName)
          .thenComparingInt(Selection::getSnapshotIndex);

  private final int offset;
  private final int limit;
  private final int retainedLimit;
  private final PriorityQueue<Selection> retained;
  private int total;

  ClassPageSelector(int offset, int limit, int maximumCandidates) {
    if (offset < 0 || limit < 1 || maximumCandidates < 0) {
      throw new IllegalArgumentException("Class page bounds are invalid");
    }
    this.offset = offset;
    this.limit = limit;
    long requestedWindow = (long) offset + (long) limit;
    this.retainedLimit =
        (int) Math.min((long) maximumCandidates, requestedWindow);
    this.retained =
        new PriorityQueue<Selection>(
            Math.max(1, retainedLimit), BEST_FIRST.reversed());
  }

  /**
   * Keeps the lexicographically first K classes without constructing result
   * protobufs for rows outside the requested window.
   *
   * <p>Time: O(log K) per match and O(C log K) overall. Space: O(K).
   */
  void accept(String className, int snapshotIndex) {
    Objects.requireNonNull(className, "className");
    if (snapshotIndex < 0) {
      throw new IllegalArgumentException("snapshotIndex must be non-negative");
    }
    total += 1;
    if (retainedLimit == 0) {
      return;
    }
    Selection candidate = new Selection(className, snapshotIndex);
    if (retained.size() < retainedLimit) {
      retained.add(candidate);
      return;
    }
    Selection worst = retained.peek();
    if (worst != null && BEST_FIRST.compare(candidate, worst) < 0) {
      retained.poll();
      retained.add(candidate);
    }
  }

  int retainedCount() {
    return retained.size();
  }

  Page finish() {
    List<Selection> ordered = new ArrayList<Selection>(retained);
    ordered.sort(BEST_FIRST);
    int fromIndex = Math.min(offset, ordered.size());
    int toIndex = Math.min(ordered.size(), fromIndex + limit);
    List<Selection> page =
        new ArrayList<Selection>(ordered.subList(fromIndex, toIndex));
    return new Page(total, Collections.unmodifiableList(page));
  }

  static final class Selection {
    private final String className;
    private final int snapshotIndex;

    private Selection(String className, int snapshotIndex) {
      this.className = className;
      this.snapshotIndex = snapshotIndex;
    }

    String getClassName() {
      return className;
    }

    int getSnapshotIndex() {
      return snapshotIndex;
    }
  }

  static final class Page {
    private final int total;
    private final List<Selection> selections;

    private Page(int total, List<Selection> selections) {
      this.total = total;
      this.selections = selections;
    }

    int getTotal() {
      return total;
    }

    List<Selection> getSelections() {
      return selections;
    }
  }
}
