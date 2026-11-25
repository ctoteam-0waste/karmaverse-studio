import { ActorField } from "@/components/actor-field";
import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { CONTENT_STATUSES, type ContentPiece } from "@/lib/schemas";
import { addDays, weekdayOf, WEEKDAY_NAMES, todayIst } from "@/lib/util";
import { Empty, Flash, PageHead, PLATFORM_LABEL, sp, StatusBadge, type SearchParams } from "@/components/ui";
import { bulkSubmitAction, generateCalendarAction } from "../actions";

export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const today = todayIst();
  const status = sp(params, "status");
  const platform = sp(params, "platform");
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp(params, "from")) ? sp(params, "from") : today;
  const view = sp(params, "view") === "list" ? "list" : "grid";

  const all = db.content.filter((c) => c.brandId === brand.id && c.plannedDate);
  const items = all.filter((c) => (!status || c.status === status) && (!platform || c.platform === platform));
  const counts = Object.fromEntries(CONTENT_STATUSES.map((s) => [s, all.filter((c) => c.status === s).length]));

  // Grid: 5 weeks starting on the Monday on/before `from`.
  const start = addDays(from, -((weekdayOf(from) + 6) % 7));
  const days = Array.from({ length: 35 }, (_, i) => addDays(start, i));
  const byDay = new Map<string, ContentPiece[]>();
  for (const c of items) byDay.set(c.plannedDate!, [...(byDay.get(c.plannedDate!) ?? []), c]);
  const qs = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ ...(status ? { status } : {}), ...(platform ? { platform } : {}), from, view, ...patch });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/calendar?${p.toString()}`;
  };

  return (
    <>
      <PageHead title="Content Calendar" intro="Draft → needs review → approved → scheduled → published (or failed). Scheduled posts are auto-published on connected platforms when auto-publish is on; otherwise post them by hand.">
        <a className="btn secondary" href="/api/export/calendar">Export CSV</a>
      </PageHead>
      <Flash params={params} />

      <div className="grid two" style={{ marginBottom: "1rem" }}>
        <section className="card">
          <h2>Plan the next 30 days</h2>
          <form action={generateCalendarAction} className="form-grid">
            <label>Start date<input type="date" name="startDate" defaultValue={today} /></label>
            <label className="inline full"><input type="checkbox" name="replaceDrafts" /> Replace existing unreviewed drafts from that date</label>
            <div className="full"><button type="submit">Generate 30-day calendar</button></div>
          </form>
          <p className="muted" style={{ marginTop: "0.5rem" }}>Uses the highest-priority ideas, rotates pillars, writes each platform version, and sets a target from your history. Times without enough data are marked "(experiment)".</p>
        </section>
        <section className="card">
          <h2>Review queue</h2>
          <div className="row" style={{ marginBottom: "0.75rem" }}>
            {CONTENT_STATUSES.map((s) => (
              <Link key={s} href={qs({ status: status === s ? "" : s })} style={{ textDecoration: "none", opacity: status && status !== s ? 0.5 : 1 }}>
                <StatusBadge status={s} /> {counts[s]}
              </Link>
            ))}
          </div>
          <form action={bulkSubmitAction} className="row">
            <ActorField />
            <button type="submit" className="secondary">Submit all planned drafts for review</button>
          </form>
        </section>
      </div>

      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <Link className="btn secondary small" href={qs({ from: addDays(start, -28) })}>← Earlier</Link>
        <Link className="btn secondary small" href={qs({ from: today })}>Today</Link>
        <Link className="btn secondary small" href={qs({ from: addDays(start, 28) })}>Later →</Link>
        <span className="spacer" />
        <form className="row" action="/calendar">
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="view" value={view} />
          <select name="platform" defaultValue={platform}>
            <option value="">All platforms</option>
            {brand.platforms.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
          </select>
          <select name="status" defaultValue={status}>
            <option value="">All statuses</option>
            {CONTENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="submit" className="secondary small">Filter</button>
        </form>
        <Link className="btn secondary small" href={qs({ view: view === "grid" ? "list" : "grid" })}>{view === "grid" ? "List view" : "Grid view"}</Link>
      </div>

      {all.length === 0 ? (
        <section className="card"><Empty>No planned content yet. Generate a 30-day calendar above.</Empty></section>
      ) : view === "grid" ? (
        <div className="cal">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="dow">{d}</div>)}
          {days.map((d) => (
            <div key={d} className={`day${d < today ? " out" : ""}`}>
              <div className="date">{WEEKDAY_NAMES[weekdayOf(d)]} {Number(d.slice(8))} {new Date(`${d}T00:00:00Z`).toLocaleString("en", { month: "short", timeZone: "UTC" })}</div>
              {(byDay.get(d) ?? []).map((c) => (
                <Link key={c.id} href={`/content/${c.id}`} className={`item status-${c.status}`} title={`${c.status}: ${c.hook}`}>
                  <b>{PLATFORM_LABEL[c.platform]} {c.format}</b>
                  {c.hook.slice(0, 60)}
                </Link>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <section className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Platform</th><th>Pillar</th><th>Topic / hook</th><th>Target</th><th>Status</th></tr></thead>
              <tbody>
                {[...items].sort((a, b) => `${a.plannedDate}${a.plannedTime}`.localeCompare(`${b.plannedDate}${b.plannedTime}`)).map((c) => (
                  <tr key={c.id}>
                    <td>{c.plannedDate}<div className="muted">{c.plannedTime}</div></td>
                    <td>{PLATFORM_LABEL[c.platform]} {c.format}</td>
                    <td>{brand.pillars.find((p) => p.id === c.pillarId)?.name ?? c.pillarId}</td>
                    <td><Link href={`/content/${c.id}`}>{c.hook}</Link><div className="muted" style={{ fontSize: "0.8rem" }}>{c.topic}</div></td>
                    <td style={{ fontSize: "0.8rem" }}>{c.targetMetric ? <>{c.targetMetric.metric}<div className="muted">{c.targetMetric.target}</div></> : "—"}</td>
                    <td><StatusBadge status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
