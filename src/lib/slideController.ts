/**
 * Central slide-navigation controller: one place decides what "next slide" means,
 * so a single action moves the real presentation and NexQ's notes together.
 *
 * Rules:
 *  - Presentation navigation is absolute ("go to slide N"), never "press next",
 *    so a retried request cannot advance twice.
 *  - At most one request is in flight. Presses that arrive meanwhile accumulate into
 *    the latest wanted slide and are sent after the current one finishes (coalesced).
 *  - With a presentation bound, the notes change only after the presentation
 *    confirmed the slide. A failure leaves both where they were and says why.
 *  - Without a bound presentation (or one that cannot be controlled) the notes
 *    change immediately: manual mode.
 *  - A slide change made directly in the presentation is adopted without sending
 *    anything back (and never while a request is pending).
 */

export interface NavTransport {
  /** Moves the presentation to `slide`; resolves with the slide it confirmed. */
  goto(slide: number): Promise<{ confirmedSlide: number }>;
}

export type SyncState = "manual" | "idle" | "pending" | "failed";

export interface ControllerState {
  /** The slide whose notes are shown (confirmed when a presentation is bound). */
  slide: number;
  /** The slide currently being requested, if any. */
  pendingSlide: number | null;
  sync: SyncState;
  error: string | null;
}

interface Options {
  /** Slide numbers that have notes/rows, any order. Empty = unknown deck. */
  slides: () => number[];
  /** Upper bound when the deck is unknown (the presentation's slide count). */
  slideLimit?: () => number | null;
  transport: () => NavTransport | null;
  initial: number;
  onChange: (state: ControllerState) => void;
}

export class SlideController {
  private shown: number;
  private desired: number | null = null;
  private running = false;
  private sync: SyncState = "manual";
  private error: string | null = null;
  private disposed = false;

  constructor(private readonly opts: Options) {
    this.shown = opts.initial;
    this.sync = opts.transport() ? "idle" : "manual";
  }

  get state(): ControllerState {
    return { slide: this.shown, pendingSlide: this.running ? this.desired : null, sync: this.sync, error: this.error };
  }

  dispose() {
    this.disposed = true;
  }

  private emit() {
    if (!this.disposed) this.opts.onChange(this.state);
  }

  /** Clamps/snaps `wanted` to a slide that exists. */
  private resolve(wanted: number): number | null {
    const numbers = [...this.opts.slides()].sort((a, b) => a - b);
    if (numbers.length > 0) {
      if (numbers.includes(wanted)) return wanted;
      const below = numbers.filter((n) => n < wanted);
      return wanted < numbers[0] ? numbers[0] : (below[below.length - 1] ?? null);
    }
    const limit = this.opts.slideLimit?.() ?? null;
    if (limit && limit > 0) return Math.min(Math.max(wanted, 1), limit);
    return wanted >= 1 ? wanted : 1;
  }

  /** The base for a relative step: the slide already wanted, else the one shown. */
  private base(): number {
    return this.desired ?? this.shown;
  }

  request(slide: number) {
    const target = this.resolve(slide);
    if (target === null) return;
    const transport = this.opts.transport();
    if (!transport) {
      this.desired = null;
      this.shown = target;
      this.sync = "manual";
      this.error = null;
      this.emit();
      return;
    }
    if (!this.running && target === this.shown && this.sync !== "failed") return;
    this.desired = target;
    if (!this.running) void this.pump(transport);
  }

  step(delta: number) {
    const numbers = [...this.opts.slides()].sort((a, b) => a - b);
    const from = this.base();
    if (numbers.length === 0) {
      this.request(from + delta);
      return;
    }
    let index = numbers.indexOf(from);
    if (index === -1) {
      // `from` is in a gap: the first step lands on the nearest slide in that direction.
      const after = numbers.findIndex((n) => n > from);
      if (delta > 0) index = (after === -1 ? numbers.length : after) - 1;
      else index = after === -1 ? numbers.length : after;
    }
    this.request(numbers[Math.min(Math.max(index + delta, 0), numbers.length - 1)]);
  }

  first() {
    const numbers = this.opts.slides();
    this.request(numbers.length ? Math.min(...numbers) : 1);
  }

  last() {
    const numbers = this.opts.slides();
    const limit = this.opts.slideLimit?.() ?? null;
    this.request(numbers.length ? Math.max(...numbers) : (limit ?? this.shown));
  }

  /** The presentation changed on its own: follow it, without sending anything back. */
  adopt(slide: number) {
    if (this.running || this.desired !== null) return;
    const target = this.resolve(slide);
    if (target === null || target === this.shown) {
      if (this.sync === "failed") {
        this.sync = "idle";
        this.error = null;
        this.emit();
      }
      return;
    }
    this.shown = target;
    this.sync = this.opts.transport() ? "idle" : "manual";
    this.error = null;
    this.emit();
  }

  /** The binding changed (bound / rebound / disconnected). */
  bindingChanged() {
    if (!this.running) {
      this.sync = this.opts.transport() ? "idle" : "manual";
      this.error = null;
      this.emit();
    }
  }

  private async pump(transport: NavTransport) {
    this.running = true;
    try {
      while (this.desired !== null && this.desired !== this.shown && !this.disposed) {
        const wanted = this.desired;
        this.sync = "pending";
        this.error = null;
        this.emit();
        try {
          const result = await transport.goto(wanted);
          this.shown = result.confirmedSlide;
          this.sync = "idle";
          if (this.desired === wanted) this.desired = null;
        } catch (e) {
          this.desired = null;
          this.sync = "failed";
          this.error = e instanceof Error ? e.message : String(e);
          break;
        }
      }
    } finally {
      this.running = false;
      this.desired = null;
      if (this.sync === "pending") this.sync = "idle";
      this.emit();
    }
  }
}
