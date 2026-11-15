// Watches meetingAudioConfig changes during an active meeting
// and restarts the Rust audio capture pipeline with the new config.
// This enables "hot-swap" of STT provider and audio source mid-meeting.
//
// Key design: debounce (300ms) + sequential restart. Two separate refs:
// - appliedConfigRef: what Rust currently has running (only set after successful restart)
// - pendingConfigRef: set immediately to prevent duplicate debounce scheduling

import { useEffect, useRef } from "react";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useDevLogStore } from "../stores/devLogStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { stopCapture, startCapturePerParty } from "../lib/ipc";
import { skipYouStt } from "../lib/audioMode";
import { emit } from "@tauri-apps/api/event";
import { safeServiceError } from "../lib/serviceHealth";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";

export function useAudioConfigSync() {
  const isRecording = useMeetingStore((s) => s.isRecording);
  const listening = useMeetingStore((s) => s.listening);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);

  // What Rust currently has running — only updated after successful restart
  const appliedConfigRef = useRef<string | null>(null);
  // What we've already scheduled a restart for — prevents duplicate debounces
  const pendingConfigRef = useRef<string | null>(null);
  // Guard against concurrent restart attempts
  const restartingRef = useRef(false);
  // Debounce timer to batch rapid config changes
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isRecording || !listening || !meetingAudioConfig) return;

    const configKey = JSON.stringify(meetingAudioConfig);

    // On first run (meeting just started), record the applied config
    if (appliedConfigRef.current === null) {
      appliedConfigRef.current = configKey;
      pendingConfigRef.current = configKey;
      return;
    }

    // Already applied — nothing to do
    if (appliedConfigRef.current === configKey) return;

    // Already scheduled a restart for this exact config
    if (pendingConfigRef.current === configKey) return;

    // Mark this config as pending (prevents duplicate debounce scheduling)
    pendingConfigRef.current = configKey;

    const log = useDevLogStore.getState().addEntry;
    const desc = `you=${meetingAudioConfig.you.stt_provider}` +
      (meetingAudioConfig.you.local_model_id ? `(${meetingAudioConfig.you.local_model_id})` : "") +
      `, them=${meetingAudioConfig.them.stt_provider}` +
      (meetingAudioConfig.them.local_model_id ? `(${meetingAudioConfig.them.local_model_id})` : "");
    log("info", "config", `STT config changed → ${desc}`);

    // Cancel any existing debounce — the new config supersedes it
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null;
      const meetingId = useMeetingStore.getState().activeMeeting?.id;
      if (!useMeetingStore.getState().listening) return;

      // If already restarting, clear pending so next effect re-schedules
      if (restartingRef.current) {
        log("warn", "config", "Hot-swap already in progress — queued for retry");
        pendingConfigRef.current = null;
        return;
      }

      restartingRef.current = true;

      // Read the latest config (may have changed during debounce wait)
      const latestConfig = useConfigStore.getState().meetingAudioConfig;
      if (!latestConfig) {
        restartingRef.current = false;
        return;
      }

      const latestKey = JSON.stringify(latestConfig);

      // If the latest config matches what's already running, skip
      if (appliedConfigRef.current === latestKey) {
        pendingConfigRef.current = latestKey;
        restartingRef.current = false;
        return;
      }

      log("info", "config", "Hot-swap: stopping current capture...");

      try {
        // Finalize any interim (non-final) transcript segments before restarting,
        // so they don't stay stuck as gray italic after the new provider takes over.
        useTranscriptStore.getState().finalizeAllInterim();

        // Stop current capture and wait for full cleanup. The recording stays
        // open: the new capture keeps writing the meeting's audio to it.
        await stopCapture(true);
        log("info", "config", "Hot-swap: capture stopped, waiting for resource release...");

        // Let Rust fully release WASAPI/audio resources
        await new Promise((r) => setTimeout(r, 200));

        // Re-read config in case it changed during the stop
        const freshConfig = useConfigStore.getState().meetingAudioConfig;
        const meeting = useMeetingStore.getState();
        if (!freshConfig || !meeting.listening || meeting.activeMeeting?.id !== meetingId) {
          log("warn", "config", "Hot-swap: no config available after stop");
          return;
        }

        log("info", "config", "Hot-swap: starting new capture pipeline...");
        const override = meeting.sttOverride;
        await startCapturePerParty(
          override ? { ...freshConfig.you, stt_provider: override } : freshConfig.you,
          override ? { ...freshConfig.them, stt_provider: override } : freshConfig.them,
          { skipYouStt: skipYouStt(useMeetingStore.getState().audioMode) },
        );
        const freshKey = JSON.stringify(freshConfig);
        appliedConfigRef.current = freshKey;
        pendingConfigRef.current = freshKey;
        log("info", "config", "Hot-swap complete — new STT pipeline active");
      } catch (err) {
        const msg = safeServiceError(err, "Audio").message;
        log("error", "config", `Hot-swap FAILED: ${msg}`);
        if (useMeetingStore.getState().activeMeeting?.id === meetingId) {
          useLiveQAHealthStore.getState().audioFailed(msg);
          useMeetingStore.setState({ listening: false });
          emit("capture_warning", msg).catch(() => log("error", "config", "Could not notify other windows of the capture failure"));
          emit("nexq:listening_changed", { listening: false }).catch(() => log("error", "config", "Could not synchronize paused listening with other windows"));
        }
        // Reset both refs so next config change retries
        appliedConfigRef.current = null;
        pendingConfigRef.current = null;
      } finally {
        restartingRef.current = false;
      }
    }, 300);
  }, [isRecording, listening, meetingAudioConfig]);

  // Reset when meeting ends
  useEffect(() => {
    if (!isRecording || !listening) {
      appliedConfigRef.current = null;
      pendingConfigRef.current = null;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    }
  }, [isRecording, listening]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);
}
