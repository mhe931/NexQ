// Closing the main window quits NexQ. The backend (src-tauri/src/lifecycle.rs)
// holds the close back and asks this window whether anything would be lost; it
// answers through these calls. Silence is treated as "quit" after ~2.5 s, so a
// window that can't answer never makes NexQ unclosable.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Sent to the launcher window when it is asked to close (Alt+F4, title-bar X). */
export const APP_CLOSE_REQUESTED_EVENT = "nexq:close_requested";

export interface AppCloseRequest {
  /** The backend's view: a meeting is between start_meeting and end_meeting. */
  meetingActive: boolean;
}

export function onAppCloseRequested(handler: (request: AppCloseRequest) => void): Promise<UnlistenFn> {
  return listen<AppCloseRequest>(APP_CLOSE_REQUESTED_EVENT, (e) =>
    handler({ meetingActive: !!e.payload?.meetingActive }),
  );
}

/** Nothing to lose, or the user chose to quit: NexQ ends. */
export function confirmAppClose(): Promise<void> {
  return invoke("confirm_app_close");
}

/** The user chose to keep NexQ open: the backend stops its fallback timer. */
export function cancelAppClose(): Promise<void> {
  return invoke("cancel_app_close");
}

/** A confirmation dialog is on screen: the user decides, the backend waits. */
export function ackAppClosePrompt(): Promise<boolean> {
  return invoke<boolean>("ack_app_close_prompt");
}
