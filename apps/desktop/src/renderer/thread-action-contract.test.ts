import { describe, expect, it } from "vitest";
import type { ActionResult } from "@shared/contracts";
import { parseThreadLockInspection } from "./thread-action-contract";

function result(values: Readonly<Record<string, string>>): ActionResult {
  return {
    actionId: "thread.locks",
    taskId: "7d76dbf2-e197-4fca-a86c-7bb0834826a4",
    targetId: "local:42",
    riskLevel: "R0",
    status: "SUCCEEDED",
    errorCode: null,
    message: null,
    values,
    completedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("Thread Action Contract v1 adapter", () => {
  it("maps a bounded lock graph into typed nodes", () => {
    expect(
      parseThreadLockInspection(
        result({
          count: "1",
          scanned: "10",
          related: "1",
          truncated: "0",
          waiting: "1",
          heldLocks: "0",
          deadlocked: "0",
          edges: "1",
          "node.0000.id": "42",
          "node.0000.name": "worker",
          "node.0000.state": "BLOCKED",
          "node.0000.deadlocked": "false",
          "node.0000.waitingLock": "java.lang.Object@1",
          "node.0000.ownerId": "7",
          "node.0000.ownerName": "owner",
          "node.0000.stackTop": "example.Work.run(Work.java:1)",
          "node.0000.monitor.count": "0",
          "node.0000.synchronizer.count": "0",
        }),
      ),
    ).toMatchObject({
      nodes: [{ id: 42, name: "worker", ownerId: 7 }],
      summary: { scanned: 10, related: 1, edges: 1 },
    });
  });

  it("fails closed when a required summary or node field is missing", () => {
    expect(() =>
      parseThreadLockInspection(result({ count: "1" })),
    ).toThrow("线程锁节点无效");
    expect(() =>
      parseThreadLockInspection(result({ count: "0" })),
    ).toThrow("线程 Action 字段无效");
  });
});
