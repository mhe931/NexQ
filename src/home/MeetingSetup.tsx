import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Copy, Play, Save, Trash2 } from "lucide-react";
import type { StartState } from "./HomeShell";
import { AdvancedSection } from "./setup/AdvancedSection";
import { BasicsSection } from "./setup/BasicsSection";
import { EnvironmentSection } from "./setup/EnvironmentSection";
import { InstructionsSection } from "./setup/InstructionsSection";
import { NotesSection } from "./setup/NotesSection";
import { OutputSection } from "./setup/OutputSection";
import { PrivacySection } from "./setup/PrivacySection";
import { SetupSection } from "./setup/SetupSection";
import { SourcesSection } from "./setup/SourcesSection";
import { Alert, Chip, ConfirmDialog, btnDanger, btnPrimary, btnQuiet, btnSecondary } from "./ui";
import type { MeetingTemplate } from "../lib/profileTypes";
import { startBlockers } from "../lib/startProfileMeeting";
import { useMeetingStore } from "../stores/meetingStore";
import { promptIsEdited, useProfileStore } from "../stores/profileStore";

type SectionId = "basics" | "sources" | "instructions" | "output" | "notes" | "environment" | "advanced" | "privacy";

interface Props {
  onBack: () => void;
  onStart: (profileId: string) => void | Promise<void>;
  startState: StartState;
}

