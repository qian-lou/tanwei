import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const ATTACH_HELPER_MAIN_CLASS = "dev.tanwei.attach.AttachHelperMain";

export interface AttachHelperInvocation {
  readonly executable: string;
  readonly prefixArguments: readonly string[];
}

export async function resolveAttachHelperInvocation(
  defaultJavaExecutable: string,
  targetJavaPath: string | null,
  helperJar: string,
): Promise<AttachHelperInvocation> {
  const jdk8Runtime = await resolveJdk8Runtime(targetJavaPath);
  if (jdk8Runtime !== null) {
    return {
      executable: jdk8Runtime.javaExecutable,
      prefixArguments: [
        "-cp",
        [helperJar, jdk8Runtime.toolsJar].join(path.delimiter),
        ATTACH_HELPER_MAIN_CLASS,
      ],
    };
  }
  return {
    executable: defaultJavaExecutable,
    prefixArguments: ["-jar", helperJar],
  };
}

async function resolveJdk8Runtime(
  targetJavaPath: string | null,
): Promise<{ readonly javaExecutable: string; readonly toolsJar: string } | null> {
  const configuredPath = targetJavaPath?.trim();
  if (!configuredPath) {
    return null;
  }
  const javaExecutable = await regularFileRealPath(configuredPath);
  if (javaExecutable === null) {
    return null;
  }
  const runtimeHome = path.dirname(path.dirname(javaExecutable));
  const candidateHomes = [runtimeHome];
  if (path.basename(runtimeHome).toLowerCase() === "jre") {
    candidateHomes.push(path.dirname(runtimeHome));
  }
  for (const candidateHome of candidateHomes) {
    const toolsJar = path.join(candidateHome, "lib", "tools.jar");
    if (await isRegularFile(toolsJar)) {
      return { javaExecutable, toolsJar };
    }
  }
  return null;
}

async function regularFileRealPath(filePath: string): Promise<string | null> {
  try {
    const resolvedPath = await realpath(filePath);
    return (await stat(resolvedPath)).isFile() ? resolvedPath : null;
  } catch {
    return null;
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
