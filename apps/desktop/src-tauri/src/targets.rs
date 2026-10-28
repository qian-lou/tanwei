//! JVM discovery, authenticated gRPC, and generation-scoped connection ownership.
//!
//! Each session owns its cancellation token and remote forwarding cleanup. A late
//! handshake can never publish into a replacement session. Calls clone the tonic
//! channel, so long actions do not serialize heartbeat or cancellation requests.
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Mutex, Notify},
    time::{timeout, Instant},
};
use tokio_util::sync::CancellationToken;
use tonic::{
    metadata::{Ascii, MetadataValue},
    transport::{Certificate, Channel, ClientTlsConfig, Endpoint, Identity},
    Request, Response, Status,
};
use uuid::Uuid;

use crate::{
    common::{HostError, HostResult, RuntimePaths, PROTOCOL_VERSION},
    proto::{self, diagnostic_service_client::DiagnosticServiceClient},
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const ATTACH_TIMEOUT: Duration = Duration::from_secs(15);
const ARTIFACT_TIMEOUT: Duration = Duration::from_secs(600);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub type RemoteCleanup =
    Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = HostResult<()>> + Send>> + Send>;

pub struct RemoteTls {
    pub server_name: String,
    pub root_certificates: Vec<u8>,
    pub client_private_key: Vec<u8>,
    pub client_certificate: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetDescriptor {
    id: String,
    pid: i64,
    display_name: String,
    main_class: String,
    arguments: Vec<String>,
    java_path: Option<String>,
    java_version: Option<String>,
    user: Option<String>,
    start_time: Option<String>,
    attachable: bool,
    attach_reason: Option<String>,
}

struct ActiveAgent {
    client: DiagnosticServiceClient<Channel>,
    secret: MetadataValue<Ascii>,
    cancel: CancellationToken,
    shutdown_on_disconnect: bool,
}

struct Session {
    generation: u64,
    target: TargetDescriptor,
    cancel: CancellationToken,
    connection: Mutex<Value>,
    active: Mutex<Option<Arc<ActiveAgent>>>,
    cleanup: Mutex<Option<RemoteCleanup>>,
    completed: AtomicBool,
    completion_error: Mutex<Option<HostError>>,
    finished: Notify,
}

#[derive(Clone)]
pub struct TargetManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    paths: Arc<RuntimePaths>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    generation: AtomicU64,
    closing: AtomicBool,
    store: OnceLock<Arc<crate::storage::Storage>>,
    close_barrier: Mutex<()>,
}

enum ConnectionPlan {
    Local,
    Remote {
        endpoint: String,
        secret: String,
        tls: Option<RemoteTls>,
    },
}

impl TargetManager {
    pub fn new(paths: Arc<RuntimePaths>) -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                paths,
                sessions: Mutex::new(HashMap::new()),
                generation: AtomicU64::new(0),
                closing: AtomicBool::new(false),
                store: OnceLock::new(),
                close_barrier: Mutex::new(()),
            }),
        }
    }

    pub fn set_store(&self, store: Arc<crate::storage::Storage>) -> HostResult<()> {
        if let Some(current) = self.inner.store.get() {
            if Arc::ptr_eq(current, &store) {
                return Ok(());
            }
            return Err(HostError::new(
                "WORKSPACE_ALREADY_BOUND",
                "目标管理器已绑定其他工作区",
            ));
        }
        self.inner
            .store
            .set(store)
            .map_err(|_| HostError::new("WORKSPACE_ALREADY_BOUND", "目标管理器已绑定工作区"))
    }

    pub async fn dispatch(&self, method: &str, args: &[Value]) -> Option<HostResult<Value>> {
        if !matches!(
            method,
            "listTargets"
                | "listConnections"
                | "connectTarget"
                | "disconnectTarget"
                | "getSnapshot"
                | "listThreads"
                | "listClasses"
                | "getClassDetails"
                | "executeAction"
                | "getObservationEvents"
                | "cancelObservation"
                | "inspectExitImpact"
        ) {
            return None;
        }
        Some(self.call(method, args).await)
    }

    pub async fn call(&self, method: &str, args: &[Value]) -> HostResult<Value> {
        match method {
            "listTargets" => self.list_targets().await,
            "listConnections" => Ok(self.list_connections().await),
            "connectTarget" => self.connect_target(argument(args, 0)?).await,
            "disconnectTarget" => {
                self.disconnect(argument(args, 0)?).await?;
                Ok(Value::Null)
            }
            "getSnapshot" => self.snapshot(argument(args, 0)?).await,
            "listThreads" => {
                self.list_threads(
                    argument(args, 0)?,
                    args.get(1).ok_or_else(invalid_arguments)?,
                )
                .await
            }
            "listClasses" => {
                self.list_classes(
                    argument(args, 0)?,
                    args.get(1).ok_or_else(invalid_arguments)?,
                )
                .await
            }
            "getClassDetails" => {
                self.class_details(argument(args, 0)?, argument(args, 1)?, argument(args, 2)?)
                    .await
            }
            "executeAction" => {
                self.execute_action(args.first().ok_or_else(invalid_arguments)?)
                    .await
            }
            "getObservationEvents" => {
                self.observation_events(argument(args, 0)?, argument(args, 1)?)
                    .await
            }
            "cancelObservation" => {
                self.cancel_observation(argument(args, 0)?, argument(args, 1)?)
                    .await
            }
            "inspectExitImpact" => self.inspect_exit_impact().await,
            _ => Err(HostError::new(
                "UNKNOWN_METHOD",
                format!("未知目标操作：{method}"),
            )),
        }
    }

    pub async fn connection(&self, target_id: &str) -> Option<Value> {
        let session = self.inner.sessions.lock().await.get(target_id).cloned()?;
        let connection = session.connection.lock().await.clone();
        Some(connection)
    }

    pub async fn list_connections(&self) -> Value {
        let mut sessions: Vec<_> = self.inner.sessions.lock().await.values().cloned().collect();
        sessions.sort_by_key(|session| session.generation);
        let mut connections = Vec::with_capacity(sessions.len());
        for session in sessions {
            connections.push(session.connection.lock().await.clone());
        }
        Value::Array(connections)
    }

    pub async fn list_targets(&self) -> HostResult<Value> {
        let helper = self.inner.paths.component("attach-helper")?;
        let mut command = Command::new(self.inner.paths.java());
        command.arg("-jar").arg(helper).args(["list", "--json"]);
        let output = run_command(
            command,
            Duration::from_secs(10),
            4 * 1024 * 1024,
            &CancellationToken::new(),
            "TARGET_DISCOVERY_FAILED",
        )
        .await?;
        let targets: Vec<TargetDescriptor> = serde_json::from_slice(&output)
            .map_err(|error| HostError::new("TARGET_DISCOVERY_FAILED", error.to_string()))?;
        for target in &targets {
            validate_target(target)?;
        }
        serde_json::to_value(targets)
            .map_err(|error| HostError::new("TARGET_DISCOVERY_FAILED", error.to_string()))
    }

    pub async fn connect_target(&self, target_id: &str) -> HostResult<Value> {
        let pid =
            local_pid(target_id).ok_or_else(|| HostError::new("INVALID_TARGET", "目标标识无效"))?;
        if let Some(connection) = self.connection(target_id).await {
            if connection["state"] == "READY" {
                return Ok(connection);
            }
        }
        let targets = self.list_targets().await?;
        let target_value = targets
            .as_array()
            .and_then(|items| items.iter().find(|target| target["id"] == target_id))
            .cloned()
            .ok_or_else(|| {
                HostError::new(
                    "TARGET_NOT_FOUND",
                    format!("Java 进程 {pid} 已退出或不可见"),
                )
            })?;
        let target: TargetDescriptor = serde_json::from_value(target_value)
            .map_err(|error| HostError::new("INVALID_TARGET", error.to_string()))?;
        if !target.attachable {
            return Err(HostError::new(
                "TARGET_NOT_ATTACHABLE",
                target
                    .attach_reason
                    .clone()
                    .unwrap_or_else(|| "当前进程不可 Attach".into()),
            ));
        }
        self.connect(target, ConnectionPlan::Local, None).await
    }

    pub async fn connect_remote(
        &self,
        target: Value,
        endpoint: String,
        secret: String,
        tls: Option<RemoteTls>,
        cleanup: Option<RemoteCleanup>,
    ) -> HostResult<Value> {
        let parsed = serde_json::from_value::<TargetDescriptor>(target)
            .map_err(|error| HostError::new("INVALID_REMOTE_TARGET", error.to_string()));
        let validation = parsed.and_then(|target| {
            validate_target(&target)?;
            validate_remote_id(&target.id, tls.is_some())?;
            Ok(target)
        });
        match validation {
            Ok(target) => {
                self.connect(
                    target,
                    ConnectionPlan::Remote {
                        endpoint,
                        secret,
                        tls,
                    },
                    cleanup,
                )
                .await
            }
            Err(error) => {
                if let Some(cleanup) = cleanup {
                    let _ = cleanup().await;
                }
                Err(error)
            }
        }
    }

    async fn connect(
        &self,
        target: TargetDescriptor,
        plan: ConnectionPlan,
        cleanup: Option<RemoteCleanup>,
    ) -> HostResult<Value> {
        if self.inner.closing.load(Ordering::Acquire) {
            if let Some(cleanup) = cleanup {
                let _ = cleanup().await;
            }
            return Err(cancelled());
        }
        let mut records = self.inner.sessions.lock().await;
        // close_all marks closing before taking this same registry lock. Recheck
        // inside it so a connect racing shutdown cannot escape the drained set.
        if self.inner.closing.load(Ordering::Acquire) {
            drop(records);
            if let Some(cleanup) = cleanup {
                let _ = cleanup().await;
            }
            return Err(cancelled());
        }
        if let Some(existing) = records.get(&target.id).cloned() {
            if !existing.completed.load(Ordering::Acquire) || existing.active.lock().await.is_some()
            {
                drop(records);
                if let Some(cleanup) = cleanup {
                    cleanup().await?;
                }
                return wait_for_connection(&existing).await;
            }
        }
        let session = Arc::new(Session {
            generation: self.inner.generation.fetch_add(1, Ordering::Relaxed),
            connection: Mutex::new(
                json!({"target":target,"state":"CONNECTING","protocolVersion":null,"agentVersion":null,"javaVersion":null,"capabilities":[],"connectedAt":null,"errorCode":null,"errorMessage":null}),
            ),
            target,
            cancel: CancellationToken::new(),
            active: Mutex::new(None),
            cleanup: Mutex::new(cleanup),
            completed: AtomicBool::new(false),
            completion_error: Mutex::new(None),
            finished: Notify::new(),
        });
        records.insert(session.target.id.clone(), session.clone());
        drop(records);
        let manager = self.clone();
        let connecting = session.clone();
        tokio::spawn(async move {
            manager.establish(connecting, plan).await;
        });
        wait_for_connection(&session).await
    }

    async fn establish(&self, session: Arc<Session>, plan: ConnectionPlan) {
        let result = self.activate(&session, plan).await;
        match result {
            Ok((active, connection)) => {
                if session.cancel.is_cancelled() || !self.is_current(&session).await {
                    close_active(&active).await;
                    *session.completion_error.lock().await = Some(cancelled());
                    let _ = cleanup_session(&session).await;
                } else {
                    *session.active.lock().await = Some(active.clone());
                    *session.connection.lock().await = connection;
                    let manager = self.clone();
                    let heartbeat_session = session.clone();
                    tokio::spawn(async move {
                        manager.heartbeat(heartbeat_session, active).await;
                    });
                }
            }
            Err(error) => {
                let error = if session.cancel.is_cancelled() {
                    cancelled()
                } else {
                    error
                };
                let mut connection = session.connection.lock().await;
                connection["state"] = json!("DISCONNECTED");
                connection["errorCode"] = json!(error.code);
                connection["errorMessage"] = json!(error.message);
                drop(connection);
                *session.completion_error.lock().await = Some(error);
                let _ = cleanup_session(&session).await;
            }
        }
        session.completed.store(true, Ordering::Release);
        session.finished.notify_waiters();
    }

    async fn is_current(&self, session: &Session) -> bool {
        self.inner
            .sessions
            .lock()
            .await
            .get(&session.target.id)
            .is_some_and(|current| current.generation == session.generation)
    }

    async fn activate(
        &self,
        session: &Session,
        plan: ConnectionPlan,
    ) -> HostResult<(Arc<ActiveAgent>, Value)> {
        let (address, secret, tls) = match plan {
            ConnectionPlan::Local => {
                let helper = self.inner.paths.component("attach-helper")?;
                let bootstrap = self.inner.paths.component("bootstrap")?;
                let agent = self.inner.paths.component("agent")?;
                let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                    .await
                    .map_err(|error| HostError::new("ATTACH_FAILED", error.to_string()))?;
                let port = listener
                    .local_addr()
                    .map_err(|error| HostError::new("ATTACH_FAILED", error.to_string()))?
                    .port();
                drop(listener);
                let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                let (executable, prefix) = attach_helper_invocation(
                    self.inner.paths.java(),
                    session.target.java_path.as_deref(),
                    &helper,
                )
                .await;
                let mut command = Command::new(executable);
                command
                    .args(prefix)
                    .arg("attach")
                    .arg("--pid")
                    .arg(session.target.pid.to_string())
                    .arg("--bootstrap")
                    .arg(bootstrap)
                    .arg("--agent")
                    .arg(agent)
                    .arg("--port")
                    .arg(port.to_string())
                    .arg("--secret")
                    .arg(&secret);
                run_command(
                    command,
                    ATTACH_TIMEOUT,
                    1024 * 1024,
                    &session.cancel,
                    "ATTACH_FAILED",
                )
                .await?;
                (format!("http://127.0.0.1:{port}"), secret, None)
            }
            ConnectionPlan::Remote {
                endpoint,
                secret,
                tls,
            } => (endpoint, secret, tls),
        };
        let shutdown_on_disconnect = tls.is_none();
        let mut endpoint = Endpoint::from_shared(address)
            .map_err(|error| HostError::new("INVALID_REMOTE_ENDPOINT", error.to_string()))?
            .connect_timeout(HANDSHAKE_TIMEOUT);
        if let Some(tls) = tls {
            endpoint = endpoint
                .tls_config(
                    ClientTlsConfig::new()
                        .domain_name(tls.server_name)
                        .ca_certificate(Certificate::from_pem(tls.root_certificates))
                        .identity(Identity::from_pem(
                            tls.client_certificate,
                            tls.client_private_key,
                        )),
                )
                .map_err(|error| {
                    HostError::new("PERSISTENT_RELAY_TLS_INVALID", error.to_string())
                })?;
        }
        let secret = secret
            .parse()
            .map_err(|_| HostError::new("INVALID_REMOTE_ENDPOINT", "Agent 认证密钥包含非法字符"))?;
        let channel = endpoint.connect_lazy();
        let active = Arc::new(ActiveAgent {
            client: DiagnosticServiceClient::new(channel),
            secret,
            cancel: session.cancel.clone(),
            shutdown_on_disconnect,
        });
        let capabilities = probe(&active, session.target.pid).await?;
        let connection = json!({ "target":session.target, "state":"READY", "protocolVersion":capabilities.protocol_version, "agentVersion":capabilities.agent_version, "javaVersion":capabilities.java_version, "capabilities": capabilities.capabilities.into_iter().map(|capability| json!({"id":capability.id,"state":capability.state,"reason":nullable_string(capability.reason)})).collect::<Vec<_>>(), "connectedAt":now(), "errorCode":null, "errorMessage":null });
        Ok((active, connection))
    }

    async fn heartbeat(&self, session: Arc<Session>, active: Arc<ActiveAgent>) {
        let mut failure_count = 0;
        loop {
            tokio::select! { _ = session.cancel.cancelled() => return, _ = tokio::time::sleep(HEARTBEAT_INTERVAL) => {} }
            let result = probe(&active, session.target.pid).await;
            if session.cancel.is_cancelled() || !self.is_current(&session).await {
                return;
            }
            match result {
                Ok(_) if failure_count == 0 => continue,
                Ok(_) => {
                    failure_count = 0;
                    let mut connection = session.connection.lock().await;
                    connection["state"] = json!("READY");
                    connection["errorCode"] = Value::Null;
                    connection["errorMessage"] = Value::Null;
                }
                Err(error) => {
                    failure_count += 1;
                    let mut connection = session.connection.lock().await;
                    connection["state"] = json!(match failure_count {
                        1 => "DEGRADED",
                        2 => "RECONNECTING",
                        _ => "DISCONNECTED",
                    });
                    connection["errorCode"] = json!("AGENT_HEARTBEAT_FAILED");
                    connection["errorMessage"] = json!(error.message);
                    drop(connection);
                    if failure_count >= 3 {
                        session.cancel.cancel();
                        if let Some(active) = session.active.lock().await.take() {
                            close_active(&active).await;
                        }
                        let _ = cleanup_session(&session).await;
                        return;
                    }
                }
            }
        }
    }

    pub async fn disconnect(&self, target_id: &str) -> HostResult<()> {
        let session = self.inner.sessions.lock().await.remove(target_id);
        if let Some(session) = session {
            session.cancel.cancel();
            wait_for_completion(&session).await;
            if let Some(active) = session.active.lock().await.take() {
                close_active(&active).await;
            }
            cleanup_session(&session).await?;
        } else if local_pid(target_id).is_none() {
            return Err(HostError::new("INVALID_TARGET", "目标标识无效"));
        }
        Ok(())
    }

    pub async fn close_all(&self) {
        let _closing = self.inner.close_barrier.lock().await;
        self.inner.closing.store(true, Ordering::Release);
        let sessions: Vec<_> = self
            .inner
            .sessions
            .lock()
            .await
            .drain()
            .map(|(_, session)| session)
            .collect();
        let mut closing = tokio::task::JoinSet::new();
        for session in sessions {
            session.cancel.cancel();
            closing.spawn(async move {
                wait_for_completion(&session).await;
                if let Some(active) = session.active.lock().await.take() {
                    close_active(&active).await;
                }
                let _ = cleanup_session(&session).await;
            });
        }
        while closing.join_next().await.is_some() {}
    }

    /// Permit fresh sessions after a failed update only once old cleanup has
    /// completed. Old sessions retain their permanently cancelled tokens.
    pub async fn resume_after_close(&self) -> HostResult<()> {
        let _closing = self.inner.close_barrier.lock().await;
        if !self.inner.sessions.lock().await.is_empty() {
            return Err(HostError::new(
                "TARGET_SESSIONS_ACTIVE",
                "目标会话尚未完成退出清理",
            ));
        }
        self.inner.closing.store(false, Ordering::Release);
        Ok(())
    }

    async fn require_active(&self, target_id: &str) -> HostResult<Arc<ActiveAgent>> {
        let session = self
            .inner
            .sessions
            .lock()
            .await
            .get(target_id)
            .cloned()
            .ok_or_else(|| {
                HostError::new("TARGET_NOT_CONNECTED", "请先连接目标 JVM，再执行诊断操作")
            })?;
        if session.connection.lock().await["state"] != "READY" {
            return Err(HostError::new(
                "TARGET_NOT_READY",
                "目标 JVM 连接暂时不可用，请等待心跳恢复或重新连接",
            ));
        }
        let active = session.active.lock().await.clone().ok_or_else(|| {
            HostError::new("TARGET_NOT_CONNECTED", "请先连接目标 JVM，再执行诊断操作")
        })?;
        if active.cancel.is_cancelled() {
            return Err(cancelled());
        }
        Ok(active)
    }

    pub async fn snapshot(&self, target_id: &str) -> HostResult<Value> {
        let active = self.require_active(target_id).await?;
        let mut client = active.client.clone();
        let response = rpc(
            &active,
            client.get_snapshot(request(
                &active,
                proto::SnapshotRequest {
                    context: Some(context(None)),
                },
                HANDSHAKE_TIMEOUT,
            )),
            HANDSHAKE_TIMEOUT,
            "SNAPSHOT_FAILED",
        )
        .await?;
        snapshot_value(target_id, response)
    }

    pub async fn list_threads(&self, target_id: &str, query: &Value) -> HostResult<Value> {
        validate_page_query(query, true)?;
        let active = self.require_active(target_id).await?;
        let mut client = active.client.clone();
        let state = string_field(query, "state")?;
        if ![
            "",
            "NEW",
            "RUNNABLE",
            "BLOCKED",
            "WAITING",
            "TIMED_WAITING",
            "TERMINATED",
        ]
        .contains(&state)
        {
            return Err(invalid_arguments());
        }
        let response = rpc(
            &active,
            client.list_threads(request(
                &active,
                proto::ThreadListRequest {
                    context: Some(context(None)),
                    offset: integer_field(query, "offset", 0, 1_000_000)?,
                    limit: integer_field(query, "limit", 1, 1000)?,
                    stack_depth: integer_field(query, "stackDepth", 0, 256)?,
                    name_query: string_field(query, "query")?.into(),
                    state_filter: state.into(),
                },
                HANDSHAKE_TIMEOUT,
            )),
            HANDSHAKE_TIMEOUT,
            "THREAD_LIST_FAILED",
        )
        .await?;
        nonnegative(response.total.into(), "threads.total")?;
        nonnegative(response.offset.into(), "threads.offset")?;
        let mut items = Vec::with_capacity(response.threads.len());
        for thread in response.threads {
            if thread.id <= 0 {
                return Err(invalid_response("线程 ID 无效"));
            }
            safe_integer(thread.id, "thread.id")?;
            safe_integer(thread.cpu_time_nanos, "thread.cpuTimeNanos")?;
            safe_integer(thread.lock_owner_id, "thread.lockOwnerId")?;
            items.push(json!({ "id":thread.id,"name":thread.name,"state":thread.state,"daemon":thread.daemon,"priority":thread.priority,"cpuTimeNanos":if thread.has_cpu_time {json!(thread.cpu_time_nanos)} else {Value::Null},"deadlocked":thread.deadlocked,"lockName":nullable_string(thread.lock_name),"lockOwnerId":if thread.lock_owner_id>=0 {json!(thread.lock_owner_id)} else {Value::Null},"stack":thread.stack }));
        }
        Ok(json!({"total":response.total,"offset":response.offset,"items":items}))
    }

    pub async fn list_classes(&self, target_id: &str, query: &Value) -> HostResult<Value> {
        validate_page_query(query, false)?;
        let active = self.require_active(target_id).await?;
        let mut client = active.client.clone();
        let response = rpc(
            &active,
            client.list_classes(request(
                &active,
                proto::ClassListRequest {
                    context: Some(context(None)),
                    offset: integer_field(query, "offset", 0, 1_000_000)?,
                    limit: integer_field(query, "limit", 1, 1000)?,
                    name_query: string_field(query, "query")?.into(),
                },
                HANDSHAKE_TIMEOUT,
            )),
            HANDSHAKE_TIMEOUT,
            "CLASS_LIST_FAILED",
        )
        .await?;
        nonnegative(response.total_matches.into(), "classes.totalMatches")?;
        nonnegative(response.offset.into(), "classes.offset")?;
        Ok(
            json!({"total":response.total_matches,"offset":response.offset,"items":response.classes.into_iter().map(|class| json!({"name":class.name,"classLoader":class.class_loader,"module":nullable_string(class.module),"modifiable":class.modifiable})).collect::<Vec<_>>() }),
        )
    }

    pub async fn class_details(
        &self,
        target_id: &str,
        name: &str,
        class_loader: &str,
    ) -> HostResult<Value> {
        if name.is_empty()
            || name.len() > 1024
            || class_loader.is_empty()
            || class_loader.len() > 4096
        {
            return Err(invalid_arguments());
        }
        let active = self.require_active(target_id).await?;
        let mut client = active.client.clone();
        let response = rpc(
            &active,
            client.get_class_details(request(
                &active,
                proto::ClassDetailsRequest {
                    context: Some(context(None)),
                    name: name.into(),
                    class_loader: class_loader.into(),
                },
                HANDSHAKE_TIMEOUT,
            )),
            HANDSHAKE_TIMEOUT,
            "CLASS_DETAILS_FAILED",
        )
        .await?;
        if !response.found {
            return Err(HostError::new(
                if response.error_code.is_empty() {
                    "CLASS_NOT_FOUND".into()
                } else {
                    response.error_code
                },
                "目标类已卸载或类加载器身份发生变化",
            ));
        }
        Ok(
            json!({"name":response.name,"classLoader":response.class_loader,"codeSource":nullable_string(response.code_source),"modifiers":response.modifiers,"superClass":nullable_string(response.super_class),"interfaces":response.interfaces,"annotations":response.annotations,"methods":response.methods}),
        )
    }

    pub async fn execute_action(&self, input: &Value) -> HostResult<Value> {
        let target_id = string_field(input, "targetId")?;
        let action_id = string_field(input, "actionId")?;
        let active = self.require_active(target_id).await?;
        let connection = self.connection(target_id).await.ok_or_else(cancelled)?;
        let contract_version = match input.get("contractVersion") {
            None => "1.0",
            Some(value) => value.as_str().ok_or_else(invalid_arguments)?,
        };
        let parameters = input.get("parameters").ok_or_else(invalid_arguments)?;
        let maximum_risk = if let Some(store) = self.inner.store.get() {
            let settings = store.settings()?;
            let rows = store.query(
                "SELECT package_json FROM active_team_policy WHERE id=1",
                &[],
            )?;
            let team = match rows.first() {
                Some(row) => {
                    serde_json::from_str(row["package_json"].as_str().ok_or_else(|| {
                        HostError::new("TEAM_POLICY_INVALID", "已启用的团队策略数据无效")
                    })?)
                    .map_err(|_| {
                        HostError::new("TEAM_POLICY_INVALID", "已启用的团队策略数据无效")
                    })?
                }
                None => Value::Null,
            };
            crate::policy::effective_risk(
                action_id,
                settings["maximumRiskLevel"].as_str().unwrap_or("R2"),
                &team,
            )?
        } else {
            "R2".into()
        };
        let parameters = crate::policy::authorize(
            &connection,
            action_id,
            parameters,
            &maximum_risk,
            contract_version,
        )?;
        let contract = crate::policy::action_contract(action_id)
            .ok_or_else(|| HostError::new("ACTION_NOT_ALLOWED", "主进程策略不允许此 Action"))?;
        let risk = string_field(contract, "riskLevel")?;
        let timeout = if risk == "R0" || risk == "R1" {
            Duration::from_secs(30)
        } else {
            Duration::from_secs(600)
        };
        let parameters: HashMap<String, String> =
            serde_json::from_value(parameters).map_err(|_| {
                HostError::new("INVALID_ACTION_PARAMETERS", "Action 参数必须为字符串映射")
            })?;
        let task_id = Uuid::new_v4().to_string();
        let mut client = active.client.clone();
        let response = rpc(
            &active,
            client.execute_action(request(
                &active,
                proto::ActionRequest {
                    context: Some(context(Some(&task_id))),
                    action_id: action_id.into(),
                    parameters,
                },
                timeout,
            )),
            timeout,
            "ACTION_FAILED",
        )
        .await?;
        if !["SUCCEEDED", "FAILED"].contains(&response.status.as_str()) {
            return Err(invalid_response("Agent 返回无效的 Action 状态"));
        }
        let result = json!({"actionId":action_id,"taskId":task_id,"targetId":target_id,"riskLevel":risk,"status":response.status,"errorCode":nullable_string(response.error_code),"message":nullable_string(response.message),"values":response.values,"completedAt":now()});
        if !action_id.ends_with(".status") {
            if let Some(store) = self.inner.store.get() {
                store.insert_action_audit(&result)?;
            }
        }
        Ok(result)
    }

    pub async fn download_artifact(
        &self,
        target_id: &str,
        token: &str,
    ) -> HostResult<ArtifactStream> {
        if token.is_empty() || token.len() > 4096 {
            return Err(invalid_arguments());
        }
        let active = self.require_active(target_id).await?;
        let mut client = active.client.clone();
        let deadline = Instant::now() + ARTIFACT_TIMEOUT;
        let stream = rpc(
            &active,
            client.download_artifact(request(
                &active,
                proto::ArtifactDownloadRequest {
                    context: Some(context(None)),
                    token: token.into(),
                },
                ARTIFACT_TIMEOUT,
            )),
            ARTIFACT_TIMEOUT,
            "ARTIFACT_DOWNLOAD_FAILED",
        )
        .await?;
        Ok(ArtifactStream {
            stream,
            cancel: active.cancel.clone(),
            deadline,
            sequence: 0,
        })
    }

    pub async fn delete_remote_artifact(&self, target_id: &str, token: &str) -> HostResult<bool> {
        if token.is_empty() || token.len() > 4096 {
            return Err(invalid_arguments());
        }
        let active = self.require_active(target_id).await?;
        let mut client = active.client.clone();
        Ok(rpc(
            &active,
            client.delete_artifact(request(
                &active,
                proto::RemoteArtifactRequest {
                    context: Some(context(None)),
                    token: token.into(),
                },
                HANDSHAKE_TIMEOUT,
            )),
            HANDSHAKE_TIMEOUT,
            "ARTIFACT_DELETE_FAILED",
        )
        .await?
        .deleted)
    }

    pub async fn observation_events(&self, target_id: &str, task_id: &str) -> HostResult<Value> {
        Uuid::parse_str(task_id).map_err(|_| invalid_arguments())?;
        let active = self.require_active(target_id).await?;
        let mut client = active.client.clone();
        let response = rpc(
            &active,
            client.get_observation_events(request(
                &active,
                proto::ObservationEventsRequest {
                    context: Some(context(Some(task_id))),
                    task_id: task_id.into(),
                    limit: 100,
                },
                HANDSHAKE_TIMEOUT,
            )),
            HANDSHAKE_TIMEOUT,
            "OBSERVATION_EVENTS_FAILED",
        )
        .await?;
        validate_observation_task(&response.task_id, &response.state, task_id)?;
        nonnegative(response.captured.into(), "observation.captured")?;
        nonnegative(response.dropped.into(), "observation.dropped")?;
        let mut events = Vec::with_capacity(response.events.len());
        for event in response.events {
            nonnegative(event.sequence, "event.sequence")?;
            nonnegative(event.event_id, "event.eventId")?;
            nonnegative(event.depth.into(), "event.depth")?;
            nonnegative(event.duration_nanos, "event.durationNanos")?;
            safe_integer(event.parent_sequence, "event.parentSequence")?;
            let phase = if event.phase.is_empty() {
                "FINISH"
            } else {
                &event.phase
            };
            if !["BEFORE", "RETURN", "THROW", "FINISH"].contains(&phase) {
                return Err(invalid_response("观测事件时机无效"));
            }
            events.push(json!({"eventId":event.event_id,"sequence":event.sequence,"parentSequence":if event.parent_sequence<0 {Value::Null} else {json!(event.parent_sequence)},"depth":event.depth,"method":event.method,"phase":phase,"capturedAt":timestamp(event.captured_at_epoch_millis)?,"durationNanos":event.duration_nanos,"threadName":event.thread_name,"arguments":event.arguments,"callStack":event.call_stack,"returnValue":nullable_string(event.return_value),"exceptionType":nullable_string(event.exception_type),"exceptionMessage":nullable_string(event.exception_message)}));
        }
        Ok(
            json!({"taskId":response.task_id,"state":response.state,"captured":response.captured,"dropped":response.dropped,"events":events}),
        )
    }

    pub async fn cancel_observation(&self, target_id: &str, task_id: &str) -> HostResult<Value> {
        Uuid::parse_str(task_id).map_err(|_| invalid_arguments())?;
        let active = self.require_active(target_id).await?;
        let mut client = active.client.clone();
        let response = rpc(
            &active,
            client.cancel_observation(request(
                &active,
                proto::ObservationTaskRequest {
                    context: Some(context(Some(task_id))),
                    task_id: task_id.into(),
                },
                HANDSHAKE_TIMEOUT,
            )),
            HANDSHAKE_TIMEOUT,
            "OBSERVATION_CANCEL_FAILED",
        )
        .await?;
        validate_observation_task(&response.task_id, &response.state, task_id)?;
        Ok(json!(response.state))
    }

    pub async fn inspect_exit_impact(&self) -> HostResult<Value> {
        let connections = self.list_connections().await;
        let mut inspection = tokio::task::JoinSet::new();
        for (index, connection) in connections.as_array().into_iter().flatten().enumerate() {
            if connection["state"] == "DISCONNECTED" || connection["state"] == "CLOSING" {
                continue;
            }
            let manager = self.clone();
            let connection = connection.clone();
            inspection.spawn(async move { let result = manager.execute_action(&json!({"targetId":connection["target"]["id"],"actionId":"session.reset.preview","parameters":{}})).await; (index, exit_impact_target(&connection, result)) });
        }
        let mut targets = Vec::new();
        while let Some(result) = inspection.join_next().await {
            targets
                .push(result.map_err(|error| {
                    HostError::new("EXIT_INSPECTION_FAILED", error.to_string())
                })?);
        }
        targets.sort_by_key(|(index, _)| *index);
        Ok(summarize_exit_impact(
            targets.into_iter().map(|(_, target)| target).collect(),
        ))
    }
}

