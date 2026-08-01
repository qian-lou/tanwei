import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

await build({
  entryPoints: [
    path.join(projectRoot, "apps", "desktop", "src", "preload", "preload.ts"),
  ],
  outfile: path.join(
    projectRoot,
    "apps",
    "desktop",
    "dist",
    "preload",
    "preload.cjs",
  ),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});
