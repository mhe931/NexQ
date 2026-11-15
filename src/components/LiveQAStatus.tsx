import { useId, useState } from "react";
import { useLiveQAHealth } from "../hooks/useLiveQAHealth";
import type { HealthDisplay } from "../lib/serviceHealth";
import { useMeetingStore } from "../stores/meetingStore";
import { showToast } from "../stores/toastStore";
import { useStreamStore } from "../stores/streamStore";
import { runYourAction } from "../lib/autoAnswer";
import { safeServiceError } from "../lib/serviceHealth";
import { clearProviderCreditFailure } from "../lib/ipc";
import { useConfigStore } from "../stores/configStore";
import { usePresenterStore } from "../stores/presenterStore";

const action = "rounded border border-border px-2 py-1 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function listeningConsentConfirmed(profileId: string | null) {
  const profile = usePresenterStore.getState().profile;
  return profileId === null || (profile?.id === profileId && profile.audio.listeningConsentConfirmed);
}

/** Independent pipeline health: compact, readable without hover or color. */
export function LiveQAStatus() {
  const health = useLiveQAHealth();
  const openSettings = useMeetingStore((s) => s.openSettings);
  const profileId = useMeetingStore((s) => s.profileId);
  const profile = usePresenterStore((s) => s.profile);
  const consentRequired = profileId !== null && (profile?.id !== profileId || !profile?.audio.listeningConsentConfirmed);
  const consentDescriptionId = useId();
  const lastAction = useStreamStore((s) => s.lastAction);
  const errorRetryable = useStreamStore((s) => s.errorRetryable);
  const [retrying, setRetrying] = useState(false);
  const [retryingAnswer, setRetryingAnswer] = useState(false);
  const sttBlocked = health.themSTT.tone === "warning" || (health.audioMode === "online" && health.youSTT.tone === "warning");
  const audioBlocked = health.themAudio.tone === "warning" || (health.showYouAudio && health.youAudio.tone === "warning");
  const retry = async () => {
    const meeting = useMeetingStore.getState();
    if (retrying || meeting.profileId !== profileId || !listeningConsentConfirmed(meeting.profileId)) return;
    const meetingId = meeting.activeMeeting?.id;
    setRetrying(true);
    try {
      // Recovery is not consent. Only the presenter's existing gate records it.
      await meeting.pauseListening();
      const current = useMeetingStore.getState();
      if (current.activeMeeting?.id !== meetingId || current.profileId !== meeting.profileId || !listeningConsentConfirmed(current.profileId)) return;
      await current.startListening();
    } catch {
      showToast("Couldn't restart audio. Check audio devices and STT configuration.", "error");
    } finally { setRetrying(false); }
  };
  return (
    <section aria-label="Live Q&A health" className="shrink-0 space-y-1.5 border-b border-border/30 px-3 py-2 text-xs">
      <div className="flex flex-wrap gap-x-4 gap-y-1" role="status" aria-live="polite" aria-atomic="true">
        {health.showYouAudio && <Health label="You audio" state={health.youAudio} />}
        {health.audioMode === "online" && <Health label="You STT" state={health.youSTT} />}
        <Health label={health.audioMode === "online" ? "Them audio" : "Room audio"} state={health.themAudio} />
        <Health label={health.audioMode === "online" ? "Them STT" : "Room STT"} state={health.themSTT} />
        <Health label="AI" ariaLabel="AI health" state={health.ai} />
        <Health label="Question" ariaLabel="Question handling" state={health.question} />
      </div>
      {(sttBlocked || audioBlocked || health.ai.tone === "warning") && (
        <div className="flex flex-wrap items-center gap-1.5">
          {sttBlocked && <button type="button" className={action} onClick={() => openSettings("stt")}>Configure STT</button>}
          {audioBlocked && <button type="button" className={action} onClick={() => openSettings("meeting_audio")}>Audio devices</button>}
          {(sttBlocked || audioBlocked) && <>
            <button type="button" className={action} onClick={() => void retry()} disabled={retrying || consentRequired} aria-describedby={consentRequired ? consentDescriptionId : undefined}>{retrying ? "Retrying…" : "Retry audio / STT"}</button>
            {consentRequired && <span id={consentDescriptionId} className="text-muted-foreground">Listening consent required. Use the presenter&apos;s Start Q&amp;A or Resume listening control first.</span>}
          </>}
          {health.ai.tone === "warning" && <button type="button" className={action} aria-label="Configure AI provider" onClick={() => openSettings("llm")}>AI provider / test</button>}
          {health.ai.tone === "warning" && lastAction && errorRetryable !== false && <button type="button" className={action} disabled={retryingAnswer} onClick={() => {
            setRetryingAnswer(true);
            clearProviderCreditFailure(useConfigStore.getState().llmProvider)
              .then(() => runYourAction(lastAction.mode, lastAction.question))
              .catch((error) => showToast(safeServiceError(error, "AI").message, "error"))
              .finally(() => setRetryingAnswer(false));
          }}>{retryingAnswer ? "Retrying answer…" : "Retry answer"}</button>}
          {sttBlocked && <span className="text-muted-foreground">You can still type a question with Ask.</span>}
        </div>
      )}
      {audioBlocked && <p className="text-xs text-muted-foreground">
        {[...(health.showYouAudio ? [health.youAudio] : []), health.themAudio]
          .filter((s) => s.tone === "warning")
          .map((s) => s.detail)
          .filter((detail, index, all) => detail && all.indexOf(detail) === index)
          .join(" ")}
      </p>}
    </section>
  );
}

function Health({ label, ariaLabel = label, state }: { label: string; ariaLabel?: string; state: HealthDisplay }) {
  return <span aria-label={ariaLabel} className={state.tone === "warning" ? "text-warning" : state.tone === "active" ? "text-success" : "text-muted-foreground"}>
    <span className="font-medium">{label}</span>: {state.label}
  </span>;
}
