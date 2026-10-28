use crate::common::{HostError, HostResult};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

static ASSETS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../report-assets.json")).expect("generated report assets")
});
const MAX_REPORT_BYTES: u64 = 64 * 1024 * 1024;
const REPORT_CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

struct ReportDocument {
    content: Vec<u8>,
    #[cfg(target_os = "linux")]
    context_directory: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
impl Drop for ReportDocument {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.context_directory);
    }
}

#[derive(Default)]
pub struct Reports {
    documents: Mutex<HashMap<String, Arc<ReportDocument>>>,
}

impl Reports {
    pub fn open(
        &self,
        app: &tauri::AppHandle,
        report: &Value,
        document: Vec<u8>,
        settings: &Value,
    ) -> HostResult<Value> {
        if document.len() as u64 > MAX_REPORT_BYTES {
            return Err(HostError::new("REPORT_TOO_LARGE", "报告超过 64 MiB"));
        }
        let mut content = String::from_utf8(document)
            .map_err(|_| HostError::new("REPORT_INVALID_ENCODING", "报告不是有效的 UTF-8 文档"))?;
        let name = report["name"].as_str().unwrap_or("Profile Report");
        let title = format!("探微 · 性能报告 — {name}");
        content.push_str("\n<script>");
        content.push_str(&adapter(
            &title,
            name,
            settings["fontFamily"].as_str().unwrap_or("SYSTEM"),
        ));
        content.push_str("</script>");
        let label = format!("report-{}", uuid::Uuid::new_v4());
        #[cfg(target_os = "linux")]
        let context_directory = app
            .state::<super::Host>()
            .paths
            .user_data
            .join("report-contexts")
            .join(&label);
        let url: tauri::Url = format!("tanwei-report://localhost/{label}")
            .parse()
            .map_err(super::desktop_error)?;
        self.documents.lock().map_err(super::desktop_error)?.insert(
            label.clone(),
            Arc::new(ReportDocument {
                content: content.into_bytes(),
                #[cfg(target_os = "linux")]
                context_directory: context_directory.clone(),
            }),
        );
        let allowed = label.clone();
        let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
            .title(&title)
            .inner_size(1440., 960.)
            .min_inner_size(760., 560.)
            .incognito(true)
            .theme(Some(tauri::Theme::Light))
            .on_navigation(move |url| permitted_url(url, &allowed))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
        // Linux 按 data_directory 缓存协议注册；隐私窗口需要独立键，才能在其临时 WebContext 注册报告协议。
        #[cfg(target_os = "linux")]
        let builder = builder.data_directory(context_directory);
        let window = builder.build();
        if let Err(error) = window {
            self.remove(&label);
            return Err(super::desktop_error(error));
        }
        Ok(Value::Null)
    }

    pub fn remove(&self, label: &str) {
        let document = self
            .documents
            .lock()
            .ok()
            .and_then(|mut documents| documents.remove(label));
        drop(document);
    }
}

fn permitted_url(url: &tauri::Url, label: &str) -> bool {
    ((url.scheme() == "tanwei-report" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tanwei-report.localhost")))
        && url.path() == format!("/{label}")
        && url.query().is_none()
}

fn adapter(title: &str, name: &str, font: &str) -> String {
    let literal = |text: &str| serde_json::to_string(text).unwrap().replace('<', "\\u003c");
    ASSETS["template"]
        .as_str()
        .unwrap()
        .replace("\"__TANWEI_TITLE__\"", &literal(title))
        .replace("\"__TANWEI_NAME__\"", &literal(name))
        // The font marker is inside a JS template string; fonts come only from the generated allowlist.
        .replace(
            "__TANWEI_FONT__",
            ASSETS["fonts"][font]
                .as_str()
                .unwrap_or_else(|| ASSETS["fonts"]["SYSTEM"].as_str().unwrap()),
        )
}

pub fn respond(
    app: &tauri::AppHandle,
    label: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let document = if request.method() == tauri::http::Method::GET
        && request.uri().path() == format!("/{label}")
        && request.uri().query().is_none()
    {
        app.try_state::<super::Host>()
            .and_then(|host| host.reports.documents.lock().ok()?.get(label).cloned())
    } else {
        None
    };
    tauri::http::Response::builder()
        .status(if document.is_some() { 200 } else { 404 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", REPORT_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(
            document
                .map(|document| document.content.clone())
                .unwrap_or_default(),
        )
        .expect("static report response")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_cannot_navigate_or_inject_titles() {
        assert!(permitted_url(
            &"tanwei-report://localhost/report-test#frame"
                .parse()
                .unwrap(),
            "report-test"
        ));
        for url in [
            "https://evil.example/report-test",
            "tanwei-report://localhost/other",
            "tanwei-report://localhost/report-test?file=x",
            "file:///etc/passwd",
        ] {
            assert!(!permitted_url(&url.parse().unwrap(), "report-test"));
        }
        let script = adapter("</script><script>alert(1)</script>", "report", "unknown");
        assert!(!script.contains("</script>"));
        assert!(!script.contains("__TANWEI_"));
    }
}
