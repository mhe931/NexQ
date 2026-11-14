import { create } from "zustand";
import { profileIpc } from "../lib/profileIpc";
import type {
  DocumentRole,
  IngestReport,
  MeetingProfile,
  MeetingTemplate,
  ProfileDocument,
  ProfileSummary,
  SlideRow,
  TemplateCatalog,
} from "../lib/profileTypes";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** True when the prompt differs from what the profile's template would put there. */
export function promptIsEdited(profile: MeetingProfile, catalog: TemplateCatalog | null): boolean {
  const text = profile.systemPrompt.trim();
  if (!text) return false;
  const template = catalog?.templates.find((t) => t.id === profile.template);
  return !template || template.systemPrompt.trim() !== text;
}

interface ProfileState {
  summaries: ProfileSummary[];
  catalog: TemplateCatalog | null;
  /** A meeting another window asked the home screen to open for setup (consumed by the home screen). */
  setupRequest: string | null;
  /** The meeting being edited (a draft: only `save` writes it). */
  current: MeetingProfile | null;
  dirty: boolean;
  documents: ProfileDocument[];
  slides: SlideRow[];
  lastReport: IngestReport | null;
  busy: boolean;
  error: string | null;

  loadList: () => Promise<void>;
  loadCatalog: () => Promise<void>;
  create: (name: string, templateId: string) => Promise<MeetingProfile | null>;
  open: (id: string) => Promise<MeetingProfile | null>;
  close: () => void;
  patch: (change: Partial<MeetingProfile> | ((p: MeetingProfile) => MeetingProfile)) => void;
  /** Applies a template: type, template id and its prompt (the caller confirms an overwrite). */
  applyTemplate: (template: MeetingTemplate) => void;
  save: () => Promise<boolean>;
  duplicate: (id: string) => Promise<MeetingProfile | null>;
  remove: (id: string) => Promise<boolean>;
  loadSlides: () => Promise<void>;
  saveSlideNotes: (slideNo: number, notes: string) => Promise<boolean>;
  addFiles: (paths: string[], role?: DocumentRole) => Promise<void>;
  addFolder: (path: string, kind: "local" | "cloud", label?: string) => Promise<void>;
  refreshSources: () => Promise<void>;
  /** Re-reads documents, source folders, presentation source and slides after an import done elsewhere. */
  reloadSources: () => Promise<void>;
  removeDocument: (documentId: string) => Promise<void>;
  setDocumentRole: (documentId: string, role: DocumentRole) => Promise<void>;
  setPresentation: (documentId: string) => Promise<void>;
  removeFolder: (folderId: string) => Promise<void>;
  clearError: () => void;
}

const EMPTY_MEETING = {
  current: null,
  dirty: false,
  documents: [] as ProfileDocument[],
  slides: [] as SlideRow[],
  lastReport: null,
  error: null,
};

/** Incremented whenever another meeting is opened, so late replies of the old one are dropped. */
let generation = 0;

