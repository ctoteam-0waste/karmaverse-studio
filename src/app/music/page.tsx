import path from "node:path";
import { dataFile } from "@/lib/db";
import { MOODS, musicDir, readLibrary } from "@/lib/music/agent";
import { Empty, Flash, PageHead, type SearchParams } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { findMusicAction, removeMusicAction } from "../actions";

const LICENSE_LABEL: Record<string, string> = { cc0: "CC0 · no credit needed", pdm: "Public domain · no credit needed", by: "CC BY · credit added to the post" };

export default async function MusicPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const library = (await readLibrary(musicDir(dataFile()))).sort((a, b) => a.mood.localeCompare(b.mood) || b.score - a.score);

  return (
    <>
      <PageHead
        title="Music Agent"
        intro="Finds background music that is safe for brand videos (CC0, public domain or CC BY only), checks each track really is music, and keeps it here. The Video Maker picks from this library automatically, or you choose a track."
      />
      <Flash params={params} />

      <section className="card">
        <h2>Find music</h2>
        <form action={findMusicAction} className="row">
          <label className="inline">
            Mood
            <select name="mood" defaultValue="uplifting">
              {Object.entries(MOODS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
          </label>
          <SubmitButton pendingText="Searching Openverse… (can take a few minutes)">Find 4 tracks</SubmitButton>
        </form>
        <p className="muted" style={{ marginTop: "0.5rem" }}>Source: Openverse (Freesound, Wikimedia Commons and more). ShareAlike and NonCommercial tracks are never used. Listen before publishing: the agent checks that a track is music and how loud it is, but not whether it suits your brand.</p>
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2>Library ({library.length})</h2>
        {library.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Track</th><th>Mood</th><th>Length</th><th>Licence</th><th>Listen</th><th></th></tr></thead>
              <tbody>
                {library.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <b>{t.title}</b>
                      <div className="muted" style={{ fontSize: "0.85rem" }}>{t.creator || "unknown artist"} · {t.source}{t.landingUrl ? <> · <a href={t.landingUrl} target="_blank" rel="noreferrer">source</a></> : null}</div>
                      {t.credit ? <div className="muted" style={{ fontSize: "0.8rem" }}>{t.credit}</div> : null}
                    </td>
                    <td>{MOODS[t.mood]?.label ?? t.mood}</td>
                    <td>{Math.floor(t.durationSec / 60)}:{String(t.durationSec % 60).padStart(2, "0")}</td>
                    <td><span className={`badge ${t.license === "by" ? "info" : "ok"}`}>{LICENSE_LABEL[t.license]}</span></td>
                    <td><audio controls preload="none" src={`/api/music/${path.basename(t.file)}`} style={{ width: 220 }} /></td>
                    <td>
                      <form action={removeMusicAction}><input type="hidden" name="id" value={t.id} /><button className="secondary small" aria-label={`Remove ${t.title}`}>Remove</button></form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No music yet. Choose a mood and click Find 4 tracks, or just make a video with Music: Auto and the agent will search for you.</Empty>
        )}
      </section>
    </>
  );
}
