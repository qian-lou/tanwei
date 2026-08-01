package dev.tanwei.agent;

import java.lang.instrument.Instrumentation;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

final class ClassLoaderResourceExplorer implements AutoCloseable {
  private static final int MAXIMUM_RESOURCE_NAME_CHARACTERS = 1_024;
  private static final int MAXIMUM_RESOURCES = 100;
  private static final int MAXIMUM_SCANNED_RESOURCES = 1_000;
  private static final int MAXIMUM_LOCATION_CHARACTERS = 4_096;
  private static final int MAXIMUM_TOTAL_LOCATION_CHARACTERS = 64 * 1_024;
  private static final long LOOKUP_TIMEOUT_MILLIS = 2_000L;

  private final Instrumentation instrumentation;
  private final ThreadPoolExecutor executor;

  ClassLoaderResourceExplorer(Instrumentation instrumentation) {
    if (instrumentation == null) {
      throw new IllegalArgumentException("Instrumentation is required");
    }
    this.instrumentation = instrumentation;
    this.executor =
        new ThreadPoolExecutor(
            0,
            2,
            30L,
            TimeUnit.SECONDS,
            new SynchronousQueue<Runnable>(),
            new ResourceLookupThreadFactory(),
            new ThreadPoolExecutor.AbortPolicy());
  }

