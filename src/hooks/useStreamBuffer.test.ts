import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (payload: unknown) => void;
const { handlers, register } = vi.hoisted(() => {
  const handlers: Record<string, Handler> = {};
  const register = (name: string) => (handler: Handler) => {
    handlers[name] = handler;
    return Promise.resolve(() => {
      delete handlers[name];
    });
  };
  return { handlers, register };
});

vi.mock("../lib/events", () => ({
  onStreamStart: register("start"),
  onStreamToken: register("token"),
  onStreamEnd: register("end"),
  onStreamSources: register("sources"),
  onStreamError: register("error"),
  onStreamThinking: register("thinking"),
  onQuestionHandlingStatus: register("handling"),
  onProfileFallback: register("fallback"),
}));

import { useStreamBuffer } from "./useStreamBuffer";
import { useStreamStore } from "../stores/streamStore";
import { useConfigStore } from "../stores/configStore";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";
import { useQuestionStore } from "../stores/questionStore";

const start = (mode: string, request_id: string) =>
  handlers.start({ mode, model: "m", provider: "p", request_id });

describe("useStreamBuffer", () => {
  beforeEach(() => {
    useStreamStore.getState().resetForMeeting();
    useLiveQAHealthStore.getState().reset();
  });

  it("shows only the stream whose start it accepted", async () => {
    renderHook(() => useStreamBuffer());
    await waitFor(() => expect(handlers.end).toBeDefined());

    act(() => {
      start("Assist", "live");
      handlers.token({ token: "Hello", request_id: "live" });
      handlers.token({ token: " leaked", request_id: "someone-else" });
      handlers.end({ total_tokens: 1, latency_ms: 5, request_id: "live" });
    });

    const state = useStreamStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.responseHistory[0]?.content).toBe("Hello");
  });

  it("settles only the matching pending question when retrieval is cancelled before stream start", () => {
    renderHook(() => useStreamBuffer());
    const questions = useQuestionStore.getState();
    questions.clear();
    questions.addQuestion({ text: "Why?", source: "Them", confidence: 1, timestamp_ms: 1 }, "line");
    questions.trackAnswer("line", "Why?", "pending");
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "pending");
      handlers.handling({ request_id: "pending", status: "retrieving_context" });
      handlers.end({ request_id: "other", cancelled: true, latency_ms: 0 });
    });
    expect(useStreamStore.getState().pendingRequestId).toBe("pending");
    act(() => handlers.end({ request_id: "pending", cancelled: true, latency_ms: 0 }));
    expect(useStreamStore.getState()).toMatchObject({
      pendingRequestId: null, handlingStatus: null, phase: "idle", answerOutcome: "cancelled", error: null,
    });
    expect(useQuestionStore.getState().questions[0]).toMatchObject({
      assisted: false, heldBack: true, answerRequestId: undefined, answerStatus: undefined,
    });
    act(() => useStreamStore.getState().setPending("AskQuestion", "retry"));
    expect(useStreamStore.getState().pendingRequestId).toBe("retry");
  });

  it("shows thinking until the first words of its own stream", async () => {
    useStreamStore.getState().resetForMeeting();
    renderHook(() => useStreamBuffer());
    await waitFor(() => expect(handlers.thinking).toBeDefined());

    act(() => {
      start("Assist", "live");
      handlers.thinking({ request_id: "someone-else" });
    });
    expect(useStreamStore.getState().phase).toBe("waiting");

    act(() => handlers.thinking({ request_id: "live" }));
    expect(useStreamStore.getState().phase).toBe("thinking");
  });

  it("carries the start details into the store and records the click time per mode", async () => {
    useStreamStore.getState().resetForMeeting();
    renderHook(() => useStreamBuffer());
    await waitFor(() => expect(handlers.end).toBeDefined());

    act(() => {
      useStreamStore.getState().setPending("FollowUp", "r1");
    });
    const clickedAt = useStreamStore.getState().requestStartedAt;
    act(() => {
      handlers.start({
        mode: "FollowUp",
        model: "haiku",
        provider: "Claude CLI",
        request_id: "r1",
        scope_label: "Last 5 min",
        transcript_segments_count: 0,
        session_key: "live:m:fast",
      });
    });

    const state = useStreamStore.getState();
    expect(state.phase).toBe("waiting");
    expect(state.streamMeta).toMatchObject({ scopeLabel: "Last 5 min", newLines: 0, sessionKey: "live:m:fast" });
    expect(state.lastUserRequest.byMode.FollowUp).toBe(clickedAt);
    expect(state.lastUserRequest.anyAt).toBe(clickedAt);
  });

  it("ignores past-meeting generations and their errors", async () => {
    renderHook(() => useStreamBuffer());
    await waitFor(() => expect(handlers.end).toBeDefined());

    act(() => {
      start("MeetingSummary", "past");
      handlers.token({ token: "summary", request_id: "past" });
      handlers.error({ message: "boom", request_id: "past" });
    });

    const state = useStreamStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.currentContent).toBe("");
    expect(state.error).toBeNull();
    expect(state.lastUserRequest.byMode.MeetingSummary).toBeUndefined();
  });

  it("accepts a pending request's pre-stream error, safely, but ignores another request", async () => {
    useStreamStore.getState().resetForMeeting();
    renderHook(() => useStreamBuffer());
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "typed");
      handlers.error({ request_id: "other", message: "401 secret" });
    });
    expect(useStreamStore.getState().error).toBeNull();
    act(() => handlers.error({ request_id: "typed", message: '{"error":"401 Unauthorized","key":"secret"}' }));
    expect(useStreamStore.getState().phase).toBe("idle");
    expect(useStreamStore.getState().error).toBe("AI authentication required. Check provider sign-in or credentials.");
  });

  it("distinguishes actual retrieval from generation for the current request only", () => {
    useStreamStore.getState().resetForMeeting();
    renderHook(() => useStreamBuffer());
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "typed");
      handlers.handling({ request_id: "other", status: "generating_answer" });
    });
    expect(useStreamStore.getState().handlingStatus).toBeNull();
    act(() => handlers.handling({ request_id: "typed", status: "retrieving_context" }));
    expect(useStreamStore.getState().handlingStatus).toBe("retrieving_context");
    act(() => handlers.handling({ request_id: "typed", status: "generating_answer" }));
    expect(useStreamStore.getState().handlingStatus).toBe("generating_answer");
  });

  it("uses structured errors and treats cancellation as stopped, not failure", () => {
    useStreamStore.getState().resetForMeeting();
    renderHook(() => useStreamBuffer());
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "typed");
      handlers.error({ request_id: "typed", message: "429 private body", code: "credits_exhausted", retryable: false });
    });
    expect(useStreamStore.getState()).toMatchObject({ error: "AI credits exhausted. Check provider billing.", errorRetryable: false });
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "next");
      handlers.error({ request_id: "next", message: "private body", code: "cancelled", retryable: false });
    });
    expect(useStreamStore.getState()).toMatchObject({ error: null, phase: "idle", answerOutcome: "cancelled" });
  });

  it("correlates a fallback before tokens, preserving the token buffer and primary attribution", () => {
    useConfigStore.setState({ llmProvider: "openai" });
    useLiveQAHealthStore.getState().markAIReady("openai", "gpt-4o");
    renderHook(() => useStreamBuffer());
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "typed", "openai", "Why?", "gpt-4o");
      handlers.start({ mode: "AskQuestion", model: "gpt-4o", provider: "OpenAI", request_id: "typed" });
      handlers.token({ token: "Hello", request_id: "typed" });
      handlers.fallback({ request_id: "typed", from_provider: "OpenAI", from_model: "gpt-4o", to_provider: "groq", to_model: "llama", reason: "credits_exhausted" });
      handlers.token({ token: " world", request_id: "typed" });
      handlers.end({ latency_ms: 5, request_id: "typed" });
    });
    expect(useStreamStore.getState()).toMatchObject({ currentContent: "Hello world", currentProvider: "groq", currentModel: "llama", requestProvider: "openai", requestModel: "gpt-4o" });
    expect(useStreamStore.getState().responseHistory[0]).toMatchObject({ content: "Hello world", provider: "groq", model: "llama" });
    expect(useLiveQAHealthStore.getState().aiReadyModels.openai).toBeUndefined();
  });

  it("accepts only a known pending fallback and retains it through stream start", () => {
    renderHook(() => useStreamBuffer());
    const notice = { request_id: "typed", from_provider: "openai", from_model: "gpt-4o", to_provider: "groq", to_model: "llama", reason: "rate_limited" };
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "typed", "openai", "Why?", "gpt-4o");
      handlers.fallback({ ...notice, request_id: "old" });
      handlers.fallback({ ...notice, request_id: null });
    });
    expect(useStreamStore.getState().profileFallback).toBeNull();
    act(() => handlers.fallback(notice));
    expect(useStreamStore.getState()).toMatchObject({ pendingRequestId: "typed", phase: "sending", currentProvider: "groq" });
    act(() => handlers.start({ mode: "AskQuestion", provider: "openai", model: "gpt-4o", request_id: "typed" }));
    expect(useStreamStore.getState()).toMatchObject({ currentProvider: "groq", currentModel: "llama", streamMeta: { provider: "groq", model: "llama" } });
    act(() => handlers.end({ latency_ms: 5, request_id: "typed" }));
    const completed = useStreamStore.getState();
    act(() => handlers.fallback({ ...notice, to_provider: "other" }));
    expect(useStreamStore.getState()).toBe(completed);
  });

  it("invalidates chat proof for the serving fallback if that provider fails", () => {
    useConfigStore.setState({ llmProvider: "openai" });
    useLiveQAHealthStore.getState().markAIReady("groq", "llama");
    renderHook(() => useStreamBuffer());
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "typed", "openai", "Why?", "gpt-4o");
      handlers.start({ mode: "AskQuestion", model: "gpt-4o", provider: "OpenAI", request_id: "typed" });
      handlers.fallback({ request_id: "typed", from_provider: "OpenAI", from_model: "gpt-4o", to_provider: "Groq", to_model: "llama", reason: "credits_exhausted" });
      handlers.error({ request_id: "typed", message: "private response", code: "credits_exhausted", retryable: false });
    });
    expect(useLiveQAHealthStore.getState().aiReadyModels.groq).toBeUndefined();
  });

  it("keeps AI response proof after a correlated pre-generation retrieval failure", () => {
    const message = "Meeting document retrieval failed. Refresh this meeting's sources before asking again.";
    useConfigStore.setState({ llmProvider: "openai" });
    useLiveQAHealthStore.getState().markAIReady("openai", "gpt-4o");
    renderHook(() => useStreamBuffer());
    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "docs", "openai", "Why?", "gpt-4o");
      handlers.handling({ request_id: "docs", status: "retrieving_context" });
      handlers.error({ request_id: "docs", message, code: "provider_error" });
    });
    expect(useStreamStore.getState()).toMatchObject({ phase: "idle", handlingStatus: "retrieving_context", error: message, answerOutcome: "unable" });
    expect(useLiveQAHealthStore.getState().aiReadyModels.openai).toBe("gpt-4o");

    act(() => {
      useStreamStore.getState().setPending("AskQuestion", "ai", "openai", "Next?", "gpt-4o");
      handlers.handling({ request_id: "ai", status: "generating_answer" });
      handlers.error({ request_id: "ai", message: "401 private response", code: "invalid_api_key" });
    });
    expect(useLiveQAHealthStore.getState().aiReadyModels.openai).toBeUndefined();
  });
});
