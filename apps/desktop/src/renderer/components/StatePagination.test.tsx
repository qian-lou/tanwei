import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import StatePagination from "./StatePagination";

describe("StatePagination", () => {
  it("provides navigation semantics and preserves button state", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();

    render(
      <StatePagination
        ariaLabel="结果分页"
        previousLabel="上一页"
        nextLabel="下一页"
        previousDisabled
        nextDisabled={false}
        summary="1–50 / 80"
        onPrevious={onPrevious}
        onNext={onNext}
      />,
    );

    expect(screen.getByRole("navigation", { name: "结果分页" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "上一页" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText("1–50 / 80")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    expect(onPrevious).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
