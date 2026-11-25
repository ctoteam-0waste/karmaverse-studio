import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { recommendExperiments, scorePosts, analysisMetrics } from "@/lib/analytics/engine";
import { pillarCoverage } from "@/lib/agents/strategy";
import type { ContentPiece } from "@/lib/schemas";
import { currentUser } from "@/lib/session";
import { liveLinks } from "@/lib/agents/share";
import { addDays, todayIst } from "@/lib/util";
import { Empty, Flash, fmtWhen, PlatformChip, SampleBadge, type SearchParams } from "@/components/ui";

const order = (c: ContentPiece) => `${c.plannedDate ?? "9999"}${(c.plannedTime ?? "09:00").padStart(5, "0")}`;

/** Status in plain words, for people who don't know the workflow names. */
function PlainStatus({ piece }: { piece: ContentPiece }) {
  switch (piece.status) {
    case "published":
      return piece.publishedUrl ? <a className="badge ok" href={piece.publishedUrl} target="_blank" rel="noreferrer">✓ Posted · view</a> : <span className="badge ok">✓ Posted</span>;
    case "scheduled":
      return <span className="badge status-scheduled">⏰ Scheduled</span>;
    case "needs-review":
      return <Link className="badge warn" href={`/approve#${piece.id}`}>Needs approval</Link>;
    case "approved":
      return <Link className="badge info" href={`/approve#${piece.id}`}>Approved · not scheduled</Link>;
    case "failed":
      return <span className="badge bad" title={piece.failureReason ?? ""}>✗ Failed</span>;
    default:
      return <span className="badge">Draft</span>;
  }
}

function greeting(now = new Date()): string {
  const h = Number(now.toLocaleString("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const user = await currentUser();
  const today = todayIst();
  const tomorrow = addDays(today, 1);
  const content = db.content.filter((c) => c.brandId === brand.id);
  const inbox = db.inbox.filter((i) => i.brandId === brand.id);

  const waiting = content.filter((c) => c.status === "needs-review" || c.status === "approved");
  const todays = content.filter((c) => c.plannedDate === today && c.status !== "draft").sort((a, b) => order(a).localeCompare(order(b)));
  const tomorrows = content.filter((c) => c.plannedDate === tomorrow && c.status !== "draft").sort((a, b) => order(a).localeCompare(order(b)));
  const failed = content.filter((c) => c.status === "failed");
  const liveToday = liveLinks(content, today);
  const weekAgo = addDays(today, -7);
  const postedWeek = content.filter((c) => c.status === "published" && c.updatedAt.slice(0, 10) >= weekAgo);
  const humanInbox = inbox.filter((i) => i.classification.needsHuman && i.replyStatus === "drafted");
  const hasSample = content.some((c) => c.isSample) || inbox.some((i) => i.isSample);

  const tips: Array<{ text: string; href: string }> = [];
  if (!tomorrows.length) tips.push({ text: "Nothing planned for tomorrow yet. Create a post.", href: "/studio" });
  const gaps = pillarCoverage(brand, content, today, addDays(today, 30)).filter((g) => g.isGap);
  if (gaps.length && content.length) tips.push({ text: `Few posts planned about ${gaps.map((g) => g.name).slice(0, 2).join(" and ")}.`, href: "/studio" });
  for (const e of recommendExperiments(brand.id, scorePosts(analysisMetrics(db.metrics, brand.id))).slice(0, 2)) tips.push({ text: `Try: ${e.hypothesis}`, href: "/experiments" });

  return (
    <>
      <div className="hello">
        <h1>{greeting()}{user ? `, ${user}` : ""} 👋</h1>
        <p className="muted">Here&apos;s what&apos;s happening on {brand.name} today.</p>
      </div>
      <Flash params={params} />
      {hasSample ? <div className="flash info">Some numbers here are <b>sample data</b> <SampleBadge show />. Remove it in <Link href="/settings">Settings</Link>.</div> : null}

      {waiting.length ? (
        <Link href="/approve" className="hero-tile warn">
          <span className="hero-num">{waiting.length}</span>
          <span className="hero-text"><b>post{waiting.length === 1 ? "" : "s"} waiting for your approval</b><span>Tap to review and approve →</span></span>
        </Link>
      ) : (
        <div className="hero-tile ok">
          <span className="hero-num">🎉</span>
          <span className="hero-text"><b>All caught up</b><span>Nothing is waiting for approval.</span></span>
        </div>
      )}
      {failed.length ? (
        <Link href="/calendar?status=failed" className="hero-tile bad">
          <span className="hero-num">{failed.length}</span>
          <span className="hero-text"><b>post{failed.length === 1 ? "" : "s"} failed to publish</b><span>Tap to see why and try again →</span></span>
        </Link>
      ) : null}

      {liveToday.length ? (
        <Link href="/share" className="hero-tile ok">
          <span className="hero-num">📲</span>
          <span className="hero-text"><b>{liveToday.length} post{liveToday.length === 1 ? " is" : "s are"} live today</b><span>Share the links on WhatsApp for likes and comments →</span></span>
        </Link>
      ) : null}

      <div className="grid four quick">
        <div className="card stat"><div className="value">{todays.length}</div><div className="label">Posts today</div></div>
        <div className="card stat"><div className="value">{postedWeek.length}</div><div className="label">Posted this week</div></div>
        <div className="card stat"><div className="value">{tomorrows.length}</div><div className="label">Planned tomorrow</div></div>
        <Link href="/inbox?filter=human" className="card stat"><div className="value">{humanInbox.length}</div><div className="label">Comments to answer</div></Link>
      </div>

      <div className="grid two">
        <section className="card">
          <h2>Today</h2>
          {todays.length ? (
            <ul className="timeline">
              {todays.map((c) => (
                <li key={c.id}>
                  <span className="t">{fmtWhen(c.plannedDate, c.plannedTime).replace("Today, ", "")}</span>
                  <PlatformChip platform={c.platform} />
                  <Link href={`/content/${c.id}`} className="h">{c.hook}</Link>
                  <PlainStatus piece={c} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No posts planned today.</Empty>
          )}
        </section>
        <section className="card">
          <h2>Tomorrow</h2>
          {tomorrows.length ? (
            <ul className="timeline">
              {tomorrows.map((c) => (
                <li key={c.id}>
                  <span className="t">{fmtWhen(c.plannedDate, c.plannedTime).replace("Tomorrow, ", "")}</span>
                  <PlatformChip platform={c.platform} />
                  <Link href={`/content/${c.id}`} className="h">{c.hook}</Link>
                  <PlainStatus piece={c} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing planned yet. <Link href="/studio">Create a post</Link></Empty>
          )}
        </section>
      </div>

      <div className="grid three quick-actions">
        <Link href="/studio" className="card action"><span aria-hidden>✨</span><b>Create a post</b><span className="muted">Write it for every platform at once</span></Link>
        <Link href="/calendar" className="card action"><span aria-hidden>📅</span><b>See the calendar</b><span className="muted">Everything planned this month</span></Link>
        <Link href="/analytics" className="card action"><span aria-hidden>📊</span><b>See results</b><span className="muted">Which posts did best</span></Link>
      </div>

      {tips.length ? (
        <section className="card" style={{ marginTop: "1rem" }}>
          <h2>Ideas for you</h2>
          <ul className="list">
            {tips.map((t) => <li key={t.text}><Link href={t.href}>💡 {t.text}</Link></li>)}
          </ul>
        </section>
      ) : null}
    </>
  );
}
