import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotModel, CopilotStatus } from "../lib/types";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const ipc = vi.hoisted(() => ({
  copilotStatus: vi.fn(),
  openCopilotLoginTerminal: vi.fn(),
  setActiveModel: vi.fn(),
  setLLMProvider: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  copilotStatus: () => ipc.copilotStatus(),
  openCopilotLoginTerminal: () => ipc.openCopilotLoginTerminal(),
  setActiveModel: (...args: unknown[]) => ipc.setActiveModel(...args),
  setLLMProvider: (...args: unknown[]) => ipc.setLLMProvider(...args),
}));

import {
  COPILOT_ROW_LABEL,
  GitHubCopilotSettings,
  copilotConnection,
  enabledModels,
} from "./GitHubCopilotSettings";
import { useConfigStore } from "../stores/configStore";

function model(id: string, name: string, usage: string | null = "1x", enabled = true): CopilotModel {
  return { id, name, description: null, usage, enabled };
}

const MODELS: CopilotModel[] = [
  model("auto", "Auto"),
  model("claude-sonnet-5.5", "Claude Sonnet 5.5"),
  model("claude-haiku-4.5", "Claude Haiku 4.5", "0.33x"),
  model("gpt-hidden", "GPT Hidden", null, false),
];

const READY: CopilotStatus = {
  state: "ready",
  installed: true,
  binary_path: "C:\\Users\\me\\AppData\\Local\\Programs\\GitHubCopilotCLI\\copilot.exe",
  version: "1.0.105",
  npm_only: false,
  handshake_ok: true,
  session_ok: true,
  models: MODELS,
  current_model: "claude-sonnet-5.5",
  error: null,
  login_hint: "Run `copilot login` in a terminal and finish the sign-in there, then check the connection again.",
};
const NOT_INSTALLED: CopilotStatus = {
  ...READY,
  state: "not_installed",
  installed: false,
  binary_path: null,
  version: null,
  handshake_ok: false,
  session_ok: false,
  models: [],
  current_model: null,
  error: "The GitHub Copilot CLI is not installed",
  login_hint: "Install the GitHub Copilot CLI, then run `copilot login` in a terminal.",
};
const NOT_LOGGED_IN: CopilotStatus = {
  ...READY,
  state: "not_logged_in",
  session_ok: false,
  models: [],
  current_model: null,
  error: "GitHub Copilot needs you to sign in: Authentication required (code -32000)",
};
const NO_ENTITLEMENT: CopilotStatus = {
  ...READY,
  state: "no_entitlement",
  models: [],
  error: "The Copilot CLI answered, but lists no model enabled for this account.",
};

function renderSettings(props: { active?: boolean; selected?: boolean } = {}) {
  return render(
    <GitHubCopilotSettings selected={props.selected ?? true} active={props.active ?? false} onSelect={() => {}} />,
  );
}

function optionTexts(): string[] {
  return Array.from((screen.getByLabelText("Copilot model") as HTMLSelectElement).options).map((o) => o.textContent ?? "");
}

