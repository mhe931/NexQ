import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { profileIpc } from "../lib/profileIpc";
import { stepFontSize } from "../lib/presenterTypography";
import type { ColorPreset, TeleprompterSettings, TextDirection } from "../lib/profileTypes";
import { TEXT_LIMITS } from "../lib/teleprompterDefaults";
import { usePresenterStore } from "../stores/presenterStore";
import { backgroundAlpha, type Palette } from "./theme";

interface Props {
  t: TeleprompterSettings;
  colors: Palette;
}

const tb =
  "inline-flex h-6 min-w-[1.75rem] items-center justify-center rounded-md border px-1.5 text-xs font-semibold cursor-pointer " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";
const field = "h-6 rounded-md border bg-transparent px-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const range = "h-4 cursor-pointer accent-current focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const DIRECTIONS: Array<{ value: TextDirection; label: string; title: string }> = [
  { value: "ltr", label: "LTR", title: "Left to right" },
  { value: "rtl", label: "RTL", title: "Right to left" },
  { value: "auto", label: "Auto", title: "Decide per paragraph from its first letter" },
];

const PRESETS: Array<{ value: ColorPreset; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "white_on_black", label: "White on black" },
  { value: "yellow_on_black", label: "Yellow on black" },
  { value: "green_on_black", label: "Green on black" },
  { value: "black_on_white", label: "Black on white" },
];

const KEYS_HINT = "Keys: ← → slides, ↑ ↓ scroll, Q start Q&A, H hide, − / + text size.";

const patch = (p: Partial<TeleprompterSettings>) => usePresenterStore.getState().patchTeleprompter(p);

/**
 * One slim row of live text controls: A− A+ · font · LTR/RTL/Auto · background opacity · Settings.
 * Every change is applied at once and saved with the meeting.
 */
export function PresenterToolbar({ t, colors }: Props) {
  const border = { borderColor: colors.border, color: colors.fg };
  const [fonts, setFonts] = useState<string[] | null>(null);
  const [fontError, setFontError] = useState<string | null>(null);
  const loading = useRef(false);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const settingsButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  /** Installed fonts are read once, the first time the list is used. */
  const loadFonts = useCallback(() => {
    if (fonts || loading.current) return;
    loading.current = true;
    profileIpc.systemFonts()
      .then((list) => { setFonts(list); setFontError(null); })
      .catch((e) => {
        setFontError(e instanceof Error ? e.message : "Couldn't list the installed fonts.");
      })
      .finally(() => { loading.current = false; });
  }, [fonts]);

  const closeSettings = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) settingsButton.current?.focus({ preventScroll: true });
  }, []);

  // Escape closes the panel from anywhere; focus only returns to the button if it was in the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      const active = document.activeElement;
      const inside = !!active && (panel.current?.contains(active) || active === settingsButton.current);
      closeSettings(inside);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeSettings]);

  const families = Array.from(new Set(["", ...(fonts ?? []), ...(t.fontFamily ? [t.fontFamily] : [])]));
  const opacity = backgroundAlpha(t.opacity);

  return (
    <div className="relative">
      <div
        role="toolbar"
        aria-label="Text controls"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1"
        style={{ borderColor: colors.border }}
        title={KEYS_HINT}
      >
        <button type="button" className={tb} style={border} aria-label="Smaller text" title="Smaller text (−)"
          disabled={t.fontSize <= TEXT_LIMITS.fontSize.min} onClick={() => patch({ fontSize: stepFontSize(t.fontSize, -1) })}>
          A−
        </button>
        <button type="button" className={tb} style={border} aria-label="Larger text" title="Larger text (+)"
          disabled={t.fontSize >= TEXT_LIMITS.fontSize.max} onClick={() => patch({ fontSize: stepFontSize(t.fontSize, 1) })}>
          A+
        </button>

        <select
          aria-label="Font"
          title="Font"
          className={`${field} max-w-[9rem]`}
          style={border}
          value={t.fontFamily}
          onFocus={loadFonts}
          onMouseDown={loadFonts}
          onChange={(e) => patch({ fontFamily: e.target.value })}
        >
          {families.map((f) => (
            <option key={f || "__default"} value={f} style={{ color: "#000" }}>{f || "Default"}</option>
          ))}
        </select>
        {fontError && <span role="status" className="text-xs" style={{ color: colors.muted }}>Fonts unavailable: using Default</span>}

        <div role="group" aria-label="Text direction" className="inline-flex overflow-hidden rounded-md border" style={{ borderColor: colors.border }}>
          {DIRECTIONS.map((d) => {
            const on = t.textDirection === d.value;
            return (
              <button
                key={d.value}
                type="button"
                aria-pressed={on}
                title={d.title}
                className="h-6 px-1.5 text-xs font-semibold cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={on ? { background: colors.accent, color: colors.onAccent } : { color: colors.fg }}
                onClick={() => patch({ textDirection: d.value })}
              >
                {d.label}
              </button>
            );
          })}
        </div>

        <label className="inline-flex items-center gap-1 text-xs" style={{ color: colors.muted }} title="Background opacity (the text stays solid)">
          <span className="sr-only">Background opacity</span>
          <span aria-hidden="true">Opacity</span>
          <input
            type="range"
            className={`${range} w-20`}
            aria-label="Background opacity"
            aria-valuetext={`${Math.round(opacity * 100)}%`}
            min={TEXT_LIMITS.opacity.min}
            max={TEXT_LIMITS.opacity.max}
            step={TEXT_LIMITS.opacity.step}
            value={opacity}
            onChange={(e) => patch({ opacity: backgroundAlpha(Number(e.target.value)) })}
          />
          <span className="w-8 tabular-nums" aria-hidden="true">{Math.round(opacity * 100)}%</span>
        </label>

        <button
          ref={settingsButton}
          type="button"
          className={`${tb} ml-auto gap-1`}
          style={border}
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          title="Text and window settings"
          onClick={() => (open ? closeSettings(true) : setOpen(true))}
        >
          <Settings className="h-3.5 w-3.5" aria-hidden="true" /> Settings
        </button>
      </div>

      {open && (
        <SettingsPanel id={panelId} panelRef={panel} t={t} colors={colors} onClose={() => closeSettings(true)} />
      )}
    </div>
  );
}

