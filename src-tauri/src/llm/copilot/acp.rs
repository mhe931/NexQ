//! Minimal Agent Client Protocol (ACP) client for `copilot --acp --stdio`.
//!
//! Transport: newline-delimited JSON-RPC 2.0 over the child's stdin/stdout
//! (https://agentclientprotocol.com, GitHub's ACP server reference:
//! https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).
//!
//! One [`AcpConnection`] owns one child process and multiplexes any number of
//! sessions over it. A reader task resolves responses by request id, routes
//! `session/update` notifications to the subscriber of that session, and
//! answers the agent's own requests:
//! * `session/request_permission` is ALWAYS refused (a reject option when the
//!   agent offers one, otherwise `cancelled`) - NexQ never lets Copilot run
//!   tools, edit files or start shell commands;
//! * every other agent request (`fs/*`, `terminal/*`, ...) gets "method not
//!   found": the client declares no capabilities at all.
//!
//! This module knows nothing about NexQ providers; see `hub.rs` for the
//! long-lived process manager and `provider.rs` for the `LLMProvider` face.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

/// ACP protocol version this client speaks.
pub const PROTOCOL_VERSION: u64 = 1;

/// How much of the child's stderr is kept for error messages.
const STDERR_TAIL_BYTES: usize = 2000;

/// A JSON-RPC error object as the agent sent it.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)
    }
}

/// Transport-level failure.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpError {
    /// The process could not be started.
    Spawn(String),
    /// The process exited / closed its pipes (with its stderr tail when any).
    Closed(String),
    /// The agent answered a request with a JSON-RPC error.
    Rpc(RpcError),
    /// No answer in time.
    Timeout(String),
    /// The agent's answer did not have the expected shape.
    Protocol(String),
}

impl std::fmt::Display for AcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(m) | Self::Closed(m) | Self::Timeout(m) | Self::Protocol(m) => {
                f.write_str(m)
            }
            Self::Rpc(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for AcpError {}

/// How to start the agent process.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Variables removed from the child's environment.
    pub remove_env: Vec<String>,
    /// Variables set in the child's environment.
    pub set_env: Vec<(String, String)>,
}

/// What a session streams while a prompt turn runs.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    /// A piece of the answer (`agent_message_chunk`).
    Text(String),
    /// The model is thinking (`agent_thought_chunk`).
    Thinking,
    /// The agent started a tool call. NexQ offers the agent no tools; seeing
    /// one means a restriction did not hold, and the turn is stopped.
    ToolCall(String),
}

type Responder = oneshot::Sender<Result<Value, AcpError>>;

struct Shared {
    next_id: AtomicU64,
    alive: AtomicBool,
    pending: Mutex<HashMap<u64, Responder>>,
    sessions: Mutex<HashMap<String, mpsc::UnboundedSender<SessionEvent>>>,
    stderr_tail: Mutex<String>,
    permissions_refused: AtomicU64,
}

impl Shared {
    fn new() -> Self {
        Self {
            next_id: AtomicU64::new(0),
            alive: AtomicBool::new(true),
            pending: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            stderr_tail: Mutex::new(String::new()),
            permissions_refused: AtomicU64::new(0),
        }
    }

    fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|t| t.trim().to_string())
            .unwrap_or_default()
    }

    fn push_stderr(&self, text: &str) {
        if let Ok(mut tail) = self.stderr_tail.lock() {
            tail.push_str(text);
            if tail.len() > STDERR_TAIL_BYTES {
                let mut cut = tail.len() - STDERR_TAIL_BYTES;
                while !tail.is_char_boundary(cut) {
                    cut += 1;
                }
                tail.drain(..cut);
            }
        }
    }

    fn closed_error(&self) -> AcpError {
        let tail = self.stderr_tail();
        if tail.is_empty() {
            AcpError::Closed("The Copilot CLI process ended unexpectedly".to_string())
        } else {
            AcpError::Closed(format!("The Copilot CLI process ended unexpectedly: {tail}"))
        }
    }
}

/// A request in flight; resolves with the agent's `result`.
pub struct PendingResponse {
    pub id: u64,
    pub rx: oneshot::Receiver<Result<Value, AcpError>>,
}

/// One live `copilot --acp` process.
pub struct AcpConnection {
    shared: Arc<Shared>,
    out: mpsc::UnboundedSender<String>,
    child: Mutex<tokio::process::Child>,
}

