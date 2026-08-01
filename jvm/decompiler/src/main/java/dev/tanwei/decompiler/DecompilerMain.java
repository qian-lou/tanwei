package dev.tanwei.decompiler;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import org.benf.cfr.reader.Main;

public final class DecompilerMain {
  private DecompilerMain() {}

  public static void main(String[] arguments) {
    if (arguments == null
        || arguments.length != 2
        || !"--input".equals(arguments[0])) {
      System.err.println("Usage: tanwei-decompiler --input <class-file>");
      System.exit(2);
      return;
    }
    Path input = Paths.get(arguments[1]).toAbsolutePath().normalize();
    if (!Files.isRegularFile(input) || !input.getFileName().toString().endsWith(".class")) {
      System.err.println("Input must be a readable .class file");
      System.exit(3);
      return;
    }
    Main.main(
        new String[] {
          input.toString(),
          "--silent",
          "true",
          "--comments",
          "false",
        });
  }
}
