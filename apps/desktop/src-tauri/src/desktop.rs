#[cfg(feature = "desktop-e2e")]
mod e2e_input;
mod notifications;
mod reports;
mod updates;

use crate::{
    common::{self, HostError, HostResult, RuntimePaths},
    governance::Governance,
    remote::RemoteManager,
    targets::TargetManager,
    workspace::Workspace,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub struct Host {
    paths: Arc<RuntimePaths>,
    targets: Arc<TargetManager>,
    workspace: Arc<Workspace>,
    remote: RemoteManager,
    governance: Governance,
    updates: updates::Updates,
    reports: reports::Reports,
    notifications: notifications::Notifications,
    quitting: AtomicBool,
}

#[tauri::command]
async fn host_call(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    host: tauri::State<'_, Host>,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if webview.label() != "main" {
        return Err("此窗口没有 Host 调用权限".into());
    }
    let url = webview.url().map_err(|e| e.to_string())?;
    if !trusted_main_url(&url, host.paths.development) {
        return Err("拒绝不受信任页面的 Host 调用".into());
    }
    if method.len() > 128
        || args.len() > 8
        || serde_json::to_vec(&args).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024
    {
        return Ok(common::operation(Err(HostError::new(
            "INVALID_INPUT",
            "桌面请求超过边界",
        ))));
    }
    if method == "getRuntimeInfo" {
        return Ok(host.runtime_info());
    }
    if method == "getUpdateStatus" {
        return Ok(host.updates.status());
    }
    let result = host.dispatch(&app, &method, args).await;
    if result.is_ok()
        && matches!(
            method.as_str(),
            "createJitTrendArtifact"
                | "acknowledgeDiagnosticAlert"
                | "acknowledgeAllDiagnosticAlerts"
        )
    {
        let _ = app.emit_to("main", "tanwei:diagnostic-alerts-changed", ());
        if method == "createJitTrendArtifact" {
            if let Ok(artifact) = &result {
                host.notifications.deliver(&app, &host.workspace, artifact);
            }
        }
    }
    Ok(common::operation(result))
}

impl Host {
    fn runtime_info(&self) -> Value {
        json!({
            "appVersion":self.paths.version,
            "platform":common::platform(),
            "architecture":common::architecture(),
            "tauriVersion":tauri::VERSION,
            "webviewEngine":if cfg!(windows){"WebView2"}else if cfg!(target_os="macos"){"WKWebView"}else{"WebKitGTK"},
            "components":{
                "host":self.paths.version,
                "agent":common::PRODUCT_VERSION,
                "protocol":common::PROTOCOL_VERSION,
                "relay":common::PRODUCT_VERSION,
                "decompiler":format!("CFR {}",common::DECOMPILER_VERSION),
                "profiler":format!("async-profiler {} / Tanwei bounded fallback {}",common::ASYNC_PROFILER_VERSION,common::BOUNDED_PROFILER_VERSION)
            }
        })
    }

