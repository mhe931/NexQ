//! Tauri commands for meeting profiles. Thin wrappers over `crate::profiles`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{command, AppHandle, Manager, State};

use crate::db::DatabaseManager;
use crate::profiles::ingest::{self, IngestReport, Limits};
use crate::profiles::model::{MeetingProfile, PresentationSource, ProfileSummary, SourceFolder};
use crate::profiles::retrieval::{self, Hit};
use crate::profiles::store::{self, ProfileDocument, SlideRow};
use crate::profiles::{prompt, templates, ActiveProfile};
use crate::state::AppState;

fn database(state: &AppState) -> Result<Arc<Mutex<DatabaseManager>>, String> {
    state.database.clone().ok_or_else(|| "The database is not available.".to_string())
}

/// Runs `work` on a dedicated connection so imports never block other database users.
async fn with_connection<T, F>(state: &AppState, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
{
    let db = database(state)?;
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?.open_connection().map_err(|e| e.to_string())?;
        work(&conn)
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

fn quick<T>(state: &AppState, work: impl FnOnce(&rusqlite::Connection) -> Result<T, String>) -> Result<T, String> {
    let db = database(state)?;
    let guard = db.lock().map_err(|e| e.to_string())?;
    work(guard.connection())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCatalog {
    templates: Vec<templates::MeetingTemplate>,
    styles: Vec<templates::StyleProfile>,
}

#[command]
pub fn profile_catalog() -> TemplateCatalog {
    TemplateCatalog { templates: templates::templates(), styles: templates::style_profiles() }
}

#[command]
pub async fn profile_list(state: State<'_, AppState>) -> Result<Vec<ProfileSummary>, String> {
    quick(&state, |c| store::list_profiles(c))
}

#[command]
pub async fn profile_create(
    name: String,
    template: String,
    state: State<'_, AppState>,
) -> Result<MeetingProfile, String> {
    let profile = templates::profile_from_template(name.trim(), &template);
    quick(&state, |c| store::create_profile(c, profile))
}

#[command]
pub async fn profile_get(id: String, state: State<'_, AppState>) -> Result<MeetingProfile, String> {
    quick(&state, |c| store::get_profile(c, &id))
}

#[command]
pub async fn profile_save(profile: MeetingProfile, state: State<'_, AppState>) -> Result<MeetingProfile, String> {
    let saved = quick(&state, |c| store::save_profile(c, profile))?;
    refresh_active_if_same(&state, &saved);
    Ok(saved)
}

#[command]
pub async fn profile_duplicate(id: String, state: State<'_, AppState>) -> Result<MeetingProfile, String> {
    with_connection(&state, move |c| store::duplicate_profile(c, &id)).await
}

/// Deleting asks for confirmation in the UI; the backend refuses to delete the
/// profile of a running meeting.
#[command]
pub async fn profile_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if active_id(&state).as_deref() == Some(id.as_str()) {
        return Err("This meeting is active. End it before deleting.".into());
    }
    quick(&state, |c| store::delete_profile(c, &id))
}

#[command]
pub async fn profile_documents(profile_id: String, state: State<'_, AppState>) -> Result<Vec<ProfileDocument>, String> {
    quick(&state, |c| store::list_documents(c, &profile_id))
}

#[command]
pub async fn profile_add_files(
    profile_id: String,
    paths: Vec<String>,
    role: Option<String>,
    state: State<'_, AppState>,
) -> Result<IngestReport, String> {
    let role = role.unwrap_or_else(|| "reference".into());
    if role != "reference" && role != "instruction" {
        return Err("Role must be 'reference' or 'instruction'.".into());
    }
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let report = with_connection(&state, move |c| {
        ingest::ingest_files(c, &profile_id, &paths, &role, &Limits::default())
    })
    .await?;
    Ok(report)
}

/// Links a folder to the meeting (so it can be refreshed) and imports it.
#[command]
pub async fn profile_add_folder(
    profile_id: String,
    path: String,
    recursive: bool,
    kind: Option<String>,
    label: Option<String>,
    state: State<'_, AppState>,
) -> Result<IngestReport, String> {
    with_connection(&state, move |c| {
        let mut profile = store::get_profile(c, &profile_id)?;
        let folder = match profile.source_folders.iter_mut().find(|f| f.path == path) {
            Some(existing) => {
                existing.recursive = recursive;
                existing.clone()
            }
            None => {
                let folder = SourceFolder {
                    id: uuid::Uuid::new_v4().to_string(),
                    label: label.unwrap_or_else(|| {
                        std::path::Path::new(&path)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("Folder")
                            .to_string()
                    }),
                    kind: kind.unwrap_or_else(|| "local".into()),
                    path: path.clone(),
                    recursive,
                };
                profile.source_folders.push(folder.clone());
                folder
            }
        };
        let report = ingest::ingest_folder(c, &profile_id, &folder, &Limits::default())?;
        store::save_profile(c, profile)?;
        Ok(report)
    })
    .await
}

#[command]
pub async fn profile_remove_folder(
    profile_id: String,
    folder_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    quick(&state, |c| {
        let mut profile = store::get_profile(c, &profile_id)?;
        profile.source_folders.retain(|f| f.id != folder_id);
        store::save_profile(c, profile)?;
        let docs: Vec<_> = store::list_documents(c, &profile_id)?
            .into_iter()
            .filter(|d| d.folder_id.as_deref() == Some(folder_id.as_str()))
            .collect();
        for d in docs {
            store::remove_document(c, &profile_id, &d.id)?;
        }
        Ok(())
    })
}

#[command]
pub async fn profile_refresh(profile_id: String, state: State<'_, AppState>) -> Result<IngestReport, String> {
    with_connection(&state, move |c| ingest::refresh(c, &profile_id, &Limits::default())).await
}

#[command]
pub async fn profile_remove_document(
    profile_id: String,
    document_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    quick(&state, |c| store::remove_document(c, &profile_id, &document_id))
}

/// Designates a document as a user instruction file (or back to untrusted reference).
#[command]
pub async fn profile_set_document_role(
    profile_id: String,
    document_id: String,
    role: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let result = with_connection(&state, move |c| {
        let text = if role == "instruction" {
            let doc = store::list_documents(c, &profile_id)?
                .into_iter()
                .find(|d| d.id == document_id)
                .ok_or("That document does not belong to this meeting.")?;
            let extracted = crate::profiles::extract::extract(std::path::Path::new(&doc.source_path))?;
            Some(
                extracted.sections.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join("\n")
                    .chars().take(12_000).collect::<String>(),
            )
        } else {
            None
        };
        store::set_document_role(c, &profile_id, &document_id, &role, text.as_deref())?;
        Ok(profile_id)
    })
    .await?;
    reactivate_if_active(&state, &result);
    Ok(())
}

#[command]
pub async fn profile_set_presentation(
    profile_id: String,
    document_id: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    with_connection(&state, move |c| {
        let count = ingest::set_presentation(c, &profile_id, &document_id)?;
        let mut profile = store::get_profile(c, &profile_id)?;
        profile.presentation.source = PresentationSource::Pptx;
        profile.presentation.current_slide = 1;
        store::save_profile(c, profile)?;
        Ok(count)
    })
    .await
}

#[command]
pub async fn profile_slides(profile_id: String, state: State<'_, AppState>) -> Result<Vec<SlideRow>, String> {
    quick(&state, |c| store::list_slides(c, &profile_id))
}

#[command]
pub async fn profile_set_slide_notes(
    profile_id: String,
    slide_no: u32,
    notes: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    quick(&state, |c| store::set_slide_notes(c, &profile_id, slide_no, &notes))
}

#[command]
pub async fn profile_search(
    profile_id: String,
    query: String,
    top_k: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<Hit>, String> {
    quick(&state, |c| retrieval::search(c, &profile_id, &query, top_k.unwrap_or(5).min(20)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPreview {
    text: String,
    layers: Vec<&'static str>,
}

#[command]
pub async fn profile_preview_prompt(profile_id: String, state: State<'_, AppState>) -> Result<PromptPreview, String> {
    quick(&state, |c| {
        let profile = store::get_profile(c, &profile_id)?;
        let files = store::instruction_documents(c, &profile_id)?;
        let composed = prompt::compose_system_prompt(&profile, &files);
        Ok(PromptPreview { text: composed.text, layers: composed.layers })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    profile_id: String,
    layers: Vec<&'static str>,
    has_failover: bool,
    documents: usize,
    prompt_chars: usize,
}

fn build_active(state: &AppState, conn: &rusqlite::Connection, profile: MeetingProfile) -> Result<ActiveProfile, String> {
    let files = store::instruction_documents(conn, &profile.id)?;
    Ok(ActiveProfile::new(profile, &files, state.latency_book.clone()))
}

fn install(state: &AppState, active: &ActiveProfile) {
    if let Ok(mut slot) = state.active_profile.write() {
        *slot = Some(active.clone());
    }
    // The existing scenario mechanism carries the prompt to every provider path
    // (stateless providers and the Claude session alike).
    if let Ok(mut scenario) = state.active_scenario.write() {
        scenario.system_prompt = active.system_prompt.clone();
    }
}

#[command]
pub async fn profile_activate(profile_id: String, state: State<'_, AppState>) -> Result<Activation, String> {
    let (active, documents, layers) = quick(&state, |c| {
        let profile = store::get_profile(c, &profile_id)?;
        let documents = store::list_documents(c, &profile_id)?.len();
        let active = build_active(&state, c, profile)?;
        let layers = prompt::compose_system_prompt(&active.profile, &store::instruction_documents(c, &profile_id)?).layers;
        Ok((active, documents, layers))
    })?;
    install(&state, &active);
    Ok(Activation {
        profile_id,
        layers,
        has_failover: active.has_failover(),
        documents,
        prompt_chars: active.system_prompt.len(),
    })
}

#[command]
pub async fn profile_deactivate(state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut slot) = state.active_profile.write() {
        *slot = None;
    }
    if let Ok(mut scenario) = state.active_scenario.write() {
        scenario.system_prompt.clear();
    }
    Ok(())
}

fn active_id(state: &AppState) -> Option<String> {
    state.active_profile.read().ok()?.as_ref().map(|a| a.profile.id.clone())
}

fn refresh_active_if_same(state: &AppState, saved: &MeetingProfile) {
    if active_id(state).as_deref() != Some(saved.id.as_str()) {
        return;
    }
    let files = database(state)
        .ok()
        .and_then(|db| db.lock().ok().and_then(|g| store::instruction_documents(g.connection(), &saved.id).ok()))
        .unwrap_or_default();
    install(state, &ActiveProfile::new(saved.clone(), &files, state.latency_book.clone()));
}

fn reactivate_if_active(state: &AppState, profile_id: &str) {
    if active_id(state).as_deref() == Some(profile_id) {
        if let Ok(profile) = quick(state, |c| store::get_profile(c, profile_id)) {
            refresh_active_if_same(state, &profile);
        }
    }
}

#[command]
pub async fn profile_latency_stats(
    state: State<'_, AppState>,
) -> Result<Vec<crate::profiles::routing::LatencySnapshot>, String> {
    Ok(state.latency_book.lock().map_err(|e| e.to_string())?.snapshot())
}

#[command]
pub async fn profile_link_meeting(
    meeting_id: String,
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    quick(&state, |c| store::link_meeting(c, &meeting_id, &profile_id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    id: String,
    title: String,
    start_time: String,
}

#[command]
pub async fn profile_sessions(profile_id: String, state: State<'_, AppState>) -> Result<Vec<SessionRef>, String> {
    quick(&state, |c| {
        Ok(store::list_sessions(c, &profile_id)?
            .into_iter()
            .map(|(id, title, start_time)| SessionRef { id, title, start_time })
            .collect())
    })
}

#[command]
pub async fn profile_clear_sessions(profile_id: String, state: State<'_, AppState>) -> Result<usize, String> {
    quick(&state, |c| store::clear_sessions(c, &profile_id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    index: usize,
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    is_primary: bool,
}

/// Connected displays in physical pixels, primary first.
#[command]
pub async fn list_displays(app: AppHandle) -> Result<Vec<Display>, String> {
    let primary = app.primary_monitor().map_err(|e| e.to_string())?;
    let mut monitors = app.available_monitors().map_err(|e| e.to_string())?;
    monitors.sort_by_key(|m| {
        let is_primary = primary.as_ref().is_some_and(|p| p.position() == m.position() && p.size() == m.size());
        (!is_primary, m.position().x, m.position().y)
    });
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, m)| Display {
            index,
            name: m.name().cloned().unwrap_or_else(|| format!("Display {}", index + 1)),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale_factor: m.scale_factor(),
            is_primary: index == 0,
        })
        .collect())
}

/// Moves and resizes the presenter overlay without giving it keyboard focus.
#[command]
pub async fn place_overlay(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    app: AppHandle,
) -> Result<(), String> {
    let window = app.get_webview_window("overlay").ok_or("The overlay window is not available.")?;
    window.set_size(tauri::PhysicalSize::new(width.max(300), height.max(120))).map_err(|e| e.to_string())?;
    window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    Ok(())
}
