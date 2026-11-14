use serde::{Deserialize, Serialize};

/// RAG pipeline configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagConfig {
    /// Whether the RAG pipeline is enabled.
    pub enabled: bool,
    /// Ollama embedding model name.
    pub embedding_model: String,
    /// Ollama server base URL.
    pub ollama_url: String,
    /// Number of texts to embed per batch request.
    pub batch_size: usize,
    /// Target chunk size in tokens.
    pub chunk_size: usize,
    /// Overlap between consecutive chunks in tokens.
    pub chunk_overlap: usize,
    /// Text splitting strategy ("recursive", etc.).
    pub splitting_strategy: String,
    /// Number of top results to return from search.
    pub top_k: usize,
    /// Search mode: "hybrid", "semantic", or "keyword".
    pub search_mode: String,
    /// Minimum similarity score to include in results.
    pub similarity_threshold: f32,
    /// Weight for semantic search in hybrid mode (0.0–1.0).
    pub semantic_weight: f32,
    /// Whether to index live transcript segments.
    pub include_transcript: bool,
    /// Dimensionality of the embedding vectors.
    pub embedding_dimensions: usize,
}

impl Default for RagConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            embedding_model: "nomic-embed-text".to_string(),
            ollama_url: "http://localhost:11434".to_string(),
            batch_size: 32,
            chunk_size: 512,
            chunk_overlap: 64,
            splitting_strategy: "recursive".to_string(),
            top_k: 5,
            search_mode: "hybrid".to_string(),
            similarity_threshold: 0.3,
            semantic_weight: 0.7,
            include_transcript: true,
            embedding_dimensions: 768,
        }
    }
}

impl RagConfig {
    /// Reads the retrieval settings the frontend saved in the app's settings
    /// store (`config.json`). A missing file or missing key yields the
    /// defaults; a present but invalid `ragConfig` is an error, not a silent reset.
    pub fn load_from_store(path: &std::path::Path) -> Result<Self, String> {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
        };
        let store: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Settings file {} is not valid JSON: {e}", path.display()))?;
        let Some(saved) = store.get("ragConfig").filter(|v| !v.is_null()) else {
            return Ok(Self::default());
        };
        let mut config: Self = serde_json::from_value(saved.clone())
            .map_err(|e| format!("Saved retrieval settings are invalid: {e}"))?;
        if store.get("contextStrategy").and_then(|v| v.as_str()) == Some("local_rag") {
            config.enabled = true;
        }
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_start_restores_saved_keyword_retrieval() {
        let path = std::env::temp_dir().join(format!("nexq-rag-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, r#"{
                "contextStrategy": "local_rag",
                "ragConfig": {
                    "enabled": true, "embedding_model": "unused",
                    "ollama_url": "http://127.0.0.1:1", "batch_size": 32,
                    "chunk_size": 384, "chunk_overlap": 48,
                    "splitting_strategy": "recursive", "top_k": 6,
                    "search_mode": "keyword", "similarity_threshold": 0.0,
                    "semantic_weight": 0.0, "include_transcript": false,
                    "embedding_dimensions": 768
                }
        }"#).unwrap();
        let loaded = RagConfig::load_from_store(&path);
        std::fs::remove_file(&path).unwrap();
        let manager = super::super::RagManager::new(loaded.unwrap());
        assert_eq!(manager.config().search_mode, "keyword");
        assert_eq!(manager.config().top_k, 6);
        assert!(manager.config().enabled);
        assert!(!manager.config().include_transcript);
    }

    #[test]
    fn invalid_saved_retrieval_config_is_not_silently_discarded() {
        let path = std::env::temp_dir().join(format!("nexq-rag-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, r#"{"ragConfig":{"top_k":"invalid"}}"#).unwrap();
        let loaded = RagConfig::load_from_store(&path);
        std::fs::remove_file(&path).unwrap();
        assert!(loaded.is_err());
    }
}
