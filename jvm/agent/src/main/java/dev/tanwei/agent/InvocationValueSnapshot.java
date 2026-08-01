package dev.tanwei.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** Immutable, bounded structured evidence for invocation arguments and return values. */
final class InvocationValueSnapshot {
  static final int MAXIMUM_NODES = 96;
  static final int MAXIMUM_SCANNED_FIELDS = 256;
  static final int MAXIMUM_DEPTH = 3;
  private static final int MAXIMUM_TEXT_LENGTH = 257;
  private static final InvocationValueSnapshot EMPTY =
      new InvocationValueSnapshot(
          true, 0, false, Collections.<Node>emptyList());
  private static final InvocationValueSnapshot UNAVAILABLE =
      new InvocationValueSnapshot(
          false, 0, false, Collections.<Node>emptyList());

  private final boolean available;
  private final int scannedFields;
  private final boolean truncated;
  private final List<Node> nodes;

  private InvocationValueSnapshot(
      boolean available,
      int scannedFields,
      boolean truncated,
      List<Node> nodes) {
    this.available = available;
    this.scannedFields = scannedFields;
    this.truncated = truncated;
    this.nodes = Collections.unmodifiableList(new ArrayList<Node>(nodes));
  }

  static InvocationValueSnapshot empty() {
    return EMPTY;
  }

  static InvocationValueSnapshot unavailable() {
    return UNAVAILABLE;
  }

  static InvocationValueSnapshot of(
      boolean available,
      int scannedFields,
      boolean truncated,
      List<String> paths,
      List<Integer> parentIndices,
      List<Integer> depths,
      List<String> kinds,
      List<String> typeNames,
      List<String> values,
      List<Integer> childCounts,
      List<Boolean> nodeTruncated) {
    if (!available) {
      return unavailable();
    }
    int size = requireSameSize(
        paths,
        parentIndices,
        depths,
        kinds,
        typeNames,
        values,
        childCounts,
        nodeTruncated);
    if (size > MAXIMUM_NODES
        || scannedFields < 0
        || scannedFields > MAXIMUM_SCANNED_FIELDS) {
      throw new IllegalArgumentException("Invocation value evidence exceeds its bounds");
    }
    if (size == 0 && scannedFields == 0 && !truncated) {
      return empty();
    }
    List<Node> nodes = new ArrayList<Node>(size);
    for (int index = 0; index < size; index++) {
      String path = paths.get(index);
      Integer parentIndex = parentIndices.get(index);
      Integer depth = depths.get(index);
      String kind = kinds.get(index);
      String typeName = typeNames.get(index);
      String value = values.get(index);
      Integer childCount = childCounts.get(index);
      Boolean truncatedNode = nodeTruncated.get(index);
      if (path == null
          || path.isEmpty()
          || path.length() > MAXIMUM_TEXT_LENGTH
          || parentIndex == null
          || parentIndex.intValue() < -1
          || parentIndex.intValue() >= index
          || depth == null
          || depth.intValue() < 0
          || depth.intValue() > MAXIMUM_DEPTH
          || kind == null
          || !isSupportedKind(kind)
          || typeName == null
          || typeName.length() > MAXIMUM_TEXT_LENGTH
          || value == null
          || value.length() > MAXIMUM_TEXT_LENGTH
          || childCount == null
          || childCount.intValue() < 0
          || truncatedNode == null) {
        throw new IllegalArgumentException("Invocation value node is invalid");
      }
      if (parentIndex.intValue() == -1) {
        if (depth.intValue() != 0) {
          throw new IllegalArgumentException("Invocation value root depth is invalid");
        }
      } else if (nodes.get(parentIndex.intValue()).depth + 1 != depth.intValue()) {
        throw new IllegalArgumentException("Invocation value node hierarchy is invalid");
      }
      nodes.add(
          new Node(
              path,
              parentIndex.intValue(),
              depth.intValue(),
              kind,
              typeName,
              value,
              childCount.intValue(),
              truncatedNode.booleanValue()));
    }
    return new InvocationValueSnapshot(true, scannedFields, truncated, nodes);
  }

  private static int requireSameSize(List<?> first, List<?>... remaining) {
    if (first == null) {
      throw new IllegalArgumentException("Invocation value node lists are required");
    }
    int size = first.size();
    for (List<?> values : remaining) {
      if (values == null || values.size() != size) {
        throw new IllegalArgumentException(
            "Invocation value node lists must have the same size");
      }
    }
    return size;
  }

  private static boolean isSupportedKind(String kind) {
    return "NULL".equals(kind)
        || "SCALAR".equals(kind)
        || "OBJECT".equals(kind)
        || "ARRAY".equals(kind)
        || "COLLECTION".equals(kind)
        || "MAP".equals(kind)
        || "ENTRY".equals(kind)
        || "REFERENCE".equals(kind)
        || "MASKED".equals(kind)
        || "UNAVAILABLE".equals(kind)
        || "OPAQUE".equals(kind);
  }

  boolean matches(String normalizedQuery) {
    if (normalizedQuery == null || normalizedQuery.isEmpty()) {
      return true;
    }
    for (Node node : nodes) {
      if (node.path.toLowerCase(Locale.ROOT).contains(normalizedQuery)
          || node.typeName.toLowerCase(Locale.ROOT).contains(normalizedQuery)
          || node.value.toLowerCase(Locale.ROOT).contains(normalizedQuery)) {
        return true;
      }
    }
    return false;
  }

  long estimatedCharacters() {
    long characters = 0L;
    for (Node node : nodes) {
      characters += node.path.length() + node.typeName.length() + node.value.length();
    }
    return characters;
  }

  boolean isAvailable() {
    return available;
  }

  int getScannedFields() {
    return scannedFields;
  }

  boolean isTruncated() {
    return truncated;
  }

  List<Node> getNodes() {
    return nodes;
  }

  static final class Node {
    private final String path;
    private final int parentIndex;
    private final int depth;
    private final String kind;
    private final String typeName;
    private final String value;
    private final int childCount;
    private final boolean truncated;

    private Node(
        String path,
        int parentIndex,
        int depth,
        String kind,
        String typeName,
        String value,
        int childCount,
        boolean truncated) {
      this.path = path;
      this.parentIndex = parentIndex;
      this.depth = depth;
      this.kind = kind;
      this.typeName = typeName;
      this.value = value;
      this.childCount = childCount;
      this.truncated = truncated;
    }

    String getPath() {
      return path;
    }

    int getParentIndex() {
      return parentIndex;
    }

    int getDepth() {
      return depth;
    }

    String getKind() {
      return kind;
    }

    String getTypeName() {
      return typeName;
    }

    String getValue() {
      return value;
    }

    int getChildCount() {
      return childCount;
    }

    boolean isTruncated() {
      return truncated;
    }
  }
}
