import { profileIpc } from "./profileIpc";
import { chooseNexqDisplay, teleprompterRect } from "./overlayPlacement";
import type { MeetingProfile } from "./profileTypes";
import type { LLMProviderType } from "./types";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { listLocalSTTEngines } from "./ipc";

/** Reasons a meeting cannot start yet. Empty means ready. */
export function startBlockers(profile: MeetingProfile): string[] {
  const out: string[] = [];
  if (!profile.name.trim()) out.push("Give the meeting a name.");
  if (!profile.ai.primaryProvider || !profile.ai.primaryModel) {
    out.push("Choose an AI provider and model in Advanced settings.");
  }
  if (profile.sessionKind === "live" && !profile.assistancePermittedConfirmed) {
    out.push("Confirm that AI assistance is permitted for this meeting before a live session.");
  }
  if (profile.ai.fallbackProvider && profile.ai.automaticFallback && profile.ai.fallbackConsentProvider !== profile.ai.fallbackProvider) {
    out.push(`Allow ${profile.ai.fallbackProvider} to receive this meeting's context, or turn automatic fallback off.`);
  }
  return out;
}

/** Missing local models block transcription, never authorize a cloud substitution. */
export async function transcriptionNotice(profile: MeetingProfile): Promise<string | null> {
  if (profile.audio.transcriptionEngine !== "whisper") return null;
  try {
    const engines = await listLocalSTTEngines();
    if (engines.find((engine) => engine.engine === "whisper_cpp")?.models.some((model) => model.is_downloaded)) return null;
  } catch (error) {
    console.warn("[profile] Could not check local transcription models:", error);
    return "Could not check the selected Whisper model. Configure STT before listening; typed Q&A is available.";
  }
  return "The selected Whisper engine has no downloaded model. Configure STT before listening; no other engine will be used. Typed Q&A is available.";
}

/**
 * Applies one meeting's profile and starts it. Everything meeting-specific
 * (prompt, documents, provider, model, transcription engine, overlay position)
 * comes from the profile; nothing is copied back into global settings except
 * the provider/model the app must have active to answer.
 */
export async function startProfileMeeting(profileId: string): Promise<{ notice: string | null }> {
  const profile = await profileIpc.get(profileId);
  const blockers = startBlockers(profile);
  if (blockers.length) throw new Error(blockers.join(" "));

  await profileIpc.activate(profile.id);
  const config = useConfigStore.getState();
  await config.activateLLMProvider(profile.ai.primaryProvider as LLMProviderType, {
    model: profile.ai.primaryModel ?? undefined,
  });

  const notice = await transcriptionNotice(profile);

  try {
    const displays = await profileIpc.displays();
    const display = chooseNexqDisplay(displays, profile.environment);
    if (display) {
      const t = profile.environment.teleprompter;
      const rect = teleprompterRect(display, profile.environment.webcamPosition, { width: t.width, height: t.height }, { x: t.x, y: t.y });
      await profileIpc.placeOverlay(rect.x, rect.y, rect.width, rect.height);
    }
  } catch (e) {
    console.warn("[profile] Overlay placement failed:", e);
  }

  const title = profile.meetingDate ? `${profile.name} — ${profile.meetingDate}` : profile.name;
  await useMeetingStore.getState().startMeetingFlow(title, "online", undefined, {
    profileId: profile.id,
    // Listening starts when the presenter asks for it. A meeting whose transcription was never
    // acknowledged is asked once, inline, in the presenter view rather than blocking the start.
    deferCapture: profile.meetingType === "presentation_qa" || !profile.audio.listeningConsentConfirmed,
    sttProvider: profile.audio.transcriptionEngine === "whisper" ? "whisper_cpp" : undefined,
  });
  const meeting = useMeetingStore.getState().activeMeeting;
  if (meeting) await profileIpc.linkMeeting(meeting.id, profile.id);
  return { notice };
}