describe("GitHubCopilotSettings", () => {
  beforeEach(() => {
    useConfigStore.setState({
      llmProvider: "ollama",
      llmModel: "llama3",
      lastModelByProvider: {},
      verifiedCloudProviders: [],
    });
    ipc.copilotStatus.mockReset().mockResolvedValue(READY);
    ipc.openCopilotLoginTerminal.mockReset().mockResolvedValue(undefined);
    ipc.setActiveModel.mockReset().mockResolvedValue(undefined);
    ipc.setLLMProvider.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps the CLI's states to row labels and the checking/failed states", () => {
    expect(copilotConnection(undefined, false)).toBe("checking");
    expect(copilotConnection(undefined, true)).toBe("failed");
    expect(copilotConnection(NOT_LOGGED_IN, false)).toBe("not_logged_in");
    expect(COPILOT_ROW_LABEL.ready).toBe("Ready");
    expect(COPILOT_ROW_LABEL.not_logged_in).toBe("Not signed in");
    expect(COPILOT_ROW_LABEL.no_entitlement).toBe("No Copilot access");
    expect(enabledModels(READY).map((m) => m.id)).toEqual(["auto", "claude-sonnet-5.5", "claude-haiku-4.5"]);
    expect(enabledModels(undefined)).toEqual([]);
  });

  it("shows the live catalog from the CLI, not a made-up list, and only enabled models", async () => {
    renderSettings();
    expect(await screen.findByText(/Copilot CLI answered · 3 models available/)).toBeInTheDocument();
    expect(screen.getByTestId("copilot-status-dot")).toHaveAttribute("data-state", "ready");
    expect(optionTexts()).toEqual(["Auto (1x)", "Claude Sonnet 5.5 (1x)", "Claude Haiku 4.5 (0.33x)"]);
    expect(screen.queryByText(/GPT Hidden/)).not.toBeInTheDocument();
    expect(screen.getByText(/v1\.0\.105/)).toBeInTheDocument();
  });

  it("defaults to Auto and is honest about plan, CLI and where chats go", async () => {
    renderSettings();
    await screen.findByText(/Copilot CLI answered/);
    expect((screen.getByLabelText("Copilot model") as HTMLSelectElement).value).toBe("auto");
    expect(screen.getByText(/Requires an active GitHub Copilot plan and the official Copilot CLI/)).toBeInTheDocument();
    expect(screen.getByText(/sent to GitHub Copilot/)).toBeInTheDocument();
  });

  it("marks the provider verified once the CLI is ready", async () => {
    renderSettings();
    await screen.findByText(/Copilot CLI answered/);
    expect(useConfigStore.getState().verifiedCloudProviders).toContain("github_copilot");
  });

  it("shows the genuine sign-in error and offers the terminal login", async () => {
    ipc.copilotStatus.mockResolvedValue(NOT_LOGGED_IN);
    renderSettings();
    expect(await screen.findByText("Copilot CLI says you need to sign in")).toBeInTheDocument();
    expect(screen.getByTestId("copilot-status-dot")).toHaveAttribute("data-state", "not_logged_in");
    expect(screen.getByTestId("copilot-error")).toHaveTextContent("Authentication required (code -32000)");
    expect(screen.getByText(/copilot login/)).toBeInTheDocument();
    expect(screen.queryByText(/Copilot CLI answered/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open terminal to sign in/i }));
    await waitFor(() => expect(ipc.openCopilotLoginTerminal).toHaveBeenCalledTimes(1));
    // Not usable until signed in.
    expect(screen.getByRole("button", { name: /use github copilot/i })).toBeDisabled();
  });

  it("says when the CLI is not installed and links to its instructions", async () => {
    ipc.copilotStatus.mockResolvedValue(NOT_INSTALLED);
    renderSettings();
    expect(await screen.findByText("Copilot CLI not installed")).toBeInTheDocument();
    expect(screen.getByTestId("copilot-error")).toHaveTextContent("The GitHub Copilot CLI is not installed");
    expect(screen.getByRole("link", { name: /copilot cli instructions/i })).toHaveAttribute(
      "href",
      "https://docs.github.com/en/copilot/how-tos/copilot-cli",
    );
    expect(screen.getByLabelText("Copilot model")).toBeDisabled();
  });

  it("reports missing entitlement without offering a sign-in", async () => {
    ipc.copilotStatus.mockResolvedValue(NO_ENTITLEMENT);
    renderSettings();
    expect(await screen.findByText("No Copilot access for this account")).toBeInTheDocument();
    expect(screen.getByTestId("copilot-status-dot")).toHaveAttribute("data-state", "no_entitlement");
    expect(screen.queryByRole("button", { name: /open terminal/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use github copilot/i })).toBeDisabled();
  });

  it("shows a quiet checking state, then says so when the check itself fails and retries", async () => {
    let resolve: (s: CopilotStatus) => void = () => {};
    ipc.copilotStatus.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderSettings();
    expect(screen.getByTestId("copilot-status-dot")).toHaveAttribute("data-state", "checking");
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await act(async () => resolve(READY));
    expect(screen.getByTestId("copilot-status-dot")).toHaveAttribute("data-state", "ready");

    ipc.copilotStatus.mockRejectedValueOnce(new Error("backend unreachable"));
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    expect(await screen.findByTestId("copilot-error")).toHaveTextContent("Couldn't check: backend unreachable");
    ipc.copilotStatus.mockResolvedValueOnce(READY);
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    await waitFor(() => expect(screen.queryByTestId("copilot-error")).not.toBeInTheDocument());
    expect(ipc.copilotStatus).toHaveBeenCalledTimes(3);
  });

  it("activates Copilot with the picked model through the shared store action", async () => {
    renderSettings();
    await screen.findByText(/Copilot CLI answered/);
    fireEvent.change(screen.getByLabelText("Copilot model"), { target: { value: "claude-haiku-4.5" } });
    // Not active yet: nothing is applied until "Use GitHub Copilot".
    expect(ipc.setActiveModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /use github copilot/i }));
    await waitFor(() => expect(ipc.setActiveModel).toHaveBeenCalledWith("github_copilot", "claude-haiku-4.5"));
    expect(JSON.parse(ipc.setLLMProvider.mock.calls[0][0] as string)).toEqual({ provider_type: "github_copilot" });
    expect(useConfigStore.getState().llmProvider).toBe("github_copilot");
    expect(useConfigStore.getState().llmModel).toBe("claude-haiku-4.5");
  });

  it("activates with Auto when no model was picked", async () => {
    renderSettings();
    await screen.findByText(/Copilot CLI answered/);
    fireEvent.click(screen.getByRole("button", { name: /use github copilot/i }));
    await waitFor(() => expect(ipc.setActiveModel).toHaveBeenCalledWith("github_copilot", "auto"));
  });

  it("applies a model change at once while Copilot is the active provider", async () => {
    useConfigStore.setState({ llmProvider: "github_copilot", llmModel: "auto" });
    renderSettings({ active: true });
    await screen.findByText(/Copilot CLI answered/);
    expect(screen.queryByRole("button", { name: /use github copilot/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Copilot model"), { target: { value: "claude-sonnet-5.5" } });
    await waitFor(() => expect(ipc.setActiveModel).toHaveBeenCalledWith("github_copilot", "claude-sonnet-5.5"));
    expect(useConfigStore.getState().llmModel).toBe("claude-sonnet-5.5");
  });

  it("keeps a saved model that the account no longer lists visible but flagged", async () => {
    useConfigStore.setState({ llmProvider: "github_copilot", llmModel: "gone-model" });
    renderSettings({ active: true });
    await screen.findByText(/Copilot CLI answered/);
    expect(optionTexts()[0]).toBe("gone-model (not in your current list)");
  });

  it("labels the row for the list of providers", async () => {
    renderSettings({ selected: false, active: true });
    const row = await screen.findByRole("button", { name: /^GitHub Copilot, Ready, active/ });
    expect(within(row).getByText("Active")).toBeInTheDocument();
    // Details stay hidden until the row is selected.
    expect(screen.queryByRole("button", { name: /check connection/i })).not.toBeInTheDocument();
  });
});
