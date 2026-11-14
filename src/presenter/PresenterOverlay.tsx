import { Suspense, lazy, useCallback, useRef, useState } from "react";
import { ArrowLeft, EyeOff, Eye, GripHorizontal, Mic, MicOff, Square } from "lucide-react";
import { AnswerPanel } from "./AnswerPanel";
import { BindStatusChip } from "./BindPresentation";
import { ListeningNotice } from "./ListeningNotice";
import { PresenterToolbar } from "./PresenterToolbar";
import { SlideNotes } from "./SlideNotes";
import { palette, type Palette } from "./theme";
import { usePresentationSync } from "./usePresentationSync";
import { usePresenterKeys } from "./usePresenterKeys";
import { useWindowGeometry } from "./useWindowGeometry";
import { useWindowOpacity } from "./useWindowOpacity";
import { profileIpc } from "../lib/profileIpc";
import type { MeetingProfile } from "../lib/profileTypes";
import { useMeetingStore } from "../stores/meetingStore";
import { usePresenterStore } from "../stores/presenterStore";
import { showToast } from "../stores/toastStore";

// Spoken answers are optional: their code is only fetched for a meeting that asks for them.
const SpokenControls = lazy(() => import("./SpokenControls"));

const ctl =
  "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold cursor-pointer " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

type AskingToListen = null | "qa" | "resume";

/** The overlay window for a meeting that runs under a profile: a minimal, high-contrast teleprompter. */
export function PresenterOverlay() {
  const profile = usePresenterStore((s) => s.profile);
  const error = usePresenterStore((s) => s.error);
  const endMeetingFlow = useMeetingStore((s) => s.endMeetingFlow);

  if (!profile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl bg-black/90 p-4 text-sm text-white" data-tauri-drag-region>
        <p role={error ? "alert" : "status"}>{error ?? "Loading meeting…"}</p>
        <button
          type="button"
          className={ctl}
          style={{ borderColor: "rgba(255,255,255,0.4)" }}
          onClick={() => endMeetingFlow().catch((e) => showToast(e instanceof Error ? e.message : "Couldn't end meeting", "error"))}
        >
          End meeting
        </button>
      </div>
    );
  }
  return <PresenterFrame profile={profile} />;
}

