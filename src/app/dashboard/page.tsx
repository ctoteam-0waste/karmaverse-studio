import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { Empty, fmtDate, PageHead, PLATFORM_LABEL, PlatformChip } from "@/components/ui";
import { CHANNEL_COLOR, DailyLine, HBars, StackedDaily } from "@/components/charts";
import { analysisMetrics } from "@/lib/analytics/engine";
import { normalise } from "@/lib/analytics/advice";
import { syncMetricsAction } from "../actions";
import { funnelTrend, socialFunnel } from "@/lib/website/social";
import { SubmitButton } from "@/components/submit-button";

const fmtNum = (n: number) => (n >= 100000 ? `${(n / 100000).toFixed(1)}L` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const fmtIst = (d: string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Friendly names for Google Analytics events. */
const EVENT_LABEL: Record<string, string> = {
  page_view: "Pages viewed",
  scroll: "Scrolled down a page",
  session_start: "Visits started",
  user_engagement: "Stayed and interacted",
  first_visit: "First-time visitors",
  login: "Logged in",
  sign_up: "Signed up",
  reward_view: "Looked at rewards",
  reward_redeemed: "Redeemed a reward",
  schedule_pickup: "Scheduled a pickup",
  pickup_completed: "Pickup completed",
  click: "Clicked a link to another site",
  file_download: "Downloaded a file",
};
const ACTIONS = ["sign_up", "login", "schedule_pickup", "pickup_completed", "reward_redeemed"] as const;

export default async function DashboardPage() {
  const db = await readDb();
  const brand = activeBrand(db);
  const webRows = [...db.websiteStats].sort((a, b) => a.date.localeCompare(b.date));
  const web = webRows[webRows.length - 1];
  const since = Date.now() - 28 * 86_400_000;
  const posts = analysisMetrics(db.metrics, brand.id).filter((m) => !m.isSample && new Date(m.postedAt).getTime() >= since);
  const postRows = posts.map((m) => ({ m, n: normalise(m.metrics) })).map((x) => ({ ...x, eng: x.n.likes + x.n.comments + x.n.shares + x.n.saves }));
  const latestAccount = (p: string) => db.accountStats.filter((a) => a.brandId === brand.id && a.platform === p).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const socialPlatforms = brand.platforms.filter((p) => p !== "linkedin" && p !== "x");
  const socialReach = socialPlatforms.reduce((s, p) => s + (latestAccount(p)?.reach ?? 0), 0);
  const socialEng = postRows.reduce((s, r) => s + r.eng, 0);
  const ev = (name: string) => web?.events?.find((e) => e.name === name);
  const aiVisits = (web?.aiSources ?? []).reduce((s, a) => s + a.sessions, 0) || (web?.channels?.find((c) => c.channel === "AI Assistant")?.sessions ?? 0);
  const last = [...db.tracking].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const asoFix = [...db.growthFixes].filter((f) => f.kind === "aso" && f.aso).sort((a, b) => b.at.localeCompare(a.at))[0];
  const evByChannel = (name: string, channel: string) => web?.eventsByChannel?.find((e) => e.name === name && e.channel === channel)?.count ?? 0;
  const aso = [...db.asoStats].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const playClicks = (web?.outbound ?? []).filter((o) => /play\.google\.com/.test(o.url)).reduce((s, o) => s + o.count, 0);
  const visitsByPost = new Map<string, number>();
  for (const p of web?.posts ?? []) visitsByPost.set(p.contentId, (visitsByPost.get(p.contentId) ?? 0) + p.sessions);
  const titleOf = (id: string) => { const c = db.content.find((x) => x.id === id); return c ? c.hook || c.topic : id; };
  const funnel = socialFunnel(web);
  const trend = funnelTrend(webRows);

  return (
    <>
      <PageHead title="Growth dashboard" intro="Every visit, click and engagement in one place: website (SEO), AI assistants (LLMO), Play Store (ASO) and social. Last 28 days; refreshed every 6 hours.">
        <form action={syncMetricsAction}><SubmitButton className="secondary" pendingText="Checking…">Refresh numbers now</SubmitButton></form>
      </PageHead>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        {web ? <>Website numbers from Google Analytics and Search Console, read {fmtIst(web.at)}.</> : "Website tracking isn't connected yet (Results page → Connect website tracking)."}{" "}
        {db.settings.lastMetricsSync ? <>Social numbers read {fmtIst(db.settings.lastMetricsSync.at)}.</> : null}
      </p>

      <div className="grid four" style={{ marginBottom: "1rem" }}>
        <div className="card stat"><div className="label">🌐 Website visitors</div><div className="value">{web?.visitors !== undefined ? fmtNum(web.visitors) : "—"}</div><div className="label">{web ? `${fmtNum(web.sessions ?? 0)} visits · ${Math.round((web.engagementRate ?? 0) * 100)}% engaged` : ""}</div></div>
        <div className="card stat"><div className="label">🔎 Clicks from Google search</div><div className="value">{web?.search ? fmtNum(web.search.clicks) : "—"}</div><div className="label">{web?.search ? `${fmtNum(web.search.impressions)} times shown · ${(web.search.ctr * 100).toFixed(1)}% click rate` : ""}</div></div>
        <div className="card stat"><div className="label">🤖 Visits from AI assistants</div><div className="value">{web ? fmtNum(aiVisits) : "—"}</div><div className="label">{last?.llmoWeb ? `AI answers correct: ${last.llmoWeb.accurate}/${last.llmoWeb.tested} (with search)` : "ChatGPT, Perplexity, Gemini…"}</div></div>
        <div className="card stat"><div className="label">📣 Social reach</div><div className="value">{fmtNum(socialReach)}</div><div className="label">{fmtNum(socialEng)} likes, comments, shares and saves</div></div>
        <div className="card stat"><div className="label">✍️ Sign-ups on the website</div><div className="value">{ev("sign_up") ? fmtNum(ev("sign_up")!.count) : "—"}</div><div className="label">{ev("login") ? `${fmtNum(ev("login")!.users)} people logged in` : ""}</div></div>
        <div className="card stat"><div className="label">♻️ Pickups scheduled</div><div className="value">{ev("schedule_pickup") ? fmtNum(ev("schedule_pickup")!.count) : "—"}</div><div className="label">{ev("pickup_completed") ? `${ev("pickup_completed")!.count} completed · ${ev("reward_redeemed")?.count ?? 0} rewards redeemed` : ""}</div></div>
        <div className="card stat"><div className="label">📱 Play Store</div><div className="value">{last?.aso ? (last.aso.available ? "Live" : "Down") : "—"}</div><div className="label">{last?.aso?.rating != null ? `★ ${last.aso.rating}` : "No public rating yet"} · {playClicks} clicks from the website</div></div>
      </div>

      <h2 className="section-title">What social media brings: website, app, Google search, AI and Play Store</h2>
      {funnel ? (
        <section className="card" style={{ marginBottom: "1rem" }}>
          <div className="grid four">
            <div className="stat"><div className="label">📣 People reached on social</div><div className="value">{fmtNum(socialReach)}</div><div className="label">{fmtNum(socialPlatforms.reduce((s, p) => s + (latestAccount(p)?.profileViews ?? 0), 0))} profile visits · {fmtNum(socialPlatforms.reduce((s, p) => s + (latestAccount(p)?.linkClicks ?? 0), 0))} link clicks</div></div>
            <div className="stat"><div className="label">🌐 Website visits from social (SEO site)</div><div className="value">{fmtNum(funnel.visits)}</div><div className="label">{pct(funnel.visits, funnel.totalVisits)} of all visits{trend ? ` · ${trend.visits >= 0 ? "+" : ""}${trend.visits} since ${fmtDate(trend.from)}` : ""}</div></div>
            <div className="stat"><div className="label">✍️ Sign-ups and pickups from social (app)</div><div className="value">{fmtNum((funnel.actions.sign_up ?? 0) + (funnel.actions.schedule_pickup ?? 0))}</div><div className="label">{funnel.actions.sign_up ?? 0} sign-ups · {funnel.actions.login ?? 0} logins · {funnel.actions.schedule_pickup ?? 0} pickups</div></div>
            <div className="stat"><div className="label">🔎 Google searches for “KarmaVerse” (SEO)</div><div className="value">{funnel.brandSearch ? fmtNum(funnel.brandSearch.clicks) : "—"}</div><div className="label">{funnel.brandSearch ? `clicks from ${fmtNum(funnel.brandSearch.impressions)} brand searches${trend ? ` · ${trend.brandClicks >= 0 ? "+" : ""}${trend.brandClicks} since ${fmtDate(trend.from)}` : ""}` : "Search Console not connected"}</div></div>
            <div className="stat"><div className="label">🤖 Visits from AI assistants (LLMO)</div><div className="value">{fmtNum(funnel.aiVisits)}</div><div className="label">{last?.llmoWeb ? `KarmaVerse named in ${last.llmoWeb.mentioned}/${last.llmoWeb.tested} AI answers` : "ChatGPT, Perplexity, Gemini"}</div></div>
            <div className="stat"><div className="label">📱 Play Store (ASO)</div><div className="value">{aso?.storeAcquisitions !== undefined ? fmtNum(aso.storeAcquisitions) : aso?.installs !== undefined ? fmtNum(aso.installs) : "—"}</div><div className="label">{aso?.storeVisitors !== undefined ? `installs from ${fmtNum(aso.storeVisitors)} store visitors` : "installs (Play Console)"} · {funnel.playClicks} clicks to Play from the site</div></div>
          </div>
          <div className="grid two" style={{ marginTop: "0.75rem" }}>
            <div>
              <HBars title="Website visits by social platform" rows={funnel.byPlatform.length ? funnel.byPlatform.map((p) => ({ label: p.platform === "x" ? "X" : p.platform[0]!.toUpperCase() + p.platform.slice(1), value: p.visits, note: `${p.people} people` })) : [{ label: "No social visits yet", value: 0 }]} />
            </div>
            <div>
              <h3 style={{ marginTop: 0 }}>Posts that sent people to the website</h3>
              {funnel.byPost.length ? (
                <ul className="list" style={{ fontSize: "0.9rem" }}>{funnel.byPost.slice(0, 6).map((p) => <li key={p.contentId}><Link href={`/content/${p.contentId}`}>{titleOf(p.contentId).slice(0, 70)}</Link> · <b>{p.visits}</b> visits</li>)}</ul>
              ) : <p className="muted" style={{ fontSize: "0.88rem" }}>None yet. Links in new posts are tagged with the post, so each post&apos;s visits show here once people click them.</p>}
            </div>
          </div>
          <p className="muted" style={{ fontSize: "0.8rem", marginBottom: 0 }}>Last 28 days. Social visits are counted from Google Analytics (social channel and visits from instagram.com, facebook.com, youtube.com and others). Brand searches show how many people looked KarmaVerse up on Google, which rises as social reach grows. Installs by source (e.g. “from Instagram”) are only shown inside Play Console → Acquisition reports, so the Play number here is all installs.</p>
        </section>
      ) : <Empty>Connect website tracking to see how many people social media brings to the website, app, search and AI.</Empty>}

      <h2 className="section-title">Every visit to karmaverse.earth, by channel</h2>
      {web?.daily?.length ? (
        <div className="grid two">
          <section className="card"><StackedDaily rows={web.daily} title="Website visits per day by channel" /></section>
          <section className="card">
            <h3 style={{ marginTop: 0 }}>What each channel brings</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Channel</th><th className="num">Visits</th><th className="num">Engaged</th><th className="num">Sign-ups</th><th className="num">Logins</th><th className="num">Pickups</th></tr></thead>
              <tbody>{(web.channels ?? []).map((c) => (
                <tr key={c.channel}>
                  <td><span style={{ display: "inline-block", width: 10, height: 10, background: CHANNEL_COLOR[c.channel] ?? "#64748b", borderRadius: 2, marginRight: 6 }} />{c.channel}</td>
                  <td className="num">{fmtNum(c.sessions)}</td><td className="num">{pct(c.engaged, c.sessions)}</td>
                  <td className="num">{evByChannel("sign_up", c.channel)}</td><td className="num">{evByChannel("login", c.channel)}</td><td className="num">{evByChannel("schedule_pickup", c.channel)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>Engaged = stayed 10+ seconds, viewed 2+ pages or did something. Direct includes people opening the web app from a bookmark.</p>
          </section>
        </div>
      ) : <Empty>No daily website data yet. Click “Refresh numbers now”.</Empty>}

      <h2 className="section-title">What visitors did (every tracked click and action)</h2>
      {web?.events?.length ? (
        <section className="card">
          <HBars title="Website actions, last 28 days" highlight="Signed up" rows={web.events.filter((e) => e.name !== "page_view").map((e) => ({ label: EVENT_LABEL[e.name] ?? e.name, value: e.count, note: `${e.users} people`, color: (ACTIONS as readonly string[]).includes(e.name) ? "var(--ok)" : undefined }))} />
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>Green = actions that matter for the business. Plus {fmtNum(ev("page_view")?.count ?? 0)} pages viewed. {web.outbound?.length ? `Links clicked to other sites: ${web.outbound.map((o) => `${o.url.replace(/^https?:\/\//, "").slice(0, 40)} (${o.count})`).join(", ")}.` : ""}</p>
        </section>
      ) : <Empty>No events yet.</Empty>}

      <h2 className="section-title">SEO: Google search</h2>
      {web?.search ? (
        <div className="grid two">
          <section className="card">
            {web.search.daily?.length ? <DailyLine title="Google clicks and impressions per day" rows={web.search.daily} line={{ key: "clicks", label: "clicks" }} bars={{ key: "impressions", label: "times shown" }} /> : <Empty>No daily data yet.</Empty>}
            <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>Average position {web.search.position?.toFixed(1) ?? "—"}. Search Console data is about 2 days behind.</p>
          </section>
          <section className="card">
            <h3 style={{ marginTop: 0 }}>What people searched</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Search</th><th className="num">Shown</th><th className="num">Clicks</th><th className="num">Click rate</th><th className="num">Position</th></tr></thead>
              <tbody>{web.search.queries.slice(0, 12).map((q) => <tr key={q.query}><td>{q.query}</td><td className="num">{q.impressions}</td><td className="num">{q.clicks}</td><td className="num">{pct(q.clicks, q.impressions)}</td><td className="num">{q.position}</td></tr>)}</tbody>
            </table></div>
            {web.search.pages?.length ? <><h3>Pages people landed on from Google</h3><div className="table-wrap"><table>
              <thead><tr><th>Page</th><th className="num">Shown</th><th className="num">Clicks</th><th className="num">Position</th></tr></thead>
              <tbody>{web.search.pages.slice(0, 8).map((p) => <tr key={p.page}><td>{p.page.replace(/^https?:\/\/[^/]+/, "") || "/"}</td><td className="num">{p.impressions}</td><td className="num">{p.clicks}</td><td className="num">{p.position}</td></tr>)}</tbody>
            </table></div></> : null}
          </section>
        </div>
      ) : <Empty>Search Console isn&apos;t connected.</Empty>}

      <h2 className="section-title">LLMO: AI assistants</h2>
      <div className="grid two">
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Visits from AI assistants</h3>
          {web?.aiSources?.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>Assistant</th><th className="num">Visits</th><th className="num">Engaged</th></tr></thead>
              <tbody>{web.aiSources.map((a) => <tr key={a.source}><td>{a.source}</td><td className="num">{a.sessions}</td><td className="num">{pct(a.engaged, a.sessions)}</td></tr>)}</tbody>
            </table></div>
          ) : <Empty>No visits from AI assistants recorded yet.</Empty>}
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>People who clicked a link to karmaverse.earth inside ChatGPT, Perplexity, Gemini, Copilot or Claude.</p>
        </section>
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Do AI assistants describe KarmaVerse correctly?</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Week</th><th className="num">From memory</th><th className="num">With web search</th><th className="num">Linked your sites</th></tr></thead>
            <tbody>{[...db.tracking].filter((s) => s.llmo || s.llmoWeb).reverse().slice(0, 8).map((s) => (
              <tr key={s.date}><td>{fmtDate(s.date)}</td><td className="num">{s.llmo ? `${s.llmo.accurate}/${s.llmo.tested}` : "—"}</td><td className="num">{s.llmoWeb ? `${s.llmoWeb.accurate}/${s.llmoWeb.tested}` : "—"}</td><td className="num">{s.llmoWeb ? s.llmoWeb.cited : "—"}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>11 questions every week. Every answer is on the <Link href="/tracking">Tracking</Link> page.</p>
        </section>
      </div>

      <h2 className="section-title">ASO: Play Store</h2>
      <section className="card">
        <div className="grid four">
          <div><div className="muted" style={{ fontSize: "0.85rem" }}>Listing</div><b>{last?.aso ? (last.aso.available ? "Live" : "Down") : "—"}</b></div>
          <div><div className="muted" style={{ fontSize: "0.85rem" }}>Rating</div><b>{last?.aso?.rating != null ? `★ ${last.aso.rating} (${last.aso.reviews ?? 0})` : "No public rating yet"}</b></div>
          <div><div className="muted" style={{ fontSize: "0.85rem" }}>Clicks to Play from the website</div><b>{playClicks}</b></div>
          <div><div className="muted" style={{ fontSize: "0.85rem" }}>New listing proposal</div><b>{asoFix ? `${asoFix.status === "merged" ? "Applied" : asoFix.status === "ready" ? "Waiting for review" : asoFix.status} (${fmtDate(asoFix.date)})` : "—"}</b></div>
        </div>
        {aso ? (
          <>
            <div className="grid four" style={{ marginTop: "0.8rem" }}>
              <div><div className="muted" style={{ fontSize: "0.85rem" }}>Installs (28 days)</div><b>{aso.installs !== undefined ? fmtNum(aso.installs) : "—"}</b>{aso.uninstalls !== undefined ? <span className="muted"> · {fmtNum(aso.uninstalls)} uninstalls</span> : null}</div>
              <div><div className="muted" style={{ fontSize: "0.85rem" }}>Store visitors → installs</div><b>{aso.storeVisitors !== undefined ? `${fmtNum(aso.storeVisitors)} → ${fmtNum(aso.storeAcquisitions ?? 0)}` : "—"}</b>{aso.conversion !== undefined ? <span className="muted"> · {(aso.conversion * 100).toFixed(1)}%</span> : null}</div>
              <div><div className="muted" style={{ fontSize: "0.85rem" }}>Crash rate (users)</div><b style={{ color: aso.userPerceivedCrashRate != null && aso.userPerceivedCrashRate > 0.0109 ? "var(--bad)" : undefined }}>{aso.userPerceivedCrashRate != null ? `${(aso.userPerceivedCrashRate * 100).toFixed(2)}%` : "—"}</b><span className="muted"> · Google's limit 1.09%</span></div>
              <div><div className="muted" style={{ fontSize: "0.85rem" }}>ANR rate (users)</div><b style={{ color: aso.userPerceivedAnrRate != null && aso.userPerceivedAnrRate > 0.0047 ? "var(--bad)" : undefined }}>{aso.userPerceivedAnrRate != null ? `${(aso.userPerceivedAnrRate * 100).toFixed(2)}%` : "—"}</b><span className="muted"> · Google's limit 0.47%</span></div>
            </div>
            {aso.reviews.length ? (
              <div className="table-wrap" style={{ marginTop: "0.8rem" }}><table>
                <thead><tr><th>Stars</th><th>Review (last 7 days)</th><th>Version</th></tr></thead>
                <tbody>{aso.reviews.slice(0, 10).map((r) => <tr key={r.id}><td>{"★".repeat(r.stars)}{"☆".repeat(Math.max(0, 5 - r.stars))}</td><td>{r.text || "—"}</td><td>{r.version}</td></tr>)}</tbody>
              </table></div>
            ) : <p className="muted" style={{ fontSize: "0.82rem" }}>No new Play reviews in the last 7 days.</p>}
            <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>Google Play Console, {fmtDate(aso.from)} – {fmtDate(aso.to)}, read {fmtIst(aso.at)}.{aso.installs === undefined ? " Installs, store visitors and conversion appear once the Play reports bucket is added." : ""}</p>
          </>
        ) : (
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>Play Console isn&apos;t connected yet: installs, store visitors, conversion, crashes, ANRs and reviews appear here once it is.</p>
        )}
      </section>

      <h2 className="section-title">Social: reach and engagement</h2>
      <div className="grid two">
        <section className="card">
          <div className="table-wrap"><table>
            <thead><tr><th>Platform</th><th className="num">Reached</th><th className="num">Views</th><th className="num">Engagements</th><th className="num">Profile visits</th><th className="num">Link clicks</th><th className="num">Followers</th></tr></thead>
            <tbody>{socialPlatforms.map((p) => {
              const a = latestAccount(p);
              const rows = postRows.filter((r) => r.m.platform === p);
              return (
                <tr key={p}>
                  <td><PlatformChip platform={p} /></td>
                  <td className="num">{a?.reach !== undefined ? fmtNum(a.reach) : "—"}</td>
                  <td className="num">{a?.views !== undefined ? fmtNum(a.views) : fmtNum(rows.reduce((s, r) => s + (r.n.views ?? 0), 0))}</td>
                  <td className="num">{fmtNum(rows.reduce((s, r) => s + r.eng, 0))}</td>
                  <td className="num">{a?.profileViews !== undefined ? fmtNum(a.profileViews) : "—"}</td>
                  <td className="num">{a?.linkClicks !== undefined ? fmtNum(a.linkClicks) : rows.some((r) => r.n.clicks !== null) ? fmtNum(rows.reduce((s, r) => s + (r.n.clicks ?? 0), 0)) : "—"}</td>
                  <td className="num">{a?.followers !== undefined ? fmtNum(a.followers) : "—"}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>Engagements = likes, comments, shares and saves on posts from the last 28 days.</p>
        </section>
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Top posts by engagement</h3>
          {postRows.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>Post</th><th className="num">Views</th><th className="num">Engagements</th><th className="num">Site visits</th></tr></thead>
              <tbody>{[...postRows].sort((a, b) => b.eng - a.eng || (b.n.views ?? 0) - (a.n.views ?? 0)).slice(0, 10).map(({ m, n, eng }) => (
                <tr key={m.id}>
                  <td><PlatformChip platform={m.platform} /> {m.contentId ? <Link href={`/content/${m.contentId}`}>{(m.hook || "post").slice(0, 55)}</Link> : m.hook}</td>
                  <td className="num">{n.views === null ? "—" : fmtNum(n.views)}</td><td className="num">{eng}</td>
                  <td className="num">{m.contentId && visitsByPost.has(m.contentId) ? visitsByPost.get(m.contentId) : "—"}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty>No posts with numbers in the last 28 days.</Empty>}
          {web?.posts?.length ? <p className="muted" style={{ fontSize: "0.82rem" }}>Posts that sent visitors: {[...visitsByPost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, v]) => `${titleOf(id)} (${v})`).join(" · ")}</p> : <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>Site visits per post appear as tagged links in new posts get clicked.</p>}
        </section>
      </div>
      <p className="muted" style={{ fontSize: "0.82rem" }}>More detail: <Link href="/analytics">Results</Link> (every post) · <Link href="/tracking">Tracking</Link> (SEO, LLMO, ASO fixes). {PLATFORM_LABEL.youtube} reach and click-through rate are only in YouTube Studio.</p>
    </>
  );
}
