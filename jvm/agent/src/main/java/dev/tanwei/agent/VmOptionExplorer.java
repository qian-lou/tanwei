package dev.tanwei.agent;

import java.lang.management.ManagementFactory;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

final class VmOptionExplorer {
  static final int MAXIMUM_QUERY_LENGTH = 128;
  static final int MAXIMUM_PAGE_SIZE = 200;
  static final int MAXIMUM_OFFSET = 10_000;
  static final int MAXIMUM_SCANNED_OPTIONS = 10_000;
  private static final int MAXIMUM_VALUE_LENGTH = 4_096;
  private static final Pattern CONTROL_CHARACTERS =
      Pattern.compile("[\\x00-\\x1f\\x7f]");
  private static final Pattern SAFE_OPTION_NAME =
      Pattern.compile("[A-Za-z][A-Za-z0-9_]{0,127}");

  private final OptionSource source;

  VmOptionExplorer() {
    this(new ReflectionOptionSource());
  }

  VmOptionExplorer(OptionSource source) {
    if (source == null) {
      throw new IllegalArgumentException("source is required");
    }
    this.source = source;
  }

  Result list(
      String query,
      Category category,
      Mutability mutability,
      int offset,
      int limit)
      throws Exception {
    String normalizedQuery = normalizeQuery(query);
    if (category == null || mutability == null) {
      throw new IllegalArgumentException("category and mutability are required");
    }
    if (offset < 0 || offset > MAXIMUM_OFFSET) {
      throw new IllegalArgumentException("offset is outside the allowed range");
    }
    if (limit < 1 || limit > MAXIMUM_PAGE_SIZE) {
      throw new IllegalArgumentException("limit is outside the allowed range");
    }

    SourceSnapshot snapshot = source.load();
    List<Entry> matched = new ArrayList<Entry>(snapshot.options.size());
    int writeable = 0;
    int readOnly = 0;
    int masked = 0;
    for (OptionValue option : snapshot.options) {
      if (option.writeable) {
        writeable++;
      } else {
        readOnly++;
      }
      boolean revealed = !isSensitiveName(option.name);
      if (!revealed) {
        masked++;
      }
      Category actualCategory = categorize(option.name.toLowerCase(Locale.ROOT));
      if ((category != Category.ALL && category != actualCategory)
          || (mutability == Mutability.WRITEABLE && !option.writeable)
          || (mutability == Mutability.READ_ONLY && option.writeable)
          || (!normalizedQuery.isEmpty()
              && !option.name.toLowerCase(Locale.ROOT).contains(normalizedQuery))) {
        continue;
      }
      boolean truncated = revealed && option.value.length() > MAXIMUM_VALUE_LENGTH;
      matched.add(
          new Entry(
              option.name,
              revealed ? truncate(option.value) : "<masked>",
              actualCategory,
              option.origin,
              revealed ? Visibility.VISIBLE : Visibility.MASKED,
              option.writeable,
              option.value.length(),
              truncated,
              option.writeable && revealed && !truncated));
    }
    matched.sort(
        Comparator.comparing(Entry::getName, String.CASE_INSENSITIVE_ORDER)
            .thenComparing(Entry::getName));
    int from = Math.min(offset, matched.size());
    int to = Math.min(from + limit, matched.size());
    return new Result(
        snapshot.optionCount,
        snapshot.scannedCount,
        writeable,
        readOnly,
        masked,
        snapshot.invalidCount,
        snapshot.sourceTruncated,
        matched.size(),
        from,
        limit,
        new ArrayList<Entry>(matched.subList(from, to)));
  }

  static boolean isSensitiveName(String name) {
    if (name == null) {
      return true;
    }
    String normalized = name.toLowerCase(Locale.ROOT);
    return normalized.contains("password")
        || normalized.contains("passwd")
        || normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("credential")
        || "onerror".equals(normalized)
        || "onoutofmemoryerror".equals(normalized);
  }

  private static String normalizeQuery(String query) {
    String normalized = query == null ? "" : query.trim();
    if (normalized.length() > MAXIMUM_QUERY_LENGTH
        || CONTROL_CHARACTERS.matcher(normalized).find()) {
      throw new IllegalArgumentException("query is outside the allowed range");
    }
    return normalized.toLowerCase(Locale.ROOT);
  }

