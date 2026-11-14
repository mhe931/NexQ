import { useCallback, useState } from "react";
import { Check, Copy, MessageSquarePlus, Send, Square, X } from "lucide-react";
import { AnswerView } from "./AnswerView";
import { fallbackMessage, useFallbackNotice } from "./useFallbackNotice";
import { textColumn, type Palette } from "./theme";
import { QuestionPanel } from "../overlay/QuestionDetector";
import { ResponseProgress } from "../overlay/ResponseProgress";
import { cancelGeneration } from "../lib/ipc";
import { parseAnswer } from "../lib/answerFormat";
import { runYourAction, useAutoAnswerRunning } from "../lib/autoAnswer";
import type { MeetingProfile } from "../lib/profileTypes";
import { showToast } from "../stores/toastStore";
import { useStreamStore } from "../stores/streamStore";

interface Props {
  profile: MeetingProfile;
  colors: Palette;
}

const ctl =
  "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold cursor-pointer " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

/** Copy text: the answer, then numbered steps. */
function copyText(content: string): string {
  const p = parseAnswer(content);
  const answer = p.blocks.filter((b) => b.kind === "answer" || b.kind === "text").map((b) => b.text).join("\n");
  const steps = p.actions.map((a) => `${a.step}. ${a.text}`).join("\n");
  return [answer, steps && `Steps:\n${steps}`].filter(Boolean).join("\n\n");
}

/**
 * The Q&A view. Detected questions and typed questions go through the same
 * pipeline as the classic overlay (runUserAction -> generate_assist); only the
 * rendering of the answer differs.
 */
export function AnswerPanel({ profile, colors }: Props) {
  const content = useStreamStore((s) => s.currentContent);
  const isStreaming = useStreamStore((s) => s.isStreaming);
  const phase = useStreamStore((s) => s.phase);
  const error = useStreamStore((s) => s.error);
  const autoRunning = useAutoAnswerRunning();
  const { notice, dismiss } = useFallbackNotice();
  const [askOpen, setAskOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [copied, setCopied] = useState(false);
  const t = profile.environment.teleprompter;

  const inFlight = isStreaming || phase !== "idle";
  // An automatic answer gives way to what you ask; an answer you asked for does not.
  const locked = inFlight && !autoRunning;

  const ask = useCallback(() => {
    const text = question.trim();
    if (!text || locked) return;
    runYourAction("AskQuestion", text).catch((err) => {
      showToast(err instanceof Error ? err.message : "Couldn't send the question", "error");
    });
    setQuestion("");
    setAskOpen(false);
  }, [question, locked]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText(content));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("Couldn't copy to the clipboard", "error");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {notice && (
        <div role="status" className="flex items-start justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs" style={{ borderColor: colors.accent }}>
          <span>{fallbackMessage(notice)}</span>
          <button type="button" aria-label="Dismiss provider notice" className="shrink-0 rounded p-0.5" onClick={dismiss}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      <QuestionPanel />

      <div className="min-h-0 flex-1 overflow-y-auto scroll-smooth rounded-lg px-1" role="region" aria-label="Answer" tabIndex={0}>
        <ResponseProgress />
        {error ? (
          <p className="text-sm text-destructive" role="alert">{error}</p>
        ) : content ? (
          <AnswerView content={content} streaming={isStreaming} t={t} colors={colors} />
        ) : !inFlight ? (
          <p style={{ ...textColumn({ ...t, fontSize: Math.min(t.fontSize, 20) }), color: colors.muted }}>
            Listening for questions. You can also type one with Ask.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {askOpen ? (
          <form
            className="flex min-w-[12rem] flex-1 items-center gap-1.5"
            onSubmit={(e) => { e.preventDefault(); ask(); }}
          >
            <input
              autoFocus
              type="text"
              aria-label="Type your question"
              maxLength={2000}
              value={question}
              disabled={locked}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setAskOpen(false);
              }}
              placeholder="Type a question…"
              className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-1.5 text-sm placeholder:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ borderColor: colors.border, color: colors.fg }}
            />
            <button type="submit" className={ctl} style={{ borderColor: colors.accent, color: colors.accent }} disabled={!question.trim() || locked} aria-label="Send question">
              <Send className="h-4 w-4" aria-hidden="true" />
            </button>
          </form>
        ) : (
          <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={() => setAskOpen(true)} aria-label="Ask a question">
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" /> Ask
          </button>
        )}
        {inFlight && (
          <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={() => cancelGeneration().catch(() => showToast("Couldn't stop the answer", "error"))} aria-label="Stop answer">
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" /> Stop
          </button>
        )}
        {content && !inFlight && (
          <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={copy} aria-label="Copy answer">
            {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />} {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </div>
  );
}
