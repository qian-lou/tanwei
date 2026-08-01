package dev.tanwei.agent;

import java.lang.instrument.Instrumentation;
import java.lang.reflect.Array;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Bounded, read-only access to HotSpot performance counters.
 *
 * <p>The implementation is compiled for Java 8 and uses reflection so the Agent can attach to
 * both the legacy {@code sun.misc.Perf} API and the modular {@code jdk.internal.perf.Perf} API.
 */
final class PerfCounterExplorer {
  static final int MAXIMUM_SCANNED_COUNTERS = 20_000;
  static final int MAXIMUM_PAGE_SIZE = 200;
  static final int MAXIMUM_SNAPSHOT_COUNTERS = 8;
  private static final int MAXIMUM_COUNTER_NAME_LENGTH = 256;
  private static final int MAXIMUM_VECTOR_ELEMENTS = 64;
  private static final int MAXIMUM_VALUE_LENGTH = 4_096;
  private static final String MASKED_VALUE = "••••••••";

  private final Object perf;
  private final Method attach;
  private final boolean attachNeedsMode;
  private final Method detach;
  private final Constructor<?> instrumentationConstructor;
  private final Method getAllCounters;
  private final Method getName;
  private final Method getUnits;
  private final Method getVariability;
  private final Method getValue;
  private final Method isInternal;
  private final Method isVector;
  private final Method getVectorLength;
  private final int processId;
  private final String unavailableReason;

  PerfCounterExplorer(Instrumentation instrumentation, long processId) {
    Object initializedPerf = null;
    Method initializedAttach = null;
    boolean initializedAttachNeedsMode = false;
    Method initializedDetach = null;
    Constructor<?> initializedInstrumentationConstructor = null;
    Method initializedGetAllCounters = null;
    Method initializedGetName = null;
    Method initializedGetUnits = null;
    Method initializedGetVariability = null;
    Method initializedGetValue = null;
    Method initializedIsInternal = null;
    Method initializedIsVector = null;
    Method initializedGetVectorLength = null;
    String initializationError = "";

    if (processId <= 0L || processId > Integer.MAX_VALUE) {
      initializationError = "Current JVM process id is not available";
    } else {
      try {
        Class<?> perfClass = loadPerfClass();
        Class<?> perfInstrumentationClass =
            Class.forName("sun.management.counter.perf.PerfInstrumentation", false, null);
        Class<?> counterClass =
            Class.forName("sun.management.counter.Counter", false, null);

        openPackage(instrumentation, perfClass, perfClass.getPackage().getName());
        openPackage(
            instrumentation,
            perfInstrumentationClass,
            perfInstrumentationClass.getPackage().getName());
        openPackage(instrumentation, counterClass, counterClass.getPackage().getName());

        Method getPerf = perfClass.getDeclaredMethod("getPerf");
        getPerf.setAccessible(true);
        initializedPerf = getPerf.invoke(null);

        try {
          initializedAttach = perfClass.getDeclaredMethod("attach", int.class);
        } catch (NoSuchMethodException noSingleArgumentAttach) {
          initializedAttach =
              perfClass.getDeclaredMethod("attach", int.class, String.class);
          initializedAttachNeedsMode = true;
        }
        initializedAttach.setAccessible(true);
        initializedDetach = optionalMethod(perfClass, "detach", ByteBuffer.class);

        initializedInstrumentationConstructor =
            perfInstrumentationClass.getDeclaredConstructor(ByteBuffer.class);
        initializedInstrumentationConstructor.setAccessible(true);
        initializedGetAllCounters =
            perfInstrumentationClass.getDeclaredMethod("getAllCounters");
        initializedGetAllCounters.setAccessible(true);

        initializedGetName = counterClass.getMethod("getName");
        initializedGetUnits = counterClass.getMethod("getUnits");
        initializedGetVariability = counterClass.getMethod("getVariability");
        initializedGetValue = counterClass.getMethod("getValue");
        initializedIsInternal = counterClass.getMethod("isInternal");
        initializedIsVector = counterClass.getMethod("isVector");
        initializedGetVectorLength = counterClass.getMethod("getVectorLength");
      } catch (Throwable exception) {
        initializationError = conciseReason(exception);
      }
    }

    this.perf = initializedPerf;
    this.attach = initializedAttach;
    this.attachNeedsMode = initializedAttachNeedsMode;
    this.detach = initializedDetach;
    this.instrumentationConstructor = initializedInstrumentationConstructor;
    this.getAllCounters = initializedGetAllCounters;
    this.getName = initializedGetName;
    this.getUnits = initializedGetUnits;
    this.getVariability = initializedGetVariability;
    this.getValue = initializedGetValue;
    this.isInternal = initializedIsInternal;
    this.isVector = initializedIsVector;
    this.getVectorLength = initializedGetVectorLength;
    this.processId = (int) processId;
    this.unavailableReason = initializationError;
  }

