import { describe, expect, it } from "vitest";
import { detectDirection } from "./textDirection";

describe("detectDirection", () => {
  it("is ltr for Latin text", () => {
    expect(detectDirection("Hello world")).toBe("ltr");
  });

  it("is rtl for Persian, Arabic and Hebrew", () => {
    expect(detectDirection("سلام دنیا")).toBe("rtl");
    expect(detectDirection("مرحبا")).toBe("rtl");
    expect(detectDirection("שלום")).toBe("rtl");
  });

  it("follows the first strong character in mixed text", () => {
    expect(detectDirection("سلام hello")).toBe("rtl");
    expect(detectDirection("hello سلام")).toBe("ltr");
  });

  it("skips digits, punctuation and spaces", () => {
    expect(detectDirection("  123 — (۱۲۳) سلام")).toBe("rtl");
    expect(detectDirection("«»! 42. Hello")).toBe("ltr");
    expect(detectDirection("۱۲۳ hello")).toBe("ltr");
  });

  it("covers the presentation-form and supplement ranges", () => {
    expect(detectDirection("\uFB50")).toBe("rtl");
    expect(detectDirection("\uFE70")).toBe("rtl");
    expect(detectDirection("\u0750")).toBe("rtl");
    expect(detectDirection("\u08A0")).toBe("rtl");
  });

  it("honours explicit direction marks and a ZWNJ does not matter", () => {
    expect(detectDirection("\u200F hello")).toBe("rtl");
    expect(detectDirection("\u200E سلام")).toBe("ltr");
    expect(detectDirection("\u200Cمی‌خواهم")).toBe("rtl");
  });

  it("defaults to ltr without any strong character", () => {
    expect(detectDirection("")).toBe("ltr");
    expect(detectDirection("123 ... 456")).toBe("ltr");
  });
});
