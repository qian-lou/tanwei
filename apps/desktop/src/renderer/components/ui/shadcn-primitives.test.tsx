import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Checkbox } from "@/components/ui/checkbox";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";

describe("shadcn form primitives", () => {
  it("keeps the native change contract for Input", () => {
    const onChange = vi.fn();
    let observedValue = "";
    render(
      <>
        <Input
          aria-label="名称"
          data-testid="name-input"
          value="before"
          onChange={(event) => {
            observedValue = event.target.value;
            onChange(event);
          }}
        />
      </>,
    );

    const input = screen.getByTestId("name-input");
    fireEvent.change(input, { target: { value: "after" } });

    expect(input.getAttribute("data-slot")).toBe("input");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(observedValue).toBe("after");
  });

  it("uses the Checkbox checked-state contract directly", () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox
        aria-label="确认"
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "确认" });
    fireEvent.click(checkbox);

    expect(checkbox.getAttribute("data-slot")).toBe("checkbox");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("renders keyboard hints through the shadcn Kbd primitive", () => {
    render(<Kbd>⌘K</Kbd>);

    expect(screen.getByText("⌘K").getAttribute("data-slot")).toBe("kbd");
  });

  it("renders full empty states through the shadcn Empty primitive", () => {
    render(
      <Empty>
        <span>暂无数据</span>
      </Empty>,
    );

    expect(screen.getByText("暂无数据").parentElement?.dataset.slot).toBe("empty");
  });

  it("uses the ToggleGroup single-selection contract", () => {
    const onValueChange = vi.fn();
    render(
      <ToggleGroup
        type="single"
        defaultValue="all"
        onValueChange={onValueChange}
      >
        <ToggleGroupItem value="all">全部</ToggleGroupItem>
        <ToggleGroupItem value="java">JAVA</ToggleGroupItem>
      </ToggleGroup>,
    );

    const javaItem = screen.getByText("JAVA");
    fireEvent.click(javaItem);

    expect(javaItem.getAttribute("data-state")).toBe("on");
    expect(onValueChange).toHaveBeenCalledWith("java");
  });
});
