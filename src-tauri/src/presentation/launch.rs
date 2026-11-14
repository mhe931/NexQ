//! "Open and bind": takes the presentation a meeting profile was prepared with
//! and brings NexQ to a bound, verified connection with it.
//!
//! The report keeps five facts apart, because each can be true without the next:
//!  A. the presentation is imported and indexed in NexQ,
//!  B. the file was launched (or was already open),
//!  C. the presentation application was detected,
//!  D. NexQ is bound to exactly that presentation,
//!  E. slide navigation was verified by a read-back from the application.
//! E is never inferred from A–D.
//!
//! Safety rules: only the profile's own file is ever launched; it is launched
//! only when no open presentation already matches; an ambiguous match is left to
//! the user; no slide show, screen share or window move is started here.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::powerpoint::is_presentation_name;
use super::service::PresentationService;
use super::{BindingStatus, ConnectionState, Target, TargetKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StageState {
    Done,
    Failed,
    Skipped,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageReport {
    pub id: &'static str,
    pub label: &'static str,
    pub state: StageState,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchReport {
    pub stages: Vec<StageReport>,
    pub status: BindingStatus,
    /// The file that was (or would have been) opened, after resolving moved files.
    pub source_path: Option<String>,
    pub source_moved: bool,
    pub launched: bool,
    /// Open presentations that might be the right one when NexQ could not choose safely.
    pub candidates: Vec<Target>,
    pub summary: String,
}

#[derive(Debug, Clone)]
pub enum Source {
    File { path: PathBuf },
    Web { url: String },
    None,
}

#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub source: Source,
    /// Slides NexQ indexed from the imported file (`None`/0: not imported).
    pub indexed_slides: Option<u32>,
    /// Folders to look in when the saved path no longer exists (same file name only).
    pub search_dirs: Vec<PathBuf>,
    /// False for "bind to the open presentation": only look, never launch.
    pub allow_launch: bool,
    pub ready_timeout: Duration,
    pub poll_every: Duration,
}

// ── pure helpers ────────────────────────────────────────────────────────────

fn normalise(s: &str) -> String {
    s.trim().trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The file name of a path or URL (`https://…/My%20deck.pptx` → `my deck.pptx`), lowercase.
fn file_name_of(s: &str) -> String {
    let last = s.rsplit(['\\', '/']).next().unwrap_or(s);
    percent_decode(last).to_lowercase()
}

#[derive(Debug, Clone, PartialEq)]
pub enum Matched {
    /// The very file (same full path).
    Exact(Target),
    /// Same file name and slide count, but a different path form (a OneDrive/SharePoint URL).
    Likely(Target),
    /// Several open presentations could be it; NexQ will not guess.
    Ambiguous(Vec<Target>),
    NoneOpen,
}

/// Finds the open PowerPoint presentation that is `path`. Prefers the exact path;
/// accepts a unique same-name, same-slide-count presentation (cloud-synced decks
/// report a URL); never picks between several.
pub fn match_source(targets: &[Target], path: &Path, indexed_slides: Option<u32>) -> Matched {
    let wanted = normalise(&path.to_string_lossy());
    let pp: Vec<&Target> = targets.iter().filter(|t| t.kind == TargetKind::Powerpoint && t.id.starts_with("pp:")).collect();
    if let Some(t) = pp.iter().find(|t| normalise(t.id.trim_start_matches("pp:")) == wanted) {
        return Matched::Exact((*t).clone());
    }
    let name = file_name_of(&path.to_string_lossy());
    let same: Vec<&Target> = pp
        .into_iter()
        .filter(|t| file_name_of(&t.detail) == name || file_name_of(&t.title) == name)
        .filter(|t| match (indexed_slides.filter(|n| *n > 0), t.slide_count) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        })
        .collect();
    match same.len() {
        0 => Matched::NoneOpen,
        1 => Matched::Likely(same[0].clone()),
        _ => Matched::Ambiguous(same.into_iter().cloned().collect()),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Resolved {
    Found(PathBuf),
    /// The saved path is gone; one file with the same name exists in a known folder.
    Moved(PathBuf),
    Missing,
    /// Several same-named files in known folders: NexQ will not pick one.
    Ambiguous(Vec<PathBuf>),
}

pub fn resolve_source(path: &Path, search_dirs: &[PathBuf]) -> Resolved {
    if path.is_file() {
        return Resolved::Found(path.to_path_buf());
    }
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_lowercase()) else { return Resolved::Missing };
    let mut found: Vec<PathBuf> = Vec::new();
    let mut dirs: Vec<PathBuf> = search_dirs.to_vec();
    if let Some(parent) = path.parent() {
        dirs.push(parent.to_path_buf());
    }
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() && p.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase() == name) && !found.contains(&p) {
                found.push(p);
            }
        }
    }
    match found.len() {
        0 => Resolved::Missing,
        1 => Resolved::Moved(found.remove(0)),
        _ => Resolved::Ambiguous(found),
    }
}

