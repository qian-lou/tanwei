import { describe, expect, it } from "vitest";
import type { ActionResult } from "@shared/contracts";
import { parseProfileTaskResult } from "./profile-action-contract";

function result(values: Readonly<Record<string, string>>): ActionResult {
  return {
    actionId: "profile.status",
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

describe("Profile Action Contract v1 adapter", () => {
  it("maps a complete generic response into a typed task snapshot", () => {
    expect(
      parseProfileTaskResult(
        result({
          kind: "PROFILE",
          taskId: "0125d955-accc-47c2-a510-80f97eb3c75c",
          state: "SUCCEEDED",
          samples: "42",
          dropped: "2",
          engine: "async-profiler",
          token: "ca8bb98d-1069-4d59-afde-2091c3b8a90d",
          size: "4096",
          type: "PROFILE",
        }),
      ),
    ).toEqual({
      taskId: "0125d955-accc-47c2-a510-80f97eb3c75c",
      state: "SUCCEEDED",
      samples: 42,
      dropped: 2,
      engine: "async-profiler",
      artifact: {
        token: "ca8bb98d-1069-4d59-afde-2091c3b8a90d",
        type: "PROFILE",
        expectedSize: 4096,
      },
    });
  });

  it("fails closed for missing fields and malformed artifacts", () => {
    expect(parseProfileTaskResult(result({ kind: "PROFILE" }))).toBeNull();
    expect(
      parseProfileTaskResult(
        result({
          kind: "PROFILE",
          taskId: "0125d955-accc-47c2-a510-80f97eb3c75c",
          state: "RUNNING",
          samples: "0",
          dropped: "0",
          engine: "async-profiler",
          token: "not-a-token",
          size: "1",
          type: "PROFILE",
        }),
      ),
    ).toBeNull();
  });
});
