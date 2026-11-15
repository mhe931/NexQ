import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, register } = vi.hoisted(() => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const register = (name: string) => (handler: (event: unknown) => void) => {
    handlers[name] = handler;
    return Promise.resolve(() => { delete handlers[name]; });
  };
  return { handlers, register };
});
vi.mock("../lib/events", () => ({
  onSTTConnectionStatus: register("stt"),
  onAudioCaptureStatus: register("capture"),
  onAudioLevel: register("level"),
  onCaptureWarning: register("warning"),
  onTranscriptUpdate: register("update"),
  onTranscriptFinal: register("final"),
}));
vi.mock("../lib/ipc", () => ({ hasApiKey: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: register("listening") }));

import { useSTTStatus } from "./useSTTStatus";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";

describe("independent capture event subscription", () => {
  beforeEach(() => {
    useLiveQAHealthStore.getState().reset();
    useMeetingStore.setState({ activeMeeting: null, listening: false, sttOverride: null });
    useConfigStore.setState({ meetingAudioConfig: {
      you: { role: "You", device_id: "mic", is_input_device: true, stt_provider: "web_speech" },
      them: { role: "Them", device_id: "system", is_input_device: false, stt_provider: "deepgram" },
      recording_enabled: false, preset_name: null,
    } });
  });

  it("captures startup events before a meeting exists, without claiming STT readiness or keeping raw details", () => {
    renderHook(() => useSTTStatus());
    act(() => {
      handlers.capture({ party: "You", status: "active", message: "Private device name" });
      handlers.capture({ party: "Them", status: "permission_denied", message: '{"private":"details"}' });
      handlers.level({ source: "System", level: 0.5 });
      handlers.warning("Generic capture warning");
    });
    expect(useLiveQAHealthStore.getState().audio).toEqual({
      you: { status: "active" }, them: { status: "permission_denied" },
    });
    expect(useLiveQAHealthStore.getState().stt).toEqual({ you: null, them: null });
  });

  it("does not let an STT credential error change physical capture", () => {
    renderHook(() => useSTTStatus());
    act(() => {
      handlers.capture({ party: "Them", status: "active" });
      handlers.stt({ party: "them", provider: "deepgram", status: "error", message: "Missing API key" });
    });
    expect(useLiveQAHealthStore.getState().audio.them).toEqual({ status: "active" });
    expect(useLiveQAHealthStore.getState().stt.them?.status).toBe("error");
  });

  it("ignores a late callback after the health subscription unmounts", () => {
    const { unmount } = renderHook(() => useSTTStatus());
    const capture = handlers.capture;
    unmount();
    act(() => capture({ party: "Them", status: "failed" }));
    expect(useLiveQAHealthStore.getState().audio.them).toBeNull();
  });
});
