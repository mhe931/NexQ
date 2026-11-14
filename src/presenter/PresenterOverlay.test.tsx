import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Windows talk over Tauri events; there is no other window here.
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => unknown>());
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: (name: string, handler: (event: { payload: unknown }) => unknown) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

import { PresenterOverlay } from "./PresenterOverlay";
import { useMeetingStore } from "../stores/meetingStore";
import { usePresenterStore } from "../stores/presenterStore";
import { useStreamStore } from "../stores/streamStore";
import { makeProfile, makeSlide } from "../test/profileFixtures";
import type { MeetingProfile } from "../lib/profileTypes";

/** Every Tauri command the overlay sent. */
let invoked: string[] = [];

const DECK = [makeSlide(1, "Notes for the first slide"), makeSlide(3, "Notes for slide three"), makeSlide(4, "")];

function present(profile: MeetingProfile, over: Partial<ReturnType<typeof usePresenterStore.getState>> = {}) {
  usePresenterStore.setState({ profile, slides: DECK, currentSlide: 3, phase: "presentation", hidden: false, speechMuted: false, error: null, ...over });
  return render(<PresenterOverlay />);
}

beforeAll(() => {
  mockWindows("overlay");
  mockIPC((cmd) => {
    invoked.push(cmd);
    return [];
  }, { shouldMockEvents: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollTo = () => {};
});

beforeEach(() => {
  invoked = [];
  listeners.clear();
  useMeetingStore.setState({
    listening: false,
    startListening: vi.fn().mockResolvedValue(undefined),
    pauseListening: vi.fn().mockResolvedValue(undefined),
    endMeetingFlow: vi.fn().mockResolvedValue(undefined),
  });
  useStreamStore.getState().resetForMeeting();
});

afterEach(() => {
  cleanup();
  usePresenterStore.getState().clear();
});

describe("PresenterOverlay slides", () => {
  it("shows the notes of exactly the current slide", () => {
    present(makeProfile());
    expect(screen.getByRole("heading", { name: "Slide 3 / 4" })).toBeInTheDocument();
    expect(screen.getByText("Notes for slide three")).toBeInTheDocument();
    expect(screen.queryByText("Notes for the first slide")).toBeNull();
  });

  it("never borrows a neighbour's notes for a slide without any", () => {
    present(makeProfile(), { currentSlide: 4 });
    expect(screen.getByText("No notes for this slide")).toBeInTheDocument();
    expect(screen.queryByText("Notes for slide three")).toBeNull();
  });

  it("steps over a gap in the slide numbers with the keyboard", () => {
    present(makeProfile());
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "Slide 4 / 4" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "p" });
    fireEvent.keyDown(window, { key: "PageUp" });
    expect(screen.getByRole("heading", { name: "Slide 1 / 4" })).toBeInTheDocument();
    expect(screen.getByText("Notes for the first slide")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "End" });
    expect(screen.getByRole("heading", { name: "Slide 4 / 4" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Home" });
    expect(screen.getByRole("heading", { name: "Slide 1 / 4" })).toBeInTheDocument();
  });

  it("has buttons and a slide selector as the manual fallback", () => {
    present(makeProfile());
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(screen.getByRole("heading", { name: "Slide 4 / 4" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Go to slide"), { target: { value: "1" } });
    expect(screen.getByRole("heading", { name: "Slide 1 / 4" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));
    expect(screen.getByRole("button", { name: "Previous slide" })).toBeDisabled();
    expect(screen.getByText(/do not follow automatically/)).toBeInTheDocument();
  });

  it("ignores slide keys typed into a text field", () => {
    present(makeProfile());
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "n" });
    expect(screen.getByRole("heading", { name: "Slide 3 / 4" })).toBeInTheDocument();
    input.remove();
  });

  it("hides to a thin bar and back with H", () => {
    present(makeProfile());
    fireEvent.keyDown(window, { key: "h" });
    expect(screen.queryByText("Notes for slide three")).toBeNull();
    expect(screen.getByRole("button", { name: /Show notes/ })).toBeInTheDocument();
    expect(screen.getByText("REHEARSAL — AI assisted")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "h" });
    expect(screen.getByText("Notes for slide three")).toBeInTheDocument();
  });
});

describe("PresenterOverlay badges and focus", () => {
  it("labels a rehearsal and a live session", () => {
    const { unmount } = present(makeProfile({ sessionKind: "rehearsal" }));
    expect(screen.getByText("REHEARSAL — AI assisted")).toBeInTheDocument();
    unmount();
    present(makeProfile({ sessionKind: "live" }));
    expect(screen.getByText("LIVE — AI assisted")).toBeInTheDocument();
  });

  it("shows whether it is listening", () => {
    present(makeProfile());
    expect(screen.getByText("NOT LISTENING")).toBeInTheDocument();
    act(() => useMeetingStore.setState({ listening: true }));
    expect(screen.getByText("LISTENING")).toBeInTheDocument();
  });

  it("never steals focus or focuses an input by itself", () => {
    present(makeProfile());
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    fireEvent.keyDown(window, { key: "q" });
    expect(invoked.filter((c) => /set_focus|setFocus/i.test(c))).toEqual([]);
    expect(document.activeElement?.tagName).not.toBe("INPUT");
  });

  it("ends the meeting through the shared flow", () => {
    present(makeProfile());
    fireEvent.click(screen.getByRole("button", { name: "End meeting" }));
    expect(useMeetingStore.getState().endMeetingFlow).toHaveBeenCalled();
  });
});

describe("PresenterOverlay Start Q&A", () => {
  it("asks for confirmation before listening when consent was not given", async () => {
    present(makeProfile({ audio: { ...makeProfile().audio, listeningConsentConfirmed: false } }));
    fireEvent.click(screen.getByRole("button", { name: /Start Q&A/ }));
    const dialog = screen.getByRole("alertdialog", { name: "Confirm listening" });
    expect(dialog).toHaveTextContent("Listening captures audio of the people in this meeting. Confirm everyone agreed.");
    expect(useMeetingStore.getState().startListening).not.toHaveBeenCalled();
    expect(usePresenterStore.getState().phase).toBe("presentation");

    fireEvent.click(within(dialog).getByRole("button", { name: /Everyone agreed/ }));
    await waitFor(() => expect(usePresenterStore.getState().phase).toBe("qa"));
    expect(useMeetingStore.getState().startListening).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Back to slides" })).toBeInTheDocument();
  });

  it("can be cancelled without listening", () => {
    present(makeProfile());
    fireEvent.keyDown(window, { key: "q" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(useMeetingStore.getState().startListening).not.toHaveBeenCalled();
    expect(usePresenterStore.getState().phase).toBe("presentation");
  });

  it("starts at once when everyone already agreed in the meeting setup, and can go back to slides", async () => {
    present(makeProfile({ audio: { ...makeProfile().audio, listeningConsentConfirmed: true } }));
    fireEvent.click(screen.getByRole("button", { name: /Start Q&A/ }));
    await waitFor(() => expect(usePresenterStore.getState().phase).toBe("qa"));
    expect(useMeetingStore.getState().startListening).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to slides" }));
    expect(usePresenterStore.getState().phase).toBe("presentation");
    expect(screen.getByText("Notes for slide three")).toBeInTheDocument();
  });

  it("offers Pause and Resume listening during Q&A", () => {
    present(makeProfile({ audio: { ...makeProfile().audio, listeningConsentConfirmed: true } }), { phase: "qa" });
    act(() => useMeetingStore.setState({ listening: true }));
    fireEvent.click(screen.getByRole("button", { name: "Pause listening" }));
    expect(useMeetingStore.getState().pauseListening).toHaveBeenCalled();
    act(() => useMeetingStore.setState({ listening: false }));
    fireEvent.click(screen.getByRole("button", { name: "Resume listening" }));
    expect(useMeetingStore.getState().startListening).toHaveBeenCalled();
  });
});

describe("PresenterOverlay answers", () => {
  const REPLY = "[ANSWER] Use a hash map for constant-time lookups.\n[ACTION] Open the project in your editor\n[ACTION] Run the unit tests\n[SOURCE] resume.pdf, page 2";

  function qa(content: string, over: Partial<ReturnType<typeof useStreamStore.getState>> = {}) {
    useStreamStore.setState({ currentContent: content, isStreaming: false, phase: "idle", error: null, ...over });
    return present(makeProfile({ meetingType: "interview", audio: { ...makeProfile().audio, listeningConsentConfirmed: true } }), { phase: "qa", slides: [] });
  }

  it("renders action steps as their own numbered items, apart from the answer", () => {
    qa(REPLY);
    const steps = screen.getByRole("list", { name: "Steps for you to do" });
    const items = within(steps).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("1.Open the project in your editor");
    expect(items[1]).toHaveTextContent("2.Run the unit tests");
    expect(within(steps).queryByText(/hash map/)).toBeNull();
    expect(screen.getByText("Use a hash map for constant-time lookups.")).toBeInTheDocument();
    expect(steps.parentElement).toHaveTextContent("DO");
    expect(screen.getByRole("list", { name: "Sources" })).toHaveTextContent("Source: resume.pdf, page 2");
    expect(screen.getByLabelText(/NexQ never operates your computer/)).toBeInTheDocument();
  });

  it("renders an unstructured reply as plain answer text", () => {
    qa("Just a plain reply with no tags.");
    expect(screen.getByText("Just a plain reply with no tags.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Steps for you to do" })).toBeNull();
  });

  it("runs nothing on the computer: showing or clicking steps makes no Tauri call", () => {
    qa(REPLY);
    invoked = [];
    fireEvent.click(screen.getByText("Run the unit tests"));
    fireEvent.keyDown(window, { key: "Enter" });
    expect(invoked).toEqual([]);
  });

  it("shows a Stop button only while an answer is running", () => {
    qa(REPLY, { isStreaming: true, phase: "writing" });
    expect(screen.getByRole("button", { name: "Stop answer" })).toBeInTheDocument();
    cleanup();
    qa(REPLY);
    expect(screen.queryByRole("button", { name: "Stop answer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy answer" })).toBeInTheDocument();
  });

  it("opens the typed Ask input only when the user asks for it", () => {
    qa(REPLY);
    expect(screen.queryByLabelText("Type your question")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask a question" }));
    expect(screen.getByLabelText("Type your question")).toBeInTheDocument();
  });

  it("tells the user when the provider was switched", async () => {
    qa(REPLY);
    await waitFor(() => expect(listeners.has("profile_fallback")).toBe(true));
    act(() => {
      listeners.get("profile_fallback")?.({
        payload: { from_provider: "openai", from_model: "gpt-4o", to_provider: "groq", to_model: "llama", reason: "rate limited", request_id: null },
      });
    });
    expect(screen.getByText("Switched to groq (rate limited) — openai was unavailable")).toBeInTheDocument();
  });

  it("loads no speech code in text mode and offers controls in spoken mode", async () => {
    qa(REPLY);
    expect(screen.queryByRole("group", { name: "Spoken answer controls" })).toBeNull();
    cleanup();
    usePresenterStore.setState({ profile: makeProfile({ audio: { ...makeProfile().audio, outputMode: "spoken", listeningConsentConfirmed: true } }), slides: [], phase: "qa" });
    render(<PresenterOverlay />);
    // jsdom has no speech engine: the honest fallback shows instead of controls.
    expect(await screen.findByText("Spoken answers are not available on this system.")).toBeInTheDocument();
  });
});
