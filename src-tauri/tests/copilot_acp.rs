//! Integration tests of the GitHub Copilot provider against
//! `examples/fake_copilot.rs`, a scripted stand-in for `copilot --acp --stdio`.
//!
//! These are MOCKED tests: they prove how NexQ drives the protocol (handshake,
//! streaming, per-request sessions, permission refusal, cancel, error
//! mapping, restart). They say nothing about the real CLI; the live check is
//! `examples/copilot_probe.rs`.

use nexq_lib::llm::copilot::acp::SpawnSpec;
use nexq_lib::llm::copilot::hub::{CopilotHub, Timeouts};
use nexq_lib::llm::copilot::{
    check_status, CopilotError, CopilotErrorKind, CopilotProvider, CopilotState,
};
use nexq_lib::llm::provider::{CancelToken, LLMError, LLMMessage, LLMProvider};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Build `fake_copilot` once and return its path.
fn fake_bin() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let mut cmd = std::process::Command::new(env!("CARGO"));
        cmd.args(["build", "--locked", "--example", "fake_copilot", "--message-format=json"])
            .current_dir(env!("CARGO_MANIFEST_DIR"));
        // Per-crate vars cargo injects into test processes would force rebuilds
        // of build scripts (see tests/claude_session.rs).
        for (key, _) in std::env::vars() {
            let injected = ["CARGO_MANIFEST_", "CARGO_PKG_", "CARGO_CRATE_", "CARGO_PRIMARY_PACKAGE", "CARGO_BIN_", "OUT_DIR"]
                .iter()
                .any(|p| key.starts_with(p));
            if injected {
                cmd.env_remove(key);
            }
        }
        if !cfg!(debug_assertions) {
            cmd.arg("--release");
        }
        // This test binary sits in target/[<triple>/]<profile>/deps: build the
        // example for the same triple.
        let profile_dir = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        if let Some(triple) = profile_dir
            .parent()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| n.matches('-').count() >= 2)
        {
            cmd.args(["--target", &triple]);
        }
        let out = cmd.output().expect("run cargo build --example fake_copilot");
        assert!(
            out.status.success(),
            "building fake_copilot failed:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let stdout = String::from_utf8_lossy(&out.stdout);
        let bin = stdout
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["reason"] == "compiler-artifact" && v["target"]["name"] == "fake_copilot")
            .filter_map(|v| v["executable"].as_str().map(PathBuf::from))
            .last()
            .expect("cargo reported no fake_copilot executable");
        assert!(bin.is_file(), "missing {}", bin.display());
        bin
    })
    .clone()
}

fn temp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("nexq-fake-copilot-{name}-{}", uuid::Uuid::new_v4()))
}

fn fast_timeouts() -> Timeouts {
    Timeouts {
        handshake: Duration::from_secs(20),
        session: Duration::from_secs(20),
        set_model: Duration::from_secs(10),
        close: Duration::from_secs(2),
        idle: Duration::from_secs(20),
    }
}

struct Fixture {
    hub: Arc<CopilotHub>,
    record: PathBuf,
}

fn fixture_with(mode: &str, timeouts: Timeouts) -> Fixture {
    let record = temp_path("record");
    let cwd = temp_path("cwd");
    let args = vec![
        "--acp".to_string(),
        "--stdio".to_string(),
        format!("--fake={mode}"),
        format!("--record={}", record.display()),
    ];
    let program = fake_bin();
    let launcher = Arc::new(move || {
        Ok(SpawnSpec {
            program: program.clone(),
            args: args.clone(),
            cwd: cwd.clone(),
            remove_env: Vec::new(),
            set_env: Vec::new(),
        })
    });
    Fixture { hub: Arc::new(CopilotHub::with_timeouts(launcher, timeouts)), record }
}

fn fixture(mode: &str) -> Fixture {
    fixture_with(mode, fast_timeouts())
}

impl Fixture {
    fn provider(&self) -> CopilotProvider {
        CopilotProvider::with_hub(self.hub.clone())
    }

