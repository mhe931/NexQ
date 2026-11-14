//! Explains, in facts, why a presentation was or was not found. Shown in the
//! Bind dialog so an empty list is never a bare "No presentations found".

use serde::Serialize;

use super::pp_windows::{OfficeWindow, WindowRole};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppReport {
    pub pid: u32,
    pub version: String,
    /// `active object` or `running object table`.
    pub source: String,
    pub presentations: u32,
    pub protected_view: u32,
    pub slide_shows: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowReport {
    pub pid: u32,
    pub class: String,
    pub title: String,
    pub role: WindowRole,
    pub rect: [i32; 4],
    /// Its process answers to automation (or it is a Presenter View, which can live in another process).
    pub reachable: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub powerpoint_installed: bool,
    pub applications: Vec<AppReport>,
    pub windows: Vec<WindowReport>,
    /// Presentation-like entries of the Running Object Table.
    pub running_object_entries: Vec<String>,
    pub notes: Vec<String>,
}

impl Diagnostics {
    pub fn with_windows(mut self, windows: &[OfficeWindow]) -> Self {
        let pids: Vec<u32> = self.applications.iter().map(|a| a.pid).collect();
        // Protected View's application object exposes no window handle, so its process is
        // unknown (pid 0): then a window cannot be proven unreachable.
        let unknown_pid = pids.contains(&0);
        self.windows = windows
            .iter()
            .map(|w| WindowReport {
                pid: w.pid,
                class: w.class.clone(),
                title: w.title.clone(),
                role: w.role,
                rect: w.rect,
                reachable: w.role == WindowRole::PresenterView || unknown_pid || pids.contains(&w.pid),
            })
            .collect();
        self
    }

    /// One plain sentence stating what NexQ sees right now.
    pub fn summary(&self) -> String {
        let unreachable = self.windows.iter().filter(|w| !w.reachable).count();
        if self.applications.is_empty() {
            return if !self.windows.is_empty() {
                "PowerPoint windows are open, but NexQ cannot reach PowerPoint's automation interface. \
                 This usually means PowerPoint runs as administrator or under another Windows user: \
                 close it and open the presentation normally."
                    .into()
            } else if !self.powerpoint_installed {
                "Desktop PowerPoint is not installed (or not registered for automation) on this computer.".into()
            } else {
                "PowerPoint is not running.".into()
            };
        }
        let decks: u32 = self.applications.iter().map(|a| a.presentations + a.protected_view).sum();
        let protected: u32 = self.applications.iter().map(|a| a.protected_view).sum();
        let shows: u32 = self.applications.iter().map(|a| a.slide_shows).sum::<u32>() + protected_shows(&self.windows);
        let mut text = format!(
            "PowerPoint is reachable ({} {}): {} open {}{}; slide show running: {}.",
            self.applications.len(),
            if self.applications.len() == 1 { "instance" } else { "instances" },
            decks,
            if decks == 1 { "presentation" } else { "presentations" },
            if protected > 0 { format!(" ({protected} in Protected View)") } else { String::new() },
            if shows > 0 { "yes" } else { "no" },
        );
        if unreachable > 0 {
            text.push_str(&format!(" {unreachable} PowerPoint window(s) belong to a process NexQ cannot reach."));
        }
        text
    }
}

fn protected_shows(windows: &[WindowReport]) -> u32 {
    windows.iter().filter(|w| w.class == "protectedViewScreenClass").count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(class: &str, role: WindowRole, pid: u32) -> OfficeWindow {
        OfficeWindow { hwnd: 1, pid, class: class.into(), title: "t".into(), role, rect: [0, 0, 10, 10] }
    }

    #[test]
    fn says_exactly_why_nothing_is_found() {
        let none = Diagnostics { powerpoint_installed: true, ..Default::default() };
        assert_eq!(none.summary(), "PowerPoint is not running.");
        let missing = Diagnostics::default();
        assert!(missing.summary().contains("not installed"));
        let unreachable = Diagnostics { powerpoint_installed: true, ..Default::default() }
            .with_windows(&[window("PPTFrameClass", WindowRole::Editor, 7)]);
        assert!(unreachable.summary().contains("cannot reach PowerPoint's automation interface"));
        assert!(unreachable.summary().contains("administrator"));
    }

    #[test]
    fn an_instance_with_an_unknown_process_never_makes_windows_unreachable() {
        let mut d = Diagnostics { powerpoint_installed: true, ..Default::default() };
        d.applications.push(AppReport {
            pid: 0, version: "16.0".into(), source: "active object".into(), presentations: 0, protected_view: 1, slide_shows: 1,
        });
        let d = d.with_windows(&[window("PPTFrameClass", WindowRole::Editor, 77), window("protectedViewScreenClass", WindowRole::SlideShow, 77)]);
        assert!(d.windows.iter().all(|w| w.reachable));
        assert!(!d.summary().contains("cannot reach"));
    }

    #[test]
    fn a_reachable_instance_with_a_protected_view_show_is_reported_as_such() {
        let mut d = Diagnostics { powerpoint_installed: true, ..Default::default() };
        d.applications.push(AppReport {
            pid: 5, version: "16.0".into(), source: "active object".into(), presentations: 0, protected_view: 1, slide_shows: 0,
        });
        let d = d.with_windows(&[
            window("protectedViewScreenClass", WindowRole::SlideShow, 5),
            window("PodiumParent", WindowRole::PresenterView, 9),
        ]);
        let s = d.summary();
        assert!(s.contains("1 open presentation (1 in Protected View)"), "{s}");
        assert!(s.contains("slide show running: yes"), "{s}");
        assert!(d.windows.iter().all(|w| w.reachable), "Presenter View in another process is normal");
    }
}