fn is_google_slides_url(url: &str) -> bool {
    url.starts_with("https://docs.google.com/presentation/")
}

// ── orchestration ───────────────────────────────────────────────────────────

struct Builder {
    stages: Vec<StageReport>,
}

impl Builder {
    fn new(indexed: Option<u32>) -> Self {
        let imported = match indexed {
            Some(n) if n > 0 => (StageState::Done, format!("{n} slides are imported and indexed in NexQ.")),
            _ => (StageState::Failed, "No presentation is imported for this meeting yet.".to_string()),
        };
        let stage = |id, label, state, detail: String| StageReport { id, label, state, detail };
        Self {
            stages: vec![
                stage("imported", "Imported and indexed in NexQ", imported.0, imported.1),
                stage("launched", "Presentation file opened", StageState::Pending, String::new()),
                stage("app_detected", "Presentation application detected", StageState::Pending, String::new()),
                stage("bound", "NexQ bound to this presentation", StageState::Pending, String::new()),
                stage("navigation", "Slide navigation verified", StageState::Pending, String::new()),
            ],
        }
    }

    fn set(&mut self, id: &str, state: StageState, detail: impl Into<String>) {
        if let Some(s) = self.stages.iter_mut().find(|s| s.id == id) {
            s.state = state;
            s.detail = detail.into();
        }
    }

    /// Everything still pending is skipped, with the reason.
    fn skip_rest(&mut self, reason: &str) {
        for s in self.stages.iter_mut().filter(|s| s.state == StageState::Pending) {
            s.state = StageState::Skipped;
            s.detail = reason.to_string();
        }
    }

    fn finish(
        mut self,
        status: BindingStatus,
        source_path: Option<String>,
        source_moved: bool,
        launched: bool,
        candidates: Vec<Target>,
        summary: impl Into<String>,
    ) -> LaunchReport {
        self.skip_rest("Not reached.");
        LaunchReport { stages: self.stages, status, source_path, source_moved, launched, candidates, summary: summary.into() }
    }
}

fn wait_for_match(
    service: &PresentationService,
    plan: &LaunchPlan,
    path: &Path,
    saw_app: &mut bool,
) -> Result<Matched, String> {
    let started = Instant::now();
    loop {
        let targets = service.targets()?;
        if targets.iter().any(|t| t.kind == TargetKind::Powerpoint) {
            *saw_app = true;
        }
        match match_source(&targets, path, plan.indexed_slides) {
            Matched::NoneOpen => {}
            found => return Ok(found),
        }
        if started.elapsed() >= plan.ready_timeout {
            return Ok(Matched::NoneOpen);
        }
        std::thread::sleep(plan.poll_every);
    }
}

pub fn open_and_bind(service: &PresentationService, plan: &LaunchPlan) -> LaunchReport {
    let mut b = Builder::new(plan.indexed_slides);
    let disconnected = |m: &str| BindingStatus::disconnected(m);
    match &plan.source {
        Source::None => {
            b.set("launched", StageState::Skipped, "This meeting has no presentation file.");
            b.skip_rest("This meeting has no presentation file.");
            let m = "This meeting has no presentation. Import a PowerPoint file in the meeting setup, or bind an open presentation manually.";
            b.finish(disconnected(m), None, false, false, vec![], m)
        }
        Source::Web { url } => open_web(service, plan, b, url),
        Source::File { path } => open_file(service, plan, b, path),
    }
}