pub struct ArtifactStream {
    stream: tonic::Streaming<proto::ArtifactChunk>,
    cancel: CancellationToken,
    deadline: Instant,
    sequence: i64,
}

impl ArtifactStream {
    pub async fn message(&mut self) -> HostResult<Option<proto::ArtifactChunk>> {
        let chunk = tokio::select! {
            _ = self.cancel.cancelled() => return Err(cancelled()),
            _ = tokio::time::sleep_until(self.deadline) => return Err(HostError::new("ARTIFACT_DOWNLOAD_FAILED", "制品下载超时")),
            result = self.stream.message() => result.map_err(|error| HostError::new("ARTIFACT_DOWNLOAD_FAILED", error.message()))?,
        };
        if let Some(chunk) = &chunk {
            if chunk.sequence != self.sequence {
                return Err(HostError::new(
                    "ARTIFACT_DOWNLOAD_FAILED",
                    format!(
                        "制品分块序号不连续：预期 {}，收到 {}",
                        self.sequence, chunk.sequence
                    ),
                ));
            }
            self.sequence = self
                .sequence
                .checked_add(1)
                .ok_or_else(|| invalid_response("制品序号溢出"))?;
        }
        Ok(chunk)
    }
}

fn request<T>(active: &ActiveAgent, value: T, timeout: Duration) -> Request<T> {
    let mut request = Request::new(value);
    request
        .metadata_mut()
        .insert("x-tanwei-secret", active.secret.clone());
    request.set_timeout(timeout);
    request
}

