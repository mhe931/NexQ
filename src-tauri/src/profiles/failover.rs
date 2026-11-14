//! Runs one answer request under a meeting's routing policy.
//!
//! The first attempt streams through the chosen model. If it fails *before any
//! text was shown*, and the policy (consent, cost, switch) allows it, exactly
//! one attempt is made on the fallback. Text from a superseded attempt is never
//! published, so the user never sees a duplicated or mixed answer.

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use super::routing::{
    choose_for_request, classify_failure, decide_after_failure, Decision, FailureKind, LatencyBook, ModelRef,
    RoutingPolicy,
};
use crate::llm::provider::{CancelToken, CompletionStats, LLMError, TokenSink};

pub trait Publisher: Send + Sync {
    fn token(&self, text: &str);
    fn end(&self, tokens: u64, latency_ms: u64);
    fn error(&self, message: &str);
    /// The request moved to another provider (for a visible notice).
    fn switched(&self, from: &ModelRef, to: &ModelRef, reason: FailureKind);
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Publishes through the same `llm_stream_*` events the normal path uses, so
/// the interface needs no special case for a routed request.
pub struct TauriPublisher {
    pub app: tauri::AppHandle,
    pub params: crate::llm::provider::GenerationParams,
}

pub const FALLBACK_NOTICE_EVENT: &str = "profile_fallback";

#[derive(serde::Serialize, Clone)]
struct FallbackNotice {
    from_provider: String,
    from_model: String,
    to_provider: String,
    to_model: String,
    reason: FailureKind,
    request_id: Option<String>,
}

impl Publisher for TauriPublisher {
    fn token(&self, text: &str) {
        crate::llm::provider::emit_token(&self.app, &self.params, text, None);
    }
    fn end(&self, tokens: u64, latency_ms: u64) {
        crate::llm::provider::emit_end(&self.app, &self.params, tokens, latency_ms);
    }
    fn error(&self, message: &str) {
        crate::llm::provider::emit_error(&self.app, &self.params, message);
    }
    fn switched(&self, from: &ModelRef, to: &ModelRef, reason: FailureKind) {
        use tauri::Emitter;
        let _ = self.app.emit(
            FALLBACK_NOTICE_EVENT,
            FallbackNotice {
                from_provider: from.provider.clone(),
                from_model: from.model.clone(),
                to_provider: to.provider.clone(),
                to_model: to.model.clone(),
                reason,
                request_id: self.params.request_id.clone(),
            },
        );
    }
}

pub async fn run<F, Fut>(
    policy: &RoutingPolicy,
    book: &Mutex<LatencyBook>,
    spent_usd: f64,
    publisher: Arc<dyn Publisher>,
    cancel: &CancelToken,
    mut attempt: F,
) -> Result<(), String>
where
    F: FnMut(ModelRef, TokenSink) -> Fut,
    Fut: Future<Output = Result<CompletionStats, LLMError>>,
{
    let mut target = {
        let book = book.lock().map_err(|e| e.to_string())?;
        match choose_for_request(policy, &book, spent_usd, now_ms()) {
            Decision::UseFallback(fb) => fb,
            _ => policy.primary.clone(),
        }
    };
    let mut fell_back = target != policy.primary;
    // Only the attempt whose number equals this may publish.
    let live_attempt = Arc::new(AtomicU64::new(1));
    let mut number = 1u64;

    loop {
        let started = Arc::new(AtomicBool::new(false));
        let first_token_ms = Arc::new(AtomicU64::new(0));
        let clock = Instant::now();
        let sink: TokenSink = {
            let (publisher, started, live, first) =
                (publisher.clone(), started.clone(), live_attempt.clone(), first_token_ms.clone());
            let mine = number;
            Arc::new(move |text: &str| {
                if live.load(Ordering::SeqCst) != mine || text.is_empty() {
                    return;
                }
                if !started.swap(true, Ordering::SeqCst) {
                    first.store(clock.elapsed().as_millis() as u64, Ordering::SeqCst);
                }
                publisher.token(text);
            })
        };

        let result = attempt(target.clone(), sink).await;
        match result {
            Ok(stats) => {
                if let Ok(mut book) = book.lock() {
                    book.record_success(&target, first_token_ms.load(Ordering::SeqCst), stats.latency_ms);
                }
                publisher.end(stats.total_tokens, stats.latency_ms);
                return Ok(());
            }
            Err(LLMError::Cancelled) => return Ok(()),
            Err(_) if cancel.is_cancelled() => return Ok(()),
            Err(error) => {
                let message = error.to_string();
                let kind = classify_failure(&message);
                if let Ok(mut book) = book.lock() {
                    book.record_failure(&target, kind, now_ms());
                }
                let decision = decide_after_failure(
                    policy,
                    kind,
                    started.load(Ordering::SeqCst),
                    fell_back,
                    spent_usd,
                );
                match decision {
                    Decision::UseFallback(next) if !cancel.is_cancelled() => {
                        publisher.switched(&target, &next, kind);
                        number += 1;
                        live_attempt.store(number, Ordering::SeqCst);
                        target = next;
                        fell_back = true;
                    }
                    _ => {
                        publisher.error(&message);
                        return Err(message);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::model::Strategy;

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<String>>,
    }
    impl Recorder {
        fn log(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }
    }
    impl Publisher for Recorder {
        fn token(&self, text: &str) {
            self.events.lock().unwrap().push(format!("token:{text}"));
        }
        fn end(&self, tokens: u64, _: u64) {
            self.events.lock().unwrap().push(format!("end:{tokens}"));
        }
        fn error(&self, message: &str) {
            self.events.lock().unwrap().push(format!("error:{message}"));
        }
        fn switched(&self, from: &ModelRef, to: &ModelRef, _: FailureKind) {
            self.events.lock().unwrap().push(format!("switch:{}->{}", from.provider, to.provider));
        }
    }

    fn policy(consent: Option<&str>) -> RoutingPolicy {
        RoutingPolicy {
            primary: ModelRef::new("openai", "p"),
            fallback: Some(ModelRef::new("gemini", "f")),
            consent_provider: consent.map(str::to_string),
            automatic: true,
            strategy: Strategy::Balanced,
            max_response_ms: 20_000,
            allow_paid_fallback: true,
            spend_limit_usd: None,
        }
    }

    fn stats(tokens: u64) -> CompletionStats {
        CompletionStats { prompt_tokens: 1, completion_tokens: tokens, total_tokens: tokens, latency_ms: 5 }
    }

    async fn drive(
        policy: &RoutingPolicy,
        publisher: Arc<Recorder>,
        calls: Arc<Mutex<Vec<String>>>,
        script: impl Fn(&ModelRef, &TokenSink) -> Result<CompletionStats, LLMError> + Clone,
    ) -> Result<(), String> {
        let book = Mutex::new(LatencyBook::default());
        let cancel = CancelToken::new();
        run(policy, &book, 0.0, publisher, &cancel, move |who, sink| {
            calls.lock().unwrap().push(who.provider.clone());
            let result = script(&who, &sink);
            async move { result }
        })
        .await
    }

    #[tokio::test]
    async fn a_rate_limited_primary_falls_back_once_and_publishes_one_answer() {
        let rec = Arc::new(Recorder::default());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let out = drive(&policy(Some("gemini")), rec.clone(), calls.clone(), |who, sink| {
            if who.provider == "openai" {
                Err(LLMError::ProviderError("HTTP 429 rate limit".into()))
            } else {
                sink("Fallback ");
                sink("answer");
                Ok(stats(2))
            }
        })
        .await;
        assert!(out.is_ok());
        assert_eq!(*calls.lock().unwrap(), ["openai", "gemini"]);
        assert_eq!(rec.log(), ["switch:openai->gemini", "token:Fallback ", "token:answer", "end:2"]);
    }

    #[tokio::test]
    async fn without_consent_the_fallback_provider_is_never_contacted() {
        let rec = Arc::new(Recorder::default());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let out = drive(&policy(None), rec.clone(), calls.clone(), |_, _| {
            Err(LLMError::ProviderError("503 unavailable".into()))
        })
        .await;
        assert!(out.is_err());
        assert_eq!(*calls.lock().unwrap(), ["openai"]);
        assert_eq!(rec.log().len(), 1);
        assert!(rec.log()[0].starts_with("error:"));
    }

    #[tokio::test]
    async fn a_failure_after_text_started_is_reported_not_replaced_by_a_second_answer() {
        let rec = Arc::new(Recorder::default());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let out = drive(&policy(Some("gemini")), rec.clone(), calls.clone(), |_, sink| {
            sink("Partial");
            Err(LLMError::ProviderError("connection dropped (timeout)".into()))
        })
        .await;
        assert!(out.is_err());
        assert_eq!(*calls.lock().unwrap(), ["openai"]);
        assert_eq!(rec.log()[0], "token:Partial");
        assert!(rec.log()[1].starts_with("error:"));
    }

    #[tokio::test]
    async fn a_second_failure_ends_the_request_instead_of_looping() {
        let rec = Arc::new(Recorder::default());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let out = drive(&policy(Some("gemini")), rec.clone(), calls.clone(), |_, _| {
            Err(LLMError::ProviderError("503 unavailable".into()))
        })
        .await;
        assert!(out.is_err());
        assert_eq!(*calls.lock().unwrap(), ["openai", "gemini"]);
        assert_eq!(rec.log().iter().filter(|e| e.starts_with("error:")).count(), 1);
    }

    #[tokio::test]
    async fn a_stalled_late_primary_cannot_publish_after_the_switch() {
        // The superseded attempt keeps a sink; its late tokens must be dropped.
        let rec = Arc::new(Recorder::default());
        let late: Arc<Mutex<Option<TokenSink>>> = Arc::new(Mutex::new(None));
        let late2 = late.clone();
        let calls = Arc::new(Mutex::new(Vec::new()));
        drive(&policy(Some("gemini")), rec.clone(), calls, move |who, sink| {
            if who.provider == "openai" {
                *late2.lock().unwrap() = Some(sink.clone());
                Err(LLMError::ProviderError("request timed out".into()))
            } else {
                sink("fallback");
                Ok(stats(1))
            }
        })
        .await
        .unwrap();
        (late.lock().unwrap().as_ref().unwrap())("STALE");
        assert!(!rec.log().iter().any(|e| e.contains("STALE")));
    }

    #[tokio::test]
    async fn success_is_measured_and_cancellation_is_not_an_error() {
        let rec = Arc::new(Recorder::default());
        let book = Mutex::new(LatencyBook::default());
        let cancel = CancelToken::new();
        let p = policy(Some("gemini"));
        run(&p, &book, 0.0, rec.clone(), &cancel, |_, sink| async move {
            sink("hi");
            Ok(stats(1))
        })
        .await
        .unwrap();
        assert!(book.lock().unwrap().median_first_token_ms(&p.primary).is_some());

        cancel.cancel();
        let rec2 = Arc::new(Recorder::default());
        let out = run(&p, &book, 0.0, rec2.clone(), &cancel, |_, _| async { Err(LLMError::Cancelled) }).await;
        assert!(out.is_ok() && rec2.log().is_empty());
    }
}
