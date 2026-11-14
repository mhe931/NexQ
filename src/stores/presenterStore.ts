import { create } from "zustand";
import { profileIpc } from "../lib/profileIpc";
import type {
  BindingStatus,
  MeetingProfile,
  PresentationSettings,
  SlideRow,
  TeleprompterSettings,
} from "../lib/profileTypes";
import { SlideController, type NavTransport, type SyncState } from "../lib/slideController";
import { slideByNumber } from "../lib/slideNav";
import { DEFAULT_TELEPROMPTER_TEXT } from "../lib/teleprompterDefaults";

export type MeetingPhase = "presentation" | "qa";

const NOT_BOUND: BindingStatus = {
  state: "disconnected",
  targetTitle: null,
  targetId: null,
  kind: null,
  targetSlide: null,
  slideCount: null,
  slideshowRunning: false,
  message: "No presentation is bound.",
};

const SAVE_DELAY_MS = 350;

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

  /** Connection to the presentation being presented. */
  binding: BindingStatus;
  /** `manual` = nothing to control (notes follow your selection); `pending` = waiting for the presentation. */
  sync: SyncState;
  pendingSlide: number | null;
  syncError: string | null;
  /** Auto-scrolling of the notes is paused (runtime only). */
  scrollPaused: boolean;

  /** Loads the meeting's profile and slides; chooses the starting phase and re-checks the saved binding. */
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
  toggleScrollPaused: () => void;
  saveNotes: (slideNo: number, notes: string) => Promise<void>;

  bind: (targetId: string) => Promise<BindingStatus>;
  disconnect: () => Promise<void>;
  testNavigation: () => Promise<string>;
  /** Manual "Sync to current slide": adopt the slide the presentation is on. */
  syncToPresentation: () => Promise<void>;
  /** One reverse-sync poll: reads the presentation's slide and follows it when allowed. */
  pollBinding: () => Promise<void>;

  /** Live typography/opacity changes: applied at once, saved with the meeting shortly after. */
  patchTeleprompter: (patch: Partial<TeleprompterSettings>) => void;
  resetTeleprompter: () => void;
  patchPresentation: (patch: Partial<PresentationSettings>) => void;
  /** Records in memory that the user confirmed listening for this meeting (persist with profileIpc.setListeningConsent). */
  markListeningConsented: () => void;
}

let controller: SlideController | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTele: { id: string; value: TeleprompterSettings } | null = null;
let pendingPres: { id: string; value: PresentationSettings } | null = null;

async function flushSaves() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const tele = pendingTele;
  const pres = pendingPres;
  pendingTele = null;
  pendingPres = null;
  try {
    if (tele) await profileIpc.updateTeleprompter(tele.id, tele.value);
    if (pres) await profileIpc.updatePresentation(pres.id, pres.value);
  } catch (e) {
    usePresenterStore.setState({ error: e instanceof Error ? e.message : String(e) });
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSaves(), SAVE_DELAY_MS);
}

/** Saves any pending presenter preference now (call before the window closes). */
export const flushPresenterSaves = flushSaves;

const controllable = (s: BindingStatus) => s.state === "connected" || s.state === "out_of_sync";

