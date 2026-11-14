import { useEffect } from "react";
import { usePresenterStore } from "../stores/presenterStore";

export const POLL_INTERVAL_MS = 500;

/**
 * Follows the bound presentation: while the notes are visible and a presentation
 * is connected, ask the store to read its slide twice a second, so a slide changed
 * in PowerPoint itself is adopted (or flagged as out of sync). Polls never overlap.
 */
export function usePresentationSync() {
  const phase = usePresenterStore((s) => s.phase);
  const hidden = usePresenterStore((s) => s.hidden);
  const bound = usePresenterStore((s) => ["connected", "out_of_sync", "waiting"].includes(s.binding.state));
  const active = phase === "presentation" && !hidden && bound;

  useEffect(() => {
    if (!active) return;
    let running = false;
    let stopped = false;
    const id = setInterval(() => {
      if (running || stopped) return;
      running = true;
      usePresenterStore.getState().pollBinding().catch(() => {}).finally(() => { running = false; });
    }, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [active]);
}