async fn rpc<T>(
    active: &ActiveAgent,
    future: impl Future<Output = Result<Response<T>, Status>>,
    deadline: Duration,
    code: &str,
) -> HostResult<T> {
    tokio::select! {
        biased;
        _ = active.cancel.cancelled() => Err(cancelled()),
        result = timeout(deadline, future) => match result {
            Ok(Ok(response)) => Ok(response.into_inner()),
            Ok(Err(error)) => Err(HostError::new(code, error.message())),
            Err(_) => Err(HostError::new(code, "Agent 请求超时")),
        }
    }
}

async fn probe(active: &ActiveAgent, pid: i64) -> HostResult<proto::CapabilitiesResponse> {
    let mut client = active.client.clone();
    let response = rpc(
        active,
        client.get_capabilities(request(
            active,
            proto::CapabilitiesRequest {
                context: Some(context(None)),
                client_protocol_version: PROTOCOL_VERSION.into(),
            },
            HANDSHAKE_TIMEOUT,
        )),
        HANDSHAKE_TIMEOUT,
        "HANDSHAKE_FAILED",
    )
    .await?;
    protocol_compatibility(PROTOCOL_VERSION, &response.protocol_version)?;
    if response.process_id != pid || pid <= 0 {
        return Err(HostError::new(
            "TARGET_IDENTITY_MISMATCH",
            format!("Agent 返回 PID {}，预期 {pid}", response.process_id),
        ));
    }
    for capability in &response.capabilities {
        if capability.id.is_empty()
            || !["AVAILABLE", "UNSUPPORTED", "RESTRICTED"].contains(&capability.state.as_str())
        {
            return Err(invalid_response("Agent 返回了无效的能力声明"));
        }
    }
    Ok(response)
}

