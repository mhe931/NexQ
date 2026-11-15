// Sub-PRD 5: Shared OpenAI-compatible client
// Used by: OpenAI, Groq, OpenRouter, LM Studio

use futures::StreamExt;
use serde_json::json;
use std::time::{Duration, Instant};

use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    cancellable, check_cancelled, is_cancelled, emit_end, emit_llm_error, emit_token, TokenSink,
};
use super::stream_parser::{LineBuffer, SSEParser};

/// Bound both requests and stalled streaming responses; reqwest's default
/// client otherwise has no total request timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Some compatible providers report a failure inside a successful SSE
/// response. Do not silently turn those frames into an empty success.
fn stream_error(provider: &str, data: &serde_json::Value) -> Option<LLMError> {
    let error = data.get("error").filter(|error| !error.is_null())?;
    Some(LLMError::from_http_failure(provider, 0, &error.to_string()))
}

/// Configuration for an OpenAI-compatible provider instance.
#[derive(Debug, Clone)]
pub struct OpenAICompatConfig {
    /// Provider name identifier (e.g., "openai", "groq", "openrouter", "lm_studio")
    pub provider_name: String,
    /// Base URL without trailing slash (e.g., "https://api.openai.com/v1")
    pub base_url: String,
    /// Optional authorization header name (e.g., "Authorization")
    pub auth_header: Option<String>,
    /// Optional authorization header value (e.g., "Bearer sk-...")
    pub auth_value: Option<String>,
    /// Optional extra headers (e.g., for OpenRouter's HTTP-Referer)
    pub extra_headers: Vec<(String, String)>,
}

pub struct OpenAICompatClient {
    config: OpenAICompatConfig,
    client: reqwest::Client,
}

impl OpenAICompatClient {
    pub fn new(config: OpenAICompatConfig) -> Self {
        let client = reqwest::Client::new();
        Self { config, client }
    }

    /// Build a request with auth headers applied.
    fn apply_auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let mut builder = builder;
        if let (Some(header), Some(value)) = (&self.config.auth_header, &self.config.auth_value) {
            builder = builder.header(header.as_str(), value.as_str());
        }
        for (key, val) in &self.config.extra_headers {
            builder = builder.header(key.as_str(), val.as_str());
        }
        builder.timeout(REQUEST_TIMEOUT)
    }

    fn transport_error(&self, error: reqwest::Error) -> LLMError {
        let kind = LLMError::from(error).kind();
        LLMError::classified(kind, &self.config.provider_name)
    }
}

#[async_trait::async_trait]
impl LLMProvider for OpenAICompatClient {
    fn provider_name(&self) -> &str {
        &self.config.provider_name
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        let url = format!("{}/models", self.config.base_url);
        let request = self.apply_auth(self.client.get(&url));

        let response = request.send().await.map_err(|error| self.transport_error(error))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(LLMError::from_http_failure(&self.config.provider_name, status.as_u16(), &body));
        }

        let body: serde_json::Value = response.json().await.map_err(|error| self.transport_error(error))?;

