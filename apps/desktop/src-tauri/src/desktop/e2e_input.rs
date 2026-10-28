//! Native keyboard input for the test build. JavaScript keyboard events do not
//! execute browser default actions or enter its keyboard focus modality.

use crate::common::{HostError, HostResult};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

pub(super) async fn press_tab(window: tauri::WebviewWindow, backwards: bool) -> HostResult<()> {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let (send, receive) = tokio::sync::oneshot::channel();
            window
                .with_webview(move |native| {
                    if send.is_closed() {
                        return;
                    }
                    #[cfg(target_os = "macos")]
                    let result = macos::press_tab(native, backwards);
                    #[cfg(target_os = "linux")]
                    let result = linux::press_tab(native, backwards);
                    #[cfg(windows)]
                    let result = windows::press_tab(native, backwards);
                    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
                    let result = Err(HostError::new(
                        "E2E_INPUT_UNSUPPORTED",
                        "此平台没有原生测试键盘入口",
                    ));
                    let _ = send.send(result);
                })
                .map_err(super::desktop_error)?;
            let result = receive.await.map_err(super::desktop_error)?;
            if result
                .as_ref()
                .is_err_and(|error| error.code == "E2E_INPUT_PENDING")
            {
                // Activation can finish on a later AppKit iteration. Pending
                // guarantees that no key event has yet been sent.
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                continue;
            }
            return result;
        }
    })
    .await
    .map_err(|_| HostError::new("E2E_INPUT_TIMEOUT", "原生键盘请求超时"))?
}
