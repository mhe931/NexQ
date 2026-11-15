use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

/// Per-request generation parameters.
/// `None` fields mean "use provider default" — they won't be sent in the HTTP body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationParams {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
    /// Gemini context cache name (e.g. "cachedContents/abc123").
    /// When set, GeminiClient uses the cached content instead of re-sending documents.
    /// Ignored by all other providers.
    pub cache_name: Option<String>,
    /// When true, enable provider-native web search/grounding.
    /// Gemini: adds the `google_search` tool. OpenRouter: appends `:online` to the model id.
    /// Ignored by providers without a native web search mechanism.
    pub enable_web_search: bool,
    /// Identifies this stream. Echoed in every `llm_stream_*` payload so listeners
    /// only react to their own request.
    pub request_id: Option<String>,
    /// When true, tokens go only to the caller's `TokenSink` and no `llm_stream_*`
    /// event is emitted (used by internal callers such as LLM translation).
    pub silent: bool,
    /// Awaitable cancel token. Providers race their network awaits against it (see
    /// `cancellable`) and check it before emitting each token, returning
    /// `LLMError::Cancelled` once it fires. Never serialized.
    #[serde(skip)]
    pub cancel: Option<Arc<CancelToken>>,
    /// In-process metadata for routed attempts. `silent` still suppresses
    /// global events; this callback lets the publisher retain their metadata.
    /// Ordinary silent probes/translations leave this unset.
    #[serde(skip)]
    pub metadata_sink: Option<MetadataSink>,
}

impl Default for GenerationParams {
    fn default() -> Self {
        Self {
            temperature: None,
            max_tokens: None,
            cache_name: None,
            enable_web_search: false,
            request_id: None,
            silent: false,
            cancel: None,
            metadata_sink: None,
        }
    }
}

/// Cancellation signal that can be polled (`is_cancelled`) or awaited (`cancelled`).
#[derive(Debug, Default)]
pub struct CancelToken {
    flag: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fires the token and wakes every task currently awaiting `cancelled()`.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolves once the token is cancelled; immediately if it already is.
    pub async fn cancelled(&self) {
        // Register for the wakeup before checking the flag so a `cancel()` landing
        // between the check and the await cannot be missed.
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

/// True when the caller asked this stream to stop.
pub fn is_cancelled(params: &GenerationParams) -> bool {
    params
        .cancel
        .as_ref()
        .map(|token| token.is_cancelled())
        .unwrap_or(false)
}

/// Runs `fut` (a request send, or the next chunk of a response stream) but gives up with
/// `Err(LLMError::Cancelled)` the moment the stream is cancelled, even if `fut` is stalled.
pub async fn cancellable<F: Future>(
    params: &GenerationParams,
    fut: F,
) -> Result<F::Output, LLMError> {
    let Some(token) = params.cancel.as_ref() else {
        return Ok(fut.await);
    };
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(LLMError::Cancelled),
        out = fut => Ok(out),
    }
}

/// `Err(LLMError::Cancelled)` when the stream was cancelled; providers call this
/// before emitting each token. A cancelled stream emits no `llm_stream_error` and
/// no `llm_stream_end` of its own: `cancel_generation` already emitted the end.
pub fn check_cancelled(params: &GenerationParams) -> Result<(), LLMError> {
    if is_cancelled(params) {
        Err(LLMError::Cancelled)
    } else {
        Ok(())
    }
}

/// Callback that receives each streamed token for an in-process caller.
pub type TokenSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Provider metadata, using the existing event payloads. Attempt errors/end
/// events are staged by routing, never published before its decision.
#[derive(Debug, Clone)]
pub enum StreamMetadata {
    Thinking,
    Sources(Vec<StreamSource>),
    End(StreamEndPayload),
    Error(StreamErrorPayload),
}

#[derive(Clone)]
pub struct MetadataSink(Arc<dyn Fn(StreamMetadata) + Send + Sync>);

impl MetadataSink {
    pub fn new(callback: impl Fn(StreamMetadata) + Send + Sync + 'static) -> Self {
        Self(Arc::new(callback))
    }

    pub fn emit(&self, event: StreamMetadata) {
        (self.0)(event);
    }
}

impl std::fmt::Debug for MetadataSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MetadataSink")
    }
}

/// Where a streamed token is delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Only the caller's sink receives it (silent stream).
    Sink,
    /// The global `llm_stream_token` event carries it (a sink, if any, also receives it).
    Global,
}

