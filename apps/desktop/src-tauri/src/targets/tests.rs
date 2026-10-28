use super::*;
use futures::{stream, Stream};
use proto::diagnostic_service_server::{DiagnosticService, DiagnosticServiceServer};
use std::sync::atomic::AtomicUsize;

#[derive(Clone, Default)]
struct AgentFixture {
    shutdowns: Arc<AtomicUsize>,
    handshake_delay: Arc<AtomicU64>,
    process_id: Arc<AtomicU64>,
    failures: Arc<AtomicUsize>,
}

type FixtureStream<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>;

#[tonic::async_trait]
impl DiagnosticService for AgentFixture {
    async fn get_capabilities(
        &self,
        request: Request<proto::CapabilitiesRequest>,
    ) -> Result<Response<proto::CapabilitiesResponse>, Status> {
        if request
            .metadata()
            .get("x-tanwei-secret")
            .and_then(|value| value.to_str().ok())
            != Some("fixture-secret")
        {
            return Err(Status::unauthenticated("missing secret"));
        }
        if request.get_ref().client_protocol_version != PROTOCOL_VERSION {
            return Err(Status::invalid_argument("protocol missing"));
        }
        let delay = self.handshake_delay.load(Ordering::Acquire);
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        if self.failures.load(Ordering::Acquire) > 0 {
            self.failures.fetch_sub(1, Ordering::AcqRel);
            return Err(Status::unavailable("fixture unavailable"));
        }
        Ok(Response::new(proto::CapabilitiesResponse {
            protocol_version: PROTOCOL_VERSION.into(),
            agent_version: "fixture".into(),
            process_id: self.process_id.load(Ordering::Acquire) as i64,
            java_version: "21".into(),
            capabilities: ["overview", "tasks", "runtime-mutation"]
                .into_iter()
                .map(|id| proto::Capability {
                    id: id.into(),
                    state: "AVAILABLE".into(),
                    reason: String::new(),
                })
                .collect(),
        }))
    }
    async fn get_snapshot(
        &self,
        _request: Request<proto::SnapshotRequest>,
    ) -> Result<Response<proto::RuntimeSnapshot>, Status> {
        Ok(Response::new(snapshot_fixture()))
    }
    type StreamMetricsStream = FixtureStream<proto::RuntimeSnapshot>;
    async fn stream_metrics(
        &self,
        _request: Request<proto::MetricStreamRequest>,
    ) -> Result<Response<Self::StreamMetricsStream>, Status> {
        Ok(Response::new(Box::pin(stream::iter([Ok(
            snapshot_fixture(),
        )]))))
    }
    async fn list_threads(
        &self,
        request: Request<proto::ThreadListRequest>,
    ) -> Result<Response<proto::ThreadListResponse>, Status> {
        Ok(Response::new(proto::ThreadListResponse {
            total: 1,
            offset: request.get_ref().offset,
            threads: vec![proto::ThreadDescriptor {
                id: 1,
                name: "main".into(),
                state: "RUNNABLE".into(),
                daemon: false,
                priority: 5,
                cpu_time_nanos: -1,
                has_cpu_time: false,
                stack: vec!["Fixture.main".into()],
                deadlocked: false,
                lock_name: String::new(),
                lock_owner_id: -1,
            }],
        }))
    }
    async fn list_classes(
        &self,
        request: Request<proto::ClassListRequest>,
    ) -> Result<Response<proto::ClassListResponse>, Status> {
        Ok(Response::new(proto::ClassListResponse {
            total_matches: 1,
            offset: request.get_ref().offset,
            classes: vec![proto::ClassDescriptor {
                name: "Fixture".into(),
                class_loader: "app".into(),
                module: String::new(),
                modifiable: true,
            }],
        }))
    }
    async fn get_class_details(
        &self,
        request: Request<proto::ClassDetailsRequest>,
    ) -> Result<Response<proto::ClassDetailsResponse>, Status> {
        Ok(Response::new(proto::ClassDetailsResponse {
            found: request.get_ref().name == "Fixture",
            name: request.get_ref().name.clone(),
            class_loader: request.get_ref().class_loader.clone(),
            methods: vec![proto::MethodDescriptor {
                name: "main".into(),
                return_type: "void".into(),
                parameter_types: vec!["java.lang.String[]".into()],
                exception_types: vec![],
                modifiers: "public static".into(),
                annotations: vec![],
            }],
            ..Default::default()
        }))
    }
    async fn execute_action(
        &self,
        request: Request<proto::ActionRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let values = if request.get_ref().action_id == "session.reset.preview" {
            HashMap::from([
                ("task.total".into(), "2".into()),
                ("class.total".into(), "1".into()),
                ("rollback.total".into(), "0".into()),
                ("artifactPotential.total".into(), "3".into()),
                ("fingerprint".into(), "a".repeat(64)),
            ])
        } else {
            request.into_inner().parameters
        };
        Ok(Response::new(proto::ActionResponse {
            status: "SUCCEEDED".into(),
            error_code: String::new(),
            message: String::new(),
            values,
        }))
    }
    type DownloadArtifactStream = FixtureStream<proto::ArtifactChunk>;
    async fn download_artifact(
        &self,
        request: Request<proto::ArtifactDownloadRequest>,
    ) -> Result<Response<Self::DownloadArtifactStream>, Status> {
        let sequence = if request.get_ref().token == "invalid-sequence" {
            7
        } else {
            0
        };
        Ok(Response::new(Box::pin(stream::iter([
            Ok(proto::ArtifactChunk {
                sequence,
                data: b"hello ".to_vec(),
            }),
            Ok(proto::ArtifactChunk {
                sequence: 1,
                data: b"world".to_vec(),
            }),
        ]))))
    }
    async fn delete_artifact(
        &self,
        _request: Request<proto::RemoteArtifactRequest>,
    ) -> Result<Response<proto::RemoteArtifactResponse>, Status> {
        Ok(Response::new(proto::RemoteArtifactResponse {
            deleted: true,
        }))
    }
    async fn get_observation_events(
        &self,
        request: Request<proto::ObservationEventsRequest>,
    ) -> Result<Response<proto::ObservationEventsResponse>, Status> {
        Ok(Response::new(proto::ObservationEventsResponse {
            task_id: request.into_inner().task_id,
            state: "RUNNING".into(),
            captured: 1,
            dropped: 0,
            events: vec![proto::ObservationEvent {
                sequence: 0,
                event_id: 17,
                parent_sequence: -1,
                captured_at_epoch_millis: 1000,
                phase: "RETURN".into(),
                return_value: "42".into(),
                ..Default::default()
            }],
        }))
    }
    async fn cancel_observation(
        &self,
        request: Request<proto::ObservationTaskRequest>,
    ) -> Result<Response<proto::ObservationTaskResponse>, Status> {
        Ok(Response::new(proto::ObservationTaskResponse {
            task_id: request.into_inner().task_id,
            state: "CANCELLED".into(),
        }))
    }
    async fn shutdown(
        &self,
        _request: Request<proto::ShutdownRequest>,
    ) -> Result<Response<proto::ShutdownResponse>, Status> {
        self.shutdowns.fetch_add(1, Ordering::AcqRel);
        Ok(Response::new(proto::ShutdownResponse { accepted: true }))
    }
}

