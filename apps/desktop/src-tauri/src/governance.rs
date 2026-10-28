mod signatures;
pub use signatures::{public_key_fingerprint, verify_team_policy};

use crate::{
    common::{HostError, HostResult, RuntimePaths},
    policy,
    storage::Storage,
    targets::TargetManager,
    workspace::Workspace,
};
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::{pkcs8::EncodePublicKey, SigningKey};
use rand::rngs::OsRng;
use serde_json::{json, Value};
use signatures::*;
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use uuid::Uuid;

const IMPORT_LIMIT: u64 = 1024 * 1024;
const MANIFEST: &str = "tanwei-plugin.json";
const TEMPLATE_COLUMNS:&str="id,name,description,action_id,parameters_json,risk_level,source,signer,public_key_fingerprint,public_key_pem,signature,created_at";

fn error(code: &str, message: impl std::fmt::Display) -> HostError {
    HostError::new(code, message.to_string())
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn confirm(confirmed: bool) -> HostResult<()> {
    if confirmed {
        Ok(())
    } else {
        Err(error("CONFIRMATION_REQUIRED", "此操作需要明确确认"))
    }
}
fn argument(args: &[Value], index: usize) -> HostResult<&str> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| error("INVALID_INPUT", "缺少操作参数"))
}

#[derive(Clone, Copy, PartialEq)]
enum ImportKind {
    Plugin,
    TeamPolicy,
}
struct PendingImport {
    id: String,
    kind: ImportKind,
    package: Value,
    descriptor: Value,
    expires: Instant,
}

pub struct Governance {
    store: Arc<Storage>,
    targets: Arc<TargetManager>,
    plugins: PathBuf,
    key: SigningKey,
    public_key: String,
    fingerprint: String,
    pending: Mutex<VecDeque<PendingImport>>,
    writes: Mutex<()>,
}

impl Governance {
    pub fn new(
        paths: Arc<RuntimePaths>,
        workspace: Arc<Workspace>,
        targets: Arc<TargetManager>,
    ) -> HostResult<Self> {
        let plugins = paths.user_data.join("plugins");
        private_directory(&plugins, true)?;
        let key = SigningKey::generate(&mut OsRng);
        let public_key = key
            .verifying_key()
            .to_public_key_pem(Default::default())
            .map_err(|e| error("GOVERNANCE_OPEN_FAILED", e))?;
        let fingerprint = public_key_fingerprint(&public_key)?;
        Ok(Self {
            store: workspace.store(),
            targets,
            plugins,
            key,
            public_key,
            fingerprint,
            pending: Mutex::new(VecDeque::new()),
            writes: Mutex::new(()),
        })
    }

    pub async fn dispatch(&self, method: &str, args: &[Value]) -> Option<HostResult<Value>> {
        let result = match method {
            "compareTargets" => {
                self.compare_targets(args.first().unwrap_or(&Value::Null))
                    .await
            }
            "listDiagnosticTemplates" => self.list_templates(),
            "createSignedDiagnosticTemplate" => {
                self.create_template(args.first().unwrap_or(&Value::Null))
            }
            "deleteDiagnosticTemplate" => match argument(args, 0) {
                Ok(id) => {
                    self.delete_template(id, args.get(1).and_then(Value::as_bool) == Some(true))
                }
                Err(e) => Err(e),
            },
            "listPlugins" => self
                .read_plugins()
                .and_then(|packages| {
                    packages
                        .iter()
                        .map(|(package, installed_at)| plugin_descriptor(package, installed_at))
                        .collect::<HostResult<Vec<_>>>()
                })
                .map(Value::Array),
            "previewPluginImport" => {
                if args.first().is_none_or(Value::is_null) {
                    Ok(Value::Null)
                } else {
                    argument(args, 0).and_then(|path| self.preview_import(path, ImportKind::Plugin))
                }
            }
            "previewTeamPolicyImport" => {
                if args.first().is_none_or(Value::is_null) {
                    Ok(Value::Null)
                } else {
                    argument(args, 0)
                        .and_then(|path| self.preview_import(path, ImportKind::TeamPolicy))
                }
            }
            "installPlugin" => argument(args, 0).and_then(|id| {
                self.install_plugin(id, args.get(1).and_then(Value::as_bool) == Some(true))
            }),
            "deletePlugin" => argument(args, 0).and_then(|id| {
                self.delete_plugin(id, args.get(1).and_then(Value::as_bool) == Some(true))
            }),
            "activateTeamPolicy" => argument(args, 0).and_then(|id| {
                self.activate_team_policy(id, args.get(1).and_then(Value::as_bool) == Some(true))
            }),
            "getActiveTeamPolicy" => self.active_team_policy(),
            "removeTeamPolicy" => {
                let result = confirm(args.first().and_then(Value::as_bool) == Some(true));
                result.and_then(|_| {
                    self.store
                        .execute("DELETE FROM active_team_policy WHERE id=1", &[])
                        .map(|_| Value::Null)
                })
            }
            // Root dispatches executeDiagnosticTemplate through its normal authorization/audit path.
            _ => return None,
        };
        Some(result)
    }

