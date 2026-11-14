import { RadioCard } from "./SetupSection";
import { hintCls } from "../ui";
import type { MeetingProfile, OutputMode, TranscriptionEngine } from "../../lib/profileTypes";
import { useProfileStore } from "../../stores/profileStore";

export function OutputSection({ profile }: { profile: MeetingProfile }) {
  const patch = useProfileStore((s) => s.patch);
  const setAudio = (change: Partial<MeetingProfile["audio"]>) => patch((p) => ({ ...p, audio: { ...p.audio, ...change } }));

  return (
    <>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-foreground/80">Response output <span className="font-normal text-muted-foreground">(how answers reach you)</span></legend>
        <div className="grid grid-cols-2 gap-2">
          <RadioCard
            name="output-mode"
            value="text"
            checked={profile.audio.outputMode === "text"}
            onChange={() => setAudio({ outputMode: "text" as OutputMode })}
            title="Text"
            description="Default. Answers appear on screen."
          />
          <RadioCard
            name="output-mode"
            value="spoken"
            checked={profile.audio.outputMode === "spoken"}
            onChange={() => setAudio({ outputMode: "spoken" as OutputMode })}
            title="Spoken answer"
            description="Optional. Reads the answer aloud."
          />
        </div>
        {profile.audio.outputMode === "spoken" && (
          <p className={hintCls} role="status">
            Spoken answers use the system text-to-speech voice on your default output device. They are off by default and are never
            routed to the meeting microphone on purpose. You can stop, pause or mute them during the meeting. Use headphones so the
            other participants do not hear them.
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-xs font-medium text-foreground/80">Transcription engine <span className="font-normal text-muted-foreground">(how speech becomes text)</span></legend>
        <div className="grid grid-cols-2 gap-2">
          <RadioCard
            name="transcription-engine"
            value="auto"
            checked={profile.audio.transcriptionEngine === "auto"}
            onChange={() => setAudio({ transcriptionEngine: "auto" as TranscriptionEngine })}
            title="Automatic"
            description="Use the existing engine from Global Settings."
          />
          <RadioCard
            name="transcription-engine"
            value="whisper"
            checked={profile.audio.transcriptionEngine === "whisper"}
            onChange={() => setAudio({ transcriptionEngine: "whisper" as TranscriptionEngine })}
            title="Whisper transcription"
            description="Speech-to-text only. Used if installed; otherwise the automatic engine runs and you get a notice."
          />
        </div>
        <p className={hintCls}>
          Transcription (what NexQ hears) and spoken answers (what NexQ says) are separate settings. Whisper never speaks.
        </p>
      </fieldset>
    </>
  );
}
