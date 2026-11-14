import type { CSSProperties } from "react";
import { fontStack } from "../lib/presenterTypography";
import type { TeleprompterSettings } from "../lib/profileTypes";
import { DEFAULT_TELEPROMPTER_TEXT, TEXT_LIMITS } from "../lib/teleprompterDefaults";

export interface Palette {
  bg: string;
  /** Always fully opaque (popovers must stay readable whatever the opacity). */
  solid: string;
  fg: string;
  muted: string;
  accent: string;
  /** Text on an accent-coloured button. */
  onAccent: string;
  border: string;
}

/** The opacity applies to the background only, and never drops below the readable minimum. */
export function backgroundAlpha(opacity: number): number {
  const { min, max } = TEXT_LIMITS.opacity;
  return Math.min(Math.max(Number.isFinite(opacity) ? opacity : max, min), max);
}

const onBlack = (alpha: number, fg: string, muted: string, accent: string): Palette => ({
  bg: `rgba(0, 0, 0, ${alpha})`, solid: "#000000", fg, muted, accent, onAccent: "#000000", border: "rgba(255,255,255,0.35)",
});

/**
 * Colours for the notes window. A chosen colour preset wins; "auto" keeps the
 * previous behaviour: high contrast is white on black, otherwise the app's own theme tokens.
 * Opacity only ever changes the background, so the text stays fully opaque.
 */
export function palette(t: TeleprompterSettings): Palette {
  const alpha = backgroundAlpha(t.opacity);
  switch (t.colorPreset) {
    case "white_on_black":
      return onBlack(alpha, "#ffffff", "#d4d4d8", "#fde047");
    case "yellow_on_black":
      return onBlack(alpha, "#fde047", "#e7d98a", "#ffffff");
    case "green_on_black":
      return onBlack(alpha, "#4ade80", "#9bd8b3", "#ffffff");
    case "black_on_white":
      return {
        bg: `rgba(255, 255, 255, ${alpha})`, solid: "#ffffff", fg: "#000000", muted: "#3f3f46", accent: "#1d4ed8",
        onAccent: "#ffffff", border: "rgba(0,0,0,0.35)",
      };
    default:
      break;
  }
  if (t.highContrast) return onBlack(alpha, "#ffffff", "#d4d4d8", "#fde047");
  return {
    bg: `hsl(var(--background) / ${alpha})`,
    solid: "hsl(var(--background))",
    fg: "hsl(var(--foreground))",
    muted: "hsl(var(--muted-foreground))",
    accent: "hsl(var(--primary))",
    onAccent: "hsl(var(--primary-foreground))",
    border: "hsl(var(--border) / 0.5)",
  };
}

/**
 * Text style: the chosen size, font (with Persian-capable fallbacks), line spacing,
 * and no wider than the configured line length (0 = fill the window).
 */
export function textColumn(t: TeleprompterSettings): CSSProperties {
  return {
    fontSize: `${t.fontSize}px`,
    fontFamily: fontStack(t.fontFamily),
    lineHeight: t.lineSpacing > 0 ? t.lineSpacing : DEFAULT_TELEPROMPTER_TEXT.lineSpacing,
    maxWidth: t.lineChars > 0 ? `${t.lineChars}ch` : undefined,
    overflowWrap: "anywhere",
  };
}
