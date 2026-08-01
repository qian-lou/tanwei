package dev.tanwei.agent;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

final class EnvironmentExplorer {
  static final int MAXIMUM_QUERY_LENGTH = 128;
  static final int MAXIMUM_PAGE_SIZE = 200;
  static final int MAXIMUM_OFFSET = 10_000;
  private static final int MAXIMUM_KEY_LENGTH = 512;
  private static final int MAXIMUM_VALUE_LENGTH = 4_096;
  private static final Pattern CONTROL_CHARACTERS =
      Pattern.compile("[\\x00-\\x1f\\x7f]");
  private static final Pattern SENSITIVE_KEY =
      Pattern.compile(
          "(?:^|[_.-])(?:password|passwd|pwd|secret|token|credential|credentials|api[_-]?key|private[_-]?key|access[_-]?key|session|cookie|auth|authorization|connection[_-]?string)(?:$|[_.-])");
  private static final Set<String> VISIBLE_KEYS =
      Collections.unmodifiableSet(
          new HashSet<String>(
              Arrays.asList(
                  "JAVA_HOME",
                  "JRE_HOME",
                  "JDK_HOME",
                  "CLASSPATH",
                  "PATH",
                  "LANG",
                  "LC_ALL",
                  "TZ",
                  "SHELL",
                  "USER",
                  "LOGNAME",
                  "HOME",
                  "PWD",
                  "OLDPWD",
                  "TMPDIR",
                  "TMP",
                  "TEMP",
                  "HOSTNAME",
                  "HOST",
                  "TERM",
                  "COLORTERM",
                  "TERM_PROGRAM",
                  "TERM_PROGRAM_VERSION",
                  "XDG_DATA_HOME",
                  "XDG_CONFIG_HOME",
                  "XDG_CACHE_HOME",
                  "MAVEN_HOME",
                  "M2_HOME",
                  "GRADLE_HOME")));

  Result list(
      Map<String, String> environment,
      String query,
      Category category,
      int offset,
      int limit) {
    if (environment == null) {
      throw new IllegalArgumentException("environment is required");
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

    List<Entry> matched = new ArrayList<Entry>(environment.size());
    int visible = 0;
    int masked = 0;
    int invalid = 0;
    for (Map.Entry<String, String> item : environment.entrySet()) {
      String key = item.getKey();
      String value = item.getValue();
      if (!validKey(key) || value == null) {
        invalid++;
        continue;
      }
      String normalizedKey = key.toUpperCase(Locale.ROOT);
      boolean revealed = isVisibleKey(normalizedKey);
      if (revealed) {
        visible++;
      } else {
        masked++;
      }
      Category actualCategory = categorize(normalizedKey);
      if ((category != Category.ALL && category != actualCategory)
          || (!normalizedQuery.isEmpty()
              && !normalizedKey.contains(normalizedQuery))) {
        continue;
      }
      boolean truncated = revealed && value.length() > MAXIMUM_VALUE_LENGTH;
      String rendered =
          revealed
              ? truncate(value)
              : "<masked>";
      matched.add(
          new Entry(
              key,
              rendered,
              actualCategory,
              revealed ? Visibility.VISIBLE : Visibility.MASKED,
              value.length(),
              truncated));
    }
    matched.sort(
        Comparator.comparing(Entry::getKey, String.CASE_INSENSITIVE_ORDER)
            .thenComparing(Entry::getKey));
    int from = Math.min(offset, matched.size());
    int to = Math.min(from + limit, matched.size());
    return new Result(
        environment.size(),
        visible,
        masked,
        invalid,
        matched.size(),
        from,
        limit,
        new ArrayList<Entry>(matched.subList(from, to)));
  }

  private static String normalizeQuery(String query) {
    String normalized = query == null ? "" : query.trim();
    if (normalized.length() > MAXIMUM_QUERY_LENGTH
        || CONTROL_CHARACTERS.matcher(normalized).find()) {
      throw new IllegalArgumentException("query is outside the allowed range");
    }
    return normalized.toUpperCase(Locale.ROOT);
  }

  private static boolean validKey(String key) {
    return key != null
        && !key.isEmpty()
        && key.length() <= MAXIMUM_KEY_LENGTH
        && !CONTROL_CHARACTERS.matcher(key).find();
  }

  private static boolean isVisibleKey(String normalizedKey) {
    if ("PWD".equals(normalizedKey)) {
      return true;
    }
    String sensitiveCandidate = normalizedKey.toLowerCase(Locale.ROOT);
    return !SENSITIVE_KEY.matcher(sensitiveCandidate).find()
        && (VISIBLE_KEYS.contains(normalizedKey)
            || normalizedKey.startsWith("LC_"));
  }

  private static Category categorize(String normalizedKey) {
    if (normalizedKey.contains("JAVA")
        || normalizedKey.contains("JDK")
        || normalizedKey.contains("JRE")
        || normalizedKey.contains("CLASSPATH")
        || normalizedKey.contains("MAVEN")
        || normalizedKey.contains("GRADLE")) {
      return Category.JAVA;
    }
    if (normalizedKey.contains("PATH")
        || normalizedKey.endsWith("HOME")
        || "PWD".equals(normalizedKey)
        || "OLDPWD".equals(normalizedKey)
        || normalizedKey.contains("TMP")
        || normalizedKey.contains("TEMP")) {
      return Category.PATH;
    }
    if ("LANG".equals(normalizedKey)
        || "TZ".equals(normalizedKey)
        || normalizedKey.startsWith("LC_")) {
      return Category.LOCALE;
    }
    if (normalizedKey.contains("USER")
        || normalizedKey.contains("SHELL")
        || normalizedKey.contains("HOST")
        || normalizedKey.contains("TERM")
        || normalizedKey.contains("PROCESS")) {
      return Category.PROCESS;
    }
    return Category.OTHER;
  }

  private static String truncate(String value) {
    return value.length() <= MAXIMUM_VALUE_LENGTH
        ? value
        : value.substring(0, MAXIMUM_VALUE_LENGTH) + "…";
  }

  enum Category {
    ALL,
    JAVA,
    PATH,
    LOCALE,
    PROCESS,
    OTHER
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

    private Entry(
        String key,
        String value,
        Category category,
        Visibility visibility,
        int valueLength,
        boolean truncated) {
      this.key = key;
      this.value = value;
      this.category = category;
      this.visibility = visibility;
      this.valueLength = valueLength;
      this.truncated = truncated;
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
  }

  static final class Result {
    private final int environmentCount;
    private final int visibleCount;
    private final int maskedCount;
    private final int invalidCount;
    private final int total;
    private final int offset;
    private final int limit;
    private final List<Entry> entries;

    private Result(
        int environmentCount,
        int visibleCount,
        int maskedCount,
        int invalidCount,
        int total,
        int offset,
        int limit,
        List<Entry> entries) {
      this.environmentCount = environmentCount;
      this.visibleCount = visibleCount;
      this.maskedCount = maskedCount;
      this.invalidCount = invalidCount;
      this.total = total;
      this.offset = offset;
      this.limit = limit;
      this.entries = Collections.unmodifiableList(new ArrayList<Entry>(entries));
    }

    int getEnvironmentCount() {
      return environmentCount;
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
