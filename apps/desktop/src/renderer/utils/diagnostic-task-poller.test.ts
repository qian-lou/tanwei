import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticTaskPoller } from "./diagnostic-task-poller.js";

describe("diagnostic task poller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never overlaps polls when one request exceeds the interval", async () => {
    vi.useFakeTimers();
    let finishPoll: ((result: "continue") => void) | undefined;
    const poll = vi.fn(
      () =>
        new Promise<"continue">((resolve) => {
          finishPoll = resolve;
        }),
    );
    const poller = new DiagnosticTaskPoller({
      intervalMillis: 500,
      poll,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledOnce();

    finishPoll?.("continue");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(499);
    expect(poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("aborts the current generation and ignores its late completion", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    let finishPoll: ((result: "continue") => void) | undefined;
    const poll = vi.fn(
      (signal: AbortSignal) =>
        new Promise<"continue">((resolve) => {
          observedSignal = signal;
          finishPoll = resolve;
        }),
    );
    const poller = new DiagnosticTaskPoller({
      intervalMillis: 500,
      poll,
    });
    poller.start();

    poller.stop();
    expect(observedSignal?.aborted).toBe(true);
    finishPoll?.("continue");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(poll).toHaveBeenCalledOnce();
    expect(poller.running).toBe(false);
  });

  it("stops after a terminal poll result", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => "stop" as const);
    const poller = new DiagnosticTaskPoller({
      intervalMillis: 500,
      poll,
    });
    poller.start();

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(poll).toHaveBeenCalledOnce();
    expect(poller.running).toBe(false);
  });
});
