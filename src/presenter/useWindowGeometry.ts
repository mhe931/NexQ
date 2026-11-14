import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { profileIpc } from "../lib/profileIpc";
import type { DisplayInfo } from "../lib/profileTypes";
import { usePresenterStore } from "../stores/presenterStore";

/** Wait this long after the last move/resize event before saving. */
export const GEOMETRY_SAVE_DELAY_MS = 600;

interface Rect { x: number; y: number; width: number; height: number }

/** The display that holds the window's centre (else the one it overlaps most). */
function displayOf(rect: Rect, displays: DisplayInfo[]): DisplayInfo | null {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const inside = displays.find((d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height);
  if (inside) return inside;
  let best: DisplayInfo | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const w = Math.min(rect.x + rect.width, d.x + d.width) - Math.max(rect.x, d.x);
    const h = Math.min(rect.y + rect.height, d.y + d.height) - Math.max(rect.y, d.y);
    if (w > 0 && h > 0 && w * h > bestArea) {
      best = d;
      bestArea = w * h;
    }
  }
  return best;
}

/** The window rectangle with x/y relative to the display that contains it (physical pixels). */
export function relativeGeometry(rect: Rect, displays: DisplayInfo[]): Rect | null {
  const display = displayOf(rect, displays);
  if (!display) return null;
  return { x: rect.x - display.x, y: rect.y - display.y, width: rect.width, height: rect.height };
}

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Remembers where the user put the notes window: after a move or resize settles,
 * saves its position (relative to its display) and size with the meeting.
 * Does nothing outside the desktop app, and never when nothing changed.
 */
export function useWindowGeometry() {
  useEffect(() => {
    if (!inTauri()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const unlisten: Array<() => void> = [];

    const save = async () => {
      timer = null;
      try {
        const win = getCurrentWindow();
        const [pos, size, displays] = await Promise.all([win.outerPosition(), win.outerSize(), profileIpc.displays()]);
        if (disposed) return;
        const geometry = relativeGeometry({ x: pos.x, y: pos.y, width: size.width, height: size.height }, displays);
        const store = usePresenterStore.getState();
        const t = store.profile?.environment.teleprompter;
        if (!geometry || !t) return;
        if (t.x === geometry.x && t.y === geometry.y && t.width === geometry.width && t.height === geometry.height) return;
        store.patchTeleprompter(geometry);
      } catch {
        // Not saving the window position is harmless.
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void save(), GEOMETRY_SAVE_DELAY_MS);
    };

    try {
      const win = getCurrentWindow();
      for (const subscribe of [win.onMoved(schedule), win.onResized(schedule)]) {
        subscribe
          .then((off) => { if (disposed) off(); else unlisten.push(off); })
          .catch(() => {});
      }
    } catch {
      // No window API: nothing to follow.
    }

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const off of unlisten) off();
    };
  }, []);
}
