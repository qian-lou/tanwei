import { beforeEach, describe, expect, it } from "vitest";
import { getAppFontStack } from "@shared/app-fonts";
import { applyAppFontFamily } from "./font-preferences";

describe("font preferences", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--tw-font-family");
    delete document.documentElement.dataset.fontFamily;
  });

  it("applies the selected family to the shared typography token", () => {
    applyAppFontFamily("SOURCE_HAN_SANS");

    expect(
      document.documentElement.style.getPropertyValue("--tw-font-family"),
    ).toBe(getAppFontStack("SOURCE_HAN_SANS"));
    expect(document.documentElement.dataset.fontFamily).toBe(
      "SOURCE_HAN_SANS",
    );
  });
});
