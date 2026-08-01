import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExitImpactSummary } from "@shared/contracts";
import ExitGuardDialog from "./ExitGuardDialog";

function impact(): ExitImpactSummary {
  return {
    inspectedAt: "2026-07-31T00:00:00.000Z",
    connectionCount: 2,
    inspectedCount: 1,
    failedCount: 1,
    taskCount: 2,
    classCount: 1,
    rollbackCount: 1,
    artifactPotentialCount: 1,
    targets: [
      {
        targetId: "local:42",
        displayName: "example.Main",
        pid: 42,
        state: "INSPECTED",
        taskCount: 2,
        classCount: 1,
        rollbackCount: 1,
        artifactPotentialCount: 1,
        errorMessage: null,
      },
      {
        targetId: "remote:ssh:aaaaaaaaaaaaaaaaaaaaaaaa",
        displayName: "remote.Main",
        pid: 43,
        state: "FAILED",
        taskCount: 0,
        classCount: 0,
        rollbackCount: 0,
        artifactPotentialCount: 0,
        errorMessage: "连接已中断",
      },
    ],
  };
}

function renderDialog(overrides?: {
  readonly onContinue?: () => void;
  readonly onReview?: () => void;
  readonly onBackground?: () => void;
  readonly onQuit?: () => void;
}) {
  const handlers = {
    onContinue: overrides?.onContinue ?? vi.fn(),
    onReview: overrides?.onReview ?? vi.fn(),
    onBackground: overrides?.onBackground ?? vi.fn(),
    onQuit: overrides?.onQuit ?? vi.fn(),
  };

  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <ExitGuardDialog
        open={open}
        loading={false}
        reason="WINDOW_CLOSE"
        platform="darwin"
        impact={impact()}
        errorMessage={null}
        onContinue={() => {
          handlers.onContinue();
          setOpen(false);
        }}
        onReview={handlers.onReview}
        onBackground={handlers.onBackground}
        onQuit={handlers.onQuit}
      />
    );
  }

  return { ...render(<Harness />), handlers };
}

describe("ExitGuardDialog", () => {
  it("shows bounded multi-target impact and exposes explicit resolutions", () => {
    const { handlers } = renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
    expect(dialog.textContent).toContain("退出会终止仍在运行的诊断");
    expect(dialog.textContent).toContain("ACTIVE TASKS");
    expect(dialog.textContent).toContain("example.Main");
    expect(dialog.textContent).toContain("remote.Main");
    expect(dialog.textContent).toContain("1 个 JVM 未完成影响检查");

    fireEvent.click(screen.getByRole("button", { name: "继续诊断" }));
    expect(handlers.onContinue).toHaveBeenCalledTimes(1);
  });

  it("routes review, background and quit resolutions", () => {
    const { handlers } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "查看任务中心" }));
    fireEvent.click(
      screen.getByRole("button", { name: "关闭窗口，任务后台继续" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "安全退出并清理" }));

    expect(handlers.onReview).toHaveBeenCalledTimes(1);
    expect(handlers.onBackground).toHaveBeenCalledTimes(1);
    expect(handlers.onQuit).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog and lets Escape keep diagnosing", () => {
    const origin = document.createElement("button");
    document.body.append(origin);
    origin.focus();

    const { handlers, unmount } = renderDialog();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "继续诊断" }),
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(handlers.onContinue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();

    unmount();
    origin.remove();
  });
});