fn snapshot_fixture() -> proto::RuntimeSnapshot {
    proto::RuntimeSnapshot {
        captured_at_epoch_millis: 1000,
        uptime_millis: 500,
        heap_used_bytes: 42,
        has_process_cpu_load: true,
        process_cpu_load: 0.5,
        ..Default::default()
    }
}
fn descriptor() -> Value {
    json!({"id":"remote:ssh:fixture:42","pid":42,"displayName":"Fixture","mainClass":"Fixture","arguments":[],"javaPath":null,"javaVersion":null,"user":null,"startTime":null,"attachable":true,"attachReason":null})
}
fn manager() -> TargetManager {
    TargetManager::new(Arc::new(RuntimePaths {
        resources: PathBuf::new(),
        user_data: std::env::temp_dir(),
        version: "test".into(),
        development: true,
    }))
}
fn cleanup(counter: Arc<AtomicUsize>) -> Option<RemoteCleanup> {
    Some(Box::new(move || {
        Box::pin(async move {
            counter.fetch_add(1, Ordering::AcqRel);
            Ok(())
        })
    }))
}

async fn start_agent() -> (AgentFixture, String, CancellationToken) {
    let agent = AgentFixture::default();
    agent.process_id.store(42, Ordering::Release);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let incoming = stream::unfold(listener, |listener| async move {
        Some((listener.accept().await.map(|(stream, _)| stream), listener))
    });
    let cancel = CancellationToken::new();
    let stopped = cancel.clone();
    let service = agent.clone();
    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(DiagnosticServiceServer::new(service))
            .serve_with_incoming_shutdown(incoming, stopped.cancelled())
            .await
            .unwrap();
    });
    (agent, address, cancel)
}

