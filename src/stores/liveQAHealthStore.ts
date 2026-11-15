import { create } from "zustand";
import { safeServiceError, type AudioObservation, type STTObservation } from "../lib/serviceHealth";

type Party = "you" | "them";
interface AIFailureObservation {
  model: string;
  error: string;
  answerId: string | null;
}
interface LiveQAHealthState {
  audio: Record<Party, AudioObservation | null>;
  stt: Record<Party, STTObservation | null>;
  aiReadyModels: Record<string, string>;
  aiFailures: Record<string, AIFailureObservation>;
  markAIReady: (provider: string, model: string) => void;
  markAIFailed: (provider: string, model: string, error: string, answerId: string | null) => void;
  clearAIFailure: (provider: string, observation: AIFailureObservation) => void;
  forgetAIReady: (provider: string) => void;
  observeSTT: (party: Party, observation: STTObservation) => void;
  observeAudioStatus: (party: Party, observation: AudioObservation) => void;
  observeAudio: (party: Party, at: number) => void;
  audioFailed: (error: string) => void;
  reset: () => void;
}
export const useLiveQAHealthStore = create<LiveQAHealthState>((set) => ({
  audio: { you: null, them: null },
  stt: { you: null, them: null },
  aiReadyModels: {},
  aiFailures: {},
  markAIReady: (provider, model) => set((s) => {
    const aiFailures = { ...s.aiFailures };
    delete aiFailures[provider];
    return { aiReadyModels: { ...s.aiReadyModels, [provider]: model }, aiFailures };
  }),
  markAIFailed: (provider, model, error, answerId) => set((s) => {
    const aiReadyModels = { ...s.aiReadyModels };
    delete aiReadyModels[provider];
    return { aiReadyModels, aiFailures: { ...s.aiFailures, [provider]: {
      model, error: safeServiceError(error, "AI").message, answerId,
    } } };
  }),
  clearAIFailure: (provider, observation) => set((s) => {
    if (s.aiFailures[provider] !== observation) return s;
    const aiFailures = { ...s.aiFailures };
    delete aiFailures[provider];
    return { aiFailures };
  }),
  forgetAIReady: (provider) => set((s) => {
    const aiReadyModels = { ...s.aiReadyModels };
    delete aiReadyModels[provider];
    return { aiReadyModels };
  }),
  observeSTT: (party, observation) => set((s) => ({ stt: { ...s.stt, [party]: observation } })),
  observeAudioStatus: (party, observation) => set((s) => ({ audio: { ...s.audio, [party]: observation } })),
  observeAudio: (party, at) => set((s) => {
    // A buffered level is not a recovery signal for a stopped/failed stream.
    if (s.audio[party]?.status || s.audio[party]?.error) return s;
    // Capture emits ~20Hz; health only needs a heartbeat, not an audio meter.
    if (at - (s.audio[party]?.lastLevelAt ?? 0) < 1000) return s;
    return { audio: { ...s.audio, [party]: { lastLevelAt: at } } };
  }),
  audioFailed: (error) => set((s) => ({ audio: {
    // Aggregate/legacy warnings cannot identify the failed channel and must
    // never overwrite the backend's independent physical state.
    you: s.audio.you?.status ? s.audio.you : { error },
    them: s.audio.them?.status ? s.audio.them : { error },
  } })),
  reset: () => set({ audio: { you: null, them: null }, stt: { you: null, them: null }, aiReadyModels: {}, aiFailures: {} }),
}));
