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
    choose_for_request, classify_kind, decide_after_failure, Decision, FailureKind, LatencyBook, ModelRef,
    RoutingPolicy,
};
use crate::llm::provider::{
    CancelToken, CompletionStats, LLMError, MetadataSink, StreamEndPayload,
    StreamMetadata, StreamUsage, TokenSink,
};

pub trait Publisher: Send + Sync {
    fn token(&self, text: &str);
    fn end(&self, tokens: u64, latency_ms: u64);
    fn error(&self, message: &str);
    /// The request moved to another provider (for a visible notice).
    fn switched(&self, from: &ModelRef, to: &ModelRef, reason: FailureKind);
    /// Existing publishers may ignore optional metadata, but retain completion.
    fn metadata(&self, event: &StreamMetadata) {
        if let StreamMetadata::End(payload) = event {
            self.end(payload.total_tokens, payload.latency_ms);
        }
    }
    fn classified_error(&self, error: &LLMError) {
        self.error(&error.safe_message());
    }
}

pub(crate) fn now_ms() -> u64 {
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
    fn classified_error(&self, error: &LLMError) {
        crate::llm::provider::emit_llm_error(&self.app, &self.params, error);
    }
    fn metadata(&self, event: &StreamMetadata) {
        use crate::llm::provider;
        match event {
            StreamMetadata::Thinking => provider::emit_thinking(&self.app, &self.params),
            StreamMetadata::Sources(sources) => provider::emit_sources(&self.app, &self.params, sources.clone()),
            StreamMetadata::End(payload) => provider::emit_end_with_usage(
                &self.app, &self.params, payload.total_tokens, payload.latency_ms, payload.usage.clone(),
            ),
            // Attempt errors must go through the final routing decision.
            StreamMetadata::Error(_) => {}
        }
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
    run_with_metadata(policy, book, spent_usd, publisher, cancel,
        |who, sink, _| attempt(who, sink)).await
}

/// The same health/consent policy as `run`, also retaining provider metadata.
/// Thinking is live (once per request); sources/end are committed only for
/// the successful attempt. All callbacks are invalidated when it finishes.
pub async fn run_with_metadata<F, Fut>(
    policy: &RoutingPolicy,
    book: &Mutex<LatencyBook>,
    spent_usd: f64,
    publisher: Arc<dyn Publisher>,
    cancel: &CancelToken,
    mut attempt: F,
) -> Result<(), String>
where
    F: FnMut(ModelRef, TokenSink, MetadataSink) -> Fut,
    Fut: Future<Output = Result<CompletionStats, LLMError>>,
{
    let (mut target, initial_reason) = {
        let book = book.lock().map_err(|e| e.to_string())?;
        match choose_for_request(policy, &book, spent_usd, now_ms()) {
            Decision::UseFallback(fb) => {
                let reason = if book.credits_exhausted(&policy.primary.provider) {
                    FailureKind::CreditsExhausted
                } else {
                    book.last_failure(&policy.primary).unwrap_or(FailureKind::Other)
                };
                (fb, reason)
            }
            Decision::Blocked(_) => {
                let error = LLMError::classified(
                    crate::llm::provider::LLMFailureKind::CreditsExhausted, &policy.primary.provider,
                );
                publisher.classified_error(&error);
                return Err(error.safe_message());
            }
            Decision::UsePrimary => (policy.primary.clone(), FailureKind::Other),
        }
    };
    let mut fell_back = target != policy.primary;
    if fell_back {
        publisher.switched(&policy.primary, &target, initial_reason);
    }
    // Only the attempt whose number equals this may publish.
    let live_attempt = Arc::new(AtomicU64::new(1));
    let thinking_sent = Arc::new(AtomicBool::new(false));
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

        let pending_metadata = Arc::new(Mutex::new(Vec::new()));
        let metadata = {
            let (publisher, live, pending, thinking) = (
                publisher.clone(), live_attempt.clone(), pending_metadata.clone(), thinking_sent.clone(),
            );
            let mine = number;
            MetadataSink::new(move |event| {
                if live.load(Ordering::SeqCst) != mine { return; }
                match event {
                    StreamMetadata::Thinking => {
                        if !thinking.swap(true, Ordering::SeqCst) {
                            publisher.metadata(&StreamMetadata::Thinking);
                        }
                    }
                    StreamMetadata::Sources(_) | StreamMetadata::End(_) => {
                        match pending.lock() {
                            Ok(mut pending) => pending.push(event),
                            Err(error) => log::error!("Routed response metadata unavailable: {error}"),
                        }
                    }
                    // The returned LLMError, not an attempt's global event,
                    // determines whether this is a terminal failure.
                    StreamMetadata::Error(_) => {}
                }
            })
        };
        let result = attempt(target.clone(), sink, metadata).await;
        live_attempt.store(0, Ordering::SeqCst);
        match result {
            Ok(_) if cancel.is_cancelled() => return Ok(()),
            Ok(stats) => {
                book.lock().map_err(|error| {
                    log::error!("Cannot update provider health: {error}");
                    publisher.error("Provider health state unavailable. Restart NexQ.");
                    "Provider health state unavailable. Restart NexQ.".to_string()
                })?.record_success(&target, first_token_ms.load(Ordering::SeqCst), stats.latency_ms);
                let mut end = StreamEndPayload {
                    total_tokens: stats.total_tokens,
                    latency_ms: stats.latency_ms,
                    request_id: None, // TauriPublisher retains its own request id.
                    cancelled: false,
                    usage: StreamUsage::from_stats(&stats),
                };
                if let Ok(pending) = pending_metadata.lock() {
                    for event in pending.iter() {
                        match event {
                            StreamMetadata::Sources(_) => publisher.metadata(event),
                            StreamMetadata::End(payload) => {
                                end.usage = payload.usage.clone();
                                end.request_id = payload.request_id.clone();
                            }
                            _ => {}
                        }
                    }
                } else {
                    log::error!("Cannot preserve routed response metadata: state lock poisoned");
                }
                publisher.metadata(&StreamMetadata::End(end));
                return Ok(());
            }
            Err(LLMError::Cancelled) => return Ok(()),
            Err(_) if cancel.is_cancelled() => return Ok(()),
            Err(error) => {
                let message = error.to_string();
                let kind = classify_kind(error.kind());
                let decision = {
                    let mut book = book.lock().map_err(|error| {
                        log::error!("Cannot update provider health: {error}");
                        publisher.error("Provider health state unavailable. Restart NexQ.");
                        "Provider health state unavailable. Restart NexQ.".to_string()
                    })?;
                    book.record_failure(&target, kind, now_ms());
                    match decide_after_failure(
                        policy, kind, started.load(Ordering::SeqCst), fell_back, spent_usd,
                    ) {
                        Decision::UseFallback(next) if book.credits_exhausted(&next.provider) =>
                            Decision::Blocked(super::routing::BlockReason::CreditsExhausted),
                        decision => decision,
                    }
                };
                match decision {
                    Decision::UseFallback(next) if !cancel.is_cancelled() => {
                        publisher.switched(&target, &next, kind);
                        number += 1;
                        live_attempt.store(number, Ordering::SeqCst);
                        target = next;
                        fell_back = true;
                    }
                    _ => {
                        publisher.classified_error(&error);
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

    #[derive(Default)]
    struct MetadataRecorder {
        events: Mutex<Vec<String>>,
        usage: Mutex<Option<crate::llm::provider::StreamUsage>>,
        request_id: Mutex<Option<String>>,
        error_code: Mutex<Option<crate::llm::provider::LLMFailureKind>>,
    }

    impl Publisher for MetadataRecorder {
        fn token(&self, text: &str) { self.events.lock().unwrap().push(format!("token:{text}")); }
        fn end(&self, tokens: u64, _: u64) { self.events.lock().unwrap().push(format!("end:{tokens}")); }
        fn error(&self, _: &str) { self.events.lock().unwrap().push("error".into()); }
        fn switched(&self, _: &ModelRef, _: &ModelRef, _: FailureKind) { self.events.lock().unwrap().push("switch".into()); }
        fn metadata(&self, event: &crate::llm::provider::StreamMetadata) {
            use crate::llm::provider::StreamMetadata;
            match event {
                StreamMetadata::Thinking => self.events.lock().unwrap().push("thinking".into()),
                StreamMetadata::Sources(sources) => {
                    for source in sources { self.events.lock().unwrap().push(format!("source:{}", source.title)); }
                }
                StreamMetadata::End(payload) => {
                    *self.usage.lock().unwrap() = payload.usage.clone();
                    *self.request_id.lock().unwrap() = payload.request_id.clone();
                    self.end(payload.total_tokens, payload.latency_ms);
                }
                StreamMetadata::Error(_) => panic!("attempt errors must not be published directly"),
            }
        }
        fn classified_error(&self, error: &LLMError) {
            *self.error_code.lock().unwrap() = Some(error.kind());
            self.error(&error.safe_message());
        }
    }

    fn end_metadata(input: u64, output: u64) -> crate::llm::provider::StreamMetadata {
        use crate::llm::provider::{StreamEndPayload, StreamMetadata, StreamUsage};
        StreamMetadata::End(StreamEndPayload {
            total_tokens: input + output, latency_ms: 5, request_id: Some("public-request".into()),
            cancelled: false, usage: Some(StreamUsage { input_tokens: input, output_tokens: output,
                cache_read_tokens: 30, thinking_tokens: 1, ..Default::default() }),
        })
    }

    #[tokio::test]
    async fn no_fallback_route_preserves_sources_thinking_and_usage_with_one_end() {
        use crate::llm::provider::{StreamMetadata, StreamSource};
        let mut p = policy(None);
        p.fallback = None;
        p.automatic = false;
        let rec = Arc::new(MetadataRecorder::default());
        run_with_metadata(&p, &Mutex::new(LatencyBook::default()), 0.0, rec.clone(), &CancelToken::new(),
            |_, sink, metadata| async move {
                metadata.emit(StreamMetadata::Thinking);
                sink("public answer");
                metadata.emit(StreamMetadata::Sources(vec![StreamSource { title: "public source".into(), url: "https://example.com".into() }]));
                metadata.emit(end_metadata(10, 2));
                Ok(stats(12))
            }).await.unwrap();
        assert_eq!(*rec.events.lock().unwrap(), ["thinking", "token:public answer", "source:public source", "end:12"]);
        let usage = rec.usage.lock().unwrap().clone().unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.thinking_tokens), (10, 2, 30, 1));
        assert_eq!(rec.request_id.lock().unwrap().as_deref(), Some("public-request"));
    }

    #[tokio::test]
    async fn fallback_discards_failed_and_late_primary_metadata() {
        use crate::llm::provider::{GenerationParams, LLMFailureKind, MetadataSink, StreamErrorPayload, StreamMetadata, StreamSource};
        let rec = Arc::new(MetadataRecorder::default());
        let late: Arc<Mutex<Option<MetadataSink>>> = Arc::new(Mutex::new(None));
        let retained = late.clone();
        run_with_metadata(&policy(Some("gemini")), &Mutex::new(LatencyBook::default()), 0.0, rec.clone(), &CancelToken::new(),
            move |who, sink, metadata| {
                let retained = retained.clone();
                async move {
                    metadata.emit(StreamMetadata::Thinking);
                    if who.provider == "openai" {
                        *retained.lock().unwrap() = Some(metadata.clone());
                        metadata.emit(StreamMetadata::Sources(vec![StreamSource { title: "failed primary".into(), url: "https://example.com/failed".into() }]));
                        metadata.emit(end_metadata(99, 99));
                        let error = LLMError::classified(LLMFailureKind::Timeout, "openai");
                        metadata.emit(StreamMetadata::Error(StreamErrorPayload::from_error(&GenerationParams::default(), &error)));
                        Err(error)
                    } else {
                        sink("fallback answer");
                        metadata.emit(StreamMetadata::Sources(vec![StreamSource { title: "fallback source".into(), url: "https://example.com/fallback".into() }]));
                        metadata.emit(end_metadata(20, 3));
                        Ok(stats(23))
                    }
                }
            }).await.unwrap();
        late.lock().unwrap().as_ref().unwrap().emit(end_metadata(100, 100));
        assert_eq!(*rec.events.lock().unwrap(), ["thinking", "switch", "token:fallback answer", "source:fallback source", "end:23"]);
        assert_eq!(rec.usage.lock().unwrap().as_ref().unwrap().input_tokens, 20);
        assert!(rec.error_code.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn final_error_keeps_classification_and_never_publishes_attempt_end() {
        use crate::llm::provider::LLMFailureKind;
        let rec = Arc::new(MetadataRecorder::default());
        let result = run_with_metadata(&policy(None), &Mutex::new(LatencyBook::default()), 0.0, rec.clone(), &CancelToken::new(),
            |_, _, metadata| async move {
                metadata.emit(end_metadata(1, 1));
                Err(LLMError::classified(LLMFailureKind::InvalidApiKey, "openai"))
            }).await;
        assert!(result.is_err());
        assert_eq!(*rec.error_code.lock().unwrap(), Some(LLMFailureKind::InvalidApiKey));
        assert_eq!(*rec.events.lock().unwrap(), ["error"]);
    }

    #[tokio::test]
    async fn cancelled_success_discards_sources_and_end() {
        use crate::llm::provider::{StreamMetadata, StreamSource};
        let rec = Arc::new(MetadataRecorder::default());
        let cancel = CancelToken::new();
        run_with_metadata(&policy(None), &Mutex::new(LatencyBook::default()), 0.0, rec.clone(), &cancel,
            |_, _, metadata| {
                metadata.emit(StreamMetadata::Sources(vec![StreamSource { title: "cancelled source".into(), url: "https://example.com".into() }]));
                metadata.emit(end_metadata(1, 1));
                cancel.cancel();
                async { Ok(stats(2)) }
            }).await.unwrap();
        assert!(rec.events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_completed_attempt_cannot_publish_late_tokens() {
        let rec = Arc::new(MetadataRecorder::default());
        let late: Arc<Mutex<Option<TokenSink>>> = Arc::new(Mutex::new(None));
        let retained = late.clone();
        run_with_metadata(&policy(None), &Mutex::new(LatencyBook::default()), 0.0, rec.clone(), &CancelToken::new(),
            move |_, sink, metadata| {
                *retained.lock().unwrap() = Some(sink);
                metadata.emit(end_metadata(1, 1));
                async { Ok(stats(2)) }
            }).await.unwrap();
        late.lock().unwrap().as_ref().unwrap()("late token");
        assert_eq!(*rec.events.lock().unwrap(), ["end:2"]);
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
    async fn exhausted_credit_is_blocked_on_subsequent_requests_without_contacting_a_provider() {
        let rec = Arc::new(Recorder::default());
        let book = Mutex::new(LatencyBook::default());
        let cancel = CancelToken::new();
        let p = policy(None);
        book.lock().unwrap().record_failure(&p.primary, FailureKind::CreditsExhausted, 0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let calls2 = calls.clone();
        let result = run(&p, &book, 0.0, rec.clone(), &cancel, move |who, _| {
            calls2.lock().unwrap().push(who.provider);
            async { Ok(stats(1)) }
        }).await;
        assert!(result.is_err());
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(rec.log().len(), 1);
        assert!(rec.log()[0].contains("credits"));
    }

    #[tokio::test]
    async fn preflight_fallback_is_announced_and_exhausted_fallback_is_never_contacted() {
        let p = policy(Some("gemini"));
        let book = Mutex::new(LatencyBook::default());
        let cancel = CancelToken::new();
        book.lock().unwrap().record_failure(&p.primary, FailureKind::CreditsExhausted, 0);
        let rec = Arc::new(Recorder::default());
        run(&p, &book, 0.0, rec.clone(), &cancel, |who, sink| async move {
            assert_eq!(who.provider, "gemini");
            sink("answer");
            Ok(stats(1))
        }).await.unwrap();
        assert_eq!(rec.log(), ["switch:openai->gemini", "token:answer", "end:1"]);

        book.lock().unwrap().clear_credit_failure("openai");
        book.lock().unwrap().record_failure(p.fallback.as_ref().unwrap(), FailureKind::CreditsExhausted, 0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let calls2 = calls.clone();
        let result = run(&p, &book, 0.0, Arc::new(Recorder::default()), &cancel, move |who, _| {
            calls2.lock().unwrap().push(who.provider);
            async { Err(LLMError::classified(crate::llm::provider::LLMFailureKind::Timeout, "openai")) }
        }).await;
        assert!(result.is_err());
        assert_eq!(*calls.lock().unwrap(), ["openai"]);
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
