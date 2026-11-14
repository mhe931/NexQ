import { beforeEach, expect, it, vi } from "vitest";
import type { RagConfig } from "../lib/types";

const fixture = vi.hoisted(() => ({
  saved: {} as Record<string, unknown>,
  strategy: "local_rag",
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => fixture.saved[key],
    set: async (key: string, value: unknown) => { fixture.saved[key] = value; },
    save: async () => {},
  }),
}));
vi.mock("./configStore", () => ({
  useConfigStore: { getState: () => ({ contextStrategy: fixture.strategy }) },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "get_rag_config") return {
      enabled: false, embedding_model: "unused", ollama_url: "http://127.0.0.1:1",
      batch_size: 32, chunk_size: 512, chunk_overlap: 64, splitting_strategy: "recursive",
      top_k: 5, search_mode: "hybrid", similarity_threshold: 0.3,
      semantic_weight: 0.7, include_transcript: true, embedding_dimensions: 768,
    };
    if (command === "update_rag_config") return;
    throw new Error(`Unexpected IPC: ${command}`);
  },
}));

beforeEach(() => {
  vi.resetModules();
  fixture.saved = {};
  fixture.strategy = "local_rag";
});

it.each(["saveRagConfig", "saveRagConfigWithStaleCheck"] as const)(
  "%s survives a new store instance without reverting to hybrid retrieval",
  async (save) => {
    const { useRagStore } = await import("./ragStore");
    await useRagStore.getState().loadRagConfig();
    const original = useRagStore.getState().ragConfig!;
    const keyword: RagConfig = {
      ...original, search_mode: "keyword", chunk_size: 384, top_k: 6,
      include_transcript: false,
    };
    if (save === "saveRagConfig") {
      await useRagStore.getState().saveRagConfig(keyword);
    } else {
      await useRagStore.getState().saveRagConfigWithStaleCheck(keyword, original);
    }
    vi.resetModules();
    const restarted = (await import("./ragStore")).useRagStore;
    await restarted.getState().loadRagConfig();
    expect(restarted.getState().error).toBeNull();
    expect(restarted.getState().ragConfig).toMatchObject({
      enabled: true, search_mode: "keyword", chunk_size: 384, top_k: 6,
      include_transcript: false,
    });
  },
);
