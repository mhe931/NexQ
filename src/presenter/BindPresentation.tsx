import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, FolderOpen, Hourglass, Link2, Link2Off, Loader2, MinusCircle, MonitorPlay, RefreshCw, X, XCircle } from "lucide-react";
import type { Palette } from "./theme";
import type {
  BindingStatus, BoundKind, ConnectionState, LaunchReport, LaunchStage, PresentationDiagnostics, PresentationInfo, PresentationTarget,
} from "../lib/profileTypes";
import { profileIpc } from "../lib/profileIpc";
import { usePresenterStore } from "../stores/presenterStore";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const btn =
  "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold cursor-pointer " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

const KIND_LABEL: Record<BoundKind, string> = { powerpoint: "PowerPoint", google_slides: "Google Slides", other: "Other" };

/** State as text + icon + colour: colour is never the only signal. */
const STATE_VIEW: Record<ConnectionState, { label: string; Icon: typeof Link2; color: (c: Palette) => string }> = {
  connected: { label: "CONNECTED", Icon: Link2, color: (c) => c.accent },
  disconnected: { label: "DISCONNECTED", Icon: Link2Off, color: () => "#f87171" },
  unsupported: { label: "UNSUPPORTED", Icon: AlertTriangle, color: () => "#fbbf24" },
  out_of_sync: { label: "OUT OF SYNC", Icon: AlertTriangle, color: () => "#fb923c" },
  waiting: { label: "WAITING FOR SLIDE SHOW", Icon: Hourglass, color: () => "#fbbf24" },
};

const controllable = (s: BindingStatus) => s.state === "connected" || s.state === "out_of_sync";

function StateBadge({ state, colors }: { state: ConnectionState; colors: Palette }) {
  const v = STATE_VIEW[state];
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-extrabold tracking-wide" style={{ color: v.color(colors) }}>
      <v.Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {v.label}
    </span>
  );
}

/**
 * Header chip showing the presentation connection state. It opens the bind
 * dialog; closing the dialog returns focus here.
 */
export function BindStatusChip({ colors }: { colors: Palette }) {
  const binding = usePresenterStore((s) => s.binding);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (wasOpen.current && !open) chipRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const closeDialog = useCallback(() => setOpen(false), []);
  const name = binding.targetTitle;
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={btn}
        style={{ borderColor: colors.border }}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {name ? (
          <>
            <MonitorPlay className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="max-w-[9rem] truncate" title={name}>{name}</span>
            <StateBadge state={binding.state} colors={colors} />
          </>
        ) : (
          <>
            <Link2Off className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Bind presentation
          </>
        )}
      </button>
      {open && <BindDialog colors={colors} onClose={closeDialog} />}
    </>
  );
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Choose which open presentation to bind, and manage the binding. A scrollable panel that fits the small overlay
 * window; it only moves focus inside this window, never to another application.
 */
