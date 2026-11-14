//! Test double for `copilot --acp --stdio`, used by `tests/copilot_acp.rs`.
//! It speaks the newline-delimited JSON-RPC 2.0 flavour of the Agent Client
//! Protocol that the real GitHub Copilot CLI speaks, and ignores the real
//! launch flags (`--available-tools=...`, `--deny-tool=...`, ...).
//!
//! Directives (command line):
//! - `--version`: prints a version banner like the CLI and exits.
//! - `--record=<path>`: every line received on stdin is appended to this file.
//! - `--fake=<mode>`:
//!   `normal` (default) | `auth_new` (session/new fails with -32000) |
//!   `no_entitlement` (every model reports `copilotEnablement: disabled`) |
//!   `no_close` (initialize does not advertise `session/close`) |
//!   `no_usage` (prompt results carry no usage) |
//!   `notice` (answers start with the CLI's "Info: Disabled tools" line) |
//!   `exit_on_start` (prints to stderr and exits 7 before answering) |
//!   `silent_start` (stays alive but never answers `initialize`).
//!
//! Prompt magic (anywhere in the prompt text):
//! - `FAKE_AUTH`: the prompt fails with -32000 "Authentication required".
//! - `FAKE_PERMISSION`: asks `session/request_permission` (allow + reject
//!   options) and answers with the outcome it received.
//! - `FAKE_TOOL`: announces a `tool_call`, then waits for `session/cancel`.
//! - `FAKE_HANG`: streams `partial`, then waits for `session/cancel` and
//!   ends the turn with `stopReason: cancelled`.
//! - `FAKE_SILENT`: never answers (reads stdin forever).
//! - `FAKE_CRASH`: streams one chunk, then exits with code 3.
//! - otherwise: a thought chunk, then `[<sessionId>|prior=<n>|model=<m>] echo: <prompt>`
//!   in three chunks, `stopReason: end_turn` and token usage.
//!   `prior` is the number of prompts the SESSION had before this one.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::mpsc;

fn send(v: &Value) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{v}").unwrap();
    out.flush().unwrap();
}

fn update(session: &str, update: Value) {
    send(&json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": update}}));
}

fn chunk(session: &str, text: &str) {
    update(
        session,
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}),
    );
}

fn models(mode: &str) -> Value {
    let enablement = if mode == "no_entitlement" { "disabled" } else { "enabled" };
    json!([
        {"modelId": "auto", "name": "Auto", "description": "Let Copilot pick the best model"},
        {"modelId": "auto", "name": "Auto", "description": "Auto", "_meta": {"copilotUsage": "1x", "copilotEnablement": enablement}},
        {"modelId": "claude-sonnet-5.5", "name": "Claude Sonnet 5.5", "description": "Claude Sonnet 5.5", "_meta": {"copilotUsage": "1x", "copilotEnablement": enablement}},
        {"modelId": "claude-haiku-4.5", "name": "Claude Haiku 4.5", "description": "Claude Haiku 4.5", "_meta": {"copilotUsage": "0.33x", "copilotEnablement": enablement}}
    ])
}

