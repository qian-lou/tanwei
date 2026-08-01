package dev.tanwei.agent;

import java.io.IOException;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.IllegalClassFormatException;
import java.lang.instrument.Instrumentation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.ProtectionDomain;
import java.util.concurrent.atomic.AtomicReference;

final class ClassDumpController {
  private final Instrumentation instrumentation;
  private final AgentArtifactRegistry artifacts;

  ClassDumpController(Instrumentation instrumentation, AgentArtifactRegistry artifacts) {
    this.instrumentation = instrumentation;
    this.artifacts = artifacts;
  }

  boolean isAvailable() {
    return instrumentation.isRetransformClassesSupported();
  }

  synchronized ArtifactInfo dump(Class<?> target) throws Exception {
    byte[] bytecode = capture(target);
    Path output = artifacts.allocatePath(".class");
    try {
      Files.write(output, bytecode);
      return new ArtifactInfo(
          artifacts.register(output),
          target.getSimpleName() + ".class",
          bytecode.length);
    } catch (Exception exception) {
      Files.deleteIfExists(output);
      throw exception;
    }
  }

  synchronized byte[] capture(Class<?> target) throws Exception {
    if (!isAvailable()) {
      throw new IllegalStateException("The target JVM does not support class retransformation");
    }
    if (!instrumentation.isModifiableClass(target)) {
      throw new IllegalStateException("The selected class is not modifiable");
    }

    AtomicReference<byte[]> captured = new AtomicReference<byte[]>();
    ClassFileTransformer transformer =
        new ClassFileTransformer() {
          @Override
          public byte[] transform(
              ClassLoader loader,
              String className,
              Class<?> classBeingRedefined,
              ProtectionDomain protectionDomain,
              byte[] classfileBuffer)
              throws IllegalClassFormatException {
            if (classBeingRedefined == target) {
              captured.compareAndSet(null, classfileBuffer.clone());
            }
            return null;
          }
        };

    instrumentation.addTransformer(transformer, true);
    try {
      instrumentation.retransformClasses(target);
    } finally {
      instrumentation.removeTransformer(transformer);
    }

    byte[] bytecode = captured.get();
    if (bytecode == null || bytecode.length == 0) {
      throw new IOException("No bytecode was captured for the selected class");
    }
    return bytecode;
  }

  static final class ArtifactInfo {
    private final String token;
    private final String name;
    private final long size;

    private ArtifactInfo(String token, String name, long size) {
      this.token = token;
      this.name = name;
      this.size = size;
    }

    String getToken() {
      return token;
    }

    String getName() {
      return name;
    }

    long getSize() {
      return size;
    }
  }
}
