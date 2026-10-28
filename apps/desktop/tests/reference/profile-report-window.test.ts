/// <reference lib="dom" />

import { beforeEach, describe, expect, it, vi } from "vitest";

import { profileReportAdapterScript } from "../../src/shared/profile-report-adapter.js";

interface ProfileReportFixture {
  frames: Array<
    Array<{
      color: string;
      left?: number;
      level?: number;
      title?: string;
      width?: number;
    }>
  >;
  labelCounts: number[];
  renderedRoots: string[];
  renderSnapshots: string[][];
  writes: string[];
}

function installProfileReportFixture(
  frames: ProfileReportFixture["frames"] = [
    [{ color: "#50e150" }],
    [{ color: "#e15a5a" }],
  ],
): ProfileReportFixture {
  const fixture = {
    frames,
    labelCounts: [] as number[],
    renderedRoots: [] as string[],
    renderSnapshots: [] as string[][],
    writes: [] as string[],
  };
  const testWindow = window as typeof window & {
    profileReportFixture?: ProfileReportFixture;
  };
  testWindow.profileReportFixture = fixture;

  window.eval(`(() => {
    class TestCanvasContext {
      get fillStyle() {
        return this.value ?? "#000000";
      }

      set fillStyle(value) {
        this.value = value;
        window.profileReportFixture.writes.push(value);
      }
    }

    const levels = window.profileReportFixture.frames;
    const c = new TestCanvasContext();
    let root = levels[0][0];
    const search = () => {};
    const render = (nextRoot) => {
      root = nextRoot ?? root;
      c.fillStyle = "#faf9f5";
      for (const frames of levels) {
        for (const frame of frames) {
          c.fillStyle = frame.color;
          c.fillStyle = "#000000";
        }
      }
      window.profileReportFixture.renderSnapshots.push(
        levels.flat().map((frame) => frame.color),
      );
      window.profileReportFixture.renderedRoots.push(root.title ?? "");
      const scale = typeof root.width === "number" ? 1_260 / root.width : 0;
      const rootLeft = root.left ?? 0;
      const rootRight = rootLeft + (root.width ?? 0);
      window.profileReportFixture.labelCounts.push(
        levels
          .flat()
          .filter(
            (frame) =>
              typeof frame.width === "number" &&
              (frame.left ?? 0) < rootRight &&
              (frame.left ?? 0) + frame.width > rootLeft &&
              frame.width * scale >= 21,
          ).length,
      );
    };

    ${profileReportAdapterScript("探微 · 性能报告", "cpu-profile.html")}
  })();`);

  return fixture;
}

describe("profile report color palette", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("defaults to native colors and restores them after monochrome mode", () => {
    const fixture = installProfileReportFixture();
    const paletteControl = document.querySelector<HTMLButtonElement>(
      'button[aria-label="原生彩色"]',
    );

    expect(paletteControl).not.toBeNull();
    expect(paletteControl?.textContent).toBe("配色：原生彩色");
    expect(paletteControl?.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.classList.contains("tanwei-native-profile-colors")).toBe(
      true,
    );
    expect(fixture.renderSnapshots.at(-1)).toEqual(["#50e150", "#e15a5a"]);

    paletteControl?.click();

    expect(paletteControl?.textContent).toBe("配色：单色");
    expect(paletteControl?.getAttribute("aria-pressed")).toBe("false");
    expect(document.body.classList.contains("tanwei-native-profile-colors")).toBe(
      false,
    );
    expect(fixture.renderSnapshots.at(-1)).toEqual([
      "rgba(20, 20, 19, 0.68)",
      "rgba(20, 20, 19, 0.78)",
    ]);
    expect(fixture.writes.at(-1)).toBe("#ffffff");

    paletteControl?.click();

    expect(paletteControl?.textContent).toBe("配色：原生彩色");
    expect(paletteControl?.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.classList.contains("tanwei-native-profile-colors")).toBe(
      true,
    );
    expect(fixture.renderSnapshots.at(-1)).toEqual(["#50e150", "#e15a5a"]);
    expect(fixture.writes.at(-1)).toBe("#000000");
  });

  it("can zoom a split wall-clock report to one thread", () => {
    const fixture = installProfileReportFixture([
      [
        {
          color: "#e15a5a",
          left: 0,
          level: 0,
          title: "all",
          width: 13_328,
        },
      ],
      [
        {
          color: "#50e150",
          left: 0,
          level: 1,
          title: "[worker-1 tid=101]",
          width: 200,
        },
        {
          color: "#50cccc",
          left: 200,
          level: 1,
          title: "[worker-2 tid=102]",
          width: 200,
        },
      ],
      [
        {
          color: "#b2e1b2",
          left: 200,
          level: 2,
          title: "example.Worker.run",
          width: 200,
        },
      ],
    ]);
    const threadControl = document.querySelector<HTMLSelectElement>(
      'select[aria-label="线程视图"]',
    );

    expect(fixture.labelCounts.at(-1)).toBe(1);
    expect(threadControl).not.toBeNull();
    expect(threadControl?.value).toBe("");

    if (threadControl) {
      threadControl.value = "1";
      threadControl.dispatchEvent(new Event("change"));
    }

    expect(fixture.renderedRoots.at(-1)).toBe("[worker-2 tid=102]");
    expect(fixture.labelCounts.at(-1)).toBeGreaterThan(1);
  });
});
