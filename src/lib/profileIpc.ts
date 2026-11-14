import { invoke } from "@tauri-apps/api/core";
import type {
  Activation,
  DisplayInfo,
  IngestReport,
  MeetingProfile,
  ProfileDocument,
  ProfileSummary,
  PromptPreview,
  SearchHit,
  SessionRef,
  SlideRow,
  TemplateCatalog,
  DocumentRole,
  LatencySnapshot,
  BindingStatus,
  NavResult,
  NotesBlock,
  NotesImportResult,
  PresentationImport,
  PresentationInfo,
  PresentationSettings,
  PresentationTarget,
  TeleprompterSettings,
} from "./profileTypes";

export const profileIpc = {
  catalog: () => invoke<TemplateCatalog>("profile_catalog"),
  list: () => invoke<ProfileSummary[]>("profile_list"),
  create: (name: string, template: string) => invoke<MeetingProfile>("profile_create", { name, template }),
  get: (id: string) => invoke<MeetingProfile>("profile_get", { id }),
  save: (profile: MeetingProfile) => invoke<MeetingProfile>("profile_save", { profile }),
  duplicate: (id: string) => invoke<MeetingProfile>("profile_duplicate", { id }),
  remove: (id: string) => invoke<void>("profile_delete", { id }),
  documents: (profileId: string) => invoke<ProfileDocument[]>("profile_documents", { profileId }),
  addFiles: (profileId: string, paths: string[], role: DocumentRole = "reference") =>
    invoke<IngestReport>("profile_add_files", { profileId, paths, role }),
  addFolder: (profileId: string, path: string, recursive = true, kind: "local" | "cloud" = "local", label?: string) =>
    invoke<IngestReport>("profile_add_folder", { profileId, path, recursive, kind, label }),
  removeFolder: (profileId: string, folderId: string) =>
    invoke<void>("profile_remove_folder", { profileId, folderId }),
  refresh: (profileId: string) => invoke<IngestReport>("profile_refresh", { profileId }),
  removeDocument: (profileId: string, documentId: string) =>
    invoke<void>("profile_remove_document", { profileId, documentId }),
  setDocumentRole: (profileId: string, documentId: string, role: DocumentRole) =>
    invoke<void>("profile_set_document_role", { profileId, documentId, role }),
  setPresentation: (profileId: string, documentId: string) =>
    invoke<number>("profile_set_presentation", { profileId, documentId }),
  slides: (profileId: string) => invoke<SlideRow[]>("profile_slides", { profileId }),
  setSlideNotes: (profileId: string, slideNo: number, notes: string) =>
    invoke<void>("profile_set_slide_notes", { profileId, slideNo, notes }),
  search: (profileId: string, query: string, topK = 5) =>
    invoke<SearchHit[]>("profile_search", { profileId, query, topK }),
  previewPrompt: (profileId: string) => invoke<PromptPreview>("profile_preview_prompt", { profileId }),
  activate: (profileId: string) => invoke<Activation>("profile_activate", { profileId }),
  deactivate: () => invoke<void>("profile_deactivate"),
  linkMeeting: (meetingId: string, profileId: string) =>
    invoke<void>("profile_link_meeting", { meetingId, profileId }),
  sessions: (profileId: string) => invoke<SessionRef[]>("profile_sessions", { profileId }),
  clearSessions: (profileId: string) => invoke<number>("profile_clear_sessions", { profileId }),
  latencyStats: () => invoke<LatencySnapshot[]>("profile_latency_stats"),

  // Presenting: binding and synchronised navigation (never calls an LLM or the network)
  presentTargets: () => invoke<PresentationTarget[]>("present_list_targets"),
  presentBind: (profileId: string, targetId: string) => invoke<BindingStatus>("present_bind", { profileId, targetId }),
  presentDisconnect: (profileId: string) => invoke<void>("present_disconnect", { profileId }),
  presentRevalidate: (profileId: string) => invoke<BindingStatus>("present_revalidate", { profileId }),
  presentStatus: (expectedSlide: number | null) => invoke<BindingStatus>("present_status", { expectedSlide }),
  presentGoto: (slide: number) => invoke<NavResult>("present_goto", { slide }),
  presentTestNavigation: () => invoke<NavResult>("present_test_navigation"),

  // Presentation and external speaker-notes sources
  addPresentation: (profileId: string, path: string) =>
    invoke<PresentationImport>("profile_add_presentation", { profileId, path }),
  presentationInfo: (profileId: string) =>
    invoke<PresentationInfo | null>("profile_presentation_info", { profileId }),
  addNotes: (profileId: string, path: string) => invoke<NotesImportResult>("profile_add_notes", { profileId, path }),
  notesBlocks: (profileId: string) => invoke<NotesBlock[]>("profile_notes_blocks", { profileId }),
  assignNotes: (profileId: string, blockId: string, slide: number | null) =>
    invoke<void>("profile_notes_assign", { profileId, blockId, slide }),

  // Per-meeting presenter preferences (narrow writes: they never overwrite other settings)
  updateTeleprompter: (profileId: string, settings: TeleprompterSettings) =>
    invoke<TeleprompterSettings>("profile_update_teleprompter", { profileId, settings }),
  updatePresentation: (profileId: string, settings: PresentationSettings) =>
    invoke<PresentationSettings>("profile_update_presentation", { profileId, settings }),
  setListeningConsent: (profileId: string, confirmed: boolean) =>
    invoke<void>("profile_set_listening_consent", { profileId, confirmed }),
  systemFonts: () => invoke<string[]>("list_system_fonts"),
  displays: () => invoke<DisplayInfo[]>("list_displays"),
  placeOverlay: (x: number, y: number, width: number, height: number) =>
    invoke<void>("place_overlay", { x, y, width, height }),
  /** Fades the whole overlay window (0.2–1); `null` returns it to its normal, opaque look. */
  setPresenterWindowOpacity: (opacity: number | null) =>
    invoke<void>("set_presenter_window_opacity", { opacity }),
};
