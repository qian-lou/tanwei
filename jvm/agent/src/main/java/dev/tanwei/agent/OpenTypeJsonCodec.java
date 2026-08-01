package dev.tanwei.agent;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.StringReader;
import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.management.ObjectName;
import javax.management.openmbean.ArrayType;
import javax.management.openmbean.CompositeData;
import javax.management.openmbean.CompositeDataSupport;
import javax.management.openmbean.CompositeType;
import javax.management.openmbean.OpenType;
import javax.management.openmbean.SimpleType;
import javax.management.openmbean.TabularData;
import javax.management.openmbean.TabularDataSupport;
import javax.management.openmbean.TabularType;

/** Strict, bounded JSON conversion for JMX OpenType values. */
final class OpenTypeJsonCodec {
  static final int MAXIMUM_JSON_CHARACTERS = 32_768;
  static final int MAXIMUM_DEPTH = 5;
  static final int MAXIMUM_NODES = 256;
  static final int MAXIMUM_CONTAINER_ENTRIES = 50;
  private static final int MAXIMUM_JSON_NESTING = 8;
  private static final int MAXIMUM_SCHEMA_CHARACTERS = 4_096;

  private OpenTypeJsonCodec() {}

  static boolean isSupported(OpenType<?> openType) {
    if (openType == null) {
      return false;
    }
    try {
      validateType(openType, 0, new Budget());
      return true;
    } catch (IllegalArgumentException exception) {
      return false;
    }
  }

  static Object decode(String rawJson, OpenType<?> openType) throws Exception {
    validateInput(rawJson);
    validateType(openType, 0, new Budget());
    JsonReader reader = new JsonReader(new StringReader(rawJson));
    reader.setStrictness(Strictness.STRICT);
    final JsonElement root;
    try {
      root = JsonParser.parseReader(reader);
      if (reader.peek() != JsonToken.END_DOCUMENT) {
        throw new IllegalArgumentException("OpenType JSON contains trailing data");
      }
    } catch (RuntimeException exception) {
      throw new IllegalArgumentException("OpenType JSON is invalid", exception);
    }
    return decodeValue(root, openType, 0, new Budget());
  }

  static String encode(Object value, OpenType<?> openType) {
    validateType(openType, 0, new Budget());
    if (value == null || !openType.isValue(value)) {
      throw new IllegalArgumentException("MBean value does not match its OpenType");
    }
    JsonElement encoded = encodeValue(value, openType, 0, new Budget());
    String json = encoded.toString();
    if (json.length() > MAXIMUM_JSON_CHARACTERS) {
      throw new IllegalArgumentException(
          "MBean OpenType value exceeds the 32 KiB JSON boundary");
    }
    return json;
  }

  static String schema(OpenType<?> openType) {
    validateType(openType, 0, new Budget());
    StringBuilder output = new StringBuilder();
    appendSchema(output, openType, 0);
    return output.toString();
  }

  private static Object decodeValue(
      JsonElement element, OpenType<?> openType, int depth, Budget budget)
      throws Exception {
    if (element == null || element instanceof JsonNull || element.isJsonNull()) {
      throw new IllegalArgumentException("OpenType JSON values cannot be null");
    }
    if (openType instanceof ArrayType) {
      ArrayType<?> arrayType = (ArrayType<?>) openType;
      return decodeArray(
          element,
          arrayType.getElementOpenType(),
          arrayType.getDimension(),
          arrayType.isPrimitiveArray(),
          depth,
          budget);
    }
    budget.visit(depth);
    if (openType instanceof SimpleType) {
      return decodeSimple(element, (SimpleType<?>) openType);
    }
    if (openType instanceof CompositeType) {
      return decodeComposite(element, (CompositeType) openType, depth, budget);
    }
    if (openType instanceof TabularType) {
      return decodeTabular(element, (TabularType) openType, depth, budget);
    }
    throw new IllegalArgumentException("Unsupported JMX OpenType");
  }

