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
    ProcessMetadata processMetadata = ProcessMetadata.read(pid);
    this.arguments =
        immutableArguments(
            processMetadata == null ? null : processMetadata.arguments,
            tokens);
    this.javaPath = processMetadata == null ? null : processMetadata.command;
    this.user = processMetadata == null ? null : processMetadata.user;
    this.startTime = processMetadata == null ? null : processMetadata.startTime;
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

  private static final class ProcessMetadata {
    private static final String PROCESS_HANDLE_CLASS_NAME = "java.lang.ProcessHandle";
    private static final String PROCESS_INFO_CLASS_NAME = "java.lang.ProcessHandle$Info";

    private final String[] arguments;
    private final String command;
    private final String user;
    private final String startTime;

    private ProcessMetadata(
        String[] arguments,
        String command,
        String user,
        String startTime) {
      this.arguments = arguments;
      this.command = command;
      this.user = user;
      this.startTime = startTime;
    }

    static ProcessMetadata read(long pid) {
      try {
        Class<?> processHandleClass = Class.forName(PROCESS_HANDLE_CLASS_NAME);
        Object handle =
            optionalValue(
                processHandleClass
                    .getMethod("of", long.class)
                    .invoke(null, Long.valueOf(pid)));
        if (handle == null) {
          return null;
        }
        Object info = processHandleClass.getMethod("info").invoke(handle);
        Class<?> processInfoClass = Class.forName(PROCESS_INFO_CLASS_NAME);
        if (!processInfoClass.isInstance(info)) {
          return null;
        }
        Object arguments =
            optionalValue(processInfoClass.getMethod("arguments").invoke(info));
        Object command =
            optionalValue(processInfoClass.getMethod("command").invoke(info));
        Object user = optionalValue(processInfoClass.getMethod("user").invoke(info));
        Object startTime =
            optionalValue(processInfoClass.getMethod("startInstant").invoke(info));
        return new ProcessMetadata(
            arguments instanceof String[] ? (String[]) arguments : null,
            command instanceof String ? (String) command : null,
            user instanceof String ? (String) user : null,
            startTime == null ? null : startTime.toString());
      } catch (ReflectiveOperationException exception) {
        return null;
      } catch (LinkageError error) {
        return null;
      } catch (RuntimeException exception) {
        return null;
      }
    }

    private static Object optionalValue(Object value) {
      return value instanceof Optional<?> ? ((Optional<?>) value).orElse(null) : null;
    }
  }
}
