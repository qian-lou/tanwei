import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import StatusPill, { type StatusPillProps } from "./StatusPill";

const STATES: readonly StatusPillProps["state"][] = [
  "idle",
  "ready",
  "working",
  "error",
];

describe("StatusPill", () => {
  it("uses explicit status icons instead of an ambiguous square marker", () => {
    const { container } = render(
      <>
        {STATES.map((state) => (
          <StatusPill key={state} state={state} label={state} />
        ))}
      </>,
    );

    expect(container.querySelector(".status-pill__mark")).toBeNull();

    const icons = container.querySelectorAll(
      'svg[data-slot="status-pill-icon"]',
    );
    expect(icons).toHaveLength(STATES.length);
    expect(Array.from(icons, (icon) => icon.getAttribute("data-state"))).toEqual(
      STATES,
    );
    expect(
      Array.from(icons).every(
        (icon) => icon.getAttribute("aria-hidden") === "true",
      ),
    ).toBe(true);
  });
});
