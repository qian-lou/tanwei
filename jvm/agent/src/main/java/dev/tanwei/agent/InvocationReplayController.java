package dev.tanwei.agent;

import java.lang.instrument.Instrumentation;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Future;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

final class InvocationReplayController implements AutoCloseable {
  private static final int MAXIMUM_ARGUMENTS = 8;
  private static final int MAXIMUM_RENDERED_VALUE_LENGTH = 512;
  private static final long INVOCATION_TIMEOUT_MILLIS = 2_000L;

  private final Instrumentation instrumentation;
  private final ReceiverStateCapture receiverStateCapture;
  private final ThreadPoolExecutor executor;

  InvocationReplayController(Instrumentation instrumentation) {
    this(
        instrumentation,
        receiver -> ReceiverStateSnapshot.unavailable());
  }

  InvocationReplayController(
      Instrumentation instrumentation,
      ReceiverStateCapture receiverStateCapture) {
    if (instrumentation == null || receiverStateCapture == null) {
      throw new IllegalArgumentException(
          "Instrumentation and receiver state capture are required");
    }
    this.instrumentation = instrumentation;
    this.receiverStateCapture = receiverStateCapture;
    this.executor =
        new ThreadPoolExecutor(
            0,
            2,
            30L,
            TimeUnit.SECONDS,
            new SynchronousQueue<Runnable>(),
            new ReplayThreadFactory(),
            new ThreadPoolExecutor.AbortPolicy());
  }

  Preview preview(
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      List<String> arguments)
      throws Exception {
    return preview(
        className,
        classLoader,
        methodName,
        parameterTypes,
        arguments,
        0L,
        null);
  }

  Preview preview(
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      List<String> arguments,
      long snapshotId,
      Object receiver)
      throws Exception {
    Selection selection =
        resolveSelection(
            className,
            classLoader,
            methodName,
            parameterTypes,
            arguments,
            snapshotId,
            receiver);
    ReceiverStateSnapshot currentReceiverState =
        captureReceiverState(selection.receiver);
    return new Preview(
        fingerprint(selection, arguments),
        selection.target.getName(),
        classLoaderName(selection.target),
        selection.method.toGenericString(),
        renderInvocation(selection, arguments),
        selection.method.getReturnType().getTypeName(),
        selection.replayMode,
        selection.receiverType,
        currentReceiverState);
  }

  Result invoke(
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      List<String> arguments,
      String expectedFingerprint)
      throws Exception {
    return invoke(
        className,
        classLoader,
        methodName,
        parameterTypes,
        arguments,
        expectedFingerprint,
        0L,
        null);
  }

