import { useState } from "react";
import { getApiKey, listModels, testLLMConnection } from "../../lib/ipc";
import { useConfigStore } from "../../stores/configStore";

/** Providers a meeting can use. "custom" and the Claude CLI are configured globally, not per meeting. */
export const MEETING_PROVIDERS: Array<{ id: string; label: string; local: boolean }> = [
  { id: "ollama", label: "Ollama (local)", local: true },
  { id: "lm_studio", label: "LM Studio (local)", local: true },
  { id: "openai", label: "OpenAI", local: false },
  { id: "anthropic", label: "Anthropic", local: false },
  { id: "groq", label: "Groq", local: false },
  { id: "gemini", label: "Google Gemini", local: false },
  { id: "openrouter", label: "OpenRouter", local: false },
];

export function providerLabel(id: string | null): string {
  return MEETING_PROVIDERS.find((p) => p.id === id)?.label ?? id ?? "";
}

/**
 * Backend config JSON for a one-off model list / connection test. A stored key
 * is read from the credential manager into this call only: it is never shown,
 * kept in state or saved with a meeting.
 */
async function providerConfigJson(provider: string): Promise<string> {
  const config: Record<string, unknown> = { provider_type: provider };
  if (!MEETING_PROVIDERS.find((p) => p.id === provider)?.local) {
    const key = await getApiKey(provider).catch(() => null);
    if (key) config.api_key = key;
  }
  return JSON.stringify(config);
}

/** Providers offered for a meeting: local ones, ones verified in Global settings, and the current choice. */
export function useAvailableProviders(current: string | null) {
  const verified = useConfigStore((s) => s.verifiedCloudProviders);
  return MEETING_PROVIDERS.filter((p) => p.local || verified.includes(p.id) || p.id === current).map((p) => ({
    ...p,
    verified: p.local || verified.includes(p.id),
  }));
}

interface Props {
  idPrefix: string;
  label: string;
  provider: string | null;
  model: string | null;
  optional?: boolean;
  onChange: (provider: string | null, model: string | null) => void;
  onOpenGlobal: () => void;
  withTest?: boolean;
}

const sel =
  "w-full rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ProviderModelPicker({ idPrefix, label, provider, model, optional, onChange, onOpenGlobal, withTest }: Props) {
  const providers = useAvailableProviders(provider);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const current = providers.find((p) => p.id === provider);

  const run = async (task: () => Promise<void>) => {
    setLoading(true);
    setStatus(null);
    try {
      await task();
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setLoading(false);
    }
  };

  const loadModels = () => run(async () => {
    if (!provider) return;
    const list = await listModels(await providerConfigJson(provider));
    setModels(list.map((m) => m.id));
    setStatus({ text: list.length ? `${list.length} models found.` : "No models found.", ok: list.length > 0 });
  });

  const test = () => run(async () => {
    if (!provider) return;
    const ok = await testLLMConnection(await providerConfigJson(provider));
    setStatus({ text: ok ? "Connection works." : "Connection failed.", ok });
  });

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${idPrefix}-provider`} className="mb-1 block text-xs font-medium text-foreground/80">{label} provider</label>
          <select
            id={`${idPrefix}-provider`}
            className={sel}
            value={provider ?? ""}
            onChange={(e) => {
              setModels([]);
              setStatus(null);
              onChange(e.target.value || null, null);
            }}
          >
            <option value="">{optional ? "None" : "Choose a provider…"}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.label}{p.verified ? "" : " — not verified"}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-model`} className="mb-1 block text-xs font-medium text-foreground/80">{label} model</label>
          <input
            id={`${idPrefix}-model`}
            className={sel}
            list={`${idPrefix}-models`}
            value={model ?? ""}
            disabled={!provider}
            onChange={(e) => onChange(provider, e.target.value || null)}
            placeholder={provider ? "Pick or type a model name" : "Choose a provider first"}
          />
          <datalist id={`${idPrefix}-models`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
        </div>
      </div>

      {provider && current && !current.verified && (
        <p className="text-meta text-warning" role="status">
          {providerLabel(provider)} is not verified. Add its key and run Test Connection in Global settings.{" "}
          <button type="button" className="underline" onClick={onOpenGlobal}>Global settings</button>
        </p>
      )}

      {provider && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="rounded-md border border-border/40 bg-secondary/30 px-2 py-1 text-xs hover:bg-secondary/60 disabled:opacity-50" onClick={loadModels} disabled={loading}>
            Load models
          </button>
          {withTest && (
            <button type="button" className="rounded-md border border-border/40 bg-secondary/30 px-2 py-1 text-xs hover:bg-secondary/60 disabled:opacity-50" onClick={test} disabled={loading}>
              Test connection
            </button>
          )}
          {status && <span role="status" className={`text-meta ${status.ok ? "text-success" : "text-destructive"}`}>{status.text}</span>}
        </div>
      )}
    </div>
  );
}
