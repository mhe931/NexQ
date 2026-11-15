// Sub-PRD 5: Google Gemini streamGenerateContent client

use futures::StreamExt;
use serde_json::json;
use std::time::Instant;

use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    cancellable, check_cancelled, is_cancelled, emit_end_with_stats, emit_error, emit_sources, emit_token, StreamSource, TokenSink,
};
use super::stream_parser::{LineBuffer, SSEParser};

pub struct GeminiClient {
    api_key: String,
    base_url: String,
    client: reqwest::Client,
}

/// Accumulate metadata for every SSE frame, including the final buffered
/// frame. Text and metadata must not take different flush paths.
#[derive(Default)]
struct GeminiMetadata {
    prompt_tokens: u64,
    completion_tokens: u64,
    grounding_sources: Vec<(String, String)>,
}

impl GeminiMetadata {
    fn observe(&mut self, data: &serde_json::Value, enable_web_search: bool) {
        if enable_web_search {
            self.grounding_sources.extend(SSEParser::extract_gemini_grounding(data));
        }
        if let Some(usage) = data.get("usageMetadata") {
            if let Some(tokens) = usage.get("promptTokenCount").and_then(|v| v.as_u64()) {
                self.prompt_tokens = tokens;
            }
            if let Some(tokens) = usage.get("candidatesTokenCount").and_then(|v| v.as_u64()) {
                self.completion_tokens = tokens;
            }
        }
    }

    fn finish(self, token_count: u64, latency_ms: u64) -> (CompletionStats, Vec<StreamSource>) {
        // Preserve the existing chunk-count fallback when usage is absent.
        let completion_tokens = if self.completion_tokens == 0 { token_count } else { self.completion_tokens };
        let stats = CompletionStats {
            prompt_tokens: self.prompt_tokens,
            completion_tokens,
            total_tokens: self.prompt_tokens + completion_tokens,
            latency_ms,
        };
        let mut seen = std::collections::HashSet::new();
        let sources = self.grounding_sources.into_iter()
            .filter(|(_, url)| seen.insert(url.clone()))
            .map(|(title, url)| StreamSource { title, url })
            .collect();
        (stats, sources)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::gemini_cache::GeminiCacheClient;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const TEST_KEY: &str = "nexq-unit-test-key-not-a-credential";

    #[test]
    fn grounding_and_usage_survive_an_unterminated_final_sse_frame() {
        let mut buffer = LineBuffer::new();
        let mut metadata = GeminiMetadata::default();
        let frames = [
            "data: {\"candidates\":[{\"groundingMetadata\":{\"groundingChunks\":[{\"web\":{\"title\":\"Public source\",\"uri\":\"https://example.com\"}}]}}]}\n\n",
            "data: {\"usageMetadata\":{\"promptTokenCount\":17,\"candidatesTokenCount\":4},\"candidates\":[{\"groundingMetadata\":{\"groundingChunks\":[{\"web\":{\"title\":\"Duplicate\",\"uri\":\"https://example.com\"}},{\"web\":{\"title\":\"Final source\",\"uri\":\"https://example.org\"}}]}}]}",
        ];
        for frame in frames {
            for line in buffer.push(frame) {
                for data in SSEParser::parse_chunk(&line).into_iter().flatten() {
                    metadata.observe(&data, true);
                }
            }
        }
        if let Some(remaining) = buffer.flush() {
            for data in SSEParser::parse_chunk(&remaining).into_iter().flatten() {
                metadata.observe(&data, true);
            }
        }
        let (stats, sources) = metadata.finish(1, 23);
        assert_eq!((stats.prompt_tokens, stats.completion_tokens, stats.total_tokens, stats.latency_ms), (17, 4, 21, 23));
        assert_eq!(sources.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), ["Public source", "Final source"]);
        let usage = crate::llm::provider::StreamUsage::from_stats(&stats).unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens), (17, 4));
    }

    #[test]
    fn disabled_grounding_and_absent_usage_keep_existing_behavior() {
        let mut metadata = GeminiMetadata::default();
        metadata.observe(&json!({"candidates":[{"groundingMetadata":{"groundingChunks":[
            {"web":{"title":"Public source","uri":"https://example.com"}}
        ]}}]}), false);
        let (stats, sources) = metadata.finish(3, 5);
        assert!(sources.is_empty());
        assert_eq!((stats.prompt_tokens, stats.completion_tokens, stats.total_tokens), (0, 3, 3));
        assert!(crate::llm::provider::StreamUsage::from_stats(&stats).is_none());
    }

    async fn server(body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let request = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(10), async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                let head_end = loop {
                    let n = socket.read(&mut buf).await.unwrap();
                    assert_ne!(n, 0, "request ended before its headers");
                    raw.extend_from_slice(&buf[..n]);
                    if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&raw[..head_end]);
                let length = head.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                }).unwrap_or(0);
                while raw.len() < head_end + length {
                    let n = socket.read(&mut buf).await.unwrap();
                    assert_ne!(n, 0, "request ended before its body");
                    raw.extend_from_slice(&buf[..n]);
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
                String::from_utf8(raw).unwrap()
            }).await.unwrap()
        });
        (base, request)
    }

    fn assert_authentication(request: &str, request_line: &str) {
        assert_eq!(request.lines().next(), Some(request_line));
        assert!(request.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("x-goog-api-key") && value.trim() == TEST_KEY
            })
        }), "Gemini must authenticate with a header, not its URL");
    }

    #[tokio::test]
    async fn list_models_keeps_credentials_out_of_urls() {
        let (base, request) = server(r#"{"models":[{"name":"models/gemini-test","displayName":"Test Gemini","supportedGenerationMethods":["generateContent"],"inputTokenLimit":8192}]}"#).await;
        let models = GeminiClient::new(TEST_KEY, Some(&base)).list_models().await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-test");
        assert_authentication(&request.await.unwrap(), "GET /v1beta/models HTTP/1.1");
    }

    #[tokio::test]
    async fn cache_operations_keep_credentials_out_of_urls() {
        let (base, request) = server(r#"{"name":"cachedContents/test","model":"models/gemini-test","expireTime":"2030-01-01T00:00:00Z","usageMetadata":{"totalTokenCount":42}}"#).await;
        let entry = GeminiCacheClient::new(TEST_KEY, Some(&base))
            .create("gemini-test", Some("Ground answers in supplied context."), "Test context", 60)
            .await.unwrap();
        assert_eq!(entry.name, "cachedContents/test");
        assert_eq!(entry.total_token_count, 42);
        let request = request.await.unwrap();
        assert_authentication(&request, "POST /v1beta/cachedContents HTTP/1.1");
        let body: serde_json::Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["model"], "models/gemini-test");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "Test context");

        let (base, request) = server("{}").await;
        GeminiCacheClient::new(TEST_KEY, Some(&base)).delete(&entry.name).await.unwrap();
        assert_authentication(&request.await.unwrap(), "DELETE /v1beta/cachedContents/test HTTP/1.1");
    }

    #[tokio::test]
    async fn transport_errors_do_not_expose_api_keys() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let error = GeminiClient::new(TEST_KEY, Some(&base)).list_models().await.unwrap_err();
        assert!(!error.to_string().contains(TEST_KEY), "transport error exposed a credential");
        let error = GeminiCacheClient::new(TEST_KEY, Some(&base)).delete("cachedContents/test").await.unwrap_err();
        assert!(!error.contains(TEST_KEY), "cache transport error exposed a credential");
    }
}