        let models = body
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let id = m.get("id")?.as_str()?.to_string();
                        let name = m
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or_else(|| m.get("id").and_then(|i| i.as_str()).unwrap_or(""))
                            .to_string();
                        Some(ModelInfo {
                            id: id.clone(),
                            name: if name.is_empty() { id.clone() } else { name },
                            provider: self.config.provider_name.clone(),
                            context_window: m
                                .get("context_window")
                                .and_then(|c| c.as_u64())
                                .or_else(|| {
                                    m.get("context_length").and_then(|c| c.as_u64())
                                }),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(models)
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        // OpenRouter's /models endpoint is public (no auth required), so use /auth/key instead
        // to actually validate the API key.
        let url = if self.config.provider_name == "openrouter" {
            format!("{}/auth/key", self.config.base_url)
        } else {
            format!("{}/models", self.config.base_url)
        };
        let request = self.apply_auth(self.client.get(&url));

        let response = request.send().await.map_err(|error| self.transport_error(error))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(LLMError::from_http_failure(&self.config.provider_name, status, &body));
        }
        // This proves endpoint/key access, not a funded completion. In
        // particular OpenAI /models may succeed while chat returns 429
        // insufficient_quota. Never make a billable chat as a settings probe.
        Ok(true)
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        let url = format!("{}/chat/completions", self.config.base_url);
        let start = Instant::now();

        // Build messages array
        let msgs: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                json!({
                    "role": m.role,
                    "content": m.content
                })
            })
            .collect();

        // OpenRouter: ":online" suffix enables web search grounding (via Exa) for any model.
        let model_id = if params.enable_web_search && self.config.provider_name == "openrouter" {
            format!("{}:online", model)
        } else {
            model.to_string()
        };

        let mut body = json!({
            "model": model_id,
            "messages": msgs,
            "stream": true
        });

        if let Some(temp) = params.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(max_tok) = params.max_tokens {
            body["max_tokens"] = json!(max_tok);
        }

        let request = self
            .apply_auth(self.client.post(&url))
            .header("Content-Type", "application/json")
            .json(&body);

        // NOTE: llm_stream_start is emitted by IntelligenceEngine::generate_assist()
        // with the correct mode. Do NOT emit it here — it would overwrite the mode.

        let response = cancellable(&params, request.send()).await?.map_err(|e| {
            if is_cancelled(&params) {
                return LLMError::Cancelled;
            }
            let error = self.transport_error(e);
            emit_llm_error(&app_handle, &params, &error);
            error
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = cancellable(&params, response.text()).await?.unwrap_or_default();
            let error = LLMError::from_http_failure(&self.config.provider_name, status.as_u16(), &body);
            check_cancelled(&params)?;
            emit_llm_error(&app_handle, &params, &error);
            return Err(error);
        }

        let mut stream = response.bytes_stream();
        let mut line_buffer = LineBuffer::new();
        let mut token_count: u64 = 0;

        while let Some(chunk_result) = cancellable(&params, stream.next()).await? {
            check_cancelled(&params)?;
            let chunk = chunk_result.map_err(|e| {
                if is_cancelled(&params) {
                    return LLMError::Cancelled;
                }
                let error = self.transport_error(e);
                emit_llm_error(&app_handle, &params, &error);
                error
            })?;

            let chunk_str = String::from_utf8_lossy(&chunk);
            let lines = line_buffer.push(&chunk_str);

            for line in lines {
                let events = SSEParser::parse_chunk(&line);
                for event in events {
                    match event {
                        Some(data) => {
                            if let Some(error) = stream_error(&self.config.provider_name, &data) {
                                emit_llm_error(&app_handle, &params, &error);
                                return Err(error);
                            }
                            if let Some(token) = SSEParser::extract_openai_token(&data) {
                                if !token.is_empty() {
                                    token_count += 1;
                                    check_cancelled(&params)?;
                                    emit_token(&app_handle, &params, &token, sink.as_ref());
                                }
                            }
                        }
                        None => {
                            // [DONE] signal
                        }
                    }
                }
            }
        }

        // Flush any remaining data in the buffer
        if let Some(remaining) = line_buffer.flush() {
            let events = SSEParser::parse_chunk(&remaining);
            for event in events {
                if let Some(data) = event {
                    if let Some(error) = stream_error(&self.config.provider_name, &data) {
                        emit_llm_error(&app_handle, &params, &error);
                        return Err(error);
                    }
                    if let Some(token) = SSEParser::extract_openai_token(&data) {
                        if !token.is_empty() {
                            token_count += 1;
                            check_cancelled(&params)?;
                            emit_token(&app_handle, &params, &token, sink.as_ref());
                        }
                    }
                }
            }
        }

        let latency_ms = start.elapsed().as_millis() as u64;
        let stats = CompletionStats {
            prompt_tokens: 0, // Not available in streaming mode for most providers
            completion_tokens: token_count,
            total_tokens: token_count,
            latency_ms,
        };

        check_cancelled(&params)?;
        emit_end(&app_handle, &params, token_count, latency_ms);

        Ok(stats)
    }
}

/// Create an OpenAI client (api.openai.com)
pub fn create_openai_client(api_key: &str) -> OpenAICompatClient {
    OpenAICompatClient::new(OpenAICompatConfig {
        provider_name: "openai".to_string(),
        base_url: "https://api.openai.com/v1".to_string(),
        auth_header: Some("Authorization".to_string()),
        auth_value: Some(format!("Bearer {}", api_key)),
        extra_headers: vec![],
    })
}

/// Create a Groq client (api.groq.com)
pub fn create_groq_client(api_key: &str) -> OpenAICompatClient {
    OpenAICompatClient::new(OpenAICompatConfig {
        provider_name: "groq".to_string(),
        base_url: "https://api.groq.com/openai/v1".to_string(),
        auth_header: Some("Authorization".to_string()),
        auth_value: Some(format!("Bearer {}", api_key)),
        extra_headers: vec![],
    })
}

/// Create an OpenRouter client (openrouter.ai)
pub fn create_openrouter_client(api_key: &str) -> OpenAICompatClient {
    OpenAICompatClient::new(OpenAICompatConfig {
        provider_name: "openrouter".to_string(),
        base_url: "https://openrouter.ai/api/v1".to_string(),
        auth_header: Some("Authorization".to_string()),
        auth_value: Some(format!("Bearer {}", api_key)),
        extra_headers: vec![
            ("HTTP-Referer".to_string(), "https://nexq.app".to_string()),
            ("X-Title".to_string(), "NexQ".to_string()),
        ],
    })
}

