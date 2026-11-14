import { Fragment, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, MinusCircle } from "lucide-react";
import { Alert, Chip, btnQuiet, btnSecondary, hintCls, inputCls } from "../ui";
import { profileIpc } from "../../lib/profileIpc";
import type { MeetingProfile, NotesBlock, SlideRow } from "../../lib/profileTypes";
import { useProfileStore } from "../../stores/profileStore";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type NotesStatus = NonNullable<SlideRow["notesStatus"]>;
type NotesSource = NonNullable<SlideRow["notesSource"]>;

const SOURCE_LABEL: Record<NotesSource, string> = {
  edited: "Your edit",
  external: "Speaker-notes document",
  embedded: "Presentation notes",
  none: "None",
};

const STATUS_VIEW: Record<NotesStatus, { label: string; tone: "success" | "warning" | "muted"; Icon: typeof CheckCircle2 }> = {
  ok: { label: "OK", tone: "success", Icon: CheckCircle2 },
  differ: { label: "Sources differ", tone: "warning", Icon: AlertTriangle },
  duplicate: { label: "Several sections on this slide", tone: "warning", Icon: AlertTriangle },
  missing: { label: "No notes", tone: "muted", Icon: MinusCircle },
};

function sourceOf(s: SlideRow): NotesSource {
  if (s.notesSource) return s.notesSource;
  if (s.notesEdited !== null) return "edited";
  return s.notesOriginal ? "embedded" : "none";
}

function statusOf(s: SlideRow): NotesStatus {
  return s.notesStatus ?? (sourceOf(s) === "none" ? "missing" : "ok");
}

