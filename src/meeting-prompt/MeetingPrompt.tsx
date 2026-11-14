import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FolderClock, Play, Presentation, X } from "lucide-react";
import { dismissMeetingPrompt, getDetectedMeeting } from "../lib/ipc";
import { emitStartDetectedMeeting, onDetectedMeetingEnded, onMeetingDetected } from "../lib/events";
import { composeMeetingTitle } from "../lib/meetingTitle";
import { platformForApp, recentProfiles, type StartChoice } from "../lib/meetingChoice";
import { profileIpc } from "../lib/profileIpc";
import { MEETING_TYPE_LABELS, type ProfileSummary } from "../lib/profileTypes";
import { useMeetingScenarios, useScenarioStore } from "../stores/scenarioStore";
import type { AIScenario, MeetingPromptInfo } from "../lib/types";

/** Window height with the card alone, with the meeting-type menu open below it, and with the saved-meetings panel open. */
export const PROMPT_HEIGHT = 104;
export const PROMPT_HEIGHT_WITH_MENU = 390;
export const PROMPT_HEIGHT_WITH_PANEL = 470;

type Panel = "recent" | "presentation" | null;

const shortDate = (iso: string | null): string => {
  if (!iso) return "not used yet";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "not used yet" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/**
 * The meeting-detection prompt: a small always-on-top card at the top of the
 * screen when Zoom, Teams, Meet… start a call. Start opens a NexQ meeting
 * named after the call, or — when the user picked one — a saved meeting
 * (its documents, notes, provider and presentation). It goes away on its own
 * after a while. Detection never starts anything: only the Start buttons do.
 */
export function MeetingPrompt({
  info,
  onStart,
  onDismiss,
  onMenuToggle,
  profiles = [],
  onPanelToggle,
}: {
  info: MeetingPromptInfo;
  onStart: (title: string, scenario: AIScenario, choice?: StartChoice) => void;
  onDismiss: () => void;
  /** The meeting-type menu opened or closed (the window makes room for it). */
  onMenuToggle?: (open: boolean) => void;
  /** Saved meetings, for "Recent meetings" and "Presentation + Q&A". */
  profiles?: ProfileSummary[];
  /** The saved-meetings panel opened or closed. */
  onPanelToggle?: (open: boolean) => void;
}) {
  const { meeting } = info;
  const [title, setTitle] = useState(meeting.title ?? "");
  const [pickedScenario, setScenario] = useState<AIScenario>(info.default_scenario);
  const scenarios = useMeetingScenarios();
  const scenario = useScenarioStore((s) => s.resolveScenario(pickedScenario));
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [choice, setChoice] = useState<StartChoice | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const scenarioName = scenarios.find((s) => s.id === scenario)?.name ?? "Meeting";

  const recent = recentProfiles(profiles);
  const presentations = recentProfiles(profiles, "presentation_qa");
  const chosenProfile = choice?.kind === "profile" ? profiles.find((p) => p.id === choice.profileId) ?? null : null;
  const newPresentationName = title.trim() || meeting.title || `${meeting.app_name} meeting`;

  const start = useCallback(() => {
    const name = composeMeetingTitle(title.trim() || meeting.app_name);
    if (choice) onStart(name, scenario, choice);
    else onStart(name, scenario);
  }, [choice, meeting.app_name, onStart, scenario, title]);

  const openPanel = (next: Exclude<Panel, null>) => {
    const target = panel === next ? null : next;
    setPanel(target);
    onPanelToggle?.(target !== null);
    if (target === "presentation") {
      // The explicit Presentation + Q&A action preselects the most recent one, but still waits for Start.
      const latest = presentations[0];
      setChoice(latest ? { kind: "profile", profileId: latest.id } : { kind: "new_presentation_qa", name: newPresentationName, platform: platformForApp(meeting.app) });
    } else {
      setChoice(null);
    }
  };

  const openMenu = useCallback(() => {
    const idx = Math.max(0, scenarios.findIndex((s) => s.id === scenario));
    setFocusIdx(idx);
    setMenuOpen(true);
    onMenuToggle?.(true);
  }, [onMenuToggle, scenario, scenarios]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    onMenuToggle?.(false);
    chevronRef.current?.focus();
  }, [onMenuToggle]);

  const choose = useCallback((id: AIScenario) => {
    setScenario(id);
    closeMenu();
  }, [closeMenu]);

  // The open menu takes focus on its current option.
  useEffect(() => {
    if (menuOpen) optionRefs.current[focusIdx]?.focus();
  }, [focusIdx, menuOpen]);

  // Unanswered: goes away after auto_dismiss_secs (paused while hovered, the menu is open or a saved meeting is being chosen).
  const total = info.auto_dismiss_secs * 1000;
  const paused = hovered || menuOpen || panel !== null;
  const [left, setLeft] = useState(total);
  useEffect(() => {
    if (total <= 0 || paused) return;
    const step = 100;
    const id = window.setInterval(() => setLeft((l) => Math.max(0, l - step)), step);
    return () => window.clearInterval(id);
  }, [paused, total]);
  useEffect(() => {
    if (total > 0 && left === 0) onDismiss();
  }, [left, onDismiss, total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menuOpen) {
        const count = scenarios.length;
        if (e.key === "Escape") closeMenu();
        else if (e.key === "ArrowDown") setFocusIdx((i) => (i + 1) % count);
        else if (e.key === "ArrowUp") setFocusIdx((i) => (i - 1 + count) % count);
        else if (e.key === "Home") setFocusIdx(0);
        else if (e.key === "End") setFocusIdx(count - 1);
        else if (e.key === "Enter" || e.key === " ") choose(scenarios[focusIdx].id as AIScenario);
        else return;
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") onDismiss();
      else if (e.key === "Enter" && e.target !== chevronRef.current) start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choose, closeMenu, focusIdx, menuOpen, onDismiss, scenarios, start]);

  return (
    <div
      className="h-screen w-screen p-2"
      // A click beside the open menu closes it.
      onMouseDown={(e) => {
        if (menuOpen && e.target === e.currentTarget) closeMenu();
      }}
    >
      <div
        className="relative"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
          role="dialog"
          aria-label={`${meeting.app_name} meeting detected`}
          className="meeting-prompt-enter relative w-full overflow-hidden rounded-[18px] border border-white/10 bg-[hsl(228_22%_9%/0.96)] text-foreground shadow-[0_10px_30px_-8px_rgba(0,0,0,0.6)] backdrop-blur-xl"
        >
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground cursor-pointer"
          >
            <X className="h-3 w-3" />
          </button>

          <div className="flex items-center gap-3 py-3 pl-8 pr-3">
            <img src="/nexq-icon.png" alt="" className="h-9 w-9 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate whitespace-nowrap text-[11px] font-medium text-muted-foreground">
                <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                </span>
                <span className="truncate">
                  {meeting.app_name} meeting detected
                  <span className="text-muted-foreground/50"> · {scenarioName}</span>
                </span>
              </p>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={`${meeting.app_name} — name this meeting`}
                aria-label="Meeting name"
                maxLength={120}
                className="mt-0.5 w-full truncate bg-transparent text-sm font-semibold text-foreground placeholder:font-medium placeholder:text-muted-foreground/50 focus:outline-none"
              />
            </div>

            {/* Split button: Start, and the meeting type behind the chevron */}
            <div className="flex shrink-0 items-stretch overflow-hidden rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/30">
              <button
                type="button"
                onClick={start}
                aria-label={
                  chosenProfile ? `Start NexQ with ${chosenProfile.name}` : undefined
                }
                className="flex items-center gap-1.5 py-2 pl-3.5 pr-3 text-xs font-semibold transition-all duration-150 hover:brightness-110 active:scale-[0.97] cursor-pointer"
              >
                <Play className="h-3 w-3 fill-current" aria-hidden="true" />
                {choice?.kind === "new_presentation_qa" ? "Set up Presentation + Q&A" : "Start NexQ"}
              </button>
              <button
                ref={chevronRef}
                type="button"
                onClick={() => (menuOpen ? closeMenu() : openMenu())}
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
                aria-label={`Meeting type: ${scenarioName}`}
                className={`flex w-7 items-center justify-center border-l border-primary-foreground/20 transition-colors cursor-pointer ${
                  menuOpen ? "bg-black/15" : "hover:bg-black/10"
                }`}
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform duration-200 ${menuOpen ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>

          <p className="-mt-1.5 truncate pb-2 pl-8 pr-3 text-[10px] text-muted-foreground/45">
            Let everyone know the meeting is being transcribed.
          </p>

          <div className="flex flex-wrap items-center gap-1.5 border-t border-white/5 px-3 py-2 pl-8">
            <button
              type="button"
              onClick={() => openPanel("recent")}
              aria-expanded={panel === "recent"}
              className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium cursor-pointer transition-colors ${
                panel === "recent" ? "border-primary/60 bg-primary/15 text-foreground" : "border-white/10 text-muted-foreground hover:bg-white/5"
              }`}
            >
              <FolderClock className="h-3 w-3" aria-hidden="true" />
              Recent meetings{recent.length > 0 ? ` (${recent.length})` : ""}
            </button>
            <button
              type="button"
              onClick={() => openPanel("presentation")}
              aria-expanded={panel === "presentation"}
              className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium cursor-pointer transition-colors ${
                panel === "presentation" ? "border-primary/60 bg-primary/15 text-foreground" : "border-white/10 text-muted-foreground hover:bg-white/5"
              }`}
            >
              <Presentation className="h-3 w-3" aria-hidden="true" />
              Presentation + Q&amp;A
            </button>
          </div>

          {panel && (
            <div className="space-y-1.5 border-t border-white/5 px-3 py-2 pl-8" aria-label={panel === "recent" ? "Recent meetings" : "Presentation + Q&A meetings"} role="region">
              <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/45">
                {panel === "recent" ? "Recent meetings" : "Presentation + Q&A"} · nothing starts until you press Start
              </p>
              {(panel === "recent" ? recent : presentations).length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {panel === "recent" ? "No saved meetings yet." : "No Presentation + Q&A meetings yet."}
                </p>
              ) : (
                <div role="radiogroup" aria-label="Saved meetings" className="max-h-[170px] space-y-1 overflow-y-auto pr-1">
                  {(panel === "recent" ? recent : presentations).map((p) => {
                    const selected = choice?.kind === "profile" && choice.profileId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setChoice(selected ? null : { kind: "profile", profileId: p.id })}
                        className={`flex w-full items-start gap-2 rounded-xl border px-2.5 py-1.5 text-left cursor-pointer transition-colors ${
                          selected ? "border-primary/60 bg-primary/10" : "border-white/10 hover:bg-white/5"
                        }`}
                      >
                        <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                          {selected && <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-foreground">{p.name}</span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {MEETING_TYPE_LABELS[p.meetingType]}
                            {p.presentationName ? ` · ${p.presentationName}` : ""}
                            {` · last used ${shortDate(p.lastUsedAt)}`}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                type="button"
                onClick={() => setChoice({ kind: "new_presentation_qa", name: newPresentationName, platform: platformForApp(meeting.app) })}
                aria-pressed={choice?.kind === "new_presentation_qa"}
                className={`flex w-full items-center gap-2 rounded-xl border border-dashed px-2.5 py-1.5 text-left text-xs cursor-pointer transition-colors ${
                  choice?.kind === "new_presentation_qa" ? "border-primary/60 bg-primary/10 text-foreground" : "border-white/15 text-muted-foreground hover:bg-white/5"
                }`}
              >
                <Presentation className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                New Presentation + Q&amp;A for “{newPresentationName}”
              </button>
            </div>
          )}

          {total > 0 && (
            <div className="absolute inset-x-0 bottom-0 h-[2px] bg-white/5" aria-hidden="true">
              <div className="h-full bg-primary/50 transition-[width] duration-100 ease-linear" style={{ width: `${(left / total) * 100}%` }} />
            </div>
          )}
        </div>

        {menuOpen && (
          <div
            role="listbox"
            aria-label="Meeting type"
            className="scope-pop-enter absolute right-0 top-full z-10 mt-1.5 max-h-[288px] w-64 overflow-y-auto rounded-2xl border border-white/10 bg-[hsl(228_22%_9%/0.97)] p-1.5 shadow-[0_14px_36px_-10px_rgba(0,0,0,0.7)] backdrop-blur-xl"
          >
            <p className="px-2.5 pb-1 pt-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/45">
              Start as
            </p>
            {scenarios.map((s, idx) => {
              const selected = s.id === scenario;
              return (
                <button
                  key={s.id}
                  ref={(el) => {
                    optionRefs.current[idx] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={idx === focusIdx ? 0 : -1}
                  onMouseEnter={() => setFocusIdx(idx)}
                  onClick={() => choose(s.id as AIScenario)}
                  className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none transition-colors duration-100 cursor-pointer ${
                    idx === focusIdx ? "bg-white/[0.07]" : ""
                  }`}
                >
                  <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {selected && <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-xs ${selected ? "font-semibold text-foreground" : "font-medium text-foreground/85"}`}>
                      {s.name}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground/55">{s.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Root of the `meeting-prompt` window. */
export function MeetingPromptWindow() {
  const [info, setInfo] = useState<MeetingPromptInfo | null>(null);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  // Remount the card (fresh title, timer) for every new call.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";

    // Dev only: `?view=meeting-prompt&demo` previews the card in a browser.
    if (window.location.port === "5173" && new URLSearchParams(window.location.search).has("demo")) {
      setInfo({ meeting: { app: "zoom", app_name: "Zoom", title: "Weekly design sync" }, auto_dismiss_secs: 0, default_scenario: "team_meeting" });
      const demo = (id: string, name: string, meetingType: ProfileSummary["meetingType"], lastUsedAt: string | null, presentationName: string | null): ProfileSummary => ({
        id, name, meetingType, platform: "zoom", meetingDate: null, primaryProvider: "github_copilot", primaryModel: "auto",
        documentCount: 3, sessionCount: lastUsedAt ? 2 : 0, updatedAt: "2026-11-01T00:00:00Z", lastUsedAt, presentationName,
      });
      setProfiles([
        demo("d1", "Thesis defence", "presentation_qa", "2026-11-13T09:00:00Z", "Thesis.pptx"),
        demo("d2", "Lab talk rehearsal", "presentation_qa", "2026-11-10T09:00:00Z", "Lab talk.pptx"),
        demo("d3", "Backend interview", "interview", "2026-10-30T09:00:00Z", null),
        demo("d4", "Team retro", "general", null, null),
      ]);
      return;
    }
    // This window stays open between calls: the scenarios and the saved meetings can change meanwhile.
    const readScenarios = () => useScenarioStore.getState().loadScenarioConfig();
    const readProfiles = () => profileIpc.list().then(setProfiles).catch(() => setProfiles([]));
    getDetectedMeeting()
      .then(async (current) => {
        if (!current) return;
        await Promise.all([readScenarios(), readProfiles()]);
        setInfo(current);
      })
      .catch(() => {});
    const unlisteners: Array<() => void> = [];
    onMeetingDetected(async (next) => {
      await Promise.all([readScenarios(), readProfiles()]);
      setInfo(next);
      setGeneration((g) => g + 1);
    }).then((fn) => unlisteners.push(fn));
    onDetectedMeetingEnded(() => setInfo(null)).then((fn) => unlisteners.push(fn));
    return () => unlisteners.forEach((fn) => fn());
  }, []);

  // The window is just the card's size; it grows downward while the menu or the saved-meetings panel is open.
  const layout = useRef({ menu: false, panel: false });
  const resize = useCallback(() => {
    const { menu, panel } = layout.current;
    const height = panel ? PROMPT_HEIGHT_WITH_PANEL : menu ? PROMPT_HEIGHT_WITH_MENU : PROMPT_HEIGHT;
    import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow, LogicalSize }) => {
        await getCurrentWindow().setSize(new LogicalSize(window.innerWidth, height));
      })
      .catch(() => {});
  }, []);
  const onMenuToggle = useCallback((open: boolean) => { layout.current.menu = open; resize(); }, [resize]);
  const onPanelToggle = useCallback((open: boolean) => { layout.current.panel = open; resize(); }, [resize]);

  const dismiss = useCallback(() => {
    layout.current = { menu: false, panel: false };
    setInfo(null);
    dismissMeetingPrompt().catch(() => {});
  }, []);

  const start = useCallback((title: string, scenario: AIScenario, choice?: StartChoice) => {
    emitStartDetectedMeeting(choice ? { title, scenario, choice } : { title, scenario }).catch(() => {});
    dismiss();
  }, [dismiss]);

  if (!info) return null;
  return (
    <MeetingPrompt
      key={generation}
      info={info}
      profiles={profiles}
      onStart={start}
      onDismiss={dismiss}
      onMenuToggle={onMenuToggle}
      onPanelToggle={onPanelToggle}
    />
  );
}
