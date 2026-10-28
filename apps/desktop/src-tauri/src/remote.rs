//! Remote deployment owns its credentials, preview identity, and forwarding lifetime.
mod transport;

use crate::common::{HostError, HostResult, RuntimePaths};
use crate::targets::{RemoteCleanup, RemoteTls, TargetManager};
use chrono::{Duration as ChronoDuration, Utc};
use openssl::{asn1::Asn1Time, hash::MessageDigest, pkey::PKey, x509::X509};
use rand::{rngs::OsRng, Rng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StandardMutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncReadExt,
    sync::{Mutex, RwLock},
};
use tokio_util::sync::CancellationToken;
use transport::Transport;
use uuid::Uuid;

const PREVIEW_TTL: Duration = Duration::from_secs(300);
const COMPONENT_IDS: [&str; 4] = ["attach-helper", "bootstrap", "agent", "relay"];
const MAX_PID: u64 = 9_007_199_254_740_991;

pub(super) fn remote_error(message: impl std::fmt::Display) -> HostError {
    HostError::new("REMOTE_DEPLOYMENT_FAILED", message.to_string())
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub(super) enum Authentication {
    #[serde(rename = "PASSWORD")]
    Password { password: String },
    #[serde(rename = "PRIVATE_KEY", rename_all = "camelCase")]
    PrivateKey {
        private_key: String,
        passphrase: String,
    },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SshInput {
    host: String,
    port: u16,
    username: String,
    authentication: Authentication,
    pid: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct KubeInput {
    context: String,
    namespace: String,
    pod: String,
    container: String,
    pid: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistentInput {
    host: String,
    port: u16,
    server_name: String,
    ca_certificate: String,
    client_certificate: String,
    client_private_key: String,
    session_secret: String,
    pid: u64,
    display_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Platform {
    platform: String,
    architecture: String,
    java_version: String,
}

#[derive(Clone, PartialEq, Serialize)]
struct Component {
    #[serde(skip)]
    id: String,
    #[serde(skip)]
    path: PathBuf,
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Clone)]
enum PreviewInput {
    Ssh(SshInput, String),
    Kubernetes(KubeInput),
    Persistent(PersistentInput),
}

struct Pending {
    id: String,
    expires: Instant,
    input: PreviewInput,
    platform: Option<Platform>,
    components: Vec<Component>,
    directory: String,
}

struct DeploymentGuard {
    transport: Option<Arc<Transport>>,
    directory: String,
    relay_pid: Option<u64>,
}
impl DeploymentGuard {
    async fn close(&mut self) {
        if let Some(transport) = self.transport.take() {
            transport.cleanup(&self.directory, self.relay_pid).await;
            transport.close().await;
        }
    }
}
impl Drop for DeploymentGuard {
    fn drop(&mut self) {
        if let Some(transport) = self.transport.take() {
            let directory = self.directory.clone();
            let pid = self.relay_pid;
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    transport.cleanup(&directory, pid).await;
                    transport.close().await;
                });
            }
        }
    }
}

pub struct RemoteManager {
    paths: Arc<RuntimePaths>,
    targets: Arc<TargetManager>,
    pending: Mutex<VecDeque<Pending>>,
    operations: RwLock<()>,
    cancellation: StandardMutex<CancellationToken>,
    closing: AtomicBool,
}

struct PreparedEndpoint {
    target: Value,
    endpoint: String,
    secret: String,
    cleanup: RemoteCleanup,
}

impl RemoteManager {
    pub fn new(paths: Arc<RuntimePaths>, targets: Arc<TargetManager>) -> Self {
        Self {
            paths,
            targets,
            pending: Mutex::new(VecDeque::new()),
            operations: RwLock::new(()),
            cancellation: StandardMutex::new(CancellationToken::new()),
            closing: AtomicBool::new(false),
        }
    }

    pub async fn close_all(&self) {
        self.closing.store(true, Ordering::Release);
        if let Ok(token) = self.cancellation.lock() {
            token.cancel();
        }
        // Wait until in-flight deployment cleanup has actually completed before
        // the caller closes the workspace or exits the Tokio runtime.
        let _exclusive = self.operations.write().await;
        self.pending.lock().await.clear();
    }

    pub async fn resume_after_close(&self) -> HostResult<()> {
        let _exclusive = self.operations.write().await;
        *self
            .cancellation
            .lock()
            .map_err(|_| remote_error("远程取消状态不可用"))? = CancellationToken::new();
        self.closing.store(false, Ordering::Release);
        Ok(())
    }

    pub async fn dispatch(&self, method: &str, args: &[Value]) -> Option<HostResult<Value>> {
        if !matches!(
            method,
            "previewSshRemote"
                | "listKubernetesContexts"
                | "listKubernetesNamespaces"
                | "listKubernetesPods"
                | "previewKubernetesRemote"
                | "previewPersistentRelay"
                | "deployRemote"
                | "cancelRemotePreview"
        ) {
            return None;
        }
        let _lease = self.operations.read().await;
        if self.closing.load(Ordering::Acquire) {
            return Some(Err(cancelled()));
        }
        let cancellation = match self.cancellation.lock() {
            Ok(token) => token.clone(),
            Err(_) => return Some(Err(remote_error("远程取消状态不可用"))),
        };
        let operation = async {
            match method {
                "previewSshRemote" => self.preview_ssh(args.first().unwrap_or(&Value::Null)).await,
                "listKubernetesContexts" => transport::list_contexts().await,
                "listKubernetesNamespaces" => match string_argument(args, 0) {
                    Ok(context) => transport::list_namespaces(context).await,
                    Err(error) => Err(error),
                },
                "listKubernetesPods" => {
                    match (string_argument(args, 0), string_argument(args, 1)) {
                        (Ok(context), Ok(namespace)) => {
                            transport::list_pods(context, namespace).await
                        }
                        (Err(error), _) | (_, Err(error)) => Err(error),
                    }
                }
                "previewKubernetesRemote" => {
                    self.preview_kube(args.first().unwrap_or(&Value::Null))
                        .await
                }
                "previewPersistentRelay" => {
                    self.preview_persistent(args.first().unwrap_or(&Value::Null))
                        .await
                }
                "deployRemote" => match string_argument(args, 0) {
                    Ok(id) => {
                        self.deploy(
                            id,
                            args.get(1).and_then(Value::as_bool).unwrap_or(false),
                            &cancellation,
                        )
                        .await
                    }
                    Err(error) => Err(error),
                },
                "cancelRemotePreview" => match string_argument(args, 0) {
                    Ok(id) => {
                        self.pending.lock().await.retain(|p| p.id != id);
                        Ok(Value::Null)
                    }
                    Err(error) => Err(error),
                },
                _ => Err(remote_error("不支持的远程操作")),
            }
        };
        let result = if method == "deployRemote" {
            operation.await
        } else {
            tokio::select! { _=cancellation.cancelled()=>Err(cancelled()), result=operation=>result }
        };
        Some(result)
    }

    async fn preview_ssh(&self, value: &Value) -> HostResult<Value> {
        let mut input: SshInput = parse(value)?;
        input.host = input.host.trim().into();
        input.username = input.username.trim().into();
        validate_host(&input.host, input.port, input.pid)?;
        bounded(&input.username, 1, 128)?;
        match &input.authentication {
            Authentication::Password { password } => bounded(password, 1, 65_536)?,
            Authentication::PrivateKey {
                private_key,
                passphrase,
            } => {
                bounded(private_key, 1, 1_048_576)?;
                bounded(passphrase, 0, 65_536)?;
            }
        }
        let transport = Transport::ssh(&input, None).await?;
        let result = async {
            let platform = transport.probe().await?;
            let fingerprint = transport
                .fingerprint()
                .ok_or_else(|| remote_error("SSH 主机密钥指纹不可用"))?;
            let destination = format!(
                "{}@{}:{} / PID {}",
                input.username, input.host, input.port, input.pid
            );
            self.create_preview(
                "SSH",
                destination,
                platform,
                Some(format!("SHA256:{fingerprint}")),
                input.pid,
                PreviewInput::Ssh(input, fingerprint),
            )
            .await
        }
        .await;
        transport.close().await;
        result
    }

    async fn preview_kube(&self, value: &Value) -> HostResult<Value> {
        let mut input: KubeInput = parse(value)?;
        input.context = input.context.trim().into();
        input.namespace = input.namespace.trim().into();
        input.pod = input.pod.trim().into();
        input.container = input.container.trim().into();
        validate_context(&input.context)?;
        for value in [&input.namespace, &input.pod, &input.container] {
            validate_resource(value)?;
        }
        validate_pid(input.pid)?;
        let transport = Transport::kubernetes(&input).await?;
        transport.require_container().await?;
        let platform = transport.probe().await?;
        let destination = format!(
            "{} / {} / {} / {} / PID {}",
            input.context, input.namespace, input.pod, input.container, input.pid
        );
        self.create_preview(
            "KUBERNETES",
            destination,
            platform,
            None,
            input.pid,
            PreviewInput::Kubernetes(input),
        )
        .await
    }

    async fn create_preview(
        &self,
        mode: &str,
        destination: String,
        platform: Platform,
        fingerprint: Option<String>,
        pid: u64,
        input: PreviewInput,
    ) -> HostResult<Value> {
        let id = Uuid::new_v4().to_string();
        let directory = format!("/tmp/tanwei-{id}");
        let components = self.components().await?;
        let preview = json!({"id":id,"mode":mode,"destination":destination,
            "platform":platform.platform,"architecture":platform.architecture,"javaVersion":platform.java_version,
            "fingerprint":fingerprint,"files":components,"remoteDirectory":directory,"riskLevel":"R2",
            "expiresAt":(Utc::now()+ChronoDuration::minutes(5)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true),
            "commands":[format!("umask 077; mkdir -p -- {directory}; chmod 700 -- {directory}"),
                format!("upload and verify {} bundled JVM components by SHA-256",components.len()),
                format!("java -jar <attach-helper> attach --pid {pid} --bootstrap <bootstrap> --agent <agent> --port <ephemeral> --secret <redacted>"),
                "java -jar <relay> --descriptor <0600-one-time-descriptor>",
                "forward a loopback-only ephemeral Relay port",
                format!("disconnect cleanup: stop Relay and remove {directory}")]});
        self.remember(Pending {
            id,
            expires: Instant::now() + PREVIEW_TTL,
            input,
            platform: Some(platform),
            components,
            directory,
        })
        .await;
        Ok(preview)
    }

    async fn preview_persistent(&self, value: &Value) -> HostResult<Value> {
        let mut input: PersistentInput = parse(value)?;
        input.host = input.host.trim().into();
        input.server_name = input.server_name.trim().into();
        input.display_name = input.display_name.trim().into();
        let (ca, client) = validate_credentials(&input)?;
        let id = Uuid::new_v4().to_string();
        let preview = json!({"id":id,"mode":"PERSISTENT","destination":format!("{}:{} / PID {}",input.host,input.port,input.pid),
            "serverName":input.server_name,"pid":input.pid,"caFingerprint":ca,"clientFingerprint":client,"riskLevel":"R2",
            "expiresAt":(Utc::now()+ChronoDuration::minutes(5)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
        self.remember(Pending {
            id,
            expires: Instant::now() + PREVIEW_TTL,
            input: PreviewInput::Persistent(input),
            platform: None,
            components: Vec::new(),
            directory: String::new(),
        })
        .await;
        Ok(preview)
    }

    async fn remember(&self, pending: Pending) {
        let mut previews = self.pending.lock().await;
        previews.retain(|p| p.expires > Instant::now());
        while previews.len() >= 20 {
            previews.pop_front();
        }
        previews.push_back(pending);
    }

    async fn components(&self) -> HostResult<Vec<Component>> {
        let mut result = Vec::with_capacity(4);
        for id in COMPONENT_IDS {
            let path = self.paths.component(id)?;
            let mut file = tokio::fs::File::open(&path).await.map_err(remote_error)?;
            let metadata = file.metadata().await.map_err(remote_error)?;
            if !metadata.is_file() {
                return Err(remote_error("组件必须为普通文件"));
            }
            let mut hash = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                let count = file.read(&mut buffer).await.map_err(remote_error)?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| remote_error("组件文件名无效"))?
                .to_owned();
            if !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            {
                return Err(remote_error("组件文件名无效"));
            }
            result.push(Component {
                id: id.into(),
                path,
                name,
                size: metadata.len(),
                sha256: hex::encode(hash.finalize()),
            });
        }
        Ok(result)
    }

    async fn deploy(
        &self,
        id: &str,
        confirmed: bool,
        cancellation: &CancellationToken,
    ) -> HostResult<Value> {
        if !confirmed {
            return Err(HostError::new(
                "CONFIRMATION_REQUIRED",
                "远程部署属于 R2 操作，必须确认预览后才能继续",
            ));
        }
        let pending = {
            let mut previews = self.pending.lock().await;
            previews.retain(|p| p.expires > Instant::now());
            let index = previews.iter().position(|p| p.id == id).ok_or_else(|| {
                HostError::new(
                    "REMOTE_PREVIEW_EXPIRED",
                    "远程部署预览不存在、已过期或已经使用",
                )
            })?;
            previews
                .remove(index)
                .ok_or_else(|| remote_error("预览已被使用"))?
        };
        if let PreviewInput::Persistent(input) = &pending.input {
            validate_credentials(input)?;
            let target = json!({"id":stable_target_id("persistent",&format!("{}:{}/{}",input.host,input.port,input.server_name),input.pid),
                "pid":input.pid,"displayName":if input.display_name.is_empty(){format!("{} / PID {}",input.host,input.pid)}else{input.display_name.clone()},
                "mainClass":"Persistent Relay JVM","arguments":[],"javaPath":null,"javaVersion":null,"user":null,"startTime":null,"attachable":true,"attachReason":null});
            let host = input.host.trim_matches(['[', ']']);
            let host = if host.contains(':') {
                format!("[{host}]")
            } else {
                host.into()
            };
            return self
                .targets
                .connect_remote(
                    target,
                    format!("https://{host}:{}", input.port),
                    input.session_secret.clone(),
                    Some(RemoteTls {
                        server_name: input.server_name.clone(),
                        root_certificates: input.ca_certificate.as_bytes().to_vec(),
                        client_private_key: input.client_private_key.as_bytes().to_vec(),
                        client_certificate: input.client_certificate.as_bytes().to_vec(),
                    }),
                    None,
                )
                .await;
        }
        let connect_transport = async {
            match &pending.input {
                PreviewInput::Ssh(input, fingerprint) => {
                    Transport::ssh(input, Some(fingerprint.clone())).await
                }
                PreviewInput::Kubernetes(input) => Transport::kubernetes(input).await,
                PreviewInput::Persistent(_) => unreachable!(),
            }
        };
        let transport = Arc::new(
            tokio::select! { _=cancellation.cancelled()=>return Err(cancelled()), result=connect_transport=>result? },
        );
        let mut deployment = DeploymentGuard {
            transport: Some(transport.clone()),
            directory: pending.directory.clone(),
            relay_pid: None,
        };
        let result = tokio::select! {
            _=cancellation.cancelled()=>Err(cancelled()),
            result=self.deploy_transport(&pending, transport.clone(), &mut deployment)=>result,
        };
        deployment.close().await;
        let prepared = result?;
        self.targets
            .connect_remote(
                prepared.target,
                prepared.endpoint,
                prepared.secret,
                None,
                Some(prepared.cleanup),
            )
            .await
    }

    async fn deploy_transport(
        &self,
        pending: &Pending,
        transport: Arc<Transport>,
        deployment: &mut DeploymentGuard,
    ) -> HostResult<PreparedEndpoint> {
        transport.require_container().await?;
        let platform = transport.probe().await?;
        if pending.platform.as_ref() != Some(&platform) {
            return Err(remote_error("远程运行时身份在预览后发生变化，已拒绝部署"));
        }
        let components = self.components().await?;
        if components != pending.components {
            return Err(remote_error("组件在预览后发生变化，已拒绝部署"));
        }
        let directory = &pending.directory;
        transport
            .shell(
                &format!(
                    "umask 077; mkdir -p -- {} && chmod 700 -- {}",
                    quote(directory),
                    quote(directory)
                ),
                15,
            )
            .await?;
        for component in &components {
            let destination = format!("{directory}/{}", component.name);
            transport.upload(&component.path, &destination).await?;
            transport
                .verify_file(&destination, &component.sha256)
                .await?;
        }
        let path = |id: &str| -> HostResult<String> {
            components
                .iter()
                .find(|c| c.id == id)
                .map(|c| format!("{directory}/{}", c.name))
                .ok_or_else(|| remote_error("缺少 JVM 组件"))
        };
        let (pid, mode, identity, display, user) = match &pending.input {
            PreviewInput::Ssh(i, _) => (
                i.pid,
                "ssh",
                format!("{}@{}:{}", i.username, i.host, i.port),
                format!("{} / PID {}", i.host, i.pid),
                Some(i.username.clone()),
            ),
            PreviewInput::Kubernetes(i) => (
                i.pid,
                "kubernetes",
                format!("{}/{}/{}/{}", i.context, i.namespace, i.pod, i.container),
                format!("{}/{} / PID {}", i.pod, i.container, i.pid),
                None,
            ),
            PreviewInput::Persistent(_) => unreachable!(),
        };
        let upstream_port = rand::thread_rng().gen_range(30_000u16..=60_000);
        let mut relay_port = rand::thread_rng().gen_range(30_000u16..=60_000);
        while relay_port == upstream_port {
            relay_port = rand::thread_rng().gen_range(30_000u16..=60_000);
        }
        let upstream_secret = random_secret();
        let relay_secret = random_secret();
        transport.shell(&format!("java -jar {} attach --pid {pid} --bootstrap {} --agent {} --port {upstream_port} --secret {upstream_secret}",quote(&path("attach-helper")?),quote(&path("bootstrap")?),quote(&path("agent")?)),60).await?;
        let descriptor_path = format!("{directory}/relay.properties");
        let descriptor = format!("listen.port={relay_port}\nupstream.port={upstream_port}\nsession.secret={relay_secret}\nupstream.secret={upstream_secret}\n");
        transport
            .write(&descriptor_path, descriptor.as_bytes())
            .await?;
        let log = format!("{directory}/relay.log");
        let started = transport
            .shell(
                &format!(
                    "nohup java -jar {} --descriptor {} > {} 2>&1 < /dev/null & echo $!",
                    quote(&path("relay")?),
                    quote(&descriptor_path),
                    quote(&log)
                ),
                15,
            )
            .await?;
        let process_id = started
            .stdout
            .trim()
            .parse::<u64>()
            .map_err(|_| remote_error("Relay 未返回有效进程标识"))?;
        validate_pid(process_id)?;
        deployment.relay_pid = Some(process_id);
        transport.wait_relay(&log).await?;
        let forwarding = transport.clone().forward(relay_port).await?;
        let port = forwarding.port;
        let cleanup_transport = transport.clone();
        let cleanup_directory = directory.clone();
        let cleanup: RemoteCleanup = Box::new(move || {
            Box::pin(async move {
                forwarding.close().await;
                cleanup_transport
                    .cleanup(&cleanup_directory, Some(process_id))
                    .await;
                cleanup_transport.close().await;
                Ok(())
            })
        });
        // TargetManager now owns cleanup, including handshake failures. Do not
        // run a second kill after it returns (the remote PID could be reused).
        deployment.transport = None;
        let target = json!({"id":stable_target_id(mode,&identity,pid),"pid":pid,"displayName":display,"mainClass":"Remote JVM",
            "arguments":[],"javaPath":null,"javaVersion":platform.java_version,"user":user,"startTime":null,"attachable":true,"attachReason":null});
        Ok(PreparedEndpoint {
            target,
            endpoint: format!("http://127.0.0.1:{port}"),
            secret: relay_secret,
            cleanup,
        })
    }
}

fn cancelled() -> HostError {
    HostError::new("REMOTE_OPERATION_CANCELLED", "远程操作已取消，应用正在关闭")
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
pub(super) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
pub(super) fn stable_target_id(mode: &str, identity: &str, pid: u64) -> String {
    format!(
        "remote:{mode}:{}",
        &hex::encode(Sha256::digest(
            format!("{mode}\0{identity}\0{pid}").as_bytes()
        ))[..24]
    )
}
pub(super) fn safe_directory(value: &str) -> bool {
    value.strip_prefix("/tmp/tanwei-").is_some_and(|id| {
        id.len() == 36
            && id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-')
    })
}
pub(super) fn normalize_platform(
    system: &str,
    architecture: &str,
    java: &str,
) -> HostResult<Platform> {
    let platform = match system.trim().to_ascii_lowercase().as_str() {
        "linux" => "linux",
        "darwin" => "darwin",
        _ => return Err(remote_error("远程系统不受支持")),
    };
    let architecture = match architecture.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" => "x64",
        "aarch64" | "arm64" => "arm64",
        _ => return Err(remote_error("远程架构不受支持")),
    };
    let java_version = java
        .lines()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .ok_or_else(|| remote_error("远程目标未返回 Java 版本"))?;
    Ok(Platform {
        platform: platform.into(),
        architecture: architecture.into(),
        java_version: java_version.into(),
    })
}
fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> HostResult<T> {
    serde_json::from_value(value.clone())
        .map_err(|_| HostError::new("INVALID_INPUT", "远程连接参数无效"))
}
fn bounded(value: &str, min: usize, max: usize) -> HostResult<()> {
    let n = value.encode_utf16().count();
    if n < min || n > max {
        Err(HostError::new("INVALID_INPUT", "参数长度超出范围"))
    } else {
        Ok(())
    }
}
fn validate_pid(pid: u64) -> HostResult<()> {
    if pid == 0 || pid > MAX_PID {
        Err(HostError::new("INVALID_INPUT", "PID 无效"))
    } else {
        Ok(())
    }
}
fn validate_host(host: &str, port: u16, pid: u64) -> HostResult<()> {
    bounded(host, 1, 253)?;
    validate_pid(pid)?;
    if port == 0
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:[]-".contains(&b))
    {
        return Err(HostError::new("INVALID_INPUT", "主机或端口无效"));
    }
    Ok(())
}
pub(super) fn validate_context(value: &str) -> HostResult<()> {
    bounded(value, 1, 512)?;
    if value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Err(HostError::new("INVALID_INPUT", "Kubernetes Context 无效"));
    }
    Ok(())
}
pub(super) fn validate_resource(value: &str) -> HostResult<()> {
    bounded(value, 1, 253)?;
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"._:/@-".contains(&b))
    {
        return Err(HostError::new("INVALID_INPUT", "Kubernetes 资源名称无效"));
    }
    Ok(())
}
fn string_argument(args: &[Value], index: usize) -> HostResult<&str> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::new("INVALID_INPUT", "缺少远程操作参数"))
}

