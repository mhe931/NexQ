//! Speaker notes supplied separately from the presentation (DOCX, PDF, TXT,
//! Markdown, or an export of a Google Doc) and their mapping onto slides.
//!
//! Notes documents are parsed into *blocks*, one per "Slide N" heading. Each
//! block keeps what was detected and what the user assigned, so an ambiguous
//! match can be corrected by hand without touching the source document.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use super::model::NotesPriority;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedBlock {
    pub label: String,
    pub detected: Option<u32>,
    pub text: String,
}

const KEYWORDS: &[&str] = &[
    "slides", "slide", "diapositiva", "folie", "page", "sl.", "слайд", "اسلاید", "صفحه",
];

fn ascii_digit(c: char) -> Option<u32> {
    match c {
        '0'..='9' => Some(c as u32 - '0' as u32),
        '\u{0660}'..='\u{0669}' => Some(c as u32 - 0x0660), // Arabic-Indic
        '\u{06F0}'..='\u{06F9}' => Some(c as u32 - 0x06F0), // Persian
        _ => None,
    }
}

fn strip_keyword(chars: &[char], keyword: &str) -> Option<usize> {
    let kw: Vec<char> = keyword.chars().collect();
    if chars.len() < kw.len() {
        return None;
    }
    chars
        .iter()
        .zip(&kw)
        .all(|(a, b)| a.to_lowercase().next() == b.to_lowercase().next())
        .then_some(kw.len())
}

/// `Some((slide, title))` when `line` is a slide heading.
///
/// Accepted: `# Slide 3`, `## Slide 3: Title`, `Slide 3 - Title`, `SLIDE 03 | START ...`,
/// `**Slide 3**`, `Slide 3 of 16`, `# 3. Title` (Markdown heading only).
/// Rejected: running text such as `Slide 3 shows the results.`
fn slide_heading(line: &str) -> Option<(u32, String)> {
    let trimmed = line.trim();
    let markdown = trimmed.starts_with('#');
    let body = trimmed.trim_start_matches('#');
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;
    while i < chars.len() && matches!(chars[i], ' ' | '\t' | '*' | '_' | '>') {
        i += 1;
    }

    let mut after_keyword = false;
    for kw in KEYWORDS {
        if let Some(n) = strip_keyword(&chars[i..], kw) {
            i += n;
            after_keyword = true;
            break;
        }
    }
    if !after_keyword && !markdown {
        return None;
    }
    while i < chars.len() && matches!(chars[i], ' ' | '\t' | '#' | '*' | '_' | '№') {
        i += 1;
    }
    // optional "no." / "nr."
    for prefix in ["no.", "nr.", "number"] {
        if let Some(n) = strip_keyword(&chars[i..], prefix) {
            i += n;
            while i < chars.len() && chars[i] == ' ' {
                i += 1;
            }
        }
    }

    let mut number = 0u32;
    let mut digits = 0;
    while i < chars.len() {
        match ascii_digit(chars[i]) {
            Some(d) if digits < 4 => {
                number = number * 10 + d;
                digits += 1;
                i += 1;
            }
            _ => break,
        }
    }
    if digits == 0 || number == 0 {
        return None;
    }
    if i < chars.len() && chars[i].is_alphanumeric() {
        return None;
    }

    let rest: String = chars[i..].iter().collect();
    let rest = rest.trim_start_matches(['*', '_']).trim().to_string();
    let lower = rest.to_lowercase();
    let mut accepted = markdown || rest.is_empty();
    let mut label = rest.clone();
    if !accepted {
        let first = rest.chars().next().unwrap_or(' ');
        if matches!(first, ':' | '-' | '–' | '—' | '.' | '|' | ')' | '(' | ',' | '/' | '·') {
            accepted = true;
        } else if lower.starts_with("of ") && lower[3..].trim().chars().all(|c| ascii_digit(c).is_some()) {
            accepted = true;
            label.clear();
        }
    }
    if !accepted {
        return None;
    }
    let label = label
        .trim_start_matches(|c: char| matches!(c, ':' | '-' | '–' | '—' | '.' | '|' | ')' | '(' | ',' | '/' | '·' | '*' | '_') || c.is_whitespace())
        .trim_end_matches(['*', '_'])
        .trim()
        .to_string();
    Some((number, label))
}

fn is_rule(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 3 && t.chars().all(|c| matches!(c, '-' | '*' | '_' | '='))
}

