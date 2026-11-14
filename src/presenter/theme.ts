import type { CSSProperties } from "react";
import { fontStack } from "../lib/presenterTypography";
import type { TeleprompterSettings } from "../lib/profileTypes";
import { DEFAULT_TELEPROMPTER_TEXT } from "../lib/teleprompterDefaults";

export interface Palette {
  /** Always an opaque colour: the window's opacity is applied to the window as a whole, never to this. */
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  /** Text on an accent-coloured button. */
  onAccent: string;
  border: string;
}

const onBlack = (fg: string, muted: string, accent: string): Palette => ({
  bg: "#000000", fg, muted, accent, onAccent: "#000000", border: "rgba(255,255,255,0.35)",
});

/**
 * Colours for the notes window. A chosen colour preset wins; "auto" keeps the
 * previous behaviour: high contrast is white on black, otherwise the app's own theme tokens.
 * Every colour is opaque; the window opacity fades the finished window.
 */
export function palette(t: TeleprompterSettings): Palette {
  switch (t.colorPreset) {
    case "white_on_black":
      return onBlack("#ffffff", "#d4d4d8", "#fde047");
    case "yellow_on_black":
      return onBlack("#fde047", "#e7d98a", "#ffffff");
    case "green_on_black":
      return onBlack("#4ade80", "#9bd8b3", "#ffffff");
    case "black_on_white":
      return {
        bg: "#ffffff", fg: "#000000", muted: "#3f3f46", accent: "#1d4ed8",
        onAccent: "#ffffff", border: "rgba(0,0,0,0.35)",
      };
    default:
      break;
  }
  if (t.highContrast) return onBlack("#ffffff", "#d4d4d8", "#fde047");
  return {
    bg: "hsl(var(--background))",
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
