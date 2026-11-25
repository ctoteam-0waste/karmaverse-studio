import type { ContentPiece } from "@/lib/schemas";
import { CAROUSEL_DESIGN_LABEL, CAROUSEL_DESIGNS, designFor, slidesFromPiece, slidesToText } from "@/lib/carousel/maker";
import { makeCarouselAction } from "@/app/actions";
import { SubmitButton } from "./submit-button";
import { videoUrl } from "./video-maker";
import { MOODS } from "@/lib/music/agent";

/** Slide previews and the Carousel Maker form for a carousel / image / document post. */
export function CarouselCard({ piece, locked }: { piece: ContentPiece; locked: boolean }) {
  const slides = piece.mediaUrls.map((f) => ({ file: f, url: videoUrl(f) })).filter((s) => s.url && s.file.endsWith(".jpg"));
  const pdf = piece.extraMedia.find((m) => m.file.endsWith(".pdf"));
  const video = piece.extraMedia.find((m) => m.file.endsWith(".mp4"));
  const videoSrc = video ? videoUrl(video.file) : null;
  const pdfUrl = pdf ? videoUrl(pdf.file) : null;
  const draft = piece.slides || slidesToText(slidesFromPiece(piece));
  return (
    <section className="card" id="carousel">
      <h2>Carousel slides</h2>
      {slides.length ? (
        <div className="stack">
          <div className="row" style={{ flexWrap: "nowrap", overflowX: "auto", gap: "0.5rem", paddingBottom: "0.25rem" }}>
            {slides.map((s, i) => (
              <a key={s.file} href={s.url!} target="_blank" rel="noreferrer" style={{ flex: "0 0 auto" }} title={`Slide ${i + 1}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url!} alt={`Slide ${i + 1}`} style={{ height: 220, borderRadius: 6, border: "1px solid var(--line)" }} />
              </a>
            ))}
          </div>
          {videoSrc ? (
            <div className="row" style={{ alignItems: "flex-start" }}>
              <video src={videoSrc} controls preload="metadata" style={{ width: 200, borderRadius: 8, background: "#000" }} />
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                <b>{video!.label}</b>
                <br />
                <a href={`${videoSrc}?download`}>Download video</a>. Post it as a Reel / Short alongside the carousel.
              </div>
            </div>
          ) : null}
          <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
            {slides.length} slides attached as this post&apos;s images. {pdfUrl ? <a href={`${pdfUrl}?download`}>Download PDF</a> : null} {pdfUrl ? "(upload it as a LinkedIn document carousel)." : null} Click a slide to open it full size.
          </p>
        </div>
      ) : (
        <p className="muted">No slides yet.</p>
      )}
      {!locked ? (
        <details open={slides.length === 0} style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer" }}>{slides.length ? "Make the slides again" : "Make slides"}</summary>
          <form action={makeCarouselAction} className="stack" style={{ marginTop: "0.5rem" }}>
            <input type="hidden" name="id" value={piece.id} />
            <label>Cover headline<input name="hook" defaultValue={piece.hook} /></label>
            <label>
              Content slides (one per line: <code>Title | short text</code>; up to 8)
              <textarea name="slides" rows={7} defaultValue={draft} />
              <small className="muted">A cover slide (headline + Swipe) and a closing slide (logo, button, website) are added automatically. Replace every [bracketed] part.</small>
            </label>
            <label>
              Images in a phone on content slides (optional; one line per content slide, in order; <code>-</code> = no image on that slide)
              <textarea name="images" rows={3} placeholder={"C:\\...\\data\\brand\\app-screens\\karmaverse-screen-2.png"} />
              <small className="muted">Check images for names, phone numbers and addresses first.</small>
            </label>
            <div className="form-grid">
              <label>
                Size
                <select name="size" defaultValue="4:5">
                  <option value="4:5">Portrait 4:5 (1080×1350, best for Instagram/LinkedIn feeds)</option>
                  <option value="1:1">Square 1:1 (1080×1080)</option>
                </select>
              </label>
              <label>
                Design
                <select name="design" defaultValue={designFor(piece.plannedDate)}>
                  {CAROUSEL_DESIGNS.map((d) => <option key={d} value={d}>{CAROUSEL_DESIGN_LABEL[d]}</option>)}
                </select>
                <small className="muted">Phone images only show in the Classic design.</small>
              </label>
              <label>Button text (last slide)<input name="cta" defaultValue={piece.cta} /></label>
              <label>Note on the last slide (optional)<input name="footnote" placeholder="Available on Android" /></label>
              <label className="inline full"><input type="checkbox" name="caption" defaultChecked /> <span><b>Write the post text from the slides</b> (replaces the caption; tuned for this platform)</span></label>
              <label className="inline full"><input type="checkbox" name="video" defaultChecked /> <span><b>Also make a video version</b> (vertical Reel/Short: swipe transitions, slow zoom, whooshes, music; adds about 1 minute)</span></label>
              <label>
                Music for the video
                <select name="mood" defaultValue="uplifting">
                  {Object.entries(MOODS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                </select>
              </label>
              <input type="hidden" name="music" value="auto" />
            </div>
            <div><SubmitButton pendingText="Making slides, text and video… (about 1–2 minutes)">Make slides</SubmitButton></div>
            <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>Remaking the slides of an approved post sends it back for review.</p>
          </form>
        </details>
      ) : null}
    </section>
  );
}
