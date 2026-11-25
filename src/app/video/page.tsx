import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { Empty, Flash, fmtDate, PageHead, PLATFORM_LABEL, SampleBadge, type SearchParams } from "@/components/ui";
import { TargetPicker } from "@/components/targets";
import { createBriefAction } from "../actions";

export default async function VideoPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const ideas = db.ideas.filter((i) => i.brandId === brand.id && i.status !== "rejected").sort((a, b) => b.priority - a.priority);
  const briefs = db.briefs.filter((b) => b.brandId === brand.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const videoPlatforms = brand.platforms.filter((p) => p !== "linkedin");

  return (
    <>
      <PageHead title="Video Director" intro="Production briefs: hooks, timestamped script, storyboard, camera and edit notes. Open a brief to make a captioned video with voiceover from it (Video Maker), or film it yourself from the storyboard." />
      <Flash params={params} />
      <div className="grid two">
        <section className="card">
          <h2>New production brief</h2>
          <form action={createBriefAction} className="stack">
            <label>Idea
              <select name="ideaId" required>
                {ideas.map((i) => <option key={i.id} value={i.id}>[{i.priority}] {i.title}</option>)}
              </select>
            </label>
            <div className="form-grid">
              <label>Platform / format<TargetPicker single platforms={videoPlatforms} defaults={["instagram/reel"]} /></label>
              <label>Duration (seconds)<input name="durationSec" type="number" min={5} max={1800} defaultValue={30} /></label>
            </div>
            <div><button type="submit" disabled={ideas.length === 0}>Write brief</button></div>
            <p className="muted">Tip: Reels and Shorts work best at 15–45 s; long-form at 4–10 minutes (240–600 s).</p>
          </form>
        </section>
        <section className="card">
          <h2>Briefs</h2>
          {briefs.length ? (
            <ul className="list">
              {briefs.map((b) => (
                <li key={b.id} className="row">
                  <span className="badge">{PLATFORM_LABEL[b.platform]} {b.format}</span>
                  <Link href={`/video/${b.id}`} style={{ flex: 1, minWidth: 180 }}>{b.title}</Link>
                  <span className="muted">{b.durationSec}s · {b.effort.level}</span>
                  <span className="muted">{fmtDate(b.createdAt)}</span>
                  <SampleBadge show={b.isSample} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No briefs yet.</Empty>
          )}
        </section>
      </div>
    </>
  );
}
