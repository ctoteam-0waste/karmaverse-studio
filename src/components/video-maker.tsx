import path from "node:path";
import { listVoices, SERVABLE, videosDir } from "@/lib/video/maker";
import { dataFile } from "@/lib/db";
import { MOODS, musicDir, readLibrary } from "@/lib/music/agent";
import { ASPECT_LABEL, ASPECTS } from "@/lib/video/ad";
import { SubmitButton } from "./submit-button";

/** URL the app serves a file in data/videos from, or null for files elsewhere on this computer. */
export function videoUrl(file: string | null | undefined): string | null {
  if (!file) return null;
  const name = path.basename(file);
  const inVideos = path.resolve(path.dirname(file.replace(/^file:\/\/\/?/i, ""))).toLowerCase() === path.resolve(videosDir(dataFile())).toLowerCase();
  return inVideos && SERVABLE.test(name) ? `/api/videos/${name}` : null;
}

/** Other sizes and cover images made with a post's video. */
export function ExtraMedia({ items }: { items: Array<{ label: string; file: string }> }) {
  const shown = items.map((m) => ({ ...m, url: videoUrl(m.file) })).filter((m) => m.url);
  if (!shown.length) return null;
  return (
    <div className="stack" style={{ marginTop: "0.75rem" }}>
      <h3 style={{ margin: 0 }}>Other sizes and covers</h3>
      <div className="row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        {shown.map((m) => (
          <figure key={m.file} style={{ margin: 0, width: m.label.includes("16:9") ? 300 : 170 }}>
            {m.file.endsWith(".png") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={m.url!} alt={m.label} style={{ width: "100%", borderRadius: 6, border: "1px solid var(--line)" }} />
            ) : (
              <video src={m.url!} controls preload="metadata" style={{ width: "100%", borderRadius: 6, background: "#000" }} />
            )}
            <figcaption className="muted" style={{ fontSize: "0.8rem" }}>
              {m.label} · <a href={`${m.url}?download`}>Download</a>
            </figcaption>
          </figure>
        ))}
      </div>
      <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>These aren&apos;t published automatically: post them on the matching platform, or use a cover as the Reel/Short cover.</p>
    </div>
  );
}

export function VideoPlayer({ file, vertical }: { file: string | null | undefined; vertical: boolean }) {
  const url = videoUrl(file);
  if (!url) return null;
  return (
    <div className="stack">
      <video src={url} controls preload="metadata" style={{ width: "100%", maxWidth: vertical ? 280 : 560, borderRadius: 8, background: "#000" }} />
      <a href={`${url}?download`} className="muted" style={{ fontSize: "0.85rem" }}>Download MP4</a>
    </div>
  );
}

/** Form for the Video Maker. `action` is a server action taking id, voice and clips. */
export async function VideoMakerForm({ id, action, label, hint, subtitles = "" }: { id: string; action: (fd: FormData) => Promise<void>; label: string; hint: string; subtitles?: string }) {
  const voices = await listVoices();
  const library = await readLibrary(musicDir(dataFile()));
  return (
    <form action={action} className="stack">
      <input type="hidden" name="id" value={id} />
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <legend style={{ fontWeight: 600, fontSize: "0.9rem" }}>Style</legend>
        <label className="inline"><input type="radio" name="style" value="captions" defaultChecked /> <span><b>Captions + voice</b>: one captioned scene per script line with a voiceover (clips optional, as backgrounds).</span></label>
        <label className="inline"><input type="radio" name="style" value="wrap" /> <span><b>Clip as it is</b>: the first clip with its own sound, title above, CTA below, end card.</span></label>
        <label className="inline"><input type="radio" name="style" value="ad" /> <span><b>Advert</b>: animated logo intro, sliding headline, the clip in a framed card with a pulsing button, logo end card, sound effects. Needs a clip; set the brand logo in Settings.</span></label>
      </fieldset>
      <label>
        Voiceover (Captions + voice style)
        <select name="voice" defaultValue={voices.find((v) => /zira/i.test(v)) ?? voices[0] ?? "none"}>
          {voices.map((v) => <option key={v} value={v}>{v.replace(/^Microsoft /, "").replace(/ Desktop$/, "")}</option>)}
          <option value="none">No voice (captions only)</option>
        </select>
      </label>
      <label>
        Background clips (optional, one file path per line; used in turn behind each scene)
        <textarea name="clips" rows={2} placeholder={"C:\\Users\\OM\\Downloads\\pickup-schedule_1080p.mp4"} />
        <small className="muted">Leave empty for the brand-colour background. Videos and images (.mp4, .mov, .jpg, .png) work.</small>
      </label>
      <div className="form-grid">
        <label>
          Music
          <select name="music" defaultValue="auto">
            <option value="auto">Auto: the Music Agent picks for the mood</option>
            {library.map((t) => <option key={t.id} value={t.id}>{t.title} ({MOODS[t.mood]?.label ?? t.mood}, {t.durationSec}s, {t.license.toUpperCase()})</option>)}
            <option value="file">My own file (path below)</option>
            <option value="none">No music</option>
          </select>
        </label>
        <label>
          Mood (for Auto)
          <select name="mood" defaultValue="uplifting">
            {Object.entries(MOODS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
        </label>
        <label>Own music file (only for &quot;My own file&quot;)<input name="musicPath" placeholder={"C:\\Music\\upbeat.mp3"} /></label>
        <label>End-card note (advert, optional)<input name="footnote" placeholder="Available on Android" /></label>
        <label className="full">Advert messages during the clip (optional, one per line; shown one after another)<textarea name="beats" rows={3} placeholder={"Small everyday actions\nEarn KarmaCoins for every green step\nJoin the KarmaVerse"} /></label>
        <label className="inline full"><input type="checkbox" name="muteClip" /> <span>Mute the clip&apos;s own sound (when its narration doesn&apos;t match the message; add music instead)</span></label>
        <label className="full">
          App screens in a phone beside the clip (advert, optional; one per line: image path, or video path@seconds)
          <textarea name="screens" rows={3} placeholder={"C:\\...\\data\\brand\\app-screens\\karmaverse-screen-1.png\nC:\\Users\\OM\\Downloads\\KarmaVerse_demo_vd.mp4@65"} />
          <small className="muted">Shown one after another, in time with the messages. Check every screen for names, phone numbers and addresses first.</small>
        </label>
        <label className="full">
          Subtitles: what the clip says (advert, optional; one sentence per line, exact words)
          <textarea name="subtitles" rows={5} defaultValue={subtitles} />
          <small className="muted">Shown in time with the speech (timed by Windows speech recognition). Leave empty for no subtitles.</small>
        </label>
        <fieldset className="full" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, fontSize: "0.9rem" }}>Extra sizes (advert)</legend>
          <div className="row">
            {ASPECTS.map((a) => <label key={a} className="inline"><input type="checkbox" name="aspect" value={a} /> {ASPECT_LABEL[a]}</label>)}
          </div>
          <label className="inline"><input type="checkbox" name="covers" /> Also make a cover image for each size</label>
          <small className="muted">The post&apos;s own size is always made. Each extra size adds about 2–3 minutes.</small>
        </fieldset>
      </div>
      <div className="row">
        <SubmitButton pendingText="Making the video… (up to 3 minutes for an advert)">{label}</SubmitButton>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>{hint} Music comes from the <a href="/music">Music library</a>; a CC BY track&apos;s credit line is added to the post automatically.</p>
    </form>
  );
}
