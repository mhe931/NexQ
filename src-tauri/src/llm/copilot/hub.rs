//! The long-lived `copilot --acp` process and the per-request session life cycle.
//!
//! * One shared child process, started on first use and restarted when it
//!   died ([`CopilotHub::connection`]).
//! * Every request gets its OWN fresh ACP session (`session/new` -> optional
//!   `session/set_model` -> `session/prompt` -> `session/close`). Sessions are
//!   never reused: one meeting's context can never be visible to another
//!   request, whatever the provider's caller does.
//! * Copilot may not run tools: the launch disables them (`detect.rs`), the
//!   client refuses permission requests (`acp.rs`), and a turn that still
//!   starts a tool call is stopped here.

use super::acp::{AcpConnection, AcpError, RpcError, SessionEvent, SpawnSpec, PROTOCOL_VERSION};
use super::notice::NoticeFilter;
use crate::llm::provider::CancelToken;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// Model asked for when the caller names none ("Auto": Copilot picks).
pub const DEFAULT_MODEL: &str = "auto";

/// What went wrong, as far as the CLI let us tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopilotErrorKind {
    /// No `copilot` executable.
    NotInstalled,
    /// The CLI says the user has to sign in.
    NotLoggedIn,
    /// Signed in, but Copilot is not available to this account (plan / policy).
    NoEntitlement,
    /// The CLI did not answer in time.
    Timeout,
    /// The pipe broke, the process died or answered something unexpected.
    Protocol,
    /// The CLI rejected the requested model.
    ModelUnavailable,
    /// The agent tried to use a tool.
    ToolBlocked,
    /// The agent declined to answer.
    Refused,
    /// The caller cancelled.
    Cancelled,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CopilotError {
    pub kind: CopilotErrorKind,
    /// The genuine text, ready to show.
    pub message: String,
}

impl CopilotError {
    pub fn new(kind: CopilotErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

impl std::fmt::Display for CopilotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CopilotError {}

/// Put a JSON-RPC error into one of the user-facing buckets. ACP reserves
/// `-32000` for "authentication required"; the text patterns cover agents
/// that put the reason in the message instead.
pub fn classify_rpc(error: &RpcError) -> CopilotErrorKind {
    let m = error.message.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| m.contains(n));
    if error.code == -32000
        || has(&[
            "authentication required",
            "not authenticated",
            "not logged in",
            "not signed in",
            "unauthorized",
            "unauthenticated",
            "copilot login",
            "please log in",
            "please sign in",
            "token expired",
            "invalid token",
            "bad credentials",
            "401",
        ])
    {
        CopilotErrorKind::NotLoggedIn
    } else if has(&[
        "entitle",
        "policy",
        "no copilot",
        "copilot is not enabled",
        "not enabled",
        "subscription",
        "forbidden",
        "access denied",
        "not have access",
        "403",
    ]) {
        CopilotErrorKind::NoEntitlement
    } else {
        CopilotErrorKind::Protocol
    }
}

impl From<AcpError> for CopilotError {
    fn from(e: AcpError) -> Self {
        match &e {
            AcpError::Rpc(rpc) => {
                let kind = classify_rpc(rpc);
                let message = match kind {
                    CopilotErrorKind::NotLoggedIn => {
                        format!("GitHub Copilot needs you to sign in: {}", rpc.message)
                    }
                    CopilotErrorKind::NoEntitlement => {
                        format!("GitHub Copilot is not available for this account: {}", rpc.message)
                    }
                    _ => format!("GitHub Copilot error: {}", rpc.message),
                };
                Self::new(kind, message)
            }
            AcpError::Timeout(m) => Self::new(CopilotErrorKind::Timeout, m.clone()),
            AcpError::Spawn(m) | AcpError::Closed(m) | AcpError::Protocol(m) => {
                Self::new(CopilotErrorKind::Protocol, m.clone())
            }
        }
    }
}

/// One model of the catalog the CLI reports in `session/new`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CopilotModel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// The CLI's own usage multiplier label ("1x", "0.33x"), when it gives one.
    pub usage: Option<String>,
    /// False when the CLI marks the model as not enabled for this account.
    pub enabled: bool,
}

/// A fresh ACP session.
#[derive(Debug, Clone)]
pub struct NewSession {
    pub id: String,
    pub models: Vec<CopilotModel>,
    pub current_model: Option<String>,
}