    /// Every message the fake received, parsed.
    fn received(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.record)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    fn received_method(&self, method: &str) -> Vec<Value> {
        self.received()
            .into_iter()
            .filter(|m| m["method"] == method)
            .collect()
    }

    /// Wait until the fake has received `count` messages of `method`.
    async fn wait_for(&self, method: &str, count: usize) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let found = self.received_method(method);
            if found.len() >= count || Instant::now() > deadline {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

fn user(text: &str) -> Vec<LLMMessage> {
    vec![LLMMessage { role: "user".into(), content: text.into() }]
}

struct Run {
    text: String,
    pieces: Vec<String>,
    thinking: usize,
}

async fn run(
    provider: &CopilotProvider,
    messages: &[LLMMessage],
    model: &str,
    cancel: &CancelToken,
) -> (Result<nexq_lib::llm::copilot::provider::Completion, LLMError>, Run) {
    let pieces = Mutex::new(Vec::<String>::new());
    let thinking = Mutex::new(0usize);
    let result = {
        let mut on_text = |t: &str| pieces.lock().unwrap().push(t.to_string());
        let mut on_thinking = || *thinking.lock().unwrap() += 1;
        provider.complete(messages, model, cancel, &mut on_text, &mut on_thinking).await
    };
    let pieces = pieces.into_inner().unwrap();
    let thinking = thinking.into_inner().unwrap();
    (result, Run { text: pieces.concat(), pieces, thinking })
}

// ── handshake / status ────────────────────────────────────────────────

#[tokio::test]
async fn status_is_ready_after_a_real_handshake_and_session() {
    let f = fixture("normal");
    let status = check_status(&f.hub).await;
    assert_eq!(status.state, CopilotState::Ready, "{:?}", status.error);
    assert!(status.installed && status.handshake_ok && status.session_ok);
    assert_eq!(status.version.as_deref(), Some("9.9.9"));
    assert_eq!(status.current_model.as_deref(), Some("claude-sonnet-5.5"));
    let ids: Vec<&str> = status.models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["auto", "claude-sonnet-5.5", "claude-haiku-4.5"]);
    assert!(status.error.is_none());

    // The client declared no capability, asked for no MCP servers and
    // gave an absolute throw-away working directory.
    let init = &f.received_method("initialize")[0];
    assert_eq!(init["params"]["protocolVersion"], 1);
    assert_eq!(init["params"]["clientCapabilities"], json!({}));
    assert_eq!(init["params"]["clientInfo"]["name"], "nexq");
    let new = &f.received_method("session/new")[0];
    assert_eq!(new["params"]["mcpServers"], json!([]));
    assert!(Path::new(new["params"]["cwd"].as_str().unwrap()).is_absolute());
    // The probe session is closed again.
    assert_eq!(f.wait_for("session/close", 1).await.len(), 1);
}

#[tokio::test]
async fn test_connection_and_list_models_use_the_live_catalog() {
    let f = fixture("normal");
    let provider = f.provider();
    assert!(provider.test_connection().await.unwrap());
    let models = provider.list_models().await.unwrap();
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["auto", "claude-sonnet-5.5", "claude-haiku-4.5"]);
    assert_eq!(models[1].name, "Claude Sonnet 5.5");
    assert!(models.iter().all(|m| m.provider == "github_copilot"));
    // One process served the status check and the model list.
    assert_eq!(f.hub.spawn_count(), 1);
}

