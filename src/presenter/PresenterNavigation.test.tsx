import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("../lib/profileIpc", async () => ({ profileIpc: (await import("../test/profileFixtures")).profileIpcMock }));

import { usePresenterStore } from "../stores/presenterStore";
import type { BindingStatus, MeetingProfile } from "../lib/profileTypes";
import { DISCONNECTED, makeProfile, profileIpcMock as ipc } from "../test/profileFixtures";
import { installPresenterEnv, presentLoaded, resetPresenterEnv } from "../test/presenterHarness";

beforeAll(installPresenterEnv);
beforeEach(resetPresenterEnv);
afterEach(() => {
  cleanup();
  usePresenterStore.getState().clear();
});

const CONNECTED: BindingStatus = {
  state: "connected", targetTitle: "Thesis.pptx", targetId: "pp1", kind: "powerpoint", targetSlide: 3,
  slideCount: 4, slideshowRunning: true, message: "Connected",
};
const bound = (over: Partial<MeetingProfile> = {}): MeetingProfile => {
  const p = makeProfile(over);
  return { ...p, presentation: { ...p.presentation, binding: { id: "pp1", title: "Thesis.pptx", kind: "powerpoint", boundAt: "2026-01-01T00:00:00Z" } } };
};
const heading = (n: number) => screen.getByRole("heading", { name: `Slide ${n} / 4` });

/** A promise settled from the test, to hold a navigation "in flight". */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("one control for the slides", () => {
  it("the Next button and the Right arrow each call step once", async () => {
    await presentLoaded();
    const step = vi.fn();
    act(() => usePresenterStore.setState({ step }));
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(step).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(step).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(step).toHaveBeenLastCalledWith(-1);
    fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));
    expect(step).toHaveBeenCalledTimes(4);
  });

  it("a held key does nothing more, yet still does not scroll the page", async () => {
    await presentLoaded();
    const step = vi.fn();
    act(() => usePresenterStore.setState({ step }));
    const first = fireEvent.keyDown(window, { key: "ArrowRight" });
    const held = fireEvent.keyDown(window, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(window, { key: "PageDown", repeat: true });
    expect(step).toHaveBeenCalledTimes(1);
    expect(first).toBe(false); // preventDefault
    expect(held).toBe(false);
  });

  it("Home, End and the first/last buttons go through the store", async () => {
    await presentLoaded();
    fireEvent.keyDown(window, { key: "End" });
    expect(heading(4)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "First slide" }));
    expect(heading(1)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Last slide" }));
    expect(heading(4)).toBeInTheDocument();
  });

  it("does not act on slide keys while hidden or in Q&A", async () => {
    await presentLoaded();
    const step = vi.fn();
    act(() => usePresenterStore.setState({ step, hidden: true }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    act(() => usePresenterStore.setState({ hidden: false, phase: "qa" }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(step).not.toHaveBeenCalled();
  });

  it("uses the meeting's configurable shortcuts", async () => {
    const p = makeProfile();
    await presentLoaded({ ...p, presentation: { ...p.presentation, shortcuts: { ...p.presentation.shortcuts, next: ["x"] } } }, { currentSlide: 1 });
    expect(heading(1)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "n" });
    expect(heading(1)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "x" });
    expect(heading(3)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "X" });
    expect(heading(4)).toBeInTheDocument();
  });

  it("a configurable start-Q&A key starts Q&A", async () => {
    const p = makeProfile({ audio: { ...makeProfile().audio, listeningConsentConfirmed: true } });
    await presentLoaded({ ...p, presentation: { ...p.presentation, shortcuts: { ...p.presentation.shortcuts, startQa: ["k"] } } });
    fireEvent.keyDown(window, { key: "q" });
    expect(usePresenterStore.getState().phase).toBe("presentation");
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(usePresenterStore.getState().phase).toBe("qa"));
  });
});

