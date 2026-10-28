use crate::common::{HostError, HostResult};
use rusqlite::{
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection,
};
use serde_json::{json, Map, Value};
use std::{path::Path, sync::Mutex};

/// One serialized connection preserves the workspace transaction boundary.
/// Callers never hold the connection guard across an await.
pub struct Storage {
    connection: Mutex<Option<Connection>>,
}
fn db_error(error: impl std::fmt::Display) -> HostError {
    HostError::new("WORKSPACE_DATABASE_FAILED", error.to_string())
}
fn sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(v) => SqlValue::Integer(i64::from(*v)),
        Value::Number(v) => v
            .as_i64()
            .map(SqlValue::Integer)
            .unwrap_or_else(|| SqlValue::Real(v.as_f64().unwrap_or(0.0))),
        Value::String(v) => SqlValue::Text(v.clone()),
        _ => SqlValue::Text(value.to_string()),
    }
}
impl Storage {
    pub fn open(path: &Path) -> HostResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(db_error)?;
        }
        let existing = path.is_file();
        let mut connection = Connection::open(path).map_err(db_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error)?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(db_error)?;
        if version > 12 {
            return Err(HostError::new(
                "WORKSPACE_SCHEMA_TOO_NEW",
                "工作区由更新版本创建，已拒绝降级数据库",
            ));
        }
        if existing && version < 12 {
            let backup = format!(
                "{}.{}.pre-v12.backup",
                path.display(),
                chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S%.3fZ")
            );
            // VACUUM INTO takes a consistent snapshot including committed WAL pages.
            connection
                .execute("VACUUM INTO ?", [&backup])
                .map_err(|e| HostError::new("WORKSPACE_BACKUP_FAILED", e.to_string()))?;
        }
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(db_error)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        tx.execute_batch(include_str!("storage/schema.sql"))
            .map_err(db_error)?;
        let columns = {
            let mut stmt = tx
                .prepare("PRAGMA table_info(app_settings)")
                .map_err(db_error)?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(db_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?
        };
        for (name, definition) in [
            ("maximum_risk_level", "TEXT NOT NULL DEFAULT 'R2' CHECK(maximum_risk_level IN ('R2','R3','R4'))"),
            ("system_notification_policy", "TEXT NOT NULL DEFAULT 'CRITICAL_ONLY' CHECK(system_notification_policy IN ('OFF','CRITICAL_ONLY','WARNING_AND_CRITICAL'))"),
            ("font_family", "TEXT NOT NULL DEFAULT 'SYSTEM' CHECK(font_family IN ('SYSTEM','INTER','SOURCE_HAN_SANS','MODERN_CHINESE_SANS','LXGW_WENKAI','JETBRAINS_MONO','SOURCE_HAN_SERIF'))"),
        ] { if !columns.iter().any(|c| c == name) { tx.execute_batch(&format!("ALTER TABLE app_settings ADD COLUMN {name} {definition}")).map_err(db_error)?; } }
        tx.execute_batch("INSERT OR IGNORE INTO app_settings (id,locale,font_family,sampling_interval_millis,artifact_quota_bytes,retention_days,update_policy,maximum_risk_level,system_notification_policy) VALUES (1,'zh-CN','SYSTEM',2000,2147483648,0,'NOTIFY','R2','CRITICAL_ONLY'); PRAGMA user_version = 12;").map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(Self {
            connection: Mutex::new(Some(connection)),
        })
    }
    pub fn query(&self, sql: &str, args: &[Value]) -> HostResult<Vec<Value>> {
        let guard = self.connection.lock().map_err(db_error)?;
        let connection = guard
            .as_ref()
            .ok_or_else(|| HostError::new("WORKSPACE_CLOSED", "工作区已关闭"))?;
        let mut stmt = connection.prepare(sql).map_err(db_error)?;
        let columns = stmt
            .column_names()
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>();
        let mut cursor = stmt
            .query(params_from_iter(args.iter().map(sql_value)))
            .map_err(db_error)?;
        let mut result = Vec::new();
        while let Some(row) = cursor.next().map_err(db_error)? {
            let mut object = Map::new();
            for (i, name) in columns.iter().enumerate() {
                let value = match row.get_ref(i).map_err(db_error)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(v) => json!(std::str::from_utf8(v).map_err(db_error)?),
                    ValueRef::Blob(_) => {
                        return Err(HostError::new(
                            "WORKSPACE_TYPE_INVALID",
                            "工作区记录含非预期二进制值",
                        ))
                    }
                };
                object.insert(name.clone(), value);
            }
            result.push(Value::Object(object));
        }
        Ok(result)
    }
    pub fn execute(&self, sql: &str, args: &[Value]) -> HostResult<usize> {
        let guard = self.connection.lock().map_err(db_error)?;
        guard
            .as_ref()
            .ok_or_else(|| HostError::new("WORKSPACE_CLOSED", "工作区已关闭"))?
            .execute(sql, params_from_iter(args.iter().map(sql_value)))
            .map_err(db_error)
    }
    pub fn reopen(&self, path: &Path) -> HostResult<()> {
        let mut guard = self.connection.lock().map_err(db_error)?;
        if guard.is_some() {
            return Ok(());
        }
        let reopened = Self::open(path)?;
        let mut new_connection = reopened.connection.lock().map_err(db_error)?;
        *guard = new_connection.take();
        Ok(())
    }
    pub fn close(&self) -> HostResult<()> {
        let mut guard = self.connection.lock().map_err(db_error)?;
        let Some(connection) = guard.as_ref() else {
            return Ok(());
        };
        let busy: i64 = connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .map_err(db_error)?;
        if busy != 0 {
            return Err(HostError::new(
                "WORKSPACE_CHECKPOINT_BUSY",
                "工作区仍被其他进程占用，检查点未完成",
            ));
        }
        if let Some(connection) = guard.take() {
            if let Err((connection, error)) = connection.close() {
                *guard = Some(connection);
                return Err(db_error(error));
            }
        }
        Ok(())
    }
    pub fn transaction(&self, commands: &[(String, Vec<Value>)]) -> HostResult<()> {
        let mut guard = self.connection.lock().map_err(db_error)?;
        let connection = guard
            .as_mut()
            .ok_or_else(|| HostError::new("WORKSPACE_CLOSED", "工作区已关闭"))?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        for (sql, args) in commands {
            tx.execute(sql, params_from_iter(args.iter().map(sql_value)))
                .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    }
    pub fn records(&self, sql: &str, args: &[Value]) -> HostResult<Value> {
        Ok(Value::Array(
            self.query(sql, args)?
                .into_iter()
                .map(map_record)
                .collect::<HostResult<_>>()?,
        ))
    }
    pub fn one(&self, sql: &str, args: &[Value]) -> HostResult<Value> {
        self.query(sql, args)?
            .into_iter()
            .next()
            .map(map_record)
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
    }
    pub fn settings(&self) -> HostResult<Value> {
        self.one("SELECT locale,font_family,sampling_interval_millis AS default_sampling_interval_millis,artifact_quota_bytes,retention_days,update_policy,maximum_risk_level,system_notification_policy FROM app_settings WHERE id=1", &[])
    }
    pub fn insert_action_audit(&self, result: &Value) -> HostResult<()> {
        let keys = result["values"]
            .as_object()
            .map(|m| m.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        self.transaction(&[
            ("INSERT INTO action_audit (task_id,target_id,action_id,risk_level,status,error_code,value_keys_json,completed_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET target_id=excluded.target_id,action_id=excluded.action_id,risk_level=excluded.risk_level,status=excluded.status,error_code=excluded.error_code,value_keys_json=excluded.value_keys_json,completed_at=excluded.completed_at".into(),vec![result["taskId"].clone(),result["targetId"].clone(),result["actionId"].clone(),result["riskLevel"].clone(),result["status"].clone(),result["errorCode"].clone(),json!(keys).to_string().into(),result["completedAt"].clone()]),
            ("DELETE FROM action_audit WHERE task_id IN (SELECT audit.task_id FROM action_audit audit LEFT JOIN case_actions pinned ON pinned.task_id=audit.task_id WHERE pinned.task_id IS NULL ORDER BY audit.completed_at DESC,audit.task_id DESC LIMIT -1 OFFSET 10000)".into(),vec![]),
        ])
    }
}

pub fn map_record(row: Value) -> HostResult<Value> {
    let mut result = Map::new();
    let object = row
        .as_object()
        .ok_or_else(|| HostError::new("WORKSPACE_RECORD_INVALID", "工作区记录无效"))?;
    for (key, value) in object {
        if key == "absolute_path" {
            continue;
        }
        let (key, value) = if let Some(key) = key.strip_suffix("_json") {
            let parsed: Value = serde_json::from_str(value.as_str().ok_or_else(|| {
                HostError::new("WORKSPACE_RECORD_INVALID", "工作区 JSON 字段无效")
            })?)
            .map_err(db_error)?;
            (key, parsed)
        } else {
            (key.as_str(), value.clone())
        };
        let value = if key == "replay_eligible" {
            json!(value.as_i64() == Some(1))
        } else {
            value
        };
        let mut name = String::new();
        let mut upper = false;
        for ch in key.chars() {
            if ch == '_' {
                upper = true;
            } else if upper {
                name.extend(ch.to_uppercase());
                upper = false;
            } else {
                name.push(ch);
            }
        }
        result.insert(name, value);
    }
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> (std::path::PathBuf, Storage) {
        let path = std::env::temp_dir().join(format!("tanwei-store-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        let db = Storage::open(&path.join("tanwei.sqlite")).unwrap();
        (path, db)
    }
    #[test]
    fn persists_cases_settings_and_rollback() {
        let (root, store) = database();
        let at = "2026-09-12T00:00:00Z";
        store
            .execute(
                "INSERT INTO diagnostic_cases VALUES (?,?,?,?,'OPEN',?,?)",
                &[
                    "case".into(),
                    "案例".into(),
                    "备注".into(),
                    "[\"性能\"]".into(),
                    at.into(),
                    at.into(),
                ],
            )
            .unwrap();
        assert_eq!(
            store.one("SELECT * FROM diagnostic_cases", &[]).unwrap()["tags"],
            json!(["性能"])
        );
        assert!(store
            .transaction(&[
                (
                    "DELETE FROM diagnostic_cases WHERE id=?".into(),
                    vec!["case".into()]
                ),
                (
                    "INSERT INTO case_artifacts VALUES (?,?)".into(),
                    vec!["missing".into(), "missing".into()]
                )
            ])
            .is_err());
        assert_eq!(
            store
                .query("SELECT * FROM diagnostic_cases", &[])
                .unwrap()
                .len(),
            1
        );
        drop(store);
        let reopened = Storage::open(&root.join("tanwei.sqlite")).unwrap();
        assert_eq!(
            reopened.settings().unwrap()["defaultSamplingIntervalMillis"],
            2000
        );
        assert_eq!(
            reopened
                .query("SELECT * FROM diagnostic_cases", &[])
                .unwrap()
                .len(),
            1
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn schema_rejects_invalid_settings() {
        let (root, store) = database();
        for sql in [
            "UPDATE app_settings SET artifact_quota_bytes=0",
            "UPDATE app_settings SET retention_days=-1",
            "UPDATE app_settings SET maximum_risk_level='R0'",
            "UPDATE app_settings SET system_notification_policy='ALL'",
        ] {
            assert!(store.execute(sql, &[]).is_err());
        }
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn explicit_close_checkpoints_and_reopen_preserves_shared_store() {
        let (root, store) = database();
        store
            .execute("UPDATE app_settings SET locale='en-US'", &[])
            .unwrap();
        store.close().unwrap();
        store.close().unwrap();
        assert_eq!(store.settings().unwrap_err().code, "WORKSPACE_CLOSED");
        store.reopen(&root.join("tanwei.sqlite")).unwrap();
        assert_eq!(store.settings().unwrap()["locale"], "en-US");
        store.close().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn upgrades_existing_schema_and_creates_consistent_backup() {
        let root = std::env::temp_dir().join(format!("tanwei-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("tanwei.sqlite");
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch("CREATE TABLE app_settings (id INTEGER PRIMARY KEY,locale TEXT NOT NULL,sampling_interval_millis INTEGER NOT NULL,artifact_quota_bytes INTEGER NOT NULL,retention_days INTEGER NOT NULL,update_policy TEXT NOT NULL); INSERT INTO app_settings VALUES (1,'en-US',5000,2147483648,30,'MANUAL'); PRAGMA user_version=5;").unwrap();
        }
        let store = Storage::open(&path).unwrap();
        assert_eq!(store.settings().unwrap()["locale"], "en-US");
        assert_eq!(store.settings().unwrap()["fontFamily"], "SYSTEM");
        assert!(std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().ends_with(".pre-v12.backup")));
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
