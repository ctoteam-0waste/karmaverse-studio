import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { analysisMetrics, scorePosts } from "@/lib/analytics/engine";
import { afterPublishTasks, boostCheck, cadenceCheck, repurposeWinners } from "@/lib/agents/engagement";
import { addDays, todayIst } from "@/lib/util";
import { BoostDetails, ScoreBadge } from "@/components/boost";
import { Empty, Flash, fmtDate, fmtDiff, PageHead, PLATFORM_LABEL, StatusBadge, type SearchParams } from "@/components/ui";
import { repurposeAction } from "../actions";

const CADENCE_BADGE = { pass: "ok", improve: "warn", fix: "bad" } as const;

export default async function GrowthPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const today = todayIst();
  const content = db.content.filter((c) => c.brandId === brand.id);
  const metrics = analysisMetrics(db.metrics, brand.id);
  const scored = scorePosts(metrics);

  const upcoming = content
    .filter((c) => ["draft", "needs-review", "approved", "scheduled"].includes(c.status) && (!c.plannedDate || (c.plannedDate >= today && c.plannedDate <= addDays(today, 14))))
    .sort((a, b) => `${a.plannedDate ?? "9"}${a.plannedTime ?? ""}`.localeCompare(`${b.plannedDate ?? "9"}${b.plannedTime ?? ""}`))
    .slice(0, 30)
    .map((piece) => ({ piece, report: boostCheck(piece, scored) }));
  const avg = upcoming.length ? Math.round(upcoming.reduce((a, u) => a + u.report.score, 0) / upcoming.length) : null;
  const weak = [...upcoming].sort((a, b) => a.report.score - b.report.score);
  const tasks = afterPublishTasks(content, db.inbox.filter((i) => i.brandId === brand.id), metrics, new Date());
  const winners = repurposeWinners(brand, content, scored);
  const cadence = cadenceCheck(brand, content, today);

  return (
    <>
      <PageHead
        title="Growth Booster"
        intro="Gets more views and engagement from every post: checks posts before they go out, lists what to do after they go live, and reuses your best posts. It uses only your posts and your logged metrics. No bots and no fake engagement."
      />
      <Flash params={params} />

      <div className="grid four" style={{ marginBottom: "1rem" }}>
        <div className="card stat"><div className="value">{avg ?? "—"}</div><div className="label">Average score, next 14 days</div></div>
        <div className="card stat"><div className="value">{upcoming.filter((u) => u.report.score < 70).length}</div><div className="label">Posts below 70</div></div>
        <div className="card stat"><div className="value">{tasks.filter((t) => t.urgent).length}</div><div className="label">Urgent after-publish tasks</div></div>
        <div className="card stat"><div className="value">{winners.length}</div><div className="label">Winners to repurpose</div></div>
      </div>

      <div className="grid two">
        <section className="card">
          <h2>After you publish</h2>
          {tasks.length ? (
            <ul className="list">
              {tasks.slice(0, 15).map((t) => (
                <li key={`${t.pieceId}${t.task}`}>
                  {t.urgent ? <span className="badge bad">now</span> : null} <b>{t.task}</b>
                  <div className="muted" style={{ fontSize: "0.9rem" }}>
                    {PLATFORM_LABEL[t.platform]} · <Link href={`/content/${t.pieceId}`}>{t.topic}</Link>
                    {t.url ? <> · <a href={t.url} target="_blank" rel="noreferrer">open post</a></> : null} · {t.why}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing yet. Tasks appear here for 48 hours after a post is published, and again after 7 days to log its metrics.</Empty>
          )}
        </section>

        <section className="card">
          <h2>Posting consistency</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Platform</th><th className="num">Plan / week</th><th className="num">Published, last 7 days</th><th className="num">Approved, next 7 days</th><th>Status</th></tr></thead>
              <tbody>
                {cadence.map((r) => (
                  <tr key={r.platform}>
                    <td>{PLATFORM_LABEL[r.platform]}</td>
                    <td className="num">{r.target}</td>
                    <td className="num">{r.last7}</td>
                    <td className="num">{r.next7}</td>
                    <td><span className={`badge ${CADENCE_BADGE[r.status]}`}>{r.status === "pass" ? "on plan" : r.status}</span> <span className="muted" style={{ fontSize: "0.85rem" }}>{r.note}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: "0.5rem" }}>Plan comes from the default weekly cadence used by the 30-day calendar.</p>
        </section>
      </div>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Repurpose your winners</h2>
        <p className="muted">Posts that scored 20% or more above earlier posts of the same platform and format. Turn each into drafts for the platforms where you haven't posted the topic yet.</p>
        {winners.length ? (
          <ul className="list">
            {winners.map((w) => (
              <li key={w.metricId} className="row" style={{ justifyContent: "space-between" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{w.topic}</b> {fmtDiff(w.lift)} <span className="muted">vs history on {PLATFORM_LABEL[w.from.platform]} {w.from.format}</span>
                  <div className="muted" style={{ fontSize: "0.9rem" }}>New drafts: {w.targets.map((t) => `${PLATFORM_LABEL[t.platform]} ${t.format}`).join(", ")}</div>
                </div>
                <form action={repurposeAction}>
                  <input type="hidden" name="metricId" value={w.metricId} />
                  <button type="submit" className="secondary small">Create drafts</button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No clear winners yet. A post needs 3 earlier posts of the same platform and format to compare with. Keep logging metrics in Analytics.</Empty>
        )}
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Check before publishing (next 14 days)</h2>
        {weak.length ? (
          <div className="stack">
            {weak.map(({ piece, report }) => (
              <details key={piece.id} open={report.score < 60}>
                <summary style={{ cursor: "pointer" }}>
                  <ScoreBadge score={report.score} /> <StatusBadge status={piece.status} /> <b>{PLATFORM_LABEL[piece.platform]} {piece.format}</b> · {piece.topic}{" "}
                  <span className="muted">{fmtDate(piece.plannedDate)} {piece.plannedTime ?? ""}</span> · <Link href={`/content/${piece.id}`}>edit</Link>
                </summary>
                <div style={{ padding: "0.5rem 0 0.75rem" }}>
                  <BoostDetails report={report} back="/growth" editable={piece.status !== "published"} />
                </div>
              </details>
            ))}
          </div>
        ) : (
          <Empty>No upcoming posts. Generate a calendar or create drafts in Content Studio.</Empty>
        )}
      </section>
    </>
  );
}