export const useProfileStore = create<ProfileState>((set, get) => {
  /** Runs a backend call for the open meeting; ignores its result if another meeting was opened meanwhile. */
  async function forCurrent<T>(task: (profileId: string) => Promise<T>, apply: (result: T) => void): Promise<void> {
    const profile = get().current;
    if (!profile) return;
    const mine = generation;
    set({ busy: true, error: null });
    try {
      const result = await task(profile.id);
      if (mine === generation) apply(result);
    } catch (e) {
      if (mine === generation) set({ error: errorText(e) });
    } finally {
      if (mine === generation) set({ busy: false });
    }
  }

  /**
   * Documents change the stored meeting (source folders, presentation choice).
   * Take those from the backend without losing the user's unsaved edits.
   */
  async function reloadDocuments(profileId: string): Promise<void> {
    const mine = generation;
    const [documents, fresh] = await Promise.all([profileIpc.documents(profileId), profileIpc.get(profileId)]);
    if (mine !== generation) return;
    const adopt = (p: MeetingProfile): MeetingProfile => ({
      ...p,
      sourceFolders: fresh.sourceFolders,
      presentation: { ...p.presentation, source: fresh.presentation.source, currentSlide: fresh.presentation.currentSlide },
    });
    set((s) => ({ documents, current: s.current ? adopt(s.current) : s.current }));
    if (get().current?.meetingType === "presentation_qa") await get().loadSlides();
  }

  return {
    summaries: [],
    catalog: null,
    setupRequest: null,
    ...EMPTY_MEETING,
    busy: false,

    loadList: async () => {
      try {
        set({ summaries: await profileIpc.list() });
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    loadCatalog: async () => {
      if (get().catalog) return;
      try {
        set({ catalog: await profileIpc.catalog() });
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    create: async (name, templateId) => {
      generation++;
      set({ ...EMPTY_MEETING, busy: true });
      const mine = generation;
      try {
        const profile = await profileIpc.create(name, templateId);
        if (mine !== generation) return null;
        set({ current: profile, dirty: false });
        await get().loadList();
        return profile;
      } catch (e) {
        if (mine === generation) set({ error: errorText(e) });
        return null;
      } finally {
        if (mine === generation) set({ busy: false });
      }
    },

    open: async (id) => {
      // Nothing of the previous meeting stays on screen while this one loads.
      generation++;
      const mine = generation;
      set({ ...EMPTY_MEETING, busy: true });
      try {
        const [profile, documents] = await Promise.all([profileIpc.get(id), profileIpc.documents(id)]);
        if (mine !== generation) return null;
        set({ current: profile, documents, dirty: false });
        if (profile.meetingType === "presentation_qa") await get().loadSlides();
        return profile;
      } catch (e) {
        if (mine === generation) set({ error: errorText(e) });
        return null;
      } finally {
        if (mine === generation) set({ busy: false });
      }
    },

    close: () => {
      generation++;
      set({ ...EMPTY_MEETING, busy: false });
    },

    patch: (change) =>
      set((s) => {
        if (!s.current) return s;
        const next = typeof change === "function" ? change(s.current) : { ...s.current, ...change };
        return { current: next, dirty: true };
      }),

    applyTemplate: (template) =>
      get().patch((p) => ({
        ...p,
        template: template.id,
        meetingType: template.meetingType,
        systemPrompt: template.systemPrompt,
        ai: {
          ...p.ai,
          responseFormat: template.meetingType === "interview" ? "action_answer" : p.ai.responseFormat,
        },
      })),

    save: async () => {
      const profile = get().current;
      if (!profile) return false;
      const mine = generation;
      set({ busy: true, error: null });
      try {
        const saved = await profileIpc.save(profile);
        if (mine !== generation) return true;
        set({ current: saved ?? profile, dirty: false });
        await get().loadList();
        return true;
      } catch (e) {
        if (mine === generation) set({ error: errorText(e) });
        return false;
      } finally {
        if (mine === generation) set({ busy: false });
      }
    },

    duplicate: async (id) => {
      try {
        const copy = await profileIpc.duplicate(id);
        await get().loadList();
        return copy;
      } catch (e) {
        set({ error: errorText(e) });
        return null;
      }
    },

    remove: async (id) => {
      try {
        await profileIpc.remove(id);
        if (get().current?.id === id) get().close();
        await get().loadList();
        return true;
      } catch (e) {
        set({ error: errorText(e) });
        return false;
      }
    },

    loadSlides: async () => {
      const profile = get().current;
      if (!profile) return;
      const mine = generation;
      try {
        const slides = await profileIpc.slides(profile.id);
        if (mine === generation) set({ slides });
      } catch (e) {
        if (mine === generation) set({ error: errorText(e) });
      }
    },

    saveSlideNotes: async (slideNo, notes) => {
      const profile = get().current;
      if (!profile) return false;
      try {
        await profileIpc.setSlideNotes(profile.id, slideNo, notes);
        await get().loadSlides();
        return true;
      } catch (e) {
        set({ error: errorText(e) });
        return false;
      }
    },

    addFiles: (paths, role = "reference") =>
      forCurrent(
        async (id) => {
          const report = await profileIpc.addFiles(id, paths, role);
          await reloadDocuments(id);
          return report;
        },
        (lastReport) => set({ lastReport }),
      ),

    addFolder: (path, kind, label) =>
      forCurrent(
        async (id) => {
          const report = await profileIpc.addFolder(id, path, true, kind, label);
          await reloadDocuments(id);
          return report;
        },
        (lastReport) => set({ lastReport }),
      ),

    refreshSources: () =>
      forCurrent(
        async (id) => {
          const report = await profileIpc.refresh(id);
          await reloadDocuments(id);
          return report;
        },
        (lastReport) => set({ lastReport }),
      ),

    reloadSources: async () => {
      const profile = get().current;
      if (!profile) return;
      try {
        await reloadDocuments(profile.id);
      } catch (e) {
        set({ error: errorText(e) });
      }
    },

    removeDocument: (documentId) =>
      forCurrent(
        async (id) => {
          await profileIpc.removeDocument(id, documentId);
          await reloadDocuments(id);
        },
        () => {},
      ),

    setDocumentRole: (documentId, role) =>
      forCurrent(
        async (id) => {
          await profileIpc.setDocumentRole(id, documentId, role);
          await reloadDocuments(id);
        },
        () => {},
      ),

    setPresentation: (documentId) =>
      forCurrent(
        async (id) => {
          await profileIpc.setPresentation(id, documentId);
          await reloadDocuments(id);
        },
        () => {},
      ),

    removeFolder: (folderId) =>
      forCurrent(
        async (id) => {
          await profileIpc.removeFolder(id, folderId);
          await reloadDocuments(id);
        },
        () => {},
      ),

    clearError: () => set({ error: null }),
  };
});
