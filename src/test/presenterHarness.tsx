import { render } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { vi } from "vitest";
import { PresenterOverlay } from "../presenter/PresenterOverlay";
import type { MeetingProfile, SlideRow } from "../lib/profileTypes";
import { useMeetingStore } from "../stores/meetingStore";
import { usePresenterStore } from "../stores/presenterStore";
import { useStreamStore } from "../stores/streamStore";
import { makeProfile, makeSlide, profileIpcMock as ipc, resetProfileIpcMock } from "./profileFixtures";

export const DECK: SlideRow[] = [makeSlide(1, "Notes for the first slide"), makeSlide(3, "Notes for slide three"), makeSlide(4, "")];

/** Tauri's window and event layers as no-ops (call once, from beforeAll). */
export function installPresenterEnv() {
  mockWindows("overlay");
  mockIPC(() => [], { shouldMockEvents: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollTo = () => {};
}

/** The store's real actions, so a test that replaced one with a spy does not leak it into the next. */
const ORIGINAL_ACTIONS = Object.fromEntries(
  Object.entries(usePresenterStore.getState()).filter(([, v]) => typeof v === "function"),
);

/** Fresh mocks and stores (call from beforeEach). */
export function resetPresenterEnv() {
  usePresenterStore.setState(ORIGINAL_ACTIONS);
  resetProfileIpcMock();
  useMeetingStore.setState({
    listening: false,
    startListening: vi.fn().mockResolvedValue(undefined),
    pauseListening: vi.fn().mockResolvedValue(undefined),
    endMeetingFlow: vi.fn().mockResolvedValue(undefined),
  });
  useStreamStore.getState().resetForMeeting();
}

/** Loads `profile` through the store (so navigation is wired up) and renders the overlay. */
export async function presentLoaded(
  profile: MeetingProfile = makeProfile(),
  { slides = DECK, currentSlide = 3 }: { slides?: SlideRow[]; currentSlide?: number } = {},
) {
  ipc.get.mockResolvedValue({ ...profile, presentation: { ...profile.presentation, currentSlide } });
  ipc.slides.mockResolvedValue(slides);
  await usePresenterStore.getState().load(profile.id);
  return render(<PresenterOverlay />);
}

/** A profile with some teleprompter settings changed. */
export function withTeleprompter(over: Partial<MeetingProfile["environment"]["teleprompter"]>, base: MeetingProfile = makeProfile()): MeetingProfile {
  return { ...base, environment: { ...base.environment, teleprompter: { ...base.environment.teleprompter, ...over } } };
}
