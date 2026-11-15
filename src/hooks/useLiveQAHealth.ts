import { useEffect, useState } from "react";
import { audioHealth, sttHealth, aiHealth, questionHealth } from "../lib/serviceHealth";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { useStreamStore } from "../stores/streamStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useQuestionStore } from "../stores/questionStore";

export function useLiveQAHealth() {
  const observed = useLiveQAHealthStore();
  const listening = useMeetingStore((s) => s.listening);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const override = useMeetingStore((s) => s.sttOverride);
  const config = useConfigStore((s) => s.meetingAudioConfig);
  const legacyProvider = useConfigStore((s) => s.sttProvider);
  const llmProvider = useConfigStore((s) => s.llmProvider);
  const llmModel = useConfigStore((s) => s.llmModel);
  const mutedYou = useConfigStore((s) => s.mutedYou);
  const mutedThem = useConfigStore((s) => s.mutedThem);
  const stream = useStreamStore();
  const hasTranscript = useTranscriptStore((s) => s.segments.some((seg) => !!seg.text.trim()));
  const hasQuestion = useQuestionStore((s) => s.questions.length > 0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!listening) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [listening]);
  const youAudio = audioHealth(observed.audio.you, listening, mutedYou, now);
  const themAudio = audioHealth(observed.audio.them, listening, mutedThem, now);
  const youListening = observed.audio.you?.status === "active" ? true : observed.audio.you?.status === "paused" ? false : listening;
  const themListening = observed.audio.them?.status === "active" ? true : observed.audio.them?.status === "paused" ? false : listening;
  const youSTT = sttHealth(observed.stt.you, override ?? config?.you.stt_provider ?? legacyProvider, youListening, mutedYou || audioMode === "in_person", now);
  const themSTT = sttHealth(observed.stt.them, override ?? config?.them.stt_provider ?? legacyProvider, themListening, mutedThem, now);
  const providerKey = (provider: string) => provider.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sameProvider = (stream.requestProvider === null || providerKey(stream.requestProvider) === providerKey(llmProvider))
    && (stream.requestModel === null || stream.requestModel === llmModel);
  const retrievalFailed = !!stream.error && stream.handlingStatus === "retrieving_context";
  const baseAI = aiHealth(sameProvider && !retrievalFailed ? stream : { phase: "idle", isStreaming: false, error: null, currentContent: "" });
  const servingDiffers = sameProvider && !!stream.currentProvider
    && (providerKey(stream.currentProvider) !== providerKey(stream.requestProvider ?? llmProvider)
      || (stream.requestModel !== null && stream.currentModel !== stream.requestModel));
  const failure = observed.aiFailures[llmProvider];
  const failedModel = failure?.model === llmModel;
  const recovered = failedModel && sameProvider && !servingDiffers
    && stream.answerOutcome === "ready" && stream.currentId !== failure.answerId
    && providerKey(stream.currentProvider) === providerKey(llmProvider) && stream.currentModel === llmModel;
  useEffect(() => {
    if (recovered && failure) observed.clearAIFailure(llmProvider, failure);
  }, [recovered, failure, llmProvider, observed.clearAIFailure]);
  const ai = failedModel && !recovered && !servingDiffers && !stream.isStreaming && stream.phase === "idle"
    ? aiHealth({ phase: "idle", isStreaming: false, error: failure.error, currentContent: "" })
    : servingDiffers && (baseAI.label === "Ready" || baseAI.label === "Answering")
      ? { ...baseAI, label: `${baseAI.label} via ${stream.currentProvider}` } : baseAI;
  return {
    audioMode,
    showYouAudio: audioMode === "online" || !!observed.audio.you?.status,
    youAudio, themAudio,
    youSTT, themSTT,
    ai: !servingDiffers && ai.tone === "neutral" && observed.aiReadyModels[llmProvider] === llmModel ? { label: "Ready", tone: "active" as const } : ai,
    question: questionHealth(stream, hasTranscript, hasQuestion),
    listeningLabel: themAudio.tone === "warning" ? "AUDIO BLOCKED"
      : themSTT.tone === "warning" ? "STT BLOCKED"
      : themAudio.label === "Paused" || themSTT.label === "Paused" ? "NOT LISTENING"
      : themAudio.label === "Active" && themSTT.tone === "active" ? "LISTENING"
      : themAudio.label === "Active" ? "AUDIO ON · STT CHECKING" : "CHECKING AUDIO / STT",
  };
}