    async fn execute_action(&self, request: Value) -> HostResult<Value> {
        if request.as_object().is_none_or(|map| {
            map.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "targetId" | "actionId" | "parameters" | "contractVersion"
                )
            })
        }) {
            return Err(HostError::new(
                "ACTION_REQUEST_INVALID",
                "Action 包含未知字段",
            ));
        }
        if request
            .get("contractVersion")
            .is_some_and(|version| !version.is_string())
        {
            return Err(HostError::new("ACTION_REQUEST_INVALID", "契约版本格式无效"));
        }
        self.targets.execute_action(&request).await
    }

    async fn dispatch(
        &self,
        app: &tauri::AppHandle,
        method: &str,
        mut args: Vec<Value>,
    ) -> HostResult<Value> {
        if self.quitting.load(Ordering::Acquire) {
            return Err(HostError::new("APP_EXITING", "应用正在关闭"));
        }
        #[cfg(feature = "desktop-e2e")]
        match method {
            "e2e_press_tab" => {
                let backwards = match args.as_slice() {
                    [Value::Bool(value)] => *value,
                    _ => return Err(HostError::new("INVALID_INPUT", "Tab 请求需要一个方向参数")),
                };
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| HostError::new("WINDOW_MISSING", "主窗口不存在"))?;
                e2e_input::press_tab(window, backwards).await?;
                return Ok(Value::Null);
            }
            "e2e_request_close" => {
                if !args.is_empty() {
                    return Err(HostError::new("INVALID_INPUT", "关闭窗口请求不接受参数"));
                }
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| HostError::new("WINDOW_MISSING", "主窗口不存在"))?;
                window.close().map_err(desktop_error)?;
                return Ok(Value::Null);
            }
            "__testWindowLifecycle" => {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide().map_err(desktop_error)?;
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    window.show().map_err(desktop_error)?;
                    window.set_focus().map_err(desktop_error)?;
                }
                return Ok(Value::Null);
            }
            "__testWindows" => {
                let windows = app.webview_windows();
                return Ok(
                    json!({"windowCount":windows.len(),"visibleWindowCount":windows.values().filter(|window|window.is_visible().unwrap_or(false)).count()}),
                );
            }
            "e2e_window_state" => {
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| HostError::new("WINDOW_MISSING", "主窗口不存在"))?;
                let color = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|window| window.label == "main")
                    .and_then(|window| window.background_color)
                    .map(|color| format!("#{:02x}{:02x}{:02x}", color.0, color.1, color.2));
                return Ok(
                    json!({"visible":window.is_visible().map_err(desktop_error)?,"configuredBackgroundColor":color,"theme":window.theme().map(|theme|format!("{theme:?}").to_lowercase()).unwrap_or_default()}),
                );
            }
            "e2e_emit_diagnostic_evidence" => {
                app.emit_to(
                    "main",
                    "tanwei:open-diagnostic-evidence",
                    common::string_arg(&args, 0)?,
                )
                .map_err(desktop_error)?;
                return Ok(Value::Null);
            }
            _ => {}
        }
        match method {
            "executeAction" => {
                return self
                    .execute_action(args.first().cloned().unwrap_or(Value::Null))
                    .await
            }
            "executeDiagnosticTemplate" => {
                let request = self
                    .governance
                    .resolve_template_action(
                        common::string_arg(&args, 0)?,
                        common::string_arg(&args, 1)?,
                        args.get(2) == Some(&Value::Bool(true)),
                    )
                    .await?;
                return self.execute_action(request).await;
            }
            "getClassDetails" => {
                let identity = args
                    .get(1)
                    .ok_or_else(|| HostError::new("INVALID_INPUT", "缺少类身份"))?;
                args = vec![
                    args[0].clone(),
                    identity["name"].clone(),
                    identity["classLoader"].clone(),
                ];
            }
            "inspectExitImpact" => return self.targets.inspect_exit_impact().await,
            "resolveAppExit" => {
                let input = args
                    .first()
                    .ok_or_else(|| HostError::new("INVALID_INPUT", "缺少退出模式"))?;
                if input.as_object().is_none_or(|map| {
                    map.len() != 2
                        || map
                            .keys()
                            .any(|key| !matches!(key.as_str(), "reason" | "mode"))
                }) || !matches!(input["reason"].as_str(), Some("WINDOW_CLOSE" | "APP_QUIT"))
                {
                    return Err(HostError::new("INVALID_INPUT", "退出请求格式无效"));
                }
                match input["mode"].as_str() {
                    Some("CLOSE_WINDOW")
                        if cfg!(target_os = "macos") && input["reason"] == "WINDOW_CLOSE" =>
                    {
                        if let Some(window) = app.get_webview_window("main") {
                            window.hide().map_err(desktop_error)?;
                        }
                    }
                    Some("CLOSE_WINDOW") => {
                        return Err(HostError::new(
                            "INVALID_EXIT_RESOLUTION",
                            "当前平台不支持仅关闭诊断窗口",
                        ))
                    }
                    Some("QUIT_APP") => self.quit(app).await,
                    _ => return Err(HostError::new("INVALID_INPUT", "退出模式无效")),
                }
                return Ok(Value::Null);
            }
            "previewPluginImport" | "previewTeamPolicyImport" | "importCase" => {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let extensions = vec!["json"];
                app.dialog()
                    .file()
                    .add_filter("JSON", &extensions)
                    .pick_file(move |selected| {
                        let _ = tx.send(selected);
                    });
                let selected = rx.await.map_err(desktop_error)?;
                let Some(selected) = selected else {
                    return Ok(Value::Null);
                };
                args = vec![selected
                    .into_path()
                    .map_err(desktop_error)?
                    .to_string_lossy()
                    .to_string()
                    .into()];
            }
            "openProfileReport" => {
                let (report, document) = self
                    .workspace
                    .profile_report_document(common::string_arg(&args, 0)?)?;
                return self.reports.open(
                    app,
                    &report,
                    document,
                    &self.workspace.store().settings()?,
                );
            }
            "revealArtifact" => {
                if args.get(1) != Some(&Value::Bool(true)) {
                    return Err(HostError::new(
                        "CONFIRMATION_REQUIRED",
                        "打开制品目录需要确认",
                    ));
                }
                let path = self
                    .workspace
                    .artifact_path(common::string_arg(&args, 0)?)?;
                app.opener()
                    .reveal_item_in_dir(path)
                    .map_err(desktop_error)?;
                return Ok(Value::Null);
            }
            "generateSupportBundle" => args = vec![self.runtime_info()],
            "checkForUpdates" => return self.updates.check(app).await,
            "downloadUpdate" => {
                return self
                    .updates
                    .download(args.first() == Some(&Value::Bool(true)))
                    .await
            }
            "installUpdate" => {
                if args.first() != Some(&Value::Bool(true)) {
                    return Err(HostError::new(
                        "CONFIRMATION_REQUIRED",
                        "安装更新需要明确确认",
                    ));
                }
                self.updates.ensure_downloaded()?;
                self.quitting.store(true, Ordering::Release);
                self.workspace.begin_shutdown();
                self.targets.close_all().await;
                self.remote.close_all().await;
                let install = match self.workspace.close().await {
                    Ok(()) => self.updates.install().await,
                    Err(error) => Err(error),
                };
                if let Err(error) = install {
                    self.workspace.resume_after_failed_update().await?;
                    self.targets.resume_after_close().await?;
                    self.remote.resume_after_close().await?;
                    self.quitting.store(false, Ordering::Release);
                    return Err(error);
                }
                app.restart();
            }
            _ => {}
        }
        if let Some(result) = self.targets.dispatch(method, &args).await {
            return result;
        }
        if let Some(result) = self.remote.dispatch(method, &args).await {
            return result;
        }
        if let Some(result) = self.workspace.dispatch(method, &args).await {
            return result;
        }
        if let Some(result) = self.governance.dispatch(method, &args).await {
            return result;
        }
        Err(HostError::new(
            "UNKNOWN_HOST_METHOD",
            format!("不支持的桌面接口：{method}"),
        ))
    }

    async fn quit(&self, app: &tauri::AppHandle) {
        if self.quitting.swap(true, Ordering::AcqRel) {
            return;
        }
        self.workspace.begin_shutdown();
        self.targets.close_all().await;
        self.remote.close_all().await;
        if let Err(error) = self.workspace.close().await {
            eprintln!("工作区关闭失败：{error}");
        }
        app.exit(0);
    }
}

