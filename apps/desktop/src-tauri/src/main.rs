#![cfg_attr(
    all(not(debug_assertions), not(feature = "desktop-e2e")),
    windows_subsystem = "windows"
)]

fn main() {
    tanwei_desktop::run();
}
