import { useState } from "react";
import { Cloud, FileText, FolderPlus, PenLine, RefreshCw, Trash2 } from "lucide-react";
import { Alert, Chip, btnQuiet, btnSecondary, hintCls } from "../ui";
import { IngestSummary } from "./IngestSummary";
import { folderLabel, pickFiles, pickFolder } from "./pickers";
import type { DocumentRole, MeetingProfile, ProfileDocument } from "../../lib/profileTypes";
import { useProfileStore } from "../../stores/profileStore";

interface Props {
  profile: MeetingProfile;
  onEditInstructions: () => void;
}

const STATUS_TONE = { indexed: "success", failed: "warning", missing: "warning" } as const;

export function SourcesSection({ profile, onEditInstructions }: Props) {
  const documents = useProfileStore((s) => s.documents);
  const slides = useProfileStore((s) => s.slides);
  const report = useProfileStore((s) => s.lastReport);
  const busy = useProfileStore((s) => s.busy);
  const addFiles = useProfileStore((s) => s.addFiles);
  const addFolder = useProfileStore((s) => s.addFolder);
  const refreshSources = useProfileStore((s) => s.refreshSources);
  const removeDocument = useProfileStore((s) => s.removeDocument);
  const removeFolder = useProfileStore((s) => s.removeFolder);
  const setDocumentRole = useProfileStore((s) => s.setDocumentRole);
  const setPresentation = useProfileStore((s) => s.setPresentation);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const presentationDoc = profile.presentation.source === "pptx" ? (slides[0]?.documentId ?? null) : null;

  const guarded = async (task: () => Promise<void>) => {
    setPickError(null);
    try {
      await task();
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    }
  };

  const onAddFiles = () => guarded(async () => {
    const paths = await pickFiles();
    if (paths.length) await addFiles(paths, "reference");
  });
  const onAddFolder = (kind: "local" | "cloud") => guarded(async () => {
    const path = await pickFolder(kind === "cloud" ? "Choose a folder synced by the Google Drive or OneDrive app" : "Choose a folder to index");
    if (path) await addFolder(path, kind, kind === "cloud" ? folderLabel(path) : undefined);
  });

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnSecondary} onClick={onAddFiles} disabled={busy}>
          <FileText className="h-3.5 w-3.5" aria-hidden="true" /> Add Files
        </button>
        <button type="button" className={btnSecondary} onClick={() => onAddFolder("local")} disabled={busy}>
          <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" /> Add Local Folder
        </button>
        <button type="button" className={btnSecondary} onClick={() => setCloudOpen((v) => !v)} aria-expanded={cloudOpen} aria-controls="cloud-folder-help">
          <Cloud className="h-3.5 w-3.5" aria-hidden="true" /> Connect Cloud Folder
        </button>
        <button type="button" className={btnSecondary} onClick={onEditInstructions}>
          <PenLine className="h-3.5 w-3.5" aria-hidden="true" /> Edit Meeting Instructions
        </button>
      </div>
      <p className={hintCls}>Supported: .md .txt .pdf .docx .pptx. Files are read and indexed on this computer only.</p>

      {cloudOpen && (
        <div id="cloud-folder-help" className="rounded-lg border border-border/30 bg-secondary/20 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          <p>
            <strong className="text-foreground">Direct Google Drive / OneDrive / SharePoint sign-in is not built into NexQ yet.</strong>{" "}
            NexQ never reads browser tokens or cookies. If the Google Drive or OneDrive desktop app already syncs a folder to this
            computer, you can add that folder as a cloud-synced folder; NexQ indexes the local copy.
          </p>
          <button type="button" className={`${btnSecondary} mt-2`} onClick={() => onAddFolder("cloud")} disabled={busy}>
            <Cloud className="h-3.5 w-3.5" aria-hidden="true" /> Choose synced folder…
          </button>
        </div>
      )}

      {pickError && <Alert>{pickError}</Alert>}
      {report && <IngestSummary report={report} />}

      {profile.sourceFolders.length > 0 && (
        <ul className="space-y-1" aria-label="Connected folders">
          {profile.sourceFolders.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 rounded-lg bg-secondary/20 px-3 py-1.5 text-xs">
              <span className="min-w-0 truncate" title={f.path}>
                <Chip tone="muted">{f.kind === "cloud" ? "Cloud-synced" : "Local"}</Chip> {f.label || folderLabel(f.path)}
                <span className="ml-1 text-meta text-muted-foreground">{f.path}</span>
              </span>
              <button type="button" className={btnQuiet} onClick={() => removeFolder(f.id)} aria-label={`Remove folder ${f.label || f.path}`}>
                Remove folder
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-foreground">Documents ({documents.length})</h3>
        <button type="button" className={`${btnQuiet} flex items-center gap-1`} onClick={refreshSources} disabled={busy}>
          <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} aria-hidden="true" /> Refresh sources
        </button>
      </div>

      {documents.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/40 px-3 py-4 text-center text-xs text-muted-foreground">
          No documents yet. Add the files NexQ should answer from.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {documents.map((d) => (
            <DocumentRow
              key={d.id}
              doc={d}
              isPresentation={presentationDoc === d.id}
              disabled={busy}
              onRole={(role) => setDocumentRole(d.id, role)}
              onRemove={() => removeDocument(d.id)}
              onPresentation={() => setPresentation(d.id)}
            />
          ))}
        </ul>
      )}
      <p className={hintCls}>
        Reference documents are untrusted data: text inside them is never followed as an instruction. Only files you mark
        “Instruction file” act as your own instructions.
      </p>
    </>
  );
}

