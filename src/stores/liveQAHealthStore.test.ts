import { beforeEach, describe, expect, it } from "vitest";
import { useLiveQAHealthStore } from "./liveQAHealthStore";

describe("independent physical capture observations", () => {
  beforeEach(() => useLiveQAHealthStore.getState().reset());

  it("keeps a failed channel separate from the channel still capturing", () => {
    const health = useLiveQAHealthStore.getState();
    health.observeAudioStatus("you", { status: "active" });
    health.observeAudioStatus("them", { status: "device_unavailable" });
    health.audioFailed("Generic capture warning");
    expect(useLiveQAHealthStore.getState().audio).toEqual({
      you: { status: "active" }, them: { status: "device_unavailable" },
    });
    expect(useLiveQAHealthStore.getState().stt).toEqual({ you: null, them: null });
  });

  it("does not let buffered levels resurrect failed or paused capture; an explicit recovery can", () => {
    const health = useLiveQAHealthStore.getState();
    health.observeAudioStatus("them", { status: "permission_denied" });
    health.observeAudio("them", 2000);
    expect(useLiveQAHealthStore.getState().audio.them?.status).toBe("permission_denied");
    health.observeAudioStatus("them", { status: "paused" });
    health.observeAudio("them", 3000);
    expect(useLiveQAHealthStore.getState().audio.them?.status).toBe("paused");
    health.observeAudioStatus("them", { status: "active" });
    expect(useLiveQAHealthStore.getState().audio.them).toEqual({ status: "active" });
  });
});
