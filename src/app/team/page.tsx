import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { Empty, Flash, PageHead, PLATFORM_LABEL, sp, type SearchParams } from "@/components/ui";
import { teamEngagement } from "@/lib/team/engagement";
import { logTeamEngagementAction, saveTeamMembersAction } from "../actions";

const fmtIst = (d: string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDay = (d: string) => new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const RANGES = [7, 30, 90] as const;

export default async function TeamPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const days = RANGES.find((d) => String(d) === sp(params, "days")) ?? 30;
  const db = await readDb();
  const brand = activeBrand(db);
  const t = teamEngagement(db, brand.id, { days });
  const score = (m: (typeof t.members)[number]) => m.comments.length + m.likes + m.shares + m.reposts;
  const ranked = [...t.members].sort((a, b) => score(b) - score(a) || b.appActions - a.appActions);
  const totalTeamComments = t.members.reduce((n, m) => n + m.comments.length, 0);
  const engagedPosts = t.posts.filter((p) => Object.keys(p.byMember).length > 0).length;
  const sync = db.settings.lastCommunitySync;

  return (
    <>
      <PageHead
        title="Team engagement"
        intro="Who in the team is commenting on our published videos and posts, and who is reviewing content in the app. Comments come from the Comments inbox, matched to each person's social handles below."
      >
        <div className="row">
          {RANGES.map((d) => (
            <Link key={d} href={`/team?days=${d}`} className={`btn small ${d === days ? "" : "secondary"}`}>Last {d} days</Link>
          ))}
        </div>
      </PageHead>
      <Flash params={params} />

      <div className="grid four" style={{ marginBottom: "1rem" }}>
        <section className="card stat"><div className="value">{t.posts.length}</div><div className="label">posts published (last {days} days)</div></section>
        <section className="card stat"><div className="value">{engagedPosts}</div><div className="label">posts with a team comment</div></section>
        <section className="card stat"><div className="value">{totalTeamComments}</div><div className="label">comments from the team</div></section>
        <section className="card stat"><div className="value">{t.members.filter((m) => score(m) > 0).length}/{t.members.length}</div><div className="label">team members who engaged</div></section>
      </div>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>Leaderboard</h2>
        {ranked.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>Name</th><th className="num">Comments</th><th className="num">Likes</th><th className="num">Shares</th><th className="num">Reposts</th><th className="num">Posts engaged</th><th>Coverage</th><th className="num">Approvals</th><th className="num">App actions</th><th>Last active</th></tr>
              </thead>
              <tbody>
                {ranked.map((m, i) => (
                  <tr key={m.name}>
                    <td>{i + 1}</td>
                    <td>
                      <b>{m.name}</b>
                      <div className="muted" style={{ fontSize: "0.8rem" }}>{m.handles.length ? m.handles.join(", ") : <span className="badge warn">no handle yet</span>}</div>
                    </td>
                    <td className="num">{m.comments.length}</td>
                    <td className="num">{m.likes}</td>
                    <td className="num">{m.shares}</td>
                    <td className="num">{m.reposts}</td>
                    <td className="num">{m.postsEngaged}</td>
                    <td style={{ minWidth: 140 }}>
                      <div style={{ background: "var(--chip)", borderRadius: 999, height: 8, overflow: "hidden" }} aria-hidden>
                        <div style={{ width: `${Math.round(m.coverage * 100)}%`, height: "100%", background: "#16a34a" }} />
                      </div>
                      <span className="muted" style={{ fontSize: "0.8rem" }}>{Math.round(m.coverage * 100)}% of posts</span>
                    </td>
                    <td className="num">{m.approvals}</td>
                    <td className="num">{m.appActions}</td>
                    <td className="muted">{m.lastActive ? fmtIst(m.lastActive) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Add team members below.</Empty>
        )}
      </section>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>Log your likes, shares and reposts</h2>
        <p className="muted" style={{ fontSize: "0.9rem", marginTop: 0 }}>
          Instagram, YouTube and LinkedIn don&apos;t tell us who liked, shared or reposted a post, so each person ticks what they did here.
        </p>
        {t.posts.length ? (
          <form action={logTeamEngagementAction} className="stack">
            <input type="hidden" name="days" value={days} />
            <div className="row" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
              <label>I am
                <select name="member" defaultValue="" required>
                  <option value="" disabled>Pick your name</option>
                  {t.members.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                </select>
              </label>
              <label className="row"><input type="checkbox" name="kind" value="like" defaultChecked /> 👍 Liked</label>
              <label className="row"><input type="checkbox" name="kind" value="share" /> ↗️ Shared</label>
              <label className="row"><input type="checkbox" name="kind" value="repost" /> 🔁 Reposted</label>
            </div>
            <div className="table-wrap" style={{ maxHeight: 260, overflowY: "auto" }}>
              <table>
                <tbody>
                  {t.posts.map((p) => (
                    <tr key={p.id}>
                      <td style={{ width: 32 }}><input type="checkbox" name="post" value={p.id} aria-label={p.title} /></td>
                      <td>{p.title.length > 70 ? p.title.slice(0, 68) + "…" : p.title}</td>
                      <td className="muted" style={{ whiteSpace: "nowrap" }}>{PLATFORM_LABEL[p.platform]} · {fmtDay(p.publishedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row">
              <button type="submit" className="small">Save</button>
              <button type="submit" name="undo" value="1" className="small secondary">Remove (if ticked by mistake)</button>
            </div>
          </form>
        ) : (
          <Empty>No posts were published in the last {days} days.</Empty>
        )}
      </section>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>Who engaged with each post</h2>
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>💬 commented · 👍 liked · ↗️ shared · 🔁 reposted</p>
        {t.posts.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Post</th>
                  {t.members.map((m) => <th key={m.name} style={{ textAlign: "center" }}>{m.name}</th>)}
                  <th className="num">Others</th>
                  <th className="num">Views</th>
                  <th className="num">Likes</th>
                  <th className="num">Comments</th>
                </tr>
              </thead>
              <tbody>
                {t.posts.map((p) => (
                  <tr key={p.id}>
                    <td style={{ minWidth: 220 }}>
                      <Link href={`/content/${p.id}`}>{p.title.length > 60 ? p.title.slice(0, 58) + "…" : p.title}</Link>
                      <div className="muted" style={{ fontSize: "0.8rem" }}>
                        {PLATFORM_LABEL[p.platform]} · {fmtDay(p.publishedAt)}{p.url ? <> · <a href={p.url} target="_blank" rel="noreferrer">open</a></> : null}
                      </div>
                    </td>
                    {t.members.map((m) => {
                      const n = p.byMember[m.name] ?? 0;
                      const liked = p.likedBy.includes(m.name);
                      const shared = p.sharedBy.includes(m.name);
                      const reposted = p.repostedBy.includes(m.name);
                      const did = [n ? `${n} comment(s)` : "", liked ? "liked" : "", shared ? "shared" : "", reposted ? "reposted" : ""].filter(Boolean);
                      return (
                        <td key={m.name} style={{ textAlign: "center", whiteSpace: "nowrap" }} title={`${m.name}: ${did.length ? did.join(", ") : "nothing yet"}`}>
                          {n ? <span className="badge ok">💬{n > 1 ? ` ${n}` : ""}</span> : null}
                          {liked ? <span className="badge info" style={{ marginLeft: 2 }}>👍</span> : null}
                          {shared ? <span className="badge info" style={{ marginLeft: 2 }}>↗️</span> : null}
                          {reposted ? <span className="badge info" style={{ marginLeft: 2 }}>🔁</span> : null}
                          {!did.length ? <span className="muted">·</span> : null}
                        </td>
                      );
                    })}
                    <td className="num">{p.others}</td>
                    <td className="num">{p.totals.views ?? "—"}</td>
                    <td className="num">{p.totals.likes ?? "—"}</td>
                    <td className="num">{p.totals.comments ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No posts were published in the last {days} days.</Empty>
        )}
      </section>

      <div className="grid two" style={{ marginBottom: "1rem" }}>
        <section className="card">
          <h2>Recent team comments</h2>
          {totalTeamComments ? (
            <ul className="list">
              {t.members
                .flatMap((m) => m.comments.map((c) => ({ ...c, name: m.name })))
                .sort((a, b) => b.at.localeCompare(a.at))
                .slice(0, 25)
                .map((c, i) => (
                  <li key={i}>
                    <div className="row">
                      <b>{c.name}</b>
                      <span className="badge">{PLATFORM_LABEL[c.platform]}</span>
                      <span className="spacer" />
                      <span className="muted" style={{ fontSize: "0.8rem" }}>{fmtIst(c.at)}</span>
                    </div>
                    <div>{c.text}</div>
                    {c.contentId ? <div className="muted" style={{ fontSize: "0.8rem" }}>on <Link href={`/content/${c.contentId}`}>this post</Link></div> : null}
                  </li>
                ))}
            </ul>
          ) : (
            <Empty>No team comments yet. Add each person&apos;s handle below so their comments are counted.</Empty>
          )}
        </section>

        <section className="card">
          <h2>Team members &amp; handles</h2>
          <form action={saveTeamMembersAction} className="stack">
            {[...t.members, { name: "", handles: [] as string[] }].map((m, i) => (
              <div key={i} className="form-grid">
                <label>Name<input name={`name_${i}`} defaultValue={m.name} placeholder={i === t.members.length ? "Add someone" : ""} /></label>
                <label>Handles<input name={`handles_${i}`} defaultValue={m.handles.join(", ")} placeholder="@instagram_handle, YouTube or Facebook name" /></label>
              </div>
            ))}
            <div className="row">
              <button type="submit" className="small">Save team</button>
              <span className="muted" style={{ fontSize: "0.8rem" }}>Clear a name to remove that person.</span>
            </div>
          </form>
          {t.unmatchedAuthors.length ? (
            <details style={{ marginTop: "0.75rem" }}>
              <summary>Commenters not matched to anyone ({t.unmatchedAuthors.length})</summary>
              <p className="muted" style={{ fontSize: "0.85rem" }}>If a team member is in this list, copy their handle into the form above.</p>
              <div className="row">{t.unmatchedAuthors.slice(0, 40).map((a) => <span key={a.author} className="badge">{a.author} · {a.count}</span>)}</div>
            </details>
          ) : null}
        </section>
      </div>

      <section className="card">
        <h2>How this is counted</h2>
        <ul style={{ margin: 0, fontSize: "0.9rem" }}>
          <li><b>Comments</b> are read from Instagram, Facebook and YouTube every 15 minutes (see the <Link href="/inbox">Comments inbox</Link>). {sync ? <>Last check: {fmtIst(sync.at)}.</> : null}</li>
          <li><b>Likes, shares and reposts per person</b> are what each person logs in the form above. Facebook likes are also picked up automatically when the person&apos;s Facebook name (for example &quot;Akash Kumar&quot;) is in their handles. Instagram, YouTube and LinkedIn only report totals, shown per post in the grid.</li>
          <li><b>Views, likes and comments totals</b> per post come from the Metrics Agent (refreshed every 6 hours).</li>
          <li><b>Approvals and app actions</b> come from each post&apos;s history (approving, scheduling, editing), matched by the name people sign in with.</li>
        </ul>
      </section>
    </>
  );
}
