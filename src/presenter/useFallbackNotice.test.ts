import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { fallbackMessage, useFallbackNotice } from "./useFallbackNotice";
import { useStreamStore } from "../stores/streamStore";
import type { FallbackNotice } from "../lib/profileTypes";

const notice: FallbackNotice = {
  request_id: "r1", from_provider: "openai", from_model: "gpt-4o",
  to_provider: "groq", to_model: "llama", reason: "credits_exhausted",
};

describe("fallback presentation", () => {
  beforeEach(() => useStreamStore.getState().resetForMeeting());

  it.each([
    ["credits_exhausted", "credits exhausted"],
    ["rate_limited", "rate limited"],
    ["timeout", "request timed out"],
    ["auth", "authentication required"],
    ["unavailable", "provider unavailable"],
    ["other", "provider could not answer"],
  ])("translates %s without raw enum underscores", (reason, readable) => {
    expect(fallbackMessage({ ...notice, reason })).toBe(`Switched to groq — openai: ${readable}.`);
  });

  it("does not display arbitrary reason text", () => {
    expect(fallbackMessage({ ...notice, reason: '{"private":"secret"}' })).toBe("Switched to groq — openai: provider could not answer.");
  });

  it("shows only correlated notices, supports dismissal, and clears on the next request", () => {
    const { result } = renderHook(() => useFallbackNotice());
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "r1", "openai");
      useStreamStore.getState().applyProfileFallback({ ...notice, request_id: "old" });
    });
    expect(result.current.notice).toBeNull();
    act(() => useStreamStore.getState().applyProfileFallback(notice));
    expect(result.current.notice).toBe(notice);
    act(() => result.current.dismiss());
    expect(result.current.notice).toBeNull();
    act(() => {
      useStreamStore.getState().clearPending("r1");
      useStreamStore.getState().setPending("AskQuestion", "r2", "openai");
    });
    expect(result.current.notice).toBeNull();
  });
});
