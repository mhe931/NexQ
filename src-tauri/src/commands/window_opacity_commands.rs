//! Whole-window opacity for the presenter window.
//!
//! The window itself is made translucent by the compositor, so every pixel
//! (background, notes, answers, buttons, borders) fades together and the
//! windows behind it (PowerPoint, Teams, a browser) show through. This is not
//! a CSS background alpha.
//!
//! Windows: the overlay's top-level window becomes a layered window with a
//! whole-window alpha (`SetLayeredWindowAttributes(..., LWA_ALPHA)`). The
//! overlay's glass blur is switched off while the presenter runs, so the
//! desktop behind is sharp. The window never gets `WS_EX_TRANSPARENT`, so it
//! stays fully clickable.

use tauri::{command, AppHandle, Manager};

/// Lowest window opacity the presenter accepts: below this it is too easy to lose.
pub const MIN_WINDOW_OPACITY: f32 = 0.2;

/// Clamp to the supported range; anything unusable counts as fully opaque.
pub fn clamp_opacity(opacity: f32) -> f32 {
    if opacity.is_finite() {
        opacity.clamp(MIN_WINDOW_OPACITY, 1.0)
    } else {
        1.0
    }
}

/// The 0–255 alpha for an opacity between 0.2 and 1.0.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn opacity_to_alpha(opacity: f32) -> u8 {
    (clamp_opacity(opacity) * 255.0).round() as u8
}

/// Puts the overlay window in presenter mode with `opacity` (0.2–1.0), or back
/// to its normal look with `None` (fully opaque, glass blur restored).
#[command]
pub async fn set_presenter_window_opacity(opacity: Option<f32>, app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("overlay").ok_or("The overlay window is not available.")?;
    apply(&window.as_ref().window(), opacity)
}

#[cfg(target_os = "windows")]
fn apply<R: tauri::Runtime>(window: &tauri::Window<R>, opacity: Option<f32>) -> Result<(), String> {
    use super::stealth_commands::{set_blur_behind_enabled, set_window_alpha};

    // The sharp desktop behind is only visible without the glass blur.
    set_blur_behind_enabled(window, opacity.is_none())?;
    set_window_alpha(window, opacity.map(opacity_to_alpha))
}

#[cfg(not(target_os = "windows"))]
fn apply<R: tauri::Runtime>(_window: &tauri::Window<R>, _opacity: Option<f32>) -> Result<(), String> {
    Err("Native window opacity is only available on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_opacity_to_alpha() {
        assert_eq!(opacity_to_alpha(1.0), 255);
        assert_eq!(opacity_to_alpha(0.7), 179);
        assert_eq!(opacity_to_alpha(0.4), 102);
        assert_eq!(opacity_to_alpha(0.2), 51);
    }

    #[test]
    fn never_goes_below_the_minimum_or_above_opaque() {
        assert_eq!(opacity_to_alpha(0.0), 51);
        assert_eq!(opacity_to_alpha(-3.0), 51);
        assert_eq!(opacity_to_alpha(7.0), 255);
        assert_eq!(opacity_to_alpha(f32::NAN), 255);
        assert_eq!(opacity_to_alpha(f32::INFINITY), 255);
    }
}
