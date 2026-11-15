import { beforeEach, describe, expect, it, vi } from "vitest";
import { readyProfile, profileIpcMock, resetProfileIpcMock } from "../test/profileFixtures";
import { getAvailableSTTProviders, listLocalSTTEngines } from "./ipc";
import { startProfileMeeting, transcriptionNotice } from "./startProfileMeeting";

const flow = vi.hoisted(() => ({
  start: vi.fn(),
  activate: vi.fn(),
}));
vi.mock("./profileIpc", async () => ({
  profileIpc: (await import("../test/profileFixtures")).profileIpcMock,
}));
vi.mock("./ipc", () => ({
  getAvailableSTTProviders: vi.fn(),
  listLocalSTTEngines: vi.fn(),
}));
vi.mock("../stores/configStore", () => ({
  useConfigStore: { getState: () => ({ activateLLMProvider: flow.activate }) },
}));
vi.mock("../stores/meetingStore", () => ({
  useMeetingStore: { getState: () => ({ startMeetingFlow: flow.start, activeMeeting: null }) },
}));

beforeEach(() => {
  resetProfileIpcMock();
  vi.clearAllMocks();
  vi.mocked(getAvailableSTTProviders).mockResolvedValue(["whisper_cpp"]);
  vi.mocked(listLocalSTTEngines).mockResolvedValue([
    { engine: "whisper_cpp", name: "Whisper", description: "", models: [] },
  ]);
});

describe("explicit meeting transcription", () => {
  it("checks downloaded models, not the catalog of compiled engines", async () => {
    const profile = readyProfile();
    profile.audio.transcriptionEngine = "whisper";
    const notice = await transcriptionNotice(profile);
    expect(notice).toMatch(/model/i);
    expect(notice).not.toMatch(/automatic engine will be used/i);
  });

  it("preserves the selected offline engine when its model is missing", async () => {
    const profile = readyProfile();
    profile.audio.transcriptionEngine = "whisper";
    vi.mocked(getAvailableSTTProviders).mockResolvedValue([]);
    profileIpcMock.get.mockResolvedValue(profile);
    await startProfileMeeting(profile.id);
    expect(flow.start).toHaveBeenCalledWith(
      profile.name, "online", undefined,
      expect.objectContaining({ deferCapture: true, sttProvider: "whisper_cpp" }),
    );
  });
});
