import { describe, expect, it } from "vitest";
import { backgroundAlpha, palette, textColumn } from "./theme";
import { makeProfile } from "../test/profileFixtures";

const base = makeProfile().environment.teleprompter;

describe("palette", () => {
  it("keeps high contrast (white on black) for the auto preset", () => {
    const p = palette({ ...base, colorPreset: "auto", highContrast: true });
    expect(p.fg).toBe("#ffffff");
    expect(p.bg).toBe("rgba(0, 0, 0, 0.92)");
  });

  it("uses the app theme tokens for auto without high contrast", () => {
    const p = palette({ ...base, colorPreset: "auto", highContrast: false });
    expect(p.fg).toBe("hsl(var(--foreground))");
    expect(p.bg).toContain("hsl(var(--background) / 0.92)");
  });

  it("honours each colour preset, whatever high contrast says", () => {
    const fg = (colorPreset: typeof base.colorPreset) => palette({ ...base, colorPreset, highContrast: false }).fg;
    expect(fg("white_on_black")).toBe("#ffffff");
    expect(fg("yellow_on_black")).toBe("#fde047");
    expect(fg("green_on_black")).toBe("#4ade80");
    expect(fg("black_on_white")).toBe("#000000");
    expect(palette({ ...base, colorPreset: "black_on_white" }).bg).toBe("rgba(255, 255, 255, 0.92)");
  });

  it("applies the opacity to the background only, within 30-100 %", () => {
    const low = palette({ ...base, opacity: 0.1 });
    const mid = palette({ ...base, opacity: 0.5 });
    expect(low.bg).toContain("0.3)");
    expect(mid.bg).toContain("0.5)");
    expect(low.fg).toBe(mid.fg);
    expect(low.muted).toBe(mid.muted);
    expect(palette({ ...base, opacity: 5 }).bg).toContain("1)");
    expect(backgroundAlpha(Number.NaN)).toBe(1);
  });

  it("offers an opaque surface for popovers at every opacity", () => {
    expect(palette({ ...base, opacity: 0.3 }).solid).toBe("#000000");
    expect(palette({ ...base, colorPreset: "black_on_white", opacity: 0.3 }).solid).toBe("#ffffff");
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
