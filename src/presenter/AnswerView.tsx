import { useMemo } from "react";
import { HelpCircle } from "lucide-react";
import { parseAnswer } from "../lib/answerFormat";
import type { TeleprompterSettings } from "../lib/profileTypes";
import { textColumn, type Palette } from "./theme";

interface Props {
  content: string;
  streaming: boolean;
  t: TeleprompterSettings;
  colors: Palette;
}

/** Plain text of the part to say aloud: the [ANSWER] (or untagged) text, never the action steps. */
export function spokenText(content: string): string {
  return parseAnswer(content).blocks
    .filter((b) => b.kind === "answer" || b.kind === "text")
    .map((b) => b.text)
    .join(" ");
}

/**
 * One answer: the direct answer first and large, then the steps the user should
 * do (numbered, marked "DO"), then the sources small. Steps are text for the
 * user: nothing here ever runs a command.
 */
export function AnswerView({ content, streaming, t, colors }: Props) {
  const parsed = useMemo(() => parseAnswer(content), [content]);
  const answers = parsed.blocks.filter((b) => b.kind === "answer" || b.kind === "text");
  const sources = parsed.blocks.filter((b) => b.kind === "source");
  const column = textColumn(t);
  const small = { fontSize: `${Math.max(12, Math.round(t.fontSize * 0.55))}px`, maxWidth: column.maxWidth, overflowWrap: "anywhere" as const };

  return (
    <div className="space-y-3" aria-live="polite" aria-busy={streaming}>
      {answers.map((b, i) => (
        <p key={`a-${i}`} className="font-semibold" style={column}>{b.text}</p>
      ))}

      {parsed.actions.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider" style={{ color: colors.accent }}>
            DO
            <span
              role="img"
              tabIndex={0}
              aria-label="About action steps: NexQ never operates your computer; these are instructions for you."
              title="NexQ never operates your computer; these are instructions for you."
              className="cursor-help rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </p>
          <ol className="space-y-1.5" aria-label="Steps for you to do">
            {parsed.actions.map((a) => (
              <li
                key={`act-${a.step}`}
                data-kind="action"
                className="flex gap-2 rounded-lg border-l-4 py-1 pl-3 pr-2"
                style={{ borderColor: colors.accent, background: "rgba(127,127,127,0.12)", ...small }}
              >
                <span className="font-bold tabular-nums" style={{ color: colors.accent }}>{a.step}.</span>
                <span>{a.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {sources.length > 0 && (
        <ul className="space-y-0.5" aria-label="Sources" style={{ color: colors.muted, fontSize: "12px" }}>
          {sources.map((s, i) => <li key={`s-${i}`}>Source: {s.text}</li>)}
        </ul>
      )}
      {streaming && <span className="inline-block h-4 w-1 animate-pulse align-middle" style={{ background: colors.accent }} aria-hidden="true" />}
    </div>
  );
}
