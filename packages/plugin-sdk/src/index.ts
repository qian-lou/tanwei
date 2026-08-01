import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

export const PLUGIN_API_VERSION = "tanwei.dev/plugin/v1" as const;
export const TEAM_POLICY_API_VERSION =
  "tanwei.dev/team-policy/v1" as const;

export interface DiagnosticTemplateContribution {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly actionId: string;
  readonly parameters: Readonly<Record<string, string>>;
}

export interface UnsignedPluginManifest {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly publisher: string;
  readonly templates: readonly DiagnosticTemplateContribution[];
}

export interface SignedPluginManifest extends UnsignedPluginManifest {
  readonly publicKey: string;
  readonly signature: string;
}

export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";

export interface UnsignedTeamPolicyPackage {
  readonly apiVersion: typeof TEAM_POLICY_API_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly maximumRiskLevel: RiskLevel;
  readonly deniedActions: readonly string[];
  readonly signer: string;
}

export interface SignedTeamPolicyPackage
  extends UnsignedTeamPolicyPackage {
  readonly publicKey: string;
  readonly signature: string;
}

export function definePlugin<T extends UnsignedPluginManifest>(
  manifest: T,
): T {
  return manifest;
}

export function defineTeamPolicy<T extends UnsignedTeamPolicyPackage>(
  policy: T,
): T {
  return policy;
}

export function signPluginManifest(
  manifest: UnsignedPluginManifest,
  privateKeyPem: string,
): SignedPluginManifest {
  const privateKey = requireEd25519PrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey).export({
    type: "spki",
    format: "pem",
  }) as string;
  const payload = { ...manifest, publicKey };
  return {
    ...payload,
    signature: detachedSignature(payload, privateKey),
  };
}

export function verifyPluginManifest(
  manifest: SignedPluginManifest,
): boolean {
  const { signature, ...payload } = manifest;
  return verifyDetached(payload, manifest.publicKey, signature);
}

export function signTeamPolicyPackage(
  policy: UnsignedTeamPolicyPackage,
  privateKeyPem: string,
): SignedTeamPolicyPackage {
  const privateKey = requireEd25519PrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey).export({
    type: "spki",
    format: "pem",
  }) as string;
  const payload = {
    ...policy,
    deniedActions: [...new Set(policy.deniedActions)].sort(),
    publicKey,
  };
  return {
    ...payload,
    signature: detachedSignature(payload, privateKey),
  };
}

export function verifyTeamPolicyPackage(
  policy: SignedTeamPolicyPackage,
): boolean {
  const { signature, ...payload } = policy;
  return verifyDetached(
    {
      ...payload,
      deniedActions: [...payload.deniedActions].sort(),
    },
    policy.publicKey,
    signature,
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function detachedSignature(
  payload: unknown,
  privateKey: ReturnType<typeof createPrivateKey>,
): string {
  return sign(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    privateKey,
  ).toString("base64");
}

function verifyDetached(
  payload: unknown,
  publicKeyPem: string,
  signature: string,
): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const signatureBytes = Buffer.from(signature, "base64");
    return (
      publicKey.asymmetricKeyType === "ed25519" &&
      signatureBytes.length === 64 &&
      verify(
        null,
        Buffer.from(canonicalJson(payload), "utf8"),
        publicKey,
        signatureBytes,
      )
    );
  } catch {
    return false;
  }
}

function requireEd25519PrivateKey(
  privateKeyPem: string,
): ReturnType<typeof createPrivateKey> {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Tanwei signing keys must use Ed25519");
  }
  return privateKey;
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Signed payloads cannot contain non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  throw new TypeError("Unsupported signed payload value");
}
