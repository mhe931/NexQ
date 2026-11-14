import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/profileIpc", async () => ({ profileIpc: (await import("../test/profileFixtures")).profileIpcMock }));

import { useProfileStore } from "./profileStore";
import { makeProfile, makeSlide, profileIpcMock as ipc, resetProfileIpcMock } from "../test/profileFixtures";

const A = makeProfile({ id: "A", name: "Meeting A", systemPrompt: "Prompt of A", ai: { ...makeProfile().ai, primaryProvider: "openai", primaryModel: "gpt-4o" } });
const B = makeProfile({ id: "B", name: "Meeting B", systemPrompt: "Prompt of B", meetingType: "interview", template: "technical_interview", ai: { ...makeProfile().ai, primaryProvider: "groq", primaryModel: "llama-3" } });
const docA = { id: "dA", profileId: "A", name: "a.pdf" };
const docB = { id: "dB", profileId: "B", name: "b.md" };

beforeEach(() => {
  resetProfileIpcMock();
  useProfileStore.getState().close();
  useProfileStore.setState({ summaries: [], catalog: null, busy: false });
  ipc.get.mockImplementation(async (id: string) => (id === "A" ? A : B));
  ipc.documents.mockImplementation(async (id: string) => (id === "A" ? [docA] : [docB]));
  ipc.slides.mockImplementation(async (id: string) => (id === "A" ? [makeSlide(1, "A notes")] : []));
});

afterEach(() => useProfileStore.getState().close());

describe("profile store isolation", () => {
  it("never shows meeting A's documents, slides, prompt or provider while B is open", async () => {
    await useProfileStore.getState().open("A");
    expect(useProfileStore.getState().documents).toEqual([docA]);
    expect(useProfileStore.getState().slides).toHaveLength(1);

    const pending = useProfileStore.getState().open("B");
    // While B loads, nothing of A is left on screen.
    expect(useProfileStore.getState().current).toBeNull();
    expect(useProfileStore.getState().documents).toEqual([]);
    expect(useProfileStore.getState().slides).toEqual([]);
    await pending;

    const s = useProfileStore.getState();
    expect(s.current?.id).toBe("B");
    expect(s.current?.systemPrompt).toBe("Prompt of B");
    expect(s.current?.ai.primaryProvider).toBe("groq");
    expect(s.documents).toEqual([docB]);
    expect(s.slides).toEqual([]);
    expect(s.lastReport).toBeNull();
    expect(s.dirty).toBe(false);
  });

  it("saves each meeting with its own provider, model and prompt", async () => {
    await useProfileStore.getState().open("A");
    useProfileStore.getState().patch({ additionalInstructions: "only A" });
    expect(useProfileStore.getState().dirty).toBe(true);
    await useProfileStore.getState().save();

    await useProfileStore.getState().open("B");
    useProfileStore.getState().patch((p) => ({ ...p, ai: { ...p.ai, primaryModel: "mixtral" } }));
    await useProfileStore.getState().save();

    const [savedA, savedB] = ipc.save.mock.calls.map((c) => c[0]);
    expect(savedA).toMatchObject({ id: "A", systemPrompt: "Prompt of A", additionalInstructions: "only A", ai: { primaryProvider: "openai", primaryModel: "gpt-4o" } });
    expect(savedB).toMatchObject({ id: "B", systemPrompt: "Prompt of B", additionalInstructions: "", ai: { primaryProvider: "groq", primaryModel: "mixtral" } });
    expect(savedA).not.toEqual(savedB);
  });

  it("drops a late reply for a meeting that is no longer open", async () => {
    let releaseA: (p: typeof A) => void = () => {};
    ipc.get.mockImplementation((id: string) => (id === "A" ? new Promise((r) => { releaseA = r; }) : Promise.resolve(B)));

    const slowA = useProfileStore.getState().open("A");
    await useProfileStore.getState().open("B");
    releaseA(A);
    await slowA;

    expect(useProfileStore.getState().current?.id).toBe("B");
    expect(useProfileStore.getState().documents).toEqual([docB]);
  });

  it("keeps unsaved edits when documents change the stored source folders", async () => {
    await useProfileStore.getState().open("A");
    useProfileStore.getState().patch({ name: "Renamed, unsaved" });
    const folder = { id: "f1", path: "C:\\docs", kind: "local" as const, label: "docs", recursive: true };
    ipc.addFolder.mockResolvedValue({ added: ["x.md"], updated: [], unchanged: [], duplicates: [], failed: [], skipped: [], missing: [] });
    ipc.get.mockResolvedValue({ ...A, sourceFolders: [folder] });

    await useProfileStore.getState().addFolder("C:\\docs", "local");

    const s = useProfileStore.getState();
    expect(s.current?.name).toBe("Renamed, unsaved");
    expect(s.current?.sourceFolders).toEqual([folder]);
    expect(s.lastReport?.added).toEqual(["x.md"]);
    expect(s.dirty).toBe(true);
  });

  it("creates a meeting without inheriting the previous one", async () => {
    await useProfileStore.getState().open("A");
    ipc.create.mockResolvedValue(makeProfile({ id: "C", name: "New meeting" }));
    const created = await useProfileStore.getState().create("New meeting", "academic_qa");
    expect(created?.id).toBe("C");
    expect(useProfileStore.getState().documents).toEqual([]);
    expect(useProfileStore.getState().current?.ai.primaryProvider).toBeNull();
  });

  it("reports backend save errors and stays dirty", async () => {
    await useProfileStore.getState().open("A");
    useProfileStore.getState().patch({ systemPrompt: "sk-abcdefghijklmnopqrstuvwxyz123456" });
    ipc.save.mockRejectedValue("The system prompt looks like it contains an API key or token.");
    expect(await useProfileStore.getState().save()).toBe(false);
    expect(useProfileStore.getState().error).toContain("API key");
    expect(useProfileStore.getState().dirty).toBe(true);
  });
});
