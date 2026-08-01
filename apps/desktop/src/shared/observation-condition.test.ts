import { describe, expect, it } from "vitest";
import {
  createObservationConditionClause,
  isObservationConditionValid,
  parseObservationCondition,
  serializeObservationCondition,
} from "./observation-condition.js";

describe("observation condition contract", () => {
  it("serializes a bounded four-clause AND expression", () => {
    const result = serializeObservationCondition([
      { ...createObservationConditionClause("DURATION"), value: "10.5" },
      {
        ...createObservationConditionClause("THREAD"),
        value: "http-nio",
      },
      {
        ...createObservationConditionClause("ARGUMENT"),
        argumentIndex: 2,
        value: "order-",
      },
      createObservationConditionClause("OUTCOME"),
    ]);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        expression:
          'durationMs >= 10.5 && thread contains "http-nio" && arg2 contains "order-" && outcome == "RETURNED"',
      }),
    );
  });

  it("parses legacy clauses and canonicalizes whitespace", () => {
    const result = parseObservationCondition(
      ' arg0   contains   "tick-"&&exception contains "IllegalState" ',
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        expression:
          'arg0 contains "tick-" && exception contains "IllegalState"',
      }),
    );
  });

  it("rejects scripts, OR, out-of-range arguments and excessive clauses", () => {
    expect(isObservationConditionValid('arg0 == "x" || true')).toBe(false);
    expect(isObservationConditionValid('arg16 == "x"')).toBe(false);
    expect(isObservationConditionValid("durationMs >= 60000.001")).toBe(false);
    expect(
      isObservationConditionValid(
        "durationMs >= 0 && durationMs < 1 && thread contains \"main\" && outcome == \"RETURNED\" && exception",
      ),
    ).toBe(false);
  });

  it("does not split an ampersand pair inside a quoted value", () => {
    const result = parseObservationCondition(
      'arg0 contains "A && B" && outcome == "RETURNED"',
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        expression: 'arg0 contains "A && B" && outcome == "RETURNED"',
      }),
    );
  });
});