function PresenterFrame({ profile }: { profile: MeetingProfile }) {
  const phase = usePresenterStore((s) => s.phase);
  const hidden = usePresenterStore((s) => s.hidden);
  const slideCount = usePresenterStore((s) => s.slides.length);
  const toggleHidden = usePresenterStore((s) => s.toggleHidden);
  const backToPresentation = usePresenterStore((s) => s.backToPresentation);
  const listening = useMeetingStore((s) => s.listening);
  const endMeetingFlow = useMeetingStore((s) => s.endMeetingFlow);

  const t = profile.environment.teleprompter;
  const colors = palette(t);
  const fallbackOpacity = useWindowOpacity(t.windowOpacity);
  const notesRef = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState<AskingToListen>(null);
  // Asked at most once per meeting: after the user agreed it is saved with the profile.
  const consented = profile.audio.listeningConsentConfirmed;

  usePresentationSync();
  useWindowGeometry();

  const listen = useCallback(async (andQa: boolean) => {
    try {
      await useMeetingStore.getState().startListening();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Couldn't start listening", "error");
    }
    if (andQa) usePresenterStore.getState().startQa();
  }, []);

  /** Listening starts at once when the user already agreed for this meeting; otherwise one inline notice asks. */
  const request = useCallback((what: "qa" | "resume") => {
    if (consented) void listen(what === "qa");
    else setAsking(what);
  }, [consented, listen]);

  const confirm = async () => {
    const what = asking;
    setAsking(null);
    usePresenterStore.getState().markListeningConsented();
    try {
      await profileIpc.setListeningConsent(profile.id, true);
    } catch (e) {
      showToast(`Couldn't save your choice for this meeting: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    await listen(what === "qa");
  };

  const decline = () => {
    const what = asking;
    setAsking(null);
    if (what === "qa") usePresenterStore.getState().startQa();
  };

  const pause = () => { void useMeetingStore.getState().pauseListening(); };

  const onScroll = useCallback((direction: 1 | -1) => {
    notesRef.current?.scrollBy?.({ top: direction * Math.round(t.fontSize * 3), behavior: "smooth" });
  }, [t.fontSize]);
  usePresenterKeys({ onStartQa: () => request("qa"), onScroll });

  const end = () =>
    endMeetingFlow()
      .then(() => showToast("Meeting ended", "info"))
      .catch((e) => showToast(e instanceof Error ? e.message : "Couldn't end meeting", "error"));

  const live = profile.sessionKind === "live";
  const sessionBadge = (
    <span
      role="status"
      className="shrink-0 rounded px-2 py-0.5 text-xs font-extrabold tracking-wide"
      style={live ? { background: "#dc2626", color: "#fff" } : { background: colors.accent, color: colors.onAccent }}
    >
      {live ? "LIVE — AI assisted" : "REHEARSAL — AI assisted"}
    </span>
  );
  const listeningBadge = (
    <span role="status" className="flex shrink-0 items-center gap-1 text-xs font-bold" style={{ color: listening ? colors.accent : colors.muted }}>
      {listening ? <Mic className="h-3.5 w-3.5" aria-hidden="true" /> : <MicOff className="h-3.5 w-3.5" aria-hidden="true" />}
      {listening ? "LISTENING" : "NOT LISTENING"}
    </span>
  );
  const frame = "relative flex h-full flex-col overflow-hidden rounded-xl border shadow-xl";
  const frameStyle = {
    background: colors.bg,
    color: colors.fg,
    borderColor: colors.border,
    opacity: fallbackOpacity < 1 ? fallbackOpacity : undefined,
  };

  if (hidden) {
    return (
      <div className={`${frame} h-auto`} style={frameStyle}>
        <div className="no-select flex cursor-move items-center gap-2 px-3 py-1.5" data-tauri-drag-region>
          {sessionBadge}
          {listeningBadge}
          <span className="min-w-0 flex-1 truncate text-xs" data-tauri-drag-region style={{ color: colors.muted }}>{profile.name}</span>
          <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={toggleHidden} aria-label="Show notes (H)">
            <Eye className="h-3.5 w-3.5" aria-hidden="true" /> Show
          </button>
          <EndButton onClick={end} />
        </div>
      </div>
    );
  }

  return (
    <div className={frame} style={frameStyle}>
      <Header
        colors={colors}
        name={profile.name}
        badges={<>{sessionBadge}{listeningBadge}<BindStatusChip colors={colors} /></>}
      >
        {phase === "qa" && (
          listening ? (
            <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={pause} aria-label="Pause listening">Pause listening</button>
          ) : (
            <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={() => request("resume")} aria-label="Resume listening">Resume listening</button>
          )
        )}
        {profile.audio.outputMode === "spoken" && (
          <Suspense fallback={null}><SpokenControls colors={colors} /></Suspense>
        )}
        <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={toggleHidden} aria-label="Hide notes (H)">
          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> Hide
        </button>
        <EndButton onClick={end} />
      </Header>

      <PresenterToolbar t={t} colors={colors} />

      {asking && <ListeningNotice colors={colors} onConfirm={() => void confirm()} onDecline={decline} />}

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2">
        {phase === "presentation" ? (
          <SlideNotes profile={profile} colors={colors} scrollRef={notesRef} onRequestQa={() => request("qa")} />
        ) : (
          <>
            {slideCount > 0 && (
              <div>
                <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={backToPresentation}>
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to slides
                </button>
              </div>
            )}
            <AnswerPanel profile={profile} colors={colors} />
          </>
        )}
      </div>
    </div>
  );
}

function Header({ name, badges, colors, children }: { name: string; badges: React.ReactNode; colors: Palette; children: React.ReactNode }) {
  return (
    <div className="no-select flex cursor-move flex-wrap items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: colors.border }} data-tauri-drag-region>
      <GripHorizontal className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" data-tauri-drag-region />
      {badges}
      <span className="min-w-0 flex-1 truncate text-xs" data-tauri-drag-region style={{ color: colors.muted }} title={name}>{name}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function EndButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="End meeting"
      className="inline-flex items-center gap-1 rounded-lg border border-red-500/60 bg-red-600/20 px-2.5 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-600/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
    >
      <Square className="h-3 w-3 fill-current" aria-hidden="true" /> End
    </button>
  );
}