/// Parse a `session/new` result. The catalog lists some models twice (a bare
/// entry and one with `_meta`); duplicates are merged by model id.
pub fn parse_new_session(result: &Value) -> Result<NewSession, CopilotError> {
    let id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            CopilotError::new(CopilotErrorKind::Protocol, "Copilot CLI's session/new answer has no sessionId")
        })?
        .to_string();
    let models_value = result.get("models");
    let mut models: Vec<CopilotModel> = Vec::new();
    for entry in models_value
        .and_then(|m| m.get("availableModels"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(model_id) = entry.get("modelId").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            continue;
        };
        let meta = entry.get("_meta").filter(|m| m.is_object());
        let enablement = meta.and_then(|m| m.get("copilotEnablement")).and_then(Value::as_str);
        let usage = meta
            .and_then(|m| m.get("copilotUsage"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let description = entry
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string);
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(model_id)
            .to_string();
        // Unknown enablement counts as enabled; any other value than
        // "enabled" (e.g. "disabled", "unconfigured") does not.
        let enabled = enablement.map_or(true, |e| e == "enabled");
        match models.iter_mut().find(|m| m.id == model_id) {
            Some(existing) => {
                if existing.usage.is_none() {
                    existing.usage = usage;
                }
                if enablement.is_some() {
                    existing.enabled = enabled;
                }
            }
            None => models.push(CopilotModel {
                id: model_id.to_string(),
                name,
                description,
                usage,
                enabled,
            }),
        }
    }
    let current_model = models_value
        .and_then(|m| m.get("currentModelId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(NewSession { id, models, current_model })
}

/// What `initialize` told us about the agent.
#[derive(Debug, Clone, Default)]
pub struct AgentInfo {
    pub version: Option<String>,
    /// The agent supports `session/close`.
    pub supports_close: bool,
}

pub fn parse_initialize(result: &Value) -> AgentInfo {
    AgentInfo {
        version: result
            .get("agentInfo")
            .and_then(|a| a.get("version"))
            .and_then(Value::as_str)
            .map(str::to_string),
        supports_close: result
            .get("agentCapabilities")
            .and_then(|c| c.get("sessionCapabilities"))
            .and_then(|s| s.get("close"))
            .is_some_and(|v| !v.is_null()),
    }
}

/// Token usage the CLI reported for a turn (ACP `usage`); absent when it
/// reported none. Never estimated.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub thought_tokens: u64,
    pub cached_read_tokens: u64,
    pub cached_write_tokens: u64,
}

pub fn parse_usage(result: &Value) -> Option<TurnUsage> {
    let usage = result.get("usage").filter(|u| u.is_object())?;
    let n = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let input = n("inputTokens");
    let output = n("outputTokens");
    let total = match n("totalTokens") {
        0 => input + output,
        t => t,
    };
    Some(TurnUsage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        thought_tokens: n("thoughtTokens"),
        cached_read_tokens: n("cachedReadTokens"),
        cached_write_tokens: n("cachedWriteTokens"),
    })
}

/// A finished turn.
#[derive(Debug, Clone)]
pub struct Answer {
    pub text: String,
    pub stop_reason: String,
    pub usage: Option<TurnUsage>,
    /// Request start until the first answer text.
    pub first_token_ms: Option<u64>,
    /// The ACP session that served it (one per request).
    pub session_id: String,
}

/// What the caller sees while the turn runs.
pub enum AskEvent<'a> {
    Text(&'a str),
    /// The model is thinking before its first words (at most once).
    Thinking,
}

/// Timeouts of the individual protocol steps.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub handshake: Duration,
    pub session: Duration,
    pub set_model: Duration,
    pub close: Duration,
    /// A turn with no update for this long is given up.
    pub idle: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            handshake: Duration::from_secs(30),
            session: Duration::from_secs(30),
            set_model: Duration::from_secs(15),
            close: Duration::from_secs(5),
            idle: Duration::from_secs(90),
        }
    }
}

/// How long [`CopilotHub::shutdown`] waits for the process slot.
const SHUTDOWN_LOCK_WAIT: Duration = Duration::from_millis(800);