pub fn parse_notes(text: &str) -> Vec<ParsedBlock> {
    let mut blocks: Vec<ParsedBlock> = Vec::new();
    let mut current: Option<ParsedBlock> = None;
    let mut preface = String::new();
    let mut in_fence = false;

    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        let heading = if in_fence { None } else { slide_heading(line) };
        if let Some((number, label)) = heading {
            if let Some(done) = current.take() {
                blocks.push(done);
            } else if !preface.trim().is_empty() {
                blocks.push(ParsedBlock {
                    label: "Text before the first slide heading".into(),
                    detected: None,
                    text: preface.trim().to_string(),
                });
            }
            current = Some(ParsedBlock { label, detected: Some(number), text: String::new() });
        } else if is_rule(line) {
            continue;
        } else if let Some(block) = current.as_mut() {
            block.text.push_str(line);
            block.text.push('\n');
        } else {
            preface.push_str(line);
            preface.push('\n');
        }
    }
    if let Some(done) = current.take() {
        blocks.push(done);
    } else if !preface.trim().is_empty() {
        blocks.push(ParsedBlock {
            label: "No slide headings found".into(),
            detected: None,
            text: preface.trim().to_string(),
        });
    }
    for b in &mut blocks {
        b.text = b.text.trim().to_string();
    }
    blocks
}

// ── persistence ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotesBlock {
    pub id: String,
    pub document_id: String,
    pub ordinal: u32,
    pub label: String,
    pub detected_slide: Option<u32>,
    pub assigned_slide: Option<u32>,
    pub text: String,
    /// Assigned by hand, not by the heading.
    pub manual: bool,
    /// `ok`, `unassigned`, `duplicate` (several blocks on one slide) or `out_of_range`.
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotesImport {
    pub document_id: String,
    pub blocks: usize,
    pub matched: usize,
    pub unassigned: usize,
    pub duplicates: usize,
}

pub fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS profile_notes_blocks (
            id             TEXT PRIMARY KEY NOT NULL,
            profile_id     TEXT NOT NULL REFERENCES meeting_profiles(id) ON DELETE CASCADE,
            document_id    TEXT NOT NULL,
            ordinal        INTEGER NOT NULL,
            label          TEXT NOT NULL DEFAULT '',
            detected_slide INTEGER,
            assigned_slide INTEGER,
            text           TEXT NOT NULL DEFAULT '',
            manual         INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_notes_blocks_profile ON profile_notes_blocks(profile_id);",
    )
}

/// Parses `text` and replaces the blocks of `document_id`. Hand assignments
/// survive a re-import when the block at the same position has the same label.
pub fn import(conn: &Connection, profile_id: &str, document_id: &str, text: &str) -> Result<NotesImport, String> {
    let parsed = parse_notes(text);
    let previous: HashMap<(u32, String), Option<u32>> = {
        let mut stmt = conn
            .prepare("SELECT ordinal, label, assigned_slide FROM profile_notes_blocks WHERE document_id = ?1 AND manual = 1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![document_id], |r| Ok(((r.get::<_, u32>(0)?, r.get::<_, String>(1)?), r.get::<_, Option<u32>>(2)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    conn.execute("DELETE FROM profile_notes_blocks WHERE document_id = ?1", params![document_id])
        .map_err(|e| e.to_string())?;
    for (i, b) in parsed.iter().enumerate() {
        let key = (i as u32, b.label.clone());
        let (assigned, manual) = match previous.get(&key) {
            Some(a) => (*a, 1),
            None => (b.detected, 0),
        };
        conn.execute(
            "INSERT INTO profile_notes_blocks (id, profile_id, document_id, ordinal, label, detected_slide, assigned_slide, text, manual)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![uuid::Uuid::new_v4().to_string(), profile_id, document_id, i as u32, b.label, b.detected, assigned, b.text, manual],
        )
        .map_err(|e| e.to_string())?;
    }
    let blocks = list_blocks(conn, profile_id, None)?
        .into_iter()
        .filter(|b| b.document_id == document_id)
        .collect::<Vec<_>>();
    Ok(NotesImport {
        document_id: document_id.to_string(),
        blocks: blocks.len(),
        matched: blocks.iter().filter(|b| b.status == "ok").count(),
        unassigned: blocks.iter().filter(|b| b.status == "unassigned").count(),
        duplicates: blocks.iter().filter(|b| b.status == "duplicate").count(),
    })
}

/// All blocks of a meeting with their mapping status. `slide_count` (the
/// loaded deck's size, when known) enables the out-of-range check.
pub fn list_blocks(conn: &Connection, profile_id: &str, slide_count: Option<u32>) -> Result<Vec<NotesBlock>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, document_id, ordinal, label, detected_slide, assigned_slide, text, manual
             FROM profile_notes_blocks WHERE profile_id = ?1 ORDER BY document_id, ordinal",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![profile_id], |r| {
            Ok(NotesBlock {
                id: r.get(0)?,
                document_id: r.get(1)?,
                ordinal: r.get(2)?,
                label: r.get(3)?,
                detected_slide: r.get(4)?,
                assigned_slide: r.get(5)?,
                text: r.get(6)?,
                manual: r.get::<_, i64>(7)? != 0,
                status: String::new(),
            })
        })
        .map_err(|e| e.to_string())?;
    let mut blocks: Vec<NotesBlock> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    let mut per_slide: HashMap<u32, usize> = HashMap::new();
    for b in &blocks {
        if let Some(s) = b.assigned_slide {
            *per_slide.entry(s).or_default() += 1;
        }
    }
    for b in &mut blocks {
        b.status = match b.assigned_slide {
            None => "unassigned",
            Some(s) if slide_count.is_some_and(|n| n > 0 && s > n) => "out_of_range",
            Some(s) if per_slide.get(&s).copied().unwrap_or(0) > 1 => "duplicate",
            Some(_) => "ok",
        }
        .into();
    }
    Ok(blocks)
}