  Map<String, String> inspect(
      String rawClassName,
      String rawClassLoader,
      String rawResourceName)
      throws Exception {
    String className = required(rawClassName, "Class name", 1_024);
    String classLoader =
        required(rawClassLoader, "ClassLoader", 4_096);
    String resourceName = normalizedResourceName(rawResourceName);
    Class<?> selected = null;
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      if (type.getName().equals(className)
          && classLoaderName(type).equals(classLoader)) {
        selected = type;
        break;
      }
    }
    if (selected == null) {
      throw new IllegalArgumentException(
          "The selected class or ClassLoader is no longer available");
    }
    return lookupSelected(
        selected.getClassLoader(),
        className,
        classLoaderName(selected),
        resourceName);
  }

  Map<String, String> lookupSelected(
      ClassLoader loader,
      String selectedClass,
      String classLoader,
      String rawResourceName)
      throws Exception {
    String resourceName = normalizedResourceName(rawResourceName);
    long startedAtNanos = System.nanoTime();
    Future<LookupResult> task =
        executor.submit(() -> enumerate(loader, resourceName));
    LookupResult result;
    try {
      result = task.get(LOOKUP_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
    } catch (TimeoutException exception) {
      task.cancel(true);
      throw new ResourceLookupTimeoutException();
    } catch (ExecutionException exception) {
      Throwable cause =
          exception.getCause() == null ? exception : exception.getCause();
      if (cause instanceof Exception) {
        throw (Exception) cause;
      }
      throw new IllegalStateException("ClassLoader resource lookup failed", cause);
    }

    Map<String, String> values = new LinkedHashMap<String, String>();
    values.put("selectedClass", selectedClass);
    values.put("classLoader", classLoader);
    values.put("resourceName", resourceName);
    values.put(
        "scope",
        loader == null ? "SYSTEM_BOOTSTRAP" : "SELECTED_WITH_PARENTS");
    values.put("count", Integer.toString(result.locations.size()));
    values.put("scanned", Integer.toString(result.scanned));
    values.put("truncated", Boolean.toString(result.truncated));
    values.put(
        "characterLimitReached",
        Boolean.toString(result.characterLimitReached));
    values.put(
        "durationMillis",
        Long.toString(
            TimeUnit.NANOSECONDS.toMillis(
                System.nanoTime() - startedAtNanos)));
    for (int index = 0; index < result.locations.size(); index++) {
      ResourceLocation location = result.locations.get(index);
      String prefix =
          "resource." + String.format(Locale.ROOT, "%04d", index) + ".";
      values.put(prefix + "kind", location.kind);
      values.put(prefix + "protocol", location.protocol);
      values.put(prefix + "location", location.location);
    }
    return values;
  }

  @Override
  public void close() {
    executor.shutdownNow();
  }

  private static LookupResult enumerate(
      ClassLoader loader, String resourceName) throws Exception {
    Enumeration<URL> resources =
        loader == null
            ? ClassLoader.getSystemResources(resourceName)
            : loader.getResources(resourceName);
    Map<String, ResourceLocation> unique =
        new LinkedHashMap<String, ResourceLocation>();
    int scanned = 0;
    int totalCharacters = 0;
    boolean truncated = false;
    boolean characterLimitReached = false;
    while (resources.hasMoreElements()) {
      if (Thread.currentThread().isInterrupted()) {
        throw new InterruptedException("Resource lookup was interrupted");
      }
      if (scanned >= MAXIMUM_SCANNED_RESOURCES
          || unique.size() >= MAXIMUM_RESOURCES) {
        truncated = true;
        break;
      }
      URL resource = resources.nextElement();
      scanned++;
      ResourceLocation location = safeLocation(resource);
      if (location.truncated) {
        characterLimitReached = true;
        truncated = true;
      }
      if (unique.containsKey(location.location)) {
        continue;
      }
      if (totalCharacters + location.location.length()
          > MAXIMUM_TOTAL_LOCATION_CHARACTERS) {
        characterLimitReached = true;
        truncated = true;
        break;
      }
      totalCharacters += location.location.length();
      unique.put(location.location, location);
    }
    return new LookupResult(
        new ArrayList<ResourceLocation>(unique.values()),
        scanned,
        truncated,
        characterLimitReached);
  }

  private static ResourceLocation safeLocation(URL resource) {
    if (resource == null) {
      return new ResourceLocation("OTHER", "unknown", "<null>", false);
    }
    String protocol = bounded(resource.getProtocol(), 64);
    StringBuilder location = new StringBuilder();
    location.append(protocol.isEmpty() ? "unknown" : protocol).append(':');
    String host = resource.getHost();
    if (host != null && !host.isEmpty()) {
      location.append("//").append(host);
      if (resource.getPort() >= 0) {
        location.append(':').append(resource.getPort());
      }
    }
    location.append(resource.getPath() == null ? "" : resource.getPath());
    String rawLocation = location.toString();
    String value = bounded(rawLocation, MAXIMUM_LOCATION_CHARACTERS);
    return new ResourceLocation(
        resourceKind(protocol),
        protocol,
        value,
        rawLocation.length() > MAXIMUM_LOCATION_CHARACTERS);
  }

  private static String resourceKind(String protocol) {
    if ("file".equalsIgnoreCase(protocol)) {
      return "FILE";
    }
    if ("jar".equalsIgnoreCase(protocol)
        || "zip".equalsIgnoreCase(protocol)) {
      return "ARCHIVE";
    }
    if ("jrt".equalsIgnoreCase(protocol)) {
      return "MODULE";
    }
    if ("http".equalsIgnoreCase(protocol)
        || "https".equalsIgnoreCase(protocol)) {
      return "REMOTE";
    }
    return "OTHER";
  }

  private static String normalizedResourceName(String rawValue) {
    String value =
        required(
            rawValue,
            "Resource name",
            MAXIMUM_RESOURCE_NAME_CHARACTERS);
    if (value.startsWith("/")
        || value.indexOf('\\') >= 0
        || value.indexOf('\0') >= 0) {
      throw new IllegalArgumentException("Resource name is invalid");
    }
    String[] segments = value.split("/", -1);
    for (String segment : segments) {
      if (segment.isEmpty()
          || ".".equals(segment)
          || "..".equals(segment)) {
        throw new IllegalArgumentException("Resource name is invalid");
      }
    }
    return value;
  }

  private static String required(
      String rawValue, String label, int maximumLength) {
    if (rawValue == null
        || rawValue.trim().isEmpty()
        || rawValue.length() > maximumLength
        || rawValue.indexOf('\r') >= 0
        || rawValue.indexOf('\n') >= 0) {
      throw new IllegalArgumentException(label + " is invalid");
    }
    return rawValue.trim();
  }

  private static String classLoaderName(Class<?> type) {
    ClassLoader loader = type.getClassLoader();
    return loader == null ? "bootstrap" : loader.toString();
  }

  private static String bounded(String value, int maximumLength) {
    if (value == null) {
      return "";
    }
    String singleLine = value.replace('\r', ' ').replace('\n', ' ');
    return singleLine.length() <= maximumLength
        ? singleLine
        : singleLine.substring(0, maximumLength - 1) + "…";
  }

  static final class ResourceLookupTimeoutException
      extends IllegalStateException {
    ResourceLookupTimeoutException() {
      super(
          "ClassLoader resource lookup exceeded 2 seconds; interruption was requested");
    }
  }

  private static final class LookupResult {
    private final List<ResourceLocation> locations;
    private final int scanned;
    private final boolean truncated;
    private final boolean characterLimitReached;

    LookupResult(
        List<ResourceLocation> locations,
        int scanned,
        boolean truncated,
        boolean characterLimitReached) {
      this.locations =
          Collections.unmodifiableList(
              new ArrayList<ResourceLocation>(locations));
      this.scanned = scanned;
      this.truncated = truncated;
      this.characterLimitReached = characterLimitReached;
    }
  }

  private static final class ResourceLocation {
    private final String kind;
    private final String protocol;
    private final String location;
    private final boolean truncated;

    ResourceLocation(
        String kind,
        String protocol,
        String location,
        boolean truncated) {
      this.kind = kind;
      this.protocol = protocol;
      this.location = location;
      this.truncated = truncated;
    }
  }

  private static final class ResourceLookupThreadFactory
      implements ThreadFactory {
    private final AtomicInteger sequence = new AtomicInteger();

    @Override
    public Thread newThread(Runnable runnable) {
      Thread thread =
          new Thread(
              runnable,
              "tanwei-classloader-resource-"
                  + sequence.incrementAndGet());
      thread.setDaemon(true);
      return thread;
    }
  }
}
