package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;

final class LineProbeControllerTest {
  @Test
  void plansAndInstrumentsEveryBytecodeLocationForAnExactSourceLine()
      throws Exception {
    byte[] bytecode = classBytes(LineProbeFixture.class);
    Method method = LineProbeFixture.class.getDeclaredMethod("calculate", int.class);
    int lineNumber = maximumMethodLine(bytecode, method);

    LineProbeController.ProbePlan plan =
        LineProbeController.ProbePlan.inspect(
            bytecode, LineProbeFixture.class, method, lineNumber);

    assertTrue(plan.pointCount() >= 1);
    assertTrue(plan.maximumLocalCount() >= 2);
    assertEquals("LineProbeFixture.java", plan.sourceFile());

    LineProbeController.LineProbeTransformer transformer =
        new LineProbeController.LineProbeTransformer(
            LineProbeFixture.class, UUID.randomUUID().toString(), plan);
    byte[] transformed =
        transformer.transform(
            LineProbeFixture.class.getClassLoader(),
            LineProbeFixture.class.getName().replace('.', '/'),
            LineProbeFixture.class,
            LineProbeFixture.class.getProtectionDomain(),
            bytecode);
    assertNotNull(transformed);
    assertEquals(plan.pointCount(), bridgeCaptureCalls(transformed, method));
  }

  @Test
  void rejectsLinesOutsideTheSelectedMethodLineTable() throws Exception {
    byte[] bytecode = classBytes(LineProbeFixture.class);
    Method method = LineProbeFixture.class.getDeclaredMethod("calculate", int.class);
    IllegalArgumentException error =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                LineProbeController.ProbePlan.inspect(
                    bytecode, LineProbeFixture.class, method, 1_000_000));
    assertTrue(error.getMessage().contains("Selected source line was not found"));
  }

  private static int maximumMethodLine(byte[] bytecode, Method target) {
    List<Integer> lines = new ArrayList<Integer>();
    String descriptor = Type.getMethodDescriptor(target);
    new ClassReader(bytecode)
        .accept(
            new ClassVisitor(Opcodes.ASM9) {
              @Override
              public MethodVisitor visitMethod(
                  int access,
                  String name,
                  String methodDescriptor,
                  String signature,
                  String[] exceptions) {
                if (!target.getName().equals(name)
                    || !descriptor.equals(methodDescriptor)) {
                  return null;
                }
                return new MethodVisitor(Opcodes.ASM9) {
                  @Override
                  public void visitLineNumber(int line, org.objectweb.asm.Label start) {
                    lines.add(Integer.valueOf(line));
                  }
                };
              }
            },
            ClassReader.SKIP_FRAMES);
    if (lines.isEmpty()) {
      throw new AssertionError("fixture line table is missing");
    }
    int maximum = Integer.MIN_VALUE;
    for (Integer line : lines) {
      maximum = Math.max(maximum, line.intValue());
    }
    return maximum;
  }

  private static int bridgeCaptureCalls(byte[] bytecode, Method target) {
    AtomicInteger calls = new AtomicInteger();
    String descriptor = Type.getMethodDescriptor(target);
    new ClassReader(bytecode)
        .accept(
            new ClassVisitor(Opcodes.ASM9) {
              @Override
              public MethodVisitor visitMethod(
                  int access,
                  String name,
                  String methodDescriptor,
                  String signature,
                  String[] exceptions) {
                if (!target.getName().equals(name)
                    || !descriptor.equals(methodDescriptor)) {
                  return null;
                }
                return new MethodVisitor(Opcodes.ASM9) {
                  @Override
                  public void visitMethodInsn(
                      int opcode,
                      String owner,
                      String name,
                      String methodDescriptor,
                      boolean isInterface) {
                    if (opcode == Opcodes.INVOKESTATIC
                        && owner.equals("dev/tanwei/bootstrap/LineProbeBridge")
                        && name.equals("capture")) {
                      calls.incrementAndGet();
                    }
                  }
                };
              }
            },
            ClassReader.EXPAND_FRAMES);
    return calls.get();
  }

  private static byte[] classBytes(Class<?> type) throws Exception {
    String resource = "/" + type.getName().replace('.', '/') + ".class";
    try (InputStream input = type.getResourceAsStream(resource)) {
      if (input == null) {
        throw new IllegalStateException("fixture bytecode is unavailable");
      }
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[4_096];
      int read;
      while ((read = input.read(buffer)) >= 0) {
        if (read > 0) {
          output.write(buffer, 0, read);
        }
      }
      return output.toByteArray();
    }
  }
}