function DocumentRow({
  doc, isPresentation, disabled, onRole, onRemove, onPresentation,
}: {
  doc: ProfileDocument;
  isPresentation: boolean;
  disabled: boolean;
  onRole: (role: DocumentRole) => void;
  onRemove: () => void;
  onPresentation: () => void;
}) {
  const isDeck = doc.fileType.toLowerCase().replace(".", "") === "pptx";
  return (
    <li className="rounded-lg border border-border/30 bg-secondary/10 px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground" title={doc.sourcePath}>{doc.name}</p>
          <p className="truncate text-meta text-muted-foreground" title={doc.sourcePath}>{doc.sourcePath}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Chip tone="muted">{doc.fileType.replace(".", "").toUpperCase()}</Chip>
          <Chip tone={STATUS_TONE[doc.status]}>{doc.status}</Chip>
          <span className="text-meta text-muted-foreground">{doc.chunkCount} {doc.chunkCount === 1 ? "chunk" : "chunks"}</span>
        </div>
      </div>
      {doc.error && <p className="mt-1 text-meta text-destructive">Error: {doc.error}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-meta text-muted-foreground">
          Role
          <select
            className="rounded-md border border-border/40 bg-secondary/30 px-1.5 py-1 text-xs text-foreground"
            value={doc.role}
            disabled={disabled}
            onChange={(e) => onRole(e.target.value as DocumentRole)}
            aria-label={`Role of ${doc.name}`}
            title="Reference: untrusted data, never gets authority. Instruction file: you chose this file as instructions."
          >
            <option value="reference">Reference</option>
            <option value="instruction">Instruction file</option>
          </select>
        </label>
        {isDeck && (
          isPresentation ? (
            <Chip tone="success">Presentation for this meeting</Chip>
          ) : (
            <button type="button" className={btnQuiet} onClick={onPresentation} disabled={disabled}>Use as presentation</button>
          )
        )}
        <button type="button" className={`${btnQuiet} ml-auto flex items-center gap-1`} onClick={onRemove} disabled={disabled} aria-label={`Remove ${doc.name}`}>
          <Trash2 className="h-3 w-3" aria-hidden="true" /> Remove
        </button>
      </div>
    </li>
  );
}
