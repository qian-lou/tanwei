// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasEnglishTranslation } from "./i18n";

const rendererDirectory = path.resolve(import.meta.dirname);
const hanPattern = /\p{Script=Han}/u;

function rendererFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return rendererFiles(absolutePath);
    }
    return /\.(?:ts|vue)$/u.test(entry.name) ? [absolutePath] : [];
  });
}

describe("renderer internationalization", () => {
  it("provides English resources for every literal Chinese translation key", () => {
    const missing = new Set<string>();
    for (const file of rendererFiles(rendererDirectory)) {
      if (file.endsWith("i18n.ts") || file.endsWith("i18n.test.ts")) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      for (const pattern of [
        /\bt\(\s*"([^"]*)"/gu,
        /\bt\(\s*'([^']*)'/gu,
        /\bt\(\s*`([^`]*)`/gu,
      ]) {
        for (const match of source.matchAll(pattern)) {
          const key = match[1] ?? "";
          if (hanPattern.test(key) && !hasEnglishTranslation(key)) {
            missing.add(key);
          }
        }
      }
    }
    expect([...missing].sort()).toEqual([]);
  });

  it("does not leave untranslated Chinese text or attributes in Vue templates", () => {
    const leaked: string[] = [];
    for (const file of rendererFiles(rendererDirectory).filter((entry) =>
      entry.endsWith(".vue"),
    )) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        />([^<>{]*\p{Script=Han}[^<>{]*)</gu,
      )) {
        const text = (match[1] ?? "").replace(/\s+/gu, " ").trim();
        if (text && text !== "探") {
          leaked.push(`${path.basename(file)}: ${text}`);
        }
      }
      for (const match of source.matchAll(
        /(?<!:)\b(?:aria-label|placeholder|title)="([^"]*\p{Script=Han}[^"]*)"/gu,
      )) {
        leaked.push(`${path.basename(file)}: ${match[1] ?? ""}`);
      }
    }
    expect(leaked).toEqual([]);
  });
});
