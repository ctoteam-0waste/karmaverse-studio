import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { plannedInstant, readiness } from "@/lib/publishing/agent";
import { brandEnv } from "@/lib/publishing/accounts";
import { CopyButton } from "@/components/copy-button";
import { SendToPerson } from "@/components/send-to-person";
import { isOverdue } from "@/lib/agents/approval";
import type { ContentPiece, Database } from "@/lib/schemas";
import { VERTICAL, VIDEO_FORMATS } from "@/lib/video/maker";
import { BuddyVideoForm } from "@/components/buddy-video";
import { ActorField } from "@/components/actor-field";
import { SubmitButton } from "@/components/submit-button";
import { videoUrl } from "@/components/video-maker";
import { Empty, Flash, fmtWhen, PageHead, pinComment, PlatformChip, type SearchParams } from "@/components/ui";
import { approveScheduleAction, sendBackAction, transitionAction } from "../actions";

const order = (c: ContentPiece) => `${c.plannedDate ?? "9999"}${(c.plannedTime ?? "09:00").padStart(5, "0")}`;

function PostingBadge({ piece, db }: { piece: ContentPiece; db: Database }) {
  const r = readiness(piece, db);
  if (r.connected && !r.problems.length) return <span className="badge ok">🤖 Posts automatically</span>;
  if (r.connected) return <span className="badge warn">⚠ Needs a fix to auto-post</span>;
  return <span className="badge info">✋ Post by hand</span>;
}

function Preview({ piece }: { piece: ContentPiece }) {
  const file = piece.mediaUrls[0];
  const url = videoUrl(file);
  if (url && /\.mp4$/i.test(url)) return <video className={`preview ${VERTICAL.includes(piece.format) ? "tall" : ""}`} src={url} controls preload="metadata" playsInline />;
  // eslint-disable-next-line @next/next/no-img-element
  if (url) return <img className="preview" src={url} alt="Post image" />;
  if (file) return <div className="preview none">🎞️ Media: {file.split(/[\\/]/).pop()}</div>;
  return <div className="preview none">📝 Text post</div>;
}

/** Who puts up posts for platforms that aren't connected (LinkedIn for now). */
const HAND_POSTER = process.env.HAND_POSTER_NAME?.trim() || "Gourav";

/** The post's media as downloadable links, with friendly file names. */
function mediaFiles(piece: ContentPiece): Array<{ url: string; name: string }> {
  const stem = `karmaverse-${piece.platform}-${piece.plannedDate ?? "post"}`;
  const files = piece.mediaUrls.map((f) => ({ f, url: videoUrl(f) })).filter((x): x is { f: string; url: string } => Boolean(x.url));
  return files.map(({ f, url }, i) => ({ url, name: `${stem}${files.length > 1 ? `-${i + 1}` : ""}${(f.match(/\.\w+$/)?.[0] ?? "").toLowerCase()}` }));
}

/** The text to paste on the platform: caption (or YouTube description) plus any hashtags not already in it. */
function postText(piece: ContentPiece): string {
  const body = piece.platform === "youtube" ? piece.description : piece.caption;
  const tags = piece.hashtags.filter((h) => !body.includes(h)).join(" ");
  return [body.trim(), tags].filter(Boolean).join("\n\n");
}

/** WhatsApp message to the person posting by hand: when, where, the text, and what to send back. */
function handMessage(piece: ContentPiece, person: string): string {
  const name = PLATFORM_NAME[piece.platform] ?? piece.platform;
  const files = mediaFiles(piece);
  const what = files.length ? (files.some((f) => /\.mp4$/.test(f.name)) ? "the video" : files.length > 1 ? `the ${files.length} images (in order)` : "the image") : "";
  return [
    `Hi ${person} 👋 ${name} post for *${fmtWhen(piece.plannedDate, piece.plannedTime)}* on the KarmaVerse page.`,
    "",
    "⬇️ *Copy from here* ⬇️",
    postText(piece),
    "⬆️ *Till here* ⬆️",
    "",
    what ? `📎 Add ${what} I'm sending with this.` : "📝 Text only, no image needed.",
    "🔗 After posting, send me the post link 🙏",
  ].join("\n");
}

function Downloads({ piece }: { piece: ContentPiece }) {
  const files = mediaFiles(piece);
  if (!files.length) return null;
  const video = files.some((f) => /\.mp4$/.test(f.name));
  return (
    <span className="row" style={{ gap: "0.4rem" }}>
      {files.map((f, i) => (
        <a key={f.url} className="btn secondary big" href={`${f.url}?download`} download={f.name}>⬇ {video ? "Download video" : files.length > 1 ? `Image ${i + 1}` : "Download image"}</a>
      ))}
    </span>
  );
}