impl AcpConnection {
    /// Start the process and the I/O tasks (no handshake yet).
    pub fn spawn(spec: &SpawnSpec) -> Result<Arc<Self>, AcpError> {
        if let Err(e) = std::fs::create_dir_all(&spec.cwd) {
            log::warn!("copilot: cannot create working dir {}: {e}", spec.cwd.display());
        }
        let mut std_cmd = std::process::Command::new(&spec.program);
        std_cmd.args(&spec.args).current_dir(&spec.cwd);
        for key in &spec.remove_env {
            std_cmd.env_remove(key);
        }
        for (key, value) in &spec.set_env {
            std_cmd.env(key, value);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std_cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut cmd = tokio::process::Command::from(std_cmd);
        cmd.kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| {
            AcpError::Spawn(format!("Could not start {}: {e}", spec.program.display()))
        })?;
        let stdin = child.stdin.take().ok_or_else(|| AcpError::Spawn("no stdin pipe".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| AcpError::Spawn("no stdout pipe".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| AcpError::Spawn("no stderr pipe".into()))?;

        let shared = Arc::new(Shared::new());
        let (out, out_rx) = mpsc::unbounded_channel::<String>();

        tokio::spawn(write_loop(stdin, out_rx, shared.clone()));
        tokio::spawn(stderr_loop(stderr, shared.clone()));
        tokio::spawn(read_loop(stdout, shared.clone(), out.clone()));

        Ok(Arc::new(Self {
            shared,
            out,
            child: Mutex::new(child),
        }))
    }

    /// False once the process has exited or its pipes closed.
    pub fn is_alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }

    /// Number of `session/request_permission` requests answered with a refusal.
    pub fn permissions_refused(&self) -> u64 {
        self.shared.permissions_refused.load(Ordering::SeqCst)
    }

    /// The most recent stderr output of the process.
    pub fn stderr_tail(&self) -> String {
        self.shared.stderr_tail()
    }

    /// Stop the process (idempotent).
    pub fn kill(&self) {
        self.shared.alive.store(false, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
    }

    /// Send a request and return a handle to its answer without waiting.
    pub fn start_request(&self, method: &str, params: Value) -> Result<PendingResponse, AcpError> {
        if !self.is_alive() {
            return Err(self.shared.closed_error());
        }
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending
            .lock()
            .map_err(|_| AcpError::Protocol("pending map poisoned".into()))?
            .insert(id, tx);
        // The reader marks the connection dead *before* failing the pending
        // requests, so a request registered after that must notice here.
        if !self.is_alive() {
            self.forget(id);
            return Err(self.shared.closed_error());
        }
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string();
        if self.out.send(line).is_err() {
            self.forget(id);
            return Err(self.shared.closed_error());
        }
        Ok(PendingResponse { id, rx })
    }

    /// Drop a request's bookkeeping (after a timeout or a cancel).
    pub fn forget(&self, id: u64) {
        if let Ok(mut pending) = self.shared.pending.lock() {
            pending.remove(&id);
        }
    }

    /// Send a request and wait up to `timeout` for its result.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, AcpError> {
        let pending = self.start_request(method, params)?;
        match tokio::time::timeout(timeout, pending.rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(self.shared.closed_error()),
            Err(_) => {
                self.forget(pending.id);
                Err(AcpError::Timeout(format!(
                    "Copilot CLI did not answer `{method}` within {} s",
                    timeout.as_secs()
                )))
            }
        }
    }

    /// Send a notification (no answer expected).
    pub fn notify(&self, method: &str, params: Value) {
        let line = json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string();
        let _ = self.out.send(line);
    }

    /// Receive the updates of `session_id`. Subscribe before sending the
    /// prompt: updates of an unsubscribed session are dropped.
    pub fn subscribe(&self, session_id: &str) -> mpsc::UnboundedReceiver<SessionEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        if let Ok(mut sessions) = self.shared.sessions.lock() {
            sessions.insert(session_id.to_string(), tx);
        }
        rx
    }

    pub fn unsubscribe(&self, session_id: &str) {
        if let Ok(mut sessions) = self.shared.sessions.lock() {
            sessions.remove(session_id);
        }
    }
}

impl Drop for AcpConnection {
    fn drop(&mut self) {
        self.kill();
    }
}

async fn write_loop(
    mut stdin: tokio::process::ChildStdin,
    mut rx: mpsc::UnboundedReceiver<String>,
    shared: Arc<Shared>,
) {
    while let Some(mut line) = rx.recv().await {
        line.push('\n');
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            // The reader sees the exit and fails the pending requests.
            shared.alive.store(false, Ordering::SeqCst);
            break;
        }
    }
}

