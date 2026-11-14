import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { ExternalLink, Github, Loader2, RefreshCw, Terminal } from "lucide-react";
import { copilotStatus, openCopilotLoginTerminal, setActiveModel } from "../lib/ipc";
import type { CopilotModel, CopilotState, CopilotStatus } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { showToast } from "../stores/toastStore";

export const COPILOT_CLI_DOCS_URL = "https://docs.github.com/en/copilot/how-tos/copilot-cli";
/** The model asked for when none was picked: Copilot chooses. */
export const COPILOT_DEFAULT_MODEL = "auto";

/** "checking" and "failed" are the app's own states; the rest is the CLI's genuine answer. */
export type CopilotConnection = "checking" | "failed" | CopilotState;

export function copilotConnection(status: CopilotStatus | undefined, failed: boolean): CopilotConnection {
  if (!status) return failed ? "failed" : "checking";
  return status.state;
}

const DOT_CLASS: Record<CopilotConnection, string> = {
  checking: "bg-muted-foreground/40 animate-pulse",
  failed: "bg-warning",
  ready: "bg-success",
  not_installed: "bg-muted-foreground/40",
  not_logged_in: "bg-warning",
  no_entitlement: "bg-warning",
  timeout: "bg-warning",
  protocol_error: "bg-warning",
};

/** Short state shown on the provider row. */
export const COPILOT_ROW_LABEL: Record<CopilotConnection, string> = {
  checking: "Checking…",
  failed: "Couldn't check",
  ready: "Ready",
  not_installed: "Not installed",
  not_logged_in: "Not signed in",
  no_entitlement: "No Copilot access",
  timeout: "No answer",
  protocol_error: "Error",
};

/** Models the account may use, as the CLI listed them. */
export function enabledModels(status: CopilotStatus | undefined): CopilotModel[] {
  return (status?.models ?? []).filter((m) => m.enabled);
}

function modelLabel(m: CopilotModel): string {
  return m.usage ? `${m.name} (${m.usage})` : m.name;
}

const SELECT_CLASS =
  "w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-3.5 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-accent hover:-translate-y-px active:translate-y-px active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 cursor-pointer";

/** While waiting for a sign-in in the terminal: re-check this often, this many times. */
const LOGIN_POLL_MS = 4000;
const LOGIN_POLL_TRIES = 30;

interface GitHubCopilotSettingsProps {
  /** The Copilot row is the provider being viewed (shows its details). */
  selected: boolean;
  /** GitHub Copilot is the active provider. */
  active: boolean;
  onSelect: () => void;
}

/**
 * GitHub Copilot through the official Copilot CLI (its Agent Client Protocol
 * server). Authentication is the CLI's own `copilot login`; this panel only
 * shows what the CLI reports, with its genuine error text.
 */
