import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import type {
  DiagnosticTemplate,
  TeamPolicyDescriptor,
} from "../../src/shared/contracts.js";

const actionIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u);
const publicKeySchema = z
  .string()
  .min(80)
  .max(4_096)
  .refine(
    (value) => value.includes("BEGIN PUBLIC KEY"),
    "必须提供 PEM 公钥",
  );
const signatureSchema = z
  .string()
  .min(80)
  .max(512)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const parameterSchema = z.record(
  z.string().min(1).max(128),
  z.string().max(4_096),
);

export const pluginPackageSchema = z
  .object({
    apiVersion: z.literal("tanwei.dev/plugin/v1"),
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u),
    name: z.string().trim().min(1).max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u),
    description: z.string().trim().max(1_000),
    publisher: z.string().trim().min(1).max(200),
    publicKey: publicKeySchema,
    templates: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u),
            name: z.string().trim().min(1).max(120),
            description: z.string().trim().max(1_000),
            actionId: actionIdSchema,
            parameters: parameterSchema,
          })
          .strict(),
      )
      .max(100),
    signature: signatureSchema,
  })
  .strict();

export type PluginPackage = z.infer<typeof pluginPackageSchema>;

export const teamPolicyPackageSchema = z
  .object({
    apiVersion: z.literal("tanwei.dev/team-policy/v1"),
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u),
    name: z.string().trim().min(1).max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    maximumRiskLevel: z.enum(["R0", "R1", "R2", "R3", "R4"]),
    deniedActions: z
      .array(actionIdSchema)
      .max(500)
      .transform((values) => [...new Set(values)].sort()),
    signer: z.string().trim().min(1).max(200),
    publicKey: publicKeySchema,
    signature: signatureSchema,
  })
  .strict();

export type TeamPolicyPackage = z.infer<typeof teamPolicyPackageSchema>;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function signCanonical(
  privateKey: KeyObject,
  value: unknown,
): string {
  return sign(null, Buffer.from(canonicalJson(value), "utf8"), privateKey)
    .toString("base64");
}

export function verifyCanonical(
  publicKeyPem: string,
  value: unknown,
  signature: string,
): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return false;
    }
    const bytes = Buffer.from(signature, "base64");
    return (
      bytes.length === 64 &&
      verify(
        null,
        Buffer.from(canonicalJson(value), "utf8"),
        publicKey,
        bytes,
      )
    );
  } catch {
    return false;
  }
}

export function publicKeyFingerprint(publicKeyPem: string): string {
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("签名公钥必须使用 Ed25519");
  }
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

export function pluginSignedPayload(
  plugin: PluginPackage,
): Readonly<Record<string, unknown>> {
  return {
    apiVersion: plugin.apiVersion,
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    publisher: plugin.publisher,
    publicKey: plugin.publicKey,
    templates: plugin.templates,
  };
}

export function verifyPluginPackage(plugin: PluginPackage): boolean {
  return verifyCanonical(
    plugin.publicKey,
    pluginSignedPayload(plugin),
    plugin.signature,
  );
}

export function teamPolicySignedPayload(
  policy: TeamPolicyPackage | TeamPolicyDescriptor,
): Readonly<Record<string, unknown>> {
  return {
    apiVersion: policy.apiVersion,
    id: policy.id,
    name: policy.name,
    version: policy.version,
    issuedAt: policy.issuedAt,
    expiresAt: policy.expiresAt,
    maximumRiskLevel: policy.maximumRiskLevel,
    deniedActions: [...policy.deniedActions].sort(),
    signer: policy.signer,
    publicKey: policy.publicKey,
  };
}

export function verifyTeamPolicy(
  policy: TeamPolicyPackage | TeamPolicyDescriptor,
): boolean {
  return verifyCanonical(
    policy.publicKey,
    teamPolicySignedPayload(policy),
    policy.signature,
  );
}

export function diagnosticTemplateSignedPayload(
  template: Omit<DiagnosticTemplate, "verified" | "signature">,
): Readonly<Record<string, unknown>> {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    actionId: template.actionId,
    parameters: template.parameters,
    riskLevel: template.riskLevel,
    source: template.source,
    signer: template.signer,
    publicKey: template.publicKey,
    publicKeyFingerprint: template.publicKeyFingerprint,
    createdAt: template.createdAt,
  };
}

export function verifyDiagnosticTemplate(
  template: DiagnosticTemplate,
): boolean {
  const { signature, verified: _verified, ...unsigned } = template;
  return (
    publicKeyFingerprint(template.publicKey) ===
      template.publicKeyFingerprint &&
    verifyCanonical(
      template.publicKey,
      diagnosticTemplateSignedPayload(unsigned),
      signature,
    )
  );
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
      throw new TypeError("签名载荷不能包含非有限数字");
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
  throw new TypeError("签名载荷包含不支持的值");
}
