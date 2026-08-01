import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = dirname(fileURLToPath(import.meta.url));

describe("migrated view contract boundary", () => {
  for (const view of ["ThreadsView.tsx", "ProfileView.tsx"]) {
    it(`${view} does not parse Generic values`, () => {
      const source = readFileSync(resolve(RENDERER_ROOT, "views", view), "utf8");
      expect(source).not.toMatch(/\.values\b/u);
    });
  }

  it("ThreadsView uses only its typed domain gateway for Action calls", () => {
    const source = readFileSync(
      resolve(RENDERER_ROOT, "views/ThreadsView.tsx"),
      "utf8",
    );
    expect(source).not.toContain("window.tanwei.executeAction");
  });
});
