import { describe, expect, it } from "vitest";
import {
  buildInvocationValueDiff,
  type InvocationValueDiffInput,
  type InvocationValueEvidence,
  type InvocationValueNode,
} from "./invocation-value-diff";

function node(
  path: string,
  value: string,
  overrides: Partial<InvocationValueNode> = {},
): InvocationValueNode {
  return {
    path,
    parentIndex: -1,
    depth: 0,
    kind: "SCALAR",
    typeName: "java.lang.String",
    value,
    childCount: 0,
    truncated: false,
    ...overrides,
  };
}

function evidence(
  nodes: readonly InvocationValueNode[],
  overrides: Partial<InvocationValueEvidence> = {},
): InvocationValueEvidence {
  return {
    available: true,
    scannedFields: nodes.length,
    truncated: false,
    nodes,
    ...overrides,
  };
}

function snapshot(
  snapshotId: number,
  nodes: readonly InvocationValueNode[],
  overrides: Partial<InvocationValueDiffInput> = {},
): InvocationValueDiffInput {
  return {
    snapshotId,
    className: "example.Target",
    classLoader: "loader-1",
    method: "work(Lexample/Payload;)Lexample/Result;",
    invocationValues: evidence(nodes),
    ...overrides,
  };
}

describe("invocation value diff", () => {
  it("reports changed, added, removed and unchanged nodes", () => {
    const baseline = snapshot(10, [
      node("arg[0]", "", {
        kind: "OBJECT",
        typeName: "example.Payload",
        childCount: 3,
      }),
      node("arg[0].name", "before", { parentIndex: 0, depth: 1 }),
      node("arg[0].count", "7", { parentIndex: 0, depth: 1 }),
      node("arg[0].legacy", "old", { parentIndex: 0, depth: 1 }),
      node("result", "ok"),
    ]);
    const current = snapshot(11, [
      node("arg[0]", "", {
        kind: "OBJECT",
        typeName: "example.Payload",
        childCount: 3,
      }),
      node("arg[0].name", "after", { parentIndex: 0, depth: 1 }),
      node("arg[0].count", "7", { parentIndex: 0, depth: 1 }),
      node("arg[0].region", "west", { parentIndex: 0, depth: 1 }),
      node("result", "ok"),
    ]);

    const result = buildInvocationValueDiff(baseline, current);

    expect(result.compatibility).toBe("COMPATIBLE");
    expect(result.changedCount).toBe(1);
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(result.unchangedCount).toBe(3);
    expect(result.changes.map((change) => change.kind)).toEqual([
      "CHANGED",
      "ADDED",
      "REMOVED",
    ]);
  });

  it("uses occurrence order so duplicate field paths do not collapse", () => {
    const baseline = snapshot(20, [
      node("arg[0]", "", { kind: "OBJECT", childCount: 2 }),
      node("arg[0].value", "first", { parentIndex: 0, depth: 1 }),
      node("arg[0].value", "second", { parentIndex: 0, depth: 1 }),
    ]);
    const current = snapshot(21, [
      node("arg[0]", "", { kind: "OBJECT", childCount: 2 }),
      node("arg[0].value", "first", { parentIndex: 0, depth: 1 }),
      node("arg[0].value", "changed", { parentIndex: 0, depth: 1 }),
    ]);

    const result = buildInvocationValueDiff(baseline, current);

    expect(result.changedCount).toBe(1);
    expect(result.unchangedCount).toBe(2);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.before?.value).toBe("second");
    expect(result.changes[0]?.after?.value).toBe("changed");
  });

  it("fails closed for the same snapshot, method drift and unavailable values", () => {
    const baseline = snapshot(30, [node("result", "ok")]);

    expect(buildInvocationValueDiff(baseline, baseline).compatibility).toBe(
      "SAME_SNAPSHOT",
    );
    expect(
      buildInvocationValueDiff(
        baseline,
        snapshot(31, [node("result", "ok")], { method: "other()V" }),
      ).compatibility,
    ).toBe("METHOD_MISMATCH");
    expect(
      buildInvocationValueDiff(
        baseline,
        snapshot(32, [], {
          invocationValues: evidence([], { available: false }),
        }),
      ).compatibility,
    ).toBe("VALUES_UNAVAILABLE");
  });

  it("marks an otherwise valid comparison as partial when either tree truncated", () => {
    const result = buildInvocationValueDiff(
      snapshot(40, [node("result", "before")], {
        invocationValues: evidence([node("result", "before")], {
          truncated: true,
        }),
      }),
      snapshot(41, [node("result", "after")]),
    );

    expect(result.compatibility).toBe("COMPATIBLE");
    expect(result.truncated).toBe(true);
    expect(result.changedCount).toBe(1);
  });
});
