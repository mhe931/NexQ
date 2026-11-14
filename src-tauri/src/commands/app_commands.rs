//! The main window's answers to "may NexQ close?" (see `lifecycle`).

use tauri::{command, AppHandle};

use crate::lifecycle;

/// Nothing would be lost, or the user chose to quit: end NexQ.
#[command]
pub fn confirm_app_close(app: AppHandle) {
    lifecycle::confirm_close(&app);
}

/// The user chose to keep NexQ open: stop the fallback and carry on.
#[command]
pub fn cancel_app_close() {
    lifecycle::cancel_close();
}

/// A confirmation dialog is on screen: the user decides, so the backend stops
/// its fallback timer. False when no close is pending any more.
#[command]
pub fn ack_app_close_prompt() -> bool {
    lifecycle::acknowledge_prompt()
}
