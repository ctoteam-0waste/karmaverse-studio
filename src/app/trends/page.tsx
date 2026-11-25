import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import type { Trend } from "@/lib/schemas";
import { Empty, Flash, fmtDate, PageHead, sp, type SearchParams } from "@/components/ui";
import { runTrendsAction, setTrendStatusAction, trendToIdeaAction } from "../actions";

const SOURCES: Record<Trend["source"], { label: string; intro: string }> = {
  "climate-day": { label: "Climate days", intro: "Coming up in the next 45 days. Best planned 1–3 weeks ahead." },
  "google-trends": { label: "Trending searches in India", intro: "From Google Trends today, kept only when they touch climate, pollution, waste or energy. Post within a day while people are searching." },
  news: { label: "In the news this week", intro: "Google News for your topics. React with a verified fact and an action; link the source." },
  youtube: { label: "Working on YouTube this week", intro: "Most-viewed videos on your topics in India in the last 7 days. Learn the format; make your own." },
  search: { label: "What people search for (Growth agent)", intro: "Searches where your sites already show up in Google but rank low, and questions AI assistants answer without mentioning you. The Blog Writer uses these; they also make good posts." },
};

const FILTERS = [
  ["", "New"],
  ["used", "Made into ideas"],
  ["dismissed", "Dismissed"],
] as const;

const fmtIst = (d: string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default async function TrendsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const filter = sp(params, "filter");
  const db = await readDb();
  const brand = activeBrand(db);
  const status = filter === "used" || filter === "dismissed" ? filter : "new";
  const items = db.trends.filter((t) => t.brandId === brand.id && t.status === status);
  const scan = db.settings.lastTrendScan;
  const order = Object.keys(SOURCES) as Trend["source"][];

  return (
    <>
      <PageHead title="Trend Watcher" intro="Finds what to post about next: upcoming climate days, what India is searching today, this week's news and what's working on YouTube. Each item has a suggested angle and a fit score. Turn the good ones into ideas.">
        <form action={runTrendsAction}><button type="submit" className="secondary">Check now</button></form>
      </PageHead>
      <Flash params={params} />

      <div className="row" style={{ marginBottom: "0.75rem" }}>
        {FILTERS.map(([key, label]) => (
          <Link key={key} href={key ? `/trends?filter=${key}` : "/trends"} className={`btn small ${filter === key ? "" : "secondary"}`}>{label}</Link>
        ))}
        <span className="spacer" />
        <span className="muted" style={{ fontSize: "0.85rem" }}>{scan ? `Checked ${fmtIst(scan.at)} (daily while the app runs).` : "Not checked yet."}</span>
      </div>
      {scan?.notes.length ? <div className="flash err">{scan.notes.join(" ")}</div> : null}

      {order.map((source) => {
        const list = items.filter((t) => t.source === source).sort((a, b) => (source === "climate-day" ? a.date.localeCompare(b.date) : b.score - a.score));
        if (!list.length && status !== "new") return null;
        return (
          <section key={source} className="card" style={{ marginBottom: "1rem" }}>
            <h2>{SOURCES[source].label} <span className="muted" style={{ fontSize: "0.9rem", fontWeight: 400 }}>{list.length}</span></h2>
            <p className="muted" style={{ marginTop: 0 }}>{SOURCES[source].intro}</p>
            {list.length ? (
              <ul className="list">
                {list.slice(0, 15).map((t) => (
                  <li key={t.id}>
                    <div className="row">
                      <span className={`badge ${t.score >= 80 ? "ok" : t.score >= 60 ? "" : "warn"}`} title="Fit with your brand (0–100)">{t.score}</span>
                      <b>{t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.title}</a> : t.title}</b>
                      {t.date ? <span className="muted" style={{ fontSize: "0.85rem" }}>{fmtDate(t.date.slice(0, 10))}</span> : null}
                      <span className="spacer" />
                      {t.status === "new" ? (
                        <>
                          <form action={trendToIdeaAction}><input type="hidden" name="id" value={t.id} /><button className="small">Make it an idea</button></form>
                          <form action={setTrendStatusAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value="dismissed" /><button className="secondary small">Dismiss</button></form>
                        </>
                      ) : (
                        <form action={setTrendStatusAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value="new" /><button className="secondary small">Restore</button></form>
                      )}
                    </div>
                    {t.detail ? <div className="muted" style={{ fontSize: "0.85rem" }}>{t.detail}</div> : null}
                    <div style={{ fontSize: "0.9rem", marginTop: "0.2rem" }}>💡 {t.angle}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{source === "youtube" ? "Nothing yet. This needs the brand's YouTube connection." : "Nothing right now."}</Empty>
            )}
          </section>
        );
      })}

      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Trending Reels audio has no public API, so check it in Instagram (Reels → audio with the ↗ arrow) and add it as a trend note in <Link href="/settings">Settings</Link>. Ideas made here go to the <Link href="/studio">Content Studio</Link> backlog.
      </p>
    </>
  );
}
