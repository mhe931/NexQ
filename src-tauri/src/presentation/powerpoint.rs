//! PowerPoint through its COM object model (desktop PowerPoint, user level).
//!
//! Discovery never relies on a window title or on the foreground window:
//!  * the active automation object (`GetActiveObject`),
//!  * every open document in the Running Object Table, which reaches PowerPoint
//!    instances `GetActiveObject` does not return,
//! and, for each instance, three collections — `Presentations` (editing),
//! `ProtectedViewWindows` (files from the internet or e-mail, which are *not* in
//! `Presentations`) and `SlideShowWindows`. Window enumeration is only a
//! diagnostic and a last-resort, uncontrollable listing.
//!
//! Navigation uses `View.GotoSlide` on the presentation's own slide show window
//! (or editing view), which neither focuses PowerPoint nor sends keystrokes, so
//! it cannot disturb Teams/Zoom or NexQ's own overlay. A presentation is
//! identified by its full path; a different file with a similar name is never
//! adopted.

use super::diagnostics::Diagnostics;
use super::{Backend, BackendError, Position, Target};
#[cfg(windows)]
use super::TargetKind;

/// Whether a Running Object Table display name is a presentation document.
pub fn is_presentation_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".pptx", ".pptm", ".ppt", ".ppsx", ".ppsm", ".pps", ".potx", ".potm", ".pot"].iter().any(|e| lower.ends_with(e))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::presentation::com::{is_registered, running_object, running_object_names, running_objects, ComError, Dispatch, Var};
    use crate::presentation::diagnostics::AppReport;
    use crate::presentation::pp_windows::{pid_of, powerpoint_windows, WindowRole};

    const PROTECTED_VIEW_NOTE: &str = "Opened in Protected View (a downloaded or e-mailed file). \
        NexQ can follow and drive its slide show; the slide is not readable before the show starts.";

    fn map(e: ComError) -> BackendError {
        match e {
            ComError::Gone(m) => BackendError::Gone(m),
            ComError::Busy(m) => BackendError::Busy(m),
            ComError::Other(m) => BackendError::Failed(m),
        }
    }

    #[derive(Clone)]
    struct AppEntry {
        pid: u32,
        app: Dispatch,
        source: &'static str,
    }

    #[derive(Clone)]
    struct Deck {
        full: String,
        name: String,
        pres: Dispatch,
        app: Dispatch,
        protected_view: bool,
    }

    impl Deck {
        fn id(&self) -> String {
            format!("pp:{}", self.full)
        }
    }

    fn add_app(apps: &mut Vec<AppEntry>, app: Dispatch, source: &'static str) {
        let pid = app.get_i32("HWND").ok().map(|h| pid_of(h as isize)).unwrap_or(0);
        if pid != 0 && apps.iter().any(|a| a.pid == pid) {
            return;
        }
        apps.push(AppEntry { pid, app, source });
    }

    /// Every reachable PowerPoint instance, deduplicated by process.
    fn discover(notes: &mut Vec<String>) -> Vec<AppEntry> {
        let mut apps = Vec::new();
        match running_object("PowerPoint.Application") {
            Ok(Some(app)) => add_app(&mut apps, app, "active object"),
            Ok(None) => {}
            Err(e) => notes.push(format!("Active automation object: {}", e.message())),
        }
        for (_, document) in running_objects(is_presentation_name) {
            if let Ok(app) = document.get_dispatch("Application") {
                add_app(&mut apps, app, "running object table");
            }
        }
        apps
    }

    fn push_deck(out: &mut Vec<Deck>, app: &Dispatch, pres: Dispatch, protected_view: bool) {
        let name = pres.get_string("Name").unwrap_or_default();
        let full = pres.get_string("FullName").unwrap_or_else(|_| name.clone());
        if full.is_empty() || out.iter().any(|d| d.full.eq_ignore_ascii_case(&full)) {
            return;
        }
        out.push(Deck { full, name, pres, app: app.clone(), protected_view });
    }

    fn collect_decks(entry: &AppEntry, busy: &mut Option<String>) -> Vec<Deck> {
        let mut out: Vec<Deck> = Vec::new();
        match entry.app.get_dispatch("Presentations") {
            Ok(col) => {
                for i in 1..=col.get_i32("Count").unwrap_or(0) {
                    match col.item(i) {
                        Ok(p) => push_deck(&mut out, &entry.app, p, false),
                        Err(ComError::Busy(m)) => *busy = Some(m),
                        Err(_) => {}
                    }
                }
            }
            Err(ComError::Busy(m)) => *busy = Some(m),
            Err(_) => {}
        }
        // Protected View windows hold their presentation outside `Presentations`.
        if let Ok(col) = entry.app.get_dispatch("ProtectedViewWindows") {
            for i in 1..=col.get_i32("Count").unwrap_or(0) {
                if let Some(p) = col.item(i).ok().and_then(|w| w.get_dispatch("Presentation").ok()) {
                    push_deck(&mut out, &entry.app, p, true);
                }
            }
        }
        if let Ok(col) = entry.app.get_dispatch("SlideShowWindows") {
            for i in 1..=col.get_i32("Count").unwrap_or(0) {
                if let Some(p) = col.item(i).ok().and_then(|w| w.get_dispatch("Presentation").ok()) {
                    push_deck(&mut out, &entry.app, p, false);
                }
            }
        }
        out
    }

    fn slide_count(deck: &Deck) -> Result<u32, BackendError> {
        Ok(deck.pres.get_dispatch("Slides").and_then(|s| s.get_i32("Count")).map_err(map)?.max(0) as u32)
    }

    /// The deck's own slide show view, wherever PowerPoint keeps it.
    fn show_view(deck: &Deck) -> Option<Dispatch> {
        if let Some(view) = deck.pres.get_dispatch("SlideShowWindow").ok().and_then(|w| w.get_dispatch("View").ok()) {
            return Some(view);
        }
        let windows = deck.app.get_dispatch("SlideShowWindows").ok()?;
        for i in 1..=windows.get_i32("Count").ok()? {
            let w = windows.item(i).ok()?;
            let pres = w.get_dispatch("Presentation").ok()?;
            if pres.get_string("FullName").ok().as_deref() == Some(deck.full.as_str()) {
                return w.get_dispatch("View").ok();
            }
        }
        None
    }

    fn edit_view(deck: &Deck) -> Option<Dispatch> {
        let windows = deck.pres.get_dispatch("Windows").ok()?;
        if windows.get_i32("Count").ok()? < 1 {
            return None;
        }
        windows.item(1).ok()?.get_dispatch("View").ok()
    }

    const PROTECTED_VIEW_WAIT: &str = "This presentation is open in Protected View. Start the slide show \
        (or click Enable Editing in PowerPoint) and NexQ will follow it.";

    fn read_position(deck: &Deck) -> Result<Position, BackendError> {
        let count = slide_count(deck)?;
        if let Some(view) = show_view(deck) {
            // `CurrentShowPosition` reads 0 right after a GotoSlide jump; the current
            // slide object's index is reliable (and is the number notes are keyed by).
            let slide = view
                .get_dispatch("Slide")
                .and_then(|s| s.get_i32("SlideIndex"))
                .or_else(|_| view.get_i32("CurrentShowPosition"))
                .map_err(map)?
                .max(0) as u32;
            return Ok(Position { slide, slide_count: count, in_show: true });
        }
        if deck.protected_view {
            return Err(BackendError::NotReady(PROTECTED_VIEW_WAIT.into()));
        }
        let view = edit_view(deck)
            .ok_or_else(|| BackendError::Failed("The presentation has no open window to navigate.".into()))?;
        let slide = view.get_dispatch("Slide").and_then(|s| s.get_i32("SlideIndex")).map_err(map)?.max(0) as u32;
        Ok(Position { slide, slide_count: count, in_show: false })
    }

    pub struct PowerPoint {
        apps: Vec<AppEntry>,
    }

    impl PowerPoint {
        pub fn new() -> Self {
            Self { apps: Vec::new() }
        }

        fn find_in(entries: &[AppEntry], full: &str, busy: &mut Option<String>) -> Option<Deck> {
            for entry in entries {
                if let Some(deck) = collect_decks(entry, busy).into_iter().find(|d| d.full.eq_ignore_ascii_case(full)) {
                    return Some(deck);
                }
            }
            None
        }

        /// Cached instances first (cheap while polling); a full discovery when the deck is not found.
        fn locate(&mut self, id: &str) -> Result<Deck, BackendError> {
            let full = id.strip_prefix("pp:").ok_or_else(|| BackendError::Failed("Not a PowerPoint target.".into()))?;
            let mut busy = None;
            // A cheap call proves a cached object is still alive.
            let alive: Vec<AppEntry> = self
                .apps
                .iter()
                .filter(|e| e.app.get_i32("HWND").is_ok() || e.app.get("Name").is_ok())
                .cloned()
                .collect();
            if let Some(deck) = Self::find_in(&alive, full, &mut busy) {
                return Ok(deck);
            }
            let mut notes = Vec::new();
            self.apps = discover(&mut notes);
            if let Some(deck) = Self::find_in(&self.apps, full, &mut busy) {
                return Ok(deck);
            }
            match busy {
                Some(m) => Err(BackendError::Busy(m)),
                None => Err(BackendError::Gone("The presentation was closed in PowerPoint.".into())),
            }
        }
    }

    impl Backend for PowerPoint {
        fn list(&mut self) -> Result<Vec<Target>, BackendError> {
            let mut notes = Vec::new();
            self.apps = discover(&mut notes);
            let mut busy = None;
            let mut out: Vec<Target> = Vec::new();
            for entry in &self.apps {
                for deck in collect_decks(entry, &mut busy) {
                    let id = deck.id();
                    if out.iter().any(|t| t.id.eq_ignore_ascii_case(&id)) {
                        continue;
                    }
                    let mut target = Target::new(id, TargetKind::Powerpoint, deck.name.clone(), deck.full.clone());
                    target.protected_view = deck.protected_view;
                    match read_position(&deck) {
                        Ok(p) => {
                            target.slideshow_running = p.in_show;
                            target.slide_count = Some(p.slide_count);
                            target.current_slide = Some(p.slide);
                            if deck.protected_view {
                                target.note = Some(PROTECTED_VIEW_NOTE.into());
                            }
                        }
                        Err(BackendError::NotReady(m)) => {
                            target.slide_count = slide_count(&deck).ok();
                            target.note = Some(m);
                        }
                        Err(_) => {}
                    }
                    out.push(target);
                }
            }
            if out.is_empty() {
                if let Some(m) = busy {
                    return Err(BackendError::Busy(m));
                }
            }
            // Windows PowerPoint shows whose process automation cannot reach: listed, never controlled.
            // Skipped when an instance's process is unknown (Protected View): its windows may be that instance's.
            let pids: Vec<u32> = self.apps.iter().map(|a| a.pid).collect();
            let unknown_pid = pids.contains(&0);
            for w in powerpoint_windows() {
                if unknown_pid || w.role == WindowRole::PresenterView || pids.contains(&w.pid) {
                    continue;
                }
                let mut target = Target::new(
                    format!("pw:{}", w.hwnd),
                    TargetKind::Powerpoint,
                    w.title.clone(),
                    format!("PowerPoint {} (process {})", w.role.label(), w.pid),
                );
                target.supports_control = false;
                target.slideshow_running = w.role == WindowRole::SlideShow;
                target.note = Some(
                    "PowerPoint shows this window, but NexQ cannot reach it through PowerPoint's automation interface \
                     (usually PowerPoint is running as administrator or as another Windows user). Notes follow your manual selection."
                        .into(),
                );
                out.push(target);
            }
            Ok(out)
        }

        fn position(&mut self, id: &str) -> Result<Position, BackendError> {
            let deck = self.locate(id)?;
            read_position(&deck)
        }

        fn goto(&mut self, id: &str, slide: u32) -> Result<Position, BackendError> {
            let deck = self.locate(id)?;
            let count = slide_count(&deck)? as i32;
            if slide as i32 > count {
                return Err(BackendError::Failed(format!("The presentation has only {count} slides.")));
            }
            let view = match show_view(&deck) {
                Some(v) => v,
                None if deck.protected_view => return Err(BackendError::NotReady(PROTECTED_VIEW_WAIT.into())),
                None => edit_view(&deck)
                    .ok_or_else(|| BackendError::Failed("The presentation has no open window to navigate.".into()))?,
            };
            view.call("GotoSlide", &[Var::int(slide as i32)]).map_err(map)?;
            read_position(&deck)
        }

        fn diagnose(&mut self) -> Diagnostics {
            let mut notes = Vec::new();
            let apps = discover(&mut notes);
            let mut busy = None;
            let mut report = Diagnostics { powerpoint_installed: is_registered("PowerPoint.Application"), ..Default::default() };
            for entry in &apps {
                let decks = collect_decks(entry, &mut busy);
                let count = |name: &str| {
                    entry.app.get_dispatch(name).and_then(|c| c.get_i32("Count")).unwrap_or(0).max(0) as u32
                };
                report.applications.push(AppReport {
                    pid: entry.pid,
                    version: entry.app.get_string("Version").unwrap_or_default(),
                    source: entry.source.to_string(),
                    presentations: count("Presentations"),
                    protected_view: count("ProtectedViewWindows"),
                    slide_shows: count("SlideShowWindows").max(decks.iter().filter(|d| show_view(d).is_some()).count() as u32),
                });
            }
            if let Some(m) = busy {
                notes.push(m);
            }
            report.running_object_entries = running_object_names().into_iter().filter(|n| is_presentation_name(n)).collect();
            report.notes = notes;
            self.apps = apps;
            report.with_windows(&powerpoint_windows())
        }

        fn launch_file(&mut self, path: &std::path::Path) -> Result<(), BackendError> {
            use crate::presentation::com::shell_open;
            if !is_registered("PowerPoint.Application") {
                return Err(BackendError::Failed(
                    "Desktop PowerPoint is not installed on this computer, so NexQ cannot open the presentation.".into(),
                ));
            }
            // PowerPoint itself (resolved through the App Paths registration), not whatever the .pptx
            // association points to: only PowerPoint can be bound and driven.
            if shell_open("powerpnt.exe", Some(&format!("\"{}\"", path.display()))) {
                return Ok(());
            }
            if shell_open(&path.to_string_lossy(), None) {
                return Ok(());
            }
            Err(BackendError::Failed(format!("Windows refused to open {}.", path.display())))
        }

        fn launch_url(&mut self, url: &str) -> Result<(), BackendError> {
            if crate::presentation::com::shell_open(url, None) {
                Ok(())
            } else {
                Err(BackendError::Failed("Windows refused to open the web presentation in a browser.".into()))
            }
        }
    }
}

