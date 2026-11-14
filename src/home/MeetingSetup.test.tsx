import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/profileIpc", async () => ({ profileIpc: (await import("../test/profileFixtures")).profileIpcMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { MeetingSetup } from "./MeetingSetup";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useProfileStore } from "../stores/profileStore";
import {
  CATALOG, makeProfile, profileIpcMock as ipc, readyProfile, resetProfileIpcMock,
} from "../test/profileFixtures";
import type { MeetingProfile } from "../lib/profileTypes";

function show(profile: MeetingProfile, props: Partial<Parameters<typeof MeetingSetup>[0]> = {}) {
  useProfileStore.setState({ current: profile, catalog: CATALOG, dirty: false, documents: [], slides: [], error: null, busy: false });
  const onBack = vi.fn();
  const onStart = vi.fn();
  render(<MeetingSetup onBack={onBack} onStart={onStart} startState={{ starting: false, error: null }} {...props} />);
  return { onBack, onStart };
}

const startButton = () => screen.getByRole("button", { name: /Start Meeting/ });

beforeEach(() => {
  resetProfileIpcMock();
  useMeetingStore.setState({ activeMeeting: null });
  useConfigStore.setState({ verifiedCloudProviders: ["openai", "groq"] });
});

afterEach(() => {
  cleanup();
  useProfileStore.getState().close();
});

describe("MeetingSetup layout", () => {
  it("labels what is this meeting's and what is global", () => {
    show(readyProfile());
    expect(screen.getByText("This meeting")).toBeInTheDocument();
    expect(screen.getByText("Global (all meetings)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Global settings" }));
    expect(useMeetingStore.getState().currentView).toBe("settings");
  });

  it("keeps the advanced section collapsed until opened", () => {
    show(readyProfile());
    const advanced = screen.getByRole("button", { name: /^Advanced/ });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Primary provider")).toBeNull();
    fireEvent.click(advanced);
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Primary provider")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "BALANCED" })).toBeChecked();
  });

  it("defaults to text output and keeps transcription separate from it", () => {
    show(readyProfile());
    expect(screen.getByRole("radio", { name: "Text" })).toBeChecked();
    const output = screen.getByRole("group", { name: /Response output/ });
    const transcription = screen.getByRole("group", { name: /Transcription engine/ });
    expect(within(output).queryByRole("radio", { name: "Whisper transcription" })).toBeNull();
    expect(within(transcription).getByRole("radio", { name: "Whisper transcription" })).not.toBeChecked();
    expect(within(transcription).getByRole("radio", { name: "Automatic" })).toBeChecked();
    expect(screen.queryByText(/system text-to-speech voice/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Spoken answer" }));
    expect(screen.getByText(/system text-to-speech voice/)).toBeInTheDocument();
    expect(useProfileStore.getState().current?.audio.outputMode).toBe("spoken");
  });

  it("only offers presentation notes for a presentation meeting", () => {
    show(readyProfile({ meetingType: "interview", template: "technical_interview" }));
    expect(screen.queryByRole("button", { name: /Presentation notes/ })).toBeNull();
  });

  it("is honest about cloud folders and Google Slides", () => {
    show(readyProfile());
    fireEvent.click(screen.getByRole("button", { name: "Connect Cloud Folder" }));
    expect(screen.getByText(/Direct Google Drive/)).toBeInTheDocument();
    expect(screen.getByText(/never reads browser tokens/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Google Slides / OneDrive / SharePoint" }));
    expect(screen.getByText(/needs your own OAuth registration/)).toBeInTheDocument();
  });
});

describe("MeetingSetup saving", () => {
  it("shows a backend refusal of credential-looking text", async () => {
    show(readyProfile());
    ipc.save.mockRejectedValue("The system prompt looks like it contains an API key or token.");
    fireEvent.change(screen.getByLabelText(/Meeting instructions/), { target: { value: "use sk-abcdefghijklmnopqrstuvwxyz123456" } });
    expect(screen.getByText("● Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/looks like it contains an API key/);
    expect(screen.getByText("● Unsaved changes")).toBeInTheDocument();
  });

  it("never replaces an edited prompt without asking", () => {
    show(readyProfile({ systemPrompt: "My own prompt" }));
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "general_meeting" } });
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/replaces them/);
    expect(useProfileStore.getState().current?.systemPrompt).toBe("My own prompt");
    fireEvent.click(screen.getByRole("button", { name: "Replace instructions" }));
    expect(useProfileStore.getState().current?.systemPrompt).toBe("General prompt");
  });

  it("fills an untouched prompt when the template or type changes", () => {
    show(readyProfile());
    fireEvent.click(screen.getByRole("radio", { name: "Interview" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const p = useProfileStore.getState().current!;
    expect(p.systemPrompt).toBe("Interview prompt");
    expect(p.ai.responseFormat).toBe("action_answer");
  });
});

describe("MeetingSetup start gating", () => {
  it("disables Start and lists what is missing", () => {
    const { onStart } = show(makeProfile());
    expect(startButton()).toBeDisabled();
    expect(screen.getByRole("status", { name: "Before you can start" })).toHaveTextContent(/Choose an AI provider and model/);
    fireEvent.click(startButton());
    expect(onStart).not.toHaveBeenCalled();
  });

  it("requires the assistance checkbox for a live session", () => {
    show(readyProfile());
    expect(startButton()).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: "Live" }));
    expect(startButton()).toBeDisabled();
    expect(screen.getByRole("status", { name: "Before you can start" })).toHaveTextContent(/AI assistance is permitted/);
    fireEvent.click(screen.getByLabelText("AI assistance is permitted for this meeting"));
    expect(startButton()).toBeEnabled();
    expect(useProfileStore.getState().current?.assistancePermittedConfirmed).toBe(true);
  });

  it("gates automatic fallback on consent to share the context with that provider", () => {
    const base = readyProfile();
    show({ ...base, ai: { ...base.ai, primaryProvider: "openai", primaryModel: "gpt-4o", fallbackProvider: "groq", fallbackModel: "llama-3", automaticFallback: true } });
    expect(startButton()).toBeDisabled();
    expect(screen.getByRole("status", { name: "Before you can start" })).toHaveTextContent(/Allow groq to receive/);

    fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));
    const consent = screen.getByLabelText("Allow Groq to receive this meeting's context");
    expect(consent).not.toBeChecked();
    fireEvent.click(consent);
    expect(useProfileStore.getState().current?.ai.fallbackConsentProvider).toBe("groq");
    expect(startButton()).toBeEnabled();

    fireEvent.click(consent);
    expect(useProfileStore.getState().current?.ai.fallbackConsentProvider).toBeNull();
    expect(startButton()).toBeDisabled();
  });

  it("drops the consent when another fallback provider is chosen", () => {
    const base = readyProfile();
    show({ ...base, ai: { ...base.ai, primaryProvider: "openai", primaryModel: "gpt-4o", fallbackProvider: "groq", fallbackModel: "x", fallbackConsentProvider: "groq" } });
    fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));
    fireEvent.change(screen.getByLabelText("Fallback provider"), { target: { value: "ollama" } });
    expect(useProfileStore.getState().current?.ai.fallbackConsentProvider).toBeNull();
  });

  it("saves pending edits, then starts", async () => {
    const { onStart } = show(readyProfile());
    fireEvent.change(screen.getByLabelText("Meeting name"), { target: { value: "Renamed" } });
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledWith("p1"));
    expect(ipc.save).toHaveBeenCalledWith(expect.objectContaining({ name: "Renamed" }));
  });

  it("never asks for an API key", () => {
    show(readyProfile());
    fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
});

