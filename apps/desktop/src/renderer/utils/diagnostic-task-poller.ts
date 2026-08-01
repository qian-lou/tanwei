export type DiagnosticPollResult = "continue" | "stop";

interface DiagnosticTaskPollerOptions {
  readonly intervalMillis: number;
  readonly poll: (signal: AbortSignal) => Promise<DiagnosticPollResult>;
  readonly onError?: (error: unknown) => void;
}

export class DiagnosticTaskPoller {
  readonly #intervalMillis: number;
  readonly #poll: DiagnosticTaskPollerOptions["poll"];
  readonly #onError: DiagnosticTaskPollerOptions["onError"];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pollController: AbortController | null = null;
  #generation = 0;
  #running = false;

  constructor(options: DiagnosticTaskPollerOptions) {
    if (
      !Number.isSafeInteger(options.intervalMillis) ||
      options.intervalMillis <= 0
    ) {
      throw new RangeError("Poll interval must be a positive integer");
    }
    this.#intervalMillis = options.intervalMillis;
    this.#poll = options.poll;
    this.#onError = options.onError;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    this.stop();
    this.#running = true;
    const generation = this.#generation;
    void this.#run(generation);
  }

  stop(): void {
    this.#running = false;
    this.#generation += 1;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pollController?.abort();
    this.#pollController = null;
  }

  async #run(generation: number): Promise<void> {
    if (!this.#isCurrent(generation)) {
      return;
    }
    const controller = new AbortController();
    this.#pollController = controller;
    try {
      const result = await this.#poll(controller.signal);
      if (!this.#isCurrent(generation) || controller.signal.aborted) {
        return;
      }
      if (result === "stop") {
        this.stop();
        return;
      }
    } catch (error) {
      if (!this.#isCurrent(generation) || controller.signal.aborted) {
        return;
      }
      this.#onError?.(error);
    } finally {
      if (this.#pollController === controller) {
        this.#pollController = null;
      }
    }
    if (!this.#isCurrent(generation)) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#run(generation);
    }, this.#intervalMillis);
  }

  #isCurrent(generation: number): boolean {
    return this.#running && this.#generation === generation;
  }
}
