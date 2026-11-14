import type { CSSProperties } from "react";
import type { TeleprompterSettings } from "../lib/profileTypes";

export interface Palette {
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  /** Text on an accent-coloured button. */
  onAccent: string;
  border: string;
}

/** High contrast is white on black; otherwise the app's own theme tokens. */
export function palette(t: TeleprompterSettings): Palette {
  const alpha = Math.min(Math.max(t.opacity, 0.2), 1);
  if (t.highContrast) {
    return { bg: `rgba(0, 0, 0, ${alpha})`, fg: "#ffffff", muted: "#d4d4d8", accent: "#fde047", onAccent: "#000000", border: "rgba(255,255,255,0.35)" };
  }
  return {
    bg: `hsl(var(--background) / ${alpha})`,
    fg: "hsl(var(--foreground))",
    muted: "hsl(var(--muted-foreground))",
    accent: "hsl(var(--primary))",
    onAccent: "hsl(var(--primary-foreground))",
    border: "hsl(var(--border) / 0.5)",
  };
}

/** Wrapped text no wider than the configured line length (0 = fill the window). */
export function textColumn(t: TeleprompterSettings): CSSProperties {
  return {
    fontSize: `${t.fontSize}px`,
    lineHeight: 1.45,
    maxWidth: t.lineChars > 0 ? `${t.lineChars}ch` : undefined,
    overflowWrap: "anywhere",
  };
}
