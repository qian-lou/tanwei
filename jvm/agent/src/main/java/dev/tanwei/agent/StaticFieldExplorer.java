package dev.tanwei.agent;

import java.lang.instrument.Instrumentation;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

final class StaticFieldExplorer {
  private static final int MAXIMUM_FIELDS = 256;
  private static final int MAXIMUM_VALUE_LENGTH = 4_096;

  private final Instrumentation instrumentation;

  StaticFieldExplorer(Instrumentation instrumentation) {
    if (instrumentation == null) {
      throw new IllegalArgumentException("Instrumentation is required");
    }
    this.instrumentation = instrumentation;
  }

  Map<String, String> list(String className, String classLoader) {
    Class<?> selected = requireClass(className, classLoader);
    List<Field> fields = staticFields(selected);
    Map<String, String> values = new TreeMap<String, String>();
    int count = Math.min(fields.size(), MAXIMUM_FIELDS);
    values.put("className", selected.getName());
    values.put("classLoader", classLoaderName(selected));
    values.put("total", Integer.toString(fields.size()));
    values.put("count", Integer.toString(count));
    values.put("truncated", Integer.toString(Math.max(0, fields.size() - count)));
    for (int index = 0; index < count; index++) {
      Field field = fields.get(index);
      String prefix =
          "field." + String.format(Locale.ROOT, "%04d", index) + ".";
      values.put(prefix + "declaringClass", field.getDeclaringClass().getName());
      values.put(prefix + "name", field.getName());
      values.put(prefix + "type", field.getType().getTypeName());
      values.put(prefix + "modifiers", Modifier.toString(field.getModifiers()));
      values.put(prefix + "enumConstant", Boolean.toString(field.isEnumConstant()));
    }
    return values;
  }

  Map<String, String> preview(
      String className,
      String classLoader,
      String declaringClass,
      String fieldName)
      throws Exception {
    Selection selection =
        select(className, classLoader, declaringClass, fieldName);
    return selectionValues(selection);
  }

  Map<String, String> read(
      String className,
      String classLoader,
      String declaringClass,
      String fieldName,
      String expectedFingerprint)
      throws Exception {
    Selection selection =
        select(className, classLoader, declaringClass, fieldName);
    String actualFingerprint = fingerprint(selection);
    if (!actualFingerprint.equals(expectedFingerprint)) {
      throw new StaleSelectionException(actualFingerprint);
    }
    Field field = selection.field;
    boolean accessible = field.isAccessible();
    Object value;
    try {
      if (!accessible) {
        field.setAccessible(true);
      }
      value = field.get(null);
    } catch (ExceptionInInitializerError error) {
      throw new IllegalStateException(
          "Class initialization failed while reading the selected static field",
          error);
    } finally {
      if (!accessible) {
        try {
          field.setAccessible(false);
        } catch (RuntimeException ignored) {
          // Access restoration is best-effort on strongly encapsulated modules.
        }
      }
    }
    Map<String, String> values = selectionValues(selection);
    values.put("value", safeValue(value));
    values.put("valueClass", value == null ? "null" : value.getClass().getName());
    return values;
  }

  private Selection select(
      String className,
      String classLoader,
      String declaringClass,
      String fieldName)
      throws Exception {
    Class<?> selected = requireClass(className, classLoader);
    for (Field field : staticFields(selected)) {
      if (field.getDeclaringClass().getName().equals(declaringClass)
          && field.getName().equals(fieldName)) {
        return new Selection(selected, field);
      }
    }
    throw new IllegalArgumentException(
        "The selected static field is no longer available");
  }

