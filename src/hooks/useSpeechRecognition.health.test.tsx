import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { emit, start, stop, instances } = vi.hoisted(() => ({
  emit: vi.fn().mockResolvedValue(undefined), start: vi.fn(), stop: vi.fn(), instances: [] as Array<Record<string, any>>,
}));
vi.mock("@tauri-apps/api/event", () => ({ emit }));
vi.mock("../lib/ipc", () => ({ pushTranscript: vi.fn().mockResolvedValue(undefined), ensureIpolicyOverride: vi.fn().mockResolvedValue({ active: false, was_drifted: false }) }));
import { useSpeechRecognition } from "./useSpeechRecognition";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";

describe("Web Speech health", () => {
  beforeEach(() => {
    instances.length = 0;
    vi.clearAllMocks();
    useLiveQAHealthStore.getState().reset();
    window.SpeechRecognition = class {
      constructor() { instances.push(this); }
      start = start;
      stop = stop;
    } as unknown as typeof window.SpeechRecognition;
    useMeetingStore.setState({ isRecording: true, listening: true, audioMode: "online", sttOverride: null });
    useConfigStore.setState({ mutedYou: false, mutedThem: false, meetingAudioConfig: {
      you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "groq_whisper" },
      them: { role: "Them", device_id: "default", is_input_device: true, stt_provider: "web_speech" },
      recording_enabled: false, preset_name: null,
    } });
  });
  it("does not capture while paused or when a different meeting engine is selected", () => {
    useMeetingStore.setState({ listening: false });
    const { rerender } = renderHook(() => useSpeechRecognition());
    expect(start).not.toHaveBeenCalled();
    act(() => useMeetingStore.setState({ listening: true, sttOverride: "groq_whisper" }));
    rerender();
    expect(start).not.toHaveBeenCalled();
  });
  it("reports Ready only on start and permission failure stops automatic retries", () => {
    renderHook(() => useSpeechRecognition());
    expect(emit).not.toHaveBeenCalledWith("stt_connection_status", expect.objectContaining({ status: "connected" }));
    act(() => instances[0].onstart());
    expect(emit).toHaveBeenCalledWith("stt_connection_status", expect.objectContaining({ party: "them", provider: "web_speech", status: "connected" }));
    act(() => instances[0].onerror({ error: "not-allowed" }));
    expect(emit).toHaveBeenCalledWith("stt_connection_status", expect.objectContaining({ status: "error" }));
    act(() => instances[0].onend());
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("does not retain local readiness when status synchronization fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    emit.mockRejectedValue(new Error("Synthetic event transport failure"));
    renderHook(() => useSpeechRecognition());
    act(() => instances[0].onstart());
    expect(useLiveQAHealthStore.getState().stt.them?.status).toBe("connected");
    await act(async () => instances[0].onerror({ error: "not-allowed" }));
    expect(useLiveQAHealthStore.getState().stt.them?.status).toBe("error");
    expect(warn).toHaveBeenCalled();
    emit.mockResolvedValue(undefined);
    warn.mockRestore();
  });
});
