import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PartyAudioConfig } from "../lib/types";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  transcribe: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  testSTTTranscription: mocks.transcribe,
}));

import { STTTranscriptionTest } from "./STTTranscriptionTest";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";
import { useTranscriptStore } from "../stores/transcriptStore";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function updateThem(updates: Partial<PartyAudioConfig>) {
  const config = useConfigStore.getState().meetingAudioConfig!;
  useConfigStore.setState({ meetingAudioConfig: { ...config, them: { ...config.them, ...updates } } });
}

describe("approved-file transcription diagnostic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.open.mockReset().mockResolvedValue("C:\\approved\\synthetic.wav");
    mocks.transcribe.mockReset().mockResolvedValue("NEXQ_SYNTHETIC_TRANSCRIPTION_OK");
    mocks.invoke.mockReset().mockResolvedValue(null);
    useConfigStore.setState({
      sttProvider: "whisper_cpp",
      sttLanguage: "en-US",
      meetingAudioConfig: {
        you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "deepgram" },
        them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "whisper_cpp", local_model_id: "tiny.en" },
        recording_enabled: false,
        preset_name: null,
      },
    });
    useMeetingStore.setState({ listening: false });
    useLiveQAHealthStore.getState().reset();
    useTranscriptStore.getState().clearSegments();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("tests only an explicitly selected WAV and does not expose text or claim live readiness", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const)
      .map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const saved = useConfigStore.getState().meetingAudioConfig;
    const stt = useLiveQAHealthStore.getState().stt;
    render(<STTTranscriptionTest />);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(screen.getByText(/16-bit PCM WAV.*30 seconds/)).toBeInTheDocument();
    expect(screen.getByText(/tiny\.en/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test transcription" }));
    await waitFor(() => expect(mocks.transcribe).toHaveBeenCalledWith("C:\\approved\\synthetic.wav", "Them"));
    expect(mocks.open).toHaveBeenCalledWith({
      title: "Select approved PCM WAV (up to 30 seconds)",
      directory: false,
      multiple: false,
      filters: [{ name: "PCM WAV audio", extensions: ["wav"] }],
    });
    expect(await screen.findByRole("status", { name: "Transcription file result" }))
      .toHaveTextContent("File transcription passed. Live capture was not tested.");
    expect(document.body).not.toHaveTextContent("NEXQ_SYNTHETIC_TRANSCRIPTION_OK");
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(useConfigStore.getState().meetingAudioConfig).toBe(saved);
    expect(useLiveQAHealthStore.getState().stt).toBe(stt);
    expect(useTranscriptStore.getState().segments).toEqual([]);
    // The test wrapper is mocked separately: no capture, settings or cloud IPC.
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    "web_speech", "windows_native", "sherpa_onnx", "ort_streaming", "parakeet_tdt",
    "deepgram", "whisper_api", "azure_speech", "groq_whisper", "cartesia",
  ] as const)("explicitly rejects %s even when the global provider is Whisper.cpp", (provider) => {
    updateThem({ stt_provider: provider });
    render(<STTTranscriptionTest />);
    expect(screen.getByText(/Unsupported.*Whisper\.cpp only/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Test transcription" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("allows the explicitly chosen You channel without changing either provider", async () => {
    const config = useConfigStore.getState().meetingAudioConfig!;
    useConfigStore.setState({ meetingAudioConfig: {
      ...config,
      you: { ...config.you, stt_provider: "whisper_cpp", local_model_id: "base.en" },
      them: { ...config.them, stt_provider: "deepgram" },
    } });
    const saved = useConfigStore.getState().meetingAudioConfig;
    render(<STTTranscriptionTest />);
    fireEvent.change(screen.getByRole("combobox", { name: "Transcription test channel" }), { target: { value: "You" } });
    fireEvent.click(screen.getByRole("button", { name: "Test transcription" }));
    await waitFor(() => expect(mocks.transcribe).toHaveBeenCalledWith("C:\\approved\\synthetic.wav", "You"));
    expect(useConfigStore.getState().meetingAudioConfig).toBe(saved);
  });

  it("requires an existing per-channel configuration", () => {
    useConfigStore.setState({ meetingAudioConfig: null });
    render(<STTTranscriptionTest />);
    expect(screen.getByRole("button", { name: "Test transcription" })).toBeDisabled();
    expect(screen.getByText(/Unsupported.*Whisper\.cpp only/)).toBeInTheDocument();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it.each(["aggregate", "you", "them"] as const)("blocks testing while %s capture is active without pausing it", (source) => {
    if (source === "aggregate") useMeetingStore.setState({ listening: true });
    else useLiveQAHealthStore.getState().observeAudioStatus(source, { status: "active" });
    render(<STTTranscriptionTest />);
    expect(screen.getByText(/Pause listening before testing/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Test transcription" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does nothing when file selection is cancelled", async () => {
    mocks.open.mockResolvedValue(null);
    render(<STTTranscriptionTest />);
    fireEvent.click(screen.getByRole("button", { name: "Test transcription" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Test transcription" })).toBeEnabled());
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Transcription file result")).toBeNull();
  });

  it("keeps a pending test single-flight and shows testing rather than readiness", async () => {
    const result = deferred<string>();
    mocks.transcribe.mockReturnValue(result.promise);
    render(<STTTranscriptionTest />);
    fireEvent.click(screen.getByRole("button", { name: "Test transcription" }));
    await waitFor(() => expect(mocks.transcribe).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Testing transcription…" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Transcription test channel" })).toBeDisabled();
    expect(screen.queryByLabelText("Transcription file result")).toBeNull();
    await act(async () => { result.resolve("Synthetic speech"); });
    expect(screen.getByRole("button", { name: "Test transcription" })).toBeEnabled();
  });

  it.each(["capture", "provider"] as const)("does not send the file when %s changes during selection", async (change) => {
    const picker = deferred<string | null>();
    mocks.open.mockReturnValue(picker.promise);
    render(<STTTranscriptionTest />);
    fireEvent.click(screen.getByRole("button", { name: "Test transcription" }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalled());
    act(() => {
      if (change === "capture") useLiveQAHealthStore.getState().observeAudioStatus("you", { status: "active" });
      else updateThem({ stt_provider: "deepgram" });
    });
    await act(async () => { picker.resolve("C:\\approved\\synthetic.wav"); });
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Transcription file result")).toBeNull();
  });

  it.each(["model", "language"] as const)("does not show an old result after the selected %s changes", async (change) => {
    const result = deferred<string>();
    mocks.transcribe.mockReturnValue(result.promise);
    render(<STTTranscriptionTest />);
    fireEvent.click(screen.getByRole("button", { name: "Test transcription" }));
    await waitFor(() => expect(mocks.transcribe).toHaveBeenCalled());
    act(() => {
      if (change === "model") updateThem({ local_model_id: "base" });
      else useConfigStore.setState({ sttLanguage: "vi-VN" });
    });
    await act(async () => { result.resolve("Synthetic speech"); });
    expect(screen.queryByLabelText("Transcription file result")).toBeNull();
    expect(screen.getByRole("button", { name: "Test transcription" })).toBeEnabled();
  });

  it("does not send a selected file after the settings action unmounts", async () => {
    const picker = deferred<string | null>();
    mocks.open.mockReturnValue(picker.promise);
    const view = render(<STTTranscriptionTest />);
    fireEvent.click(screen.getByRole("button", { name: "Test transcription" }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalled());
    view.unmount();
    await act(async () => { picker.resolve("C:\\approved\\synthetic.wav"); });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("does not report success for an empty transcript", async () => {
    mocks.transcribe.mockResolvedValue(" \n ");
    render(<STTTranscriptionTest />);
    fireEvent.click(screen.getByRole("button", { name: "Test transcription" }));
    expect(await screen.findByRole("alert", { name: "Transcription file result" }))
      .toHaveTextContent("No transcription returned");
    expect(screen.queryByText(/File transcription passed/)).toBeNull();
  });

  it("does not display or log raw transcription failures", async () => {
    const raw = '{"path":"private-example.wav","transcript":"PRIVATE_SYNTHETIC_MARKER"}';
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.transcribe.mockRejectedValue(raw);
    render(<STTTranscriptionTest />);
    fireEvent.click(screen.getByRole("button", { name: "Test transcription" }));
    expect(await screen.findByRole("alert", { name: "Transcription file result" }))
      .toHaveTextContent("Test failed. Check the selected Whisper.cpp model");
    expect(document.body).not.toHaveTextContent("PRIVATE_SYNTHETIC_MARKER");
    expect(document.body).not.toHaveTextContent("private-example.wav");
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();
  });

  it("reports picker failure safely without attempting transcription", async () => {
    mocks.open.mockRejectedValue("private picker error");
    render(<STTTranscriptionTest />);
    fireEvent.click(screen.getByRole("button", { name: "Test transcription" }));
    expect(await screen.findByRole("alert", { name: "Transcription file result" }))
      .toHaveTextContent("Could not open the file picker");
    expect(document.body).not.toHaveTextContent("private picker error");
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});