#[test]
fn protocol_contract_rejects_malformed_versions_and_accepts_same_major() {
    for agent in ["1.0", "1.1", "1.999"] {
        assert!(protocol_compatibility("1.0", agent).is_ok());
    }
    for agent in [
        "1",
        "1.0.0",
        "01.0",
        "1.00",
        " 1.0",
        "1.-1",
        "a.0",
        "1.9007199254740992",
    ] {
        assert_eq!(
            protocol_compatibility("1.0", agent).unwrap_err().code,
            "PROTOCOL_VERSION_INVALID"
        );
    }
    assert_eq!(
        protocol_compatibility("1.0", "").unwrap_err().code,
        "PROTOCOL_VERSION_MISSING"
    );
    assert_eq!(
        protocol_compatibility("1.0", "2.0").unwrap_err().code,
        "PROTOCOL_INCOMPATIBLE"
    );
}

#[test]
fn page_query_preserves_original_host_bounds_and_strict_fields() {
    assert!(validate_page_query(
        &json!({"offset":0,"limit":100,"query":"x".repeat(512)}),
        false
    )
    .is_ok());
    assert!(validate_page_query(
        &json!({"offset":0,"limit":100,"query":"🦀".repeat(257)}),
        false
    )
    .is_err());
    assert!(validate_page_query(
        &json!({"offset":0,"limit":100,"query":"","extra":true}),
        false
    )
    .is_err());
    assert!(validate_page_query(
        &json!({"offset":0,"limit":100,"query":"","stackDepth":0,"state":""}),
        true
    )
    .is_ok());
    assert!(integer_field(&json!({"offset":1_000_001}), "offset", 0, 1_000_000).is_err());
}

#[test]
fn snapshot_preserves_nullable_metrics_and_rejects_unsafe_integers() {
    let value = snapshot_value("local:42", snapshot_fixture()).unwrap();
    assert_eq!(value["capturedAt"], "1970-01-01T00:00:01.000Z");
    assert_eq!(value["processCpuLoad"], 0.5);
    assert_eq!(value["systemCpuLoad"], Value::Null);
    let invalid = proto::RuntimeSnapshot {
        heap_used_bytes: MAX_SAFE_INTEGER + 1,
        ..snapshot_fixture()
    };
    assert!(snapshot_value("local:42", invalid).is_err());
    let invalid = proto::RuntimeSnapshot {
        gc_count: -1,
        ..snapshot_fixture()
    };
    assert!(snapshot_value("local:42", invalid).is_err());
}

#[test]
fn exit_summary_rejects_mismatched_or_noncanonical_preview_counts() {
    let connection = json!({"target":descriptor()});
    let action = json!({"targetId":descriptor()["id"],"actionId":"session.reset.preview","status":"SUCCEEDED","values":{"task.total":"2","class.total":"1","rollback.total":"0","artifactPotential.total":"3","fingerprint":"a".repeat(64)}});
    let inspected = exit_impact_target(&connection, Ok(action.clone()));
    assert_eq!(inspected["state"], "INSPECTED");
    let mut invalid = action;
    invalid["values"]["class.total"] = json!("01");
    let failed = exit_impact_target(&connection, Ok(invalid));
    assert_eq!(failed["state"], "FAILED");
    assert_eq!(failed["taskCount"], 0);
    let summary = summarize_exit_impact(vec![inspected, failed]);
    assert_eq!(summary["connectionCount"], 2);
    assert_eq!(summary["inspectedCount"], 1);
    assert_eq!(summary["taskCount"], 2);
}