/// Resolves the launch of the CLI; fails with `NotInstalled` when there is none.
pub type Launcher = Arc<dyn Fn() -> Result<SpawnSpec, CopilotError> + Send + Sync>;

/// A connected, initialized process.
#[derive(Clone)]
pub struct Live {
    pub conn: Arc<AcpConnection>,
    pub info: AgentInfo,
    cwd: String,
}

pub struct CopilotHub {
    launcher: Launcher,
    live: tokio::sync::Mutex<Option<Live>>,
    spawns: AtomicUsize,
    timeouts: Timeouts,
}

impl CopilotHub {
    pub fn new(launcher: Launcher) -> Self {
        Self::with_timeouts(launcher, Timeouts::default())
    }

    pub fn with_timeouts(launcher: Launcher, timeouts: Timeouts) -> Self {
        Self {
            launcher,
            live: tokio::sync::Mutex::new(None),
            spawns: AtomicUsize::new(0),
            timeouts,
        }
    }

    /// The hub of the installed CLI, shared by the whole app: providers are
    /// created per call, the process must outlive them.
    pub fn global() -> Arc<CopilotHub> {
        static GLOBAL: OnceLock<Arc<CopilotHub>> = OnceLock::new();
        GLOBAL
            .get_or_init(|| {
                Arc::new(CopilotHub::new(Arc::new(|| {
                    super::detect::find_copilot_binary()
                        .map(|bin| super::detect::launch_spec(&bin))
                        .ok_or_else(|| {
                            CopilotError::new(
                                CopilotErrorKind::NotInstalled,
                                "The GitHub Copilot CLI is not installed",
                            )
                        })
                })))
            })
            .clone()
    }

    pub fn timeouts(&self) -> Timeouts {
        self.timeouts
    }

    /// How many CLI processes this hub has started.
    pub fn spawn_count(&self) -> usize {
        self.spawns.load(Ordering::SeqCst)
    }

    /// Resolve how the CLI would be launched (finds the binary).
    pub async fn launch_spec(&self) -> Result<SpawnSpec, CopilotError> {
        let launcher = self.launcher.clone();
        tokio::task::spawn_blocking(move || launcher())
            .await
            .map_err(|e| CopilotError::new(CopilotErrorKind::Protocol, format!("launch lookup failed: {e}")))?
    }

