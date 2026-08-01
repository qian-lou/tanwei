package dev.tanwei.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Immutable, bounded scalar-field evidence for one live invocation receiver. */
final class ReceiverStateSnapshot {
  private static final int MAXIMUM_FIELDS = 16;
  private static final int MAXIMUM_SCANNED_FIELDS = 128;
  private static final int MAXIMUM_TEXT_LENGTH = 257;
  private static final ReceiverStateSnapshot EMPTY =
      new ReceiverStateSnapshot(
          true,
          0,
          0,
          false,
          Collections.<FieldValue>emptyList());
  private static final ReceiverStateSnapshot UNAVAILABLE =
      new ReceiverStateSnapshot(
          false,
          0,
          0,
          false,
          Collections.<FieldValue>emptyList());

  private final boolean available;
  private final int scannedFields;
  private final int unavailableFields;
  private final boolean truncated;
  private final List<FieldValue> fields;

  private ReceiverStateSnapshot(
      boolean available,
      int scannedFields,
      int unavailableFields,
      boolean truncated,
      List<FieldValue> fields) {
    this.available = available;
    this.scannedFields = Math.max(0, scannedFields);
    this.unavailableFields = Math.max(0, unavailableFields);
    this.truncated = truncated;
    this.fields =
        Collections.unmodifiableList(new ArrayList<FieldValue>(fields));
  }

  static ReceiverStateSnapshot empty() {
    return EMPTY;
  }

  static ReceiverStateSnapshot unavailable() {
    return UNAVAILABLE;
  }

  static ReceiverStateSnapshot of(
      boolean available,
      int scannedFields,
      int unavailableFields,
      boolean truncated,
      List<String> names,
      List<String> values) {
    if (!available) {
      return unavailable();
    }
    if (names == null || values == null || names.size() != values.size()) {
      throw new IllegalArgumentException(
          "Receiver state names and values must have the same size");
    }
    if (names.size() > MAXIMUM_FIELDS
        || scannedFields < 0
        || scannedFields > MAXIMUM_SCANNED_FIELDS
        || unavailableFields < 0
        || unavailableFields > MAXIMUM_FIELDS) {
      throw new IllegalArgumentException("Receiver state exceeds its bounds");
    }
    if (names.isEmpty()
        && scannedFields == 0
        && unavailableFields == 0
        && !truncated) {
      return empty();
    }
    List<FieldValue> fields = new ArrayList<FieldValue>(names.size());
    for (int index = 0; index < names.size(); index++) {
      String name = names.get(index);
      String value = values.get(index);
      if (name == null
          || name.isEmpty()
          || name.length() > MAXIMUM_TEXT_LENGTH
          || value == null
          || value.length() > MAXIMUM_TEXT_LENGTH) {
        throw new IllegalArgumentException(
            "Receiver state fields must have non-empty names and values");
      }
      fields.add(new FieldValue(name, value));
    }
    return new ReceiverStateSnapshot(
        true,
        scannedFields,
        unavailableFields,
        truncated,
        fields);
  }

  List<Change> changesTo(ReceiverStateSnapshot after) {
    ReceiverStateSnapshot safeAfter =
        after == null ? unavailable() : after;
    if (!available || !safeAfter.available) {
      return Collections.emptyList();
    }
    Map<String, String> remaining = new LinkedHashMap<String, String>();
    for (FieldValue field : safeAfter.fields) {
      remaining.put(field.name, field.value);
    }
    List<Change> changes = new ArrayList<Change>();
    for (FieldValue before : fields) {
      if (!remaining.containsKey(before.name)) {
        changes.add(new Change(before.name, before.value, "", "REMOVED"));
        continue;
      }
      String afterValue = remaining.remove(before.name);
      if (!before.value.equals(afterValue)) {
        changes.add(
            new Change(before.name, before.value, afterValue, "CHANGED"));
      }
    }
    for (Map.Entry<String, String> added : remaining.entrySet()) {
      changes.add(new Change(added.getKey(), "", added.getValue(), "ADDED"));
    }
    return Collections.unmodifiableList(changes);
  }

  boolean isAvailable() {
    return available;
  }

  int getScannedFields() {
    return scannedFields;
  }

  int getUnavailableFields() {
    return unavailableFields;
  }

  boolean isTruncated() {
    return truncated;
  }

  List<FieldValue> getFields() {
    return fields;
  }

  static final class FieldValue {
    private final String name;
    private final String value;

    private FieldValue(String name, String value) {
      this.name = name;
      this.value = value;
    }

    String getName() {
      return name;
    }

    String getValue() {
      return value;
    }
  }

  static final class Change {
    private final String name;
    private final String before;
    private final String after;
    private final String kind;

    private Change(String name, String before, String after, String kind) {
      this.name = name;
      this.before = before;
      this.after = after;
      this.kind = kind;
    }

    String getName() {
      return name;
    }

    String getBefore() {
      return before;
    }

    String getAfter() {
      return after;
    }

    String getKind() {
      return kind;
    }
  }
}
