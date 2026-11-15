/** Frontend presentation only: never display a provider response body or endpoint. */
export type FailureKind = "auth" | "credentials" | "credits" | "rate" | "offline" | "permission" | "device" | "failed";
export function safeServiceError(error: unknown, service: "AI" | "STT" | "Audio", code?: string | null) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // Only these fixed native context errors may pass through, never DB details.
  if (service === "AI") {
    for (const safe of [
      "Meeting documents are unavailable. Restart NexQ before asking again.",
      "Meeting document retrieval failed. Refresh this meeting's sources before asking again.",
    ]) {
      if (message.trim() === safe) return { kind: "failed" as FailureKind, message: safe };
    }
  }
  const raw = message.toLowerCase();
  let kind: FailureKind = "failed";
  // Billing errors sometimes also contain 429; classify billing first.
  if (/insufficient_quota|credit_balance_exhausted|insufficient_balance|credits|credit balance|billing|payment required|402/.test(raw)) kind = "credits";
  else if (/429|rate.limit|too many requests/.test(raw)) kind = "rate";
  else if (/missing.*(key|credential)|no.*api.key|api.key.*(missing|not.*(?:set|configured))|credentials.*(missing|not.*configured)/.test(raw)) kind = "credentials";
  else if (/401|403|unauthorized|unauthorised|invalid.*(key|credential)|authentication|auth_error|not.authenticated|not_logged_in|sign.in/.test(raw)) kind = "auth";
  else if (/permission|not-allowed|access.denied/.test(raw)) kind = "permission";
  else if (/device.*(not found|unavailable|disconnected)|audio-capture|no.*device/.test(raw)) kind = "device";
  else if (/offline|network|connect|timeout|timed out|fetch|dns/.test(raw)) kind = "offline";
  const codes: Record<string, FailureKind> = {
    credits_exhausted: "credits", rate_limited: "rate", invalid_api_key: "auth",
    authentication: "auth", unavailable: "offline", timeout: "offline",
    not_configured: "credentials", invalid_response: "failed", provider_error: "failed",
  };
  if (code && codes[code]) kind = codes[code];
  const messages: Record<FailureKind, string> = {
    credits: `${service} credits exhausted. Check provider billing.`,
    rate: `${service} rate limited. Wait, then retry.`,
    credentials: `${service} credentials missing. Configure the selected provider.`,
    auth: `${service} authentication required. Check provider sign-in or credentials.`,
    offline: `${service} offline. Check the connection, then retry.`,
    permission: `${service} permission denied. Check microphone permissions.`,
    device: `${service} device unavailable. Choose an available audio device.`,
    failed: `${service} failed. Check configuration, then retry.`,
  };
  return { kind, message: messages[kind] };
}

export interface HealthDisplay {
  label: string;
  tone: "neutral" | "active" | "warning";
  detail?: string;
}
export interface STTObservation {
  provider: string;
  status: string;
  message?: string;
  lastTranscriptAt?: number;
}
export interface AudioObservation {
  /** Authoritative physical state from audio_capture_status, when available. */
  status?: "active" | "paused" | "device_unavailable" | "permission_denied" | "failed";
  lastLevelAt?: number;
  error?: string;
}
const neutral = (label: string): HealthDisplay => ({ label, tone: "neutral" });

export function audioHealth(observed: AudioObservation | null, listening: boolean, _muted: boolean, now = Date.now()): HealthDisplay {
  // Physical capture is independent of transcription mute and the aggregate
  // command result. One device can still capture when the other fails.
  switch (observed?.status) {
    case "active": return { label: "Active", tone: "active" };
    case "paused": return neutral("Paused");
    case "device_unavailable": return { label: "Device unavailable", tone: "warning", detail: "Choose an available audio device, then retry." };
    case "permission_denied": return { label: "Permission denied", tone: "warning", detail: "Check microphone permissions, then retry." };
    case "failed": return { label: "Failed", tone: "warning", detail: "Check audio devices, then retry." };
  }
  if (observed?.error) {
    const safe = safeServiceError(observed.error, "Audio");
    return { label: safe.kind === "permission" ? "Permission denied" : safe.kind === "device" ? "Device unavailable" : "Failed", tone: "warning", detail: safe.message };
  }
  if (!listening) return neutral("Paused");
  // A zero-level heartbeat is still an active capture. Silence isn't failure.
  if (observed?.lastLevelAt !== undefined && now - observed.lastLevelAt < 3000) return { label: "Active", tone: "active" };
  return neutral("Checking");
}

export function sttHealth(observed: STTObservation | null, provider: string, listening: boolean, muted: boolean, now = Date.now()): HealthDisplay {
  const current = observed?.provider === provider ? observed : null;
  if (current?.status === "error") {
    const safe = safeServiceError(current.message, "STT");
    return {
      label: safe.kind === "auth" || safe.kind === "credentials" ? "Missing credentials" : safe.kind === "offline" ? "Offline" : "Failed",
      tone: "warning", detail: safe.message,
    };
  }
  if (!listening || muted || current?.status === "paused") return neutral("Paused");
  if (current?.status === "disconnected" || current?.status === "reconnecting") return { label: "Offline", tone: "warning" };
  if (current?.status === "connected") {
    return { label: current.lastTranscriptAt !== undefined && now - current.lastTranscriptAt < 2000 ? "Transcribing" : "Ready", tone: "active" };
  }
  return neutral("Checking");
}

export function aiHealth(stream: { phase: string; error: string | null; currentContent: string; isStreaming: boolean; answerOutcome?: string | null }): HealthDisplay {
  if (stream.error) {
    const safe = safeServiceError(stream.error, "AI");
    return { label: ({ auth: "Authentication required", credentials: "Missing credentials", credits: "Credits exhausted", rate: "Rate limited", offline: "Offline" } as Partial<Record<FailureKind, string>>)[safe.kind] ?? "Failed", tone: "warning", detail: safe.message };
  }
  if (stream.isStreaming || stream.phase !== "idle") return { label: "Answering", tone: "active" };
  if (stream.answerOutcome === "unable") return { label: "Failed", tone: "warning", detail: "AI returned no answer. Retry or check the provider." };
  // A selected provider isn't proof of readiness. A successful answer is.
  return stream.answerOutcome === "ready" ? { label: "Ready", tone: "active" } : neutral("Not checked");
}

export function questionHealth(stream: { phase: string; handlingStatus: string | null; error: string | null; currentContent: string; answerOutcome?: string | null }, hasTranscript: boolean, hasQuestion: boolean): HealthDisplay {
  if (stream.error) return { label: "Unable to answer", tone: "warning" };
  if (stream.handlingStatus === "retrieving_context") return { label: "Retrieving context", tone: "active" };
  if (stream.handlingStatus === "generating_answer" || ["waiting", "thinking", "writing"].includes(stream.phase)) return { label: "Generating answer", tone: "active" };
  if (stream.phase === "sending") return neutral("Question received");
  if (stream.answerOutcome === "cancelled") return neutral("Answer stopped");
  if (stream.answerOutcome === "unable") return { label: "Unable to answer", tone: "warning" };
  if (stream.answerOutcome === "ready") return { label: "Answer ready", tone: "active" };
  if (hasQuestion) return neutral("Question detected");
  return neutral(hasTranscript ? "Transcript received" : "Waiting for speech");
}