  boolean isAvailable() {
    return unavailableReason.isEmpty();
  }

  String unavailableReason() {
    return unavailableReason;
  }

  Page list(String query, String namespace, int offset, int limit) throws Exception {
    if (!isAvailable()) {
      throw new IllegalStateException(unavailableReason);
    }
    if (offset < 0 || offset > MAXIMUM_SCANNED_COUNTERS) {
      throw new IllegalArgumentException("offset is outside the allowed range");
    }
    if (limit < 1 || limit > MAXIMUM_PAGE_SIZE) {
      throw new IllegalArgumentException("limit is outside the allowed range");
    }

    String normalizedQuery = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
    String normalizedNamespace = normalizeNamespace(namespace);
    ByteBuffer buffer = attach();
    try {
      Object perfInstrumentation = instrumentationConstructor.newInstance(buffer);
      @SuppressWarnings("unchecked")
      List<Object> counters = (List<Object>) getAllCounters.invoke(perfInstrumentation);
      if (counters == null || counters.isEmpty()) {
        return Page.empty(offset, limit);
      }

      int scanCount = Math.min(counters.size(), MAXIMUM_SCANNED_COUNTERS);
      boolean truncated = counters.size() > scanCount;
      int javaCount = 0;
      int sunCount = 0;
      int jdkCount = 0;
      int otherCount = 0;
      List<CounterReference> matches = new ArrayList<CounterReference>();

      for (int index = 0; index < scanCount; index++) {
        Object counter = counters.get(index);
        String name = safeString(invoke(getName, counter));
        String category = categoryOf(name);
        if (!normalizedQuery.isEmpty()
            && !name.toLowerCase(Locale.ROOT).contains(normalizedQuery)) {
          continue;
        }
        if ("JAVA".equals(category)) {
          javaCount++;
        } else if ("SUN".equals(category)) {
          sunCount++;
        } else if ("JDK".equals(category)) {
          jdkCount++;
        } else {
          otherCount++;
        }
        if ("ALL".equals(normalizedNamespace)
            || normalizedNamespace.equals(category)) {
          matches.add(new CounterReference(name, category, counter));
        }
      }

      Collections.sort(
          matches,
          new Comparator<CounterReference>() {
            @Override
            public int compare(CounterReference left, CounterReference right) {
              return left.name.compareTo(right.name);
            }
          });

      int fromIndex = Math.min(offset, matches.size());
      int toIndex = Math.min(fromIndex + limit, matches.size());
      List<CounterSnapshot> page = new ArrayList<CounterSnapshot>(toIndex - fromIndex);
      for (int index = fromIndex; index < toIndex; index++) {
        page.add(snapshot(matches.get(index)));
      }
      return new Page(
          matches.size(),
          offset,
          limit,
          truncated,
          System.currentTimeMillis(),
          javaCount,
          sunCount,
          jdkCount,
          otherCount,
          page);
    } finally {
      detach(buffer);
    }
  }

