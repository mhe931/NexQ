// Sub-PRD 6: Subscribe to llm_token/stream_start/stream_end events
// Batch at 60fps via requestAnimationFrame

import { useEffect, useRef } from "react";
import { useStreamStore } from "../stores/streamStore";
import { useQuestionStore } from "../stores/questionStore";
import { useLiveQAHealthStore } from "../stores/liveQAHealthStore";
import { useConfigStore } from "../stores/configStore";
import {
  onStreamStart,
  onStreamToken,
  onStreamEnd,
  onStreamSources,
  onStreamError,
  onStreamThinking,
  onQuestionHandlingStatus,
  onProfileFallback,
} from "../lib/events";
import type { IntelligenceMode } from "../lib/types";

/** Generations for a past meeting stream into that meeting's view, never the live buffer. */
export const PAST_MEETING_MODES: ReadonlySet<string> = new Set([
  "MeetingSummary",
  "ActionItemsExtraction",
  "BookmarkSuggestions",
  "MeetingAsk",
]);

/**
 * Hook that subscribes to LLM streaming events from the Tauri backend
 * and updates the streamStore. Batches token updates at 60fps using
 * requestAnimationFrame for smooth rendering.
 */
export function useStreamBuffer() {
  const appendToken = useStreamStore((s) => s.appendToken);
  const startStream = useStreamStore((s) => s.startStream);
  const endStream = useStreamStore((s) => s.endStream);
  const setSources = useStreamStore((s) => s.setSources);
  const setError = useStreamStore((s) => s.setError);
  const recordUserRequest = useStreamStore((s) => s.recordUserRequest);

  // Token batching buffer
  const tokenBuffer = useRef<string>("");
  const rafId = useRef<number | null>(null);
  // request_id of the stream this buffer is showing — only streams whose
  // start event we saw (and accepted) are displayed.
  const activeRequestId = useRef<string | null>(null);

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [];

    // Flush buffered tokens to the store at ~60fps
    const flushTokens = () => {
      if (tokenBuffer.current.length > 0) {
        appendToken(tokenBuffer.current);
        tokenBuffer.current = "";
      }
      rafId.current = null;
    };

    // Schedule a flush if not already scheduled
    const scheduleFlush = () => {
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(flushTokens);
      }
    };

    const isActive = (requestId: string | null) =>
      activeRequestId.current !== null && requestId === activeRequestId.current;

    const forgetAIReady = (...providers: Array<string | null>) => {
      const providerKey = (provider: string) => provider.toLowerCase().replace(/[^a-z0-9]/g, "");
      const failed = new Set(providers.filter((provider): provider is string => !!provider).map(providerKey));
      const health = useLiveQAHealthStore.getState();
      for (const provider of Object.keys(health.aiReadyModels)) {
        if (failed.has(providerKey(provider))) health.forgetAIReady(provider);
      }
    };

    unlisteners.push(onQuestionHandlingStatus((event) => {
      if (!useStreamStore.getState().isRunning(event.request_id)) return;
      useStreamStore.getState().setHandlingStatus(event.status);
    }));

    unlisteners.push(onProfileFallback((event) => {
      const store = useStreamStore.getState();
      if (!store.applyProfileFallback(event)) return;
      // A successful fallback does not verify the provider that just failed.
      forgetAIReady(event.from_provider, store.requestProvider);
    }));

    // Subscribe to stream start
    unlisteners.push(
      onStreamStart((event) => {
        if (PAST_MEETING_MODES.has(event.mode)) return;
        activeRequestId.current = event.request_id;
        tokenBuffer.current = "";
        if (rafId.current !== null) {
          cancelAnimationFrame(rafId.current);
          rafId.current = null;
        }
        // Remember when this request was made (the click, when this window
        // saw it), for the "since last answer" scopes.
        const store = useStreamStore.getState();
        const clickedAt =
          store.pendingRequestId !== null && store.pendingRequestId === event.request_id
            ? store.requestStartedAt
            : null;
        recordUserRequest(event.mode, clickedAt ?? Date.now());
        startStream(
          event.mode as IntelligenceMode,
          event.model,
          event.provider,
          {
            requestId: event.request_id,
            scopeLabel: event.scope_label ?? null,
            newLines: event.transcript_segments_count ?? null,
            sessionKey: event.session_key ?? null,
          }
        );
      })
    );

    // Subscribe to stream tokens — batch at 60fps
    unlisteners.push(
      onStreamToken((event) => {
        if (!isActive(event.request_id)) return;
        tokenBuffer.current += event.token;
        scheduleFlush();
      })
    );

    // Subscribe to stream end
    unlisteners.push(
      onStreamEnd((event) => {
        if (!isActive(event.request_id)) return;
        activeRequestId.current = null;
        // Flush any remaining buffered tokens immediately
        if (tokenBuffer.current.length > 0) {
          appendToken(tokenBuffer.current);
          tokenBuffer.current = "";
        }
        if (rafId.current !== null) {
          cancelAnimationFrame(rafId.current);
          rafId.current = null;
        }
        endStream(event.latency_ms, event.cancelled);
        if (event.request_id) useQuestionStore.getState().settleAnswer(
          event.request_id,
          event.cancelled ? "cancelled" : useStreamStore.getState().currentContent.trim() ? "ready" : "unable",
        );
      })
    );

    // The model is reasoning before it answers (Claude extended thinking).
    unlisteners.push(
      onStreamThinking((event) => {
        if (!isActive(event.request_id)) return;
        const store = useStreamStore.getState();
        if (store.firstTokenAt === null) store.setPhase("thinking");
      })
    );

    // Subscribe to grounding sources (emitted before stream end, when web search is enabled)
    unlisteners.push(
      onStreamSources((event) => {
        if (!isActive(event.request_id)) return;
        setSources(event.sources);
      })
    );

    // Subscribe to stream errors
    unlisteners.push(
      onStreamError((event) => {
        if (!isActive(event.request_id) && !(event.request_id && useStreamStore.getState().pendingRequestId === event.request_id)) return;
        activeRequestId.current = null;
        tokenBuffer.current = "";
        if (rafId.current !== null) {
          cancelAnimationFrame(rafId.current);
          rafId.current = null;
        }
        setError(event.message, { code: event.code, retryable: event.retryable });
        if (event.code !== "cancelled" && useStreamStore.getState().handlingStatus !== "retrieving_context") {
          const store = useStreamStore.getState();
          forgetAIReady(store.currentProvider || store.requestProvider || useConfigStore.getState().llmProvider);
        }
        if (event.request_id) useQuestionStore.getState().settleAnswer(event.request_id, event.code === "cancelled" ? "cancelled" : "unable");
      })
    );

    // Cleanup on unmount
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
      unlisteners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, [appendToken, startStream, endStream, setSources, setError, recordUserRequest]);
}
