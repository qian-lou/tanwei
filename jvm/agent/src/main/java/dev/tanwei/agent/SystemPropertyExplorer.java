package dev.tanwei.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

final class SystemPropertyExplorer {
  static final int MAXIMUM_QUERY_LENGTH = 128;
  static final int MAXIMUM_PAGE_SIZE = 200;
  static final int MAXIMUM_OFFSET = 10_000;
  static final int MAXIMUM_SCANNED_PROPERTIES = 20_000;
  private static final int MAXIMUM_KEY_LENGTH = 512;
  private static final int MAXIMUM_VALUE_LENGTH = 4_096;
  private static final Pattern CONTROL_CHARACTERS =
      Pattern.compile("[\\x00-\\x1f\\x7f]");
  private static final Pattern SAFE_MUTATION_KEY =
      Pattern.compile("[A-Za-z0-9_.-]{1,256}");
  private static final Pattern SENSITIVE_BOUNDARY =
      Pattern.compile(
          "(?:^|[_.-])(?:api[_-]?key|private[_-]?key|access[_-]?key|session|cookie|auth|authorization|connection[_-]?string)(?:$|[_.-])");

  Result list(
      Map<?, ?> properties,
      String query,
      Category category,
      int offset,
      int limit) {
    if (properties == null) {
      throw new IllegalArgumentException("properties are required");
    }
    String normalizedQuery = normalizeQuery(query);
    if (category == null) {
      throw new IllegalArgumentException("category is required");
    }
    if (offset < 0 || offset > MAXIMUM_OFFSET) {
      throw new IllegalArgumentException("offset is outside the allowed range");
    }
    if (limit < 1 || limit > MAXIMUM_PAGE_SIZE) {
      throw new IllegalArgumentException("limit is outside the allowed range");
    }

    int propertyCount = properties.size();
    int initialCapacity = Math.min(propertyCount, MAXIMUM_SCANNED_PROPERTIES);
    List<Entry> matched = new ArrayList<Entry>(initialCapacity);
    int scanned = 0;
    int visible = 0;
    int masked = 0;
    int invalid = 0;
    for (Map.Entry<?, ?> item : properties.entrySet()) {
      if (scanned >= MAXIMUM_SCANNED_PROPERTIES) {
        break;
      }
      scanned++;
      if (!(item.getKey() instanceof String)
          || !(item.getValue() instanceof String)) {
        invalid++;
        continue;
      }
      String key = (String) item.getKey();
      String value = (String) item.getValue();
      if (!validKey(key)) {
        invalid++;
        continue;
      }
      boolean revealed = !isSensitiveKey(key);
      if (revealed) {
        visible++;
      } else {
        masked++;
      }
      String normalizedKey = key.toLowerCase(Locale.ROOT);
      Category actualCategory = categorize(normalizedKey);
      if ((category != Category.ALL && category != actualCategory)
          || (!normalizedQuery.isEmpty()
              && !normalizedKey.contains(normalizedQuery))) {
        continue;
      }
      boolean truncated = revealed && value.length() > MAXIMUM_VALUE_LENGTH;
      matched.add(
          new Entry(
              key,
              revealed ? truncate(value) : "<masked>",
              actualCategory,
              revealed ? Visibility.VISIBLE : Visibility.MASKED,
              value.length(),
              truncated,
              revealed
                  && !truncated
                  && SAFE_MUTATION_KEY.matcher(key).matches()));
    }
    matched.sort(
        Comparator.comparing(Entry::getKey, String.CASE_INSENSITIVE_ORDER)
            .thenComparing(Entry::getKey));
    int from = Math.min(offset, matched.size());
    int to = Math.min(from + limit, matched.size());
    return new Result(
        propertyCount,
        scanned,
        visible,
        masked,
        invalid,
        propertyCount > scanned,
        matched.size(),
        from,
        limit,
        new ArrayList<Entry>(matched.subList(from, to)));
  }

  static boolean isSensitiveKey(String key) {
    if (key == null) {
      return true;
    }
    String normalized = key.toLowerCase(Locale.ROOT);
    return normalized.contains("password")
        || normalized.contains("passwd")
        || normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("credential")
        || SENSITIVE_BOUNDARY.matcher(normalized).find()
        || normalized.endsWith(".key")
        || normalized.endsWith("_key")
        || normalized.endsWith("-key");
  }

