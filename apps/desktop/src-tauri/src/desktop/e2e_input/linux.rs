use crate::common::{HostError, HostResult};
use gtk::glib::translate::{from_glib_full, IntoGlib, ToGlibPtr};
use gtk::{gdk, prelude::*};

pub(super) fn press_tab(
    native: tauri::webview::PlatformWebview,
    backwards: bool,
) -> HostResult<()> {
    let webview = native.inner();
    if !webview.is_realized() || !webview.is_mapped() {
        return Err(input_error("WebView 尚未显示，无法发送原生 Tab"));
    }
    let window = webview
        .window()
        .ok_or_else(|| input_error("WebView 原生窗口不存在"))?;
    let display = webview.display();
    let keyboard = display
        .default_seat()
        .and_then(|seat| seat.keyboard())
        .ok_or_else(|| input_error("当前显示服务没有键盘设备"))?;
    let keymap = gdk::Keymap::for_display(&display)
        .ok_or_else(|| input_error("当前显示服务没有键盘映射"))?;
    let (hardware_keycode, group) = keymap
        .entries_for_keyval(*gdk::keys::constants::Tab)
        .iter()
        .filter(|key| key.level() == 0)
        .find_map(|key| {
            Some((
                u16::try_from(key.keycode()).ok()?,
                u8::try_from(key.group()).ok()?,
            ))
        })
        .ok_or_else(|| input_error("键盘映射没有可用的 Tab 键"))?;
    if !webview.has_focus() {
        // Focus the native widget, preserving the page's current DOM focus.
        webview.grab_focus();
    }
    if !webview.has_focus() {
        return Err(input_error("WebView 未获得原生键盘焦点"));
    }
    let state = if backwards {
        gdk::ModifierType::SHIFT_MASK
    } else {
        gdk::ModifierType::empty()
    };
    let keyval = if backwards {
        *gdk::keys::constants::ISO_Left_Tab
    } else {
        *gdk::keys::constants::Tab
    };
    for kind in [gdk::EventType::KeyPress, gdk::EventType::KeyRelease] {
        // SAFETY: with_webview executes on GTK's main thread. gdk_event_new
        // transfers ownership; Event frees it and its window/device references.
        let mut event: gdk::Event =
            unsafe { from_glib_full(gdk::ffi::gdk_event_new(kind.into_glib())) };
        let key = event
            .downcast_mut::<gdk::EventKey>()
            .ok_or_else(|| input_error("无法创建原生 Tab 事件"))?;
        let fields: &mut gdk::ffi::GdkEventKey = key.as_mut();
        fields.window = window.to_glib_full();
        fields.send_event = 1;
        fields.time = gdk::ffi::GDK_CURRENT_TIME as u32;
        fields.state = state.into_glib();
        fields.keyval = keyval;
        fields.hardware_keycode = hardware_keycode;
        fields.group = group;
        event.set_device(Some(&keyboard));
        event.set_source_device(Some(&keyboard));
        // GTK routes native key events into WebKit's normal keyboard handler,
        // including browser default Tab navigation and keyboard focus modality.
        // Unlike XSendEvent, this works without disabling XI2 globally.
        gtk::main_do_event(&mut event);
    }
    Ok(())
}

fn input_error(message: &str) -> HostError {
    HostError::new("E2E_INPUT_FAILED", message)
}
