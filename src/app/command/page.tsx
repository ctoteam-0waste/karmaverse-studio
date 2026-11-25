import { activeBrand, readDb } from "@/lib/db";
import { CHARACTERS } from "@/lib/video/characters";
import { Empty, Flash, PageHead, type SearchParams } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { addDirectionAction, retryCommandAction, sendCommandAction, toggleDirectionAction, undoChangeAction } from "./actions";

const fmtIst = (d: string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const EXAMPLES = [
  "Make more Hinglish videos for Instagram, and keep every reel under 20 seconds.",
  "Goal: 500 Instagram followers and 200 website visits from social by 31 December.",
  "Use Dadi in the next myth video and Binny the Bin in the next eco hack.",
  "Move tomorrow's Facebook reel to 7 pm.",
  "Stop saying 'doorstep pickup' in captions; talk about climate action instead.",
  "Turn on automatic replies for praise comments.",
  "How did our posts do this week?",
];

export default async function CommandPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const commands = db.commands.filter((c) => c.brandId === brand.id).slice().reverse().slice(0, 30);
  const busy = commands.some((c) => c.status === "pending" || c.status === "running");
  const rules = brand.instructions.slice().reverse();
  const goals = brand.goals.slice().reverse();

  return (
    <>
      {/* While Claude is working, reload every 5 seconds to show the result. */}
      {busy ? <meta httpEquiv="refresh" content="5" /> : null}
      <PageHead
        title="Tell the team"
        intro="Write what you want in plain words: comments on posts, rules for the writers, the outcomes you want, or a question. The system changes itself and shows exactly what it did, with Undo. Publishing still follows your approval rules."
      />
      <Flash params={params} />

      <section className="card">
        <form action={sendCommandAction} className="stack">
          <label htmlFor="cmd-text"><b>What do you want?</b></label>
          <textarea id="cmd-text" name="text" required minLength={3} maxLength={4000} rows={4} placeholder={EXAMPLES[0]} />
          <div className="row">
            <SubmitButton pendingText="Sending…">Send</SubmitButton>
            <span className="muted">English, Hindi or Hinglish all work.</span>
          </div>
        </form>
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer" }}>Things you can say</summary>
          <ul style={{ fontSize: "0.9rem" }}>{EXAMPLES.map((e) => <li key={e}>{e}</li>)}</ul>
          <p className="muted" style={{ fontSize: "0.85rem" }}>Video hosts: {CHARACTERS.map((c) => `${c.emoji} ${c.name}`).join(" · ")}. Name one in your message to use it.</p>
        </details>
      </section>

      <div className="grid two" style={{ marginTop: "1rem" }}>
        <section className="card">
          <h2>Standing instructions <span className="badge ok">{rules.filter((r) => r.active).length} active</span></h2>
          <p className="muted" style={{ marginTop: 0 }}>Every writer (posts, video scripts, blog) follows these. If two disagree, the newer one wins.</p>
          {rules.length ? (
            <ul className="list">
              {rules.map((r) => (
                <li key={r.id} style={{ opacity: r.active ? 1 : 0.55 }}>
                  {r.text} <span className="muted" style={{ fontSize: "0.8rem" }}>{r.by ? `· ${r.by} ` : ""}· {fmtIst(r.addedAt)}</span>
                  <form action={toggleDirectionAction} style={{ display: "inline", marginLeft: "0.4rem" }}>
                    <input type="hidden" name="kind" value="rule" />
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="active" value={r.active ? "0" : "1"} />
                    <button type="submit" className="secondary small">{r.active ? "Retire" : "Turn back on"}</button>
                  </form>
                </li>
              ))}
            </ul>
          ) : <Empty>No instructions yet. Tell the team how you want things done.</Empty>}
          <form action={addDirectionAction} className="row" style={{ marginTop: "0.5rem" }}>
            <input type="hidden" name="kind" value="rule" />
            <input name="text" placeholder="Add one directly, e.g. End every caption with a question" style={{ flex: 1, minWidth: "12rem" }} aria-label="New instruction" />
            <button type="submit" className="secondary">Add</button>
          </form>
        </section>

        <section className="card">
          <h2>Goals <span className="badge ok">{goals.filter((g) => g.active).length} active</span></h2>
          <p className="muted" style={{ marginTop: 0 }}>The outcomes you want. Writers pick angles, hooks and calls to action that move them.</p>
          {goals.length ? (
            <ul className="list">
              {goals.map((g) => (
                <li key={g.id} style={{ opacity: g.active ? 1 : 0.55 }}>
                  {g.text} <span className="muted" style={{ fontSize: "0.8rem" }}>· {fmtIst(g.addedAt)}</span>
                  <form action={toggleDirectionAction} style={{ display: "inline", marginLeft: "0.4rem" }}>
                    <input type="hidden" name="kind" value="goal" />
                    <input type="hidden" name="id" value={g.id} />
                    <input type="hidden" name="active" value={g.active ? "0" : "1"} />
                    <button type="submit" className="secondary small">{g.active ? "Done / retire" : "Turn back on"}</button>
                  </form>
                </li>
              ))}
            </ul>
          ) : <Empty>No goals yet, e.g. “500 Instagram followers by 31 Dec”.</Empty>}
          <form action={addDirectionAction} className="row" style={{ marginTop: "0.5rem" }}>
            <input type="hidden" name="kind" value="goal" />
            <input name="text" placeholder="Add a goal directly" style={{ flex: 1, minWidth: "12rem" }} aria-label="New goal" />
            <button type="submit" className="secondary">Add</button>
          </form>
        </section>
      </div>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>What you asked, and what changed</h2>
        {commands.length ? (
          <ul className="list">
            {commands.map((c) => (
              <li key={c.id} style={{ paddingBottom: "0.75rem" }}>
                <div>
                  <b>{c.by || "team"}</b> <span className="muted" style={{ fontSize: "0.8rem" }}>{fmtIst(c.at)}</span>{" "}
                  <span className={`badge ${c.status === "done" ? "ok" : c.status === "failed" ? "bad" : "info"}`}>{c.status === "pending" || c.status === "running" ? "working…" : c.status}</span>
                </div>
                <div style={{ whiteSpace: "pre-wrap", margin: "0.25rem 0" }}>“{c.text}”</div>
                {c.reply ? <div style={{ background: "var(--chip)", borderRadius: 8, padding: "0.5rem 0.7rem" }}>{c.reply}</div> : null}
                {c.changes.length ? (
                  <ul style={{ fontSize: "0.9rem", margin: "0.4rem 0 0" }}>
                    {c.changes.map((ch) => (
                      <li key={ch.id} style={{ textDecoration: ch.undoneAt ? "line-through" : undefined }}>
                        {ch.label}
                        {ch.undo && !ch.undoneAt ? (
                          <form action={undoChangeAction} style={{ display: "inline", marginLeft: "0.4rem" }}>
                            <input type="hidden" name="command" value={c.id} />
                            <input type="hidden" name="change" value={ch.id} />
                            <button type="submit" className="secondary small">Undo</button>
                          </form>
                        ) : ch.undoneAt ? <span className="muted"> (undone)</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : c.status === "done" ? <div className="muted" style={{ fontSize: "0.85rem" }}>No changes needed.</div> : null}
                {c.error ? <div className="muted" style={{ fontSize: "0.85rem" }}>{c.error}</div> : null}
                {c.status === "failed" ? (
                  <form action={retryCommandAction} style={{ marginTop: "0.3rem" }}>
                    <input type="hidden" name="id" value={c.id} />
                    <button type="submit" className="secondary small">Try again</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <Empty>Nothing yet. Write your first message above.</Empty>}
      </section>
    </>
  );
}