/// Feeds `token` to the sink (if any) and decides whether it must also be
/// emitted globally. Kept free of `AppHandle` so it can be unit-tested.
fn route_token(params: &GenerationParams, token: &str, sink: Option<&TokenSink>) -> Route {
    if let Some(sink) = sink {
        sink(token);
    }
    if params.silent {
        Route::Sink
    } else {
        Route::Global
    }
}

/// The same routing rule as tokens, without AppHandle so silent/cancelled
/// metadata delivery can be tested directly.
pub(crate) fn route_metadata(params: &GenerationParams, event: &StreamMetadata) -> Route {
    if is_cancelled(params) {
        return Route::Sink;
    }
    if let Some(sink) = &params.metadata_sink {
        sink.emit(event.clone());
    }
    if params.silent { Route::Sink } else { Route::Global }
}

/// Delivers one streamed token: to the sink, and as `llm_stream_token` unless the stream is silent.
pub fn emit_token(app: &AppHandle, params: &GenerationParams, token: &str, sink: Option<&TokenSink>) {
    if route_token(params, token, sink) == Route::Global {
        let _ = app.emit(
            "llm_stream_token",
            StreamTokenPayload {
                token: token.to_string(),
                request_id: params.request_id.clone(),
            },
        );
    }
}

/// Emits `llm_stream_end` for this request (nothing for silent streams).
pub fn emit_end(app: &AppHandle, params: &GenerationParams, total_tokens: u64, latency_ms: u64) {
    emit_end_with_usage(app, params, total_tokens, latency_ms, None);
}

/// [`emit_end`] carrying the request's actual token usage.
pub fn emit_end_with_usage(
    app: &AppHandle,
    params: &GenerationParams,
    total_tokens: u64,
    latency_ms: u64,
    usage: Option<StreamUsage>,
) {
    let payload = StreamEndPayload {
        total_tokens,
        latency_ms,
        request_id: params.request_id.clone(),
        cancelled: false,
        usage,
    };
    if route_metadata(params, &StreamMetadata::End(payload.clone())) == Route::Global {
        let _ = app.emit("llm_stream_end", payload);
    }
}

/// [`emit_end`] for a provider that reports real prompt/completion counts in
/// `stats`: the end also carries them as usage.
pub fn emit_end_with_stats(app: &AppHandle, params: &GenerationParams, stats: &CompletionStats) {
    emit_end_with_usage(
        app,
        params,
        stats.total_tokens,
        stats.latency_ms,
        StreamUsage::from_stats(stats),
    );
}

/// Emits `llm_stream_thinking` for this request (nothing for silent
/// streams): the model is thinking before its first words. Once per request.
pub fn emit_thinking(app: &AppHandle, params: &GenerationParams) {
    if route_metadata(params, &StreamMetadata::Thinking) != Route::Global {
        return;
    }
    let _ = app.emit(
        "llm_stream_thinking",
        StreamThinkingPayload {
            request_id: params.request_id.clone(),
        },
    );
}

/// Emits `llm_stream_error` for this request (nothing for silent streams — the
/// caller gets the error from the returned `Result`).
pub fn emit_error(app: &AppHandle, params: &GenerationParams, message: &str) {
    // Legacy providers pass strings. Classify them before redacting, never
    // forward a provider body or CLI stderr to the UI.
    let error = LLMError::ProviderError(message.to_string());
    emit_llm_error(app, params, &error);
}

/// Emits a typed, sanitized failure, preserving its classification.
pub fn emit_llm_error(app: &AppHandle, params: &GenerationParams, error: &LLMError) {
    // A stopped stream already got its cancelled end event; no error on top of it.
    if is_cancelled(params) || error.kind() == LLMFailureKind::Cancelled {
        return;
    }
    let payload = StreamErrorPayload::from_error(params, error);
    if route_metadata(params, &StreamMetadata::Error(payload.clone())) == Route::Global {
        let _ = app.emit("llm_stream_error", payload);
    }
}