export function BindDialog({ colors, onClose }: { colors: Palette; onClose: () => void }) {
  const binding = usePresenterStore((s) => s.binding);
  const bind = usePresenterStore((s) => s.bind);
  const disconnect = usePresenterStore((s) => s.disconnect);
  const testNavigation = usePresenterStore((s) => s.testNavigation);
  const syncToPresentation = usePresenterStore((s) => s.syncToPresentation);
  const profileId = usePresenterStore((s) => s.profile?.id ?? null);
  const hasLaunch = usePresenterStore((s) => s.launch !== null);

  const panelRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"list" | "bound">(binding.targetTitle ? "bound" : "list");
  const [targets, setTargets] = useState<PresentationTarget[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [info, setInfo] = useState<PresentationInfo | null>(null);
  const [scans, setScans] = useState(0);

  useEffect(() => {
    if (!profileId) return;
    let live = true;
    profileIpc.presentationInfo(profileId).then((i) => live && setInfo(i ?? null)).catch(() => live && setInfo(null));
    return () => { live = false; };
  }, [profileId]);

  const loadTargets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = (await profileIpc.presentTargets()) ?? [];
      setTargets(list);
      setSelected((id) => (id && list.some((t) => t.id === id) ? id : null));
    } catch (e) {
      setTargets([]);
      setError(errorText(e));
    } finally {
      setScans((n) => n + 1);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === "list") void loadTargets();
  }, [mode, loadTargets]);

  // Keyboard: Escape closes, Tab stays in the panel, and no key reaches the presenter shortcuts underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      const panel = panelRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => { panelRef.current?.focus(); }, []);

  const guarded = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onBind = () => selected && guarded(async () => {
    setResult(null);
    await bind(selected);
    setMode("bound");
  });
  const onDisconnect = () => guarded(async () => {
    setResult(null);
    await disconnect();
    setMode("list");
  });
  const onTest = () => guarded(async () => {
    setResult(null);
    setResult(await testNavigation());
  });
  const onSync = () => guarded(async () => {
    setResult(null);
    await syncToPresentation();
    const slide = usePresenterStore.getState().binding.targetSlide;
    setResult(slide ? `Notes now follow slide ${slide} of the presentation.` : "Synced with the presentation.");
  });

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bind-title"
      tabIndex={-1}
      className="fixed inset-1 z-50 flex flex-col overflow-hidden rounded-xl border shadow-2xl focus:outline-none"
      style={{ background: colors.bg, color: colors.fg, borderColor: colors.accent }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5" style={{ borderColor: colors.border }}>
        <h2 id="bind-title" className="text-sm font-bold">Bind presentation</h2>
        <button type="button" className={btn} style={{ borderColor: colors.border }} onClick={onClose} aria-label="Close">
          <X className="h-3.5 w-3.5" aria-hidden="true" /> Close
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2 text-xs">
        {mode === "list" ? (
          <>
            <p style={{ color: colors.muted }}>Open PowerPoint or Google Slides first, then choose it here.</p>
            <MeetingPresentation
              info={info}
              colors={colors}
              onDone={(report) => {
                if (report && report.status.targetId && report.status.state !== "disconnected") setMode("bound");
                void loadTargets();
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={btn} style={{ borderColor: colors.border }} onClick={() => void loadTargets()} disabled={loading || busy}>
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" /> Refresh
              </button>
              <button
                type="button"
                className={btn}
                style={{ borderColor: colors.accent, background: colors.accent, color: colors.onAccent }}
                onClick={onBind}
                disabled={!selected || busy}
              >
                Bind
              </button>
              {binding.targetTitle && (
                <button type="button" className={btn} style={{ borderColor: colors.border }} onClick={() => setMode("bound")}>
                  Back
                </button>
              )}
            </div>
            {error && <Problem>{error}</Problem>}
            <TargetList targets={targets} loading={loading} selected={selected} onSelect={setSelected} colors={colors} info={info} scans={scans} />
          </>
        ) : (
          <>
            <BoundView
              binding={binding}
              colors={colors}
              busy={busy}
              canControl={controllable(binding)}
              result={result}
              error={error}
              onRebind={() => { setResult(null); setError(null); setMode("list"); }}
              onDisconnect={onDisconnect}
              onTest={onTest}
              onSync={onSync}
            />
            {(binding.state === "disconnected" || binding.state === "waiting" || hasLaunch) && (
              <MeetingPresentation info={info} colors={colors} onDone={() => undefined} />
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md border px-2 py-1 font-semibold" style={{ borderColor: "#f87171", color: "#fca5a5" }}>
      {children}
    </p>
  );
}

function TargetList({
  targets, loading, selected, onSelect, colors, info, scans,
}: {
  targets: PresentationTarget[] | null;
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  colors: Palette;
  info: PresentationInfo | null;
  scans: number;
}) {
  if (targets === null) return <p role="status" style={{ color: colors.muted }}>{loading ? "Looking for open presentations…" : ""}</p>;
  if (targets.length === 0) return <NoTargets colors={colors} info={info} scans={scans} />;
  return (
    <div role="radiogroup" aria-label="Open presentations" className="space-y-1.5">
      {targets.map((t) => {
        const checked = selected === t.id;
        return (
          <label
            key={t.id}
            className="flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5"
            style={{ borderColor: checked ? colors.accent : colors.border }}
          >
            <input type="radio" name="bind-target" className="mt-0.5" checked={checked} onChange={() => onSelect(t.id)} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 truncate font-semibold" title={t.title}>{t.title}</span>
                <span className="rounded border px-1.5 text-[10px] font-bold uppercase" style={{ borderColor: colors.border }}>{KIND_LABEL[t.kind]}</span>
                {t.slideshowRunning && <span className="font-semibold" style={{ color: colors.accent }}>slide show running</span>}
                {t.protectedView && <span className="rounded border px-1.5 text-[10px] font-bold uppercase" style={{ borderColor: "#fbbf24", color: "#fbbf24" }}>Protected View</span>}
              </span>
              {t.detail && <span className="block truncate" style={{ color: colors.muted }} title={t.detail}>{t.detail}</span>}
              <span className="block" style={{ color: colors.muted }}>
                {t.slideCount !== null && `${t.slideCount} ${t.slideCount === 1 ? "slide" : "slides"}`}
                {t.slideCount !== null && t.currentSlide !== null && " · "}
                {t.currentSlide !== null && `currently on slide ${t.currentSlide}`}
              </span>
              {t.note && <span className="block" style={{ color: colors.muted }}>{t.note}</span>}
              {!t.supportsControl && (
                <span className="mt-0.5 flex items-center gap-1 font-semibold" style={{ color: "#fbbf24" }}>
                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                  Can be listed, cannot be controlled — manual sync
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

const STAGE_ICON: Record<LaunchStage["state"], { Icon: typeof CheckCircle2; color: string; text: string }> = {
  done: { Icon: CheckCircle2, color: "#4ade80", text: "Done" },
  failed: { Icon: XCircle, color: "#f87171", text: "Failed" },
  skipped: { Icon: MinusCircle, color: "#a1a1aa", text: "Not applicable" },
  pending: { Icon: Loader2, color: "#fbbf24", text: "Pending" },
};

/** Stages A–E of opening the meeting's presentation: each is its own fact, never inferred from another. */
function StageList({ stages, colors }: { stages: LaunchStage[]; colors: Palette }) {
  return (
    <ol aria-label="Presentation launch steps" className="space-y-1">
      {stages.map((s, i) => {
        const v = STAGE_ICON[s.state];
        return (
          <li key={s.id} className="flex items-start gap-1.5">
            <v.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: v.color }} aria-hidden="true" />
            <span className="min-w-0">
              <span className="font-semibold">{String.fromCharCode(65 + i)}. {s.label}</span>
              <span className="ml-1 text-[10px] font-bold uppercase" style={{ color: v.color }}>{v.text}</span>
              {s.detail && <span className="block" style={{ color: colors.muted }}>{s.detail}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The presentation this meeting was prepared with, and the actions that bring it up. Shown even when nothing is
 * open, so an empty list is never a dead end.
 */
function MeetingPresentation({ info, colors, onDone }: { info: PresentationInfo | null; colors: Palette; onDone: (r: LaunchReport | null) => void }) {
  const opening = usePresenterStore((s) => s.opening);
  const launch = usePresenterStore((s) => s.launch);
  const launchError = usePresenterStore((s) => s.launchError);
  const openPresentation = usePresenterStore((s) => s.openPresentation);
  const [action, setAction] = useState<"open" | "find" | null>(null);

  if (!info && !launch && !launchError) return null;

  const run = async (launchIt: boolean) => {
    setAction(launchIt ? "open" : "find");
    try {
      onDone(await openPresentation(launchIt));
    } catch {
      onDone(null);
    } finally {
      setAction(null);
    }
  };

  return (
    <section aria-label="This meeting's presentation" className="space-y-1.5 rounded-lg border px-2.5 py-2" style={{ borderColor: colors.border }}>
      <h3 className="text-[10px] font-bold uppercase tracking-wide" style={{ color: colors.muted }}>This meeting's presentation</h3>
      {info && (
        <div>
          <p className="truncate font-semibold" title={info.name}>{info.name}</p>
          <p className="truncate" style={{ color: colors.muted }} title={info.path}>{info.path}</p>
          <p style={{ color: colors.muted }}>
            {info.slideCount} {info.slideCount === 1 ? "slide" : "slides"} imported and indexed in NexQ
            {info.origin === "synced_cloud" ? " · locally synced cloud copy" : ""}
          </p>
          {info.sourceMissing && (
            <p className="font-semibold" style={{ color: "#fbbf24" }}>
              The file is no longer at this location. NexQ will look for the same file name in this meeting's folders; otherwise import it again from its new location.
            </p>
          )}
          {info.stale && !info.sourceMissing && (
            <p style={{ color: "#fbbf24" }}>The file changed after it was imported; refresh the meeting's sources if its text or notes changed.</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btn}
          style={{ borderColor: colors.accent, background: colors.accent, color: colors.onAccent }}
          onClick={() => void run(true)}
          disabled={opening || !info}
          title={info ? "Opens this file in PowerPoint if it is not open yet, then binds to it" : "Import a PowerPoint file in the meeting setup first"}
        >
          <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" /> Open presentation
        </button>
        <button
          type="button"
          className={btn}
          style={{ borderColor: colors.border }}
          onClick={() => void run(false)}
          disabled={opening || !info}
          title="Finds this presentation among the open ones and binds to it, without opening anything"
        >
          Bind to open presentation
        </button>
      </div>
      {opening && (
        <p role="status" className="flex items-center gap-1.5 font-semibold" style={{ color: colors.accent }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {action === "find" ? "Looking for the open presentation…" : "Opening and binding — this can take up to 30 seconds while PowerPoint starts…"}
        </p>
      )}
      {launch && !opening && (
        <>
          <StageList stages={launch.stages} colors={colors} />
          <p role="status" className="font-semibold">{launch.summary}</p>
          {launch.sourceMoved && launch.sourcePath && <p style={{ color: colors.muted }}>The file was found at its new location: {launch.sourcePath}</p>}
        </>
      )}
      {launchError && <Problem>{launchError}</Problem>}
    </section>
  );
}

/** Why the list is empty, in facts, plus what to do next. Never a bare "not found". */
function NoTargets({ colors, info, scans }: { colors: Palette; info: PresentationInfo | null; scans: number }) {
  const [diag, setDiag] = useState<PresentationDiagnostics | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDiag(null);
    setDiagError(null);
    profileIpc.presentDiagnose().then((d) => live && setDiag(d)).catch((e) => live && setDiagError(errorText(e)));
    return () => { live = false; };
  }, [scans]);

  return (
    <div role="status" className="space-y-1.5" style={{ color: colors.muted }}>
      <p className="font-semibold" style={{ color: colors.fg }}>
        {info ? `“${info.name}” is not open in a presentation app.` : "No open presentation found."}
      </p>
      <p>{diagError ? `Diagnostics unavailable: ${diagError}` : (diag?.summary ?? "Checking PowerPoint…")}</p>
      <ul className="list-disc space-y-0.5 pl-4">
        {info ? (
          <li>Choose <strong>Open presentation</strong> to open it, or open it yourself and choose Refresh.</li>
        ) : (
          <li>Open your deck in PowerPoint (desktop) or Google Slides in a browser, then choose Refresh.</li>
        )}
        <li>A file downloaded or received by e-mail opens in Protected View; NexQ follows its slide show once it is running.</li>
        <li>Sharing a browser tab is not the same as sharing a PowerPoint slide show: NexQ can only control desktop PowerPoint.</li>
      </ul>
      {diag && (diag.applications.length > 0 || diag.windows.length > 0 || diag.notes.length > 0) && (
        <details>
          <summary className="cursor-pointer font-semibold">Diagnostic details</summary>
          <ul className="mt-1 space-y-0.5">
            {diag.applications.map((a, i) => (
              <li key={`app-${i}`}>
                PowerPoint {a.version || ""} ({a.source}): {a.presentations} open, {a.protectedView} in Protected View, {a.slideShows} slide show(s)
              </li>
            ))}
            {diag.windows.map((w, i) => (
              <li key={`win-${i}`}>
                {w.role.replace("_", " ")} “{w.title}” — {w.reachable ? "reachable" : "not reachable"}
              </li>
            ))}
            {diag.notes.map((n, i) => <li key={`note-${i}`}>{n}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function unsupportedCopy(kind: BoundKind | null): string {
  return kind === "google_slides"
    ? "NexQ cannot control Google Slides (Google offers no slideshow-control API). Your notes follow the slide you select in NexQ — change the slide in the browser yourself."
    : "NexQ cannot control this presentation. Your notes follow the slide you select in NexQ — change the slide in the presentation yourself.";
}

function BoundView({
  binding, colors, busy, canControl, result, error, onRebind, onDisconnect, onTest, onSync,
}: {
  binding: BindingStatus;
  colors: Palette;
  busy: boolean;
  canControl: boolean;
  result: string | null;
  error: string | null;
  onRebind: () => void;
  onDisconnect: () => void;
  onTest: () => void;
  onSync: () => void;
}) {
  const position =
    binding.targetSlide && binding.slideCount
      ? `Slide ${binding.targetSlide} of ${binding.slideCount}`
      : binding.targetSlide
        ? `Slide ${binding.targetSlide}`
        : "Slide position unknown";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-bold" title={binding.targetTitle ?? ""}>{binding.targetTitle}</span>
        {binding.kind && <span className="rounded border px-1.5 text-[10px] font-bold uppercase" style={{ borderColor: colors.border }}>{KIND_LABEL[binding.kind]}</span>}
        <span role="status" aria-label="Connection state"><StateBadge state={binding.state} colors={colors} /></span>
      </div>
      <p>{binding.message}</p>
      <p style={{ color: colors.muted }}>
        {position}{binding.slideshowRunning ? " · slide show running" : ""}
      </p>
      {binding.state === "unsupported" && <p style={{ color: "#fbbf24" }}>{unsupportedCopy(binding.kind)}</p>}
      {binding.state === "waiting" && (
        <p style={{ color: "#fbbf24" }}>
          Bound to the right presentation, but it is not CONNECTED yet: start the slide show (or click Enable Editing in PowerPoint) and NexQ will follow it. Nothing is controlled until then.
        </p>
      )}
      {binding.state === "disconnected" && (
        <p style={{ color: colors.muted }}>
          The presentation is not reachable. Open it again, then choose Rebind; until then your notes follow the slide you select in NexQ.
        </p>
      )}
      {binding.state === "out_of_sync" && (
        <p style={{ color: colors.muted }}>The presentation and NexQ show different slides. Choose Sync to current slide to follow the presentation.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} style={{ borderColor: colors.border }} onClick={onRebind} disabled={busy}>Rebind</button>
        <button type="button" className={btn} style={{ borderColor: colors.border }} onClick={onDisconnect} disabled={busy}>Disconnect</button>
        <button
          type="button"
          className={btn}
          style={{ borderColor: colors.border }}
          onClick={onTest}
          disabled={busy || !canControl}
          title={canControl ? "Moves one slide and back" : "Needs a connected PowerPoint presentation"}
        >
          Test navigation
        </button>
        <button
          type="button"
          className={btn}
          style={{ borderColor: colors.border }}
          onClick={onSync}
          disabled={busy || !canControl}
          title={canControl ? undefined : "Needs a connected PowerPoint presentation"}
        >
          Sync to current slide
        </button>
      </div>
      {result && <p role="status" className="font-semibold" style={{ color: colors.accent }}>{result}</p>}
      {error && <Problem>{error}</Problem>}
    </>
  );
}
