import { characterById, pickCharacter } from "../video/characters";
import { existsSync } from "node:fs";
import type { Brand, ContentPiece, Database } from "../schemas";
import { dataFile, mutate, readDb } from "../db";
import { logger } from "../logger";
import { addDays, nowIso, todayIst } from "../util";
import { analysisMetrics } from "../analytics/engine";
import { videoTuning } from "../analytics/advice";
import { applyEdit, transition } from "./calendar";
import { lintContent } from "./content";
import { VIDEO_FORMATS, videosDir } from "../video/maker";
import { brandAssets, pickLook, pickMusic, renderBuddy, scriptFromPiece, type Look } from "../video/buddy";
import { musicDir, readLibrary } from "../music/agent";
import { designFor, renderCarousel, slidesFromPiece, slidesToText } from "../carousel/maker";
import { exclusiveRender, isRendering } from "../video/render-lock";
import { isClaudeConfigured } from "../llm/anthropic";
import { generateContent } from "../services/generation";
import { claudeClient } from "../llm/anthropic";
import { readStoredScript, writeSeriesPost } from "./series-writer";
import { isVideoPost, newsCandidates, renderCartoon, scenesFromScript, seriesFor } from "../video/series";

const log = logger("media-maker");

/**
 * L. Post Writer + Media Maker (runs in the background with the scheduler).
 *
 * Keeps the daily calendar postable. When the writing mode is Claude, it first
 * rewrites template drafts for the next week into complete posts (one per run).
 * Then, for posts planned in the next few days
 * that still have no media, it makes an Earth Buddy video (reels, shorts,
 * stories) or carousel slides (carousels, image posts), one at a time. Drafts
 * planned in that window that have everything they need are then sent for
 * review, so they show up on the Approve page. Nothing is approved or posted
 * here: a person still approves every post.
 */

export const AHEAD_DAYS = 3;
export const WRITE_AHEAD_DAYS = 7;
const SLIDE_FORMATS = ["carousel", "image-post"];
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const OPEN = ["draft", "needs-review"];

const KEY = Symbol.for("social-growth-agent.media-maker");
type G = typeof globalThis & { [KEY]?: { running: boolean; failed: Map<string, number> } };
function state() {
  const g = globalThis as G;
  return (g[KEY] ??= { running: false, failed: new Map() });
}

export function needsMedia(p: Pick<ContentPiece, "platform" | "format" | "mediaUrls">): boolean {
  if (p.platform === "x" || p.mediaUrls.length > 0) return false;
  return VIDEO_FORMATS.includes(p.format) || SLIDE_FORMATS.includes(p.format);
}

const inWindow = (p: ContentPiece, today: string, days = AHEAD_DAYS) => !p.isSample && !!p.plannedDate && p.plannedDate >= today && p.plannedDate <= addDays(today, days);

/** True when template drafts should be rewritten by Claude before media is made or review is asked for. */
export function writerOn(db: Pick<Database, "settings">): boolean {
  return db.settings.generationMode === "anthropic" && isClaudeConfigured();
}
/** Template posts Claude should rewrite: drafts, and posts waiting for review that nobody has approved yet. */
export const REWRITABLE = ["draft", "needs-review"];
const waitingForWriter = (db: Database, p: ContentPiece) => writerOn(db) && p.generatedBy === "template" && REWRITABLE.includes(p.status);

/** Fields for a rewritten post: old media was made from the old text, so it is dropped and made again. */
export function rewritePatch(cur: ContentPiece): Partial<ContentPiece> {
  return cur.mediaUrls.length ? { mediaUrls: [], hostedMedia: {}, extraMedia: [] } : {};
}

