// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  aggregateTraceHotspots,
  type TraceAggregationInput,
} from "@shared/trace-aggregation";

describe("aggregateTraceHotspots", () => {
  it("aggregates inclusive and self time across retained traces", () => {
    const traces: readonly TraceAggregationInput[] = [
      {
        durationNanos: 100,
        spans: [
          span(1, null, "Root#run", 100),
          span(2, 1, "Service#load", 60),
          span(3, 1, "Cache#get", 20),
        ],
      },
      {
        durationNanos: 80,
        spans: [
          span(4, null, "Root#run", 80),
          span(5, 4, "Service#load", 50, "java.lang.IllegalStateException"),
        ],
      },
    ];

    const hotspots = aggregateTraceHotspots(traces);

    expect(hotspots.map((hotspot) => hotspot.method)).toEqual([
      "Service#load",
      "Root#run",
      "Cache#get",
    ]);
    expect(hotspots[0]).toMatchObject({
      calls: 2,
      errors: 1,
      totalDurationNanos: 110,
      selfDurationNanos: 110,
      averageDurationNanos: 55,
      maximumDurationNanos: 60,
    });
    expect(hotspots[1]).toMatchObject({
      calls: 2,
      errors: 0,
      totalDurationNanos: 180,
      selfDurationNanos: 50,
    });
    expect(hotspots[0]?.selfSharePercent).toBeCloseTo(61.111, 3);
  });

  it("clamps overlapping child time and ignores malformed values", () => {
    const hotspots = aggregateTraceHotspots([
      {
        durationNanos: Number.NaN,
        spans: [
          span(1, null, "Root#run", 10),
          span(2, 1, "Child#a", 8),
          span(3, 1, "Child#b", 8),
          span(4, 99, "", -1),
        ],
      },
    ]);

    expect(
      hotspots.find((hotspot) => hotspot.method === "Root#run"),
    ).toMatchObject({
      totalDurationNanos: 10,
      selfDurationNanos: 0,
    });
    expect(hotspots).toHaveLength(3);
    expect(hotspots.every((hotspot) => hotspot.selfSharePercent === 0)).toBe(
      true,
    );
  });

  it("applies a bounded render limit after deterministic sorting", () => {
    const hotspots = aggregateTraceHotspots(
      [
        {
          durationNanos: 10,
          spans: [span(1, null, "B#run", 5), span(2, null, "A#run", 5)],
        },
      ],
      1,
    );

    expect(hotspots).toHaveLength(1);
    expect(hotspots[0]?.method).toBe("A#run");
  });
});

function span(
  sequence: number,
  parentSequence: number | null,
  method: string,
  durationNanos: number,
  exceptionType: string | null = null,
) {
  return {
    sequence,
    parentSequence,
    method,
    durationNanos,
    exceptionType,
  };
}
