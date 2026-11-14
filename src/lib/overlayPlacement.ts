import type { DisplayInfo, EnvironmentSettings, WebcamPosition } from "./profileTypes";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EDGE = 24;

/** The display NexQ's notes should live on: the configured one, else the first. */
export function chooseNexqDisplay(displays: DisplayInfo[], env: EnvironmentSettings): DisplayInfo | null {
  if (displays.length === 0) return null;
  if (env.monitorCount <= 1 || displays.length === 1) return displays[0];
  return displays[Math.min(Math.max(env.nexqMonitor, 0), displays.length - 1)];
}

export function clampToDisplay(rect: Rect, display: DisplayInfo): Rect {
  const width = Math.min(rect.width, display.width);
  const height = Math.min(rect.height, display.height);
  return {
    width,
    height,
    x: Math.min(Math.max(rect.x, display.x), display.x + display.width - width),
    y: Math.min(Math.max(rect.y, display.y), display.y + display.height - height),
  };
}

/** Default overlay rectangle: just below the camera edge of the display, in physical pixels. */
export function teleprompterRect(
  display: DisplayInfo,
  webcam: WebcamPosition,
  size: { width: number; height: number },
  custom?: { x: number; y: number },
): Rect {
  const width = Math.min(size.width, display.width - 2 * EDGE);
  const y = display.y + EDGE;
  let x: number;
  switch (webcam) {
    case "top_left":
      x = display.x + EDGE;
      break;
    case "top_right":
      x = display.x + display.width - width - EDGE;
      break;
    case "custom":
      return clampToDisplay({ x: display.x + (custom?.x ?? EDGE), y: display.y + (custom?.y ?? EDGE), width, height: size.height }, display);
    default:
      x = display.x + Math.round((display.width - width) / 2);
  }
  return clampToDisplay({ x, y, width, height: size.height }, display);
}

/**
 * Honest visibility warnings for the chosen setup. NexQ cannot know what a
 * platform captures, so it never claims to be hidden; it says what to verify.
 */
export function screenShareWarnings(env: EnvironmentSettings, detectedDisplays: number): string[] {
  const out: string[] = [];
  if (env.monitorCount > detectedDisplays && detectedDisplays > 0) {
    out.push(`This meeting expects ${env.monitorCount} monitors but only ${detectedDisplays} detected. Check your display settings.`);
  }
  const single = env.monitorCount <= 1 || detectedDisplays <= 1;
  if (env.screenShare === "display") {
    const sameDisplay = single || env.nexqMonitor === env.presentationMonitor;
    if (sameDisplay) {
      out.push(
        "NexQ is on the display you are sharing, so participants may see your notes. NexQ does not hide itself from Teams, Zoom, Meet or recordings: use the platform's share preview to check before you start.",
      );
    }
  } else if (env.screenShare === "window" && single) {
    out.push(
      "You share one window, but the notes overlay sits on the same screen. Confirm in the platform's share preview that only the chosen window is visible.",
    );
  } else if (env.screenShare === "none" && single) {
    out.push("With one monitor, keep the overlay compact and move it near the camera; it can cover your own content.");
  }
  return out;
}