export function MeetingSetup({ onBack, onStart, startState }: Props) {
  const profile = useProfileStore((s) => s.current);
  const dirty = useProfileStore((s) => s.dirty);
  const busy = useProfileStore((s) => s.busy);
  const error = useProfileStore((s) => s.error);
  const documentCount = useProfileStore((s) => s.documents.length);
  const slideCount = useProfileStore((s) => s.slides.length);
  const save = useProfileStore((s) => s.save);
  const open = useProfileStore((s) => s.open);
  const duplicate = useProfileStore((s) => s.duplicate);
  const remove = useProfileStore((s) => s.remove);
  const applyTemplate = useProfileStore((s) => s.applyTemplate);
  const loadCatalog = useProfileStore((s) => s.loadCatalog);
  const meetingRunning = useMeetingStore((s) => !!s.activeMeeting);

  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>({
    basics: true, sources: true, instructions: true, output: true, notes: true, environment: true, advanced: false, privacy: true,
  });
  const [pendingTemplate, setPendingTemplate] = useState<MeetingTemplate | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "discard" | null>(null);
  const [scrollToInstructions, setScrollToInstructions] = useState(false);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  useEffect(() => {
    if (!scrollToInstructions) return;
    document.getElementById("setup-instructions")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    setScrollToInstructions(false);
  }, [scrollToInstructions]);

  const toggle = (id: SectionId) => setOpenSections((s) => ({ ...s, [id]: !s[id] }));

  const requestTemplate = useCallback((template: MeetingTemplate) => {
    const { current, catalog: cat } = useProfileStore.getState();
    if (current && promptIsEdited(current, cat)) setPendingTemplate(template);
    else applyTemplate(template);
  }, [applyTemplate]);

  const editInstructions = () => {
    setOpenSections((s) => ({ ...s, instructions: true }));
    setScrollToInstructions(true);
  };

  if (!profile) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        {error ? <Alert>{error}</Alert> : <p className="text-xs text-muted-foreground" role="status">Loading meeting…</p>}
        <button type="button" className={btnSecondary} onClick={onBack}>Back</button>
      </main>
    );
  }

  const blockers = startBlockers(profile);
  const startDisabled = blockers.length > 0 || startState.starting || busy || meetingRunning;
  const isPresentation = profile.meetingType === "presentation_qa";

  const handleStart = async () => {
    if (dirty && !(await save())) return;
    await onStart(profile.id);
  };
  const handleDuplicate = async () => {
    if (dirty && !(await save())) return;
    const copy = await duplicate(profile.id);
    if (copy) await open(copy.id);
  };
  const handleDelete = async () => {
    setConfirm(null);
    if (await remove(profile.id)) onBack();
  };
  const handleBack = () => (dirty ? setConfirm("discard") : onBack());

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/20 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold text-foreground">{profile.name || "Untitled meeting"}</h1>
          <Chip>This meeting</Chip>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border/30 bg-secondary/20 px-3 py-1.5 text-meta text-muted-foreground">
          <Chip tone="muted">Global (all meetings)</Chip>
          API keys and transcription models are set once for every meeting.
          <button type="button" className={btnQuiet} onClick={() => useMeetingStore.getState().setCurrentView("settings")}>Global settings</button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4" aria-label="Meeting setup">
        <div className="mx-auto max-w-3xl space-y-3">
          <p className="text-xs text-muted-foreground">Everything on this page belongs to this meeting only. Another meeting keeps its own documents, instructions and AI model.</p>

          <SetupSection id="basics" title="Basics" open={openSections.basics} onToggle={() => toggle("basics")}>
            <BasicsSection profile={profile} onTemplate={requestTemplate} />
          </SetupSection>

          <SetupSection id="sources" title="Sources" summary={`${documentCount} ${documentCount === 1 ? "document" : "documents"}`} open={openSections.sources} onToggle={() => toggle("sources")}>
            <SourcesSection profile={profile} onEditInstructions={editInstructions} />
          </SetupSection>

          <SetupSection id="instructions" title="AI Instructions" open={openSections.instructions} onToggle={() => toggle("instructions")}>
            <InstructionsSection profile={profile} onTemplate={requestTemplate} />
          </SetupSection>

          <SetupSection id="output" title="Output & transcription" open={openSections.output} onToggle={() => toggle("output")}>
            <OutputSection profile={profile} />
          </SetupSection>

          {isPresentation && (
            <SetupSection id="notes" title="Presentation notes" summary={slideCount ? `${slideCount} slides` : undefined} open={openSections.notes} onToggle={() => toggle("notes")}>
              <NotesSection profile={profile} />
            </SetupSection>
          )}

          <SetupSection id="environment" title="Meeting environment" open={openSections.environment} onToggle={() => toggle("environment")}>
            <EnvironmentSection profile={profile} />
          </SetupSection>

          <SetupSection id="advanced" title="Advanced" summary="AI model, fallback, cost" open={openSections.advanced} onToggle={() => toggle("advanced")}>
            <AdvancedSection profile={profile} />
          </SetupSection>

          <SetupSection id="privacy" title="Privacy & consent" open={openSections.privacy} onToggle={() => toggle("privacy")}>
            <PrivacySection profile={profile} onDelete={() => setConfirm("delete")} />
          </SetupSection>
        </div>
      </main>

      <footer className="shrink-0 space-y-2 border-t border-border/30 bg-card px-5 py-3">
        {error && <Alert>{error}</Alert>}
        {startState.error && <Alert>{startState.error}</Alert>}
        {blockers.length > 0 && (
          <div role="status" aria-label="Before you can start" className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
            <p className="font-medium">Before you can start:</p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        )}
        {meetingRunning && <p className="text-xs text-muted-foreground" role="status">A meeting is already running; end it before starting another.</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button type="button" className={btnQuiet + " flex items-center gap-1"} onClick={handleBack}>
              <ArrowLeft className="h-3 w-3" aria-hidden="true" /> Back
            </button>
            <button type="button" className={btnSecondary} onClick={handleDuplicate} disabled={busy}>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Duplicate
            </button>
            <button type="button" className={btnDanger} onClick={() => setConfirm("delete")} disabled={busy}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-meta text-muted-foreground" role="status">{dirty ? "● Unsaved changes" : "All changes saved"}</span>
            <button type="button" className={btnSecondary} onClick={() => void save()} disabled={busy || !dirty}>
              <Save className="h-3.5 w-3.5" aria-hidden="true" /> Save
            </button>
            <button type="button" className={btnPrimary} onClick={handleStart} disabled={startDisabled}>
              <Play className="h-3.5 w-3.5" aria-hidden="true" /> {startState.starting ? "Starting…" : "Start Meeting"}
            </button>
          </div>
        </div>
      </footer>

      {pendingTemplate && (
        <ConfirmDialog
          title="Replace your instructions?"
          message={`You edited this meeting's instructions. Applying “${pendingTemplate.name}” replaces them with the template text.`}
          confirmLabel="Replace instructions"
          destructive
          onCancel={() => setPendingTemplate(null)}
          onConfirm={() => {
            applyTemplate(pendingTemplate);
            setPendingTemplate(null);
          }}
        />
      )}
      {confirm === "delete" && (
        <ConfirmDialog
          title={`Delete “${profile.name || "Untitled meeting"}”?`}
          message="This permanently removes the meeting, its indexed documents, notes copies and stored sessions. Your original files are not touched."
          confirmLabel="Delete meeting and data"
          destructive
          onCancel={() => setConfirm(null)}
          onConfirm={handleDelete}
        />
      )}
      {confirm === "discard" && (
        <ConfirmDialog
          title="Leave without saving?"
          message="You have unsaved changes to this meeting."
          confirmLabel="Discard changes"
          destructive
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); onBack(); }}
        />
      )}
    </div>
  );
}