/// Emits `llm_stream_sources` for this request (nothing for silent streams).
pub fn emit_sources(app: &AppHandle, params: &GenerationParams, sources: Vec<StreamSource>) {
    if route_metadata(params, &StreamMetadata::Sources(sources.clone())) != Route::Global {
        return;
    }
    let _ = app.emit(
        "llm_stream_sources",
        StreamSourcesPayload {
            sources,
            request_id: params.request_id.clone(),
        },
    );
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionStats {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMMessage {
    pub role: String,
    pub content: String,
}

/// Stable failure contract shared by providers, routing and the frontend.
/// Retryability describes the failed provider, NOT permission to switch
/// providers, send private context elsewhere, or incur another charge.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LLMFailureKind {
    CreditsExhausted,
    RateLimited,
    InvalidApiKey,
    Authentication,
    Unavailable,
    Timeout,
    NotConfigured,
    InvalidResponse,
    Cancelled,
    #[default]
    ProviderError,
}

impl LLMFailureKind {
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::RateLimited | Self::Unavailable | Self::Timeout)
    }

    /// Only known provider names enter the message. Unknown/custom names
    /// might contain a URL or other private configuration.
    pub fn safe_message(self, provider: &str) -> String {
        let name = match provider {
            "openai" => "OpenAI",
            "groq" => "Groq",
            "openrouter" => "OpenRouter",
            "lm_studio" => "LM Studio",
            "anthropic" => "Anthropic",
            "gemini" => "Gemini",
            "ollama" => "Ollama",
            "github_copilot" => "GitHub Copilot",
            "claude_cli" => "Claude CLI",
            _ => "The selected provider",
        };
        match self {
            Self::CreditsExhausted if provider == "github_copilot" => format!(
                "{name} credits are exhausted or the request allowance has been reached. \
                 Check the account's Copilot usage, billing and organization policy before trying again."
            ),
            Self::CreditsExhausted => format!(
                "{name} API credits are exhausted or the billing limit has been reached. \
                 Check the account's API billing and credit balance before trying again. \
                 A chat subscription does not provide API credits."
            ),
            Self::RateLimited => format!(
                "{name} is rate limited. Wait before trying again, or reduce the request rate."
            ),
            Self::InvalidApiKey => format!(
                "{name} API key is invalid or expired. Check the saved API key in Settings."
            ),
            Self::Authentication if provider == "github_copilot" => format!(
                "{name} authentication or account access failed. Run `copilot login` if signed out; \
                 otherwise check the account's Copilot plan and organization policy."
            ),
            Self::Authentication => format!(
                "{name} authentication or account access failed. Check sign-in, credentials, \
                 account permissions and provider entitlement."
            ),
            Self::Unavailable => format!(
                "{name} is unavailable. Check the provider's service and your connection, then try again."
            ),
            Self::Timeout => format!(
                "{name} request timed out. Check the connection and try again."
            ),
            Self::NotConfigured if provider == "github_copilot" => format!(
                "{name} is not configured. Install the official standalone Copilot CLI and run `copilot login`."
            ),
            Self::NotConfigured => format!(
                "{name} is not configured. Choose a provider and model and check its settings."
            ),
            Self::InvalidResponse => format!(
                "{name} returned an invalid response. Check the selected model and provider settings."
            ),
            Self::Cancelled => "Stream cancelled".to_string(),
            Self::ProviderError => format!(
                "{name} could not complete the request. Check the selected model and provider settings."
            ),
        }
    }
}

/// Classify legacy provider text without retaining or exposing it.
/// Explicit billing exhaustion MUST win over generic quota / HTTP 429.
/// A generic request/token quota can be transient; it is not proof of an
/// empty credit balance.
pub fn classify_failure(message: &str) -> LLMFailureKind {
    let lower = message.to_lowercase();
    let has = |patterns: &[&str]| patterns.iter().any(|p| lower.contains(p));
    let status = |code: &str| lower.split(|c: char| !c.is_ascii_alphanumeric()).any(|s| s == code);
    if has(&[
        "insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached",
        "credits exhausted", "credits are exhausted", "credit balance is exhausted",
        "credit balance exhausted", "insufficient credits", "not enough credits",
        "no credits", "out of credits", "exceeded your current quota",
        "billing limit", "payment required",
    ]) || status("402") {
        LLMFailureKind::CreditsExhausted
    } else if has(&["not configured", "not installed", "api key required", "no llm provider"]) {
        LLMFailureKind::NotConfigured
    } else if has(&[
        "invalid_api_key", "invalid api key", "incorrect api key",
        "api key is invalid", "api key expired", "expired api key",
    ]) {
        LLMFailureKind::InvalidApiKey
    } else if has(&[
        "authentication", "unauthorized", "unauthenticated", "forbidden",
        "not logged in", "not signed in", "copilot login", "bad credentials",
        "invalid token", "token expired", "no entitlement", "access denied",
    ]) || status("401") || status("403") {
        LLMFailureKind::Authentication
    } else if has(&[
        "rate_limit", "rate limit", "rate-limit", "too many requests",
        "quota exceeded", "resource_exhausted",
    ]) || status("429") {
        LLMFailureKind::RateLimited
    } else if has(&["timeout", "timed out", "deadline exceeded"]) || status("408") || status("504") {
        LLMFailureKind::Timeout
    } else if has(&[
        "unavailable", "connection refused", "connection failed", "connection reset",
        "connection dropped", "failed to connect", "service overloaded", "overloaded_error",
        "connection error", "network error", "error sending request",
    ]) || ["500", "502", "503", "529"].iter().any(|code| status(code)) {
        LLMFailureKind::Unavailable
    } else if has(&["invalid response", "json parse error"]) {
        LLMFailureKind::InvalidResponse
    } else if has(&["stream cancelled"]) {
        LLMFailureKind::Cancelled
    } else {
        LLMFailureKind::ProviderError
    }
}

