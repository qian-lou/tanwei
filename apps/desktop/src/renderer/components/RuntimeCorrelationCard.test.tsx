import { render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  RuntimeCorrelationSummary,
  RuntimeIntervalEvidence,
} from "../utils/runtime-correlation";

let RuntimeCorrelationCard: typeof import("./RuntimeCorrelationCard").default;

function interval(
  endedAtEpochMillis: number,
  processCpuLoad: number | null,
): RuntimeIntervalEvidence {
  return {
    startedAtEpochMillis: endedAtEpochMillis - 2_000,
    endedAtEpochMillis,
    durationMillis: 2_000,
    processCpuLoad,
    heapUsedBytes: 153 * 1024 * 1024,
    heapMaxBytes: 24 * 1024 * 1024 * 1024,
    heapDeltaBytes: 0,
    liveThreads: 36,
    threadDelta: 0,
    gcCountDelta: 0,
    gcTimeDeltaMillis: 0,
    gcTimeShare: 0,
    signals: [],
    assessment: "STABLE",
  };
}

const SUMMARY: RuntimeCorrelationSummary = {
  intervalCount: 2,
  gcIntervals: 0,
  pressureIntervals: 0,
  concurrentSignalIntervals: 0,
  totalGcTimeDeltaMillis: 0,
  peakProcessCpuLoad: null,
  maximumHeapGrowthBytes: 0,
};

describe("RuntimeCorrelationCard", () => {
  beforeAll(async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    RuntimeCorrelationCard = (await import("./RuntimeCorrelationCard")).default;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("keeps unavailable CPU samples out of the numeric series", () => {
    const { container } = render(
      <RuntimeCorrelationCard
        intervals={[interval(10_000, null), interval(12_000, null)]}
        summary={SUMMARY}
      />,
    );

    const cpuChart = container.querySelector(
      '[data-series="process-cpu"]',
    );
    expect(cpuChart?.getAttribute("data-available-points")).toBe("0");
    expect(cpuChart?.getAttribute("data-missing-points")).toBe("2");
  });

  it("preserves CPU gaps and composes the visualization from shadcn primitives", () => {
    const { container } = render(
      <RuntimeCorrelationCard
        intervals={[
          interval(10_000, 0.2),
          interval(12_000, 0.3),
          interval(14_000, null),
          interval(16_000, 0.4),
          interval(18_000, 0.5),
        ]}
        summary={SUMMARY}
      />,
    );

    const cpuChart = container.querySelector('[data-series="process-cpu"]');
    expect(cpuChart?.getAttribute("data-available-points")).toBe("4");
    expect(cpuChart?.getAttribute("data-missing-points")).toBe("1");
    expect(container.querySelectorAll('[data-slot="chart"]')).toHaveLength(4);
    expect(container.querySelector('[data-slot="table"]')).not.toBeNull();
  });
});
