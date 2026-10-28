use super::{
    normalize_platform, quote, remote_error, safe_directory, validate_context, validate_resource,
    Authentication, KubeInput, Platform, SshInput,
};
use crate::common::{HostError, HostResult};
use async_trait::async_trait;
use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::{
    api::{AttachParams, ListParams},
    config::{KubeConfigOptions, Kubeconfig},
    Api, Client, Config,
};
use russh::{client, ChannelMsg, Disconnect};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::{JoinHandle, JoinSet},
    time::timeout,
};

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;

pub(super) struct SshHandler {
    fingerprint: Arc<Mutex<Option<String>>>,
    expected: Option<String>,
}

#[async_trait]
impl client::Handler for SshHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let hash = hex::encode(Sha256::digest(
            key.to_bytes().map_err(|_| russh::Error::UnknownKey)?,
        ));
        if let Ok(mut fingerprint) = self.fingerprint.lock() {
            *fingerprint = Some(hash.clone());
        } else {
            return Ok(false);
        }
        Ok(self
            .expected
            .as_ref()
            .is_none_or(|expected| expected == &hash))
    }
}

pub(super) enum Transport {
    Ssh {
        session: Arc<client::Handle<SshHandler>>,
        fingerprint: String,
    },
    Kubernetes {
        api: Api<Pod>,
        input: KubeInput,
    },
}

pub(super) struct CommandResult {
    pub stdout: String,
    pub stderr: String,
}