  private static Category categorize(String name) {
    if (name.contains("gc")
        || name.contains("collector")
        || name.contains("mark")
        || name.contains("sweep")
        || name.contains("region")
        || name.contains("pause")) {
      return Category.GC;
    }
    if (name.contains("compile")
        || name.contains("compiler")
        || name.contains("tiered")
        || name.contains("inline")
        || name.contains("codecache")
        || name.contains("jvmci")) {
      return Category.COMPILER;
    }
    if (name.contains("heap")
        || name.contains("metaspace")
        || name.contains("memory")
        || name.contains("tlab")
        || name.contains("survivor")
        || name.contains("tenuring")
        || name.contains("compressed")) {
      return Category.MEMORY;
    }
    if (name.contains("diagnostic")
        || name.contains("debug")
        || name.contains("flightrecorder")
        || name.contains("dump")
        || name.contains("error")
        || name.contains("nativememory")) {
      return Category.DIAGNOSTIC;
    }
    if (name.contains("log")
        || name.contains("trace")
        || name.contains("print")) {
      return Category.LOGGING;
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
    MEMORY,
    GC,
    COMPILER,
    DIAGNOSTIC,
    LOGGING,
    OTHER
  }

  enum Mutability {
    ALL,
    WRITEABLE,
    READ_ONLY
  }

  enum Visibility {
    VISIBLE,
    MASKED
  }

  interface OptionSource {
    SourceSnapshot load() throws Exception;
  }

  static final class OptionValue {
    private final String name;
    private final String value;
    private final boolean writeable;
    private final String origin;

    OptionValue(String name, String value, boolean writeable, String origin) {
      this.name = name;
      this.value = value;
      this.writeable = writeable;
      this.origin = origin;
    }
  }

  static final class SourceSnapshot {
    private final int optionCount;
    private final int scannedCount;
    private final int invalidCount;
    private final boolean sourceTruncated;
    private final List<OptionValue> options;

    SourceSnapshot(
        int optionCount,
        int scannedCount,
        int invalidCount,
        boolean sourceTruncated,
        List<OptionValue> options) {
      if (optionCount < 0
          || scannedCount < 0
          || scannedCount > optionCount
          || invalidCount < 0
          || invalidCount > scannedCount
          || options == null
          || options.size() + invalidCount != scannedCount
          || sourceTruncated != (optionCount > scannedCount)) {
        throw new IllegalArgumentException("source snapshot is invalid");
      }
      this.optionCount = optionCount;
      this.scannedCount = scannedCount;
      this.invalidCount = invalidCount;
      this.sourceTruncated = sourceTruncated;
      this.options =
          Collections.unmodifiableList(new ArrayList<OptionValue>(options));
    }
  }

  static final class Entry {
    private final String name;
    private final String value;
    private final Category category;
    private final String origin;
    private final Visibility visibility;
    private final boolean writeable;
    private final int valueLength;
    private final boolean truncated;
    private final boolean mutable;

    private Entry(
        String name,
        String value,
        Category category,
        String origin,
        Visibility visibility,
        boolean writeable,
        int valueLength,
        boolean truncated,
        boolean mutable) {
      this.name = name;
      this.value = value;
      this.category = category;
      this.origin = origin;
      this.visibility = visibility;
      this.writeable = writeable;
      this.valueLength = valueLength;
      this.truncated = truncated;
      this.mutable = mutable;
    }

    String getName() {
      return name;
    }

    String getValue() {
      return value;
    }

    Category getCategory() {
      return category;
    }

    String getOrigin() {
      return origin;
    }

    Visibility getVisibility() {
      return visibility;
    }

    boolean isWriteable() {
      return writeable;
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
    private final int optionCount;
    private final int scannedCount;
    private final int writeableCount;
    private final int readOnlyCount;
    private final int maskedCount;
    private final int invalidCount;
    private final boolean sourceTruncated;
    private final int total;
    private final int offset;
    private final int limit;
    private final List<Entry> entries;

    private Result(
        int optionCount,
        int scannedCount,
        int writeableCount,
        int readOnlyCount,
        int maskedCount,
        int invalidCount,
        boolean sourceTruncated,
        int total,
        int offset,
        int limit,
        List<Entry> entries) {
      this.optionCount = optionCount;
      this.scannedCount = scannedCount;
      this.writeableCount = writeableCount;
      this.readOnlyCount = readOnlyCount;
      this.maskedCount = maskedCount;
      this.invalidCount = invalidCount;
      this.sourceTruncated = sourceTruncated;
      this.total = total;
      this.offset = offset;
      this.limit = limit;
      this.entries = Collections.unmodifiableList(new ArrayList<Entry>(entries));
    }

    int getOptionCount() {
      return optionCount;
    }

    int getScannedCount() {
      return scannedCount;
    }

    int getWriteableCount() {
      return writeableCount;
    }

    int getReadOnlyCount() {
      return readOnlyCount;
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

  private static final class ReflectionOptionSource implements OptionSource {
    @Override
    public SourceSnapshot load() throws Exception {
      Class<?> diagnosticType =
          Class.forName("com.sun.management.HotSpotDiagnosticMXBean");
      @SuppressWarnings({"rawtypes", "unchecked"})
      Object diagnostic =
          ManagementFactory.getPlatformMXBean((Class) diagnosticType);
      if (diagnostic == null) {
        throw new UnsupportedOperationException(
            "HotSpot diagnostic options are unavailable");
      }
      Object rawOptions =
          diagnosticType.getMethod("getDiagnosticOptions").invoke(diagnostic);
      if (!(rawOptions instanceof List<?>)) {
        throw new UnsupportedOperationException(
            "HotSpot diagnostic options returned an unsupported type");
      }
      List<?> options = (List<?>) rawOptions;
      int optionCount = options.size();
      int scannedCount = Math.min(optionCount, MAXIMUM_SCANNED_OPTIONS);
      List<OptionValue> values = new ArrayList<OptionValue>(scannedCount);
      int invalidCount = 0;
      for (int index = 0; index < scannedCount; index++) {
        Object option = options.get(index);
        try {
          if (option == null) {
            invalidCount++;
            continue;
          }
          Class<?> optionType = option.getClass();
          Object name = optionType.getMethod("getName").invoke(option);
          Object value = optionType.getMethod("getValue").invoke(option);
          Object writeable = optionType.getMethod("isWriteable").invoke(option);
          Object origin = optionType.getMethod("getOrigin").invoke(option);
          if (!(name instanceof String)
              || !(value instanceof String)
              || !(writeable instanceof Boolean)
              || !SAFE_OPTION_NAME.matcher((String) name).matches()) {
            invalidCount++;
            continue;
          }
          String originName =
              origin instanceof Enum<?> ? ((Enum<?>) origin).name() : "OTHER";
          values.add(
              new OptionValue(
                  (String) name,
                  (String) value,
                  ((Boolean) writeable).booleanValue(),
                  originName));
        } catch (ReflectiveOperationException exception) {
          invalidCount++;
        }
      }
      return new SourceSnapshot(
          optionCount,
          scannedCount,
          invalidCount,
          optionCount > scannedCount,
          values);
    }
  }
}
