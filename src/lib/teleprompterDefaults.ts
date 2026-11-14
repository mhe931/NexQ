export const DEFAULT_TELEPROMPTER_TEXT = {
  fontSize: 28,
  fontFamily: "",
  textDirection: "auto",
  colorPreset: "auto",
  lineSpacing: 1.45,
  lineChars: 60,
  opacity: 0.92,
  scrollSpeed: 0,
  highContrast: true,
} as const;

/** Sensible bounds for the live controls (the backend accepts a slightly wider range). */
export const TEXT_LIMITS = {
  fontSize: { min: 14, max: 96, step: 2 },
  lineSpacing: { min: 1.0, max: 2.5, step: 0.05 },
  lineChars: { min: 20, max: 200, step: 5 },
  opacity: { min: 0.3, max: 1, step: 0.05 },
  scrollSpeed: { min: 0, max: 200, step: 5 },
} as const;
