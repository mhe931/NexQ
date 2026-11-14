import { describe, expect, it } from "vitest";
import { palette, textColumn } from "./theme";
import { makeProfile } from "../test/profileFixtures";

const base = makeProfile().environment.teleprompter;

describe("palette", () => {
  it("keeps high contrast (white on black) for the auto preset", () => {
    const p = palette({ ...base, colorPreset: "auto", highContrast: true });
    expect(p.fg).toBe("#ffffff");
    expect(p.bg).toBe("#000000");
  });

  it("uses the app theme tokens for auto without high contrast", () => {
    const p = palette({ ...base, colorPreset: "auto", highContrast: false });
    expect(p.fg).toBe("hsl(var(--foreground))");
    expect(p.bg).toBe("hsl(var(--background))");
  });

  it("honours each colour preset, whatever high contrast says", () => {
    const fg = (colorPreset: typeof base.colorPreset) => palette({ ...base, colorPreset, highContrast: false }).fg;
    expect(fg("white_on_black")).toBe("#ffffff");
    expect(fg("yellow_on_black")).toBe("#fde047");
    expect(fg("green_on_black")).toBe("#4ade80");
    expect(fg("black_on_white")).toBe("#000000");
    expect(palette({ ...base, colorPreset: "black_on_white" }).bg).toBe("#ffffff");
  });

  it("never bakes the window opacity into a colour (the window is faded as a whole)", () => {
    for (const windowOpacity of [0.2, 0.5, 1]) {
      for (const colorPreset of ["auto", "white_on_black", "black_on_white"] as const) {
        const p = palette({ ...base, colorPreset, windowOpacity });
        expect(p.bg).not.toMatch(/rgba|\//);
      }
    }
  });
});

describe("textColumn", () => {
  it("applies size, font stack, line spacing and width", () => {
    const style = textColumn({ ...base, fontSize: 40, fontFamily: "Vazirmatn", lineSpacing: 1.8, lineChars: 50 });
    expect(style.fontSize).toBe("40px");
    expect(style.lineHeight).toBe(1.8);
    expect(style.maxWidth).toBe("50ch");
    expect(String(style.fontFamily).startsWith('"Vazirmatn", ')).toBe(true);
    expect(String(style.fontFamily)).toContain("'Noto Naskh Arabic'");
  });

  it("fills the window at width 0", () => {
    expect(textColumn({ ...base, lineChars: 0 }).maxWidth).toBeUndefined();
  });
});
