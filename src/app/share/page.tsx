import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { liveLinks, shareMessage, statusText } from "@/lib/agents/share";
import { addDays, todayIst } from "@/lib/util";
import { ShareButtons } from "@/components/share-buttons";
import { videoUrl } from "@/components/video-maker";
import { Empty, fmtDate, PageHead, PlatformChip, sp, type SearchParams } from "@/components/ui";

export default async function Share({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const today = todayIst();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp(params, "date")) ? sp(params, "date") : today;
  const mine = db.content.filter((c) => c.brandId === brand.id);
  const links = liveLinks(mine, date);
  const posts = links.map((l) => mine.find((c) => c.id === l.contentId)!);
  const topic = posts[0]?.topic ?? "";
  const message = shareMessage(links, { brand: brand.name, topic, seed: Number(date.replaceAll("-", "")) });
  const status = statusText(links, brand.name);
  const video = posts.map((p) => p.mediaUrls[0]).find((f) => f && /\.mp4$/i.test(f) && videoUrl(f));
  const later = mine.filter((c) => c.plannedDate === date && c.status === "scheduled").length;

  return (
    <>
      <PageHead title="Share on WhatsApp" intro="Every post that went live, in one message. Send it to your groups or Status so people like, comment and share.">
        <Link className="btn secondary small" href={`/share?date=${addDays(date, -1)}`}>← Previous day</Link>
        {date !== today ? <Link className="btn secondary small" href="/share">Today</Link> : null}
      </PageHead>
      <p className="when">📅 {date === today ? "Today" : fmtDate(date)}{later ? ` · ${later} more post${later === 1 ? "" : "s"} still scheduled; come back after they go live` : ""}</p>

      {links.length ? (
        <div className="grid two">
          <section className="card stack">
            <h2>Live links</h2>
            <ul className="list">
              {links.map((l) => (
                <li key={l.url} className="row">
                  <PlatformChip platform={l.platform} />
                  <a href={l.url} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 160 }}>{l.hook}</a>
                </li>
              ))}
            </ul>
            <ShareButtons message={message} status={status} videoUrl={video ? videoUrl(video) : null} videoName="karmaverse.mp4" />
            <p className="muted" style={{ margin: 0 }}>Tip: share within the first hour after posting. Early likes and comments make the platforms show the post to more people.</p>
          </section>
          <section className="card">
            <h2>The message</h2>
            <pre className="share-preview">{message}</pre>
          </section>
        </div>
      ) : (
        <Empty>No posts went live {date === today ? "today" : "that day"} yet. Live posts appear here automatically with their links.</Empty>
      )}
    </>
  );
}
