use crate::{common::HostResult, workspace::Workspace};
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};

pub struct Notifications {
    processed: Mutex<(HashSet<String>, VecDeque<String>)>,
    active: Arc<AtomicUsize>,
}
impl Notifications {
    pub fn new(workspace: &Workspace) -> HostResult<Self> {
        let alerts = workspace.store().query(
            "SELECT id FROM diagnostic_alerts ORDER BY created_at DESC LIMIT 256",
            &[],
        )?;
        let ids: VecDeque<String> = alerts
            .iter()
            .filter_map(|alert| alert["id"].as_str().map(str::to_owned))
            .collect();
        #[cfg(target_os = "macos")]
        let _ = notify_rust::set_application("dev.tanwei.desktop");
        Ok(Self {
            processed: Mutex::new((ids.iter().cloned().collect(), ids)),
            active: Arc::new(AtomicUsize::new(0)),
        })
    }
    pub fn deliver(&self, app: &tauri::AppHandle, workspace: &Workspace, artifact: &Value) {
        let Ok(alerts) = workspace.store().query(
            "SELECT * FROM diagnostic_alerts WHERE artifact_id=? ORDER BY created_at",
            &[artifact["id"].clone()],
        ) else {
            return;
        };
        let Ok(settings) = workspace.store().settings() else {
            return;
        };
        for row in alerts {
            let Ok(alert) = crate::storage::map_record(row) else {
                continue;
            };
            let Some(id) = alert["id"].as_str() else {
                continue;
            };
            let Ok(mut processed) = self.processed.lock() else {
                return;
            };
            if !processed.0.insert(id.to_owned()) {
                continue;
            }
            processed.1.push_back(id.to_owned());
            while processed.1.len() > 256 {
                if let Some(expired) = processed.1.pop_front() {
                    processed.0.remove(&expired);
                }
            }
            drop(processed);
            let foreground = app.get_webview_window("main").is_some_and(|window| {
                window.is_visible().unwrap_or(false)
                    && window.is_focused().unwrap_or(false)
                    && !window.is_minimized().unwrap_or(false)
            });
            if !eligible(&alert, &settings, foreground) {
                continue;
            }
            let Some(artifact_id) = alert["artifactId"].as_str().map(str::to_owned) else {
                continue;
            };
            // Bound native notification waiters even on systems that never dismiss notifications.
            if self
                .active
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                    (count < 8).then_some(count + 1)
                })
                .is_err()
            {
                continue;
            }
            let (title, body) = content(&alert, settings["locale"] == "en-US");
            let app = app.clone();
            let active = self.active.clone();
            let spawned=std::thread::Builder::new().name("diagnostic-notification".into()).spawn(move||{
                let mut request=notify_rust::Notification::new();
                request.appname("dev.tanwei.desktop").summary(&title).body(&body).action("default","Open evidence").timeout(15_000);
                #[cfg(target_os="windows")]
                request.app_id("dev.tanwei.desktop");
                if let Ok(notification)=request.show(){
                    let _=notification.wait_for_response(|response:&notify_rust::NotificationResponse|{if matches!(response,notify_rust::NotificationResponse::Default)||matches!(response,notify_rust::NotificationResponse::Action(action) if action=="default"){if let Some(window)=app.get_webview_window("main"){let _=window.show();let _=window.unminimize();let _=window.set_focus();let _=app.emit_to("main","tanwei:open-diagnostic-evidence",&artifact_id);}}});
                }
                active.fetch_sub(1,Ordering::AcqRel);
            });
            if spawned.is_err() {
                self.active.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }
}
fn eligible(alert: &Value, settings: &Value, foreground: bool) -> bool {
    alert["acknowledgedAt"].is_null()
        && alert["artifactId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        && !foreground
        && match settings["systemNotificationPolicy"].as_str() {
            Some("WARNING_AND_CRITICAL") => {
                matches!(alert["severity"].as_str(), Some("WARNING" | "CRITICAL"))
            }
            Some("CRITICAL_ONLY") => alert["severity"] == "CRITICAL",
            _ => false,
        }
}
fn content(alert: &Value, english: bool) -> (String, String) {
    let maximum = alert["codeCacheCapacityKind"] == "MAX";
    let title = match (english, alert["codeCachePressure"].as_str(), maximum) {
        (false, Some("EXHAUSTED"), true) => "探微：Code Cache 最大容量已耗尽",
        (false, Some("EXHAUSTED"), false) => "探微：Code Cache 已提交容量已用尽",
        (false, Some("HIGH"), _) => "探微：Code Cache 进入高压力",
        (false, Some("ELEVATED"), _) => "探微：Code Cache 压力升高",
        (false, _, _) => "探微：JIT 基线已保存",
        (true, Some("EXHAUSTED"), true) => "Tanwei: Code Cache maximum exhausted",
        (true, Some("EXHAUSTED"), false) => "Tanwei: committed Code Cache consumed",
        (true, Some("HIGH"), _) => "Tanwei: high Code Cache pressure",
        (true, Some("ELEVATED"), _) => "Tanwei: elevated Code Cache pressure",
        (true, _, _) => "Tanwei: JIT baseline saved",
    };
    let percent = alert["codeCachePercent"]
        .as_f64()
        .filter(|value| value.is_finite())
        .unwrap_or(0.);
    let body = if english {
        format!(
            "Window peak {percent:.1}% of {}. Click to inspect verified evidence.",
            if maximum {
                "maximum capacity"
            } else {
                "committed capacity"
            }
        )
    } else {
        format!(
            "窗口峰值 {percent:.1}% · 按{}判断。点击检查校验证据。",
            if maximum {
                "最大容量"
            } else {
                "已提交容量"
            }
        )
    };
    (title.into(), body)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn thresholds_and_capacity() {
        let alert = json!({"artifactId":"x","severity":"WARNING","acknowledgedAt":null,"codeCacheCapacityKind":"COMMITTED","codeCachePressure":"EXHAUSTED","codeCachePercent":99.5});
        assert!(!eligible(
            &alert,
            &json!({"systemNotificationPolicy":"CRITICAL_ONLY"}),
            false
        ));
        assert!(eligible(
            &alert,
            &json!({"systemNotificationPolicy":"WARNING_AND_CRITICAL"}),
            false
        ));
        assert!(!eligible(
            &alert,
            &json!({"systemNotificationPolicy":"WARNING_AND_CRITICAL"}),
            true
        ));
        assert!(content(&alert, false).0.contains("已提交"));
    }
}
