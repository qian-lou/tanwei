// @vitest-environment node

import {
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActionResult,
  ActionRequest,
  OperationResult,
  TargetConnection,
  TargetSnapshot,
} from "../shared/contracts.js";
import {
  signCanonical,
  teamPolicySignedPayload,
  type PluginPackage,
  type TeamPolicyPackage,
} from "./governance-signatures.js";
import { GovernanceService } from "./governance-service.js";
import { LocalStore } from "./local-store.js";
import type { TargetService } from "./target-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("GovernanceService", () => {
  it("compares connected targets and signs executable safe templates", async () => {
    const directory = await temporaryDirectory();
    const store = await LocalStore.open(path.join(directory, "tanwei.sqlite"));
    const targetService = fakeTargetService();
    const service = await GovernanceService.open(
      directory,
      store,
      targetService,
    );

    const comparison = await service.compareTargets([
      "local:1",
      "local:2",
    ]);
    expect(comparison.value?.rows).toHaveLength(2);
    expect(
      comparison.value?.rows[1]?.deltaFromBaseline.heapUsedBytes,
    ).toBe(100);

    const created = service.createSignedDiagnosticTemplate({
      name: "JVM info",
      description: "safe",
      actionId: "jvm.info",
      parameters: {},
    });
    expect(created.value).toMatchObject({
      verified: true,
      riskLevel: "R0",
    });
    expect((await service.listDiagnosticTemplates()).value?.[0]).toMatchObject({
      verified: true,
    });
    const executed = await service.executeDiagnosticTemplate(
      created.value?.id ?? "",
      "local:1",
      false,
    );
    expect(executed.value).toMatchObject({
      actionId: "jvm.info",
      status: "SUCCEEDED",
    });
    store.close();
  });

  it("previews, installs and removes signed plugins and team policies", async () => {
    const directory = await temporaryDirectory();
    const store = await LocalStore.open(path.join(directory, "tanwei.sqlite"));
    const service = await GovernanceService.open(
      directory,
      store,
      fakeTargetService(),
    );
    const { privateKey, publicKey } = signingKeys();

    const unsignedPlugin: Omit<PluginPackage, "signature"> = {
      apiVersion: "tanwei.dev/plugin/v1",
      id: "runtime-basics",
      name: "Runtime Basics",
      version: "1.0.0",
      description: "safe",
      publisher: "Test",
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
      ...unsignedPlugin,
      signature: signCanonical(privateKey, unsignedPlugin),
    };
    const pluginPath = path.join(directory, "plugin.json");
    await writeFile(pluginPath, JSON.stringify(plugin), "utf8");
    const pluginPreview = await service.previewPluginImport(pluginPath);
    expect(pluginPreview.value?.value.verified).toBe(true);
    const installed = await service.installPlugin(
      pluginPreview.value?.previewId ?? "",
      true,
    );
    expect(installed.value?.id).toBe("runtime-basics");
    expect((await service.listPlugins()).value).toHaveLength(1);
    expect(
      (await service.listDiagnosticTemplates()).value?.find(
        (template) => template.source === "PLUGIN",
      ),
    ).toMatchObject({ verified: true, actionId: "jvm.info" });
    expect((await service.deletePlugin("runtime-basics", true)).ok).toBe(true);

    const unsignedPolicy: Omit<TeamPolicyPackage, "signature"> = {
      apiVersion: "tanwei.dev/team-policy/v1",
      id: "production",
      name: "Production",
      version: "1.0.0",
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      maximumRiskLevel: "R1",
      deniedActions: ["gc.run"],
      signer: "Platform",
      publicKey,
    };
    const policy: TeamPolicyPackage = {
      ...unsignedPolicy,
      signature: signCanonical(
        privateKey,
        teamPolicySignedPayload({
          ...unsignedPolicy,
          signature: "",
        }),
      ),
    };
    const policyPath = path.join(directory, "policy.json");
    await writeFile(policyPath, JSON.stringify(policy), "utf8");
    const policyPreview = await service.previewTeamPolicyImport(policyPath);
    expect(policyPreview.value?.value.verified).toBe(true);
    expect(
      service.activateTeamPolicy(
        policyPreview.value?.previewId ?? "",
        true,
      ).value,
    ).toMatchObject({ maximumRiskLevel: "R1", verified: true });
    expect(service.getActiveTeamPolicy().value).toMatchObject({
      deniedActions: ["gc.run"],
      verified: true,
    });
    expect(service.removeTeamPolicy(true).ok).toBe(true);
    expect(service.getActiveTeamPolicy().value).toBeNull();
    store.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tanwei-governance-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function signingKeys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({
      type: "spki",
      format: "pem",
    }) as string,
  };
}

function fakeTargetService(): TargetService {
  const connections: readonly TargetConnection[] = [1, 2].map(
    (pid): TargetConnection => ({
      target: {
        id: `local:${pid}`,
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
      capabilities: [
        { id: "overview", state: "AVAILABLE", reason: null },
      ],
      connectedAt: new Date(0).toISOString(),
      errorCode: null,
      errorMessage: null,
    }),
  );
  return {
    listConnections: () => connections,
    getSnapshot: async (
      targetId: string,
    ): Promise<OperationResult<TargetSnapshot>> => {
      const pid = Number(targetId.split(":")[1]);
      return {
        ok: true,
        value: {
          targetId,
          capturedAt: new Date(0).toISOString(),
          uptimeMillis: 1_000,
          jvmStartTimeEpochMillis: 1,
          processCpuLoad: pid / 10,
          systemCpuLoad: null,
          heapUsedBytes: pid * 100,
          heapMaxBytes: 1_000,
          nonHeapUsedBytes: pid * 10,
          liveThreads: pid,
          peakThreads: pid,
          loadedClasses: pid * 2,
          gcCount: pid,
          gcTimeMillis: pid * 3,
        },
        errorCode: null,
        errorMessage: null,
      };
    },
    executeAction: async (
      request: ActionRequest,
    ): Promise<OperationResult<ActionResult>> => ({
      ok: true,
      value: {
        actionId: request.actionId,
        taskId: randomUUID(),
        targetId: request.targetId,
        riskLevel: "R0",
        status: "SUCCEEDED",
        errorCode: null,
        message: null,
        values: {},
        completedAt: new Date().toISOString(),
      },
      errorCode: null,
      errorMessage: null,
    }),
  } as unknown as TargetService;
}
