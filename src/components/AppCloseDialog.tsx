import { useEffect, useRef } from "react";
import { Alert, btnDanger, btnPrimary, btnSecondary } from "../home/ui";
import type { AppCloseGuard, CloseReason } from "../hooks/useAppCloseGuard";

/** What would be lost, in words. */
export function closeSummary(reason: CloseReason): string {
  if (reason.meetingActive && reason.unsavedSetup) {
    return "A meeting is still running and your meeting setup has unsaved changes.";
  }
  if (reason.meetingActive) return "A meeting is still running.";
  return "Your meeting setup has unsaved changes.";
}

/**
 * The "quit NexQ?" question, shown only when a meeting is running or the
 * meeting setup has unsaved edits (see useAppCloseGuard). Escape cancels, Tab
 * stays inside the dialog and focus starts on the safe choice, "Save and quit".
 */
export function AppCloseDialog({ guard }: { guard: AppCloseGuard }) {
  const { prompt, busy, error, saveAndQuit, quitWithoutSaving, cancel } = guard;
  const panelRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const open = prompt !== null;

  useEffect(() => {
    if (open) saveRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Capture phase: Escape answers this dialog only (not the settings' Escape too).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) void cancel();
        return;
      }
      if (e.key !== "Tab") return;
      const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      const active = document.activeElement;
      if (!panelRef.current?.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, busy, cancel]);

  if (!prompt) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" role="presentation">
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="app-close-title"
        aria-describedby="app-close-message"
        className="w-[420px] max-w-full rounded-2xl border border-border/40 bg-card p-5 shadow-2xl"
      >
        <h2 id="app-close-title" className="text-sm font-semibold text-foreground">
          Quit NexQ?
        </h2>
        <p id="app-close-message" className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {closeSummary(prompt)} Save before quitting, or you will lose it.
        </p>
        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className={btnSecondary} onClick={() => void cancel()} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={btnDanger} onClick={() => void quitWithoutSaving()}>
            Quit without saving
          </button>
          <button ref={saveRef} type="button" className={btnPrimary} onClick={() => void saveAndQuit()} disabled={busy}>
            {busy ? "Saving…" : "Save and quit"}
          </button>
        </div>
      </div>
    </div>
  );
}
