// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ActionResult } from "@shared/contracts";
import { parseLineBatch } from "./LineView";

function actionResult(values: Readonly<Record<string, string>>): ActionResult {
  return {
    actionId: "line.events",
    taskId: "host-task",
    targetId: "local:42",
    riskLevel: "R0",
    status: "SUCCEEDED",
    errorCode: null,
    message: null,
    values,
    completedAt: new Date(0).toISOString(),
  };
}

describe("line event parser", () => {
  it("parses bounded local variables and call stacks", () => {
    const batch = parseLineBatch(
      actionResult({
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        state: "RUNNING",
        captured: "1",
        dropped: "0",
        "event.count": "1",
        "event.0000.sequence": "1",
        "event.0000.capturedAtEpochMillis": "1000",
        "event.0000.threadName": "worker-1",
        "event.0000.className": "example.Probe",
        "event.0000.method": "run(Ljava/lang/String;)V",
        "event.0000.lineNumber": "42",
        "event.0000.local.count": "2",
        "event.0000.local.00.name": "value",
        "event.0000.local.00.value": "order-42",
        "event.0000.local.01.name": "token",
        "event.0000.local.01.value": "[REDACTED]",
        "event.0000.stack.count": "1",
        "event.0000.stack.00": "example.Caller.call(Caller.java:7)",
      }),
    );

    expect(batch.state).toBe("RUNNING");
    expect(batch.events).toEqual([
      {
        sequence: 1,
        capturedAtEpochMillis: 1000,
        threadName: "worker-1",
        className: "example.Probe",
        method: "run(Ljava/lang/String;)V",
        lineNumber: 42,
        locals: [
          { name: "value", value: "order-42" },
          { name: "token", value: "[REDACTED]" },
        ],
        callStack: ["example.Caller.call(Caller.java:7)"],
      },
    ]);
  });

  it("rejects invalid task identities and ignores oversized event counts", () => {
    expect(() =>
      parseLineBatch(actionResult({ taskId: "invalid", "event.count": "1" })),
    ).toThrowError("Agent 返回的行探针任务标识无效");

    const batch = parseLineBatch(
      actionResult({
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        state: "RUNNING",
        captured: "100",
        dropped: "999",
        "event.count": "1000000",
      }),
    );
    expect(batch.events).toEqual([]);
  });
});
