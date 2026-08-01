package dev.tanwei.attach;

import com.sun.tools.attach.VirtualMachine;
import com.sun.tools.attach.VirtualMachineDescriptor;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class AttachHelperMain {
  private static final int EXIT_INVALID_INPUT = 2;
  private static final int EXIT_OPERATION_FAILED = 3;

  private AttachHelperMain() {}

  public static void main(String[] args) {
    int exitCode;
    try {
      exitCode = run(args);
    } catch (RuntimeException exception) {
      System.out.println(JsonWriter.error("UNEXPECTED_ERROR", safeMessage(exception)));
      exitCode = EXIT_OPERATION_FAILED;
    }
    if (exitCode != 0) {
      System.exit(exitCode);
    }
  }

  static int run(String[] args) {
    if (args == null || args.length == 0) {
      System.out.println(JsonWriter.error("INVALID_COMMAND", "必须指定 list 或 attach"));
      return EXIT_INVALID_INPUT;
    }
    switch (args[0]) {
      case "list":
        return listProcesses();
      case "attach":
        return attach(parseOptions(args));
      default:
        System.out.println(JsonWriter.error("INVALID_COMMAND", "未知命令: " + args[0]));
        return EXIT_INVALID_INPUT;
    }
  }

  private static int listProcesses() {
    String currentPid = currentPid();
    List<TargetProcess> targets = new ArrayList<TargetProcess>();
    for (VirtualMachineDescriptor descriptor : VirtualMachine.list()) {
      long pid;
      try {
        pid = Long.parseLong(descriptor.id());
      } catch (NumberFormatException ignored) {
        continue;
      }
      boolean self = descriptor.id().equals(currentPid);
      targets.add(
          new TargetProcess(
              pid,
              descriptor.displayName(),
              !self,
              self ? "Attach Helper 不能 Attach 自身" : null));
    }
    targets.sort(Comparator.comparingLong(TargetProcess::getPid));
    System.out.println(JsonWriter.targets(targets));
    return 0;
  }

  private static int attach(Map<String, String> options) {
    String pidValue = options.get("pid");
    String bootstrapValue = options.get("bootstrap");
    String agentValue = options.get("agent");
    String portValue = options.get("port");
    String secret = options.get("secret");
    if (pidValue == null
        || bootstrapValue == null
        || agentValue == null
        || portValue == null
        || secret == null) {
      System.out.println(
          JsonWriter.error(
              "INVALID_ARGUMENT",
              "attach 需要 --pid、--bootstrap、--agent、--port 和 --secret"));
      return EXIT_INVALID_INPUT;
    }

    long pid;
    int port;
    try {
      pid = Long.parseLong(pidValue);
      port = Integer.parseInt(portValue);
    } catch (NumberFormatException exception) {
      System.out.println(JsonWriter.error("INVALID_ARGUMENT", "PID 或端口不是有效整数"));
      return EXIT_INVALID_INPUT;
    }
    if (pid <= 0 || port <= 0 || port > 65_535 || secret.length() < 32) {
      System.out.println(JsonWriter.error("INVALID_ARGUMENT", "PID、端口或会话密钥无效"));
      return EXIT_INVALID_INPUT;
    }

    Path bootstrapPath = Paths.get(bootstrapValue).toAbsolutePath().normalize();
    Path agentPath = Paths.get(agentValue).toAbsolutePath().normalize();
    if (!Files.isRegularFile(bootstrapPath)) {
      System.out.println(JsonWriter.error("BOOTSTRAP_NOT_FOUND", "Agent Bootstrap 文件不存在"));
      return EXIT_INVALID_INPUT;
    }
    if (!Files.isRegularFile(agentPath)) {
      System.out.println(JsonWriter.error("AGENT_NOT_FOUND", "Agent Core 文件不存在"));
      return EXIT_INVALID_INPUT;
    }

    VirtualMachine virtualMachine = null;
    try {
      virtualMachine = VirtualMachine.attach(Long.toString(pid));
      String encodedCorePath =
          Base64.getUrlEncoder()
              .withoutPadding()
              .encodeToString(agentPath.toString().getBytes(StandardCharsets.UTF_8));
      String agentArguments =
          "core=" + encodedCorePath + ";port=" + port + ";secret=" + secret;
      virtualMachine.loadAgent(bootstrapPath.toString(), agentArguments);
      System.out.println(JsonWriter.success(pid));
      return 0;
    } catch (Exception exception) {
      System.out.println(JsonWriter.error("ATTACH_FAILED", safeMessage(exception)));
      return EXIT_OPERATION_FAILED;
    } finally {
      if (virtualMachine != null) {
        try {
          virtualMachine.detach();
        } catch (Exception ignored) {
          // Target may have exited; the primary result is already reported.
        }
      }
    }
  }

  private static Map<String, String> parseOptions(String[] args) {
    Map<String, String> options = new HashMap<String, String>(8);
    for (int index = 1; index < args.length; index++) {
      String argument = args[index];
      if (!argument.startsWith("--") || index + 1 >= args.length) {
        continue;
      }
      options.put(argument.substring(2), args[++index]);
    }
    return options;
  }

  private static String currentPid() {
    String runtimeName = java.lang.management.ManagementFactory.getRuntimeMXBean().getName();
    int separator = runtimeName.indexOf('@');
    return separator > 0 ? runtimeName.substring(0, separator) : runtimeName;
  }

  private static String safeMessage(Exception exception) {
    String message = exception.getMessage();
    return message == null || message.trim().isEmpty()
        ? exception.getClass().getSimpleName()
        : message;
  }
}
