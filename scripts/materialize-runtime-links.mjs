import { chmod, lstat, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// Tauri copies resources as files. jlink's shared legal notices are symlinks;
// materialize only links confined to this runtime so every bundle retains them.
export async function materializeRuntimeLinks(root) {
  const canonicalRoot = await realpath(root);
  const pending = [canonicalRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(source);
      } else if (entry.isSymbolicLink()) {
        const target = await realpath(source);
        const relative = path.relative(canonicalRoot, target);
        if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
          throw new Error(`Runtime resource link escapes staging root: ${source}`);
        }
        const metadata = await lstat(target);
        if (!metadata.isFile()) throw new Error(`Runtime resource link must target a regular file: ${source}`);
        const content = await readFile(target);
        await unlink(source);
        await writeFile(source, content, { mode: (metadata.mode & 0o777) | 0o200 });
      } else if (entry.isFile()) {
        // Resource copies must remain replaceable on the next incremental build.
        const metadata = await lstat(source);
        await chmod(source, (metadata.mode & 0o777) | 0o200);
      }
    }
  }
}