  Result invoke(
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      List<String> arguments,
      String expectedFingerprint,
      long snapshotId,
      Object receiver)
      throws Exception {
    final Selection selection =
        resolveSelection(
            className,
            classLoader,
            methodName,
            parameterTypes,
            arguments,
            snapshotId,
            receiver);
    String currentFingerprint = fingerprint(selection, arguments);
    if (!currentFingerprint.equals(expectedFingerprint)) {
      throw new StaleReplayException(currentFingerprint);
    }
    final ReceiverStateSnapshot beforeReceiverState =
        captureReceiverState(selection.receiver);
    final Object[] converted = convertArguments(selection.method, arguments);
    Future<Result> task =
        executor.submit(
            () -> {
              Thread thread = Thread.currentThread();
              ClassLoader previousLoader = thread.getContextClassLoader();
              try {
                thread.setContextClassLoader(selection.target.getClassLoader());
                Object value =
                    selection.method.invoke(selection.receiver, converted);
                return Result.returned(
                    safeValue(value),
                    beforeReceiverState,
                    captureReceiverState(selection.receiver));
              } catch (InvocationTargetException exception) {
                Throwable cause =
                    exception.getCause() == null ? exception : exception.getCause();
                return Result.threw(
                    cause.getClass().getName(),
                    safeValue(cause.getMessage()),
                    beforeReceiverState,
                    captureReceiverState(selection.receiver));
              } finally {
                thread.setContextClassLoader(previousLoader);
              }
            });
    try {
      return task.get(INVOCATION_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
    } catch (TimeoutException exception) {
      task.cancel(true);
      throw new ReplayTimeoutException();
    }
  }

  @Override
  public void close() {
    executor.shutdownNow();
  }

  private Selection resolveSelection(
      String className,
      String classLoader,
      String methodName,
      String parameterTypes,
      List<String> arguments,
      long snapshotId,
      Object receiver) {
    if (arguments == null || arguments.size() > MAXIMUM_ARGUMENTS) {
      throw new IllegalArgumentException(
          "Controlled replay supports at most 8 scalar arguments");
    }
    Class<?> target = findClass(className, classLoader);
    if (target == null) {
      throw new IllegalArgumentException("The selected replay class is no longer loaded");
    }
    if (target.getClassLoader() == null
        || target.getName().startsWith("java.")
        || target.getName().startsWith("javax.")
        || target.getName().startsWith("jdk.")
        || target.getName().startsWith("sun.")
        || target.getName().startsWith("com.sun.")) {
      throw new IllegalArgumentException(
          "Bootstrap and JDK implementation classes cannot be replayed");
    }
    Method method = findMethod(target, methodName, parameterTypes);
    if (method == null) {
      throw new IllegalArgumentException("The selected replay method was not found");
    }
    int modifiers = method.getModifiers();
    if (!Modifier.isPublic(target.getModifiers())
        || !Modifier.isPublic(modifiers)
        || Modifier.isAbstract(modifiers)
        || Modifier.isNative(modifiers)) {
      throw new IllegalArgumentException(
          "Controlled replay is limited to public non-native methods");
    }
    boolean staticMethod = Modifier.isStatic(modifiers);
    if (!staticMethod) {
      if (snapshotId <= 0L) {
        throw new IllegalArgumentException(
            "Instance replay requires the originating live snapshot");
      }
      if (receiver == null) {
        throw new ReceiverExpiredException();
      }
      if (!target.isInstance(receiver)) {
        throw new IllegalArgumentException(
            "The snapshot receiver no longer matches the selected replay class");
      }
    }
    Class<?>[] types = method.getParameterTypes();
    if (types.length != arguments.size()) {
      throw new IllegalArgumentException(
          "Replay argument count does not match the selected method");
    }
    for (Class<?> type : types) {
      if (!isSupportedScalar(type)) {
        throw new IllegalArgumentException(
            "Controlled replay only accepts strings, primitives, wrappers and enums");
      }
    }
    return new Selection(
        target,
        method,
        staticMethod ? null : receiver,
        staticMethod ? 0L : snapshotId,
        staticMethod ? "STATIC" : "INSTANCE");
  }

  private Class<?> findClass(String name, String classLoader) {
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      if (type.getName().equals(name)
          && classLoaderName(type).equals(classLoader)) {
        return type;
      }
    }
    return null;
  }

  private static Method findMethod(
      Class<?> target, String methodName, String parameterTypes) {
    for (Method method : target.getDeclaredMethods()) {
      if (method.getName().equals(methodName)
          && joinParameterTypes(method).equals(parameterTypes)) {
        return method;
      }
    }
    return null;
  }

  private static String joinParameterTypes(Method method) {
    Class<?>[] types = method.getParameterTypes();
    List<String> names = new ArrayList<String>(types.length);
    for (Class<?> type : types) {
      names.add(type.getTypeName());
    }
    return String.join(",", names);
  }

  private static boolean isSupportedScalar(Class<?> type) {
    return type == String.class
        || type == boolean.class
        || type == Boolean.class
        || type == byte.class
        || type == Byte.class
        || type == short.class
        || type == Short.class
        || type == int.class
        || type == Integer.class
        || type == long.class
        || type == Long.class
        || type == float.class
        || type == Float.class
        || type == double.class
        || type == Double.class
        || type == char.class
        || type == Character.class
        || type.isEnum();
  }

  private static Object[] convertArguments(Method method, List<String> arguments) {
    Class<?>[] types = method.getParameterTypes();
    Object[] converted = new Object[types.length];
    for (int index = 0; index < types.length; index++) {
      converted[index] = convertArgument(types[index], arguments.get(index));
    }
    return converted;
  }