    pub async fn resolve_template_action(
        &self,
        template_id: &str,
        target_id: &str,
        confirmed: bool,
    ) -> HostResult<Value> {
        let template = self
            .resolve_template(template_id)?
            .ok_or_else(|| error("TEMPLATE_NOT_FOUND", "诊断模板不存在"))?;
        if template["verified"] != true {
            return Err(error(
                "TEMPLATE_SIGNATURE_INVALID",
                "诊断模板签名无效，已拒绝执行",
            ));
        }
        if template["riskLevel"] == "R1" && !confirmed {
            return Err(error(
                "CONFIRMATION_REQUIRED",
                "R1 诊断模板需要逐次确认后执行",
            ));
        }
        let action = policy::validate_template_action(
            string(&template, "actionId", 1, 128)?,
            &template["parameters"],
        )?;
        Ok(
            json!({"targetId":target_id,"actionId":action["actionId"],"parameters":action["parameters"],"contractVersion":"1.0"}),
        )
    }

    async fn compare_targets(&self, value: &Value) -> HostResult<Value> {
        let selected = value
            .as_array()
            .ok_or_else(|| error("INVALID_COMPARISON_TARGETS", "多目标对比参数必须为数组"))?;
        if selected.len() < 2 || selected.len() > 8 {
            return Err(error(
                "INVALID_COMPARISON_TARGETS",
                "多目标对比必须选择 2 至 8 个不同的已连接 JVM",
            ));
        }
        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        for value in selected {
            let id = value
                .as_str()
                .ok_or_else(|| error("INVALID_COMPARISON_TARGETS", "目标标识无效"))?;
            if !seen.insert(id) {
                return Err(error("INVALID_COMPARISON_TARGETS", "对比目标不能重复"));
            }
            ids.push(id);
        }
        let mut connections = Vec::new();
        for id in &ids {
            let connection = self.targets.connection(id).await.ok_or_else(|| {
                error(
                    "COMPARISON_TARGET_NOT_READY",
                    "所有对比目标都必须处于已连接状态",
                )
            })?;
            if connection["state"] != "READY" {
                return Err(error(
                    "COMPARISON_TARGET_NOT_READY",
                    "所有对比目标都必须处于已连接状态",
                ));
            }
            connections.push(connection);
        }
        let snapshots =
            futures::future::try_join_all(ids.iter().map(|id| self.targets.snapshot(id))).await?;
        let baseline = &snapshots[0];
        let rows=snapshots.iter().zip(connections).map(|(snapshot,connection)| {
            let mut delta=serde_json::Map::new();
            for key in ["processCpuLoad","heapUsedBytes","nonHeapUsedBytes","liveThreads","loadedClasses","gcCount","gcTimeMillis"] {
                let value=match (snapshot[key].as_f64(),baseline[key].as_f64()){(Some(a),Some(b))=>json!(a-b),_=>Value::Null};delta.insert(key.into(),value);
            }
            json!({"targetId":connection["target"]["id"],"displayName":connection["target"]["displayName"],"pid":connection["target"]["pid"],"javaVersion":connection["javaVersion"],"snapshot":snapshot,"deltaFromBaseline":delta})
        }).collect::<Vec<_>>();
        Ok(json!({"capturedAt":now(),"baselineTargetId":ids[0],"rows":rows}))
    }