fn open_file(service: &PresentationService, plan: &LaunchPlan, mut b: Builder, saved: &Path) -> LaunchReport {
    let fail = |b: Builder, stage: &str, detail: String, source: Option<String>, moved: bool, launched: bool| {
        let mut b = b;
        b.set(stage, StageState::Failed, detail.clone());
        b.finish(BindingStatus::disconnected(detail.clone()), source, moved, launched, vec![], detail)
    };

    if !is_presentation_name(&saved.to_string_lossy()) {
        return fail(b, "launched", "Only a PowerPoint file (.pptx, .pptm, .ppsx …) can be opened here.".into(), None, false, false);
    }
    let (path, moved) = match resolve_source(saved, &plan.search_dirs) {
        Resolved::Found(p) => (p, false),
        Resolved::Moved(p) => (p, true),
        Resolved::Ambiguous(list) => {
            let names: Vec<String> = list.iter().map(|p| p.display().to_string()).collect();
            return fail(
                b,
                "launched",
                format!("{} was not found where it was imported from, and several copies exist ({}). Choose the right one in the meeting setup.", saved.display(), names.join("; ")),
                None,
                false,
                false,
            );
        }
        Resolved::Missing => {
            return fail(
                b,
                "launched",
                format!("{} no longer exists (moved, renamed or on a disconnected drive). Re-import it from its new location in the meeting setup.", saved.display()),
                None,
                false,
                false,
            );
        }
    };
    let source = Some(path.display().to_string());

    let mut saw_app = false;
    let first = match service.targets() {
        Ok(t) => t,
        Err(e) => return fail(b, "app_detected", e, source, moved, false),
    };
    if first.iter().any(|t| t.kind == TargetKind::Powerpoint) {
        saw_app = true;
    }
    let mut launched = false;
    let found = match match_source(&first, &path, plan.indexed_slides) {
        Matched::NoneOpen if !plan.allow_launch => {
            b.set("launched", StageState::Skipped, "Not opened: you asked to bind to an already open presentation.");
            if saw_app {
                b.set("app_detected", StageState::Done, "PowerPoint answered to automation.");
            }
            let msg = format!("{} is not open in PowerPoint. Choose Open presentation, or open it yourself and retry.", path.display());
            b.set("bound", StageState::Failed, msg.clone());
            return b.finish(BindingStatus::disconnected(msg.clone()), source, moved, false, vec![], msg);
        }
        Matched::NoneOpen => {
            if let Err(e) = service.launch_file(path.clone()) {
                return fail(b, "launched", e, source, moved, false);
            }
            launched = true;
            b.set("launched", StageState::Done, format!("Asked PowerPoint to open {}.", path.display()));
            match wait_for_match(service, plan, &path, &mut saw_app) {
                Ok(m) => m,
                Err(e) => return fail(b, "app_detected", e, source, moved, true),
            }
        }
        other => {
            b.set("launched", StageState::Skipped, "Already open in PowerPoint: it was not opened a second time.");
            other
        }
    };
    if saw_app {
        b.set("app_detected", StageState::Done, "PowerPoint answered to automation.");
    }

    let target = match found {
        Matched::Exact(t) | Matched::Likely(t) => t,
        Matched::Ambiguous(list) => {
            let msg = "Several open presentations could be this one. NexQ will not guess: choose the right one in the Bind dialog.".to_string();
            b.set("bound", StageState::Failed, msg.clone());
            return b.finish(BindingStatus::disconnected(msg.clone()), source, moved, launched, list, msg);
        }
        Matched::NoneOpen => {
            let msg = if saw_app {
                "PowerPoint is running but this presentation did not open in time (it may be waiting at a dialog, a sign-in or a repair prompt). Check PowerPoint, then choose Bind to open presentation.".to_string()
            } else {
                b.set("app_detected", StageState::Failed, "PowerPoint was not detected after opening the file.");
                "PowerPoint did not start or is not reachable (see the diagnostics).".to_string()
            };
            b.set("bound", StageState::Failed, msg.clone());
            return b.finish(BindingStatus::disconnected(msg.clone()), source, moved, launched, vec![], msg);
        }
    };

    let status = match service.bind(&target.id) {
        Ok(s) => s,
        Err(e) => {
            b.set("bound", StageState::Failed, e.clone());
            return b.finish(BindingStatus::disconnected(e.clone()), source, moved, launched, vec![], e);
        }
    };
    let bound_ok = status.target_id.is_some() && status.state != ConnectionState::Disconnected;
    if bound_ok {
        b.set("bound", StageState::Done, format!("Bound to {}.", target.detail));
    } else {
        b.set("bound", StageState::Failed, status.message.clone());
    }

    match status.state {
        ConnectionState::Connected | ConnectionState::OutOfSync => match service.verify_navigation() {
            Ok((slide, true)) => b.set("navigation", StageState::Done, format!("PowerPoint moved one slide away and back and confirmed slide {slide} (editing view, nobody watching).")),
            Ok((slide, false)) => b.set("navigation", StageState::Done, format!("PowerPoint accepted a go-to-current-slide command and read back slide {slide}. The live slide show was not disturbed; use Test navigation to see a visible move.")),
            Err(e) => b.set("navigation", StageState::Failed, e),
        },
        ConnectionState::Waiting => b.set("navigation", StageState::Skipped, status.message.clone()),
        ConnectionState::Unsupported => b.set("navigation", StageState::Skipped, "This presentation cannot be controlled from NexQ."),
        ConnectionState::Disconnected => b.set("navigation", StageState::Skipped, "Not bound."),
    }
    let nav_ok = b.stages.iter().any(|s| s.id == "navigation" && s.state == StageState::Done);
    let summary = if bound_ok && nav_ok {
        format!("Connected to {} and slide navigation verified.", target.title)
    } else if status.state == ConnectionState::Waiting {
        format!("Bound to {}; {}", target.title, status.message)
    } else if bound_ok {
        format!("Bound to {}, but slide navigation is not verified: {}", target.title, b.stages.iter().find(|s| s.id == "navigation").map(|s| s.detail.clone()).unwrap_or_default())
    } else {
        status.message.clone()
    };
    b.finish(status, source, moved, launched, vec![], summary)
}

