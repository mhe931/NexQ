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
    emit_end_with_usage, emit_llm_error, emit_thinking, emit_token, is_cancelled, CancelToken,
    classify_failure, CompletionStats, GenerationParams, LLMError, LLMFailureKind, LLMMessage, LLMProvider, ModelInfo, StreamUsage,
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
    // ACP may wrap a provider's billing / limit failure in a generic RPC
    // error. Preserve its nontransient meaning before discarding the text.
    if !matches!(error.kind, CopilotErrorKind::Cancelled | CopilotErrorKind::NotInstalled) {
        let detail = classify_failure(&error.message);
        if matches!(detail, LLMFailureKind::CreditsExhausted | LLMFailureKind::RateLimited | LLMFailureKind::InvalidApiKey) {
            return LLMError::classified(detail, PROVIDER_NAME);
        }
    }
    let kind = match error.kind {
        CopilotErrorKind::Cancelled => return LLMError::Cancelled,
        CopilotErrorKind::NotInstalled => LLMFailureKind::NotConfigured,
        CopilotErrorKind::NotLoggedIn | CopilotErrorKind::NoEntitlement => LLMFailureKind::Authentication,
        CopilotErrorKind::Timeout => LLMFailureKind::Timeout,
        CopilotErrorKind::Protocol => LLMFailureKind::Unavailable,
        CopilotErrorKind::ModelUnavailable | CopilotErrorKind::ToolBlocked | CopilotErrorKind::Refused => {
            LLMFailureKind::ProviderError
        }
    };
    // Raw RPC text / stderr can echo credentials or the prompt. The status
    // state retains the entitlement distinction; the LLM error stays safe.
    LLMError::classified(kind, PROVIDER_NAME)
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
            return Err(LLMError::classified(LLMFailureKind::Authentication, PROVIDER_NAME));
        }
        Ok(models)
    }

    /// `Ok(true)` only when the CLI answered the ACP handshake and a new
    /// session listed models for this account.
    async fn test_connection(&self) -> Result<bool, LLMError> {
        let status = check_status(&self.hub).await;
        match status.state {
            CopilotState::Ready => Ok(true),
            CopilotState::NotInstalled => Err(LLMError::classified(LLMFailureKind::NotConfigured, PROVIDER_NAME)),
            CopilotState::NotLoggedIn | CopilotState::NoEntitlement => Err(LLMError::classified(LLMFailureKind::Authentication, PROVIDER_NAME)),
            CopilotState::Timeout => Err(LLMError::classified(LLMFailureKind::Timeout, PROVIDER_NAME)),
            CopilotState::ProtocolError => Err(LLMError::classified(LLMFailureKind::Unavailable, PROVIDER_NAME)),
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
                emit_llm_error(&app_handle, &params, &err);
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
    fn meeting_instructions_and_context_survive_copilot_prompt_assembly() {
        let instructions = "Public test scenario: answer briefly as an interview candidate.";
        let context = "Public test context: the demo meeting is about Rust lifetimes.";
        let question = "How do lifetimes avoid dangling references?";
        let prompt = build_prompt(&[
            msg("system", instructions),
            msg("user", context),
            msg("assistant", "I will use that demo context."),
            msg("user", question),
        ]);
        for content in [instructions, context, question] {
            assert_eq!(prompt.matches(content).count(), 1);
        }
        assert!(prompt.find(instructions).unwrap() < prompt.find(context).unwrap());
        assert!(prompt.find(context).unwrap() < prompt.find(question).unwrap());
    }

    #[test]
    fn copilot_error_messages_are_safe_actionable_and_keep_timeout_distinct() {
        use crate::llm::provider::LLMFailureKind;
        for (kind, expected) in [
            (CopilotErrorKind::NotLoggedIn, LLMFailureKind::Authentication),
            (CopilotErrorKind::NoEntitlement, LLMFailureKind::Authentication),
            (CopilotErrorKind::Timeout, LLMFailureKind::Timeout),
            (CopilotErrorKind::Protocol, LLMFailureKind::Unavailable),
        ] {
            let error = to_llm_error(CopilotError::new(kind, "private-stderr-sentinel"));
            assert_eq!(error.kind(), expected);
            assert!(!error.to_string().contains("sentinel"));
            assert!(error.safe_message().contains("Copilot"));
        }
        let login = to_llm_error(CopilotError::new(CopilotErrorKind::NotLoggedIn, "raw"));
        assert!(login.safe_message().contains("copilot login"));
        let entitlement = to_llm_error(CopilotError::new(CopilotErrorKind::NoEntitlement, "raw"));
        assert!(entitlement.safe_message().contains("plan"));
        assert!(!entitlement.is_retryable());
    }

    #[test]
    fn rpc_billing_errors_do_not_become_retryable_connection_failures() {
        for marker in ["insufficient_quota", "credit_balance_exhausted", "no credits"] {
            let error = to_llm_error(CopilotError::new(
                CopilotErrorKind::Protocol, format!("HTTP 429 {marker}; private-sentinel"),
            ));
            assert_eq!(error.kind(), LLMFailureKind::CreditsExhausted);
            assert!(!error.is_retryable());
            assert!(!error.safe_message().contains("sentinel"));
            assert!(error.safe_message().contains("Copilot"));
        }
        let rate = to_llm_error(CopilotError::new(CopilotErrorKind::Protocol, "HTTP 429 rate_limit_exceeded"));
        assert_eq!(rate.kind(), LLMFailureKind::RateLimited);
    }

    #[test]
    fn copilot_errors_map_to_llm_errors() {
        let e = |kind| to_llm_error(CopilotError::new(kind, "x"));
        assert!(matches!(e(CopilotErrorKind::Cancelled), LLMError::Cancelled));
        use crate::llm::provider::LLMFailureKind;
        assert_eq!(e(CopilotErrorKind::NotInstalled).kind(), LLMFailureKind::NotConfigured);
        assert_eq!(e(CopilotErrorKind::NotLoggedIn).kind(), LLMFailureKind::Authentication);
        assert_eq!(e(CopilotErrorKind::NoEntitlement).kind(), LLMFailureKind::Authentication);
        assert_eq!(e(CopilotErrorKind::Timeout).kind(), LLMFailureKind::Timeout);
        assert_eq!(e(CopilotErrorKind::Protocol).kind(), LLMFailureKind::Unavailable);
        assert_eq!(e(CopilotErrorKind::ModelUnavailable).kind(), LLMFailureKind::ProviderError);
        assert_eq!(e(CopilotErrorKind::ToolBlocked).kind(), LLMFailureKind::ProviderError);
    }

    #[test]
    fn provider_identity() {
        let hub = Arc::new(CopilotHub::new(Arc::new(|| {
            Err(CopilotError::new(CopilotErrorKind::NotInstalled, "none"))
        })));
        assert_eq!(CopilotProvider::with_hub(hub).provider_name(), "github_copilot");
    }
}