async fn stderr_loop(mut stderr: tokio::process::ChildStderr, shared: Arc<Shared>) {
    let mut buf = [0u8; 1024];
    loop {
        match stderr.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => shared.push_stderr(&String::from_utf8_lossy(&buf[..n])),
        }
    }
}

async fn read_loop(
    stdout: tokio::process::ChildStdout,
    shared: Arc<Shared>,
    out: mpsc::UnboundedSender<String>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                // Anything that is not a JSON object is not protocol traffic.
                if let Ok(msg) = serde_json::from_str::<Value>(line) {
                    if msg.is_object() {
                        dispatch(&shared, &out, &msg);
                    }
                }
            }
            Ok(None) | Err(_) => break,
        }
    }
    shared.alive.store(false, Ordering::SeqCst);
    // Give the stderr task a moment to deliver the last words of the process.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let error = shared.closed_error();
    let pending: Vec<Responder> = shared
        .pending
        .lock()
        .map(|mut p| p.drain().map(|(_, tx)| tx).collect())
        .unwrap_or_default();
    for tx in pending {
        let _ = tx.send(Err(error.clone()));
    }
    // Dropping the senders ends every session's event stream.
    if let Ok(mut sessions) = shared.sessions.lock() {
        sessions.clear();
    }
}

fn dispatch(shared: &Shared, out: &mpsc::UnboundedSender<String>, msg: &Value) {
    let method = msg.get("method").and_then(Value::as_str);
    let id = msg.get("id").filter(|v| !v.is_null());
    match (method, id) {
        (Some(method), Some(id)) => answer_agent_request(shared, out, method, id, msg),
        (Some("session/update"), None) => route_update(shared, msg),
        (Some(_), None) => {}
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            let responder = shared.pending.lock().ok().and_then(|mut p| p.remove(&id));
            let Some(responder) = responder else { return };
            let result = match msg.get("error") {
                Some(err) => Err(AcpError::Rpc(RpcError {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .to_string(),
                })),
                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = responder.send(result);
        }
        (None, None) => {}
    }
}

/// The agent asked the client for something. Permissions are refused; the
/// client has no fs / terminal capability.
fn answer_agent_request(
    shared: &Shared,
    out: &mpsc::UnboundedSender<String>,
    method: &str,
    id: &Value,
    msg: &Value,
) {
    let reply = if method == "session/request_permission" {
        shared.permissions_refused.fetch_add(1, Ordering::SeqCst);
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": refusal_outcome(&params)}})
    } else {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": -32601, "message": format!("NexQ does not support `{method}`")}
        })
    };
    let _ = out.send(reply.to_string());
}

/// The outcome that refuses a permission request: the agent's own reject
/// option when it offers one, else `cancelled`. Never an allow option.
pub fn refusal_outcome(params: &Value) -> Value {
    let reject = params
        .get("options")
        .and_then(Value::as_array)
        .and_then(|options| {
            options.iter().find(|o| {
                o.get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|k| k.starts_with("reject"))
            })
        })
        .and_then(|o| o.get("optionId").and_then(Value::as_str));
    match reject {
        Some(option_id) => json!({"outcome": "selected", "optionId": option_id}),
        None => json!({"outcome": "cancelled"}),
    }
}

