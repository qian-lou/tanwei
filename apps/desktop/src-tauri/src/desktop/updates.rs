use crate::common::{sha256_file, HostError, HostResult, RuntimePaths};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri_plugin_updater::{Update, UpdaterExt};

struct Downloaded {
    path: PathBuf,
    sha256: String,
}
pub struct Updates {
    state: Mutex<Value>,
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<Downloaded>>,
    operation: tokio::sync::Mutex<()>,
    paths: Arc<RuntimePaths>,
    configured: bool,
}

impl Updates {
    pub fn new(paths: Arc<RuntimePaths>, app: &tauri::AppHandle) -> HostResult<Self> {
        cleanup_update_cache(&paths.user_data.join("updates"))?;
        let configured = app.config().plugins.0.get("updater").is_some_and(|config| {
            config["pubkey"].as_str().is_some_and(|key| !key.is_empty())
                && config["endpoints"]
                    .as_array()
                    .is_some_and(|urls| !urls.is_empty())
        });
        Ok(Self {
            state: Mutex::new(
                json!({"state":if configured {"IDLE"} else {"NOT_CONFIGURED"},"currentVersion":paths.version,"availableVersion":null,"releaseName":null,"releaseNotes":null,"progressPercent":null,"errorMessage":null}),
            ),
            pending: Mutex::new(None),
            downloaded: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
            paths,
            configured,
        })
    }
    pub fn status(&self) -> Value {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn update(&self, fields: Value) -> Value {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        for (key, value) in fields.as_object().expect("internal status fields") {
            state[key] = value.clone();
        }
        state.clone()
    }
    fn failure(&self, code: &str, error: impl std::fmt::Display) -> HostError {
        self.update(json!({"state":"FAILED","errorMessage":error.to_string()}));
        HostError::new(code, error.to_string())
    }
    pub async fn check(&self, app: &tauri::AppHandle) -> HostResult<Value> {
        if !self.configured {
            return Err(HostError::new(
                "UPDATE_NOT_CONFIGURED",
                "当前构建不含签名发布源元数据",
            ));
        }
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| HostError::new("UPDATE_BUSY", "更新操作正在进行"))?;
        if self.status()["state"] == "DOWNLOADED" {
            return Ok(self.status());
        }
        self.update(json!({"state":"CHECKING","errorMessage":null}));
        let updater = app
            .updater_builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| self.failure("UPDATE_CHECK_FAILED", e))?;
        let update = updater
            .check()
            .await
            .map_err(|e| self.failure("UPDATE_CHECK_FAILED", e))?;
        let status = match &update {
            Some(update) => self.update(json!({"state":"AVAILABLE","availableVersion":update.version,"releaseName":update.raw_json.get("name"),"releaseNotes":update.body,"progressPercent":null,"errorMessage":null})),
            None => self.update(json!({"state":"UP_TO_DATE","availableVersion":null,"releaseName":null,"releaseNotes":null,"progressPercent":null,"errorMessage":null})),
        };
        *self.pending.lock().map_err(super::desktop_error)? = update;
        Ok(status)
    }
    pub async fn download(&self, confirmed: bool) -> HostResult<Value> {
        if !confirmed {
            return Err(HostError::new(
                "CONFIRMATION_REQUIRED",
                "下载更新需要确认版本说明",
            ));
        }
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| HostError::new("UPDATE_BUSY", "更新操作正在进行"))?;
        let update = self
            .pending
            .lock()
            .map_err(super::desktop_error)?
            .clone()
            .ok_or_else(|| HostError::new("UPDATE_NOT_AVAILABLE", "当前没有可下载的签名更新"))?;
        self.update(json!({"state":"DOWNLOADING","errorMessage":null,"progressPercent":0}));
        let mut received = 0u64;
        let bytes = update.download(|chunk, total| { received = received.saturating_add(chunk as u64); self.update(json!({"progressPercent":total.filter(|total| *total > 0).map(|total| (received as f64 / total as f64 * 100.).min(100.))})); }, || {}).await.map_err(|e| self.failure("UPDATE_DOWNLOAD_FAILED", e))?;
        let directory = self.paths.user_data.join("updates");
        let result = (|| -> HostResult<Downloaded> {
            std::fs::create_dir_all(&directory)?;
            let path = directory.join(format!("{}.update", uuid::Uuid::new_v4()));
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&path)?;
            if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
                let _ = std::fs::remove_file(&path);
                return Err(error.into());
            }
            Ok(Downloaded {
                sha256: sha256_file(&path)?,
                path,
            })
        })();
        let downloaded = result.map_err(|e| self.failure("UPDATE_DOWNLOAD_FAILED", e))?;
        if let Some(previous) = self
            .downloaded
            .lock()
            .map_err(super::desktop_error)?
            .replace(downloaded)
        {
            let _ = std::fs::remove_file(previous.path);
        }
        Ok(self.update(json!({"state":"DOWNLOADED","progressPercent":100})))
    }
    pub fn ensure_downloaded(&self) -> HostResult<()> {
        if self.status()["state"] != "DOWNLOADED"
            || self
                .downloaded
                .lock()
                .map_err(super::desktop_error)?
                .is_none()
        {
            return Err(HostError::new(
                "UPDATE_NOT_DOWNLOADED",
                "更新尚未完成下载与签名校验",
            ));
        }
        Ok(())
    }
    pub async fn install(&self) -> HostResult<()> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| HostError::new("UPDATE_BUSY", "更新操作正在进行"))?;
        self.ensure_downloaded()?;
        let update = self
            .pending
            .lock()
            .map_err(super::desktop_error)?
            .clone()
            .ok_or_else(|| HostError::new("UPDATE_NOT_AVAILABLE", "签名更新元数据已失效"))?;
        let downloaded = self.downloaded.lock().map_err(super::desktop_error)?;
        let downloaded = downloaded
            .as_ref()
            .ok_or_else(|| HostError::new("UPDATE_NOT_DOWNLOADED", "更新缓存已失效"))?;
        let bytes = std::fs::read(&downloaded.path)?;
        use sha2::{Digest, Sha256};
        if hex::encode(Sha256::digest(&bytes)) != downloaded.sha256 {
            return Err(self.failure("UPDATE_INTEGRITY_FAILED", "签名校验后的更新缓存已被修改"));
        }
        update
            .install(&bytes)
            .map_err(|e| self.failure("UPDATE_INSTALL_FAILED", e))?;
        let _ = std::fs::remove_file(&downloaded.path);
        Ok(())
    }
}