pub(super) struct Forwarding {
    pub port: u16,
    task: Option<JoinHandle<()>>,
}
impl Forwarding {
    pub async fn close(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for Forwarding {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

struct AttachedGuard(kube::api::AttachedProcess);
impl Drop for AttachedGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}
struct PortForwardGuard(kube::api::Portforwarder);
impl Drop for PortForwardGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Transport {
    pub async fn ssh(input: &SshInput, expected: Option<String>) -> HostResult<Self> {
        let fingerprint = Arc::new(Mutex::new(None));
        let handler = SshHandler {
            fingerprint: fingerprint.clone(),
            expected: expected.clone(),
        };
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(10)),
            keepalive_max: 3,
            ..Default::default()
        });
        let operation = async {
            let mut session = client::connect(
                config,
                (input.host.trim_matches(['[', ']']), input.port),
                handler,
            )
            .await
            .map_err(remote_error)?;
            let authenticated = match &input.authentication {
                Authentication::Password { password } => session
                    .authenticate_password(&input.username, password)
                    .await
                    .map_err(remote_error)?,
                Authentication::PrivateKey {
                    private_key,
                    passphrase,
                } => {
                    let key = russh::keys::decode_secret_key(
                        private_key,
                        if passphrase.is_empty() {
                            None
                        } else {
                            Some(passphrase)
                        },
                    )
                    .map_err(remote_error)?;
                    session
                        .authenticate_publickey(&input.username, Arc::new(key))
                        .await
                        .map_err(remote_error)?
                }
            };
            if !authenticated {
                let _ = session
                    .disconnect(Disconnect::ByApplication, "Authentication failed", "en")
                    .await;
                return Err(remote_error("SSH 身份验证失败"));
            }
            let hash = fingerprint
                .lock()
                .map_err(|_| remote_error("SSH 指纹状态不可用"))?
                .clone()
                .ok_or_else(|| remote_error("SSH 服务端未提供主机密钥指纹"))?;
            Ok(Self::Ssh {
                session: Arc::new(session),
                fingerprint: hash,
            })
        };
        let result = timeout(Duration::from_secs(15), operation)
            .await
            .map_err(|_| remote_error("SSH 连接或身份验证超时"))?;
        if result.is_err()
            && expected.as_ref().is_some_and(|expected| {
                fingerprint
                    .lock()
                    .ok()
                    .and_then(|p| p.clone())
                    .is_some_and(|actual| &actual != expected)
            })
        {
            return Err(remote_error("SSH 主机密钥指纹与预览不一致，已拒绝连接"));
        }
        result
    }

    pub async fn kubernetes(input: &KubeInput) -> HostResult<Self> {
        Ok(Self::Kubernetes {
            api: Api::namespaced(kube_client(&input.context).await?, &input.namespace),
            input: input.clone(),
        })
    }

    pub fn fingerprint(&self) -> Option<String> {
        match self {
            Self::Ssh { fingerprint, .. } => Some(fingerprint.clone()),
            _ => None,
        }
    }

    pub async fn close(&self) {
        if let Self::Ssh { session, .. } = self {
            let _ = timeout(
                Duration::from_secs(3),
                session.disconnect(Disconnect::ByApplication, "", "en"),
            )
            .await;
        }
    }

    pub async fn require_container(&self) -> HostResult<()> {
        if let Self::Kubernetes { api, input } = self {
            let pod = timeout(Duration::from_secs(15), api.get(&input.pod))
                .await
                .map_err(remote_error)?
                .map_err(remote_error)?;
            if pod.status.as_ref().and_then(|s| s.phase.as_deref()) != Some("Running") {
                return Err(remote_error("Pod 必须处于 Running 状态"));
            }
            if !pod
                .spec
                .is_some_and(|s| s.containers.iter().any(|c| c.name == input.container))
            {
                return Err(remote_error("Pod 中不存在指定容器"));
            }
        }
        Ok(())
    }

    pub async fn probe(&self) -> HostResult<Platform> {
        let (system, architecture, java) = tokio::try_join!(
            self.shell("uname -s", 15),
            self.shell("uname -m", 15),
            self.shell("java -version", 15)
        )?;
        normalize_platform(
            &system.stdout,
            &architecture.stdout,
            if java.stderr.is_empty() {
                &java.stdout
            } else {
                &java.stderr
            },
        )
    }

    pub async fn shell(&self, command: &str, seconds: u64) -> HostResult<CommandResult> {
        match self {
            Self::Ssh { session, .. } => {
                let mut channel =
                    timeout(Duration::from_secs(seconds), session.channel_open_session())
                        .await
                        .map_err(remote_error)?
                        .map_err(remote_error)?;
                let result = timeout(Duration::from_secs(seconds), async {
                    channel.exec(true, command).await.map_err(remote_error)?;
                    let mut stdout = Vec::new();
                    let mut stderr = Vec::new();
                    let mut code = None;
                    while let Some(message) = channel.wait().await {
                        match message {
                            ChannelMsg::Data { data } => append_bounded(&mut stdout, &data)?,
                            ChannelMsg::ExtendedData { data, .. } => {
                                append_bounded(&mut stderr, &data)?
                            }
                            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                            _ => {}
                        }
                    }
                    let result = CommandResult {
                        stdout: String::from_utf8_lossy(&stdout).into_owned(),
                        stderr: String::from_utf8_lossy(&stderr).into_owned(),
                    };
                    if code != Some(0) {
                        return Err(remote_error(format!(
                            "SSH 命令失败（{}）：{}",
                            code.map(|c| c.to_string())
                                .unwrap_or_else(|| "无退出状态".into()),
                            if result.stderr.trim().is_empty() {
                                result.stdout.trim()
                            } else {
                                result.stderr.trim()
                            }
                        )));
                    }
                    Ok(result)
                })
                .await
                .map_err(|_| remote_error("SSH 命令执行超时"));
                let _ = channel.close().await;
                result?
            }
            Self::Kubernetes { api, input } => kube_exec(api, input, command, None, seconds).await,
        }
    }

    pub async fn upload(&self, local: &Path, remote: &str) -> HostResult<()> {
        match self {
            Self::Ssh { session, .. } => {
                let operation = async {
                    let sftp = open_sftp(session).await?;
                    let result = async {
                        let mut attributes = FileAttributes::empty();
                        attributes.permissions = Some(0o600);
                        let mut output = sftp
                            .open_with_flags_and_attributes(
                                remote,
                                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                                attributes,
                            )
                            .await
                            .map_err(remote_error)?;
                        let mut input = tokio::fs::File::open(local).await.map_err(remote_error)?;
                        tokio::io::copy(&mut input, &mut output)
                            .await
                            .map_err(remote_error)?;
                        output.shutdown().await.map_err(remote_error)
                    }
                    .await;
                    let _ = sftp.close().await;
                    result
                };
                timeout(Duration::from_secs(60), operation)
                    .await
                    .map_err(|_| remote_error("SFTP 上传超时"))?
            }
            Self::Kubernetes { api, input } => {
                let source = tokio::fs::File::open(local).await.map_err(remote_error)?;
                let length = source.metadata().await.map_err(remote_error)?.len();
                kube_exec(
                    api,
                    input,
                    &format!("umask 077; head -c {length} > {}", quote(remote)),
                    Some(Box::new(source.take(length))),
                    60,
                )
                .await
                .map(|_| ())
            }
        }
    }

    pub async fn write(&self, remote: &str, content: &[u8]) -> HostResult<()> {
        match self {
            Self::Ssh { session, .. } => timeout(Duration::from_secs(15), async {
                let sftp = open_sftp(session).await?;
                let result = async {
                    let mut attributes = FileAttributes::empty();
                    attributes.permissions = Some(0o600);
                    let mut output = sftp
                        .open_with_flags_and_attributes(
                            remote,
                            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                            attributes,
                        )
                        .await
                        .map_err(remote_error)?;
                    output.write_all(content).await.map_err(remote_error)?;
                    output.shutdown().await.map_err(remote_error)
                }
                .await;
                let _ = sftp.close().await;
                result
            })
            .await
            .map_err(|_| remote_error("SFTP 写入超时"))?,
            Self::Kubernetes { api, input } => kube_exec(
                api,
                input,
                &format!("umask 077; head -c {} > {}", content.len(), quote(remote)),
                Some(Box::new(std::io::Cursor::new(content.to_vec()))),
                15,
            )
            .await
            .map(|_| ()),
        }
    }

    pub async fn verify_file(&self, path: &str, expected: &str) -> HostResult<()> {
        let output=self.shell(&format!("if command -v sha256sum >/dev/null 2>&1; then sha256sum -- {}; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- {}; else echo 'SHA-256 tool unavailable' >&2; exit 127; fi",quote(path),quote(path)),15).await?;
        if output.stdout.split_whitespace().next() != Some(expected) {
            return Err(remote_error(format!("远程文件 {path} SHA-256 校验失败")));
        }
        Ok(())
    }

    pub async fn wait_relay(&self, log: &str) -> HostResult<()> {
        for _ in 0..40 {
            let output = self
                .shell(
                    &format!(
                        "test -f {} && tail -n 20 -- {} || true",
                        quote(log),
                        quote(log)
                    ),
                    15,
                )
                .await?;
            if output.stdout.contains("TANWEI_RELAY_READY") {
                return Ok(());
            }
            let lower = output.stdout.to_ascii_lowercase();
            if ["exception", "error", "failed"]
                .iter()
                .any(|word| lower.contains(word))
            {
                return Err(remote_error(format!(
                    "Relay 启动失败：{}",
                    output.stdout.trim()
                )));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(remote_error("等待远程 Relay 就绪超时"))
    }

    pub async fn cleanup(&self, directory: &str, pid: Option<u64>) {
        if !safe_directory(directory) {
            return;
        }
        let kill = pid
            .filter(|pid| *pid > 0 && *pid <= super::MAX_PID)
            .map(|pid| format!("kill {pid} >/dev/null 2>&1 || true; "))
            .unwrap_or_default();
        let _ = self
            .shell(&format!("{kill}rm -rf -- {}", quote(directory)), 15)
            .await;
    }

    pub async fn forward(self: Arc<Self>, relay_port: u16) -> HostResult<Forwarding> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(remote_error)?;
        let port = listener.local_addr().map_err(remote_error)?.port();
        let task = tokio::spawn(async move {
            let mut children = JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let Ok((mut stream,peer))=accepted else {break;};
                        let transport=self.clone();
                        children.spawn(async move {
                            match transport.as_ref() {
                                Self::Ssh{session,..}=>{
                                    if let Ok(Ok(channel))=timeout(Duration::from_secs(15),session.channel_open_direct_tcpip("127.0.0.1",u32::from(relay_port),"127.0.0.1",u32::from(peer.port()))).await {
                                        let mut remote=channel.into_stream(); let _=tokio::io::copy_bidirectional(&mut stream,&mut remote).await;
                                    }
                                }
                                Self::Kubernetes{api,input}=>{
                                    if let Ok(Ok(forward))=timeout(Duration::from_secs(15),api.portforward(&input.pod,&[relay_port])).await {
                                        let mut forward=PortForwardGuard(forward);
                                        if let Some(mut remote)=forward.0.take_stream(relay_port) { let _=tokio::io::copy_bidirectional(&mut stream,&mut remote).await; }
                                    }
                                }
                            }
                        });
                    }
                    _=children.join_next(),if !children.is_empty()=>{}
                }
            }
        });
        Ok(Forwarding {
            port,
            task: Some(task),
        })
    }
}

