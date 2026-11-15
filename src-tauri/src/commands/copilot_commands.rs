//! GitHub Copilot provider: connection status, sign-in hint and login terminal.
//!
//! Authentication is the official CLI's own (`copilot login`). NexQ reads no
//! credential file and stores no token; it only reports what the CLI says.

use std::path::PathBuf;
use tauri::command;

use crate::llm::copilot::detect::{find_copilot_binary, login_launch, INSTALL_HINT, LOGIN_HINT};
use crate::llm::copilot::{check_status, CopilotHub, CopilotStatus};

async fn resolve_binary() -> Option<PathBuf> {
    tokio::task::spawn_blocking(find_copilot_binary)
        .await
        .ok()
        .flatten()
}

/// Probe the Copilot CLI: installed? version? and, from a real ACP handshake
/// plus a throw-away `session/new`, whether it answers and lists models for
/// this account. Makes no model call, so readiness does not establish chat
/// entitlement. Errors are sanitized; raw RPC text/stderr never enters IPC.
#[command]
pub async fn copilot_status() -> Result<CopilotStatus, String> {
    Ok(check_status(&CopilotHub::global()).await)
}

/// What to tell the user to do next: install the CLI, or sign in with
/// `copilot login` in a terminal.
#[command]
pub async fn copilot_login_hint() -> Result<String, String> {
    Ok(match resolve_binary().await {
        Some(_) => LOGIN_HINT.to_string(),
        None => INSTALL_HINT.to_string(),
    })
}

/// Open a visible terminal running `copilot login`. NexQ reads nothing from
/// it; the sign-in stays between the user and the CLI.
#[command]
pub async fn open_copilot_login_terminal() -> Result<(), String> {
    let bin = resolve_binary().await;
    let (dir, command_line) = login_launch(bin.as_deref());
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut cmd = std::process::Command::new(comspec);
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Exact quoting for cmd.exe; this outer cmd has no window of its own
        // (CREATE_NO_WINDOW), `start` gives `copilot login` a fresh visible console.
        cmd.raw_arg(command_line).creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    cmd.arg(command_line);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open a terminal: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::copilot::CopilotState;

    #[test]
    fn status_serializes_snake_case_for_the_frontend() {
        let status = CopilotStatus {
            state: CopilotState::NotLoggedIn,
            installed: true,
            binary_path: Some("c".into()),
            version: Some("1.0.105".into()),
            npm_only: false,
            handshake_ok: true,
            session_ok: false,
            models: Vec::new(),
            current_model: None,
            error: Some("Authentication required".into()),
            login_hint: LOGIN_HINT.to_string(),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "not_logged_in");
        assert_eq!(json["binary_path"], "c");
        assert_eq!(json["handshake_ok"], true);
        assert_eq!(json["session_ok"], false);
        assert_eq!(json["error"], "Authentication required");
        assert!(json["login_hint"].as_str().unwrap().contains("copilot login"));
        assert!(json["models"].as_array().unwrap().is_empty());
    }
}