/// Create an LM Studio client (localhost)
pub fn create_lm_studio_client(base_url: Option<&str>) -> OpenAICompatClient {
    OpenAICompatClient::new(OpenAICompatConfig {
        provider_name: "lm_studio".to_string(),
        base_url: base_url
            .unwrap_or("http://localhost:1234/v1")
            .to_string(),
        auth_header: None,
        auth_value: None,
        extra_headers: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::provider::LLMFailureKind;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// An unauthenticated loopback stub, never the user's configured provider.
    async fn stub(status: u16, body: &str) -> (OpenAICompatClient, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let body = body.to_string();
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let n = socket.read(&mut request).await.unwrap();
            let request_line = String::from_utf8_lossy(&request[..n]).lines().next().unwrap().to_string();
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
            request_line
        });
        let mut client = OpenAICompatClient::new(OpenAICompatConfig {
            provider_name: "openai".into(),
            base_url,
            auth_header: None,
            auth_value: None,
            extra_headers: vec![],
        });
        // Local tests must not use the machine's HTTP proxy configuration.
        client.client = reqwest::Client::builder().no_proxy().build().unwrap();
        (client, served)
    }

    #[tokio::test]
    async fn model_listing_classifies_credit_exhaustion_and_redacts_the_body() {
        let (client, served) = stub(429, r#"{"error":{"code":"insufficient_quota","message":"private-body-sentinel"}}"#).await;
        let error = client.list_models().await.unwrap_err();
        assert_eq!(error.kind(), LLMFailureKind::CreditsExhausted);
        assert!(!error.is_retryable());
        assert!(!error.to_string().contains("sentinel"));
        assert_eq!(served.await.unwrap(), "GET /models HTTP/1.1");
    }

    #[tokio::test]
    async fn connection_probe_reports_actionable_failure_instead_of_false() {
        for (status, body, expected) in [
            (401, r#"{"error":{"code":"invalid_api_key","message":"private-key-sentinel"}}"#, LLMFailureKind::InvalidApiKey),
            (403, "private-body-sentinel", LLMFailureKind::Authentication),
            (429, r#"{"error":{"code":"rate_limit_exceeded"}}"#, LLMFailureKind::RateLimited),
            (429, r#"{"error":{"code":"credit_balance_exhausted"}}"#, LLMFailureKind::CreditsExhausted),
            (503, "private-body-sentinel", LLMFailureKind::Unavailable),
            (504, "private-body-sentinel", LLMFailureKind::Timeout),
        ] {
            let (client, served) = stub(status, body).await;
            let error = client.test_connection().await.unwrap_err();
            assert_eq!(error.kind(), expected);
            assert!(!error.to_string().contains("sentinel"));
            assert_eq!(served.await.unwrap(), "GET /models HTTP/1.1");
        }
    }

    #[tokio::test]
    async fn successful_model_access_does_not_make_a_billable_chat_probe() {
        let (client, served) = stub(200, r#"{"data":[]}"#).await;
        assert!(client.test_connection().await.unwrap());
        assert_eq!(served.await.unwrap(), "GET /models HTTP/1.1");
    }

    #[tokio::test]
    async fn stalled_requests_are_classified_as_timeout_without_url_leakage() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = OpenAICompatClient::new(OpenAICompatConfig {
            provider_name: "openai".into(),
            base_url: format!("http://{}/private-url-sentinel", listener.local_addr().unwrap()),
            auth_header: None,
            auth_value: None,
            extra_headers: vec![],
        });
        client.client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(20))
            .build().unwrap();
        // apply_auth sets a per-request timeout, so exercise the same error
        // conversion with a short bounded request to the local listener.
        let error = client.client.get(&client.config.base_url)
            .timeout(Duration::from_millis(20)).send().await.unwrap_err();
        let error = client.transport_error(error);
        assert_eq!(error.kind(), LLMFailureKind::Timeout);
        assert!(error.is_retryable());
        assert!(!error.to_string().contains("sentinel"));
    }

    #[test]
    fn sse_failure_frames_are_errors_not_an_empty_success() {
        for (code, expected) in [
            ("insufficient_quota", LLMFailureKind::CreditsExhausted),
            ("credit_balance_exhausted", LLMFailureKind::CreditsExhausted),
            ("rate_limit_exceeded", LLMFailureKind::RateLimited),
            ("invalid_api_key", LLMFailureKind::InvalidApiKey),
        ] {
            let data = json!({"error":{"code":code, "message":"private-sse-sentinel"}});
            let error = stream_error("openai", &data).unwrap();
            assert_eq!(error.kind(), expected);
            assert!(!error.to_string().contains("sentinel"));
        }
        assert!(stream_error("openai", &json!({"choices":[{"delta":{"content":"Public reply"}}]})).is_none());
        assert!(stream_error("openai", &json!({"error":null})).is_none());
    }
}
