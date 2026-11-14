import { useState } from "react";
import { Alert, btnSecondary, hintCls, inputCls, labelCls } from "../ui";
import { RadioCard } from "./SetupSection";
import { profileIpc } from "../../lib/profileIpc";
import { chooseNexqDisplay, screenShareWarnings, teleprompterRect } from "../../lib/overlayPlacement";
import type {
  DisplayInfo, EnvironmentSettings, MeetingProfile, ScreenShare, TeleprompterSettings, WebcamPosition,
} from "../../lib/profileTypes";
import { useProfileStore } from "../../stores/profileStore";

const WEBCAM: Array<[WebcamPosition, string]> = [
  ["top_center", "Top centre"], ["top_left", "Top left"], ["top_right", "Top right"],
];
const SHARE: Array<[ScreenShare, string]> = [
  ["none", "Not sharing my screen"], ["window", "A single window"], ["display", "My entire display"],
];

function NumberField({
  id, label, value, min, max, step = 1, onChange,
}: { id: string; label: string; value: number; min: number; max: number; step?: number; onChange: (n: number) => void }) {
  const invalid = value < min || value > max;
  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}</label>
      <input
        id={id}
        type="number"
        className={inputCls}
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        aria-invalid={invalid}
        aria-describedby={`${id}-range`}
        onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))}
        onBlur={() => invalid && onChange(Math.min(Math.max(value, min), max))}
      />
      <p id={`${id}-range`} className={hintCls}>{min}–{max}</p>
    </div>
  );
}

export function EnvironmentSection({ profile }: { profile: MeetingProfile }) {
  const patch = useProfileStore((s) => s.patch);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const env = profile.environment;
  const setEnv = (change: Partial<EnvironmentSettings>) => patch((p) => ({ ...p, environment: { ...p.environment, ...change } }));
  const setTele = (change: Partial<TeleprompterSettings>) =>
    setEnv({ teleprompter: { ...env.teleprompter, ...change } });

  const detect = async (): Promise<DisplayInfo[]> => {
    try {
      const found = await profileIpc.displays();
      setDisplays(found);
      setMessage({ text: `${found.length} ${found.length === 1 ? "display" : "displays"} detected.`, error: false });
      return found;
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
      return [];
    }
  };

  const testPlacement = async () => {
    const list = displays.length ? displays : await detect();
    const display = chooseNexqDisplay(list, env);
    if (!display) {
      setMessage({ text: "No display detected, so the placement can't be tested.", error: true });
      return;
    }
    const t = env.teleprompter;
    const rect = teleprompterRect(display, env.webcamPosition, { width: t.width, height: t.height }, { x: t.x, y: t.y });
    try {
      await profileIpc.placeOverlay(rect.x, rect.y, rect.width, rect.height);
      setMessage({ text: `NexQ was moved to “${display.name}”. Start a meeting to see the notes there.`, error: false });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  const monitorOptions = (displays.length ? displays.map((d) => d.index) : Array.from({ length: env.monitorCount }, (_, i) => i));
  const label = (i: number) => {
    const d = displays.find((x) => x.index === i);
    return d ? `${i + 1}: ${d.name}${d.isPrimary ? " (primary)" : ""}` : `Monitor ${i + 1}`;
  };
  const monitorSelect = (id: string, text: string, value: number, key: "primaryMonitor" | "presentationMonitor" | "nexqMonitor") => (
    <div>
      <label htmlFor={id} className={labelCls}>{text}</label>
      <select id={id} className={inputCls} value={value} onChange={(e) => setEnv({ [key]: Number(e.target.value) })}>
        {monitorOptions.map((i) => <option key={i} value={i}>{label(i)}</option>)}
      </select>
    </div>
  );

  const warnings = screenShareWarnings(env, displays.length);

  return (
    <>
      <fieldset>
        <legend className={labelCls}>Monitors</legend>
        <div className="grid grid-cols-2 gap-2">
          <RadioCard name="monitor-count" value="1" checked={env.monitorCount <= 1} onChange={() => setEnv({ monitorCount: 1, nexqMonitor: 0, presentationMonitor: 0, primaryMonitor: 0 })} title="One monitor" />
          <RadioCard name="monitor-count" value="2" checked={env.monitorCount >= 2} onChange={() => setEnv({ monitorCount: 2 })} title="Two monitors" />
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="button" className={btnSecondary} onClick={detect}>Detect displays</button>
        <button type="button" className={btnSecondary} onClick={testPlacement}>Test placement</button>
      </div>
      {displays.length > 0 && (
        <ul className="space-y-0.5 text-meta text-muted-foreground" aria-label="Detected displays">
          {displays.map((d) => (
            <li key={d.index}>{d.index + 1}. {d.name} — {d.width}×{d.height}{d.isPrimary ? " (primary)" : ""}</li>
          ))}
        </ul>
      )}
      {message && (message.error ? <Alert>{message.text}</Alert> : <p className="text-xs text-muted-foreground" role="status">{message.text}</p>)}

      {env.monitorCount >= 2 && (
        <div className="grid grid-cols-3 gap-3">
          {monitorSelect("mon-primary", "Primary monitor", env.primaryMonitor, "primaryMonitor")}
          {monitorSelect("mon-present", "Presentation / shared monitor", env.presentationMonitor, "presentationMonitor")}
          {monitorSelect("mon-nexq", "Monitor for NexQ notes", env.nexqMonitor, "nexqMonitor")}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="webcam" className={labelCls}>Webcam position</label>
          <select id="webcam" className={inputCls} value={env.webcamPosition} onChange={(e) => setEnv({ webcamPosition: e.target.value as WebcamPosition })}>
            {WEBCAM.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            {env.webcamPosition === "custom" && <option value="custom">Custom</option>}
          </select>
          <p className={hintCls}>NexQ's notes are placed just below the camera edge.</p>
        </div>
        <div>
          <label htmlFor="screen-share" className={labelCls}>Screen sharing</label>
          <select id="screen-share" className={inputCls} value={env.screenShare} onChange={(e) => setEnv({ screenShare: e.target.value as ScreenShare })}>
            {SHARE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <NumberField id="tp-font" label="Teleprompter font size" value={env.teleprompter.fontSize} min={12} max={120} onChange={(n) => setTele({ fontSize: n })} />
        <NumberField id="tp-line" label="Line length (characters)" value={env.teleprompter.lineChars} min={0} max={200} onChange={(n) => setTele({ lineChars: n })} />
        <NumberField id="tp-opacity" label="Opacity" value={env.teleprompter.opacity} min={0.2} max={1} step={0.05} onChange={(n) => setTele({ opacity: n })} />
        <NumberField id="tp-scroll" label="Auto-scroll (px/second)" value={env.teleprompter.scrollSpeed} min={0} max={400} onChange={(n) => setTele({ scrollSpeed: n })} />
      </div>
      <label className="flex items-center gap-2 text-xs text-foreground/90">
        <input type="checkbox" checked={env.teleprompter.highContrast} onChange={(e) => setTele({ highContrast: e.target.checked })} />
        High contrast
      </label>

      <div role="status" aria-label="Screen sharing check" className="space-y-1.5 rounded-lg border border-border/30 bg-secondary/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        {warnings.map((w) => <p key={w}>{w}</p>)}
        <p>NexQ cannot guarantee it is hidden from Teams, Zoom, Meet or recordings. Always check the platform's share preview before you start.</p>
      </div>
    </>
  );
}
