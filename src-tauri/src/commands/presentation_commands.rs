//! Tauri commands for presenting: binding to a presentation, synchronised
//! navigation, external speaker notes, per-meeting presenter preferences and fonts.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use tauri::{command, State};

use super::profile_commands::{quick, with_connection};
use crate::presentation::diagnostics::Diagnostics;
use crate::presentation::launch::{self, LaunchPlan, LaunchReport, Source};
use crate::presentation::{BindingStatus, ConnectionState, NavResult, Target};
use crate::profiles::ingest::{self, IngestReport, Limits, PresentationInfo};
use crate::profiles::model::{
    MeetingProfile, PresentationBinding, PresentationSettings, PresentationSource, TeleprompterSettings,
};
use crate::profiles::notes::{self, NotesBlock, NotesImport};
use crate::profiles::store;
use crate::state::AppState;

// ── binding and navigation ──────────────────────────────────────────────────

/// Presentations NexQ can bind to: open PowerPoint decks and Google Slides browser windows.
#[command]
pub async fn present_list_targets(state: State<'_, AppState>) -> Result<Vec<Target>, String> {
    let service = state.presentation.clone();
    tokio::task::spawn_blocking(move || service.targets()).await.map_err(|e| e.to_string())?
}

fn save_binding(state: &AppState, profile_id: &str, binding: Option<PresentationBinding>) -> Result<(), String> {
    quick(state, |c| {
        let mut profile = store::get_profile(c, profile_id)?;
        profile.presentation.binding = binding;
        store::save_profile(c, profile).map(|_| ())
    })
}

/// Binds this meeting to the presentation the user picked (never to "the focused window").
#[command]
pub async fn present_bind(profile_id: String, target_id: String, state: State<'_, AppState>) -> Result<BindingStatus, String> {
    let service = state.presentation.clone();
    let status = tokio::task::spawn_blocking(move || service.bind(&target_id)).await.map_err(|e| e.to_string())??;
    if let (Some(id), Some(title), Some(kind)) = (status.target_id.clone(), status.target_title.clone(), status.kind) {
        save_binding(&state, &profile_id, Some(PresentationBinding { id, title, kind, bound_at: Utc::now().to_rfc3339() }))?;
    }
    Ok(status)
}

#[command]
pub async fn present_disconnect(profile_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let service = state.presentation.clone();
    tokio::task::spawn_blocking(move || service.disconnect()).await.map_err(|e| e.to_string())??;
    save_binding(&state, &profile_id, None)
}

/// After a restart or reopening: checks that the saved target is still open, exactly.
#[command]
pub async fn present_revalidate(profile_id: String, state: State<'_, AppState>) -> Result<BindingStatus, String> {
    let binding = quick(&state, |c| Ok(store::get_profile(c, &profile_id)?.presentation.binding))?;
    let service = state.presentation.clone();
    match binding {
        None => tokio::task::spawn_blocking(move || service.status(None)).await.map_err(|e| e.to_string())?,
        Some(b) => tokio::task::spawn_blocking(move || service.revalidate(&b.id, &b.title, b.kind))
            .await
            .map_err(|e| e.to_string())?,
    }
}

/// `expected_slide` is the slide NexQ shows; a different slide in the presentation is OUT OF SYNC.
#[command]
pub async fn present_status(expected_slide: Option<u32>, state: State<'_, AppState>) -> Result<BindingStatus, String> {
    let service = state.presentation.clone();
    tokio::task::spawn_blocking(move || service.status(expected_slide)).await.map_err(|e| e.to_string())?
}

/// Moves the bound presentation to an absolute slide. Succeeds only when the
/// presentation confirms it; no LLM or network call is involved.
#[command]
pub async fn present_goto(slide: u32, state: State<'_, AppState>) -> Result<NavResult, String> {
    let service = state.presentation.clone();
    tokio::task::spawn_blocking(move || service.goto(slide)).await.map_err(|e| e.to_string())?
}

#[command]
pub async fn present_test_navigation(state: State<'_, AppState>) -> Result<NavResult, String> {
    let service = state.presentation.clone();
    tokio::task::spawn_blocking(move || service.test_navigation()).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    summary: String,
    #[serde(flatten)]
    details: Diagnostics,
}

/// Why presentations are or are not found: processes, windows and automation reachability.
#[command]
pub async fn present_diagnose(state: State<'_, AppState>) -> Result<DiagnosticsReport, String> {
    let service = state.presentation.clone();
    let details = tokio::task::spawn_blocking(move || service.diagnose()).await.map_err(|e| e.to_string())??;
    Ok(DiagnosticsReport { summary: details.summary(), details })
}

/// One launch at a time: a second click must not open the file twice.
static OPENING: AtomicBool = AtomicBool::new(false);

struct OpeningGuard;

impl OpeningGuard {
    fn acquire() -> Result<Self, String> {
        if OPENING.swap(true, Ordering::SeqCst) {
            Err("NexQ is already opening this presentation. Wait for it to finish.".into())
        } else {
            Ok(Self)
        }
    }
}

impl Drop for OpeningGuard {
    fn drop(&mut self) {
        OPENING.store(false, Ordering::SeqCst);
    }
}

const OPEN_WAIT: Duration = Duration::from_secs(30);
const OPEN_POLL: Duration = Duration::from_millis(600);

