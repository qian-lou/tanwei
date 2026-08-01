package dev.tanwei.attach;

import java.util.List;

final class JsonWriter {

  private JsonWriter() {}

  static String targets(List<TargetProcess> targets) {
    StringBuilder builder = new StringBuilder(Math.max(16, targets.size() * 128));
    builder.append('[');
    for (int index = 0; index < targets.size(); index++) {
      if (index > 0) {
        builder.append(',');
      }
      appendTarget(builder, targets.get(index));
    }
    return builder.append(']').toString();
  }

  static String success(long pid) {
    return "{\"ok\":true,\"pid\":" + pid + "}";
  }

  static String error(String code, String message) {
    StringBuilder builder = new StringBuilder(128);
    builder.append("{\"ok\":false,\"errorCode\":");
    appendString(builder, code);
    builder.append(",\"errorMessage\":");
    appendString(builder, message);
    return builder.append('}').toString();
  }

  private static void appendTarget(StringBuilder builder, TargetProcess target) {
    builder.append("{\"id\":");
    appendString(builder, "local:" + target.getPid());
    builder.append(",\"pid\":").append(target.getPid());
    builder.append(",\"displayName\":");
    appendString(builder, target.getDisplayName());
    builder.append(",\"mainClass\":");
    appendString(builder, target.getMainClass());
    builder.append(",\"arguments\":[");
    List<String> arguments = target.getArguments();
    for (int index = 0; index < arguments.size(); index++) {
      if (index > 0) {
        builder.append(',');
      }
      appendString(builder, arguments.get(index));
    }
    builder.append("],\"javaPath\":");
    appendNullableString(builder, target.getJavaPath());
    builder.append(",\"javaVersion\":null,\"user\":");
    appendNullableString(builder, target.getUser());
    builder.append(",\"startTime\":");
    appendNullableString(builder, target.getStartTime());
    builder.append(",\"attachable\":");
    builder.append(target.isAttachable());
    builder.append(",\"attachReason\":");
    if (target.getAttachReason() == null) {
      builder.append("null");
    } else {
      appendString(builder, target.getAttachReason());
    }
    builder.append('}');
  }

  private static void appendString(StringBuilder builder, String value) {
    builder.append('"');
    for (int index = 0; index < value.length(); index++) {
      char character = value.charAt(index);
      switch (character) {
        case '"':
          builder.append("\\\"");
          break;
        case '\\':
          builder.append("\\\\");
          break;
        case '\b':
          builder.append("\\b");
          break;
        case '\f':
          builder.append("\\f");
          break;
        case '\n':
          builder.append("\\n");
          break;
        case '\r':
          builder.append("\\r");
          break;
        case '\t':
          builder.append("\\t");
          break;
        default:
          if (character < 0x20) {
            builder.append(String.format("\\u%04x", (int) character));
          } else {
            builder.append(character);
          }
      }
    }
    builder.append('"');
  }

  private static void appendNullableString(StringBuilder builder, String value) {
    if (value == null) {
      builder.append("null");
    } else {
      appendString(builder, value);
    }
  }
}