#[tokio::test]
async fn a_missing_cli_is_reported_as_not_installed() {
    let hub = Arc::new(CopilotHub::new(Arc::new(|| {
        Err(CopilotError::new(CopilotErrorKind::NotInstalled, "The GitHub Copilot CLI is not installed"))
    })));
    let status = check_status(&hub).await;
    assert_eq!(status.state, CopilotState::NotInstalled);
    assert!(!status.installed && !status.handshake_ok);
    assert!(status.login_hint.contains("Install"));
    let provider = CopilotProvider::with_hub(hub);
    assert!(matches!(provider.test_connection().await, Err(LLMError::NotConfigured(_))));
    assert!(matches!(provider.list_models().await, Err(LLMError::NotConfigured(_))));
    let (result, _) = run(&provider, &user("hi"), "auto", &CancelToken::new()).await;
    assert!(matches!(result, Err(LLMError::NotConfigured(_))));
}

#[tokio::test]
async fn a_cli_that_dies_during_the_handshake_is_a_protocol_error_with_its_stderr() {
    let f = fixture("exit_on_start");
    let status = check_status(&f.hub).await;
    assert_eq!(status.state, CopilotState::ProtocolError);
    assert!(status.installed && !status.handshake_ok);
    assert!(status.error.as_deref().unwrap().contains("refusing to start"), "{:?}", status.error);
    assert!(matches!(f.provider().test_connection().await, Err(LLMError::ConnectionFailed(_))));
}

#[tokio::test]
async fn a_cli_that_never_answers_the_handshake_is_a_timeout() {
    let f = fixture_with("silent_start", Timeouts { handshake: Duration::from_millis(400), ..fast_timeouts() });
    let status = check_status(&f.hub).await;
    assert_eq!(status.state, CopilotState::Timeout, "{:?}", status.error);
    assert!(status.error.as_deref().unwrap().contains("did not answer"), "{:?}", status.error);
    assert!(matches!(f.provider().test_connection().await, Err(LLMError::ConnectionFailed(_))));
}

// ── authentication / entitlement ──────────────────────────────────────

#[tokio::test]
async fn an_authentication_error_from_session_new_means_not_logged_in() {
    let f = fixture("auth_new");
    let status = check_status(&f.hub).await;
    assert_eq!(status.state, CopilotState::NotLoggedIn);
    assert!(status.handshake_ok && !status.session_ok);
    let error = status.error.as_deref().unwrap();
    assert!(error.contains("Authentication required"), "genuine text kept: {error}");
    assert!(status.login_hint.contains("copilot login"));

    let provider = f.provider();
    match provider.test_connection().await {
        Err(LLMError::AuthError(m)) => assert!(m.contains("copilot login"), "{m}"),
        other => panic!("expected AuthError, got {other:?}"),
    }
    assert!(matches!(provider.list_models().await, Err(LLMError::AuthError(_))));
    let (result, _) = run(&provider, &user("hi"), "auto", &CancelToken::new()).await;
    assert!(matches!(result, Err(LLMError::AuthError(_))));
}

#[tokio::test]
async fn an_authentication_error_while_prompting_is_an_auth_error() {
    let f = fixture("normal");
    let (result, run) = run(&f.provider(), &user("FAKE_AUTH"), "auto", &CancelToken::new()).await;
    match result {
        Err(LLMError::AuthError(m)) => assert!(m.contains("Authentication required"), "{m}"),
        other => panic!("expected AuthError, got {:?}", other.err()),
    }
    assert!(run.text.is_empty());
}

#[tokio::test]
async fn no_enabled_model_means_no_entitlement() {
    let f = fixture("no_entitlement");
    let status = check_status(&f.hub).await;
    assert_eq!(status.state, CopilotState::NoEntitlement);
    assert!(status.session_ok);
    assert!(status.error.as_deref().unwrap().contains("no model enabled"));
    assert!(matches!(f.provider().list_models().await, Err(LLMError::AuthError(_))));
    assert!(matches!(f.provider().test_connection().await, Err(LLMError::AuthError(_))));
}

// ── streaming, usage, models ──────────────────────────────────────────

