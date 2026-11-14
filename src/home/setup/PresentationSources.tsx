import { useState } from "react";
import { AlertTriangle, Cloud, FileText, FileUp, RefreshCw } from "lucide-react";
import { Alert, Chip, btnSecondary, hintCls, inputCls, labelCls, shortDate } from "../ui";
import { IngestSummary } from "./IngestSummary";
import { NOTES_EXTENSIONS, PRESENTATION_EXTENSIONS, pickFile } from "./pickers";
import { profileIpc } from "../../lib/profileIpc";
import type { IngestReport, MeetingProfile, NotesImportSummary, PresentationInfo } from "../../lib/profileTypes";
import { useProfileStore } from "../../stores/profileStore";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Props {
  profile: MeetingProfile;
  info: PresentationInfo | null;
  onInfo: (info: PresentationInfo | null) => void;
  /** Called after anything changed that the mapping table / correction list depends on. */
  onChanged: () => Promise<void> | void;
}

/** Add a presentation file and an external speaker-notes document; honest about cloud sources. */
export function PresentationSources({ profile, info, onInfo, onChanged }: Props) {
  const reloadSources = useProfileStore((s) => s.reloadSources);
  const patch = useProfileStore((s) => s.patch);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<IngestReport | null>(null);
  const [summary, setSummary] = useState<NotesImportSummary | null>(null);
  const [cloudOpen, setCloudOpen] = useState(false);

  const run = async (task: () => Promise<void>) => {
    setError(null);
    setWorking(true);
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(false);
    }
  };

  const addPresentation = () => run(async () => {
    const path = await pickFile("PowerPoint presentation", PRESENTATION_EXTENSIONS);
    if (!path) return;
    const result = await profileIpc.addPresentation(profile.id, path);
    setReport(result.report);
    onInfo(result.info);
    await reloadSources();
    await onChanged();
  });

  const refreshPresentation = () => run(async () => {
    setReport(await profileIpc.refresh(profile.id));
    onInfo(await profileIpc.presentationInfo(profile.id));
    await reloadSources();
    await onChanged();
  });

  const addNotes = () => run(async () => {
    const path = await pickFile("Speaker notes", NOTES_EXTENSIONS);
    if (!path) return;
    const result = await profileIpc.addNotes(profile.id, path);
    setReport(result.report);
    setSummary(result.summary);
    await reloadSources();
    await onChanged();
  });

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnSecondary} onClick={addPresentation} disabled={working}>
          <FileUp className="h-3.5 w-3.5" aria-hidden="true" /> Add Presentation
        </button>
        <button type="button" className={btnSecondary} onClick={addNotes} disabled={working}>
          <FileText className="h-3.5 w-3.5" aria-hidden="true" /> Add Speaker Notes
        </button>
        <button
          type="button"
          className={btnSecondary}
          onClick={() => setCloudOpen((v) => !v)}
          aria-expanded={cloudOpen}
          aria-controls="presentation-cloud-help"
        >
          <Cloud className="h-3.5 w-3.5" aria-hidden="true" /> Google Slides / OneDrive / SharePoint
        </button>
      </div>
      <p className={hintCls}>
        Presentation: .pptx .pptm .ppsx. Speaker notes document: .docx .pdf .txt .md. Google Docs notes: File → Download → .docx or Markdown (.md).
      </p>

      {cloudOpen && (
        <div id="presentation-cloud-help" className="rounded-lg border border-border/30 bg-secondary/20 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          <p>
            <strong className="text-foreground">Direct sign-in to Google Slides, OneDrive or SharePoint is not built into NexQ yet</strong>{" "}
            (it needs your own OAuth registration and approval). NexQ never reads browser tokens or cookies. Supported today:
          </p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5">
            <li>
              In Google Slides choose <em>File → Download → Microsoft PowerPoint (.pptx)</em>, then use Add Presentation.
            </li>
            <li>
              A OneDrive, SharePoint or Google Drive deck that their desktop app syncs to this computer can be added directly from its local
              folder; it is labelled “Locally synced cloud file”.
            </li>
          </ol>
          <label htmlFor="slides-url" className={`${labelCls} mt-2`}>
            Google Slides link <span className="font-normal text-muted-foreground">(optional, kept as a link only)</span>
          </label>
          <input
            id="slides-url"
            className={inputCls}
            value={profile.presentation.googleSlidesUrl}
            onChange={(e) => patch((p) => ({ ...p, presentation: { ...p.presentation, googleSlidesUrl: e.target.value } }))}
            placeholder="https://docs.google.com/presentation/…"
          />
        </div>
      )}

      {error && <Alert>{error}</Alert>}
      {info && <PresentationCard info={info} working={working} onRefresh={refreshPresentation} />}
      {summary && (
        <p className="rounded-lg border border-border/30 bg-secondary/20 px-3 py-2 text-xs font-medium text-foreground" role="status" aria-label="Speaker notes import">
          {summary.blocks} {summary.blocks === 1 ? "section" : "sections"} found, {summary.matched} matched to slides,{" "}
          {Math.max(summary.blocks - summary.matched, 0)} need attention
        </p>
      )}
      {report && <IngestSummary report={report} />}
    </>
  );
}

function PresentationCard({ info, working, onRefresh }: { info: PresentationInfo; working: boolean; onRefresh: () => void }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-border/30 bg-secondary/10 px-3 py-2 text-xs" aria-label="Presentation">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-medium text-foreground" title={info.path}>{info.name}</span>
        <Chip tone="muted">{info.slideCount} {info.slideCount === 1 ? "slide" : "slides"}</Chip>
        {info.origin === "synced_cloud" && <Chip tone="info"><Cloud className="mr-1 h-3 w-3" aria-hidden="true" />Locally synced cloud file</Chip>}
        <span className="text-meta text-muted-foreground">Imported {shortDate(info.indexedAt)}</span>
      </div>
      {info.stale && !info.sourceMissing && (
        <div className="flex flex-wrap items-center gap-2 text-foreground">
          <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
          <span role="status">Source file changed since import</span>
          <button type="button" className={btnSecondary} onClick={onRefresh} disabled={working}>
            <RefreshCw className="h-3 w-3" aria-hidden="true" /> Refresh
          </button>
        </div>
      )}
      {info.sourceMissing && (
        <p className="flex items-center gap-2 text-foreground" role="status">
          <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
          Source file missing — cached slides still usable
        </p>
      )}
    </div>
  );
}
