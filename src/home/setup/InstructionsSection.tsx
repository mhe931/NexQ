import { useState } from "react";
import { Alert, btnSecondary, hintCls, inputCls, labelCls } from "../ui";
import { pickFiles } from "./pickers";
import { profileIpc } from "../../lib/profileIpc";
import type { MeetingProfile, MeetingTemplate, PromptPreview } from "../../lib/profileTypes";
import { useProfileStore } from "../../stores/profileStore";

const LAYER_LABELS: Record<string, string> = {
  safety: "Safety rules",
  meeting_prompt: "Meeting prompt",
  style: "Style",
  additional_instructions: "Additional instructions",
  instruction_files: "Instruction files",
  response_format: "Response format",
  session_label: "Session label",
};

interface Props {
  profile: MeetingProfile;
  onTemplate: (template: MeetingTemplate) => void;
}

export function InstructionsSection({ profile, onTemplate }: Props) {
  const catalog = useProfileStore((s) => s.catalog);
  const dirty = useProfileStore((s) => s.dirty);
  const patch = useProfileStore((s) => s.patch);
  const save = useProfileStore((s) => s.save);
  const addFiles = useProfileStore((s) => s.addFiles);
  const busy = useProfileStore((s) => s.busy);
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const showPreview = async () => {
    setPreviewError(null);
    // The preview is built from the saved meeting, so save pending edits first.
    if (dirty && !(await save())) {
      setPreviewError("Fix the problem shown at the bottom of the screen, then preview again.");
      return;
    }
    try {
      setPreview(await profileIpc.previewPrompt(profile.id));
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    }
  };

  const importInstructionFile = async () => {
    const paths = await pickFiles(["md", "txt"]);
    if (paths.length) await addFiles(paths, "instruction");
  };

  return (
    <>
      <div>
        <label htmlFor="template" className={labelCls}>Template</label>
        <select
          id="template"
          className={inputCls}
          value={profile.template}
          onChange={(e) => {
            const t = catalog?.templates.find((x) => x.id === e.target.value);
            if (t) onTemplate(t);
          }}
        >
          {!catalog?.templates.some((t) => t.id === profile.template) && <option value={profile.template}>{profile.template}</option>}
          {catalog?.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <p className={hintCls}>A template only fills the prompt below. You can edit it freely.</p>
      </div>

      <div>
        <label htmlFor="system-prompt" className={labelCls}>Meeting instructions (system prompt)</label>
        <textarea
          id="system-prompt"
          className={`${inputCls} min-h-[180px] resize-y font-mono leading-relaxed`}
          value={profile.systemPrompt}
          onChange={(e) => patch({ systemPrompt: e.target.value })}
        />
        <div className="mt-1">
          <button type="button" className={btnSecondary} onClick={importInstructionFile} disabled={busy}>
            Import instruction .md
          </button>
          <span className={`${hintCls} ml-2 inline`}>Added to this meeting as an “Instruction file”.</span>
        </div>
      </div>

      <div>
        <label htmlFor="additional" className={labelCls}>Additional instructions</label>
        <textarea
          id="additional"
          className={`${inputCls} min-h-[70px] resize-y`}
          value={profile.additionalInstructions}
          onChange={(e) => patch({ additionalInstructions: e.target.value })}
          placeholder="For example: keep answers under 30 seconds."
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="style" className={labelCls}>Style</label>
          <select
            id="style"
            className={inputCls}
            value={profile.style.profileId ?? ""}
            onChange={(e) => patch((p) => ({ ...p, style: { ...p.style, profileId: e.target.value || null } }))}
          >
            <option value="">None</option>
            {catalog?.styles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="style-custom" className={labelCls}>Custom style text</label>
          <input
            id="style-custom"
            className={inputCls}
            value={profile.style.customText}
            onChange={(e) => patch((p) => ({ ...p, style: { ...p.style, customText: e.target.value } }))}
            placeholder="Optional"
          />
        </div>
      </div>
      <p className={hintCls}>A style is how answers are written; it is not a synthesized voice.</p>

      <div>
        <button type="button" className={btnSecondary} onClick={showPreview} disabled={busy}>Preview combined instructions</button>
      </div>
      {previewError && <Alert>{previewError}</Alert>}
      {preview && (
        <div className="space-y-2">
          <p className="text-xs text-foreground/80">Precedence, highest first (later layers cannot override earlier ones):</p>
          <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground" aria-label="Instruction layers">
            {preview.layers.map((l) => <li key={l}>{LAYER_LABELS[l] ?? l}</li>)}
          </ol>
          <textarea readOnly aria-label="Combined instructions" className={`${inputCls} min-h-[160px] resize-y font-mono`} value={preview.text} />
        </div>
      )}
    </>
  );
}