export function GitHubCopilotSettings({ selected, active, onSelect }: GitHubCopilotSettingsProps) {
  const [status, setStatus] = useState<CopilotStatus | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | undefined>(undefined);
  const [checkedAt, setCheckedAt] = useState<number | undefined>(undefined);
  const alive = useRef(true);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const next = await copilotStatus();
      if (!alive.current) return;
      setStatus(next);
      setCheckError(undefined);
      // "Ready" is what the other pickers (status bar, per-meeting setup) call verified.
      const { verifiedCloudProviders, setVerifiedCloudProviders } = useConfigStore.getState();
      const listed = verifiedCloudProviders.includes("github_copilot");
      if (next.state === "ready" && !listed) {
        setVerifiedCloudProviders([...verifiedCloudProviders, "github_copilot"]);
      } else if (listed && (next.state === "not_installed" || next.state === "not_logged_in" || next.state === "no_entitlement")) {
        setVerifiedCloudProviders(verifiedCloudProviders.filter((p) => p !== "github_copilot"));
      }
    } catch (e) {
      if (!alive.current) return;
      setCheckError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) {
        setChecking(false);
        setCheckedAt(Date.now());
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void check();
    return () => {
      alive.current = false;
    };
  }, [check]);

  const state = copilotConnection(status, !!checkError && !checking);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-primary/80">GitHub Copilot</h3>
        <span className="rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold uppercase tracking-wider text-warning">
          Beta
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Uses your own GitHub Copilot plan through the official Copilot CLI. NexQ never sees your credentials.
      </p>

      <div className="mt-4 grid grid-cols-3 gap-2.5">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`GitHub Copilot, ${COPILOT_ROW_LABEL[state]}${active ? ", active" : ""}`}
          className={`relative flex flex-col items-start rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer ${
            selected
              ? "border-primary bg-primary/5 ring-1 ring-primary/20"
              : "border-border/50 hover:border-border hover:bg-accent/50"
          }`}
        >
          <div className="flex w-full items-center gap-1.5">
            <Github className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">GitHub Copilot</span>
            {active && <span className="ml-auto text-meta font-medium text-primary/80">Active</span>}
          </div>
          <span className="mt-1.5 flex w-full items-center gap-1.5 text-meta text-muted-foreground">
            <span
              data-testid="copilot-status-dot"
              data-state={state}
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[state]}`}
            />
            <span className="truncate">{COPILOT_ROW_LABEL[state]}</span>
          </span>
        </button>
      </div>

      {selected && (
        <CopilotDetails
          status={status}
          state={state}
          checking={checking}
          checkError={checkError}
          checkedAt={checkedAt}
          active={active}
          onCheck={check}
        />
      )}
    </div>
  );
}

/** The CLI's own words for what it found; never softened. */
function statusLine(state: CopilotConnection, status: CopilotStatus | undefined): string {
  switch (state) {
    case "checking":
      return "Looking for the Copilot CLI…";
    case "failed":
      return "Couldn't check the Copilot CLI";
    case "ready": {
      const n = enabledModels(status).length;
      return `Copilot CLI answered · ${n} model${n === 1 ? "" : "s"} available for your account`;
    }
    case "not_installed":
      return "Copilot CLI not installed";
    case "not_logged_in":
      return "Copilot CLI says you need to sign in";
    case "no_entitlement":
      return "No Copilot access for this account";
    case "timeout":
      return "Copilot CLI did not answer in time";
    case "protocol_error":
      return "Copilot CLI error";
  }
}

function CopilotDetails({
  status,
  state,
  checking,
  checkError,
  checkedAt,
  active,
  onCheck,
}: {
  status: CopilotStatus | undefined;
  state: CopilotConnection;
  checking: boolean;
  checkError: string | undefined;
  checkedAt: number | undefined;
  active: boolean;
  onCheck: () => Promise<void>;
}) {
  const llmModel = useConfigStore((s) => s.llmModel);
  const rememberedModel = useConfigStore((s) => s.lastModelByProvider.github_copilot);
  const [pickedModel, setPickedModel] = useState<string | undefined>(undefined);
  const [activating, setActivating] = useState(false);
  const [awaitingLogin, setAwaitingLogin] = useState(false);

  const models = enabledModels(status);
  const model = active ? llmModel : (pickedModel ?? rememberedModel ?? COPILOT_DEFAULT_MODEL);
  const listed = models.some((m) => m.id === model);
  const needsSignIn = state === "not_logged_in";
  const unusable = state === "not_installed" || needsSignIn || state === "no_entitlement";
  const errorText = checkError ? `Couldn't check: ${checkError}` : status?.error ?? null;

  // After the login terminal opens: re-check on window focus and every few
  // seconds for a while, until the CLI no longer asks for a sign-in.
  useEffect(() => {
    if (!awaitingLogin) return;
    if (state === "ready") {
      setAwaitingLogin(false);
      return;
    }
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      void onCheck();
      if (tries >= LOGIN_POLL_TRIES) setAwaitingLogin(false);
    }, LOGIN_POLL_MS);
    const onFocus = () => void onCheck();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [awaitingLogin, state, onCheck]);

  const handleModel = async (id: string) => {
    setPickedModel(id);
    // Only the active provider's model is applied now; otherwise "Use GitHub Copilot" applies it.
    if (!active) return;
    useConfigStore.getState().setLLMModel(id, "github_copilot");
    try {
      await setActiveModel("github_copilot", id);
    } catch (e) {
      showToast(`Couldn't apply the model: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const handleActivate = async () => {
    setActivating(true);
    try {
      await useConfigStore.getState().activateLLMProvider("github_copilot", {
        model: model || COPILOT_DEFAULT_MODEL,
      });
    } catch (e) {
      showToast(`Couldn't switch to GitHub Copilot: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setActivating(false);
    }
  };

  const handleOpenLogin = async () => {
    try {
      await openCopilotLoginTerminal();
      setAwaitingLogin(true);
    } catch (e) {
      showToast(`Couldn't open a terminal: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const openDocs = (e: React.MouseEvent) => {
    e.preventDefault();
    open(COPILOT_CLI_DOCS_URL).catch((err) =>
      showToast(`Couldn't open the browser: ${err instanceof Error ? err.message : String(err)}`, "error"),
    );
  };

  return (
    <div className="mt-4 space-y-4 border-t border-border/20 pt-4">
      {!active && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Not in use — answers come from your current provider until you switch.
          </p>
          <button
            type="button"
            onClick={handleActivate}
            disabled={unusable || activating}
            className={`${BUTTON_CLASS} shrink-0 border-primary/30 text-primary`}
          >
            {activating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Use GitHub Copilot
          </button>
        </div>
      )}

      {/* Connection */}
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{statusLine(state, status)}</p>
            {status?.installed && (
              <p className="mt-0.5 truncate font-mono text-meta text-muted-foreground/70" title={status.binary_path ?? undefined}>
                {[status.version && `v${status.version}`, status.binary_path].filter(Boolean).join(" — ")}
              </p>
            )}
          </div>
          <button type="button" onClick={() => void onCheck()} disabled={checking} className={`${BUTTON_CLASS} shrink-0`}>
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {checking ? "Checking…" : "Check connection"}
          </button>
        </div>

        {!checking && errorText && checkedAt !== undefined && (
          <p role="status" data-testid="copilot-error" className="mt-2 break-words text-xs text-warning">
            {errorText}
          </p>
        )}
        {!checking && state === "ready" && !checkError && checkedAt !== undefined && (
          <p role="status" className="mt-2 text-xs text-success">
            ✓ The CLI listed its models for your account
          </p>
        )}
      </div>

      {/* Guidance */}
      {(state === "not_installed" || state === "not_logged_in" || state === "no_entitlement") && (
        <div className="rounded-lg border border-warning/20 bg-warning/5 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {status?.login_hint ??
              "Install the GitHub Copilot CLI, then run `copilot login` in a terminal."}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            {state !== "no_entitlement" && (
              <button type="button" onClick={handleOpenLogin} className={BUTTON_CLASS}>
                <Terminal className="h-3.5 w-3.5" />
                {state === "not_installed" ? "Open terminal" : "Open terminal to sign in"}
              </button>
            )}
            <a
              href={COPILOT_CLI_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              onClick={openDocs}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Copilot CLI instructions
              <ExternalLink className="h-3 w-3" />
            </a>
            {awaitingLogin && <span className="text-meta text-muted-foreground">Waiting for sign-in…</span>}
          </div>
        </div>
      )}

      {/* Model */}
      <div>
        <label htmlFor="copilot-model" className="text-xs font-semibold text-foreground">
          Model
        </label>
        <select
          id="copilot-model"
          aria-label="Copilot model"
          value={model}
          disabled={models.length === 0}
          onChange={(e) => void handleModel(e.target.value)}
          className={`${SELECT_CLASS} mt-2`}
        >
          {!listed && <option value={model}>{model}{models.length > 0 ? " (not in your current list)" : ""}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {modelLabel(m)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-meta text-muted-foreground">
          {models.length > 0
            ? "The list comes live from your Copilot CLI. “Auto” lets Copilot pick; multipliers show its usage cost."
            : "Check the connection to load the models your plan offers. “Auto” is used until you pick one."}
        </p>
      </div>

      <p className="text-meta text-muted-foreground">
        Requires an active GitHub Copilot plan and the official Copilot CLI. Your prompts, transcript excerpts and
        meeting context are sent to GitHub Copilot, so it counts as a cloud provider. Copilot gets no tools: it cannot
        read files or run commands. Usage counts against your Copilot plan.
      </p>
    </div>
  );
}
