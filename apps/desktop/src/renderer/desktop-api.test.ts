import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
import "./desktop-api.js";

describe("Tauri desktop bridge", () => {
  beforeEach(() => {
    native.invoke.mockReset().mockResolvedValue(null);
    native.listen.mockReset();
  });

  it("routes every existing desktop method to its Rust Host method", async () => {
    for (const [name, method] of Object.entries(window.tanwei)) {
      if (name.startsWith("on")) continue;
      await (method as (...args: unknown[]) => Promise<unknown>)("first", "second", true);
      expect(native.invoke).toHaveBeenLastCalledWith("host_call", expect.objectContaining({ method: name }));
    }
    expect(Object.isFrozen(window.tanwei)).toBe(true);
  });

  it("releases a pending native subscription when React unmounts first", async () => {
    let resolveSubscription: ((unlisten: () => void) => void) | undefined;
    let callback: ((event: { payload: unknown }) => void) | undefined;
    native.listen.mockImplementation((_name, listener) => {
      callback = listener;
      return new Promise((resolve) => { resolveSubscription = resolve; });
    });
    const listener = vi.fn();
    const dispose = window.tanwei.onDiagnosticAlertsChanged(listener);
    dispose();
    callback?.({ payload: null });
    const unlisten = vi.fn();
    resolveSubscription?.(unlisten);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("accepts only valid diagnostic artifact identities from native events", async () => {
    let callback: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    native.listen.mockImplementation((_name, listener) => { callback = listener; return Promise.resolve(unlisten); });
    const listener = vi.fn();
    const dispose = window.tanwei.onOpenDiagnosticEvidence(listener);
    callback?.({ payload: "../../outside" });
    callback?.({ payload: null });
    callback?.({ payload: "e7fe9e1a-d4cc-4a8e-b845-584da55ec137" });
    expect(listener).toHaveBeenCalledExactlyOnceWith("e7fe9e1a-d4cc-4a8e-b845-584da55ec137");
    await Promise.resolve();
    dispose();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
