import Link from "next/link";
import { readDb } from "@/lib/db";
import { PLATFORMS } from "@/lib/schemas";
import { connectionStatus, plannedInstant, QUEUE_AHEAD_DAYS, readiness } from "@/lib/publishing/agent";
import { accountKey, defaultBrandId } from "@/lib/publishing/accounts";
import { ADAPTERS } from "@/lib/publishing/adapters";
import { describeHost, hostConfig, needsHosting } from "@/lib/publishing/media-host";
import { Empty, Flash, PageHead, PLATFORM_LABEL, StatusBadge, type SearchParams } from "@/components/ui";
import { runPublishingNowAction, setAutoPublishAction } from "../actions";

const fmtIst = (d: Date | string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** What to put in .env.local, per platform. `K` is the brand's account key. */
const SETUP: Record<string, (k: string) => string> = {
  facebook: (k) => `${k}_META_PAGE_ID and ${k}_META_PAGE_ACCESS_TOKEN (a long-lived Page access token with pages_manage_posts).`,
  instagram: (k) => `${k}_INSTAGRAM_ACCOUNT_ID, plus ${k}_INSTAGRAM_ACCESS_TOKEN (Instagram Login) or ${k}_META_PAGE_ACCESS_TOKEN (the linked Facebook Page's token).`,
  linkedin: (k) => `${k}_LINKEDIN_ACCESS_TOKEN (w_organization_social; expires after 60 days) and ${k}_LINKEDIN_AUTHOR_URN, e.g. urn:li:organization:12345.`,
  youtube: (k) => `${k}_YOUTUBE_CLIENT_ID, ${k}_YOUTUBE_CLIENT_SECRET and ${k}_YOUTUBE_REFRESH_TOKEN (OAuth with the youtube.upload scope).`,
  x: (k) => `${k}_X_API_KEY, ${k}_X_API_SECRET, ${k}_X_ACCESS_TOKEN and ${k}_X_ACCESS_TOKEN_SECRET (app set to Read and Write before generating the token).`,
};

export default async function PublishingPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const defaultId = defaultBrandId(db, process.env);
  const brands = db.brands.map((b) => ({ b, key: accountKey(b), status: connectionStatus(b, db) }));
  const brandName = (id: string) => db.brands.find((b) => b.id === id)?.name ?? id;
  const now = Date.now();
  const queue = db.content
    .filter((c) => c.status === "scheduled" || c.status === "approved" || c.status === "failed")
    .map((c) => ({ c, at: plannedInstant(c), ready: readiness(c, db) }))
    .sort((a, b) => (a.at?.getTime() ?? Infinity) - (b.at?.getTime() ?? Infinity));
  const recent = db.content
    .filter((c) => c.status === "published" && c.history.some((h) => h.by === "publishing-agent"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 10);
  const run = db.settings.lastPublishRun;
  const host = hostConfig(process.env);
  const waitingForHost = db.content.filter((c) => ["approved", "scheduled", "failed"].includes(c.status) && needsHosting(c)).length;

  return (
    <>
      <PageHead
        title="Publishing Agent"
        intro="Posts approved, scheduled content to each platform at its planned time (IST), using the official APIs and each brand's own accounts. Drafts and posts in review are never published."
      />
      <Flash params={params} />

      <div className="grid two">
        <section className="card">
          <h2>Auto-publish</h2>
          <form action={setAutoPublishAction} className="stack">
            <label className="inline"><input type="checkbox" name="autoPublish" defaultChecked={db.settings.autoPublish} /> <span>Publish scheduled posts automatically at their planned time</span></label>
            <div className="row">
              <button type="submit">Save</button>
              <span className={`badge ${db.settings.autoPublish ? "ok" : "warn"}`}>{db.settings.autoPublish ? "on" : "off"}</span>
            </div>
          </form>
          <p className="muted" style={{ marginTop: "0.5rem" }}>The agent checks every minute while the app is running. <b>Facebook and YouTube</b> posts that are approved and scheduled for the next {QUEUE_AHEAD_DAYS} days are handed to the platform in advance with their time, so they go out <b>even if this computer is off</b>. Instagram, LinkedIn and X have no scheduling API: they go out at the planned time if the computer is on, or the next time the app starts. Editing or moving a queued post here replaces the queued copy. To queue a post, approve it, then click <b>Mark scheduled</b>.</p>
          <hr />
          <form action={runPublishingNowAction} className="row">
            <button type="submit" className="secondary">Run now</button>
            <span className="muted">Publishes everything that is due right now, for all brands.</span>
          </form>
          {run ? (
            <div style={{ marginTop: "0.75rem" }}>
              <b>Last run</b> <span className="muted">{fmtIst(run.at)}</span>: {run.published} published, {run.failed} failed, {run.skipped} skipped
              {run.notes.length ? <ul style={{ margin: "0.25rem 0 0", fontSize: "0.9rem" }}>{run.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
            </div>
          ) : null}
        </section>

        <section className="card">
          <h2>How to connect an account</h2>
          <p>Accounts connect with <b>API tokens</b> from each platform&apos;s developer console, never with account passwords. Put them in <code>.env.local</code> using the brand&apos;s account key as a prefix, then restart the app.</p>
          <ul style={{ fontSize: "0.9rem", paddingLeft: "1.1rem" }}>
            {PLATFORMS.map((p) => <li key={p}><b>{PLATFORM_LABEL[p]}</b>: {SETUP[p]!("KEY")} <a href={ADAPTERS[p].docs} target="_blank" rel="noreferrer">Docs</a></li>)}
          </ul>
          <p className="muted">Each brand uses only its own tokens, so a post can never go to another brand&apos;s account. Set the account key in <Link href="/settings">Settings</Link> (brand profile).</p>
        </section>
      </div>

      <section className="card" style={{ marginTop: "1rem" }} id="media-host">
        <h2>Media Host <span className={`badge ${host ? "ok" : "warn"}`}>{describeHost(host)}</span></h2>
        <p>Instagram and Facebook download images and videos from a <b>public link</b>; they can&apos;t read files on this computer. When a post has slides, covers or videos made here, the Media Host uploads them just before publishing and posts with the public links (each file once).{waitingForHost ? <> <b>{waitingForHost}</b> post(s) in the queue have files on this computer for Instagram/Facebook.</> : null}</p>
        {host ? (
          <p className="muted" style={{ margin: 0 }}>Set up. PNG images are delivered as JPEG for Instagram. Uploaded files are public to anyone with the link, so only approved posts are uploaded.</p>
        ) : (
          <details open={waitingForHost > 0}>
            <summary style={{ cursor: "pointer" }}>Set it up (free, about 5 minutes)</summary>
            <ol style={{ fontSize: "0.9rem", paddingLeft: "1.1rem" }}>
              <li>Create a free account at <a href="https://cloudinary.com/users/register_free" target="_blank" rel="noreferrer">cloudinary.com</a> (the free plan is plenty for social posts).</li>
              <li>In the Cloudinary console, open <b>Settings → API Keys</b> and copy the <b>API environment variable</b>. It looks like <code>cloudinary://123456789:abcDEF…@your-cloud-name</code>.</li>
              <li>Add it to <code>.env.local</code> as <code>CLOUDINARY_URL=cloudinary://…</code> (one line; shared by all brands), then restart the app.</li>
            </ol>
            <p className="muted" style={{ fontSize: "0.85rem" }}>Alternative: if this app is reachable from the internet at an https address, set <code>MEDIA_PUBLIC_BASE_URL=https://that-address</code> instead; files made by the app are then linked directly.</p>
          </details>
        )}
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Connections by brand</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Brand</th><th>Account key</th>{PLATFORMS.map((p) => <th key={p}>{PLATFORM_LABEL[p]}</th>)}</tr></thead>
            <tbody>
              {brands.map(({ b, key, status }) => (
                <tr key={b.id}>
                  <td>{b.name}{b.id === defaultId ? <div className="muted" style={{ fontSize: "0.8rem" }}>default: may also use unprefixed names</div> : null}</td>
                  <td><code>{key}</code></td>
                  {status.map((s) => (
                    <td key={s.platform} title={s.connected ? "" : `Add: ${s.missing.join(", ")}`}>
                      {!b.platforms.includes(s.platform) ? <span className="muted">not used</span> : s.connected ? <span className="badge ok">connected</span> : <span className="badge warn">manual</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer" }}>Exact variables each brand still needs</summary>
          <ul style={{ fontSize: "0.85rem" }}>
            {brands.flatMap(({ b, status }) => status.filter((s) => !s.connected && b.platforms.includes(s.platform)).map((s) => <li key={`${b.id}${s.platform}`}><b>{b.name} · {PLATFORM_LABEL[s.platform]}</b>: {s.missing.join(", ")}</li>))}
          </ul>
        </details>
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Queue</h2>
        {queue.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When (IST)</th><th>Brand</th><th>Platform</th><th>Post</th><th>Status</th><th>Ready?</th></tr></thead>
              <tbody>
                {queue.map(({ c, at, ready }) => (
                  <tr key={c.id}>
                    <td>{at ? fmtIst(at) : "no date"}{at && at.getTime() <= now && c.status === "scheduled" ? <> <span className="badge info">due</span></> : null}</td>
                    <td>{brandName(c.brandId)}</td>
                    <td>{PLATFORM_LABEL[c.platform]} {c.format}</td>
                    <td><Link href={`/content/${c.id}`}>{c.topic}</Link></td>
                    <td><StatusBadge status={c.status} />{c.publishingStartedAt ? <> <span className="badge info">publishing…</span></> : null}</td>
                    <td style={{ fontSize: "0.85rem" }}>
                      {c.status === "failed" ? <span className="muted">{c.failureReason}</span>
                        : !ready.connected ? <span className="badge warn">manual</span>
                        : ready.problems.length ? <span>{ready.problems.join(" ")}</span>
                        : c.status === "approved" ? <span className="muted">Approved; mark it scheduled to queue it.</span>
                        : c.platformQueue?.externalId && !c.platformQueue.error ? <span className="badge ok" title="Already handed to the platform with its publish time">queued on {PLATFORM_LABEL[c.platform]}: posts even if this PC is off</span>
                        : <><span className="badge ok">ready</span>{c.platformQueue?.error ? <div className="muted">Could not queue in advance: {c.platformQueue.error}</div> : null}</>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing approved or scheduled. Approve posts in the <Link href="/calendar?status=needs-review">review queue</Link>.</Empty>
        )}
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Recently auto-published</h2>
        {recent.length ? (
          <ul className="list">
            {recent.map((c) => (
              <li key={c.id}><b>{brandName(c.brandId)} · {PLATFORM_LABEL[c.platform]}</b> · <Link href={`/content/${c.id}`}>{c.topic}</Link> · {c.publishedUrl ? <a href={c.publishedUrl} target="_blank" rel="noreferrer">live post</a> : null} <span className="muted">{fmtIst(c.updatedAt)}</span></li>
            ))}
          </ul>
        ) : (
          <Empty>No posts published by the agent yet.</Empty>
        )}
      </section>
    </>
  );
}
