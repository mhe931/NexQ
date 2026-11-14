import { useEffect, useRef, useState } from "react";
import { Pause, Play, Square, Volume2, VolumeX } from "lucide-react";
import { spokenText } from "./AnswerView";
import { usePresenterStore } from "../stores/presenterStore";
import { useStreamStore } from "../stores/streamStore";
import type { Palette } from "./theme";

const ctl =
  "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold cursor-pointer " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Optional spoken answers (only mounted when the meeting's output is "spoken").
 * Uses the system text-to-speech voice through the browser engine, on the
 * default output device. Nothing is routed to the microphone.
 */
export default function SpokenControls({ colors }: { colors: Palette }) {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  const finishedId = useStreamStore((s) => s.currentId);
  const streaming = useStreamStore((s) => s.isStreaming);
  const muted = usePresenterStore((s) => s.speechMuted);
  const toggleMuted = usePresenterStore((s) => s.toggleSpeechMuted);
  const [paused, setPaused] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const spokenFor = useRef<string | null>(null);

  const stop = () => {
    synth?.cancel();
    setPaused(false);
    setSpeaking(false);
  };

  // A new answer cuts the old one off.
  useEffect(() => {
    if (streaming) stop();
  }, [streaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Speak each finished answer once, unless muted.
  useEffect(() => {
    if (!synth || muted || !finishedId || spokenFor.current === finishedId) return;
    const text = spokenText(useStreamStore.getState().currentContent).trim();
    spokenFor.current = finishedId;
    if (!text) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utterance);
  }, [finishedId, muted, synth]);

  useEffect(() => () => { synth?.cancel(); }, [synth]);

  if (!synth) {
    return <p className="text-meta" style={{ color: colors.muted }} role="status">Spoken answers are not available on this system.</p>;
  }

  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Spoken answer controls">
      <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={stop} disabled={!speaking} aria-label="Stop speaking">
        <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" /> Stop
      </button>
      <button
        type="button"
        className={ctl}
        style={{ borderColor: colors.border }}
        disabled={!speaking}
        aria-label={paused ? "Resume speaking" : "Pause speaking"}
        onClick={() => {
          if (paused) synth.resume(); else synth.pause();
          setPaused(!paused);
        }}
      >
        {paused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
      <button
        type="button"
        className={ctl}
        style={{ borderColor: colors.border }}
        aria-pressed={muted}
        aria-label={muted ? "Unmute spoken answers" : "Mute spoken answers"}
        onClick={() => {
          if (!muted) stop();
          toggleMuted();
        }}
      >
        {muted ? <VolumeX className="h-3.5 w-3.5" aria-hidden="true" /> : <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
    </div>
  );
}
