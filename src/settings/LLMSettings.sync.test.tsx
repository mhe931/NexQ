// Settings ↔ footer: one source of truth for the active LLM provider.
//
// Reported bug: "activating" Claude in Settings left the footer on the old
// provider until Claude was picked again in the footer.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCliStatus, CopilotStatus } from "../lib/types";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const ipc = vi.hoisted(() => ({
  claudeCliStatus: vi.fn(),
  claudeCliModels: vi.fn(),
  getAgentSessions: vi.fn(),
  setLLMProvider: vi.fn(),
  setActiveModel: vi.fn(),
  setClaudeCliConfig: vi.fn(),
  storeApiKey: vi.fn(),
  testLLMConnection: vi.fn(),
  testLLMResponse: vi.fn(),
  clearProviderCreditFailure: vi.fn(),
  copilotStatus: vi.fn(),
  getApiKey: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  claudeCliStatus: () => ipc.claudeCliStatus(),
  claudeCliModels: (...a: unknown[]) => ipc.claudeCliModels(...a),
  getAgentSessions: () => ipc.getAgentSessions(),
  setLLMProvider: (...a: unknown[]) => ipc.setLLMProvider(...a),
  setActiveModel: (...a: unknown[]) => ipc.setActiveModel(...a),
  setClaudeCliConfig: (...a: unknown[]) => ipc.setClaudeCliConfig(...a),
  storeApiKey: (...a: unknown[]) => ipc.storeApiKey(...a),
  testLLMConnection: (...a: unknown[]) => ipc.testLLMConnection(...a),
  testLLMResponse: (...a: unknown[]) => ipc.testLLMResponse(...a),
  clearProviderCreditFailure: (...a: unknown[]) => ipc.clearProviderCreditFailure(...a),
  copilotStatus: () => ipc.copilotStatus(),
  getApiKey: (...a: unknown[]) => ipc.getApiKey(...a),
  hasApiKey: async () => false,
  listModels: async () => [],
  listLocalSTTEngines: async () => [],
  getLLMProviders: async () => [],
}));

import { LLMSettings } from "./LLMSettings";
import { ServiceStatusBar } from "../components/ServiceStatusBar";
import { resetAgentStoreForTests } from "../stores/agentStore";
import { useStreamStore } from "../stores/streamStore";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";
import { DEFAULT_CLAUDE_CLI_CONFIG, useConfigStore } from "../stores/configStore";
import { useLiveQAHealth } from "../hooks/useLiveQAHealth";

const LOGGED_IN: ClaudeCliStatus = {
  installed: true,
  binary_path: "C:\\Users\\me\\.local\\bin\\claude.exe",
  version: "2.1.288",
  auth: { logged_in: true, auth_method: "claude.ai", subscription_type: "max", email: "me@example.com", login: "subscription" },
  npm_only: false,
};
const COPILOT_CONNECTED: CopilotStatus = {
  state: "ready", installed: true, binary_path: "C:\\test\\copilot.exe",
  version: "1.0.105", npm_only: false, handshake_ok: true, session_ok: true,
  models: [], current_model: "auto", error: null, login_hint: "",
};

/** The footer's LLM chip: Claude's status chip, or the generic provider chip. */
function footerShowsClaude(): boolean {
  return screen.queryByTestId("agent-status-chip") !== null;
}

function claudeCard(): HTMLElement {
  return screen.getByRole("button", { name: /^Claude\b/ });
}

