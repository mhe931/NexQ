import { useEffect, useRef, type RefObject } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MessageCircleQuestion } from "lucide-react";
import type { MeetingProfile } from "../lib/profileTypes";
import { lastSlide, notesFor, slideByNumber } from "../lib/slideNav";
import { usePresenterStore } from "../stores/presenterStore";
import { DirectedText } from "./DirectedText";
import { textColumn, type Palette } from "./theme";

interface Props {
  profile: MeetingProfile;
  colors: Palette;
  scrollRef: RefObject<HTMLDivElement>;
  onRequestQa: () => void;
}

const ctl =
  "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold cursor-pointer " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

/** Auto-scrolls `ref` at `speed` px/s while `active`. */
function useAutoScroll(ref: RefObject<HTMLDivElement>, speed: number, active: boolean) {
  useEffect(() => {
    if (!active || speed <= 0) return;
    let frame = 0;
    let last = performance.now();
    let carry = 0;
    const tick = (now: number) => {
      const el = ref.current;
      if (el) {
        carry += ((now - last) / 1000) * speed;
        const whole = Math.floor(carry);
        if (whole > 0) {
          el.scrollTop += whole;
          carry -= whole;
        }
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ref, speed, active]);
}

export function SlideNotes({ profile, colors, scrollRef, onRequestQa }: Props) {
  const slides = usePresenterStore((s) => s.slides);
  const currentSlide = usePresenterStore((s) => s.currentSlide);
  const step = usePresenterStore((s) => s.step);
  const first_ = usePresenterStore((s) => s.first);
  const last_ = usePresenterStore((s) => s.last);
  const gotoSlide = usePresenterStore((s) => s.gotoSlide);
  const sync = usePresenterStore((s) => s.sync);
  const pendingSlide = usePresenterStore((s) => s.pendingSlide);
  const syncError = usePresenterStore((s) => s.syncError);
  const binding = usePresenterStore((s) => s.binding);
  const scrollPaused = usePresenterStore((s) => s.scrollPaused);
  const syncToPresentation = usePresenterStore((s) => s.syncToPresentation);
  const t = profile.environment.teleprompter;

  const slide = slideByNumber(slides, currentSlide);
  const notes = notesFor(slide);
  const total = lastSlide(slides);

  useAutoScroll(scrollRef, t.scrollSpeed, !scrollPaused);
  // Each slide's notes start from the top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [currentSlide, scrollRef]);

  // Remember what was asked for, so Retry can ask again after a failure.
  const wanted = useRef<number | null>(null);
  useEffect(() => {
    if (pendingSlide !== null) wanted.current = pendingSlide;
  }, [pendingSlide]);
  const retry = () => {
    if (wanted.current !== null && wanted.current !== currentSlide) gotoSlide(wanted.current);
    else void syncToPresentation().catch(() => {});
  };

  const sorted = [...slides].sort((a, b) => a.slideNo - b.slideNo);
  const first = sorted[0]?.slideNo;
  const lastNo = sorted[sorted.length - 1]?.slideNo;

  const outOfSync = binding.state === "out_of_sync";
  const manual = binding.state === "unsupported" || (binding.state === "disconnected" && !!profile.presentation.binding);
  const notice = { borderColor: colors.accent };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex items-baseline gap-2">
          <h2
            className="text-xl font-bold tabular-nums"
            style={{ color: colors.accent }}
            aria-live="polite"
            title="Keys: ← → slides, ↑ ↓ scroll, Q start Q&A, H hide, − / + text size"
          >
            Slide {currentSlide} / {total}
          </h2>
          <span aria-live="polite" className="text-xs" style={{ color: colors.muted }}>
            {sync === "pending" ? "Moving…" : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={() => first_()} disabled={currentSlide === first} aria-label="First slide" title="First slide (Home)">
            <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={() => step(-1)} disabled={currentSlide === first} aria-label="Previous slide">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Prev
          </button>
          <label className="sr-only" htmlFor="slide-select">Go to slide</label>
          <select
            id="slide-select"
            className="max-w-[14rem] rounded-lg border bg-transparent px-2 py-1 text-xs"
            style={{ borderColor: colors.border, color: colors.fg }}
            value={currentSlide}
            onChange={(e) => gotoSlide(Number(e.target.value))}
          >
            {sorted.map((s) => (
              <option key={s.slideNo} value={s.slideNo} style={{ color: "#000" }}>
                {s.slideNo}{s.title ? ` — ${s.title}` : ""}
              </option>
            ))}
          </select>
          <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={() => step(1)} disabled={currentSlide === lastNo} aria-label="Next slide">
            Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={() => last_()} disabled={currentSlide === lastNo} aria-label="Last slide" title="Last slide (End)">
            <ChevronsRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={ctl}
            style={{ borderColor: colors.accent, background: colors.accent, color: colors.onAccent }}
            onClick={onRequestQa}
            title="Start Q&A (Q)"
          >
            <MessageCircleQuestion className="h-4 w-4" aria-hidden="true" /> Start Q&amp;A
          </button>
        </div>
      </div>

      {sync === "failed" && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1 text-xs" style={notice}>
          <span>{syncError ?? "The presentation did not move."} The notes stayed on slide {currentSlide}.</span>
          <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={retry}>Retry</button>
        </div>
      )}
      {outOfSync && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1 text-xs font-semibold" style={notice}>
          <span>OUT OF SYNC: presentation is on slide {binding.targetSlide ?? "?"}</span>
          <button type="button" className={ctl} style={{ borderColor: colors.accent, background: colors.accent, color: colors.onAccent }} onClick={() => void syncToPresentation().catch(() => {})}>
            Sync to current slide
          </button>
        </div>
      )}
      {manual && (
        <p className="text-xs" style={{ color: colors.muted }}>
          Manual: change slides yourself; NexQ notes follow your selection.
        </p>
      )}

      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label={`Notes for slide ${currentSlide}`}
        className="min-h-0 flex-1 overflow-y-auto scroll-smooth rounded-lg px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {notes.trim() ? (
          <DirectedText text={notes} direction={t.textDirection} style={textColumn(t)} />
        ) : (
          <p style={{ ...textColumn(t), color: colors.muted }}>No notes for this slide</p>
        )}
      </div>
    </div>
  );
}