/// Classify an HTTP failure using both status and the private response body.
/// Bodies may contain keys / prompts; callers must discard them after this.
pub fn classify_http_failure(status: u16, body: &str) -> LLMFailureKind {
    let detail = classify_failure(body);
    if matches!(detail, LLMFailureKind::CreditsExhausted | LLMFailureKind::InvalidApiKey) {
        return detail;
    }
    match status {
        402 => LLMFailureKind::CreditsExhausted,
        401 | 403 => LLMFailureKind::Authentication,
        429 => LLMFailureKind::RateLimited,
        408 | 504 => LLMFailureKind::Timeout,
        500..=599 => LLMFailureKind::Unavailable,
        _ => detail,
    }
}

#[derive(Debug)]
pub enum LLMError {
    HttpError(reqwest::Error),
    JsonError(serde_json::Error),
    NotConfigured(String),
    AuthError(String),
    Cancelled,
    ConnectionFailed(String),
    InvalidResponse(String),
    ProviderError(String),
    /// No raw body, URL, stderr, API key or user content is stored here.
    Failure { kind: LLMFailureKind, provider: String },
}

impl LLMError {
    pub fn classified(kind: LLMFailureKind, provider: &str) -> Self {
        Self::Failure { kind, provider: provider.to_string() }
    }

    pub fn from_http_failure(provider: &str, status: u16, body: &str) -> Self {
        Self::classified(classify_http_failure(status, body), provider)
    }

    pub fn kind(&self) -> LLMFailureKind {
        match self {
            Self::Failure { kind, .. } => *kind,
            Self::HttpError(error) if error.is_timeout() => LLMFailureKind::Timeout,
            Self::HttpError(error) if error.is_connect() => LLMFailureKind::Unavailable,
            Self::HttpError(error) if error.is_decode() => LLMFailureKind::InvalidResponse,
            Self::HttpError(error) => error.status().map_or(
                LLMFailureKind::Unavailable,
                |status| classify_http_failure(status.as_u16(), ""),
            ),
            Self::JsonError(_) | Self::InvalidResponse(_) => LLMFailureKind::InvalidResponse,
            Self::NotConfigured(_) => LLMFailureKind::NotConfigured,
            Self::AuthError(message) => match classify_failure(message) {
                LLMFailureKind::InvalidApiKey => LLMFailureKind::InvalidApiKey,
                LLMFailureKind::CreditsExhausted => LLMFailureKind::CreditsExhausted,
                _ => LLMFailureKind::Authentication,
            },
            Self::Cancelled => LLMFailureKind::Cancelled,
            Self::ConnectionFailed(message) => match classify_failure(message) {
                LLMFailureKind::ProviderError => LLMFailureKind::Unavailable,
                kind => kind,
            },
            Self::ProviderError(message) => classify_failure(message),
        }
    }

    pub fn is_retryable(&self) -> bool {
        self.kind().is_retryable()
    }

    pub fn safe_message(&self) -> String {
        let provider = match self {
            Self::Failure { provider, .. } => provider.as_str(),
            _ => "",
        };
        self.kind().safe_message(provider)
    }
}

// Display and serialization are always user-safe, including legacy variants.
// Keep the actual transport error as a source for in-process diagnostics only.
impl std::fmt::Display for LLMError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.safe_message())
    }
}

impl std::error::Error for LLMError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::HttpError(error) => Some(error),
            Self::JsonError(error) => Some(error),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for LLMError {
    fn from(error: reqwest::Error) -> Self {
        Self::HttpError(error)
    }
}

impl From<serde_json::Error> for LLMError {
    fn from(error: serde_json::Error) -> Self {
        Self::JsonError(error)
    }
}

