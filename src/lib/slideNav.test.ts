import { describe, expect, it } from "vitest";
import { lastSlide, notesFor, presenterKey, slideByNumber, stepSlide } from "./slideNav";
import type { SlideRow } from "./profileTypes";

const slide = (n: number, notes: string, edited: string | null = null): SlideRow => ({
  slideNo: n, documentId: "d", title: `T${n}`, body: "", notesOriginal: notes, notesEdited: edited,
});
const deck = [slide(1, "one"), slide(2, "two", "my two"), slide(4, "four")];

describe("slide navigation", () => {
  it("shows the notes of exactly slide N, preferring the meeting's edited copy", () => {
    expect(notesFor(slideByNumber(deck, 1))).toBe("one");
    expect(notesFor(slideByNumber(deck, 2))).toBe("my two");
    // Slide 3 does not exist: no neighbouring slide's notes may appear.
    expect(slideByNumber(deck, 3)).toBeNull();
    expect(notesFor(slideByNumber(deck, 3))).toBe("");
  });

  it("steps inside the deck without overshooting", () => {
    expect(stepSlide(deck, 1, 1)).toBe(2);
    expect(stepSlide(deck, 2, 1)).toBe(4);
    expect(stepSlide(deck, 4, 1)).toBe(4);
    expect(stepSlide(deck, 1, -1)).toBe(1);
    expect(stepSlide(deck, 3, 1)).toBe(4);
    expect(stepSlide(deck, 3, -1)).toBe(2);
    expect(stepSlide([], 5, 1)).toBe(5);
    expect(lastSlide(deck)).toBe(4);
  });

  it("maps presenter keys and ignores typing and modified shortcuts", () => {
    expect(presenterKey({ key: "ArrowRight" })).toBe("next");
    expect(presenterKey({ key: "PageUp" })).toBe("prev");
    expect(presenterKey({ key: "q" })).toBe("start_qa");
    expect(presenterKey({ key: "ArrowRight", ctrlKey: true })).toBeNull();
    const input = document.createElement("input");
    expect(presenterKey({ key: "n", target: input })).toBeNull();
    expect(presenterKey({ key: "x" })).toBeNull();
  });
});