    /// The live process, started (and `initialize`d) when there is none or
    /// the previous one died.
    pub async fn connection(&self) -> Result<Live, CopilotError> {
        let mut slot = self.live.lock().await;
        if let Some(live) = slot.as_ref() {
            if live.conn.is_alive() {
                return Ok(live.clone());
            }
        }
        // Dropping a dead connection reaps its process.
        *slot = None;
        let spec = self.launch_spec().await?;
        let conn = AcpConnection::spawn(&spec)?;
        self.spawns.fetch_add(1, Ordering::SeqCst);
        // No capabilities: the agent can read nothing and run nothing on our side.
        let init = conn
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {},
                    "clientInfo": {"name": "nexq", "title": "NexQ", "version": env!("CARGO_PKG_VERSION")},
                }),
                self.timeouts.handshake,
            )
            .await;
        match init {
            Ok(result) => {
                let live = Live {
                    conn,
                    info: parse_initialize(&result),
                    cwd: spec.cwd.to_string_lossy().into_owned(),
                };
                *slot = Some(live.clone());
                Ok(live)
            }
            Err(e) => {
                conn.kill();
                Err(e.into())
            }
        }
    }

    /// Stop the CLI process this hub started, if there is one (NexQ is quitting).
    /// Only that child is ended — never another process, whatever its name — and
    /// the hub would start a new one on the next request. Waits at most
    /// [`SHUTDOWN_LOCK_WAIT`] for a handshake that is just starting.
    pub async fn shutdown(&self) {
        let live = match tokio::time::timeout(SHUTDOWN_LOCK_WAIT, self.live.lock()).await {
            Ok(mut slot) => slot.take(),
            Err(_) => {
                log::warn!("copilot: a CLI process is still starting; leaving it to exit with its pipes");
                None
            }
        };
        if let Some(live) = live {
            live.conn.kill();
            log::info!("copilot: stopped the CLI process on exit");
        }
    }

    /// A fresh session (never reused).
    pub async fn open_session(&self, live: &Live) -> Result<NewSession, CopilotError> {
        let result = live
            .conn
            .request(
                "session/new",
                json!({"cwd": live.cwd, "mcpServers": []}),
                self.timeouts.session,
            )
            .await?;
        parse_new_session(&result)
    }

    /// End a session without delaying the caller.
    pub fn close_session(&self, live: &Live, session_id: &str) {
        live.conn.unsubscribe(session_id);
        if !live.info.supports_close {
            return;
        }
        let conn = live.conn.clone();
        let id = session_id.to_string();
        let timeout = self.timeouts.close;
        tokio::spawn(async move {
            let _ = conn.request("session/close", json!({"sessionId": id}), timeout).await;
        });
    }

    /// Open a session, read the model catalog it reports and close it again.
    pub async fn catalog(&self) -> Result<Vec<CopilotModel>, CopilotError> {
        let live = self.connection().await?;
        let session = self.open_session(&live).await?;
        self.close_session(&live, &session.id);
        Ok(session.models)
    }

    /// Run one prompt in a fresh session of its own.
    pub async fn ask(
        &self,
        prompt: &str,
        model: &str,
        cancel: &CancelToken,
        on_event: &mut (dyn FnMut(AskEvent<'_>) + Send),
    ) -> Result<Answer, CopilotError> {
        if cancel.is_cancelled() {
            return Err(CopilotError::new(CopilotErrorKind::Cancelled, "Stream cancelled"));
        }
        let live = self.connection().await?;
        let session = self.open_session(&live).await?;
        let result = self.run_turn(&live, &session, model, prompt, cancel, on_event).await;
        self.close_session(&live, &session.id);
        result
    }

    async fn run_turn(
        &self,
        live: &Live,
        session: &NewSession,
        model: &str,
        prompt: &str,
        cancel: &CancelToken,
        on_event: &mut (dyn FnMut(AskEvent<'_>) + Send),
    ) -> Result<Answer, CopilotError> {
        let conn = &live.conn;
        let sid = session.id.as_str();
        let model = match model.trim() {
            "" => DEFAULT_MODEL,
            m => m,
        };
        if session.current_model.as_deref() != Some(model) {
            conn.request(
                "session/set_model",
                json!({"sessionId": sid, "modelId": model}),
                self.timeouts.set_model,
            )
            .await
            .map_err(|e| match e {
                AcpError::Rpc(rpc) if rpc.code == -32602 => CopilotError::new(
                    CopilotErrorKind::ModelUnavailable,
                    format!("GitHub Copilot does not offer the model \"{model}\" here: {}", rpc.message),
                ),
                other => other.into(),
            })?;
        }
        if cancel.is_cancelled() {
            return Err(CopilotError::new(CopilotErrorKind::Cancelled, "Stream cancelled"));
        }

        // Subscribe before the prompt is sent: nothing may be missed.
        let mut events = conn.subscribe(sid);
        let pending = conn.start_request(
            "session/prompt",
            json!({"sessionId": sid, "prompt": [{"type": "text", "text": prompt}]}),
        )?;
        let prompt_id = pending.id;
        let mut response = pending.rx;

        let started = Instant::now();
        let mut turn = Turn::default();
        let idle = self.timeouts.idle;
        let mut events_open = true;

        let outcome: Result<Value, AcpError> = loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    conn.notify("session/cancel", json!({"sessionId": sid}));
                    conn.forget(prompt_id);
                    return Err(CopilotError::new(CopilotErrorKind::Cancelled, "Stream cancelled"));
                }
                event = events.recv(), if events_open => match event {
                    Some(event) => {
                        if let Some(name) = turn.on_event(event, started, on_event) {
                            conn.notify("session/cancel", json!({"sessionId": sid}));
                            conn.forget(prompt_id);
                            return Err(CopilotError::new(
                                CopilotErrorKind::ToolBlocked,
                                format!(
                                    "GitHub Copilot tried to use {name}. NexQ allows Copilot no tools, so the request was stopped."
                                ),
                            ));
                        }
                    }
                    // The connection is gone: the response resolves with the reason.
                    None => events_open = false,
                },
                result = &mut response => {
                    break result.unwrap_or_else(|_| Err(AcpError::Closed(
                        "The Copilot CLI process ended unexpectedly".into(),
                    )));
                }
                _ = tokio::time::sleep(idle) => {
                    conn.notify("session/cancel", json!({"sessionId": sid}));
                    conn.forget(prompt_id);
                    return Err(CopilotError::new(
                        CopilotErrorKind::Timeout,
                        format!("GitHub Copilot sent nothing for {} s", idle.as_secs()),
                    ));
                }
            }
        };

        // Everything streamed before the answer was sent already sits in the channel.
        while let Ok(event) = events.try_recv() {
            if let Some(name) = turn.on_event(event, started, on_event) {
                return Err(CopilotError::new(
                    CopilotErrorKind::ToolBlocked,
                    format!("GitHub Copilot tried to use {name}. NexQ allows Copilot no tools."),
                ));
            }
        }
        let result = outcome?;
        turn.finish(on_event);

        let stop_reason = result
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn")
            .to_string();
        match stop_reason.as_str() {
            "refusal" => {
                return Err(CopilotError::new(
                    CopilotErrorKind::Refused,
                    "GitHub Copilot declined to answer this request",
                ))
            }
            "cancelled" => {
                return Err(CopilotError::new(
                    CopilotErrorKind::Protocol,
                    "GitHub Copilot stopped the answer before it was finished",
                ))
            }
            _ => {}
        }
        if turn.text.trim().is_empty() {
            return Err(CopilotError::new(
                CopilotErrorKind::Protocol,
                "GitHub Copilot returned an empty answer",
            ));
        }
        Ok(Answer {
            text: turn.text,
            stop_reason,
            usage: parse_usage(&result),
            first_token_ms: turn.first_token_ms,
            session_id: session.id.clone(),
        })
    }
}