impl Serialize for LLMError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Event payloads emitted during streaming
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamStartPayload {
    pub mode: String,
    pub model: String,
    pub provider: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub include_transcript: bool,
    pub include_rag: bool,
    pub include_instructions: bool,
    pub include_question: bool,
    // New fields for AI log enrichment
    pub temperature: f64,
    pub rag_query: Option<String>,
    pub rag_chunks: Vec<RagChunkInfo>,
    pub rag_chunks_filtered: usize,
    pub rag_total_candidates: usize,
    pub transcript_window_seconds: u64,
    pub transcript_segments_count: usize,
    pub transcript_segments_total: usize,
    pub request_id: Option<String>,
    /// The Claude session that answered (`live:<meeting>:fast`...); `None`
    /// on the stateless path.
    pub session_key: Option<String>,
    /// The transcript scope the user picked ("Last 5 min"...); `None` for the
    /// action's default scope.
    #[serde(default)]
    pub scope_label: Option<String>,
}

/// Metadata about a single RAG chunk, sent to the frontend for AI log display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagChunkInfo {
    pub source: String,
    pub chunk_index: usize,
    pub text: String,
    pub normalized_score: f64,
    pub raw_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamTokenPayload {
    pub token: String,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEndPayload {
    pub total_tokens: u64,
    pub latency_ms: u64,
    pub request_id: Option<String>,
    /// True when the stream was stopped by the user rather than finishing.
    #[serde(default)]
    pub cancelled: bool,
    /// The request's actual token usage, when the provider reported it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<StreamUsage>,
}

/// Actual token usage of one request, as the provider reported it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StreamUsage {
    /// Uncached prompt tokens (all prompt tokens for providers without a cache).
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// Output tokens, thinking included.
    pub output_tokens: u64,
    pub thinking_tokens: u64,
    /// This request's cost estimate, when known.
    #[serde(default)]
    pub cost_usd: Option<f64>,
    /// From the request's start until its first words, when measured.
    #[serde(default)]
    pub first_token_ms: Option<u64>,
}

impl StreamUsage {
    /// Prompt/completion counts of `stats`; `None` without a prompt count
    /// (providers that only count streamed chunks).
    pub fn from_stats(stats: &CompletionStats) -> Option<StreamUsage> {
        (stats.prompt_tokens > 0).then(|| StreamUsage {
            input_tokens: stats.prompt_tokens,
            output_tokens: stats.completion_tokens,
            ..Default::default()
        })
    }
}

/// Payload of `llm_stream_thinking`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamThinkingPayload {
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamErrorPayload {
    pub message: String,
    pub request_id: Option<String>,
    #[serde(default)]
    pub code: LLMFailureKind,
    #[serde(default)]
    pub retryable: bool,
}

impl StreamErrorPayload {
    pub fn from_error(params: &GenerationParams, error: &LLMError) -> Self {
        Self {
            message: error.safe_message(),
            request_id: params.request_id.clone(),
            code: error.kind(),
            retryable: error.is_retryable(),
        }
    }
}

/// A single web search result/source surfaced by provider-native grounding (e.g. Gemini).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamSource {
    pub title: String,
    pub url: String,
}

/// Emitted once, after streaming completes, when the provider returned grounding sources.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamSourcesPayload {
    pub sources: Vec<StreamSource>,
    pub request_id: Option<String>,
}

/// Trait that all LLM providers implement.
#[async_trait::async_trait]
pub trait LLMProvider: Send + Sync {
    /// Returns the name of this provider (e.g., "openai", "ollama")
    fn provider_name(&self) -> &str;

    /// Lists available models for this provider
    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError>;

    /// Tests whether the provider is reachable and properly configured
    async fn test_connection(&self) -> Result<bool, LLMError>;

