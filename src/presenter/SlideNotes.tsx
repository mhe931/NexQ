import { useEffect, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight, MessageCircleQuestion, Pause, Play } from "lucide-react";
import type { MeetingProfile } from "../lib/profileTypes";
import { lastSlide, notesFor, slideByNumber } from "../lib/slideNav";
import { usePresenterStore } from "../stores/presenterStore";
import { textColumn, type Palette } from "./theme";

interface Props {
  profile: MeetingProfile;
  colors: Palette;
  scrollRef: RefObject<HTMLDivElement>;
  onRequestQa: () => void;
}

const ctl =
  "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold cursor-pointer " +
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
  const gotoSlide = usePresenterStore((s) => s.gotoSlide);
  const t = profile.environment.teleprompter;
  const [autoScroll, setAutoScroll] = useState(t.scrollSpeed > 0);

  const slide = slideByNumber(slides, currentSlide);
  const notes = notesFor(slide).trim();
  const total = lastSlide(slides);

  useAutoScroll(scrollRef, t.scrollSpeed, autoScroll);
  // Each slide's notes start from the top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [currentSlide, scrollRef]);

  const sorted = [...slides].sort((a, b) => a.slideNo - b.slideNo);
  const first = sorted[0]?.slideNo;
  const lastNo = sorted[sorted.length - 1]?.slideNo;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl font-bold tabular-nums" style={{ color: colors.accent }} aria-live="polite">
          Slide {currentSlide} / {total}
        </h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={() => step(-1)} disabled={currentSlide === first} aria-label="Previous slide">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Prev
          </button>
          <label className="sr-only" htmlFor="slide-select">Go to slide</label>
          <select
            id="slide-select"
            className="max-w-[16rem] rounded-lg border bg-transparent px-2 py-1.5 text-xs"
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
          {t.scrollSpeed > 0 && (
            <button type="button" className={ctl} style={{ borderColor: colors.border }} onClick={() => setAutoScroll((v) => !v)} aria-pressed={autoScroll} aria-label={autoScroll ? "Pause auto-scroll" : "Start auto-scroll"}>
              {autoScroll ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />} Scroll
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label={`Notes for slide ${currentSlide}`}
        className="min-h-0 flex-1 overflow-y-auto scroll-smooth rounded-lg px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p className="whitespace-pre-wrap" style={textColumn(t)}>
          {notes || <span style={{ color: colors.muted }}>No notes for this slide</span>}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta" style={{ color: colors.muted }}>
          Slides do not follow automatically; choose or step slides yourself. Keys: ← → slides, ↑ ↓ scroll, Q start Q&amp;A, H hide.
        </p>
        <button
          type="button"
          className={`${ctl} text-sm`}
          style={{ borderColor: colors.accent, background: colors.accent, color: colors.onAccent }}
          onClick={onRequestQa}
        >
          <MessageCircleQuestion className="h-4 w-4" aria-hidden="true" /> Start Q&amp;A
        </button>
      </div>
    </div>
  );
}
