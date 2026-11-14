import { describe, expect, it } from "vitest";
import { directionProps, fontStack, noteParagraphs, stepFontSize } from "./presenterTypography";

describe("fontStack", () => {
  it("puts the chosen family first, quoted, then fallbacks that cover Persian", () => {
    expect(fontStack("Vazirmatn")).toBe(
      `"Vazirmatn", 'Segoe UI', Tahoma, 'Noto Sans Arabic', 'Noto Naskh Arabic', system-ui, sans-serif`,
    );
  });

  it("is only the fallbacks without a family", () => {
    const stack = fontStack("");
    expect(stack.startsWith("'Segoe UI'")).toBe(true);
    expect(stack).toContain("'Noto Naskh Arabic'");
    expect(fontStack("   ")).toBe(stack);
    expect(fontStack(undefined)).toBe(stack);
  });

  it("escapes quotes, backslashes and control characters", () => {
    expect(fontStack('Evil"; color: red; x:"')).toContain('"Evil\\"; color: red; x:\\""');
    expect(fontStack("A\\B")).toContain('"A\\\\B"');
    expect(fontStack("A\nB;}")).toContain('"A B;}"');
  });
});

describe("noteParagraphs", () => {
  it("splits on newlines and drops blank lines", () => {
    expect(noteParagraphs("one\n\ntwo\r\nthree\n   \nfour")).toEqual(["one", "two", "three", "four"]);
  });

  it("keeps each line exactly, including ZWNJ, direction marks and indentation", () => {
    const line = "  می\u200Cخواهم \u200Fhello\u200E ";
    expect(noteParagraphs(`${line}\nx`)[0]).toBe(line);
  });

  it("is empty for blank text", () => {
    expect(noteParagraphs("")).toEqual([]);
    expect(noteParagraphs(" \n \n")).toEqual([]);
  });
});

describe("directionProps", () => {
  it("auto: every paragraph decides by itself", () => {
    const p = directionProps("auto");
    expect(p.paragraph.dir).toBe("auto");
    expect(p.paragraph.style).toMatchObject({ unicodeBidi: "plaintext", textAlign: "start" });
    expect(p.container.dir).toBeUndefined();
  });

  it.each(["ltr", "rtl"] as const)("%s: forced on the container with isolate", (d) => {
    const p = directionProps(d);
    expect(p.container.dir).toBe(d);
    expect(p.container.style).toMatchObject({ unicodeBidi: "isolate", textAlign: "start" });
    expect(p.paragraph.dir).toBeUndefined();
  });
});

describe("stepFontSize", () => {
  it("steps by the configured step inside the limits", () => {
    expect(stepFontSize(28, 1)).toBe(30);
    expect(stepFontSize(28, -1)).toBe(26);
    expect(stepFontSize(96, 1)).toBe(96);
    expect(stepFontSize(14, -1)).toBe(14);
    expect(stepFontSize(15, -1)).toBe(14);
  });
});
