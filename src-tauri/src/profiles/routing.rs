//! Per-meeting provider selection and fallback policy.
//!
//! Pure decision logic, kept separate from I/O so it can be tested without
//! network access. Principles:
//! * the user's primary provider is always tried first;
//! * a different provider only ever receives the meeting's private context if
//!   the user named it as the consented fallback;
//! * a paid fallback needs explicit permission and respects a spend cap;
//! * speed claims come from measured latency, never from assumptions;
//! * output that has already started streaming is never replaced (no duplicates).

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use super::model::{AiSettings, Strategy};

const SAMPLE_WINDOW: usize = 12;
const MIN_SAMPLES_TO_COMPARE: usize = 3;
const RATE_LIMIT_COOLDOWN_MS: u64 = 60_000;
const LOCAL_PROVIDERS: &[&str] = &["ollama"];

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
}

impl ModelRef {
    pub fn new(provider: &str, model: &str) -> Self {
        Self { provider: provider.to_string(), model: model.to_string() }
    }
    fn is_local(&self) -> bool {
        LOCAL_PROVIDERS.contains(&self.provider.to_lowercase().as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Unavailable,
    RateLimited,
    Timeout,
    Auth,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum BlockReason {
    NoFallbackConfigured,
    AutomaticFallbackOff,
    ConsentMissing(String),
    PaidFallbackNotAllowed,
    SpendLimitReached,
    OutputAlreadyStarted,
    AlreadyFellBack,
    NotRetryable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum Decision {
    UsePrimary,
    UseFallback(ModelRef),
    /// Stay on the primary (or report the failure) for the given reason.
    Blocked(BlockReason),
}

#[derive(Debug, Clone)]
pub struct RoutingPolicy {
    pub primary: ModelRef,
    pub fallback: Option<ModelRef>,
    pub consent_provider: Option<String>,
    pub automatic: bool,
    pub strategy: Strategy,
    pub max_response_ms: u64,
    pub allow_paid_fallback: bool,
    pub spend_limit_usd: Option<f64>,
}

impl RoutingPolicy {
    /// `None` when the meeting has no primary provider/model chosen.
    pub fn from_settings(ai: &AiSettings) -> Option<Self> {
        let primary = ModelRef::new(ai.primary_provider.as_deref()?, ai.primary_model.as_deref()?);
        let fallback = match (&ai.fallback_provider, &ai.fallback_model) {
            (Some(p), Some(m)) if !p.is_empty() && !m.is_empty() => Some(ModelRef::new(p, m)),
            _ => None,
        };
        Some(Self {
            primary,
            fallback,
            consent_provider: ai.fallback_consent_provider.clone(),
            automatic: ai.automatic_fallback,
            strategy: ai.strategy,
            max_response_ms: u64::from(ai.max_response_seconds) * 1000,
            allow_paid_fallback: ai.allow_paid_fallback,
            spend_limit_usd: ai.spend_limit_usd,
        })
    }

    /// Whether the fallback may legitimately receive this meeting's context.
    fn fallback_allowed(&self, spent_usd: f64) -> Result<&ModelRef, BlockReason> {
        let fb = self.fallback.as_ref().ok_or(BlockReason::NoFallbackConfigured)?;
        if !self.automatic {
            return Err(BlockReason::AutomaticFallbackOff);
        }
        if fb.provider != self.primary.provider && !fb.is_local() {
            let consented = self
                .consent_provider
                .as_deref()
                .is_some_and(|c| c.eq_ignore_ascii_case(&fb.provider));
            if !consented {
                return Err(BlockReason::ConsentMissing(fb.provider.clone()));
            }
            if !self.allow_paid_fallback {
                return Err(BlockReason::PaidFallbackNotAllowed);
            }
        }
        if self.spend_limit_usd.is_some_and(|limit| spent_usd >= limit) {
            return Err(BlockReason::SpendLimitReached);
        }
        Ok(fb)
    }
}

#[derive(Debug, Default, Clone)]
struct Stats {
    first_token_ms: VecDeque<u64>,
    total_ms: VecDeque<u64>,
    consecutive_failures: u32,
    rate_limited_until_ms: u64,
}

fn push(window: &mut VecDeque<u64>, v: u64) {
    if window.len() == SAMPLE_WINDOW {
        window.pop_front();
    }
    window.push_back(v);
}

fn median(window: &VecDeque<u64>) -> Option<u64> {
    if window.is_empty() {
        return None;
    }
    let mut v: Vec<u64> = window.iter().copied().collect();
    v.sort_unstable();
    Some(v[v.len() / 2])
}

/// Measured behaviour of each provider/model during this app session.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LatencySnapshot {
    pub provider: String,
    pub model: String,
    pub samples: usize,
    pub median_first_token_ms: Option<u64>,
    pub median_total_ms: Option<u64>,
    pub consecutive_failures: u32,
}

/// Measured behaviour of each provider/model during this app session.
#[derive(Debug, Default, Clone)]
pub struct LatencyBook {
    stats: HashMap<ModelRef, Stats>,
}

impl LatencyBook {
    pub fn record_success(&mut self, who: &ModelRef, first_token_ms: u64, total_ms: u64) {
        let s = self.stats.entry(who.clone()).or_default();
        push(&mut s.first_token_ms, first_token_ms);
        push(&mut s.total_ms, total_ms);
        s.consecutive_failures = 0;
    }

    pub fn record_failure(&mut self, who: &ModelRef, kind: FailureKind, now_ms: u64) {
        let s = self.stats.entry(who.clone()).or_default();
        s.consecutive_failures += 1;
        if kind == FailureKind::RateLimited {
            s.rate_limited_until_ms = now_ms + RATE_LIMIT_COOLDOWN_MS;
        }
    }

    pub fn median_first_token_ms(&self, who: &ModelRef) -> Option<u64> {
        self.stats.get(who).and_then(|s| median(&s.first_token_ms))
    }

    pub fn median_total_ms(&self, who: &ModelRef) -> Option<u64> {
        self.stats.get(who).and_then(|s| median(&s.total_ms))
    }

    fn samples(&self, who: &ModelRef) -> usize {
        self.stats.get(who).map_or(0, |s| s.first_token_ms.len())
    }

    /// Measured numbers for display (live results only; empty until requests ran).
    pub fn snapshot(&self) -> Vec<LatencySnapshot> {
        let mut out: Vec<_> = self
            .stats
            .iter()
            .map(|(who, s)| LatencySnapshot {
                provider: who.provider.clone(),
                model: who.model.clone(),
                samples: s.first_token_ms.len(),
                median_first_token_ms: median(&s.first_token_ms),
                median_total_ms: median(&s.total_ms),
                consecutive_failures: s.consecutive_failures,
            })
            .collect();
        out.sort_by(|a, b| (&a.provider, &a.model).cmp(&(&b.provider, &b.model)));
        out
    }

    fn degraded(&self, who: &ModelRef, now_ms: u64, max_response_ms: u64) -> bool {
        self.stats.get(who).is_some_and(|s| {
            s.rate_limited_until_ms > now_ms
                || s.consecutive_failures >= 2
                || median(&s.total_ms).is_some_and(|m| m > max_response_ms)
        })
    }
}

/// Which model should serve the next request.
pub fn choose_for_request(
    policy: &RoutingPolicy,
    book: &LatencyBook,
    spent_usd: f64,
    now_ms: u64,
) -> Decision {
    let fallback = match policy.fallback_allowed(spent_usd) {
        Ok(fb) => fb,
        Err(_) => return Decision::UsePrimary,
    };
    if book.degraded(&policy.primary, now_ms, policy.max_response_ms)
        && !book.degraded(fallback, now_ms, policy.max_response_ms)
    {
        // BEST ANSWER stays on the primary unless it is outright unavailable.
        let unavailable = book
            .stats
            .get(&policy.primary)
            .is_some_and(|s| s.rate_limited_until_ms > now_ms || s.consecutive_failures >= 2);
        if policy.strategy != Strategy::Best || unavailable {
            return Decision::UseFallback(fallback.clone());
        }
    }
    if policy.strategy == Strategy::Fast
        && book.samples(&policy.primary) >= MIN_SAMPLES_TO_COMPARE
        && book.samples(fallback) >= MIN_SAMPLES_TO_COMPARE
    {
        let (p, f) = (
            book.median_first_token_ms(&policy.primary),
            book.median_first_token_ms(fallback),
        );
        if let (Some(p), Some(f)) = (p, f) {
            // Only a clearly (>= 30%) faster measured fallback justifies leaving the primary.
            if f * 10 <= p * 7 {
                return Decision::UseFallback(fallback.clone());
            }
        }
    }
    Decision::UsePrimary
}

/// What to do after a request failed.
pub fn decide_after_failure(
    policy: &RoutingPolicy,
    kind: FailureKind,
    output_started: bool,
    already_fell_back: bool,
    spent_usd: f64,
) -> Decision {
    if already_fell_back {
        return Decision::Blocked(BlockReason::AlreadyFellBack);
    }
    if output_started {
        return Decision::Blocked(BlockReason::OutputAlreadyStarted);
    }
    if kind == FailureKind::Other {
        return Decision::Blocked(BlockReason::NotRetryable);
    }
    match policy.fallback_allowed(spent_usd) {
        Ok(fb) => Decision::UseFallback(fb.clone()),
        Err(reason) => Decision::Blocked(reason),
    }
}

/// Maps an LLM error message to a failure class.
pub fn classify_failure(message: &str) -> FailureKind {
    let m = message.to_lowercase();
    if m.contains("429") || m.contains("rate limit") || m.contains("quota") || m.contains("too many requests") {
        FailureKind::RateLimited
    } else if m.contains("timed out") || m.contains("timeout") {
        FailureKind::Timeout
    } else if m.contains("401") || m.contains("403") || m.contains("api key") || m.contains("unauthor") {
        FailureKind::Auth
    } else if m.contains("503") || m.contains("502") || m.contains("500") || m.contains("unavailable")
        || m.contains("connect") || m.contains("dns") || m.contains("overloaded")
    {
        FailureKind::Unavailable
    } else {
        FailureKind::Other
    }
}

/// Guarantees only the newest request may publish output, so a superseded
/// request (or a fallback racing a slow primary) can never show a duplicate answer.
#[derive(Debug, Default)]
pub struct RequestGate {
    current: Option<String>,
    cancelled: Vec<String>,
}

impl RequestGate {
    /// Starts `id`; returns the request it supersedes (to be cancelled), if any.
    pub fn begin(&mut self, id: &str) -> Option<String> {
        let previous = self.current.replace(id.to_string());
        if let Some(prev) = &previous {
            self.cancelled.push(prev.clone());
        }
        previous
    }

    pub fn may_publish(&self, id: &str) -> bool {
        self.current.as_deref() == Some(id)
    }

    pub fn finish(&mut self, id: &str) {
        if self.current.as_deref() == Some(id) {
            self.current = None;
        }
    }

    pub fn was_cancelled(&self, id: &str) -> bool {
        self.cancelled.iter().any(|c| c == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(strategy: Strategy) -> RoutingPolicy {
        RoutingPolicy {
            primary: ModelRef::new("openai", "gpt-primary"),
            fallback: Some(ModelRef::new("gemini", "gemini-fast")),
            consent_provider: Some("gemini".into()),
            automatic: true,
            strategy,
            max_response_ms: 20_000,
            allow_paid_fallback: true,
            spend_limit_usd: None,
        }
    }

    fn warmed(book: &mut LatencyBook, who: &ModelRef, ttft: u64, n: usize) {
        for _ in 0..n {
            book.record_success(who, ttft, ttft * 3);
        }
    }

    #[test]
    fn private_context_never_goes_to_an_unconsented_provider() {
        let mut p = policy(Strategy::Balanced);
        p.consent_provider = None;
        assert_eq!(
            decide_after_failure(&p, FailureKind::RateLimited, false, false, 0.0),
            Decision::Blocked(BlockReason::ConsentMissing("gemini".into()))
        );
        p.consent_provider = Some("openrouter".into());
        assert!(matches!(
            decide_after_failure(&p, FailureKind::Unavailable, false, false, 0.0),
            Decision::Blocked(BlockReason::ConsentMissing(_))
        ));
        // Consent for the named provider is case-insensitive and enables the switch.
        p.consent_provider = Some("Gemini".into());
        assert_eq!(
            decide_after_failure(&p, FailureKind::Unavailable, false, false, 0.0),
            Decision::UseFallback(ModelRef::new("gemini", "gemini-fast"))
        );
    }

    #[test]
    fn fallback_respects_the_switch_paid_permission_and_spend_cap() {
        let mut p = policy(Strategy::Balanced);
        p.automatic = false;
        assert_eq!(
            decide_after_failure(&p, FailureKind::Timeout, false, false, 0.0),
            Decision::Blocked(BlockReason::AutomaticFallbackOff)
        );
        p.automatic = true;
        p.allow_paid_fallback = false;
        assert_eq!(
            decide_after_failure(&p, FailureKind::Timeout, false, false, 0.0),
            Decision::Blocked(BlockReason::PaidFallbackNotAllowed)
        );
        p.allow_paid_fallback = true;
        p.spend_limit_usd = Some(1.0);
        assert_eq!(
            decide_after_failure(&p, FailureKind::Timeout, false, false, 1.0),
            Decision::Blocked(BlockReason::SpendLimitReached)
        );
        assert!(matches!(
            decide_after_failure(&p, FailureKind::Timeout, false, false, 0.5),
            Decision::UseFallback(_)
        ));
    }

    #[test]
    fn a_local_fallback_needs_neither_consent_nor_paid_permission() {
        let mut p = policy(Strategy::Balanced);
        p.fallback = Some(ModelRef::new("ollama", "llama"));
        p.consent_provider = None;
        p.allow_paid_fallback = false;
        assert_eq!(
            decide_after_failure(&p, FailureKind::Unavailable, false, false, 0.0),
            Decision::UseFallback(ModelRef::new("ollama", "llama"))
        );
    }

    #[test]
    fn no_switch_after_output_started_after_one_fallback_or_for_unrelated_errors() {
        let p = policy(Strategy::Balanced);
        assert_eq!(
            decide_after_failure(&p, FailureKind::Timeout, true, false, 0.0),
            Decision::Blocked(BlockReason::OutputAlreadyStarted)
        );
        assert_eq!(
            decide_after_failure(&p, FailureKind::Timeout, false, true, 0.0),
            Decision::Blocked(BlockReason::AlreadyFellBack)
        );
        assert_eq!(
            decide_after_failure(&p, FailureKind::Other, false, false, 0.0),
            Decision::Blocked(BlockReason::NotRetryable)
        );
    }

    #[test]
    fn balanced_switches_only_when_the_primary_is_measured_to_be_degraded() {
        let p = policy(Strategy::Balanced);
        let mut book = LatencyBook::default();
        assert_eq!(choose_for_request(&p, &book, 0.0, 0), Decision::UsePrimary);
        book.record_failure(&p.primary, FailureKind::RateLimited, 1_000);
        // Rate-limited: switch during the cool-down, return afterwards.
        assert!(matches!(choose_for_request(&p, &book, 0.0, 2_000), Decision::UseFallback(_)));
        assert_eq!(choose_for_request(&p, &book, 0.0, 1_000 + RATE_LIMIT_COOLDOWN_MS + 1), Decision::UsePrimary);
        // Slow answers beyond the maximum response time also count as degraded.
        let mut slow = LatencyBook::default();
        for _ in 0..3 {
            slow.record_success(&p.primary, 9_000, 25_000);
        }
        assert!(matches!(choose_for_request(&p, &slow, 0.0, 0), Decision::UseFallback(_)));
    }

    #[test]
    fn fast_uses_measured_latency_and_best_answer_does_not_chase_speed() {
        let mut book = LatencyBook::default();
        let fast = policy(Strategy::Fast);
        warmed(&mut book, &fast.primary, 1_000, 3);
        // Too few fallback samples: no assumption that it is faster.
        assert_eq!(choose_for_request(&fast, &book, 0.0, 0), Decision::UsePrimary);
        warmed(&mut book, fast.fallback.as_ref().unwrap(), 400, 3);
        assert!(matches!(choose_for_request(&fast, &book, 0.0, 0), Decision::UseFallback(_)));
        // Only marginally faster: stay.
        let mut close = LatencyBook::default();
        warmed(&mut close, &fast.primary, 1_000, 3);
        warmed(&mut close, fast.fallback.as_ref().unwrap(), 900, 3);
        assert_eq!(choose_for_request(&fast, &close, 0.0, 0), Decision::UsePrimary);
        // BEST ANSWER ignores the speed advantage.
        assert_eq!(choose_for_request(&policy(Strategy::Best), &book, 0.0, 0), Decision::UsePrimary);
        // ...but not a primary that is rate limited.
        let best = policy(Strategy::Best);
        let mut limited = LatencyBook::default();
        limited.record_failure(&best.primary, FailureKind::RateLimited, 0);
        assert!(matches!(choose_for_request(&best, &limited, 0.0, 1), Decision::UseFallback(_)));
    }

    #[test]
    fn errors_are_classified() {
        assert_eq!(classify_failure("HTTP 429 Too Many Requests"), FailureKind::RateLimited);
        assert_eq!(classify_failure("request timed out"), FailureKind::Timeout);
        assert_eq!(classify_failure("401 invalid API key"), FailureKind::Auth);
        assert_eq!(classify_failure("503 Service Unavailable"), FailureKind::Unavailable);
        assert_eq!(classify_failure("malformed JSON"), FailureKind::Other);
    }

    #[test]
    fn only_the_latest_request_may_publish_and_older_ones_are_cancelled() {
        let mut gate = RequestGate::default();
        assert_eq!(gate.begin("a"), None);
        assert!(gate.may_publish("a"));
        assert_eq!(gate.begin("b"), Some("a".into()));
        assert!(!gate.may_publish("a") && gate.may_publish("b"));
        assert!(gate.was_cancelled("a") && !gate.was_cancelled("b"));
        gate.finish("a");
        assert!(gate.may_publish("b"));
        gate.finish("b");
        assert!(!gate.may_publish("b"));
    }

    #[test]
    fn policy_requires_a_chosen_primary_and_ignores_empty_fallback() {
        assert!(RoutingPolicy::from_settings(&AiSettings::default()).is_none());
        let ai = AiSettings {
            primary_provider: Some("openai".into()),
            primary_model: Some("m".into()),
            fallback_provider: Some(String::new()),
            fallback_model: Some(String::new()),
            ..Default::default()
        };
        assert!(RoutingPolicy::from_settings(&ai).unwrap().fallback.is_none());
    }
}