fn route_update(shared: &Shared, msg: &Value) {
    let Some(params) = msg.get("params") else { return };
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else { return };
    let Some(update) = params.get("update") else { return };
    let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
    let event = match kind {
        "agent_message_chunk" => {
            let content = update.get("content");
            let is_text = content
                .and_then(|c| c.get("type"))
                .and_then(Value::as_str)
                .map_or(true, |t| t == "text");
            let text = content.and_then(|c| c.get("text")).and_then(Value::as_str);
            match (is_text, text) {
                (true, Some(text)) if !text.is_empty() => SessionEvent::Text(text.to_string()),
                _ => return,
            }
        }
        "agent_thought_chunk" => SessionEvent::Thinking,
        "tool_call" => SessionEvent::ToolCall(
            update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("a tool")
                .to_string(),
        ),
        _ => return,
    };
    let sender = shared
        .sessions
        .lock()
        .ok()
        .and_then(|s| s.get(session_id).cloned());
    if let Some(sender) = sender {
        let _ = sender.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(kinds: &[(&str, &str)]) -> Value {
        json!({"options": kinds.iter().map(|(id, kind)| json!({"optionId": id, "kind": kind, "name": id})).collect::<Vec<_>>()})
    }

    #[test]
    fn permission_refusal_prefers_a_reject_option_and_never_allows() {
        let both = options(&[("a", "allow_once"), ("b", "allow_always"), ("r", "reject_once")]);
        assert_eq!(refusal_outcome(&both), json!({"outcome": "selected", "optionId": "r"}));
        let only_allow = options(&[("a", "allow_once"), ("b", "allow_always")]);
        assert_eq!(refusal_outcome(&only_allow), json!({"outcome": "cancelled"}));
        assert_eq!(refusal_outcome(&Value::Null), json!({"outcome": "cancelled"}));
        assert_eq!(refusal_outcome(&json!({"options": "nonsense"})), json!({"outcome": "cancelled"}));
    }

    fn shared_with(session: &str) -> (Arc<Shared>, mpsc::UnboundedReceiver<SessionEvent>) {
        let shared = Arc::new(Shared::new());
        let (tx, rx) = mpsc::unbounded_channel();
        shared.sessions.lock().unwrap().insert(session.to_string(), tx);
        (shared, rx)
    }

    fn update(session: &str, update: Value) -> Value {
        json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": update}})
    }

    #[test]
    fn updates_route_to_their_own_session_only() {
        let (shared, mut rx) = shared_with("s1");
        route_update(
            &shared,
            &update("s1", json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}})),
        );
        route_update(
            &shared,
            &update("other", json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "leak"}})),
        );
        route_update(&shared, &update("s1", json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hmm"}})));
        route_update(&shared, &update("s1", json!({"sessionUpdate": "usage_update", "used": 1})));
        route_update(&shared, &update("s1", json!({"sessionUpdate": "tool_call", "title": "bash"})));
        // Non-text content and empty text are not answer text.
        route_update(&shared, &update("s1", json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "image"}})));
        route_update(&shared, &update("s1", json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": ""}})));
        assert_eq!(rx.try_recv().unwrap(), SessionEvent::Text("hi".into()));
        assert_eq!(rx.try_recv().unwrap(), SessionEvent::Thinking);
        assert_eq!(rx.try_recv().unwrap(), SessionEvent::ToolCall("bash".into()));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn stderr_tail_is_bounded_and_char_safe() {
        let (shared, _rx) = shared_with("s");
        let chunk = "é".repeat(STDERR_TAIL_BYTES);
        shared.push_stderr(&chunk);
        shared.push_stderr("end");
        let tail = shared.stderr_tail();
        assert!(tail.len() <= STDERR_TAIL_BYTES);
        assert!(tail.ends_with("end"));
    }

    #[test]
    fn responses_resolve_by_id_and_carry_rpc_errors() {
        let (shared, _rx) = shared_with("s");
        let (out, _out_rx) = mpsc::unbounded_channel();
        let (ok_tx, mut ok_rx) = oneshot::channel();
        let (err_tx, mut err_rx) = oneshot::channel();
        shared.pending.lock().unwrap().insert(1, ok_tx);
        shared.pending.lock().unwrap().insert(2, err_tx);
        dispatch(&shared, &out, &json!({"jsonrpc": "2.0", "id": 1, "result": {"a": 1}}));
        dispatch(
            &shared,
            &out,
            &json!({"jsonrpc": "2.0", "id": 2, "error": {"code": -32000, "message": "Authentication required"}}),
        );
        assert_eq!(ok_rx.try_recv().unwrap().unwrap(), json!({"a": 1}));
        assert_eq!(
            err_rx.try_recv().unwrap().unwrap_err(),
            AcpError::Rpc(RpcError { code: -32000, message: "Authentication required".into() })
        );
    }

    #[test]
    fn agent_requests_get_a_refusal_or_method_not_found() {
        let (shared, _rx) = shared_with("s");
        let (out, mut out_rx) = mpsc::unbounded_channel();
        dispatch(
            &shared,
            &out,
            &json!({"jsonrpc": "2.0", "id": "p-1", "method": "session/request_permission",
                    "params": {"options": [{"optionId": "yes", "kind": "allow_once"}, {"optionId": "no", "kind": "reject_once"}]}}),
        );
        dispatch(&shared, &out, &json!({"jsonrpc": "2.0", "id": 7, "method": "fs/read_text_file", "params": {}}));
        let first: Value = serde_json::from_str(&out_rx.try_recv().unwrap()).unwrap();
        assert_eq!(first["id"], "p-1");
        assert_eq!(first["result"]["outcome"], json!({"outcome": "selected", "optionId": "no"}));
        let second: Value = serde_json::from_str(&out_rx.try_recv().unwrap()).unwrap();
        assert_eq!(second["id"], 7);
        assert_eq!(second["error"]["code"], -32601);
        assert_eq!(shared.permissions_refused.load(Ordering::SeqCst), 1);
    }
}
