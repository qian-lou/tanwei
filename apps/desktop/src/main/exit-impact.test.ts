import { describe, expect, it } from "vitest";
import type {
  ActionResult,
  OperationResult,
  TargetConnection,
} from "../shared/contracts.js";
import {
  exitImpactTargetFromAction,
  summarizeExitImpact,
} from "./exit-impact.js";

function connection(targetId: string, pid: number): TargetConnection {
  return {
    target: {
      id: targetId,
      pid,
      displayName: `JVM ${pid}`,
      mainClass: "example.Main",
      arguments: [],
      javaPath: null,
      javaVersion: "21",
      user: null,
      startTime: null,
      attachable: true,
      attachReason: null,
    },
    state: "READY",
    protocolVersion: "1.0",
    agentVersion: "0.1.0",
    javaVersion: "21",
    capabilities: [],
    connectedAt: "2026-07-31T00:00:00.000Z",
    errorCode: null,
    errorMessage: null,
  };
}

function preview(
  targetId: string,
  values: Readonly<Record<string, string>>,
): OperationResult<ActionResult> {
  return {
    ok: true,
    value: {
      actionId: "session.reset.preview",
      taskId: "00000000-0000-4000-8000-000000000001",
      targetId,
      riskLevel: "R0",
      status: "SUCCEEDED",
      errorCode: null,
      message: null,
      values,
      completedAt: "2026-07-31T00:00:01.000Z",
    },
    errorCode: null,
    errorMessage: null,
  };
}

describe("exit impact", () => {
  it("parses exact reset counts and summarizes multiple targets in O(N)", () => {
    const first = exitImpactTargetFromAction(
      connection("local:41", 41),
      preview("local:41", {
        "task.total": "2",
        "class.total": "3",
        "rollback.total": "4",
        "artifactPotential.total": "1",
        fingerprint: "a".repeat(64),
      }),
    );
    const second = exitImpactTargetFromAction(
      connection("local:42", 42),
      preview("local:42", {
        "task.total": "1",
        "class.total": "0",
        "rollback.total": "0",
        "artifactPotential.total": "0",
        fingerprint: "b".repeat(64),
      }),
    );

    expect(
      summarizeExitImpact(
        [first, second],
        "2026-07-31T00:00:02.000Z",
      ),
    ).toMatchObject({
      connectionCount: 2,
      inspectedCount: 2,
      failedCount: 0,
      taskCount: 3,
      classCount: 3,
      rollbackCount: 4,
      artifactPotentialCount: 1,
    });
  });

  it("fails closed for malformed, stale, or unsuccessful Agent data", () => {
    const target = connection("local:42", 42);
    const malformed = exitImpactTargetFromAction(
      target,
      preview("local:42", {
        "task.total": "-1",
        "class.total": "0",
        "rollback.total": "0",
        "artifactPotential.total": "0",
        fingerprint: "not-a-fingerprint",
      }),
    );
    const stale = exitImpactTargetFromAction(
      target,
      preview("local:43", {
        "task.total": "0",
        "class.total": "0",
        "rollback.total": "0",
        "artifactPotential.total": "0",
        fingerprint: "c".repeat(64),
      }),
    );
    const unavailable = exitImpactTargetFromAction(target, {
      ok: false,
      value: null,
      errorCode: "CONNECTION_LOST",
      errorMessage: "连接已中断",
    });

    expect(malformed).toMatchObject({ state: "FAILED", taskCount: 0 });
    expect(stale).toMatchObject({ state: "FAILED", taskCount: 0 });
    expect(unavailable).toMatchObject({
      state: "FAILED",
      errorMessage: "连接已中断",
    });
    expect(summarizeExitImpact([malformed, stale, unavailable])).toMatchObject(
      {
        connectionCount: 3,
        inspectedCount: 0,
        failedCount: 3,
        taskCount: 0,
      },
    );
  });

  it("represents an empty desktop session without inventing impact", () => {
    expect(
      summarizeExitImpact([], "2026-07-31T00:00:00.000Z"),
    ).toEqual({
      inspectedAt: "2026-07-31T00:00:00.000Z",
      connectionCount: 0,
      inspectedCount: 0,
      failedCount: 0,
      taskCount: 0,
      classCount: 0,
      rollbackCount: 0,
      artifactPotentialCount: 0,
      targets: [],
    });
  });
});
