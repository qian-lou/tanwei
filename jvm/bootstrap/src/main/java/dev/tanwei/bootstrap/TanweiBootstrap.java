package dev.tanwei.bootstrap;

import java.io.InputStream;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;
import java.util.Enumeration;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;

public final class TanweiBootstrap {
  private static final Object LIFECYCLE_LOCK = new Object();
  private static final String CORE_PREFIX = "core=";
  private static final String LATENCY_BRIDGE_PREFIX =
      "dev/tanwei/bootstrap/ThreadPoolLatencyBridge";
  private static URLClassLoader runtimeClassLoader;
  private static Method stopMethod;
  private static JarFile bootstrapSearchJar;

  private TanweiBootstrap() {}

  public static void premain(String arguments, Instrumentation instrumentation) {
    start(arguments, instrumentation);
  }

  public static void agentmain(String arguments, Instrumentation instrumentation) {
    start(arguments, instrumentation);
  }

  private static void start(String arguments, Instrumentation instrumentation) {
    ParsedArguments parsed = parse(arguments);
    synchronized (LIFECYCLE_LOCK) {
      stopLocked();
      try {
        URL coreUrl = parsed.corePath.toUri().toURL();
        URLClassLoader classLoader = new URLClassLoader(new URL[] {coreUrl}, null);
        Thread currentThread = Thread.currentThread();
        ClassLoader previousContextLoader = currentThread.getContextClassLoader();
        try {
          currentThread.setContextClassLoader(classLoader);
          Class<?> entrypoint =
              Class.forName(
                  "dev.tanwei.agent.RuntimeEntrypoint",
                  true,
                  classLoader);
          Method start =
              entrypoint.getMethod(
                  "start",
                  String.class,
                  Instrumentation.class);
          Method stop = entrypoint.getMethod("stop");
          start.invoke(null, parsed.runtimeArguments, instrumentation);
          runtimeClassLoader = classLoader;
          stopMethod = stop;
        } catch (Exception exception) {
          close(classLoader);
          throw unwrap("Unable to start Tanwei Agent runtime", exception);
        } finally {
          currentThread.setContextClassLoader(previousContextLoader);
        }
      } catch (RuntimeException exception) {
        throw exception;
      } catch (Exception exception) {
        throw new IllegalStateException("Unable to create Agent ClassLoader", exception);
      }
    }
  }

  public static void stop() {
    synchronized (LIFECYCLE_LOCK) {
      stopLocked();
    }
  }

  public static void installBootstrapBridge(Instrumentation instrumentation) {
    if (instrumentation == null) {
      throw new IllegalArgumentException("instrumentation is required");
    }
    synchronized (LIFECYCLE_LOCK) {
      if (bootstrapSearchJar != null) {
        return;
      }
      try {
        URL location =
            TanweiBootstrap.class
                .getProtectionDomain()
                .getCodeSource()
                .getLocation();
        Path path = Paths.get(location.toURI()).toAbsolutePath().normalize();
        if (!Files.isRegularFile(path)) {
          throw new IllegalStateException(
              "Tanwei bootstrap code source is not a regular file");
        }
        Path bridgePath = createLatencyBridgeJar(path);
        JarFile jar = new JarFile(bridgePath.toFile());
        try {
          instrumentation.appendToBootstrapClassLoaderSearch(jar);
          Class.forName(
              "dev.tanwei.bootstrap.ThreadPoolLatencyBridge",
              true,
              null);
          bootstrapSearchJar = jar;
        } catch (Throwable failure) {
          try {
            jar.close();
          } catch (Exception ignored) {
            // The original installation failure is authoritative.
          }
          throw failure;
        }
      } catch (RuntimeException exception) {
        throw exception;
      } catch (Throwable exception) {
        throw new IllegalStateException(
            "Unable to install the bootstrap diagnostics bridge",
            exception);
      }
    }
  }

