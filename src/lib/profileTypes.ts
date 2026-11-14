// Mirrors src-tauri/src/profiles/model.rs (serde camelCase / snake_case enums).

export type MeetingType = "presentation_qa" | "interview" | "general" | "custom";
export type Platform = "teams" | "zoom" | "meet" | "other";
export type Strategy = "fast" | "balanced" | "best";
export type OutputMode = "text" | "spoken";
export type TranscriptionEngine = "auto" | "whisper";
export type ScreenShare = "none" | "window" | "display";
export type WebcamPosition = "top_center" | "top_left" | "top_right" | "custom";
export type SessionKind = "rehearsal" | "live";
export type ResponseLength = "short" | "medium" | "long";
export type ResponseFormat = "plain" | "action_answer";
export type PresentationSource = "none" | "pptx" | "google_slides";
export type DocumentRole = "reference" | "instruction";
export type TextDirection = "auto" | "ltr" | "rtl";
export type ColorPreset = "auto" | "white_on_black" | "yellow_on_black" | "green_on_black" | "black_on_white";
export type NotesPriority = "external_first" | "embedded_first";
export type BoundKind = "powerpoint" | "google_slides" | "other";
export type ConnectionState = "connected" | "disconnected" | "unsupported" | "out_of_sync";

export interface SourceFolder {
  id: string;
  path: string;
  kind: "local" | "cloud";
  label: string;
  recursive: boolean;
}

export interface StyleSettings {
  profileId: string | null;
  customText: string;
}

export interface AiSettings {
  primaryProvider: string | null;
  primaryModel: string | null;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  /** Provider the user explicitly allowed to receive this meeting's context as a fallback. */
  fallbackConsentProvider: string | null;
  automaticFallback: boolean;
  strategy: Strategy;
  responseLength: ResponseLength;
  responseFormat: ResponseFormat;
  streaming: boolean;
  maxResponseSeconds: number;
  spendLimitUsd: number | null;
  allowPaidFallback: boolean;
}

export interface AudioSettings {
  transcriptionEngine: TranscriptionEngine;
  micDeviceId: string | null;
  outputDeviceId: string | null;
  outputMode: OutputMode;
  /** Asked once per meeting and kept; never repeated on pause/resume or phase changes. */
  listeningConsentConfirmed: boolean;
  listeningAcknowledgedAt: string | null;
}