struct Session {
    prompts: usize,
    model: String,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("GitHub Copilot CLI 9.9.9.\nRun 'copilot update' to check for updates.");
        return;
    }
    let flag = |name: &str| {
        args.iter()
            .find_map(|a| a.strip_prefix(&format!("{name}=")).map(str::to_string))
    };
    let mode = flag("--fake").unwrap_or_else(|| "normal".into());
    let record = flag("--record");
    if mode == "exit_on_start" {
        eprintln!("fake_copilot: refusing to start");
        std::process::exit(7);
    }
    if mode == "silent_start" {
        // Alive but never answers `initialize`.
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }

    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if let Some(path) = &record {
                let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
                writeln!(f, "{line}").unwrap();
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });

    // Noise that is not protocol traffic: the client must skip it.
    println!("fake_copilot starting");

    let mut sessions: HashMap<String, Session> = HashMap::new();
    let mut counter = 0usize;
    while let Ok(msg) = rx.recv() {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let id = msg.get("id").cloned();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let reply = |result: Value| send(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
        let fail = |code: i64, message: &str| {
            send(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}))
        };
        match method {
            "initialize" => {
                let mut caps = json!({"loadSession": true, "sessionCapabilities": {"close": {}, "list": {}}});
                if mode == "no_close" {
                    caps = json!({"loadSession": true});
                }
                reply(json!({
                    "protocolVersion": 1,
                    "agentCapabilities": caps,
                    "agentInfo": {"name": "Copilot", "title": "Copilot", "version": "9.9.9"},
                    "authMethods": [{"id": "copilot-login", "name": "Log in with Copilot CLI"}]
                }));
            }
            "session/new" => {
                if mode == "auth_new" {
                    fail(-32000, "Authentication required");
                    continue;
                }
                counter += 1;
                let sid = format!("fake-session-{counter}");
                sessions.insert(sid.clone(), Session { prompts: 0, model: "claude-sonnet-5.5".into() });
                reply(json!({
                    "sessionId": sid,
                    "models": {"availableModels": models(&mode), "currentModelId": "claude-sonnet-5.5"},
                    "modes": {},
                }));
                update(&sid, json!({"sessionUpdate": "available_commands_update", "availableCommands": []}));
            }
            "session/set_model" => {
                let sid = params["sessionId"].as_str().unwrap_or("");
                let model = params["modelId"].as_str().unwrap_or("");
                let known = ["auto", "claude-sonnet-5.5", "claude-haiku-4.5"].contains(&model);
                match sessions.get_mut(sid) {
                    Some(s) if known => {
                        s.model = model.to_string();
                        reply(json!({}));
                    }
                    Some(_) => fail(-32602, &format!("Invalid modelId '{model}': not one of this session's models.")),
                    None => fail(-32602, "unknown session"),
                }
            }
            "session/close" => {
                let sid = params["sessionId"].as_str().unwrap_or("");
                sessions.remove(sid);
                reply(json!({}));
            }
            "session/cancel" => {}
            "session/prompt" => {
                let sid = params["sessionId"].as_str().unwrap_or("").to_string();
                let text = params["prompt"][0]["text"].as_str().unwrap_or("").to_string();
                let Some(session) = sessions.get_mut(&sid) else {
                    fail(-32602, "unknown session");
                    continue;
                };
                let prior = session.prompts;
                session.prompts += 1;
                let model = session.model.clone();

                if text.contains("FAKE_AUTH") {
                    fail(-32000, "Authentication required");
                } else if text.contains("FAKE_PERMISSION") {
                    send(&json!({"jsonrpc": "2.0", "id": 9001, "method": "session/request_permission", "params": {
                        "sessionId": sid,
                        "toolCall": {"toolCallId": "t1", "title": "Run rm -rf", "kind": "execute"},
                        "options": [
                            {"optionId": "allow-once", "name": "Allow", "kind": "allow_once"},
                            {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
                        ]}}));
                    let outcome = loop {
                        match rx.recv() {
                            Ok(m) if m.get("id") == Some(&json!(9001)) => break m["result"]["outcome"].clone(),
                            Ok(_) => {}
                            Err(_) => return,
                        }
                    };
                    chunk(&sid, &format!("permission outcome: {outcome}"));
                    reply(json!({"stopReason": "end_turn"}));
                } else if text.contains("FAKE_TOOL") {
                    update(&sid, json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "bash", "kind": "execute", "status": "pending"}));
                    wait_for_cancel(&rx, &sid);
                    reply(json!({"stopReason": "cancelled"}));
                } else if text.contains("FAKE_HANG") {
                    chunk(&sid, "partial");
                    wait_for_cancel(&rx, &sid);
                    reply(json!({"stopReason": "cancelled"}));
                } else if text.contains("FAKE_SILENT") {
                    loop {
                        if rx.recv().is_err() {
                            return;
                        }
                    }
                } else if text.contains("FAKE_CRASH") {
                    chunk(&sid, "par");
                    eprintln!("fake_copilot: crashing mid-turn");
                    std::process::exit(3);
                } else {
                    update(&sid, json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}}));
                    if mode == "notice" {
                        // As captured from the real CLI: separate chunks, no trailing newline.
                        chunk(&sid, "Info: Disabled tools: bash, view, edit");
                        chunk(&sid, "Info: Unknown tool name in the tool allowlist: \"nexq-no-tools\"");
                    }
                    chunk(&sid, &format!("[{sid}|prior={prior}|model={model}] "));
                    chunk(&sid, "echo: ");
                    chunk(&sid, &text);
                    update(&sid, json!({"sessionUpdate": "usage_update", "used": 10, "size": 200000}));
                    let mut result = json!({"stopReason": "end_turn"});
                    if mode != "no_usage" {
                        result["usage"] = json!({"inputTokens": 100, "outputTokens": 5, "totalTokens": 105,
                            "thoughtTokens": 0, "cachedReadTokens": 10, "cachedWriteTokens": 20});
                    }
                    reply(result);
                }
            }
            _ => {
                if id.is_some() {
                    fail(-32601, "Method not found");
                }
            }
        }
    }
}

/// Block until `session/cancel` for `sid` arrives (the client cancelled).
fn wait_for_cancel(rx: &mpsc::Receiver<Value>, sid: &str) {
    loop {
        match rx.recv() {
            Ok(m)
                if m.get("method").and_then(Value::as_str) == Some("session/cancel")
                    && m["params"]["sessionId"] == sid =>
            {
                return
            }
            Ok(_) => {}
            Err(_) => std::process::exit(0),
        }
    }
}