async fn close_active(active: &ActiveAgent) {
    active.cancel.cancel();
    if active.shutdown_on_disconnect {
        let mut client = active.client.clone();
        let shutdown = request(
            active,
            proto::ShutdownRequest {
                context: Some(context(None)),
            },
            HANDSHAKE_TIMEOUT,
        );
        // Shutdown uses a fresh deadline after cancelling all ordinary requests.
        let _ = timeout(HANDSHAKE_TIMEOUT, client.shutdown(shutdown)).await;
    }
}

async fn cleanup_session(session: &Session) -> HostResult<()> {
    if let Some(cleanup) = session.cleanup.lock().await.take() {
        cleanup().await?;
    }
    Ok(())
}

async fn wait_for_completion(session: &Session) {
    loop {
        let notified = session.finished.notified();
        if session.completed.load(Ordering::Acquire) {
            return;
        }
        notified.await;
    }
}

async fn wait_for_connection(session: &Session) -> HostResult<Value> {
    wait_for_completion(session).await;
    if session.cancel.is_cancelled() {
        return Err(cancelled());
    }
    if let Some(error) = session.completion_error.lock().await.clone() {
        return Err(error);
    }
    Ok(session.connection.lock().await.clone())
}

fn context(task_id: Option<&str>) -> proto::RequestContext {
    proto::RequestContext {
        request_id: Uuid::new_v4().to_string(),
        task_id: task_id
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        timestamp_epoch_millis: Utc::now().timestamp_millis(),
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn nullable_string(value: String) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    }
}
fn cancelled() -> HostError {
    HostError::new("CONNECTION_CANCELLED", "目标连接已取消")
}
fn invalid_arguments() -> HostError {
    HostError::new("INVALID_ARGUMENTS", "请求参数格式无效")
}
fn invalid_response(message: impl Into<String>) -> HostError {
    HostError::new("INVALID_AGENT_RESPONSE", message)
}
fn argument(args: &[Value], index: usize) -> HostResult<&str> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(invalid_arguments)
}
fn string_field<'a>(value: &'a Value, key: &str) -> HostResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(invalid_arguments)
}
fn integer_field(value: &Value, key: &str, min: i32, max: i32) -> HostResult<i32> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .and_then(|number| i32::try_from(number).ok())
        .filter(|number| (*number >= min) && (*number <= max))
        .ok_or_else(invalid_arguments)
}
fn validate_page_query(query: &Value, threads: bool) -> HostResult<()> {
    let fields = query.as_object().ok_or_else(invalid_arguments)?;
    let allowed = if threads {
        &["offset", "limit", "query", "stackDepth", "state"][..]
    } else {
        &["offset", "limit", "query"][..]
    };
    if fields.keys().any(|key| !allowed.contains(&key.as_str()))
        || string_field(query, "query")?.encode_utf16().count() > 512
    {
        return Err(invalid_arguments());
    }
    Ok(())
}
fn safe_integer(number: i64, field: &str) -> HostResult<()> {
    if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&number) {
        return Err(invalid_response(format!("{field} 超出前端安全整数范围")));
    }
    Ok(())
}
fn nonnegative(number: i64, field: &str) -> HostResult<()> {
    safe_integer(number, field)?;
    if number < 0 {
        return Err(invalid_response(format!("{field} 不得为负数")));
    }
    Ok(())
}
fn timestamp(millis: i64) -> HostResult<String> {
    nonnegative(millis, "timestamp")?;
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| invalid_response("时间戳超出有效范围"))
}

