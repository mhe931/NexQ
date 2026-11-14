import { useCallback, useEffect, useRef, useState } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useProfileStore } from "../stores/profileStore";
import { endMeetingFromThisWindow, endMeetingInAllWindows } from "./useUpdater";
import { ackAppClosePrompt, cancelAppClose, confirmAppClose, onAppCloseRequested } from "../lib/appClose";

/** What closing NexQ right now would lose. */
export interface CloseReason {
  meetingActive: boolean;
  unsavedSetup: boolean;
}

/** Ask only when something would be lost; otherwise closing is instant. */
export function closeNeedsConfirmation(reason: CloseReason): boolean {
  return reason.meetingActive || reason.unsavedSetup;
}

export interface AppCloseGuard {
  /** The reason the dialog is open for, or null when no dialog is shown. */
  prompt: CloseReason | null;
  /** Saving (or quitting) is in progress. */
  busy: boolean;
  error: string | null;
  /** End the meeting / save the setup, then quit. Stays open on failure. */
  saveAndQuit: () => Promise<void>;
  quitWithoutSaving: () => Promise<void>;
  /** Keep NexQ running. */
  cancel: () => Promise<void>;
}

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

/**
 * Answers the backend's close request. Only the `launcher` window takes part:
 * the overlay never quits the app (its close just hides it).
 *
 * - Nothing to lose: answers "confirm" at once, no dialog.
 * - A meeting is running or the meeting setup has unsaved edits: exposes `prompt`
 *   (rendered by AppCloseDialog) and tells the backend a dialog is up, so its
 *   fallback timer waits for the user.
 */
export function useAppCloseGuard(windowLabel: string): AppCloseGuard {
  const [prompt, setPrompt] = useState<CloseReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<CloseReason | null>(null);
  promptRef.current = prompt;

  useEffect(() => {
    if (windowLabel !== "launcher") return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    onAppCloseRequested(({ meetingActive }) => {
      const reason: CloseReason = {
        meetingActive: meetingActive || !!useMeetingStore.getState().activeMeeting,
        unsavedSetup: useProfileStore.getState().dirty,
      };
      if (!closeNeedsConfirmation(reason)) {
        // If this fails the backend's fallback timer quits anyway.
        confirmAppClose().catch((err) => console.warn("[appClose] confirm failed:", err));
        return;
      }
      // Closing again while the dialog is up asks again: answer so the backend
      // knows this window is alive.
      if (!promptRef.current) setPrompt(reason);
      ackAppClosePrompt().catch((err) => console.warn("[appClose] acknowledge failed:", err));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [windowLabel]);

  const quit = useCallback(async () => {
    await confirmAppClose();
  }, []);

  const saveAndQuit = useCallback(async () => {
    const reason = promptRef.current;
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      if (reason.meetingActive) {
        // The window route the update restart uses: when the overlay took the
        // meeting it ends there too, so the data only it holds is saved. If this
        // window doesn't know the meeting, ask every window to end it.
        const known = !!useMeetingStore.getState().activeMeeting;
        const ended = known ? await endMeetingFromThisWindow() : await endMeetingInAllWindows();
        if (!ended) throw new Error("The meeting didn't finish saving. Try again, or quit without saving.");
      }
      if (reason.unsavedSetup) {
        const saved = await useProfileStore.getState().save();
        if (!saved) {
          throw new Error(useProfileStore.getState().error ?? "The meeting setup could not be saved.");
        }
      }
      await quit();
    } catch (err) {
      setError(messageOf(err, "Couldn't save. You can quit without saving or cancel."));
      setBusy(false);
    }
  }, [quit]);

  const quitWithoutSaving = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await quit();
    } catch (err) {
      setError(messageOf(err, "Couldn't quit."));
      setBusy(false);
    }
  }, [quit]);

  const cancel = useCallback(async () => {
    setPrompt(null);
    setError(null);
    setBusy(false);
    try {
      await cancelAppClose();
    } catch (err) {
      console.warn("[appClose] cancel failed:", err);
    }
  }, []);

  return { prompt, busy, error, saveAndQuit, quitWithoutSaving, cancel };
}
