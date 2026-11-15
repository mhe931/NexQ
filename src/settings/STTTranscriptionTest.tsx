import { useEffect, useRef, useState } from "react";
import { testSTTTranscription } from "../lib/ipc";
import type { PartyAudioConfig, PartyRole } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";
import { useMeetingStore } from "../stores/meetingStore";

function selectionKey(party: PartyRole, config: PartyAudioConfig | undefined, language: string) {
  return JSON.stringify([party, config?.stt_provider, config?.local_model_id ?? "base", language]);
}

function captureIsActive() {
  const audio = useLiveQAHealthStore.getState().audio;
  return useMeetingStore.getState().listening
    || audio.you?.status === "active" || audio.them?.status === "active";
}

/** File-only diagnostic of the saved per-party selection, never a live-STT probe. */
export function STTTranscriptionTest() {
  const config = useConfigStore((s) => s.meetingAudioConfig);
  const language = useConfigStore((s) => s.sttLanguage);
  const listening = useMeetingStore((s) => s.listening);
  const audio = useLiveQAHealthStore((s) => s.audio);
  const openSettings = useMeetingStore((s) => s.openSettings);
  const [party, setParty] = useState<PartyRole>("Them");
  const [phase, setPhase] = useState<"idle" | "choosing" | "testing">("idle");
  const [feedback, setFeedback] = useState<{ key: string; success: boolean; message: string } | null>(null);
  const mounted = useRef(false);
  const requestEpoch = useRef(0);
  const busy = useRef(false);
  const partyKey = party === "You" ? "you" : "them";
  const selected = config?.[partyKey];
  const key = selectionKey(party, selected, language);
  const supported = selected?.stt_provider === "whisper_cpp";
  const capturing = listening || audio.you?.status === "active" || audio.them?.status === "active";
  const currentFeedback = !capturing && feedback?.key === key ? feedback : null;

  useEffect(() => {
    mounted.current = true;
    requestEpoch.current += 1;
    setFeedback(null);
    return () => {
      mounted.current = false;
      requestEpoch.current += 1;
    };
  }, [key, capturing]);

  const test = async () => {
    if (!supported || captureIsActive() || busy.current) return;
    busy.current = true;
    const epoch = ++requestEpoch.current;
    const isCurrent = () => {
      const saved = useConfigStore.getState();
      return mounted.current && epoch === requestEpoch.current
        && key === selectionKey(party, saved.meetingAudioConfig?.[partyKey], saved.sttLanguage);
    };
    setFeedback(null);
    setPhase("choosing");
    let choosing = true;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      if (!isCurrent() || captureIsActive()) return;
      const path = await open({
        title: "Select approved PCM WAV (up to 30 seconds)",
        directory: false,
        multiple: false,
        filters: [{ name: "PCM WAV audio", extensions: ["wav"] }],
      });
      if (typeof path !== "string" || !path || !isCurrent() || captureIsActive()) return;
      choosing = false;
      setPhase("testing");
      // Native code validates PCM/duration and the exact installed model.
      // Never put returned text in meeting transcripts, state, logs or toasts.
      const text = await testSTTTranscription(path, party);
      if (!isCurrent()) return;
      const success = typeof text === "string" && text.trim().length > 0;
      setFeedback({
        key,
        success,
        message: success
          ? "File transcription passed. Live capture was not tested."
          : "No transcription returned. Try a WAV containing clear speech.",
      });
    } catch {
      if (isCurrent()) setFeedback({
        key,
        success: false,
        message: choosing
          ? "Could not open the file picker. Try again."
          : "Test failed. Check the selected Whisper.cpp model and use a valid PCM WAV of up to 30 seconds.",
      });
    } finally {
      busy.current = false;
      if (mounted.current) setPhase("idle");
    }
  };

  return (
    <section aria-label="Transcription file test" className="space-y-2 rounded-xl border border-border/30 bg-card/50 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold text-primary/80">Test transcription</h3>
        <select
          aria-label="Transcription test channel"
          value={party}
          onChange={(event) => setParty(event.target.value as PartyRole)}
          disabled={phase !== "idle"}
          className="rounded-lg border border-border/50 bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="You">You</option>
          <option value="Them">Them / Room</option>
        </select>
        <button
          type="button"
          aria-busy={phase !== "idle"}
          onClick={() => void test()}
          disabled={!supported || capturing || phase !== "idle"}
          className="rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === "choosing" ? "Choosing file…" : phase === "testing" ? "Testing transcription…" : "Test transcription"}
        </button>
      </div>
      <span role="status" aria-live="polite" aria-label="Transcription file progress" className="sr-only">
        {phase === "choosing" ? "Choosing an approved audio file." : phase === "testing" ? "Testing file transcription with the selected Whisper.cpp model." : ""}
      </span>
      <p className="text-xs text-muted-foreground">
        Use only audio you have permission to test: 16-bit PCM WAV, up to 30 seconds. No recording or cloud.
      </p>
      {supported ? (
        <p className="break-words text-xs text-muted-foreground">
          Saved Audio &amp; Devices selection: Whisper.cpp · model {selected?.local_model_id ?? "base"}. Meeting overrides are not tested.
        </p>
      ) : (
        <p className="text-xs text-warning">
          Unsupported: file tests support Whisper.cpp only. Select this channel&apos;s installed model in{" "}
          <button type="button" onClick={() => openSettings("meeting_audio")} className="underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Audio &amp; Devices</button>.
        </p>
      )}
      {capturing && <p className="text-xs text-warning">Pause listening before testing. This action will not pause or start capture.</p>}
      {currentFeedback && (
        <p role={currentFeedback.success ? "status" : "alert"} aria-label="Transcription file result" className={`text-xs ${currentFeedback.success ? "text-success" : "text-destructive"}`}>
          {currentFeedback.message}
        </p>
      )}
    </section>
  );
}
