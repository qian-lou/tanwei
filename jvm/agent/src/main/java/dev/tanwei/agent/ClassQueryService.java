package dev.tanwei.agent;

import dev.tanwei.protocol.v1.ClassDescriptor;
import dev.tanwei.protocol.v1.ClassListRequest;
import dev.tanwei.protocol.v1.ClassListResponse;
import java.lang.instrument.Instrumentation;
import java.util.Objects;

final class ClassQueryService {
  private static final int DEFAULT_PAGE_SIZE = 100;
  private static final int MAXIMUM_PAGE_SIZE = 1_000;

  private final Instrumentation instrumentation;

  ClassQueryService(Instrumentation instrumentation) {
    this.instrumentation = Objects.requireNonNull(instrumentation, "instrumentation");
  }

  /**
   * Selects a bounded page from one loaded-class snapshot, then materializes
   * descriptors only for that page.
   *
   * <p>Time: O(C log K + K log K). Extra space: O(K), excluding the JVM-owned
   * class snapshot array, where K = min(C, offset + limit).
   */
  ClassListResponse list(ClassListRequest request) {
    Objects.requireNonNull(request, "request");
    int offset = Math.max(0, request.getOffset());
    int limit = pageSize(request.getLimit());
    String query = safeString(request.getNameQuery()).trim();
    Class<?>[] loadedClasses = instrumentation.getAllLoadedClasses();
    if (loadedClasses == null) {
      loadedClasses = new Class<?>[0];
    }
    ClassPageSelector selector =
        new ClassPageSelector(offset, limit, loadedClasses.length);
    for (int index = 0; index < loadedClasses.length; index++) {
      Class<?> type = loadedClasses[index];
      if (type == null) {
        continue;
      }
      String className = safeString(type.getName());
      if (containsIgnoreCase(className, query)) {
        selector.accept(className, index);
      }
    }

    ClassPageSelector.Page selected = selector.finish();
    ClassListResponse.Builder response =
        ClassListResponse.newBuilder()
            .setTotalMatches(selected.getTotal())
            .setOffset(offset);
    for (ClassPageSelector.Selection selection : selected.getSelections()) {
      Class<?> type = loadedClasses[selection.getSnapshotIndex()];
      if (type == null) {
        continue;
      }
      ClassLoader loader = type.getClassLoader();
      response.addClasses(
          ClassDescriptor.newBuilder()
              .setName(selection.getClassName())
              .setClassLoader(loader == null ? "bootstrap" : loader.toString())
              .setModule("")
              .setModifiable(instrumentation.isModifiableClass(type))
              .build());
    }
    return response.build();
  }

  private static boolean containsIgnoreCase(String value, String query) {
    if (query.isEmpty()) {
      return true;
    }
    int maximumStart = value.length() - query.length();
    for (int start = 0; start <= maximumStart; start++) {
      if (value.regionMatches(true, start, query, 0, query.length())) {
        return true;
      }
    }
    return false;
  }

  private static int pageSize(int requested) {
    return requested <= 0
        ? DEFAULT_PAGE_SIZE
        : Math.min(MAXIMUM_PAGE_SIZE, requested);
  }

  private static String safeString(String value) {
    return value == null ? "" : value;
  }
}
