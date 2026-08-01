package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.instrument.ClassDefinition;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Proxy;
import java.security.MessageDigest;
import java.security.ProtectionDomain;
import java.util.Arrays;
import java.util.Base64;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

final class ClassRedefinitionControllerTest {
  @Test
  void appliesAndRestoresOneAtomicSameLoaderChangeSet()
      throws Exception {
    byte[] alphaBefore = classBytes(Alpha.class);
    byte[] betaBefore = classBytes(Beta.class);
    FakeInstrumentation fake =
        new FakeInstrumentation(
            Alpha.class, alphaBefore, Beta.class, betaBefore);
    try (AgentArtifactRegistry artifacts =
        new AgentArtifactRegistry()) {
      ClassRedefinitionController controller =
          new ClassRedefinitionController(
              fake.proxy(),
              new ClassDumpController(fake.proxy(), artifacts));
      List<Class<?>> targets =
          Arrays.<Class<?>>asList(Alpha.class, Beta.class);
      List<String> proposed =
          Arrays.asList(
              encoded(
                  replaceStringConstant(
                      alphaBefore, "alpha-before", "alpha-after")),
              encoded(
                  replaceStringConstant(
                      betaBefore, "beta-before", "beta-after")));

      ClassRedefinitionController.BatchPreview preview =
          controller.previewBatch(targets, proposed);
      assertEquals(2, preview.getItems().size());
      assertEquals(64, preview.getFingerprint().length());

      ClassRedefinitionController.BatchResult applied =
          controller.redefineBatch(
              targets, proposed, preview.getFingerprint());
      assertEquals(2, fake.lastRedefineBatchSize);
      assertEquals(2, applied.getItems().size());
      assertEquals(64, applied.getExpectedCurrentFingerprint().length());
      assertEquals(
          sha256(Base64.getDecoder().decode(proposed.get(0))),
          sha256(fake.bytecode(Alpha.class)));
      assertEquals(
          sha256(Base64.getDecoder().decode(proposed.get(1))),
          sha256(fake.bytecode(Beta.class)));

      assertThrows(
          ClassRedefinitionController.StaleChangeSetException.class,
          () ->
              controller.redefineBatch(
                  targets, proposed, preview.getFingerprint()));

      ClassRedefinitionController.BatchResult restored =
          controller.restoreBatch(
              applied.getRollbackToken(),
              applied.getExpectedCurrentFingerprint());
      assertEquals(2, fake.lastRedefineBatchSize);
      assertEquals(2, restored.getItems().size());
      assertEquals(sha256(alphaBefore), sha256(fake.bytecode(Alpha.class)));
      assertEquals(sha256(betaBefore), sha256(fake.bytecode(Beta.class)));
      controller.close();
    }
  }

  @Test
  void restoresTheWholeBaselineWhenPostApplyVerificationFails()
      throws Exception {
    byte[] alphaBefore = classBytes(Alpha.class);
    byte[] betaBefore = classBytes(Beta.class);
    FakeInstrumentation fake =
        new FakeInstrumentation(
            Alpha.class, alphaBefore, Beta.class, betaBefore);
    try (AgentArtifactRegistry artifacts =
        new AgentArtifactRegistry()) {
      Instrumentation instrumentation = fake.proxy();
      ClassRedefinitionController controller =
          new ClassRedefinitionController(
              instrumentation,
              new ClassDumpController(instrumentation, artifacts));
      List<Class<?>> targets =
          Arrays.<Class<?>>asList(Alpha.class, Beta.class);
      List<String> proposed =
          Arrays.asList(
              encoded(
                  replaceStringConstant(
                      alphaBefore, "alpha-before", "alpha-after")),
              encoded(
                  replaceStringConstant(
                      betaBefore, "beta-before", "beta-after")));
      ClassRedefinitionController.BatchPreview preview =
          controller.previewBatch(targets, proposed);

      fake.failFirstCaptureAfterNextRedefine = true;
      assertThrows(
          IllegalStateException.class,
          () ->
              controller.redefineBatch(
                  targets, proposed, preview.getFingerprint()));

      assertEquals(2, fake.redefineCalls);
      assertEquals(sha256(alphaBefore), sha256(fake.bytecode(Alpha.class)));
      assertEquals(sha256(betaBefore), sha256(fake.bytecode(Beta.class)));
      assertTrue(controller.resetSnapshots().isEmpty());
      controller.close();
    }
  }

  @Test
  void rejectsDuplicateClassesBeforeMutation() throws Exception {
    byte[] alphaBefore = classBytes(Alpha.class);
    FakeInstrumentation fake =
        new FakeInstrumentation(Alpha.class, alphaBefore);
    try (AgentArtifactRegistry artifacts =
        new AgentArtifactRegistry()) {
      Instrumentation instrumentation = fake.proxy();
      ClassRedefinitionController controller =
          new ClassRedefinitionController(
              instrumentation,
              new ClassDumpController(instrumentation, artifacts));
      String proposed =
          encoded(
              replaceStringConstant(
                  alphaBefore, "alpha-before", "alpha-after"));

      assertThrows(
          IllegalArgumentException.class,
          () ->
              controller.previewBatch(
                  Arrays.<Class<?>>asList(Alpha.class, Alpha.class),
                  Arrays.asList(proposed, proposed)));
      assertEquals(0, fake.redefineCalls);
      controller.close();
    }
  }