async fn open_sftp(session: &client::Handle<SshHandler>) -> HostResult<SftpSession> {
    let channel = session.channel_open_session().await.map_err(remote_error)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(remote_error)?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(remote_error)
}

async fn kube_exec(
    api: &Api<Pod>,
    input: &KubeInput,
    command: &str,
    source: Option<Box<dyn AsyncRead + Unpin + Send>>,
    seconds: u64,
) -> HostResult<CommandResult> {
    timeout(Duration::from_secs(seconds), async {
        let params = AttachParams::default()
            .container(input.container.clone())
            .stdin(source.is_some())
            .stdout(true)
            .stderr(true)
            .tty(false);
        let mut attached = AttachedGuard(
            api.exec(&input.pod, ["/bin/sh", "-c", command], &params)
                .await
                .map_err(remote_error)?,
        );
        let stdout = attached
            .0
            .stdout()
            .ok_or_else(|| remote_error("Kubernetes Exec 缺少 stdout"))?;
        let stderr = attached
            .0
            .stderr()
            .ok_or_else(|| remote_error("Kubernetes Exec 缺少 stderr"))?;
        let stdin = attached.0.stdin();
        let status = attached
            .0
            .take_status()
            .ok_or_else(|| remote_error("Kubernetes Exec 缺少状态通道"))?;
        let write = async move {
            let mut stdin = stdin;
            if let Some(mut source) = source {
                let writer = stdin
                    .as_mut()
                    .ok_or_else(|| remote_error("Kubernetes Exec 缺少 stdin"))?;
                tokio::io::copy(&mut source, writer)
                    .await
                    .map_err(remote_error)?;
                writer.flush().await.map_err(remote_error)?;
            }
            // kube 0.98 closes the entire v4 websocket on stdin EOF. A bounded
            // remote reader exits after the declared byte count; keep stdin
            // alive until stdout/stderr and the server's exit status arrive.
            Ok::<_, HostError>(stdin)
        };
        let (stdout, stderr, _stdin, status) =
            tokio::try_join!(read_bounded(stdout), read_bounded(stderr), write, async {
                status
                    .await
                    .ok_or_else(|| remote_error("Kubernetes Exec 未返回退出状态"))
            })?;
        if status.status.as_deref() != Some("Success") {
            return Err(remote_error(
                status
                    .message
                    .unwrap_or_else(|| format!("Kubernetes Exec 失败：{stderr}")),
            ));
        }
        Ok(CommandResult { stdout, stderr })
    })
    .await
    .map_err(|_| remote_error("Kubernetes Exec 超时"))?
}

