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