  @SuppressWarnings({"rawtypes", "unchecked"})
  private static Object convertArgument(Class<?> type, String value) {
    if (type == String.class) {
      return value;
    }
    if (type == boolean.class || type == Boolean.class) {
      if (!"true".equalsIgnoreCase(value) && !"false".equalsIgnoreCase(value)) {
        throw new IllegalArgumentException("Boolean replay arguments must be true or false");
      }
      return Boolean.valueOf(value);
    }
    if (type == byte.class || type == Byte.class) {
      return Byte.valueOf(value);
    }
    if (type == short.class || type == Short.class) {
      return Short.valueOf(value);
    }
    if (type == int.class || type == Integer.class) {
      return Integer.valueOf(value);
    }
    if (type == long.class || type == Long.class) {
      return Long.valueOf(value);
    }
    if (type == float.class || type == Float.class) {
      Float parsed = Float.valueOf(value);
      if (!Float.isFinite(parsed.floatValue())) {
        throw new IllegalArgumentException("Float replay arguments must be finite");
      }
      return parsed;
    }
    if (type == double.class || type == Double.class) {
      Double parsed = Double.valueOf(value);
      if (!Double.isFinite(parsed.doubleValue())) {
        throw new IllegalArgumentException("Double replay arguments must be finite");
      }
      return parsed;
    }
    if (type == char.class || type == Character.class) {
      if (value.length() != 1) {
        throw new IllegalArgumentException(
            "Character replay arguments must contain exactly one character");
      }
      return Character.valueOf(value.charAt(0));
    }
    if (type.isEnum()) {
      return Enum.valueOf((Class<? extends Enum>) type, value);
    }
    throw new IllegalArgumentException("Unsupported replay argument type");
  }

