//! `CopilotProvider`: the `LLMProvider` face of the GitHub Copilot CLI.
//!
//! Copilot is reached only through the officially supported Agent Client
//! Protocol server of the user's own, signed-in `copilot` CLI. Every call
//! gets a FRESH ACP session on the shared process (see `hub.rs`), so the full
//! `messages` list of the call is all Copilot ever sees; nothing carries over
//! from one request - or meeting - to the next.
//!
//! The provider holds no state besides the shared hub, so `create_provider`
//! needs no access to `AppState`.

use super::hub::{AskEvent, CopilotError, CopilotErrorKind, CopilotHub};
use super::status::{check_status, CopilotState};
use crate::llm::provider::{
    emit_end_with_usage, emit_error, emit_thinking, emit_token, is_cancelled, CancelToken,
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo, StreamUsage,
    TokenSink,
};
use std::sync::Arc;
use std::time::Instant;

pub const PROVIDER_NAME: &str = "github_copilot";

/// Copilot sessions carry no system prompt of ours; this first line keeps the
/// model from reaching for tools it does not have.
const PREAMBLE: &str = "Answer directly in plain text. You have no tools, files, shell or web \
access in this conversation; do not try to use them.";

pub struct CopilotProvider {
    hub: Arc<CopilotHub>,
}

impl CopilotProvider {
    /// Uses the app-wide hub (one `copilot --acp` process for the whole app).
    pub fn new() -> Self {
        Self::with_hub(CopilotHub::global())
    }

    pub fn with_hub(hub: Arc<CopilotHub>) -> Self {
        Self { hub }
    }
}

impl Default for CopilotProvider {
    fn default() -> Self {
        Self::new()
    }
}

fn capitalized(role: &str) -> String {
    let mut chars = role.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// One prompt out of a message list. System messages become a leading
/// `## Instructions` block; a single user message follows as it is; a longer
/// conversation follows as a labelled transcript.
pub fn build_prompt(messages: &[LLMMessage]) -> String {
    let instructions: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == "system" && !m.content.trim().is_empty())
        .map(|m| m.content.as_str())
        .collect();
    let turns: Vec<&LLMMessage> = messages.iter().filter(|m| m.role != "system").collect();

    let mut blocks = vec![PREAMBLE.to_string()];
    if !instructions.is_empty() {
        blocks.push(format!("## Instructions\n\n{}", instructions.join("\n\n")));
    }
    match turns.as_slice() {
        [] => {}
        [only] if only.role == "user" => blocks.push(only.content.clone()),
        many => {
            let transcript: Vec<String> = many
                .iter()
                .map(|m| format!("{}: {}", capitalized(&m.role), m.content))
                .collect();
            blocks.push(format!(
                "## Conversation\n\n{}\n\nReply as the Assistant to the last message above.",
                transcript.join("\n\n")
            ));
        }
    }
    blocks.join("\n\n")
}

/// Map a Copilot failure onto the provider errors the callers already handle.
pub fn to_llm_error(error: CopilotError) -> LLMError {
    let message = error.message;
    match error.kind {
        CopilotErrorKind::Cancelled => LLMError::Cancelled,
        CopilotErrorKind::NotInstalled => LLMError::NotConfigured(message),
        CopilotErrorKind::NotLoggedIn | CopilotErrorKind::NoEntitlement => LLMError::AuthError(message),
        CopilotErrorKind::Timeout | CopilotErrorKind::Protocol => LLMError::ConnectionFailed(message),
        CopilotErrorKind::ModelUnavailable | CopilotErrorKind::ToolBlocked | CopilotErrorKind::Refused => {
            LLMError::ProviderError(message)
        }
    }
}

/// What a finished completion reports.
pub struct Completion {
    pub stats: CompletionStats,
    pub usage: Option<StreamUsage>,
}

impl CopilotProvider {
    /// Runs the request and hands each piece of text to `on_text` (and the
    /// thinking signal, once, to `on_thinking`). No Tauri involved, so tests
    /// can run it against a scripted ACP server.
    pub async fn complete(
        &self,
        messages: &[LLMMessage],
        model: &str,
        cancel: &CancelToken,
        on_text: &mut (dyn FnMut(&str) + Send),
        on_thinking: &mut (dyn FnMut() + Send),
    ) -> Result<Completion, LLMError> {
        let start = Instant::now();
        let prompt = build_prompt(messages);
        let mut on_event = |event: AskEvent<'_>| match event {
            AskEvent::Text(text) => on_text(text),
            AskEvent::Thinking => on_thinking(),
        };
        let answer = self
            .hub
            .ask(&prompt, model, cancel, &mut on_event)
            .await
            .map_err(to_llm_error)?;
        let latency_ms = start.elapsed().as_millis() as u64;
        // Counts come from the CLI or stay zero: nothing is estimated.
        let (stats, usage) = match answer.usage {
            Some(u) => (
                CompletionStats {
                    prompt_tokens: u.input_tokens,
                    completion_tokens: u.output_tokens,
                    total_tokens: u.total_tokens,
                    latency_ms,
                },
                Some(StreamUsage {
                    input_tokens: u
                        .input_tokens
                        .saturating_sub(u.cached_read_tokens + u.cached_write_tokens),
                    cache_read_tokens: u.cached_read_tokens,
                    cache_write_tokens: u.cached_write_tokens,
                    output_tokens: u.output_tokens,
                    thinking_tokens: u.thought_tokens,
                    cost_usd: None,
                    first_token_ms: answer.first_token_ms,
                }),
            ),
            // No usage reported: zero counts and no usage block, never a guess.
            None => (
                CompletionStats {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                    latency_ms,
                },
                None,
            ),
        };
        Ok(Completion { stats, usage })
    }
}

