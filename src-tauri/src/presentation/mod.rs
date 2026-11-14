//! Binding NexQ to a real presentation and navigating it.
//!
//! The [`Controller`] is backend-agnostic: PowerPoint is driven through COM
//! (`powerpoint`), and browser windows (Google Slides) are only *listed*,
//! because no supported API lets another application drive a Google Slides
//! slideshow. Rules enforced here, independent of backend:
//!  * a target is matched by its exact identity, never "whatever is focused";
//!  * navigation is absolute (`goto(n)`), so a repeated request cannot advance twice;
//!  * success is reported only when the target read-back equals the request.

pub mod browsers;
#[cfg(windows)]
pub mod com;
pub mod powerpoint;
pub mod service;

use serde::{Deserialize, Serialize};

pub use crate::profiles::model::BoundKind as TargetKind;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Stable identity (`pp:<full path>` for PowerPoint).
    pub id: String,
    pub kind: TargetKind,
    pub title: String,
    pub detail: String,
    /// False when NexQ can only list the target (Google Slides in a browser).
    pub supports_control: bool,
    pub slideshow_running: bool,
    pub slide_count: Option<u32>,
    pub current_slide: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Connected,
    Disconnected,
    Unsupported,
    OutOfSync,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BindingStatus {
    pub state: ConnectionState,
    pub target_title: Option<String>,
    pub target_id: Option<String>,
    pub kind: Option<TargetKind>,
    pub target_slide: Option<u32>,
    pub slide_count: Option<u32>,
    pub slideshow_running: bool,
    pub message: String,
}