    fn list_templates(&self) -> HostResult<Value> {
        let mut templates = self
            .store
            .query(
                &format!(
                    "SELECT {TEMPLATE_COLUMNS} FROM diagnostic_templates ORDER BY created_at DESC"
                ),
                &[],
            )?
            .iter()
            .map(map_template)
            .collect::<HostResult<Vec<_>>>()?;
        for (plugin, installed_at) in self.read_plugins()? {
            templates.extend(self.plugin_templates(&plugin, &installed_at)?);
        }
        Ok(Value::Array(templates))
    }

    fn create_template(&self, value: &Value) -> HostResult<Value> {
        let mut value = value.clone();
        strict(&value, &["name", "description", "actionId", "parameters"])?;
        trim_string(&mut value, "name", 1, 120)?;
        trim_string(&mut value, "description", 0, 1000)?;
        parameters(&value["parameters"])?;
        let action = policy::validate_template_action(
            string(&value, "actionId", 1, 128)?,
            &value["parameters"],
        )?;
        let mut template = json!({"id":Uuid::new_v4().to_string(),"name":value["name"],"description":value["description"],
            "actionId":action["actionId"],"parameters":action["parameters"],"riskLevel":action["riskLevel"],"source":"LOCAL",
            "signer":"Tanwei local session","publicKey":self.public_key,"publicKeyFingerprint":self.fingerprint,"createdAt":now()});
        template["signature"] = sign_canonical(&self.key, &template_payload(&template))?.into();
        template["verified"] = true.into();
        let args = [
            "id",
            "name",
            "description",
            "actionId",
            "parameters",
            "riskLevel",
            "source",
            "signer",
            "publicKey",
            "publicKeyFingerprint",
            "signature",
            "createdAt",
        ]
        .iter()
        .map(|key| {
            if *key == "parameters" {
                Value::String(template[*key].to_string())
            } else {
                template[*key].clone()
            }
        })
        .collect::<Vec<_>>();
        self.store.execute("INSERT INTO diagnostic_templates (id,name,description,action_id,parameters_json,risk_level,source,signer,public_key_pem,public_key_fingerprint,signature,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",&args)?;
        Ok(template)
    }

    fn delete_template(&self, id: &str, confirmed: bool) -> HostResult<Value> {
        confirm(confirmed)?;
        if id.starts_with("plugin:") {
            return Err(error(
                "PLUGIN_TEMPLATE_READ_ONLY",
                "插件模板只可通过卸载对应插件移除",
            ));
        }
        if self
            .store
            .execute("DELETE FROM diagnostic_templates WHERE id=?", &[id.into()])?
            == 0
        {
            return Err(error("TEMPLATE_NOT_FOUND", "诊断模板不存在"));
        }
        Ok(Value::Null)
    }

    fn resolve_template(&self, id: &str) -> HostResult<Option<Value>> {
        if let Some(row) = self
            .store
            .query(
                &format!("SELECT {TEMPLATE_COLUMNS} FROM diagnostic_templates WHERE id=?"),
                &[id.into()],
            )?
            .first()
        {
            return Ok(Some(map_template(row)?));
        }
        let parts = id.split(':').collect::<Vec<_>>();
        if parts.len() != 3
            || parts[0] != "plugin"
            || !identifier(parts[1])
            || !identifier(parts[2])
        {
            return Ok(None);
        }
        for (plugin, installed_at) in self.read_plugins()? {
            if plugin["id"] == parts[1] {
                return Ok(self
                    .plugin_templates(&plugin, &installed_at)?
                    .into_iter()
                    .find(|t| t["id"] == id));
            }
        }
        Ok(None)
    }

    fn plugin_templates(&self, plugin: &Value, installed_at: &str) -> HostResult<Vec<Value>> {
        let fingerprint = public_key_fingerprint(string(plugin, "publicKey", 80, 4096)?)?;
        let verified = verify_plugin(plugin);
        plugin["templates"].as_array().ok_or_else(||invalid("插件模板必须为数组"))?.iter().map(|template| {
            let action=policy::validate_template_action(string(template,"actionId",1,128)?,&template["parameters"])?;
            Ok(json!({"id":format!("plugin:{}:{}",plugin["id"].as_str().unwrap_or_default(),template["id"].as_str().unwrap_or_default()),
                "name":template["name"],"description":template["description"],"actionId":action["actionId"],"parameters":action["parameters"],"riskLevel":action["riskLevel"],
                "source":"PLUGIN","signer":plugin["publisher"],"publicKey":plugin["publicKey"],"publicKeyFingerprint":fingerprint,"signature":plugin["signature"],"verified":verified,"createdAt":installed_at}))
        }).collect()
    }