#[tokio::test]
async fn text_streams_in_chunks_with_usage_reported_by_the_cli() {
    let f = fixture("normal");
    let messages = vec![
        LLMMessage { role: "system".into(), content: "Be brief.".into() },
        LLMMessage { role: "user".into(), content: "What is two plus two?".into() },
    ];
    let (result, run) = run(&f.provider(), &messages, "auto", &CancelToken::new()).await;
    let done = result.unwrap();
    assert!(run.pieces.len() >= 3, "streamed in pieces: {:?}", run.pieces);
    assert!(run.text.contains("echo: "), "{}", run.text);
    assert!(run.text.contains("## Instructions\n\nBe brief."), "{}", run.text);
    assert!(run.text.contains("What is two plus two?"), "{}", run.text);
    assert_eq!(run.thinking, 1, "thinking is reported once");
    assert_eq!(done.stats.prompt_tokens, 100);
    assert_eq!(done.stats.completion_tokens, 5);
    assert_eq!(done.stats.total_tokens, 105);
    let usage = done.usage.unwrap();
    assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.cache_write_tokens), (70, 10, 20));
    assert!(usage.first_token_ms.is_some());
    assert_eq!(usage.cost_usd, None, "no cost is invented");
}

#[tokio::test]
async fn missing_usage_stays_zero_instead_of_being_estimated() {
    let f = fixture("no_usage");
    let (result, _) = run(&f.provider(), &user("hi"), "auto", &CancelToken::new()).await;
    let done = result.unwrap();
    assert_eq!((done.stats.prompt_tokens, done.stats.completion_tokens, done.stats.total_tokens), (0, 0, 0));
    assert!(done.usage.is_none());
}

