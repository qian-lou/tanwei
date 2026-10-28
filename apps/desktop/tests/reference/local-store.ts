import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_APP_FONT_FAMILY,
  normalizeAppFontFamily,
} from "../../src/shared/app-fonts.js";
import type {
  ActionAuditPage,
  ActionAuditQuery,
  ActionResult,
  ActionAuditDescriptor,
  AppSettings,
  ArtifactDescriptor,
  ArtifactStatus,
  ArtifactType,
  CompileClassChangeSetItem,
  CreateCaseInput,
  DiagnosticCase,
  DiagnosticAlertDescriptor,
  CaseEvidence,
  DiagnosticTemplate,
  PersistedInvocationSnapshot,
  PersistedInvocationSnapshotPage,
  PersistedInvocationSnapshotQuery,
  PersistedInvocationSnapshotSummary,
  SupportedThreadPoolClass,
  TeamPolicyDescriptor,
  ThreadPoolAliasDescriptor,
} from "../../src/shared/contracts.js";

const SCHEMA_VERSION = 12;
const MAXIMUM_UNPINNED_ACTION_AUDITS = 10_000;
const MAXIMUM_PERSISTED_INVOCATION_SNAPSHOTS = 2_000;
const MAXIMUM_PERSISTED_INVOCATION_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const DEFAULT_SETTINGS: AppSettings = {
  locale: "zh-CN",
  fontFamily: DEFAULT_APP_FONT_FAMILY,
  defaultSamplingIntervalMillis: 2_000,
  artifactQuotaBytes: 2 * 1024 * 1024 * 1024,
  retentionDays: 0,
  updatePolicy: "NOTIFY",
  maximumRiskLevel: "R2",
  systemNotificationPolicy: "CRITICAL_ONLY",
};

interface CaseRow {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly tags_json: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ArtifactRow {
  readonly id: string;
  readonly target_id: string;
  readonly type: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly status: string;
  readonly created_at: string;
}

interface ActionAuditRow {
  readonly task_id: string;
  readonly target_id: string;
  readonly action_id: string;
  readonly risk_level: string;
  readonly status: string;
  readonly error_code: string | null;
  readonly value_keys_json: string;
  readonly completed_at: string;
}

interface ActionAuditSummaryRow {
  readonly total: number;
  readonly succeeded: number | null;
  readonly failed: number | null;
}

interface PersistedInvocationSnapshotRow {
  readonly id: string;
  readonly target_id: string;
  readonly jvm_start_time_epoch_millis: number;
  readonly source_snapshot_id: number;
  readonly task_id: string;
  readonly class_name: string;
  readonly class_loader: string;
  readonly root_method_name: string;
  readonly parameter_types: string;
  readonly modifiers: string;
  readonly sequence: number;
  readonly parent_sequence: number;
  readonly depth: number;
  readonly method: string;
  readonly captured_at_epoch_millis: number;
  readonly duration_nanos: number;
  readonly thread_name: string;
  readonly outcome: string;
  readonly return_value: string;
  readonly exception_type: string;
  readonly exception_message: string;
  readonly arguments_json: string;
  readonly call_stack_json: string;
  readonly replay_eligible: number;
  readonly estimated_bytes: number;
  readonly saved_at: string;
}

interface PersistedInvocationSnapshotListRow {
  readonly id: string;
  readonly target_id: string;
  readonly jvm_start_time_epoch_millis: number;
  readonly source_snapshot_id: number;
  readonly task_id: string;
  readonly class_name: string;
  readonly sequence: number;
  readonly depth: number;
  readonly method: string;
  readonly captured_at_epoch_millis: number;
  readonly duration_nanos: number;
  readonly thread_name: string;
  readonly outcome: string;
  readonly exception_type: string;
  readonly replay_eligible: number;
  readonly estimated_bytes: number;
  readonly saved_at: string;
}

interface PersistedInvocationSnapshotAggregateRow {
  readonly total: number;
  readonly returned: number | null;
  readonly threw: number | null;
  readonly root: number | null;
  readonly internal: number | null;
}

interface DiagnosticAlertRow {
  readonly id: string;
  readonly target_id: string;
  readonly kind: string;
  readonly severity: string;
  readonly artifact_id: string | null;
  readonly code_cache_percent: number;
  readonly code_cache_pressure: string;
  readonly code_cache_capacity_kind: string;
  readonly created_at: string;
  readonly acknowledged_at: string | null;
}

interface DiagnosticTemplateRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly action_id: string;
  readonly parameters_json: string;
  readonly risk_level: string;
  readonly source: string;
  readonly signer: string;
  readonly public_key_pem: string;
  readonly public_key_fingerprint: string;
  readonly signature: string;
  readonly created_at: string;
}

interface ThreadPoolAliasRow {
  readonly target_id: string;
  readonly jvm_start_time_epoch_millis: number;
  readonly pool_identity: string;
  readonly pool_class_name: string;
  readonly alias: string;
  readonly updated_at: string;
}

interface ClassChangeSetDraftRow {
  readonly class_name: string;
  readonly class_loader: string;
  readonly source: string;
}