describe("with a bound presentation", () => {
  beforeEach(() => {
    ipc.presentRevalidate.mockResolvedValue(CONNECTED);
  });

  it("changes the notes only after the presentation confirmed the slide", async () => {
    const goto = deferred<{ confirmedSlide: number; status: BindingStatus }>();
    ipc.presentGoto.mockReturnValue(goto.promise);
    await presentLoaded(bound());
    expect(usePresenterStore.getState().binding.state).toBe("connected");

    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(ipc.presentGoto).toHaveBeenCalledWith(4);
    expect(await screen.findByText("Moving…")).toBeInTheDocument();
    // Still the previous slide's notes until PowerPoint answers.
    expect(heading(3)).toBeInTheDocument();
    expect(screen.getByText("Notes for slide three")).toBeInTheDocument();

    await act(async () => goto.resolve({ confirmedSlide: 4, status: { ...CONNECTED, targetSlide: 4 } }));
    expect(heading(4)).toBeInTheDocument();
    expect(screen.queryByText("Moving…")).toBeNull();
    expect(screen.getByText("No notes for this slide")).toBeInTheDocument();
  });

  it("keeps the notes where they are and says why when the presentation does not move", async () => {
    ipc.presentGoto.mockRejectedValueOnce(new Error("PowerPoint is busy"));
    await presentLoaded(bound());
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("PowerPoint is busy");
    expect(heading(3)).toBeInTheDocument();
    expect(screen.getByText("Notes for slide three")).toBeInTheDocument();
    expect(screen.queryByText("Moving…")).toBeNull();

    ipc.presentGoto.mockResolvedValueOnce({ confirmedSlide: 4, status: { ...CONNECTED, targetSlide: 4 } });
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(heading(4)).toBeInTheDocument());
    expect(ipc.presentGoto).toHaveBeenCalledTimes(2);
    expect(ipc.presentGoto).toHaveBeenLastCalledWith(4);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an out-of-sync notice and syncs to the slide the presentation is on", async () => {
    await presentLoaded(bound());
    act(() => usePresenterStore.setState({ binding: { ...CONNECTED, state: "out_of_sync", targetSlide: 1, message: "Presentation is on slide 1" } }));
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("OUT OF SYNC: presentation is on slide 1");

    ipc.presentStatus.mockResolvedValue({ ...CONNECTED, targetSlide: 1 });
    fireEvent.click(within(notice).getByRole("button", { name: "Sync to current slide" }));
    await waitFor(() => expect(heading(1)).toBeInTheDocument());
    expect(ipc.presentStatus).toHaveBeenCalledWith(null);
    expect(screen.getByText("Notes for the first slide")).toBeInTheDocument();
    expect(screen.queryByText(/OUT OF SYNC: presentation/)).toBeNull();
  });

  it("does not claim manual mode while connected", async () => {
    await presentLoaded(bound());
    expect(screen.queryByText(/Manual: change slides yourself/)).toBeNull();
  });
});

describe("manual mode", () => {
  const MANUAL = "Manual: change slides yourself; NexQ notes follow your selection.";

  it("explains it for an unsupported presentation, and the notes follow at once", async () => {
    ipc.presentRevalidate.mockResolvedValue({ ...DISCONNECTED, state: "unsupported", message: "Not supported" });
    await presentLoaded(bound());
    expect(screen.getByText(MANUAL)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(ipc.presentGoto).not.toHaveBeenCalled();
    expect(heading(4)).toBeInTheDocument();
  });

  it("explains it when a bound presentation is disconnected", async () => {
    ipc.presentRevalidate.mockResolvedValue(DISCONNECTED);
    await presentLoaded(bound());
    expect(screen.getByText(MANUAL)).toBeInTheDocument();
  });

  it("says nothing when no presentation was ever bound", async () => {
    await presentLoaded(makeProfile());
    expect(screen.queryByText(/Manual: change slides yourself/)).toBeNull();
    expect(screen.queryByText(/do not follow automatically/)).toBeNull();
  });
});