fn desktop_error(error: impl std::fmt::Display) -> HostError {
    HostError::new("DESKTOP_ERROR", error.to_string())
}

fn trusted_main_url(url: &tauri::Url, development: bool) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || (development
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(5173))
}

fn user_data(app: &tauri::AppHandle) -> HostResult<PathBuf> {
    if let Some(path) = std::env::var("TANWEI_USER_DATA_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(PathBuf::from(path));
    }
    // Preserve the Electron application's established workspace location.
    let base = app.path().config_dir().map_err(desktop_error)?;
    let legacy = base.join("@tanwei/desktop");
    let product = base.join("探微");
    if legacy.join("tanwei.sqlite").exists() {
        return Ok(legacy);
    }
    if product.join("tanwei.sqlite").exists() {
        return Ok(product);
    }
    Ok(legacy)
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![host_call])
        .register_uri_scheme_protocol("tanwei-report", |context, request| {
            reports::respond(context.app_handle(), context.webview_label(), request)
        })
        .setup(|app| {
            let handle = app.handle();
            let resources = handle.path().resource_dir()?;
            #[cfg(feature = "desktop-e2e")]
            let resources = std::env::var_os("TANWEI_RESOURCES_DIR")
                .map(PathBuf::from)
                .unwrap_or(resources);
            let paths = Arc::new(RuntimePaths {
                resources,
                user_data: user_data(handle)?,
                version: handle.package_info().version.to_string(),
                development: cfg!(debug_assertions),
            });
            paths.verify_installation()?;
            let targets = Arc::new(TargetManager::new(paths.clone()));
            let workspace = Arc::new(Workspace::open(paths.clone(), targets.clone())?);
            let governance = Governance::new(paths.clone(), workspace.clone(), targets.clone())?;
            let remote = RemoteManager::new(paths.clone(), targets.clone());
            let updates = updates::Updates::new(paths.clone(), handle)?;
            let notifications = notifications::Notifications::new(&workspace)?;
            app.manage(Host {
                paths,
                targets,
                workspace,
                remote,
                governance,
                updates,
                reports: reports::Reports::default(),
                notifications,
                quitting: AtomicBool::new(false),
            });
            let main = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("缺少主窗口配置")?;
            let main_window = tauri::WebviewWindowBuilder::from_config(app.handle(), main)?
                .on_navigation(|url| trusted_main_url(url, cfg!(debug_assertions)))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_page_load(|window, event| {
                    if event.event() == tauri::webview::PageLoadEvent::Finished {
                        let _ = window.show();
                    }
                })
                .build()?;
            if cfg!(target_os = "linux") {
                // Tao 的 Linux 构造器忽略初始主题，需要在窗口创建后显式应用。
                main_window.set_theme(main.theme)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    if let Some(host) = window.app_handle().try_state::<Host>() {
                        if !host.quitting.load(Ordering::Acquire) {
                            api.prevent_close();
                            let _ = window.emit("tanwei:app-exit-requested", "WINDOW_CLOSE");
                        }
                    }
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed)
                && window.label().starts_with("report-")
            {
                if let Some(host) = window.app_handle().try_state::<Host>() {
                    host.reports.remove(window.label());
                }
            }
        });
    #[cfg(feature = "desktop-e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let app = builder
        .build(tauri::generate_context!())
        .expect("无法启动探微桌面应用");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if let Some(host) = app.try_state::<Host>() {
                if !host.quitting.load(Ordering::Acquire) {
                    api.prevent_exit();
                    let _ = app.emit_to("main", "tanwei:app-exit-requested", "APP_QUIT");
                }
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