    fn preview_import(&self, path: &str, kind: ImportKind) -> HostResult<Value> {
        let value = read_json(Path::new(path))?;
        let (package, descriptor) = match kind {
            ImportKind::Plugin => {
                let plugin = validate_plugin(value)?;
                if !verify_plugin(&plugin) {
                    return Err(error(
                        "PLUGIN_SIGNATURE_INVALID",
                        "插件清单的 Ed25519 签名无效",
                    ));
                }
                for template in plugin["templates"]
                    .as_array()
                    .ok_or_else(|| invalid("插件模板必须为数组"))?
                {
                    policy::validate_template_action(
                        string(template, "actionId", 1, 128)?,
                        &template["parameters"],
                    )?;
                }
                let descriptor = plugin_descriptor(&plugin, &now())?;
                (plugin, descriptor)
            }
            ImportKind::TeamPolicy => {
                let package = validate_team_policy(value)?;
                if !verify_team_policy(&package) {
                    return Err(error(
                        "TEAM_POLICY_SIGNATURE_INVALID",
                        "团队策略包的 Ed25519 签名无效",
                    ));
                }
                validate_policy_time(&package)?;
                let descriptor = team_descriptor(&package, None)?;
                (package, descriptor)
            }
        };
        let preview_id = Uuid::new_v4().to_string();
        let expires_at = (Utc::now() + Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| error("GOVERNANCE_STATE_FAILED", "导入预览状态不可用"))?;
        pending.retain(|p| p.expires > Instant::now());
        while pending.len() >= 20 {
            pending.pop_front();
        }
        pending.push_back(PendingImport {
            id: preview_id.clone(),
            kind,
            package,
            descriptor: descriptor.clone(),
            expires: Instant::now() + std::time::Duration::from_secs(300),
        });
        Ok(json!({"previewId":preview_id,"value":descriptor,"expiresAt":expires_at}))
    }