fn validate_credentials(input: &PersistentInput) -> HostResult<(String, String)> {
    validate_host(&input.host, input.port, input.pid)?;
    bounded(&input.server_name, 1, 253)?;
    bounded(&input.display_name, 0, 200)?;
    if !input
        .server_name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || input.session_secret.len() != 64
        || !input
            .session_secret
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(remote_error("持久 Relay 服务名或会话密钥无效"));
    }
    for pem in [
        &input.ca_certificate,
        &input.client_certificate,
        &input.client_private_key,
    ] {
        bounded(pem, 80, 1_048_576)?;
    }
    let ca = X509::from_pem(input.ca_certificate.as_bytes()).map_err(remote_error)?;
    let client = X509::from_pem(input.client_certificate.as_bytes()).map_err(remote_error)?;
    let now = Asn1Time::from_unix(Utc::now().timestamp()).map_err(remote_error)?;
    if client.not_before() > now.as_ref() || client.not_after() <= now.as_ref() {
        return Err(remote_error("客户端证书尚未生效或已经过期"));
    }
    let key =
        PKey::private_key_from_pem(input.client_private_key.as_bytes()).map_err(remote_error)?;
    if !client.public_key().map_err(remote_error)?.public_eq(&key) {
        return Err(remote_error("客户端证书与私钥不匹配"));
    }
    let fingerprint = |cert: &X509| -> HostResult<String> {
        Ok(cert
            .digest(MessageDigest::sha256())
            .map_err(remote_error)?
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":"))
    };
    Ok((fingerprint(&ca)?, fingerprint(&client)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_and_cleanup_are_bounded() {
        assert_eq!(quote("a'b"), "'a'\"'\"'b'");
        assert!(!safe_directory("/tmp/tanwei-../"));
        assert!(!safe_directory("/tmp"));
        assert!(safe_directory(
            "/tmp/tanwei-123e4567-e89b-12d3-a456-426614174000"
        ));
    }
    #[test]
    fn platform_is_normalized() {
        let p =
            normalize_platform("Linux\n", "aarch64\n", "\nopenjdk version \"21\"\nmore").unwrap();
        assert_eq!(p.architecture, "arm64");
        assert_eq!(p.java_version, "openjdk version \"21\"");
        assert!(normalize_platform("Windows", "x86_64", "21").is_err());
    }
    #[test]
    fn target_identity_is_stable_and_separated() {
        assert_eq!(
            stable_target_id("ssh", "u@host:22", 1),
            stable_target_id("ssh", "u@host:22", 1)
        );
        assert_ne!(
            stable_target_id("ssh", "u@host:22", 1),
            stable_target_id("kubernetes", "u@host:22", 1)
        );
    }

    #[test]
    fn remote_input_rejects_unknown_fields_and_invalid_boundaries() {
        assert!(parse::<SshInput>(&json!({"host":"localhost","port":22,"username":"user","pid":1,"authentication":{"kind":"PASSWORD","password":"secret"},"command":"id"})).is_err());
        assert!(validate_host("localhost;id", 22, 1).is_err());
        assert!(validate_host("localhost", 0, 1).is_err());
        assert!(validate_pid(MAX_PID + 1).is_err());
        assert!(validate_context("bad\ncontext").is_err());
        assert!(validate_resource("pod; id").is_err());
    }

    fn persistent_fixture(expired: bool) -> PersistentInput {
        use openssl::x509::X509NameBuilder;
        let key = PKey::generate_ed25519().unwrap();
        let mut name = X509NameBuilder::new().unwrap();
        name.append_entry_by_text("CN", "tanwei-test").unwrap();
        let name = name.build();
        let mut builder = X509::builder().unwrap();
        builder.set_version(2).unwrap();
        builder.set_subject_name(&name).unwrap();
        builder.set_issuer_name(&name).unwrap();
        builder.set_pubkey(&key).unwrap();
        builder
            .set_not_before(&Asn1Time::from_unix(Utc::now().timestamp() - 3600).unwrap())
            .unwrap();
        builder
            .set_not_after(
                &Asn1Time::from_unix(Utc::now().timestamp() + if expired { -1 } else { 3600 })
                    .unwrap(),
            )
            .unwrap();
        builder.sign(&key, MessageDigest::null()).unwrap();
        let certificate = String::from_utf8(builder.build().to_pem().unwrap()).unwrap();
        PersistentInput {
            host: "localhost".into(),
            port: 8443,
            server_name: "tanwei-test".into(),
            ca_certificate: certificate.clone(),
            client_certificate: certificate,
            client_private_key: String::from_utf8(key.private_key_to_pem_pkcs8().unwrap()).unwrap(),
            session_secret: "a".repeat(64),
            pid: 1,
            display_name: "".into(),
        }
    }

    #[test]
    fn persistent_credentials_require_live_matching_certificate_and_key() {
        let mut input = persistent_fixture(false);
        let (ca, client) = validate_credentials(&input).unwrap();
        assert_eq!(ca, client);
        assert!(validate_credentials(&persistent_fixture(true)).is_err());
        input.client_private_key = persistent_fixture(false).client_private_key;
        assert!(validate_credentials(&input).is_err());
    }

    #[tokio::test]
    async fn shutdown_erases_previews_rejects_new_work_and_can_resume() {
        let paths = Arc::new(RuntimePaths {
            resources: PathBuf::new(),
            user_data: PathBuf::new(),
            version: "0.1.0".into(),
            development: true,
        });
        let manager = RemoteManager::new(paths.clone(), Arc::new(TargetManager::new(paths)));
        let preview=manager.preview_persistent(&serde_json::to_value(json!({
            "host":"localhost","port":8443,"serverName":"tanwei-test","caCertificate":persistent_fixture(false).ca_certificate,
            "clientCertificate":"invalid","clientPrivateKey":"invalid","sessionSecret":"a".repeat(64),"pid":1,"displayName":""
        })).unwrap()).await;
        assert!(preview.is_err());
        for index in 0..25 {
            manager
                .remember(Pending {
                    id: index.to_string(),
                    expires: Instant::now() + PREVIEW_TTL,
                    input: PreviewInput::Persistent(persistent_fixture(false)),
                    platform: None,
                    components: vec![],
                    directory: String::new(),
                })
                .await;
        }
        assert_eq!(manager.pending.lock().await.len(), 20);
        manager.close_all().await;
        assert!(manager.pending.lock().await.is_empty());
        let error = manager
            .dispatch("listKubernetesContexts", &[])
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "REMOTE_OPERATION_CANCELLED");
        manager.resume_after_close().await.unwrap();
        assert!(manager
            .dispatch("cancelRemotePreview", &[Uuid::new_v4().to_string().into()])
            .await
            .unwrap()
            .is_ok());
    }
}