fn local_pid(target_id: &str) -> Option<i64> {
    let text = target_id.strip_prefix("local:")?;
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse()
        .ok()
        .filter(|pid| *pid > 0 && *pid <= MAX_SAFE_INTEGER)
}

fn validate_target(target: &TargetDescriptor) -> HostResult<()> {
    if target.id.is_empty() || target.pid <= 0 || target.pid > MAX_SAFE_INTEGER {
        return Err(HostError::new("INVALID_TARGET", "目标进程描述无效"));
    }
    if target.id.starts_with("local:") && local_pid(&target.id) != Some(target.pid) {
        return Err(HostError::new("INVALID_TARGET", "目标标识与 PID 不匹配"));
    }
    if let Some(start) = &target.start_time {
        chrono::DateTime::parse_from_rfc3339(start)
            .map_err(|_| HostError::new("INVALID_TARGET", "目标启动时间无效"))?;
    }
    Ok(())
}

fn validate_remote_id(id: &str, persistent: bool) -> HostResult<()> {
    let valid = if persistent {
        id.strip_prefix("remote:persistent:").is_some_and(|suffix| {
            suffix.len() == 24
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    } else {
        id.strip_prefix("remote:ssh:")
            .or_else(|| id.strip_prefix("remote:kubernetes:"))
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.len() <= 512
                    && suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
            })
    };
    if !valid {
        return Err(HostError::new("INVALID_REMOTE_TARGET", "远程目标标识无效"));
    }
    Ok(())
}