  CounterBatch snapshot(String encodedNames) throws Exception {
    if (!isAvailable()) {
      throw new IllegalStateException(unavailableReason);
    }
    List<String> requestedNames = parseSnapshotNames(encodedNames);
    Set<String> requestedSet = new LinkedHashSet<String>(requestedNames);
    Map<String, CounterSnapshot> found = new HashMap<String, CounterSnapshot>(
        requestedNames.size());
    ByteBuffer buffer = attach();
    try {
      Object perfInstrumentation = instrumentationConstructor.newInstance(buffer);
      @SuppressWarnings("unchecked")
      List<Object> counters = (List<Object>) getAllCounters.invoke(perfInstrumentation);
      if (counters == null || counters.isEmpty()) {
        return new CounterBatch(
            System.currentTimeMillis(),
            0,
            false,
            Collections.<CounterSnapshot>emptyList(),
            requestedNames);
      }

      int scanLimit = Math.min(counters.size(), MAXIMUM_SCANNED_COUNTERS);
      int scanned = 0;
      for (int index = 0; index < scanLimit && found.size() < requestedSet.size(); index++) {
        Object counter = counters.get(index);
        scanned++;
        String name = safeString(invoke(getName, counter));
        if (requestedSet.contains(name) && !found.containsKey(name)) {
          found.put(
              name,
              snapshot(new CounterReference(name, categoryOf(name), counter)));
        }
      }

      List<CounterSnapshot> snapshots =
          new ArrayList<CounterSnapshot>(requestedNames.size());
      List<String> missingNames = new ArrayList<String>(requestedNames.size());
      for (String name : requestedNames) {
        CounterSnapshot counter = found.get(name);
        if (counter == null) {
          missingNames.add(name);
        } else {
          snapshots.add(counter);
        }
      }
      boolean truncated =
          !missingNames.isEmpty() && counters.size() > MAXIMUM_SCANNED_COUNTERS;
      return new CounterBatch(
          System.currentTimeMillis(),
          scanned,
          truncated,
          snapshots,
          missingNames);
    } finally {
      detach(buffer);
    }
  }

  static List<String> parseSnapshotNames(String encodedNames) {
    if (encodedNames == null || encodedNames.isEmpty()) {
      throw new IllegalArgumentException("names must contain at least one counter");
    }
    String[] lines = encodedNames.split("\\n", -1);
    if (lines.length < 1 || lines.length > MAXIMUM_SNAPSHOT_COUNTERS) {
      throw new IllegalArgumentException(
          "names must contain between 1 and "
              + MAXIMUM_SNAPSHOT_COUNTERS
              + " counters");
    }
    LinkedHashSet<String> unique = new LinkedHashSet<String>(lines.length);
    for (String name : lines) {
      if (name.isEmpty()
          || !name.equals(name.trim())
          || name.length() > MAXIMUM_COUNTER_NAME_LENGTH
          || containsControlCharacter(name)) {
        throw new IllegalArgumentException(
            "counter names must be trimmed, bounded, and contain no control characters");
      }
      if (!unique.add(name)) {
        throw new IllegalArgumentException("counter names must be unique");
      }
    }
    return Collections.unmodifiableList(new ArrayList<String>(unique));
  }

  private static boolean containsControlCharacter(String value) {
    for (int index = 0; index < value.length(); index++) {
      char character = value.charAt(index);
      if (character < 0x20 || character == 0x7f) {
        return true;
      }
    }
    return false;
  }