/// Assigns a block to a slide (or `None` to leave it unused). Marks it manual.
pub fn assign(conn: &Connection, profile_id: &str, block_id: &str, slide: Option<u32>) -> Result<(), String> {
    if slide == Some(0) {
        return Err("Slide numbers start at 1.".into());
    }
    let changed = conn
        .execute(
            "UPDATE profile_notes_blocks SET assigned_slide = ?3, manual = 1 WHERE id = ?1 AND profile_id = ?2",
            params![block_id, profile_id, slide],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That notes block does not belong to this meeting.".into());
    }
    Ok(())
}

pub fn remove_document(conn: &Connection, document_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM profile_notes_blocks WHERE document_id = ?1", params![document_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// External notes per slide: blocks assigned to the same slide are joined in
/// document order (and reported as `duplicate` by [`list_blocks`]).
pub fn external_by_slide(conn: &Connection, profile_id: &str) -> Result<HashMap<u32, (String, usize)>, String> {
    let mut map: HashMap<u32, (String, usize)> = HashMap::new();
    for b in list_blocks(conn, profile_id, None)? {
        let Some(slide) = b.assigned_slide else { continue };
        if b.text.trim().is_empty() {
            continue;
        }
        let entry = map.entry(slide).or_insert((String::new(), 0));
        if entry.1 > 0 {
            entry.0.push_str("\n\n");
        }
        entry.0.push_str(b.text.trim());
        entry.1 += 1;
    }
    Ok(map)
}

/// Which notes a slide shows. An edited copy always wins; between the other two
/// the meeting's priority decides, and a missing one falls through.
pub fn effective(
    priority: NotesPriority,
    edited: Option<&str>,
    external: Option<&str>,
    embedded: &str,
) -> (String, &'static str) {
    let non_empty = |s: &str| !s.trim().is_empty();
    if let Some(e) = edited.filter(|e| non_empty(e)) {
        return (e.to_string(), "edited");
    }
    let ext = external.filter(|e| non_empty(e));
    let emb = Some(embedded).filter(|e| non_empty(e));
    let ordered = match priority {
        NotesPriority::ExternalFirst => [(ext, "external"), (emb, "embedded")],
        NotesPriority::EmbeddedFirst => [(emb, "embedded"), (ext, "external")],
    };
    for (text, source) in ordered {
        if let Some(t) = text {
            return (t.to_string(), source);
        }
    }
    (String::new(), "none")
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether both sources exist and say different things (shown, never hidden).
pub fn differs(external: Option<&str>, embedded: &str) -> bool {
    match external {
        Some(e) if !e.trim().is_empty() && !embedded.trim().is_empty() => squash(e) != squash(embedded),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_slide_headings_are_split_into_blocks() {
        let b = parse_notes("# Slide 1\nIntroduction...\n\n# Slide 2\nResearch objectives...\n# Slide 3\nArchitecture...");
        let got: Vec<_> = b.iter().map(|b| (b.detected, b.text.as_str())).collect();
        assert_eq!(
            got,
            [(Some(1), "Introduction..."), (Some(2), "Research objectives..."), (Some(3), "Architecture...")]
        );
    }

    #[test]
    fn reasonable_heading_variations_are_recognised() {
        for (line, number, title) in [
            ("Slide 2:", 2, ""),
            ("SLIDE 07 | START 07:15 | END 08:35 | TARGET 01:20", 7, "START 07:15 | END 08:35 | TARGET 01:20"),
            ("## Slide 12 - Results", 12, "Results"),
            ("**Slide 4**", 4, ""),
            ("Slide #5", 5, ""),
            ("slide no. 6 — Method", 6, "Method"),
            ("Slide 8 of 16", 8, ""),
            ("# 9. Conclusions", 9, "Conclusions"),
            ("Page 3:", 3, ""),
            ("اسلاید ۴", 4, ""),
            ("## Slide ٣", 3, ""),
        ] {
            assert_eq!(slide_heading(line), Some((number, title.to_string())), "{line}");
        }
    }

    #[test]
    fn running_text_and_look_alikes_are_not_headings() {
        for line in [
            "Slide 3 shows the results of the experiment.",
            "On slide 4 we see the architecture.",
            "Slides are great",
            "Slide 3b",
            "Slide",
            "Slide 0",
            "The page 4 limit",
            "3. A numbered list item",
        ] {
            assert_eq!(slide_heading(line), None, "{line}");
        }
    }

    #[test]
    fn text_before_the_first_heading_and_headingless_files_stay_visible_but_unassigned() {
        let b = parse_notes("Preface text\n# Slide 1\nHello");
        assert_eq!(b[0].detected, None);
        assert!(b[0].label.contains("before"));
        assert_eq!(b[1].detected, Some(1));
        let plain = parse_notes("Just some notes\nwithout headings");
        assert_eq!(plain.len(), 1);
        assert_eq!(plain[0].detected, None);
        assert!(parse_notes("   \n").is_empty());
    }

    #[test]
    fn code_fences_and_rules_do_not_create_headings() {
        let b = parse_notes("# Slide 1\nSee:\n```\n# Slide 9\nnot a heading\n```\n---\nDone");
        assert_eq!(b.len(), 1);
        assert!(b[0].text.contains("# Slide 9") && b[0].text.ends_with("Done"));
    }

    #[test]
    fn priority_is_predictable_and_edits_always_win() {
        use NotesPriority::*;
        assert_eq!(effective(ExternalFirst, None, Some("ext"), "emb"), ("ext".into(), "external"));
        assert_eq!(effective(EmbeddedFirst, None, Some("ext"), "emb"), ("emb".into(), "embedded"));
        assert_eq!(effective(ExternalFirst, Some("mine"), Some("ext"), "emb"), ("mine".into(), "edited"));
        // A missing source falls through instead of showing nothing.
        assert_eq!(effective(ExternalFirst, None, None, "emb"), ("emb".into(), "embedded"));
        assert_eq!(effective(EmbeddedFirst, None, Some("ext"), "  "), ("ext".into(), "external"));
        assert_eq!(effective(ExternalFirst, Some("  "), None, ""), (String::new(), "none"));
        assert!(differs(Some("a b"), "a  c") && !differs(Some("a  b"), "a b") && !differs(None, "x"));
    }

    fn conn_with_profile() -> (Connection, String) {
        let conn = crate::profiles::store::test_conn();
        let p = crate::profiles::store::create_profile(
            &conn,
            crate::profiles::model::MeetingProfile { name: "A".into(), ..Default::default() },
        )
        .unwrap();
        (conn, p.id)
    }

    #[test]
    fn import_assigns_detected_slides_and_flags_duplicates_and_unassigned_blocks() {
        let (conn, p) = conn_with_profile();
        let r = import(&conn, &p, "doc1", "Intro\n# Slide 1\nA\n# Slide 2\nB\n# Slide 2\nB again\n# Slide 40\nC").unwrap();
        assert_eq!((r.blocks, r.matched, r.unassigned, r.duplicates), (5, 2, 1, 2));
        let blocks = list_blocks(&conn, &p, Some(16)).unwrap();
        let status: Vec<_> = blocks.iter().map(|b| b.status.as_str()).collect();
        assert_eq!(status, ["unassigned", "ok", "duplicate", "duplicate", "out_of_range"]);
        // Duplicates are both kept, in order, never silently dropped.
        let ext = external_by_slide(&conn, &p).unwrap();
        assert_eq!(ext[&2].0, "B\n\nB again");
    }

    #[test]
    fn manual_corrections_resolve_ambiguity_and_survive_a_reimport() {
        let (conn, p) = conn_with_profile();
        import(&conn, &p, "doc1", "# Slide 2\nB\n# Slide 2\nB again").unwrap();
        let second = list_blocks(&conn, &p, None).unwrap()[1].clone();
        assign(&conn, &p, &second.id, Some(3)).unwrap();
        let blocks = list_blocks(&conn, &p, None).unwrap();
        assert_eq!(blocks[0].status, "ok");
        assert_eq!((blocks[1].assigned_slide, blocks[1].manual), (Some(3), true));
        // The source document changed a little: the correction is kept.
        import(&conn, &p, "doc1", "# Slide 2\nB v2\n# Slide 2\nB again v2").unwrap();
        let again = list_blocks(&conn, &p, None).unwrap();
        assert_eq!(again[1].assigned_slide, Some(3));
        assert_eq!(again[1].text, "B again v2");
        assert!(assign(&conn, &p, &again[1].id, Some(0)).is_err());
        assert!(assign(&conn, "other-profile", &again[1].id, Some(1)).is_err());
        assign(&conn, &p, &again[1].id, None).unwrap();
        assert_eq!(list_blocks(&conn, &p, None).unwrap()[1].status, "unassigned");
    }
}
