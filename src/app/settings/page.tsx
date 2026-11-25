import { activeBrand, readDb, dataFile } from "@/lib/db";
import { PLATFORMS } from "@/lib/schemas";
import { ADAPTERS } from "@/lib/publishing/adapters";
import { connectionStatus } from "@/lib/publishing/agent";
import { accountKey } from "@/lib/publishing/accounts";
import { claudeSource } from "@/lib/llm/anthropic";
import { Flash, PageHead, PLATFORM_LABEL, type SearchParams } from "@/components/ui";
import { addBrandAction, addTrendNoteAction, clearSampleDataAction, removeTrendNoteAction, saveBrandAction, setModeAction } from "../actions";

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const sampleCount = db.metrics.filter((m) => m.isSample).length + db.inbox.filter((m) => m.isSample).length + db.experiments.filter((m) => m.isSample).length;
  const source = claudeSource();
  const connected = new Set(connectionStatus(brand, db).filter((c) => c.connected).map((c) => c.platform));

  return (
    <>
      <PageHead title="Settings" intro={`Brand profile, approval rules, generation mode and integrations. Data file: ${dataFile()}`} />
      <Flash params={params} />

      <div className="grid two">
        <section className="card">
          <h2>Generation mode</h2>
          <form action={setModeAction} className="stack">
            <label className="inline"><input type="radio" name="mode" value="template" defaultChecked={db.settings.generationMode === "template"} /> <span><b>Template</b> — free, offline, rule-based drafts you edit.</span></label>
            <label className="inline"><input type="radio" name="mode" value="manual" defaultChecked={db.settings.generationMode === "manual"} /> <span><b>Manual via Claude chat</b> — free with a Claude subscription: copy a prompt, paste the JSON back.</span></label>
            <label className="inline"><input type="radio" name="mode" value="anthropic" defaultChecked={db.settings.generationMode === "anthropic"} /> <span><b>Claude (automatic)</b> — writes complete posts by itself. Uses: {source === "api" ? <span className="badge ok">API key (billed per use)</span> : source === "subscription" ? <span className="badge ok">your Claude subscription (Claude Code on this PC)</span> : <span className="badge warn">nothing found</span>}</span></label>
            <div><button type="submit">Save mode</button></div>
          </form>
          <p className="muted" style={{ marginTop: "0.5rem" }}>Without an API key, automatic mode uses Claude Code on this computer, signed in with your Claude subscription (no extra cost; it counts toward your usage limits). If neither is available it falls back to templates and says so.</p>
        </section>

        <section className="card">
          <h2>Trend notes</h2>
          <p className="muted">Add trends, festivals or news you've seen on the platforms (this version doesn't scrape anything). "Generate ideas" turns them into backlog ideas.</p>
          <form action={addTrendNoteAction} className="row">
            <input name="text" placeholder="e.g. Diwali 8 Nov: decluttering Reels trending" style={{ flex: 1 }} required />
            <button type="submit" className="secondary">Add</button>
          </form>
          <ul className="list">
            {brand.trendNotes.map((t) => (
              <li key={t.id} className="row"><span style={{ flex: 1 }}>{t.text}</span><form action={removeTrendNoteAction}><input type="hidden" name="id" value={t.id} /><button className="secondary small">Remove</button></form></li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Brand profile — {brand.name}</h2>
        <form action={saveBrandAction} className="form-grid">
          <label>Name<input name="name" defaultValue={brand.name} required /></label>
          <label>Organisation<input name="organisation" defaultValue={brand.organisation} /></label>
          <label>Website<input name="website" defaultValue={brand.website} /></label>
          <label>Languages (comma-separated)<input name="languages" defaultValue={brand.languages.join(", ")} /></label>
          <label>Category<input name="category" defaultValue={brand.category} /></label>
          <label>Logo file (for videos; PNG with a transparent background works best)<input name="logoFile" defaultValue={brand.logoFile} placeholder="C:\path	o\logo.png" /></label>
          <label>Tagline (shown on video end cards)<input name="tagline" defaultValue={brand.tagline} placeholder="Earn • Impact • Elevate" /></label>
          <label>Account key (prefix for this brand&apos;s tokens in .env.local)<input name="accountKey" defaultValue={brand.accountKey} placeholder={accountKey(brand)} /><small>Tokens are read as {accountKey(brand)}_META_PAGE_ID, {accountKey(brand)}_INSTAGRAM_ACCOUNT_ID, and so on.</small></label>
          <label>Audience (one per line)<textarea name="audience" defaultValue={brand.audience.join("\n")} /></label>
          <label>Voice (comma-separated)<textarea name="voice" defaultValue={brand.voice.join(", ")} /></label>
          <label className="full">Content pillars (one per line: id | name | description)<textarea name="pillars" rows={8} defaultValue={brand.pillars.map((p) => `${p.id} | ${p.name} | ${p.description}`).join("\n")} /></label>
          <label className="full">
            Brand facts (one per line: [x] verified or [ ] unverified, then fact | source). Only [x] facts are stated in generated copy.
            <textarea name="facts" rows={8} defaultValue={brand.facts.map((f) => `[${f.verified ? "x" : " "}] ${f.text} | ${f.source}`).join("\n")} />
          </label>
          <label>Brand hashtags (space-separated)<input name="hashtags" defaultValue={brand.hashtags.join(" ")} /></label>
          <label>Default CTAs (one per line)<textarea name="defaultCtas" defaultValue={brand.defaultCtas.join("\n")} /></label>
          <label className="full">Never say (one per line)<textarea name="avoid" defaultValue={brand.avoid.join("\n")} /></label>
          <fieldset className="full" style={{ border: 0, padding: 0 }}>
            <legend style={{ fontSize: "0.85rem", fontWeight: 600 }}>Platforms</legend>
            <div className="row">{PLATFORMS.map((p) => <label key={p} className="inline"><input type="checkbox" name="platforms" value={p} defaultChecked={brand.platforms.includes(p)} /> {PLATFORM_LABEL[p]}</label>)}</div>
          </fieldset>
          <fieldset className="full" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.75rem" }}>
            <legend style={{ fontWeight: 600 }}>Approval policy</legend>
            <div className="form-grid">
              <label className="inline full"><input type="checkbox" name="requireReview" defaultChecked={brand.approvalPolicy.requireReview} /> Content must go to "needs review" before it can be approved</label>
              <label>Content approvers (comma-separated names; empty = anyone)<input name="approvers" defaultValue={brand.approvalPolicy.approvers.join(", ")} /></label>
              <label>Reply approvers (comma-separated; empty = anyone)<input name="replyApprovers" defaultValue={brand.approvalPolicy.replyApprovers.join(", ")} /></label>
            </div>
            <p className="muted" style={{ margin: "0.5rem 0 0" }}>Always on: only approved, scheduled posts are published (automatically only when auto-publish is on), and comment replies are never posted automatically.</p>
          </fieldset>
          <div className="full"><button type="submit">Save brand profile</button></div>
        </form>
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Platform connections</h2>
        <p className="muted">Connected platforms are posted to by the Publishing Agent (set it up and switch it on in <a href="/publishing">Publishing</a>). Others stay export-only. Requirements below were checked against official docs on 26 Oct 2026; re-check them if a call fails.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Platform</th><th>Status</th><th>Official API</th><th>Needs</th><th>Limits</th></tr></thead>
            <tbody>
              {Object.values(ADAPTERS).map((a) => (
                <tr key={a.platform}>
                  <td>{PLATFORM_LABEL[a.platform]}</td>
                  <td>{connected.has(a.platform) ? <span className="badge ok">connected</span> : <span className="badge warn">export only</span>}</td>
                  <td><a href={a.docs} target="_blank" rel="noreferrer">{a.officialApi}</a></td>
                  <td style={{ fontSize: "0.85rem" }}>{a.accountRequirement} Permissions: {a.permissions.join("; ")}. {a.access}</td>
                  <td style={{ fontSize: "0.85rem" }}>{[...a.limits, ...a.notSupported].join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid two" style={{ marginTop: "1rem" }}>
        <section className="card">
          <h2>Add another brand</h2>
          <form action={addBrandAction} className="form-grid">
            <label>Name<input name="name" required /></label>
            <label>Category<input name="category" /></label>
            <div className="full"><button type="submit" className="secondary">Create and switch</button></div>
          </form>
          <p className="muted">Template ideas are tuned for sustainability brands; other categories work best in Manual or API mode.</p>
        </section>
        <section className="card">
          <h2>Sample data</h2>
          <p>{sampleCount} sample record(s) (invented metrics, comments and experiments) are in this workspace.</p>
          <form action={clearSampleDataAction}><button type="submit" className="danger" disabled={sampleCount === 0}>Remove all sample data</button></form>
          <p className="muted" style={{ marginTop: "0.5rem" }}>To start over completely, stop the app and run <code>npm run reset-data</code> (a backup is kept).</p>
        </section>
      </div>
    </>
  );
}
