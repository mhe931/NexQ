import { hintCls, inputCls, labelCls } from "../ui";
import { RadioCard } from "./SetupSection";
import {
  MEETING_TYPE_LABELS,
  PLATFORM_LABELS,
  type MeetingProfile,
  type MeetingTemplate,
  type MeetingType,
  type Platform,
  type SessionKind,
} from "../../lib/profileTypes";
import { promptIsEdited, useProfileStore } from "../../stores/profileStore";

const TYPE_HINT: Record<MeetingType, string> = {
  presentation_qa: "Present with notes, then answer questions",
  interview: "Questions and answers, with action steps",
  general: "Short answers during an ordinary meeting",
  custom: "Write your own instructions",
};

interface Props {
  profile: MeetingProfile;
  /** Asks to apply a template's text (the caller confirms before replacing an edited prompt). */
  onTemplate: (template: MeetingTemplate) => void;
}

export function BasicsSection({ profile, onTemplate }: Props) {
  const patch = useProfileStore((s) => s.patch);
  const catalog = useProfileStore((s) => s.catalog);

  const matching = catalog?.templates.find((t) => t.meetingType === profile.meetingType) ?? null;
  const suggestTemplate = !!matching && matching.id !== profile.template;

  const changeType = (type: MeetingType) => {
    if (type === profile.meetingType) return;
    const template = catalog?.templates.find((t) => t.meetingType === type);
    // An untouched prompt follows the type; an edited one is never replaced without asking.
    if (template && !promptIsEdited(profile, catalog)) {
      onTemplate(template);
    } else {
      patch({ meetingType: type });
    }
  };

  return (
    <>
      <div>
        <label htmlFor="meeting-name" className={labelCls}>Meeting name</label>
        <input id="meeting-name" className={inputCls} value={profile.name} maxLength={120} onChange={(e) => patch({ name: e.target.value })} />
      </div>

      <fieldset>
        <legend className={labelCls}>Meeting type</legend>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(MEETING_TYPE_LABELS) as MeetingType[]).map((type) => (
            <RadioCard
              key={type}
              name="meeting-type"
              value={type}
              checked={profile.meetingType === type}
              onChange={() => changeType(type)}
              title={MEETING_TYPE_LABELS[type]}
              description={TYPE_HINT[type]}
            />
          ))}
        </div>
        {suggestTemplate && matching && (
          <p className={hintCls} role="status">
            The “{matching.name}” instructions fit this type. Your current prompt was kept; apply the template under AI Instructions if you want it.{" "}
            <button type="button" className="underline hover:text-foreground" onClick={() => onTemplate(matching)}>
              Use “{matching.name}” instructions
            </button>
          </p>
        )}
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="meeting-date" className={labelCls}>Date <span className="font-normal text-muted-foreground">(optional)</span></label>
          <input
            id="meeting-date"
            type="date"
            className={inputCls}
            value={profile.meetingDate ?? ""}
            onChange={(e) => patch({ meetingDate: e.target.value || null })}
          />
        </div>
        <div>
          <label htmlFor="meeting-platform" className={labelCls}>Platform</label>
          <select id="meeting-platform" className={inputCls} value={profile.platform} onChange={(e) => patch({ platform: e.target.value as Platform })}>
            {(Object.keys(PLATFORM_LABELS) as Platform[]).map((p) => (
              <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>
            ))}
          </select>
        </div>
      </div>

      <fieldset>
        <legend className={labelCls}>Session</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["rehearsal", "live"] as SessionKind[]).map((kind) => (
            <RadioCard
              key={kind}
              name="session-kind"
              value={kind}
              checked={profile.sessionKind === kind}
              onChange={() => patch({ sessionKind: kind })}
              title={kind === "rehearsal" ? "Rehearsal" : "Live"}
              description={kind === "rehearsal" ? "Practice; you may ask for feedback" : "The real meeting; talking points only"}
            />
          ))}
        </div>
        {profile.sessionKind === "live" && (
          <div className="mt-2 flex items-start gap-2 text-xs text-foreground/90">
            <input
              id="assistance-permitted"
              type="checkbox"
              className="mt-0.5"
              aria-describedby="assistance-permitted-hint"
              checked={profile.assistancePermittedConfirmed}
              onChange={(e) => patch((p) => ({ ...p, assistancePermittedConfirmed: e.target.checked }))}
            />
            <div>
              <label htmlFor="assistance-permitted">AI assistance is permitted for this meeting</label>
              <p id="assistance-permitted-hint" className="text-meta text-muted-foreground">
                Required before a live session. Check the rules of the meeting, exam or interview first.
              </p>
            </div>
          </div>
        )}
      </fieldset>
    </>
  );
}
