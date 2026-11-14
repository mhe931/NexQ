//! PowerPoint through its COM object model (desktop PowerPoint, user level).
//!
//! Navigation uses `View.GotoSlide`, which neither focuses PowerPoint nor
//! sends keystrokes, so it cannot disturb Teams/Zoom or NexQ's own overlay.
//! A presentation is identified by its full path; a different file with a
//! similar name is never adopted.

use super::{Backend, BackendError, Position, Target, TargetKind};

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::presentation::com::{running_object, ComError, Dispatch, Var};

    fn map(e: ComError) -> BackendError {
        match e {
            ComError::Gone(m) => BackendError::Gone(m),
            ComError::Busy(m) => BackendError::Busy(m),
            ComError::Other(m) => BackendError::Failed(m),
        }
    }

    pub struct PowerPoint {
        app: Option<Dispatch>,
    }

    impl PowerPoint {
        pub fn new() -> Self {
            Self { app: None }
        }

        /// The running application, or `Gone` when PowerPoint is not open.
        fn app(&mut self) -> Result<Dispatch, BackendError> {
            if let Some(app) = &self.app {
                // A cheap call proves the cached object is still alive.
                if app.get_i32("Visible").is_ok() || app.get("Name").is_ok() {
                    return Ok(app.clone());
                }
                self.app = None;
            }
            match running_object("PowerPoint.Application").map_err(map)? {
                Some(app) => {
                    self.app = Some(app.clone());
                    Ok(app)
                }
                None => Err(BackendError::Gone("PowerPoint is not running. Open your presentation first.".into())),
            }
        }

        fn presentations(app: &Dispatch) -> Result<Vec<(String, String, Dispatch)>, BackendError> {
            let col = app.get_dispatch("Presentations").map_err(map)?;
            let count = col.get_i32("Count").map_err(map)?;
            let mut out = Vec::new();
            for i in 1..=count {
                let p = col.item(i).map_err(map)?;
                let full = p.get_string("FullName").map_err(map)?;
                let name = p.get_string("Name").map_err(map)?;
                out.push((full, name, p));
            }
            Ok(out)
        }

        fn show_window(app: &Dispatch, full_name: &str) -> Option<Dispatch> {
            let windows = app.get_dispatch("SlideShowWindows").ok()?;
            let count = windows.get_i32("Count").ok()?;
            for i in 1..=count {
                let w = windows.item(i).ok()?;
                let pres = w.get_dispatch("Presentation").ok()?;
                if pres.get_string("FullName").ok().as_deref() == Some(full_name) {
                    return Some(w);
                }
            }
            None
        }

        fn edit_view(pres: &Dispatch) -> Option<Dispatch> {
            let windows = pres.get_dispatch("Windows").ok()?;
            if windows.get_i32("Count").ok()? < 1 {
                return None;
            }
            windows.item(1).ok()?.get_dispatch("View").ok()
        }

        fn read_position(app: &Dispatch, pres: &Dispatch, full: &str) -> Result<Position, BackendError> {
            let slide_count = pres.get_dispatch("Slides").and_then(|s| s.get_i32("Count")).map_err(map)?.max(0) as u32;
            if let Some(w) = Self::show_window(app, full) {
                let view = w.get_dispatch("View").map_err(map)?;
                // `CurrentShowPosition` reads 0 right after a GotoSlide jump; the current
                // slide object's index is reliable (and is the number notes are keyed by).
                let slide = view
                    .get_dispatch("Slide")
                    .and_then(|s| s.get_i32("SlideIndex"))
                    .or_else(|_| view.get_i32("CurrentShowPosition"))
                    .map_err(map)?
                    .max(0) as u32;
                return Ok(Position { slide, slide_count, in_show: true });
            }
            let view = Self::edit_view(pres).ok_or_else(|| {
                BackendError::Failed("The presentation has no open window to navigate.".into())
            })?;
            let slide = view
                .get_dispatch("Slide")
                .and_then(|s| s.get_i32("SlideIndex"))
                .map_err(map)?
                .max(0) as u32;
            Ok(Position { slide, slide_count, in_show: false })
        }

        fn find(&mut self, id: &str) -> Result<(Dispatch, Dispatch, String), BackendError> {
            let full = id.strip_prefix("pp:").ok_or_else(|| BackendError::Failed("Not a PowerPoint target.".into()))?;
            let app = self.app()?;
            let found = Self::presentations(&app)?
                .into_iter()
                .find(|(f, _, _)| f.eq_ignore_ascii_case(full))
                .map(|(f, _, p)| (f, p));
            match found {
                Some((f, p)) => Ok((app, p, f)),
                None => Err(BackendError::Gone("The presentation was closed in PowerPoint.".into())),
            }
        }
    }

    impl Backend for PowerPoint {
        fn list(&mut self) -> Result<Vec<Target>, BackendError> {
            let app = match self.app() {
                Ok(app) => app,
                // Not running is a normal, empty result for a listing.
                Err(BackendError::Gone(_)) => return Ok(Vec::new()),
                Err(e) => return Err(e),
            };
            let mut out = Vec::new();
            for (full, name, pres) in Self::presentations(&app)? {
                let pos = Self::read_position(&app, &pres, &full).ok();
                out.push(Target {
                    id: format!("pp:{full}"),
                    kind: TargetKind::Powerpoint,
                    title: name,
                    detail: full,
                    supports_control: true,
                    slideshow_running: pos.as_ref().is_some_and(|p| p.in_show),
                    slide_count: pos.as_ref().map(|p| p.slide_count),
                    current_slide: pos.map(|p| p.slide),
                });
            }
            Ok(out)
        }

        fn position(&mut self, id: &str) -> Result<Position, BackendError> {
            let (app, pres, full) = self.find(id)?;
            Self::read_position(&app, &pres, &full)
        }

        fn goto(&mut self, id: &str, slide: u32) -> Result<Position, BackendError> {
            let (app, pres, full) = self.find(id)?;
            let count = pres.get_dispatch("Slides").and_then(|s| s.get_i32("Count")).map_err(map)?;
            if slide as i32 > count {
                return Err(BackendError::Failed(format!("The presentation has only {count} slides.")));
            }
            let view = match Self::show_window(&app, &full) {
                Some(w) => w.get_dispatch("View").map_err(map)?,
                None => Self::edit_view(&pres)
                    .ok_or_else(|| BackendError::Failed("The presentation has no open window to navigate.".into()))?,
            };
            view.call("GotoSlide", &[Var::int(slide as i32)]).map_err(map)?;
            Self::read_position(&app, &pres, &full)
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