export const usePresenterStore = create<PresenterState>((set, get) => {
  const transport = (): NavTransport | null => {
    if (!controllable(get().binding)) return null;
    return {
      goto: async (slide) => {
        const result = await profileIpc.presentGoto(slide);
        set({ binding: result.status });
        return { confirmedSlide: result.confirmedSlide };
      },
    };
  };

  const buildController = (initial: number) => {
    controller?.dispose();
    controller = new SlideController({
      slides: () => get().slides.map((s) => s.slideNo),
      slideLimit: () => get().binding.slideCount,
      transport,
      initial,
      onChange: (s) => set({ currentSlide: s.slide, sync: s.sync, pendingSlide: s.pendingSlide, syncError: s.error }),
    });
  };

  return {
    profile: null,
    slides: [],
    currentSlide: 1,
    phase: "qa",
    hidden: false,
    speechMuted: false,
    error: null,
    binding: NOT_BOUND,
    sync: "manual",
    pendingSlide: null,
    syncError: null,
    scrollPaused: false,

    load: async (profileId) => {
      try {
        const [profile, slides] = await Promise.all([profileIpc.get(profileId), profileIpc.slides(profileId)]);
        const presenting = profile.meetingType === "presentation_qa" && slides.length > 0;
        const start = slideByNumber(slides, profile.presentation.currentSlide)
          ? profile.presentation.currentSlide
          : (slides[0]?.slideNo ?? 1);
        set({
          profile,
          slides,
          currentSlide: start,
          phase: presenting ? "presentation" : "qa",
          hidden: false,
          error: null,
          binding: NOT_BOUND,
          sync: "manual",
          pendingSlide: null,
          syncError: null,
        });
        buildController(start);
        // The saved binding is only a hint: look for exactly that presentation again.
        if (profile.presentation.binding) {
          try {
            const status = await profileIpc.presentRevalidate(profileId);
            if (get().profile?.id === profileId) {
              set({ binding: status });
              controller?.bindingChanged();
            }
          } catch (e) {
            set({ binding: { ...NOT_BOUND, message: e instanceof Error ? e.message : String(e) } });
          }
        }
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    clear: () => {
      void flushSaves();
      controller?.dispose();
      controller = null;
      set({
        profile: null, slides: [], currentSlide: 1, phase: "qa", hidden: false, speechMuted: false,
        error: null, binding: NOT_BOUND, sync: "manual", pendingSlide: null, syncError: null, scrollPaused: false,
      });
    },

    gotoSlide: (slideNo) => controller?.request(slideNo),
    step: (delta) => controller?.step(delta),
    first: () => controller?.first(),
    last: () => controller?.last(),

    startQa: () => set({ phase: "qa" }),
    backToPresentation: () => set((s) => ({ phase: s.slides.length > 0 ? "presentation" : "qa" })),
    toggleHidden: () => set((s) => ({ hidden: !s.hidden })),
    toggleSpeechMuted: () => set((s) => ({ speechMuted: !s.speechMuted })),
    toggleScrollPaused: () => set((s) => ({ scrollPaused: !s.scrollPaused })),

    saveNotes: async (slideNo, notes) => {
      const profile = get().profile;
      if (!profile) return;
      await profileIpc.setSlideNotes(profile.id, slideNo, notes);
      set({ slides: await profileIpc.slides(profile.id) });
    },

    bind: async (targetId) => {
      const profile = get().profile;
      if (!profile) throw new Error("No meeting is open.");
      const status = await profileIpc.presentBind(profile.id, targetId);
      set({ binding: status });
      controller?.bindingChanged();
      if (status.state === "connected" && status.targetSlide && profile.presentation.autoFollow) {
        controller?.adopt(status.targetSlide);
      }
      return status;
    },

    disconnect: async () => {
      const profile = get().profile;
      if (!profile) return;
      await profileIpc.presentDisconnect(profile.id);
      set({ binding: NOT_BOUND });
      controller?.bindingChanged();
    },

    testNavigation: async () => {
      const result = await profileIpc.presentTestNavigation();
      set({ binding: result.status });
      return `Moved one slide and back; the presentation is on slide ${result.confirmedSlide}.`;
    },

    syncToPresentation: async () => {
      const status = await profileIpc.presentStatus(null);
      set({ binding: status });
      if (status.targetSlide) controller?.adopt(status.targetSlide);
      controller?.bindingChanged();
    },

    pollBinding: async () => {
      const current = get();
      if (!controllable(current.binding) || !current.profile) return;
      const shownBefore = current.currentSlide;
      try {
        const status = await profileIpc.presentStatus(shownBefore);
        // Ignore a reply that raced a navigation we started meanwhile.
        if (get().pendingSlide !== null || get().currentSlide !== shownBefore) return;
        if (status.targetSlide && status.targetSlide !== shownBefore && current.profile.presentation.autoFollow) {
          controller?.adopt(status.targetSlide);
          set({ binding: { ...status, state: status.state === "out_of_sync" ? "connected" : status.state } });
        } else {
          set({ binding: status });
        }
      } catch (e) {
        set({ binding: { ...NOT_BOUND, message: e instanceof Error ? e.message : String(e) } });
        controller?.bindingChanged();
      }
    },

    patchTeleprompter: (patch) => {
      const profile = get().profile;
      if (!profile) return;
      const value = { ...profile.environment.teleprompter, ...patch };
      set({ profile: { ...profile, environment: { ...profile.environment, teleprompter: value } } });
      pendingTele = { id: profile.id, value };
      scheduleSave();
    },

    resetTeleprompter: () => get().patchTeleprompter({ ...DEFAULT_TELEPROMPTER_TEXT }),

    patchPresentation: (patch) => {
      const profile = get().profile;
      if (!profile) return;
      const value = { ...profile.presentation, ...patch };
      set({ profile: { ...profile, presentation: value } });
      pendingPres = { id: profile.id, value };
      scheduleSave();
    },

    markListeningConsented: () => {
      const profile = get().profile;
      if (!profile || profile.audio.listeningConsentConfirmed) return;
      set({ profile: { ...profile, audio: { ...profile.audio, listeningConsentConfirmed: true } } });
    },
  };
});