#[tokio::test]
async fn grpc_roundtrip_preserves_all_frontend_contracts_and_cleans_once() {
    let (agent, address, server) = start_agent().await;
    let manager = manager();
    let cleaned = Arc::new(AtomicUsize::new(0));
    let target = descriptor();
    let id = target["id"].as_str().unwrap();
    let connection = manager
        .connect_remote(
            target.clone(),
            address,
            "fixture-secret".into(),
            None,
            cleanup(cleaned.clone()),
        )
        .await
        .unwrap();
    assert_eq!(connection["state"], "READY");
    assert_eq!(manager.snapshot(id).await.unwrap()["heapUsedBytes"], 42);
    let threads = manager
        .list_threads(
            id,
            &json!({"offset":0,"limit":50,"query":"","state":"","stackDepth":20}),
        )
        .await
        .unwrap();
    assert_eq!(threads["items"][0]["cpuTimeNanos"], Value::Null);
    assert_eq!(threads["items"][0]["lockOwnerId"], Value::Null);
    let classes = manager
        .list_classes(id, &json!({"offset":0,"limit":50,"query":""}))
        .await
        .unwrap();
    assert_eq!(classes["items"][0]["module"], Value::Null);
    let details = manager.class_details(id, "Fixture", "app").await.unwrap();
    assert_eq!(details["methods"][0]["returnType"], "void");
    assert!(manager.class_details(id, "Gone", "app").await.is_err());
    let action = manager
        .execute_action(&json!({"targetId":id,"actionId":"jvm.info","parameters":{}}))
        .await
        .unwrap();
    assert_eq!(action["riskLevel"], "R0");
    assert!(Uuid::parse_str(action["taskId"].as_str().unwrap()).is_ok());
    assert_eq!(
        manager
            .execute_action(&json!({"targetId":id,"actionId":"profile.start","parameters":{}}))
            .await
            .unwrap_err()
            .code,
        "CAPABILITY_UNAVAILABLE"
    );
    let mut stream = manager.download_artifact(id, "artifact").await.unwrap();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.message().await.unwrap() {
        bytes.extend(chunk.data);
    }
    assert_eq!(bytes, b"hello world");
    let mut invalid = manager
        .download_artifact(id, "invalid-sequence")
        .await
        .unwrap();
    assert!(invalid.message().await.is_err());
    assert!(manager
        .delete_remote_artifact(id, "artifact")
        .await
        .unwrap());
    let task = Uuid::new_v4().to_string();
    let events = manager.observation_events(id, &task).await.unwrap();
    assert_eq!(events["events"][0]["parentSequence"], Value::Null);
    assert_eq!(events["events"][0]["eventId"], 17);
    assert_eq!(
        manager.cancel_observation(id, &task).await.unwrap(),
        "CANCELLED"
    );
    let impact = manager.inspect_exit_impact().await.unwrap();
    assert_eq!(impact["taskCount"], 2);
    assert_eq!(impact["inspectedCount"], 1);
    manager.disconnect(id).await.unwrap();
    manager.close_all().await;
    assert_eq!(agent.shutdowns.load(Ordering::Acquire), 1);
    assert_eq!(cleaned.load(Ordering::Acquire), 1);
    server.cancel();
}

#[tokio::test]
async fn cancelled_handshake_cannot_resurrect_or_remove_replacement_session() {
    let (agent, address, server) = start_agent().await;
    agent.handshake_delay.store(500, Ordering::Release);
    let manager = manager();
    let cleaned = Arc::new(AtomicUsize::new(0));
    let connecting = manager.clone();
    let endpoint = address.clone();
    let old_cleanup = cleaned.clone();
    let pending = tokio::spawn(async move {
        connecting
            .connect_remote(
                descriptor(),
                endpoint,
                "fixture-secret".into(),
                None,
                cleanup(old_cleanup),
            )
            .await
    });
    for _ in 0..100 {
        if manager.connection("remote:ssh:fixture:42").await.is_some() {
            break;
        }
        tokio::task::yield_now().await;
    }
    manager.disconnect("remote:ssh:fixture:42").await.unwrap();
    assert_eq!(
        pending.await.unwrap().unwrap_err().code,
        "CONNECTION_CANCELLED"
    );
    agent.handshake_delay.store(0, Ordering::Release);
    manager
        .connect_remote(descriptor(), address, "fixture-secret".into(), None, None)
        .await
        .unwrap();
    assert_eq!(
        manager.connection("remote:ssh:fixture:42").await.unwrap()["state"],
        "READY"
    );
    assert_eq!(cleaned.load(Ordering::Acquire), 1);
    manager.close_all().await;
    server.cancel();
}