    fn take_preview(&self, id: &str, kind: ImportKind) -> HostResult<PendingImport> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| error("GOVERNANCE_STATE_FAILED", "导入预览状态不可用"))?;
        pending.retain(|p| p.expires > Instant::now());
        let value = pending
            .iter()
            .position(|p| p.id == id)
            .and_then(|index| pending.remove(index));
        value.filter(|value| value.kind == kind).ok_or_else(|| {
            error(
                if kind == ImportKind::Plugin {
                    "PLUGIN_PREVIEW_EXPIRED"
                } else {
                    "TEAM_POLICY_PREVIEW_EXPIRED"
                },
                "导入预览不存在、已过期或已经使用",
            )
        })
    }

    fn install_plugin(&self, id: &str, confirmed: bool) -> HostResult<Value> {
        let pending = self.take_preview(id, ImportKind::Plugin)?;
        confirm(confirmed)?;
        let _writes = self
            .writes
            .lock()
            .map_err(|_| error("PLUGIN_INSTALL_FAILED", "插件写入状态不可用"))?;
        let directory = self.plugin_directory(string(&pending.package, "id", 2, 64)?)?;
        if directory
            .join(MANIFEST)
            .try_exists()
            .map_err(|e| error("PLUGIN_INSTALL_FAILED", e))?
        {
            return Err(error(
                "PLUGIN_ALREADY_INSTALLED",
                "同名插件已安装；请先卸载旧版本再安装",
            ));
        }
        private_directory(&directory, false)?;
        let temporary = directory.join(format!(".{}.partial", Uuid::new_v4()));
        let result = || -> HostResult<()> {
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .map_err(|e| error("PLUGIN_INSTALL_FAILED", e))?;
            file.write_all(
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&pending.package)
                        .map_err(|e| error("PLUGIN_INSTALL_FAILED", e))?
                )
                .as_bytes(),
            )
            .map_err(|e| error("PLUGIN_INSTALL_FAILED", e))?;
            file.sync_all()
                .map_err(|e| error("PLUGIN_INSTALL_FAILED", e))?;
            fs::rename(&temporary, directory.join(MANIFEST))
                .map_err(|e| error("PLUGIN_INSTALL_FAILED", e))?;
            Ok(())
        };
        if let Err(error) = result() {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_dir_all(&directory);
            return Err(error);
        }
        Ok(pending.descriptor)
    }

    fn delete_plugin(&self, id: &str, confirmed: bool) -> HostResult<Value> {
        confirm(confirmed)?;
        let _writes = self
            .writes
            .lock()
            .map_err(|_| error("PLUGIN_DELETE_FAILED", "插件写入状态不可用"))?;
        let directory = self.plugin_directory(id)?;
        let metadata = fs::symlink_metadata(&directory)
            .map_err(|_| error("PLUGIN_NOT_FOUND", "插件不存在"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(error("PLUGIN_DIRECTORY_INVALID", "插件目录类型无效"));
        }
        if !directory.join(MANIFEST).is_file() {
            return Err(error("PLUGIN_NOT_FOUND", "插件不存在"));
        }
        fs::remove_dir_all(directory).map_err(|e| error("PLUGIN_DELETE_FAILED", e))?;
        Ok(Value::Null)
    }

    fn activate_team_policy(&self, id: &str, confirmed: bool) -> HostResult<Value> {
        let pending = self.take_preview(id, ImportKind::TeamPolicy)?;
        confirm(confirmed)?;
        validate_policy_time(&pending.package)?;
        let activated_at = now();
        let mut descriptor = pending.descriptor;
        descriptor["activatedAt"] = Value::Null;
        self.store.execute("INSERT INTO active_team_policy (id,package_json,activated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET package_json=excluded.package_json,activated_at=excluded.activated_at",&[descriptor.to_string().into(),activated_at.clone().into()])?;
        descriptor["activatedAt"] = activated_at.into();
        Ok(descriptor)
    }

    pub fn active_team_policy(&self) -> HostResult<Value> {
        let records = self.store.query(
            "SELECT package_json,activated_at FROM active_team_policy WHERE id=1",
            &[],
        )?;
        let Some(row) = records.first() else {
            return Ok(Value::Null);
        };
        let mut policy: Value =
            serde_json::from_str(string(row, "package_json", 1, IMPORT_LIMIT as usize)?)
                .map_err(|e| error("TEAM_POLICY_READ_FAILED", e))?;
        let verified = verify_team_policy(&policy)
            && policy["publicKey"]
                .as_str()
                .and_then(|key| public_key_fingerprint(key).ok())
                .is_some_and(|fingerprint| policy["publicKeyFingerprint"] == fingerprint);
        policy["verified"] = verified.into();
        policy["activatedAt"] = row["activated_at"].clone();
        Ok(policy)
    }

    fn read_plugins(&self) -> HostResult<Vec<(Value, String)>> {
        let mut packages = Vec::new();
        for entry in fs::read_dir(&self.plugins)
            .map_err(|e| error("PLUGIN_LIST_FAILED", e))?
            .take(100)
        {
            let entry = entry.map_err(|e| error("PLUGIN_LIST_FAILED", e))?;
            if !entry
                .file_type()
                .map_err(|e| error("PLUGIN_LIST_FAILED", e))?
                .is_dir()
            {
                continue;
            }
            let id = entry.file_name();
            let Some(id) = id.to_str().filter(|id| identifier(id)) else {
                continue;
            };
            let path = entry.path().join(MANIFEST);
            // Invalid or tampered packages are never exposed as executable templates.
            let read = || -> HostResult<(Value, String)> {
                let plugin = validate_plugin(read_json(&path)?)?;
                if plugin["id"] != id || !verify_plugin(&plugin) {
                    return Err(error("PLUGIN_SIGNATURE_INVALID", "已安装插件签名无效"));
                }
                let modified = fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .map_err(|e| error("PLUGIN_LIST_FAILED", e))?;
                Ok((
                    plugin,
                    DateTime::<Utc>::from(modified)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ))
            };
            if let Ok(package) = read() {
                packages.push(package);
            }
        }
        packages.sort_by(|a, b| a.0["name"].as_str().cmp(&b.0["name"].as_str()));
        Ok(packages)
    }
    fn plugin_directory(&self, id: &str) -> HostResult<PathBuf> {
        if !identifier(id) {
            Err(error("INVALID_PLUGIN_ID", "插件标识无效"))
        } else {
            Ok(self.plugins.join(id))
        }
    }
}

