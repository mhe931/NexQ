//! Live check of the GitHub Copilot integration against the REAL, signed-in
//! `copilot` CLI. Not part of any test run: it talks to the user's account.
//!
//!   cargo run --release --target x86_64-pc-windows-gnu --locked --example copilot_probe -- status
//!       The `copilot_status` check: `copilot --version`, ACP handshake,
//!       `session/new` with the live model catalog. Makes NO model call.
//!   cargo run ... --example copilot_probe -- raw "<prompt>" [model]
//!       One real prompt through the restricted launch, printing every
//!       streamed chunk as it arrived (exactly as the CLI chunked it), the
//!       turn result and the permission refusals. Costs one Copilot request.

use nexq_lib::llm::copilot::acp::{AcpConnection, SessionEvent, PROTOCOL_VERSION};
use nexq_lib::llm::copilot::detect::{find_copilot_binary, launch_spec};
use nexq_lib::llm::copilot::{check_status, CopilotHub};
use serde_json::json;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("status") => {
            let status = check_status(&CopilotHub::global()).await;
            println!("{}", serde_json::to_string_pretty(&status).unwrap());
        }
        Some("raw") => {
            let prompt = args.get(1).cloned().unwrap_or_else(|| "Reply with exactly the single word: pong".into());
            let model = args.get(2).cloned().unwrap_or_else(|| "auto".into());
            raw(&prompt, &model).await;
        }
        _ => eprintln!("usage: copilot_probe status | raw \"<prompt>\" [model]"),
    }
}

async fn raw(prompt: &str, model: &str) {
    let bin = find_copilot_binary().expect("copilot CLI not found");
    let spec = launch_spec(&bin);
    println!("launch: {} {}", spec.program.display(), spec.args.join(" "));
    let conn = AcpConnection::spawn(&spec).expect("spawn");
    let t = Duration::from_secs(60);
    let init = conn
        .request(
            "initialize",
            json!({"protocolVersion": PROTOCOL_VERSION, "clientCapabilities": {}, "clientInfo": {"name": "nexq-probe", "version": "0"}}),
            t,
        )
        .await
        .expect("initialize");
    println!("initialize ok, agent version {}", init["agentInfo"]["version"]);
    let session = conn
        .request("session/new", json!({"cwd": spec.cwd.to_string_lossy(), "mcpServers": []}), t)
        .await
        .expect("session/new");
    let sid = session["sessionId"].as_str().expect("sessionId").to_string();
    println!("session/new ok, current model {}", session["models"]["currentModelId"]);
    conn.request("session/set_model", json!({"sessionId": sid, "modelId": model}), t)
        .await
        .expect("session/set_model");
    println!("model set to {model}");

    let mut events = conn.subscribe(&sid);
    let pending = conn
        .start_request("session/prompt", json!({"sessionId": sid, "prompt": [{"type": "text", "text": prompt}]}))
        .expect("prompt");
    let mut response = pending.rx;
    let result = loop {
        tokio::select! {
            Some(event) = events.recv() => match event {
                SessionEvent::Text(text) => println!("CHUNK {}", serde_json::to_string(&text).unwrap()),
                SessionEvent::Thinking => println!("THINKING"),
                SessionEvent::ToolCall(name) => println!("TOOL CALL {name}"),
            },
            result = &mut response => break result,
            _ = tokio::time::sleep(Duration::from_secs(120)) => {
                println!("TIMEOUT");
                conn.kill();
                return;
            }
        }
    };
    while let Ok(event) = events.try_recv() {
        if let SessionEvent::Text(text) = event {
            println!("CHUNK {}", serde_json::to_string(&text).unwrap());
        }
    }
    println!("RESULT {:?}", result.map(|r| r.map(|v| v.to_string())));
    println!("permissions refused: {}", conn.permissions_refused());
    let _ = conn.request("session/close", json!({"sessionId": sid}), Duration::from_secs(5)).await;
    conn.kill();
}
