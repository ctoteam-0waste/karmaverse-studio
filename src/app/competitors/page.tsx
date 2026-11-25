import { activeBrand, readDb } from "@/lib/db";
import { FORMATS } from "@/lib/schemas";
import { competitorReport, engagementOf } from "@/lib/competitors/agent";
import { analysisMetrics } from "@/lib/analytics/engine";
import { todayIst } from "@/lib/util";
import { Empty, Flash, fmtDate, PageHead, PLATFORM_LABEL, type SearchParams } from "@/components/ui";
import { addCompetitorAction, addCompetitorPostAction, competitorIdeaAction, deleteCompetitorPostAction, removeCompetitorAction, syncCompetitorsAction } from "../actions";

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("en-IN"));
const fmtIst = (d: string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default async function CompetitorsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const competitors = db.competitors.filter((c) => c.brandId === brand.id);
  const report = competitorReport(brand, competitors, db.competitorPosts, { content: db.content, metrics: analysisMetrics(db.metrics, brand.id) }, new Date());
  const posts = db.competitorPosts.filter((p) => competitors.some((c) => c.id === p.competitorId)).sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  const sync = db.settings.lastCompetitorSync;
  const name = (id: string) => competitors.find((c) => c.id === id)?.name ?? "?";

  return (
    <>
      <PageHead title="Competitor Watch" intro="Tracks what similar brands post and what works for them: formats, posting times, hooks and their best posts, compared with your own pace. Public data only, for learning, never copying.">
        <form action={syncCompetitorsAction}><button type="submit" className="secondary">Refresh now</button></form>
      </PageHead>
      <Flash params={params} />

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>What to learn</h2>
        {report.insights.length ? <ul>{report.insights.map((i) => <li key={i}>{i}</li>)}</ul> : <Empty>Not enough posts yet to compare. Insights appear with at least 3 posts per format.</Empty>}
        <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>{sync ? `Refreshed ${fmtIst(sync.at)} (daily while the app runs).` : "Not refreshed yet."} Lift = a post&apos;s engagement (likes + comments) divided by that competitor&apos;s usual (median) engagement, so big and small accounts compare fairly.</p>
      </section>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>Side by side</h2>
        {report.rows.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th>Platform</th><th className="num">Followers</th><th className="num">Posts / week (30 days)</th><th className="num">Avg engagement / post</th><th className="num">Engagement rate</th><th className="num">Avg views</th><th>Best format</th></tr></thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={`${r.competitor.id}${r.platform}`}>
                    <td>{r.competitor.name}</td>
                    <td>{PLATFORM_LABEL[r.platform]}</td>
                    <td className="num">{n(r.followers)}</td>
                    <td className="num">{r.perWeek}</td>
                    <td className="num">{n(r.avgEngagement)}</td>
                    <td className="num">{r.engagementRate === null ? "—" : `${r.engagementRate}%`}</td>
                    <td className="num">{n(r.avgViews)}</td>
                    <td>{r.bestFormat ? `${r.bestFormat.format} (${r.bestFormat.times}×)` : "—"}</td>
                  </tr>
                ))}
                {report.own.map((o) => (
                  <tr key={`own${o.platform}`} style={{ fontWeight: 600 }}>
                    <td>You ({brand.name})</td>
                    <td>{PLATFORM_LABEL[o.platform]}</td>
                    <td className="num">—</td>
                    <td className="num">{o.perWeek}</td>
                    <td className="num">{n(o.avgEngagement)}</td>
                    <td className="num">—</td>
                    <td className="num">—</td>
                    <td>—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Add a competitor below to start.</Empty>
        )}
      </section>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>Their best recent posts</h2>
        {report.top.length ? (
          <ul className="list">
            {report.top.map(({ post: p, competitor, lift }) => (
              <li key={p.id}>
                <div className="row">
                  <span className={`badge ${lift >= 2 ? "ok" : ""}`}>{Math.round(lift * 10) / 10}×</span>
                  <b>{competitor.name}</b>
                  <span className="badge">{PLATFORM_LABEL[p.platform]} {p.format}</span>
                  <span className="muted" style={{ fontSize: "0.85rem" }}>{fmtDate(p.postedAt)} · {n(p.likes)} likes · {n(p.comments)} comments{p.views !== null ? ` · ${n(p.views)} views` : ""}</span>
                  <span className="spacer" />
                  <form action={competitorIdeaAction}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="lift" value={String(Math.round(lift * 10) / 10)} /><button className="small">Make our version</button></form>
                </div>
                <div style={{ fontSize: "0.9rem" }}>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.hook || "(no caption)"}</a> : p.hook || "(no caption)"}</div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No posts from the last 60 days yet.</Empty>
        )}
      </section>

      <div className="grid three" style={{ marginBottom: "1rem" }}>
        <section className="card">
          <h2>Formats</h2>
          {report.formats.length ? (
            <table><thead><tr><th>Format</th><th className="num">Lift</th><th className="num">Posts</th></tr></thead>
              <tbody>{report.formats.map((f) => <tr key={`${f.platform}${f.format}`}><td>{PLATFORM_LABEL[f.platform]} {f.format}</td><td className="num">{f.lift}×</td><td className="num">{f.posts}</td></tr>)}</tbody></table>
          ) : <Empty>Needs 3+ posts per format.</Empty>}
        </section>
        <section className="card">
          <h2>Posting times (IST)</h2>
          {report.bestSlots.length ? (
            <table><thead><tr><th>Slot</th><th className="num">Lift</th><th className="num">Posts</th></tr></thead>
              <tbody>{report.bestSlots.map((s) => <tr key={`${s.day}${s.hours}`}><td>{s.day} {s.hours}</td><td className="num">{s.lift}×</td><td className="num">{s.posts}</td></tr>)}</tbody></table>
          ) : <Empty>Needs 2+ posts per slot.</Empty>}
        </section>
        <section className="card">
          <h2>Hooks</h2>
          {report.hooks.length ? (
            <table><thead><tr><th>Hook that…</th><th className="num">vs others</th><th className="num">Posts</th></tr></thead>
              <tbody>{report.hooks.map((h) => <tr key={h.pattern}><td>{h.pattern}</td><td className="num">{h.lift}×</td><td className="num">{h.posts}</td></tr>)}</tbody></table>
          ) : <Empty>Needs 3+ posts with and without each pattern.</Empty>}
        </section>
      </div>

      <div className="grid two" style={{ marginBottom: "1rem" }}>
        <section className="card">
          <h2>Competitors</h2>
          {competitors.length ? (
            <ul className="list">
              {competitors.map((c) => (
                <li key={c.id}>
                  <div className="row">
                    <b>{c.name}</b>
                    {c.instagram ? <a className="badge" href={`https://www.instagram.com/${c.instagram}/`} target="_blank" rel="noreferrer">IG @{c.instagram}</a> : null}
                    {c.youtube ? <a className="badge" href={`https://www.youtube.com/${c.youtube.startsWith("UC") ? `channel/${c.youtube}` : c.youtube.startsWith("@") ? c.youtube : `@${c.youtube}`}`} target="_blank" rel="noreferrer">YT {c.youtube}</a> : null}
                    {c.website ? <a href={c.website} target="_blank" rel="noreferrer" className="muted">site</a> : null}
                    <span className="spacer" />
                    <form action={removeCompetitorAction}><input type="hidden" name="id" value={c.id} /><button className="secondary small">Remove</button></form>
                  </div>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {c.profiles.map((p) => `${PLATFORM_LABEL[p.platform]}: ${n(p.followers)} followers`).join(" · ") || "No numbers yet."} {c.lastSyncAt ? `· read ${fmtIst(c.lastSyncAt)}` : ""}
                  </div>
                  {c.notes ? <div style={{ fontSize: "0.85rem" }}>{c.notes}</div> : null}
                  {c.lastSyncNotes.length ? <div className="flash err" style={{ margin: "0.3rem 0 0", fontSize: "0.85rem" }}>{c.lastSyncNotes.join(" ")}</div> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No competitors yet.</Empty>
          )}
        </section>

        <section className="card">
          <h2>Add a competitor</h2>
          <form action={addCompetitorAction} className="stack">
            <label>Name<input name="name" required placeholder="e.g. another climate or recycling brand" /></label>
            <div className="form-grid">
              <label>Instagram username<input name="instagram" placeholder="username (business or creator account)" /></label>
              <label>YouTube handle or channel id<input name="youtube" placeholder="@handle" /></label>
              <label>Website<input name="website" placeholder="https://" /></label>
              <label>Notes<input name="notes" placeholder="Why we watch them" /></label>
            </div>
            <div><button type="submit">Add and read</button></div>
          </form>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            YouTube uses your brand&apos;s YouTube connection. Instagram uses Business Discovery: it needs your brand&apos;s <code>INSTAGRAM_ACCOUNT_ID</code> and a Facebook Page token (<code>META_PAGE_ACCESS_TOKEN</code>) with <code>instagram_basic</code>, and only works for business/creator accounts. LinkedIn, Facebook and X don&apos;t share other accounts&apos; posts, so add those by hand.
          </p>
        </section>
      </div>

      <section className="card" id="add-post" style={{ marginBottom: "1rem" }}>
        <h2>Add a post by hand</h2>
        {competitors.length ? (
          <form action={addCompetitorPostAction} className="stack">
            <div className="form-grid">
              <label>Competitor<select name="competitorId">{competitors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label>Platform<select name="platform">{brand.platforms.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select></label>
              <label>Format<select name="format">{FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
              <label>Posted on<input type="date" name="postedAt" defaultValue={todayIst()} required /></label>
              <label>Time (IST, optional)<input type="time" name="time" /></label>
              <label>Link<input name="url" placeholder="https://" /></label>
              <label className="full">First line / title<input name="hook" /></label>
              <label>Likes / reactions<input type="number" min={0} name="likes" defaultValue={0} /></label>
              <label>Comments<input type="number" min={0} name="comments" defaultValue={0} /></label>
              <label>Views (videos)<input type="number" min={0} name="views" /></label>
              <label>Their followers now (optional)<input type="number" min={0} name="followers" /></label>
            </div>
            <div><button type="submit">Add post</button></div>
          </form>
        ) : (
          <Empty>Add a competitor first.</Empty>
        )}
      </section>

      {posts.length ? (
        <details className="card">
          <summary style={{ cursor: "pointer" }}><b>All tracked posts</b> ({posts.length})</summary>
          <div className="table-wrap" style={{ marginTop: "0.5rem" }}>
            <table>
              <thead><tr><th>Date</th><th>Account</th><th>Post</th><th className="num">Likes</th><th className="num">Comments</th><th className="num">Views</th><th>Source</th><th /></tr></thead>
              <tbody>
                {posts.slice(0, 200).map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.postedAt)}</td>
                    <td>{name(p.competitorId)}<div className="muted" style={{ fontSize: "0.8rem" }}>{PLATFORM_LABEL[p.platform]} {p.format}</div></td>
                    <td style={{ maxWidth: 360 }}>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.hook || "(no caption)"}</a> : p.hook || "(no caption)"}</td>
                    <td className="num">{n(p.likes)}</td>
                    <td className="num">{n(p.comments)}</td>
                    <td className="num">{n(p.views)}</td>
                    <td>{p.source}</td>
                    <td><form action={deleteCompetitorPostAction}><input type="hidden" name="id" value={p.id} /><button className="secondary small" title={`Engagement ${engagementOf(p)}`}>Delete</button></form></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </>
  );
}
