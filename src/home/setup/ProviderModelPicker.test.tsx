import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));

const ipc = vi.hoisted(() => ({
  getApiKey: vi.fn(),
  listModels: vi.fn(),
  testLLMConnection: vi.fn(),
}));
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  getApiKey: (...args: unknown[]) => ipc.getApiKey(...args),
  listModels: (...args: unknown[]) => ipc.listModels(...args),
  testLLMConnection: (...args: unknown[]) => ipc.testLLMConnection(...args),
}));

import { MEETING_PROVIDERS, ProviderModelPicker, providerLabel } from "./ProviderModelPicker";
import { useConfigStore } from "../../stores/configStore";

describe("ProviderModelPicker: GitHub Copilot", () => {
  beforeEach(() => {
    useConfigStore.setState({ verifiedCloudProviders: [] });
    ipc.getApiKey.mockReset().mockResolvedValue("should-never-be-read");
    ipc.listModels.mockReset().mockResolvedValue([{ id: "auto", name: "Auto" }, { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" }]);
    ipc.testLLMConnection.mockReset().mockResolvedValue(true);
  });
  afterEach(() => cleanup());

  it("is listed as a cloud (non-local) provider", () => {
    const copilot = MEETING_PROVIDERS.find((p) => p.id === "github_copilot");
    expect(copilot).toEqual({ id: "github_copilot", label: "GitHub Copilot", local: false });
    expect(providerLabel("github_copilot")).toBe("GitHub Copilot");
  });

  it("is only offered once verified, unless it is the current choice", () => {
    const { unmount } = render(
      <ProviderModelPicker idPrefix="p" label="Primary" provider={null} model={null} onChange={() => {}} onOpenGlobal={() => {}} />,
    );
    expect(screen.queryByRole("option", { name: /GitHub Copilot/ })).not.toBeInTheDocument();
    unmount();
    useConfigStore.setState({ verifiedCloudProviders: ["github_copilot"] });
    render(<ProviderModelPicker idPrefix="p" label="Primary" provider={null} model={null} onChange={() => {}} onOpenGlobal={() => {}} />);
    expect(screen.getByRole("option", { name: "GitHub Copilot" })).toBeInTheDocument();
  });

  it("explains the CLI sign-in (not an API key) when unverified", () => {
    render(<ProviderModelPicker idPrefix="p" label="Primary" provider="github_copilot" model={null} onChange={() => {}} onOpenGlobal={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Sign in with the official CLI and run Check connection/);
    expect(screen.getByRole("status")).not.toHaveTextContent(/key/i);
  });

  it("loads the live models and tests the connection without ever reading an API key", async () => {
    render(<ProviderModelPicker idPrefix="p" label="Primary" provider="github_copilot" model={null} withTest onChange={() => {}} onOpenGlobal={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Load models" }));
    await waitFor(() => expect(ipc.listModels).toHaveBeenCalledTimes(1));
    expect(JSON.parse(ipc.listModels.mock.calls[0][0] as string)).toEqual({ provider_type: "github_copilot" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(ipc.testLLMConnection).toHaveBeenCalledTimes(1));
    expect(JSON.parse(ipc.testLLMConnection.mock.calls[0][0] as string)).toEqual({ provider_type: "github_copilot" });
    expect(ipc.getApiKey).not.toHaveBeenCalled();
  });
});