export interface TeleprompterSettings {
  fontSize: number;
  /** Preferred font; empty = built-in stack. Always rendered with fallbacks. */
  fontFamily: string;
  textDirection: TextDirection;
  colorPreset: ColorPreset;
  lineSpacing: number;
  lineChars: number;
  opacity: number;
  scrollSpeed: number;
  highContrast: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EnvironmentSettings {
  monitorCount: number;
  autoDetectDisplays: boolean;
  primaryMonitor: number;
  presentationMonitor: number;
  nexqMonitor: number;
  webcamPosition: WebcamPosition;
  screenShare: ScreenShare;
  teleprompter: TeleprompterSettings;
}

export interface PresentationBinding {
  id: string;
  title: string;
  kind: BoundKind;
  boundAt: string;
}

/** `KeyboardEvent.key` values for each presenter action. */
export interface Shortcuts {
  next: string[];
  prev: string[];
  first: string[];
  last: string[];
  startQa: string[];
}

export interface PresentationSettings {
  source: PresentationSource;
  googleSlidesUrl: string;
  /** Follow slide changes made directly in the bound presentation. */
  autoFollow: boolean;
  currentSlide: number;
  notesPriority: NotesPriority;
  binding: PresentationBinding | null;
  shortcuts: Shortcuts;
}

export interface MeetingProfile {
  id: string;
  name: string;
  meetingType: MeetingType;
  template: string;
  meetingDate: string | null;
  platform: Platform;
  sessionKind: SessionKind;
  assistancePermittedConfirmed: boolean;
  systemPrompt: string;
  additionalInstructions: string;
  style: StyleSettings;
  sourceFolders: SourceFolder[];
  ai: AiSettings;
  audio: AudioSettings;
  environment: EnvironmentSettings;
  presentation: PresentationSettings;
  feedback: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  meetingType: MeetingType;
  platform: Platform;
  meetingDate: string | null;
  primaryProvider: string | null;
  primaryModel: string | null;
  documentCount: number;
  sessionCount: number;
  updatedAt: string;
}

export interface ProfileDocument {
  id: string;
  profileId: string;
  name: string;
  sourcePath: string;
  sourceKind: "file" | "folder";
  folderId: string | null;
  role: DocumentRole;
  fileType: string;
  sizeBytes: number;
  contentHash: string;
  mtimeMs: number;
  status: "indexed" | "failed" | "missing";
  error: string | null;
  chunkCount: number;
  preview: string;
  indexedAt: string;
}

export interface Problem {
  path: string;
  reason: string;
}

export interface IngestReport {
  added: string[];
  updated: string[];
  unchanged: string[];
  duplicates: Problem[];
  failed: Problem[];
  skipped: Problem[];
  missing: string[];
}

export interface SlideRow {
  slideNo: number;
  documentId: string;
  title: string;
  body: string;
  notesOriginal: string;
  notesEdited: string | null;
  /** Notes from a separately imported speaker-notes document mapped to this slide. */
  notesExternal?: string | null;
  /** What the presenter view shows (edited > external/embedded by the meeting priority). */
  effectiveNotes?: string;
  notesSource?: "edited" | "external" | "embedded" | "none";
  notesStatus?: "ok" | "differ" | "duplicate" | "missing";
}

export interface SearchHit {
  documentId: string;
  sourceName: string;
  locator: string;
  text: string;
  score: number;
}

export interface MeetingTemplate {
  id: string;
  name: string;
  description: string;
  meetingType: MeetingType;
  systemPrompt: string;
}

export interface StyleProfile {
  id: string;
  name: string;
  description: string;
  instruction: string;
}

export interface TemplateCatalog {
  templates: MeetingTemplate[];
  styles: StyleProfile[];
}

export interface PromptPreview {
  text: string;
  layers: string[];
}

export interface Activation {
  profileId: string;
  layers: string[];
  hasFailover: boolean;
  documents: number;
  promptChars: number;
}

export interface DisplayInfo {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface SessionRef {
  id: string;
  title: string;
  startTime: string;
}

/** Live measurements from this app session (empty until answers were generated). */
export interface LatencySnapshot {
  provider: string;
  model: string;
  samples: number;
  medianFirstTokenMs: number | null;
  medianTotalMs: number | null;
  consecutiveFailures: number;
}

export interface FallbackNotice {
  from_provider: string;
  from_model: string;
  to_provider: string;
  to_model: string;
  reason: string;
  request_id: string | null;
}

export const MEETING_TYPE_LABELS: Record<MeetingType, string> = {
  presentation_qa: "Presentation + Questions",
  interview: "Interview",
  general: "General meeting",
  custom: "Custom",
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  teams: "Microsoft Teams",
  zoom: "Zoom",
  meet: "Google Meet",
  other: "Other / custom",
};

// ── presenting: binding, sources, notes mapping ─────────────────────────────

export interface PresentationTarget {
  id: string;
  kind: BoundKind;
  title: string;
  detail: string;
  /** False when NexQ can only list it (Google Slides in a browser). */
  supportsControl: boolean;
  slideshowRunning: boolean;
  slideCount: number | null;
  currentSlide: number | null;
}

export interface BindingStatus {
  state: ConnectionState;
  targetTitle: string | null;
  targetId: string | null;
  kind: BoundKind | null;
  targetSlide: number | null;
  slideCount: number | null;
  slideshowRunning: boolean;
  message: string;
}

export interface NavResult {
  confirmedSlide: number;
  status: BindingStatus;
}

export interface PresentationInfo {
  documentId: string;
  name: string;
  path: string;
  slideCount: number;
  indexedAt: string;
  /** The file changed on disk after it was imported. */
  stale: boolean;
  sourceMissing: boolean;
  origin: "local" | "synced_cloud";
}

export interface PresentationImport {
  report: IngestReport;
  info: PresentationInfo;
}

export interface NotesBlock {
  id: string;
  documentId: string;
  ordinal: number;
  label: string;
  detectedSlide: number | null;
  assignedSlide: number | null;
  text: string;
  manual: boolean;
  status: "ok" | "unassigned" | "duplicate" | "out_of_range";
}

export interface NotesImportSummary {
  documentId: string;
  blocks: number;
  matched: number;
  unassigned: number;
  duplicates: number;
}

export interface NotesImportResult {
  report: IngestReport;
  summary: NotesImportSummary;
}