  private static String encoded(byte[] bytecode) {
    return Base64.getEncoder().encodeToString(bytecode);
  }

  private static byte[] classBytes(Class<?> type) throws Exception {
    String resource = "/" + type.getName().replace('.', '/') + ".class";
    try (InputStream input = type.getResourceAsStream(resource)) {
      if (input == null) {
        throw new IllegalStateException("Missing test class " + resource);
      }
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[4_096];
      int read;
      while ((read = input.read(buffer)) != -1) {
        if (read > 0) {
          output.write(buffer, 0, read);
        }
      }
      return output.toByteArray();
    }
  }

  private static byte[] replaceStringConstant(
      byte[] bytecode, String before, String after) {
    ClassReader reader = new ClassReader(bytecode);
    ClassWriter writer = new ClassWriter(reader, 0);
    reader.accept(
        new ClassVisitor(Opcodes.ASM9, writer) {
          @Override
          public MethodVisitor visitMethod(
              int access,
              String name,
              String descriptor,
              String signature,
              String[] exceptions) {
            MethodVisitor delegate =
                super.visitMethod(
                    access,
                    name,
                    descriptor,
                    signature,
                    exceptions);
            return new MethodVisitor(Opcodes.ASM9, delegate) {
              @Override
              public void visitLdcInsn(Object value) {
                super.visitLdcInsn(
                    before.equals(value) ? after : value);
              }
            };
          }
        },
        0);
    return writer.toByteArray();
  }

  private static String sha256(byte[] value) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
    StringBuilder result = new StringBuilder(digest.length * 2);
    for (byte item : digest) {
      result.append(
          String.format(
              java.util.Locale.ROOT, "%02x", item & 0xff));
    }
    return result.toString();
  }

  private static final class Alpha {
    private static String value() {
      return "alpha-before";
    }
  }

  private static final class Beta {
    private static String value() {
      return "beta-before";
    }
  }

  private static final class FakeInstrumentation {
    private final Map<Class<?>, byte[]> bytecodes =
        new IdentityHashMap<Class<?>, byte[]>();
    private ClassFileTransformer transformer;
    private boolean failFirstCaptureAfterNextRedefine;
    private boolean failNextCapture;
    private int redefineCalls;
    private int lastRedefineBatchSize;
    private Instrumentation proxy;

    private FakeInstrumentation(Object... classAndBytes) {
      for (int index = 0; index < classAndBytes.length; index += 2) {
        bytecodes.put(
            (Class<?>) classAndBytes[index],
            ((byte[]) classAndBytes[index + 1]).clone());
      }
    }

    private Instrumentation proxy() {
      if (proxy == null) {
        proxy =
            (Instrumentation)
                Proxy.newProxyInstance(
                    ClassRedefinitionControllerTest.class.getClassLoader(),
                    new Class<?>[] {Instrumentation.class},
                    (ignored, method, arguments) -> {
                      String name = method.getName();
                      if ("isRedefineClassesSupported".equals(name)
                          || "isRetransformClassesSupported".equals(name)
                          || "isModifiableClass".equals(name)) {
                        return Boolean.TRUE;
                      }
                      if ("addTransformer".equals(name)) {
                        transformer =
                            (ClassFileTransformer) arguments[0];
                        return null;
                      }
                      if ("removeTransformer".equals(name)) {
                        transformer = null;
                        return Boolean.TRUE;
                      }
                      if ("retransformClasses".equals(name)) {
                        if (failNextCapture) {
                          failNextCapture = false;
                          throw new IllegalStateException(
                              "simulated capture failure");
                        }
                        Class<?>[] targets = (Class<?>[]) arguments[0];
                        for (Class<?> target : targets) {
                          byte[] current = bytecode(target);
                          transformer.transform(
                              target.getClassLoader(),
                              target.getName().replace('.', '/'),
                              target,
                              (ProtectionDomain) null,
                              current.clone());
                        }
                        return null;
                      }
                      if ("redefineClasses".equals(name)) {
                        ClassDefinition[] definitions =
                            (ClassDefinition[]) arguments[0];
                        redefineCalls++;
                        lastRedefineBatchSize = definitions.length;
                        for (ClassDefinition definition : definitions) {
                          bytecodes.put(
                              definition.getDefinitionClass(),
                              definition
                                  .getDefinitionClassFile()
                                  .clone());
                        }
                        if (failFirstCaptureAfterNextRedefine) {
                          failFirstCaptureAfterNextRedefine = false;
                          failNextCapture = true;
                        }
                        return null;
                      }
                      Class<?> returnType = method.getReturnType();
                      if (returnType == boolean.class) {
                        return Boolean.FALSE;
                      }
                      if (returnType == int.class) {
                        return Integer.valueOf(0);
                      }
                      if (returnType == long.class) {
                        return Long.valueOf(0L);
                      }
                      return null;
                    });
      }
      return proxy;
    }

    private byte[] bytecode(Class<?> type) {
      byte[] value = bytecodes.get(type);
      if (value == null) {
        throw new IllegalArgumentException("Unknown class " + type.getName());
      }
      return value.clone();
    }
  }
}
