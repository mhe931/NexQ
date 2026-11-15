import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** config.json, which other windows may have written since this one read it. */
const saved = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.config[key],
    set: async () => {},
  }),
}));

import { BUILT_IN_SCENARIOS } from "../lib/scenarios";
import { useMeetingStore } from "./meetingStore";
import { useConfigStore } from "./configStore";
import { useScenarioStore } from "./scenarioStore";
import { runUserAction } from "../lib/userAction";

const boardReview = {
  id: "custom_1",
  name: "Board review",
  description: "Custom scenario",
  system_prompt: "Board system prompt",
  summary_prompt: "Board summary prompt",
  question_detection_prompt: "Board question prompt",
  is_custom: true,
};

const calls = new Map<string, Record<string, unknown>>();
const eventCalls: Record<string, unknown>[] = [];
let captureSelection: { override: string | null; published: boolean } | null = null;
let captureFails = false;
let recordingFails = false;

beforeAll(() => {
  mockWindows("launcher");
  mockIPC((cmd, args) => {
    calls.set(cmd, args as Record<string, unknown>);
    if (recordingFails && cmd === "set_recording_enabled") return Promise.reject("Recording preferences could not be applied");
    if (cmd === "plugin:event|emit") eventCalls.push(args as Record<string, unknown>);
    if (cmd === "start_capture" || cmd === "start_capture_per_party") {
      captureSelection = {
        override: useMeetingStore.getState().sttOverride,
        published: eventCalls.some((event) => event.event === "nexq:meeting_started"),
      };
    }
    if (captureFails && (cmd === "start_capture" || cmd === "start_capture_per_party")) return Promise.reject("Audio device unavailable");
    return cmd === "start_meeting" ? JSON.stringify({ id: "meeting-1", title: "Standup" }) : [];
  });
});

beforeEach(() => {
  calls.clear();
  eventCalls.length = 0;
  captureSelection = null;
  saved.config = {};
  captureFails = false;
  recordingFails = false;
  useConfigStore.setState({ meetingAudioConfig: null, recordingEnabled: false });
});

afterEach(() => {
  const meetings = useMeetingStore.getState();
  meetings.stopTimer();
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher", isRecording: false, aiScenario: "team_meeting" });
  useScenarioStore.setState({ activeScenarioId: "team_meeting", customScenarios: [], scenarioOverrides: {} });
});

describe("startMeetingFlow's scenario", () => {
  it("blocks a profile's resumed capture when recording policy cannot be applied, without blocking typed questions", async () => {
    useConfigStore.setState({ recordingEnabled: true });
    await useMeetingStore.getState().startMeetingFlow("Rehearsal", "online", "team_meeting", {
      profileId: "profile", deferCapture: true,
    });
    recordingFails = true;
    await useMeetingStore.getState().startListening();
    expect(useMeetingStore.getState().listening).toBe(false);
    expect(calls.has("start_capture")).toBe(false);
    expect(calls.has("start_capture_per_party")).toBe(false);
    await runUserAction("AskQuestion", "Public connectivity question");
    expect(calls.has("generate_assist")).toBe(true);
  });

  it("synchronizes the profile STT selection in both windows before native capture starts", async () => {
    useConfigStore.setState({ meetingAudioConfig: {
      you: { role: "You", device_id: "mic", is_input_device: true, stt_provider: "web_speech" },
      them: { role: "Them", device_id: "system", is_input_device: false, stt_provider: "deepgram" },
      recording_enabled: false, preset_name: null,
    } });
    await useMeetingStore.getState().startMeetingFlow("Rehearsal", "online", "team_meeting", {
      profileId: "profile", sttProvider: "whisper_cpp",
    });
    expect(captureSelection).toEqual({ override: "whisper_cpp", published: true });
    expect(eventCalls.find((event) => event.event === "nexq:meeting_started")).toMatchObject({
      payload: { sttOverride: "whisper_cpp", listening: false },
    });
    expect(useMeetingStore.getState().listening).toBe(true);
  });
  it("retains typed Q&A after a deferred profile's later capture failure", async () => {
    captureFails = true;
    await useMeetingStore.getState().startMeetingFlow("Typed Q&A", "online", "team_meeting", { profileId: "profile", deferCapture: true });
    expect(calls.has("start_capture")).toBe(false);
    expect(calls.has("start_capture_per_party")).toBe(false);
    expect(useMeetingStore.getState()).toMatchObject({ profileId: "profile", listening: false, activeMeeting: { id: "meeting-1" } });
    await useMeetingStore.getState().startListening();
    expect(useMeetingStore.getState()).toMatchObject({ listening: false, activeMeeting: { id: "meeting-1" } });
    await runUserAction("AskQuestion", "What is the next step?");
    expect(calls.has("generate_assist")).toBe(true);
  });
  it("uses a custom scenario's prompts, even one saved by another window", async () => {
    saved.config.customScenarios = [boardReview];
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "custom_1");

    expect(calls.get("set_active_scenario")).toEqual({
      systemPrompt: "Board system prompt",
      summaryPrompt: "Board summary prompt",
      questionDetectionPrompt: "Board question prompt",
    });
    expect(calls.get("update_meeting_mode")).toMatchObject({ aiScenario: "custom_1" });
    await vi.waitFor(() => {
      expect(eventCalls.find((event) => event.event === "nexq:meeting_started")).toMatchObject({ payload: { aiScenario: "custom_1" } });
    });
  });

  it("runs as Team Meeting when its custom scenario was deleted", async () => {
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "custom_1");

    expect(calls.get("set_active_scenario")).toMatchObject({ systemPrompt: BUILT_IN_SCENARIOS[0].system_prompt });
    expect(calls.get("update_meeting_mode")).toMatchObject({ aiScenario: "team_meeting" });
    expect(useMeetingStore.getState().aiScenario).toBe("team_meeting");
  });
});