function SettingsPanel({ id, panelRef, t, colors, onClose }: {
  id: string;
  panelRef: React.RefObject<HTMLDivElement>;
  t: TeleprompterSettings;
  colors: Palette;
  onClose: () => void;
}) {
  const scrollPaused = usePresenterStore((s) => s.scrollPaused);
  const toggleScrollPaused = usePresenterStore((s) => s.toggleScrollPaused);
  const resetTeleprompter = usePresenterStore((s) => s.resetTeleprompter);
  const border = { borderColor: colors.border, color: colors.fg };
  const full = t.lineChars === 0;
  const L = TEXT_LIMITS;

  return (
    <div
      id={id}
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label="Presentation settings"
      className="absolute right-2 top-full z-30 mt-1 w-80 max-w-[calc(100%-1rem)] space-y-2 overflow-y-auto rounded-lg border p-3 text-xs shadow-xl"
      style={{ background: colors.solid, color: colors.fg, borderColor: colors.border, maxHeight: "calc(100vh - 5rem)", minHeight: "8rem" }}
    >
      <Slider label="Font size" unit="px" value={t.fontSize} {...L.fontSize} onChange={(v) => patch({ fontSize: v })} />
      <Slider label="Line spacing" value={t.lineSpacing} {...L.lineSpacing} format={(v) => v.toFixed(2)} onChange={(v) => patch({ lineSpacing: v })} />
      <div>
        <Slider
          label="Text width"
          value={full ? L.lineChars.max : t.lineChars}
          {...L.lineChars}
          disabled={full}
          format={(v) => (full ? "Full width" : `${v} chars`)}
          onChange={(v) => patch({ lineChars: v })}
        />
        <label className="mt-1 inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 cursor-pointer accent-current focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            checked={full}
            onChange={(e) => patch({ lineChars: e.target.checked ? 0 : 60 })}
          />
          Full width
        </label>
      </div>
      <Slider label="Scroll speed" unit=" px/s" value={t.scrollSpeed} {...L.scrollSpeed} onChange={(v) => patch({ scrollSpeed: v })} />
      <div className="flex items-center gap-2">
        <button type="button" className={`${tb} px-2`} style={border} onClick={toggleScrollPaused}>
          {scrollPaused ? "Resume scrolling" : "Pause scrolling"}
        </button>
        {t.scrollSpeed === 0 && <span style={{ color: colors.muted }}>Scroll speed is 0.</span>}
      </div>

      <label className="flex items-center justify-between gap-2">
        <span>Colours</span>
        <select
          aria-label="Colour preset"
          className={`${field} w-40`}
          style={border}
          value={t.colorPreset}
          onChange={(e) => patch({ colorPreset: e.target.value as ColorPreset })}
        >
          {PRESETS.map((p) => <option key={p.value} value={p.value} style={{ color: "#000" }}>{p.label}</option>)}
        </select>
      </label>

      <div className="flex items-center justify-between gap-2">
        <button type="button" className={`${tb} px-2`} style={border} onClick={resetTeleprompter}>Restore defaults</button>
        <button type="button" className={`${tb} px-2`} style={border} onClick={onClose}>Close</button>
      </div>

      <p style={{ color: colors.muted }}>
        Move the window by dragging the top bar; resize it from its edges. {KEYS_HINT}
      </p>
    </div>
  );
}

function Slider({ label, value, min, max, step, unit = "", format, disabled, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  format?: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const shown = format ? format(value) : `${value}${unit}`;
  return (
    <label className="flex items-center gap-2">
      <span className="w-24 shrink-0">{label}</span>
      <input
        type="range"
        className={`${range} min-w-0 flex-1`}
        aria-label={label}
        aria-valuetext={shown}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-20 shrink-0 text-right tabular-nums" aria-hidden="true">{shown}</span>
    </label>
  );
}