/** Template drafts in the coming week that Claude should rewrite, soonest first. */
export function writeQueue(db: Database, today = todayIst()): ContentPiece[] {
  if (!writerOn(db)) return [];
  const failed = state().failed;
  const now = Date.now();
  return db.content
    .filter((p) => REWRITABLE.includes(p.status) && p.generatedBy === "template" && inWindow(p, today, WRITE_AHEAD_DAYS) && now - (failed.get(`w:${p.id}`) ?? 0) > RETRY_AFTER_MS)
    // News videos are written the day before at the earliest, so the story is still fresh.
    .filter((p) => !(isVideoPost(p) && p.plannedDate! > addDays(today, 1) && seriesFor(p, newsCandidates(db.trends, p.brandId).length > 0) === "news"))
    .sort((a, b) => `${a.plannedDate} ${a.plannedTime}`.localeCompare(`${b.plannedDate} ${b.plannedTime}`));
}

/** Rewrites one template draft with Claude. Returns a short note, or null if nothing was written. */
export async function writeNext(db: Database): Promise<string | null> {
  const piece = writeQueue(db)[0];
  if (!piece) return null;
  const brand = db.brands.find((b) => b.id === piece.brandId);
  if (!brand) return null;
  // Reels and shorts are written as part of a video series (news, quiz, myth vs fact, eco hack, cartoon).
  if (isVideoPost(piece)) {
    try {
      const r = await writeSeriesPost(db, brand, piece, claudeClient());
      if (r?.ok) {
        await setWriterHealth(true, "");
        return r.note;
      }
    } catch (err) {
      const msg = (err as Error).message;
      log.warn("Could not write series post; writing a classic one instead", { id: piece.id, error: msg });
      if (/Claude Code|signed in|not found|exited with code|longer than/i.test(msg)) {
        await setWriterHealth(false, msg);
        state().failed.set(`w:${piece.id}`, Date.now());
        return null;
      }
    }
  }
  const idea = db.ideas.find((i) => i.id === piece.ideaId) ?? { title: piece.topic, angle: piece.hook, pillarId: piece.pillarId, audienceQuestion: "" };
  const r = await generateContent(brand, idea, [{ platform: piece.platform, format: piece.format }], "anthropic", undefined, { readyToPost: true });
  const v = r.versions[0];
  const blanks = v ? lintContent(brand, [v.hook, v.caption, v.description].join("\n")).filter((w) => w.level === "block") : [];
  if (r.generatedBy !== "anthropic" || !v || blanks.length) {
    if (blanks.length) r.warnings.push(...blanks.map((b) => b.message));
    state().failed.set(`w:${piece.id}`, Date.now());
    log.warn("Could not write post", { id: piece.id, warnings: r.warnings });
    const down = r.warnings.find((w) => w.startsWith("Claude failed") || w.includes("Claude Code"));
    if (down) await setWriterHealth(false, down);
    return null;
  }
  await setWriterHealth(true, "");
  const saved = await mutate((d) => {
    const i = d.content.findIndex((c) => c.id === piece.id);
    const cur = d.content[i];
    if (!cur || !REWRITABLE.includes(cur.status) || cur.generatedBy !== "template") return false;
    const next = applyEdit({ ...cur, ...rewritePatch(cur) }, { hook: v.hook, caption: v.caption, description: v.description, keywords: v.keywords, hashtags: v.hashtags, cta: v.cta, thumbnailConcept: v.thumbnailConcept }, "post-writer");
    d.content[i] = { ...next, generatedBy: "anthropic", history: [...next.history, { at: nowIso(), from: next.status, to: next.status, by: "post-writer", note: "Written by Claude." }] };
    return true;
  });
  if (!saved) return null;
  log.info("Wrote post", { id: piece.id, platform: piece.platform, date: piece.plannedDate });
  return `${piece.platform} "${piece.topic}" (${piece.plannedDate})`;
}

/** Records whether Claude answered, so the app can warn when the writer has stopped (e.g. signed out). */
async function setWriterHealth(ok: boolean, message: string): Promise<void> {
  await mutate((d) => {
    const cur = d.settings.writerHealth;
    if (cur && cur.ok === ok && cur.message === message && Date.now() - Date.parse(cur.at) < 60 * 60 * 1000) return;
    d.settings.writerHealth = { ok, at: nowIso(), message: message.slice(0, 300) };
  });
}

