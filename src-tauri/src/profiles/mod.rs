//! Per-meeting profiles: independent settings, documents, prompts and routing.

pub mod extract;
pub mod failover;
pub mod ingest;
pub mod model;
pub mod prompt;
pub mod retrieval;
pub mod routing;
pub mod store;
pub mod templates;

use std::sync::{Arc, Mutex};

use model::MeetingProfile;
use routing::{LatencyBook, RoutingPolicy};

/// The profile of the meeting currently running (or being rehearsed).
/// Everything the answer pipeline needs is resolved once at activation.
#[derive(Debug, Clone)]
pub struct ActiveProfile {
    pub profile: MeetingProfile,
    /// Safety rules + meeting prompt + style + instructions (see `prompt`).
    pub system_prompt: String,
    pub policy: Option<RoutingPolicy>,
    /// Measured provider latency for this app session.
    pub book: Arc<Mutex<LatencyBook>>,
}

impl ActiveProfile {
    pub fn new(
        profile: MeetingProfile,
        instruction_files: &[(String, String)],
        book: Arc<Mutex<LatencyBook>>,
    ) -> Self {
        let system_prompt = prompt::compose_system_prompt(&profile, instruction_files).text;
        let policy = RoutingPolicy::from_settings(&profile.ai);
        Self { profile, system_prompt, policy, book }
    }

    /// True when a failed request may be retried on a consented fallback.
    pub fn has_failover(&self) -> bool {
        self.policy
            .as_ref()
            .is_some_and(|p| p.automatic && p.fallback.is_some())
    }
}
