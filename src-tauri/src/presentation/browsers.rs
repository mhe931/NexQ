//! Listing browser windows that show Google Slides.
//!
//! Window titles are read with the ordinary top-level-window listing: no
//! browser debugging port, no cookies, no page access. Because no supported
//! API lets another application drive a Google Slides slideshow, such windows
//! are listed as *not controllable*; NexQ then offers manual synchronisation.

use super::{Backend, BackendError, Position, Target, TargetKind};

/// A Google Slides window title looks like
/// `My deck - Google Slides - Google Chrome` (or Microsoft Edge, Firefox ...).
pub fn google_slides_title(title: &str) -> Option<String> {
    let marker = " - Google Slides";
    let idx = title.find(marker)?;
    let deck = title[..idx].trim();
    Some(if deck.is_empty() { "Google Slides".to_string() } else { deck.to_string() })
}

#[cfg(windows)]
fn visible_window_titles() -> Vec<(isize, String)> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible};

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<(isize, String)>);
        if IsWindowVisible(hwnd).as_bool() {
            let len = GetWindowTextLengthW(hwnd);
            if len > 0 {
                let mut buf = vec![0u16; len as usize + 1];
                let n = GetWindowTextW(hwnd, &mut buf);
                if n > 0 {
                    out.push((hwnd.0 as isize, String::from_utf16_lossy(&buf[..n as usize])));
                }
            }
        }
        BOOL(1)
    }

    let mut found: Vec<(isize, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

#[cfg(not(windows))]
fn visible_window_titles() -> Vec<(isize, String)> {
    Vec::new()
}

pub fn google_slides_targets() -> Vec<Target> {
    visible_window_titles()
        .into_iter()
        .filter_map(|(hwnd, title)| {
            let deck = google_slides_title(&title)?;
            Some(Target {
                id: format!("win:{hwnd}"),
                kind: TargetKind::GoogleSlides,
                title: deck,
                detail: format!("Browser window: {title}"),
                supports_control: false,
                slideshow_running: false,
                slide_count: None,
                current_slide: None,
            })
        })
        .collect()
}

/// PowerPoint (controllable) plus Google Slides browser windows (listed only).
pub struct SystemBackend {
    powerpoint: super::powerpoint::PowerPoint,
}

impl SystemBackend {
    pub fn new() -> Self {
        Self { powerpoint: super::powerpoint::PowerPoint::new() }
    }
}

impl Backend for SystemBackend {
    fn list(&mut self) -> Result<Vec<Target>, BackendError> {
        let mut targets = self.powerpoint.list()?;
        targets.extend(google_slides_targets());
        Ok(targets)
    }

    fn position(&mut self, id: &str) -> Result<Position, BackendError> {
        if id.starts_with("pp:") {
            self.powerpoint.position(id)
        } else {
            Err(BackendError::Failed("This window cannot be controlled.".into()))
        }
    }

    fn goto(&mut self, id: &str, slide: u32) -> Result<Position, BackendError> {
        if id.starts_with("pp:") {
            self.powerpoint.goto(id, slide)
        } else {
            Err(BackendError::Failed("This window cannot be controlled.".into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_google_slides_browser_titles_only() {
        assert_eq!(
            google_slides_title("Kvarken defence - Google Slides - Google Chrome").as_deref(),
            Some("Kvarken defence")
        );
        assert_eq!(google_slides_title("Deck - Google Slides — Microsoft Edge").as_deref(), Some("Deck"));
        assert_eq!(google_slides_title("Thesis - Google Docs - Google Chrome"), None);
        assert_eq!(google_slides_title("Slides - Notes.pptx - PowerPoint"), None);
        assert_eq!(google_slides_title(" - Google Slides - Edge").as_deref(), Some("Google Slides"));
    }
}