/** Posts that still need media, soonest first. */
export function mediaQueue(db: Database, today = todayIst()): ContentPiece[] {
  const failed = state().failed;
  const now = Date.now();
  return db.content
    .filter((p) => OPEN.includes(p.status) && inWindow(p, today) && needsMedia(p) && !waitingForWriter(db, p) && now - (failed.get(p.id) ?? 0) > RETRY_AFTER_MS)
    .sort((a, b) => `${a.plannedDate} ${a.plannedTime}`.localeCompare(`${b.plannedDate} ${b.plannedTime}`));
}

function withCredit(p: ContentPiece, credit: string): Partial<ContentPiece> {
  if (!credit) return {};
  if (p.platform === "youtube") return p.description.includes(credit) ? {} : { description: `${p.description.trim()}\n\n${credit}`.trim() };
  return p.caption.includes(credit) ? {} : { caption: `${p.caption.trim()}\n\n${credit}`.trim() };
}

async function makeSeriesVideo(db: Database, brand: Brand, piece: ContentPiece) {
  const stored = readStoredScript(piece);
  if (!stored) return null;
  const tracks = (await readLibrary(musicDir(dataFile()))).filter((t) => existsSync(t.file));
  const history = db.settings.videoLooks as Look[];
  const topic = `${stored.series} ${piece.topic} ${piece.hook}`;
  if (stored.series === "cartoon") {
    const music = pickMusic(tracks, "kinetic", `playful ${topic}`, history);
    const r = await exclusiveRender(() => renderCartoon(brand, stored.script as never, { outDir: videosDir(dataFile()), dataFile: dataFile(), music }));
    const credit = tracks.find((t) => t.file === music)?.credit ?? "";
    return {
      patch: (p: ContentPiece) => ({ mediaUrls: [r.file], ...withCredit(p, credit) }),
      extra: (d: Database) => {
        d.settings.videoLooks = [...d.settings.videoLooks, { style: "cartoon", theme: "story", layout: "center", music, at: nowIso(), file: r.file }].slice(-50);
      },
      what: `cartoon story video (${r.durationSec}s)`,
    };
  }
  const scenes = scenesFromScript(brand, stored.series, stored.script, stored.date);
  const picked = pickLook(history, "auto", scenes as never, tracks.map((t) => t.file), false);
  const look = { ...picked, style: stored.series, music: pickMusic(tracks, picked.style, topic, history) };
  const headline = "headline" in stored.script ? String(stored.script.headline) : piece.topic;
  const character = pickCharacter(history.map((l) => l.character), piece.character);
  const r = await exclusiveRender(() => renderBuddy(brand, scenes as never, look, { outDir: videosDir(dataFile()), dataFile: dataFile(), ticker: headline, character }));
  const credit = tracks.find((t) => t.file === look.music)?.credit ?? "";
  return {
    patch: (p: ContentPiece) => ({ mediaUrls: [r.file], character, ...withCredit(p, credit) }),
    extra: (d: Database) => {
      d.settings.videoLooks = [...d.settings.videoLooks, { ...look, character, at: nowIso(), file: r.file }].slice(-50);
    },
    what: `${stored.series} video with ${characterById(character)?.name ?? character} (${r.durationSec}s)`,
  };
}

async function makeVideo(db: Database, brand: Brand, piece: ContentPiece) {
  const series = await makeSeriesVideo(db, brand, piece);
  if (series) return series;
  const tuning = videoTuning(analysisMetrics(db.metrics, brand.id));
  const scenes = scriptFromPiece(brand, piece, tuning.maxPoints);
  if (scenes.length < 3) throw new Error("The post needs a hook and some text before a video can be made from it.");
  const tracks = (await readLibrary(musicDir(dataFile()))).filter((t) => existsSync(t.file));
  const history = db.settings.videoLooks as Look[];
  const picked = pickLook(history, "auto", scenes, tracks.map((t) => t.file), brandAssets(brand, dataFile()).screens.length > 0);
  const look = { ...picked, music: pickMusic(tracks, picked.style, `${piece.topic} ${piece.hook}`, history) };
  const character = pickCharacter(history.map((l) => l.character), piece.character);
  const r = await exclusiveRender(() => renderBuddy(brand, scenes, look, { outDir: videosDir(dataFile()), dataFile: dataFile(), character }));
  const credit = tracks.find((t) => t.file === look.music)?.credit ?? "";
  return {
    patch: (p: ContentPiece) => ({ mediaUrls: [r.file], character, ...withCredit(p, credit) }),
    extra: (d: Database) => {
      d.settings.videoLooks = [...d.settings.videoLooks, { ...look, character, at: nowIso(), file: r.file }].slice(-50);
    },
    what: `${characterById(character)?.name ?? "Earth Buddy"} video (${r.durationSec}s)`,
  };
}

