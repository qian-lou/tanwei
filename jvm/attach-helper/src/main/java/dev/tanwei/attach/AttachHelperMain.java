package dev.tanwei.attach;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
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
    try {
      String currentPid = currentPid();
      List<TargetProcess> targets = new ArrayList<TargetProcess>();
      for (Object descriptor : AttachApi.listVirtualMachines()) {
        String descriptorId = AttachApi.descriptorId(descriptor);
        long pid;
        try {
          pid = Long.parseLong(descriptorId);
        } catch (NumberFormatException ignored) {
          continue;
        }
        boolean self = descriptorId.equals(currentPid);
        targets.add(
            new TargetProcess(
                pid,
                AttachApi.descriptorDisplayName(descriptor),
                !self,
                self ? "Attach Helper 不能 Attach 自身" : null));
      }
      targets.sort(Comparator.comparingLong(TargetProcess::getPid));
      System.out.println(JsonWriter.targets(targets));
      return 0;
    } catch (Exception exception) {
      System.out.println(JsonWriter.error("DISCOVERY_FAILED", safeMessage(exception)));
      return EXIT_OPERATION_FAILED;
    }
  }

  static int attach(Map<String, String> options) {
    return attach(options, AttachHelperMain::loadAgent);
  }

  static int attach(Map<String, String> options, AgentLoader agentLoader) {
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

    try {
      String encodedCorePath =
          Base64.getUrlEncoder()
              .withoutPadding()
              .encodeToString(agentPath.toString().getBytes(StandardCharsets.UTF_8));
      String agentArguments =
          "core=" + encodedCorePath + ";port=" + port + ";secret=" + secret;
      agentLoader.load(pid, bootstrapPath, agentArguments);
    } catch (Exception exception) {
      System.out.println(JsonWriter.error("ATTACH_FAILED", safeMessage(exception)));
      return EXIT_OPERATION_FAILED;
    }
    System.out.println(JsonWriter.success(pid));
    return 0;
  }

  private static void loadAgent(long pid, Path bootstrapPath, String agentArguments)
      throws Exception {
    Object virtualMachine = null;
    try {
      virtualMachine = AttachApi.attach(Long.toString(pid));
      AttachApi.loadAgent(virtualMachine, bootstrapPath.toString(), agentArguments);
    } finally {
      if (virtualMachine != null) {
        try {
          AttachApi.detach(virtualMachine);
        } catch (Exception ignored) {
          // Target may have exited; the primary result is already reported.
        }
      }
    }
  }

  @FunctionalInterface
  interface AgentLoader {
    void load(long pid, Path bootstrapPath, String agentArguments) throws Exception;
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

  private static final class AttachApi {
    private static final String VIRTUAL_MACHINE_CLASS_NAME =
        "com.sun.tools.attach.VirtualMachine";
    private static final String DESCRIPTOR_CLASS_NAME =
        "com.sun.tools.attach.VirtualMachineDescriptor";

    private AttachApi() {}

    static List<?> listVirtualMachines() throws Exception {
      Method list = virtualMachineClass().getMethod("list");
      Object value = invoke(list, null);
      if (!(value instanceof List<?>)) {
        throw new IllegalStateException("Attach API returned an invalid process list");
      }
      return (List<?>) value;
    }

    static String descriptorId(Object descriptor) throws Exception {
      return descriptorValue(descriptor, "id");
    }

    static String descriptorDisplayName(Object descriptor) throws Exception {
      return descriptorValue(descriptor, "displayName");
    }

    static Object attach(String pid) throws Exception {
      Method attach = virtualMachineClass().getMethod("attach", String.class);
      return invoke(attach, null, pid);
    }

    static void loadAgent(Object virtualMachine, String agentPath, String arguments)
        throws Exception {
      Method loadAgent =
          virtualMachineClass().getMethod("loadAgent", String.class, String.class);
      invoke(loadAgent, virtualMachine, agentPath, arguments);
    }

    static void detach(Object virtualMachine) throws Exception {
      Method detach = virtualMachineClass().getMethod("detach");
      invoke(detach, virtualMachine);
    }

    private static String descriptorValue(Object descriptor, String methodName)
        throws Exception {
      if (descriptor == null) {
        throw new IllegalArgumentException("Attach descriptor is required");
      }
      Class<?> descriptorClass = Class.forName(DESCRIPTOR_CLASS_NAME);
      if (!descriptorClass.isInstance(descriptor)) {
        throw new IllegalStateException("Attach API returned an invalid descriptor");
      }
      Object value = invoke(descriptorClass.getMethod(methodName), descriptor);
      if (!(value instanceof String)) {
        throw new IllegalStateException("Attach descriptor returned an invalid " + methodName);
      }
      return (String) value;
    }

    private static Class<?> virtualMachineClass() throws ClassNotFoundException {
      return Class.forName(VIRTUAL_MACHINE_CLASS_NAME);
    }

    private static Object invoke(Method method, Object target, Object... arguments)
        throws Exception {
      try {
        return method.invoke(target, arguments);
      } catch (InvocationTargetException exception) {
        Throwable cause = exception.getCause();
        if (cause instanceof Exception) {
          throw (Exception) cause;
        }
        if (cause instanceof Error) {
          throw (Error) cause;
        }
        throw new IllegalStateException("Attach API invocation failed", cause);
      }
    }
  }
}
