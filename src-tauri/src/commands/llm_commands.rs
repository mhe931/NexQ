use std::sync::Arc;
use tauri::{command, AppHandle, State};
use tokio::sync::Mutex as TokioMutex;

use crate::llm::provider::{GenerationParams, LLMFailureKind, LLMProvider, TokenSink};
use crate::llm::{create_provider, LLMRouter, ProviderConfig};
use crate::llm::openrouter_models;
use crate::state::AppState;

/// Resolve the provider for a read-only operation (model listing, connection test).
///
/// A JSON `ProviderConfig` builds a temporary provider and never touches the
/// router; a bare type name must match the currently active provider.
fn resolve_provider(
    llm: &std::sync::Mutex<LLMRouter>,
    provider: &str,
) -> Result<Arc<TokioMutex<Box<dyn LLMProvider>>>, String> {
    if let Ok(config) = serde_json::from_str::<ProviderConfig>(provider) {
        let temp = create_provider(&config).map_err(|e| format!("Failed to create provider: {}", e))?;
        return Ok(Arc::new(TokioMutex::new(temp)));
    }

    let router = llm
        .lock()
        .map_err(|e| format!("Failed to lock LLM router: {}", e))?;
    if !router.active_provider_type().is_some_and(|active| active.as_str().eq_ignore_ascii_case(provider.trim())) {
        return Err("The requested AI provider is not active. Apply its settings before testing.".into());
    }
    router
        .get_provider()
        .map_err(|e| format!("No active provider: {}", e))
}

#[command]
pub async fn set_llm_provider(
    provider: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Parse the provider config from the JSON string, or create a simple one from the provider name
    let config: ProviderConfig = match serde_json::from_str(&provider) {
        Ok(config) => config,
        Err(_) => {
            // Treat the input as just a provider type name
            ProviderConfig {
                provider_type: provider.clone(),
                api_key: None,
                base_url: None,
                auth_type: None,
                auth_value: None,
                auth_header: None,
            }
        }
    };

    let llm = state
        .llm
        .as_ref()
        .ok_or_else(|| "LLM router not initialized".to_string())?;

    let mut router = llm
        .lock()
        .map_err(|e| format!("Failed to lock LLM router: {}", e))?;

    // Log the provider type only: the raw config JSON carries the API key / auth value.
    let provider_type = config.provider_type.clone();
    router
        .set_provider(config)
        .map_err(|e| format!("Failed to set provider: {}", e))?;

    log::info!("LLM provider set to: {}", provider_type);
    Ok(())
}

#[command]
pub async fn list_models(
    provider: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let llm = state
        .llm
        .as_ref()
        .ok_or_else(|| "LLM router not initialized".to_string())?;

    // A JSON config uses a temporary provider; the active provider is never switched.
    let provider_arc = resolve_provider(llm, &provider)?;

    let provider_guard = provider_arc.lock().await;
    let models = provider_guard
        .list_models()
        .await
        .map_err(|e| format!("Failed to list models: {}", e))?;

    serde_json::to_string(&models).map_err(|e| format!("Failed to serialize models: {}", e))
}

#[command]
pub async fn set_active_model(
    _provider: String,
    model_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let llm = state
        .llm
        .as_ref()
        .ok_or_else(|| "LLM router not initialized".to_string())?;

    let mut router = llm
        .lock()
        .map_err(|e| format!("Failed to lock LLM router: {}", e))?;

    router.set_active_model(model_id.clone());
    log::info!("Active model set to: {}", model_id);
    Ok(())
}

#[command]
pub async fn test_llm_connection(
    provider: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let llm = state
        .llm
        .as_ref()
        .ok_or_else(|| "LLM router not initialized".to_string())?;

    // A JSON config uses a temporary provider; the active provider is never switched.
    let provider_arc = resolve_provider(llm, &provider)?;

    let provider_guard = provider_arc.lock().await;
    provider_guard
        .test_connection()
        .await
        .map_err(|e| format!("Connection test failed: {}", e))
}

#[command]
pub async fn clear_provider_credit_failure(
    provider: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.latency_book.lock()
        .map_err(|e| format!("Failed to lock provider health: {e}"))?
        .clear_credit_failure(&provider);
    Ok(())
}

