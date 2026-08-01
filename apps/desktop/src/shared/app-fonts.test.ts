// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  APP_FONT_OPTIONS,
  getAppFontStack,
  normalizeAppFontFamily,
} from "./app-fonts.js";

describe("app font preferences", () => {
  it("normalizes unknown persisted values to the system font", () => {
    expect(normalizeAppFontFamily("JETBRAINS_MONO")).toBe("JETBRAINS_MONO");
    expect(normalizeAppFontFamily("UNKNOWN")).toBe("SYSTEM");
    expect(normalizeAppFontFamily(null)).toBe("SYSTEM");
  });

  it("provides a non-empty fallback stack for every selectable font", () => {
    for (const option of APP_FONT_OPTIONS) {
      expect(getAppFontStack(option.value)).toMatch(/(?:sans-serif|serif|monospace)$/u);
    }
  });
});
