import { useEffect, useState } from "react";
import { Alert, Chip, btnQuiet, hintCls } from "../ui";
import { profileIpc } from "../../lib/profileIpc";
import type { MeetingProfile, NotesPriority, PresentationSettings, Shortcuts } from "../../lib/profileTypes";
import { DEFAULT_SHORTCUTS } from "../../lib/slideNav";
import { useProfileStore } from "../../stores/profileStore";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const PRIORITIES: Array<{ value: NotesPriority; label: string }> = [
  { value: "external_first", label: "Speaker-notes document first (default)" },
  { value: "embedded_first", label: "Presentation notes first" },
];

/** Which notes win when a slide has both. Saved with the meeting (Save). */
export function NotesPriorityPicker({ profile }: { profile: MeetingProfile }) {
  const patch = useProfileStore((s) => s.patch);
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-xs font-semibold text-foreground">Notes priority</legend>
      <div role="radiogroup" aria-label="Notes priority" className="space-y-1">
        {PRIORITIES.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-xs text-foreground/90">
            <input
              type="radio"
              name="notes-priority"
              checked={profile.presentation.notesPriority === o.value}
              onChange={() => patch((p) => ({ ...p, presentation: { ...p.presentation, notesPriority: o.value } }))}
            />
            {o.label}
          </label>
        ))}
      </div>
      <p className={hintCls}>Your own edits always come first; neither source is ever deleted.</p>
    </fieldset>
  );
}

type ActionKey = keyof Shortcuts;

const ACTIONS: Array<{ key: ActionKey; label: string }> = [
  { key: "next", label: "Next slide" },
  { key: "prev", label: "Previous slide" },
  { key: "first", label: "First slide" },
  { key: "last", label: "Last slide" },
  { key: "startQa", label: "Start Q&A" },
];

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Process"]);

export const keyLabel = (key: string) => (key === " " ? "Space" : key);

/** What is being captured: replace the key at `index`, or add one (`index === null`). */
interface Capture { action: ActionKey; index: number | null }

/** Presenter keys and the follow-PowerPoint option. */
export function PresenterPreferences({ profile }: { profile: MeetingProfile }) {
  const patch = useProfileStore((s) => s.patch);
  const shortcuts = profile.presentation.shortcuts;
  const [capture, setCapture] = useState<Capture | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** The backend validates (duplicates, reserved keys); only an accepted set is kept. */
  const apply = async (next: Shortcuts) => {
    setError(null);
    const current = useProfileStore.getState().current;
    if (!current) return;
    const settings: PresentationSettings = { ...current.presentation, shortcuts: next };
    try {
      const saved = await profileIpc.updatePresentation(current.id, settings);
      // Keep the draft (and its unsaved flag) as it was; only the shortcuts change.
      useProfileStore.setState((s) =>
        s.current ? { current: { ...s.current, presentation: { ...s.current.presentation, shortcuts: saved?.shortcuts ?? next } } } : s,
      );
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    if (!capture) return;
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapture(null);
        return;
      }
      const current = useProfileStore.getState().current?.presentation.shortcuts;
      setCapture(null);
      if (!current) return;
      const keys = [...current[capture.action]];
      if (capture.index === null) keys.push(e.key);
      else keys[capture.index] = e.key;
      void apply({ ...current, [capture.action]: keys });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capture]);

  const remove = (action: ActionKey, index: number) =>
    void apply({ ...shortcuts, [action]: shortcuts[action].filter((_, i) => i !== index) });

  return (
    <>
      <div className="space-y-1.5" role="group" aria-label="Keyboard shortcuts">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-foreground">Keyboard shortcuts</h3>
          <button type="button" className={btnQuiet} onClick={() => { setCapture(null); void apply({ ...DEFAULT_SHORTCUTS }); }}>
            Reset to defaults
          </button>
        </div>
        <ul className="space-y-1">
          {ACTIONS.map(({ key, label }) => (
            <li key={key} className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary/20 px-3 py-1.5 text-xs">
              <span className="w-28 shrink-0 font-medium text-foreground">{label}</span>
              <span className="flex flex-wrap items-center gap-1.5">
                {shortcuts[key].map((k, i) => {
                  const capturing = capture?.action === key && capture.index === i;
                  return (
                    <span key={`${k}-${i}`} className="inline-flex items-center gap-1">
                      <Chip tone="muted"><kbd className="font-mono">{capturing ? "Press a key…" : keyLabel(k)}</kbd></Chip>
                      <button
                        type="button"
                        className={btnQuiet}
                        onClick={() => setCapture(capturing ? null : { action: key, index: i })}
                        aria-label={`Change ${keyLabel(k)} for ${label}`}
                      >
                        Change
                      </button>
                      {shortcuts[key].length > 1 && (
                        <button type="button" className={btnQuiet} onClick={() => remove(key, i)} aria-label={`Remove ${keyLabel(k)} from ${label}`}>
                          ×
                        </button>
                      )}
                    </span>
                  );
                })}
                <button
                  type="button"
                  className={btnQuiet}
                  onClick={() => setCapture(capture?.action === key && capture.index === null ? null : { action: key, index: null })}
                  aria-label={`Add a key for ${label}`}
                >
                  {capture?.action === key && capture.index === null ? "Press a key…" : "Add key"}
                </button>
              </span>
            </li>
          ))}
        </ul>
        {capture && <p className={hintCls} role="status">Press the new key. Escape cancels.</p>}
        {error && <Alert>{error}</Alert>}
        <p className={hintCls}>
          Fixed keys: <kbd className="font-mono">ArrowUp</kbd> / <kbd className="font-mono">ArrowDown</kbd> scroll the notes and{" "}
          <kbd className="font-mono">H</kbd> hides them; these cannot be changed. Shortcuts are saved as soon as they are accepted.
        </p>
      </div>

      <div className="flex items-start gap-2 text-xs text-foreground/90">
        <input
          id="auto-follow"
          type="checkbox"
          className="mt-0.5"
          checked={profile.presentation.autoFollow}
          onChange={(e) => patch((p) => ({ ...p, presentation: { ...p.presentation, autoFollow: e.target.checked } }))}
        />
        <div>
          <label htmlFor="auto-follow">Follow slide changes made in PowerPoint</label>
          <p className="text-meta text-muted-foreground">Only works with a bound PowerPoint slide show. Google Slides always needs manual sync.</p>
        </div>
      </div>
    </>
  );
}
