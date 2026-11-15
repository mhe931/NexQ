import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { onSTTConnectionStatus, onAudioCaptureStatus, onAudioLevel, onCaptureWarning, onTranscriptUpdate, onTranscriptFinal } from "../lib/events";
import { hasApiKey } from "../lib/ipc";
import { safeServiceError } from "../lib/serviceHealth";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { showToast } from "../stores/toastStore";

/** Stay mounted before capture starts: connection events can precede the meeting UI. */
export function useSTTStatus() {
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id);
  const config = useConfigStore((s) => s.meetingAudioConfig);
  const override = useMeetingStore((s) => s.sttOverride);
  const legacyProvider = useConfigStore((s) => s.sttProvider);

  useEffect(() => {
    if (!meetingId) useLiveQAHealthStore.getState().reset();
  }, [meetingId]);

  // Missing credentials are actionable even when the failed startup event was
  // emitted before this window subscribed. A key's presence is NOT readiness.
  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;
    for (const party of ["you", "them"] as const) {
      const provider = override ?? config?.[party].stt_provider ?? legacyProvider;
      if (!["deepgram", "whisper_api", "azure_speech", "groq_whisper", "cartesia"].includes(provider)) continue;
      hasApiKey(provider).then((present) => {
        if (!cancelled && !present) useLiveQAHealthStore.getState().observeSTT(party, { provider, status: "error", message: "Missing API key" });
      }).catch(() => {
        console.warn("[STT] Credential availability check failed");
        if (!cancelled && useLiveQAHealthStore.getState().stt[party]?.status !== "connected") {
          useLiveQAHealthStore.getState().observeSTT(party, {
            provider, status: "error", message: "Could not check STT credentials. Open Settings and retry.",
          });
        }
      });
    }
    return () => { cancelled = true; };
  }, [meetingId, config, override, legacyProvider]);

  useEffect(() => {
    let mounted = true;
    const transcript: Parameters<typeof onTranscriptUpdate>[0] = ({ segment }) => {
      if (!mounted || !segment.text.trim()) return;
      const party = segment.speaker === "User" ? "you" : "them";
      const config = useConfigStore.getState();
      const provider = useMeetingStore.getState().sttOverride ?? config.meetingAudioConfig?.[party].stt_provider ?? config.sttProvider;
      const previous = useLiveQAHealthStore.getState().stt[party];
      // Old/buffered words must never clear a reported failure.
      if (previous?.provider === provider && ["error", "disconnected"].includes(previous.status)) return;
      useLiveQAHealthStore.getState().observeSTT(party, { provider, status: "connected", lastTranscriptAt: Date.now() });
    };
    const subscriptions = [
      onAudioCaptureStatus((event) => {
        const party = event.party.toLowerCase();
        if (!mounted || (party !== "you" && party !== "them")) return;
        // Device names/native response details do not belong in health state.
        useLiveQAHealthStore.getState().observeAudioStatus(party, { status: event.status });
      }),
      onSTTConnectionStatus((event) => {
        const party = event.party.toLowerCase();
        if (!mounted || (party !== "you" && party !== "them")) return;
        const cfg = useConfigStore.getState();
        const provider = useMeetingStore.getState().sttOverride ?? cfg.meetingAudioConfig?.[party].stt_provider ?? cfg.sttProvider;
        if (event.provider !== provider) return;
        useLiveQAHealthStore.getState().observeSTT(party, event);
        if (event.status === "error") showToast(safeServiceError(event.message, "STT").message, "error");
      }),
      onAudioLevel((event) => {
        if (!mounted) return;
        const party = event.source === "Mic" ? "you" : event.source === "System" || event.source === "Room" ? "them" : null;
        if (party) useLiveQAHealthStore.getState().observeAudio(party, Date.now());
      }),
      onCaptureWarning((message) => {
        if (mounted) useLiveQAHealthStore.getState().audioFailed(safeServiceError(message, "Audio").message);
      }),
      onTranscriptUpdate(transcript),
      onTranscriptFinal(transcript),
      listen<{ listening: boolean }>("nexq:listening_changed", ({ payload }) => {
        if (mounted) useMeetingStore.setState({ listening: payload.listening });
      }),
    ];
    const unlisteners: Array<() => void> = [];
    let subscriptionErrorShown = false;
    subscriptions.forEach((promise) => {
      promise.then((unlisten) => {
        if (mounted) unlisteners.push(unlisten);
        else unlisten();
      }).catch(() => {
        console.warn("[STT] Health event subscription failed");
        if (mounted && !subscriptionErrorShown) {
          subscriptionErrorShown = true;
          showToast("Audio/STT monitoring is unavailable. Restart NexQ.", "error");
        }
      });
    });
    return () => { mounted = false; unlisteners.forEach((unlisten) => unlisten()); };
  }, []);
}
