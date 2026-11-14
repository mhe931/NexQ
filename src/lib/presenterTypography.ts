import type { CSSProperties } from "react";
import type { TextDirection } from "./profileTypes";
import { TEXT_LIMITS } from "./teleprompterDefaults";

/** Fonts that follow the chosen one, so a missing font still renders Latin and Persian text. */
const FALLBACKS = ["'Segoe UI'", "Tahoma", "'Noto Sans Arabic'", "'Noto Naskh Arabic'", "system-ui", "sans-serif"];

/** `family` as one safely quoted CSS font-family name; null when it has no usable characters. */
function quoteFamily(family: string): string | null {
  // Control characters (incl. newlines) cannot be part of a name and could break out of the string.
  // eslint-disable-next-line no-control-regex
  const clean = family.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!clean) return null;
  return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** CSS `font-family`: the chosen family first (when any), then fallbacks that cover Persian. */
export function fontStack(family: string | null | undefined): string {
  const first = quoteFamily(family ?? "");
  return (first ? [first, ...FALLBACKS] : FALLBACKS).join(", ");
}

/**
 * Notes/answer text as paragraphs: one per non-blank line. Each paragraph is
 * returned exactly as written (no trimming or normalisation), so ZWNJ and
 * direction marks survive. Render with `white-space: pre-wrap`.
 */
export function noteParagraphs(text: string): string[] {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
}

export interface DirectionProps {
  /** On the element that holds the paragraphs. */
  container: { dir?: "ltr" | "rtl"; style: CSSProperties };
  /** On every paragraph. */
  paragraph: { dir?: "auto"; style: CSSProperties };
}

/**
 * Direction attributes for a block of paragraphs.
 *  - auto: each paragraph decides by its own first strong character (`dir="auto"`, plaintext bidi).
 *  - ltr/rtl: forced on the container; mixed-script text still orders correctly (isolate).
 * Text is always aligned to the start edge of its direction.
 */
export function directionProps(direction: TextDirection): DirectionProps {
  if (direction === "ltr" || direction === "rtl") {
    return {
      container: { dir: direction, style: { textAlign: "start", unicodeBidi: "isolate" } },
      paragraph: { style: {} },
    };
  }
  return {
    container: { style: { textAlign: "start" } },
    paragraph: { dir: "auto", style: { unicodeBidi: "plaintext", textAlign: "start" } },
  };
}

const { fontSize } = TEXT_LIMITS;

/** The font size after one A− (-1) or A+ (+1) step, kept inside the limits. */
export function stepFontSize(current: number, direction: 1 | -1): number {
  const next = current + direction * fontSize.step;
  return Math.min(fontSize.max, Math.max(fontSize.min, next));
}
