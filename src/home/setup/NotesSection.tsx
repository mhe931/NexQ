import { useState } from "react";
import { Alert, Chip, btnQuiet, btnSecondary, hintCls, inputCls, labelCls } from "../ui";
import type { MeetingProfile, SlideRow } from "../../lib/profileTypes";
import { notesFor } from "../../lib/slideNav";
import { useProfileStore } from "../../stores/profileStore";

export function NotesSection({ profile }: { profile: MeetingProfile }) {
  const slides = useProfileStore((s) => s.slides);
  const patch = useProfileStore((s) => s.patch);

  return (
    <>
      {slides.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/40 px-3 py-4 text-center text-xs text-muted-foreground">
          No slides yet. Add a .pptx under Sources and choose “Use as presentation”.
        </p>
      ) : (
        <ul className="space-y-1.5" aria-label="Slides and speaker notes">
          {slides.map((s) => <SlideRowEditor key={`${s.documentId}-${s.slideNo}`} slide={s} />)}
        </ul>
      )}
      <p className={hintCls}>
        Edits are this meeting's copy. The original .pptx and its notes are never changed. “Restore original” brings the file's notes back.
      </p>

      <div className="rounded-lg border border-border/30 bg-secondary/20 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        <p>
          <strong className="text-foreground">Google Slides:</strong> reading speaker notes live from Google Slides needs Google API sign-in, which is not
          built into NexQ yet. Supported fallback: in Google Slides choose <em>File → Download → Microsoft PowerPoint (.pptx)</em>, then use Add Files above.
        </p>
        <label htmlFor="slides-url" className={`${labelCls} mt-2`}>Google Slides link <span className="font-normal text-muted-foreground">(optional, kept as a link only)</span></label>
        <input
          id="slides-url"
          className={inputCls}
          value={profile.presentation.googleSlidesUrl}
          onChange={(e) => patch((p) => ({ ...p, presentation: { ...p.presentation, googleSlidesUrl: e.target.value } }))}
          placeholder="https://docs.google.com/presentation/…"
        />
      </div>
      <p className={hintCls}>Automatic slide following is not available; during the meeting you move between slides yourself.</p>
    </>
  );
}

function SlideRowEditor({ slide }: { slide: SlideRow }) {
  const saveSlideNotes = useProfileStore((s) => s.saveSlideNotes);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const notes = notesFor(slide);
  const edited = slide.notesEdited !== null;

  const commit = async (value: string) => {
    setError(null);
    if (await saveSlideNotes(slide.slideNo, value)) setEditing(false);
    else setError("Couldn't save the notes for this slide.");
  };

  return (
    <li className="rounded-lg border border-border/30 bg-secondary/10 px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            Slide {slide.slideNo}{slide.title ? ` — ${slide.title}` : ""} {edited && <Chip tone="info">Edited copy</Chip>}
          </p>
          {!editing && (
            <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-meta text-muted-foreground">{notes || "No notes for this slide"}</p>
          )}
        </div>
        {!editing && (
          <button
            type="button"
            className={btnQuiet}
            onClick={() => { setDraft(notes); setEditing(true); }}
            aria-label={`Edit notes for slide ${slide.slideNo}`}
          >
            Edit notes
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-2 space-y-2">
          <textarea
            className={`${inputCls} min-h-[90px] resize-y`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Notes for slide ${slide.slideNo}`}
          />
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnSecondary} onClick={() => commit(draft)}>Save this meeting's copy</button>
            <button type="button" className={btnQuiet} onClick={() => commit("")}>Restore original</button>
            <button type="button" className={btnQuiet} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}