fn private_directory(path: &Path, recursive: bool) -> HostResult<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|e| error("PLUGIN_DIRECTORY_FAILED", e))
}
fn read_json(path: &Path) -> HostResult<Value> {
    let file = fs::File::open(path).map_err(|e| error("IMPORT_READ_FAILED", e))?;
    let metadata = file
        .metadata()
        .map_err(|e| error("IMPORT_READ_FAILED", e))?;
    if !metadata.is_file() || metadata.len() > IMPORT_LIMIT {
        return Err(error(
            "IMPORT_SIZE_EXCEEDED",
            "导入文件必须是小于 1 MiB 的普通文件",
        ));
    }
    let mut bytes = Vec::new();
    file.take(IMPORT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| error("IMPORT_READ_FAILED", e))?;
    if bytes.len() as u64 > IMPORT_LIMIT {
        return Err(error("IMPORT_SIZE_EXCEEDED", "导入文件超过 1 MiB"));
    }
    serde_json::from_slice(&bytes).map_err(|e| error("IMPORT_JSON_INVALID", e))
}
fn map_template(row: &Value) -> HostResult<Value> {
    let parameters: Value =
        serde_json::from_str(string(row, "parameters_json", 2, IMPORT_LIMIT as usize)?)
            .map_err(|e| error("TEMPLATE_LIST_FAILED", e))?;
    let mut template = json!({"id":row["id"],"name":row["name"],"description":row["description"],"actionId":row["action_id"],"parameters":parameters,
        "riskLevel":row["risk_level"],"source":row["source"],"signer":row["signer"],"publicKey":row["public_key_pem"],"publicKeyFingerprint":row["public_key_fingerprint"],"signature":row["signature"],"createdAt":row["created_at"]});
    template["verified"] = verify_template(&template).into();
    Ok(template)
}
fn plugin_descriptor(plugin: &Value, installed_at: &str) -> HostResult<Value> {
    Ok(
        json!({"id":plugin["id"],"name":plugin["name"],"version":plugin["version"],"apiVersion":plugin["apiVersion"],"description":plugin["description"],"publisher":plugin["publisher"],
        "publicKeyFingerprint":public_key_fingerprint(string(plugin,"publicKey",80,4096)?)?,"templateCount":plugin["templates"].as_array().map_or(0,Vec::len),"verified":verify_plugin(plugin),"installedAt":installed_at}),
    )
}
fn team_descriptor(package: &Value, activated_at: Option<&str>) -> HostResult<Value> {
    let mut result = package.clone();
    result["publicKeyFingerprint"] =
        public_key_fingerprint(string(package, "publicKey", 80, 4096)?)?.into();
    result["verified"] = verify_team_policy(package).into();
    result["activatedAt"] = json!(activated_at);
    Ok(result)
}
fn validate_policy_time(policy: &Value) -> HostResult<()> {
    let issued_at = DateTime::parse_from_rfc3339(string(policy, "issuedAt", 1, 128)?)
        .map_err(|e| error("TEAM_POLICY_TIME_INVALID", e))?;
    if issued_at > Utc::now() + Duration::minutes(5) {
        return Err(error(
            "TEAM_POLICY_NOT_YET_VALID",
            "团队策略签发时间晚于当前时间",
        ));
    }
    if let Some(value) = policy["expiresAt"].as_str() {
        let expiration = DateTime::parse_from_rfc3339(value)
            .map_err(|e| error("TEAM_POLICY_TIME_INVALID", e))?;
        if expiration <= Utc::now() {
            return Err(error("TEAM_POLICY_EXPIRED", "团队策略包已经过期"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test(root: &Path) -> Governance {
        let paths = Arc::new(RuntimePaths {
            resources: root.join("resources"),
            user_data: root.to_path_buf(),
            version: "0.1.0".into(),
            development: true,
        });
        let targets = Arc::new(TargetManager::new(paths.clone()));
        let workspace = Arc::new(Workspace::open(paths.clone(), targets.clone()).unwrap());
        Governance::new(paths, workspace, targets).unwrap()
    }
    fn test_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("tanwei-governance-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        root
    }
    fn signed_plugin(governance: &Governance) -> Value {
        let mut plugin = json!({"apiVersion":"tanwei.dev/plugin/v1","id":"test-plugin","name":"测试插件","version":"1.0.0","description":"","publisher":"Test",
            "publicKey":governance.public_key,"templates":[{"id":"runtime-info","name":"JVM Info","description":"","actionId":"jvm.info","parameters":{}}]});
        plugin["signature"] = sign_canonical(&governance.key, &plugin_payload(&plugin))
            .unwrap()
            .into();
        plugin
    }

    #[tokio::test]
    async fn local_templates_survive_new_session_and_reject_database_tampering() {
        let root = test_root();
        {
            let governance = open_test(&root);
            let template=governance.create_template(&json!({"name":" Runtime ","description":"","actionId":"jvm.info","parameters":{}})).unwrap();
            assert_eq!(template["name"], "Runtime");
            let id = template["id"].as_str().unwrap();
            let request = governance
                .resolve_template_action(id, "local:1", false)
                .await
                .unwrap();
            assert_eq!(request["contractVersion"], "1.0");
            let reopened = open_test(&root);
            assert_eq!(
                reopened.resolve_template(id).unwrap().unwrap()["verified"],
                true
            );
            reopened
                .store
                .execute(
                    "UPDATE diagnostic_templates SET name='tampered' WHERE id=?",
                    &[id.into()],
                )
                .unwrap();
            assert_eq!(
                reopened
                    .resolve_template_action(id, "local:1", true)
                    .await
                    .unwrap_err()
                    .code,
                "TEMPLATE_SIGNATURE_INVALID"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn plugin_previews_are_one_use_and_installed_signatures_are_rechecked() {
        let root = test_root();
        {
            let governance = open_test(&root);
            let package = signed_plugin(&governance);
            let source = root.join("plugin.json");
            fs::write(&source, package.to_string()).unwrap();
            let preview = governance
                .preview_import(source.to_str().unwrap(), ImportKind::Plugin)
                .unwrap();
            let id = preview["previewId"].as_str().unwrap();
            assert!(governance.install_plugin(id, true).is_ok());
            assert_eq!(
                governance.install_plugin(id, true).unwrap_err().code,
                "PLUGIN_PREVIEW_EXPIRED"
            );
            assert_eq!(governance.read_plugins().unwrap().len(), 1);
            assert!(governance
                .resolve_template_action("plugin:test-plugin:runtime-info", "local:1", false)
                .await
                .is_ok());
            let mut corrupt = package;
            corrupt["templates"][0]["actionId"] = "class.dump".into();
            fs::write(
                root.join("plugins/test-plugin/tanwei-plugin.json"),
                corrupt.to_string(),
            )
            .unwrap();
            assert!(governance.read_plugins().unwrap().is_empty());
            assert_eq!(
                governance
                    .resolve_template_action("plugin:test-plugin:runtime-info", "local:1", true)
                    .await
                    .unwrap_err()
                    .code,
                "TEMPLATE_NOT_FOUND"
            );
            assert!(governance.delete_plugin("../outside", true).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn team_policy_activation_requires_confirmation_and_verifies_persisted_payload() {
        let root = test_root();
        {
            let governance = open_test(&root);
            let mut policy = json!({"apiVersion":"tanwei.dev/team-policy/v1","id":"test-policy","name":"Test Policy","version":"1.0.0","issuedAt":now(),"expiresAt":null,"maximumRiskLevel":"R1","deniedActions":[],"signer":"Test","publicKey":governance.public_key});
            policy["signature"] = sign_canonical(&governance.key, &team_payload(&policy))
                .unwrap()
                .into();
            let source = root.join("policy.json");
            fs::write(&source, policy.to_string()).unwrap();
            let preview = governance
                .preview_import(source.to_str().unwrap(), ImportKind::TeamPolicy)
                .unwrap();
            let id = preview["previewId"].as_str().unwrap();
            assert_eq!(
                governance.activate_team_policy(id, false).unwrap_err().code,
                "CONFIRMATION_REQUIRED"
            );
            assert!(governance.active_team_policy().unwrap().is_null());
            let preview = governance
                .preview_import(source.to_str().unwrap(), ImportKind::TeamPolicy)
                .unwrap();
            let mut active = governance
                .activate_team_policy(preview["previewId"].as_str().unwrap(), true)
                .unwrap();
            assert_eq!(governance.active_team_policy().unwrap()["verified"], true);
            active["maximumRiskLevel"] = "R4".into();
            governance
                .store
                .execute(
                    "UPDATE active_team_policy SET package_json=? WHERE id=1",
                    &[active.to_string().into()],
                )
                .unwrap();
            assert_eq!(governance.active_team_policy().unwrap()["verified"], false);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
