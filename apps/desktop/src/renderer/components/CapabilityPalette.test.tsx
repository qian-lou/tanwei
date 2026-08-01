import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import CapabilityPalette from "./CapabilityPalette";

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function PaletteHarness({ connected }: { readonly connected: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <CapabilityPalette
        open={open}
        connected={connected}
        onOpenChange={setOpen}
      />
      <div data-testid="palette-open">{String(open)}</div>
    </>
  );
}

function renderPalette(connected = true) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <LocationProbe />
      <PaletteHarness connected={connected} />
    </MemoryRouter>,
  );
}

describe("CapabilityPalette", () => {
  it("filters by reference terminology and opens the exact Runtime workspace", async () => {
    renderPalette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "vmoption" } });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("VM Option Inspector");

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/runtime?workspace=vm-options",
      );
    });
    expect(screen.getByTestId("palette-open").textContent).toBe("false");
  });

  it("cycles keyboard selection and exposes connection requirements", () => {
    renderPalette(false);
    const dialog = screen.getByRole("dialog");
    const selectedBefore = screen.getByRole("option", { selected: true });
    expect(selectedBefore.textContent).toContain("本机 JVM 发现与 Attach");

    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const selectedAfter = screen.getByRole("option", { selected: true });
    expect(selectedAfter.textContent).toContain("SSH 与 Kubernetes 目标");
    expect(dialog.textContent).toContain("需连接");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByTestId("palette-open").textContent).toBe("false");
  });
});
