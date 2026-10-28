use crate::common::{HostError, HostResult};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
use objc2_foundation::{NSPoint, NSProcessInfo, NSString};

pub(super) fn press_tab(
    native: tauri::webview::PlatformWebview,
    backwards: bool,
) -> HostResult<()> {
    let main_thread = MainThreadMarker::new()
        .ok_or_else(|| HostError::new("E2E_INPUT_FAILED", "原生键盘请求必须运行在主线程"))?;
    let app = NSApplication::sharedApplication(main_thread);
    if !app.isActive() {
        // Keep compatibility with the app's macOS 13.3 minimum.
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
    }
    // SAFETY: with_webview runs on the main thread and owns the live native
    // webview/window for this callback. The reference never leaves it.
    let window = unsafe { native.ns_window().cast::<NSWindow>().as_ref() }
        .ok_or_else(|| HostError::new("WINDOW_MISSING", "原生主窗口不存在"))?;
    window.makeKeyAndOrderFront(None);
    if !app.isActive() || !window.isKeyWindow() {
        return Err(HostError::new("E2E_INPUT_PENDING", "正在激活测试窗口"));
    }
    let flags = if backwards {
        NSEventModifierFlags::Shift
    } else {
        NSEventModifierFlags::empty()
    };
    let characters = NSString::from_str("\t");
    for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            flags,
            NSProcessInfo::processInfo().systemUptime(),
            window.windowNumber(),
            None,
            &characters,
            &characters,
            false,
            48,
        ).ok_or_else(|| HostError::new("E2E_INPUT_FAILED", "无法创建原生 Tab 事件"))?;
        window.sendEvent(&event);
    }
    Ok(())
}