export class LocalStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static async open(databasePath: string): Promise<LocalStore> {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const existing = await stat(databasePath).catch(() => null);
    if (existing?.isFile()) {
      const probe = new DatabaseSync(databasePath, { readOnly: true });
      const row = probe.prepare("PRAGMA user_version").get() as
        { user_version?: number } | undefined;
      probe.close();
      const version = row?.user_version ?? 0;
      if (version < SCHEMA_VERSION) {
        const backupTimestamp = new Date()
          .toISOString()
          .replaceAll(/[:.]/gu, "-");
        await cp(
          databasePath,
          `${databasePath}.${backupTimestamp}.pre-v${SCHEMA_VERSION}.backup`,
          {
            force: false,
          },
        ).catch((error: unknown) => {
          throw new Error("SQLite 迁移前备份失败，已拒绝修改本地数据库", {
            cause: error,
          });
        });
      }
    }

    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    migrate(database);
    return new LocalStore(database);
  }

  close(): void {
    this.#database.close();
  }

  listCases(): readonly DiagnosticCase[] {
    const rows = this.#database
      .prepare(
        `SELECT id, title, notes, tags_json, status, created_at, updated_at
         FROM diagnostic_cases
         ORDER BY updated_at DESC`,
      )
      .all() as unknown as readonly CaseRow[];
    return rows.map(mapCase);
  }

  createCase(
    id: string,
    input: CreateCaseInput,
    timestamp: string,
  ): DiagnosticCase {
    this.#database
      .prepare(
        `INSERT INTO diagnostic_cases
           (id, title, notes, tags_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'OPEN', ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.notes,
        JSON.stringify(input.tags),
        timestamp,
        timestamp,
      );
    return {
      id,
      title: input.title,
      notes: input.notes,
      tags: input.tags,
      status: "OPEN",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  archiveCase(id: string, timestamp: string): DiagnosticCase | null {
    const result = this.#database
      .prepare(
        `UPDATE diagnostic_cases
         SET status = 'ARCHIVED', updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, id);
    if (result.changes === 0) {
      return null;
    }
    const row = this.#database
      .prepare(
        `SELECT id, title, notes, tags_json, status, created_at, updated_at
         FROM diagnostic_cases
         WHERE id = ?`,
      )
      .get(id) as CaseRow | undefined;
    return row ? mapCase(row) : null;
  }

  getCase(id: string): DiagnosticCase | null {
    const row = this.#database
      .prepare(
        `SELECT id, title, notes, tags_json, status, created_at, updated_at
         FROM diagnostic_cases
         WHERE id = ?`,
      )
      .get(id) as CaseRow | undefined;
    return row ? mapCase(row) : null;
  }

  deleteCase(id: string): boolean {
    return (
      this.#database
        .prepare("DELETE FROM diagnostic_cases WHERE id = ?")
        .run(id).changes > 0
    );
  }

  listArtifacts(): readonly ArtifactDescriptor[] {
    const rows = this.#database
      .prepare(
        `SELECT id, target_id, type, name, size, sha256, status, created_at
         FROM artifacts
         ORDER BY created_at DESC`,
      )
      .all() as unknown as readonly ArtifactRow[];
    return rows.map(mapArtifact);
  }

  getArtifact(id: string): ArtifactDescriptor | null {
    const row = this.#database
      .prepare(
        `SELECT id, target_id, type, name, size, sha256, status, created_at
         FROM artifacts
         WHERE id = ?`,
      )
      .get(id) as ArtifactRow | undefined;
    return row ? mapArtifact(row) : null;
  }

  insertArtifact(artifact: ArtifactDescriptor, absolutePath: string): void {
    this.#database
      .prepare(
        `INSERT INTO artifacts
           (id, target_id, type, name, absolute_path, size, sha256, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.targetId,
        artifact.type,
        artifact.name,
        absolutePath,
        artifact.size,
        artifact.sha256,
        artifact.status,
        artifact.createdAt,
      );
  }

  getArtifactPath(id: string): string | null {
    const row = this.#database
      .prepare("SELECT absolute_path FROM artifacts WHERE id = ?")
      .get(id) as { absolute_path?: string } | undefined;
    return row?.absolute_path ?? null;
  }

  deleteArtifact(id: string): boolean {
    return (
      this.#database.prepare("DELETE FROM artifacts WHERE id = ?").run(id)
        .changes > 0
    );
  }

  insertDiagnosticAlert(alert: DiagnosticAlertDescriptor): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `INSERT INTO diagnostic_alerts
             (id, target_id, kind, severity, artifact_id,
              code_cache_percent, code_cache_pressure,
              code_cache_capacity_kind, created_at, acknowledged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          alert.id,
          alert.targetId,
          alert.kind,
          alert.severity,
          alert.artifactId,
          alert.codeCachePercent,
          alert.codeCachePressure,
          alert.codeCacheCapacityKind,
          alert.createdAt,
          alert.acknowledgedAt,
        );
      this.#database.exec(`
        DELETE FROM diagnostic_alerts
        WHERE id IN (
          SELECT id
          FROM diagnostic_alerts
          ORDER BY created_at DESC, id DESC
          LIMIT -1 OFFSET 200
        );
      `);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listDiagnosticAlerts(): readonly DiagnosticAlertDescriptor[] {
    const rows = this.#database
      .prepare(
        `SELECT id, target_id, kind, severity, artifact_id,
                code_cache_percent, code_cache_pressure,
                code_cache_capacity_kind, created_at, acknowledged_at
         FROM diagnostic_alerts
         ORDER BY created_at DESC, id DESC
         LIMIT 200`,
      )
      .all() as unknown as readonly DiagnosticAlertRow[];
    return rows.map(mapDiagnosticAlert);
  }

  acknowledgeDiagnosticAlert(
    id: string,
    acknowledgedAt: string,
  ): DiagnosticAlertDescriptor | null {
    this.#database
      .prepare(
        `UPDATE diagnostic_alerts
         SET acknowledged_at = COALESCE(acknowledged_at, ?)
         WHERE id = ?`,
      )
      .run(acknowledgedAt, id);
    const row = this.#database
      .prepare(
        `SELECT id, target_id, kind, severity, artifact_id,
                code_cache_percent, code_cache_pressure,
                code_cache_capacity_kind, created_at, acknowledged_at
         FROM diagnostic_alerts
         WHERE id = ?`,
      )
      .get(id) as DiagnosticAlertRow | undefined;
    return row ? mapDiagnosticAlert(row) : null;
  }

  acknowledgeAllDiagnosticAlerts(acknowledgedAt: string): number {
    return Number(
      this.#database
        .prepare(
          `UPDATE diagnostic_alerts
           SET acknowledged_at = ?
           WHERE acknowledged_at IS NULL`,
        )
        .run(acknowledgedAt).changes,
    );
  }

  insertActionAudit(result: ActionResult): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `INSERT INTO action_audit
             (task_id, target_id, action_id, risk_level, status, error_code,
              value_keys_json, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          result.taskId,
          result.targetId,
          result.actionId,
          result.riskLevel,
          result.status,
          result.errorCode,
          JSON.stringify(Object.keys(result.values).sort()),
          result.completedAt,
        );
      this.#database
        .prepare(
          `DELETE FROM action_audit
           WHERE task_id IN (
             SELECT audit.task_id
             FROM action_audit audit
             LEFT JOIN case_actions pinned ON pinned.task_id = audit.task_id
             WHERE pinned.task_id IS NULL
             ORDER BY audit.completed_at DESC, audit.task_id DESC
             LIMIT -1 OFFSET ?
           )`,
        )
        .run(MAXIMUM_UNPINNED_ACTION_AUDITS);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listActionAudits(limit = 100): readonly ActionAuditDescriptor[] {
    const rows = this.#database
      .prepare(
        `SELECT task_id, target_id, action_id, risk_level, status, error_code,
                value_keys_json, completed_at
         FROM action_audit
         ORDER BY completed_at DESC
         LIMIT ?`,
      )
      .all(
        Math.max(1, Math.min(1_000, limit)),
      ) as unknown as readonly ActionAuditRow[];
    return rows.map(mapActionAudit);
  }

  queryActionAudits(query: ActionAuditQuery): ActionAuditPage {
    const normalized = normalizeActionAuditQuery(query);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (normalized.query) {
      const pattern = `%${escapeLikePattern(
        normalized.query.toLocaleLowerCase(),
      )}%`;
      clauses.push(`(
        lower(action_id) LIKE ? ESCAPE '\\'
        OR lower(task_id) LIKE ? ESCAPE '\\'
        OR lower(target_id) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(error_code, '')) LIKE ? ESCAPE '\\'
      )`);
      parameters.push(pattern, pattern, pattern, pattern);
    }
    if (normalized.targetId) {
      clauses.push("target_id = ?");
      parameters.push(normalized.targetId);
    }
    if (normalized.status !== "ALL") {
      clauses.push("status = ?");
      parameters.push(normalized.status);
    }
    if (normalized.riskLevel !== "ALL") {
      clauses.push("risk_level = ?");
      parameters.push(normalized.riskLevel);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const summary = this.#database
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
         FROM action_audit
         ${where}`,
      )
      .get(...parameters) as unknown as ActionAuditSummaryRow;
    const retained = this.#database
      .prepare("SELECT COUNT(*) AS total FROM action_audit")
      .get() as { readonly total: number };
    const rows = this.#database
      .prepare(
        `SELECT task_id, target_id, action_id, risk_level, status, error_code,
                value_keys_json, completed_at
         FROM action_audit
         ${where}
         ORDER BY completed_at DESC, task_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(
        ...parameters,
        normalized.limit,
        normalized.offset,
      ) as unknown as readonly ActionAuditRow[];
    return {
      total: summary.total,
      retained: retained.total,
      offset: normalized.offset,
      limit: normalized.limit,
      succeeded: summary.succeeded ?? 0,
      failed: summary.failed ?? 0,
      items: rows.map(mapActionAudit),
    };
  }

  upsertPersistedInvocationSnapshot(
    snapshot: PersistedInvocationSnapshot,
  ): PersistedInvocationSnapshot {
    validatePersistedInvocationSnapshot(snapshot);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `INSERT INTO persisted_invocation_snapshots (
             id, target_id, jvm_start_time_epoch_millis, source_snapshot_id,
             task_id, class_name, class_loader, root_method_name,
             parameter_types, modifiers, sequence, parent_sequence, depth,
             method, captured_at_epoch_millis, duration_nanos, thread_name,
             outcome, return_value, exception_type, exception_message,
             arguments_json, call_stack_json, replay_eligible,
             estimated_bytes, saved_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?
           )
           ON CONFLICT(target_id, jvm_start_time_epoch_millis, source_snapshot_id)
           DO UPDATE SET
             task_id = excluded.task_id,
             class_name = excluded.class_name,
             class_loader = excluded.class_loader,
             root_method_name = excluded.root_method_name,
             parameter_types = excluded.parameter_types,
             modifiers = excluded.modifiers,
             sequence = excluded.sequence,
             parent_sequence = excluded.parent_sequence,
             depth = excluded.depth,
             method = excluded.method,
             captured_at_epoch_millis = excluded.captured_at_epoch_millis,
             duration_nanos = excluded.duration_nanos,
             thread_name = excluded.thread_name,
             outcome = excluded.outcome,
             return_value = excluded.return_value,
             exception_type = excluded.exception_type,
             exception_message = excluded.exception_message,
             arguments_json = excluded.arguments_json,
             call_stack_json = excluded.call_stack_json,
             replay_eligible = excluded.replay_eligible,
             estimated_bytes = excluded.estimated_bytes,
             saved_at = excluded.saved_at`,
        )
        .run(
          snapshot.id,
          snapshot.targetId,
          snapshot.jvmStartTimeEpochMillis,
          snapshot.sourceSnapshotId,
          snapshot.taskId,
          snapshot.className,
          snapshot.classLoader,
          snapshot.rootMethodName,
          snapshot.parameterTypes,
          snapshot.modifiers,
          snapshot.sequence,
          snapshot.parentSequence,
          snapshot.depth,
          snapshot.method,
          snapshot.capturedAtEpochMillis,
          snapshot.durationNanos,
          snapshot.threadName,
          snapshot.outcome,
          snapshot.returnValue,
          snapshot.exceptionType,
          snapshot.exceptionMessage,
          JSON.stringify(snapshot.arguments),
          JSON.stringify(snapshot.callStack),
          snapshot.replayEligible ? 1 : 0,
          snapshot.estimatedBytes,
          snapshot.savedAt,
        );
      this.#database
        .prepare(
          `DELETE FROM persisted_invocation_snapshots
           WHERE id IN (
             SELECT id
             FROM persisted_invocation_snapshots
             ORDER BY saved_at DESC, id DESC
             LIMIT -1 OFFSET ?
           )`,
        )
        .run(MAXIMUM_PERSISTED_INVOCATION_SNAPSHOTS);
      this.#database
        .prepare(
          `DELETE FROM persisted_invocation_snapshots
           WHERE id IN (
             SELECT id FROM (
               SELECT id,
                      SUM(estimated_bytes) OVER (
                        ORDER BY saved_at DESC, id DESC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                      ) AS cumulative_bytes
               FROM persisted_invocation_snapshots
             ) bounded
             WHERE cumulative_bytes > ?
           )`,
        )
        .run(MAXIMUM_PERSISTED_INVOCATION_SNAPSHOT_BYTES);
      const row = this.#database
        .prepare(
          `${persistedInvocationSnapshotSelect()}
           WHERE target_id = ?
             AND jvm_start_time_epoch_millis = ?
             AND source_snapshot_id = ?`,
        )
        .get(
          snapshot.targetId,
          snapshot.jvmStartTimeEpochMillis,
          snapshot.sourceSnapshotId,
        ) as unknown as PersistedInvocationSnapshotRow | undefined;
      if (!row) {
        throw new Error("Persisted invocation snapshot exceeded storage bounds");
      }
      this.#database.exec("COMMIT");
      return mapPersistedInvocationSnapshot(row);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  queryPersistedInvocationSnapshots(
    query: PersistedInvocationSnapshotQuery,
  ): PersistedInvocationSnapshotPage {
    const normalized = normalizePersistedInvocationSnapshotQuery(query);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (normalized.query) {
      const pattern = `%${escapeLikePattern(
        normalized.query.toLocaleLowerCase(),
      )}%`;
      clauses.push(`(
        lower(class_name) LIKE ? ESCAPE '\\'
        OR lower(method) LIKE ? ESCAPE '\\'
        OR lower(thread_name) LIKE ? ESCAPE '\\'
        OR lower(task_id) LIKE ? ESCAPE '\\'
        OR lower(exception_type) LIKE ? ESCAPE '\\'
        OR lower(exception_message) LIKE ? ESCAPE '\\'
        OR lower(return_value) LIKE ? ESCAPE '\\'
        OR lower(arguments_json) LIKE ? ESCAPE '\\'
      )`);
      parameters.push(
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
      );
    }
    if (normalized.targetId) {
      clauses.push("target_id = ?");
      parameters.push(normalized.targetId);
    }
    if (normalized.outcome !== "ALL") {
      clauses.push("outcome = ?");
      parameters.push(normalized.outcome);
    }
    if (normalized.scope === "ROOT") {
      clauses.push("depth = 0");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const summary = this.#database
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN outcome = 'RETURNED' THEN 1 ELSE 0 END) AS returned,
                SUM(CASE WHEN outcome = 'THREW' THEN 1 ELSE 0 END) AS threw,
                SUM(CASE WHEN depth = 0 THEN 1 ELSE 0 END) AS root,
                SUM(CASE WHEN depth > 0 THEN 1 ELSE 0 END) AS internal
         FROM persisted_invocation_snapshots
         ${where}`,
      )
      .get(...parameters) as unknown as PersistedInvocationSnapshotAggregateRow;
    const retained = this.#database
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(estimated_bytes), 0) AS estimated_bytes
         FROM persisted_invocation_snapshots`,
      )
      .get() as { readonly total: number; readonly estimated_bytes: number };
    const rows = this.#database
      .prepare(
        `${persistedInvocationSnapshotSummarySelect()}
         ${where}
         ORDER BY captured_at_epoch_millis DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(
        ...parameters,
        normalized.limit,
        normalized.offset,
      ) as unknown as readonly PersistedInvocationSnapshotListRow[];
    return {
      total: summary.total,
      retained: retained.total,
      offset: normalized.offset,
      limit: normalized.limit,
      returned: summary.returned ?? 0,
      threw: summary.threw ?? 0,
      root: summary.root ?? 0,
      internal: summary.internal ?? 0,
      estimatedBytes: retained.estimated_bytes,
      items: rows.map(mapPersistedInvocationSnapshotSummary),
    };
  }

  getPersistedInvocationSnapshot(
    snapshotId: string,
  ): PersistedInvocationSnapshot | null {
    const row = this.#database
      .prepare(`${persistedInvocationSnapshotSelect()} WHERE id = ?`)
      .get(snapshotId) as unknown as PersistedInvocationSnapshotRow | undefined;
    return row ? mapPersistedInvocationSnapshot(row) : null;
  }

  deletePersistedInvocationSnapshot(snapshotId: string): boolean {
    return (
      this.#database
        .prepare("DELETE FROM persisted_invocation_snapshots WHERE id = ?")
        .run(snapshotId).changes > 0
    );
  }

  getCaseEvidence(caseId: string): CaseEvidence | null {
    if (!this.getCase(caseId)) {
      return null;
    }
    const artifactRows = this.#database
      .prepare(
        `SELECT a.id, a.target_id, a.type, a.name, a.size, a.sha256,
                a.status, a.created_at
         FROM artifacts a
         INNER JOIN case_artifacts ca ON ca.artifact_id = a.id
         WHERE ca.case_id = ?
         ORDER BY a.created_at`,
      )
      .all(caseId) as unknown as readonly ArtifactRow[];
    const actionRows = this.#database
      .prepare(
        `SELECT a.task_id, a.target_id, a.action_id, a.risk_level, a.status,
                a.error_code, a.value_keys_json, a.completed_at
         FROM action_audit a
         INNER JOIN case_actions ca ON ca.task_id = a.task_id
         WHERE ca.case_id = ?
         ORDER BY a.completed_at`,
      )
      .all(caseId) as unknown as readonly ActionAuditRow[];
    return {
      caseId,
      artifacts: artifactRows.map(mapArtifact),
      actions: actionRows.map(mapActionAudit),
    };
  }

  updateCaseEvidence(
    caseId: string,
    artifactIds: readonly string[],
    actionTaskIds: readonly string[],
    timestamp: string,
  ): CaseEvidence | null {
    if (!this.getCase(caseId)) {
      return null;
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("DELETE FROM case_artifacts WHERE case_id = ?")
        .run(caseId);
      this.#database
        .prepare("DELETE FROM case_actions WHERE case_id = ?")
        .run(caseId);
      const insertArtifact = this.#database.prepare(
        `INSERT INTO case_artifacts (case_id, artifact_id)
         SELECT ?, id FROM artifacts WHERE id = ?`,
      );
      for (const artifactId of artifactIds) {
        insertArtifact.run(caseId, artifactId);
      }
      const insertAction = this.#database.prepare(
        `INSERT INTO case_actions (case_id, task_id)
         SELECT ?, task_id FROM action_audit WHERE task_id = ?`,
      );
      for (const taskId of actionTaskIds) {
        insertAction.run(caseId, taskId);
      }
      this.#database
        .prepare("UPDATE diagnostic_cases SET updated_at = ? WHERE id = ?")
        .run(timestamp, caseId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.getCaseEvidence(caseId);
  }

  getSettings(): AppSettings {
    const row = this.#database
      .prepare(
        `SELECT locale, font_family, sampling_interval_millis, artifact_quota_bytes,
                retention_days, update_policy, maximum_risk_level,
                system_notification_policy
         FROM app_settings
         WHERE id = 1`,
      )
      .get() as
      | {
          locale?: string;
          font_family?: string;
          sampling_interval_millis?: number;
          artifact_quota_bytes?: number;
          retention_days?: number;
          update_policy?: string;
          maximum_risk_level?: string;
          system_notification_policy?: string;
        }
      | undefined;
    if (!row) {
      return DEFAULT_SETTINGS;
    }
    return {
      locale: row.locale === "en-US" ? "en-US" : "zh-CN",
      fontFamily: normalizeAppFontFamily(row.font_family),
      defaultSamplingIntervalMillis:
        row.sampling_interval_millis === 1_000 ||
        row.sampling_interval_millis === 5_000 ||
        row.sampling_interval_millis === 10_000
          ? row.sampling_interval_millis
          : 2_000,
      artifactQuotaBytes:
        typeof row.artifact_quota_bytes === "number"
          ? row.artifact_quota_bytes
          : DEFAULT_SETTINGS.artifactQuotaBytes,
      retentionDays:
        typeof row.retention_days === "number"
          ? row.retention_days
          : DEFAULT_SETTINGS.retentionDays,
      updatePolicy: row.update_policy === "MANUAL" ? "MANUAL" : "NOTIFY",
      maximumRiskLevel:
        row.maximum_risk_level === "R3" || row.maximum_risk_level === "R4"
          ? row.maximum_risk_level
          : "R2",
      systemNotificationPolicy:
        row.system_notification_policy === "OFF" ||
        row.system_notification_policy === "WARNING_AND_CRITICAL"
          ? row.system_notification_policy
          : "CRITICAL_ONLY",
    };
  }

  updateSettings(settings: AppSettings): AppSettings {
    this.#database
      .prepare(
        `UPDATE app_settings
         SET locale = ?,
             font_family = ?,
             sampling_interval_millis = ?,
             artifact_quota_bytes = ?,
             retention_days = ?,
             update_policy = ?,
             maximum_risk_level = ?,
             system_notification_policy = ?
         WHERE id = 1`,
      )
      .run(
        settings.locale,
        settings.fontFamily,
        settings.defaultSamplingIntervalMillis,
        settings.artifactQuotaBytes,
        settings.retentionDays,
        settings.updatePolicy,
        settings.maximumRiskLevel,
        settings.systemNotificationPolicy,
      );
    return this.getSettings();
  }

  listDiagnosticTemplates(): readonly DiagnosticTemplate[] {
    const rows = this.#database
      .prepare(
        `SELECT id, name, description, action_id, parameters_json,
                risk_level, source, signer, public_key_fingerprint,
                public_key_pem, signature, created_at
         FROM diagnostic_templates
         ORDER BY created_at DESC`,
      )
      .all() as unknown as readonly DiagnosticTemplateRow[];
    return rows.map(mapDiagnosticTemplate);
  }

  getDiagnosticTemplate(id: string): DiagnosticTemplate | null {
    const row = this.#database
      .prepare(
        `SELECT id, name, description, action_id, parameters_json,
                risk_level, source, signer, public_key_fingerprint,
                public_key_pem, signature, created_at
         FROM diagnostic_templates
         WHERE id = ?`,
      )
      .get(id) as DiagnosticTemplateRow | undefined;
    return row ? mapDiagnosticTemplate(row) : null;
  }

  insertDiagnosticTemplate(template: DiagnosticTemplate): void {
    this.#database
      .prepare(
        `INSERT INTO diagnostic_templates
           (id, name, description, action_id, parameters_json, risk_level,
            source, signer, public_key_pem, public_key_fingerprint, signature,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        template.id,
        template.name,
        template.description,
        template.actionId,
        JSON.stringify(template.parameters),
        template.riskLevel,
        template.source,
        template.signer,
        template.publicKey,
        template.publicKeyFingerprint,
        template.signature,
        template.createdAt,
      );
  }

  deleteDiagnosticTemplate(id: string): boolean {
    return (
      this.#database
        .prepare("DELETE FROM diagnostic_templates WHERE id = ?")
        .run(id).changes > 0
    );
  }

  getActiveTeamPolicy(): TeamPolicyDescriptor | null {
    const row = this.#database
      .prepare(
        "SELECT package_json, activated_at FROM active_team_policy WHERE id = 1",
      )
      .get() as { package_json?: string; activated_at?: string } | undefined;
    if (!row?.package_json || !row.activated_at) {
      return null;
    }
    const parsed = JSON.parse(row.package_json) as TeamPolicyDescriptor;
    return {
      ...parsed,
      activatedAt: row.activated_at,
    };
  }

  setActiveTeamPolicy(
    policy: TeamPolicyDescriptor,
    activatedAt: string,
  ): TeamPolicyDescriptor {
    const stored = {
      ...policy,
      activatedAt: null,
    };
    this.#database
      .prepare(
        `INSERT INTO active_team_policy (id, package_json, activated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           package_json = excluded.package_json,
           activated_at = excluded.activated_at`,
      )
      .run(JSON.stringify(stored), activatedAt);
    return {
      ...stored,
      activatedAt,
    };
  }

  clearActiveTeamPolicy(): void {
    this.#database.prepare("DELETE FROM active_team_policy WHERE id = 1").run();
  }

  listThreadPoolAliases(
    targetId: string,
    jvmStartTimeEpochMillis: number,
  ): readonly ThreadPoolAliasDescriptor[] {
    const rows = this.#database
      .prepare(
        `SELECT target_id, jvm_start_time_epoch_millis, pool_identity,
                pool_class_name, alias, updated_at
         FROM thread_pool_aliases
         WHERE target_id = ? AND jvm_start_time_epoch_millis = ?
         ORDER BY alias, pool_identity
         LIMIT 1000`,
      )
      .all(
        targetId,
        jvmStartTimeEpochMillis,
      ) as unknown as readonly ThreadPoolAliasRow[];
    return rows.map(mapThreadPoolAlias);
  }

  upsertThreadPoolAlias(
    alias: ThreadPoolAliasDescriptor,
  ): ThreadPoolAliasDescriptor {
    this.#database
      .prepare(
        `INSERT INTO thread_pool_aliases
           (target_id, jvm_start_time_epoch_millis, pool_identity,
            pool_class_name, alias, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_id, jvm_start_time_epoch_millis, pool_identity)
         DO UPDATE SET
           pool_class_name = excluded.pool_class_name,
           alias = excluded.alias,
           updated_at = excluded.updated_at`,
      )
      .run(
        alias.targetId,
        alias.jvmStartTimeEpochMillis,
        alias.poolIdentity,
        alias.poolClassName,
        alias.alias,
        alias.updatedAt,
      );
    return alias;
  }

  deleteThreadPoolAlias(
    targetId: string,
    jvmStartTimeEpochMillis: number,
    poolIdentity: string,
  ): boolean {
    return (
      this.#database
        .prepare(
          `DELETE FROM thread_pool_aliases
           WHERE target_id = ?
             AND jvm_start_time_epoch_millis = ?
             AND pool_identity = ?`,
        )
        .run(targetId, jvmStartTimeEpochMillis, poolIdentity).changes > 0
    );
  }

  listClassChangeSetDrafts(
    targetId: string,
    jvmStartTimeEpochMillis: number,
  ): readonly CompileClassChangeSetItem[] {
    const rows = this.#database
      .prepare(
        `SELECT class_name, class_loader, source
         FROM class_change_set_drafts
         WHERE target_id = ? AND jvm_start_time_epoch_millis = ?
         ORDER BY ordinal
         LIMIT 8`,
      )
      .all(
        targetId,
        jvmStartTimeEpochMillis,
      ) as unknown as readonly ClassChangeSetDraftRow[];
    return rows.map((row) => ({
      className: row.class_name,
      classLoader: row.class_loader,
      source: row.source,
    }));
  }

  deleteStaleClassChangeSetDrafts(
    targetId: string,
    jvmStartTimeEpochMillis: number,
  ): void {
    this.#database
      .prepare(
        `DELETE FROM class_change_set_drafts
         WHERE target_id = ? AND jvm_start_time_epoch_millis <> ?`,
      )
      .run(targetId, jvmStartTimeEpochMillis);
  }

  replaceClassChangeSetDrafts(
    targetId: string,
    jvmStartTimeEpochMillis: number,
    items: readonly CompileClassChangeSetItem[],
    updatedAt: string,
  ): readonly CompileClassChangeSetItem[] {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("DELETE FROM class_change_set_drafts WHERE target_id = ?")
        .run(targetId);
      const insert = this.#database.prepare(
        `INSERT INTO class_change_set_drafts
           (target_id, jvm_start_time_epoch_millis, ordinal,
            class_name, class_loader, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      items.forEach((item, index) => {
        insert.run(
          targetId,
          jvmStartTimeEpochMillis,
          index,
          item.className,
          item.classLoader,
          item.source,
          updatedAt,
        );
      });
      this.#database.exec("COMMIT");
      return items;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function migrate(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS diagnostic_cases (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
        notes TEXT NOT NULL CHECK(length(notes) <= 20000),
        tags_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('OPEN', 'ARCHIVED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cases_updated_at
        ON diagnostic_cases(updated_at DESC);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        absolute_path TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL CHECK(size >= 0),
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_created_at
        ON artifacts(created_at DESC);

      CREATE TABLE IF NOT EXISTS diagnostic_alerts (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 560),
        kind TEXT NOT NULL CHECK(kind IN (
          'JIT_BASELINE_READY', 'CODE_CACHE_PRESSURE'
        )),
        severity TEXT NOT NULL CHECK(severity IN (
          'INFO', 'WARNING', 'CRITICAL'
        )),
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        code_cache_percent REAL NOT NULL
          CHECK(code_cache_percent BETWEEN 0 AND 100),
        code_cache_pressure TEXT NOT NULL CHECK(code_cache_pressure IN (
          'NORMAL', 'ELEVATED', 'HIGH', 'EXHAUSTED'
        )),
        code_cache_capacity_kind TEXT NOT NULL
          CHECK(code_cache_capacity_kind IN ('MAX', 'COMMITTED')),
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_diagnostic_alerts_created_at
        ON diagnostic_alerts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_diagnostic_alerts_unread
        ON diagnostic_alerts(acknowledged_at, created_at DESC);

      CREATE TABLE IF NOT EXISTS action_audit (
        task_id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        value_keys_json TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_action_audit_completed_at
        ON action_audit(completed_at DESC, task_id DESC);
      CREATE INDEX IF NOT EXISTS idx_action_audit_target_completed
        ON action_audit(target_id, completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_action_audit_action_completed
        ON action_audit(action_id, completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_action_audit_status_risk_completed
        ON action_audit(status, risk_level, completed_at DESC);

      CREATE TABLE IF NOT EXISTS persisted_invocation_snapshots (
        id TEXT PRIMARY KEY CHECK(length(id) = 36),
        target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 560),
        jvm_start_time_epoch_millis INTEGER NOT NULL
          CHECK(jvm_start_time_epoch_millis > 0),
        source_snapshot_id INTEGER NOT NULL CHECK(source_snapshot_id > 0),
        task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 4096),
        class_name TEXT NOT NULL CHECK(length(class_name) BETWEEN 1 AND 4096),
        class_loader TEXT NOT NULL CHECK(length(class_loader) <= 4096),
        root_method_name TEXT NOT NULL CHECK(length(root_method_name) <= 512),
        parameter_types TEXT NOT NULL CHECK(length(parameter_types) <= 4096),
        modifiers TEXT NOT NULL CHECK(length(modifiers) <= 512),
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        parent_sequence INTEGER NOT NULL CHECK(parent_sequence >= -1),
        depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 1024),
        method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 4096),
        captured_at_epoch_millis INTEGER NOT NULL
          CHECK(captured_at_epoch_millis > 0),
        duration_nanos INTEGER NOT NULL CHECK(duration_nanos >= 0),
        thread_name TEXT NOT NULL CHECK(length(thread_name) <= 512),
        outcome TEXT NOT NULL CHECK(outcome IN ('RETURNED', 'THREW')),
        return_value TEXT NOT NULL CHECK(length(return_value) <= 512),
        exception_type TEXT NOT NULL CHECK(length(exception_type) <= 512),
        exception_message TEXT NOT NULL CHECK(length(exception_message) <= 512),
        arguments_json TEXT NOT NULL CHECK(length(arguments_json) <= 16384),
        call_stack_json TEXT NOT NULL CHECK(length(call_stack_json) <= 16384),
        replay_eligible INTEGER NOT NULL CHECK(replay_eligible IN (0, 1)),
        estimated_bytes INTEGER NOT NULL
          CHECK(estimated_bytes BETWEEN 1 AND 131072),
        saved_at TEXT NOT NULL,
        UNIQUE(target_id, jvm_start_time_epoch_millis, source_snapshot_id)
      );
      CREATE INDEX IF NOT EXISTS idx_persisted_invocation_saved
        ON persisted_invocation_snapshots(saved_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_persisted_invocation_target_capture
        ON persisted_invocation_snapshots(
          target_id, jvm_start_time_epoch_millis,
          captured_at_epoch_millis DESC, id DESC
        );
      CREATE INDEX IF NOT EXISTS idx_persisted_invocation_outcome_depth_capture
        ON persisted_invocation_snapshots(
          outcome, depth, captured_at_epoch_millis DESC, id DESC
        );

      CREATE TABLE IF NOT EXISTS case_artifacts (
        case_id TEXT NOT NULL REFERENCES diagnostic_cases(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        PRIMARY KEY (case_id, artifact_id)
      );

      CREATE TABLE IF NOT EXISTS case_actions (
        case_id TEXT NOT NULL REFERENCES diagnostic_cases(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES action_audit(task_id) ON DELETE CASCADE,
        PRIMARY KEY (case_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_case_actions_task_id
        ON case_actions(task_id);

      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        locale TEXT NOT NULL CHECK(locale IN ('zh-CN', 'en-US')),
        font_family TEXT NOT NULL DEFAULT 'SYSTEM'
          CHECK(font_family IN (
            'SYSTEM', 'INTER', 'SOURCE_HAN_SANS', 'MODERN_CHINESE_SANS',
            'LXGW_WENKAI', 'JETBRAINS_MONO', 'SOURCE_HAN_SERIF'
          )),
        sampling_interval_millis INTEGER NOT NULL
          CHECK(sampling_interval_millis IN (1000, 2000, 5000, 10000)),
        artifact_quota_bytes INTEGER NOT NULL
          CHECK(artifact_quota_bytes BETWEEN 104857600 AND 1099511627776),
        retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 0 AND 3650),
        update_policy TEXT NOT NULL CHECK(update_policy IN ('NOTIFY', 'MANUAL')),
        maximum_risk_level TEXT NOT NULL DEFAULT 'R2'
          CHECK(maximum_risk_level IN ('R2', 'R3', 'R4')),
        system_notification_policy TEXT NOT NULL DEFAULT 'CRITICAL_ONLY'
          CHECK(system_notification_policy IN (
            'OFF', 'CRITICAL_ONLY', 'WARNING_AND_CRITICAL'
          ))
      );

      CREATE TABLE IF NOT EXISTS diagnostic_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
        description TEXT NOT NULL CHECK(length(description) <= 1000),
        action_id TEXT NOT NULL CHECK(length(action_id) BETWEEN 1 AND 128),
        parameters_json TEXT NOT NULL,
        risk_level TEXT NOT NULL CHECK(risk_level IN ('R0', 'R1')),
        source TEXT NOT NULL CHECK(source IN ('LOCAL', 'PLUGIN')),
        signer TEXT NOT NULL CHECK(length(signer) BETWEEN 1 AND 200),
        public_key_pem TEXT NOT NULL CHECK(length(public_key_pem) BETWEEN 80 AND 4096),
        public_key_fingerprint TEXT NOT NULL CHECK(length(public_key_fingerprint) = 64),
        signature TEXT NOT NULL CHECK(length(signature) BETWEEN 80 AND 512),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_diagnostic_templates_created_at
        ON diagnostic_templates(created_at DESC);

      CREATE TABLE IF NOT EXISTS active_team_policy (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        package_json TEXT NOT NULL,
        activated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_pool_aliases (
        target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 560),
        jvm_start_time_epoch_millis INTEGER NOT NULL
          CHECK(jvm_start_time_epoch_millis > 0),
        pool_identity TEXT NOT NULL CHECK(length(pool_identity) BETWEEN 1 AND 128),
        pool_class_name TEXT NOT NULL CHECK(pool_class_name IN (
          'java.util.concurrent.ThreadPoolExecutor',
          'java.util.concurrent.ScheduledThreadPoolExecutor',
          'java.util.concurrent.ForkJoinPool'
        )),
        alias TEXT NOT NULL CHECK(length(alias) BETWEEN 1 AND 64),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(target_id, jvm_start_time_epoch_millis, pool_identity)
      );
      CREATE INDEX IF NOT EXISTS idx_thread_pool_aliases_updated_at
        ON thread_pool_aliases(updated_at DESC);

      CREATE TABLE IF NOT EXISTS class_change_set_drafts (
        target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 560),
        jvm_start_time_epoch_millis INTEGER NOT NULL
          CHECK(jvm_start_time_epoch_millis > 0),
        ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 7),
        class_name TEXT NOT NULL CHECK(length(class_name) BETWEEN 1 AND 1024),
        class_loader TEXT NOT NULL CHECK(length(class_loader) BETWEEN 1 AND 4096),
        source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 1048576),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(target_id, jvm_start_time_epoch_millis, class_name, class_loader),
        UNIQUE(target_id, jvm_start_time_epoch_millis, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_class_change_set_drafts_updated_at
        ON class_change_set_drafts(updated_at DESC);
    `);
    const settingsColumns = database
      .prepare("PRAGMA table_info(app_settings)")
      .all() as unknown as readonly { name?: string }[];
    if (
      !settingsColumns.some((column) => column.name === "maximum_risk_level")
    ) {
      database.exec(`
        ALTER TABLE app_settings
        ADD COLUMN maximum_risk_level TEXT NOT NULL DEFAULT 'R2'
          CHECK(maximum_risk_level IN ('R2', 'R3', 'R4'));
      `);
    }
    if (
      !settingsColumns.some(
        (column) => column.name === "system_notification_policy",
      )
    ) {
      database.exec(`
        ALTER TABLE app_settings
        ADD COLUMN system_notification_policy TEXT NOT NULL DEFAULT 'CRITICAL_ONLY'
          CHECK(system_notification_policy IN (
            'OFF', 'CRITICAL_ONLY', 'WARNING_AND_CRITICAL'
          ));
      `);
    }
    if (!settingsColumns.some((column) => column.name === "font_family")) {
      database.exec(`
        ALTER TABLE app_settings
        ADD COLUMN font_family TEXT NOT NULL DEFAULT 'SYSTEM'
          CHECK(font_family IN (
            'SYSTEM', 'INTER', 'SOURCE_HAN_SANS', 'MODERN_CHINESE_SANS',
            'LXGW_WENKAI', 'JETBRAINS_MONO', 'SOURCE_HAN_SERIF'
          ));
      `);
    }
    database.exec(`
      INSERT OR IGNORE INTO app_settings
        (id, locale, font_family, sampling_interval_millis, artifact_quota_bytes,
         retention_days, update_policy, maximum_risk_level,
         system_notification_policy)
      VALUES (
        1, 'zh-CN', 'SYSTEM', 2000, 2147483648, 0, 'NOTIFY', 'R2',
        'CRITICAL_ONLY'
      );
    `);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function mapCase(row: CaseRow): DiagnosticCase {
  const tags = JSON.parse(row.tags_json) as unknown;
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    tags: Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    status: row.status === "ARCHIVED" ? "ARCHIVED" : "OPEN",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapArtifact(row: ArtifactRow): ArtifactDescriptor {
  return {
    id: row.id,
    targetId: row.target_id,
    type: row.type as ArtifactType,
    name: row.name,
    size: row.size,
    sha256: row.sha256,
    status: row.status as ArtifactStatus,
    createdAt: row.created_at,
  };
}

function mapDiagnosticAlert(
  row: DiagnosticAlertRow,
): DiagnosticAlertDescriptor {
  if (
    (row.kind !== "JIT_BASELINE_READY" && row.kind !== "CODE_CACHE_PRESSURE") ||
    (row.severity !== "INFO" &&
      row.severity !== "WARNING" &&
      row.severity !== "CRITICAL") ||
    (row.code_cache_pressure !== "NORMAL" &&
      row.code_cache_pressure !== "ELEVATED" &&
      row.code_cache_pressure !== "HIGH" &&
      row.code_cache_pressure !== "EXHAUSTED") ||
    (row.code_cache_capacity_kind !== "MAX" &&
      row.code_cache_capacity_kind !== "COMMITTED") ||
    !Number.isFinite(row.code_cache_percent) ||
    row.code_cache_percent < 0 ||
    row.code_cache_percent > 100
  ) {
    throw new Error("Stored diagnostic alert is invalid");
  }
  return {
    id: row.id,
    targetId: row.target_id,
    kind: row.kind,
    severity: row.severity,
    artifactId: row.artifact_id,
    codeCachePercent: row.code_cache_percent,
    codeCachePressure: row.code_cache_pressure,
    codeCacheCapacityKind: row.code_cache_capacity_kind,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

function mapActionAudit(row: ActionAuditRow): ActionAuditDescriptor {
  const valueKeys = JSON.parse(row.value_keys_json) as unknown;
  return {
    taskId: row.task_id,
    targetId: row.target_id,
    actionId: row.action_id,
    riskLevel:
      row.risk_level === "R1" ||
      row.risk_level === "R2" ||
      row.risk_level === "R3" ||
      row.risk_level === "R4"
        ? row.risk_level
        : "R0",
    status: row.status === "FAILED" ? "FAILED" : "SUCCEEDED",
    errorCode: row.error_code,
    valueKeys: Array.isArray(valueKeys)
      ? valueKeys.filter((value): value is string => typeof value === "string")
      : [],
    completedAt: row.completed_at,
  };
}

function normalizeActionAuditQuery(query: ActionAuditQuery): ActionAuditQuery {
  const normalizedText = query.query.trim();
  if (
    !Number.isSafeInteger(query.offset) ||
    query.offset < 0 ||
    query.offset > 1_000_000 ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100 ||
    normalizedText.length > 256 ||
    query.targetId.length > 560 ||
    (query.status !== "ALL" &&
      query.status !== "SUCCEEDED" &&
      query.status !== "FAILED") ||
    (query.riskLevel !== "ALL" &&
      query.riskLevel !== "R0" &&
      query.riskLevel !== "R1" &&
      query.riskLevel !== "R2" &&
      query.riskLevel !== "R3" &&
      query.riskLevel !== "R4")
  ) {
    throw new TypeError("Action audit query is outside the allowed bounds");
  }
  return { ...query, query: normalizedText };
}

function persistedInvocationSnapshotSummarySelect(): string {
  return `SELECT id, target_id, jvm_start_time_epoch_millis,
                 source_snapshot_id, task_id, class_name, sequence, depth,
                 method, captured_at_epoch_millis, duration_nanos,
                 thread_name, outcome, exception_type, replay_eligible,
                 estimated_bytes, saved_at
          FROM persisted_invocation_snapshots`;
}

function persistedInvocationSnapshotSelect(): string {
  return `SELECT id, target_id, jvm_start_time_epoch_millis,
                 source_snapshot_id, task_id, class_name, class_loader,
                 root_method_name, parameter_types, modifiers, sequence,
                 parent_sequence, depth, method, captured_at_epoch_millis,
                 duration_nanos, thread_name, outcome, return_value,
                 exception_type, exception_message, arguments_json,
                 call_stack_json, replay_eligible, estimated_bytes, saved_at
          FROM persisted_invocation_snapshots`;
}

function mapPersistedInvocationSnapshotSummary(
  row: PersistedInvocationSnapshotListRow,
): PersistedInvocationSnapshotSummary {
  if (row.outcome !== "RETURNED" && row.outcome !== "THREW") {
    throw new Error("Stored invocation snapshot outcome is invalid");
  }
  return {
    id: row.id,
    targetId: row.target_id,
    jvmStartTimeEpochMillis: row.jvm_start_time_epoch_millis,
    sourceSnapshotId: row.source_snapshot_id,
    taskId: row.task_id,
    className: row.class_name,
    sequence: row.sequence,
    depth: row.depth,
    method: row.method,
    capturedAtEpochMillis: row.captured_at_epoch_millis,
    durationNanos: row.duration_nanos,
    threadName: row.thread_name,
    outcome: row.outcome,
    exceptionType: row.exception_type,
    replayEligible: row.replay_eligible === 1,
    estimatedBytes: row.estimated_bytes,
    savedAt: row.saved_at,
  };
}

function mapPersistedInvocationSnapshot(
  row: PersistedInvocationSnapshotRow,
): PersistedInvocationSnapshot {
  const summary = mapPersistedInvocationSnapshotSummary(row);
  return {
    ...summary,
    classLoader: row.class_loader,
    rootMethodName: row.root_method_name,
    parameterTypes: row.parameter_types,
    modifiers: row.modifiers,
    parentSequence: row.parent_sequence,
    returnValue: row.return_value,
    exceptionMessage: row.exception_message,
    arguments: parseStoredStringArray(row.arguments_json, 16, 512),
    callStack: parseStoredStringArray(row.call_stack_json, 12, 512),
  };
}

function parseStoredStringArray(
  json: string,
  maximumItems: number,
  maximumItemLength: number,
): readonly string[] {
  const parsed = JSON.parse(json) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length > maximumItems ||
    parsed.some(
      (item) =>
        typeof item !== "string" || item.length > maximumItemLength,
    )
  ) {
    throw new Error("Stored invocation snapshot detail is invalid");
  }
  return parsed;
}

function validatePersistedInvocationSnapshot(
  snapshot: PersistedInvocationSnapshot,
): void {
  const totalCharacters = [
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
  const expectedEstimatedBytes = 512 + totalCharacters * 2;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      snapshot.id,
    ) ||
    snapshot.targetId.length < 1 ||
    snapshot.targetId.length > 560 ||
    !Number.isSafeInteger(snapshot.jvmStartTimeEpochMillis) ||
    snapshot.jvmStartTimeEpochMillis <= 0 ||
    !Number.isSafeInteger(snapshot.sourceSnapshotId) ||
    snapshot.sourceSnapshotId <= 0 ||
    snapshot.taskId.length < 1 ||
    snapshot.taskId.length > 4_096 ||
    snapshot.className.length < 1 ||
    snapshot.className.length > 4_096 ||
    snapshot.classLoader.length > 4_096 ||
    snapshot.rootMethodName.length > 512 ||
    snapshot.parameterTypes.length > 4_096 ||
    snapshot.modifiers.length > 512 ||
    !Number.isSafeInteger(snapshot.sequence) ||
    snapshot.sequence < 0 ||
    !Number.isSafeInteger(snapshot.parentSequence) ||
    snapshot.parentSequence < -1 ||
    !Number.isSafeInteger(snapshot.depth) ||
    snapshot.depth < 0 ||
    snapshot.depth > 1_024 ||
    snapshot.method.length < 1 ||
    snapshot.method.length > 4_096 ||
    !Number.isSafeInteger(snapshot.capturedAtEpochMillis) ||
    snapshot.capturedAtEpochMillis <= 0 ||
    !Number.isSafeInteger(snapshot.durationNanos) ||
    snapshot.durationNanos < 0 ||
    snapshot.threadName.length > 512 ||
    (snapshot.outcome !== "RETURNED" && snapshot.outcome !== "THREW") ||
    snapshot.returnValue.length > 512 ||
    snapshot.exceptionType.length > 512 ||
    snapshot.exceptionMessage.length > 512 ||
    snapshot.arguments.length > 16 ||
    snapshot.arguments.some((value) => value.length > 512) ||
    snapshot.callStack.length > 12 ||
    snapshot.callStack.some((value) => value.length > 512) ||
    snapshot.estimatedBytes !== expectedEstimatedBytes ||
    snapshot.estimatedBytes > 131_072 ||
    !Number.isFinite(Date.parse(snapshot.savedAt))
  ) {
    throw new TypeError("Persisted invocation snapshot is outside the allowed bounds");
  }
}

function normalizePersistedInvocationSnapshotQuery(
  query: PersistedInvocationSnapshotQuery,
): PersistedInvocationSnapshotQuery {
  const normalizedText = query.query.trim();
  if (
    !Number.isSafeInteger(query.offset) ||
    query.offset < 0 ||
    query.offset > 1_000_000 ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 50 ||
    normalizedText.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(normalizedText) ||
    query.targetId.length > 560 ||
    (query.outcome !== "ALL" &&
      query.outcome !== "RETURNED" &&
      query.outcome !== "THREW") ||
    (query.scope !== "ROOT" && query.scope !== "ALL")
  ) {
    throw new TypeError(
      "Persisted invocation snapshot query is outside the allowed bounds",
    );
  }
  return { ...query, query: normalizedText };
}

function escapeLikePattern(value: string): string {
  return value.replaceAll(/([%_\\])/gu, "\\$1");
}

function mapDiagnosticTemplate(row: DiagnosticTemplateRow): DiagnosticTemplate {
  const parameters = JSON.parse(row.parameters_json) as unknown;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    actionId: row.action_id,
    parameters:
      typeof parameters === "object" &&
      parameters !== null &&
      !Array.isArray(parameters)
        ? Object.fromEntries(
            Object.entries(parameters).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          )
        : {},
    riskLevel: row.risk_level === "R1" ? "R1" : "R0",
    source: row.source === "PLUGIN" ? "PLUGIN" : "LOCAL",
    signer: row.signer,
    publicKey: row.public_key_pem,
    publicKeyFingerprint: row.public_key_fingerprint,
    signature: row.signature,
    verified: false,
    createdAt: row.created_at,
  };
}

function mapThreadPoolAlias(
  row: ThreadPoolAliasRow,
): ThreadPoolAliasDescriptor {
  return {
    targetId: row.target_id,
    jvmStartTimeEpochMillis: row.jvm_start_time_epoch_millis,
    poolIdentity: row.pool_identity,
    poolClassName: parseSupportedThreadPoolClass(row.pool_class_name),
    alias: row.alias,
    updatedAt: row.updated_at,
  };
}

function parseSupportedThreadPoolClass(
  value: string,
): SupportedThreadPoolClass {
  switch (value) {
    case "java.util.concurrent.ThreadPoolExecutor":
    case "java.util.concurrent.ScheduledThreadPoolExecutor":
    case "java.util.concurrent.ForkJoinPool":
      return value;
    default:
      throw new Error(`本地数据库包含不支持的线程池类型：${value}`);
  }
}