    /// Streams a completion response. Tokens, end and errors go through
    /// `emit_token` / `emit_end` / `emit_error`, which tag events with
    /// `params.request_id` and stay silent when `params.silent` is set.
    /// Events: "llm_stream_token", "llm_stream_end", "llm_stream_error"
    /// ("llm_stream_start" is emitted by the caller).
    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn silent_metadata_reaches_its_sink_without_global_events() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let target = received.clone();
        let params = GenerationParams {
            silent: true,
            request_id: Some("public-request".into()),
            metadata_sink: Some(MetadataSink::new(move |event| target.lock().unwrap().push(event))),
            ..Default::default()
        };
        let end = StreamMetadata::End(StreamEndPayload {
            total_tokens: 12, latency_ms: 23, request_id: params.request_id.clone(),
            cancelled: false, usage: Some(StreamUsage { input_tokens: 10, output_tokens: 2, ..Default::default() }),
        });
        for event in [
            StreamMetadata::Thinking,
            StreamMetadata::Sources(vec![StreamSource { title: "Public source".into(), url: "https://example.com".into() }]),
            end,
            StreamMetadata::Error(StreamErrorPayload::from_error(&params,
                &LLMError::classified(LLMFailureKind::CreditsExhausted, "openai"))),
        ] {
            assert_eq!(route_metadata(&params, &event), Route::Sink);
        }
        let events = received.lock().unwrap();
        assert_eq!(events.len(), 4);
        assert!(matches!(&events[2], StreamMetadata::End(payload)
            if payload.request_id.as_deref() == Some("public-request") && payload.usage.as_ref().unwrap().input_tokens == 10));
        assert!(matches!(&events[3], StreamMetadata::Error(payload)
            if payload.code == LLMFailureKind::CreditsExhausted && !payload.retryable));
        let json = serde_json::to_value(&params).unwrap();
        assert!(json.get("metadata_sink").is_none());
    }

    #[test]
    fn ordinary_silent_calls_and_cancelled_metadata_stay_silent() {
        let silent = GenerationParams { silent: true, ..Default::default() };
        assert_eq!(route_metadata(&silent, &StreamMetadata::Thinking), Route::Sink);
        assert_eq!(route_metadata(&GenerationParams::default(), &StreamMetadata::Thinking), Route::Global);
        let token = Arc::new(CancelToken::new());
        let received = Arc::new(Mutex::new(0));
        let target = received.clone();
        let params = GenerationParams {
            cancel: Some(token.clone()),
            metadata_sink: Some(MetadataSink::new(move |_| *target.lock().unwrap() += 1)),
            ..Default::default()
        };
        token.cancel();
        assert_eq!(route_metadata(&params, &StreamMetadata::Thinking), Route::Sink);
        assert_eq!(*received.lock().unwrap(), 0);
    }

    #[test]
    fn credit_exhaustion_wins_over_http_429_and_is_never_retryable() {
        for marker in [
            "insufficient_quota",
            "credit_balance_exhausted",
            "billing_hard_limit_reached",
            "You have no credits",
            "Your credit balance is exhausted",
            "You exceeded your current quota, please check your plan and billing details",
        ] {
            let body = serde_json::json!({
                "error": { "code": marker, "message": "HTTP 429 Too Many Requests" }
            }).to_string();
            assert_eq!(classify_http_failure(429, &body), LLMFailureKind::CreditsExhausted, "{marker}");
            assert_eq!(classify_failure(&format!("HTTP 429: {marker}")), LLMFailureKind::CreditsExhausted);
            let error = LLMError::from_http_failure("openai", 429, &body);
            assert_eq!(error.kind(), LLMFailureKind::CreditsExhausted);
            assert!(!error.is_retryable());
            assert!(error.safe_message().contains("billing"));
        }
        // Providers using 402 for payment-required belong to the same bucket.
        assert_eq!(classify_http_failure(402, ""), LLMFailureKind::CreditsExhausted);
    }

    #[test]
    fn transient_limits_auth_and_timeout_have_distinct_classifications() {
        for (status, body, expected) in [
            (429, r#"{"error":{"code":"rate_limit_exceeded"}}"#, LLMFailureKind::RateLimited),
            (429, "Too Many Requests", LLMFailureKind::RateLimited),
            (401, r#"{"error":{"code":"invalid_api_key"}}"#, LLMFailureKind::InvalidApiKey),
            (401, "Unauthorized", LLMFailureKind::Authentication),
            (403, "Forbidden", LLMFailureKind::Authentication),
            (408, "", LLMFailureKind::Timeout),
            (504, "", LLMFailureKind::Timeout),
            (503, "", LLMFailureKind::Unavailable),
            (500, "", LLMFailureKind::Unavailable),
            (400, "Bad request", LLMFailureKind::ProviderError),
        ] {
            let error = LLMError::from_http_failure("openai", status, body);
            assert_eq!(error.kind(), expected);
            assert_eq!(error.is_retryable(), matches!(expected,
                LLMFailureKind::RateLimited | LLMFailureKind::Unavailable | LLMFailureKind::Timeout));
            assert_eq!(classify_failure(&error.to_string()), expected);
        }
        // Generic quota wording is not proof that paid credits are exhausted.
        assert_eq!(classify_failure("quota exceeded: requests per minute"), LLMFailureKind::RateLimited);
        assert_eq!(classify_failure("request timed out"), LLMFailureKind::Timeout);
        assert_eq!(classify_failure("connection refused"), LLMFailureKind::Unavailable);
        assert_eq!(classify_failure("Unknown failure 1429"), LLMFailureKind::ProviderError);
    }

    #[test]
    fn safe_error_payload_preserves_request_identity_without_provider_secrets() {
        let raw = r#"{"error":{"code":"insufficient_quota","message":"Bearer secret-sentinel; private-meeting-sentinel; https://private.invalid/?key=secret-sentinel"}}"#;
        let error = LLMError::from_http_failure("openai", 429, raw);
        let params = GenerationParams { request_id: Some("request-public".into()), ..Default::default() };
        let payload = StreamErrorPayload::from_error(&params, &error);
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["code"], "credits_exhausted");
        assert_eq!(json["retryable"], false);
        assert_eq!(json["request_id"], "request-public");
        assert!(json["message"].as_str().unwrap().contains("OpenAI"));
        for serialized in [json.to_string(), error.to_string(), serde_json::to_string(&error).unwrap()] {
            assert!(!serialized.contains("sentinel"), "{serialized}");
            assert!(!serialized.contains("private.invalid"), "{serialized}");
        }
        // Legacy errors also never echo a raw provider body, URL, or stderr.
        let legacy = LLMError::ProviderError(format!("HTTP 429 insufficient_quota {raw}"));
        assert_eq!(legacy.kind(), LLMFailureKind::CreditsExhausted);
        assert!(!legacy.to_string().contains("sentinel"));
        let unknown = LLMError::ConnectionFailed("private-meeting-sentinel".into());
        assert_eq!(unknown.kind(), LLMFailureKind::Unavailable);
        assert!(!unknown.safe_message().contains("sentinel"));
        let custom = LLMError::classified(LLMFailureKind::Unavailable, "https://private.invalid/private-provider-sentinel");
        assert!(!custom.safe_message().contains("sentinel"));
        assert!(!custom.safe_message().contains("private.invalid"));
    }

    #[test]
    fn legacy_stream_error_payload_still_deserializes() {
        let payload: StreamErrorPayload =
            serde_json::from_str(r#"{"message":"old error","request_id":"req"}"#).unwrap();
        assert_eq!(payload.code, LLMFailureKind::ProviderError);
        assert!(!payload.retryable);
    }

    #[test]
    fn every_failure_kind_round_trips_through_safe_legacy_messages() {
        for kind in [
            LLMFailureKind::CreditsExhausted,
            LLMFailureKind::RateLimited,
            LLMFailureKind::InvalidApiKey,
            LLMFailureKind::Authentication,
            LLMFailureKind::Unavailable,
            LLMFailureKind::Timeout,
            LLMFailureKind::NotConfigured,
            LLMFailureKind::InvalidResponse,
            LLMFailureKind::Cancelled,
            LLMFailureKind::ProviderError,
        ] {
            for provider in ["openai", "github_copilot", ""] {
                let message = kind.safe_message(provider);
                assert_eq!(classify_failure(&message), kind, "{message}");
            }
        }
    }

    fn collecting_sink() -> (TokenSink, Arc<Mutex<String>>) {
        let collected = Arc::new(Mutex::new(String::new()));
        let target = collected.clone();
        let sink: TokenSink = Arc::new(move |token: &str| {
            target.lock().unwrap().push_str(token);
        });
        (sink, collected)
    }

    #[test]
    fn silent_params_route_tokens_to_sink_only() {
        let (sink, collected) = collecting_sink();
        let silent = GenerationParams {
            silent: true,
            request_id: Some("req-1".to_string()),
            ..Default::default()
        };

        assert_eq!(route_token(&silent, "hi", Some(&sink)), Route::Sink);
        assert_eq!(collected.lock().unwrap().as_str(), "hi");

        let global = GenerationParams {
            silent: false,
            ..Default::default()
        };
        assert_eq!(route_token(&global, "!", Some(&sink)), Route::Global);
        // A sink attached to a non-silent stream still receives tokens.
        assert_eq!(collected.lock().unwrap().as_str(), "hi!");
    }

    #[test]
    fn is_cancelled_follows_the_flag() {
        let token = Arc::new(CancelToken::new());
        let params = GenerationParams {
            cancel: Some(token.clone()),
            ..Default::default()
        };
        assert!(!is_cancelled(&params));
        token.cancel();
        assert!(is_cancelled(&params));
        assert!(matches!(check_cancelled(&params), Err(LLMError::Cancelled)));
        assert!(!is_cancelled(&GenerationParams::default()));
        assert!(check_cancelled(&GenerationParams::default()).is_ok());
    }

    #[test]
    fn stream_end_payload_cancelled_defaults_to_false() {
        let payload: StreamEndPayload =
            serde_json::from_str(r#"{"total_tokens":1,"latency_ms":2,"request_id":null}"#).unwrap();
        assert!(!payload.cancelled);
        assert_eq!(payload.usage, None);
        // Without usage the payload looks exactly as before.
        assert!(serde_json::to_value(&payload).unwrap().get("usage").is_none());
    }

    #[test]
    fn stream_usage_serializes_snake_case_and_comes_from_real_counts_only() {
        let usage = StreamUsage {
            input_tokens: 10,
            cache_read_tokens: 4000,
            cache_write_tokens: 190,
            output_tokens: 38,
            thinking_tokens: 0,
            cost_usd: Some(0.002),
            first_token_ms: Some(640),
        };
        let v = serde_json::to_value(&usage).unwrap();
        assert_eq!(v["cache_write_tokens"], 190);
        assert_eq!(v["first_token_ms"], 640);
        let stats = |prompt| CompletionStats {
            prompt_tokens: prompt,
            completion_tokens: 7,
            total_tokens: prompt + 7,
            latency_ms: 1,
        };
        assert_eq!(StreamUsage::from_stats(&stats(0)), None);
        let real = StreamUsage::from_stats(&stats(12)).unwrap();
        assert_eq!((real.input_tokens, real.output_tokens, real.cost_usd), (12, 7, None));
    }

    /// Mirrors a provider's stream loop (chunk -> lines -> SSE events -> token) over a
    /// canned OpenAI-style body and stops as soon as the flag is set.
    #[test]
    fn stream_loop_stops_after_cancel_flag_set_mid_stream() {
        use crate::llm::stream_parser::{LineBuffer, SSEParser};

        let chunks = [
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: [DONE]\n\n",
        ];
        let cancel_token = Arc::new(CancelToken::new());
        let params = GenerationParams {
            cancel: Some(cancel_token.clone()),
            ..Default::default()
        };

        let mut collected: Vec<String> = Vec::new();
        let mut line_buffer = LineBuffer::new();
        let result: Result<(), LLMError> = (|| {
            for chunk in chunks {
                check_cancelled(&params)?;
                for line in line_buffer.push(chunk) {
                    for event in SSEParser::parse_chunk(&line).into_iter().flatten() {
                        if let Some(token) = SSEParser::extract_openai_token(&event) {
                            check_cancelled(&params)?;
                            collected.push(token);
                            // The user presses Stop right after the first token.
                            cancel_token.cancel();
                        }
                    }
                }
            }
            Ok(())
        })();

        assert_eq!(collected, vec!["Hel".to_string()]);
        assert!(matches!(result, Err(LLMError::Cancelled)));
    }

    #[tokio::test]
    async fn cancellable_returns_cancelled_promptly_for_a_stalled_future() {
        let token = Arc::new(CancelToken::new());
        let params = GenerationParams {
            cancel: Some(token.clone()),
            ..Default::default()
        };
        let canceller = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            canceller.cancel();
        });

        let stalled = std::future::pending::<()>();
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(2), cancellable(&params, stalled))
                .await
                .expect("cancellable must return promptly after cancel()");
        assert!(matches!(result, Err(LLMError::Cancelled)));
    }

    #[tokio::test]
    async fn cancellable_returns_cancelled_when_already_cancelled() {
        let token = Arc::new(CancelToken::new());
        token.cancel();
        let params = GenerationParams {
            cancel: Some(token),
            ..Default::default()
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            cancellable(&params, std::future::pending::<()>()),
        )
        .await
        .expect("must not wait");
        assert!(matches!(result, Err(LLMError::Cancelled)));
    }

    #[tokio::test]
    async fn cancellable_passes_through_output_when_not_cancelled() {
        let params = GenerationParams {
            cancel: Some(Arc::new(CancelToken::new())),
            ..Default::default()
        };
        assert_eq!(cancellable(&params, async { 7 }).await.unwrap(), 7);
        assert_eq!(cancellable(&GenerationParams::default(), async { 8 }).await.unwrap(), 8);
    }
}
