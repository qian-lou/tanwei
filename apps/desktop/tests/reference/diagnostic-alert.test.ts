// @vitest-environment node

import { describe, expect, it } from "vitest";
import type {
  ArtifactDescriptor,
  CodeCachePressureState,
} from "../../src/shared/contracts.js";
import { createJitDiagnosticAlert } from "./diagnostic-alert.js";

const artifact: ArtifactDescriptor = {
  id: "44c4077b-f56c-4f7d-a428-500428423612",
  targetId: "local:42",
  type: "JIT_TREND",
  name: "jit.json",
  size: 1_024,
  sha256: "a".repeat(64),
  status: "READY",
  createdAt: "2026-07-31T20:00:00.000Z",
};

function alertAt(state: CodeCachePressureState) {
  const percent = {
    NORMAL: 79,
    ELEVATED: 80,
    HIGH: 90,
    EXHAUSTED: 100,
  }[state];
  return createJitDiagnosticAlert(
    {
      peakCodeCachePercent: percent,
      codeCachePressure: state,
      codeCacheCapacityKind: "MAX",
    },
    artifact,
    `alert-${state.toLocaleLowerCase()}`,
    "2026-07-31T20:00:01.000Z",
  );
}

describe("diagnostic alerts", () => {
  it("maps a normal saved window to an informational baseline event", () => {
    expect(alertAt("NORMAL")).toMatchObject({
      kind: "JIT_BASELINE_READY",
      severity: "INFO",
      artifactId: artifact.id,
      codeCachePercent: 79,
      acknowledgedAt: null,
    });
  });

  it("maps Code Cache thresholds to warning and critical events", () => {
    expect(alertAt("ELEVATED")).toMatchObject({
      kind: "CODE_CACHE_PRESSURE",
      severity: "WARNING",
    });
    expect(alertAt("HIGH")).toMatchObject({
      kind: "CODE_CACHE_PRESSURE",
      severity: "CRITICAL",
    });
    expect(alertAt("EXHAUSTED")).toMatchObject({
      kind: "CODE_CACHE_PRESSURE",
      severity: "CRITICAL",
    });
  });

  it("rejects detached or invalid evidence", () => {
    expect(() =>
      createJitDiagnosticAlert(
        {
          peakCodeCachePercent: 101,
          codeCachePressure: "EXHAUSTED",
          codeCacheCapacityKind: "MAX",
        },
        artifact,
        "alert-invalid",
        "2026-07-31T20:00:01.000Z",
      ),
    ).toThrow(/invalid/u);
  });
});