function ApproveCard({ piece, db }: { piece: ContentPiece; db: Database }) {
  const r = readiness(piece, db);
  const text = piece.platform === "youtube" ? piece.description : piece.caption;
  const tags = piece.hashtags.filter((h) => !text.includes(h)).join(" ");
  const pin = pinComment(piece.platform === "youtube" ? piece.history.map((h) => h.note ?? "").join("\n") : piece.description);
  const approved = piece.status === "approved";
  const late = isOverdue(piece);
  const label = late || !piece.plannedDate ? "✅ Approve" : approved ? "📅 Schedule it" : "✅ Approve & schedule";
  return (
    <article className="card approve-card" id={piece.id}>
      <header className="row">
        <PlatformChip platform={piece.platform} format={piece.format} />
        <span className="when">🕒 {fmtWhen(piece.plannedDate, piece.plannedTime)}</span>
        {late ? <span className="badge bad">Date passed</span> : null}
        <span className="spacer" />
        <PostingBadge piece={piece} db={db} />
      </header>
      <div className="approve-body">
        <Preview piece={piece} />
        <div className="stack approve-text">
          <h2>{piece.hook}</h2>
          <div className="caption-box">{text || <span className="muted">No text yet.</span>}{tags ? <p className="tags">{tags}</p> : null}</div>
          {pin ? <p className="pin">💬 <b>Pin this first comment:</b> {pin}</p> : null}
          {r.connected && r.problems.length ? <div className="flash err" style={{ margin: 0 }}>Fix before it can post: {r.problems.join(" ")}</div> : null}
          {approved ? <p className="muted" style={{ margin: 0 }}>Approved by {piece.approvedBy}. Schedule it to queue it.</p> : null}
          {late ? <p className="muted" style={{ margin: 0 }}>Its planned time has passed. Tap <b>Edit</b> to pick a new date; approving alone won&apos;t post it.</p> : null}
        </div>
      </div>
      <footer className="approve-actions">
        <form action={approveScheduleAction}>
          <input type="hidden" name="id" value={piece.id} />
          <input type="hidden" name="back" value="/approve" />
          <ActorField />
          <SubmitButton className="big ok" pendingText="Saving…">{label}</SubmitButton>
        </form>
        <Link className="btn secondary big" href={`/content/${piece.id}`}>✏️ Edit</Link>
        <Downloads piece={piece} />
        {!r.connected ? <SendToPerson person={HAND_POSTER} text={handMessage(piece, HAND_POSTER)} files={mediaFiles(piece)} /> : null}
        {VIDEO_FORMATS.includes(piece.format) ? <BuddyVideoForm id={piece.id} back={`/approve#${piece.id}`} compact hasVideo={piece.mediaUrls.length > 0} /> : null}
        <details className="send-back">
          <summary className="btn secondary big">↩️ Send back</summary>
          <form action={sendBackAction} className="stack">
            <input type="hidden" name="id" value={piece.id} />
            <input type="hidden" name="back" value="/approve" />
            <ActorField />
            <label>What should change?<textarea name="note" placeholder="e.g. Use the Hinglish video, shorter caption" required /></label>
            <SubmitButton className="secondary" pendingText="Sending…">Send back to the team</SubmitButton>
          </form>
        </details>
      </footer>
    </article>
  );
}

/** Where to post by hand: the LinkedIn Page's admin view when its id is known, else the platform's composer. */
function composeUrl(piece: ContentPiece, db: Database): string {
  if (piece.platform === "linkedin") {
    const brand = db.brands.find((b) => b.id === piece.brandId);
    const org = brand ? brandEnv(brand, db, process.env).LINKEDIN_AUTHOR_URN?.match(/organization:(\d+)/)?.[1] : undefined;
    return org ? `https://www.linkedin.com/company/${org}/admin/page-posts/published/` : "https://www.linkedin.com/feed/?shareActive=true";
  }
  return { x: "https://x.com/compose/post", instagram: "https://www.instagram.com/", facebook: "https://business.facebook.com/latest/composer", youtube: "https://studio.youtube.com/" }[piece.platform] ?? "about:blank";
}

const PLATFORM_NAME: Record<string, string> = { linkedin: "LinkedIn", x: "X", instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };

