import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingAudioConfig } from "../lib/types";
const { startCapturePerParty, stopCapture, emit } = vi.hoisted(() => ({
  startCapturePerParty: vi.fn().mockResolvedValue(undefined),
  stopCapture: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/ipc", () => ({ startCapturePerParty, stopCapture }));
vi.mock("@tauri-apps/api/event", () => ({ emit }));
import { useAudioConfigSync } from "./useAudioConfigSync";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";
const config: MeetingAudioConfig = {
  you: { role: "You", device_id: "mic", is_input_device: true, stt_provider: "web_speech" },
  them: { role: "Them", device_id: "system", is_input_device: false, stt_provider: "deepgram" },
  recording_enabled: false, preset_name: null,
};
describe("audio restart health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    startCapturePerParty.mockReset().mockResolvedValue(undefined);
    stopCapture.mockClear();
    emit.mockClear();
    useLiveQAHealthStore.getState().reset();
    useMeetingStore.setState({ isRecording: true, listening: true, audioMode: "online", activeMeeting: { id: "live" } as never });
    useConfigStore.setState({ meetingAudioConfig: config });
  });
  afterEach(() => vi.useRealTimers());
  it("does not hot-swap or start capture while listening is paused", async () => {
    renderHook(() => useAudioConfigSync());
    act(() => useMeetingStore.setState({ listening: false }));
    act(() => useConfigStore.setState({ meetingAudioConfig: { ...config, preset_name: "changed" } }));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(startCapturePerParty).not.toHaveBeenCalled();
  });
  it("surfaces a failed restart and clears stale capture success", async () => {
    renderHook(() => useAudioConfigSync());
    startCapturePerParty.mockRejectedValueOnce("Audio device not found: secret");
    act(() => useConfigStore.setState({ meetingAudioConfig: { ...config, preset_name: "changed" } }));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(useMeetingStore.getState().listening).toBe(false);
    expect(useLiveQAHealthStore.getState().audio.them?.error).toBe("Audio device unavailable. Choose an available audio device.");
    expect(emit).toHaveBeenCalledWith("capture_warning", "Audio device unavailable. Choose an available audio device.");
  });
});
