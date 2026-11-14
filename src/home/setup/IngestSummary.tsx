import type { IngestReport } from "../../lib/profileTypes";

const base = (p: string) => p.split(/[\\/]/).pop() || p;

/** What the last import did, with a reason for everything that was not added. */
export function IngestSummary({ report }: { report: IngestReport }) {
  const counts: Array<[string, number]> = [
    ["added", report.added.length],
    ["updated", report.updated.length],
    ["unchanged", report.unchanged.length],
    ["duplicates", report.duplicates.length],
    ["failed", report.failed.length],
    ["skipped", report.skipped.length],
    ["missing", report.missing.length],
  ];
  const problems: Array<[string, string, string]> = [
    ...report.failed.map((p) => ["Failed", p.path, p.reason] as [string, string, string]),
    ...report.duplicates.map((p) => ["Duplicate", p.path, p.reason] as [string, string, string]),
    ...report.skipped.map((p) => ["Skipped", p.path, p.reason] as [string, string, string]),
    ...report.missing.map((p) => ["Missing", p, "The file is no longer there."] as [string, string, string]),
  ];
  return (
    <div role="status" aria-label="Import summary" className="rounded-lg border border-border/30 bg-secondary/20 px-3 py-2 text-xs">
      <p className="font-medium text-foreground">
        {counts.map(([label, n]) => `${n} ${label}`).join(" · ")}
      </p>
      {problems.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-meta text-muted-foreground">
          {problems.map(([kind, path, reason], i) => (
            <li key={`${kind}-${path}-${i}`} title={path}>
              <span className="font-semibold text-foreground/80">{kind}:</span> {base(path)} — {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