async function makeSlides(brand: Brand, piece: ContentPiece) {
  const slides = slidesFromPiece(piece);
  if (slides.length < 2) throw new Error("The post text is too short to make slides from.");
  const cta = piece.cta || brand.defaultCtas[0] || "Follow for more";
  const r = await exclusiveRender(() => renderCarousel(brand, piece.hook, slides, { outDir: videosDir(dataFile()), size: "4:5", cta, design: designFor(piece.plannedDate) }));
  const max = piece.platform === "linkedin" ? 20 : 10;
  return {
    patch: () => ({ mediaUrls: r.slides.slice(0, max) }),
    extra: () => undefined,
    slidesText: slidesToText(slides),
    pdf: r.pdf,
    what: `${Math.min(r.slides.length, max)} carousel slides`,
  };
}

/** Sends drafts planned in the next few days to review once they have the media they need. */
export async function submitReadyDrafts(today = todayIst()): Promise<number> {
  return mutate((d) => {
    let n = 0;
    d.content = d.content.map((p) => {
      if (p.status !== "draft" || !inWindow(p, today) || needsMedia(p) || waitingForWriter(d, p)) return p;
      const brand = d.brands.find((b) => b.id === p.brandId);
      if (!brand) return p;
      try {
        n++;
        return transition(p, { to: "needs-review", actor: "media-maker", note: "Media ready; sent for review automatically." }, brand.approvalPolicy, brand);
      } catch {
        n--;
        return p;
      }
    });
    return n;
  });
}

/** Makes media for the next post in the queue (at most one per call). */
export async function runMediaMaker(): Promise<{ written: string | null; made: string | null; submitted: number }> {
  const st = state();
  if (st.running || isRendering()) return { written: null, made: null, submitted: 0 };
  st.running = true;
  try {
    let written: string | null = null;
    try {
      written = await writeNext(await readDb());
    } catch (err) {
      log.warn("Post Writer failed", { error: (err as Error).message });
    }
    const db = await readDb();
    const piece = mediaQueue(db)[0];
    let made: string | null = null;
    if (piece) {
      const brand = db.brands.find((b) => b.id === piece.brandId);
      if (brand) {
        try {
          const job = VIDEO_FORMATS.includes(piece.format) ? await makeVideo(db, brand, piece) : await makeSlides(brand, piece);
          const saved = await mutate((d) => {
            const i = d.content.findIndex((c) => c.id === piece.id);
            const cur = d.content[i];
            // Someone changed it meanwhile (added media, approved it, deleted it): leave it alone.
            if (!cur || !OPEN.includes(cur.status) || cur.mediaUrls.length) return false;
            let next = applyEdit(cur, job.patch(cur), "media-maker");
            if ("slidesText" in job) next = { ...next, slides: job.slidesText, extraMedia: [{ label: "PDF for LinkedIn document carousel", file: job.pdf }] };
            d.content[i] = next;
            job.extra(d);
            return true;
          });
          if (saved) {
            made = `${job.what} for ${piece.platform} "${piece.topic}" (${piece.plannedDate})`;
            log.info("Made media", { id: piece.id, what: job.what });
          }
        } catch (err) {
          st.failed.set(piece.id, Date.now());
          log.warn("Could not make media", { id: piece.id, error: (err as Error).message });
        }
      }
    }
    const submitted = await submitReadyDrafts();
    if (submitted) log.info("Sent drafts for review", { count: submitted });
    return { written, made, submitted };
  } finally {
    st.running = false;
  }
}
