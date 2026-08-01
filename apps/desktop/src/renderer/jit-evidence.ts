import type { ArtifactDescriptor } from "@shared/contracts";

const MAXIMUM_JFR_ARTIFACT_BYTES = 512 * 1_024 * 1_024;
const MAXIMUM_ARTIFACT_TOKEN_LENGTH = 256;

export interface AgentArtifactReference {
  readonly token: string;
  readonly expectedSize: number;
}

function comparableCreatedAt(artifact: ArtifactDescriptor): number {
  const parsed = Date.parse(artifact.createdAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function selectLatestReadyJfrArtifact(
  artifacts: readonly ArtifactDescriptor[],
  targetId: string,
): ArtifactDescriptor | null {
  let latest: ArtifactDescriptor | null = null;
  for (const artifact of artifacts) {
    if (
      artifact.targetId !== targetId ||
      artifact.type !== "JFR" ||
      artifact.status !== "READY"
    ) {
      continue;
    }
    if (
      latest === null ||
      comparableCreatedAt(artifact) > comparableCreatedAt(latest) ||
      (comparableCreatedAt(artifact) === comparableCreatedAt(latest) &&
        artifact.id.localeCompare(latest.id) > 0)
    ) {
      latest = artifact;
    }
  }
  return latest;
}

export function parseAgentArtifactReference(
  values: Readonly<Record<string, string>>,
): AgentArtifactReference | null {
  const token = values.token?.trim() ?? "";
  const expectedSize = Number(values.size);
  if (
    token.length === 0 ||
    token.length > MAXIMUM_ARTIFACT_TOKEN_LENGTH ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    expectedSize > MAXIMUM_JFR_ARTIFACT_BYTES
  ) {
    return null;
  }
  return { token, expectedSize };
}
