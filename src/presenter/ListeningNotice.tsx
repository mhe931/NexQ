import type { Palette } from "./theme";

interface Props {
  colors: Palette;
  onConfirm: () => void;
  onDecline: () => void;
}

const btn =
  "inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-semibold cursor-pointer " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The one-time heads-up before NexQ starts listening. It is an inline status
 * line, not a dialog: it never blocks the rest of the window, traps focus or takes it.
 */
export function ListeningNotice({ colors, onConfirm, onDecline }: Props) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b px-3 py-1 text-xs" style={{ borderColor: colors.accent }}>
      <span className="min-w-0 flex-1">
        Listening transcribes everyone on this call — make sure that is allowed.
      </span>
      <button type="button" className={btn} style={{ borderColor: colors.accent, background: colors.accent, color: colors.onAccent }} onClick={onConfirm}>
        Start listening and remember for this meeting
      </button>
      <button type="button" className={btn} style={{ borderColor: colors.border }} onClick={onDecline}>
        Not now
      </button>
    </div>
  );
}
