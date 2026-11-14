import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/profileIpc", async () => ({ profileIpc: (await import("../test/profileFixtures")).profileIpcMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../launcher/LauncherView", () => ({ LauncherView: () => <div>Classic launcher stub</div> }));
vi.mock("../lib/startProfileMeeting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/startProfileMeeting")>()),
  startProfileMeeting: vi.fn(),
}));

import { HomeShell } from "./HomeShell";
import { startProfileMeeting } from "../lib/startProfileMeeting";
import { useMeetingStore } from "../stores/meetingStore";
import { useProfileStore } from "../stores/profileStore";
import { useToastStore } from "../stores/toastStore";
import { makeProfile, makeSummary, profileIpcMock as ipc, readyProfile, resetProfileIpcMock } from "../test/profileFixtures";

const toastMessages = () => useToastStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  resetProfileIpcMock();
  vi.mocked(startProfileMeeting).mockReset();
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher" });
  useProfileStore.getState().close();
  useProfileStore.setState({ summaries: [], catalog: null });
});

afterEach(cleanup);

describe("HomeShell", () => {
  it("offers exactly the four primary actions", async () => {
    render(<HomeShell />);
    for (const name of ["New Meeting", "Start Meeting", "Saved Meetings", "Global Settings"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Classic interview launcher" })).toBeInTheDocument();
    await waitFor(() => expect(ipc.list).toHaveBeenCalled());
  });

  it("disables Start with a hint when no meeting exists", async () => {
    render(<HomeShell />);
    await waitFor(() => expect(ipc.list).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /^Start Meeting/ })).toBeDisabled();
    expect(screen.getByText(/No saved meetings yet/)).toBeInTheDocument();
    expect(screen.queryByText("Recent meetings")).toBeNull();
  });

  it("starts the most recently updated meeting", async () => {
    ipc.list.mockResolvedValue([
      makeSummary({ id: "old", name: "Old", updatedAt: "2026-01-01T00:00:00Z" }),
      makeSummary({ id: "new", name: "Newest", updatedAt: "2026-03-01T00:00:00Z" }),
    ]);
    ipc.get.mockImplementation(async (id: string) => readyProfile({ id, name: id }));
    vi.mocked(startProfileMeeting).mockResolvedValue({ notice: "Whisper transcription is not installed; the automatic engine will be used." });

    render(<HomeShell />);
    const start = await screen.findByRole("button", { name: /^Start Meeting/ });
    await waitFor(() => expect(start).toBeEnabled());
    expect(start).toHaveTextContent("Most recent: Newest");
    fireEvent.click(start);
    await waitFor(() => expect(startProfileMeeting).toHaveBeenCalledWith("new"));
    await waitFor(() => expect(toastMessages()).toContain("Whisper transcription is not installed; the automatic engine will be used."));
  });

  it("explains why the latest meeting cannot start", async () => {
    ipc.list.mockResolvedValue([makeSummary()]);
    ipc.get.mockResolvedValue(makeProfile());
    render(<HomeShell />);
    expect(await screen.findByText(/isn't ready to start/)).toBeInTheDocument();
    expect(screen.getByText(/Choose an AI provider and model/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Start Meeting/ })).toBeDisabled();
  });

  it("shows a start error inline", async () => {
    ipc.list.mockResolvedValue([makeSummary()]);
    ipc.get.mockResolvedValue(readyProfile());
    vi.mocked(startProfileMeeting).mockRejectedValue(new Error("Ollama is not running"));
    render(<HomeShell />);
    const start = await screen.findByRole("button", { name: /^Start Meeting/ });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent("Ollama is not running");
  });

  it("lists at most three recent meetings", async () => {
    ipc.list.mockResolvedValue([1, 2, 3, 4].map((n) => makeSummary({ id: `m${n}`, name: `Meeting ${n}`, updatedAt: `2026-0${n}-01T00:00:00Z` })));
    ipc.get.mockResolvedValue(readyProfile());
    render(<HomeShell />);
    expect(await screen.findByRole("button", { name: "Open Meeting 4" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Meeting 1" })).toBeNull();
  });

  it("opens global settings and keeps the classic launcher reachable", async () => {
    render(<HomeShell />);
    fireEvent.click(screen.getByRole("button", { name: /^Global Settings/ }));
    expect(useMeetingStore.getState().currentView).toBe("settings");
    fireEvent.click(screen.getByRole("button", { name: "Classic interview launcher" }));
    expect(screen.getByText("Classic launcher stub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Back to meeting home/ }));
    expect(screen.getByRole("button", { name: /^New Meeting/ })).toBeInTheDocument();
    await act(async () => {});
  });

  it("creates a meeting and opens its setup", async () => {
    ipc.create.mockResolvedValue(makeProfile({ id: "n1", name: "New meeting" }));
    render(<HomeShell />);
    fireEvent.click(screen.getByRole("button", { name: /^New Meeting/ }));
    await waitFor(() => expect(ipc.create).toHaveBeenCalledWith("New meeting", "academic_qa"));
    expect(await screen.findByRole("button", { name: /^Basics/ })).toBeInTheDocument();
  });
});