  private Class<?> requireClass(String className, String classLoader) {
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      if (type.getName().equals(className)
          && classLoaderName(type).equals(classLoader)) {
        return type;
      }
    }
    throw new IllegalArgumentException(
        "The selected class or ClassLoader is no longer available");
  }

  private static List<Field> staticFields(Class<?> selected) {
    List<Field> fields = new ArrayList<Field>();
    Class<?> current = selected;
    while (current != null && current != Object.class) {
      Collections.addAll(fields, current.getDeclaredFields());
      current = current.getSuperclass();
    }
    fields.removeIf(field -> !Modifier.isStatic(field.getModifiers()));
    fields.sort(
        Comparator.comparing(
                (Field field) -> field.getDeclaringClass().getName())
            .thenComparing(Field::getName)
            .thenComparing(field -> field.getType().getTypeName()));
    return fields;
  }

  private static Map<String, String> selectionValues(Selection selection)
      throws Exception {
    Field field = selection.field;
    Map<String, String> values = new TreeMap<String, String>();
    values.put("className", selection.selectedClass.getName());
    values.put("classLoader", classLoaderName(selection.selectedClass));
    values.put("declaringClass", field.getDeclaringClass().getName());
    values.put("fieldName", field.getName());
    values.put("type", field.getType().getTypeName());
    values.put("modifiers", Modifier.toString(field.getModifiers()));
    values.put("fingerprint", fingerprint(selection));
    values.put(
        "boundary",
        "Reading this field may initialize its declaring class and execute <clinit>");
    return values;
  }

  private static String fingerprint(Selection selection) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    updateDigest(digest, selection.selectedClass.getName());
    updateDigest(digest, classLoaderName(selection.selectedClass));
    updateDigest(digest, selection.field.getDeclaringClass().getName());
    updateDigest(digest, selection.field.getName());
    updateDigest(digest, selection.field.getType().getTypeName());
    updateDigest(digest, Modifier.toString(selection.field.getModifiers()));
    byte[] result = digest.digest();
    StringBuilder output = new StringBuilder(result.length * 2);
    for (byte value : result) {
      output.append(String.format(Locale.ROOT, "%02x", value & 0xff));
    }
    return output.toString();
  }

  private static void updateDigest(MessageDigest digest, String value) {
    byte[] encoded = value.getBytes(StandardCharsets.UTF_8);
    digest.update((byte) (encoded.length >>> 24));
    digest.update((byte) (encoded.length >>> 16));
    digest.update((byte) (encoded.length >>> 8));
    digest.update((byte) encoded.length);
    digest.update(encoded);
  }

  private static String safeValue(Object value) {
    if (value == null) {
      return "null";
    }
    try {
      String rendered;
      Class<?> type = value.getClass();
      if (type == String.class
          || type == Boolean.class
          || type == Byte.class
          || type == Short.class
          || type == Integer.class
          || type == Long.class
          || type == Float.class
          || type == Double.class
          || type == Character.class) {
        rendered = String.valueOf(value);
      } else if (value instanceof Enum) {
        rendered = ((Enum<?>) value).name();
      } else if (value instanceof Class) {
        rendered = ((Class<?>) value).getName();
      } else if (type.isArray()) {
        rendered =
            "<"
                + type.getTypeName()
                + " length="
                + Array.getLength(value)
                + "@"
                + Integer.toHexString(System.identityHashCode(value))
                + ">";
      } else {
        rendered =
            "<"
                + type.getName()
                + "@"
                + Integer.toHexString(System.identityHashCode(value))
                + ">";
      }
      return rendered.length() <= MAXIMUM_VALUE_LENGTH
          ? rendered
          : rendered.substring(0, MAXIMUM_VALUE_LENGTH) + "…";
    } catch (RuntimeException ignored) {
      return "<unavailable>";
    }
  }

  private static String classLoaderName(Class<?> type) {
    ClassLoader loader = type.getClassLoader();
    return loader == null ? "bootstrap" : loader.toString();
  }

  static final class StaleSelectionException extends Exception {
    private final String actualFingerprint;

    StaleSelectionException(String actualFingerprint) {
      super("The static field metadata changed after preview");
      this.actualFingerprint = actualFingerprint;
    }

    String getActualFingerprint() {
      return actualFingerprint;
    }
  }

  private static final class Selection {
    private final Class<?> selectedClass;
    private final Field field;

    private Selection(Class<?> selectedClass, Field field) {
      this.selectedClass = selectedClass;
      this.field = field;
    }
  }
}
