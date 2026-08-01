import { BUILD_METADATA } from "../shared/build-metadata.generated.js";

export const CURRENT_PROTOCOL_VERSION = BUILD_METADATA.protocolVersion;

const PROTOCOL_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

export type ProtocolCompatibilityErrorCode =
  | "PROTOCOL_VERSION_MISSING"
  | "PROTOCOL_VERSION_INVALID"
  | "PROTOCOL_INCOMPATIBLE";

function parseProtocolVersion(value: string): ProtocolVersion | null {
  const match = PROTOCOL_VERSION_PATTERN.exec(value);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    return null;
  }
  return { major, minor };
}

export function isProtocolCompatible(
  clientVersion: string | null | undefined,
  agentVersion: string | null | undefined,
): boolean {
  return protocolCompatibilityError(clientVersion, agentVersion) === null;
}

export function protocolCompatibilityError(
  clientVersion: string | null | undefined,
  agentVersion: string | null | undefined,
): ProtocolCompatibilityErrorCode | null {
  if (!clientVersion?.trim() || !agentVersion?.trim()) {
    return "PROTOCOL_VERSION_MISSING";
  }
  const client = parseProtocolVersion(clientVersion);
  const agent = parseProtocolVersion(agentVersion);
  if (client === null || agent === null) {
    return "PROTOCOL_VERSION_INVALID";
  }
  return client.major === agent.major ? null : "PROTOCOL_INCOMPATIBLE";
}