#[tokio::test]
async fn invalid_identity_and_shutdown_race_release_forwarders() {
    let (agent, address, server) = start_agent().await;
    agent.process_id.store(43, Ordering::Release);
    let manager = manager();
    let cleaned = Arc::new(AtomicUsize::new(0));
    let error = manager
        .connect_remote(
            descriptor(),
            address.clone(),
            "fixture-secret".into(),
            None,
            cleanup(cleaned.clone()),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "TARGET_IDENTITY_MISMATCH");
    assert_eq!(cleaned.load(Ordering::Acquire), 1);
    manager.close_all().await;
    let error = manager
        .connect_remote(
            descriptor(),
            address,
            "fixture-secret".into(),
            None,
            cleanup(cleaned.clone()),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "CONNECTION_CANCELLED");
    assert_eq!(cleaned.load(Ordering::Acquire), 2);
    server.cancel();
}

#[tokio::test]
async fn every_action_path_enforces_workspace_policy_and_records_audit() {
    let (_agent, address, server) = start_agent().await;
    let manager = manager();
    manager
        .connect_remote(descriptor(), address, "fixture-secret".into(), None, None)
        .await
        .unwrap();
    let action = json!({"targetId":descriptor()["id"],"actionId":"system.property.set","parameters":{"name":"test.property","expectedOldValue":"old","newValue":"new","confirmed":"true"}});
    assert_eq!(
        manager.execute_action(&action).await.unwrap_err().code,
        "ACTION_DISABLED_BY_POLICY"
    );
    let directory = std::env::temp_dir().join(format!("tanwei-target-policy-{}", Uuid::new_v4()));
    let store =
        Arc::new(crate::storage::Storage::open(&directory.join("workspace.sqlite")).unwrap());
    manager.set_store(store.clone()).unwrap();
    assert_eq!(
        manager.execute_action(&action).await.unwrap_err().code,
        "ACTION_DISABLED_BY_POLICY"
    );
    store
        .execute(
            "UPDATE app_settings SET maximum_risk_level='R3' WHERE id=1",
            &[],
        )
        .unwrap();
    let result = manager.execute_action(&action).await.unwrap();
    assert_eq!(result["riskLevel"], "R3");
    let audits = store
        .query(
            "SELECT task_id,action_id,value_keys_json FROM action_audit",
            &[],
        )
        .unwrap();
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0]["task_id"], result["taskId"]);
    assert_eq!(audits[0]["action_id"], "system.property.set");
    store
        .execute(
            "INSERT INTO active_team_policy (id,package_json,activated_at) VALUES (1,?,?)",
            &[json!("{\"maximumRiskLevel\":\"R4\"}"), json!(now())],
        )
        .unwrap();
    assert_eq!(
        manager.execute_action(&action).await.unwrap_err().code,
        "TEAM_POLICY_INVALID"
    );
    manager.close_all().await;
    store.close().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
    server.cancel();
}