  private static Object decodeSimple(JsonElement element, SimpleType<?> type)
      throws Exception {
    JsonPrimitive primitive = requiredPrimitive(element);
    if (SimpleType.STRING.equals(type)) {
      requireString(primitive, type);
      return primitive.getAsString();
    }
    if (SimpleType.BOOLEAN.equals(type)) {
      if (!primitive.isBoolean()) {
        throw typeMismatch(type);
      }
      return Boolean.valueOf(primitive.getAsBoolean());
    }
    if (SimpleType.CHARACTER.equals(type)) {
      requireString(primitive, type);
      String value = primitive.getAsString();
      if (value.length() != 1) {
        throw new IllegalArgumentException(
            "OpenType Character values must contain exactly one character");
      }
      return Character.valueOf(value.charAt(0));
    }
    if (SimpleType.DATE.equals(type)) {
      requireString(primitive, type);
      try {
        return Date.from(Instant.parse(primitive.getAsString()));
      } catch (RuntimeException exception) {
        throw new IllegalArgumentException(
            "OpenType Date values must use ISO-8601 UTC format", exception);
      }
    }
    if (SimpleType.OBJECTNAME.equals(type)) {
      requireString(primitive, type);
      ObjectName value = new ObjectName(primitive.getAsString());
      if (value.isPattern()) {
        throw new IllegalArgumentException(
            "OpenType ObjectName values cannot be patterns");
      }
      return value;
    }
    if (!primitive.isNumber()) {
      throw typeMismatch(type);
    }
    String number = primitive.getAsString();
    try {
      if (SimpleType.BYTE.equals(type)) {
        return Byte.valueOf(number);
      }
      if (SimpleType.SHORT.equals(type)) {
        return Short.valueOf(number);
      }
      if (SimpleType.INTEGER.equals(type)) {
        return Integer.valueOf(number);
      }
      if (SimpleType.LONG.equals(type)) {
        return Long.valueOf(number);
      }
      if (SimpleType.BIGINTEGER.equals(type)) {
        return new BigInteger(number);
      }
      if (SimpleType.BIGDECIMAL.equals(type)) {
        return new BigDecimal(number);
      }
      if (SimpleType.FLOAT.equals(type)) {
        Float value = Float.valueOf(number);
        if (!Float.isFinite(value.floatValue())) {
          throw typeMismatch(type);
        }
        return value;
      }
      if (SimpleType.DOUBLE.equals(type)) {
        Double value = Double.valueOf(number);
        if (!Double.isFinite(value.doubleValue())) {
          throw typeMismatch(type);
        }
        return value;
      }
    } catch (NumberFormatException exception) {
      throw new IllegalArgumentException(
          "OpenType numeric value is outside the declared type", exception);
    }
    throw new IllegalArgumentException("Unsupported JMX SimpleType");
  }

  private static CompositeData decodeComposite(
      JsonElement element, CompositeType type, int depth, Budget budget)
      throws Exception {
    if (!element.isJsonObject()) {
      throw typeMismatch(type);
    }
    JsonObject object = element.getAsJsonObject();
    List<String> keys = sortedKeys(type);
    if (object.size() != keys.size()) {
      throw new IllegalArgumentException(
          "OpenType composite JSON must contain every declared item and no unknown items");
    }
    Map<String, Object> values = new LinkedHashMap<String, Object>(keys.size());
    for (String key : keys) {
      if (!object.has(key)) {
        throw new IllegalArgumentException(
            "OpenType composite JSON is missing item: " + boundedLabel(key));
      }
      values.put(
          key,
          decodeValue(object.get(key), type.getType(key), depth + 1, budget));
    }
    return new CompositeDataSupport(type, values);
  }

  private static Object decodeArray(
      JsonElement element,
      OpenType<?> elementType,
      int dimension,
      boolean primitiveArray,
      int depth,
      Budget budget)
      throws Exception {
    budget.visit(depth);
    if (!element.isJsonArray()) {
      throw new IllegalArgumentException("OpenType array values must be JSON arrays");
    }
    JsonArray input = element.getAsJsonArray();
    if (input.size() > MAXIMUM_CONTAINER_ENTRIES) {
      throw new IllegalArgumentException(
          "OpenType arrays support at most 50 items per dimension");
    }
    Class<?> baseClass = simpleClass(elementType, primitiveArray);
    Class<?> componentClass =
        dimension == 1
            ? baseClass
            : Array.newInstance(baseClass, new int[dimension - 1]).getClass();
    Object output = Array.newInstance(componentClass, input.size());
    for (int index = 0; index < input.size(); index++) {
      Object item =
          dimension == 1
              ? decodeValue(input.get(index), elementType, depth + 1, budget)
              : decodeArray(
                  input.get(index),
                  elementType,
                  dimension - 1,
                  primitiveArray,
                  depth + 1,
                  budget);
      Array.set(output, index, item);
    }
    return output;
  }

