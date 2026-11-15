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
let captureFails = false;

beforeAll(() => {
  mockWindows("launcher");
  mockIPC((cmd, args) => {
    calls.set(cmd, args as Record<string, unknown>);
    if (captureFails && (cmd === "start_capture" || cmd === "start_capture_per_party")) return Promise.reject("Audio device unavailable");
    return cmd === "start_meeting" ? JSON.stringify({ id: "meeting-1", title: "Standup" }) : [];
  });
});

beforeEach(() => {
  calls.clear();
  saved.config = {};
  captureFails = false;
});

afterEach(() => {
  const meetings = useMeetingStore.getState();
  meetings.stopTimer();
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher", isRecording: false, aiScenario: "team_meeting" });
  useScenarioStore.setState({ activeScenarioId: "team_meeting", customScenarios: [], scenarioOverrides: {} });
});

describe("startMeetingFlow's scenario", () => {
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
      expect(calls.get("plugin:event|emit")).toMatchObject({ payload: { aiScenario: "custom_1" } });
    });
  });

  it("runs as Team Meeting when its custom scenario was deleted", async () => {
    await useMeetingStore.getState().startMeetingFlow("Standup", "online", "custom_1");

    expect(calls.get("set_active_scenario")).toMatchObject({ systemPrompt: BUILT_IN_SCENARIOS[0].system_prompt });
    expect(calls.get("update_meeting_mode")).toMatchObject({ aiScenario: "team_meeting" });
    expect(useMeetingStore.getState().aiScenario).toBe("team_meeting");
  });
});
