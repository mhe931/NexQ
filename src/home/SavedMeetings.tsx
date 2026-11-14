import { useState } from "react";
import { ArrowLeft, Copy, Pencil, Play, Trash2 } from "lucide-react";
import type { StartState } from "./HomeShell";
import { Alert, ConfirmDialog, btnDanger, btnPrimary, btnQuiet, btnSecondary, shortDate } from "./ui";
import { MEETING_TYPE_LABELS, PLATFORM_LABELS, type ProfileSummary } from "../lib/profileTypes";
import { useProfileStore } from "../stores/profileStore";

interface Props {
  onBack: () => void;
  onOpen: (id: string) => void;
  onStart: (id: string) => void;
  startState: StartState;
}

export function SavedMeetings({ onBack, onOpen, onStart, startState }: Props) {
  const summaries = useProfileStore((s) => s.summaries);
  const error = useProfileStore((s) => s.error);
  const duplicate = useProfileStore((s) => s.duplicate);
  const remove = useProfileStore((s) => s.remove);
  const [pendingDelete, setPendingDelete] = useState<ProfileSummary | null>(null);

  const sorted = [...summaries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <main className="flex h-full flex-col bg-background" aria-labelledby="saved-title">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/20 px-5 py-3">
        <button type="button" className={`${btnQuiet} flex items-center gap-1`} onClick={onBack}>
          <ArrowLeft className="h-3 w-3" aria-hidden="true" /> Home
        </button>
        <h1 id="saved-title" className="text-sm font-semibold text-foreground">Saved meetings</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {startState.error && <Alert>{startState.error}</Alert>}
          {error && <Alert>{error}</Alert>}

          {sorted.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/40 px-4 py-10 text-center">
              <p className="text-sm font-medium text-foreground">No saved meetings yet</p>
              <p className="mt-1 text-xs text-muted-foreground">Create one from Home with New Meeting.</p>
              <button type="button" className={`${btnSecondary} mt-4`} onClick={onBack}>Back to Home</button>
            </div>
          ) : (
            <ul className="space-y-2">
              {sorted.map((m) => (
                <li key={m.id} className="rounded-xl border border-border/30 bg-secondary/10 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold text-foreground">{m.name}</h2>
                      <p className="mt-0.5 text-meta text-muted-foreground">
                        {[
                          MEETING_TYPE_LABELS[m.meetingType],
                          PLATFORM_LABELS[m.platform],
                          m.meetingDate ? shortDate(m.meetingDate) : null,
                        ].filter(Boolean).join(" · ")}
                      </p>
                      <p className="mt-0.5 text-meta text-muted-foreground">
                        {m.primaryProvider && m.primaryModel ? `${m.primaryProvider} / ${m.primaryModel}` : "No AI model chosen"}
                        {" · "}{m.documentCount} {m.documentCount === 1 ? "document" : "documents"}
                        {" · "}{m.sessionCount} {m.sessionCount === 1 ? "session" : "sessions"}
                        {" · updated "}{shortDate(m.updatedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      <button type="button" className={btnPrimary} disabled={startState.starting} onClick={() => onStart(m.id)} aria-label={`Start ${m.name}`}>
                        <Play className="h-3.5 w-3.5" aria-hidden="true" /> Start
                      </button>
                      <button type="button" className={btnSecondary} onClick={() => onOpen(m.id)} aria-label={`Open ${m.name} to edit`}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Open / Edit
                      </button>
                      <button type="button" className={btnSecondary} onClick={() => duplicate(m.id)} aria-label={`Duplicate ${m.name}`}>
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Duplicate
                      </button>
                      <button type="button" className={btnDanger} onClick={() => setPendingDelete(m)} aria-label={`Delete ${m.name}`}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.name}”?`}
          message="This removes the meeting, its indexed documents and its notes copies. Your original files are not touched."
          confirmLabel="Delete meeting"
          destructive
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const id = pendingDelete.id;
            setPendingDelete(null);
            void remove(id);
          }}
        />
      )}
    </main>
  );
}
