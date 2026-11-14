import type { SlideRow } from "./profileTypes";

export type PresenterKey =
  | "next" | "prev" | "first" | "last" | "start_qa" | "scroll_down" | "scroll_up" | "toggle_hide";

/** The slide with exactly this number, or null: notes are never borrowed from a neighbour. */
export function slideByNumber(slides: SlideRow[], slideNo: number): SlideRow | null {
  return slides.find((s) => s.slideNo === slideNo) ?? null;
}

export function notesFor(slide: SlideRow | null): string {
  if (!slide) return "";
  return slide.notesEdited ?? slide.notesOriginal;
}

export function lastSlide(slides: SlideRow[]): number {
  return slides.reduce((max, s) => Math.max(max, s.slideNo), 0);
}

/** Moves by `delta` slides, staying inside the deck. */
export function stepSlide(slides: SlideRow[], current: number, delta: number): number {
  const numbers = slides.map((s) => s.slideNo).sort((a, b) => a - b);
  if (numbers.length === 0) return current;
  const index = numbers.indexOf(current);
  if (index !== -1) return numbers[Math.min(Math.max(index + delta, 0), numbers.length - 1)];
  // `current` is not a slide of the deck (a gap): step from where it would sit.
  if (delta === 0) return current;
  if (delta > 0) {
    const after = numbers.filter((n) => n > current);
    return after[delta - 1] ?? numbers[numbers.length - 1];
  }
  const before = numbers.filter((n) => n < current);
  return before[before.length + delta] ?? numbers[0];
}

/** Keyboard map for the presenter view. Ignores keys typed into inputs and modified shortcuts. */
export function presenterKey(e: {
  key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; target?: EventTarget | null;
}): PresenterKey | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return null;
  switch (e.key) {
    case "ArrowRight": case "PageDown": case "n": return "next";
    case "ArrowLeft": case "PageUp": case "p": return "prev";
    case "Home": return "first";
    case "End": return "last";
    case "q": case "Q": return "start_qa";
    case "ArrowDown": return "scroll_down";
    case "ArrowUp": return "scroll_up";
    case "h": case "H": return "toggle_hide";
    default: return null;
  }
}
