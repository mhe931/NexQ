import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FolderOpen, Play, Plus, Settings } from "lucide-react";
import { LauncherView } from "../launcher/LauncherView";
import { MeetingSetup } from "./MeetingSetup";
import { SavedMeetings } from "./SavedMeetings";
import { Alert, btnQuiet, shortDate } from "./ui";
import { profileIpc } from "../lib/profileIpc";
import { MEETING_TYPE_LABELS, type ProfileSummary } from "../lib/profileTypes";
import { startBlockers, startProfileMeeting } from "../lib/startProfileMeeting";
import { useMeetingStore } from "../stores/meetingStore";
import { useProfileStore } from "../stores/profileStore";
import { showToast } from "../stores/toastStore";

type HomeView = "home" | "setup" | "saved" | "classic";

/** The meeting being started, and why it failed (shown inline wherever Start is offered). */
export interface StartState {
  starting: boolean;
  error: string | null;
}

const tile =
  "flex flex-col items-start gap-1.5 rounded-2xl border p-4 text-left transition-all duration-150 cursor-pointer " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

export function HomeShell() {
  const [view, setView] = useState<HomeView>("home");
  const [start, setStart] = useState<StartState>({ starting: false, error: null });
  const [blockers, setBlockers] = useState<string[]>([]);
  const summaries = useProfileStore((s) => s.summaries);
  const loadList = useProfileStore((s) => s.loadList);
  const loadCatalog = useProfileStore((s) => s.loadCatalog);
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);

  useEffect(() => {
    void loadList();
    void loadCatalog();
  }, [loadList, loadCatalog, view]);

  const recent: ProfileSummary[] = [...summaries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latest = recent[0] ?? null;

  // Why the most recent meeting cannot start yet (computed from its saved settings).
  useEffect(() => {
    if (!latest || view !== "home") {
      setBlockers([]);
      return;
    }
    let live = true;
    profileIpc
      .get(latest.id)
      .then((p) => live && setBlockers(startBlockers(p)))
      .catch(() => live && setBlockers([]));
    return () => {
      live = false;
    };
  }, [latest?.id, latest?.updatedAt, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const startMeeting = useCallback(async (id: string) => {
    setStart({ starting: true, error: null });
    try {
      const { notice } = await startProfileMeeting(id);
      if (notice) showToast(notice, "info");
      setStart({ starting: false, error: null });
    } catch (e) {
      setStart({ starting: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const openMeeting = useCallback(async (id: string) => {
    setStart({ starting: false, error: null });
    const profile = await useProfileStore.getState().open(id);
    if (profile) setView("setup");
  }, []);

  const newMeeting = useCallback(async () => {
    setStart({ starting: false, error: null });
    await useProfileStore.getState().loadCatalog();
    const profile = await useProfileStore.getState().create("New meeting", "academic_qa");
    if (profile) setView("setup");
  }, []);

  const goHome = useCallback(() => {
    useProfileStore.getState().close();
    setStart({ starting: false, error: null });
    setView("home");
  }, []);

  if (view === "classic") {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex shrink-0 items-center border-b border-border/20 px-3 py-1">
          <button type="button" className={`${btnQuiet} flex items-center gap-1`} onClick={goHome}>
            <ArrowLeft className="h-3 w-3" aria-hidden="true" /> Back to meeting home
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <LauncherView />
        </div>
      </div>
    );
  }

  if (view === "setup") {
    return <MeetingSetup onBack={goHome} onStart={startMeeting} startState={start} />;
  }

  if (view === "saved") {
    return <SavedMeetings onBack={goHome} onOpen={openMeeting} onStart={startMeeting} startState={start} />;
  }

  const meetingRunning = !!activeMeeting;
  const startDisabled = !latest || blockers.length > 0 || start.starting || meetingRunning;
  const startHint = !latest
    ? "No saved meetings yet. Create one with New Meeting; Start Meeting then runs your most recent one."
    : meetingRunning
      ? "A meeting is already running."
      : null;

  return (
    <main className="flex h-full flex-col overflow-y-auto bg-background px-8 py-8" aria-labelledby="home-title">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
        <h1 id="home-title" className="text-xl font-semibold tracking-tight text-foreground">NexQ</h1>
        <p className="mt-1 text-xs text-muted-foreground">Prepare a meeting once, then start it in one click.</p>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button type="button" onClick={newMeeting} className={`${tile} border-primary/30 bg-primary/10 hover:bg-primary/15`}>
            <Plus className="h-5 w-5 text-primary" aria-hidden="true" />
            <span className="text-sm font-semibold text-foreground">New Meeting</span>
            <span className="text-meta text-muted-foreground">Set up documents, instructions and screen</span>
          </button>
          <button
            type="button"
            onClick={() => latest && startMeeting(latest.id)}
            disabled={startDisabled}
            aria-describedby="start-hint"
            className={`${tile} border-success/30 bg-success/10 enabled:hover:bg-success/15`}
          >
            <Play className="h-5 w-5 text-success" aria-hidden="true" />
            <span className="text-sm font-semibold text-foreground">{start.starting ? "Starting…" : "Start Meeting"}</span>
            <span className="max-w-full truncate text-meta text-muted-foreground">
              {latest ? `Most recent: ${latest.name}` : "Nothing to start yet"}
            </span>
          </button>
          <button type="button" onClick={() => setView("saved")} className={`${tile} border-border/40 bg-secondary/20 hover:bg-secondary/40`}>
            <FolderOpen className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm font-semibold text-foreground">Saved Meetings</span>
            <span className="text-meta text-muted-foreground">
              {summaries.length === 1 ? "1 meeting" : `${summaries.length} meetings`}
            </span>
          </button>
          <button
            type="button"
            onClick={() => useMeetingStore.getState().setCurrentView("settings")}
            className={`${tile} border-border/40 bg-secondary/20 hover:bg-secondary/40`}
          >
            <Settings className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm font-semibold text-foreground">Global Settings</span>
            <span className="text-meta text-muted-foreground">API keys, transcription models, appearance</span>
          </button>
        </div>

        <div id="start-hint" className="mt-3 space-y-2" aria-live="polite">
          {startHint && <p className="text-xs text-muted-foreground">{startHint}</p>}
          {latest && blockers.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
              <p className="font-medium">“{latest.name}” isn't ready to start:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
              <button type="button" className={`${btnQuiet} mt-1 -ml-2`} onClick={() => openMeeting(latest.id)}>Open its setup</button>
            </div>
          )}
          {start.error && <Alert>{start.error}</Alert>}
        </div>

        {recent.length > 0 && (
          <section className="mt-6" aria-labelledby="recent-title">
            <h2 id="recent-title" className="text-meta font-semibold uppercase tracking-wider text-muted-foreground">Recent meetings</h2>
            <ul className="mt-2 divide-y divide-border/20 rounded-xl border border-border/30">
              {recent.slice(0, 3).map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => openMeeting(m.id)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Open ${m.name}`}
                  >
                    <span className="truncate font-medium text-foreground">{m.name}</span>
                    <span className="shrink-0 text-meta text-muted-foreground">
                      {MEETING_TYPE_LABELS[m.meetingType]}{m.meetingDate ? ` · ${shortDate(m.meetingDate)}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-auto pt-8 text-center">
          <button type="button" className={btnQuiet} onClick={() => setView("classic")}>Classic interview launcher</button>
        </footer>
      </div>
    </main>
  );
}