  private CounterSnapshot snapshot(CounterReference reference) {
    Object counter = reference.counter;
    String value;
    String valueType;
    if (isSensitiveCounter(reference.name)) {
      valueType = "masked";
      value = MASKED_VALUE;
    } else {
      try {
        Object rawValue = invoke(getValue, counter);
        valueType = rawValue == null ? "null" : rawValue.getClass().getTypeName();
        value = renderValue(rawValue);
      } catch (RuntimeException exception) {
        valueType = "unavailable";
        value = "<unavailable>";
      }
    }

    return new CounterSnapshot(
        reference.name,
        reference.category,
        safeInvokeString(getUnits, counter, "unknown"),
        safeInvokeString(getVariability, counter, "unknown"),
        value,
        valueType,
        safeInvokeBoolean(isInternal, counter),
        safeInvokeBoolean(isVector, counter)
            ? safeInvokeInt(getVectorLength, counter)
            : 0);
  }

  private ByteBuffer attach() throws Exception {
    Object result =
        attachNeedsMode
            ? attach.invoke(perf, processId, "r")
            : attach.invoke(perf, processId);
    if (!(result instanceof ByteBuffer)) {
      throw new IllegalStateException("HotSpot Perf attach did not return a buffer");
    }
    return (ByteBuffer) result;
  }

  private void detach(ByteBuffer buffer) {
    if (detach == null || buffer == null) {
      return;
    }
    try {
      detach.invoke(perf, buffer);
    } catch (ReflectiveOperationException ignored) {
      // The read is complete; detach availability differs across JDK releases.
    }
  }

  private static Class<?> loadPerfClass() throws ClassNotFoundException {
    try {
      return Class.forName("jdk.internal.perf.Perf", false, null);
    } catch (ClassNotFoundException modularPerfUnavailable) {
      return Class.forName("sun.misc.Perf", false, null);
    }
  }

  private static void openPackage(
      Instrumentation instrumentation, Class<?> sourceClass, String packageName)
      throws Exception {
    if (instrumentation == null) {
      return;
    }
    Method getModule;
    try {
      getModule = Class.class.getMethod("getModule");
    } catch (NoSuchMethodException javaEight) {
      return;
    }

    Object sourceModule = getModule.invoke(sourceClass);
    Object targetModule = getModule.invoke(PerfCounterExplorer.class);
    Method redefineModule = null;
    for (Method candidate : Instrumentation.class.getMethods()) {
      if ("redefineModule".equals(candidate.getName())
          && candidate.getParameterTypes().length == 6) {
        redefineModule = candidate;
        break;
      }
    }
    if (redefineModule == null) {
      throw new IllegalStateException("Instrumentation cannot open JDK modules");
    }

    Set<Object> target = Collections.singleton(targetModule);
    Map<String, Set<Object>> exports = new HashMap<String, Set<Object>>();
    exports.put(packageName, target);
    Map<String, Set<Object>> opens = new HashMap<String, Set<Object>>();
    opens.put(packageName, target);
    redefineModule.invoke(
        instrumentation,
        sourceModule,
        Collections.emptySet(),
        exports,
        opens,
        Collections.emptySet(),
        Collections.emptyMap());
  }

  private static Method optionalMethod(
      Class<?> type, String name, Class<?> parameterType) {
    try {
      Method method = type.getDeclaredMethod(name, parameterType);
      method.setAccessible(true);
      return method;
    } catch (ReflectiveOperationException ignored) {
      return null;
    }
  }

  private static Object invoke(Method method, Object target) {
    try {
      return method.invoke(target);
    } catch (IllegalAccessException exception) {
      throw new IllegalStateException(exception);
    } catch (InvocationTargetException exception) {
      Throwable cause = exception.getCause();
      if (cause instanceof RuntimeException) {
        throw (RuntimeException) cause;
      }
      throw new IllegalStateException(cause == null ? exception : cause);
    }
  }

  private static String safeInvokeString(
      Method method, Object target, String fallback) {
    try {
      return safeString(invoke(method, target));
    } catch (RuntimeException ignored) {
      return fallback;
    }
  }

