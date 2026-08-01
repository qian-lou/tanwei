import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RiskLevel } from "@shared/contracts";
import RiskPill from "./RiskPill";

const RISK_LEVELS: readonly RiskLevel[] = ["R0", "R1", "R2", "R3", "R4"];

describe("RiskPill", () => {
  it("uses a distinct icon and explicit text for every risk level", () => {
    const { container } = render(
      <>
        {RISK_LEVELS.map((level) => (
          <RiskPill key={level} level={level} />
        ))}
      </>,
    );

    const icons = container.querySelectorAll('[data-slot="risk-pill-icon"]');
    expect(icons).toHaveLength(RISK_LEVELS.length);
    expect(
      Array.from(icons, (icon) => icon.getAttribute("data-risk-level")),
    ).toEqual(RISK_LEVELS);
    expect(
      Array.from(icons).every(
        (icon) => icon.getAttribute("aria-hidden") === "true",
      ),
    ).toBe(true);
    RISK_LEVELS.forEach((level) => {
      expect(screen.getByText(new RegExp(`^${level} · `))).toBeTruthy();
    });
  });

  it("keeps compact labels descriptive through a title", () => {
    render(<RiskPill level="R4" compact />);

    const pill = screen.getByText("R4");
    expect(pill.getAttribute("data-variant")).toBe("destructive");
    expect(pill.getAttribute("aria-label")).toMatch(/^R4 · /);
    expect(pill.getAttribute("title")).toMatch(/^R4 · /);
  });
});
