import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveQAStatus } from "./LiveQAStatus";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { useStreamStore } from "../stores/streamStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useQuestionStore } from "../stores/questionStore";
import { usePresenterStore } from "../stores/presenterStore";
import { makeProfile } from "../test/profileFixtures";
import type { Meeting } from "../lib/types";
import { runYourAction } from "../lib/autoAnswer";
vi.mock("../lib/autoAnswer", () => ({ runYourAction: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/ipc", () => ({ clearProviderCreditFailure: vi.fn().mockResolvedValue(undefined) }));

const MEETING: Meeting = {
  id: "meeting", title: "Synthetic Q&A", start_time: "2026-11-15T10:00:00Z",
  end_time: null, duration_seconds: null, transcript: [], ai_interactions: [],
  summary: null, config_snapshot: null,
};

describe("live Q&A status and recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLiveQAHealthStore.getState().reset();
    useStreamStore.getState().resetForMeeting();
    useTranscriptStore.getState().clearSegments();
    useQuestionStore.getState().clear();
    useMeetingStore.setState({ activeMeeting: MEETING, listening: true, audioMode: "online", sttOverride: null, profileId: "profile", openSettings: vi.fn(), pauseListening: vi.fn().mockResolvedValue(undefined), startListening: vi.fn().mockResolvedValue(undefined) });
    usePresenterStore.setState({ profile: makeProfile({ id: "profile", audio: { ...makeProfile().audio, listeningConsentConfirmed: true } }) });
    useConfigStore.setState({ mutedYou: false, mutedThem: false, meetingAudioConfig: {
      you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "web_speech" },
      them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram" },
      recording_enabled: false, preset_name: null,
    } });
  });

  it("shows failed Them STT independently from active audio, without raw errors", () => {
    useLiveQAHealthStore.getState().observeAudio("them", Date.now());
    useLiveQAHealthStore.getState().observeSTT("them", { provider: "deepgram", status: "error", message: "401 Unauthorized secret" });
    render(<LiveQAStatus />);
    expect(screen.getByLabelText("Them audio")).toHaveTextContent("Active");
    expect(screen.getByLabelText("Them STT")).toHaveTextContent("Missing credentials");
    expect(screen.queryByText(/secret/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Configure STT" }));
    expect(useMeetingStore.getState().openSettings).toHaveBeenCalledWith("stt");
  });

  it("opens provider settings without activating a provider or bypassing meeting routing", () => {
    useStreamStore.getState().setError("429 too many requests secret");
    render(<LiveQAStatus />);
    expect(screen.getByLabelText("AI health")).toHaveTextContent("Rate limited");
    expect(screen.getByLabelText("Question handling")).toHaveTextContent("Unable to answer");
    fireEvent.click(screen.getByRole("button", { name: "Configure AI provider" }));
    expect(useMeetingStore.getState().openSettings).toHaveBeenCalledWith("llm");
  });

  it("never announces generation while context is being retrieved", () => {
    render(<LiveQAStatus />);
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "typed");
      useStreamStore.getState().setHandlingStatus("retrieving_context");
    });
    expect(screen.getByLabelText("Question handling")).toHaveTextContent("Retrieving context");
    expect(screen.getByLabelText("Question handling")).not.toHaveTextContent("Generating");
  });

  it("does not reuse another provider's success or failure after an explicit change", () => {
    useConfigStore.setState({ llmProvider: "openai" });
    useStreamStore.getState().setPending("AskQuestion", "typed", "openai");
    useStreamStore.getState().setError("401 invalid API key");
    render(<LiveQAStatus />);
    expect(screen.getByLabelText("AI health")).toHaveTextContent("Authentication required");
    act(() => useConfigStore.setState({ llmProvider: "groq" }));
    expect(screen.getByLabelText("AI health")).toHaveTextContent("Not checked");
    expect(screen.getByLabelText("AI health")).not.toHaveTextContent("Ready");
  });

  it("retries the exact typed question only after an explicit click", async () => {
    useStreamStore.getState().setPending("AskQuestion", "typed", undefined, "Why?");
    useStreamStore.getState().setError("429 rate limit");
    render(<LiveQAStatus />);
    expect(runYourAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry answer" }));
    await waitFor(() => expect(runYourAction).toHaveBeenCalledWith("AskQuestion", "Why?"));
  });

  it("routes a non-retryable error to configuration instead of offering repeated attempts", () => {
    useStreamStore.getState().setPending("AskQuestion", "typed", undefined, "Why?");
    useStreamStore.getState().setError("private body", { code: "invalid_api_key", retryable: false });
    render(<LiveQAStatus />);
    expect(screen.queryByRole("button", { name: "Retry answer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Configure AI provider" })).toBeEnabled();
  });

  it("shows physical capture independently, including active-but-STT-muted You and failed Them", () => {
    useConfigStore.setState({ mutedYou: true });
    useLiveQAHealthStore.getState().observeAudioStatus("you", { status: "active" });
    useLiveQAHealthStore.getState().observeAudioStatus("them", { status: "device_unavailable" });
    useLiveQAHealthStore.getState().observeSTT("them", { provider: "deepgram", status: "connected" });
    render(<LiveQAStatus />);
    expect(screen.getByLabelText("You audio")).toHaveTextContent("Active");
    expect(screen.getByLabelText("You STT")).toHaveTextContent("Paused");
    expect(screen.getByLabelText("Them audio")).toHaveTextContent("Device unavailable");
    expect(screen.getByLabelText("Them STT")).toHaveTextContent("Ready");
    fireEvent.click(screen.getByRole("button", { name: "Audio devices" }));
    expect(useMeetingStore.getState().openSettings).toHaveBeenCalledWith("meeting_audio");
  });

  it("does not hide physical You capture in room mode", () => {
    useMeetingStore.setState({ audioMode: "in_person" });
    useLiveQAHealthStore.getState().observeAudioStatus("you", { status: "active" });
    useLiveQAHealthStore.getState().observeAudioStatus("them", { status: "paused" });
    render(<LiveQAStatus />);
    expect(screen.getByLabelText("You audio")).toHaveTextContent("Active");
    expect(screen.getByLabelText("Room audio")).toHaveTextContent("Paused");
  });

  it("cannot capture from an unconsented deferred profile's preflight STT recovery", () => {
    const profile = makeProfile({ id: "profile" });
    usePresenterStore.setState({ profile });
    useMeetingStore.setState({ listening: false });
    useLiveQAHealthStore.getState().observeSTT("them", { provider: "deepgram", status: "error", message: "Missing API key" });
    render(<LiveQAStatus />);
    const retry = screen.getByRole("button", { name: "Retry audio / STT" });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAccessibleDescription(/Listening consent required/);
    fireEvent.click(retry);
    expect(useMeetingStore.getState().pauseListening).not.toHaveBeenCalled();
    expect(useMeetingStore.getState().startListening).not.toHaveBeenCalled();
    expect(usePresenterStore.getState().profile).toBe(profile);
    expect(profile.audio.listeningConsentConfirmed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Configure STT" }));
    expect(useMeetingStore.getState().openSettings).toHaveBeenCalledWith("stt");
    expect(screen.getByText(/You can still type a question with Ask/)).toBeInTheDocument();
  });

  it.each([null, makeProfile({ id: "other-profile", audio: { ...makeProfile().audio, listeningConsentConfirmed: true } })])(
    "fails closed when consent belongs to a missing or different profile",
    (profile) => {
      usePresenterStore.setState({ profile });
      useLiveQAHealthStore.getState().observeSTT("them", { provider: "deepgram", status: "error" });
      render(<LiveQAStatus />);
      const retry = screen.getByRole("button", { name: "Retry audio / STT" });
      expect(retry).toBeDisabled();
      fireEvent.click(retry);
      expect(useMeetingStore.getState().startListening).not.toHaveBeenCalled();
    },
  );

  it("preserves explicit retry for the active consenting profile", async () => {
    useLiveQAHealthStore.getState().observeSTT("them", { provider: "deepgram", status: "error" });
    render(<LiveQAStatus />);
    const retry = screen.getByRole("button", { name: "Retry audio / STT" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(useMeetingStore.getState().startListening).toHaveBeenCalledTimes(1));
    expect(useMeetingStore.getState().pauseListening).toHaveBeenCalledTimes(1);
  });

  it("rechecks consent after awaiting pause, before capture can restart", async () => {
    let paused: () => void = () => {};
    useMeetingStore.setState({ pauseListening: vi.fn(() => new Promise<void>((resolve) => { paused = resolve; })) });
    useLiveQAHealthStore.getState().observeSTT("them", { provider: "deepgram", status: "error" });
    render(<LiveQAStatus />);
    fireEvent.click(screen.getByRole("button", { name: "Retry audio / STT" }));
    act(() => usePresenterStore.setState({ profile: makeProfile({ id: "profile" }) }));
    await act(async () => { paused(); });
    expect(useMeetingStore.getState().startListening).not.toHaveBeenCalled();
  });

  it("does not restart another session after awaiting pause", async () => {
    let paused: () => void = () => {};
    useMeetingStore.setState({ pauseListening: vi.fn(() => new Promise<void>((resolve) => { paused = resolve; })) });
    useLiveQAHealthStore.getState().observeSTT("them", { provider: "deepgram", status: "error" });
    render(<LiveQAStatus />);
    fireEvent.click(screen.getByRole("button", { name: "Retry audio / STT" }));
    act(() => useMeetingStore.setState({ activeMeeting: { ...MEETING, id: "different-session" } }));
    await act(async () => { paused(); });
    expect(useMeetingStore.getState().startListening).not.toHaveBeenCalled();
  });

  it("preserves the classic meeting's explicit retry without a profile gate", async () => {
    useMeetingStore.setState({ profileId: null });
    usePresenterStore.setState({ profile: null });
    useLiveQAHealthStore.getState().observeSTT("them", { provider: "deepgram", status: "error" });
    render(<LiveQAStatus />);
    fireEvent.click(screen.getByRole("button", { name: "Retry audio / STT" }));
    await waitFor(() => expect(useMeetingStore.getState().startListening).toHaveBeenCalledTimes(1));
  });

  it("names the actual fallback provider without making the exhausted primary ready", () => {
    useConfigStore.setState({ llmProvider: "openai", llmModel: "gpt-4o" });
    useLiveQAHealthStore.getState().markAIReady("openai", "gpt-4o");
    useStreamStore.getState().setPending("AskQuestion", "typed", "openai", "Why?", "gpt-4o");
    useStreamStore.getState().startStream("AskQuestion", "gpt-4o", "openai", { requestId: "typed" });
    useStreamStore.getState().applyProfileFallback({
      request_id: "typed", from_provider: "openai", from_model: "gpt-4o",
      to_provider: "groq", to_model: "llama", reason: "credits_exhausted",
    });
    render(<LiveQAStatus />);
    expect(screen.getByLabelText("AI health")).toHaveTextContent("Answering via groq");
    act(() => {
      useStreamStore.getState().appendToken("Answer");
      useStreamStore.getState().endStream(10);
    });
    expect(screen.getByLabelText("AI health")).toHaveTextContent("Ready via groq");
    expect(useStreamStore.getState().requestProvider).toBe("openai");
    expect(useConfigStore.getState().llmProvider).toBe("openai");
    act(() => useConfigStore.setState({ llmProvider: "ollama", llmModel: "local" }));
    expect(screen.getByLabelText("AI health")).toHaveTextContent("Not checked");
    expect(screen.getByLabelText("AI health")).not.toHaveTextContent("Ready");
  });

  it.each([false, true])("does not blame AI for failed context retrieval (AI proof: %s)", (verified) => {
    useConfigStore.setState({ llmProvider: "openai", llmModel: "gpt-4o" });
    if (verified) useLiveQAHealthStore.getState().markAIReady("openai", "gpt-4o");
    useStreamStore.getState().setPending("AskQuestion", "docs", "openai", "Why?", "gpt-4o");
    useStreamStore.getState().setHandlingStatus("retrieving_context");
    useStreamStore.getState().setError("Meeting document retrieval failed. Refresh this meeting's sources before asking again.");
    render(<LiveQAStatus />);
    expect(screen.getByLabelText("Question handling")).toHaveTextContent("Unable to answer");
    expect(screen.getByLabelText("AI health")).toHaveTextContent(verified ? "Ready" : "Not checked");
    expect(screen.getByLabelText("AI health")).not.toHaveTextContent("Failed");
    expect(screen.queryByRole("button", { name: "Configure AI provider" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry answer" })).toBeNull();
  });
});