pub fn protocol_compatibility(client: &str, agent: &str) -> HostResult<()> {
    fn parse(value: &str) -> Option<(u64, u64)> {
        let (major, minor) = value.split_once('.')?;
        fn component(value: &str) -> Option<u64> {
            if value.is_empty()
                || value.len() > 1 && value.starts_with('0')
                || !value.bytes().all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            value
                .parse::<u64>()
                .ok()
                .filter(|number| *number <= MAX_SAFE_INTEGER as u64)
        }
        Some((component(major)?, component(minor)?))
    }
    if client.trim().is_empty() || agent.trim().is_empty() {
        return Err(HostError::new(
            "PROTOCOL_VERSION_MISSING",
            "Host 或 Agent 缺少协议版本",
        ));
    }
    let (Some(client_version), Some(agent_version)) = (parse(client), parse(agent)) else {
        return Err(HostError::new(
            "PROTOCOL_VERSION_INVALID",
            "Host 或 Agent 协议版本格式无效",
        ));
    };
    if client_version.0 != agent_version.0 {
        return Err(HostError::new(
            "PROTOCOL_INCOMPATIBLE",
            format!("Host 协议 {client} 与 Agent 协议 {agent} 不兼容"),
        ));
    }
    Ok(())
}

async fn attach_helper_invocation(
    default_java: PathBuf,
    target_java: Option<&str>,
    helper: &Path,
) -> (PathBuf, Vec<std::ffi::OsString>) {
    if let Some(java) = target_java.filter(|java| !java.trim().is_empty()) {
        if let Ok(java) = tokio::fs::canonicalize(java.trim()).await {
            if tokio::fs::metadata(&java)
                .await
                .is_ok_and(|metadata| metadata.is_file())
            {
                if let Some(home) = java.parent().and_then(Path::parent) {
                    let mut homes = vec![home.to_owned()];
                    if home
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("jre"))
                    {
                        if let Some(parent) = home.parent() {
                            homes.push(parent.to_owned());
                        }
                    }
                    for home in homes {
                        let tools = home.join("lib/tools.jar");
                        if tokio::fs::metadata(&tools)
                            .await
                            .is_ok_and(|metadata| metadata.is_file())
                        {
                            if let Ok(classpath) = std::env::join_paths([helper, &tools]) {
                                return (
                                    java,
                                    vec![
                                        "-cp".into(),
                                        classpath,
                                        "dev.tanwei.attach.AttachHelperMain".into(),
                                    ],
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    (
        default_java,
        vec!["-jar".into(), helper.as_os_str().to_owned()],
    )
}

pub(crate) async fn run_command(
    mut command: Command,
    deadline: Duration,
    max_buffer: usize,
    cancel: &CancellationToken,
    code: &str,
) -> HostResult<Vec<u8>> {
    use std::process::Stdio;
    if cancel.is_cancelled() {
        return Err(cancelled());
    }
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|error| HostError::new(code, error.to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| HostError::new(code, "无法读取子进程输出"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| HostError::new(code, "无法读取子进程错误输出"))?;
    let collect = async {
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let mut stdout = stdout.take(max_buffer as u64 + 1);
        let mut stderr = stderr.take(max_buffer as u64 + 1);
        tokio::try_join!(
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut errors)
        )
        .map_err(|error| HostError::new(code, error.to_string()))?;
        if output.len() > max_buffer || errors.len() > max_buffer {
            return Err(HostError::new(code, "子进程输出超过允许大小"));
        }
        let status = child
            .wait()
            .await
            .map_err(|error| HostError::new(code, error.to_string()))?;
        if !status.success() {
            return Err(HostError::new(
                code,
                String::from_utf8_lossy(&errors).trim().to_owned(),
            ));
        }
        Ok(output)
    };
    let result = tokio::select! { _=cancel.cancelled()=>Err(cancelled()), result=timeout(deadline,collect)=>result.unwrap_or_else(|_|Err(HostError::new(code,"Java Helper 执行超时"))) };
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}

fn snapshot_value(target_id: &str, response: proto::RuntimeSnapshot) -> HostResult<Value> {
    for (field, number) in [
        ("uptimeMillis", response.uptime_millis),
        (
            "jvmStartTimeEpochMillis",
            response.jvm_start_time_epoch_millis,
        ),
        ("heapUsedBytes", response.heap_used_bytes),
        ("heapMaxBytes", response.heap_max_bytes),
        ("nonHeapUsedBytes", response.non_heap_used_bytes),
        ("liveThreads", response.live_threads.into()),
        ("peakThreads", response.peak_threads.into()),
        ("loadedClasses", response.loaded_classes.into()),
        ("gcCount", response.gc_count),
        ("gcTimeMillis", response.gc_time_millis),
    ] {
        nonnegative(number, field)?;
    }
    if !response.process_cpu_load.is_finite() || !response.system_cpu_load.is_finite() {
        return Err(invalid_response("CPU 使用率无效"));
    }
    Ok(
        json!({"targetId":target_id,"capturedAt":timestamp(response.captured_at_epoch_millis)?,"uptimeMillis":response.uptime_millis,"jvmStartTimeEpochMillis":response.jvm_start_time_epoch_millis,"processCpuLoad":if response.has_process_cpu_load {json!(response.process_cpu_load)} else {Value::Null},"systemCpuLoad":if response.has_system_cpu_load {json!(response.system_cpu_load)} else {Value::Null},"heapUsedBytes":response.heap_used_bytes,"heapMaxBytes":response.heap_max_bytes,"nonHeapUsedBytes":response.non_heap_used_bytes,"liveThreads":response.live_threads,"peakThreads":response.peak_threads,"loadedClasses":response.loaded_classes,"gcCount":response.gc_count,"gcTimeMillis":response.gc_time_millis}),
    )
}

fn validate_observation_task(actual: &str, state: &str, expected: &str) -> HostResult<()> {
    if actual != expected
        || Uuid::parse_str(actual).is_err()
        || ![
            "RUNNING",
            "SUCCEEDED",
            "FAILED",
            "CANCELLED",
            "TIMED_OUT",
            "UNKNOWN",
        ]
        .contains(&state)
    {
        return Err(invalid_response("Agent 返回了不匹配的观测任务"));
    }
    Ok(())
}

fn exit_impact_target(connection: &Value, result: HostResult<Value>) -> Value {
    let mut target = json!({"targetId":connection["target"]["id"],"displayName":connection["target"]["displayName"],"pid":connection["target"]["pid"],"state":"FAILED","taskCount":0,"classCount":0,"rollbackCount":0,"artifactPotentialCount":0,"errorMessage":null});
    let action = match result {
        Ok(action) => action,
        Err(error) => {
            target["errorMessage"] = json!(error.message);
            return target;
        }
    };
    if action["actionId"] != "session.reset.preview"
        || action["targetId"] != target["targetId"]
        || action["status"] != "SUCCEEDED"
    {
        target["errorMessage"] = json!("Agent 返回了不匹配的会话预检结果");
        return target;
    }
    let values = &action["values"];
    let fingerprint = values["fingerprint"].as_str().unwrap_or("");
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        target["errorMessage"] = json!("Agent 返回了无效的会话预检数据");
        return target;
    }
    for (source, destination) in [
        ("task.total", "taskCount"),
        ("class.total", "classCount"),
        ("rollback.total", "rollbackCount"),
        ("artifactPotential.total", "artifactPotentialCount"),
    ] {
        let raw = values[source].as_str().unwrap_or("");
        let count = raw
            .parse::<u64>()
            .ok()
            .filter(|count| *count <= 1_000_000 && raw == count.to_string());
        let Some(count) = count else {
            target["errorMessage"] = json!("Agent 返回了无效的会话预检数据");
            for key in [
                "taskCount",
                "classCount",
                "rollbackCount",
                "artifactPotentialCount",
            ] {
                target[key] = json!(0);
            }
            return target;
        };
        target[destination] = json!(count);
    }
    target["state"] = json!("INSPECTED");
    target
}

fn summarize_exit_impact(targets: Vec<Value>) -> Value {
    let mut summary = json!({"inspectedAt":now(),"connectionCount":targets.len(),"inspectedCount":0,"failedCount":0,"taskCount":0,"classCount":0,"rollbackCount":0,"artifactPotentialCount":0});
    for target in &targets {
        let key = if target["state"] == "FAILED" {
            "failedCount"
        } else {
            "inspectedCount"
        };
        summary[key] = json!(summary[key].as_u64().unwrap_or(0) + 1);
        if key == "inspectedCount" {
            for count in [
                "taskCount",
                "classCount",
                "rollbackCount",
                "artifactPotentialCount",
            ] {
                summary[count] = json!(
                    summary[count].as_u64().unwrap_or(0) + target[count].as_u64().unwrap_or(0)
                );
            }
        }
    }
    summary["targets"] = json!(targets);
    summary
}

#[cfg(test)]
mod tests;