#[command]
pub async fn test_llm_response(
    provider: String,
    model: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if model.trim().is_empty() {
        return Err("Select a model before testing an AI response.".into());
    }
    let llm = state.llm.as_ref().ok_or("LLM router not initialized")?;
    let provider_arc = resolve_provider(llm, &provider)?;
    let config = serde_json::from_str::<ProviderConfig>(&provider).ok();
    let active = config.is_none();
    let provider_id = config.map(|c| c.provider_type).unwrap_or_else(|| provider.trim().to_ascii_lowercase());
    let active_revision = if active {
        let router = llm.lock().map_err(|e| format!("Failed to lock LLM router: {e}"))?;
        if !Arc::ptr_eq(&router.get_provider().map_err(|e| e.safe_message())?, &provider_arc) || router.active_model() != model {
            return Err("Active AI settings changed. Apply the selected model and test again.".into());
        }
        Some(state.latency_book.lock()
            .map_err(|e| format!("Failed to lock provider health: {e}"))?
            .failure_revision(&provider_id))
    } else {
        None
    };
    let response = Arc::new(std::sync::Mutex::new(String::new()));
    let received = response.clone();
    let sink: TokenSink = Arc::new(move |text| {
        match received.lock() {
            Ok(mut response) => response.push_str(text),
            Err(error) => log::error!("AI response test buffer unavailable: {error}"),
        }
    });
    let result = provider_arc.lock().await.stream_completion(
        vec![crate::llm::provider::LLMMessage {
            role: "user".into(),
            content: "Reply with the single word READY. This is a public connectivity test.".into(),
        }],
        &model,
        GenerationParams { silent: true, max_tokens: Some(32), ..Default::default() },
        app,
        Some(sink),
    ).await;
    let who = crate::profiles::routing::ModelRef::new(&provider_id, &model);
    let has_output = !response.lock().map_err(|e| e.to_string())?.trim().is_empty();
    let active_guard = if active {
        Some(llm.lock().map_err(|e| format!("Failed to lock LLM router: {e}"))?)
    } else {
        None
    };
    if let Some(router) = &active_guard {
        if !Arc::ptr_eq(&router.get_provider().map_err(|e| e.safe_message())?, &provider_arc) || router.active_model() != model {
            return Err("Active AI settings changed during the test. Test again.".into());
        }
    }
    finish_response_test(&state.latency_book, &who, active_revision, result.map(|_| ()), has_output)
}

#[command]
pub async fn get_llm_providers() -> Result<String, String> {
    let providers = LLMRouter::get_all_providers();
    serde_json::to_string(&providers)
        .map_err(|e| format!("Failed to serialize providers: {}", e))
}

#[command]
pub async fn list_openrouter_models(
    force_refresh: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Check cache first (unless force refresh)
    if !force_refresh {
        let cache_guard = state
            .openrouter_cache
            .lock()
            .map_err(|e| format!("Failed to lock cache: {}", e))?;
        if let Some(ref cache) = *cache_guard {
            if cache.is_valid() {
                log::info!(
                    "OpenRouter models: returning {} cached models",
                    cache.models.len()
                );
                return serde_json::to_string(&cache.models)
                    .map_err(|e| format!("Failed to serialize: {}", e));
            }
        }
    }

    // Get API key from CredentialManager
    let api_key = {
        let cred_mgr = state
            .credentials
            .as_ref()
            .ok_or_else(|| "Credential manager not initialized".to_string())?;
        let cred = cred_mgr
            .lock()
            .map_err(|e| format!("Failed to lock credential manager: {}", e))?;
        cred.get_key("openrouter")
            .map_err(|e| format!("Failed to get API key: {}", e))?
            .ok_or_else(|| "OpenRouter API key not found. Please enter your API key first.".to_string())?
    };

    // Fetch from API
    let models = openrouter_models::fetch_openrouter_models(&api_key).await?;
    let model_count = models.len();

    // Update cache
    {
        let mut cache_guard = state
            .openrouter_cache
            .lock()
            .map_err(|e| format!("Failed to lock cache: {}", e))?;
        *cache_guard = Some(openrouter_models::OpenRouterModelCache::new(models.clone()));
    }

    log::info!(
        "OpenRouter models: fetched and cached {} models",
        model_count
    );

    serde_json::to_string(&models).map_err(|e| format!("Failed to serialize: {}", e))
}