  private static TabularData decodeTabular(
      JsonElement element, TabularType type, int depth, Budget budget)
      throws Exception {
    if (!element.isJsonArray()) {
      throw new IllegalArgumentException(
          "OpenType tabular values must be JSON arrays of row objects");
    }
    JsonArray rows = element.getAsJsonArray();
    if (rows.size() > MAXIMUM_CONTAINER_ENTRIES) {
      throw new IllegalArgumentException(
          "OpenType tabular values support at most 50 rows");
    }
    TabularDataSupport table = new TabularDataSupport(type);
    for (JsonElement row : rows) {
      table.put(
          (CompositeData)
              decodeValue(row, type.getRowType(), depth + 1, budget));
    }
    return table;
  }

  private static JsonElement encodeValue(
      Object value, OpenType<?> openType, int depth, Budget budget) {
    if (value == null) {
      throw new IllegalArgumentException("MBean OpenType values cannot be null");
    }
    if (openType instanceof ArrayType && value.getClass().isArray()) {
      ArrayType<?> type = (ArrayType<?>) openType;
      return encodeArray(
          value, type.getElementOpenType(), type.getDimension(), depth, budget);
    }
    budget.visit(depth);
    if (openType instanceof SimpleType) {
      return encodeSimple(value, (SimpleType<?>) openType);
    }
    if (openType instanceof CompositeType && value instanceof CompositeData) {
      CompositeType type = (CompositeType) openType;
      CompositeData composite = (CompositeData) value;
      JsonObject object = new JsonObject();
      for (String key : sortedKeys(type)) {
        object.add(
            key,
            encodeValue(composite.get(key), type.getType(key), depth + 1, budget));
      }
      return object;
    }
    if (openType instanceof TabularType && value instanceof TabularData) {
      TabularType type = (TabularType) openType;
      List<JsonElement> rows = new ArrayList<JsonElement>();
      for (Object row : ((TabularData) value).values()) {
        rows.add(
            encodeValue(row, type.getRowType(), depth + 1, budget));
      }
      Collections.sort(rows, (left, right) -> left.toString().compareTo(right.toString()));
      JsonArray output = new JsonArray();
      for (JsonElement row : rows) {
        output.add(row);
      }
      return output;
    }
    throw new IllegalArgumentException("MBean value does not match its OpenType");
  }

  private static JsonElement encodeSimple(Object value, SimpleType<?> type) {
    if (SimpleType.STRING.equals(type)) {
      return new JsonPrimitive((String) value);
    }
    if (SimpleType.BOOLEAN.equals(type)) {
      return new JsonPrimitive((Boolean) value);
    }
    if (SimpleType.CHARACTER.equals(type)) {
      return new JsonPrimitive(String.valueOf(value));
    }
    if (SimpleType.DATE.equals(type)) {
      return new JsonPrimitive(((Date) value).toInstant().toString());
    }
    if (SimpleType.OBJECTNAME.equals(type)) {
      return new JsonPrimitive(((ObjectName) value).getCanonicalName());
    }
    if (value instanceof BigDecimal) {
      return new JsonPrimitive((BigDecimal) value);
    }
    if (value instanceof BigInteger) {
      return new JsonPrimitive((BigInteger) value);
    }
    if (value instanceof Number) {
      return new JsonPrimitive((Number) value);
    }
    throw new IllegalArgumentException("MBean value does not match its SimpleType");
  }

  private static JsonElement encodeArray(
      Object value,
      OpenType<?> elementType,
      int dimension,
      int depth,
      Budget budget) {
    budget.visit(depth);
    int length = Array.getLength(value);
    if (length > MAXIMUM_CONTAINER_ENTRIES) {
      throw new IllegalArgumentException(
          "MBean OpenType array exceeds the 50 item boundary");
    }
    JsonArray output = new JsonArray();
    for (int index = 0; index < length; index++) {
      Object item = Array.get(value, index);
      output.add(
          dimension == 1
              ? encodeValue(item, elementType, depth + 1, budget)
              : encodeArray(item, elementType, dimension - 1, depth + 1, budget));
    }
    return output;
  }

