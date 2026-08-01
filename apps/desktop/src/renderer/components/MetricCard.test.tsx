import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import MetricCard from "./MetricCard";

function pathVerticalSpread(path: string): number {
  const coordinates = Array.from(
    path.matchAll(/[ML] [\d.]+ ([\d.]+)/gu),
    (match) => Number(match[1]),
  );
  return Math.max(...coordinates) - Math.min(...coordinates);
}

describe("MetricCard", () => {
  it("makes small changes visible even when values are below one percent", () => {
    const { container } = render(
      <MetricCard
        label="HEAP USED"
        value="153.2 MiB"
        detail="24 GiB max"
        points={[0.62, 0.63, 0.625]}
      />,
    );

    const path = container.querySelector("path")?.getAttribute("d") ?? "";
    expect(pathVerticalSpread(path)).toBeGreaterThan(20);
  });
});
