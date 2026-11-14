import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

interface Props {
  id: string;
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/** A collapsible group of settings. Content is not rendered while collapsed. */
export function SetupSection({ id, title, summary, open, onToggle, children }: Props) {
  return (
    <section id={`setup-${id}`} className="scroll-mt-4 rounded-2xl border border-border/30 bg-card/60" aria-labelledby={`setup-${id}-title`}>
      <h2 id={`setup-${id}-title`} className="text-sm">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`setup-${id}-body`}
          className="flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left font-semibold text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>
            {title}
            {summary && <span className="ml-2 text-meta font-normal text-muted-foreground">{summary}</span>}
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      </h2>
      {open && (
        <div id={`setup-${id}-body`} className="space-y-4 border-t border-border/20 px-4 py-4">
          {children}
        </div>
      )}
    </section>
  );
}

/** A labelled radio option rendered as a selectable card. */
export function RadioCard({
  name, value, checked, onChange, title, description, disabled,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  description?: string;
  disabled?: boolean;
}) {
  const descId = useId();
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-xl border px-3 py-2 text-xs transition-colors focus-within:ring-2 focus-within:ring-ring ${
        checked ? "border-primary/50 bg-primary/10" : "border-border/30 bg-secondary/10 hover:bg-secondary/30"
      } ${disabled ? "opacity-60" : ""}`}
    >
      <label className={`flex items-center gap-2 font-semibold text-foreground ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          aria-describedby={description ? descId : undefined}
          className="accent-[hsl(var(--primary))]"
        />
        {title}
      </label>
      {description && <p id={descId} className="pl-6 text-meta leading-snug text-muted-foreground">{description}</p>}
    </div>
  );
}