fn finish_response_test(
    health: &std::sync::Mutex<crate::profiles::routing::LatencyBook>,
    who: &crate::profiles::routing::ModelRef,
    active_revision: Option<u64>,
    result: Result<(), crate::llm::provider::LLMError>,
    has_output: bool,
) -> Result<bool, String> {
    match result {
        Ok(()) if has_output => {
            if let Some(revision) = active_revision {
                let mut health = health.lock().map_err(|e| format!("Failed to lock provider health: {e}"))?;
                if health.failure_revision(&who.provider) != revision {
                    return Err("AI provider health changed during the test. Test again.".into());
                }
                health.clear_credit_failure(&who.provider);
            }
            Ok(true)
        }
        Ok(()) => Err(LLMFailureKind::InvalidResponse.safe_message(&who.provider)),
        Err(error) => {
            if active_revision.is_some() {
                health.lock()
                    .map_err(|e| format!("Failed to lock provider health: {e}"))?
                    .record_failure(who, crate::profiles::routing::classify_kind(error.kind()), crate::profiles::failover::now_ms());
            }
            Err(error.safe_message())
        }
    }
}

#[cfg(test)]
mod response_test_tests {
    use super::*;
    use crate::profiles::routing::{FailureKind, LatencyBook, ModelRef};
    use std::sync::Mutex;

    #[test]
    fn temporary_response_does_not_clear_the_active_accounts_credit_failure() {
        let who = ModelRef::new("openai", "model");
        let health = Mutex::new(LatencyBook::default());
        health.lock().unwrap().record_failure(&who, FailureKind::CreditsExhausted, 0);
        assert!(finish_response_test(&health, &who, None, Ok(()), true).unwrap());
        assert!(health.lock().unwrap().credits_exhausted("openai"));
    }

    #[test]
    fn temporary_failure_does_not_poison_the_active_provider() {
        let who = ModelRef::new("openai", "model");
        let health = Mutex::new(LatencyBook::default());
        let error = crate::llm::provider::LLMError::NotConfigured("Missing credentials".into());
        assert!(finish_response_test(&health, &who, None, Err(error), false).is_err());
        assert_eq!(health.lock().unwrap().last_failure(&who), None);
    }

    #[test]
    fn actual_active_response_clears_credit_failure_only_with_output() {
        let who = ModelRef::new("openai", "model");
        let health = Mutex::new(LatencyBook::default());
        health.lock().unwrap().record_failure(&who, FailureKind::CreditsExhausted, 0);
        let revision = health.lock().unwrap().failure_revision("openai");
        assert!(finish_response_test(&health, &who, Some(revision), Ok(()), false).is_err());
        assert!(health.lock().unwrap().credits_exhausted("openai"));
        assert!(finish_response_test(&health, &who, Some(revision), Ok(()), true).unwrap());
        assert!(!health.lock().unwrap().credits_exhausted("openai"));
    }

    #[test]
    fn bare_response_test_refuses_another_active_provider() {
        let mut router = LLMRouter::new();
        router.set_provider(ProviderConfig {
            provider_type: "ollama".into(), api_key: None, base_url: None,
            auth_type: None, auth_value: None, auth_header: None,
        }).unwrap();
        let router = Mutex::new(router);
        assert!(resolve_provider(&router, "github_copilot").is_err());
        assert!(resolve_provider(&router, "ollama").is_ok());
    }

    #[test]
    fn old_response_cannot_clear_a_newer_failure_on_another_model() {
        let who = ModelRef::new("openai", "model");
        let health = Mutex::new(LatencyBook::default());
        health.lock().unwrap().record_failure(&who, FailureKind::CreditsExhausted, 0);
        let revision = health.lock().unwrap().failure_revision("openai");
        health.lock().unwrap().record_failure(&ModelRef::new("openai", "other"), FailureKind::CreditsExhausted, 1);
        assert!(finish_response_test(&health, &who, Some(revision), Ok(()), true).is_err());
        assert!(health.lock().unwrap().credits_exhausted("openai"));
    }

    #[test]
    fn another_providers_failure_does_not_block_verified_active_recovery() {
        let who = ModelRef::new("github_copilot", "model");
        let health = Mutex::new(LatencyBook::default());
        let revision = health.lock().unwrap().failure_revision("github_copilot");
        health.lock().unwrap().record_failure(&ModelRef::new("openai", "other"), FailureKind::CreditsExhausted, 1);
        assert!(finish_response_test(&health, &who, Some(revision), Ok(()), true).unwrap());
        assert!(health.lock().unwrap().credits_exhausted("openai"));
    }
}
