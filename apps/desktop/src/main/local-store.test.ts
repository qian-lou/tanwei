// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ArtifactDescriptor,
  PersistedInvocationSnapshot,
} from "../shared/contracts.js";
import { LocalStore } from "./local-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalStore", () => {
  it("backs up and migrates v3 settings with the safe R2 policy default", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-store-v3-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "tanwei.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        locale TEXT NOT NULL,
        sampling_interval_millis INTEGER NOT NULL,
        artifact_quota_bytes INTEGER NOT NULL,
        retention_days INTEGER NOT NULL,
        update_policy TEXT NOT NULL
      );
      INSERT INTO app_settings
      VALUES (1, 'en-US', 5000, 1073741824, 30, 'MANUAL');
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const store = await LocalStore.open(databasePath);
    expect(store.getSettings()).toMatchObject({
      locale: "en-US",
      fontFamily: "SYSTEM",
      maximumRiskLevel: "R2",
      systemNotificationPolicy: "CRITICAL_ONLY",
    });
    store.close();
    expect(
      (await readdir(directory)).some((name) =>
        name.includes(".pre-v12.backup"),
      ),
    ).toBe(true);
  });

  it("migrates and persists cases, artifacts and sanitized action audit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-store-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "tanwei.sqlite");
    const store = await LocalStore.open(databasePath);
    const timestamp = new Date().toISOString();
    expect(store.getSettings()).toMatchObject({
      locale: "zh-CN",
      fontFamily: "SYSTEM",
      defaultSamplingIntervalMillis: 2_000,
      maximumRiskLevel: "R2",
      systemNotificationPolicy: "CRITICAL_ONLY",
    });
    expect(
      store.updateSettings({
        locale: "en-US",
        fontFamily: "JETBRAINS_MONO",
        defaultSamplingIntervalMillis: 5_000,
        artifactQuotaBytes: 1024 * 1024 * 1024,
        retentionDays: 30,
        updatePolicy: "MANUAL",
        maximumRiskLevel: "R4",
        systemNotificationPolicy: "WARNING_AND_CRITICAL",
      }),
    ).toMatchObject({
      locale: "en-US",
      fontFamily: "JETBRAINS_MONO",
      defaultSamplingIntervalMillis: 5_000,
      maximumRiskLevel: "R4",
      systemNotificationPolicy: "WARNING_AND_CRITICAL",
    });

    const diagnosticCase = store.createCase(
      randomUUID(),
      {
        title: "CPU incident",
        notes: "bounded note",
        tags: ["cpu", "production"],
      },
      timestamp,
    );
    expect(store.listCases()).toEqual([diagnosticCase]);

    const templateId = randomUUID();
    store.insertDiagnosticTemplate({
      id: templateId,
      name: "JVM facts",
      description: "read-only",
      actionId: "jvm.info",
      parameters: {},
      riskLevel: "R0",
      source: "LOCAL",
      signer: "test signer",
      publicKey: "p".repeat(80),
      publicKeyFingerprint: "b".repeat(64),
      signature: "c".repeat(80),
      verified: true,
      createdAt: timestamp,
    });
    expect(store.getDiagnosticTemplate(templateId)).toMatchObject({
      id: templateId,
      verified: false,
    });

    store.setActiveTeamPolicy(
      {
        id: "production",
        name: "Production",
        version: "1.0.0",
        apiVersion: "tanwei.dev/team-policy/v1",
        issuedAt: timestamp,
        expiresAt: null,
        maximumRiskLevel: "R1",
        deniedActions: ["gc.run"],
        signer: "Platform",
        publicKey: "p".repeat(80),
        publicKeyFingerprint: "d".repeat(64),
        signature: "e".repeat(80),
        verified: true,
        activatedAt: null,
      },
      timestamp,
    );
    expect(store.getActiveTeamPolicy()).toMatchObject({
      maximumRiskLevel: "R1",
      activatedAt: timestamp,
    });

    const artifact: ArtifactDescriptor = {
      id: randomUUID(),
      targetId: "local:42",
      type: "SNAPSHOT",
      name: "snapshot.json",
      size: 10,
      sha256: "a".repeat(64),
      status: "READY",
      createdAt: timestamp,
    };
    store.insertArtifact(artifact, path.join(directory, artifact.name));
    expect(store.listArtifacts()).toEqual([artifact]);

    const diagnosticAlert = {
      id: randomUUID(),
      targetId: artifact.targetId,
      kind: "JIT_BASELINE_READY" as const,
      severity: "INFO" as const,
      artifactId: artifact.id,
      codeCachePercent: 3.5,
      codeCachePressure: "NORMAL" as const,
      codeCacheCapacityKind: "MAX" as const,
      createdAt: timestamp,
      acknowledgedAt: null,
    };
    store.insertDiagnosticAlert(diagnosticAlert);
    expect(store.listDiagnosticAlerts()).toEqual([diagnosticAlert]);
    expect(
      store.acknowledgeDiagnosticAlert(
        diagnosticAlert.id,
        "2026-07-31T20:00:01.000Z",
      ),
    ).toMatchObject({
      id: diagnosticAlert.id,
      acknowledgedAt: "2026-07-31T20:00:01.000Z",
    });
    expect(store.acknowledgeAllDiagnosticAlerts(timestamp)).toBe(0);

    store.insertActionAudit({
      actionId: "jvm.info",
      taskId: randomUUID(),
      targetId: "local:42",
      riskLevel: "R0",
      status: "SUCCEEDED",
      errorCode: null,
      message: null,
      values: { "java.version": "25.0.1" },
      completedAt: timestamp,
    });
    const audit = store.listActionAudits()[0];
    expect(audit).toMatchObject({
      actionId: "jvm.info",
      valueKeys: ["java.version"],
    });
    expect(
      store.updateCaseEvidence(
        diagnosticCase.id,
        [artifact.id],
        audit ? [audit.taskId] : [],
        timestamp,
      ),
    ).toMatchObject({
      caseId: diagnosticCase.id,
      artifacts: [artifact],
    });
    store.close();

    const reopened = await LocalStore.open(databasePath);
    expect(reopened.listCases()).toEqual([diagnosticCase]);
    expect(reopened.listArtifacts()).toEqual([artifact]);
    expect(reopened.listDiagnosticAlerts()).toMatchObject([
      {
        id: diagnosticAlert.id,
        artifactId: artifact.id,
        acknowledgedAt: "2026-07-31T20:00:01.000Z",
      },
    ]);
    expect(reopened.getSettings()).toMatchObject({
      locale: "en-US",
      fontFamily: "JETBRAINS_MONO",
      retentionDays: 30,
      maximumRiskLevel: "R4",
      systemNotificationPolicy: "WARNING_AND_CRITICAL",
    });
    expect(reopened.getCaseEvidence(diagnosticCase.id)).toMatchObject({
      artifacts: [artifact],
      actions: [{ actionId: "jvm.info" }],
    });
    expect(reopened.getDiagnosticTemplate(templateId)).toMatchObject({
      actionId: "jvm.info",
    });
    expect(reopened.getActiveTeamPolicy()).toMatchObject({
      deniedActions: ["gc.run"],
    });
    expect(reopened.deleteArtifact(artifact.id)).toBe(true);
    expect(reopened.listDiagnosticAlerts()[0]?.artifactId).toBeNull();
    reopened.close();
  });

  it("queries persistent action audits with bounded server-side filters and pagination", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-audit-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "tanwei.sqlite");
    const store = await LocalStore.open(databasePath);
    const taskIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ] as const;
    const records = [
      {
        taskId: taskIds[0],
        targetId: "local:41",
        actionId: "jvm.info",
        riskLevel: "R0" as const,
        status: "SUCCEEDED" as const,
        errorCode: null,
        completedAt: "2026-07-31T19:00:00.000Z",
      },
      {
        taskId: taskIds[1],
        targetId: "local:42",
        actionId: "mbean.attribute.set",
        riskLevel: "R4" as const,
        status: "FAILED" as const,
        errorCode: "MBean_CONCURRENT_DRIFT",
        completedAt: "2026-07-31T19:01:00.000Z",
      },
      {
        taskId: taskIds[2],
        targetId: "local:42",
        actionId: "session.reset.preview",
        riskLevel: "R0" as const,
        status: "SUCCEEDED" as const,
        errorCode: null,
        completedAt: "2026-07-31T19:02:00.000Z",
      },
      {
        taskId: taskIds[3],
        targetId: "local:42",
        actionId: "gc.run",
        riskLevel: "R4" as const,
        status: "SUCCEEDED" as const,
        errorCode: null,
        completedAt: "2026-07-31T19:03:00.000Z",
      },
    ];
    for (const record of records) {
      store.insertActionAudit({
        ...record,
        message: null,
        values: { summary: "redacted-at-source" },
      });
    }

    expect(
      store.queryActionAudits({
        offset: 0,
        limit: 2,
        query: "",
        targetId: "",
        status: "ALL",
        riskLevel: "ALL",
      }),
    ).toMatchObject({
      total: 4,
      retained: 4,
      succeeded: 3,
      failed: 1,
      items: [
        { taskId: taskIds[3], actionId: "gc.run" },
        { taskId: taskIds[2], actionId: "session.reset.preview" },
      ],
    });
    expect(
      store.queryActionAudits({
        offset: 0,
        limit: 50,
        query: "mbean",
        targetId: "local:42",
        status: "FAILED",
        riskLevel: "R4",
      }),
    ).toMatchObject({
      total: 1,
      succeeded: 0,
      failed: 1,
      items: [
        {
          taskId: taskIds[1],
          errorCode: "MBean_CONCURRENT_DRIFT",
          valueKeys: ["summary"],
        },
      ],
    });
    expect(
      store.queryActionAudits({
        offset: 1,
        limit: 2,
        query: "local:42",
        targetId: "",
        status: "ALL",
        riskLevel: "ALL",
      }).items.map((item) => item.taskId),
    ).toEqual([taskIds[2], taskIds[1]]);
    expect(
      store.queryActionAudits({
        offset: 0,
        limit: 50,
        query: "%",
        targetId: "",
        status: "ALL",
        riskLevel: "ALL",
      }).total,
    ).toBe(0);
    expect(() =>
      store.queryActionAudits({
        offset: 1_000_001,
        limit: 50,
        query: "",
        targetId: "",
        status: "ALL",
        riskLevel: "ALL",
      }),
    ).toThrow(/outside the allowed bounds/u);
    store.close();

    const reopened = await LocalStore.open(databasePath);
    expect(
      reopened.queryActionAudits({
        offset: 0,
        limit: 50,
        query: "gc.run",
        targetId: "local:42",
        status: "SUCCEEDED",
        riskLevel: "R4",
      }).items,
    ).toMatchObject([{ taskId: taskIds[3] }]);
    reopened.close();
  });

  it("persists and queries bounded invocation snapshots across desktop sessions", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "tanwei-invocation-archive-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "tanwei.sqlite");
    const store = await LocalStore.open(databasePath);
    const returned = invocationSnapshot({
      id: randomUUID(),
      sourceSnapshotId: 1001,
      className: "dev.tanwei.Target",
      method: "greet(java.lang.String)",
      arguments: ["world"],
      returnValue: "hello world",
      capturedAtEpochMillis: 1_785_500_001_000,
      savedAt: "2026-07-31T20:00:01.000Z",
    });
    const threw = invocationSnapshot({
      id: randomUUID(),
      sourceSnapshotId: 1002,
      className: "dev.tanwei.FailingTarget",
      method: "explode()",
      depth: 1,
      outcome: "THREW",
      exceptionType: "java.lang.IllegalStateException",
      exceptionMessage: "boom",
      capturedAtEpochMillis: 1_785_500_002_000,
      savedAt: "2026-07-31T20:00:02.000Z",
    });

    expect(store.upsertPersistedInvocationSnapshot(returned)).toEqual(returned);
    expect(store.upsertPersistedInvocationSnapshot(threw)).toEqual(threw);
    expect(
      store.queryPersistedInvocationSnapshots({
        offset: 0,
        limit: 50,
        query: "",
        targetId: "",
        outcome: "ALL",
        scope: "ALL",
      }),
    ).toMatchObject({
      total: 2,
      retained: 2,
      returned: 1,
      threw: 1,
      root: 1,
      internal: 1,
      items: [
        { id: threw.id, outcome: "THREW" },
        { id: returned.id, outcome: "RETURNED" },
      ],
    });
    expect(
      store.queryPersistedInvocationSnapshots({
        offset: 0,
        limit: 1,
        query: "hello world",
        targetId: "local:42",
        outcome: "RETURNED",
        scope: "ROOT",
      }).items,
    ).toMatchObject([{ id: returned.id, className: "dev.tanwei.Target" }]);
    expect(
      store.queryPersistedInvocationSnapshots({
        offset: 0,
        limit: 50,
        query: "%",
        targetId: "",
        outcome: "ALL",
        scope: "ALL",
      }).total,
    ).toBe(0);
    expect(store.getPersistedInvocationSnapshot(returned.id)).toMatchObject({
      arguments: ["world"],
      callStack: ["dev.tanwei.Caller.run(Caller.java:10)"],
    });
    store.close();

    const reopened = await LocalStore.open(databasePath);
    expect(reopened.getPersistedInvocationSnapshot(threw.id)).toMatchObject({
      exceptionMessage: "boom",
      jvmStartTimeEpochMillis: 1_785_500_000_000,
    });
    expect(reopened.deletePersistedInvocationSnapshot(threw.id)).toBe(true);
    expect(reopened.getPersistedInvocationSnapshot(threw.id)).toBeNull();
    reopened.close();
  });

  it("persists thread-pool aliases only for the exact target and JVM cycle", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-alias-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "tanwei.sqlite");
    const store = await LocalStore.open(databasePath);
    const descriptor = {
      targetId: "local:42",
      jvmStartTimeEpochMillis: 1_785_450_000_000,
      poolIdentity: "ThreadPoolExecutor@1a2b3c",
      poolClassName: "java.util.concurrent.ThreadPoolExecutor" as const,
      alias: "订单异步池",
      updatedAt: "2026-07-31T00:00:00.000Z",
    };

    expect(store.upsertThreadPoolAlias(descriptor)).toEqual(descriptor);
    expect(
      store.listThreadPoolAliases(
        descriptor.targetId,
        descriptor.jvmStartTimeEpochMillis,
      ),
    ).toEqual([descriptor]);
    expect(
      store.listThreadPoolAliases(
        descriptor.targetId,
        descriptor.jvmStartTimeEpochMillis + 1,
      ),
    ).toEqual([]);
    store.close();

    const reopened = await LocalStore.open(databasePath);
    expect(
      reopened.listThreadPoolAliases(
        descriptor.targetId,
        descriptor.jvmStartTimeEpochMillis,
      ),
    ).toEqual([descriptor]);
    expect(
      reopened.deleteThreadPoolAlias(
        descriptor.targetId,
        descriptor.jvmStartTimeEpochMillis,
        descriptor.poolIdentity,
      ),
    ).toBe(true);
    expect(
      reopened.listThreadPoolAliases(
        descriptor.targetId,
        descriptor.jvmStartTimeEpochMillis,
      ),
    ).toEqual([]);
    reopened.close();
  });

  it("bounds persisted diagnostic alerts and acknowledges the retained set", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-alerts-"));
    temporaryDirectories.push(directory);
    const store = await LocalStore.open(path.join(directory, "tanwei.sqlite"));
    const ids: string[] = [];
    for (let index = 0; index < 205; index += 1) {
      const id = randomUUID();
      ids.push(id);
      store.insertDiagnosticAlert({
        id,
        targetId: "local:42",
        kind: "JIT_BASELINE_READY",
        severity: "INFO",
        artifactId: null,
        codeCachePercent: 3.5,
        codeCachePressure: "NORMAL",
        codeCacheCapacityKind: "MAX",
        createdAt: new Date(1_785_450_000_000 + index).toISOString(),
        acknowledgedAt: null,
      });
    }

    const retained = store.listDiagnosticAlerts();
    expect(retained).toHaveLength(200);
    expect(retained.map((alert) => alert.id)).not.toContain(ids[0]);
    expect(retained[0]?.id).toBe(ids.at(-1));
    expect(
      store.acknowledgeAllDiagnosticAlerts("2026-07-31T20:00:01.000Z"),
    ).toBe(200);
    expect(
      store.listDiagnosticAlerts().every((alert) => alert.acknowledgedAt),
    ).toBe(true);
    store.close();
  });

  it("atomically replaces class change-set drafts for one exact JVM cycle", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tanwei-drafts-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "tanwei.sqlite");
    const targetId = "local:42";
    const jvmStartTime = 1_785_450_000_000;
    const drafts = [
      {
        className: "dev.tanwei.OrderService",
        classLoader: "AppClassLoader@1a2b3c",
        source: "package dev.tanwei; class OrderService {}",
      },
      {
        className: "dev.tanwei.OrderRepository",
        classLoader: "AppClassLoader@1a2b3c",
        source: "package dev.tanwei; class OrderRepository {}",
      },
    ] as const;
    const store = await LocalStore.open(databasePath);

    expect(
      store.replaceClassChangeSetDrafts(
        targetId,
        jvmStartTime,
        drafts,
        "2026-07-31T01:00:00.000Z",
      ),
    ).toEqual(drafts);
    expect(store.listClassChangeSetDrafts(targetId, jvmStartTime)).toEqual(
      drafts,
    );
    expect(store.listClassChangeSetDrafts(targetId, jvmStartTime + 1)).toEqual(
      [],
    );
    store.close();

    const reopened = await LocalStore.open(databasePath);
    expect(reopened.listClassChangeSetDrafts(targetId, jvmStartTime)).toEqual(
      drafts,
    );
    expect(() =>
      reopened.replaceClassChangeSetDrafts(
        targetId,
        jvmStartTime,
        [drafts[0], { ...drafts[1], source: "" }],
        "2026-07-31T01:30:00.000Z",
      ),
    ).toThrow();
    expect(reopened.listClassChangeSetDrafts(targetId, jvmStartTime)).toEqual(
      drafts,
    );
    expect(
      reopened.replaceClassChangeSetDrafts(
        targetId,
        jvmStartTime,
        drafts.slice(1),
        "2026-07-31T02:00:00.000Z",
      ),
    ).toEqual(drafts.slice(1));
    expect(reopened.listClassChangeSetDrafts(targetId, jvmStartTime)).toEqual(
      drafts.slice(1),
    );
    reopened.deleteStaleClassChangeSetDrafts(targetId, jvmStartTime + 1);
    expect(reopened.listClassChangeSetDrafts(targetId, jvmStartTime)).toEqual(
      [],
    );
    expect(
      reopened.replaceClassChangeSetDrafts(
        targetId,
        jvmStartTime,
        [],
        "2026-07-31T03:00:00.000Z",
      ),
    ).toEqual([]);
    expect(reopened.listClassChangeSetDrafts(targetId, jvmStartTime)).toEqual(
      [],
    );
    reopened.close();
  });
});