describe("MeetingSetup deleting", () => {
  it("asks for confirmation naming the meeting before deleting anything", async () => {
    ipc.remove.mockResolvedValue(undefined);
    const { onBack } = show(readyProfile());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete “Thesis defence”?");
    expect(ipc.remove).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete this meeting and its data" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete meeting and data" }));
    await waitFor(() => expect(ipc.remove).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it("asks before clearing session history", async () => {
    ipc.clearSessions.mockResolvedValue(2);
    show(readyProfile());
    fireEvent.click(screen.getByRole("button", { name: "Clear session history" }));
    expect(ipc.clearSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(ipc.clearSessions).toHaveBeenCalledWith("p1"));
  });
});

describe("MeetingSetup sources", () => {
  it("shows failed documents with their error and an import summary", () => {
    show(readyProfile());
    act(() => useProfileStore.setState({
      documents: [
        { id: "d1", profileId: "p1", name: "scan.pdf", sourcePath: "C:\\x\\scan.pdf", sourceKind: "file", folderId: null, role: "reference", fileType: "pdf", sizeBytes: 1, contentHash: "h", mtimeMs: 0, status: "failed", error: "No text layer found", chunkCount: 0, preview: "", indexedAt: "" },
        { id: "d2", profileId: "p1", name: "deck.pptx", sourcePath: "C:\\x\\deck.pptx", sourceKind: "file", folderId: null, role: "reference", fileType: "pptx", sizeBytes: 1, contentHash: "h2", mtimeMs: 0, status: "indexed", error: null, chunkCount: 12, preview: "", indexedAt: "" },
      ],
      lastReport: { added: ["deck.pptx"], updated: [], unchanged: [], duplicates: [], failed: [{ path: "C:\\x\\scan.pdf", reason: "No text layer found" }], skipped: [], missing: [] },
    }));
    expect(screen.getByText(/Error: No text layer found/)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Import summary" })).toHaveTextContent("1 added");
    expect(screen.getByRole("status", { name: "Import summary" })).toHaveTextContent(/Failed: scan.pdf — No text layer found/);
    expect(screen.getByText("12 chunks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use as presentation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Role of scan.pdf")).toHaveValue("reference");
  });
});
