//! GitHub Copilot as an AI provider, through the officially supported
//! Agent Client Protocol server of the user's own `copilot` CLI
//! (`copilot --acp --stdio`).
//!
//! * `acp`      - the JSON-RPC/ACP client over the child's stdio.
//! * `detect`   - find the CLI, its version, the restricted launch, the login terminal.
//! * `hub`      - the shared process and the one-fresh-session-per-request life cycle.
//! * `status`   - the connection status for Settings (`copilot_status`).
//! * `provider` - the `LLMProvider` implementation.
//!
//! Authentication is entirely the CLI's own (`copilot login`); NexQ reads no
//! credential, stores no token and only reports what the CLI says.

pub mod acp;
pub mod detect;
pub mod hub;
mod notice;
pub mod provider;
pub mod status;

pub use hub::{CopilotError, CopilotErrorKind, CopilotHub, CopilotModel};
pub use provider::CopilotProvider;
pub use status::{check_status, CopilotState, CopilotStatus};
