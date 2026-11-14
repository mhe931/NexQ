//! The connection status shown in Settings, derived only from what the
//! official CLI itself reports: `copilot --version`, the ACP handshake and a
//! `session/new` (with its genuine error text). No credential file is read.

use super::detect::{copilot_version, find_npm_copilot, INSTALL_HINT, LOGIN_HINT};
use super::hub::{CopilotError, CopilotErrorKind, CopilotHub, CopilotModel};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CopilotState {
    /// No `copilot` executable found.
    NotInstalled,
    /// The CLI reports that a sign-in is needed.
    NotLoggedIn,
    /// Signed in, but Copilot is not available to the account (plan / policy / no enabled model).
    NoEntitlement,
    /// The CLI did not answer in time.
    Timeout,
    /// The handshake or session failed for another reason (see `error`).
    ProtocolError,
    /// The CLI answered the handshake and opened a session listing models for this account.
    Ready,
}

/// Mirrors the TypeScript `CopilotStatus` (`copilot_status` command).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CopilotStatus {
    pub state: CopilotState,
    pub installed: bool,
    pub binary_path: Option<String>,
    /// From `copilot --version`; `None` when that probe failed.
    pub version: Option<String>,
    /// Only an npm shim (`copilot.cmd`) was found; NexQ needs the standalone executable.
    pub npm_only: bool,
    /// `initialize` was answered.
    pub handshake_ok: bool,
    /// `session/new` succeeded.
    pub session_ok: bool,
    /// The live catalog the CLI reported (empty unless `session_ok`).
    pub models: Vec<CopilotModel>,
    /// The CLI's own default model for a new session.
    pub current_model: Option<String>,
    /// The genuine failure text, when `state` is not `ready`.
    pub error: Option<String>,
    /// What to do about it (sign-in / install instructions).
    pub login_hint: String,
}

impl CopilotStatus {
    fn base() -> Self {
        Self {
            state: CopilotState::ProtocolError,
            installed: true,
            binary_path: None,
            version: None,
            npm_only: false,
            handshake_ok: false,
            session_ok: false,
            models: Vec::new(),
            current_model: None,
            error: None,
            login_hint: LOGIN_HINT.to_string(),
        }
    }

    /// Models enabled for this account.
    pub fn entitled_models(&self) -> impl Iterator<Item = &CopilotModel> {
        self.models.iter().filter(|m| m.enabled)
    }
}

fn state_of(kind: CopilotErrorKind) -> CopilotState {
    match kind {
        CopilotErrorKind::NotInstalled => CopilotState::NotInstalled,
        CopilotErrorKind::NotLoggedIn => CopilotState::NotLoggedIn,
        CopilotErrorKind::NoEntitlement => CopilotState::NoEntitlement,
        CopilotErrorKind::Timeout => CopilotState::Timeout,
        _ => CopilotState::ProtocolError,
    }
}

fn fail(mut status: CopilotStatus, error: CopilotError) -> CopilotStatus {
    status.state = state_of(error.kind);
    status.error = Some(error.message);
    status
}

/// Probe the CLI: version, handshake, a throw-away session (closed again).
/// Never fails: every problem becomes a state with the CLI's own message.
pub async fn check_status(hub: &CopilotHub) -> CopilotStatus {
    let mut status = CopilotStatus::base();

    let spec = match hub.launch_spec().await {
        Ok(spec) => spec,
        Err(error) => {
            status.installed = false;
            status.npm_only = tokio::task::spawn_blocking(find_npm_copilot)
                .await
                .ok()
                .flatten()
                .is_some();
            status.login_hint = INSTALL_HINT.to_string();
            let mut status = fail(status, error);
            if status.npm_only {
                status.error = Some(
                    "Only an npm install of the Copilot CLI was found. NexQ needs the standalone copilot executable."
                        .to_string(),
                );
            }
            return status;
        }
    };
    status.binary_path = Some(spec.program.to_string_lossy().into_owned());
    status.version = copilot_version(&spec.program)
        .await
        .map_err(|e| log::warn!("Copilot CLI version probe failed: {e}"))
        .ok();

    let live = match hub.connection().await {
        Ok(live) => live,
        Err(error) => return fail(status, error),
    };
    status.handshake_ok = true;
    if status.version.is_none() {
        status.version = live.info.version.clone();
    }

    let session = match hub.open_session(&live).await {
        Ok(session) => session,
        Err(error) => return fail(status, error),
    };
    hub.close_session(&live, &session.id);
    status.session_ok = true;
    status.current_model = session.current_model;
    status.models = session.models;

    if status.entitled_models().next().is_none() {
        status.state = CopilotState::NoEntitlement;
        status.error = Some(
            "The Copilot CLI answered, but lists no model enabled for this account. \
             Check that your GitHub account has an active Copilot plan and that your organization allows it."
                .to_string(),
        );
        return status;
    }
    status.state = CopilotState::Ready;
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_serialize_in_snake_case_for_the_frontend() {
        assert_eq!(serde_json::to_value(CopilotState::NotLoggedIn).unwrap(), "not_logged_in");
        assert_eq!(serde_json::to_value(CopilotState::NoEntitlement).unwrap(), "no_entitlement");
        assert_eq!(serde_json::to_value(CopilotState::ProtocolError).unwrap(), "protocol_error");
        assert_eq!(serde_json::to_value(CopilotState::NotInstalled).unwrap(), "not_installed");
    }

    #[test]
    fn error_kinds_map_to_distinct_states() {
        assert_eq!(state_of(CopilotErrorKind::NotInstalled), CopilotState::NotInstalled);
        assert_eq!(state_of(CopilotErrorKind::NotLoggedIn), CopilotState::NotLoggedIn);
        assert_eq!(state_of(CopilotErrorKind::NoEntitlement), CopilotState::NoEntitlement);
        assert_eq!(state_of(CopilotErrorKind::Timeout), CopilotState::Timeout);
        assert_eq!(state_of(CopilotErrorKind::Protocol), CopilotState::ProtocolError);
    }
}