function invocationSnapshot(
  overrides: Partial<PersistedInvocationSnapshot> = {},
): PersistedInvocationSnapshot {
  const base: PersistedInvocationSnapshot = {
    id: randomUUID(),
    targetId: "local:42",
    jvmStartTimeEpochMillis: 1_785_500_000_000,
    sourceSnapshotId: 1000,
    taskId: randomUUID(),
    className: "dev.tanwei.Target",
    classLoader: "app-loader",
    rootMethodName: "greet",
    parameterTypes: "java.lang.String",
    modifiers: "public static",
    sequence: 1,
    parentSequence: -1,
    depth: 0,
    method: "greet(java.lang.String)",
    capturedAtEpochMillis: 1_785_500_001_000,
    durationNanos: 1_000_000,
    threadName: "main",
    outcome: "RETURNED",
    returnValue: "hello",
    exceptionType: "",
    exceptionMessage: "",
    arguments: ["world"],
    callStack: ["dev.tanwei.Caller.run(Caller.java:10)"],
    replayEligible: true,
    estimatedBytes: 0,
    savedAt: "2026-07-31T20:00:00.000Z",
  };
  const snapshot = { ...base, ...overrides };
  const characters = [
    snapshot.targetId,
    snapshot.taskId,
    snapshot.className,
    snapshot.classLoader,
    snapshot.rootMethodName,
    snapshot.parameterTypes,
    snapshot.modifiers,
    snapshot.method,
    snapshot.threadName,
    snapshot.returnValue,
    snapshot.exceptionType,
    snapshot.exceptionMessage,
    ...snapshot.arguments,
    ...snapshot.callStack,
  ].reduce((total, value) => total + value.length, 0);
  return { ...snapshot, estimatedBytes: 512 + characters * 2 };
}
