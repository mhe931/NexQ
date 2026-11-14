import { profileIpc } from "./profileIpc";
import { findExistingPresentationQa, type StartChoice } from "./meetingChoice";
import { startProfileMeeting } from "./startProfileMeeting";
import { showLauncherWindow } from "./windows";
import { useMeetingStore } from "../stores/meetingStore";
import { useProfileStore } from "../stores/profileStore";
import { showToast } from "../stores/toastStore";

let inFlight = false;

export type DetectedStart = "started" | "setup" | "ignored";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Opens the meeting's setup on the home screen (in front), for a profile that cannot start yet. */
async function openSetup(profileId: string): Promise<void> {
  useProfileStore.setState({ setupRequest: profileId });
  await showLauncherWindow().catch(() => {});
}

/**
 * Acts on the saved meeting (or new Presentation + Q&A) chosen on the meeting-detection prompt.
 * Only an explicit Start reaches here. A call that already has a NexQ meeting, or a start that is
 * still running, is ignored, so one call never produces two meeting records; and a new
 * Presentation + Q&A reuses a meeting of the same name instead of creating a duplicate.
 */
export async function startDetectedChoice(choice: StartChoice): Promise<DetectedStart> {
  if (inFlight || useMeetingStore.getState().activeMeeting) return "ignored";
  inFlight = true;
  try {
    if (choice.kind === "profile") {
      try {
        await startProfileMeeting(choice.profileId);
        return "started";
      } catch (e) {
        showToast(`${errorText(e)} Opening the meeting's setup.`, "error");
        await openSetup(choice.profileId);
        return "setup";
      }
    }

    const store = useProfileStore.getState();
    await store.loadList();
    const existing = findExistingPresentationQa(useProfileStore.getState().summaries, choice.name);
    let profileId = existing?.id ?? null;
    if (!profileId) {
      await store.loadCatalog();
      const created = await useProfileStore.getState().create(choice.name, "academic_qa");
      if (!created) {
        showToast(useProfileStore.getState().error ?? "Could not create the Presentation + Q&A meeting.", "error");
        return "ignored";
      }
      profileId = created.id;
      if (created.platform !== choice.platform) await profileIpc.save({ ...created, platform: choice.platform });
    }
    showToast(
      existing
        ? `Using your existing “${choice.name}” meeting. Check its presentation, then press Start.`
        : `Presentation + Q&A prepared for “${choice.name}”. Import your presentation, then press Start.`,
      "info",
    );
    await openSetup(profileId);
    return "setup";
  } finally {
    inFlight = false;
  }
}