  private static boolean safeInvokeBoolean(Method method, Object target) {
    try {
      return Boolean.TRUE.equals(invoke(method, target));
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  private static int safeInvokeInt(Method method, Object target) {
    try {
      Object value = invoke(method, target);
      return value instanceof Number ? Math.max(0, ((Number) value).intValue()) : 0;
    } catch (RuntimeException ignored) {
      return 0;
    }
  }

  static String categoryOf(String name) {
    String normalized = name == null ? "" : name.toLowerCase(Locale.ROOT);
    if (normalized.startsWith("java.")) {
      return "JAVA";
    }
    if (normalized.startsWith("sun.") || normalized.startsWith("com.sun.")) {
      return "SUN";
    }
    if (normalized.startsWith("jdk.")) {
      return "JDK";
    }
    return "OTHER";
  }

  static boolean matchesNamespace(String name, String namespace) {
    String normalized = normalizeNamespace(namespace);
    return "ALL".equals(normalized) || normalized.equals(categoryOf(name));
  }

  private static String normalizeNamespace(String namespace) {
    String normalized =
        namespace == null ? "ALL" : namespace.trim().toUpperCase(Locale.ROOT);
    if (!"ALL".equals(normalized)
        && !"JAVA".equals(normalized)
        && !"SUN".equals(normalized)
        && !"JDK".equals(normalized)
        && !"OTHER".equals(normalized)) {
      throw new IllegalArgumentException("namespace is not supported");
    }
    return normalized;
  }

  static boolean isSensitiveCounter(String name) {
    String normalized = name == null ? "" : name.toLowerCase(Locale.ROOT);
    return "java.rt.vmargs".equals(normalized)
        || "java.rt.javacommand".equals(normalized)
        || normalized.contains("password")
        || normalized.contains("passwd")
        || normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("credential")
        || normalized.endsWith(".key")
        || normalized.endsWith("_key");
  }

  static String renderValue(Object value) {
    String rendered;
    if (value == null) {
      rendered = "null";
    } else if (value instanceof String
        || value instanceof Number
        || value instanceof Boolean
        || value instanceof Character) {
      rendered = String.valueOf(value);
    } else if (value instanceof byte[]) {
      byte[] bytes = (byte[]) value;
      int length = 0;
      while (length < bytes.length && bytes[length] != 0 && length < MAXIMUM_VALUE_LENGTH) {
        length++;
      }
      rendered = new String(bytes, 0, length, StandardCharsets.UTF_8);
    } else if (value.getClass().isArray()) {
      int length = Array.getLength(value);
      int visibleLength = Math.min(length, MAXIMUM_VECTOR_ELEMENTS);
      StringBuilder builder = new StringBuilder("[");
      for (int index = 0; index < visibleLength; index++) {
        if (index > 0) {
          builder.append(", ");
        }
        Object element = Array.get(value, index);
        if (element instanceof Number
            || element instanceof Boolean
            || element instanceof Character) {
          builder.append(element);
        } else {
          builder.append("<unsupported>");
        }
      }
      if (visibleLength < length) {
        builder.append(", …");
      }
      rendered = builder.append(']').toString();
    } else {
      rendered = "<unsupported: " + value.getClass().getTypeName() + ">";
    }
    return trim(rendered);
  }

  private static String safeString(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  private static String trim(String value) {
    return value.length() <= MAXIMUM_VALUE_LENGTH
        ? value
        : value.substring(0, MAXIMUM_VALUE_LENGTH) + "…";
  }

  private static String conciseReason(Throwable exception) {
    Throwable current = exception;
    while (current instanceof InvocationTargetException
        && ((InvocationTargetException) current).getCause() != null) {
      current = ((InvocationTargetException) current).getCause();
    }
    String message = current.getMessage();
    String reason =
        current.getClass().getSimpleName()
            + (message == null || message.trim().isEmpty() ? "" : ": " + message.trim());
    return trim(reason);
  }

  private static final class CounterReference {
    private final String name;
    private final String category;
    private final Object counter;

    private CounterReference(String name, String category, Object counter) {
      this.name = name;
      this.category = category;
      this.counter = counter;
    }
  }

  static final class Page {
    private final int total;
    private final int offset;
    private final int limit;
    private final boolean truncated;
    private final long sampledAtEpochMillis;
    private final int javaCount;
    private final int sunCount;
    private final int jdkCount;
    private final int otherCount;
    private final List<CounterSnapshot> counters;

    private Page(
        int total,
        int offset,
        int limit,
        boolean truncated,
        long sampledAtEpochMillis,
        int javaCount,
        int sunCount,
        int jdkCount,
        int otherCount,
        List<CounterSnapshot> counters) {
      this.total = total;
      this.offset = offset;
      this.limit = limit;
      this.truncated = truncated;
      this.sampledAtEpochMillis = sampledAtEpochMillis;
      this.javaCount = javaCount;
      this.sunCount = sunCount;
      this.jdkCount = jdkCount;
      this.otherCount = otherCount;
      this.counters = Collections.unmodifiableList(new ArrayList<CounterSnapshot>(counters));
    }

    private static Page empty(int offset, int limit) {
      return new Page(
          0,
          offset,
          limit,
          false,
          System.currentTimeMillis(),
          0,
          0,
          0,
          0,
          Collections.<CounterSnapshot>emptyList());
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

    boolean isTruncated() {
      return truncated;
    }

    long getSampledAtEpochMillis() {
      return sampledAtEpochMillis;
    }

    int getJavaCount() {
      return javaCount;
    }

    int getSunCount() {
      return sunCount;
    }

    int getJdkCount() {
      return jdkCount;
    }

    int getOtherCount() {
      return otherCount;
    }

    List<CounterSnapshot> getCounters() {
      return counters;
    }
  }

  static final class CounterSnapshot {
    private final String name;
    private final String category;
    private final String units;
    private final String variability;
    private final String value;
    private final String valueType;
    private final boolean internal;
    private final int vectorLength;

    private CounterSnapshot(
        String name,
        String category,
        String units,
        String variability,
        String value,
        String valueType,
        boolean internal,
        int vectorLength) {
      this.name = name;
      this.category = category;
      this.units = units;
      this.variability = variability;
      this.value = value;
      this.valueType = valueType;
      this.internal = internal;
      this.vectorLength = vectorLength;
    }

    String getName() {
      return name;
    }

    String getCategory() {
      return category;
    }

    String getUnits() {
      return units;
    }

    String getVariability() {
      return variability;
    }

    String getValue() {
      return value;
    }

    String getValueType() {
      return valueType;
    }

    boolean isInternal() {
      return internal;
    }

    int getVectorLength() {
      return vectorLength;
    }
  }

  static final class CounterBatch {
    private final long sampledAtEpochMillis;
    private final int scannedCounters;
    private final boolean truncated;
    private final List<CounterSnapshot> counters;
    private final List<String> missingNames;

    private CounterBatch(
        long sampledAtEpochMillis,
        int scannedCounters,
        boolean truncated,
        List<CounterSnapshot> counters,
        List<String> missingNames) {
      this.sampledAtEpochMillis = sampledAtEpochMillis;
      this.scannedCounters = scannedCounters;
      this.truncated = truncated;
      this.counters =
          Collections.unmodifiableList(
              new ArrayList<CounterSnapshot>(counters));
      this.missingNames =
          Collections.unmodifiableList(new ArrayList<String>(missingNames));
    }

    long getSampledAtEpochMillis() {
      return sampledAtEpochMillis;
    }

    int getScannedCounters() {
      return scannedCounters;
    }

    boolean isTruncated() {
      return truncated;
    }

    List<CounterSnapshot> getCounters() {
      return counters;
    }

    List<String> getMissingNames() {
      return missingNames;
    }
  }
}