  private static void validateInput(String input) {
    if (input == null || input.isEmpty() || input.length() > MAXIMUM_JSON_CHARACTERS) {
      throw new IllegalArgumentException(
          "OpenType JSON must contain between 1 byte and 32 KiB");
    }
    int depth = 0;
    boolean inString = false;
    boolean escaped = false;
    for (int index = 0; index < input.length(); index++) {
      char character = input.charAt(index);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character == '\\') {
          escaped = true;
        } else if (character == '"') {
          inString = false;
        }
        continue;
      }
      if (character == '"') {
        inString = true;
      } else if (character == '{' || character == '[') {
        depth++;
        if (depth > MAXIMUM_JSON_NESTING) {
          throw new IllegalArgumentException(
              "OpenType JSON exceeds the nesting boundary");
        }
      } else if (character == '}' || character == ']') {
        depth--;
        if (depth < 0) {
          throw new IllegalArgumentException("OpenType JSON nesting is invalid");
        }
      } else if (character == '\u0000') {
        throw new IllegalArgumentException("OpenType JSON contains a null character");
      }
    }
    if (depth != 0 || inString || escaped) {
      throw new IllegalArgumentException("OpenType JSON is incomplete");
    }
  }

  private static void validateType(OpenType<?> openType, int depth, Budget budget) {
    if (openType == null) {
      throw new IllegalArgumentException("OpenType metadata is missing");
    }
    budget.visit(depth);
    if (openType instanceof SimpleType) {
      if (!isSupportedSimple((SimpleType<?>) openType)) {
        throw new IllegalArgumentException("Unsupported JMX SimpleType");
      }
      return;
    }
    if (openType instanceof CompositeType) {
      CompositeType type = (CompositeType) openType;
      List<String> keys = sortedKeys(type);
      requireContainerSize(keys.size());
      for (String key : keys) {
        validateType(type.getType(key), depth + 1, budget);
      }
      return;
    }
    if (openType instanceof ArrayType) {
      ArrayType<?> type = (ArrayType<?>) openType;
      if (depth + type.getDimension() > MAXIMUM_DEPTH) {
        throw new IllegalArgumentException("OpenType array exceeds the depth boundary");
      }
      validateType(type.getElementOpenType(), depth + type.getDimension(), budget);
      return;
    }
    if (openType instanceof TabularType) {
      validateType(((TabularType) openType).getRowType(), depth + 1, budget);
      return;
    }
    throw new IllegalArgumentException("Unsupported JMX OpenType");
  }

  private static boolean isSupportedSimple(SimpleType<?> type) {
    return SimpleType.STRING.equals(type)
        || SimpleType.BOOLEAN.equals(type)
        || SimpleType.CHARACTER.equals(type)
        || SimpleType.BYTE.equals(type)
        || SimpleType.SHORT.equals(type)
        || SimpleType.INTEGER.equals(type)
        || SimpleType.LONG.equals(type)
        || SimpleType.FLOAT.equals(type)
        || SimpleType.DOUBLE.equals(type)
        || SimpleType.BIGINTEGER.equals(type)
        || SimpleType.BIGDECIMAL.equals(type)
        || SimpleType.DATE.equals(type)
        || SimpleType.OBJECTNAME.equals(type);
  }

  private static Class<?> simpleClass(OpenType<?> type, boolean primitive) {
    if (!(type instanceof SimpleType)) {
      if (type instanceof CompositeType) {
        return CompositeData.class;
      }
      if (type instanceof TabularType) {
        return TabularData.class;
      }
      throw new IllegalArgumentException("Unsupported OpenType array element type");
    }
    SimpleType<?> simple = (SimpleType<?>) type;
    if (primitive) {
      if (SimpleType.BOOLEAN.equals(simple)) return Boolean.TYPE;
      if (SimpleType.BYTE.equals(simple)) return Byte.TYPE;
      if (SimpleType.SHORT.equals(simple)) return Short.TYPE;
      if (SimpleType.INTEGER.equals(simple)) return Integer.TYPE;
      if (SimpleType.LONG.equals(simple)) return Long.TYPE;
      if (SimpleType.FLOAT.equals(simple)) return Float.TYPE;
      if (SimpleType.DOUBLE.equals(simple)) return Double.TYPE;
      if (SimpleType.CHARACTER.equals(simple)) return Character.TYPE;
      throw new IllegalArgumentException("Unsupported primitive OpenType array");
    }
    if (SimpleType.STRING.equals(simple)) return String.class;
    if (SimpleType.BOOLEAN.equals(simple)) return Boolean.class;
    if (SimpleType.BYTE.equals(simple)) return Byte.class;
    if (SimpleType.SHORT.equals(simple)) return Short.class;
    if (SimpleType.INTEGER.equals(simple)) return Integer.class;
    if (SimpleType.LONG.equals(simple)) return Long.class;
    if (SimpleType.FLOAT.equals(simple)) return Float.class;
    if (SimpleType.DOUBLE.equals(simple)) return Double.class;
    if (SimpleType.CHARACTER.equals(simple)) return Character.class;
    if (SimpleType.BIGINTEGER.equals(simple)) return BigInteger.class;
    if (SimpleType.BIGDECIMAL.equals(simple)) return BigDecimal.class;
    if (SimpleType.DATE.equals(simple)) return Date.class;
    if (SimpleType.OBJECTNAME.equals(simple)) return ObjectName.class;
    throw new IllegalArgumentException("Unsupported OpenType array element type");
  }

  private static void appendSchema(
      StringBuilder output, OpenType<?> openType, int depth) {
    if (output.length() >= MAXIMUM_SCHEMA_CHARACTERS) {
      return;
    }
    if (openType instanceof SimpleType) {
      appendBounded(output, simpleSchemaName((SimpleType<?>) openType));
      return;
    }
    if (openType instanceof CompositeType) {
      appendBounded(output, "object{");
      List<String> keys = sortedKeys((CompositeType) openType);
      for (int index = 0; index < keys.size(); index++) {
        if (index > 0) appendBounded(output, ",");
        String key = keys.get(index);
        appendBounded(output, key);
        appendBounded(output, ":");
        appendSchema(output, ((CompositeType) openType).getType(key), depth + 1);
      }
      appendBounded(output, "}");
      return;
    }
    if (openType instanceof ArrayType) {
      ArrayType<?> type = (ArrayType<?>) openType;
      for (int index = 0; index < type.getDimension(); index++) {
        appendBounded(output, "array<");
      }
      appendSchema(output, type.getElementOpenType(), depth + type.getDimension());
      for (int index = 0; index < type.getDimension(); index++) {
        appendBounded(output, ">");
      }
      return;
    }
    if (openType instanceof TabularType) {
      appendBounded(output, "table<");
      appendSchema(output, ((TabularType) openType).getRowType(), depth + 1);
      appendBounded(output, ">");
    }
  }

  private static String simpleSchemaName(SimpleType<?> type) {
    if (SimpleType.STRING.equals(type)) return "string";
    if (SimpleType.BOOLEAN.equals(type)) return "boolean";
    if (SimpleType.CHARACTER.equals(type)) return "character";
    if (SimpleType.DATE.equals(type)) return "date-iso8601";
    if (SimpleType.OBJECTNAME.equals(type)) return "object-name";
    return type.getTypeName().toLowerCase(java.util.Locale.ROOT);
  }

  private static void appendBounded(StringBuilder output, String value) {
    if (output.length() >= MAXIMUM_SCHEMA_CHARACTERS) {
      return;
    }
    int remaining = MAXIMUM_SCHEMA_CHARACTERS - output.length();
    output.append(value, 0, Math.min(value.length(), remaining));
  }

  private static JsonPrimitive requiredPrimitive(JsonElement element) {
    if (!element.isJsonPrimitive()) {
      throw new IllegalArgumentException("OpenType scalar value is invalid");
    }
    return element.getAsJsonPrimitive();
  }

  private static void requireString(JsonPrimitive primitive, OpenType<?> type) {
    if (!primitive.isString()) {
      throw typeMismatch(type);
    }
  }

  private static IllegalArgumentException typeMismatch(OpenType<?> type) {
    return new IllegalArgumentException(
        "OpenType JSON value does not match " + boundedLabel(type.getTypeName()));
  }

  private static List<String> sortedKeys(CompositeType type) {
    List<String> keys = new ArrayList<String>(type.keySet());
    Collections.sort(keys);
    return keys;
  }

  private static void requireContainerSize(int size) {
    if (size > MAXIMUM_CONTAINER_ENTRIES) {
      throw new IllegalArgumentException(
          "OpenType containers support at most 50 declared items");
    }
  }

  private static String boundedLabel(String value) {
    if (value == null) {
      return "";
    }
    return value.length() <= 128 ? value : value.substring(0, 128) + "…";
  }

  private static final class Budget {
    private int nodes;

    private void visit(int depth) {
      if (depth > MAXIMUM_DEPTH) {
        throw new IllegalArgumentException("OpenType value exceeds the depth boundary");
      }
      nodes++;
      if (nodes > MAXIMUM_NODES) {
        throw new IllegalArgumentException("OpenType value exceeds the node boundary");
      }
    }
  }
}
