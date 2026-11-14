import { create } from "zustand";
import { profileIpc } from "../lib/profileIpc";
import type { MeetingProfile, SlideRow } from "../lib/profileTypes";
import { lastSlide, slideByNumber, stepSlide } from "../lib/slideNav";

export type MeetingPhase = "presentation" | "qa";

interface PresenterState {
  profile: MeetingProfile | null;
  slides: SlideRow[];
  currentSlide: number;
  phase: MeetingPhase;
  /** Notes view hidden by the user (a quick "hide" without ending anything). */
  hidden: boolean;
  /** Spoken answers muted/paused by the user. */
  speechMuted: boolean;
  error: string | null;

  /** Loads the meeting's profile and slides; chooses the starting phase. */
  load: (profileId: string) => Promise<void>;
  clear: () => void;
  gotoSlide: (slideNo: number) => void;
  step: (delta: number) => void;
  first: () => void;
  last: () => void;
  /** Presentation → Q&A. Same profile, documents and settings; only the phase changes. */
  startQa: () => void;
  backToPresentation: () => void;
  toggleHidden: () => void;
  toggleSpeechMuted: () => void;
  saveNotes: (slideNo: number, notes: string) => Promise<void>;
}

export const usePresenterStore = create<PresenterState>((set, get) => ({
  profile: null,
  slides: [],
  currentSlide: 1,
  phase: "qa",
  hidden: false,
  speechMuted: false,
  error: null,

  load: async (profileId) => {
    try {
      const [profile, slides] = await Promise.all([profileIpc.get(profileId), profileIpc.slides(profileId)]);
      const presenting = profile.meetingType === "presentation_qa" && slides.length > 0;
      set({
        profile,
        slides,
        currentSlide: slideByNumber(slides, profile.presentation.currentSlide)
          ? profile.presentation.currentSlide
          : (slides[0]?.slideNo ?? 1),
        phase: presenting ? "presentation" : "qa",
        hidden: false,
        error: null,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  clear: () =>
    set({ profile: null, slides: [], currentSlide: 1, phase: "qa", hidden: false, speechMuted: false, error: null }),

  gotoSlide: (slideNo) => {
    if (slideByNumber(get().slides, slideNo)) set({ currentSlide: slideNo });
  },
  step: (delta) => set((s) => ({ currentSlide: stepSlide(s.slides, s.currentSlide, delta) })),
  first: () => set((s) => ({ currentSlide: s.slides[0]?.slideNo ?? s.currentSlide })),
  last: () => set((s) => ({ currentSlide: lastSlide(s.slides) || s.currentSlide })),

  startQa: () => set({ phase: "qa" }),
  backToPresentation: () => set((s) => ({ phase: s.slides.length > 0 ? "presentation" : "qa" })),
  toggleHidden: () => set((s) => ({ hidden: !s.hidden })),
  toggleSpeechMuted: () => set((s) => ({ speechMuted: !s.speechMuted })),

  saveNotes: async (slideNo, notes) => {
    const profile = get().profile;
    if (!profile) return;
    await profileIpc.setSlideNotes(profile.id, slideNo, notes);
    set({ slides: await profileIpc.slides(profile.id) });
  },
}));
