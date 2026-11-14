import type { MeetingType, Platform, ProfileSummary } from "./profileTypes";

/** What the user chose on the meeting-detection prompt (besides the call's own name). */
export type StartChoice =
  | { kind: "profile"; profileId: string }
  /** A new Presentation + Q&A meeting prepared for this call; opens its setup, never starts by itself. */
  | { kind: "new_presentation_qa"; name: string; platform: Platform };

/** The call platform the detector reports, as the meeting profile's platform. */
export function platformForApp(app: string): Platform {
  switch (app) {
    case "zoom": return "zoom";
    case "teams": return "teams";
    case "google_meet": return "meet";
    default: return "other";
  }
}

const stamp = (p: ProfileSummary) => p.lastUsedAt ?? p.updatedAt;

/**
 * Saved meetings, most recently used first (a meeting never run falls back to its last edit).
 * `type` limits the list (Presentation + Q&A only).
 */
export function recentProfiles(summaries: ProfileSummary[], type?: MeetingType, limit = 6): ProfileSummary[] {
  return summaries
    .filter((p) => !type || p.meetingType === type)
    .sort((a, b) => stamp(b).localeCompare(stamp(a)))
    .slice(0, limit);
}

/** An already prepared Presentation + Q&A meeting with this name, so a detected call never gets a duplicate. */
export function findExistingPresentationQa(summaries: ProfileSummary[], name: string): ProfileSummary | null {
  const wanted = name.trim().toLowerCase();
  return summaries.find((p) => p.meetingType === "presentation_qa" && p.name.trim().toLowerCase() === wanted) ?? null;
}
