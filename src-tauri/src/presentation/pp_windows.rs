//! The top-level windows PowerPoint shows, read with the ordinary window
//! listing (no hooks, no injection, no administrator rights).
//!
//! These are used for diagnostics and as a last-resort listing only: the
//! identity of a presentation always comes from PowerPoint's object model,
//! never from a title or from "the foreground window". The classes are the
//! ones PowerPoint registers (verified on Microsoft 365 Apps):
//!  * `PPTFrameClass`            the main window (also for Protected View)
//!  * `screenClass`              the slide show window
//!  * `protectedViewScreenClass` the slide show window of a Protected View file
//!  * `PodiumParent`             Presenter View (can live in a different process)

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowRole {
    Editor,
    SlideShow,
    PresenterView,
}

impl WindowRole {
    pub fn label(self) -> &'static str {
        match self {
            Self::Editor => "editing window",
            Self::SlideShow => "slide show window",
            Self::PresenterView => "Presenter View",
        }
    }
}

pub fn role_of(class: &str) -> Option<WindowRole> {
    match class {
        "PPTFrameClass" => Some(WindowRole::Editor),
        "screenClass" | "protectedViewScreenClass" => Some(WindowRole::SlideShow),
        "PodiumParent" => Some(WindowRole::PresenterView),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWindow {
    pub hwnd: isize,
    pub pid: u32,
    pub class: String,
    pub title: String,
    pub role: WindowRole,
    /// left, top, right, bottom in virtual-screen pixels (shows which display it is on).
    pub rect: [i32; 4],
}

#[cfg(windows)]
pub fn pid_of(hwnd: isize) -> u32 {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid));
    }
    pid
}

/// Visible PowerPoint windows (all processes of the current user session that
/// the calling process can see).
#[cfg(windows)]
pub fn powerpoint_windows() -> Vec<OfficeWindow> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextW, IsWindowVisible,
    };

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<OfficeWindow>);
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut class = [0u16; 128];
        let n = GetClassNameW(hwnd, &mut class);
        if n <= 0 {
            return BOOL(1);
        }
        let class = String::from_utf16_lossy(&class[..n as usize]);
        let Some(role) = role_of(&class) else { return BOOL(1) };
        let mut title = [0u16; 512];
        let t = GetWindowTextW(hwnd, &mut title);
        let title = String::from_utf16_lossy(&title[..t.max(0) as usize]);
        let mut r = RECT::default();
        let _ = GetWindowRect(hwnd, &mut r);
        let handle = hwnd.0 as isize;
        out.push(OfficeWindow { hwnd: handle, pid: pid_of(handle), class, title, role, rect: [r.left, r.top, r.right, r.bottom] });
        BOOL(1)
    }

    let mut found: Vec<OfficeWindow> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

#[cfg(not(windows))]
pub fn powerpoint_windows() -> Vec<OfficeWindow> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_classes_powerpoint_registers_are_recognised() {
        assert_eq!(role_of("PPTFrameClass"), Some(WindowRole::Editor));
        assert_eq!(role_of("screenClass"), Some(WindowRole::SlideShow));
        assert_eq!(role_of("protectedViewScreenClass"), Some(WindowRole::SlideShow));
        assert_eq!(role_of("PodiumParent"), Some(WindowRole::PresenterView));
        assert_eq!(role_of("Chrome_WidgetWin_1"), None);
        assert_eq!(role_of("ZPContentViewWndClass"), None, "a Zoom share window is not a presentation");
    }
}