impl GeminiClient {
    pub fn new(api_key: &str, base_url: Option<&str>) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or("https://generativelanguage.googleapis.com")
                .to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// Convert standard LLM messages to Gemini format.
    /// Gemini uses "user" and "model" roles, with a separate systemInstruction field.
    fn convert_messages(
        messages: &[LLMMessage],
    ) -> (Option<String>, Vec<serde_json::Value>) {
        let mut system_instruction: Option<String> = None;
        let mut contents: Vec<serde_json::Value> = Vec::new();

        for msg in messages {
            match msg.role.as_str() {
                "system" => {
                    system_instruction = Some(msg.content.clone());
                }
                "assistant" => {
                    contents.push(json!({
                        "role": "model",
                        "parts": [{"text": msg.content}]
                    }));
                }
                _ => {
                    // "user" or anything else maps to "user"
                    contents.push(json!({
                        "role": "user",
                        "parts": [{"text": msg.content}]
                    }));
                }
            }
        }

        (system_instruction, contents)
    }
}

#[async_trait::async_trait]
impl LLMProvider for GeminiClient {
    fn provider_name(&self) -> &str {
        "gemini"
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        let url = format!("{}/v1beta/models", self.base_url);

        let response = self.client.get(&url)
            .header("x-goog-api-key", &self.api_key)
            .send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(LLMError::AuthError(format!(
                    "Gemini authentication failed ({}): {}",
                    status, body
                )));
            }
            return Err(LLMError::ProviderError(format!(
                "Failed to list Gemini models ({}): {}",
                status, body
            )));
        }

        let body: serde_json::Value = response.json().await?;

        let models = body
            .get("models")
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let name = m.get("name")?.as_str()?.to_string();
                        let display_name = m
                            .get("displayName")
                            .and_then(|n| n.as_str())
                            .unwrap_or(&name)
                            .to_string();

                        // Filter to only generateContent-supporting models
                        let supported = m
                            .get("supportedGenerationMethods")
                            .and_then(|s| s.as_array())
                            .map(|methods| {
                                methods.iter().any(|method| {
                                    method.as_str() == Some("generateContent")
                                        || method.as_str() == Some("streamGenerateContent")
                                })
                            })
                            .unwrap_or(false);

                        if !supported {
                            return None;
                        }

                        // Extract model ID from "models/gemini-pro" -> "gemini-pro"
                        let id = name
                            .strip_prefix("models/")
                            .unwrap_or(&name)
                            .to_string();

                        let context_window = m
                            .get("inputTokenLimit")
                            .and_then(|c| c.as_u64());

                        Some(ModelInfo {
                            id,
                            name: display_name,
                            provider: "gemini".to_string(),
                            context_window,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(models)
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        match self.list_models().await {
            Ok(models) => Ok(!models.is_empty()),
            Err(_) => Ok(false),
        }
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        let url = format!(
            "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
            self.base_url, model
        );
        let start = Instant::now();

        let (system_instruction, contents) = Self::convert_messages(&messages);

        let max_output = params.max_tokens.unwrap_or(4096);
        let mut gen_config = json!({
            "maxOutputTokens": max_output
        });
        if let Some(temp) = params.temperature {
            gen_config["temperature"] = json!(temp);
        }

        let mut body = if let Some(cache_name) = &params.cache_name {
            // Cache active: reference cached content, skip systemInstruction (it's in the cache).
            // Only dynamic contents (transcript + question) are sent fresh.
            json!({
                "cachedContent": cache_name,
                "contents": contents,
                "generationConfig": gen_config
            })
        } else {
            let mut b = json!({
                "contents": contents,
                "generationConfig": gen_config
            });
            if let Some(system) = system_instruction {
                b["systemInstruction"] = json!({
                    "parts": [{"text": system}]
                });
            }
            b
        };

        if params.enable_web_search {
            body["tools"] = json!([{ "google_search": {} }]);
        }

        // NOTE: llm_stream_start is emitted by IntelligenceEngine::generate_assist()
        // with the correct mode. Do NOT emit it here — it would overwrite the mode.

        let response = cancellable(
            &params,
            self
                .client
                .post(&url)
                .header("x-goog-api-key", &self.api_key)
                .header("Content-Type", "application/json")
                .json(&body)
                .send(),
        )
        .await?
        .map_err(|e| {
            if is_cancelled(&params) {
                return LLMError::Cancelled;
            }
                emit_error(&app_handle, &params, &e.to_string());
            LLMError::HttpError(e)
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let err_msg = format!("Gemini request failed ({}): {}", status, body);
            check_cancelled(&params)?;
            emit_error(&app_handle, &params, &err_msg);

            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(LLMError::AuthError(err_msg));
            }
            return Err(LLMError::ProviderError(err_msg));
        }

        let mut stream = response.bytes_stream();
        let mut line_buffer = LineBuffer::new();
        let mut token_count: u64 = 0;
        let mut metadata = GeminiMetadata::default();

        while let Some(chunk_result) = cancellable(&params, stream.next()).await? {
            check_cancelled(&params)?;
            let chunk = chunk_result.map_err(|e| {
                if is_cancelled(&params) {
                    return LLMError::Cancelled;
                }
                emit_error(&app_handle, &params, &e.to_string());
                LLMError::HttpError(e)
            })?;

            let chunk_str = String::from_utf8_lossy(&chunk);
            let lines = line_buffer.push(&chunk_str);

            for line in lines {
                let events = SSEParser::parse_chunk(&line);
                for event in events {
                    match event {
                        Some(data) => {
                            // Extract token from Gemini format
                            if let Some(token) = SSEParser::extract_gemini_token(&data) {
                                if !token.is_empty() {
                                    token_count += 1;
                                    check_cancelled(&params)?;
                                    emit_token(&app_handle, &params, &token, sink.as_ref());
                                }
                            }

                            metadata.observe(&data, params.enable_web_search);
                        }
                        None => {
                            // [DONE] signal
                        }
                    }
                }
            }
        }

        // Flush remaining buffer
        if let Some(remaining) = line_buffer.flush() {
            let events = SSEParser::parse_chunk(&remaining);
            for event in events {
                if let Some(data) = event {
                    metadata.observe(&data, params.enable_web_search);
                    if let Some(token) = SSEParser::extract_gemini_token(&data) {
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

        let (stats, sources) = metadata.finish(token_count, latency_ms);

        if !sources.is_empty() {
            check_cancelled(&params)?;
            emit_sources(&app_handle, &params, sources);
        }

        check_cancelled(&params)?;
        emit_end_with_stats(&app_handle, &params, &stats);

        Ok(stats)
    }
}
