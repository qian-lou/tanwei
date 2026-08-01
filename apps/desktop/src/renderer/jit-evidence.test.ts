import type { ArtifactDescriptor } from "@shared/contracts";
import { describe, expect, it } from "vitest";
import {
  parseAgentArtifactReference,
  selectLatestReadyJfrArtifact,
} from "./jit-evidence";

function artifact(
  overrides: Partial<ArtifactDescriptor> = {},
): ArtifactDescriptor {
  return {
    id: "artifact-a",
    targetId: "target-a",
    type: "JFR",
    name: "recording.jfr",
    size: 1_024,
    sha256: "a".repeat(64),
    status: "READY",
    createdAt: "2026-07-31T10:00:00.000Z",
    ...overrides,
  };
}

describe("JIT evidence artifact selection", () => {
  it("selects only the newest ready JFR from the active target", () => {
    const selected = selectLatestReadyJfrArtifact(
      [
        artifact({ id: "older" }),
        artifact({
          id: "newer",
          createdAt: "2026-07-31T11:00:00.000Z",
        }),
        artifact({ id: "other-target", targetId: "target-b" }),
        artifact({ id: "failed", status: "FAILED" }),
        artifact({ id: "profile", type: "PROFILE" }),
      ],
      "target-a",
    );

    expect(selected?.id).toBe("newer");
    expect(selectLatestReadyJfrArtifact([], "target-a")).toBeNull();
  });

  it("uses the identifier as a deterministic tie breaker", () => {
    const selected = selectLatestReadyJfrArtifact(
      [artifact({ id: "artifact-a" }), artifact({ id: "artifact-b" })],
      "target-a",
    );

    expect(selected?.id).toBe("artifact-b");
  });

  it("accepts only bounded positive artifact references", () => {
    expect(
      parseAgentArtifactReference({ token: "token-a", size: "4096" }),
    ).toEqual({ token: "token-a", expectedSize: 4_096 });
    expect(parseAgentArtifactReference({ token: "", size: "4096" })).toBeNull();
    expect(
      parseAgentArtifactReference({ token: "token-a", size: "0" }),
    ).toBeNull();
    expect(
      parseAgentArtifactReference({
        token: "token-a",
        size: String(512 * 1_024 * 1_024 + 1),
      }),
    ).toBeNull();
  });
});
