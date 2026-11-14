/** Reading direction of a piece of text, decided by its first strong character. */
export type Direction = "ltr" | "rtl";

/** Scripts written right to left: Hebrew, Arabic, Persian, Syriac, Thaana, N'Ko and their presentation forms. */
const RTL_RANGES: Array<[number, number]> = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic, Persian
  [0x0700, 0x074f], // Syriac
  [0x0750, 0x077f], // Arabic Supplement
  [0x0780, 0x07bf], // Thaana
  [0x07c0, 0x07ff], // N'Ko
  [0x0800, 0x08ff], // Samaritan, Mandaic, Arabic Extended
  [0xfb1d, 0xfb4f], // Hebrew presentation forms
  [0xfb50, 0xfdff], // Arabic presentation forms A
  [0xfe70, 0xfeff], // Arabic presentation forms B
  [0x10800, 0x10fff],
  [0x1e800, 0x1efff],
];

const LETTER = /\p{L}/u;

const isRtlScript = (cp: number) => RTL_RANGES.some(([from, to]) => cp >= from && cp <= to);

/**
 * "rtl" when the first strong character is from a right-to-left script,
 * "ltr" for any other letter (Latin, Cyrillic, CJK, ...). Digits, punctuation,
 * spaces and combining marks are neutral and skipped. Explicit LRM/RLM/ALM
 * marks count as strong. Text without any strong character is "ltr".
 */
export function detectDirection(text: string): Direction {
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x200f || cp === 0x061c) return "rtl";
    if (cp === 0x200e) return "ltr";
    if (!LETTER.test(ch)) continue;
    return isRtlScript(cp) ? "rtl" : "ltr";
  }
  return "ltr";
}
