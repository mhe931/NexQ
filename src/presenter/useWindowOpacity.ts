import { useEffect, useState } from "react";
import { profileIpc } from "../lib/profileIpc";
import { TEXT_LIMITS } from "../lib/teleprompterDefaults";

/** A usable window opacity: within 20–100 %, and fully opaque for anything unusable. */
export function clampWindowOpacity(opacity: number): number {
  const { min, max } = TEXT_LIMITS.windowOpacity;
  return Math.min(Math.max(Number.isFinite(opacity) ? opacity : max, min), max);
}

// Calls reach the native window one after the other, so the last one sent is the one that sticks.
let queue: Promise<unknown> = Promise.resolve();
function send(opacity: number | null): Promise<void> {
  const result = queue.then(() => profileIpc.setPresenterWindowOpacity(opacity));
  queue = result.catch(() => {});
  return result;
}

/**
 * Fades the entire presenter window (background, text, buttons, borders) at the
 * operating-system level, so the windows behind it show through. The window
 * returns to its normal look when the presenter closes.
 *
 * Returns the CSS opacity the caller must apply to its root: 1 when the
 * native window opacity is in charge, the requested value on platforms or
 * previews where it is unavailable (the whole root then fades instead).
 */
export function useWindowOpacity(opacity: number): number {
  const value = clampWindowOpacity(opacity);
  const [native, setNative] = useState<boolean | null>(null);

  useEffect(() => {
    let current = true;
    send(value).then(
      () => { if (current) setNative(true); },
      () => { if (current) setNative(false); },
    );
    return () => { current = false; };
  }, [value]);

  useEffect(() => () => { send(null).catch(() => {}); }, []);

  return native === false ? value : 1;
}
