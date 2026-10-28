import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAttachHelperInvocation } from "./attach-helper-invocation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("resolveAttachHelperInvocation", () => {
  it("uses the target JDK 8 runtime and tools.jar", async () => {
    const directory = await temporaryDirectory();
    const javaExecutable = path.join(directory, "jdk8", "bin", "java");
    const toolsJar = path.join(directory, "jdk8", "lib", "tools.jar");
    await createFile(javaExecutable);
    await createFile(toolsJar);
    const resolvedJavaExecutable = await realpath(javaExecutable);
    const resolvedToolsJar = await realpath(toolsJar);

    const invocation = await resolveAttachHelperInvocation(
      "/bundled/bin/java",
      javaExecutable,
      "/application/attach-helper.jar",
    );

    expect(invocation).toEqual({
      executable: resolvedJavaExecutable,
      prefixArguments: [
        "-cp",
        ["/application/attach-helper.jar", resolvedToolsJar].join(
          path.delimiter,
        ),
        "dev.tanwei.attach.AttachHelperMain",
      ],
    });
  });

  it("finds tools.jar above a JDK 8 jre directory", async () => {
    const directory = await temporaryDirectory();
    const javaExecutable = path.join(
      directory,
      "jdk8",
      "jre",
      "bin",
      "java",
    );
    const toolsJar = path.join(directory, "jdk8", "lib", "tools.jar");
    await createFile(javaExecutable);
    await createFile(toolsJar);
    const resolvedJavaExecutable = await realpath(javaExecutable);
    const resolvedToolsJar = await realpath(toolsJar);

    const invocation = await resolveAttachHelperInvocation(
      "/bundled/bin/java",
      javaExecutable,
      "/application/attach-helper.jar",
    );

    expect(invocation.executable).toBe(resolvedJavaExecutable);
    expect(invocation.prefixArguments[1]).toBe(
      ["/application/attach-helper.jar", resolvedToolsJar].join(
        path.delimiter,
      ),
    );
  });

  it("uses the bundled runtime when the target has no JDK 8 tools.jar", async () => {
    const directory = await temporaryDirectory();
    const javaExecutable = path.join(directory, "jdk11", "bin", "java");
    await createFile(javaExecutable);

    await expect(
      resolveAttachHelperInvocation(
        "/bundled/bin/java",
        javaExecutable,
        "/application/attach-helper.jar",
      ),
    ).resolves.toEqual({
      executable: "/bundled/bin/java",
      prefixArguments: ["-jar", "/application/attach-helper.jar"],
    });
  });

  it("uses the bundled runtime when the target Java path is unavailable", async () => {
    await expect(
      resolveAttachHelperInvocation(
        "/bundled/bin/java",
        null,
        "/application/attach-helper.jar",
      ),
    ).resolves.toEqual({
      executable: "/bundled/bin/java",
      prefixArguments: ["-jar", "/application/attach-helper.jar"],
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tanwei-attach-runtime-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function createFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture", "utf8");
}
