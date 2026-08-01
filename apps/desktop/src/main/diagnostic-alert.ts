import type {
  ArtifactDescriptor,
  DiagnosticAlertDescriptor,
  JitTrendSummary,
} from "../shared/contracts.js";

type JitAlertEvidence = Pick<
  JitTrendSummary,
  | "peakCodeCachePercent"
  | "codeCachePressure"
  | "codeCacheCapacityKind"
>;

export function createJitDiagnosticAlert(
  summary: JitAlertEvidence,
  artifact: ArtifactDescriptor,
  id: string,
  createdAt: string,
): DiagnosticAlertDescriptor {
  if (
    artifact.type !== "JIT_TREND" ||
    artifact.status !== "READY" ||
    !id.trim() ||
    !Number.isFinite(summary.peakCodeCachePercent) ||
    summary.peakCodeCachePercent < 0 ||
    summary.peakCodeCachePercent > 100 ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new Error("JIT diagnostic alert evidence is invalid");
  }
  const pressured = summary.codeCachePressure !== "NORMAL";
  return {
    id,
    targetId: artifact.targetId,
    kind: pressured ? "CODE_CACHE_PRESSURE" : "JIT_BASELINE_READY",
    severity:
      summary.codeCachePressure === "HIGH" ||
      summary.codeCachePressure === "EXHAUSTED"
        ? "CRITICAL"
        : summary.codeCachePressure === "ELEVATED"
          ? "WARNING"
          : "INFO",
    artifactId: artifact.id,
    codeCachePercent: summary.peakCodeCachePercent,
    codeCachePressure: summary.codeCachePressure,
    codeCacheCapacityKind: summary.codeCacheCapacityKind,
    createdAt,
    acknowledgedAt: null,
  };
}
