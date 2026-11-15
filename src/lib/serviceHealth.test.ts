import { describe, expect, it } from "vitest";
import { safeServiceError, sttHealth, audioHealth, questionHealth, aiHealth } from "./serviceHealth";

describe("live Q&A health", () => {
  it.each([
    "Meeting documents are unavailable. Restart NexQ before asking again.",
    "Meeting document retrieval failed. Refresh this meeting's sources before asking again.",
  ])("preserves only the safe actionable context error: %s", (message) => {
    expect(safeServiceError(message, "AI").message).toBe(message);
    expect(safeServiceError(new Error(message), "AI").message).toBe(message);
    const unsafe = `${message} SQLite private/path database error`;
    expect(safeServiceError(unsafe, "AI").message).not.toContain("SQLite");
    expect(safeServiceError(unsafe, "AI").message).not.toContain("private/path");
  });

  it("keeps audio independent from failed STT, including silence", () => {
    expect(audioHealth({ lastLevelAt: 1000 }, true, false, 1500).label).toBe("Active");
    expect(sttHealth({ provider: "deepgram", status: "error", message: "401 invalid API key" }, "deepgram", true, false).label).toBe("Missing credentials");
  });

  it("does not infer STT readiness from capture or a selected provider", () => {
    expect(sttHealth(null, "deepgram", true, false).label).toBe("Checking");
    expect(sttHealth({ provider: "groq_whisper", status: "connected" }, "deepgram", true, false).label).toBe("Checking");
  });

  it("keeps a failure visible when capture is paused and never retains an old active heartbeat", () => {
    expect(sttHealth({ provider: "deepgram", status: "error" }, "deepgram", false, false).label).toBe("Failed");
    expect(audioHealth({ lastLevelAt: 1000 }, true, false, 6000).label).toBe("Checking");
    expect(audioHealth({ lastLevelAt: 1000 }, false, false, 1500).label).toBe("Paused");
  });

  it("reports connected, transcribing and offline distinctly", () => {
    expect(sttHealth({ provider: "deepgram", status: "connected", lastTranscriptAt: 1000 }, "deepgram", true, false, 1500).label).toBe("Transcribing");
    expect(sttHealth({ provider: "deepgram", status: "connected", lastTranscriptAt: 1000 }, "deepgram", true, false, 6000).label).toBe("Ready");
    expect(sttHealth({ provider: "deepgram", status: "disconnected" }, "deepgram", true, false).label).toBe("Offline");
  });

  it.each([
    ['{"error":{"code":"insufficient_quota","message":"private account data"}}', "credits"],
    ["HTTP 429 too many requests", "rate"],
    ["401 Unauthorized Bearer secret", "auth"],
    ["Failed to connect: https://private.example", "offline"],
    ["Permission denied microphone", "permission"],
    ["Audio device not found: Private device name", "device"],
    ["arbitrary private response body", "failed"],
  ])("reduces provider errors to a safe category: %s", (raw, kind) => {
    const safe = safeServiceError(raw, "AI");
    expect(safe.kind).toBe(kind);
    expect(safe.message).not.toContain(raw);
    expect(safe.message).not.toMatch(/private|secret|Bearer|\{|\}/i);
  });

  it("does not claim generation during retrieval or completion on an error with partial words", () => {
    expect(questionHealth({ phase: "sending", handlingStatus: "retrieving_context", error: null, currentContent: "" }, true, true).label).toBe("Retrieving context");
    expect(questionHealth({ phase: "waiting", handlingStatus: "generating_answer", error: null, currentContent: "" }, true, true).label).toBe("Generating answer");
    expect(questionHealth({ phase: "idle", handlingStatus: null, error: "AI failed", currentContent: "partial" }, true, true).label).toBe("Unable to answer");
    expect(questionHealth({ phase: "idle", handlingStatus: null, error: null, currentContent: "" }, false, false).label).toBe("Waiting for speech");
    expect(questionHealth({ phase: "idle", handlingStatus: null, error: null, currentContent: "" }, true, false).label).toBe("Transcript received");
    expect(questionHealth({ phase: "idle", handlingStatus: null, error: null, currentContent: "" }, false, true).label).toBe("Question detected");
  });

  it("never calls a cancelled partial answer ready or turns unverified configuration into readiness", () => {
    const stream = { phase: "idle", handlingStatus: null, error: null, currentContent: "partial", isStreaming: false, answerOutcome: "cancelled" };
    expect(questionHealth(stream, true, true).label).toBe("Answer stopped");
    expect(aiHealth(stream).label).toBe("Not checked");
    expect(aiHealth({ ...stream, answerOutcome: "ready" }).label).toBe("Ready");
  });

  it("trusts the structured failure code, never misleading provider text", () => {
    expect(safeServiceError("429 raw private response", "AI", "credits_exhausted").kind).toBe("credits");
    expect(safeServiceError("network private response", "AI", "invalid_api_key").kind).toBe("auth");
  });

  it("does not mistake exhausted credits for rate limiting or transient quota for billing", () => {
    expect(safeServiceError("429 credit_balance_exhausted", "AI").kind).toBe("credits");
    expect(safeServiceError("429 token quota exceeded", "AI").kind).toBe("rate");
  });

  it("identifies the native Deepgram missing-key failure as a credential blocker", () => {
    expect(safeServiceError("Deepgram API key not configured", "STT").kind).toBe("credentials");
  });

  it("uses actionable credits and authentication wording without reclassifying quota", () => {
    expect(safeServiceError("429 credit_balance_exhausted", "AI").message).toBe("AI credits exhausted. Check provider billing.");
    expect(safeServiceError("401", "AI").message).toBe("AI authentication required. Check provider sign-in or credentials.");
    const idle = { phase: "idle", currentContent: "", isStreaming: false };
    expect(aiHealth({ ...idle, error: "AI credits exhausted. Check provider billing." }).label).toBe("Credits exhausted");
    expect(aiHealth({ ...idle, error: "AI authentication required. Check provider sign-in or credentials." }).label).toBe("Authentication required");
  });

  it.each([
    ["device_unavailable", "Device unavailable"],
    ["permission_denied", "Permission denied"],
    ["failed", "Failed"],
    ["paused", "Paused"],
    ["active", "Active"],
  ] as const)("uses the authoritative physical capture status %s, not volume or STT mute", (status, label) => {
    expect(audioHealth({ status, lastLevelAt: 1000 }, false, true, 10_000).label).toBe(label);
  });

  it("does not infer physical capture pause from muting transcription", () => {
    expect(audioHealth({ lastLevelAt: 1000 }, true, true, 1500).label).toBe("Active");
  });
});