  private static String normalizeQuery(String query) {
    String normalized = query == null ? "" : query.trim();
    if (normalized.length() > MAXIMUM_QUERY_LENGTH
        || CONTROL_CHARACTERS.matcher(normalized).find()) {
      throw new IllegalArgumentException("query is outside the allowed range");
    }
    return normalized.toLowerCase(Locale.ROOT);
  }

  private static boolean validKey(String key) {
    return !key.isEmpty()
        && key.length() <= MAXIMUM_KEY_LENGTH
        && !CONTROL_CHARACTERS.matcher(key).find();
  }

  private static Category categorize(String normalizedKey) {
    if (normalizedKey.endsWith(".path")
        || normalizedKey.endsWith(".dirs")
        || normalizedKey.endsWith(".dir")
        || normalizedKey.endsWith(".home")
        || normalizedKey.contains("library.path")) {
      return Category.PATH;
    }
    if (normalizedKey.startsWith("java.vm.")
        || normalizedKey.startsWith("java.runtime.")
        || normalizedKey.startsWith("java.specification.")
        || normalizedKey.startsWith("jdk.")
        || normalizedKey.startsWith("sun.")
        || normalizedKey.startsWith("com.sun.")) {
      return Category.VM;
    }
    if (normalizedKey.startsWith("java.")
        || normalizedKey.startsWith("javax.")) {
      return Category.JAVA;
    }
    if (normalizedKey.startsWith("os.")
        || normalizedKey.startsWith("file.")
        || "line.separator".equals(normalizedKey)) {
      return Category.OS;
    }
    if (normalizedKey.startsWith("user.")) {
      return Category.USER;
    }
    return Category.APPLICATION;
  }

  private static String truncate(String value) {
    return value.length() <= MAXIMUM_VALUE_LENGTH
        ? value
        : value.substring(0, MAXIMUM_VALUE_LENGTH) + "…";
  }

  enum Category {
    ALL,
    JAVA,
    VM,
    OS,
    USER,
    PATH,
    APPLICATION
  }

  enum Visibility {
    VISIBLE,
    MASKED
  }

  static final class Entry {
    private final String key;
    private final String value;
    private final Category category;
    private final Visibility visibility;
    private final int valueLength;
    private final boolean truncated;
    private final boolean mutable;

    private Entry(
        String key,
        String value,
        Category category,
        Visibility visibility,
        int valueLength,
        boolean truncated,
        boolean mutable) {
      this.key = key;
      this.value = value;
      this.category = category;
      this.visibility = visibility;
      this.valueLength = valueLength;
      this.truncated = truncated;
      this.mutable = mutable;
    }

    String getKey() {
      return key;
    }

    String getValue() {
      return value;
    }

    Category getCategory() {
      return category;
    }

    Visibility getVisibility() {
      return visibility;
    }

    int getValueLength() {
      return valueLength;
    }

    boolean isTruncated() {
      return truncated;
    }

    boolean isMutable() {
      return mutable;
    }
  }

  static final class Result {
    private final int propertyCount;
    private final int scannedCount;
    private final int visibleCount;
    private final int maskedCount;
    private final int invalidCount;
    private final boolean sourceTruncated;
    private final int total;
    private final int offset;
    private final int limit;
    private final List<Entry> entries;

    private Result(
        int propertyCount,
        int scannedCount,
        int visibleCount,
        int maskedCount,
        int invalidCount,
        boolean sourceTruncated,
        int total,
        int offset,
        int limit,
        List<Entry> entries) {
      this.propertyCount = propertyCount;
      this.scannedCount = scannedCount;
      this.visibleCount = visibleCount;
      this.maskedCount = maskedCount;
      this.invalidCount = invalidCount;
      this.sourceTruncated = sourceTruncated;
      this.total = total;
      this.offset = offset;
      this.limit = limit;
      this.entries = Collections.unmodifiableList(new ArrayList<Entry>(entries));
    }

    int getPropertyCount() {
      return propertyCount;
    }

    int getScannedCount() {
      return scannedCount;
    }

    int getVisibleCount() {
      return visibleCount;
    }

    int getMaskedCount() {
      return maskedCount;
    }

    int getInvalidCount() {
      return invalidCount;
    }

    boolean isSourceTruncated() {
      return sourceTruncated;
    }

    int getTotal() {
      return total;
    }

    int getOffset() {
      return offset;
    }

    int getLimit() {
      return limit;
    }

    List<Entry> getEntries() {
      return entries;
    }
  }
}