/** SLIDE | TITLE | NOTES SOURCE | STATUS, one row per slide, expandable to every source. */
export function NotesMappingTable({ slides }: { slides: SlideRow[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <table className="w-full border-collapse text-left text-xs" aria-label="Slide to notes mapping">
      <thead>
        <tr className="text-meta uppercase tracking-wide text-muted-foreground">
          <th scope="col" className="px-2 py-1 font-semibold">Slide</th>
          <th scope="col" className="px-2 py-1 font-semibold">Title</th>
          <th scope="col" className="px-2 py-1 font-semibold">Notes source</th>
          <th scope="col" className="px-2 py-1 font-semibold">Status</th>
        </tr>
      </thead>
      <tbody>
        {slides.map((s) => {
          const status = STATUS_VIEW[statusOf(s)];
          const open = expanded === s.slideNo;
          return (
            <Fragment key={`${s.documentId}-${s.slideNo}`}>
              <tr className="border-t border-border/20">
                <td className="px-2 py-1.5 align-top">
                  <button
                    type="button"
                    className={`${btnQuiet} flex items-center gap-1 no-underline`}
                    aria-expanded={open}
                    aria-label={`${open ? "Hide" : "Show"} all notes sources for slide ${s.slideNo}`}
                    onClick={() => setExpanded(open ? null : s.slideNo)}
                  >
                    {open ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
                    {s.slideNo}
                  </button>
                </td>
                <td className="px-2 py-1.5 align-top text-foreground">{s.title || <span className="text-muted-foreground">(untitled)</span>}</td>
                <td className="px-2 py-1.5 align-top text-foreground">{SOURCE_LABEL[sourceOf(s)]}</td>
                <td className="px-2 py-1.5 align-top">
                  <Chip tone={status.tone}><status.Icon className="mr-1 h-3 w-3" aria-hidden="true" />{status.label}</Chip>
                </td>
              </tr>
              {open && (
                <tr>
                  <td colSpan={4} className="px-2 pb-2">
                    <SlideSources slide={s} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function SourceBox({ title, text, empty }: { title: string; text: string | null | undefined; empty: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border/30 bg-secondary/10 px-2 py-1.5">
      <h4 className="text-meta font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <p className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground">
        {text ? text : <span className="text-muted-foreground">{empty}</span>}
      </p>
    </div>
  );
}

function SlideSources({ slide }: { slide: SlideRow }) {
  const saveSlideNotes = useProfileStore((s) => s.saveSlideNotes);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const edited = slide.notesEdited !== null;

  const commit = async (value: string) => {
    setError(null);
    if (await saveSlideNotes(slide.slideNo, value)) setEditing(false);
    else setError("Couldn't save the notes for this slide.");
  };

  return (
    <div className="space-y-2" role="group" aria-label={`Notes sources for slide ${slide.slideNo}`}>
      <div className="grid gap-2 sm:grid-cols-3">
        <SourceBox title="Presentation notes" text={slide.notesOriginal} empty="No notes in the presentation" />
        <SourceBox title="Speaker-notes document" text={slide.notesExternal} empty="No section matched this slide" />
        <SourceBox title="Your edit (this meeting)" text={slide.notesEdited} empty="Not edited" />
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            className={`${inputCls} min-h-[90px] resize-y`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Notes for slide ${slide.slideNo}`}
          />
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnSecondary} onClick={() => commit(draft)}>Save this meeting's copy</button>
            <button type="button" className={btnQuiet} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnSecondary}
            onClick={() => { setDraft(slide.effectiveNotes ?? slide.notesEdited ?? slide.notesOriginal); setEditing(true); }}
            aria-label={`Edit this meeting's copy of slide ${slide.slideNo}`}
          >
            Edit this meeting's copy
          </button>
          {edited && (
            <button type="button" className={btnQuiet} onClick={() => commit("")} aria-label={`Restore original notes of slide ${slide.slideNo}`}>
              Restore original
            </button>
          )}
          {error && <Alert>{error}</Alert>}
        </div>
      )}
    </div>
  );
}

const BLOCK_STATUS: Record<NotesBlock["status"], string> = {
  ok: "Matched",
  unassigned: "Not matched to a slide",
  duplicate: "Several sections on one slide",
  out_of_range: "Slide number is beyond the deck",
};

/** Notes sections the importer could not place cleanly, with a manual slide picker. */
export function NotesCorrection({
  profile, blocks, slides, onChanged,
}: {
  profile: MeetingProfile;
  blocks: NotesBlock[];
  slides: SlideRow[];
  onChanged: () => Promise<void> | void;
}) {
  const loadSlides = useProfileStore((s) => s.loadSlides);
  const [error, setError] = useState<string | null>(null);
  const shown = blocks.filter((b) => b.status !== "ok" || b.manual);
  if (shown.length === 0) return null;

  const assign = async (block: NotesBlock, value: string) => {
    setError(null);
    try {
      await profileIpc.assignNotes(profile.id, block.id, value === "" ? null : Number(value));
      await loadSlides();
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const numbers = slides.map((s) => s.slideNo).sort((a, b) => a - b);
  const attention = blocks.filter((b) => b.status !== "ok").length;

  return (
    <div className="space-y-1.5" role="group" aria-label="Notes sections to check">
      <h3 className="text-xs font-semibold text-foreground">Notes sections to check ({attention} need attention)</h3>
      <p className={hintCls}>Choose the slide each section belongs to, or “None” to keep it out of the presenter view. Nothing is deleted.</p>
      {error && <Alert>{error}</Alert>}
      <ul className="space-y-1.5">
        {shown.map((b) => {
          const excerpt = b.text.length > 160 ? `${b.text.slice(0, 160)}…` : b.text;
          return (
            <li key={b.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border/30 bg-secondary/10 px-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">
                  {b.label || `Section ${b.ordinal}`}{" "}
                  <Chip tone={b.status === "ok" ? "success" : "warning"}>{BLOCK_STATUS[b.status]}</Chip>{" "}
                  {b.manual && <Chip tone="info">Manually assigned</Chip>}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-meta text-muted-foreground">{excerpt}</p>
              </div>
              <label className="flex items-center gap-1 text-meta text-muted-foreground">
                Slide
                <select
                  className="rounded-md border border-border/40 bg-secondary/30 px-1.5 py-1 text-xs text-foreground"
                  value={b.assignedSlide === null ? "" : String(b.assignedSlide)}
                  onChange={(e) => assign(b, e.target.value)}
                  aria-label={`Slide for ${b.label || `section ${b.ordinal}`}`}
                >
                  <option value="">None</option>
                  {b.assignedSlide !== null && !numbers.includes(b.assignedSlide) && (
                    <option value={String(b.assignedSlide)}>{b.assignedSlide} (not in the deck)</option>
                  )}
                  {numbers.map((n) => <option key={n} value={String(n)}>{n}</option>)}
                </select>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
