import type { ReactNode } from "react";
import type { ContentStatus } from "@/lib/schemas";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export function sp(params: Record<string, string | string[] | undefined>, key: string): string {
  const v = params[key];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export function PageHead({ title, intro, children }: { title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {intro ? <p>{intro}</p> : null}
      </div>
      {children ? <div className="row">{children}</div> : null}
    </div>
  );
}

export function Flash({ params }: { params: Record<string, string | string[] | undefined> }) {
  const ok = sp(params, "ok");
  const err = sp(params, "err");
  return (
    <>
      {ok ? <div className="flash ok" role="status">{ok}</div> : null}
      {err ? <div className="flash err" role="alert">{err}</div> : null}
    </>
  );
}

export function StatusBadge({ status }: { status: ContentStatus }) {
  return <span className={`badge status-${status}`}>{status.replace("-", " ")}</span>;
}

export function SampleBadge({ show }: { show: boolean }) {
  return show ? <span className="badge sample" title="Invented demo data. Not real performance.">Sample</span> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function fmtScore(n: number | null | undefined, format: "percent" | "number" = "percent"): string {
  if (n === null || n === undefined) return "—";
  return format === "percent" ? `${(n * 100).toFixed(2)}%` : n.toFixed(2);
}

export function fmtDiff(d: number | null | undefined): ReactNode {
  if (d === null || d === undefined) return <span className="muted">—</span>;
  const pctText = `${d > 0 ? "+" : ""}${Math.round(d * 100)}%`;
  return <span className={d >= 0 ? "up" : "down"}>{pctText}</span>;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: iso.length === 10 ? "UTC" : "Asia/Kolkata" });
}

export const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", youtube: "YouTube", linkedin: "LinkedIn", facebook: "Facebook", x: "X" };

export const PLATFORM_ICON: Record<string, string> = { instagram: "📸", youtube: "▶️", linkedin: "💼", facebook: "📘", x: "✖️" };

export function PlatformChip({ platform, format }: { platform: string; format?: string }) {
  return (
    <span className={`chip pf-${platform}`}>
      <span aria-hidden>{PLATFORM_ICON[platform] ?? "•"}</span> {PLATFORM_LABEL[platform] ?? platform}
      {format ? <span className="chip-sub"> · {format.replace("-", " ")}</span> : null}
    </span>
  );
}

/** "Today, 7:00 pm", "Tomorrow, 9:30 am", "Fri 7 Nov, 10:00 am" (IST). Planned time defaults to 9:00. */
export function fmtWhen(plannedDate: string | null | undefined, plannedTime: string | null | undefined, now = new Date()): string {
  if (!plannedDate || !/^\d{4}-\d{2}-\d{2}$/.test(plannedDate)) return "No date yet";
  const m = (plannedTime ?? "").match(/(\d{1,2})[:.](\d{2})/);
  const at = new Date(`${plannedDate}T${String(m ? Math.min(23, Number(m[1])) : 9).padStart(2, "0")}:${m ? m[2] : "00"}:00+05:30`);
  const ist = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const time = at.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const today = ist(now);
  const tomorrow = ist(new Date(now.getTime() + 864e5));
  const yesterday = ist(new Date(now.getTime() - 864e5));
  const day = plannedDate === today ? "Today" : plannedDate === tomorrow ? "Tomorrow" : plannedDate === yesterday ? "Yesterday" : at.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  return `${day}, ${time}`;
}

/** The "FIRST COMMENT TO PIN: …" line from a post's notes, if any. */
export function pinComment(notes: string): string {
  return notes.match(/FIRST COMMENT TO PIN:\s*(.+)/)?.[1]?.trim() ?? "";
}
