import type { Shortcuts, SlideRow } from "./profileTypes";

export type PresenterKey =
  | "next" | "prev" | "first" | "last" | "start_qa" | "scroll_down" | "scroll_up" | "toggle_hide";

/** The slide with exactly this number, or null: notes are never borrowed from a neighbour. */
export function slideByNumber(slides: SlideRow[], slideNo: number): SlideRow | null {
  return slides.find((s) => s.slideNo === slideNo) ?? null;
}

export function notesFor(slide: SlideRow | null): string {
  if (!slide) return "";
  // The backend resolves edited > external/embedded by the meeting's priority.
  if (slide.effectiveNotes !== undefined) return slide.effectiveNotes;
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
  return presenterAction(e, DEFAULT_SHORTCUTS);
}

export const DEFAULT_SHORTCUTS: Shortcuts = {
  next: ["ArrowRight", "PageDown", "n"],
  prev: ["ArrowLeft", "PageUp", "p"],
  first: ["Home"],
  last: ["End"],
  startQa: ["q"],
};

const sameKey = (pressed: string, configured: string) =>
  pressed === configured || (configured.length === 1 && pressed.toLowerCase() === configured.toLowerCase());

/**
 * The presenter action for a key press under the meeting's configurable shortcuts.
 * ArrowUp/ArrowDown (scroll) and H (hide) are fixed and cannot be reassigned.
 */
export function presenterAction(
  e: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; target?: EventTarget | null },
  shortcuts: Shortcuts,
): PresenterKey | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return null;
  if (e.key === "ArrowDown") return "scroll_down";
  if (e.key === "ArrowUp") return "scroll_up";
  if (e.key === "h" || e.key === "H") return "toggle_hide";
  const table: Array<[PresenterKey, string[]]> = [
    ["next", shortcuts.next], ["prev", shortcuts.prev], ["first", shortcuts.first],
    ["last", shortcuts.last], ["start_qa", shortcuts.startQa],
  ];
  for (const [action, keys] of table) {
    if (keys.some((k) => sameKey(e.key, k))) return action;
  }
  return null;
}