/** A scheduled post for a platform that isn't connected yet, once its time has come: copy, post, paste the link. */
function HandPostCard({ piece, db }: { piece: ContentPiece; db: Database }) {
  const text = postText(piece);
  const files = piece.mediaUrls.map((f) => ({ f, url: videoUrl(f) }));
  const name = PLATFORM_NAME[piece.platform] ?? piece.platform;
  return (
    <article className="card approve-card" id={`hand-${piece.id}`}>
      <header className="row">
        <PlatformChip platform={piece.platform} format={piece.format} />
        <span className="when">🕒 {fmtWhen(piece.plannedDate, piece.plannedTime)}</span>
        <span className="spacer" />
        <span className="badge info">✋ Your turn to post</span>
      </header>
      <div className="approve-body">
        <Preview piece={piece} />
        <div className="stack approve-text">
          <h2>{piece.hook}</h2>
          <ol className="steps" style={{ margin: 0, paddingLeft: "1.2rem" }}>
            <li>Not posting it yourself? <SendToPerson person={HAND_POSTER} text={handMessage(piece, HAND_POSTER)} files={mediaFiles(piece)} /> Then paste the link {HAND_POSTER} sends back in step 4.</li>
            <li>Copy the text: <CopyButton text={text} label="📋 Copy text" /></li>
            {files.length ? (
              <li>
                Download the {files.length > 1 ? `${files.length} images` : /\.mp4$/i.test(files[0]!.f) ? "video" : "image"}:{" "}
                {files.map(({ f, url }, i) => (url ? <a key={f} className="btn secondary small" href={url} download>⬇ {files.length > 1 ? i + 1 : "Download"}</a> : <code key={f}>{f}</code>))}
              </li>
            ) : null}
            <li><a className="btn small" href={composeUrl(piece, db)} target="_blank" rel="noreferrer">Open {name}</a>, start a post, paste the text{files.length ? " and add the file" : ""}, then post it.</li>
            <li>Copy the link of the live post and paste it here:</li>
          </ol>
          <div className="caption-box">{text}</div>
        </div>
      </div>
      <footer className="approve-actions">
        <form action={transitionAction} className="row" style={{ flex: 1 }}>
          <input type="hidden" name="id" value={piece.id} />
          <input type="hidden" name="to" value="published" />
          <input type="hidden" name="back" value="/approve" />
          <input type="hidden" name="note" value="Posted by hand." />
          <ActorField />
          <input name="publishedUrl" type="url" required placeholder={`https://www.${piece.platform === "x" ? "x" : piece.platform}.com/…`} style={{ flex: 1, minWidth: 200 }} />
          <SubmitButton className="big ok" pendingText="Saving…">✅ Mark as posted</SubmitButton>
        </form>
      </footer>
    </article>
  );
}

export default async function Approve({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const mine = db.content.filter((c) => c.brandId === brand.id);
  const all = mine.filter((c) => c.status === "needs-review" || c.status === "approved").sort((a, b) => order(a).localeCompare(order(b)));
  // Upcoming first; posts whose time has passed are tucked away below.
  const waiting = all.filter((c) => !isOverdue(c));
  const older = all.filter((c) => isOverdue(c)).reverse();
  const scheduled = mine.filter((c) => c.status === "scheduled").sort((a, b) => order(a).localeCompare(order(b)));
  // Scheduled posts for platforms that aren't connected: shown from an hour before their time until they're marked posted.
  const soon = Date.now() + 60 * 60 * 1000;
  const byHand = scheduled.filter((c) => !readiness(c, db).connected && (plannedInstant(c)?.getTime() ?? Infinity) <= soon);

  return (
    <>
      <PageHead title="Approve posts" intro="Watch, read, then tap Approve. Approved posts with a date go out by themselves at that time." />
      <Flash params={params} />
      {byHand.length ? (
        <div className="stack" style={{ marginBottom: "1.25rem" }}>
          <p className="count-line">✋ <b>{byHand.length}</b> post{byHand.length === 1 ? "" : "s"} to put up by hand now</p>
          {byHand.map((p) => <HandPostCard key={p.id} piece={p} db={db} />)}
        </div>
      ) : null}
      {waiting.length ? (
        <div className="stack">
          <p className="count-line"><b>{waiting.length}</b> post{waiting.length === 1 ? "" : "s"} waiting for you</p>
          {waiting.map((p) => <ApproveCard key={p.id} piece={p} db={db} />)}
        </div>
      ) : older.length ? null : (
        <section className="card done-card">
          <div aria-hidden className="big-emoji">🎉</div>
          <h2>All caught up!</h2>
          <p className="muted">Nothing is waiting for approval.</p>
          <Link className="btn" href="/studio">✨ Create a new post</Link>
        </section>
      )}

      {older.length ? (
        <details className="card older" style={{ marginTop: "1.25rem" }}>
          <summary>{older.length} older post{older.length === 1 ? "" : "s"} whose date has passed</summary>
          <div className="stack" style={{ marginTop: "0.9rem" }}>
            {older.map((p) => <ApproveCard key={p.id} piece={p} db={db} />)}
          </div>
        </details>
      ) : null}

      <section className="card" style={{ marginTop: "1.25rem" }}>
        <h2>Approved and scheduled</h2>
        {scheduled.length ? (
          <ul className="list">
            {scheduled.map((c) => (
              <li key={c.id} className="row">
                <span className="when" style={{ minWidth: 150 }}>🕒 {fmtWhen(c.plannedDate, c.plannedTime)}</span>
                <PlatformChip platform={c.platform} />
                <Link href={`/content/${c.id}`} style={{ flex: 1, minWidth: 160 }}>{c.hook}</Link>
                <PostingBadge piece={c} db={db} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing scheduled yet.</Empty>
        )}
      </section>
    </>
  );
}
