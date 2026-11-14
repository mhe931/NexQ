//! SQLite persistence for meeting profiles and their documents.
//!
//! Every document, chunk and slide row carries its `profile_id`; all reads are
//! filtered by it, which is what keeps one meeting's context out of another's.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::model::{MeetingProfile, ProfileSummary};

pub fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meeting_profiles (
            id          TEXT PRIMARY KEY NOT NULL,
            name        TEXT NOT NULL,
            data        TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profile_documents (
            id            TEXT PRIMARY KEY NOT NULL,
            profile_id    TEXT NOT NULL REFERENCES meeting_profiles(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            source_path   TEXT NOT NULL,
            source_kind   TEXT NOT NULL DEFAULT 'file',
            folder_id     TEXT,
            role          TEXT NOT NULL DEFAULT 'reference',
            file_type     TEXT NOT NULL,
            size_bytes    INTEGER NOT NULL DEFAULT 0,
            content_hash  TEXT NOT NULL,
            mtime_ms      INTEGER NOT NULL DEFAULT 0,
            status        TEXT NOT NULL DEFAULT 'indexed',
            error         TEXT,
            chunk_count   INTEGER NOT NULL DEFAULT 0,
            preview       TEXT NOT NULL DEFAULT '',
            instruction_text TEXT,
            indexed_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_profile_documents_profile
            ON profile_documents(profile_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS profile_fts USING fts5(
            text,
            profile_id UNINDEXED,
            document_id UNINDEXED,
            locator UNINDEXED,
            ordinal UNINDEXED
        );

        CREATE TABLE IF NOT EXISTS profile_slides (
            profile_id      TEXT NOT NULL REFERENCES meeting_profiles(id) ON DELETE CASCADE,
            slide_no        INTEGER NOT NULL,
            document_id     TEXT NOT NULL,
            title           TEXT NOT NULL DEFAULT '',
            body            TEXT NOT NULL DEFAULT '',
            notes_original  TEXT NOT NULL DEFAULT '',
            notes_edited    TEXT,
            PRIMARY KEY (profile_id, slide_no)
        );
        ",
    )?;
    super::notes::migrate(conn)?;
    // Session history: the meeting row records which profile it ran under.
    if let Err(e) = conn.execute("ALTER TABLE meetings ADD COLUMN profile_id TEXT", []) {
        if !e.to_string().contains("duplicate column") {
            return Err(e);
        }
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_meetings_profile_id ON meetings(profile_id);",
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDocument {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub source_path: String,
    pub source_kind: String,
    pub folder_id: Option<String>,
    /// `reference` (untrusted data) or `instruction` (user-designated).
    pub role: String,
    pub file_type: String,
    pub size_bytes: i64,
    pub content_hash: String,
    pub mtime_ms: i64,
    /// `indexed`, `failed` or `missing`.
    pub status: String,
    pub error: Option<String>,
    pub chunk_count: i64,
    pub preview: String,
    pub indexed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlideRow {
    pub slide_no: u32,
    pub document_id: String,
    pub title: String,
    pub body: String,
    pub notes_original: String,
    pub notes_edited: Option<String>,
    /// Notes from a separately imported speaker-notes document, if mapped here.
    #[serde(default)]
    pub notes_external: Option<String>,
    /// What the presenter view shows, by the meeting's priority (see `notes::effective`).
    #[serde(default)]
    pub effective_notes: String,
    /// `edited`, `external`, `embedded` or `none`.
    #[serde(default)]
    pub notes_source: String,
    /// `ok`, `differ` (embedded and external disagree), `duplicate` (several external
    /// blocks on this slide) or `missing`.
    #[serde(default)]
    pub notes_status: String,
}

impl SlideRow {
    /// The notes to show: the meeting's edited copy, else the original.
    pub fn notes(&self) -> &str {
        self.notes_edited.as_deref().unwrap_or(&self.notes_original)
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn create_profile(conn: &Connection, mut profile: MeetingProfile) -> Result<MeetingProfile, String> {
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    profile.created_at = now();
    profile.updated_at = profile.created_at.clone();
    profile.validate()?;
    let data = serde_json::to_string(&profile).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meeting_profiles (id, name, data, created_at, updated_at) VALUES (?1,?2,?3,?4,?5)",
        params![profile.id, profile.name, data, profile.created_at, profile.updated_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(profile)
}

pub fn get_profile(conn: &Connection, id: &str) -> Result<MeetingProfile, String> {
    let data: Option<String> = conn
        .query_row("SELECT data FROM meeting_profiles WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let data = data.ok_or_else(|| format!("Meeting {id} was not found."))?;
    serde_json::from_str(&data).map_err(|e| format!("Saved meeting is unreadable: {e}"))
}

/// Saves edits to one profile. Only that profile's row is written.
pub fn save_profile(conn: &Connection, mut profile: MeetingProfile) -> Result<MeetingProfile, String> {
    profile.validate()?;
    let existing = get_profile(conn, &profile.id)?;
    profile.created_at = existing.created_at;
    profile.updated_at = now();
    let data = serde_json::to_string(&profile).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE meeting_profiles SET name = ?2, data = ?3, updated_at = ?4 WHERE id = ?1",
        params![profile.id, profile.name, data, profile.updated_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(profile)
}

pub fn list_profiles(conn: &Connection) -> Result<Vec<ProfileSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.data,
                    (SELECT COUNT(*) FROM profile_documents d WHERE d.profile_id = p.id),
                    (SELECT COUNT(*) FROM meetings m WHERE m.profile_id = p.id),
                    (SELECT MAX(m.start_time) FROM meetings m WHERE m.profile_id = p.id),
                    (SELECT d.name FROM profile_documents d
                       WHERE d.profile_id = p.id AND d.id = (SELECT s.document_id FROM profile_slides s
                                                              WHERE s.profile_id = p.id ORDER BY s.slide_no LIMIT 1))
             FROM meeting_profiles p ORDER BY p.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, u32>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (data, documents, sessions, last_used_at, presentation_name) = row.map_err(|e| e.to_string())?;
        let p: MeetingProfile = match serde_json::from_str(&data) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("Skipping unreadable meeting profile: {e}");
                continue;
            }
        };
        out.push(ProfileSummary {
            id: p.id,
            name: p.name,
            meeting_type: p.meeting_type,
            platform: p.platform,
            meeting_date: p.meeting_date,
            primary_provider: p.ai.primary_provider,
            primary_model: p.ai.primary_model,
            document_count: documents,
            session_count: sessions,
            updated_at: p.updated_at,
            last_used_at,
            presentation_name,
        });
    }
    Ok(out)
}

/// Copies a profile with its documents, chunks and slides under a new id.
/// The copy shares nothing with the original afterwards.
pub fn duplicate_profile(conn: &Connection, id: &str) -> Result<MeetingProfile, String> {
    let mut copy = get_profile(conn, id)?;
    let new_id = uuid::Uuid::new_v4().to_string();
    copy.id = new_id.clone();
    copy.name = format!("{} (copy)", copy.name);
    for folder in &mut copy.source_folders {
        folder.id = uuid::Uuid::new_v4().to_string();
    }
    let created = create_profile(conn, copy)?;

    let docs = list_documents(conn, id)?;
    for doc in docs {
        let new_doc_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO profile_documents (id, profile_id, name, source_path, source_kind, folder_id, role,
                file_type, size_bytes, content_hash, mtime_ms, status, error, chunk_count, preview,
                instruction_text, indexed_at)
             SELECT ?3, ?2, name, source_path, source_kind, NULL, role, file_type, size_bytes, content_hash,
                mtime_ms, status, error, chunk_count, preview, instruction_text, indexed_at
             FROM profile_documents WHERE id = ?1",
            params![doc.id, new_id, new_doc_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO profile_fts (text, profile_id, document_id, locator, ordinal)
             SELECT text, ?2, ?3, locator, ordinal FROM profile_fts WHERE document_id = ?1",
            params![doc.id, new_id, new_doc_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO profile_slides (profile_id, slide_no, document_id, title, body, notes_original, notes_edited)
             SELECT ?2, slide_no, ?3, title, body, notes_original, notes_edited
             FROM profile_slides WHERE profile_id = ?4 AND document_id = ?1",
            params![doc.id, new_id, new_doc_id, id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO profile_notes_blocks (id, profile_id, document_id, ordinal, label, detected_slide, assigned_slide, text, manual)
             SELECT lower(hex(randomblob(16))), ?2, ?3, ordinal, label, detected_slide, assigned_slide, text, manual
             FROM profile_notes_blocks WHERE document_id = ?1",
            params![doc.id, new_id, new_doc_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(created)
}

/// Deletes a profile and everything it owns. Sessions it ran keep their
/// transcripts but are unlinked from the profile.
pub fn delete_profile(conn: &Connection, id: &str) -> Result<(), String> {
    get_profile(conn, id)?;
    conn.execute("DELETE FROM profile_fts WHERE profile_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM profile_slides WHERE profile_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM profile_notes_blocks WHERE profile_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM profile_documents WHERE profile_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("UPDATE meetings SET profile_id = NULL WHERE profile_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meeting_profiles WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn doc_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProfileDocument> {
    Ok(ProfileDocument {
        id: r.get(0)?,
        profile_id: r.get(1)?,
        name: r.get(2)?,
        source_path: r.get(3)?,
        source_kind: r.get(4)?,
        folder_id: r.get(5)?,
        role: r.get(6)?,
        file_type: r.get(7)?,
        size_bytes: r.get(8)?,
        content_hash: r.get(9)?,
        mtime_ms: r.get(10)?,
        status: r.get(11)?,
        error: r.get(12)?,
        chunk_count: r.get(13)?,
        preview: r.get(14)?,
        indexed_at: r.get(15)?,
    })
}

const DOC_COLUMNS: &str = "id, profile_id, name, source_path, source_kind, folder_id, role, file_type, \
    size_bytes, content_hash, mtime_ms, status, error, chunk_count, preview, indexed_at";

pub fn list_documents(conn: &Connection, profile_id: &str) -> Result<Vec<ProfileDocument>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {DOC_COLUMNS} FROM profile_documents WHERE profile_id = ?1 ORDER BY name COLLATE NOCASE"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![profile_id], doc_from_row).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn find_document_by_path(
    conn: &Connection,
    profile_id: &str,
    source_path: &str,
) -> Result<Option<ProfileDocument>, String> {
    conn.query_row(
        &format!("SELECT {DOC_COLUMNS} FROM profile_documents WHERE profile_id = ?1 AND source_path = ?2"),
        params![profile_id, source_path],
        doc_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn find_document_by_hash(
    conn: &Connection,
    profile_id: &str,
    content_hash: &str,
) -> Result<Option<ProfileDocument>, String> {
    conn.query_row(
        &format!(
            "SELECT {DOC_COLUMNS} FROM profile_documents
             WHERE profile_id = ?1 AND content_hash = ?2 AND status = 'indexed' LIMIT 1"
        ),
        params![profile_id, content_hash],
        doc_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn remove_document(conn: &Connection, profile_id: &str, document_id: &str) -> Result<(), String> {
    let removed = conn
        .execute(
            "DELETE FROM profile_documents WHERE id = ?1 AND profile_id = ?2",
            params![document_id, profile_id],
        )
        .map_err(|e| e.to_string())?;
    if removed == 0 {
        return Err("That document does not belong to this meeting.".into());
    }
    conn.execute("DELETE FROM profile_fts WHERE document_id = ?1", params![document_id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM profile_slides WHERE profile_id = ?1 AND document_id = ?2",
        params![profile_id, document_id],
    )
    .map_err(|e| e.to_string())?;
    super::notes::remove_document(conn, document_id)?;
    Ok(())
}

pub fn set_document_role(
    conn: &Connection,
    profile_id: &str,
    document_id: &str,
    role: &str,
    instruction_text: Option<&str>,
) -> Result<(), String> {
    if role != "reference" && role != "instruction" {
        return Err("Role must be 'reference' or 'instruction'.".into());
    }
    let changed = conn
        .execute(
            "UPDATE profile_documents SET role = ?3, instruction_text = ?4
             WHERE id = ?1 AND profile_id = ?2",
            params![document_id, profile_id, role, if role == "instruction" { instruction_text } else { None }],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That document does not belong to this meeting.".into());
    }
    Ok(())
}

/// Text of the documents the user explicitly designated as instructions.
pub fn instruction_documents(conn: &Connection, profile_id: &str) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name, COALESCE(instruction_text, '') FROM profile_documents
             WHERE profile_id = ?1 AND role = 'instruction' AND status = 'indexed' ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![profile_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn list_slides(conn: &Connection, profile_id: &str) -> Result<Vec<SlideRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT slide_no, document_id, title, body, notes_original, notes_edited
             FROM profile_slides WHERE profile_id = ?1 ORDER BY slide_no",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![profile_id], |r| {
            Ok(SlideRow {
                slide_no: r.get(0)?,
                document_id: r.get(1)?,
                title: r.get(2)?,
                body: r.get(3)?,
                notes_original: r.get(4)?,
                notes_edited: r.get(5)?,
                notes_external: None,
                effective_notes: String::new(),
                notes_source: String::new(),
                notes_status: String::new(),
            })
        })
        .map_err(|e| e.to_string())?;
    let mut slides: Vec<SlideRow> = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if slides.is_empty() {
        return Ok(slides);
    }
    let priority = get_profile(conn, profile_id)
        .map(|p| p.presentation.notes_priority)
        .unwrap_or(super::model::NotesPriority::ExternalFirst);
    let external = super::notes::external_by_slide(conn, profile_id)?;
    for s in &mut slides {
        let ext = external.get(&s.slide_no);
        s.notes_external = ext.map(|(text, _)| text.clone());
        let (text, source) = super::notes::effective(
            priority, s.notes_edited.as_deref(), s.notes_external.as_deref(), &s.notes_original,
        );
        s.effective_notes = text;
        s.notes_source = source.to_string();
        s.notes_status = if ext.is_some_and(|(_, n)| *n > 1) {
            "duplicate"
        } else if super::notes::differs(s.notes_external.as_deref(), &s.notes_original) {
            "differ"
        } else if source == "none" {
            "missing"
        } else {
            "ok"
        }
        .into();
    }
    Ok(slides)
}

/// Saves the meeting's own copy of a slide's notes; the imported file is untouched.
/// An empty string restores the original notes.
pub fn set_slide_notes(
    conn: &Connection,
    profile_id: &str,
    slide_no: u32,
    notes: &str,
) -> Result<(), String> {
    let value = if notes.is_empty() { None } else { Some(notes) };
    let changed = conn
        .execute(
            "UPDATE profile_slides SET notes_edited = ?3 WHERE profile_id = ?1 AND slide_no = ?2",
            params![profile_id, slide_no, value],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("This meeting has no slide {slide_no}."));
    }
    Ok(())
}

pub fn link_meeting(conn: &Connection, meeting_id: &str, profile_id: &str) -> Result<(), String> {
    get_profile(conn, profile_id)?;
    conn.execute(
        "UPDATE meetings SET profile_id = ?2 WHERE id = ?1",
        params![meeting_id, profile_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Meetings (sessions) that ran under a profile, newest first.
pub fn list_sessions(conn: &Connection, profile_id: &str) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, start_time FROM meetings WHERE profile_id = ?1 ORDER BY start_time DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![profile_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Removes every session record of a profile (transcripts included).
pub fn clear_sessions(conn: &Connection, profile_id: &str) -> Result<usize, String> {
    let ids: Vec<String> = list_sessions(conn, profile_id)?.into_iter().map(|s| s.0).collect();
    for id in &ids {
        for table in [
            "transcript_segments", "meeting_speakers", "meeting_bookmarks",
            "meeting_topic_sections", "meeting_action_items", "meeting_chat",
            "transcript_translations",
        ] {
            conn.execute(&format!("DELETE FROM {table} WHERE meeting_id = ?1"), params![id])
                .map_err(|e| e.to_string())?;
        }
        conn.execute("DELETE FROM meetings WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    }
    Ok(ids.len())
}

#[cfg(test)]
pub(crate) fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::model::{MeetingType, Strategy};

    fn named(name: &str) -> MeetingProfile {
        MeetingProfile { name: name.into(), ..Default::default() }
    }

    #[test]
    fn two_meetings_keep_distinct_settings_and_survive_reopening() {
        let conn = test_conn();
        let mut a = create_profile(&conn, named("Defense")).unwrap();
        let mut b = create_profile(&conn, named("Interview")).unwrap();
        a.meeting_type = MeetingType::PresentationQa;
        a.system_prompt = "Academic prompt".into();
        a.ai.primary_provider = Some("gemini".into());
        a.ai.primary_model = Some("gemini-flash".into());
        b.meeting_type = MeetingType::Interview;
        b.system_prompt = "Interview prompt".into();
        b.ai.primary_provider = Some("openai".into());
        b.ai.strategy = Strategy::Fast;
        save_profile(&conn, a.clone()).unwrap();
        save_profile(&conn, b.clone()).unwrap();

        // "Restart": read everything back through fresh queries.
        let a2 = get_profile(&conn, &a.id).unwrap();
        let b2 = get_profile(&conn, &b.id).unwrap();
        assert_eq!(a2.system_prompt, "Academic prompt");
        assert_eq!(a2.ai.primary_provider.as_deref(), Some("gemini"));
        assert_eq!(b2.system_prompt, "Interview prompt");
        assert_eq!(b2.ai.primary_provider.as_deref(), Some("openai"));
        assert_eq!(b2.ai.strategy, Strategy::Fast);
        assert_eq!(a2.ai.strategy, Strategy::Balanced);
        assert_eq!(list_profiles(&conn).unwrap().len(), 2);
    }

    #[test]
    fn saving_one_profile_never_touches_another() {
        let conn = test_conn();
        let a = create_profile(&conn, named("A")).unwrap();
        let b = create_profile(&conn, named("B")).unwrap();
        let before = get_profile(&conn, &b.id).unwrap();
        let mut edited = a.clone();
        edited.additional_instructions = "Only for A".into();
        save_profile(&conn, edited).unwrap();
        assert_eq!(get_profile(&conn, &b.id).unwrap(), before);
    }

    #[test]
    fn duplicates_are_independent_and_deletion_is_scoped() {
        let conn = test_conn();
        let a = create_profile(&conn, named("A")).unwrap();
        let copy = duplicate_profile(&conn, &a.id).unwrap();
        assert_eq!(copy.name, "A (copy)");
        assert_ne!(copy.id, a.id);
        let mut edited = copy.clone();
        edited.system_prompt = "changed".into();
        save_profile(&conn, edited).unwrap();
        assert_eq!(get_profile(&conn, &a.id).unwrap().system_prompt, "");
        delete_profile(&conn, &copy.id).unwrap();
        assert!(get_profile(&conn, &copy.id).is_err());
        assert!(get_profile(&conn, &a.id).is_ok());
    }

    #[test]
    fn profiles_with_credentials_are_not_persisted() {
        let conn = test_conn();
        let mut p = named("Leaky");
        p.additional_instructions = "key = sk-abcdefghijklmnopqrstuvwxyz123456".into();
        assert!(create_profile(&conn, p).is_err());
        assert!(list_profiles(&conn).unwrap().is_empty());
    }
}