#[async_trait::async_trait]
impl LLMProvider for CopilotProvider {
    fn provider_name(&self) -> &str {
        PROVIDER_NAME
    }

    /// The live catalog the CLI reports for this account; an error when the
    /// CLI cannot be reached (no made-up list stands in for it).
    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        let models = self.hub.catalog().await.map_err(to_llm_error)?;
        let models: Vec<ModelInfo> = models
            .into_iter()
            .filter(|m| m.enabled)
            .map(|m| ModelInfo {
                id: m.id,
                name: m.name,
                provider: PROVIDER_NAME.to_string(),
                context_window: None,
            })
            .collect();
        if models.is_empty() {
            return Err(LLMError::AuthError(
                "The Copilot CLI lists no model enabled for this account".to_string(),
            ));
        }
        Ok(models)
    }

    /// `Ok(true)` only when the CLI answered the ACP handshake and a new
    /// session listed models for this account.
    async fn test_connection(&self) -> Result<bool, LLMError> {
        let status = check_status(&self.hub).await;
        let error = status.error.clone().unwrap_or_else(|| "unknown error".to_string());
        match status.state {
            CopilotState::Ready => Ok(true),
            CopilotState::NotInstalled => Err(LLMError::NotConfigured(format!(
                "{error}. {}",
                status.login_hint
            ))),
            CopilotState::NotLoggedIn => Err(LLMError::AuthError(format!("{error}. {}", status.login_hint))),
            CopilotState::NoEntitlement => Err(LLMError::AuthError(error)),
            CopilotState::Timeout | CopilotState::ProtocolError => Err(LLMError::ConnectionFailed(error)),
        }
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        let cancel = params
            .cancel
            .clone()
            .unwrap_or_else(|| Arc::new(CancelToken::new()));
        let mut on_text = |text: &str| {
            if !is_cancelled(&params) {
                emit_token(&app_handle, &params, text, sink.as_ref());
            }
        };
        let mut on_thinking = || {
            if !is_cancelled(&params) {
                emit_thinking(&app_handle, &params);
            }
        };
        match self
            .complete(&messages, model, &cancel, &mut on_text, &mut on_thinking)
            .await
        {
            Ok(done) => {
                if is_cancelled(&params) {
                    return Err(LLMError::Cancelled);
                }
                emit_end_with_usage(
                    &app_handle,
                    &params,
                    done.stats.total_tokens,
                    done.stats.latency_ms,
                    done.usage,
                );
                Ok(done.stats)
            }
            Err(err) => {
                // A stopped stream already got its end from `cancel_generation`.
                if matches!(err, LLMError::Cancelled) || is_cancelled(&params) {
                    return Err(LLMError::Cancelled);
                }
                emit_error(&app_handle, &params, &err.to_string());
                Err(err)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> LLMMessage {
        LLMMessage { role: role.to_string(), content: content.to_string() }
    }

    #[test]
    fn a_single_user_message_follows_the_instructions_unlabelled() {
        let prompt = build_prompt(&[msg("system", "Be brief."), msg("user", "Hi")]);
        assert_eq!(prompt, format!("{PREAMBLE}\n\n## Instructions\n\nBe brief.\n\nHi"));
        assert_eq!(build_prompt(&[msg("user", "Translate x")]), format!("{PREAMBLE}\n\nTranslate x"));
    }

    #[test]
    fn several_system_messages_are_joined_into_one_instructions_block() {
        let prompt = build_prompt(&[msg("system", "A"), msg("system", "  "), msg("system", "B"), msg("user", "Q")]);
        assert_eq!(prompt, format!("{PREAMBLE}\n\n## Instructions\n\nA\n\nB\n\nQ"));
    }

    #[test]
    fn multi_turn_chat_becomes_a_labelled_transcript() {
        let prompt = build_prompt(&[
            msg("system", "You are helpful."),
            msg("user", "What is Rust?"),
            msg("assistant", "A language."),
            msg("user", "Who made it?"),
        ]);
        assert_eq!(
            prompt,
            format!(
                "{PREAMBLE}\n\n## Instructions\n\nYou are helpful.\n\n## Conversation\n\n\
                 User: What is Rust?\n\nAssistant: A language.\n\nUser: Who made it?\n\n\
                 Reply as the Assistant to the last message above."
            )
        );
    }

    #[test]
    fn copilot_errors_map_to_llm_errors() {
        let e = |kind| to_llm_error(CopilotError::new(kind, "x"));
        assert!(matches!(e(CopilotErrorKind::Cancelled), LLMError::Cancelled));
        assert!(matches!(e(CopilotErrorKind::NotInstalled), LLMError::NotConfigured(_)));
        assert!(matches!(e(CopilotErrorKind::NotLoggedIn), LLMError::AuthError(_)));
        assert!(matches!(e(CopilotErrorKind::NoEntitlement), LLMError::AuthError(_)));
        assert!(matches!(e(CopilotErrorKind::Timeout), LLMError::ConnectionFailed(_)));
        assert!(matches!(e(CopilotErrorKind::Protocol), LLMError::ConnectionFailed(_)));
        assert!(matches!(e(CopilotErrorKind::ModelUnavailable), LLMError::ProviderError(_)));
        assert!(matches!(e(CopilotErrorKind::ToolBlocked), LLMError::ProviderError(_)));
    }

    #[test]
    fn provider_identity() {
        let hub = Arc::new(CopilotHub::new(Arc::new(|| {
            Err(CopilotError::new(CopilotErrorKind::NotInstalled, "none"))
        })));
        assert_eq!(CopilotProvider::with_hub(hub).provider_name(), "github_copilot");
    }
}
