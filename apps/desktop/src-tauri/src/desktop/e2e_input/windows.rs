use crate::common::{HostError, HostResult};
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOT};

pub(super) fn press_tab(
    native: tauri::webview::PlatformWebview,
    backwards: bool,
) -> HostResult<()> {
    let controller = native.controller();
    let mut parent = HWND::default();
    // SAFETY: with_webview runs on the UI thread with a live controller. All
    // Win32 input buffers remain valid for these synchronous calls.
    unsafe {
        controller
            .ParentWindow(&mut parent)
            .map_err(|error| input_error(format!("无法读取 WebView 原生窗口：{error}")))?;
        let root = GetAncestor(parent, GA_ROOT);
        if root.is_invalid() || GetForegroundWindow() != root {
            return Err(input_error("应用必须位于前台才能发送原生 Tab"));
        }
        // Never release or combine a user's already-held keys with test input.
        for key in [VK_TAB, VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN] {
            if GetAsyncKeyState(i32::from(key.0)) < 0 {
                return Err(input_error("键盘已有按住的 Tab 或修饰键，请先释放"));
            }
        }
        // PROGRAMMATIC restores the WebView's current focus, unlike NEXT/PREVIOUS
        // which would itself advance page focus before the real Tab arrives.
        controller
            .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
            .map_err(|error| input_error(format!("无法聚焦 WebView：{error}")))?;
        if GetForegroundWindow() != root {
            return Err(input_error("发送原生 Tab 前应用失去前台焦点"));
        }
        let mut inputs = Vec::with_capacity(4);
        if backwards {
            inputs.push(key_input(VK_SHIFT, false));
        }
        inputs.push(key_input(VK_TAB, false));
        inputs.push(key_input(VK_TAB, true));
        if backwards {
            inputs.push(key_input(VK_SHIFT, true));
        }
        let size = std::mem::size_of::<INPUT>() as i32;
        let sent = SendInput(&inputs, size);
        if sent as usize != inputs.len() {
            // A partial insertion must not leave our Tab/Shift held down.
            // No input was inserted when sent == 0, so no release is needed.
            let released = if sent > 0 {
                let mut releases = vec![key_input(VK_TAB, true)];
                if backwards {
                    releases.push(key_input(VK_SHIFT, true));
                }
                SendInput(&releases, size) as usize == releases.len()
            } else {
                true
            };
            return Err(input_error(format!(
                "原生 Tab 只发送了 {sent}/{} 个事件，按键释放{}",
                inputs.len(),
                if released { "完成" } else { "失败" }
            )));
        }
    }
    Ok(())
}

fn key_input(key: VIRTUAL_KEY, released: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: if released {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                ..Default::default()
            },
        },
    }
}

fn input_error(message: impl Into<String>) -> HostError {
    HostError::new("E2E_INPUT_FAILED", message)
}
