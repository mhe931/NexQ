//! Startup checks that run before any window exists.
//!
//! A `nexq.exe` compiled with plain `cargo build` / `cargo test` (instead of
//! `npx tauri build`) lacks Tauri's `custom-protocol` feature. Such a binary has
//! no bundled interface and loads the development server (`devUrl`,
//! http://localhost:5173) instead, which shows the browser error
//! "localhost refused to connect" when no Vite server is running. This module
//! turns that silent failure into a plain explanation, and lets the install
//! script prove a binary carries its interface (`--self-test`).

use std::ffi::OsString;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

/// Must equal the port of `build.devUrl` in `tauri.conf.json` (checked by a test).
pub const DEV_SERVER: &str = "localhost:5173";

/// Exit code of `--self-test` for a binary that has no bundled interface.
pub const SELF_TEST_NO_UI: i32 = 3;

/// True when this binary embeds its frontend (a real `tauri build`).
pub fn has_bundled_ui() -> bool {
    !tauri::is_dev()
}

fn dev_server_listening() -> bool {
    let Ok(addrs) = DEV_SERVER.to_socket_addrs() else { return false };
    addrs.collect::<Vec<SocketAddr>>().iter().any(|a| TcpStream::connect_timeout(a, Duration::from_millis(400)).is_ok())
}

/// What a launch of this binary should do before starting the app, as an exit code.
/// `Some(code)` means "exit with this code now".
pub fn early_exit(args: impl IntoIterator<Item = OsString>) -> Option<i32> {
    decide(args, has_bundled_ui(), dev_server_listening)
}

fn decide(args: impl IntoIterator<Item = OsString>, bundled: bool, dev_server: impl Fn() -> bool) -> Option<i32> {
    if args.into_iter().any(|a| a == "--self-test") {
        return Some(if bundled { 0 } else { SELF_TEST_NO_UI });
    }
    if bundled || dev_server() {
        return None;
    }
    explain_missing_ui();
    Some(2)
}

const MESSAGE: &str = "This copy of NexQ was built without its bundled interface (a developer build), and no \
development server is running at http://localhost:5173, so it has nothing to show.\n\n\
Start NexQ from the desktop shortcut or the installed copy instead. To make one from the source, run \
scripts\\install-user.ps1 (it builds with `npx tauri build`, which bundles the interface).";

#[cfg(windows)]
fn explain_missing_ui() {
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let text: Vec<u16> = MESSAGE.encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(None, windows::core::PCWSTR(text.as_ptr()), w!("NexQ cannot start"), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn explain_missing_ui() {
    eprintln!("{MESSAGE}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn a_bundled_build_just_starts() {
        assert_eq!(decide(args(&["nexq.exe"]), true, || false), None);
    }

    #[test]
    fn a_developer_build_with_a_running_dev_server_starts() {
        assert_eq!(decide(args(&["nexq.exe"]), false, || true), None);
    }

    #[test]
    fn a_developer_build_without_a_server_is_refused_with_a_reason_instead_of_a_browser_error() {
        // (the message box is only shown on Windows; here the decision is what matters)
        #[cfg(not(windows))]
        assert_eq!(decide(args(&["nexq"]), false, || false), Some(2));
        #[cfg(windows)]
        {
            // Not calling `decide` on Windows: it would block on a modal message box.
            assert!(MESSAGE.contains("localhost:5173"));
        }
    }

    #[test]
    fn self_test_reports_whether_the_interface_is_bundled() {
        assert_eq!(decide(args(&["nexq.exe", "--self-test"]), true, || false), Some(0));
        assert_eq!(decide(args(&["nexq.exe", "--self-test"]), false, || true), Some(SELF_TEST_NO_UI));
    }

    #[test]
    fn the_guarded_port_is_the_one_tauri_would_load() {
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains(&format!("\"devUrl\": \"http://{DEV_SERVER}\"")), "DEV_SERVER must match build.devUrl");
    }
}