#[tokio::test]
async fn java8_attach_uses_target_jdk_tools_jar_and_preserves_paths_with_spaces() {
    let root = std::env::temp_dir().join(format!("tanwei jdk8 {}", Uuid::new_v4()));
    let java = root.join("jre/bin/java");
    let tools = root.join("lib/tools.jar");
    tokio::fs::create_dir_all(java.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::create_dir_all(tools.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&java, b"").await.unwrap();
    tokio::fs::write(&tools, b"").await.unwrap();
    let helper = root.join("attach helper.jar");
    let (executable, args) =
        attach_helper_invocation(PathBuf::from("java"), java.to_str(), &helper).await;
    assert_eq!(executable, tokio::fs::canonicalize(&java).await.unwrap());
    assert_eq!(args[0], "-cp");
    assert_eq!(
        std::env::split_paths(&args[1]).collect::<Vec<_>>(),
        [helper, tokio::fs::canonicalize(tools).await.unwrap()]
    );
    tokio::fs::remove_dir_all(root).await.unwrap();
}

/// This test owns its JVM and workspace; it never attaches to a user's process.
/// Build the Java components first, then run `cargo test --lib real_jvm -- --ignored`.
#[tokio::test]
#[ignore = "requires built JVM components and java/javac on PATH"]
async fn real_jvm_discovery_attach_actions_artifacts_and_compilation() {
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let root = Scratch(std::env::temp_dir().join(format!("tanwei-rust-jvm-{}", Uuid::new_v4())));
    tokio::fs::create_dir_all(&root.0).await.unwrap();
    let source = root.0.join("TanweiRustFixture.java");
    let code = "public class TanweiRustFixture { public static int value() { return TanweiRustHelper.value(); } public static void main(String[] args) throws Exception { while (true) { value(); Thread.sleep(100); } } } class TanweiRustHelper { static int value() { return 42; } }";
    tokio::fs::write(&source, code).await.unwrap();
    let paths = Arc::new(RuntimePaths {
        resources: root.0.clone(),
        user_data: root.0.join("workspace"),
        version: "0.1.0".into(),
        development: true,
    });
    let output = Command::new(paths.javac())
        .arg("-d")
        .arg(&root.0)
        .arg(&source)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut fixture = Command::new(paths.java())
        .arg("-cp")
        .arg(&root.0)
        .arg("TanweiRustFixture")
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let pid = fixture.id().unwrap();
    let manager = Arc::new(TargetManager::new(paths.clone()));
    let id = format!("local:{pid}");
    let mut discovered = false;
    for _ in 0..20 {
        let targets = manager.list_targets().await.unwrap();
        if targets
            .as_array()
            .unwrap()
            .iter()
            .any(|target| target["id"] == id)
        {
            discovered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(discovered, "owned JVM was not discovered");
    let connection = manager.connect_target(&id).await.unwrap();
    assert_eq!(connection["state"], "READY");
    let snapshot = manager.snapshot(&id).await.unwrap();
    assert!(snapshot["heapUsedBytes"].as_i64().unwrap() > 0);
    let action = manager
        .execute_action(&json!({"targetId":id,"actionId":"jvm.info","parameters":{}}))
        .await
        .unwrap();
    assert_eq!(action["status"], "SUCCEEDED");
    let classes = manager
        .list_classes(&id, &json!({"offset":0,"limit":100,"query":"TanweiRust"}))
        .await
        .unwrap();
    let class = classes["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|class| class["name"] == "TanweiRustFixture")
        .unwrap();
    let loader = class["classLoader"].as_str().unwrap();
    let details = manager
        .class_details(&id, "TanweiRustFixture", loader)
        .await
        .unwrap();
    assert!(details["methods"]
        .as_array()
        .unwrap()
        .iter()
        .any(|method| method["name"] == "value"));
    let dump = manager.execute_action(&json!({"targetId":id,"actionId":"thread.dump","parameters":{"maximumThreads":"100","maximumStackDepth":"32","includeLocks":"true"}})).await.unwrap();
    assert_eq!(dump["status"], "SUCCEEDED");
    let token = dump["values"]["token"].as_str().unwrap();
    let mut stream = manager.download_artifact(&id, token).await.unwrap();
    let mut dump_bytes = Vec::new();
    while let Some(chunk) = stream.message().await.unwrap() {
        dump_bytes.extend_from_slice(&chunk.data);
    }
    assert!(String::from_utf8_lossy(&dump_bytes).contains("TanweiRustFixture"));
    assert!(manager.delete_remote_artifact(&id, token).await.unwrap());

    let workspace = crate::workspace::Workspace::open(paths, manager.clone()).unwrap();
    let snapshot_artifact = workspace
        .dispatch("createSnapshotArtifact", &[json!(id)])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot_artifact["status"], "READY");
    let compile_source = "public class TanweiRustFixture { public static int value() { return TanweiRustHelper.value() + 1; } public static void main(String[] args) throws Exception { while (true) { value(); Thread.sleep(100); } } }";
    let compiled = workspace.dispatch("compileClassSource",&[json!({"targetId":id,"className":"TanweiRustFixture","classLoader":loader,"source":compile_source})]).await.unwrap().unwrap();
    assert!(compiled["size"].as_u64().unwrap() > 8);
    let change_set = workspace.dispatch("compileClassChangeSet",&[json!({"targetId":id,"items":[{"className":"TanweiRustFixture","classLoader":loader,"source":compile_source},{"className":"TanweiRustHelper","classLoader":loader,"source":"class TanweiRustHelper { static int value() { return 44; } }"}]})]).await.unwrap().unwrap();
    assert_eq!(change_set["items"].as_array().unwrap().len(), 2);
    manager.close_all().await;
    assert_eq!(manager.list_connections().await, json!([]));
    assert!(
        fixture.try_wait().unwrap().is_none(),
        "disconnect must not terminate the owned target JVM"
    );
    fixture.kill().await.unwrap();
    fixture.wait().await.unwrap();
}
