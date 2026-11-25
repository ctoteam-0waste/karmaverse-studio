import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { analysisMetrics, bestPostingTimes, ctaPatterns, hookPatterns, MIN_SAMPLE, pillarPatterns, scorePosts, summarise, type PatternRow } from "@/lib/analytics/engine";
import { metricsFor } from "@/lib/analytics/metrics";
import { FormatSchema, PLATFORM_FORMATS, PlatformSchema, type Format, type Platform } from "@/lib/schemas";
import { Empty, Flash, fmtDate, fmtDiff, fmtScore, PageHead, PLATFORM_LABEL, PlatformChip, SampleBadge, sp, type SearchParams } from "@/components/ui";
import { adviceFor, platformResults, VIDEO_CHECKLIST, videoTuning } from "@/lib/analytics/advice";
import { connectionStatus } from "@/lib/publishing/agent";

const fmtNum = (n: number) => (n >= 100000 ? `${(n / 100000).toFixed(1)}L` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
import { addMetricAction, deleteMetricAction, importCsvAction, syncMetricsAction } from "../actions";
import { READ_SCOPES } from "@/lib/metrics/sync";
import { clickRate } from "@/lib/metrics/account";
import { visitsByPost, websiteConfigured, type WebsiteEnv } from "@/lib/website/google";
import { bioLink } from "@/lib/publishing/utm";
import type { AccountStat } from "@/lib/schemas";
import { SubmitButton } from "@/components/submit-button";

function Patterns({ title, rows, labelOf }: { title: string; rows: PatternRow[]; labelOf?: (s: string) => string }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Group</th><th>Pattern</th><th className="num">Posts</th><th className="num">vs group median</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.group}${r.label}`}>
                  <td>{r.group}</td>
                  <td>{labelOf ? labelOf(r.label) : r.label}</td>
                  <td className="num">{r.count}</td>
                  <td className="num">{r.lift === null ? <span className="muted">too few</span> : fmtDiff(r.lift)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No data yet.</Empty>
      )}
    </section>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const allMine = db.metrics.filter((m) => m.brandId === brand.id);
  const metrics = analysisMetrics(db.metrics, brand.id);
  const hiddenSamples = allMine.length - metrics.length;
  const fromApi = metrics.filter((m) => m.source === "api").length;
  const sync = db.settings.lastMetricsSync;
  const scored = scorePosts(metrics);
  const groups = summarise(scored);
  const group = sp(params, "group");
  const shown = [...scored].filter((s) => !group || `${s.post.platform}/${s.post.format}` === group).reverse();
  const times = bestPostingTimes(scored);
  const pillarName = (id: string) => brand.pillars.find((p) => p.id === id)?.name ?? id;
  const results = platformResults(metrics).filter((r) => brand.platforms.includes(r.platform));
  const autoRead = connectionStatus(brand, db).filter((c) => c.connected).map((c) => c.platform);
  const tips = adviceFor({ results, content: db.content.filter((c) => c.brandId === brand.id), looks: db.settings.videoLooks, autoRead, syncNotes: sync?.notes ?? [] });
  const tuning = videoTuning(metrics);
  const allRows = results.flatMap((r) => r.rows).sort((a, b) => b.metric.postedAt.localeCompare(a.metric.postedAt));
  // Account reach and clicks: the latest row per platform, and the row from about a week earlier for the change.
  const mineStats = db.accountStats.filter((a) => a.brandId === brand.id);
  const reachCards = brand.platforms.flatMap((platform) => {
    const rows = mineStats.filter((a) => a.platform === platform).sort((a, b) => a.date.localeCompare(b.date));
    const now = rows[rows.length - 1];
    if (!now) return [];
    const weekAgo = [...rows].reverse().find((a) => a.date <= new Date(new Date(now.date).getTime() - 6 * 86_400_000).toISOString().slice(0, 10));
    return [{ platform, now, weekAgo }];
  });
  const webRows = [...db.websiteStats].sort((a, b) => a.date.localeCompare(b.date));
  const web = webRows[webRows.length - 1];
  const webWeekAgo = web ? [...webRows].reverse().find((w) => w.date <= new Date(new Date(web.date).getTime() - 6 * 86_400_000).toISOString().slice(0, 10)) : undefined;
  const webCfg = websiteConfigured(process.env as WebsiteEnv);
  const siteVisits = visitsByPost(web, db.content);
  const postTitle = (id: string) => { const c = db.content.find((x) => x.id === id); return c ? c.hook || c.topic : id; };
  const change = (now: number | undefined, before: number | undefined) => (now === undefined || before === undefined || before === 0 ? null : (now - before) / before);
  const postsReach = (p: Platform) => {
    const since = Date.now() - 28 * 86_400_000;
    const rows = allRows.filter((r) => r.metric.platform === p && new Date(r.metric.postedAt).getTime() >= since);
    return { posts: rows.length, views: rows.reduce((s, r) => s + (r.n.views ?? 0), 0), clicks: rows.reduce((s, r) => s + (r.n.clicks ?? 0), 0) };
  };
  const Stat = ({ value, label, diff }: { value: string; label: string; diff?: number | null }) => (
    <div><b>{value}</b><span>{label}{diff !== undefined && diff !== null ? <> · <span className={diff >= 0 ? "ok-text" : "warn-text"}>{diff >= 0 ? "▲" : "▼"} {Math.abs(Math.round(diff * 100))}%</span></> : null}</span></div>
  );
  const show = (a: AccountStat, k: "reach" | "views" | "profileViews" | "linkClicks" | "followers") => (a[k] === undefined ? "—" : fmtNum(a[k]!));

  const formPlatform: Platform = PlatformSchema.safeParse(sp(params, "platform")).success ? (sp(params, "platform") as Platform) : brand.platforms[0] ?? "instagram";
  const fmtParsed = FormatSchema.safeParse(sp(params, "format"));
  const formFormat: Format = fmtParsed.success && PLATFORM_FORMATS[formPlatform].includes(fmtParsed.data) ? fmtParsed.data : PLATFORM_FORMATS[formPlatform][0]!;
  const defs = metricsFor(formPlatform, formFormat);

  return (
    <>
      <PageHead title="Results" intro="How your posts are doing on each platform, and what to change to get more likes, comments and shares." />
      <Flash params={params} />
      {metrics.some((m) => m.isSample) ? <div className="flash info">Rows marked <SampleBadge show /> are invented demo numbers. They are used only until your first real numbers arrive, then left out automatically. Remove them for good in Settings.</div> : null}
      {hiddenSamples > 0 ? <div className="flash info">Using your real data only: {hiddenSamples} sample row(s) are left out of all analysis. Remove them in Settings.</div> : null}

      <div className="row sync-bar">
        <span>🔄 {sync ? <>Numbers last checked <b>{new Date(sync.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</b> (every 6 hours automatically)</> : "Numbers haven't been checked yet."}</span>
        <span className="spacer" />
        <form action={syncMetricsAction}><SubmitButton className="secondary" pendingText="Checking…">Check numbers now</SubmitButton></form>
      </div>
      {sync?.failed ? (
        <details className="flash info"><summary>{sync.failed} post(s) couldn&apos;t be read last time. Details</summary><ul style={{ margin: "0.4rem 0 0" }}>{sync.notes.map((n) => <li key={n}>{n}</li>)}</ul></details>
      ) : null}

      <h2 className="section-title">Reach &amp; clicks (last 28 days)</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        <b>People reached</b> = different accounts that saw your posts. <b>Link clicks</b> = taps on your bio link / website button (Instagram) or on links in posts (Facebook).
        <b> Click rate</b> = link clicks ÷ people reached. Updated with the numbers every 6 hours.
      </p>
      {reachCards.length ? (
        <div className="grid platforms">
          {reachCards.map(({ platform, now, weekAgo }) => {
            const rate = clickRate(now);
            const pr = postsReach(platform);
            const visitRate = now.reach && now.profileViews !== undefined ? now.profileViews / now.reach : null;
            return (
              <section key={platform} className="card pf-card">
                <header className="row"><PlatformChip platform={platform} /><span className="spacer" />{now.followers !== undefined ? <span className="badge info">{fmtNum(now.followers)} {platform === "youtube" ? "subscribers" : "followers"}</span> : null}</header>
                <div className="pf-nums">
                  {platform === "youtube" ? (
                    <>
                      <Stat value={fmtNum(pr.views)} label="views (new posts)" />
                      <Stat value={String(pr.posts)} label="posts" />
                    </>
                  ) : (
                    <>
                      <Stat value={show(now, "reach")} label="people reached" diff={change(now.reach, weekAgo?.reach)} />
                      <Stat value={show(now, "views")} label="views" diff={change(now.views, weekAgo?.views)} />
                      <Stat value={show(now, "profileViews")} label={platform === "facebook" ? "Page visits" : "profile visits"} />
                      <Stat value={platform === "facebook" ? fmtNum(pr.clicks) : show(now, "linkClicks")} label="link clicks" />
                    </>
                  )}
                </div>
                {platform === "youtube" ? (
                  <p className="pf-line muted">Reach (impressions) and click-through rate for YouTube are only in YouTube Studio → Analytics → Reach. The API doesn&apos;t give them.</p>
                ) : (
                  <p className="pf-line">
                    Click rate <b>{platform === "facebook" ? (now.reach ? `${((pr.clicks / now.reach) * 100).toFixed(1)}%` : "—") : rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}</b>
                    {visitRate !== null ? <> · profile visit rate <b>{(visitRate * 100).toFixed(1)}%</b></> : null}
                    {now.engaged !== undefined && now.reach ? <> · <b>{((now.engaged / now.reach) * 100).toFixed(1)}%</b> of people reached reacted</> : null}
                  </p>
                )}
                {platform === "instagram" && now.reach && !now.linkClicks ? <p className="pf-line muted">0 link clicks: check that the Instagram bio has the karmaverse.earth / Play Store link, and say “link in bio” in captions.</p> : null}
              </section>
            );
          })}
        </div>
      ) : (
        <Empty>No reach numbers yet. Click “Check numbers now” above.</Empty>
      )}

      <h2 className="section-title">Website: {brand.website?.replace(/^https?:\/\//, "") || "your site"} (last 28 days)</h2>
      {web ? (
        <>
          <div className="grid platforms">
            <section className="card pf-card">
              <header className="row"><b>🌐 Visitors (Google Analytics)</b><span className="spacer" /><span className="badge ok">Read automatically</span></header>
              {web.visitors !== undefined ? (
                <>
                  <div className="pf-nums">
                    <Stat value={fmtNum(web.visitors)} label="visitors" diff={change(web.visitors, webWeekAgo?.visitors)} />
                    <Stat value={fmtNum(web.sessions ?? 0)} label="visits" diff={change(web.sessions, webWeekAgo?.sessions)} />
                    <Stat value={fmtNum(web.pageViews ?? 0)} label="page views" />
                    <Stat value={fmtNum(web.fromSocial ?? 0)} label="visits from social" diff={change(web.fromSocial, webWeekAgo?.fromSocial)} />
                  </div>
                  <p className="pf-line">
                    {web.sessions ? <><b>{Math.round(((web.fromSocial ?? 0) / web.sessions) * 100)}%</b> of visits came from social · </> : null}
                    <b>{Math.round((web.engagementRate ?? 0) * 100)}%</b> of visits were engaged (10 s+, 2+ pages or an action) · {fmtNum(web.newVisitors ?? 0)} new visitors
                  </p>
                </>
              ) : <p className="muted pf-empty">Google Analytics isn&apos;t connected (see the setup below).</p>}
            </section>
            <section className="card pf-card">
              <header className="row"><b>🔎 Google search (Search Console)</b><span className="spacer" /></header>
              {web.search ? (
                <>
                  <div className="pf-nums">
                    <Stat value={fmtNum(web.search.impressions)} label="times shown in Google" diff={change(web.search.impressions, webWeekAgo?.search?.impressions)} />
                    <Stat value={fmtNum(web.search.clicks)} label="clicks from Google" diff={change(web.search.clicks, webWeekAgo?.search?.clicks)} />
                    <Stat value={`${(web.search.ctr * 100).toFixed(1)}%`} label="click rate" />
                    <Stat value={web.search.position === null ? "—" : web.search.position.toFixed(1)} label="average position" />
                  </div>
                  {web.search.queries.length ? <p className="pf-line muted">Top searches: {web.search.queries.slice(0, 5).map((q) => `“${q.query}” (${q.clicks} clicks, ${q.impressions} shown)`).join(" · ")}</p> : null}
                </>
              ) : <p className="muted pf-empty">Search Console isn&apos;t connected (see the setup below).</p>}
            </section>
          </div>
          <div className="grid two" style={{ marginTop: "1rem" }}>
            <section className="card">
              <h3 style={{ marginTop: 0 }}>Where visitors came from</h3>
              {web.sources.length ? (
                <div className="table-wrap"><table>
                  <thead><tr><th>Source</th><th>Type</th><th className="num">Visits</th><th className="num">Visitors</th></tr></thead>
                  <tbody>{web.sources.map((s) => <tr key={s.source + s.medium}><td>{s.source}</td><td>{s.medium}</td><td className="num">{fmtNum(s.sessions)}</td><td className="num">{fmtNum(s.visitors)}</td></tr>)}</tbody>
                </table></div>
              ) : <Empty>No visits recorded yet.</Empty>}
            </section>
            <section className="card">
              <h3 style={{ marginTop: 0 }}>Posts that sent visitors to the website</h3>
              {web.posts.length ? (
                <div className="table-wrap"><table>
                  <thead><tr><th>Post</th><th>From</th><th className="num">Visits</th></tr></thead>
                  <tbody>{[...web.posts].sort((a, b) => b.sessions - a.sessions).slice(0, 15).map((p) => <tr key={p.contentId + p.source}><td>{db.content.some((c) => c.id === p.contentId) ? <Link href={`/content/${p.contentId}`}>{postTitle(p.contentId)}</Link> : p.contentId}</td><td>{p.source}</td><td className="num">{fmtNum(p.sessions)}</td></tr>)}</tbody>
                </table></div>
              ) : <Empty>No visits from tagged post links yet. Links to the website in new posts are tagged automatically from now on.</Empty>}
              {web.pages.length ? <p className="muted" style={{ marginBottom: 0 }}>Top landing pages: {web.pages.slice(0, 5).map((p) => `${p.page} (${p.sessions})`).join(" · ")}</p> : null}
            </section>
          </div>
        </>
      ) : null}
      {!webCfg.ga4 || !webCfg.gsc ? (
        <details className="card" open={!web} style={{ marginTop: web ? "1rem" : 0 }}>
          <summary><b>Connect website tracking</b> ({[!webCfg.ga4 ? "Google Analytics" : "", !webCfg.gsc ? "Search Console" : ""].filter(Boolean).join(" and ")} not connected yet)</summary>
          <p className="muted">karmaverse.earth already records visits in Google Analytics 4 (G-8Z7CRL6KKG). To show them here, give the studio read-only access once:</p>
          <ol className="tip-how">
            <li>In <a href="https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com" target="_blank" rel="noreferrer">Google Cloud</a> (same project as YouTube is fine), enable <b>Google Analytics Data API</b> and <b>Google Search Console API</b>.</li>
            <li>IAM &amp; Admin → Service accounts → <b>Create service account</b> (no roles needed) → Keys → Add key → JSON. Save the file on this PC, e.g. <code>C:\Users\OM\Downloads\social-growth-agent\data\google-key.json</code>.</li>
            <li>Google Analytics → Admin → <b>Property access management</b> → add the service account&apos;s email as <b>Viewer</b>. Copy the numeric <b>Property ID</b> from Admin → Property details.</li>
            <li>Search Console → karmaverse.earth → Settings → <b>Users and permissions</b> → add the same email (Restricted).</li>
            <li>Add to <code>.env.local</code>, then restart the studio:<pre style={{ whiteSpace: "pre-wrap" }}>{"GOOGLE_SERVICE_ACCOUNT_FILE=C:\\Users\\OM\\Downloads\\social-growth-agent\\data\\google-key.json\nGA4_PROPERTY_ID=123456789\nGSC_SITE=sc-domain:karmaverse.earth"}</pre></li>
          </ol>
        </details>
      ) : null}
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Links to karmaverse.earth, 0waste.co.in and the Play Store in posts are tagged automatically (utm_source = platform, utm_content = post), so each visit is credited to its post.
        Instagram captions can&apos;t have links. Put this tagged link in the Instagram bio: <code>{bioLink(brand.website || "https://karmaverse.earth", "instagram")}</code>
      </p>

      <h2 className="section-title">Each platform</h2>
      <div className="grid platforms">
        {results.map((r) => (
          <section key={r.platform} className="card pf-card">
            <header className="row"><PlatformChip platform={r.platform} /><span className="spacer" />{autoRead.includes(r.platform) ? <span className="badge ok">Read automatically</span> : <span className="badge info">Add by hand</span>}</header>
            {r.posts ? (
              <>
                <div className="pf-nums">
                  <div><b>{fmtNum(r.views)}</b><span>{r.platform === "facebook" ? "plays" : "views"}</span></div>
                  <div><b>{fmtNum(r.likes)}</b><span>{r.platform === "facebook" ? "reactions" : "likes"}</span></div>
                  <div><b>{fmtNum(r.comments)}</b><span>comments</span></div>
                  <div><b>{fmtNum(r.shares)}</b><span>shares</span></div>
                </div>
                <p className="pf-line">{r.posts} post{r.posts === 1 ? "" : "s"} · <b>{r.engagement === null ? "—" : `${(r.engagement * 100).toFixed(1)}%`}</b> of viewers reacted{r.watch !== null ? <> · watched <b>{Math.round(r.watch * 100)}%</b> on average</> : null}</p>
                {r.best ? <p className="pf-line muted">Best: {r.best.metric.contentId ? <Link href={`/content/${r.best.metric.contentId}`}>{r.best.metric.hook || "post"}</Link> : r.best.metric.hook}</p> : null}
              </>
            ) : (
              <p className="muted pf-empty">{autoRead.includes(r.platform) ? "No published posts with numbers yet." : `No numbers yet. After posting, open the post and add its numbers from the ${PLATFORM_LABEL[r.platform]} app.`}</p>
            )}
          </section>
        ))}
      </div>

      <h2 className="section-title">How to get more likes, comments and shares</h2>
      <div className="stack">
        {tips.map((t) => (
          <section key={t.title} className="card tip">
            <div className="tip-icon" aria-hidden>{t.icon}</div>
            <div className="stack" style={{ gap: "0.35rem" }}>
              <h3 style={{ margin: 0 }}>{t.title}</h3>
              <p className="muted" style={{ margin: 0 }}>{t.why}</p>
              <ul className="tip-how">{t.how.map((h) => <li key={h}>{h}</li>)}</ul>
              {t.link ? <a className="btn secondary small" href={t.link.href} target={t.link.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" style={{ alignSelf: "flex-start" }}>{t.link.label} →</a> : null}
            </div>
          </section>
        ))}
        <section className="card">
          <h3 style={{ marginTop: 0 }}>🎬 Checklist for every Earth Buddy video</h3>
          <ul className="tip-how">{VIDEO_CHECKLIST.map((c) => <li key={c}>✓ {c}</li>)}</ul>
          {tuning.reason ? <p className="muted" style={{ marginBottom: 0 }}>Video maker setting from your results: <b>{tuning.reason}</b></p> : null}
        </section>
      </div>

      <h2 className="section-title">Every post</h2>
      <section className="card">
        {allRows.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Posted</th><th>Platform</th><th>Post</th><th className="num">Views</th><th className="num">Reached</th><th className="num">Clicks</th><th className="num">Site visits</th><th className="num">Likes</th><th className="num">Comments</th><th className="num">Shares</th><th className="num">Reacted</th><th className="num">Watched</th></tr></thead>
              <tbody>
                {allRows.map(({ metric: m, n, rate }) => (
                  <tr key={m.id}>
                    <td>{fmtDate(m.postedAt)}</td>
                    <td><PlatformChip platform={m.platform} /></td>
                    <td>{m.contentId ? <Link href={`/content/${m.contentId}`}>{m.hook || "post"}</Link> : m.hook || "—"} <SampleBadge show={m.isSample} /></td>
                    <td className="num">{n.views === null ? "—" : fmtNum(n.views)}</td>
                    <td className="num">{n.reach === null ? "—" : fmtNum(n.reach)}</td>
                    <td className="num">{n.clicks === null ? "—" : fmtNum(n.clicks)}</td>
                    <td className="num">{m.contentId && siteVisits.has(m.contentId) ? fmtNum(siteVisits.get(m.contentId)!) : "—"}</td>
                    <td className="num">{fmtNum(n.likes)}</td>
                    <td className="num">{fmtNum(n.comments)}</td>
                    <td className="num">{fmtNum(n.shares)}</td>
                    <td className="num">{rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}</td>
                    <td className="num">{n.watch === null ? "—" : `${Math.round(n.watch * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No numbers yet.</Empty>}
      </section>

      <details className="card advanced" style={{ marginTop: "1rem" }}>
        <summary>Advanced analysis (scores, patterns, posting windows, CSV import)</summary>
        <div style={{ marginTop: "1rem" }}>
        <p className="muted">Reads views, likes, saves, shares and watch time for published posts from each connected platform. {fromApi ? <b>{fromApi} post(s) here came from the platforms.</b> : null}</p>
        <details style={{ marginBottom: "1rem" }}>
          <summary style={{ cursor: "pointer" }}>Read permissions each platform needs</summary>
          <ul style={{ fontSize: "0.85rem" }}>{Object.entries(READ_SCOPES).map(([p, s]) => <li key={p}><b>{PLATFORM_LABEL[p]}</b>: {s}</li>)}</ul>
        </details>

      <section className="card">
        <h2>By platform and format</h2>
        {groups.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Group</th><th className="num">Posts</th><th>Primary score</th><th className="num">Median score</th><th className="num">Median volume</th><th className="num">Trend</th><th></th></tr></thead>
              <tbody>
                {groups.map((g) => {
                  const key = `${g.platform}/${g.format}`;
                  return (
                    <tr key={key}>
                      <td>{PLATFORM_LABEL[g.platform]} {g.format}</td>
                      <td className="num">{g.count}</td>
                      <td>{g.scoreLabel}</td>
                      <td className="num">{fmtScore(g.medianScore, g.scoreFormat)}</td>
                      <td className="num">{g.medianVolume ?? "—"} <span className="muted">{g.volumeLabel.toLowerCase()}</span></td>
                      <td className="num">{fmtDiff(g.trend)}</td>
                      <td><Link className="btn secondary small" href={group === key ? "/analytics" : `/analytics?group=${key}`}>{group === key ? "Show all" : "Posts"}</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No metrics yet. Add a post's numbers below or import a CSV.</Empty>
        )}
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Posts {group ? `— ${group}` : ""}</h2>
        {shown.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Posted</th><th>Group</th><th>Hook</th><th>Pillar</th><th className="num">Score</th><th className="num">vs earlier posts</th><th></th></tr></thead>
              <tbody>
                {shown.map((s) => {
                  const d = metricsFor(s.post.platform, s.post.format);
                  return (
                    <tr key={s.post.id}>
                      <td>{fmtDate(s.post.postedAt)}</td>
                      <td>{PLATFORM_LABEL[s.post.platform]} {s.post.format}</td>
                      <td>{s.post.hook || "—"} <SampleBadge show={s.post.isSample} />{s.post.source === "api" ? <span className="badge info" title={s.post.syncedAt ? `Synced ${new Date(s.post.syncedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}>auto</span> : null}</td>
                      <td>{pillarName(s.post.pillarId)}</td>
                      <td className="num">{fmtScore(s.score, d?.primary.format)}</td>
                      <td className="num">{s.vsHistory ? fmtDiff(s.vsHistory.diff) : <span className="muted">needs {MIN_SAMPLE} earlier</span>}</td>
                      <td>
                        <div className="row">
                          <Link className="btn secondary small" href={`/analytics/${s.post.id}`}>Diagnose</Link>
                          <form action={deleteMetricAction}><input type="hidden" name="id" value={s.post.id} /><button className="secondary small" aria-label="Delete row">✕</button></form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No posts.</Empty>
        )}
      </section>

      <div className="grid two" style={{ marginTop: "1rem" }}>
        <Patterns title="Hook styles" rows={hookPatterns(scored)} />
        <Patterns title="CTAs" rows={ctaPatterns(scored)} />
        <Patterns title="Pillars" rows={pillarPatterns(scored)} labelOf={pillarName} />
        <section className="card">
          <h2>Posting windows (IST)</h2>
          <ul className="list">
            {times.map((t) => (
              <li key={t.group}>
                <b>{t.group}</b>: {t.bucket} <span className={`badge ${t.basis === "data" ? "ok" : "warn"}`}>{t.basis === "data" ? "from data" : "experiment"}</span>
                <div className="muted" style={{ fontSize: "0.85rem" }}>{t.note}</div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="grid two" style={{ marginTop: "1rem" }}>
        <section className="card" id="add">
          <h2>Add a post's metrics</h2>
          <form action="/analytics#add" className="row" style={{ marginBottom: "0.75rem" }}>
            <select name="platform" defaultValue={formPlatform}>{brand.platforms.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select>
            <select name="format" defaultValue={formFormat}>{PLATFORM_FORMATS[formPlatform].map((f) => <option key={f} value={f}>{f}</option>)}</select>
            <button className="secondary small" type="submit">Show fields</button>
          </form>
          {defs ? (
            <form action={addMetricAction} className="form-grid">
              <input type="hidden" name="platform" value={formPlatform} />
              <input type="hidden" name="format" value={formFormat} />
              <label>Posted at<input type="datetime-local" name="postedAt" required /></label>
              <label>Pillar<select name="pillarId"><option value="">—</option>{brand.pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label className="full">Hook / title<input name="hook" /></label>
              <label>CTA used<input name="cta" /></label>
              <label>Post URL<input name="url" type="url" /></label>
              {defs.metrics.map((m) => (
                <label key={m.key}>{m.label}{m.unit && m.unit !== "count" ? ` (${m.unit})` : ""}<input name={`m_${m.key}`} inputMode="decimal" /></label>
              ))}
              <div className="full"><button type="submit">Save metrics</button></div>
            </form>
          ) : null}
          <p className="muted" style={{ marginTop: "0.5rem" }}>Copy numbers from {formPlatform === "youtube" ? "YouTube Studio" : formPlatform === "linkedin" ? "LinkedIn page analytics" : "Meta Business Suite / Instagram Insights"} 7 days after posting, so posts are compared at the same age.</p>
        </section>

        <section className="card">
          <h2>Import CSV</h2>
          <form action={importCsvAction} className="stack">
            <textarea name="csv" rows={8} placeholder={"platform,format,postedAt,hook,pillarId,cta,url,reach,likes,comments,shares,saves\ninstagram,reel,2026-10-20T19:00:00+05:30,My hook,myths,Save,,1200,60,8,9,20"} required />
            <button type="submit">Import</button>
          </form>
          <details style={{ marginTop: "0.75rem" }}>
            <summary>Metric columns per platform and format</summary>
            <ul>
              {brand.platforms.flatMap((p) => PLATFORM_FORMATS[p].map((f) => {
                const d = metricsFor(p, f);
                return d ? <li key={`${p}${f}`}><b>{p}/{f}</b>: <code>{d.metrics.map((m) => m.key).join(", ")}</code></li> : null;
              }))}
            </ul>
          </details>
        </section>
      </div>
        </div>
      </details>
    </>
  );
}