#[tokio::test]
async fn the_selected_model_reaches_the_cli_and_auto_is_the_default() {
    let f = fixture("normal");
    let provider = f.provider();
    let (haiku, run1) = run(&provider, &user("a"), "claude-haiku-4.5", &CancelToken::new()).await;
    haiku.unwrap();
    assert!(run1.text.contains("model=claude-haiku-4.5"), "{}", run1.text);
    let (auto, run2) = run(&provider, &user("b"), "", &CancelToken::new()).await;
    auto.unwrap();
    assert!(run2.text.contains("model=auto"), "{}", run2.text);
    let set: Vec<String> = f
        .received_method("session/set_model")
        .iter()
        .map(|m| m["params"]["modelId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(set, ["claude-haiku-4.5", "auto"]);
    // Asking for the CLI's own default needs no extra call.
    let (default, _) = run(&provider, &user("c"), "claude-sonnet-5.5", &CancelToken::new()).await;
    default.unwrap();
    assert_eq!(f.received_method("session/set_model").len(), 2);
}

#[tokio::test]
async fn a_model_the_cli_rejects_fails_with_its_message() {
    let f = fixture("normal");
    let (result, run) = run(&f.provider(), &user("a"), "no-such-model", &CancelToken::new()).await;
    match result {
        Err(LLMError::ProviderError(m)) => {
            assert!(m.contains("no-such-model") && m.contains("not one of this session's models"), "{m}")
        }
        other => panic!("expected ProviderError, got {:?}", other.err()),
    }
    assert!(f.received_method("session/prompt").is_empty(), "nothing was sent to the wrong model");
    assert!(run.text.is_empty());
}

#[tokio::test]
async fn the_cli_status_notice_never_reaches_the_answer() {
    let f = fixture("notice");
    let (result, run) = run(&f.provider(), &user("hello"), "auto", &CancelToken::new()).await;
    result.unwrap();
    assert!(!run.text.contains("Disabled tools"), "{}", run.text);
    assert!(run.text.starts_with("[fake-session-"), "{}", run.text);
}

// ── isolation ─────────────────────────────────────────────────────────

#[tokio::test]
async fn every_request_gets_its_own_fresh_session() {
    let f = fixture("normal");
    let provider = f.provider();
    let (first, run1) = run(&provider, &user("MEETING-ALPHA secret budget"), "auto", &CancelToken::new()).await;
    first.unwrap();
    let (second, run2) = run(&provider, &user("MEETING-BETA agenda"), "auto", &CancelToken::new()).await;
    second.unwrap();

    // Both turns were the first turn of a brand-new session.
    assert!(run1.text.contains("|prior=0|"), "{}", run1.text);
    assert!(run2.text.contains("|prior=0|"), "{}", run2.text);
    assert_eq!(f.hub.spawn_count(), 1, "one shared process");

    let news = f.received_method("session/new");
    assert_eq!(news.len(), 2, "a session per request");
    let prompts = f.received_method("session/prompt");
    assert_eq!(prompts.len(), 2);
    let sessions: Vec<&str> = prompts.iter().map(|p| p["params"]["sessionId"].as_str().unwrap()).collect();
    assert_ne!(sessions[0], sessions[1], "no session is reused");
    // The second prompt carries nothing of the first meeting.
    let second_text = prompts[1]["params"]["prompt"][0]["text"].as_str().unwrap();
    assert!(second_text.contains("MEETING-BETA") && !second_text.contains("MEETING-ALPHA"));
    assert!(!run2.text.contains("MEETING-ALPHA"));
    // And both sessions are closed again.
    let closes = f.wait_for("session/close", 2).await;
    let closed: Vec<&str> = closes.iter().map(|c| c["params"]["sessionId"].as_str().unwrap()).collect();
    assert!(closed.contains(&sessions[0]) && closed.contains(&sessions[1]), "{closed:?}");
}

#[tokio::test]
async fn concurrent_requests_do_not_mix_their_streams() {
    let f = fixture("normal");
    let provider = Arc::new(f.provider());
    let a = {
        let p = provider.clone();
        tokio::spawn(async move { run(&p, &user("ALPHA-ONLY"), "auto", &CancelToken::new()).await.1.text })
    };
    let b = {
        let p = provider.clone();
        tokio::spawn(async move { run(&p, &user("BETA-ONLY"), "auto", &CancelToken::new()).await.1.text })
    };
    let (a, b) = (a.await.unwrap(), b.await.unwrap());
    assert!(a.contains("ALPHA-ONLY") && !a.contains("BETA-ONLY"), "{a}");
    assert!(b.contains("BETA-ONLY") && !b.contains("ALPHA-ONLY"), "{b}");
    assert_eq!(f.hub.spawn_count(), 1);
}

#[tokio::test]
async fn a_chat_history_travels_in_the_single_prompt_of_its_own_session() {
    let f = fixture("normal");
    let messages = vec![
        LLMMessage { role: "user".into(), content: "My name is Ada.".into() },
        LLMMessage { role: "assistant".into(), content: "Hello Ada.".into() },
        LLMMessage { role: "user".into(), content: "What is my name?".into() },
    ];
    let (result, run) = run(&f.provider(), &messages, "auto", &CancelToken::new()).await;
    result.unwrap();
    assert!(run.text.contains("User: My name is Ada.\n\nAssistant: Hello Ada.\n\nUser: What is my name?"), "{}", run.text);
    assert_eq!(f.received_method("session/prompt").len(), 1);
}

#[tokio::test]
async fn sessions_are_not_closed_when_the_cli_has_no_close_method() {
    let f = fixture("no_close");
    let (result, _) = run(&f.provider(), &user("hi"), "auto", &CancelToken::new()).await;
    result.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(f.received_method("session/close").is_empty());
}

// ── safety: permissions and tools ─────────────────────────────────────

#[tokio::test]
async fn a_permission_request_is_always_refused() {
    let f = fixture("normal");
    let (result, run) = run(&f.provider(), &user("FAKE_PERMISSION"), "auto", &CancelToken::new()).await;
    result.unwrap();
    assert!(run.text.contains("reject-once"), "the reject option was chosen: {}", run.text);
    assert!(!run.text.contains("allow-once"), "{}", run.text);
    let live = f.hub.connection().await.unwrap();
    assert_eq!(live.conn.permissions_refused(), 1);
}

#[tokio::test]
async fn a_tool_call_stops_the_turn() {
    let f = fixture("normal");
    let (result, _) = run(&f.provider(), &user("FAKE_TOOL"), "auto", &CancelToken::new()).await;
    match result {
        Err(LLMError::ProviderError(m)) => assert!(m.contains("tried to use bash"), "{m}"),
        other => panic!("expected ProviderError, got {:?}", other.err()),
    }
    assert_eq!(f.wait_for("session/cancel", 1).await.len(), 1, "the agent was told to stop");
}

// ── cancel, timeout, restart ──────────────────────────────────────────

#[tokio::test]
async fn cancel_sends_session_cancel_and_returns_promptly() {
    let f = fixture("normal");
    let provider = Arc::new(f.provider());
    let cancel = Arc::new(CancelToken::new());
    let task = {
        let (p, c) = (provider.clone(), cancel.clone());
        tokio::spawn(async move { run(&p, &user("FAKE_HANG"), "auto", &c).await })
    };
    // Wait until the turn is running (prompt received), then cancel.
    assert_eq!(f.wait_for("session/prompt", 1).await.len(), 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let cancelled_at = Instant::now();
    cancel.cancel();
    let (result, run1) = task.await.unwrap();
    assert!(cancelled_at.elapsed() < Duration::from_secs(2), "cancel must not wait for the turn");
    assert!(matches!(result, Err(LLMError::Cancelled)), "{:?}", result.err());
    assert_eq!(f.wait_for("session/cancel", 1).await.len(), 1);
    let sid = f.received_method("session/prompt")[0]["params"]["sessionId"].clone();
    assert_eq!(f.received_method("session/cancel")[0]["params"]["sessionId"], sid);
    assert!(run1.text.is_empty() || run1.text == "partial");

    // The shared process is still good for the next request.
    let (next, _) = run(&provider, &user("after cancel"), "auto", &CancelToken::new()).await;
    next.unwrap();
    assert_eq!(f.hub.spawn_count(), 1);
}

#[tokio::test]
async fn a_request_cancelled_before_it_starts_sends_nothing() {
    let f = fixture("normal");
    let cancel = CancelToken::new();
    cancel.cancel();
    let (result, _) = run(&f.provider(), &user("hi"), "auto", &cancel).await;
    assert!(matches!(result, Err(LLMError::Cancelled)));
    assert!(f.received_method("session/prompt").is_empty());
}

#[tokio::test]
async fn a_silent_cli_times_out_and_is_told_to_stop() {
    let f = fixture_with("normal", Timeouts { idle: Duration::from_millis(400), ..fast_timeouts() });
    let (result, _) = run(&f.provider(), &user("FAKE_SILENT"), "auto", &CancelToken::new()).await;
    match result {
        Err(LLMError::ConnectionFailed(m)) => assert!(m.contains("sent nothing"), "{m}"),
        other => panic!("expected a timeout, got {:?}", other.err()),
    }
    assert_eq!(f.wait_for("session/cancel", 1).await.len(), 1);
}

#[tokio::test]
async fn a_dead_process_is_restarted_for_the_next_request() {
    let f = fixture("normal");
    let provider = f.provider();
    let (crashed, run1) = run(&provider, &user("FAKE_CRASH"), "auto", &CancelToken::new()).await;
    match crashed {
        Err(LLMError::ConnectionFailed(m)) => assert!(m.contains("ended unexpectedly"), "{m}"),
        other => panic!("expected a connection error, got {:?}", other.err()),
    }
    assert_eq!(run1.text, "par", "what streamed before the crash was delivered");
    assert_eq!(f.hub.spawn_count(), 1);

    let (again, run2) = run(&provider, &user("back again"), "auto", &CancelToken::new()).await;
    again.unwrap();
    assert!(run2.text.contains("back again"));
    assert_eq!(f.hub.spawn_count(), 2, "a new process was started");
    // The new process knows nothing of the old session.
    assert!(run2.text.contains("|prior=0|"));
}
