import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSTTEngineInfo, MeetingAudioConfig } from "../lib/types";
import type * as IPC from "../lib/ipc";

const { listLocalSTTEngines } = vi.hoisted(() => ({
  listLocalSTTEngines: vi.fn<() => Promise<LocalSTTEngineInfo[]>>(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IPC>()),
  listAudioDevices: async () => ({
    inputs: [{ id: 'Studio: USB "Audio"', name: 'Studio: USB "Audio"', is_input: true, is_default: false }],
    outputs: [{ id: 'Studio: USB "Audio"', name: 'Studio: USB "Audio"', is_input: false, is_default: false }],
  }),
  getAudioSessions: async () => [],
  hasApiKey: async () => false,
  listLocalSTTEngines,
  startDeviceMonitor: async () => {},
  stopDeviceMonitor: async () => {},
  stopAudioTest: async () => false,
}));

import { MeetingAudioSettings } from "./MeetingAudioSettings";
import { STTSettings } from "./STTSettings";
import { AudioSetupStep } from "../components/wizard/AudioSetupStep";
import { useConfigStore } from "../stores/configStore";

const initialConfig: MeetingAudioConfig = {
  you: { role: "You", device_id: 'Studio: USB "Audio"', is_input_device: true, stt_provider: "deepgram" },
  them: { role: "Them", device_id: 'Studio: USB "Audio"', is_input_device: true, stt_provider: "deepgram" },
  recording_enabled: false,
  preset_name: null,
};

const installedWhisper: LocalSTTEngineInfo[] = [{
  engine: "whisper_cpp", name: "Whisper.cpp", description: "Local speech recognition",
  models: [{
    id: "tiny", engine: "whisper_cpp", name: "Whisper Tiny",
    size_bytes: 77691713, accuracy_rating: 2, speed_rating: 5,
    is_streaming: false, is_downloaded: true,
  }],
}];

beforeEach(() => {
  listLocalSTTEngines.mockReset().mockResolvedValue([]);
  useConfigStore.setState({
    meetingAudioConfig: initialConfig, activeWhisperModel: null,
    activeModelPerEngine: {}, verifiedCloudProviders: [],
  });
});
afterEach(cleanup);

it("allows Vietnamese to be selected in Audio & Devices", async () => {
  useConfigStore.setState({ sttLanguage: "en-US" });
  render(<MeetingAudioSettings />);
  const select = screen.getByRole("combobox", { name: /STT Language/i });
  await userEvent.setup().selectOptions(select, "vi-VN");
  expect(useConfigStore.getState().sttLanguage).toBe("vi-VN");
  expect(within(select).getByRole<HTMLOptionElement>("option", { name: "Vietnamese" }).selected).toBe(true);
});

it("allows the Them channel to select its installed local Whisper model", async () => {
  listLocalSTTEngines.mockResolvedValue(installedWhisper);
  render(<MeetingAudioSettings />);
  await act(async () => {});
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: "Deepgram" })[1]);
  await user.click(screen.getByRole("button", { name: "Whisper.cpp" }));
  expect(useConfigStore.getState().meetingAudioConfig?.them).toMatchObject({
    stt_provider: "whisper_cpp", local_model_id: "tiny",
  });
  expect(useConfigStore.getState().meetingAudioConfig?.you.stt_provider).toBe("deepgram");
});

it("does not change the selected STT provider when availability resolves again", async () => {
  let resolveLater!: (engines: LocalSTTEngineInfo[]) => void;
  const later = new Promise<LocalSTTEngineInfo[]>((resolve) => { resolveLater = resolve; });
  listLocalSTTEngines.mockResolvedValueOnce(installedWhisper).mockReturnValueOnce(later);
  render(<StrictMode><MeetingAudioSettings /></StrictMode>);
  await act(async () => {});
  await act(async () => resolveLater([]));
  expect(useConfigStore.getState().meetingAudioConfig?.you.stt_provider).toBe("deepgram");
  expect(useConfigStore.getState().meetingAudioConfig?.them.stt_provider).toBe("deepgram");
});

it("does not advertise provider catalog entries as operational STT readiness", async () => {
  listLocalSTTEngines.mockResolvedValue(installedWhisper);
  render(<STTSettings />);
  await act(async () => {});
  expect(screen.getByRole("button", { name: /Windows Speech/ })).not.toHaveTextContent("Ready");
  expect(screen.getByRole("button", { name: /Whisper.cpp/ })).not.toHaveTextContent("Batch mode only");
});

describe.each([
  { surface: "settings", Component: MeetingAudioSettings },
  { surface: "wizard", Component: AudioSetupStep },
])("$surface audio source selection", ({ Component }) => {
  it.each(["you", "them"] as const)("keeps the %s input and output distinct when their names match", async (party) => {
    const user = userEvent.setup();
    const view = render(<Component />);
    const group = await screen.findAllByRole("group", { name: "Speakers / Output" });
    const output = within(group[party === "you" ? 0 : 1]).getByRole<HTMLOptionElement>("option");
    const select = output.closest("select")!;
    await waitFor(() => expect(select).toBeEnabled());

    await user.selectOptions(select, output);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: 'Studio: USB "Audio"',
      is_input_device: false,
    });
    expect(output.selected).toBe(true);

    view.unmount();
    render(<Component />);
    const restoredGroups = await screen.findAllByRole("group", { name: "Speakers / Output" });
    const restoredOutput = within(restoredGroups[party === "you" ? 0 : 1]).getByRole<HTMLOptionElement>("option");
    expect(restoredOutput.selected).toBe(true);
    const restoredSelect = restoredOutput.closest("select")!;
    const micGroup = within(restoredSelect).getByRole("group", { name: "Microphones" });
    const input = within(micGroup).getByRole<HTMLOptionElement>("option");
    await waitFor(() => expect(restoredSelect).toBeEnabled());
    await user.selectOptions(restoredSelect, input);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: 'Studio: USB "Audio"',
      is_input_device: true,
    });
    expect(input.selected).toBe(true);
  });

  it.each([
    { party: "you" as const, isInput: true },
    { party: "them" as const, isInput: false },
  ])("uses the correct direction for the $party default", async ({ party, isInput }) => {
    const user = userEvent.setup();
    render(<Component />);
    const groups = await screen.findAllByRole("group", { name: "Microphones" });
    const select = groups[party === "you" ? 0 : 1].closest("select")!;
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, select.options[0]);
    expect(useConfigStore.getState().meetingAudioConfig?.[party]).toMatchObject({
      device_id: "default",
      is_input_device: isInput,
    });
    expect(select.options[0].selected).toBe(true);
  });
});