/// Accumulates one turn's streamed text.
#[derive(Default)]
struct Turn {
    text: String,
    filter: NoticeFilter,
    first_token_ms: Option<u64>,
    thinking_sent: bool,
}

impl Turn {
    /// Handle one update; returns the tool name when the agent started a tool call.
    fn on_event(
        &mut self,
        event: SessionEvent,
        started: Instant,
        on_event: &mut (dyn FnMut(AskEvent<'_>) + Send),
    ) -> Option<String> {
        match event {
            SessionEvent::Text(chunk) => {
                let out = self.filter.push(&chunk);
                self.emit(out, started, on_event);
            }
            SessionEvent::Thinking => {
                if !self.thinking_sent && self.first_token_ms.is_none() {
                    self.thinking_sent = true;
                    on_event(AskEvent::Thinking);
                }
            }
            SessionEvent::ToolCall(name) => return Some(name),
        }
        None
    }

    /// Flush whatever the notice filter still holds back.
    fn finish(&mut self, on_event: &mut (dyn FnMut(AskEvent<'_>) + Send)) {
        let rest = self.filter.finish();
        self.emit(rest, Instant::now(), on_event);
    }

    fn emit(&mut self, text: String, started: Instant, on_event: &mut (dyn FnMut(AskEvent<'_>) + Send)) {
        if text.is_empty() {
            return;
        }
        if self.first_token_ms.is_none() {
            self.first_token_ms = Some(started.elapsed().as_millis() as u64);
        }
        self.text.push_str(&text);
        on_event(AskEvent::Text(&text));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_new(models: Value) -> Value {
        json!({"sessionId": "s-1", "models": {"availableModels": models, "currentModelId": "claude-sonnet-5.5"}})
    }

    #[test]
    fn shutdown_without_a_process_starts_nothing_and_can_repeat() {
        let hub = CopilotHub::new(Arc::new(|| {
            Err(CopilotError::new(CopilotErrorKind::NotInstalled, "not installed"))
        }));
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        runtime.block_on(async {
            hub.shutdown().await;
            hub.shutdown().await;
        });
        assert_eq!(hub.spawn_count(), 0);
    }

    #[test]
    fn rpc_errors_map_to_user_facing_kinds() {
        let err = |code: i64, message: &str| RpcError { code, message: message.into() };
        assert_eq!(classify_rpc(&err(-32000, "Authentication required")), CopilotErrorKind::NotLoggedIn);
        assert_eq!(classify_rpc(&err(-32603, "Not logged in. Run copilot login")), CopilotErrorKind::NotLoggedIn);
        assert_eq!(classify_rpc(&err(-32603, "HTTP 401 Unauthorized")), CopilotErrorKind::NotLoggedIn);
        assert_eq!(classify_rpc(&err(-32603, "Copilot is not enabled for this account")), CopilotErrorKind::NoEntitlement);
        assert_eq!(classify_rpc(&err(-32603, "Blocked by organization policy")), CopilotErrorKind::NoEntitlement);
        assert_eq!(classify_rpc(&err(-32603, "403 Forbidden")), CopilotErrorKind::NoEntitlement);
        assert_eq!(classify_rpc(&err(-32603, "Internal error")), CopilotErrorKind::Protocol);
        let mapped: CopilotError = AcpError::Rpc(err(-32000, "Authentication required")).into();
        assert_eq!(mapped.kind, CopilotErrorKind::NotLoggedIn);
        assert!(mapped.message.contains("Authentication required"), "{}", mapped.message);
        let timeout: CopilotError = AcpError::Timeout("slow".into()).into();
        assert_eq!(timeout.kind, CopilotErrorKind::Timeout);
        let closed: CopilotError = AcpError::Closed("gone".into()).into();
        assert_eq!(closed.kind, CopilotErrorKind::Protocol);
    }

    #[test]
    fn catalog_merges_duplicates_and_flags_disabled_models() {
        let parsed = parse_new_session(&session_new(json!([
            {"modelId": "auto", "name": "Auto", "description": "Let Copilot pick the best model"},
            {"modelId": "auto", "name": "Auto", "description": "Auto", "_meta": {"copilotUsage": "1x", "copilotEnablement": "enabled"}},
            {"modelId": "claude-haiku-4.5", "name": "Claude Haiku 4.5", "_meta": {"copilotUsage": "0.33x", "copilotEnablement": "enabled"}},
            {"modelId": "gpt-x", "name": "GPT X", "_meta": {"copilotEnablement": "disabled"}},
            {"name": "no id"}
        ])))
        .unwrap();
        assert_eq!(parsed.id, "s-1");
        assert_eq!(parsed.current_model.as_deref(), Some("claude-sonnet-5.5"));
        let ids: Vec<&str> = parsed.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["auto", "claude-haiku-4.5", "gpt-x"]);
        assert_eq!(parsed.models[0].usage.as_deref(), Some("1x"));
        assert_eq!(parsed.models[0].description.as_deref(), Some("Let Copilot pick the best model"));
        assert!(parsed.models[0].enabled && parsed.models[1].enabled);
        assert!(!parsed.models[2].enabled);
        assert_eq!(parsed.models[1].name, "Claude Haiku 4.5");
    }

    #[test]
    fn a_session_without_an_id_is_a_protocol_error() {
        let err = parse_new_session(&json!({"models": {}})).unwrap_err();
        assert_eq!(err.kind, CopilotErrorKind::Protocol);
        // No catalog at all is fine: the list is simply empty.
        assert!(parse_new_session(&json!({"sessionId": "x"})).unwrap().models.is_empty());
    }

    #[test]
    fn initialize_reports_close_support_and_version() {
        let info = parse_initialize(&json!({
            "agentInfo": {"name": "Copilot", "version": "1.0.105"},
            "agentCapabilities": {"sessionCapabilities": {"close": {}, "list": {}}}
        }));
        assert_eq!(info.version.as_deref(), Some("1.0.105"));
        assert!(info.supports_close);
        let none = parse_initialize(&json!({"agentCapabilities": {}}));
        assert!(!none.supports_close && none.version.is_none());
    }

    #[test]
    fn usage_is_taken_from_the_cli_never_invented() {
        let usage = parse_usage(&json!({
            "stopReason": "end_turn",
            "usage": {"inputTokens": 4423, "outputTokens": 4, "totalTokens": 4427, "thoughtTokens": 0, "cachedReadTokens": 1397, "cachedWriteTokens": 3022}
        }))
        .unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens, usage.total_tokens), (4423, 4, 4427));
        assert_eq!((usage.cached_read_tokens, usage.cached_write_tokens), (1397, 3022));
        assert_eq!(parse_usage(&json!({"stopReason": "end_turn"})), None);
        // A missing total is the sum of what was reported, not a guess.
        let sum = parse_usage(&json!({"usage": {"inputTokens": 10, "outputTokens": 5}})).unwrap();
        assert_eq!(sum.total_tokens, 15);
    }
}