// Downloads are intentionally session-local: only remove our regular UUID cache
// files, and never descend into directories or follow a redirected cache root.
fn cleanup_update_cache(directory: &std::path::Path) -> HostResult<()> {
    let metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(());
    }
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(stem) = name.to_str().and_then(|name| name.strip_suffix(".update")) else {
            continue;
        };
        if uuid::Uuid::parse_str(stem).is_ok_and(|id| id.to_string() == stem) {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::cleanup_update_cache;

    #[test]
    fn startup_cleans_only_regular_uuid_downloads_without_following_links() {
        let temporary =
            std::env::temp_dir().join(format!("tanwei-update-cleanup-{}", uuid::Uuid::new_v4()));
        let directory = temporary.join("updates");
        let name = format!("{}.update", uuid::Uuid::new_v4());
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(&name), b"old download").unwrap();
        std::fs::write(directory.join("notes.update"), b"retain").unwrap();
        let nested = directory.join(format!("{}.update", uuid::Uuid::new_v4()));
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join(&name), b"retain nested").unwrap();
        let outside = temporary.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join(&name), b"retain external").unwrap();
        #[cfg(unix)]
        let link = {
            let link = directory.join(format!("{}.update", uuid::Uuid::new_v4()));
            std::os::unix::fs::symlink(outside.join(&name), &link).unwrap();
            link
        };
        cleanup_update_cache(&directory).unwrap();
        assert!(!directory.join(&name).exists());
        assert!(directory.join("notes.update").exists());
        assert!(nested.join(&name).exists());
        assert!(outside.join(&name).exists());
        #[cfg(unix)]
        {
            assert!(std::fs::symlink_metadata(link)
                .unwrap()
                .file_type()
                .is_symlink());
            let redirected = temporary.join("redirected");
            std::os::unix::fs::symlink(&outside, &redirected).unwrap();
            cleanup_update_cache(&redirected).unwrap();
            assert!(outside.join(&name).exists());
        }
        cleanup_update_cache(&temporary.join("missing")).unwrap();
        std::fs::remove_dir_all(temporary).unwrap();
    }
}