fn open_web(service: &PresentationService, plan: &LaunchPlan, mut b: Builder, url: &str) -> LaunchReport {
    let fail = |mut b: Builder, stage: &str, detail: String, launched: bool| {
        b.set(stage, StageState::Failed, detail.clone());
        b.finish(BindingStatus::disconnected(detail.clone()), None, false, launched, vec![], detail)
    };
    if !is_google_slides_url(url) {
        return fail(b, "launched", "Only a https://docs.google.com/presentation/ link can be opened from NexQ.".into(), false);
    }
    let slides_windows = |t: &[Target]| t.iter().filter(|t| t.kind == TargetKind::GoogleSlides).cloned().collect::<Vec<_>>();
    let before = match service.targets() {
        Ok(t) => slides_windows(&t),
        Err(e) => return fail(b, "app_detected", e, false),
    };
    let mut launched = false;
    let mut windows = before.clone();
    if before.is_empty() && !plan.allow_launch {
        b.set("launched", StageState::Skipped, "Not opened: you asked to bind to an already open presentation.");
        let msg = "No Google Slides window is open in a browser.".to_string();
        b.set("bound", StageState::Failed, msg.clone());
        return b.finish(BindingStatus::disconnected(msg.clone()), None, false, false, vec![], msg);
    }
    if before.is_empty() {
        if let Err(e) = service.launch_url(url) {
            return fail(b, "launched", e, false);
        }
        launched = true;
        b.set("launched", StageState::Done, "Opened the link in your default browser.");
        let started = Instant::now();
        loop {
            windows = match service.targets() {
                Ok(t) => slides_windows(&t),
                Err(e) => return fail(b, "app_detected", e, true),
            };
            if !windows.is_empty() || started.elapsed() >= plan.ready_timeout {
                break;
            }
            std::thread::sleep(plan.poll_every);
        }
    } else {
        b.set("launched", StageState::Skipped, "A Google Slides window is already open: nothing was opened.");
    }
    match windows.len() {
        0 => {
            b.set("app_detected", StageState::Failed, "No browser window titled “… - Google Slides” appeared.");
            let msg = "The browser did not show a Google Slides window in time.".to_string();
            b.set("bound", StageState::Failed, msg.clone());
            b.finish(BindingStatus::disconnected(msg.clone()), None, false, launched, vec![], msg)
        }
        1 => {
            b.set("app_detected", StageState::Done, "A browser window with Google Slides was found by its title.");
            match service.bind(&windows[0].id) {
                Ok(status) => {
                    b.set("bound", StageState::Done, "Bound to the browser window (list-only).");
                    b.set("navigation", StageState::Skipped, "Google offers no slideshow-control API: NexQ cannot change or read the slide in a browser.");
                    let summary = status.message.clone();
                    b.finish(status, None, false, launched, vec![], summary)
                }
                Err(e) => {
                    b.set("bound", StageState::Failed, e.clone());
                    b.finish(BindingStatus::disconnected(e.clone()), None, false, launched, vec![], e)
                }
            }
        }
        _ => {
            b.set("app_detected", StageState::Done, "Several Google Slides windows are open.");
            let msg = "Several Google Slides windows are open; choose the right one in the Bind dialog.".to_string();
            b.set("bound", StageState::Failed, msg.clone());
            b.finish(BindingStatus::disconnected(msg.clone()), None, false, launched, windows, msg)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{Backend, BackendError, Position};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct World {
        /// id -> (slide, count, in_show, protected_view)
        decks: HashMap<String, (u32, u32, bool, bool)>,
        launched: Vec<PathBuf>,
        launched_urls: Vec<String>,
        /// Appears after this many listings once launched: (id, remaining, deck).
        pending: Option<(String, u32, (u32, u32, bool, bool))>,
        slides_windows: Vec<String>,
        /// goto requests the fake received, in order.
        calls: Vec<u32>,
        powerpoint_running: bool,
    }

    struct Fake(Arc<Mutex<World>>);

    fn target(id: &str, w: &World) -> Target {
        let (slide, count, show, pv) = w.decks[id];
        let full = id.trim_start_matches("pp:");
        let mut t = Target::new(id, TargetKind::Powerpoint, file_name_of(full), full);
        t.slide_count = Some(count);
        t.current_slide = if pv && !show { None } else { Some(slide) };
        t.slideshow_running = show;
        t.protected_view = pv;
        t
    }

    impl Backend for Fake {
        fn list(&mut self) -> Result<Vec<Target>, BackendError> {
            let mut w = self.0.lock().unwrap();
            if let Some((id, remaining, deck)) = w.pending.clone() {
                if remaining == 0 {
                    w.decks.insert(id, deck);
                    w.pending = None;
                } else {
                    w.pending = Some((id, remaining - 1, deck));
                }
            }
            let mut out: Vec<Target> = w.decks.keys().map(|id| target(id, &w)).collect();
            out.sort_by(|a, b| a.id.cmp(&b.id));
            for title in &w.slides_windows {
                let mut t = Target::new(format!("win:{title}"), TargetKind::GoogleSlides, title.clone(), "browser");
                t.supports_control = false;
                out.push(t);
            }
            Ok(out)
        }
        fn position(&mut self, id: &str) -> Result<Position, BackendError> {
            let w = self.0.lock().unwrap();
            let &(slide, slide_count, in_show, pv) = w.decks.get(id).ok_or_else(|| BackendError::Gone("closed".into()))?;
            if pv && !in_show {
                return Err(BackendError::NotReady("Protected View: start the slide show".into()));
            }
            Ok(Position { slide, slide_count, in_show })
        }
        fn goto(&mut self, id: &str, slide: u32) -> Result<Position, BackendError> {
            let mut w = self.0.lock().unwrap();
            w.calls.push(slide);
            let d = w.decks.get_mut(id).ok_or_else(|| BackendError::Gone("closed".into()))?;
            if d.3 && !d.2 {
                return Err(BackendError::NotReady("Protected View: start the slide show".into()));
            }
            d.0 = slide;
            Ok(Position { slide: d.0, slide_count: d.1, in_show: d.2 })
        }
        fn launch_file(&mut self, path: &Path) -> Result<(), BackendError> {
            let mut w = self.0.lock().unwrap();
            w.launched.push(path.to_path_buf());
            w.powerpoint_running = true;
            let id = format!("pp:{}", path.display());
            let deck = (1, 8, false, false);
            w.pending = Some((id, 2, deck));
            Ok(())
        }
        fn launch_url(&mut self, url: &str) -> Result<(), BackendError> {
            let mut w = self.0.lock().unwrap();
            w.launched_urls.push(url.to_string());
            w.slides_windows.push("Deck - Google Slides".into());
            Ok(())
        }
    }

    fn service(world: &Arc<Mutex<World>>) -> PresentationService {
        let world = world.clone();
        PresentationService::with_backend(Arc::new(move || Box::new(Fake(world.clone())) as Box<dyn Backend>))
    }

    fn plan_for(path: &Path, slides: Option<u32>) -> LaunchPlan {
        LaunchPlan {
            source: Source::File { path: path.to_path_buf() },
            indexed_slides: slides,
            search_dirs: vec![],
            allow_launch: true,
            ready_timeout: Duration::from_millis(500),
            poll_every: Duration::from_millis(1),
        }
    }

    struct TempFile(PathBuf);
    impl TempFile {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("nexq-launch-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.join(name);
            std::fs::write(&p, b"x").unwrap();
            Self(p)
        }
    }
    impl Drop for TempFile {
        fn drop(&mut self) {
            if let Some(d) = self.0.parent() {
                let _ = std::fs::remove_dir_all(d);
            }
        }
    }

    fn stage<'a>(r: &'a LaunchReport, id: &str) -> &'a StageReport {
        r.stages.iter().find(|s| s.id == id).unwrap()
    }

    #[test]
    fn a_closed_presentation_is_launched_waited_for_bound_and_navigation_verified() {
        let file = TempFile::new("Thesis.pptx");
        let world = Arc::new(Mutex::new(World::default()));
        let r = open_and_bind(&service(&world), &plan_for(&file.0, Some(8)));
        assert_eq!(world.lock().unwrap().launched, vec![file.0.clone()]);
        for id in ["imported", "launched", "app_detected", "bound", "navigation"] {
            assert_eq!(stage(&r, id).state, StageState::Done, "{id}: {:?}", stage(&r, id));
        }
        assert_eq!(r.status.state, ConnectionState::Connected);
        assert!(r.launched && !r.source_moved);
        assert_eq!(world.lock().unwrap().calls, vec![2, 1], "editing view: a real round trip, nobody is watching");
    }

    #[test]
    fn a_live_slide_show_is_bound_without_visibly_changing_slides() {
        let file = TempFile::new("Thesis.pptx");
        let world = Arc::new(Mutex::new(World::default()));
        world.lock().unwrap().decks.insert(format!("pp:{}", file.0.display()), (3, 8, true, false));
        let r = open_and_bind(&service(&world), &plan_for(&file.0, Some(8)));
        assert!(world.lock().unwrap().launched.is_empty(), "no second copy");
        assert_eq!(stage(&r, "launched").state, StageState::Skipped);
        assert_eq!(r.status.target_slide, Some(3));
        assert_eq!(stage(&r, "navigation").state, StageState::Done);
        assert_eq!(world.lock().unwrap().calls, vec![3], "only a request for the slide it is already on");
    }

    #[test]
    fn navigation_is_never_reported_verified_for_a_deck_that_cannot_be_read() {
        let file = TempFile::new("Thesis.pptx");
        let world = Arc::new(Mutex::new(World::default()));
        world.lock().unwrap().decks.insert(format!("pp:{}", file.0.display()), (1, 8, false, true));
        let r = open_and_bind(&service(&world), &plan_for(&file.0, Some(8)));
        assert_eq!(r.status.state, ConnectionState::Waiting);
        assert_eq!(stage(&r, "bound").state, StageState::Done);
        assert_eq!(stage(&r, "navigation").state, StageState::Skipped);
        assert!(world.lock().unwrap().calls.is_empty());
        assert_ne!(r.status.state, ConnectionState::Connected, "Protected View before the show is never CONNECTED");
    }

    #[test]
    fn a_protected_view_deck_becomes_connected_once_its_show_runs() {
        let file = TempFile::new("Thesis.pptx");
        let world = Arc::new(Mutex::new(World::default()));
        let id = format!("pp:{}", file.0.display());
        world.lock().unwrap().decks.insert(id.clone(), (1, 8, false, true));
        let svc = service(&world);
        assert_eq!(open_and_bind(&svc, &plan_for(&file.0, Some(8))).status.state, ConnectionState::Waiting);
        world.lock().unwrap().decks.get_mut(&id).unwrap().2 = true;
        let status = svc.status(None).unwrap();
        assert_eq!(status.state, ConnectionState::Connected);
        assert_eq!(svc.verify_navigation().unwrap(), (1, false));
    }

    #[test]
    fn a_missing_file_is_reported_and_nothing_unrelated_is_launched() {
        let world = Arc::new(Mutex::new(World::default()));
        world.lock().unwrap().decks.insert("pp:C:\\other\\unrelated.pptx".into(), (1, 3, false, false));
        let r = open_and_bind(&service(&world), &plan_for(Path::new("Z:\\gone\\Thesis.pptx"), Some(8)));
        assert!(world.lock().unwrap().launched.is_empty());
        assert_eq!(stage(&r, "launched").state, StageState::Failed);
        assert!(r.summary.contains("no longer exists"));
        assert_ne!(r.status.state, ConnectionState::Connected);
        assert_eq!(stage(&r, "bound").state, StageState::Skipped);
    }

    #[test]
    fn a_moved_file_is_found_by_name_in_a_known_folder_only_when_unique() {
        let a = TempFile::new("Thesis.pptx");
        let b = TempFile::new("Thesis.pptx");
        let ghost_dir = a.0.parent().unwrap().join("nexq-no-such-folder");
        let ghost = ghost_dir.join("Thesis.pptx");
        let ghost = ghost.as_path();
        let dir_a = a.0.parent().unwrap().to_path_buf();
        let dir_b = b.0.parent().unwrap().to_path_buf();
        assert_eq!(resolve_source(ghost, &[dir_a.clone()]), Resolved::Moved(a.0.clone()));
        assert!(matches!(resolve_source(ghost, &[dir_a, dir_b]), Resolved::Ambiguous(v) if v.len() == 2));
        assert_eq!(resolve_source(ghost, &[]), Resolved::Missing);
        assert_eq!(resolve_source(&a.0, &[]), Resolved::Found(a.0.clone()));
    }

    #[test]
    fn several_candidates_are_left_to_the_user_never_guessed() {
        let file = TempFile::new("Thesis.pptx");
        let world = Arc::new(Mutex::new(World::default()));
        {
            let mut w = world.lock().unwrap();
            w.decks.insert("pp:https://d.docs.live.net/1/Thesis.pptx".into(), (1, 8, false, false));
            w.decks.insert("pp:https://contoso.sharepoint.com/Thesis.pptx".into(), (1, 8, false, false));
        }
        let r = open_and_bind(&service(&world), &plan_for(&file.0, Some(8)));
        assert!(world.lock().unwrap().launched.is_empty(), "an ambiguous match must not launch a third copy");
        assert_eq!(r.candidates.len(), 2);
        assert_eq!(stage(&r, "bound").state, StageState::Failed);
        assert_ne!(r.status.state, ConnectionState::Connected);
    }

    #[test]
    fn a_cloud_synced_deck_reporting_a_url_matches_by_name_and_slide_count() {
        let t = |id: &str, n| {
            let mut t = Target::new(id, TargetKind::Powerpoint, "x", id.trim_start_matches("pp:"));
            t.slide_count = Some(n);
            t
        };
        let path = Path::new("C:\\Users\\me\\OneDrive\\Talks\\My deck.pptx");
        let open = [t("pp:https://d.docs.live.net/abc/My%20deck.pptx", 12)];
        assert!(matches!(match_source(&open, path, Some(12)), Matched::Likely(_)));
        assert_eq!(match_source(&open, path, Some(11)), Matched::NoneOpen, "a different slide count is a different deck");
        let exact = [t("pp:c:/users/me/onedrive/talks/my deck.pptx", 12)];
        assert!(matches!(match_source(&exact, path, Some(12)), Matched::Exact(_)));
        assert_eq!(match_source(&[t("pp:C:\\other\\Notes.pptx", 12)], path, Some(12)), Matched::NoneOpen);
    }

    #[test]
    fn a_launch_that_never_shows_up_is_a_failure_not_a_connection() {
        let file = TempFile::new("Thesis.pptx");
        let world = Arc::new(Mutex::new(World::default()));
        let mut plan = plan_for(&file.0, Some(8));
        plan.ready_timeout = Duration::from_millis(30);
        // The fake only shows the deck after 2 listings; with no pending deck (launch is ignored) it never appears.
        struct Mute(Arc<Mutex<World>>);
        impl Backend for Mute {
            fn list(&mut self) -> Result<Vec<Target>, BackendError> { Ok(vec![]) }
            fn position(&mut self, _: &str) -> Result<Position, BackendError> { Err(BackendError::Gone("x".into())) }
            fn goto(&mut self, _: &str, _: u32) -> Result<Position, BackendError> { Err(BackendError::Gone("x".into())) }
            fn launch_file(&mut self, p: &Path) -> Result<(), BackendError> {
                self.0.lock().unwrap().launched.push(p.to_path_buf());
                Ok(())
            }
        }
        let w = world.clone();
        let svc = PresentationService::with_backend(Arc::new(move || Box::new(Mute(w.clone())) as Box<dyn Backend>));
        let r = open_and_bind(&svc, &plan);
        assert_eq!(stage(&r, "launched").state, StageState::Done);
        assert_eq!(stage(&r, "app_detected").state, StageState::Failed);
        assert_eq!(stage(&r, "bound").state, StageState::Failed);
        assert_eq!(r.status.state, ConnectionState::Disconnected);
    }

    #[test]
    fn google_slides_is_opened_and_listed_but_reported_uncontrollable() {
        let world = Arc::new(Mutex::new(World::default()));
        let plan = LaunchPlan {
            source: Source::Web { url: "https://docs.google.com/presentation/d/abc/edit".into() },
            indexed_slides: None,
            search_dirs: vec![],
            allow_launch: true,
            ready_timeout: Duration::from_millis(200),
            poll_every: Duration::from_millis(1),
        };
        let r = open_and_bind(&service(&world), &plan);
        assert_eq!(world.lock().unwrap().launched_urls.len(), 1);
        assert_eq!(stage(&r, "bound").state, StageState::Done);
        assert_eq!(stage(&r, "navigation").state, StageState::Skipped);
        assert_eq!(r.status.state, ConnectionState::Unsupported);
        let bad = LaunchPlan { source: Source::Web { url: "https://evil.example/x".into() }, ..plan };
        let r = open_and_bind(&service(&world), &bad);
        assert_eq!(world.lock().unwrap().launched_urls.len(), 1, "only Google Slides links are opened");
        assert_eq!(stage(&r, "launched").state, StageState::Failed);
    }

    #[test]
    fn bind_only_mode_never_launches_anything() {
        let file = TempFile::new("Thesis.pptx");
        let world = Arc::new(Mutex::new(World::default()));
        let mut plan = plan_for(&file.0, Some(8));
        plan.allow_launch = false;
        let r = open_and_bind(&service(&world), &plan);
        assert!(world.lock().unwrap().launched.is_empty());
        assert_eq!(stage(&r, "launched").state, StageState::Skipped);
        assert_eq!(stage(&r, "bound").state, StageState::Failed);
        assert!(r.summary.contains("is not open"));
        world.lock().unwrap().decks.insert(format!("pp:{}", file.0.display()), (2, 8, true, false));
        assert_eq!(open_and_bind(&service(&world), &plan).status.state, ConnectionState::Connected);
    }

    #[test]
    fn file_names_are_read_from_paths_and_urls() {
        assert_eq!(file_name_of("C:\\a\\B.PPTX"), "b.pptx");
        assert_eq!(file_name_of("https://x/y/My%20Deck%2B1.pptx"), "my deck+1.pptx");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
