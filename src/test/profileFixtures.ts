import { vi } from "vitest";
import type { MeetingProfile, ProfileSummary, SlideRow, TemplateCatalog } from "../lib/profileTypes";

/** Every `profileIpc` command as a vi.fn(), for `vi.mock("../lib/profileIpc", ...)`. */
export const profileIpcMock = {
  catalog: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  duplicate: vi.fn(),
  remove: vi.fn(),
  documents: vi.fn(),
  addFiles: vi.fn(),
  addFolder: vi.fn(),
  removeFolder: vi.fn(),
  refresh: vi.fn(),
  removeDocument: vi.fn(),
  setDocumentRole: vi.fn(),
  setPresentation: vi.fn(),
  slides: vi.fn(),
  setSlideNotes: vi.fn(),
  search: vi.fn(),
  previewPrompt: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
  linkMeeting: vi.fn(),
  sessions: vi.fn(),
  clearSessions: vi.fn(),
  displays: vi.fn(),
  placeOverlay: vi.fn(),
};

export function resetProfileIpcMock() {
  for (const fn of Object.values(profileIpcMock)) fn.mockReset();
  profileIpcMock.list.mockResolvedValue([]);
  profileIpcMock.documents.mockResolvedValue([]);
  profileIpcMock.slides.mockResolvedValue([]);
  profileIpcMock.sessions.mockResolvedValue([]);
  profileIpcMock.displays.mockResolvedValue([]);
  profileIpcMock.catalog.mockResolvedValue(CATALOG);
  profileIpcMock.save.mockImplementation(async (p: MeetingProfile) => p);
}

export const CATALOG: TemplateCatalog = {
  templates: [
    { id: "academic_qa", name: "Presentation + Academic Q&A", description: "", meetingType: "presentation_qa", systemPrompt: "Academic prompt" },
    { id: "technical_interview", name: "Technical Interview", description: "", meetingType: "interview", systemPrompt: "Interview prompt" },
    { id: "general_meeting", name: "General Meeting", description: "", meetingType: "general", systemPrompt: "General prompt" },
    { id: "custom", name: "Custom", description: "", meetingType: "custom", systemPrompt: "" },
  ],
  styles: [{ id: "daniel_academic_voice", name: "Daniel Academic Voice", description: "", instruction: "" }],
};

export function makeProfile(over: Partial<MeetingProfile> = {}): MeetingProfile {
  return {
    id: "p1",
    name: "Thesis defence",
    meetingType: "presentation_qa",
    template: "academic_qa",
    meetingDate: null,
    platform: "teams",
    sessionKind: "rehearsal",
    assistancePermittedConfirmed: false,
    systemPrompt: "Academic prompt",
    additionalInstructions: "",
    style: { profileId: null, customText: "" },
    sourceFolders: [],
    ai: {
      primaryProvider: null,
      primaryModel: null,
      fallbackProvider: null,
      fallbackModel: null,
      fallbackConsentProvider: null,
      automaticFallback: false,
      strategy: "balanced",
      responseLength: "short",
      responseFormat: "plain",
      streaming: true,
      maxResponseSeconds: 20,
      spendLimitUsd: null,
      allowPaidFallback: false,
    },
    audio: {
      transcriptionEngine: "auto",
      micDeviceId: null,
      outputDeviceId: null,
      outputMode: "text",
      listeningConsentConfirmed: false,
    },
    environment: {
      monitorCount: 1,
      autoDetectDisplays: true,
      primaryMonitor: 0,
      presentationMonitor: 0,
      nexqMonitor: 0,
      webcamPosition: "top_center",
      screenShare: "none",
      teleprompter: { fontSize: 28, lineChars: 60, opacity: 0.92, scrollSpeed: 0, highContrast: true, x: 0, y: 0, width: 900, height: 220 },
    },
    presentation: { source: "none", googleSlidesUrl: "", autoFollow: false, currentSlide: 1 },
    feedback: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** A profile that can start: model chosen, nothing else missing. */
export function readyProfile(over: Partial<MeetingProfile> = {}): MeetingProfile {
  const base = makeProfile(over);
  return {
    ...base,
    ai: { ...base.ai, primaryProvider: base.ai.primaryProvider ?? "ollama", primaryModel: base.ai.primaryModel ?? "llama3" },
  };
}

export function makeSummary(over: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: "p1",
    name: "Thesis defence",
    meetingType: "presentation_qa",
    platform: "teams",
    meetingDate: null,
    primaryProvider: "ollama",
    primaryModel: "llama3",
    documentCount: 2,
    sessionCount: 1,
    updatedAt: "2026-02-01T00:00:00Z",
    ...over,
  };
}

export function makeSlide(slideNo: number, notes: string, title = `Title ${slideNo}`): SlideRow {
  return { slideNo, documentId: "doc1", title, body: "", notesOriginal: notes, notesEdited: null };
}