describe("Settings ↔ footer sync of the active LLM", () => {
  beforeEach(() => {
    resetAgentStoreForTests();
    useStreamStore.getState().resetForMeeting();
    useLiveQAHealthStore.getState().reset();
    useConfigStore.setState({
      llmProvider: "ollama",
      llmModel: "llama3.2",
      lastModelByProvider: { ollama: "llama3.2" },
      claudeCliConfig: DEFAULT_CLAUDE_CLI_CONFIG,
      claudeCliFallbackPinned: false,
      verifiedCloudProviders: [],
      customLlmBaseUrl: "",
      customLlmAuthType: "none",
    });
    ipc.claudeCliStatus.mockReset().mockResolvedValue(LOGGED_IN);
    ipc.claudeCliModels.mockReset().mockResolvedValue([]);
    ipc.getAgentSessions.mockReset().mockResolvedValue([]);
    ipc.setLLMProvider.mockReset().mockResolvedValue(undefined);
    ipc.setActiveModel.mockReset().mockResolvedValue(undefined);
    ipc.setClaudeCliConfig.mockReset().mockResolvedValue(undefined);
    ipc.storeApiKey.mockReset().mockResolvedValue(undefined);
    ipc.testLLMConnection.mockReset().mockResolvedValue(true);
    ipc.testLLMResponse.mockReset().mockResolvedValue(true);
    ipc.clearProviderCreditFailure.mockReset().mockResolvedValue(undefined);
    ipc.copilotStatus.mockReset().mockResolvedValue(COPILOT_CONNECTED);
    ipc.getApiKey.mockReset().mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("the Claude panel in Settings activates Claude, and the footer follows", async () => {
    render(
      <>
        <LLMSettings />
        <ServiceStatusBar />
      </>,
    );
    expect(footerShowsClaude()).toBe(false);

    // Open Claude in Settings: its panel shows the login and models...
    fireEvent.click(claudeCard());
    await screen.findByText("me@example.com · Max");
    // ...and offers activation right there, not only at the bottom of the page.
    fireEvent.click(screen.getByRole("button", { name: "Use Claude" }));

    await waitFor(() => expect(footerShowsClaude()).toBe(true));
    expect(useConfigStore.getState().llmProvider).toBe("claude_cli");
    expect(ipc.setLLMProvider).toHaveBeenCalledWith(JSON.stringify({ provider_type: "claude_cli" }));
    expect(ipc.setActiveModel).toHaveBeenCalledWith("claude_cli", "haiku");
    expect(within(claudeCard()).getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Claude" })).not.toBeInTheDocument();
    // Router activation is not proof of an operational generation.
    expect(useConfigStore.getState().verifiedCloudProviders).not.toContain("claude_cli");
  });

  it("connection checking does not test chat or clear a credit failure", async () => {
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() => expect(ipc.testLLMConnection).toHaveBeenCalled());
    expect(ipc.testLLMResponse).not.toHaveBeenCalled();
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
    expect(screen.queryByText("AI response verified")).toBeNull();
  });

  it("tests the selected config/model without treating a diagnostic response as active-router recovery", async () => {
    useConfigStore.setState({
      llmProvider: "openai", llmModel: "gpt-4o", lastModelByProvider: { ollama: "llama3.2" },
    });
    useStreamStore.getState().setPending("AskQuestion", "failed", "openai", "Why?", "gpt-4o");
    useStreamStore.getState().setError("credits exhausted", { code: "credits_exhausted" });
    const activeError = useStreamStore.getState().error;
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: /^Ollama\b/ }));
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await waitFor(() => expect(ipc.testLLMResponse).toHaveBeenCalledWith('{"provider_type":"ollama"}', "llama3.2"));
    expect(await screen.findByRole("status", { name: "AI response test" }))
      .toHaveTextContent("Test response received. Active AI configuration not verified.");
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
    expect(useStreamStore.getState().error).toBe(activeError);
    expect(useLiveQAHealthStore.getState().aiReadyModels).toEqual({});
    expect(ipc.setLLMProvider).not.toHaveBeenCalled();
    expect(screen.getByText(/No meeting content\. Provider usage may apply/)).toBeInTheDocument();
  });

  it("reconfigures the active saved selection before testing the actual router by bare provider id", async () => {
    useStreamStore.getState().setPending("AskQuestion", "failed", "ollama", "Why?", "llama3.2");
    useStreamStore.getState().setError("credits exhausted", { code: "credits_exhausted" });
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    expect(await screen.findByRole("status", { name: "AI response test" })).toHaveTextContent("Active AI response verified");
    expect(ipc.testLLMResponse).toHaveBeenCalledWith("ollama", "llama3.2");
    expect(ipc.setLLMProvider).toHaveBeenCalledWith('{"provider_type":"ollama"}');
    expect(ipc.setActiveModel).toHaveBeenCalledWith("ollama", "llama3.2");
    expect(ipc.setActiveModel.mock.invocationCallOrder[0]).toBeLessThan(ipc.testLLMResponse.mock.invocationCallOrder[0]);
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
    expect(useStreamStore.getState().error).toBeNull();
    expect(useLiveQAHealthStore.getState().aiReadyModels.ollama).toBe("llama3.2");
  });

  it("does not test or clear an active failure when reconfiguration fails", async () => {
    ipc.setActiveModel.mockRejectedValueOnce(new Error("Model was not applied"));
    useStreamStore.getState().setError("credits exhausted", { code: "credits_exhausted" });
    const activeError = useStreamStore.getState().error;
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    expect(await screen.findByRole("alert", { name: "AI response test" })).toHaveTextContent("Could not apply saved settings");
    expect(ipc.testLLMResponse).not.toHaveBeenCalled();
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
    expect(useStreamStore.getState().error).toBe(activeError);
    expect(useLiveQAHealthStore.getState().aiReadyModels.ollama).toBeUndefined();
  });

  it("does not clear a credit failure or show success after an empty/failed chat test", async () => {
    ipc.testLLMResponse.mockResolvedValue(false);
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await waitFor(() => expect(screen.getByRole("alert", { name: "AI response test" })).toHaveTextContent("AI returned no answer"));
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
    expect(screen.queryByText("AI response verified")).toBeNull();
  });

  it("does not replace a document-retrieval failure with diagnostic AI success", async () => {
    const message = "Meeting documents are unavailable. Restart NexQ before asking again.";
    useStreamStore.getState().setPending("AskQuestion", "docs", "ollama");
    useStreamStore.getState().setHandlingStatus("retrieving_context");
    useStreamStore.getState().setError(message);
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await screen.findByRole("status", { name: "AI response test" });
    expect(useStreamStore.getState()).toMatchObject({ error: message, handlingStatus: "retrieving_context", answerOutcome: "unable" });
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
  });

  it("does not mark unsaved credentials ready or clear the active provider's failure", async () => {
    useConfigStore.setState({ llmProvider: "openai", llmModel: "gpt-4o", lastModelByProvider: { openai: "gpt-4o" } });
    useStreamStore.getState().setError("401 invalid API key");
    const activeError = useStreamStore.getState().error;
    render(<LLMSettings />);
    fireEvent.change(await screen.findByPlaceholderText("Enter OpenAI API key"), { target: { value: "test-unsaved-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await screen.findByRole("status", { name: "AI response test" });
    expect(ipc.testLLMResponse).toHaveBeenCalledWith('{"provider_type":"openai","api_key":"test-unsaved-key"}', "gpt-4o");
    expect(ipc.storeApiKey).not.toHaveBeenCalled();
    expect(ipc.setLLMProvider).not.toHaveBeenCalled();
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
    expect(useStreamStore.getState().error).toBe(activeError);
    expect(useLiveQAHealthStore.getState().aiReadyModels.openai).toBeUndefined();
  });

  it("reapplies saved API credentials before an active-router response test", async () => {
    useConfigStore.setState({ llmProvider: "openai", llmModel: "gpt-4o", lastModelByProvider: { openai: "gpt-4o" } });
    ipc.getApiKey.mockResolvedValue("test-saved-key");
    render(<LLMSettings />);
    await waitFor(() => expect(screen.getByPlaceholderText("Enter OpenAI API key")).toHaveValue("test-saved-key"));
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    expect(await screen.findByRole("status", { name: "AI response test" })).toHaveTextContent("Active AI response verified");
    expect(ipc.setLLMProvider).toHaveBeenCalledWith('{"provider_type":"openai","api_key":"test-saved-key"}');
    expect(ipc.testLLMResponse).toHaveBeenCalledWith("openai", "gpt-4o");
    expect(ipc.setActiveModel.mock.invocationCallOrder[0]).toBeLessThan(ipc.testLLMResponse.mock.invocationCallOrder[0]);
    expect(ipc.storeApiKey).not.toHaveBeenCalled();
    expect(useLiveQAHealthStore.getState().aiReadyModels.openai).toBe("gpt-4o");
  });

  it("does not recover active health when saved credentials change during a response test", async () => {
    let complete: (success: boolean) => void = () => {};
    ipc.testLLMResponse.mockReturnValueOnce(new Promise<boolean>((resolve) => { complete = resolve; }));
    ipc.getApiKey.mockResolvedValue("test-saved-key");
    useConfigStore.setState({ llmProvider: "openai", llmModel: "gpt-4o", lastModelByProvider: { openai: "gpt-4o" } });
    useStreamStore.getState().setPending("AskQuestion", "failed", "openai", "Why?", "gpt-4o");
    useStreamStore.getState().setError("401 invalid API key");
    const activeError = useStreamStore.getState().error;
    render(<LLMSettings />);
    await waitFor(() => expect(screen.getByPlaceholderText("Enter OpenAI API key")).toHaveValue("test-saved-key"));
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await waitFor(() => expect(ipc.testLLMResponse).toHaveBeenCalledWith("openai", "gpt-4o"));
    ipc.getApiKey.mockResolvedValue("test-new-saved-key");
    await act(async () => { complete(true); });
    expect(await screen.findByRole("alert", { name: "AI response test" })).toHaveTextContent("Saved credentials changed");
    expect(useStreamStore.getState().error).toBe(activeError);
    expect(useLiveQAHealthStore.getState().aiReadyModels.openai).toBeUndefined();
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
  });

  it("does not test or recover a model changed while active reconfiguration awaits", async () => {
    let applied: () => void = () => {};
    ipc.setActiveModel.mockReturnValueOnce(new Promise<void>((resolve) => { applied = resolve; }));
    useStreamStore.getState().setError("credits exhausted", { code: "credits_exhausted" });
    const activeError = useStreamStore.getState().error;
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await waitFor(() => expect(ipc.setActiveModel).toHaveBeenCalled());
    act(() => useConfigStore.getState().setLLMModel("different-model", "ollama"));
    await act(async () => { applied(); });
    expect(ipc.testLLMResponse).not.toHaveBeenCalled();
    expect(useStreamStore.getState().error).toBe(activeError);
    expect(useLiveQAHealthStore.getState().aiReadyModels).toEqual({});
  });

  it("does not clear a serving fallback provider's error when the requested primary passes", async () => {
    useStreamStore.getState().setPending("AskQuestion", "fallback", "ollama", "Why?", "llama3.2");
    useStreamStore.getState().applyProfileFallback({
      request_id: "fallback", from_provider: "ollama", from_model: "llama3.2",
      to_provider: "openai", to_model: "gpt-4o", reason: "unavailable",
    });
    useStreamStore.getState().setError("401 invalid API key");
    const activeError = useStreamStore.getState().error;
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await screen.findByRole("status", { name: "AI response test" });
    expect(useStreamStore.getState().error).toBe(activeError);
    expect(useStreamStore.getState().currentProvider).toBe("openai");
    expect(useLiveQAHealthStore.getState().aiReadyModels.ollama).toBe("llama3.2");
  });

  it("invalidates generation proof only when the actual active response test fails", async () => {
    useLiveQAHealthStore.getState().markAIReady("ollama", "llama3.2");
    ipc.testLLMResponse.mockRejectedValueOnce(new Error("401 invalid API key"));
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await screen.findByRole("alert", { name: "AI response test" });
    expect(ipc.testLLMResponse).toHaveBeenCalledWith("ollama", "llama3.2");
    expect(useLiveQAHealthStore.getState().aiReadyModels.ollama).toBeUndefined();
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Failed", error: null },
    { label: "Credits exhausted", error: "429 credit_balance_exhausted" },
  ])("shows $label after a failed active test instead of reusing an older answer's Ready state", async ({ label, error }) => {
    const stream = useStreamStore.getState();
    stream.setPending("AskQuestion", "older-answer", "ollama", "Earlier question", "llama3.2");
    stream.startStream("AskQuestion", "llama3.2", "ollama", { requestId: "older-answer" });
    stream.appendToken("An earlier valid answer.");
    stream.endStream(20);
    const { result } = renderHook(() => useLiveQAHealth());
    expect(result.current.ai.label).toBe("Ready");
    if (error) ipc.testLLMResponse.mockRejectedValueOnce(new Error(error));
    else ipc.testLLMResponse.mockResolvedValueOnce(false);
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await screen.findByRole("alert", { name: "AI response test" });
    expect(result.current.ai.label).toBe(label);
    expect(result.current.question.label).toBe("Answer ready");
    expect(useStreamStore.getState().responseHistory[0].content).toBe("An earlier valid answer.");

    act(() => {
      stream.setPending("AskQuestion", "recovered-answer", "ollama", "New question", "llama3.2");
      stream.startStream("AskQuestion", "llama3.2", "ollama", { requestId: "recovered-answer" });
      stream.appendToken("A new real response.");
      stream.endStream(20);
    });
    await waitFor(() => expect(result.current.ai.label).toBe("Ready"));
  });

  it("discards stale diagnostic completion before any active-health recovery", async () => {
    let complete: (success: boolean) => void = () => {};
    ipc.testLLMResponse.mockReturnValueOnce(new Promise<boolean>((resolve) => { complete = resolve; }));
    useStreamStore.getState().setError("credits exhausted", { code: "credits_exhausted" });
    const activeError = useStreamStore.getState().error;
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await waitFor(() => expect(ipc.testLLMResponse).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /^Groq\b/ }));
    await act(async () => { complete(true); });
    expect(screen.queryByLabelText("AI response test")).toBeNull();
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
    expect(useStreamStore.getState().error).toBe(activeError);
    expect(useLiveQAHealthStore.getState().aiReadyModels).toEqual({});
  });

  it("does not invalidate operational proof when viewing settings or an isolated diagnostic fails", async () => {
    useConfigStore.setState({ llmProvider: "openai", llmModel: "gpt-4o", lastModelByProvider: { openai: "gpt-4o" } });
    useLiveQAHealthStore.getState().markAIReady("openai", "gpt-4o");
    ipc.testLLMResponse.mockRejectedValueOnce(new Error("401 diagnostic credentials"));
    render(<LLMSettings />);
    expect(useLiveQAHealthStore.getState().aiReadyModels.openai).toBe("gpt-4o");
    fireEvent.change(await screen.findByPlaceholderText("Enter OpenAI API key"), { target: { value: "test-unsaved-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await screen.findByRole("alert", { name: "AI response test" });
    expect(useLiveQAHealthStore.getState().aiReadyModels.openai).toBe("gpt-4o");
    expect(ipc.setLLMProvider).not.toHaveBeenCalled();
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
  });

  it("offers Claude's public response test using its Fast model, without activation", async () => {
    render(<LLMSettings />);
    fireEvent.click(claudeCard());
    await screen.findByText("me@example.com · Max");
    const button = screen.getByRole("button", { name: "Test AI response" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await screen.findByRole("status", { name: "AI response test" });
    expect(ipc.testLLMResponse).toHaveBeenCalledWith('{"provider_type":"claude_cli"}', DEFAULT_CLAUDE_CLI_CONFIG.fast_model);
    expect(ipc.setLLMProvider).not.toHaveBeenCalled();
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
    expect(useLiveQAHealthStore.getState().aiReadyModels.claude_cli).toBeUndefined();
  });

  it.each([
    { active: false, model: "auto" },
    { active: true, model: "claude-sonnet-5.5" },
  ])("offers Copilot's public response test for the saved/active model (active: $active)", async ({ active, model }) => {
    if (active) useConfigStore.setState({
      llmProvider: "github_copilot", llmModel: model, lastModelByProvider: { github_copilot: model },
    });
    render(<LLMSettings />);
    if (!active) fireEvent.click(await screen.findByRole("button", { name: /^GitHub Copilot,/ }));
    const button = screen.getByRole("button", { name: "Test AI response" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await screen.findByRole("status", { name: "AI response test" });
    expect(ipc.testLLMResponse).toHaveBeenCalledWith(active ? "github_copilot" : '{"provider_type":"github_copilot"}', model);
    if (!active) expect(ipc.setLLMProvider).not.toHaveBeenCalled();
    expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
    expect(useLiveQAHealthStore.getState().aiReadyModels.github_copilot).toBe(active ? model : undefined);
  });

  it("tests active Claude only after applying its saved CLI configuration", async () => {
    useConfigStore.setState({ llmProvider: "claude_cli", llmModel: DEFAULT_CLAUDE_CLI_CONFIG.fast_model });
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await screen.findByRole("status", { name: "AI response test" });
    expect(ipc.setClaudeCliConfig).toHaveBeenCalledWith(DEFAULT_CLAUDE_CLI_CONFIG);
    expect(ipc.setClaudeCliConfig.mock.invocationCallOrder[0]).toBeLessThan(ipc.setLLMProvider.mock.invocationCallOrder[0]);
    expect(ipc.testLLMResponse).toHaveBeenCalledWith("claude_cli", DEFAULT_CLAUDE_CLI_CONFIG.fast_model);
    expect(useLiveQAHealthStore.getState().aiReadyModels.claude_cli).toBe(DEFAULT_CLAUDE_CLI_CONFIG.fast_model);
    expect(useConfigStore.getState().claudeCliConfig).toEqual(DEFAULT_CLAUDE_CLI_CONFIG);
  });

  it("does not clear or verify a newer provider failure that arrives during an active test", async () => {
    let complete: (success: boolean) => void = () => {};
    ipc.testLLMResponse.mockReturnValueOnce(new Promise<boolean>((resolve) => { complete = resolve; }));
    render(<LLMSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
    await waitFor(() => expect(ipc.testLLMResponse).toHaveBeenCalled());
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "new-failure", "ollama", "Why?", "llama3.2");
      useStreamStore.getState().setError("credits exhausted", { code: "credits_exhausted" });
    });
    const activeError = useStreamStore.getState().error;
    await act(async () => { complete(true); });
    expect(useStreamStore.getState().error).toBe(activeError);
    expect(useLiveQAHealthStore.getState().aiReadyModels.ollama).toBeUndefined();
  });

  describe("Custom endpoint", () => {
    const OLLAMA_CLOUD = { provider_type: "custom", base_url: "https://ollama.com/v1" };

    beforeEach(() => {
      useConfigStore.setState({
        llmProvider: "custom",
        llmModel: "gemma4:31b-cloud",
        lastModelByProvider: { custom: "gemma4:31b-cloud" },
        customLlmBaseUrl: OLLAMA_CLOUD.base_url,
        customLlmAuthType: "bearer",
      });
    });

    // Reported: a new token was saved but the custom endpoint in use kept
    // the old one (401) until NexQ restarted; the pasted key had spaces too.
    it("a token changed while Custom is in use applies at once, without spaces around it", async () => {
      render(<LLMSettings />);
      const token = await screen.findByPlaceholderText("Bearer token...");
      fireEvent.change(token, { target: { value: "  the-key \t" } });
      fireEvent.blur(token);
      await waitFor(() =>
        expect(ipc.setLLMProvider).toHaveBeenLastCalledWith(
          JSON.stringify({ ...OLLAMA_CLOUD, auth_type: "bearer", auth_value: "the-key" }),
        ),
      );
      expect(ipc.storeApiKey).toHaveBeenCalledWith("custom", "the-key");
      expect(token).toHaveValue("the-key");
    });

    it("a changed auth type applies at once", async () => {
      render(<LLMSettings />);
      await screen.findByPlaceholderText("Bearer token...");
      fireEvent.change(screen.getByDisplayValue("Bearer Token"), { target: { value: "none" } });
      await waitFor(() => expect(ipc.setLLMProvider).toHaveBeenLastCalledWith(JSON.stringify(OLLAMA_CLOUD)));
    });

    it("while another provider is in use, a token is only saved", async () => {
      useConfigStore.setState({ llmProvider: "ollama", llmModel: "llama3.2" });
      render(<LLMSettings />);
      fireEvent.click(screen.getByRole("button", { name: /^Custom\b/ }));
      const token = await screen.findByPlaceholderText("Bearer token...");
      fireEvent.change(token, { target: { value: "the-key" } });
      fireEvent.blur(token);
      await waitFor(() => expect(ipc.storeApiKey).toHaveBeenCalledWith("custom", "the-key"));
      expect(ipc.setLLMProvider).not.toHaveBeenCalled();
    });

    it("does not treat successful draft credentials as router recovery after custom activation failed", async () => {
      useStreamStore.getState().setError("401 invalid API key");
      const activeError = useStreamStore.getState().error;
      ipc.setLLMProvider.mockRejectedValueOnce(new Error("Custom config was not applied"));
      render(<LLMSettings />);
      const token = await screen.findByPlaceholderText("Bearer token...");
      fireEvent.change(token, { target: { value: "test-new-token" } });
      fireEvent.blur(token);
      await waitFor(() => expect(ipc.setLLMProvider).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Test AI response" }));
      await screen.findByRole("status", { name: "AI response test" });
      expect(ipc.testLLMResponse).toHaveBeenCalledWith(
        JSON.stringify({ ...OLLAMA_CLOUD, auth_type: "bearer", auth_value: "test-new-token" }), "gemma4:31b-cloud",
      );
      expect(ipc.clearProviderCreditFailure).not.toHaveBeenCalled();
      expect(useStreamStore.getState().error).toBe(activeError);
      expect(useLiveQAHealthStore.getState().aiReadyModels.custom).toBeUndefined();
    });
  });

  it("the bottom 'Set as Active' button takes the same path", async () => {
    render(
      <>
        <LLMSettings />
        <ServiceStatusBar />
      </>,
    );
    fireEvent.click(claudeCard());
    await screen.findByText("me@example.com · Max");
    fireEvent.click(screen.getByRole("button", { name: /set claude \(subscription\) as active provider/i }));
    await waitFor(() => expect(footerShowsClaude()).toBe(true));
    expect(ipc.setActiveModel).toHaveBeenCalledWith("claude_cli", "haiku");
  });

  it("after an answer has streamed, the footer shows the newly activated provider, not the last stream's", async () => {
    // An answer streamed with Groq earlier in the meeting; the stream store
    // keeps its provider/model until the meeting ends.
    useConfigStore.setState({ llmProvider: "groq", llmModel: "llama-3.3-70b", lastModelByProvider: { groq: "llama-3.3-70b", openai: "gpt-4o" } });
    useStreamStore.setState({ isStreaming: false, currentProvider: "groq", currentModel: "llama-3.3-70b" });
    render(<ServiceStatusBar />);

    await act(async () => {
      await useConfigStore.getState().activateLLMProvider("openai");
    });
    const chip = screen.getByTitle(/^LLM:/);
    expect(chip).toHaveAttribute("title", expect.stringContaining("OpenAI"));
    expect(chip).not.toHaveAttribute("title", expect.stringContaining("Groq"));

    // While an answer streams, the chip names what actually serves it.
    act(() => useStreamStore.setState({ isStreaming: true, currentProvider: "ollama", currentModel: "llama3.2" }));
    expect(screen.getByTitle(/^LLM:/)).toHaveAttribute("title", expect.stringContaining("Ollama"));
    act(() => useStreamStore.setState({ isStreaming: false, currentProvider: "", currentModel: "" }));
  });

  it("a provider switched in the footer is reflected in open Settings", async () => {
    render(<LLMSettings />);
    // Settings opened while Ollama is active: Ollama is the selected card.
    expect(screen.getByRole("button", { name: /^Ollama/ })).toHaveAttribute("aria-pressed", "true");

    // The footer in the other window switches to Claude; the store's
    // cross-window sync (onKeyChange) applies it here.
    act(() => useConfigStore.setState({ llmProvider: "claude_cli", llmModel: "haiku" }));

    expect(screen.getByText(/Active: Claude \(subscription\)/)).toBeInTheDocument();
    // Settings shows the provider that is actually active...
    expect(claudeCard()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Ollama/ })).toHaveAttribute("aria-pressed", "false");
    // ...and doesn't offer to "activate" the provider that was just replaced.
    expect(screen.queryByRole("button", { name: /set .* as active provider/i })).not.toBeInTheDocument();
  });
});
