import { useEffect, useRef, type ReactNode } from "react";

/** Shared class names for the meeting-profile screens (same tokens as the rest of the launcher). */
export const btnBase =
  "inline-flex items-center justify-center gap-2 rounded-xl text-xs font-semibold transition-all duration-150 cursor-pointer " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
export const btnPrimary = `${btnBase} bg-primary px-4 py-2.5 text-primary-foreground shadow-md shadow-primary/20 hover:bg-primary/90 active:scale-[0.98]`;
export const btnSecondary = `${btnBase} border border-border/40 bg-secondary/30 px-3 py-2 text-foreground/90 hover:bg-secondary/60 active:scale-[0.98]`;
export const btnDanger = `${btnBase} border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive hover:bg-destructive/20 active:scale-[0.98]`;
export const btnQuiet =
  "rounded-md px-2 py-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline cursor-pointer " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export const inputCls =
  "w-full rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/70 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
export const labelCls = "mb-1 block text-xs font-medium text-foreground/80";
export const hintCls = "mt-1 text-meta leading-snug text-muted-foreground";

/** Visible, announced problem text. */
export function Alert({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "warning" }) {
  const palette =
    tone === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-warning/30 bg-warning/10 text-foreground";
  return (
    <div role="alert" className={`rounded-lg border px-3 py-2 text-xs leading-snug ${palette}`}>
      {children}
    </div>
  );
}

/** Small status pill (for "This meeting" / "Global" and similar). */
export function Chip({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "muted" | "success" | "warning" }) {
  const palette = {
    info: "bg-primary/15 text-primary",
    muted: "bg-muted text-muted-foreground",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-meta font-semibold ${palette}`}>{children}</span>;
}

interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Modal confirmation: Escape cancels, focus starts on the safe (Cancel) button. */
export function ConfirmDialog({ title, message, confirmLabel, destructive, onConfirm, onCancel }: ConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm" role="presentation">
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="w-[380px] rounded-2xl border border-border/40 bg-card p-5 shadow-2xl">
        <h2 id="confirm-title" className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{message}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={btnSecondary} onClick={onCancel}>Cancel</button>
          <button type="button" className={destructive ? btnDanger : btnPrimary} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

/** "12 Nov 2026" style date, tolerant of bad input. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