async fn read_bounded(reader: impl AsyncRead + Unpin) -> HostResult<String> {
    let mut bytes = Vec::new();
    reader
        .take((OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(remote_error)?;
    if bytes.len() > OUTPUT_LIMIT {
        return Err(remote_error("远程输出超过 2 MiB 限制"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
fn append_bounded(buffer: &mut Vec<u8>, bytes: &[u8]) -> HostResult<()> {
    if bytes.len() > OUTPUT_LIMIT.saturating_sub(buffer.len()) {
        return Err(remote_error("远程输出超过 2 MiB 限制"));
    }
    buffer.extend_from_slice(bytes);
    Ok(())
}

fn kube_config() -> HostResult<Kubeconfig> {
    let config = Kubeconfig::read()
        .map_err(|e| HostError::new("KUBERNETES_CONTEXTS_FAILED", e.to_string()))?;
    Ok(config)
}
async fn kube_client(context: &str) -> HostResult<Client> {
    validate_context(context)?;
    let config = kube_config()?;
    if !config
        .contexts
        .iter()
        .any(|c| c.name == context && c.context.is_some())
    {
        return Err(remote_error(format!("Kubernetes Context {context} 不存在")));
    }
    let options = KubeConfigOptions {
        context: Some(context.into()),
        ..Default::default()
    };
    let mut config = Config::from_custom_kubeconfig(config, &options)
        .await
        .map_err(remote_error)?;
    config.connect_timeout = Some(Duration::from_secs(15));
    Client::try_from(config).map_err(remote_error)
}
pub(super) async fn list_contexts() -> HostResult<Value> {
    let config = kube_config()?;
    if config.current_context.as_deref().is_none_or(str::is_empty) {
        return Err(HostError::new(
            "KUBERNETES_CONTEXTS_FAILED",
            "未配置 Kubernetes 当前 Context",
        ));
    }
    let current = config.current_context.as_deref();
    let mut contexts=config.contexts.iter().filter_map(|named|named.context.as_ref().map(|context|json!({"name":named.name,"cluster":context.cluster,"user":context.user.as_deref().unwrap_or(""),"current":Some(named.name.as_str())==current}))).collect::<Vec<_>>();
    contexts.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(Value::Array(contexts))
}
pub(super) async fn list_namespaces(context: &str) -> HostResult<Value> {
    let api: Api<Namespace> = Api::all(kube_client(context).await?);
    let response = timeout(Duration::from_secs(15), api.list(&ListParams::default()))
        .await
        .map_err(remote_error)?
        .map_err(remote_error)?;
    let mut namespaces = response
        .items
        .into_iter()
        .filter_map(|item| item.metadata.name)
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    namespaces.sort();
    Ok(json!(namespaces))
}
pub(super) async fn list_pods(context: &str, namespace: &str) -> HostResult<Value> {
    validate_resource(namespace)?;
    let api: Api<Pod> = Api::namespaced(kube_client(context).await?, namespace);
    let response = timeout(Duration::from_secs(15), api.list(&ListParams::default()))
        .await
        .map_err(remote_error)?
        .map_err(remote_error)?;
    let mut pods = response
        .items
        .into_iter()
        .filter_map(|pod| {
            let name = pod.metadata.name.filter(|name| !name.is_empty())?;
            let phase = pod
                .status
                .and_then(|status| status.phase)
                .unwrap_or_else(|| "Unknown".into());
            let (node, containers) = pod
                .spec
                .map(|spec| {
                    (
                        spec.node_name,
                        spec.containers
                            .into_iter()
                            .map(|c| c.name)
                            .collect::<Vec<_>>(),
                    )
                })
                .unwrap_or_default();
            Some(json!({"name":name,"phase":phase,"nodeName":node,"containers":containers}))
        })
        .collect::<Vec<_>>();
    pods.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(Value::Array(pods))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn ssh_key_is_observed_for_preview_and_pinned_for_deployment() {
        let key = russh::keys::PrivateKey::random(
            &mut rand::rngs::OsRng,
            russh::keys::Algorithm::Ed25519,
        )
        .unwrap();
        let observed = Arc::new(Mutex::new(None));
        let mut handler = SshHandler {
            fingerprint: observed.clone(),
            expected: None,
        };
        assert!(
            client::Handler::check_server_key(&mut handler, key.public_key())
                .await
                .unwrap()
        );
        handler.expected = observed.lock().unwrap().clone();
        assert!(
            client::Handler::check_server_key(&mut handler, key.public_key())
                .await
                .unwrap()
        );
        let changed = russh::keys::PrivateKey::random(
            &mut rand::rngs::OsRng,
            russh::keys::Algorithm::Ed25519,
        )
        .unwrap();
        assert!(
            !client::Handler::check_server_key(&mut handler, changed.public_key())
                .await
                .unwrap()
        );
    }
    #[test]
    fn output_budget_rejects_overflow_without_growing_buffer() {
        let mut output = vec![0; OUTPUT_LIMIT];
        assert!(append_bounded(&mut output, &[1]).is_err());
        assert_eq!(output.len(), OUTPUT_LIMIT);
    }
}
