import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { audienceQuestions, monthlyStrategy, pillarCoverage, weeklyStrategy } from "@/lib/agents/strategy";
import { addDays, weekdayOf, todayIst } from "@/lib/util";
import { Empty, Flash, PageHead, PLATFORM_LABEL, SampleBadge, StatusBadge, type SearchParams } from "@/components/ui";
import { TargetPicker } from "@/components/targets";
import { addIdeaAction, createContentAction, generateIdeasAction, setIdeaStatusAction } from "../actions";

export default async function Studio({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const today = todayIst();
  const nextMonday = addDays(today, ((8 - weekdayOf(today)) % 7) || 7);
  const ideas = db.ideas.filter((i) => i.brandId === brand.id);
  const open = ideas.filter((i) => i.status === "backlog" || i.status === "approved").sort((a, b) => b.priority - a.priority);
  const content = db.content.filter((c) => c.brandId === brand.id);
  const drafts = content.filter((c) => c.status === "draft" || c.status === "needs-review").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
  const week = weeklyStrategy(brand, ideas, nextMonday);
  const month = monthlyStrategy(brand, nextMonday);
  const coverage = pillarCoverage(brand, content, today, addDays(today, 30));
  const questions = audienceQuestions(db.inbox, brand.id, 6);
  const pillarName = (id: string) => brand.pillars.find((p) => p.id === id)?.name ?? id;
  const preselect = typeof params.ideaId === "string" ? params.ideaId : "";

  return (
    <>
      <PageHead title="Content Studio" intro="Strategy, a prioritised idea backlog, and platform-specific drafts. Nothing is published from here.">
        <form action={generateIdeasAction}><button type="submit">Generate ideas</button></form>
      </PageHead>
      <Flash params={params} />

      <div className="grid two">
        <section className="card">
          <h2>Create content from an idea</h2>
          <form action={createContentAction} className="stack">
            <label>
              Idea
              <select name="ideaId" defaultValue={preselect || open[0]?.id} required>
                {open.map((i) => (
                  <option key={i.id} value={i.id}>[{i.priority}] {i.title}</option>
                ))}
              </select>
            </label>
            <div>
              <div className="muted" style={{ fontSize: "0.85rem", marginBottom: 4 }}>Platform versions (each is written differently)</div>
              <TargetPicker platforms={brand.platforms} defaults={["instagram/reel", "linkedin/text-post", "youtube/short", "facebook/image-post"].filter((d) => brand.platforms.includes(d.split("/")[0] as never))} />
            </div>
            <div className="row">
              <button type="submit" disabled={open.length === 0}>Write drafts</button>
              <span className="muted">Mode: {db.settings.generationMode}. Change it in <Link href="/settings">Settings</Link>.</span>
            </div>
          </form>
        </section>

        <section className="card">
          <h2>Audience questions and gaps</h2>
          <h3>Questions from your comments</h3>
          {questions.length ? <ul>{questions.map((q) => <li key={q}>{q}</li>)}</ul> : <p className="muted">No questions yet. Add comments in the Community Inbox.</p>}
          <h3>Pillar coverage (next 30 days)</h3>
          <div className="stack">
            {coverage.map((c) => (
              <div key={c.pillarId}>
                <div className="row"><span>{c.name}</span><span className="spacer" /><span className="muted">{c.planned}</span>{c.isGap ? <span className="badge warn">gap</span> : null}</div>
                <div className="bar"><span style={{ width: `${Math.round(c.share * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Weekly strategy — week of {week.weekStart}</h2>
        <p className="muted">Top-priority ideas on the default cadence, max two per pillar. {week.notes.join(" ")}</p>
        {week.observances.length ? <p>Observances this week: {week.observances.map((o) => `${o.name} (${o.date})`).join(", ")}</p> : null}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Day</th><th>Platform</th><th>Idea</th><th>Pillar</th></tr></thead>
            <tbody>
              {week.slots.map((s) => (
                <tr key={`${s.date}${s.platform}${s.format}`}>
                  <td>{s.day} {s.date.slice(5)}</td>
                  <td>{PLATFORM_LABEL[s.platform]} {s.format}</td>
                  <td>{s.ideaTitle}</td>
                  <td>{pillarName(s.pillarId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details style={{ marginTop: "0.75rem" }}>
          <summary>Monthly themes</summary>
          <ul>
            {month.weeks.map((w) => <li key={w.weekStart}><b>{w.weekStart}</b>: {w.theme} — {w.pillars.map(pillarName).join(", ")}</li>)}
          </ul>
          <p className="muted">Fixed-date observances only: {month.observances.map((o) => `${o.name} (${o.date})`).join(", ") || "none in this window"}. Add movable festivals (Diwali, Holi, Eid, etc.) as trend notes in Settings.</p>
        </details>
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Idea backlog <span className="muted" style={{ fontWeight: 400, fontSize: "0.85rem" }}>Priority = relevance 50% · impact 30% · ease 20% (+10 for gap pillars)</span></h2>
        {open.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th className="num">Priority</th><th>Idea</th><th>Pillar</th><th>Source</th><th className="num">R/I/E</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {open.map((i) => (
                  <tr key={i.id}>
                    <td className="num"><b>{i.priority}</b></td>
                    <td>{i.title}{i.angle ? <div className="muted" style={{ fontSize: "0.8rem" }}>{i.angle}</div> : null}</td>
                    <td>{pillarName(i.pillarId)}</td>
                    <td><span className="badge">{i.source}</span> <SampleBadge show={i.isSample} /></td>
                    <td className="num">{i.relevance}/{i.impact}/{i.effort}</td>
                    <td>{i.status}</td>
                    <td>
                      <div className="row">
                        {i.status !== "approved" ? (
                          <form action={setIdeaStatusAction}><input type="hidden" name="id" value={i.id} /><input type="hidden" name="status" value="approved" /><button className="secondary small">Approve</button></form>
                        ) : null}
                        <form action={setIdeaStatusAction}><input type="hidden" name="id" value={i.id} /><input type="hidden" name="status" value="rejected" /><button className="secondary small">Reject</button></form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>The backlog is empty. Click "Generate ideas" or add one below.</Empty>
        )}
        <details style={{ marginTop: "1rem" }}>
          <summary>Add your own idea</summary>
          <form action={addIdeaAction} className="form-grid" style={{ marginTop: "0.75rem" }}>
            <label className="full">Title<input name="title" required /></label>
            <label>Pillar<select name="pillarId">{brand.pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>Relevance (1–5)<input name="relevance" type="number" min={1} max={5} defaultValue={4} /></label>
            <label>Impact (1–5)<input name="impact" type="number" min={1} max={5} defaultValue={3} /></label>
            <label>Effort (1–5)<input name="effort" type="number" min={1} max={5} defaultValue={2} /></label>
            <label className="full">Angle<input name="angle" /></label>
            <label className="full">Audience question it answers<input name="audienceQuestion" /></label>
            <div><button type="submit">Add idea</button></div>
          </form>
        </details>
      </section>

      <section className="card" style={{ marginTop: "1rem" }} id="drafts">
        <h2>Recent drafts</h2>
        {drafts.length ? (
          <ul className="list">
            {drafts.map((c) => (
              <li key={c.id} className="row">
                <span className="badge">{PLATFORM_LABEL[c.platform]} {c.format}</span>
                <Link href={`/content/${c.id}`} style={{ flex: 1, minWidth: 200 }}>{c.hook}</Link>
                <span className="muted">{c.plannedDate ?? "unscheduled"}</span>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No drafts yet.</Empty>
        )}
      </section>
    </>
  );
}
