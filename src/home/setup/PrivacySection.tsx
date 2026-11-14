import { useState } from "react";
import { Alert, ConfirmDialog, btnDanger, btnSecondary, hintCls, shortDate } from "../ui";
import { profileIpc } from "../../lib/profileIpc";
import type { MeetingProfile, SessionRef } from "../../lib/profileTypes";
import { useProfileStore } from "../../stores/profileStore";

export function PrivacySection({ profile, onDelete }: { profile: MeetingProfile; onDelete: () => void }) {
  const patch = useProfileStore((s) => s.patch);
  const loadList = useProfileStore((s) => s.loadList);
  const [sessions, setSessions] = useState<SessionRef[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const review = async () => {
    try {
      setSessions(await profileIpc.sessions(profile.id));
      setMessage(null);
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  const clear = async () => {
    setConfirmClear(false);
    try {
      const n = await profileIpc.clearSessions(profile.id);
      setSessions([]);
      setMessage({ text: `${n} ${n === 1 ? "session" : "sessions"} cleared.`, error: false });
      void loadList();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  return (
    <>
      <div className="flex items-start gap-2 text-xs text-foreground/90">
        <input
          id="listening-consent"
          type="checkbox"
          className="mt-0.5"
          checked={profile.audio.listeningConsentConfirmed}
          onChange={(e) => patch((p) => ({ ...p, audio: { ...p.audio, listeningConsentConfirmed: e.target.checked } }))}
        />
        <label htmlFor="listening-consent">
          I will make sure everyone on this meeting knows it is transcribed or that it is permitted (asked once per meeting)
        </label>
      </div>
      <p className={hintCls}>
        Optional here: you can start the meeting without ticking this. If it is left unchecked, the presenter asks once before listening
        starts. Once confirmed it is saved with this meeting and not asked again.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
        <li>Nothing is recorded or uploaded automatically.</li>
        <li>Folders and files are indexed locally on this computer.</li>
        <li>Only the excerpts retrieved for a question are sent to the AI provider you selected.</li>
      </ul>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnSecondary} onClick={review}>Review retained data</button>
        <button type="button" className={btnSecondary} onClick={() => setConfirmClear(true)}>Clear session history</button>
        <button type="button" className={btnDanger} onClick={onDelete}>Delete this meeting and its data</button>
      </div>

      {message && (message.error ? <Alert>{message.text}</Alert> : <p className="text-xs text-muted-foreground" role="status">{message.text}</p>)}
      {sessions && (
        sessions.length === 0 ? (
          <p className={hintCls}>No sessions are stored for this meeting.</p>
        ) : (
          <ul className="space-y-0.5 text-xs text-muted-foreground" aria-label="Retained sessions">
            {sessions.map((s) => <li key={s.id}>{s.title || "Untitled session"} — {shortDate(s.startTime)}</li>)}
          </ul>
        )
      )}

      {confirmClear && (
        <ConfirmDialog
          title="Clear session history?"
          message="This deletes the transcripts and answers stored for this meeting's sessions. The meeting, its documents and settings stay."
          confirmLabel="Clear history"
          destructive
          onCancel={() => setConfirmClear(false)}
          onConfirm={clear}
        />
      )}
    </>
  );
}
