import { beforeEach, describe, expect, it } from "vitest";
import type { ObservationEvent } from "@shared/contracts";
import { useObservationsStore } from "./observations";

function event(
  eventId: number,
  sequence: number,
  depth: number,
): ObservationEvent {
  return {
    eventId,
    sequence,
    parentSequence: depth === 0 ? null : 0,
    depth,
    method: depth === 0 ? "root()" : "nested()",
    phase: "FINISH",
    capturedAt: "2026-08-01T00:00:00.000Z",
    durationNanos: 1,
    threadName: "main",
    arguments: [],
    callStack: [],
    returnValue: "ok",
    exceptionType: null,
    exceptionMessage: null,
  };
}

describe("observations store", () => {
  beforeEach(() => {
    useObservationsStore.setState({
      selection: null,
      targetId: null,
      taskId: null,
      state: null,
      events: [],
      captured: 0,
      dropped: 0,
    });
  });

  it("orders a nested completion batch by invocation hierarchy", () => {
    useObservationsStore.getState().applyBatch({
      taskId: "00000000-0000-4000-8000-000000000001",
      state: "RUNNING",
      captured: 2,
      dropped: 0,
      events: [event(0, 1, 1), event(1, 0, 0)],
    });

    expect(
      useObservationsStore.getState().events.map((item) => item.method),
    ).toEqual(["root()", "nested()"]);
  });
});
