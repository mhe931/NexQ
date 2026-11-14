import { ProviderModelPicker, providerLabel } from "./ProviderModelPicker";
import { RadioCard } from "./SetupSection";
import { hintCls, inputCls, labelCls } from "../ui";
import type { AiSettings, MeetingProfile, ResponseFormat, ResponseLength, Strategy } from "../../lib/profileTypes";
import { useMeetingStore } from "../../stores/meetingStore";
import { useProfileStore } from "../../stores/profileStore";

const STRATEGIES: Array<[Strategy, string, string]> = [
  ["fast", "FAST", "Lowest delay; shorter reasoning."],
  ["balanced", "BALANCED", "Good answers at a steady pace (default)."],
  ["best", "BEST ANSWER", "Most careful; may take longer and cost more."],
];

export function AdvancedSection({ profile }: { profile: MeetingProfile }) {
  const patch = useProfileStore((s) => s.patch);
  const ai = profile.ai;
  const setAi = (change: Partial<AiSettings>) => patch((p) => ({ ...p, ai: { ...p.ai, ...change } }));
  const openGlobal = () => useMeetingStore.getState().setCurrentView("settings");
  const fallback = ai.fallbackProvider;

  return (
    <>
      <div className="rounded-lg border border-border/30 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
        API keys are never entered here. They live in Global settings (Windows Credential Manager) and are shared by all meetings.{" "}
        <button type="button" className="underline hover:text-foreground" onClick={openGlobal}>Global settings</button>
      </div>

      <ProviderModelPicker
        idPrefix="primary"
        label="Primary"
        provider={ai.primaryProvider}
        model={ai.primaryModel}
        withTest
        onOpenGlobal={openGlobal}
        onChange={(provider, model) => setAi({ primaryProvider: provider, primaryModel: model })}
      />

      <ProviderModelPicker
        idPrefix="fallback"
        label="Fallback"
        provider={fallback}
        model={ai.fallbackModel}
        optional
        onOpenGlobal={openGlobal}
        onChange={(provider, model) =>
          setAi({
            fallbackProvider: provider,
            fallbackModel: model,
            // Consent is for one named provider; a different (or no) fallback starts without it.
            fallbackConsentProvider: provider && provider === ai.fallbackConsentProvider ? provider : null,
            automaticFallback: provider ? ai.automaticFallback : false,
          })
        }
      />

      {fallback && (
        <div className="space-y-2 rounded-lg border border-border/30 bg-secondary/10 px-3 py-3">
          <label className="flex items-start gap-2 text-xs text-foreground/90">
            <input type="checkbox" className="mt-0.5" checked={ai.automaticFallback} onChange={(e) => setAi({ automaticFallback: e.target.checked })} />
            <span>Switch to the fallback automatically if the primary fails</span>
          </label>
          <label className="flex items-start gap-2 text-xs text-foreground/90">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={ai.fallbackConsentProvider === fallback}
              onChange={(e) => setAi({ fallbackConsentProvider: e.target.checked ? fallback : null })}
            />
            <span>Allow {providerLabel(fallback)} to receive this meeting's context</span>
          </label>
          <p className={hintCls}>Without this, NexQ will never send your documents' excerpts to the fallback. Only the excerpts retrieved for a question are sent.</p>
          <label className="flex items-start gap-2 text-xs text-foreground/90">
            <input type="checkbox" className="mt-0.5" checked={ai.allowPaidFallback} onChange={(e) => setAi({ allowPaidFallback: e.target.checked })} />
            <span>Allow paid fallback</span>
          </label>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="spend-limit" className={labelCls}>Spending limit (USD, optional)</label>
          <input
            id="spend-limit"
            type="number"
            min={0}
            step={0.5}
            className={inputCls}
            value={ai.spendLimitUsd ?? ""}
            placeholder="No limit"
            onChange={(e) => setAi({ spendLimitUsd: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })}
          />
        </div>
        <div>
          <label htmlFor="max-seconds" className={labelCls}>Maximum response time (seconds)</label>
          <input
            id="max-seconds"
            type="number"
            min={1}
            max={300}
            className={inputCls}
            value={ai.maxResponseSeconds}
            onChange={(e) => e.target.value !== "" && setAi({ maxResponseSeconds: Number(e.target.value) })}
          />
          <p className={hintCls}>1–300</p>
        </div>
      </div>

      <fieldset>
        <legend className={labelCls}>Strategy</legend>
        <div className="grid grid-cols-3 gap-2">
          {STRATEGIES.map(([value, title, description]) => (
            <RadioCard key={value} name="strategy" value={value} checked={ai.strategy === value} onChange={() => setAi({ strategy: value })} title={title} description={description} />
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="resp-length" className={labelCls}>Response length</label>
          <select id="resp-length" className={inputCls} value={ai.responseLength} onChange={(e) => setAi({ responseLength: e.target.value as ResponseLength })}>
            <option value="short">Short</option>
            <option value="medium">Medium</option>
            <option value="long">Long</option>
          </select>
        </div>
        <div>
          <label htmlFor="resp-format" className={labelCls}>Response format</label>
          <select id="resp-format" className={inputCls} value={ai.responseFormat} onChange={(e) => setAi({ responseFormat: e.target.value as ResponseFormat })}>
            <option value="plain">Plain answer</option>
            <option value="action_answer">ACTION / ANSWER steps</option>
          </select>
          <p className={hintCls}>ACTION steps are instructions for you to follow. NexQ never operates your computer.</p>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-foreground/90">
        <input type="checkbox" checked={ai.streaming} onChange={(e) => setAi({ streaming: e.target.checked })} />
        Stream answers as they are written
      </label>
    </>
  );
}
