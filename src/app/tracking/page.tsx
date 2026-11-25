import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import type { TrackingSnapshot } from "@/lib/schemas";
import { Empty, Flash, fmtDate, PageHead, PLATFORM_LABEL, type SearchParams } from "@/components/ui";
import { SERIES_LABEL } from "@/lib/video/series";
import { addDays, todayIst } from "@/lib/util";
import { runBlogNowAction, runGrowthNowAction, runTrackingNowAction, setGrowthFixStatusAction } from "../actions";

const fmtIst = (d: string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const SITE = "https://0waste.co.in";

function Change({ now, before, lowerIsBetter = true }: { now: number | null | undefined; before: number | null | undefined; lowerIsBetter?: boolean }) {
  if (now == null || before == null || now === before) return null;
  const better = lowerIsBetter ? now < before : now > before;
  return <span className={better ? "up" : "down"} style={{ fontSize: "0.85rem", marginLeft: "0.4rem" }}>{now > before ? "▲" : "▼"} {Math.abs(now - before)}</span>;
}

const seoOpen = (s: TrackingSnapshot | undefined) => (s?.seo ? s.seo.critical + s.seo.high : null);

export default async function TrackingPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const snaps = [...db.tracking].sort((a, b) => a.date.localeCompare(b.date));
  const last = snaps[snaps.length - 1];
  // Compare with about a week ago (or the oldest we have).
  const weekAgo = [...snaps].reverse().find((s) => s.date <= addDays(last?.date ?? todayIst(), -7)) ?? snaps[0];
  const run = db.settings.lastTrackingRun;
  const blogRun = db.settings.lastBlogRun;

  const latestLlmo = new Map<string, (typeof db.llmoResults)[number]>();
  for (const r of db.llmoResults) latestLlmo.set(`${r.platform}|${r.promptId}`, r);
  const llmo = [...latestLlmo.values()].sort((a, b) => a.promptId.localeCompare(b.promptId));

  const today = todayIst();
  const videos = db.content
    .filter((c) => c.brandId === brand.id && !c.isSample && c.plannedDate && c.plannedDate >= addDays(today, -7) && c.plannedDate <= addDays(today, 7) && ["reel", "short", "story"].includes(c.format))
    .sort((a, b) => `${a.plannedDate}${a.platform}`.localeCompare(`${b.plannedDate}${b.platform}`));
  const blogs = [...db.blogPosts].reverse().slice(0, 15);
  const growthRun = db.settings.lastGrowthRun;
  const fixesByTime = [...db.growthFixes].sort((a, b) => b.at.localeCompare(a.at));
  const websiteFix = fixesByTime.find((f) => f.kind === "website" && f.status !== "dismissed");
  const asoFix = fixesByTime.find((f) => f.kind === "aso" && f.status !== "dismissed" && f.status !== "failed") ?? fixesByTime.find((f) => f.kind === "aso");
  const opportunities = db.trends.filter((t) => t.brandId === brand.id && t.source === "search" && t.status !== "dismissed").sort((a, b) => b.score - a.score).slice(0, 12);
  const blogged = new Set(db.blogPosts.map((b) => b.trendId));

  return (
    <>
      <PageHead
        title="Tracking: SEO · LLMO · ASO · Blog"
        intro="Every day the studio runs the website, Play Store and brand checks, drafts one blog article for the 3R website from a trend, and once a week asks Claude your AI-answer questions. Nothing on a live site changes on its own: fixes are listed here for a person to do, and articles wait as drafts in the website's admin."
      >
        <form action={runTrackingNowAction}><button type="submit" className="secondary">Run checks now</button></form>
        <form action={runBlogNowAction}><button type="submit" className="secondary">Write a blog draft now</button></form>
        <form action={runGrowthNowAction}><button type="submit">Run Growth agent now</button></form>
      </PageHead>
      <Flash params={params} />
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>
        Checks: {run ? `${fmtIst(run.at)} — ${run.notes.join(" ")}` : "not run yet"} · Blog Writer: {blogRun ? `${fmtIst(blogRun.at)} — ${blogRun.notes.join(" ")}` : "not run yet"}
      </p>

      <div className="grid four" style={{ marginBottom: "1rem" }}>
        <div className="card stat">
          <div className="label">SEO: serious issues on karmaverse.earth</div>
          <div className="value">{seoOpen(last) ?? "–"}<Change now={seoOpen(last)} before={seoOpen(weekAgo)} /></div>
          <div className="label">{last?.seo ? `${last.seo.critical} critical · ${last.seo.high} high · ${last.seo.medium + last.seo.low} minor · ${last.seo.resolved} fixed since last check` : "Run the checks"}</div>
        </div>
        <div className="card stat">
          <div className="label">ASO: Play Store listing</div>
          <div className="value">{last?.aso ? (last.aso.available ? "Live" : "Down") : "–"}</div>
          <div className="label">{last?.aso ? `${last.aso.rating != null ? `★ ${last.aso.rating}` : "No public rating yet"}${last.aso.reviews != null ? ` · ${last.aso.reviews} ratings` : ""} · ${last.aso.findings} change(s) vs. approved listing` : "Run the checks"}</div>
        </div>
        <div className="card stat">
          <div className="label">LLMO: AI answers that describe KarmaVerse correctly</div>
          <div className="value">{last?.llmo ? `${last.llmo.accurate}/${last.llmo.tested}` : "–"}<Change now={last?.llmo?.accurate} before={weekAgo?.llmo?.accurate} lowerIsBetter={false} /></div>
          <div className="label">
            Claude from memory, weekly{last?.llmo && last.llmo.mentioned > last.llmo.accurate ? ` · ${last.llmo.mentioned - last.llmo.accurate} mixed it up with something else` : ""}.
            {last?.llmoWeb ? ` With web search: ${last.llmoWeb.accurate}/${last.llmoWeb.tested} correct, ${last.llmoWeb.cited} linked to your sites.` : " With web search: not tested yet."} ChatGPT, Gemini, Perplexity: record by hand.
          </div>
        </div>
        <div className="card stat">
          <div className="label">Blog on 0waste.co.in</div>
          <div className="value">{last?.blog ? last.blog.posts : "–"}<Change now={last?.blog?.posts} before={weekAgo?.blog?.posts} lowerIsBetter={false} /></div>
          <div className="label">{last?.blog ? `published · ${last.blog.drafts} draft(s) waiting for review` : "Run the checks"}</div>
        </div>
      </div>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>🚀 Growth agent: fixes ready for your review</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Every day it turns the results above into fixes: website changes on a GitHub branch (weekly), a better Play Store listing (weekly) and topics people search for (daily, used by the Blog Writer).
          Nothing goes live until a person approves it. {growthRun ? <>Last run {fmtIst(growthRun.at)}: {growthRun.notes.join(" ")}</> : "Not run yet."}
        </p>

        <h3>1. Website: karmaverse.earth (SEO + AI answers)</h3>
        {websiteFix ? (
          <div className="stack" style={{ gap: "0.4rem" }}>
            <div className="row">
              <span className={`badge ${websiteFix.status === "ready" ? "warn" : websiteFix.status === "merged" ? "ok" : ""}`}>{websiteFix.status === "ready" ? "Waiting for review" : websiteFix.status === "merged" ? "Merged" : websiteFix.status === "nothing" ? "Nothing to change" : "Failed"}</span>
              <b>{websiteFix.title}</b><span className="muted">{fmtDate(websiteFix.date)}{websiteFix.branch ? ` · branch ${websiteFix.branch}` : ""}</span>
            </div>
            {websiteFix.summary.length ? <ul className="tip-how">{websiteFix.summary.map((s) => <li key={s}>{s}</li>)}</ul> : null}
            {websiteFix.files?.length ? <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>Files: {websiteFix.files.join(", ")}</p> : null}
            {websiteFix.error ? <p className="flash err" style={{ margin: 0 }}>{websiteFix.error}</p> : null}
            {websiteFix.status === "ready" ? (
              <>
                <p style={{ margin: 0, fontSize: "0.9rem" }}>
                  <b>To approve:</b> open the link, click <b>Create pull request</b>, check the changes (“Files changed” tab), then <b>Merge</b>. Netlify then deploys it.
                  It also contains earlier unmerged fixes (like the <code>seo-fixes</code> branch), so merging this one is enough.
                </p>
                <div className="row">
                  {websiteFix.compareUrl ? <a className="btn" href={websiteFix.compareUrl} target="_blank" rel="noreferrer">Review on GitHub →</a> : null}
                  <form action={setGrowthFixStatusAction}><input type="hidden" name="id" value={websiteFix.id} /><input type="hidden" name="status" value="merged" /><button className="secondary small">I merged it</button></form>
                  <form action={setGrowthFixStatusAction}><input type="hidden" name="id" value={websiteFix.id} /><input type="hidden" name="status" value="dismissed" /><button className="secondary small">Dismiss</button></form>
                </div>
              </>
            ) : null}
          </div>
        ) : <Empty>No website fixes yet. Click “Run Growth agent now”.</Empty>}

        <h3 style={{ marginTop: "1.25rem" }}>2. Play Store listing (ASO)</h3>
        {asoFix?.aso ? (
          <div className="stack" style={{ gap: "0.5rem" }}>
            <p className="muted" style={{ margin: 0 }}>Proposed {fmtDate(asoFix.date)}. Copy into Play Console → Grow → Store presence → Main store listing, after checking every claim. Also saved in <code>Desktop\seo,llmo,aso\marketing\aso\listing-proposal-latest.md</code>.</p>
            <label>App name ({asoFix.aso.title.length}/30)<input readOnly value={asoFix.aso.title} /></label>
            <label>Short description ({asoFix.aso.shortDescription.length}/80)<input readOnly value={asoFix.aso.shortDescription} /></label>
            <label>Full description ({asoFix.aso.fullDescription.length}/4000)<textarea readOnly rows={10} value={asoFix.aso.fullDescription} /></label>
            <p style={{ margin: 0, fontSize: "0.9rem" }}><b>Keywords targeted:</b> {asoFix.aso.keywords.join(", ")}</p>
            {asoFix.aso.reasons.length ? <details><summary>Why these changes</summary><ul className="tip-how">{asoFix.aso.reasons.map((r) => <li key={r}>{r}</li>)}</ul></details> : null}
            <div className="row">
              <form action={setGrowthFixStatusAction}><input type="hidden" name="id" value={asoFix.id} /><input type="hidden" name="status" value="merged" /><button className="secondary small">{asoFix.status === "merged" ? "✓ Updated in Play Console" : "I updated Play Console"}</button></form>
              <form action={setGrowthFixStatusAction}><input type="hidden" name="id" value={asoFix.id} /><input type="hidden" name="status" value="dismissed" /><button className="secondary small">Dismiss</button></form>
            </div>
          </div>
        ) : asoFix?.error ? <p className="flash err">{asoFix.error}</p> : <Empty>No proposal yet.</Empty>}

        <h3 style={{ marginTop: "1.25rem" }}>3. What people search for (content opportunities)</h3>
        <p className="muted" style={{ marginTop: 0 }}>Searches where your sites already show in Google but rank too low to get clicks, and questions AI assistants answer without you. The Blog Writer picks the best one each day; you can also turn them into posts on the <Link href="/trends">Trends</Link> page.</p>
        {opportunities.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Opportunity</th><th>Details</th><th className="num">Score</th><th>Status</th></tr></thead>
            <tbody>{opportunities.map((t) => (
              <tr key={t.id}><td>{t.title}</td><td className="muted" style={{ fontSize: "0.85rem" }}>{t.detail}</td><td className="num">{t.score}</td><td>{blogged.has(t.id) ? "Blog drafted" : t.status === "used" ? "Used" : "Open"}</td></tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>None yet. They appear after the Growth agent runs (needs Search Console connected).</Empty>}
      </section>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>What to fix next</h2>
        <p className="muted" style={{ marginTop: 0 }}>Most serious first; the same issue on several pages is listed once. Full details are in the reports in <code>Desktop\seo,llmo,aso\marketing\reports</code>.</p>
        {last?.fixes.length ? (
          <ul className="list">
            {last.fixes.map((f, i) => (
              <li key={i}>
                <div className="row">
                  <span className={`badge ${f.severity === "Critical" || f.severity === "High" ? "warn" : ""}`}>{f.area} · {f.severity}</span>
                  <b>{f.title}</b>
                  {f.url ? <a href={f.url} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: "0.85rem" }}>{f.url.replace(/^https?:\/\//, "")}</a> : null}
                </div>
                <div style={{ fontSize: "0.9rem" }}>→ {f.action}</div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{last ? "Nothing to fix. 🎉" : "No checks yet. Click “Run checks now”."}</Empty>
        )}
      </section>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>Blog articles drafted from trends</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          One a day. Each one is saved as a draft on the website: open it in <a href={`${SITE}/admin`} target="_blank" rel="noreferrer">the website admin</a>, check the facts, add a cover image and click Publish.
        </p>
        {blogs.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Article</th><th>Focus keyword</th><th>From trend</th><th>Status</th></tr></thead>
              <tbody>
                {blogs.map((b) => (
                  <tr key={b.id}>
                    <td>{fmtDate(b.createdAt.slice(0, 10))}</td>
                    <td>{b.status === "draft" && b.pushed ? <a href={`${SITE}/admin/blog/${b.slug}`} target="_blank" rel="noreferrer">{b.title}</a> : b.title}{b.words ? <span className="muted"> · {b.words} words</span> : null}</td>
                    <td>{b.focusKeyword}</td>
                    <td className="muted">{b.trendTitle}</td>
                    <td>{b.status === "failed" ? <span className="badge warn" title={b.error}>Failed</span> : b.pushed ? <span className="badge ok">Draft in admin</span> : <span className="badge" title={b.error}>Saved on this PC</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No articles yet. The first one is written on the next daily run, or click “Write a blog draft now”.</Empty>
        )}
      </section>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>Videos this fortnight</h2>
        <p className="muted" style={{ marginTop: 0 }}>YouTube Shorts carry the daily climate news; Instagram and Facebook rotate myth vs fact, eco hack, cartoon story and quiz.</p>
        {videos.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Platform</th><th>Series</th><th>Post</th><th>Status</th></tr></thead>
              <tbody>
                {videos.map((v) => (
                  <tr key={v.id}>
                    <td>{fmtDate(v.plannedDate)}</td>
                    <td>{PLATFORM_LABEL[v.platform] ?? v.platform}</td>
                    <td>{v.series ? SERIES_LABEL[v.series] : <span className="muted">{v.generatedBy === "template" ? "decided when written" : "classic explainer"}</span>}</td>
                    <td><Link href={`/content/${v.id}`}>{v.hook || v.topic}</Link>{v.sourceUrl ? <> · <a href={v.sourceUrl} target="_blank" rel="noreferrer" className="muted">source</a></> : null}</td>
                    <td>{v.status}{v.mediaUrls.length ? " · 🎬" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No video posts planned in this window.</Empty>
        )}
      </section>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>AI answers (LLMO)</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Your question set from <code>llmo/prompts.yaml</code>, asked to Claude every week twice: from memory (changes slowly, with new model versions) and with web search (like ChatGPT or Perplexity search answers; reacts to website and content fixes within weeks). “Mentioned” is checked automatically; read the excerpt before acting on it. Results are also added to the toolkit's <code>results.yaml</code>.
        </p>
        {llmo.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Question</th><th>Assistant</th><th>Mentioned?</th><th>What it said</th><th>Tested</th></tr></thead>
              <tbody>
                {llmo.map((r) => (
                  <tr key={`${r.platform}${r.promptId}`}>
                    <td>{r.prompt}</td>
                    <td>{r.platform === "claude_web" ? "Claude + web search" : r.platform === "claude" ? "Claude (from memory)" : r.platform}{r.cited ? " · 🔗 linked you" : ""}</td>
                    <td>{r.mentioned ? <span className={`badge ${r.accurate === false ? "warn" : "ok"}`}>{r.accurate === false ? "Yes, but confused" : "Yes"}</span> : <span className="badge">No</span>}</td>
                    <td className="muted" style={{ fontSize: "0.85rem" }}>{r.excerpt || (r.competitors.length ? `Named instead: ${r.competitors.join(", ")}` : "—")}</td>
                    <td>{fmtDate(r.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Not tested yet: AI visibility is unknown until the first weekly test runs.</Empty>
        )}
      </section>

      <section className="card">
        <h2>History</h2>
        {snaps.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>SEO critical + high</th><th>SEO minor</th><th>Fixed</th><th>Play listing</th><th>Brand conflicts</th><th>LLMO correct</th><th>Blog posts / drafts</th></tr></thead>
              <tbody>
                {[...snaps].reverse().slice(0, 30).map((s) => (
                  <tr key={s.date}>
                    <td>{fmtDate(s.date)}</td>
                    <td>{seoOpen(s) ?? "–"}</td>
                    <td>{s.seo ? s.seo.medium + s.seo.low : "–"}</td>
                    <td>{s.seo?.resolved ?? "–"}</td>
                    <td>{s.aso ? (s.aso.available ? "Live" : "Down") : "–"}</td>
                    <td>{s.brand?.conflicts ?? "–"}</td>
                    <td>{s.llmo ? `${s.llmo.accurate}/${s.llmo.tested}` : "–"}</td>
                    <td>{s.blog ? `${s.blog.posts} / ${s.blog.drafts}` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>The first row appears after the first daily check.</Empty>
        )}
      </section>
    </>
  );
}