#[cfg(windows)]
pub use imp::PowerPoint;

/// Other platforms have no PowerPoint automation here: nothing is listed.
#[cfg(not(windows))]
pub struct PowerPoint;

#[cfg(not(windows))]
impl PowerPoint {
    pub fn new() -> Self {
        Self
    }
}

#[cfg(not(windows))]
impl Backend for PowerPoint {
    fn list(&mut self) -> Result<Vec<Target>, BackendError> {
        Ok(Vec::new())
    }
    fn position(&mut self, _id: &str) -> Result<Position, BackendError> {
        Err(BackendError::Failed("PowerPoint control is only available on Windows.".into()))
    }
    fn goto(&mut self, _id: &str, _slide: u32) -> Result<Position, BackendError> {
        Err(BackendError::Failed("PowerPoint control is only available on Windows.".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_object_names_that_are_presentations_are_recognised() {
        assert!(is_presentation_name("C:\\talks\\Thesis Defence.PPTX"));
        assert!(is_presentation_name("https://d.docs.live.net/abc/deck.pptm"));
        assert!(is_presentation_name("D:\\show.ppsx"));
        assert!(!is_presentation_name("C:\\notes.docx"));
        assert!(!is_presentation_name("!{A4F0C1E2-0000-0000-0000-000000000000}"));
    }
}