impl BindingStatus {
    pub fn disconnected(message: impl Into<String>) -> Self {
        Self {
            state: ConnectionState::Disconnected,
            target_title: None,
            target_id: None,
            kind: None,
            target_slide: None,
            slide_count: None,
            slideshow_running: false,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NavResult {
    /// The slide the presentation confirmed after the request.
    pub confirmed_slide: u32,
    pub status: BindingStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Position {
    pub slide: u32,
    pub slide_count: u32,
    pub in_show: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BackendError {
    /// The bound target no longer exists (closed).
    Gone(String),
    /// The application is installed/running but did not answer in time or refused.
    Busy(String),
    Failed(String),
}

impl BackendError {
    pub fn message(&self) -> &str {
        match self {
            Self::Gone(m) | Self::Busy(m) | Self::Failed(m) => m,
        }
    }
}

pub trait Backend {
    fn list(&mut self) -> Result<Vec<Target>, BackendError>;
    /// Current position of exactly the target `id`.
    fn position(&mut self, id: &str) -> Result<Position, BackendError>;
    /// Moves exactly the target `id` to `slide` (1-based) and returns what it reports.
    fn goto(&mut self, id: &str, slide: u32) -> Result<Position, BackendError>;
}

#[derive(Debug, Clone)]
struct Bound {
    id: String,
    title: String,
    kind: TargetKind,
    controllable: bool,
}

pub struct Controller<B: Backend> {
    backend: B,
    bound: Option<Bound>,
}

impl<B: Backend> Controller<B> {
    pub fn new(backend: B) -> Self {
        Self { backend, bound: None }
    }

    pub fn targets(&mut self) -> Result<Vec<Target>, String> {
        self.backend.list().map_err(|e| e.message().to_string())
    }

    fn status_for(&self, bound: &Bound, position: Result<Position, BackendError>, expected: Option<u32>) -> BindingStatus {
        let base = |state, slide: Option<u32>, count, show, message: String| BindingStatus {
            state,
            target_title: Some(bound.title.clone()),
            target_id: Some(bound.id.clone()),
            kind: Some(bound.kind),
            target_slide: slide,
            slide_count: count,
            slideshow_running: show,
            message,
        };
        match position {
            Ok(p) => match expected {
                Some(e) if e != p.slide => base(
                    ConnectionState::OutOfSync,
                    Some(p.slide),
                    Some(p.slide_count),
                    p.in_show,
                    format!("The presentation is on slide {} but NexQ shows slide {e}.", p.slide),
                ),
                _ => base(
                    ConnectionState::Connected,
                    Some(p.slide),
                    Some(p.slide_count),
                    p.in_show,
                    if p.in_show { "Connected (slide show running)".into() } else { "Connected (editing view)".into() },
                ),
            },
            Err(e) => base(ConnectionState::Disconnected, None, None, false, e.message().to_string()),
        }
    }

    /// Binds to the target `id` chosen by the user from [`targets`](Self::targets).
    pub fn bind(&mut self, id: &str) -> Result<BindingStatus, String> {
        let targets = self.backend.list().map_err(|e| e.message().to_string())?;
        let target = targets
            .into_iter()
            .find(|t| t.id == id)
            .ok_or("That window is no longer available. Open it and choose Bind again.")?;
        let bound = Bound {
            id: target.id.clone(),
            title: target.title.clone(),
            kind: target.kind,
            controllable: target.supports_control,
        };
        self.bound = Some(bound.clone());
        if !bound.controllable {
            return Ok(unsupported(&bound));
        }
        let pos = self.backend.position(&bound.id);
        Ok(self.status_for(&bound, pos, None))
    }

    pub fn disconnect(&mut self) {
        self.bound = None;
    }

    pub fn is_bound(&self) -> bool {
        self.bound.is_some()
    }

    /// Re-finds a previously saved binding by identity after a restart.
    /// Succeeds only when exactly that target is currently open.
    pub fn revalidate(&mut self, id: &str, title: &str, kind: TargetKind) -> BindingStatus {
        match self.backend.list() {
            Ok(targets) => {
                if targets.iter().any(|t| t.id == id) {
                    self.bind(id).unwrap_or_else(BindingStatus::disconnected)
                } else {
                    self.bound = None;
                    let mut s = BindingStatus::disconnected(format!("“{title}” is not open. Open it, then choose Rebind."));
                    s.target_title = Some(title.to_string());
                    s.target_id = Some(id.to_string());
                    s.kind = Some(kind);
                    s
                }
            }
            Err(e) => BindingStatus::disconnected(e.message().to_string()),
        }
    }

    /// `expected` is the slide NexQ currently shows; a difference is OUT OF SYNC.
    pub fn status(&mut self, expected: Option<u32>) -> BindingStatus {
        let Some(bound) = self.bound.clone() else {
            return BindingStatus::disconnected("No presentation is bound.");
        };
        if !bound.controllable {
            return unsupported(&bound);
        }
        let pos = self.backend.position(&bound.id);
        self.status_for(&bound, pos, expected)
    }

    /// Moves the bound presentation to `slide`. Fails (and says why) rather
    /// than guessing: unbound, uncontrollable, closed, out of range or not confirmed.
    pub fn goto(&mut self, slide: u32) -> Result<NavResult, String> {
        let bound = self.bound.clone().ok_or("No presentation is bound.")?;
        if !bound.controllable {
            return Err(unsupported(&bound).message);
        }
        if slide == 0 {
            return Err("Slide numbers start at 1.".into());
        }
        let pos = self.backend.goto(&bound.id, slide).map_err(|e| e.message().to_string())?;
        if pos.slide != slide {
            return Err(format!(
                "{} reported slide {} instead of slide {slide}; NexQ did not change slides.",
                bound.title, pos.slide
            ));
        }
        let status = self.status_for(&bound, Ok(pos.clone()), Some(slide));
        Ok(NavResult { confirmed_slide: pos.slide, status })
    }

    /// Visible round trip: one slide away and back. Proves navigation works.
    pub fn test_navigation(&mut self) -> Result<NavResult, String> {
        let bound = self.bound.clone().ok_or("No presentation is bound.")?;
        if !bound.controllable {
            return Err(unsupported(&bound).message);
        }
        let start = self.backend.position(&bound.id).map_err(|e| e.message().to_string())?;
        if start.slide_count < 2 {
            return Err("The presentation needs at least two slides to test navigation.".into());
        }
        let away = if start.slide < start.slide_count { start.slide + 1 } else { start.slide - 1 };
        self.goto(away)?;
        self.goto(start.slide)
    }
}

fn unsupported(bound: &Bound) -> BindingStatus {
    BindingStatus {
        state: ConnectionState::Unsupported,
        target_title: Some(bound.title.clone()),
        target_id: Some(bound.id.clone()),
        kind: Some(bound.kind),
        target_slide: None,
        slide_count: None,
        slideshow_running: false,
        message: match bound.kind {
            TargetKind::GoogleSlides => "Google Slides cannot be controlled from NexQ (Google offers no slideshow-control API). NexQ notes follow your manual selection; change the slide in the browser yourself.".into(),
            _ => "NexQ can list this window but cannot control it. Use manual slide selection.".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Fake {
        /// id -> (slide, count, in_show)
        decks: HashMap<String, (u32, u32, bool)>,
        browsers: Vec<Target>,
        /// Every navigation the backend was asked to perform: (id, slide).
        calls: Vec<(String, u32)>,
        /// When set, goto reports this slide instead of the requested one.
        stuck_at: Option<u32>,
        busy: bool,
    }

    fn pp(id: &str, title: &str) -> Target {
        Target {
            id: id.into(), kind: TargetKind::Powerpoint, title: title.into(), detail: String::new(),
            supports_control: true, slideshow_running: false, slide_count: None, current_slide: None,
        }
    }

    impl Fake {
        fn with(decks: &[(&str, u32, u32)]) -> Self {
            let mut f = Fake::default();
            for (id, slide, count) in decks {
                f.decks.insert(id.to_string(), (*slide, *count, false));
            }
            f
        }
    }

    impl Backend for Fake {
        fn list(&mut self) -> Result<Vec<Target>, BackendError> {
            let mut out: Vec<Target> = self.decks.keys().map(|id| pp(id, id.trim_start_matches("pp:"))).collect();
            out.sort_by(|a, b| a.id.cmp(&b.id));
            out.extend(self.browsers.clone());
            Ok(out)
        }
        fn position(&mut self, id: &str) -> Result<Position, BackendError> {
            if self.busy {
                return Err(BackendError::Busy("PowerPoint is busy".into()));
            }
            self.decks
                .get(id)
                .map(|&(slide, slide_count, in_show)| Position { slide, slide_count, in_show })
                .ok_or_else(|| BackendError::Gone("The presentation was closed.".into()))
        }
        fn goto(&mut self, id: &str, slide: u32) -> Result<Position, BackendError> {
            self.calls.push((id.to_string(), slide));
            let (cur, count, show) = self.decks.get_mut(id).ok_or_else(|| BackendError::Gone("The presentation was closed.".into()))?;
            if slide > *count {
                return Err(BackendError::Failed(format!("The presentation has only {count} slides.")));
            }
            *cur = self.stuck_at.unwrap_or(slide);
            Ok(Position { slide: *cur, slide_count: *count, in_show: *show })
        }
    }

    fn controller(decks: &[(&str, u32, u32)]) -> Controller<Fake> {
        Controller::new(Fake::with(decks))
    }

    #[test]
    fn navigation_goes_only_to_the_bound_presentation_never_to_others() {
        let mut c = controller(&[("pp:C:\\a\\thesis.pptx", 1, 16), ("pp:C:\\b\\other.pptx", 1, 5)]);
        c.bind("pp:C:\\a\\thesis.pptx").unwrap();
        c.goto(2).unwrap();
        c.goto(3).unwrap();
        assert!(c.backend.calls.iter().all(|(id, _)| id == "pp:C:\\a\\thesis.pptx"));
        assert_eq!(c.backend.decks["pp:C:\\b\\other.pptx"].0, 1, "the unrelated deck must not move");
        assert_eq!(c.backend.decks["pp:C:\\a\\thesis.pptx"].0, 3);
    }

    #[test]
    fn binding_requires_a_listed_target_and_nothing_is_assumed() {
        let mut c = controller(&[("pp:a.pptx", 1, 3)]);
        assert!(c.bind("pp:not-open.pptx").is_err());
        assert!(!c.is_bound());
        assert_eq!(c.status(None).state, ConnectionState::Disconnected);
        assert!(c.goto(2).unwrap_err().contains("No presentation is bound"));
        assert!(c.backend.calls.is_empty());
    }

    #[test]
    fn goto_is_absolute_so_repeating_a_request_never_double_advances() {
        let mut c = controller(&[("pp:a.pptx", 1, 10)]);
        c.bind("pp:a.pptx").unwrap();
        for _ in 0..3 {
            assert_eq!(c.goto(4).unwrap().confirmed_slide, 4);
        }
        assert_eq!(c.backend.decks["pp:a.pptx"].0, 4);
    }

    #[test]
    fn a_navigation_the_presentation_does_not_confirm_is_not_reported_as_success() {
        let mut c = controller(&[("pp:a.pptx", 1, 10)]);
        c.bind("pp:a.pptx").unwrap();
        c.backend.stuck_at = Some(1);
        let err = c.goto(5).unwrap_err();
        assert!(err.contains("reported slide 1") && err.contains("did not change"));
        c.backend.stuck_at = None;
        assert!(c.goto(11).is_err());
        assert!(c.goto(0).is_err());
    }

    #[test]
    fn a_closed_presentation_is_disconnected_with_a_reason_and_can_be_rebound() {
        let mut c = controller(&[("pp:a.pptx", 2, 10), ("pp:b.pptx", 1, 4)]);
        c.bind("pp:a.pptx").unwrap();
        c.backend.decks.remove("pp:a.pptx");
        let s = c.status(Some(2));
        assert_eq!(s.state, ConnectionState::Disconnected);
        assert!(s.message.contains("closed"));
        assert!(c.goto(3).is_err());
        assert_eq!(c.backend.calls.len(), 1, "only the single attempt that discovered the closure");
        assert_eq!(c.bind("pp:b.pptx").unwrap().state, ConnectionState::Connected);
        c.disconnect();
        assert!(!c.is_bound());
    }

    #[test]
    fn out_of_sync_is_reported_when_the_presentation_moved_on_its_own() {
        let mut c = controller(&[("pp:a.pptx", 1, 10)]);
        c.bind("pp:a.pptx").unwrap();
        assert_eq!(c.status(Some(1)).state, ConnectionState::Connected);
        c.backend.decks.get_mut("pp:a.pptx").unwrap().0 = 7;
        let s = c.status(Some(1));
        assert_eq!(s.state, ConnectionState::OutOfSync);
        assert_eq!(s.target_slide, Some(7));
    }

    #[test]
    fn google_slides_windows_can_be_bound_but_are_reported_unsupported_and_never_navigated() {
        let mut f = Fake::default();
        f.browsers.push(Target {
            id: "win:123".into(), kind: TargetKind::GoogleSlides, title: "Thesis - Google Slides".into(),
            detail: String::new(), supports_control: false, slideshow_running: false, slide_count: None, current_slide: None,
        });
        let mut c = Controller::new(f);
        let s = c.bind("win:123").unwrap();
        assert_eq!(s.state, ConnectionState::Unsupported);
        assert!(s.message.contains("no slideshow-control API"));
        assert!(c.goto(2).is_err());
        assert!(c.test_navigation().is_err());
        assert_eq!(c.status(Some(3)).state, ConnectionState::Unsupported);
        assert!(c.backend.calls.is_empty());
    }

    #[test]
    fn test_navigation_moves_away_and_back_and_needs_two_slides() {
        let mut c = controller(&[("pp:a.pptx", 3, 10), ("pp:one.pptx", 1, 1)]);
        c.bind("pp:a.pptx").unwrap();
        let r = c.test_navigation().unwrap();
        assert_eq!(r.confirmed_slide, 3);
        let slides: Vec<u32> = c.backend.calls.iter().map(|(_, s)| *s).collect();
        assert_eq!(slides, [4, 3]);
        c.bind("pp:one.pptx").unwrap();
        assert!(c.test_navigation().unwrap_err().contains("at least two"));
        c.bind("pp:a.pptx").unwrap();
        c.backend.decks.get_mut("pp:a.pptx").unwrap().0 = 10;
        c.backend.calls.clear();
        c.test_navigation().unwrap();
        assert_eq!(c.backend.calls.iter().map(|(_, s)| *s).collect::<Vec<_>>(), [9, 10]);
    }

    #[test]
    fn a_busy_application_is_reported_not_treated_as_connected() {
        let mut c = controller(&[("pp:a.pptx", 1, 4)]);
        c.bind("pp:a.pptx").unwrap();
        c.backend.busy = true;
        let s = c.status(Some(1));
        assert_eq!(s.state, ConnectionState::Disconnected);
        assert!(s.message.contains("busy"));
    }

    #[test]
    fn revalidation_finds_exactly_the_saved_target_or_says_it_is_not_open() {
        let mut c = controller(&[("pp:a.pptx", 2, 8), ("pp:copy-of-a.pptx", 1, 8)]);
        assert_eq!(c.revalidate("pp:a.pptx", "a", TargetKind::Powerpoint).state, ConnectionState::Connected);
        assert!(c.is_bound());
        let mut c = controller(&[("pp:copy-of-a.pptx", 1, 8)]);
        let s = c.revalidate("pp:a.pptx", "a.pptx", TargetKind::Powerpoint);
        assert_eq!(s.state, ConnectionState::Disconnected);
        assert!(s.message.contains("is not open") && !c.is_bound());
        assert!(c.goto(2).is_err() && c.backend.calls.is_empty());
    }
}
