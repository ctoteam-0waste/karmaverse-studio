import { ActorField } from "@/components/actor-field";
import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { Empty, Flash, PageHead, PLATFORM_LABEL, SampleBadge, sp, type SearchParams } from "@/components/ui";
import { addCommentsAction, runCommunityAction, setAutoReplyAction, updateReplyAction } from "../actions";
import { canSend } from "@/lib/community/agent";
import { canUseComments, COMMENT_SCOPES } from "@/lib/community/comments";
import { brandEnv } from "@/lib/publishing/accounts";

const fmtIst = (d: string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const FILTERS = [
  ["", "All open"],
  ["human", "Needs a person"],
  ["question", "Questions"],
  ["spam", "Spam"],
  ["failed", "Not sent"],
  ["done", "Done"],
] as const;

export default async function InboxPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const filter = sp(params, "filter");
  const db = await readDb();
  const brand = activeBrand(db);
  const all = db.inbox.filter((i) => i.brandId === brand.id).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const open = (i: (typeof all)[number]) => i.replyStatus === "drafted" || i.replyStatus === "approved";
  const items = all.filter((i) => {
    if (filter === "human") return open(i) && i.classification.needsHuman;
    if (filter === "question") return open(i) && i.classification.intent === "question";
    if (filter === "spam") return i.classification.intent === "spam" && open(i);
    if (filter === "done") return !open(i);
    if (filter === "failed") return Boolean(i.replyError);
    return open(i);
  });

  const env = brandEnv(brand, db, process.env);
  const reading = brand.platforms.filter((p) => canUseComments(p, env));
  const sync = db.settings.lastCommunitySync;

  return (
    <>
      <PageHead title="Community Inbox" intro="The Community Manager reads new comments on your published posts every 15 minutes, sorts them and drafts replies. You approve and send them; only thanks and quiz answers can go out on their own, and only if you turn that on." />
      <Flash params={params} />

      <section className="card" style={{ marginBottom: "1rem" }}>
        <h2>Community Manager</h2>
        <div className="grid two">
          <div className="stack">
            <div>
              <b>Reading comments from:</b>{" "}
              {reading.length ? reading.map((p) => <span key={p} className="badge ok" style={{ marginRight: 4 }}>{PLATFORM_LABEL[p]}</span>) : <span className="badge warn">no connected platforms</span>}
            </div>
            <form action={runCommunityAction} className="row">
              <button type="submit" className="secondary">Check comments now</button>
              {sync ? <span className="muted">Last check {fmtIst(sync.at)}: {sync.added} new, {sync.sent} auto-sent{sync.failed ? `, ${sync.failed} problem(s)` : ""}</span> : <span className="muted">Not run yet.</span>}
            </form>
            {sync?.notes.length ? <ul style={{ margin: 0, fontSize: "0.85rem" }}>{sync.notes.slice(0, 6).map((n) => <li key={n}>{n}</li>)}</ul> : null}
          </div>
          <div className="stack">
            <form action={setAutoReplyAction} className="stack">
              <label className="inline"><input type="radio" name="autoReply" value="off" defaultChecked={db.settings.autoReply === "off"} /> <span><b>Off</b>: every reply waits for your approval</span></label>
              <label className="inline"><input type="radio" name="autoReply" value="safe" defaultChecked={db.settings.autoReply === "safe"} /> <span><b>Safe auto-reply</b>: send thanks to praise and &quot;Correct! 🎉&quot; / &quot;Good try&quot; to quiz answers (comments under 3 days old, at most 15 per check). Questions, complaints, support and anything sensitive always wait for you.</span></label>
              <div><button type="submit" className="small">Save</button></div>
            </form>
          </div>
        </div>
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer" }}>Permissions each platform needs</summary>
          <ul style={{ fontSize: "0.85rem" }}>
            {brand.platforms.map((p) => <li key={p}><b>{PLATFORM_LABEL[p]}</b>: read: {COMMENT_SCOPES[p].read}; reply: {COMMENT_SCOPES[p].reply}.</li>)}
          </ul>
          <p className="muted" style={{ fontSize: "0.85rem" }}>Direct messages aren&apos;t read: Instagram and Facebook messaging needs a separate Meta app review.</p>
        </details>
      </section>

      <div className="grid two" style={{ marginBottom: "1rem" }}>
        <section className="card">
          <h2>Add comments by hand</h2>
          <form action={addCommentsAction} className="stack">
            <div className="form-grid">
              <label>Platform<select name="platform">{brand.platforms.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select></label>
              <label>Post (optional)<input name="postRef" placeholder="URL or title" /></label>
            </div>
            <label>One comment per line. Optional "author: comment" format.<textarea name="comments" rows={5} placeholder={"@riya.k: How do I book a pickup?\n@aman: Love this!"} required /></label>
            <div><button type="submit">Classify</button></div>
          </form>
          <p className="muted" style={{ marginTop: "0.5rem" }}>For comments the Community Manager can&apos;t read (platform not connected, or pasted from elsewhere). Replies to pasted comments are posted by hand.</p>
        </section>
        <section className="card">
          <h2>How replies are handled</h2>
          <ul>
            <li><b>Escalation</b> (legal, fraud, threats, harm): a person handles it; the draft only invites a DM.</li>
            <li><b>Support</b> (pickups, coins, app issues): move to DM; never ask for personal data in public.</li>
            <li><b>Spam</b>: no reply drafted. Hide or delete it on the platform.</li>
            <li>Replies with [brackets] can't be approved until the bracket is filled with a verified fact.</li>
          </ul>
        </section>
      </div>

      <div className="row" style={{ marginBottom: "0.75rem" }}>
        {FILTERS.map(([key, label]) => (
          <Link key={key} href={key ? `/inbox?filter=${key}` : "/inbox"} className={`btn small ${filter === key ? "" : "secondary"}`}>{label}</Link>
        ))}
      </div>

      <section className="card">
        {items.length ? (
          <ul className="list">
            {items.map((i) => {
              const c = i.classification;
              const tone = c.intent === "escalation" ? "bad" : c.needsHuman ? "warn" : c.intent === "spam" ? "" : "ok";
              const sendable = canSend(i, db);
              return (
                <li key={i.id}>
                  <div className="row">
                    <b>{i.author}</b>
                    <span className="badge">{PLATFORM_LABEL[i.platform]}</span>
                    <span className={`badge ${tone}`}>{c.intent}</span>
                    <span className="badge">{c.sentiment}</span>
                    {c.flags.map((f) => <span key={f} className="badge warn">{f}</span>)}
                    {c.needsHuman ? <span className="badge bad">needs a person</span> : null}
                    <SampleBadge show={i.isSample} />
                    <span className="spacer" />
                    <span className="muted">{i.replyStatus === "posted" ? "sent ✓" : i.replyStatus}{i.approvedBy ? ` by ${i.approvedBy}` : ""}</span>
                  </div>
                  {i.contentId ? <div className="muted" style={{ fontSize: "0.8rem" }}>{fmtIst(i.receivedAt)} · on <Link href={`/content/${i.contentId}`}>this post</Link>{/^https?:/.test(i.postRef) ? <> · <a href={i.postRef} target="_blank" rel="noreferrer">open on {PLATFORM_LABEL[i.platform]}</a></> : null}</div> : null}
                  {i.replyError ? <div className="flash err" style={{ margin: "0.4rem 0" }}>Not sent: {i.replyError}</div> : null}
                  <p style={{ margin: "0.4rem 0" }}>{i.text}</p>
                  <div className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.4rem" }}>{c.reason}</div>
                  {c.intent !== "spam" || i.suggestedReply ? (
                    <form action={updateReplyAction} className="stack">
                      <input type="hidden" name="id" value={i.id} />
                      <textarea name="reply" rows={2} defaultValue={i.suggestedReply} disabled={i.replyStatus !== "drafted"} />
                      <div className="row">
                        {i.replyStatus === "drafted" ? (
                          <>
                            <ActorField required={false} />
                            {sendable ? <button name="do" value="send" className="small">Approve &amp; send</button> : null}
                            <button name="do" value="approve" className={sendable ? "secondary small" : "small"}>Approve reply</button>
                            <button name="do" value="ignore" className="secondary small">No reply</button>
                          </>
                        ) : null}
                        {i.replyStatus === "approved" ? <>{sendable ? <button name="do" value="send" className="small">Send reply</button> : null}<button name="do" value="posted" className={sendable ? "secondary small" : "small"}>I posted it</button><button name="do" value="reopen" className="secondary small">Edit again</button></> : null}
                        {i.replyStatus === "ignored" || i.replyStatus === "posted-manually" ? <button name="do" value="reopen" className="secondary small">Reopen</button> : null}
                      </div>
                    </form>
                  ) : (
                    <form action={updateReplyAction} className="row">
                      <input type="hidden" name="id" value={i.id} />
                      <button name="do" value="ignore" className="secondary small">Mark handled</button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>No comments here.</Empty>
        )}
      </section>
    </>
  );
}
