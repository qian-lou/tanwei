package dev.tanwei.attach;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

final class TargetProcess {
  private final long pid;
  private final String displayName;
  private final String mainClass;
  private final List<String> arguments;
  private final String javaPath;
  private final String user;
  private final String startTime;
  private final boolean attachable;
  private final String attachReason;

  TargetProcess(long pid, String displayName, boolean attachable, String attachReason) {
    if (pid <= 0) {
      throw new IllegalArgumentException("pid must be positive");
    }
    this.pid = pid;
    this.displayName = Objects.requireNonNull(displayName, "displayName");
    List<String> tokens = tokenize(displayName);
    this.mainClass = tokens.isEmpty() ? "" : tokens.get(0);
    Optional<ProcessHandle> processHandle = ProcessHandle.of(pid);
    ProcessHandle.Info processInfo =
        processHandle.map(ProcessHandle::info).orElse(null);
    String[] processArguments =
        processInfo == null ? null : processInfo.arguments().orElse(null);
    this.arguments = immutableArguments(processArguments, tokens);
    this.javaPath =
        processInfo == null ? null : processInfo.command().orElse(null);
    this.user = processInfo == null ? null : processInfo.user().orElse(null);
    this.startTime =
        processInfo == null
            ? null
            : processInfo.startInstant().map(Object::toString).orElse(null);
    this.attachable = attachable;
    this.attachReason = attachReason;
  }

  long getPid() {
    return pid;
  }

  String getDisplayName() {
    return displayName;
  }

  String getMainClass() {
    return mainClass;
  }

  List<String> getArguments() {
    return arguments;
  }

  String getJavaPath() {
    return javaPath;
  }

  String getUser() {
    return user;
  }

  String getStartTime() {
    return startTime;
  }

  boolean isAttachable() {
    return attachable;
  }

  String getAttachReason() {
    return attachReason;
  }

  private static List<String> tokenize(String value) {
    if (value.trim().isEmpty()) {
      return Collections.emptyList();
    }
    List<String> result = new ArrayList<String>();
    StringBuilder current = new StringBuilder();
    boolean quoted = false;
    char quote = '\0';
    for (int index = 0; index < value.length(); index++) {
      char character = value.charAt(index);
      if ((character == '"' || character == '\'') && (!quoted || quote == character)) {
        if (quoted) {
          quoted = false;
          quote = '\0';
        } else {
          quoted = true;
          quote = character;
        }
      } else if (Character.isWhitespace(character) && !quoted) {
        appendToken(result, current);
      } else {
        current.append(character);
      }
    }
    appendToken(result, current);
    return result;
  }

  private static List<String> immutableArguments(
      String[] processArguments, List<String> displayTokens) {
    if (processArguments != null && processArguments.length > 0) {
      List<String> result = new ArrayList<String>(processArguments.length);
      Collections.addAll(result, processArguments);
      return Collections.unmodifiableList(result);
    }
    return displayTokens.size() <= 1
        ? Collections.<String>emptyList()
        : Collections.unmodifiableList(
            new ArrayList<String>(displayTokens.subList(1, displayTokens.size())));
  }

  private static void appendToken(List<String> result, StringBuilder current) {
    if (current.length() > 0) {
      result.add(current.toString());
      current.setLength(0);
    }
  }
}
