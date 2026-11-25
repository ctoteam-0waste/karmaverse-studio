import { activeBrand, readDb } from "@/lib/db";
import { analysisMetrics, recommendExperiments, scorePosts } from "@/lib/analytics/engine";
import { EXPERIMENT_VARIABLES } from "@/lib/schemas";
import { Empty, Flash, PageHead, PLATFORM_LABEL, SampleBadge, type SearchParams } from "@/components/ui";
import { TargetPicker } from "@/components/targets";
import { addExperimentAction, addObservationAction, addRecommendedExperimentsAction, updateExperimentAction } from "../actions";

export default async function ExperimentsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const exps = db.experiments.filter((e) => e.brandId === brand.id);
  const active = exps.filter((e) => e.status === "proposed" || e.status === "running").sort((a, b) => b.impact / b.effort - a.impact / a.effort);
  const closed = exps.filter((e) => e.status === "concluded" || e.status === "abandoned");
  const recs = recommendExperiments(brand.id, scorePosts(analysisMetrics(db.metrics, brand.id)));
  const learning = db.learning.filter((l) => l.brandId === brand.id).sort((a, b) => b.at.localeCompare(a.at));

  return (
    <>
      <PageHead title="Experiments" intro="Change one or two things at a time, measure the platform's own metric, and write down what you learned.">
        <form action={addRecommendedExperimentsAction}><button type="submit">Add recommended ({recs.length})</button></form>
      </PageHead>
      <Flash params={params} />

      <section className="card">
        <h2>Active and proposed</h2>
        {active.length ? (
          <ul className="list">
            {active.map((e) => (
              <li key={e.id}>
                <div className="row">
                  <b style={{ flex: 1, minWidth: 220 }}>{e.hypothesis}</b>
                  <span className={`badge ${e.status === "running" ? "info" : ""}`}>{e.status}</span>
                  <span className="badge">impact {e.impact} · effort {e.effort}</span>
                  <SampleBadge show={e.isSample} />
                </div>
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  {PLATFORM_LABEL[e.platform]} {e.format} · change: {e.variable} — {e.change} · measure: {e.primaryMetric}{e.baseline ? ` · baseline: ${e.baseline}` : ""}{e.startDate ? ` · started ${e.startDate}` : ""}
                </div>
                <form action={updateExperimentAction} className="form-grid" style={{ marginTop: "0.5rem" }}>
                  <input type="hidden" name="id" value={e.id} />
                  <label>Result<input name="result" defaultValue={e.result} placeholder="What happened, with numbers" /></label>
                  <label>Learning<input name="learning" defaultValue={e.learning} placeholder="What we'll do differently" /></label>
                  <div className="row" style={{ alignSelf: "end" }}>
                    {e.status === "proposed" ? <button name="status" value="running" className="small">Start</button> : null}
                    <button name="status" value="concluded" className="secondary small">Conclude</button>
                    <button name="status" value="abandoned" className="secondary small">Abandon</button>
                  </div>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No active experiments. Add the recommended ones or write your own.</Empty>
        )}
      </section>

      <div className="grid two" style={{ marginTop: "1rem" }}>
        <section className="card">
          <h2>New hypothesis</h2>
          <form action={addExperimentAction} className="form-grid">
            <label className="full">Hypothesis<input name="hypothesis" placeholder="Reels with a question hook get more comments than statement hooks" required /></label>
            <label>Platform / format<TargetPicker single platforms={brand.platforms} /></label>
            <label>What changes<select name="variable">{EXPERIMENT_VARIABLES.map((v) => <option key={v}>{v}</option>)}</select></label>
            <label className="full">The change<input name="change" placeholder="Next 4 Reels open with a question; same time and length" /></label>
            <label>Metric to watch<input name="primaryMetric" placeholder="Engagement rate (per reach)" /></label>
            <label>Baseline<input name="baseline" /></label>
            <label>Impact (1–5)<input type="number" name="impact" min={1} max={5} defaultValue={3} /></label>
            <label>Effort (1–5)<input type="number" name="effort" min={1} max={5} defaultValue={2} /></label>
            <div className="full"><button type="submit">Add experiment</button></div>
          </form>
        </section>

        <section className="card">
          <h2>Learning log</h2>
          <form action={addObservationAction} className="row" style={{ marginBottom: "0.75rem" }}>
            <input name="text" placeholder="Observation, e.g. carousels with a checklist get saved more" style={{ flex: 1 }} />
            <button type="submit" className="secondary">Log</button>
          </form>
          {learning.length ? (
            <ul className="list">
              {learning.slice(0, 30).map((l) => (
                <li key={l.id}><span className={`badge ${l.kind === "result" ? "ok" : l.kind === "hypothesis" ? "info" : ""}`}>{l.kind}</span> {l.text} <span className="muted">{l.at.slice(0, 10)}</span></li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing logged yet.</Empty>
          )}
        </section>
      </div>

      {closed.length ? (
        <section className="card" style={{ marginTop: "1rem" }}>
          <h2>Concluded</h2>
          <ul className="list">
            {closed.map((e) => (
              <li key={e.id}><b>{e.hypothesis}</b> <span className="badge">{e.status}</span><div className="muted">{e.result}{e.learning ? ` — ${e.learning}` : ""}</div></li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