  private static String fingerprint(Selection selection, List<String> arguments)
      throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    updateDigest(digest, selection.target.getName());
    updateDigest(digest, classLoaderName(selection.target));
    updateDigest(digest, selection.method.toGenericString());
    updateDigest(digest, selection.replayMode);
    if (selection.receiver != null) {
      updateDigest(digest, Long.toString(selection.snapshotId));
      updateDigest(digest, selection.receiverType);
      updateDigest(
          digest,
          Integer.toHexString(System.identityHashCode(selection.receiver)));
    }
    for (String argument : arguments) {
      updateDigest(digest, argument);
    }
    byte[] value = digest.digest();
    StringBuilder result = new StringBuilder(value.length * 2);
    for (byte item : value) {
      result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
    }
    return result.toString();
  }

  private static void updateDigest(MessageDigest digest, String value) {
    byte[] encoded = value.getBytes(StandardCharsets.UTF_8);
    digest.update((byte) (encoded.length >>> 24));
    digest.update((byte) (encoded.length >>> 16));
    digest.update((byte) (encoded.length >>> 8));
    digest.update((byte) encoded.length);
    digest.update(encoded);
  }

  private static String renderInvocation(
      Selection selection, List<String> arguments) {
    StringBuilder result =
        new StringBuilder();
    if (selection.receiver == null) {
      result.append(selection.target.getName());
    } else {
      result
          .append("<receiver:")
          .append(selection.receiverType)
          .append('@')
          .append(
              Integer.toHexString(System.identityHashCode(selection.receiver)))
          .append('>');
    }
    result.append('.').append(selection.method.getName()).append('(');
    for (int index = 0; index < arguments.size(); index++) {
      if (index > 0) {
        result.append(", ");
      }
      result.append('"').append(escape(arguments.get(index))).append('"');
    }
    return result.append(')').toString();
  }

  private static String escape(String value) {
    return value
        .replace("\\", "\\\\")
        .replace("\r", "\\r")
        .replace("\n", "\\n")
        .replace("\"", "\\\"");
  }

  private static String safeValue(Object value) {
    if (value == null) {
      return "null";
    }
    try {
      boolean scalar =
          value instanceof CharSequence
              || value instanceof Number
              || value instanceof Boolean
              || value instanceof Character
              || value instanceof Enum;
      String rendered =
          scalar ? String.valueOf(value) : "<" + value.getClass().getName() + ">";
      return rendered.length() <= MAXIMUM_RENDERED_VALUE_LENGTH
          ? rendered
          : rendered.substring(0, MAXIMUM_RENDERED_VALUE_LENGTH) + "…";
    } catch (Throwable ignored) {
      return "<unavailable>";
    }
  }

  private ReceiverStateSnapshot captureReceiverState(Object receiver) {
    if (receiver == null) {
      return ReceiverStateSnapshot.empty();
    }
    try {
      ReceiverStateSnapshot state = receiverStateCapture.capture(receiver);
      return state == null ? ReceiverStateSnapshot.unavailable() : state;
    } catch (Throwable ignored) {
      return ReceiverStateSnapshot.unavailable();
    }
  }

  private static String classLoaderName(Class<?> type) {
    ClassLoader loader = type.getClassLoader();
    return loader == null ? "bootstrap" : loader.toString();
  }

  static final class StaleReplayException extends IllegalStateException {
    private final String actualFingerprint;

    StaleReplayException(String actualFingerprint) {
      super("The replay target or arguments changed after preview");
      this.actualFingerprint = actualFingerprint;
    }

    String getActualFingerprint() {
      return actualFingerprint;
    }
  }

  static final class ReplayTimeoutException extends IllegalStateException {
    ReplayTimeoutException() {
      super(
          "The invocation exceeded 2 seconds; interruption was requested but target code may continue");
    }
  }

  static final class ReceiverExpiredException extends IllegalStateException {
    ReceiverExpiredException() {
      super(
          "The original instance receiver was reclaimed before replay; capture a new snapshot");
    }
  }

  static final class Preview {
    private final String fingerprint;
    private final String className;
    private final String classLoader;
    private final String method;
    private final String invocation;
    private final String returnType;
    private final String replayMode;
    private final String receiverType;
    private final ReceiverStateSnapshot receiverState;

    Preview(
        String fingerprint,
        String className,
        String classLoader,
        String method,
        String invocation,
        String returnType,
        String replayMode,
        String receiverType,
        ReceiverStateSnapshot receiverState) {
      this.fingerprint = fingerprint;
      this.className = className;
      this.classLoader = classLoader;
      this.method = method;
      this.invocation = invocation;
      this.returnType = returnType;
      this.replayMode = replayMode;
      this.receiverType = receiverType;
      this.receiverState = receiverState;
    }

    String getFingerprint() {
      return fingerprint;
    }

    String getClassName() {
      return className;
    }

    String getClassLoader() {
      return classLoader;
    }

    String getMethod() {
      return method;
    }

    String getInvocation() {
      return invocation;
    }

    String getReturnType() {
      return returnType;
    }

    String getReplayMode() {
      return replayMode;
    }

    String getReceiverType() {
      return receiverType;
    }

    ReceiverStateSnapshot getReceiverState() {
      return receiverState;
    }
  }

  static final class Result {
    private final String outcome;
    private final String returnValue;
    private final String exceptionType;
    private final String exceptionMessage;
    private final ReceiverStateSnapshot beforeReceiverState;
    private final ReceiverStateSnapshot afterReceiverState;

    private Result(
        String outcome,
        String returnValue,
        String exceptionType,
        String exceptionMessage,
        ReceiverStateSnapshot beforeReceiverState,
        ReceiverStateSnapshot afterReceiverState) {
      this.outcome = outcome;
      this.returnValue = returnValue;
      this.exceptionType = exceptionType;
      this.exceptionMessage = exceptionMessage;
      this.beforeReceiverState = beforeReceiverState;
      this.afterReceiverState = afterReceiverState;
    }

    static Result returned(
        String returnValue,
        ReceiverStateSnapshot beforeReceiverState,
        ReceiverStateSnapshot afterReceiverState) {
      return new Result(
          "RETURNED",
          returnValue,
          "",
          "",
          beforeReceiverState,
          afterReceiverState);
    }

    static Result threw(
        String exceptionType,
        String exceptionMessage,
        ReceiverStateSnapshot beforeReceiverState,
        ReceiverStateSnapshot afterReceiverState) {
      return new Result(
          "THREW",
          "",
          exceptionType,
          exceptionMessage,
          beforeReceiverState,
          afterReceiverState);
    }

    String getOutcome() {
      return outcome;
    }

    String getReturnValue() {
      return returnValue;
    }

    String getExceptionType() {
      return exceptionType;
    }

    String getExceptionMessage() {
      return exceptionMessage;
    }

    ReceiverStateSnapshot getBeforeReceiverState() {
      return beforeReceiverState;
    }

    ReceiverStateSnapshot getAfterReceiverState() {
      return afterReceiverState;
    }
  }

  interface ReceiverStateCapture {
    ReceiverStateSnapshot capture(Object receiver);
  }

  private static final class Selection {
    private final Class<?> target;
    private final Method method;
    private final Object receiver;
    private final long snapshotId;
    private final String replayMode;
    private final String receiverType;

    private Selection(
        Class<?> target,
        Method method,
        Object receiver,
        long snapshotId,
        String replayMode) {
      this.target = target;
      this.method = method;
      this.receiver = receiver;
      this.snapshotId = snapshotId;
      this.replayMode = replayMode;
      this.receiverType =
          receiver == null ? "" : receiver.getClass().getName();
    }
  }

  private static final class ReplayThreadFactory implements ThreadFactory {
    private final AtomicInteger sequence = new AtomicInteger();

    @Override
    public Thread newThread(Runnable runnable) {
      Thread thread =
          new Thread(
              runnable,
              "tanwei-invocation-replay-" + sequence.incrementAndGet());
      thread.setDaemon(true);
      return thread;
    }
  }
}
