import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { FallbackNotice } from "../lib/profileTypes";

/** Wording for the provider-switch notice. */
export function fallbackMessage(n: FallbackNotice): string {
  return `Switched to ${n.to_provider} (${n.reason}) — ${n.from_provider} was unavailable`;
}

/** The latest `profile_fallback` event of this meeting, until dismissed. */
export function useFallbackNotice(): { notice: FallbackNotice | null; dismiss: () => void } {
  const [notice, setNotice] = useState<FallbackNotice | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<FallbackNotice>("profile_fallback", (e) => setNotice(e.payload))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const dismiss = useCallback(() => setNotice(null), []);
  return { notice, dismiss };
}
