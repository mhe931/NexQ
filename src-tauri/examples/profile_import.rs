//! Creates or updates a meeting profile from the command line and imports its
//! documents into the app's database. Personal meeting definitions live
//! outside the repository; this tool contains none of them.
//!
//! ```text
//! cargo run --example profile_import -- --db-dir "%APPDATA%\com.nexq.app" \
//!     --name "My meeting" --template academic_qa --profile-json my-meeting.local.json \
//!     --file notes.docx --file paper.pdf --instruction style.md --presentation deck.pptx
//! ```
//! `--profile-json` holds a partial profile (same camelCase fields the app saves)
//! that is merged over the template. Re-running with the same `--name` updates
//! that meeting instead of creating a duplicate.

use std::path::PathBuf;

use nexq_lib::db::DatabaseManager;
use nexq_lib::profiles::ingest::{self, IngestReport, Limits};
use nexq_lib::profiles::model::MeetingProfile;
use nexq_lib::profiles::{store, templates};
use serde_json::Value;

fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(b), Value::Object(p)) => {
            for (k, v) in p {
                merge(b.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (b, p) => *b = p.clone(),
    }
}

fn main() -> Result<(), String> {
    let mut db_dir = None;
    let (mut name, mut template, mut json) = (None, "custom".to_string(), None);
    let (mut files, mut instructions, mut presentation) = (Vec::new(), Vec::new(), None);
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let mut value = || args.next().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--db-dir" => db_dir = Some(PathBuf::from(value()?)),
            "--name" => name = Some(value()?),
            "--template" => template = value()?,
            "--profile-json" => json = Some(PathBuf::from(value()?)),
            "--file" => files.push(PathBuf::from(value()?)),
            "--instruction" => instructions.push(PathBuf::from(value()?)),
            "--presentation" => presentation = Some(PathBuf::from(value()?)),
            other => return Err(format!("Unknown option {other}")),
        }
    }
    let db_dir = db_dir.ok_or("--db-dir is required")?;
    let name = name.ok_or("--name is required")?;
    let db = DatabaseManager::new(db_dir).map_err(|e| e.to_string())?;
    let conn = db.connection();

    let existing = store::list_profiles(conn)?.into_iter().find(|p| p.name == name);
    let mut value = match &existing {
        Some(p) => serde_json::to_value(store::get_profile(conn, &p.id)?).map_err(|e| e.to_string())?,
        None => serde_json::to_value(templates::profile_from_template(&name, &template)).map_err(|e| e.to_string())?,
    };
    if let Some(path) = json {
        let patch: Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        merge(&mut value, &patch);
    }
    let profile: MeetingProfile = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let profile = match existing {
        Some(_) => store::save_profile(conn, profile)?,
        None => store::create_profile(conn, profile)?,
    };
    println!("Meeting {} ({})", profile.name, profile.id);

    let limits = Limits::default();
    let mut total = IngestReport::default();
    for (paths, role) in [(&files, "reference"), (&instructions, "instruction")] {
        let r = ingest::ingest_files(conn, &profile.id, paths, role, &limits)?;
        total.added.extend(r.added);
        total.updated.extend(r.updated);
        total.unchanged.extend(r.unchanged);
        total.duplicates.extend(r.duplicates);
        total.failed.extend(r.failed);
        total.skipped.extend(r.skipped);
    }
    if let Some(deck) = presentation {
        let r = ingest::ingest_files(conn, &profile.id, &[deck.clone()], "reference", &limits)?;
        total.added.extend(r.added);
        total.updated.extend(r.updated);
        total.unchanged.extend(r.unchanged);
        total.failed.extend(r.failed);
        let doc = store::find_document_by_path(conn, &profile.id, &deck.to_string_lossy())?
            .ok_or("The presentation could not be imported")?;
        let slides = ingest::set_presentation(conn, &profile.id, &doc.id)?;
        let mut p = store::get_profile(conn, &profile.id)?;
        p.presentation.source = nexq_lib::profiles::model::PresentationSource::Pptx;
        store::save_profile(conn, p)?;
        println!("Presentation: {slides} slides with notes loaded");
    }
    println!(
        "Documents: {} added, {} updated, {} unchanged, {} duplicate, {} skipped, {} FAILED",
        total.added.len(), total.updated.len(), total.unchanged.len(),
        total.duplicates.len(), total.skipped.len(), total.failed.len()
    );
    for f in &total.failed {
        println!("  FAILED {}: {}", f.path, f.reason);
    }
    Ok(())
}
