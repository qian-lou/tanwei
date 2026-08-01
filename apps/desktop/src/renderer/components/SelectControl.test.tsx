import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SelectControl, SelectControlItem } from "./SelectControl";

describe("SelectControl", () => {
  it("renders the shadcn select trigger instead of a native select", () => {
    render(
      <SelectControl value="RUNNABLE" onValueChange={vi.fn()}>
        <SelectControlItem value="ALL">全部状态</SelectControlItem>
        <SelectControlItem value="RUNNABLE">RUNNABLE</SelectControlItem>
      </SelectControl>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger.getAttribute("data-slot")).toBe("select-trigger");
    expect(document.querySelector("select")).toBeNull();
  });

  it("normalizes numeric values and restores an explicit empty option", () => {
    const onNumericChange = vi.fn();
    const { rerender } = render(
      <SelectControl value={20} onValueChange={onNumericChange}>
        <SelectControlItem value={20}>20</SelectControlItem>
        <SelectControlItem value={50}>50</SelectControlItem>
      </SelectControl>,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "50" }));
    expect(onNumericChange).toHaveBeenCalledWith("50");

    const onEmptyChange = vi.fn();
    rerender(
      <SelectControl value="selected" onValueChange={onEmptyChange}>
        <SelectControlItem value="">不比较</SelectControlItem>
        <SelectControlItem value="selected">当前项</SelectControlItem>
      </SelectControl>,
    );
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "不比较" }));
    expect(onEmptyChange).toHaveBeenCalledWith("");
  });
});
