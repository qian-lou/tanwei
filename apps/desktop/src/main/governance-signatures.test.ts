// @vitest-environment node

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DiagnosticTemplate } from "../shared/contracts.js";
import {
  diagnosticTemplateSignedPayload,
  pluginSignedPayload,
  publicKeyFingerprint,
  signCanonical,
  teamPolicySignedPayload,
  verifyDiagnosticTemplate,
  verifyPluginPackage,
  verifyTeamPolicy,
  type PluginPackage,
  type TeamPolicyPackage,
} from "./governance-signatures.js";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({
      type: "spki",
      format: "pem",
    }) as string,
  };
}

describe("signed governance assets", () => {
  it("verifies plugin manifests and detects payload tampering", () => {
    const { privateKey, publicKey } = keys();
    const unsigned: Omit<PluginPackage, "signature"> = {
      apiVersion: "tanwei.dev/plugin/v1",
      id: "runtime-basics",
      name: "Runtime Basics",
      version: "1.0.0",
      description: "safe templates",
      publisher: "Test Team",
      publicKey,
      templates: [
        {
          id: "jvm-info",
          name: "JVM Info",
          description: "read identity",
          actionId: "jvm.info",
          parameters: {},
        },
      ],
    };
    const plugin: PluginPackage = {
      ...unsigned,
      signature: signCanonical(privateKey, unsigned),
    };
    expect(verifyPluginPackage(plugin)).toBe(true);
    expect(
      verifyPluginPackage({
        ...plugin,
        name: "Tampered",
      }),
    ).toBe(false);
    expect(pluginSignedPayload(plugin)).toEqual(unsigned);
  });

  it("verifies team policy and local diagnostic template signatures", () => {
    const { privateKey, publicKey } = keys();
    const unsignedPolicy = {
      apiVersion: "tanwei.dev/team-policy/v1",
      id: "production",
      name: "Production",
      version: "1.0.0",
      issuedAt: new Date(0).toISOString(),
      expiresAt: null,
      maximumRiskLevel: "R1",
      deniedActions: ["gc.run"],
      signer: "Platform",
      publicKey,
    } as const;
    const policy: TeamPolicyPackage = {
      ...unsignedPolicy,
      deniedActions: [...unsignedPolicy.deniedActions],
      signature: signCanonical(privateKey, unsignedPolicy),
    };
    expect(verifyTeamPolicy(policy)).toBe(true);
    expect(teamPolicySignedPayload(policy)).toEqual(unsignedPolicy);

    const unsignedTemplate: Omit<
      DiagnosticTemplate,
      "signature" | "verified"
    > = {
      id: randomUUID(),
      name: "JVM Info",
      description: "read identity",
      actionId: "jvm.info",
      parameters: {},
      riskLevel: "R0",
      source: "LOCAL",
      signer: "Test",
      publicKey,
      publicKeyFingerprint: publicKeyFingerprint(publicKey),
      createdAt: new Date(0).toISOString(),
    };
    const template: DiagnosticTemplate = {
      ...unsignedTemplate,
      signature: signCanonical(
        privateKey,
        diagnosticTemplateSignedPayload(unsignedTemplate),
      ),
      verified: true,
    };
    expect(verifyDiagnosticTemplate(template)).toBe(true);
    expect(
      verifyDiagnosticTemplate({
        ...template,
        actionId: "system.properties",
      }),
    ).toBe(false);
  });
});