  private static Path createLatencyBridgeJar(Path sourcePath) throws Exception {
    Path output =
        Files.createTempFile("tanwei-thread-pool-latency-", ".jar");
    boolean complete = false;
    try (JarFile source = new JarFile(sourcePath.toFile());
        JarOutputStream target =
            new JarOutputStream(Files.newOutputStream(output))) {
      Enumeration<JarEntry> entries = source.entries();
      int copied = 0;
      while (entries.hasMoreElements()) {
        JarEntry entry = entries.nextElement();
        String name = entry.getName();
        if (!entry.isDirectory()
            && name.startsWith(LATENCY_BRIDGE_PREFIX)
            && name.endsWith(".class")) {
          target.putNextEntry(new JarEntry(name));
          try (InputStream input = source.getInputStream(entry)) {
            byte[] buffer = new byte[8_192];
            int read;
            while ((read = input.read(buffer)) >= 0) {
              if (read > 0) {
                target.write(buffer, 0, read);
              }
            }
          }
          target.closeEntry();
          copied++;
        }
      }
      if (copied == 0) {
        throw new IllegalStateException(
            "Thread-pool latency bridge classes are missing");
      }
      complete = true;
      output.toFile().deleteOnExit();
      return output;
    } finally {
      if (!complete) {
        Files.deleteIfExists(output);
      }
    }
  }

  private static void stopLocked() {
    if (stopMethod != null) {
      try {
        stopMethod.invoke(null);
      } catch (IllegalAccessException ignored) {
        // The runtime is already unavailable; loader closure remains deterministic.
      } catch (InvocationTargetException ignored) {
        // Runtime shutdown failure must not retain the isolated ClassLoader.
      }
    }
    stopMethod = null;
    close(runtimeClassLoader);
    runtimeClassLoader = null;
  }

  private static ParsedArguments parse(String arguments) {
    if (arguments == null || arguments.trim().isEmpty()) {
      throw new IllegalArgumentException("Bootstrap arguments are required");
    }
    String coreValue = null;
    StringBuilder runtimeArguments = new StringBuilder(arguments.length());
    for (String token : arguments.split(";")) {
      if (token.startsWith(CORE_PREFIX)) {
        coreValue = token.substring(CORE_PREFIX.length());
      } else if (!token.trim().isEmpty()) {
        if (runtimeArguments.length() > 0) {
          runtimeArguments.append(';');
        }
        runtimeArguments.append(token);
      }
    }
    if (coreValue == null || coreValue.isEmpty()) {
      throw new IllegalArgumentException("core argument is required");
    }
    Path corePath;
    try {
      byte[] decoded = Base64.getUrlDecoder().decode(coreValue);
      corePath =
          Paths.get(new String(decoded, StandardCharsets.UTF_8))
              .toAbsolutePath()
              .normalize();
    } catch (IllegalArgumentException exception) {
      throw new IllegalArgumentException("core argument is not valid Base64URL", exception);
    }
    if (!Files.isRegularFile(corePath)) {
      throw new IllegalArgumentException("Agent core file does not exist");
    }
    return new ParsedArguments(corePath, runtimeArguments.toString());
  }

  private static IllegalStateException unwrap(String message, Exception exception) {
    Throwable cause =
        exception instanceof InvocationTargetException
            ? ((InvocationTargetException) exception).getTargetException()
            : exception;
    return new IllegalStateException(message, cause);
  }

  private static void close(URLClassLoader classLoader) {
    if (classLoader == null) {
      return;
    }
    try {
      classLoader.close();
    } catch (Exception ignored) {
      // No recovery is possible during Agent shutdown.
    }
  }

  private static final class ParsedArguments {
    private final Path corePath;
    private final String runtimeArguments;

    private ParsedArguments(Path corePath, String runtimeArguments) {
      this.corePath = corePath;
      this.runtimeArguments = runtimeArguments;
    }
  }
}
