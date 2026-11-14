//! Local keyword retrieval over one meeting's documents (SQLite FTS5, BM25).
//! No network, no embedding service: fast, private and always available.

use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub document_id: String,
    pub source_name: String,
    pub locator: String,
    pub text: String,
    pub score: f64,
}

impl Hit {
    /// Citation shown with an answer, e.g. `thesis.docx — section "Methods"`.
    pub fn citation(&self) -> String {
        format!("{} — {}", self.source_name, self.locator)
    }
}

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "your", "can", "does", "did", "how", "what", "why",
    "when", "where", "which", "who", "whom", "was", "were", "have", "has", "had", "with", "that", "this",
    "from", "about", "would", "could", "should", "there", "their", "them", "into", "than", "then",
    "tell", "explain", "please",
];

fn fts_query(raw: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    raw.split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_'))
        .map(str::to_lowercase)
        .filter(|w| {
            let n = w.chars().count();
            (n >= 3 || (n == 2 && w.chars().any(|c| c.is_ascii_digit()))) && !STOPWORDS.contains(&w.as_str())
        })
        .filter(|w| seen.insert(w.clone()))
        .take(24)
        .map(|w| format!("\"{}\"", w.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// Top matches for `query`, restricted to `profile_id`'s reference documents.
pub fn search(conn: &Connection, profile_id: &str, query: &str, top_k: usize) -> Result<Vec<Hit>, String> {
    let q = fts_query(query);
    if q.is_empty() || top_k == 0 {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT d.id, d.name, f.locator, f.text, bm25(profile_fts) AS score
             FROM profile_fts f
             JOIN profile_documents d ON d.id = f.document_id
             WHERE profile_fts MATCH ?1 AND f.profile_id = ?2
               AND d.profile_id = ?2 AND d.role = 'reference' AND d.status = 'indexed'
             ORDER BY score LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![q, profile_id, top_k as i64], |r| {
            Ok(Hit {
                document_id: r.get(0)?,
                source_name: r.get(1)?,
                locator: r.get(2)?,
                text: r.get(3)?,
                score: -r.get::<_, f64>(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_drop_stopwords_dedupe_and_neutralize_fts_syntax() {
        assert_eq!(fts_query("What is the NDSI threshold?"), "\"ndsi\" OR \"threshold\"");
        assert_eq!(fts_query("sea sea ice\" OR NEAR(x)"), "\"sea\" OR \"ice\" OR \"near\"");
        assert_eq!(fts_query("Section 6.9 q4"), "\"section\" OR \"q4\"");
        assert!(fts_query("???").is_empty());
    }
}
