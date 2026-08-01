import { afterEach, describe, expect, it, vi } from "vitest";
import { HeartbeatMonitor } from "./heartbeat-monitor.js";

describe("heartbeat monitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves through degraded and reconnecting before disconnecting", async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const monitor = new HeartbeatMonitor({
      intervalMillis: 1_000,
      probe: async () => {
        throw new Error("target unavailable");
      },
      onStateChange: (state) => states.push(state),
    });
    monitor.start();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(states).toEqual(["DEGRADED", "RECONNECTING", "DISCONNECTED"]);
    expect(monitor.running).toBe(false);
  });

  it("waits for the current probe before scheduling the next one", async () => {
    vi.useFakeTimers();
    let finishProbe: (() => void) | undefined;
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProbe = resolve;
        }),
    );
    const monitor = new HeartbeatMonitor({
      intervalMillis: 1_000,
      probe,
      onStateChange: () => undefined,
    });
    monitor.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(probe).toHaveBeenCalledOnce();

    finishProbe?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("returns to ready after a degraded probe recovers", async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const probe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue(undefined);
    const monitor = new HeartbeatMonitor({
      intervalMillis: 1_000,
      probe,
      onStateChange: (state) => states.push(state),
    });
    monitor.start();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(states).toEqual(["DEGRADED", "READY"]);
    expect(monitor.running).toBe(true);
    monitor.stop();
  });
});
