import { useCallback, useState } from "react";
import type { FallbackNotice } from "../lib/profileTypes";
import { useStreamStore } from "../stores/streamStore";

/** Wording for the provider-switch notice. */
export function fallbackMessage(n: FallbackNotice): string {
  const reasons: Record<string, string> = {
    credits_exhausted: "credits exhausted",
    rate_limited: "rate limited",
    timeout: "request timed out",
    auth: "authentication required",
    unavailable: "provider unavailable",
    other: "provider could not answer",
  };
  const reason = Object.prototype.hasOwnProperty.call(reasons, n.reason) ? reasons[n.reason] : reasons.other;
  return `Switched to ${n.to_provider} — ${n.from_provider}: ${reason}.`;
}

/** The latest `profile_fallback` event of this meeting, until dismissed. */
export function useFallbackNotice(): { notice: FallbackNotice | null; dismiss: () => void } {
  // Stream buffer owns event correlation; display must not adopt stale switches.
  const accepted = useStreamStore((s) => s.profileFallback);
  const [dismissed, setDismissed] = useState<FallbackNotice | null>(null);
  const notice = accepted === dismissed ? null : accepted;
  const dismiss = useCallback(() => setDismissed(accepted), [accepted]);
  return { notice, dismiss };
}
