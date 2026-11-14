import { describe, expect, it } from "vitest";
import { SlideController, type ControllerState, type NavTransport } from "./slideController";

/** A transport whose calls resolve only when the test releases them. */
function manualTransport() {
  const calls: number[] = [];
  const waiting: Array<{ slide: number; ok: (n: number) => void; fail: (e: Error) => void }> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const transport: NavTransport = {
    goto: (slide) => {
      calls.push(slide);
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise((resolve, reject) => {
        waiting.push({
          slide,
          ok: (n) => { concurrent--; resolve({ confirmedSlide: n }); },
          fail: (e) => { concurrent--; reject(e); },
        });
      });
    },
  };
  const release = async (confirm?: (slide: number) => number) => {
    const next = waiting.shift()!;
    next.ok(confirm ? confirm(next.slide) : next.slide);
    await Promise.resolve();
    await Promise.resolve();
  };
  const failNext = async (message: string) => {
    waiting.shift()!.fail(new Error(message));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { transport, calls, release, failNext, pendingCount: () => waiting.length, maxConcurrent: () => maxConcurrent };
}

function make(opts: { bound?: boolean; slides?: number[]; initial?: number; transport?: NavTransport } = {}) {
  const states: ControllerState[] = [];
  const t = manualTransport();
  const transport = opts.bound === false ? null : (opts.transport ?? t.transport);
  const controller = new SlideController({
    slides: () => opts.slides ?? [1, 2, 3, 4, 5],
    transport: () => transport,
    initial: opts.initial ?? 1,
    onChange: (s) => states.push(s),
  });
  return { controller, states, ...t };
}

describe("SlideController with a bound presentation", () => {
  it("moves the notes only after the presentation confirmed the slide", async () => {
    const { controller, release, calls } = make();
    controller.step(1);
    expect(calls).toEqual([2]);
    expect(controller.state).toMatchObject({ slide: 1, pendingSlide: 2, sync: "pending" });
    await release();
    expect(controller.state).toMatchObject({ slide: 2, pendingSlide: null, sync: "idle", error: null });
  });

  it("one press sends exactly one request, even though the request is absolute", async () => {
    const { controller, release, calls, pendingCount } = make();
    controller.step(1);
    await release();
    expect(calls).toEqual([2]);
    expect(pendingCount()).toBe(0);
  });

  it("rapid presses while a request is in flight are coalesced: one request at a time, the last wanted slide wins", async () => {
    const { controller, release, calls, maxConcurrent } = make({ slides: [1, 2, 3, 4, 5, 6, 7, 8] });
    controller.step(1); // in flight: 2
    controller.step(1); // wants 3
    controller.step(1); // wants 4
    controller.step(1); // wants 5
    expect(calls).toEqual([2]);
    await release(); // 2 confirmed -> now request the latest wanted slide directly
    expect(calls).toEqual([2, 5]);
    await release();
    expect(controller.state).toMatchObject({ slide: 5, sync: "idle" });
    expect(maxConcurrent()).toBe(1);
  });

  it("previous goes backwards and never below the first slide", async () => {
    const { controller, release, calls } = make({ initial: 2 });
    controller.step(-1);
    await release();
    expect(controller.state.slide).toBe(1);
    controller.step(-1);
    expect(calls).toEqual([1]);
    expect(controller.state.sync).toBe("idle");
  });

  it("does not run past the last slide, and first/last go to the ends", async () => {
    const { controller, release, calls } = make({ initial: 5 });
    controller.step(1);
    expect(calls).toEqual([]);
    controller.first();
    await release();
    controller.last();
    await release();
    expect(calls).toEqual([1, 5]);
    expect(controller.state.slide).toBe(5);
  });

  it("a failed navigation does not change the notes and says why", async () => {
    const { controller, failNext } = make();
    controller.step(1);
    await failNext("PowerPoint was closed.");
    expect(controller.state).toMatchObject({ slide: 1, sync: "failed", error: "PowerPoint was closed.", pendingSlide: null });
    // The next attempt is allowed and can succeed.
    controller.step(1);
    expect(controller.state.sync).toBe("pending");
  });

  it("uses what the presentation confirms even if it differs from the request", async () => {
    const { controller, release } = make();
    controller.step(1);
    await release(() => 4);
    expect(controller.state.slide).toBe(4);
  });

  it("steps over a gap in the numbered slides", async () => {
    const { controller, release, calls } = make({ slides: [1, 2, 4, 5], initial: 2 });
    controller.step(1);
    await release();
    expect(calls).toEqual([4]);
    controller.step(-1);
    await release();
    expect(calls).toEqual([4, 2]);
  });

  it("follows a change made in the presentation without sending anything back", async () => {
    const { controller, calls } = make();
    controller.adopt(4);
    expect(controller.state).toMatchObject({ slide: 4, sync: "idle" });
    expect(calls).toEqual([]);
  });

  it("ignores reverse sync while its own request is pending", async () => {
    const { controller, release } = make();
    controller.step(1);
    controller.adopt(5);
    expect(controller.state.slide).toBe(1);
    await release();
    expect(controller.state.slide).toBe(2);
  });
});

describe("SlideController without a controllable presentation", () => {
  it("changes the notes immediately (manual mode) and never calls a transport", () => {
    const { controller, calls } = make({ bound: false });
    expect(controller.state.sync).toBe("manual");
    controller.step(1);
    controller.step(1);
    expect(controller.state).toMatchObject({ slide: 3, sync: "manual", pendingSlide: null });
    controller.request(99);
    expect(controller.state.slide).toBe(5);
    expect(calls).toEqual([]);
  });

  it("works for a deck whose size is only known from the presentation", () => {
    const states: ControllerState[] = [];
    const c = new SlideController({
      slides: () => [], slideLimit: () => 3, transport: () => null, initial: 1, onChange: (s) => states.push(s),
    });
    c.step(1); c.step(1); c.step(1);
    expect(c.state.slide).toBe(3);
    c.step(-1);
    expect(c.state.slide).toBe(2);
  });
});
