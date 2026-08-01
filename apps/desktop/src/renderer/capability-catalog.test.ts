// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_GROUPS,
  searchCapabilityCatalog,
} from "./capability-catalog";
import { hasEnglishTranslation } from "./i18n";

describe("capability catalog", () => {
  it("publishes a unique and routable desktop capability inventory", () => {
    expect(CAPABILITY_CATALOG.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CAPABILITY_CATALOG.map((item) => item.id)).size).toBe(
      CAPABILITY_CATALOG.length,
    );
    expect(
      CAPABILITY_CATALOG.every(
        (item) =>
          item.path.startsWith("/") &&
          CAPABILITY_GROUPS.includes(item.group) &&
          item.label.length > 0 &&
          item.description.length > 0,
      ),
    ).toBe(true);
    expect(
      [
        ...CAPABILITY_GROUPS,
        ...CAPABILITY_CATALOG.flatMap((item) => [item.label, item.description]),
      ].filter((key) => !hasEnglishTranslation(key)),
    ).toEqual([]);
  });

  it("finds reference terminology and desktop terminology deterministically", () => {
    expect(searchCapabilityCatalog("vmoption").map((item) => item.id)).toEqual([
      "runtime.vm-options",
    ]);
    expect(searchCapabilityCatalog("线程 dump").map((item) => item.id)).toEqual(
      ["threads.dump"],
    );
    expect(searchCapabilityCatalog("retained").map((item) => item.id)).toEqual([
      "objects.retained",
      "profile.dominator",
    ]);
    expect(searchCapabilityCatalog("log4j").map((item) => item.id)).toEqual([
      "runtime.loggers",
    ]);
    expect(searchCapabilityCatalog("thread -n").map((item) => item.id)).toEqual(
      ["threads.hot-cpu"],
    );
    expect(searchCapabilityCatalog("heap diff").map((item) => item.id)).toEqual(
      ["profile.heap-histogram-diff", "artifacts.heap-histogram-diff"],
    );
    expect(
      searchCapabilityCatalog("跨会话内存").map((item) => item.id),
    ).toEqual(["artifacts.heap-histogram-diff"]);
    expect(searchCapabilityCatalog("does-not-exist")).toEqual([]);
  });

  it("keeps catalog order for blank and equally ranked searches", () => {
    expect(searchCapabilityCatalog(" ")).toBe(CAPABILITY_CATALOG);
    expect(searchCapabilityCatalog("thread").map((item) => item.id)).toEqual([
      "threads.dump",
      "threads.live",
      "threads.hot-cpu",
      "threads.trend",
      "threads.diff",
      "threads.locks",
      "threads.pools",
      "threads.interrupt",
    ]);
  });
});