fn launch_plan(conn: &rusqlite::Connection, profile_id: &str, allow_launch: bool) -> Result<LaunchPlan, String> {
    let profile = store::get_profile(conn, profile_id)?;
    let info = ingest::presentation_info(conn, profile_id)?;
    let mut search_dirs: Vec<PathBuf> = profile.source_folders.iter().map(|f| PathBuf::from(&f.path)).collect();
    for doc in store::list_documents(conn, profile_id)? {
        if let Some(parent) = std::path::Path::new(&doc.source_path).parent() {
            let parent = parent.to_path_buf();
            if !search_dirs.contains(&parent) {
                search_dirs.push(parent);
            }
        }
    }
    let source = match (profile.presentation.source, &info) {
        (PresentationSource::GoogleSlides, _) if !profile.presentation.google_slides_url.trim().is_empty() => {
            Source::Web { url: profile.presentation.google_slides_url.trim().to_string() }
        }
        (_, Some(i)) => Source::File { path: PathBuf::from(&i.path) },
        _ => Source::None,
    };
    Ok(LaunchPlan {
        source,
        indexed_slides: info.map(|i| i.slide_count as u32),
        search_dirs,
        allow_launch,
        ready_timeout: OPEN_WAIT,
        poll_every: OPEN_POLL,
    })
}

/// Opens the meeting's own presentation when it is not open yet (`launch`), waits for it,
/// binds to exactly that document and verifies navigation. With `launch = false` it only
/// binds to an already open copy. Never starts a slide show or shares a screen.
#[command]
pub async fn present_open_and_bind(
    profile_id: String,
    launch: bool,
    state: State<'_, AppState>,
) -> Result<LaunchReport, String> {
    let _guard = OpeningGuard::acquire()?;
    let id = profile_id.clone();
    let plan = with_connection(&state, move |c| launch_plan(c, &id, launch)).await?;
    let service = state.presentation.clone();
    let report = tokio::task::spawn_blocking(move || launch::open_and_bind(&service, &plan))
        .await
        .map_err(|e| e.to_string())?;
    let status = &report.status;
    if let (Some(id), Some(title), Some(kind)) = (status.target_id.clone(), status.target_title.clone(), status.kind) {
        if status.state != ConnectionState::Disconnected {
            save_binding(&state, &profile_id, Some(PresentationBinding { id, title, kind, bound_at: Utc::now().to_rfc3339() }))?;
        }
    }
    Ok(report)
}

// ── presentation and external notes sources ─────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationImport {
    report: IngestReport,
    info: PresentationInfo,
}

#[command]
pub async fn profile_add_presentation(
    profile_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<PresentationImport, String> {
    let (report, info) = with_connection(&state, move |c| {
        ingest::add_presentation(c, &profile_id, &PathBuf::from(path), &Limits::default())
    })
    .await?;
    Ok(PresentationImport { report, info })
}

#[command]
pub async fn profile_presentation_info(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<Option<PresentationInfo>, String> {
    quick(&state, |c| ingest::presentation_info(c, &profile_id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesImportResult {
    report: IngestReport,
    summary: NotesImport,
}

#[command]
pub async fn profile_add_notes(
    profile_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<NotesImportResult, String> {
    let (report, summary) = with_connection(&state, move |c| {
        ingest::add_notes(c, &profile_id, &PathBuf::from(path), &Limits::default())
    })
    .await?;
    Ok(NotesImportResult { report, summary })
}

/// Mapping of every imported notes block (for the correction interface).
#[command]
pub async fn profile_notes_blocks(profile_id: String, state: State<'_, AppState>) -> Result<Vec<NotesBlock>, String> {
    quick(&state, |c| {
        let slide_count = store::list_slides(c, &profile_id)?.len() as u32;
        notes::list_blocks(c, &profile_id, Some(slide_count))
    })
}

/// Assigns a notes block to a slide, or `None` to leave it unused.
#[command]
pub async fn profile_notes_assign(
    profile_id: String,
    block_id: String,
    slide: Option<u32>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    quick(&state, |c| notes::assign(c, &profile_id, &block_id, slide))
}

// ── per-meeting presenter preferences ───────────────────────────────────────

fn update_profile(
    state: &AppState,
    profile_id: &str,
    change: impl FnOnce(&mut MeetingProfile) -> Result<(), String>,
) -> Result<MeetingProfile, String> {
    // Read-modify-write under one lock so a concurrent edit elsewhere is not clobbered.
    quick(state, |c| {
        let mut profile = store::get_profile(c, profile_id)?;
        change(&mut profile)?;
        store::save_profile(c, profile)
    })
}

/// Typography, colours, opacity and window size, saved with the meeting.
#[command]
pub async fn profile_update_teleprompter(
    profile_id: String,
    settings: TeleprompterSettings,
    state: State<'_, AppState>,
) -> Result<TeleprompterSettings, String> {
    update_profile(&state, &profile_id, |p| {
        p.environment.teleprompter = settings;
        Ok(())
    })
    .map(|p| p.environment.teleprompter)
}

/// Notes priority, reverse-sync and keyboard shortcuts. The binding is managed
/// by `present_bind` / `present_disconnect` and is kept as stored.
#[command]
pub async fn profile_update_presentation(
    profile_id: String,
    settings: PresentationSettings,
    state: State<'_, AppState>,
) -> Result<PresentationSettings, String> {
    update_profile(&state, &profile_id, |p| {
        let binding = p.presentation.binding.clone();
        p.presentation = PresentationSettings { binding, ..settings };
        Ok(())
    })
    .map(|p| p.presentation)
}

/// The one-time, per-meeting transcription acknowledgement (not asked again).
#[command]
pub async fn profile_set_listening_consent(
    profile_id: String,
    confirmed: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    update_profile(&state, &profile_id, |p| {
        p.audio.listening_consent_confirmed = confirmed;
        p.audio.listening_acknowledged_at = confirmed.then(|| Utc::now().to_rfc3339());
        Ok(())
    })
    .map(|_| ())
}

/// Installed font families for the font picker (with Persian-capable fallbacks).
#[command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(crate::profiles::fonts::installed_font_families)
        .await
        .map_err(|e| e.to_string())
}
