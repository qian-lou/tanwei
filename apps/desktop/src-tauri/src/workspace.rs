use crate::{
    artifacts,
    common::{HostError, HostResult, RuntimePaths},
    storage::Storage,
    targets::TargetManager,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
mod compilation;
mod snapshots;
mod validation;

pub struct Workspace {
    pub(crate) paths: Arc<RuntimePaths>,
    pub(crate) targets: Arc<TargetManager>,
    pub(crate) store: Arc<Storage>,
    root: PathBuf,
    writes: tokio::sync::Mutex<()>,
    closing: std::sync::atomic::AtomicBool,
}
pub(crate) fn err(code: &str, message: impl std::fmt::Display) -> HostError {
    HostError::new(code, message.to_string())
}
pub(crate) fn text<'a>(value: &'a Value, key: &str) -> HostResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| err("INVALID_INPUT", format!("缺少文本字段 {key}")))
}
pub(crate) fn string(value: &Value) -> HostResult<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| err("INVALID_INPUT", "参数必须为非空字符串"))
}
pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(crate) fn millis(value: &Value) -> HostResult<i64> {
    chrono::DateTime::parse_from_rfc3339(string(value)?)
        .map(|d| d.timestamp_millis())
        .map_err(|e| err("TIME_INVALID", e))
}
pub(crate) fn confirmed(value: &Value) -> HostResult<()> {
    if value.as_bool() == Some(true) {
        Ok(())
    } else {
        Err(err("CONFIRMATION_REQUIRED", "此操作需要明确确认"))
    }
}
fn required(value: Value, code: &str) -> HostResult<Value> {
    if value.is_null() {
        Err(err(code, "记录不存在"))
    } else {
        Ok(value)
    }
}
impl Workspace {
    pub fn open(paths: Arc<RuntimePaths>, targets: Arc<TargetManager>) -> HostResult<Self> {
        let root = paths.user_data.join("artifacts");
        std::fs::create_dir_all(&root).map_err(|e| err("WORKSPACE_OPEN_FAILED", e))?;
        let store = Arc::new(Storage::open(&paths.user_data.join("tanwei.sqlite"))?);
        targets.set_store(store.clone())?;
        let result = Self {
            paths,
            targets,
            store,
            root,
            writes: tokio::sync::Mutex::new(()),
            closing: std::sync::atomic::AtomicBool::new(false),
        };
        result.cleanup()?;
        Ok(result)
    }
    pub fn begin_shutdown(&self) {
        self.closing
            .store(true, std::sync::atomic::Ordering::Release);
    }
    pub async fn close(&self) -> HostResult<()> {
        self.begin_shutdown();
        let _guard = self.writes.lock().await;
        self.store.close()
    }
    pub async fn resume_after_failed_update(&self) -> HostResult<()> {
        let _guard = self.writes.lock().await;
        self.store
            .reopen(&self.paths.user_data.join("tanwei.sqlite"))?;
        self.closing
            .store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    }
    fn ensure_open(&self) -> HostResult<()> {
        if self.closing.load(std::sync::atomic::Ordering::Acquire) {
            Err(err("WORKSPACE_CLOSED", "工作区正在关闭"))
        } else {
            Ok(())
        }
    }
    pub fn store(&self) -> Arc<Storage> {
        self.store.clone()
    }
    pub async fn dispatch(&self, method: &str, args: &[Value]) -> Option<HostResult<Value>> {
        if let Err(error) = self.ensure_open() {
            return Some(Err(error));
        }
        if let Err(error) = validation::validate(method, args) {
            return Some(Err(error));
        }
        let a = args.first().unwrap_or(&Value::Null);
        let b = args.get(1).unwrap_or(&Value::Null);
        let result = match method {
            "getSettings" => self.store.settings(),
            "updateSettings" => {
                let _guard = self.writes.lock().await;
                self.ensure_open().and_then(|_| self.update_settings(a))
            }
            "listCases" => self.store.records(
                "SELECT * FROM diagnostic_cases ORDER BY updated_at DESC",
                &[],
            ),
            "createCase" => self.create_case(a),
            "archiveCase" => (|| {
                self.store.execute(
                    "UPDATE diagnostic_cases SET status='ARCHIVED',updated_at=? WHERE id=?",
                    &[now().into(), a.clone()],
                )?;
                self.case(string(a)?)
            })(),
            "deleteCase" => (|| {
                confirmed(b)?;
                self.case(string(a)?)?;
                self.store
                    .execute("DELETE FROM diagnostic_cases WHERE id=?", &[a.clone()])?;
                Ok(Value::Null)
            })(),
            "getCaseEvidence" => self.evidence(a),
            "updateCaseEvidence" => self.update_evidence(a),
            "listArtifacts" => self
                .store
                .records("SELECT * FROM artifacts ORDER BY created_at DESC", &[]),
            "listActionAudits" => self.store.records(
                "SELECT * FROM action_audit ORDER BY completed_at DESC LIMIT 100",
                &[],
            ),
            "queryActionAudits" => self.query_audits(a),
            "saveInvocationSnapshot" => self.save_invocation_snapshot(a).await,
            "queryPersistedInvocationSnapshots" => self.query_snapshots(a),
            "getPersistedInvocationSnapshot" => self
                .store
                .one(
                    "SELECT * FROM persisted_invocation_snapshots WHERE id=?",
                    &[a.clone()],
                )
                .and_then(|v| required(v, "INVOCATION_SNAPSHOT_NOT_FOUND")),
            "deletePersistedInvocationSnapshot" => (|| {
                confirmed(b)?;
                if self.store.execute(
                    "DELETE FROM persisted_invocation_snapshots WHERE id=?",
                    &[a.clone()],
                )? == 0
                {
                    return Err(err("INVOCATION_SNAPSHOT_NOT_FOUND", "调用档案不存在"));
                }
                Ok(Value::Null)
            })(),
            "listDiagnosticAlerts" => self.store.records(
                "SELECT * FROM diagnostic_alerts ORDER BY created_at DESC,id DESC LIMIT 200",
                &[],
            ),
            "acknowledgeDiagnosticAlert" => (|| {
                self.store.execute("UPDATE diagnostic_alerts SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?",&[now().into(),a.clone()])?;
                self.store
                    .one("SELECT * FROM diagnostic_alerts WHERE id=?", &[a.clone()])
            })(),
            "acknowledgeAllDiagnosticAlerts" => self
                .store
                .execute(
                    "UPDATE diagnostic_alerts SET acknowledged_at=? WHERE acknowledged_at IS NULL",
                    &[now().into()],
                )
                .map(|n| json!(n)),
            "listThreadPoolAliases"
            | "upsertThreadPoolAlias"
            | "deleteThreadPoolAlias"
            | "listClassChangeSetDrafts"
            | "replaceClassChangeSetDrafts" => self.identity_records(method, a).await,
            "previewCaseExport" => self.case_export_preview(a),
            "exportCase" => self.export_case(a, b).await,
            "importCase" => {
                if a.is_null() {
                    Ok(Value::Null)
                } else {
                    self.import_case(a)
                }
            }
            "generateSupportBundle" => self.support_bundle(a).await,
            "createSnapshotArtifact" => self.create_snapshot(a).await,
            "createHeapHistogramArtifact"
            | "createThreadPoolTrendArtifact"
            | "createJitTrendArtifact"
            | "createTraceHotspotArtifact"
            | "createMonitorWindowsArtifact" => self.create_recording(method, a).await,
            "collectAgentArtifact" => self.collect_artifact(a).await,
            "deleteArtifact" => self.delete_artifact(a, b).await,
            "verifyArtifact" => self.verify_artifact(a),
            "inspectHeapHistogramArtifact"
            | "inspectThreadPoolTrendArtifact"
            | "inspectJitTrendArtifact"
            | "inspectObservationExportArtifact"
            | "inspectThreadDumpArtifact"
            | "inspectJfrArtifact" => self.inspect(method, a).await,
            "compareHeapHistogramArtifacts"
            | "compareThreadPoolTrendArtifacts"
            | "compareJitTrendArtifacts"
            | "compareThreadDumpArtifacts" => self.compare_artifacts(method, a).await,
            "listJitRegressionBaselines" => self.jit_baselines().await,
            "decompileClassArtifact" => self.decompile_class(a).await,
            "compileClassSource" => self.compile_class(a).await,
            "compileClassChangeSet" => self.compile_change_set(a).await,
            _ => return None,
        };
        Some(result)
    }
    fn update_settings(&self, a: &Value) -> HostResult<Value> {
        self.store.execute("UPDATE app_settings SET locale=?,font_family=?,sampling_interval_millis=?,artifact_quota_bytes=?,retention_days=?,update_policy=?,maximum_risk_level=?,system_notification_policy=? WHERE id=1",&[a["locale"].clone(),a["fontFamily"].clone(),a["defaultSamplingIntervalMillis"].clone(),a["artifactQuotaBytes"].clone(),a["retentionDays"].clone(),a["updatePolicy"].clone(),a["maximumRiskLevel"].clone(),a["systemNotificationPolicy"].clone()])?;
        self.store.settings()
    }
    fn create_case(&self, a: &Value) -> HostResult<Value> {
        let title = text(a, "title")?.trim();
        let notes = text(a, "notes")?.trim();
        let tags = a["tags"]
            .as_array()
            .ok_or_else(|| err("CASE_INPUT_INVALID", "标签必须为数组"))?;
        if title.trim().is_empty()
            || title.encode_utf16().count() > 200
            || notes.encode_utf16().count() > 20000
            || tags.len() > 20
            || tags.iter().any(|v| {
                v.as_str()
                    .is_none_or(|s| s.trim().is_empty() || s.trim().encode_utf16().count() > 40)
            })
        {
            return Err(err("CASE_INPUT_INVALID", "案例标题、备注或标签超过边界"));
        }
        let mut seen_tags = HashSet::new();
        let normalized_tags = tags
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|tag| seen_tags.insert(*tag))
            .collect::<Vec<_>>();
        let id = uuid::Uuid::new_v4().to_string();
        let at = now();
        self.store.execute("INSERT INTO diagnostic_cases (id,title,notes,tags_json,status,created_at,updated_at) VALUES (?,?,?,?,'OPEN',?,?)",&[id.clone().into(),title.into(),notes.into(),json!(normalized_tags).to_string().into(),at.clone().into(),at.into()])?;
        self.case(&id)
    }
    fn case(&self, id: &str) -> HostResult<Value> {
        required(
            self.store
                .one("SELECT * FROM diagnostic_cases WHERE id=?", &[id.into()])?,
            "CASE_NOT_FOUND",
        )
    }
    fn evidence(&self, id: &Value) -> HostResult<Value> {
        self.case(string(id)?)?;
        let artifacts=self.store.records("SELECT a.* FROM artifacts a INNER JOIN case_artifacts ca ON ca.artifact_id=a.id WHERE ca.case_id=? ORDER BY a.created_at",&[id.clone()])?;
        let actions=self.store.records("SELECT a.* FROM action_audit a INNER JOIN case_actions ca ON ca.task_id=a.task_id WHERE ca.case_id=? ORDER BY a.completed_at",&[id.clone()])?;
        Ok(json!({"caseId":id,"artifacts":artifacts,"actions":actions}))
    }
    fn update_evidence(&self, a: &Value) -> HostResult<Value> {
        let id = a["caseId"].clone();
        self.case(string(&id)?)?;
        let mut commands = vec![
            (
                "DELETE FROM case_artifacts WHERE case_id=?".into(),
                vec![id.clone()],
            ),
            (
                "DELETE FROM case_actions WHERE case_id=?".into(),
                vec![id.clone()],
            ),
        ];
        for (key,sql) in [("artifactIds","INSERT INTO case_artifacts (case_id,artifact_id) SELECT ?,id FROM artifacts WHERE id=?"),("actionTaskIds","INSERT INTO case_actions (case_id,task_id) SELECT ?,task_id FROM action_audit WHERE task_id=?")] {
            let list=a[key].as_array().filter(|v|v.len()<=10000).ok_or_else(||err("CASE_EVIDENCE_INVALID","证据列表无效"))?;let mut seen=HashSet::new();
            for value in list {let item=string(value)?;if seen.insert(item){commands.push((sql.into(),vec![id.clone(),value.clone()]));}}
        }
        commands.push((
            "UPDATE diagnostic_cases SET updated_at=? WHERE id=?".into(),
            vec![now().into(), id.clone()],
        ));
        self.store.transaction(&commands)?;
        self.evidence(&id)
    }
    fn query_audits(&self, a: &Value) -> HostResult<Value> {
        self.query_records(a, false)
    }
    pub(crate) fn query_records(&self, a: &Value, snapshots: bool) -> HostResult<Value> {
        let limit = a["limit"]
            .as_i64()
            .filter(|n| *n >= 1 && *n <= 100)
            .ok_or_else(|| err("QUERY_INVALID", "分页大小无效"))?;
        let offset = a["offset"]
            .as_i64()
            .filter(|n| *n >= 0 && *n <= 1_000_000)
            .ok_or_else(|| err("QUERY_INVALID", "分页偏移无效"))?;
        let query = text(a, "query")?.trim();
        if query.encode_utf16().count() > 256 {
            return Err(err("QUERY_INVALID", "查询长度超过256字符"));
        }
        let mut clauses = Vec::new();
        let mut args = Vec::new();
        if !query.is_empty() {
            let pattern = format!(
                "%{}%",
                query
                    .to_lowercase()
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            );
            let fields = if snapshots {
                vec![
                    "class_name",
                    "method",
                    "thread_name",
                    "task_id",
                    "exception_type",
                    "exception_message",
                    "return_value",
                    "arguments_json",
                ]
            } else {
                vec![
                    "action_id",
                    "task_id",
                    "target_id",
                    "COALESCE(error_code,'')",
                ]
            };
            let inner = fields
                .iter()
                .map(|f| {
                    args.push(json!(pattern));
                    format!("lower({f}) LIKE ? ESCAPE '\\'")
                })
                .collect::<Vec<_>>()
                .join(" OR ");
            clauses.push(format!("({inner})"));
        }
        if let Some(id) = a["targetId"].as_str().filter(|s| !s.is_empty()) {
            clauses.push("target_id=?".into());
            args.push(id.into());
        }
        let filters = if snapshots {
            vec![("outcome", "outcome", vec!["ALL", "RETURNED", "THREW"])]
        } else {
            vec![
                ("status", "status", vec!["ALL", "SUCCEEDED", "FAILED"]),
                (
                    "riskLevel",
                    "risk_level",
                    vec!["ALL", "R0", "R1", "R2", "R3", "R4"],
                ),
            ]
        };
        for (key, column, choices) in filters {
            let value = text(a, key)?;
            if !choices.contains(&value) {
                return Err(err("QUERY_INVALID", "查询条件无效"));
            }
            if value != "ALL" {
                clauses.push(format!("{column}=?"));
                args.push(value.into());
            }
        }
        if snapshots {
            match text(a, "scope")? {
                "ROOT" => clauses.push("depth=0".into()),
                "ALL" => (),
                _ => return Err(err("QUERY_INVALID", "调用档案范围无效")),
            }
        }
        let table = if snapshots {
            "persisted_invocation_snapshots"
        } else {
            "action_audit"
        };
        let condition = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let aggregates = if snapshots {
            "COALESCE(SUM(outcome='RETURNED'),0) AS returned,COALESCE(SUM(outcome='THREW'),0) AS threw,COALESCE(SUM(depth=0),0) AS root,COALESCE(SUM(depth>0),0) AS internal"
        } else {
            "COALESCE(SUM(status='SUCCEEDED'),0) AS succeeded,COALESCE(SUM(status='FAILED'),0) AS failed"
        };
        let mut summary = self.store.one(
            &format!("SELECT COUNT(*) AS total,{aggregates} FROM {table} {condition}"),
            &args,
        )?;
        let retained = self.store.one(
            &format!(
                "SELECT COUNT(*) AS total{} FROM {table}",
                if snapshots {
                    ",COALESCE(SUM(estimated_bytes),0) AS estimated_bytes"
                } else {
                    ""
                }
            ),
            &[],
        )?;
        let ordering = if snapshots {
            "captured_at_epoch_millis DESC,id DESC"
        } else {
            "completed_at DESC,task_id DESC"
        };
        args.extend([limit.into(), offset.into()]);
        let fields = if snapshots {
            "id,target_id,jvm_start_time_epoch_millis,source_snapshot_id,task_id,class_name,sequence,depth,method,captured_at_epoch_millis,duration_nanos,thread_name,outcome,exception_type,replay_eligible,estimated_bytes,saved_at"
        } else {
            "*"
        };
        summary["items"] = self.store.records(
            &format!(
                "SELECT {fields} FROM {table} {condition} ORDER BY {ordering} LIMIT ? OFFSET ?"
            ),
            &args,
        )?;
        summary["retained"] = retained["total"].clone();
        summary["limit"] = limit.into();
        summary["offset"] = offset.into();
        if snapshots {
            summary["estimatedBytes"] = retained["estimatedBytes"].clone();
        }
        Ok(summary)
    }
    async fn identity_records(&self, method: &str, a: &Value) -> HostResult<Value> {
        let target = if a.is_string() {
            string(a)?
        } else {
            text(a, "targetId")?
        };
        let snapshot = self.targets.snapshot(target).await?;
        let jvm = snapshot["jvmStartTimeEpochMillis"]
            .as_i64()
            .filter(|n| *n > 0)
            .ok_or_else(|| err("JVM_IDENTITY_INVALID", "目标 JVM 启动时间无效"))?;
        let identity = vec![target.into(), jvm.into()];
        match method {
            "listThreadPoolAliases"=>self.store.records("SELECT * FROM thread_pool_aliases WHERE target_id=? AND jvm_start_time_epoch_millis=? ORDER BY updated_at DESC",&identity),
            "upsertThreadPoolAlias"=>{let alias=text(a,"alias")?.trim();if alias.is_empty()||alias.encode_utf16().count()>64||alias.chars().any(|c|c<='\u{1f}'||c=='\u{7f}'){return Err(err("THREAD_POOL_ALIAS_INVALID","线程池别名无效"));}let at=now();self.store.execute("INSERT INTO thread_pool_aliases (target_id,jvm_start_time_epoch_millis,pool_identity,pool_class_name,alias,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(target_id,jvm_start_time_epoch_millis,pool_identity) DO UPDATE SET pool_class_name=excluded.pool_class_name,alias=excluded.alias,updated_at=excluded.updated_at",&[target.into(),jvm.into(),a["poolIdentity"].clone(),a["poolClassName"].clone(),alias.into(),at.into()])?;self.store.one("SELECT * FROM thread_pool_aliases WHERE target_id=? AND jvm_start_time_epoch_millis=? AND pool_identity=?",&[target.into(),jvm.into(),a["poolIdentity"].clone()])},
            "deleteThreadPoolAlias"=>{self.store.execute("DELETE FROM thread_pool_aliases WHERE target_id=? AND jvm_start_time_epoch_millis=? AND pool_identity=?",&[target.into(),jvm.into(),a["poolIdentity"].clone()])?;Ok(Value::Null)},
            _=>{let mut commands=vec![("DELETE FROM class_change_set_drafts WHERE target_id=? AND jvm_start_time_epoch_millis<>?".into(),identity.clone())];if method=="replaceClassChangeSetDrafts"{let items=a["items"].as_array().filter(|v|v.len()<=8).ok_or_else(||err("CLASS_CHANGE_SET_DRAFT_SIZE_INVALID","类变更集最多包含8个精确类"))?;commands.push(("DELETE FROM class_change_set_drafts WHERE target_id=? AND jvm_start_time_epoch_millis=?".into(),identity.clone()));let mut bytes=0;let mut seen=HashSet::new();let mut loader=None;for (index,item) in items.iter().enumerate(){let name=text(item,"className")?;let cl=text(item,"classLoader")?;let source=text(item,"source")?;bytes+=source.len();if name.is_empty()||name.len()>1024||cl.is_empty()||cl.encode_utf16().count()>4096||source.is_empty()||source.len()>1024*1024||bytes>2*1024*1024||!seen.insert(name)||loader.is_some_and(|l|l!=cl){return Err(err("CLASS_CHANGE_SET_DRAFT_INVALID","类变更集身份或源代码边界无效"));}loader=Some(cl);commands.push(("INSERT INTO class_change_set_drafts (target_id,jvm_start_time_epoch_millis,ordinal,class_name,class_loader,source,updated_at) VALUES (?,?,?,?,?,?,?)".into(),vec![target.into(),jvm.into(),index.into(),name.into(),cl.into(),source.into(),now().into()]));}}
            self.store.transaction(&commands)?;self.store.records("SELECT class_name,class_loader,source FROM class_change_set_drafts WHERE target_id=? AND jvm_start_time_epoch_millis=? ORDER BY ordinal",&identity)}
        }
    }
    fn case_manifest(&self, case: &Value, evidence: &Value, notes: &str) -> Value {
        json!({"schemaVersion":1,"product":"tanwei","productVersion":self.paths.version,"exportedAt":now(),"case":{"title":case["title"],"notes":notes,"tags":case["tags"],"status":case["status"],"createdAt":case["createdAt"],"updatedAt":case["updatedAt"]},"evidence":{"artifacts":evidence["artifacts"],"actions":evidence["actions"]}})
    }
    fn case_export_preview(&self, id: &Value) -> HostResult<Value> {
        let case = self.case(string(id)?)?;
        let evidence = self.evidence(id)?;
        let (notes, count) = redact(text(&case, "notes")?);
        let manifest = self.case_manifest(&case, &evidence, &notes);
        Ok(
            json!({"diagnosticCase":case,"evidence":evidence,"redactedNotes":notes,"redactionCount":count,"manifestBytes":manifest.to_string().len(),"productVersion":self.paths.version,"schemaVersion":1}),
        )
    }
    async fn export_case(&self, id: &Value, confirmation: &Value) -> HostResult<Value> {
        confirmed(confirmation)?;
        let case = self.case(string(id)?)?;
        let evidence = self.evidence(id)?;
        let (notes, _) = redact(text(&case, "notes")?);
        self.write_json(
            "case",
            "CASE_EXPORT",
            &self.case_manifest(&case, &evidence, &notes),
            &now(),
        )
        .await
    }
    fn import_case(&self, path: &Value) -> HostResult<Value> {
        let content = read_bounded(Path::new(string(path)?), 10 * 1024 * 1024)?;
        let value: Value =
            serde_json::from_slice(&content).map_err(|e| err("CASE_IMPORT_FAILED", e))?;
        if value["product"] != "tanwei" || value["schemaVersion"] != 1 {
            return Err(err("CASE_IMPORT_FAILED", "案例文件格式不受支持"));
        }
        let source = &value["case"];
        let mut tags = source["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .take(19)
            .map(str::to_string)
            .collect::<Vec<_>>();
        if !tags.iter().any(|tag| tag == "imported") {
            tags.push("imported".into());
        }
        let case = json!({"title":source["title"].as_str().unwrap_or("").trim(),"notes":source["notes"].as_str().unwrap_or("").trim(),"tags":tags});
        self.create_case(&case)
    }
    async fn support_bundle(&self, runtime: &Value) -> HostResult<Value> {
        let at = now();
        let counts=self.store.one("SELECT (SELECT COUNT(*) FROM artifacts) AS artifact_count,(SELECT COUNT(*) FROM diagnostic_cases) AS case_count",&[])?;
        self.write_json("support","SUPPORT_BUNDLE",&json!({"schemaVersion":1,"product":"tanwei","generatedAt":at,"runtime":runtime,"settings":self.store.settings()?,"storage":counts,"design":{"source":"apps/desktop/components.json","preset":"shadcn/ui New York neutral dark","version":"1.0.0"},"privacy":"No paths, credentials, session secrets, environment values, system property values or live object values are included."}),&at).await
    }
    async fn create_snapshot(&self, target: &Value) -> HostResult<Value> {
        let target = string(target)?;
        let snapshot = self.targets.snapshot(target).await?;
        let at = now();
        self.write_json(target,"SNAPSHOT",&json!({"schemaVersion":1,"product":"tanwei","targetId":target,"capturedAt":at,"snapshot":snapshot}),&at).await
    }
    pub(crate) fn artifact(&self, id: &str) -> HostResult<Value> {
        required(
            self.store
                .one("SELECT * FROM artifacts WHERE id=?", &[id.into()])?,
            "ARTIFACT_NOT_FOUND",
        )
    }
    pub fn artifact_path(&self, id: &str) -> HostResult<PathBuf> {
        let record = self
            .store
            .query(
                "SELECT absolute_path FROM artifacts WHERE id=?",
                &[id.into()],
            )?
            .into_iter()
            .next()
            .ok_or_else(|| err("ARTIFACT_NOT_FOUND", "制品不存在"))?;
        let path = PathBuf::from(text(&record, "absolute_path")?);
        let canonical_root = self
            .root
            .canonicalize()
            .map_err(|e| err("UNSAFE_ARTIFACT_PATH", e))?;
        let canonical = path
            .canonicalize()
            .map_err(|e| err("ARTIFACT_NOT_FOUND", e))?;
        if canonical == canonical_root || !canonical.starts_with(canonical_root) {
            return Err(err("UNSAFE_ARTIFACT_PATH", "制品路径超出受控目录"));
        }
        Ok(canonical)
    }
    fn verify_artifact(&self, id: &Value) -> HostResult<Value> {
        let id = string(id)?;
        let artifact = self.artifact(id)?;
        let path = self.artifact_path(id)?;
        let file = std::fs::File::open(&path).map_err(|e| err("ARTIFACT_VERIFY_FAILED", e))?;
        let metadata = file
            .metadata()
            .map_err(|e| err("ARTIFACT_VERIFY_FAILED", e))?;
        if !metadata.is_file() || Some(metadata.len()) != artifact["size"].as_u64() {
            return Err(err("ARTIFACT_SIZE_MISMATCH", "制品大小与登记信息不一致"));
        }
        let mut hash = Sha256::new();
        let mut reader = std::io::BufReader::new(file);
        let mut buffer = [0u8; 65536];
        let mut size = 0u64;
        loop {
            let n = reader
                .read(&mut buffer)
                .map_err(|e| err("ARTIFACT_VERIFY_FAILED", e))?;
            if n == 0 {
                break;
            }
            size = size
                .checked_add(n as u64)
                .filter(|s| *s <= metadata.len())
                .ok_or_else(|| err("ARTIFACT_SIZE_MISMATCH", "制品在校验过程中发生变化"))?;
            hash.update(&buffer[..n]);
        }
        if size != metadata.len() {
            return Err(err("ARTIFACT_SIZE_MISMATCH", "制品在校验过程中发生变化"));
        }
        if format!("{:x}", hash.finalize()) != text(&artifact, "sha256")? {
            return Err(err("ARTIFACT_HASH_MISMATCH", "制品 SHA-256 校验失败"));
        }
        Ok(artifact)
    }
    pub fn verified_artifact_bytes(&self, id: &str, max: usize) -> HostResult<Vec<u8>> {
        let artifact = self.artifact(id)?;
        let path = self.artifact_path(id)?;
        let content = read_bounded(&path, max)?;
        if Some(content.len() as u64) != artifact["size"].as_u64() {
            return Err(err("ARTIFACT_SIZE_MISMATCH", "制品大小与登记信息不一致"));
        }
        if format!("{:x}", Sha256::digest(&content)) != text(&artifact, "sha256")? {
            return Err(err("ARTIFACT_HASH_MISMATCH", "制品 SHA-256 校验失败"));
        }
        Ok(content)
    }
    pub fn profile_report_document(&self, id: &str) -> HostResult<(Value, Vec<u8>)> {
        let artifact = self.artifact(id)?;
        let path = self.artifact_path(id)?;
        if artifact["type"] != "PROFILE"
            || artifact["status"] != "READY"
            || path
                .extension()
                .and_then(|v| v.to_str())
                .is_none_or(|ext| !ext.eq_ignore_ascii_case("html"))
        {
            return Err(err("UNSUPPORTED_PROFILE_REPORT", "性能报告类型或状态无效"));
        }
        let bytes = self.verified_artifact_bytes(id, 64 * 1024 * 1024)?;
        Ok((json!({"absolutePath":path,"name":artifact["name"]}), bytes))
    }
    async fn delete_artifact(&self, id: &Value, confirmation: &Value) -> HostResult<Value> {
        confirmed(confirmation)?;
        let _guard = self.writes.lock().await;
        self.ensure_open()?;
        let artifact_id = string(id)?;
        self.artifact(artifact_id)?;
        // A rename permits compensating a database failure without losing the file.
        let path = match self.artifact_path(artifact_id) {
            Ok(path) => path,
            Err(error) if error.code == "ARTIFACT_NOT_FOUND" => {
                let row = self
                    .store
                    .query(
                        "SELECT absolute_path FROM artifacts WHERE id=?",
                        &[id.clone()],
                    )?
                    .into_iter()
                    .next()
                    .ok_or_else(|| err("ARTIFACT_NOT_FOUND", "制品不存在"))?;
                let registered = PathBuf::from(text(&row, "absolute_path")?);
                let root = self
                    .root
                    .canonicalize()
                    .map_err(|e| err("UNSAFE_ARTIFACT_PATH", e))?;
                let parent = registered
                    .parent()
                    .and_then(|p| p.canonicalize().ok())
                    .ok_or_else(|| err("UNSAFE_ARTIFACT_PATH", "制品父目录无效"))?;
                if !parent.starts_with(&root) {
                    return Err(err("UNSAFE_ARTIFACT_PATH", "制品路径超出受控目录"));
                }
                match std::fs::symlink_metadata(&registered) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        self.store
                            .execute("DELETE FROM artifacts WHERE id=?", &[id.clone()])?;
                        return Ok(Value::Null);
                    }
                    _ => return Err(error),
                }
            }
            Err(error) => return Err(error),
        };
        let trash = self.root.join(format!(".{}.partial", uuid::Uuid::new_v4()));
        std::fs::rename(&path, &trash).map_err(|e| err("ARTIFACT_DELETE_FAILED", e))?;
        if let Err(error) = self
            .store
            .execute("DELETE FROM artifacts WHERE id=?", &[id.clone()])
        {
            let _ = std::fs::rename(&trash, &path);
            return Err(error);
        }
        std::fs::remove_file(&trash).map_err(|e| err("ARTIFACT_DELETE_FAILED", e))?;
        Ok(Value::Null)
    }
    pub(crate) async fn write_json(
        &self,
        target: &str,
        kind: &str,
        value: &Value,
        at: &str,
    ) -> HostResult<Value> {
        let mut content =
            serde_json::to_vec_pretty(value).map_err(|e| err("ARTIFACT_CREATE_FAILED", e))?;
        content.push(b'\n');
        self.write_buffer(target, kind, &content, at).await
    }
    pub(crate) async fn write_buffer(
        &self,
        target: &str,
        kind: &str,
        content: &[u8],
        at: &str,
    ) -> HostResult<Value> {
        let _guard = self.writes.lock().await;
        self.ensure_open()?;
        self.capacity(content.len() as u64)?;
        let id = uuid::Uuid::new_v4().to_string();
        let name = artifact_name(kind, at, &id)?;
        let temporary = self.root.join(format!(".{id}.partial"));
        let final_path = self.root.join(&name);
        let write = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .map_err(|e| err("ARTIFACT_CREATE_FAILED", e))?;
            file.write_all(content)
                .and_then(|_| file.sync_all())
                .map_err(|e| err("ARTIFACT_CREATE_FAILED", e))?;
            drop(file);
            std::fs::rename(&temporary, &final_path)
                .map_err(|e| err("ARTIFACT_CREATE_FAILED", e))?;
            let artifact = json!({"id":id,"targetId":target,"type":kind,"name":name,"size":content.len(),"sha256":format!("{:x}",Sha256::digest(content)),"status":"READY","createdAt":at});
            self.register_artifact(&artifact, &final_path)?;
            Ok(artifact)
        })();
        if write.is_err() {
            let _ = std::fs::remove_file(&temporary);
            let _ = std::fs::remove_file(&final_path);
        }
        write
    }
    fn register_artifact(&self, a: &Value, path: &Path) -> HostResult<()> {
        self.store.execute("INSERT INTO artifacts (id,target_id,type,name,absolute_path,size,sha256,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)",&[a["id"].clone(),a["targetId"].clone(),a["type"].clone(),a["name"].clone(),json!(path),a["size"].clone(),a["sha256"].clone(),a["status"].clone(),a["createdAt"].clone()])?;
        Ok(())
    }
    fn capacity(&self, size: u64) -> HostResult<()> {
        let stored = self.store.one(
            "SELECT COALESCE(SUM(size),0) AS bytes FROM artifacts WHERE status='READY'",
            &[],
        )?;
        let quota = self.store.settings()?["artifactQuotaBytes"]
            .as_u64()
            .unwrap_or(0);
        if size > quota.saturating_sub(stored["bytes"].as_u64().unwrap_or(0)) {
            return Err(err("ARTIFACT_QUOTA_EXCEEDED", "本地制品配额不足"));
        }
        let free = fs2::available_space(&self.root)
            .map_err(|e| err("ARTIFACT_CAPACITY_CHECK_FAILED", e))?;
        if free.saturating_sub(size) < 100 * 1024 * 1024 {
            return Err(err("INSUFFICIENT_DISK_SPACE", "磁盘余量不足"));
        }
        Ok(())
    }
    async fn collect_artifact(&self, a: &Value) -> HostResult<Value> {
        let _guard = self.writes.lock().await;
        self.ensure_open()?;
        let expected = a["expectedSize"]
            .as_u64()
            .ok_or_else(|| err("ARTIFACT_SIZE_INVALID", "制品大小无效"))?;
        self.capacity(expected)?;
        let target = text(a, "targetId")?;
        let token = text(a, "token")?;
        let kind = text(a, "type")?;
        let id = uuid::Uuid::new_v4().to_string();
        let at = now();
        let name = artifact_name(kind, &at, &id)?;
        let temporary = self.root.join(format!(".{id}.partial"));
        let final_path = self.root.join(&name);
        let mut cleanup = ArtifactCleanup {
            files: vec![temporary.clone(), final_path.clone()],
            remote: Some((self.targets.clone(), target.to_string(), token.to_string())),
        };
        let outcome = async {
            // Keep file operations in this poll. Tokio's detached file jobs can
            // finish creating/writing after cancellation cleanup already ran.
            let mut options=std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file=options.open(&temporary).map_err(|e|err("ARTIFACT_COLLECT_FAILED",e))?;
            let mut stream=self.targets.download_artifact(target,token).await?;
            let mut sequence=0i64;
            let mut size=0u64;
            let mut hash=Sha256::new();
            while let Some(chunk)=stream.message().await? {
                if chunk.sequence!=sequence {return Err(err("ARTIFACT_SEQUENCE_INVALID","制品分块序号不连续"));}
                sequence=sequence.checked_add(1).ok_or_else(||err("ARTIFACT_SEQUENCE_INVALID","制品分块序号溢出"))?;
                size=size.checked_add(chunk.data.len() as u64).ok_or_else(||err("ARTIFACT_SIZE_INVALID","制品大小溢出"))?;
                if size>expected {return Err(err("ARTIFACT_SIZE_MISMATCH","制品大小超过声明值"));}
                file.write_all(&chunk.data).map_err(|e|err("ARTIFACT_COLLECT_FAILED",e))?;
                hash.update(&chunk.data);
            }
            if size!=expected {return Err(err("ARTIFACT_SIZE_MISMATCH","制品大小与声明值不一致"));}
            file.sync_all().map_err(|e|err("ARTIFACT_COLLECT_FAILED",e))?;
            drop(file);
            // Keep rename, database registration and rollback disarming within
            // one poll so cancellation cannot strand an unregistered final file.
            std::fs::rename(&temporary,&final_path).map_err(|e|err("ARTIFACT_COLLECT_FAILED",e))?;
            let artifact=json!({"id":id,"targetId":target,"type":kind,"name":name,"size":size,"sha256":format!("{:x}",hash.finalize()),"status":"READY","createdAt":at});
            self.register_artifact(&artifact,&final_path)?;
            cleanup.files.clear();
            Ok(artifact)
        }.await;
        if let Some((targets, target, token)) = &cleanup.remote {
            let _ = targets.delete_remote_artifact(target, token).await;
            cleanup.remote = None;
        }
        outcome
    }
    fn cleanup(&self) -> HostResult<()> {
        let pattern = regex::Regex::new(r"^\.[a-f0-9-]{36}\.partial$")
            .map_err(|e| err("WORKSPACE_OPEN_FAILED", e))?;
        for entry in std::fs::read_dir(&self.root).map_err(|e| err("WORKSPACE_OPEN_FAILED", e))? {
            let entry = entry.map_err(|e| err("WORKSPACE_OPEN_FAILED", e))?;
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
                && pattern.is_match(&entry.file_name().to_string_lossy())
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let days = self.store.settings()?["retentionDays"]
            .as_i64()
            .unwrap_or(0);
        if days > 0 {
            let cutoff = chrono::Utc::now().timestamp_millis() - days * 86_400_000;
            for artifact in self
                .store
                .query("SELECT id,created_at FROM artifacts", &[])?
            {
                let id = text(&artifact, "id")?;
                if millis(&artifact["created_at"]).is_ok_and(|t| t < cutoff) {
                    if let Ok(path) = self.artifact_path(id) {
                        if std::fs::remove_file(path).is_ok() {
                            self.store
                                .execute("DELETE FROM artifacts WHERE id=?", &[id.into()])?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    async fn create_recording(&self, method: &str, input: &Value) -> HostResult<Value> {
        if method == "createHeapHistogramArtifact" {
            let snapshot = &input["snapshot"];
            artifacts::validate_heap(snapshot)?;
            let at = timestamp(
                snapshot["capturedAt"]
                    .as_i64()
                    .ok_or_else(|| err("TIME_INVALID", "快照时间无效"))?,
            )?;
            return self.write_json(text(snapshot,"targetId")?,"HEAP_HISTOGRAM",&json!({"schemaVersion":1,"product":"tanwei","kind":"heap-histogram","snapshot":snapshot}),&at).await;
        }
        if method == "createTraceHotspotArtifact" || method == "createMonitorWindowsArtifact" {
            let target = text(input, "targetId")?;
            let snapshot = self.targets.snapshot(target).await?;
            let identity = &input["target"];
            let details = self
                .targets
                .call(
                    "getClassDetails",
                    &[
                        target.into(),
                        identity["className"].clone(),
                        identity["classLoader"].clone(),
                    ],
                )
                .await?;
            let exists = details["methods"].as_array().is_some_and(|methods| {
                methods.iter().any(|m| {
                    m["name"] == identity["methodName"]
                        && m["parameterTypes"] == identity["parameterTypes"]
                })
            });
            if !exists {
                return Err(err(
                    "OBSERVATION_EXPORT_IDENTITY_MISMATCH",
                    "精确方法不再匹配",
                ));
            }
            let jvm = snapshot["jvmStartTimeEpochMillis"]
                .as_i64()
                .filter(|v| *v > 0)
                .ok_or_else(|| err("JVM_IDENTITY_INVALID", "JVM身份无效"))?;
            let at = millis(&snapshot["capturedAt"])?;
            let trace = method == "createTraceHotspotArtifact";
            let export = artifacts::observation_export(input, jvm, at, trace)?;
            return self
                .write_json(
                    target,
                    if trace {
                        "TRACE_HOTSPOTS"
                    } else {
                        "MONITOR_WINDOWS"
                    },
                    &export,
                    &timestamp(at)?,
                )
                .await;
        }
        let jit = method == "createJitTrendArtifact";
        let mut recording = input["recording"].clone();
        let target = text(&recording, "targetId")?.to_string();
        if jit && !recording["regressionIdentity"].is_null() {
            return Err(err(
                "JIT_REGRESSION_IDENTITY_UNTRUSTED",
                "跨版本回归身份必须由Host推导",
            ));
        }
        artifacts::validate_trend(&recording, jit)?;
        let snapshot = self.targets.snapshot(&target).await?;
        if snapshot["jvmStartTimeEpochMillis"] != recording["jvmStartTimeEpochMillis"] {
            return Err(err("JVM_RESTARTED", "目标JVM已重启，拒绝保存旧周期趋势"));
        }
        let time_key = if jit {
            "sampledAtEpochMillis"
        } else {
            "capturedAt"
        };
        let captured = recording["samples"]
            .as_array()
            .and_then(|s| s.last())
            .and_then(|s| s[time_key].as_i64())
            .ok_or_else(|| err("TREND_EMPTY", "趋势没有有效样本"))?;
        if captured > millis(&snapshot["capturedAt"])? + 5000 {
            return Err(err("TREND_TIME_INVALID", "趋势时间晚于Host快照"));
        }
        if jit && !input["regressionLabel"].is_null() {
            let connection = self.targets.connection(&target).await.ok_or_else(|| {
                err(
                    "JIT_REGRESSION_ENVIRONMENT_UNAVAILABLE",
                    "无法核对JDK或主类",
                )
            })?;
            if connection["state"] != "READY" {
                return Err(err(
                    "JIT_REGRESSION_ENVIRONMENT_UNAVAILABLE",
                    "目标连接未就绪",
                ));
            }
            let java = connection["javaVersion"]
                .as_str()
                .filter(|v| !v.trim().is_empty())
                .or_else(|| connection["target"]["javaVersion"].as_str())
                .unwrap_or("");
            let main = connection["target"]["mainClass"].as_str().unwrap_or("");
            let compiler = self
                .targets
                .execute_action(
                    &json!({"targetId":target,"actionId":"jit.compiler.summary","parameters":{}}),
                )
                .await?;
            if compiler["status"] != "SUCCEEDED"
                || compiler["values"]["compiler.available"] != "true"
            {
                return Err(err(
                    "JIT_REGRESSION_COMPILER_UNAVAILABLE",
                    "无法核对JIT编译器身份",
                ));
            }
            let name = text(&compiler["values"], "compiler.name")?;
            let latest = self.targets.snapshot(&target).await?;
            if latest["jvmStartTimeEpochMillis"] != recording["jvmStartTimeEpochMillis"] {
                return Err(err("JVM_RESTARTED", "核对环境时目标JVM发生变化"));
            }
            recording["regressionIdentity"] = json!({"workloadKey":text(&input["regressionLabel"],"workloadKey")?.trim(),"releaseLabel":text(&input["regressionLabel"],"releaseLabel")?.trim(),"targetMainClass":main.trim(),"javaVersion":java.trim(),"compilerName":name.trim()});
            artifacts::validate_trend(&recording, true)?;
        }
        let kind = if jit {
            "JIT_TREND"
        } else {
            "THREAD_POOL_TREND"
        };
        let version = if jit && !recording["regressionIdentity"].is_null() {
            2
        } else {
            1
        };
        let payload = json!({"schemaVersion":version,"product":"tanwei","kind":kind.to_lowercase().replace('_',"-"),"recording":recording});
        if serde_json::to_vec_pretty(&payload)
            .map_err(|e| err("ARTIFACT_CREATE_FAILED", e))?
            .len()
            + 1
            > 256 * 1024
        {
            return Err(err("TREND_SIZE_INVALID", "趋势制品超过256KiB"));
        }
        let artifact = self
            .write_json(&target, kind, &payload, &timestamp(captured)?)
            .await?;
        if jit {
            let summary = artifacts::summarize_jit(&recording)?;
            let pressure = text(&summary, "codeCachePressure")?;
            let (kind, severity) = match pressure {
                "NORMAL" => ("JIT_BASELINE_READY", "INFO"),
                "ELEVATED" => ("CODE_CACHE_PRESSURE", "WARNING"),
                _ => ("CODE_CACHE_PRESSURE", "CRITICAL"),
            };
            let _=self.store.transaction(&[("INSERT INTO diagnostic_alerts (id,target_id,kind,severity,artifact_id,code_cache_percent,code_cache_pressure,code_cache_capacity_kind,created_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)".into(),vec![uuid::Uuid::new_v4().to_string().into(),target.into(),kind.into(),severity.into(),artifact["id"].clone(),summary["peakCodeCachePercent"].clone(),pressure.into(),summary["codeCacheCapacityKind"].clone(),now().into()]),("DELETE FROM diagnostic_alerts WHERE id IN (SELECT id FROM diagnostic_alerts ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 200)".into(),vec![])]);
        }
        Ok(artifact)
    }
    async fn inspect(&self, method: &str, id: &Value) -> HostResult<Value> {
        let artifact = self.artifact(string(id)?)?;
        let path = self.artifact_path(string(id)?)?;
        let kind = text(&artifact, "type")?;
        let expected = match method {
            "inspectHeapHistogramArtifact" => "HEAP_HISTOGRAM",
            "inspectThreadPoolTrendArtifact" => "THREAD_POOL_TREND",
            "inspectJitTrendArtifact" => "JIT_TREND",
            "inspectThreadDumpArtifact" => "THREAD_DUMP",
            "inspectJfrArtifact" => "JFR",
            _ => kind,
        };
        if kind != expected
            || artifact["status"] != "READY"
            || method == "inspectObservationExportArtifact"
                && !matches!(kind, "TRACE_HOTSPOTS" | "MONITOR_WINDOWS")
        {
            return Err(err("ARTIFACT_TYPE_INVALID", "制品类型或状态不匹配"));
        }
        if kind == "THREAD_DUMP" {
            let content = self.verified_artifact_bytes(string(id)?, 32 * 1024 * 1024)?;
            return artifacts::parse_thread_dump(
                std::str::from_utf8(&content).map_err(|e| err("ARTIFACT_ENCODING_INVALID", e))?,
                string(id)?,
            );
        }
        if kind == "JFR" {
            self.verify_artifact(id)?;
            if artifact["size"]
                .as_u64()
                .is_none_or(|n| n == 0 || n > 512 * 1024 * 1024)
                || path.extension().and_then(|s| s.to_str()) != Some("jfr")
            {
                return Err(err("JFR_ARTIFACT_SIZE_INVALID", "JFR录制为空或超过512MiB"));
            }
            let mut command = tokio::process::Command::new(self.paths.jfr());
            command.args(["print","--json","--events","jdk.CPULoad,jdk.GarbageCollection,jdk.GCPhasePause,jdk.ExecutionSample,jdk.NativeMethodSample,jdk.ObjectAllocationSample,jdk.Compilation,jdk.Deoptimization,jdk.JavaMonitorEnter,jdk.ThreadPark,jdk.ExceptionThrown,jdk.FileRead,jdk.FileWrite,jdk.SocketRead,jdk.SocketWrite","--stack-depth","8"]).arg(path);
            let output = bounded_output(command, 32 * 1024 * 1024).await?;
            return artifacts::parse_jfr(&output, string(id)?);
        }
        artifacts::parse_json_report(
            &self.verified_artifact_bytes(string(id)?, 512 * 1024)?,
            string(id)?,
            kind,
        )
    }
    async fn compare_artifacts(&self, method: &str, input: &Value) -> HostResult<Value> {
        let baseline = &input["baselineArtifactId"];
        let current = &input["currentArtifactId"];
        if baseline == current {
            return Err(err("ARTIFACT_COMPARISON_INVALID", "比较需要两个不同制品"));
        }
        let left = self.artifact(string(baseline)?)?;
        let right = self.artifact(string(current)?)?;
        let cross = method == "compareJitTrendArtifacts" && input["mode"] == "CROSS_RELEASE";
        if !cross && left["targetId"] != right["targetId"] {
            return Err(err("ARTIFACT_TARGET_MISMATCH", "制品来自不同目标"));
        }
        let inspect = method
            .replacen("compare", "inspect", 1)
            .trim_end_matches('s')
            .to_string();
        let l = self.inspect(&inspect, baseline).await?;
        let r = self.inspect(&inspect, current).await?;
        match method {
            "compareHeapHistogramArtifacts" => {
                artifacts::compare_heap(&l, &r, text(&left, "targetId")?)
            }
            "compareThreadDumpArtifacts" => {
                artifacts::compare_thread_dumps(&l, &r, text(&left, "targetId")?)
            }
            _ => artifacts::compare_trend(&l, &r, input, method == "compareJitTrendArtifacts"),
        }
    }
    async fn jit_baselines(&self) -> HostResult<Value> {
        let candidates=self.store.query("SELECT id FROM artifacts WHERE type='JIT_TREND' AND status='READY' ORDER BY created_at DESC",&[])?;
        let mut baselines = Vec::new();
        let mut scanned = 0;
        for entry in candidates.iter().take(100) {
            scanned += 1;
            if let Ok(report) = self.inspect("inspectJitTrendArtifact", &entry["id"]).await {
                if !report["recording"]["regressionIdentity"].is_null() {
                    baselines.push(json!({"artifact":self.artifact(string(&entry["id"])?)?,"identity":report["recording"]["regressionIdentity"],"jvmStartTimeEpochMillis":report["recording"]["jvmStartTimeEpochMillis"],"samplingIntervalMillis":report["recording"]["samplingIntervalMillis"],"summary":report["summary"]}));
                    if baselines.len() == 50 {
                        break;
                    }
                }
            }
        }
        Ok(
            json!({"baselines":baselines,"scannedArtifacts":scanned,"truncated":scanned<candidates.len()||candidates.len()>100}),
        )
    }
}
struct ArtifactCleanup {
    files: Vec<PathBuf>,
    remote: Option<(Arc<TargetManager>, String, String)>,
}
impl Drop for ArtifactCleanup {
    fn drop(&mut self) {
        for path in &self.files {
            let _ = std::fs::remove_file(path);
        }
        if let Some((targets, target, token)) = self.remote.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = targets.delete_remote_artifact(&target, &token).await;
                });
            }
        }
    }
}
pub(crate) fn read_bounded(path: &Path, max: usize) -> HostResult<Vec<u8>> {
    let file = std::fs::File::open(path).map_err(|e| err("ARTIFACT_READ_FAILED", e))?;
    let meta = file
        .metadata()
        .map_err(|e| err("ARTIFACT_READ_FAILED", e))?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > max as u64 {
        return Err(err("ARTIFACT_SIZE_INVALID", "制品为空或超过读取大小边界"));
    }
    let mut content = Vec::with_capacity(meta.len() as usize);
    file.take(max as u64 + 1)
        .read_to_end(&mut content)
        .map_err(|e| err("ARTIFACT_READ_FAILED", e))?;
    if content.len() > max {
        return Err(err("ARTIFACT_SIZE_INVALID", "读取过程中制品超过大小边界"));
    }
    Ok(content)
}
fn timestamp(ms: i64) -> HostResult<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| err("TIME_INVALID", "时间超出支持范围"))
}
fn artifact_name(kind: &str, at: &str, id: &str) -> HostResult<String> {
    let extension = match kind {
        "JFR" => "jfr",
        "HEAP_DUMP" => "hprof",
        "PROFILE" => "html",
        "CLASS_DUMP" => "class",
        "THREAD_DUMP" => "txt",
        "SNAPSHOT" | "HEAP_HISTOGRAM" | "THREAD_POOL_TREND" | "JIT_TREND" | "TRACE_HOTSPOTS"
        | "MONITOR_WINDOWS" | "CASE_EXPORT" | "SUPPORT_BUNDLE" => "json",
        _ => return Err(err("ARTIFACT_TYPE_INVALID", "制品类型不受支持")),
    };
    Ok(format!(
        "tanwei-{}-{}-{}.{}",
        kind.to_lowercase().replace('_', "-"),
        at.replace([':', '.'], "-"),
        id.get(..8).unwrap_or(id),
        extension
    ))
}
fn redact(value: &str) -> (String, usize) {
    let mut count = 0;
    let mut result = value.to_string();
    for pattern in [
        r"(?i)\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*",
        r"(?i)\b(password|passwd|secret|token|credential|api[_-]?key)\b\s*[:=]\s*([^\s,;]+)",
        r"\b[A-Fa-f0-9]{32,}\b",
    ] {
        if let Ok(regex) = regex::Regex::new(pattern) {
            result = regex
                .replace_all(&result, |captures: &regex::Captures<'_>| {
                    count += 1;
                    captures
                        .get(1)
                        .map(|label| format!("{}=<redacted>", label.as_str()))
                        .unwrap_or_else(|| "<redacted>".into())
                })
                .into_owned();
        }
    }
    (result, count)
}
pub(crate) async fn bounded_output(
    mut command: tokio::process::Command,
    max: usize,
) -> HostResult<String> {
    use tokio::io::AsyncReadExt;
    command
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|e| err("JAVA_TOOL_FAILED", e))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| err("JAVA_TOOL_FAILED", "无法读取标准输出"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| err("JAVA_TOOL_FAILED", "无法读取错误输出"))?;
    let task = async {
        let read = |stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>, limit: usize| async move {
            let mut buffer = Vec::new();
            stream
                .take(limit as u64 + 1)
                .read_to_end(&mut buffer)
                .await
                .map_err(|e| err("JAVA_TOOL_FAILED", e))?;
            if buffer.len() > limit {
                return Err(err(
                    "JAVA_TOOL_OUTPUT_TOO_LARGE",
                    "Java工具输出超过安全上限",
                ));
            }
            Ok::<_, HostError>(buffer)
        };
        let (stdout, stderr) = tokio::try_join!(
            read(Box::new(stdout), max),
            read(Box::new(stderr), 1024 * 1024)
        )?;
        let status = child.wait().await.map_err(|e| err("JAVA_TOOL_FAILED", e))?;
        if !status.success() {
            return Err(err("JAVA_TOOL_FAILED", String::from_utf8_lossy(&stderr)));
        }
        String::from_utf8(stdout).map_err(|e| err("JAVA_TOOL_FAILED", e))
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), task)
        .await
        .map_err(|_| err("JAVA_TOOL_TIMEOUT", "Java工具执行超过30秒"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> (PathBuf, Workspace) {
        let root = std::env::temp_dir().join(format!("tanwei-workspace-{}", uuid::Uuid::new_v4()));
        let paths = Arc::new(RuntimePaths {
            resources: root.clone(),
            user_data: root.clone(),
            version: "0.1.0".into(),
            development: true,
        });
        let targets = Arc::new(TargetManager::new(paths.clone()));
        let workspace = Workspace::open(paths, targets).unwrap();
        (root, workspace)
    }
    fn heap() -> Value {
        json!({"snapshot":{"targetId":"local:42","targetStartTime":"2026-09-12T00:00:00Z","capturedAt":1789171200000i64,"query":"","limit":100,"scanLimit":10000,"scanComplete":true,"rowsComplete":true,"accountedObjects":2,"accountedBytes":48,"rows":[{"className":"dev.Probe","classLoader":"AppClassLoader@1","instanceCount":2,"shallowBytes":48,"averageShallowBytes":24}]}})
    }
    async fn call(workspace: &Workspace, method: &str, args: &[Value]) -> HostResult<Value> {
        workspace
            .dispatch(method, args)
            .await
            .expect("workspace method exists")
    }
    #[tokio::test]
    async fn case_evidence_export_and_import_preserve_existing_manifest_contract() {
        let (root, workspace) = workspace();
        let case = call(
            &workspace,
            "createCase",
            &[json!({"title":"事故案例","notes":"password=secret-value; visible","tags":["prod"]})],
        )
        .await
        .unwrap();
        let artifact = call(&workspace, "createHeapHistogramArtifact", &[heap()])
            .await
            .unwrap();
        let evidence = call(
            &workspace,
            "updateCaseEvidence",
            &[json!({"caseId":case["id"],"artifactIds":[artifact["id"]],"actionTaskIds":[]})],
        )
        .await
        .unwrap();
        assert_eq!(evidence["artifacts"][0]["id"], artifact["id"]);
        let exported = call(&workspace, "exportCase", &[case["id"].clone(), true.into()])
            .await
            .unwrap();
        let path = workspace
            .artifact_path(string(&exported["id"]).unwrap())
            .unwrap();
        let content: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(content["case"]["notes"], "password=<redacted>; visible");
        assert!(content.get("diagnosticCase").is_none());
        let imported = call(&workspace, "importCase", &[json!(path)])
            .await
            .unwrap();
        assert_eq!(imported["title"], case["title"]);
        assert!(imported["tags"]
            .as_array()
            .unwrap()
            .contains(&json!("imported")));
        assert!(call(
            &workspace,
            "deleteCase",
            &[case["id"].clone(), false.into()]
        )
        .await
        .is_err());
        call(&workspace, "deleteCase", &[case["id"].clone(), true.into()])
            .await
            .unwrap();
        assert_eq!(
            call(&workspace, "listCases", &[])
                .await
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        drop(workspace);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn artifact_inspection_detects_tampering_and_rejects_wrong_type() {
        let (root, workspace) = workspace();
        let artifact = call(&workspace, "createHeapHistogramArtifact", &[heap()])
            .await
            .unwrap();
        let id = artifact["id"].clone();
        let report = call(&workspace, "inspectHeapHistogramArtifact", &[id.clone()])
            .await
            .unwrap();
        assert_eq!(report["snapshot"], heap()["snapshot"]);
        assert!(call(&workspace, "inspectJfrArtifact", &[id.clone()])
            .await
            .is_err());
        let path = workspace.artifact_path(string(&id).unwrap()).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[0] = b'[';
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(
            call(&workspace, "verifyArtifact", &[id.clone()])
                .await
                .unwrap_err()
                .code,
            "ARTIFACT_HASH_MISMATCH"
        );
        call(&workspace, "deleteArtifact", &[id, true.into()])
            .await
            .unwrap();
        assert!(!path.exists());
        drop(workspace);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn settings_and_query_inputs_fail_before_writes() {
        let (root, workspace) = workspace();
        let original = call(&workspace, "getSettings", &[]).await.unwrap();
        let mut forged = original.clone();
        forged["maximumRiskLevel"] = "R0".into();
        assert!(call(&workspace, "updateSettings", &[forged]).await.is_err());
        let mut unknown = original.clone();
        unknown["extra"] = true.into();
        assert!(call(&workspace, "updateSettings", &[unknown])
            .await
            .is_err());
        assert_eq!(
            call(&workspace, "getSettings", &[]).await.unwrap(),
            original
        );
        assert!(call(&workspace,"queryActionAudits",&[json!({"offset":0,"limit":100,"query":"\u{0000}","targetId":"","status":"ALL","riskLevel":"ALL"})]).await.is_err());
        drop(workspace);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn aborted_transfer_removes_partial_and_unregistered_final_files() {
        let root =
            std::env::temp_dir().join(format!("tanwei-cancelled-receipt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let partial = root.join(".receipt.partial");
        let final_path = root.join("receipt.jfr");
        std::fs::write(&partial, b"partial").unwrap();
        std::fs::write(&final_path, b"unregistered").unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let paths = vec![partial.clone(), final_path.clone()];
        let task = tokio::spawn(async move {
            let _cleanup = ArtifactCleanup {
                files: paths,
                remote: None,
            };
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        task.abort();
        let _ = task.await;
        assert!(!partial.exists());
        assert!(!final_path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn missing_artifact_file_can_be_removed_from_the_workspace() {
        let (root, workspace) = workspace();
        let artifact = call(&workspace, "createHeapHistogramArtifact", &[heap()])
            .await
            .unwrap();
        let path = workspace
            .artifact_path(string(&artifact["id"]).unwrap())
            .unwrap();
        std::fs::remove_file(path).unwrap();
        call(
            &workspace,
            "deleteArtifact",
            &[artifact["id"].clone(), true.into()],
        )
        .await
        .unwrap();
        assert_eq!(
            call(&workspace, "listArtifacts", &[]).await.unwrap(),
            json!([])
        );
        drop(workspace);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn over_quota_stream_is_rejected_before_connecting_or_creating_files() {
        let (root, workspace) = workspace();
        let mut settings = workspace.store.settings().unwrap();
        settings["artifactQuotaBytes"] = 104857600.into();
        call(&workspace, "updateSettings", &[settings])
            .await
            .unwrap();
        let request = json!({"targetId":"local:42","token":uuid::Uuid::new_v4().to_string(),"type":"JFR","expectedSize":104857601});
        assert_eq!(
            call(&workspace, "collectAgentArtifact", &[request])
                .await
                .unwrap_err()
                .code,
            "ARTIFACT_QUOTA_EXCEEDED"
        );
        assert_eq!(std::fs::read_dir(&workspace.root).unwrap().count(), 0);
        drop(workspace);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn profile_document_uses_the_verified_bytes_and_checks_the_digest() {
        let (root, workspace) = workspace();
        let report = workspace
            .write_buffer(
                "local:42",
                "PROFILE",
                b"<html><body>trusted</body></html>",
                &now(),
            )
            .await
            .unwrap();
        let id = string(&report["id"]).unwrap();
        let (metadata, document) = workspace.profile_report_document(id).unwrap();
        let path = PathBuf::from(text(&metadata, "absolutePath").unwrap());
        std::fs::write(&path, b"<html><body>changed</body></html>").unwrap();
        assert_eq!(document, b"<html><body>trusted</body></html>");
        assert_eq!(
            workspace.profile_report_document(id).unwrap_err().code,
            "ARTIFACT_HASH_MISMATCH"
        );
        drop(workspace);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn shutdown_closes_database_and_failed_update_can_resume() {
        let (root, workspace) = workspace();
        let case = call(
            &workspace,
            "createCase",
            &[json!({"title":"retain","notes":"","tags":[]})],
        )
        .await
        .unwrap();
        workspace.close().await.unwrap();
        assert_eq!(
            call(&workspace, "listCases", &[]).await.unwrap_err().code,
            "WORKSPACE_CLOSED"
        );
        workspace.resume_after_failed_update().await.unwrap();
        assert_eq!(
            call(&workspace, "listCases", &[]).await.unwrap()[0]["id"],
            case["id"]
        );
        workspace.close().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn managed_artifact_symlink_cannot_escape_root() {
        use std::os::unix::fs::symlink;
        let (root, workspace) = workspace();
        let artifact = call(&workspace, "createHeapHistogramArtifact", &[heap()])
            .await
            .unwrap();
        let path = workspace
            .artifact_path(string(&artifact["id"]).unwrap())
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        let external = root.join("outside.json");
        std::fs::write(&external, b"outside").unwrap();
        symlink(&external, &path).unwrap();
        assert_eq!(
            workspace
                .artifact_path(string(&artifact["id"]).unwrap())
                .unwrap_err()
                .code,
            "UNSAFE_ARTIFACT_PATH"
        );
        assert!(external.exists());
        drop(workspace);
        std::fs::remove_dir_all(root).unwrap();
    }
}
