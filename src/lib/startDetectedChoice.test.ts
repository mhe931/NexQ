import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./profileIpc", async () => ({ profileIpc: (await import("../test/profileFixtures")).profileIpcMock }));
const startProfileMeeting = vi.hoisted(() => vi.fn());
vi.mock("./startProfileMeeting", () => ({ startProfileMeeting }));
const showLauncherWindow = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./windows", () => ({ showLauncherWindow }));
const showToast = vi.hoisted(() => vi.fn());
vi.mock("../stores/toastStore", () => ({ showToast }));

import { startDetectedChoice } from "./startDetectedChoice";
import { useMeetingStore } from "../stores/meetingStore";
import { useProfileStore } from "../stores/profileStore";
import { makeProfile, profileIpcMock as ipc, resetProfileIpcMock } from "../test/profileFixtures";
import type { ProfileSummary } from "./profileTypes";

const summary = (id: string, name: string, meetingType: ProfileSummary["meetingType"]): ProfileSummary => ({
  id, name, meetingType, platform: "zoom", meetingDate: null, primaryProvider: null, primaryModel: null,
  documentCount: 0, sessionCount: 0, updatedAt: "2026-01-01T00:00:00Z", lastUsedAt: null, presentationName: null,
});

beforeEach(() => {
  resetProfileIpcMock();
  startProfileMeeting.mockReset();
  showLauncherWindow.mockClear();
  showToast.mockClear();
  useMeetingStore.setState({ activeMeeting: null });
  useProfileStore.setState({ summaries: [], setupRequest: null, error: null });
});

describe("startDetectedChoice", () => {
  it("starts the chosen saved meeting through the normal profile start", async () => {
    startProfileMeeting.mockResolvedValue({ notice: null });
    expect(await startDetectedChoice({ kind: "profile", profileId: "p1" })).toBe("started");
    expect(startProfileMeeting).toHaveBeenCalledWith("p1");
    expect(useProfileStore.getState().setupRequest).toBeNull();
  });

  it("a meeting that cannot start yet opens its setup with the reason instead of failing silently", async () => {
    startProfileMeeting.mockRejectedValue(new Error("Choose an AI provider and model in Advanced settings."));
    expect(await startDetectedChoice({ kind: "profile", profileId: "p1" })).toBe("setup");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Choose an AI provider"), "error");
    expect(useProfileStore.getState().setupRequest).toBe("p1");
    expect(showLauncherWindow).toHaveBeenCalled();
  });

  it("never starts a second meeting while one is running or a start is already in flight", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    expect(await startDetectedChoice({ kind: "profile", profileId: "p1" })).toBe("ignored");
    useMeetingStore.setState({ activeMeeting: null });
    let release: (v: { notice: null }) => void = () => {};
    startProfileMeeting.mockReturnValue(new Promise((r) => { release = r; }));
    const first = startDetectedChoice({ kind: "profile", profileId: "p1" });
    expect(await startDetectedChoice({ kind: "profile", profileId: "p1" })).toBe("ignored");
    release({ notice: null });
    expect(await first).toBe("started");
    expect(startProfileMeeting).toHaveBeenCalledTimes(1);
  });

  it("a new Presentation + Q&A is created once, named after the call, and its setup opens; it does not start", async () => {
    ipc.list.mockResolvedValue([]);
    ipc.create.mockResolvedValue(makeProfile({ id: "new1", name: "Defence", platform: "other" }));
    ipc.save.mockImplementation(async (p: unknown) => p);
    expect(await startDetectedChoice({ kind: "new_presentation_qa", name: "Defence", platform: "meet" })).toBe("setup");
    expect(ipc.create).toHaveBeenCalledWith("Defence", "academic_qa");
    expect(ipc.save).toHaveBeenCalledWith(expect.objectContaining({ id: "new1", platform: "meet" }));
    expect(useProfileStore.getState().setupRequest).toBe("new1");
    expect(startProfileMeeting).not.toHaveBeenCalled();
  });

  it("reuses an existing Presentation + Q&A of the same name instead of creating a duplicate", async () => {
    ipc.list.mockResolvedValue([summary("old", "Defence", "presentation_qa")]);
    expect(await startDetectedChoice({ kind: "new_presentation_qa", name: "defence", platform: "meet" })).toBe("setup");
    expect(ipc.create).not.toHaveBeenCalled();
    expect(useProfileStore.getState().setupRequest).toBe("old");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("existing"), "info");
  });
});
