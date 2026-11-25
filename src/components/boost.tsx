import type { BoostCheck, BoostReport } from "@/lib/agents/engagement";
import { applyHookAction } from "@/app/actions";

const STATUS_BADGE: Record<BoostCheck["status"], { cls: string; text: string }> = {
  pass: { cls: "ok", text: "good" },
  improve: { cls: "warn", text: "improve" },
  fix: { cls: "bad", text: "fix" },
};

export function scoreClass(score: number): string {
  return score >= 80 ? "ok" : score >= 60 ? "warn" : "bad";
}

export function ScoreBadge({ score }: { score: number }) {
  return <span className={`badge ${scoreClass(score)}`} title="Growth Booster score out of 100">{score}/100</span>;
}

/** Checklist and one-click hook swaps for one post. */
export function BoostDetails({ report, back, editable }: { report: BoostReport; back: string; editable: boolean }) {
  const open = report.checks.filter((c) => c.status !== "pass");
  const passed = report.checks.filter((c) => c.status === "pass");
  return (
    <div className="stack">
      <ul className="list">
        {[...open, ...passed].map((c) => (
          <li key={c.id}>
            <span className={`badge ${STATUS_BADGE[c.status].cls}`}>{STATUS_BADGE[c.status].text}</span> <b>{c.label}</b>
            <div className="muted" style={{ fontSize: "0.9rem" }}>{c.detail}</div>
          </li>
        ))}
      </ul>
      {editable && report.hookIdeas.length ? (
        <div>
          <h3>Try a different hook</h3>
          <ul className="list">
            {report.hookIdeas.map((h) => (
              <li key={h.style}>
                <form action={applyHookAction} className="row" style={{ alignItems: "center" }}>
                  <input type="hidden" name="id" value={report.pieceId} />
                  <input type="hidden" name="back" value={back} />
                  <input name="hook" defaultValue={h.hook} style={{ flex: 1, minWidth: 0 }} aria-label={`${h.style} hook`} />
                  <span className="badge info">{h.style}</span>
                  <button type="submit" className="secondary small">Use</button>
                </form>
              </li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: "0.85rem" }}>Edit the text before clicking Use. Changing the hook of an approved post sends it back for review.</p>
        </div>
      ) : null}
    </div>
  );
}
