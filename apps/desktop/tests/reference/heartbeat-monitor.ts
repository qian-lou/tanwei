import type { ConnectionState } from "../../src/shared/contracts.js";

export type HeartbeatConnectionState = Extract<
  ConnectionState,
  "READY" | "DEGRADED" | "RECONNECTING" | "DISCONNECTED"
>;

interface HeartbeatMonitorOptions {
  readonly intervalMillis: number;
  readonly probe: (signal: AbortSignal) => Promise<void>;
  readonly onStateChange: (
    state: HeartbeatConnectionState,
    error: unknown,
  ) => void;
}

export class HeartbeatMonitor {
  readonly #intervalMillis: number;
  readonly #probe: HeartbeatMonitorOptions["probe"];
  readonly #onStateChange: HeartbeatMonitorOptions["onStateChange"];
  #timer: NodeJS.Timeout | null = null;
  #probeController: AbortController | null = null;
  #failureCount = 0;
  #running = false;

  constructor(options: HeartbeatMonitorOptions) {
    if (!Number.isSafeInteger(options.intervalMillis) || options.intervalMillis <= 0) {
      throw new RangeError("Heartbeat interval must be a positive integer");
    }
    this.#intervalMillis = options.intervalMillis;
    this.#probe = options.probe;
    this.#onStateChange = options.onStateChange;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#schedule();
  }

  stop(): void {
    if (!this.#running) {
      return;
    }
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#probeController?.abort();
    this.#probeController = null;
  }

  #schedule(): void {
    if (!this.#running) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, this.#intervalMillis);
    this.#timer.unref();
  }

  async #tick(): Promise<void> {
    if (!this.#running) {
      return;
    }
    const controller = new AbortController();
    this.#probeController = controller;
    try {
      await this.#probe(controller.signal);
      if (!this.#running || controller.signal.aborted) {
        return;
      }
      if (this.#failureCount > 0) {
        this.#failureCount = 0;
        this.#onStateChange("READY", null);
      }
    } catch (error) {
      if (!this.#running || controller.signal.aborted) {
        return;
      }
      this.#failureCount += 1;
      if (this.#failureCount >= 3) {
        this.#running = false;
        this.#onStateChange("DISCONNECTED", error);
        return;
      }
      this.#onStateChange(
        this.#failureCount === 1 ? "DEGRADED" : "RECONNECTING",
        error,
      );
    } finally {
      if (this.#probeController === controller) {
        this.#probeController = null;
      }
    }
    this.#schedule();
  }
}
