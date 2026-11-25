"use server";

import { existsSync } from "node:fs";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { activeBrand, mutate, readDb } from "@/lib/db";
import {
  BrandSchema,
  ContentStatusSchema,
  EXPERIMENT_VARIABLES,
  FormatSchema,
  GenerationModeSchema,
  PLATFORM_FORMATS,
  PlatformSchema,
  type Brand,
  type ContentPiece,
  type Format,
  type GeneratedPlatformContent,
  type Idea,
  type Platform,
} from "@/lib/schemas";
import { generateIdeas, priorityScore } from "@/lib/agents/strategy";
import { applyEdit, generateCalendar, transition } from "@/lib/agents/calendar";
import { classifyComment, draftReply, INBOX_API_DEFAULTS } from "@/lib/agents/community";
import { analysisMetrics, recommendExperiments, parseMetricsCsv, scorePosts } from "@/lib/analytics/engine";
import { metricsFor } from "@/lib/analytics/metrics";
import { repurposeWinners } from "@/lib/agents/engagement";
import { generatePlatformVersion } from "@/lib/agents/content";
import { runPublishingAgent, type RunSummary } from "@/lib/publishing/agent";
import { runMetricsSync } from "@/lib/metrics/sync";
import { runCommunityManager, sendReply } from "@/lib/community/agent";
import { pillarFor, runTrendWatcher } from "@/lib/trends/agent";
import { CLIMATE_DAYS } from "@/lib/trends/days";
import { runCompetitorWatch } from "@/lib/competitors/agent";
import { ASPECT_LABEL, ASPECTS, aspectFor, renderAd, renderCover, type Aspect } from "@/lib/video/ad";
import { buildCaptions, draftTranscript, recogniseWords } from "@/lib/video/subtitles";
import { findMusic, MOODS, musicDir, musicFor, readLibrary, removeTrack, type Mood, type Track } from "@/lib/music/agent";
import { CAROUSEL_DESIGNS, parseSlides, renderCarousel, type CarouselDesign } from "@/lib/carousel/maker";
import { captionFromSlides, renderCarouselVideo, slideDurations } from "@/lib/carousel/video";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegBinary, probeClip, renderVideo, renderWrapped, scenesFromBrief, scenesFromPiece, VIDEO_FORMATS, videosDir, type RenderResult, type Scene } from "@/lib/video/maker";
import { dataFile } from "@/lib/db";
import { accountKey } from "@/lib/publishing/accounts";
import { parseHandles } from "@/lib/team/engagement";
import { generateBrief, generateContent, parseManualBrief, parseManualContent } from "@/lib/services/generation";
import { logger } from "@/lib/logger";
import { exclusiveRender } from "@/lib/video/render-lock";
import { newId, nowIso, splitLines, todayIst } from "@/lib/util";
import { cookies, headers } from "next/headers";
import { authConfig, cleanName, clientIp, codeMatches, loginThrottle, safeNext, SESSION_COOKIE, SESSION_MAX_AGE, signSession } from "@/lib/auth";
import { currentUser } from "@/lib/session";
import { approveAndSchedule, sendBack } from "@/lib/agents/approval";
import { videoTuning } from "@/lib/analytics/advice";
import { BUDDY_STYLE_LABEL, BUDDY_STYLES, brandAssets, pickLook, pickMusic, renderBuddy, scriptFromPiece, type BuddyStyle, type Look } from "@/lib/video/buddy";

const log = logger("actions");

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** Who made a change: the signed-in person, or the name typed in the form when sign-in is off. */
const actorOf = async (fd: FormData) => (await currentUser()) ?? str(fd, "actor");
const num = (fd: FormData, k: string, fallback: number) => {
  const n = Number(fd.get(k));
  return Number.isFinite(n) ? n : fallback;
};
const lines = (fd: FormData, k: string) => splitLines(str(fd, k));

/** Adds ?key=value before any #hash, replacing an earlier ok/err message. */
function withQuery(path: string, key: string, value: string) {
  const [beforeHash, hash] = path.split("#");
  const [base, query = ""] = beforeHash!.split("?");
  const params = new URLSearchParams(query);
  params.delete("ok");
  params.delete("err");
  params.set(key, value);
  return `${base}?${params.toString()}${hash ? `#${hash}` : ""}`;
}

/** Runs a mutation, then redirects back with a success or error message. */
async function act(back: string, fn: () => Promise<string | { message: string; to: string }>): Promise<never> {
  let outcome: { message: string; to: string };
  try {
    const r = await fn();
    outcome = typeof r === "string" ? { message: r, to: back } : r;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Action failed", { back, error: message });
    redirect(withQuery(back, "err", message));
  }
  revalidatePath("/", "layout");
  redirect(withQuery(outcome.to, "ok", outcome.message));
}

function parseTargets(fd: FormData): Array<{ platform: Platform; format: Format }> {
  const out: Array<{ platform: Platform; format: Format }> = [];
  for (const v of fd.getAll("target")) {
    const [p, f] = String(v).split("/");
    const platform = PlatformSchema.parse(p);
    const format = FormatSchema.parse(f);
    if (!PLATFORM_FORMATS[platform].includes(format)) throw new Error(`${format} is not supported on ${platform}.`);
    out.push({ platform, format });
  }
  if (out.length === 0) throw new Error("Pick at least one platform and format.");
  return out;
}

function pieceFrom(brandId: string, idea: Idea, v: GeneratedPlatformContent, generatedBy: ContentPiece["generatedBy"]): ContentPiece {
  const now = nowIso();
  return {
    id: newId("post"),
    brandId,
    ideaId: idea.id,
    platform: v.platform,
    format: v.format,
    pillarId: idea.pillarId,
    topic: idea.title,
    hook: v.hook,
    caption: v.caption,
    description: v.description,
    keywords: v.keywords,
    hashtags: v.hashtags,
    cta: v.cta,
    thumbnailConcept: v.thumbnailConcept,
    mediaUrls: [],
    extraMedia: [],
    subtitles: "",
    slides: "",
    hostedMedia: {},
    plannedDate: null,
    plannedTime: null,
    targetMetric: null,
    status: "draft",
    approvedBy: null,
    approvedAt: null,
    publishedUrl: null,
    failureReason: null,
    publishingStartedAt: null,
    externalId: null,
    generatedBy,
    history: [{ at: now, from: null, to: "draft", by: "content-agent", note: `Generated (${generatedBy})` }],
    createdAt: now,
    updatedAt: now,
    isSample: false,
  };
}

/* ------------------------------------------------------------------ */
/* Strategy and ideas                                                  */
/* ------------------------------------------------------------------ */

export async function generateIdeasAction() {
  await act("/studio", async () => {
    const added = await mutate((db) => {
      const brand = activeBrand(db);
      const ideas = generateIdeas(brand, { content: db.content, inbox: db.inbox, existingIdeas: db.ideas, today: todayIst() });
      db.ideas.push(...ideas);
      return ideas.length;
    });
    return added ? `Added ${added} new ideas to the backlog.` : "No new ideas: the backlog already holds every template idea. Add your own or add trend notes in Settings.";
  });
}

export async function addIdeaAction(fd: FormData) {
  await act("/studio", async () => {
    const title = str(fd, "title");
    if (!title) throw new Error("Give the idea a title.");
    const relevance = num(fd, "relevance", 3);
    const impact = num(fd, "impact", 3);
    const effort = num(fd, "effort", 3);
    await mutate((db) => {
      const brand = activeBrand(db);
      const pillarId = str(fd, "pillarId") || brand.pillars[0]?.id || "general";
      db.ideas.push({ id: newId("idea"), brandId: brand.id, title, pillarId, angle: str(fd, "angle"), audienceQuestion: str(fd, "audienceQuestion"), source: "manual", relevance, impact, effort, priority: priorityScore(relevance, impact, effort), status: "backlog", createdAt: nowIso(), isSample: false });
    });
    return "Idea added.";
  });
}

export async function setIdeaStatusAction(fd: FormData) {
  await act("/studio", async () => {
    const id = str(fd, "id");
    const status = str(fd, "status") as Idea["status"];
    if (!["backlog", "approved", "rejected", "used"].includes(status)) throw new Error("Unknown status.");
    await mutate((db) => {
      const idea = db.ideas.find((i) => i.id === id);
      if (!idea) throw new Error("Idea not found.");
      idea.status = status;
    });
    return `Idea marked ${status}.`;
  });
}

/* ------------------------------------------------------------------ */
/* Content generation                                                  */
/* ------------------------------------------------------------------ */

export async function createContentAction(fd: FormData) {
  const ideaId = str(fd, "ideaId");
  await act("/studio", async () => {
    const targets = parseTargets(fd);
    const db = await readDb();
    const brand = activeBrand(db);
    const idea = db.ideas.find((i) => i.id === ideaId && i.brandId === brand.id);
    if (!idea) throw new Error("Pick an idea first.");
    const mode = db.settings.generationMode;
    if (mode === "manual") {
      return { message: "Copy the prompt into Claude, then paste the answer below.", to: `/studio/manual?ideaId=${idea.id}&targets=${encodeURIComponent(targets.map((t) => `${t.platform}/${t.format}`).join(","))}` };
    }
    const result = await generateContent(brand, idea, targets, mode);
    const ids = await mutate((d) => {
      const pieces = result.versions.map((v) => pieceFrom(brand.id, idea, v, result.generatedBy));
      d.content.push(...pieces);
      const i = d.ideas.find((x) => x.id === idea.id);
      if (i && i.status !== "used") i.status = "used";
      return pieces.map((p) => p.id);
    });
    const note = result.warnings.length ? ` Note: ${result.warnings.join(" ")}` : "";
    return { message: `Created ${ids.length} draft(s).${note}`, to: ids.length === 1 ? `/content/${ids[0]}` : "/studio#drafts" };
  });
}

export async function importManualContentAction(fd: FormData) {
  const ideaId = str(fd, "ideaId");
  const back = `/studio/manual?ideaId=${ideaId}&targets=${encodeURIComponent(str(fd, "targets"))}`;
  await act(back, async () => {
    const versions = parseManualContent(str(fd, "pasted"));
    const n = await mutate((db) => {
      const brand = activeBrand(db);
      const idea = db.ideas.find((i) => i.id === ideaId);
      if (!idea) throw new Error("Idea not found.");
      const bad = versions.find((v) => !PLATFORM_FORMATS[v.platform].includes(v.format));
      if (bad) throw new Error(`${bad.format} is not supported on ${bad.platform}.`);
      db.content.push(...versions.map((v) => pieceFrom(brand.id, idea, v, "manual")));
      idea.status = "used";
      return versions.length;
    });
    return { message: `Imported ${n} draft(s) from Claude.`, to: "/studio#drafts" };
  });
}

/* ------------------------------------------------------------------ */
/* Content editing and workflow                                        */
/* ------------------------------------------------------------------ */

export async function updateContentAction(fd: FormData) {
  const id = str(fd, "id");
  await act(`/content/${id}`, async () => {
    const actor = await actorOf(fd);
    const res = await mutate((db) => {
      const i = db.content.findIndex((c) => c.id === id);
      if (i === -1) throw new Error("Content not found.");
      const before = db.content[i]!;
      const after = applyEdit(
        before,
        {
          hook: str(fd, "hook"),
          caption: String(fd.get("caption") ?? ""),
          description: String(fd.get("description") ?? ""),
          cta: str(fd, "cta"),
          hashtags: str(fd, "hashtags").split(/\s+/).filter(Boolean),
          keywords: str(fd, "keywords").split(",").map((k) => k.trim()).filter(Boolean),
          thumbnailConcept: str(fd, "thumbnailConcept"),
          mediaUrls: lines(fd, "mediaUrls"),
          plannedDate: str(fd, "plannedDate") || null,
          plannedTime: str(fd, "plannedTime") || null,
        },
        actor,
      );
      db.content[i] = after;
      return before.status !== after.status;
    });
    return res ? "Saved. Approved content was edited, so it went back to review." : "Saved.";
  });
}

export async function transitionAction(fd: FormData) {
  const id = str(fd, "id");
  const back = str(fd, "back") || `/content/${id}`;
  await act(back, async () => {
    const to = ContentStatusSchema.parse(str(fd, "to"));
    const actor = await actorOf(fd);
    await mutate((db) => {
      const i = db.content.findIndex((c) => c.id === id);
      if (i === -1) throw new Error("Content not found.");
      const piece = db.content[i]!;
      const brand = db.brands.find((b) => b.id === piece.brandId) ?? activeBrand(db);
      db.content[i] = transition(piece, { to, actor, note: str(fd, "note"), publishedUrl: str(fd, "publishedUrl"), failureReason: str(fd, "failureReason") }, brand.approvalPolicy, brand);
    });
    return `Moved to ${to}.`;
  });
}

export async function deleteContentAction(fd: FormData) {
  await act("/calendar", async () => {
    const id = str(fd, "id");
    await mutate((db) => {
      const p = db.content.find((c) => c.id === id);
      if (!p) throw new Error("Content not found.");
      if (p.status === "published") throw new Error("Published content is kept as a record and cannot be deleted here.");
      db.content = db.content.filter((c) => c.id !== id);
    });
    return "Deleted.";
  });
}

/* ------------------------------------------------------------------ */
/* Publishing Agent                                                    */
/* ------------------------------------------------------------------ */

function runMessage(r: RunSummary): string {
  const head = `Published ${r.published}, failed ${r.failed}, skipped ${r.skipped}.`;
  return r.notes.length ? `${head} ${r.notes.slice(0, 3).join(" ")}` : `${head} Nothing was due.`;
}

export async function setAutoPublishAction(fd: FormData) {
  await act("/publishing", async () => {
    const on = str(fd, "autoPublish") === "on";
    await mutate((db) => void (db.settings.autoPublish = on));
    return on ? "Auto-publish is on. Scheduled posts go out at their planned time while the app is running." : "Auto-publish is off. Nothing will be posted automatically.";
  });
}

export async function runPublishingNowAction() {
  await act("/publishing", async () => runMessage(await runPublishingAgent()));
}

/** Publishes one approved or scheduled post immediately. */
export async function publishNowAction(fd: FormData) {
  const id = str(fd, "id");
  await act(`/content/${id}`, async () => {
    const actor = await actorOf(fd);
    if (!actor) throw new Error("Enter your name: publishing is recorded in the post history.");
    await mutate((db) => {
      const i = db.content.findIndex((c) => c.id === id);
      if (i === -1) throw new Error("Content not found.");
      const p = db.content[i]!;
      if (p.status === "approved") {
        const brand = db.brands.find((b) => b.id === p.brandId) ?? activeBrand(db);
        db.content[i] = transition({ ...p, plannedDate: p.plannedDate ?? todayIst() }, { to: "scheduled", actor, note: "Scheduled to publish now." }, brand.approvalPolicy, brand);
      } else if (p.status !== "scheduled") {
        throw new Error(`Only approved or scheduled posts can be published (this one is ${p.status}).`);
      }
    });
    const r = await runPublishingAgent({ onlyId: id });
    if (r.published) return `Published. ${r.notes.join(" ")}`;
    throw new Error(r.notes.join(" ") || "Nothing was published.");
  });
}

/* ------------------------------------------------------------------ */
/* Video Maker                                                         */
/* ------------------------------------------------------------------ */


function videoOptions(fd: FormData) {
  return { voice: str(fd, "voice") || "none", clips: lines(fd, "clips").map((c) => c.replace(/^"|"$/g, "")) };
}

/**
 * Music for a video: "auto" (Music Agent picks for the mood, searching if needed),
 * "none", a library track id, or "file" (own file path in musicPath).
 */
async function chooseMusic(fd: FormData, videoSec: number): Promise<{ file?: string; track: Track | null; notes: string[] }> {
  const choice = str(fd, "music") || "auto";
  const mood = (str(fd, "mood") in MOODS ? str(fd, "mood") : "uplifting") as Mood;
  const dir = musicDir(dataFile());
  if (choice === "none") return { track: null, notes: [] };
  if (choice === "file") {
    const p = str(fd, "musicPath").replace(/^"|"$/g, "");
    if (!p) throw new Error("Enter the music file path, or choose Auto.");
    if (!existsSync(p)) throw new Error(`Music file not found: ${p}`);
    return { file: p, track: null, notes: ["Using your own music file: make sure you have the rights to use it."] };
  }
  if (choice !== "auto") {
    const t = (await readLibrary(dir)).find((x) => x.id === choice);
    if (!t) throw new Error("That music track is no longer in the library.");
    return { file: t.file, track: t, notes: [] };
  }
  const { track, notes } = await musicFor(dir, mood, videoSec);
  return { file: track?.file, track, notes };
}

interface MadeVideo extends RenderResult {
  /** Credit line to add to the post (CC BY music), or "". */
  credit: string;
  /** Other sizes and cover images (advert style). */
  extras: Array<{ label: string; file: string }>;
  /** The subtitle script used ("" when none). */
  subtitles: string;
}

/** Captions + voice (scenes), the clip as it is in a branded frame, or an animated advert around the clip. */
async function makeVideo(fd: FormData, brand: Brand, format: Format, scenes: () => Scene[], wrapText: { title: string; cta: string }): Promise<MadeVideo> {
  const o = videoOptions(fd);
  const outDir = videosDir(dataFile());
  const style = str(fd, "style") || "captions";
  if (style === "wrap") {
    if (o.clips.length === 0) throw new Error("The Clip as it is style needs a clip: add its file path under Background clips.");
    const r = await exclusiveRender(() => renderWrapped(brand, format, o.clips[0]!, wrapText, { outDir }));
    return { ...r, credit: "", extras: [], subtitles: "" };
  }
  if (style === "ad" && o.clips.length === 0) throw new Error("The Advert style needs a clip: add its file path under Background clips.");
  const music = await chooseMusic(fd, 30);
  const subtitles = String(fd.get("subtitles") ?? "").trim();
  let r: RenderResult;
  const extras: MadeVideo["extras"] = [];
  if (style === "ad") {
    const clip = o.clips[0]!;
    // Subtitles: a checked script, timed to the clip's speech.
    let captions;
    if (subtitles) {
      const ff = ffmpegBinary();
      const heard = await recogniseWords(ff, clip);
      captions = buildCaptions(subtitles, heard, (await probeClip(ff, clip)).seconds);
    }
    const native = aspectFor(format);
    const chosen = fd.getAll("aspect").map(String).filter((a): a is Aspect => (ASPECTS as string[]).includes(a));
    // The post's own size is always made (it's the one published); ticked sizes are extra versions.
    const sizes: Aspect[] = [native, ...new Set(chosen.filter((a) => a !== native))];
    const content = { headline: wrapText.title, cta: wrapText.cta, footnote: str(fd, "footnote"), beats: lines(fd, "beats"), muteClip: fd.get("muteClip") === "on", appScreens: lines(fd, "screens"), captions };
    r = await exclusiveRender(async () => {
      let main: RenderResult | null = null;
      for (const aspect of sizes) {
        const one = await renderAd(brand, format, clip, content, { outDir, musicFile: music.file, aspect });
        if (aspect === native) main = one;
        else extras.push({ label: ASPECT_LABEL[aspect], file: one.file });
        if (fd.get("covers") === "on") extras.push({ label: `Cover ${aspect}`, file: await renderCover(brand, aspect, clip, wrapText.title, { outDir }) });
      }
      return main!;
    });
    if (sizes.length > 1) r.notes.push(`Also made: ${sizes.filter((a) => a !== native).map((a) => ASPECT_LABEL[a]).join(", ")}.`);
    if (captions) r.notes.push(`${captions.length} subtitles added.`);
  } else {
    r = await exclusiveRender(() => renderVideo(brand, format, scenes(), { ...o, outDir, musicFile: music.file }));
  }
  if (o.clips.length > 1 && style === "ad") r.notes.push("Only the first clip was used.");
  r.notes = r.notes.filter((n) => !(music.file && /music/i.test(n) && /No background music|no music/i.test(n)));
  if (music.track) r.notes.push(`Music: "${music.track.title}" by ${music.track.creator || "unknown"} (${music.track.license.toUpperCase()}).`);
  r.notes.push(...music.notes);
  return { ...r, credit: music.track?.credit ?? "", extras, subtitles };
}

/** Makes carousel slides for a post and attaches them as its images (plus a PDF for LinkedIn). */
export async function makeCarouselAction(fd: FormData) {
  const id = str(fd, "id");
  await act(`/content/${id}#carousel`, async () => {
    const db = await readDb();
    const piece = db.content.find((c) => c.id === id);
    if (!piece) throw new Error("Content not found.");
    if (piece.status === "published") throw new Error("This post is already published.");
    const brand = db.brands.find((b) => b.id === piece.brandId) ?? activeBrand(db);
    const text = String(fd.get("slides") ?? "").trim();
    const slides = parseSlides(text);
    const hook = str(fd, "hook") || piece.hook;
    const cta = str(fd, "cta") || piece.cta || brand.defaultCtas[0] || "Follow for more";
    const size = str(fd, "size") === "1:1" ? "1:1" : "4:5";
    const outDir = videosDir(dataFile());
    const design = (CAROUSEL_DESIGNS as readonly string[]).includes(str(fd, "design")) ? (str(fd, "design") as CarouselDesign) : "classic";
    const common = { images: lines(fd, "images"), cta, footnote: str(fd, "footnote"), design };
    const withVideo = fd.get("video") === "on";
    const music = withVideo ? await chooseMusic(fd, 30) : { file: undefined, track: null, notes: [] as string[] };
    const made = await exclusiveRender(async () => {
      const post = await renderCarousel(brand, hook, slides, { outDir, size, ...common });
      if (!withVideo) return { post, video: null };
      // Video version: the same slides at 9:16, rendered to a temporary folder, then animated.
      const tmp = await mkdtemp(path.join(tmpdir(), "sga-carvid-slides-"));
      try {
        const tall = await renderCarousel(brand, hook, slides, { outDir: tmp, size: "9:16", ...common });
        const video = await renderCarouselVideo(tall.slides, slideDurations(slides), { outDir, musicFile: music.file });
        return { post, video };
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    });
    const caption = fd.get("caption") === "on" ? captionFromSlides(brand, piece.platform, hook, slides, cta) : null;
    const extras = [{ label: "PDF for LinkedIn document carousel", file: made.post.pdf }];
    if (made.video) extras.unshift({ label: `Video version 9:16 (Reel/Short, ${made.video.durationSec}s)`, file: made.video.file });
    const who = await actorOf(fd);
    const sentBack = await mutate((d) => {
      const i = d.content.findIndex((c) => c.id === id);
      if (i === -1) throw new Error("Content not found.");
      const before = d.content[i]!;
      const patch = { mediaUrls: made.post.slides, ...(caption ? { caption } : {}), ...(music.track ? withCredit({ ...before, caption: caption ?? before.caption }, music.track.credit) : {}) };
      d.content[i] = { ...applyEdit(before, patch, who || "carousel-maker"), extraMedia: extras, slides: text };
      return before.status !== d.content[i]!.status;
    });
    const parts = [`Made ${made.post.slides.length} slides`];
    if (made.video) parts.push(`a ${made.video.durationSec}s video version${music.track ? ` with "${music.track.title}"` : ""}`);
    if (caption) parts.push("the post text");
    const platformNote = piece.platform === "instagram" || piece.platform === "facebook" ? " Instagram and Facebook download images from a public link, so post these slides by hand until image hosting is set up." : "";
    return `${parts.join(", ")}${sentBack ? "; the post was approved, so it went back to review" : ""}.${platformNote}${[...made.post.notes, ...music.notes].length ? ` ${[...made.post.notes, ...music.notes].join(" ")}` : ""}`;
  });
}

/** Drafts subtitles from the clip's speech (Windows speech recognition) for a person to correct. */
export async function suggestSubtitlesAction(fd: FormData) {
  const id = str(fd, "id");
  await act(`/content/${id}#video`, async () => {
    const clip = str(fd, "clip").replace(/^"|"$/g, "");
    if (!clip || !existsSync(clip)) throw new Error("Enter the path of the clip that speaks.");
    const heard = await recogniseWords(ffmpegBinary(), clip);
    if (!heard.length) throw new Error("No speech was recognised (speech recognition needs Windows with English speech installed). Type the subtitles yourself.");
    await mutate((d) => {
      const p = d.content.find((c) => c.id === id);
      if (!p) throw new Error("Content not found.");
      p.subtitles = draftTranscript(heard);
    });
    return "Draft subtitles added below. Speech recognition gets many words wrong: correct them before making the video.";
  });
}

/** Adds a music credit line to the post text once (YouTube: description; others: caption). */
function withCredit(p: ContentPiece, credit: string): Partial<ContentPiece> {
  if (!credit) return {};
  if (p.platform === "youtube") return p.description.includes(credit) ? {} : { description: `${p.description.trim()}\n\n${credit}`.trim() };
  return p.caption.includes(credit) ? {} : { caption: `${p.caption.trim()}\n\n${credit}`.trim() };
}

export async function findMusicAction(fd: FormData) {
  await act("/music", async () => {
    const mood = (str(fd, "mood") in MOODS ? str(fd, "mood") : "uplifting") as Mood;
    const r = await findMusic(musicDir(dataFile()), mood, 4);
    const extra = [...r.rejected.slice(0, 2), ...r.errors.slice(0, 2)];
    return `Added ${r.added.length} ${MOODS[mood].label.toLowerCase()} track(s).${extra.length ? ` Skipped: ${extra.join("; ")}` : ""}`;
  });
}

export async function removeMusicAction(fd: FormData) {
  await act("/music", async () => {
    const t = await removeTrack(musicDir(dataFile()), str(fd, "id"));
    if (!t) throw new Error("Track not found.");
    return `Removed "${t.title}".`;
  });
}

/** Makes a video from a Video Director brief and attaches it to the brief's post (creating a draft post if needed). */
export async function makeVideoFromBriefAction(fd: FormData) {
  const id = str(fd, "id");
  await act(`/video/${id}`, async () => {
    const db = await readDb();
    const brief = db.briefs.find((b) => b.id === id);
    if (!brief) throw new Error("Brief not found.");
    const brand = db.brands.find((b) => b.id === brief.brandId) ?? activeBrand(db);
    const r = await makeVideo(fd, brand, brief.format, () => scenesFromBrief(brand, brief), { title: brief.platform === "youtube" ? (brief.titleOptions[0] ?? brief.title) : (brief.hooks[0] ?? brief.title), cta: brief.cta });
    const pieceId = await mutate((d) => {
      const b = d.briefs.find((x) => x.id === id);
      if (!b) throw new Error("Brief not found.");
      b.videoFile = r.file;
      const existing = b.contentId ? d.content.findIndex((c) => c.id === b.contentId && c.status !== "published") : -1;
      if (existing >= 0) {
        d.content[existing] = { ...applyEdit(d.content[existing]!, { mediaUrls: [r.file], ...withCredit(d.content[existing]!, r.credit) }, "video-maker"), extraMedia: r.extras, subtitles: r.subtitles };
        return d.content[existing]!.id;
      }
      const idea = d.ideas.find((i) => i.id === b.ideaId) ?? { id: null, title: b.title, angle: b.objective, pillarId: brand.pillars[0]?.id ?? "general", audienceQuestion: "" };
      const v = generatePlatformVersion(brand, idea, b.platform, b.format);
      const now = nowIso();
      const piece: ContentPiece = {
        ...pieceFrom(brand.id, { ...(idea as Idea), id: idea.id ?? newId("idea") }, { ...v, hook: b.platform === "youtube" ? (b.titleOptions[0] ?? v.hook) : (b.hooks[0] ?? v.hook), cta: b.cta || v.cta, thumbnailConcept: b.thumbnailConcept || v.thumbnailConcept }, b.generatedBy),
        ideaId: b.ideaId,
        mediaUrls: [r.file],
      };
      Object.assign(piece, withCredit(piece, r.credit), { extraMedia: r.extras, subtitles: r.subtitles });
      piece.history = [{ at: now, from: null, to: "draft", by: "video-maker", note: `Created with a video made from brief "${b.title}".` }];
      d.content.push(piece);
      b.contentId = piece.id;
      return piece.id;
    });
    const notes = r.notes.length ? ` ${r.notes.join(" ")}` : "";
    return { message: `Video made (${r.durationSec}s, ${r.scenes} scenes) and attached to its post (${pieceId}).${notes}`, to: `/video/${id}#video` };
  });
}

/** Makes a video from a post's own text and attaches it to that post. */
export async function makeVideoFromPostAction(fd: FormData) {
  const id = str(fd, "id");
  await act(`/content/${id}`, async () => {
    const db = await readDb();
    const piece = db.content.find((c) => c.id === id);
    if (!piece) throw new Error("Content not found.");
    if (piece.status === "published") throw new Error("This post is already published.");
    if (!VIDEO_FORMATS.includes(piece.format)) throw new Error(`${piece.format} is not a video format.`);
    const brand = db.brands.find((b) => b.id === piece.brandId) ?? activeBrand(db);
    const r = await makeVideo(fd, brand, piece.format, () => scenesFromPiece(brand, piece), { title: piece.hook, cta: piece.cta });
    const who = await actorOf(fd);
    const sentBack = await mutate((d) => {
      const i = d.content.findIndex((c) => c.id === id);
      if (i === -1) throw new Error("Content not found.");
      const before = d.content[i]!;
      d.content[i] = { ...applyEdit(before, { mediaUrls: [r.file], ...withCredit(before, r.credit) }, who || "video-maker"), extraMedia: r.extras, subtitles: r.subtitles || before.subtitles };
      return before.status !== d.content[i]!.status;
    });
    return `Video made (${r.durationSec}s) and attached.${sentBack ? " The post was approved, so it went back to review." : ""}${r.notes.length ? ` ${r.notes.join(" ")}` : ""}`;
  });
}

/** Saves an edited script: one line per scene, "voiceover | on-screen text". */
export async function updateBriefScriptAction(fd: FormData) {
  const id = str(fd, "id");
  await act(`/video/${id}#script`, async () => {
    const rows = lines(fd, "script");
    if (rows.length === 0) throw new Error("The script is empty.");
    await mutate((d) => {
      const b = d.briefs.find((x) => x.id === id);
      if (!b) throw new Error("Brief not found.");
      const per = Math.max(2, Math.round(b.durationSec / rows.length));
      b.script = rows.map((row, i) => {
        const [voiceover, onScreen] = row.split("|").map((s) => s.trim());
        const old = b.script[i];
        const start = old?.start ?? i * per;
        const end = old?.end ?? start + per;
        return { start, end: Math.max(end, start + 1), voiceover: voiceover ?? "", onScreenText: onScreen ?? "" };
      });
      if (str(fd, "cta")) b.cta = str(fd, "cta");
    });
    return "Script saved.";
  });
}

/* ------------------------------------------------------------------ */
/* Growth Booster                                                      */
/* ------------------------------------------------------------------ */

export async function applyHookAction(fd: FormData) {
  const id = str(fd, "id");
  const back = str(fd, "back") || `/content/${id}`;
  await act(back, async () => {
    const hook = str(fd, "hook");
    if (!hook) throw new Error("The hook is empty.");
    const who = await actorOf(fd);
    const sentBack = await mutate((db) => {
      const i = db.content.findIndex((c) => c.id === id);
      if (i === -1) throw new Error("Content not found.");
      const before = db.content[i]!;
      // Swap the first line of the caption too, when it repeats the old hook.
      const captionLines = before.caption.split("\n");
      const caption = captionLines[0]?.trim() === before.hook.trim() ? [hook, ...captionLines.slice(1)].join("\n") : before.caption;
      db.content[i] = applyEdit(before, { hook, caption }, who || "growth-booster");
      return before.status !== db.content[i]!.status;
    });
    return sentBack ? "Hook updated. The post was approved, so it went back to review." : "Hook updated.";
  });
}

export async function repurposeAction(fd: FormData) {
  await act("/growth", async () => {
    const metricId = str(fd, "metricId");
    const n = await mutate((db) => {
      const brand = activeBrand(db);
      const scored = scorePosts(analysisMetrics(db.metrics, brand.id));
      const s = repurposeWinners(brand, db.content.filter((c) => c.brandId === brand.id), scored, 50).find((r) => r.metricId === metricId);
      if (!s) throw new Error("That suggestion is no longer available.");
      const idea: Idea = { id: newId("idea"), brandId: brand.id, title: s.topic, pillarId: s.pillarId || brand.pillars[0]?.id || "general", angle: `Repurposed from a ${s.from.platform} ${s.from.format} that beat its history`, audienceQuestion: "", source: "manual", relevance: 4, impact: 4, effort: 2, priority: priorityScore(4, 4, 2), status: "used", createdAt: nowIso(), isSample: false };
      db.ideas.push(idea);
      const pieces = s.targets.map((t) => pieceFrom(brand.id, idea, generatePlatformVersion(brand, idea, t.platform, t.format), "template"));
      for (const p of pieces) p.history[0]!.by = "growth-booster";
      db.content.push(...pieces);
      return pieces.length;
    });
    return { message: `Created ${n} draft(s) from a winning post. Review and edit them before approval.`, to: "/studio#drafts" };
  });
}

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

export async function generateCalendarAction(fd: FormData) {
  await act("/calendar", async () => {
    const start = str(fd, "startDate") || todayIst();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("Start date must be YYYY-MM-DD.");
    const replace = fd.get("replaceDrafts") === "on";
    const n = await mutate((db) => {
      const brand = activeBrand(db);
      if (replace) db.content = db.content.filter((c) => !(c.brandId === brand.id && c.status === "draft" && c.plannedDate && c.plannedDate >= start));
      const items = generateCalendar(brand, db.ideas, db.metrics, { startDate: start, days: 30, existing: db.content });
      db.content.push(...items);
      return items.length;
    });
    return `Planned ${n} posts for 30 days from ${start} (one a day on every platform; days that already had a post were kept). All are drafts until reviewed.`;
  });
}

export async function bulkSubmitAction(fd: FormData) {
  await act("/calendar", async () => {
    const actor = await actorOf(fd);
    if (!actor) throw new Error("Enter your name to submit drafts for review.");
    const n = await mutate((db) => {
      const brand = activeBrand(db);
      let count = 0;
      db.content = db.content.map((c) => {
        if (c.brandId !== brand.id || c.status !== "draft" || !c.plannedDate) return c;
        count++;
        return transition(c, { to: "needs-review", actor }, brand.approvalPolicy, brand);
      });
      return count;
    });
    return `Submitted ${n} drafts for review.`;
  });
}

/* ------------------------------------------------------------------ */
/* Video briefs                                                        */
/* ------------------------------------------------------------------ */

export async function createBriefAction(fd: FormData) {
  await act("/video", async () => {
    const [p, f] = str(fd, "target").split("/");
    const platform = PlatformSchema.parse(p);
    const format = FormatSchema.parse(f);
    const duration = Math.round(num(fd, "durationSec", format === "long-video" ? 300 : 30));
    if (duration < 5 || duration > 1800) throw new Error("Duration must be between 5 and 1800 seconds.");
    const db = await readDb();
    const brand = activeBrand(db);
    const idea = db.ideas.find((i) => i.id === str(fd, "ideaId"));
    if (!idea) throw new Error("Pick an idea.");
    const mode = db.settings.generationMode;
    if (mode === "manual") return { message: "Copy the prompt into Claude, then paste the answer below.", to: `/video/manual?ideaId=${idea.id}&target=${platform}/${format}&d=${duration}` };
    const r = await generateBrief(brand, idea, platform, format, duration, mode);
    if (!r.brief) throw new Error("No brief was produced.");
    await mutate((d) => void d.briefs.push(r.brief!));
    return { message: `Brief created.${r.warnings.length ? ` Note: ${r.warnings.join(" ")}` : ""}`, to: `/video/${r.brief.id}` };
  });
}

export async function importManualBriefAction(fd: FormData) {
  const ideaId = str(fd, "ideaId");
  const target = str(fd, "target");
  await act(`/video/manual?ideaId=${ideaId}&target=${target}&d=${str(fd, "d")}`, async () => {
    const [p, f] = target.split("/");
    const id = await mutate((db) => {
      const brand = activeBrand(db);
      const idea = db.ideas.find((i) => i.id === ideaId);
      if (!idea) throw new Error("Idea not found.");
      const brief = parseManualBrief(brand, idea, PlatformSchema.parse(p), FormatSchema.parse(f), str(fd, "pasted"));
      db.briefs.push(brief);
      return brief.id;
    });
    return { message: "Brief imported from Claude.", to: `/video/${id}` };
  });
}

export async function deleteBriefAction(fd: FormData) {
  await act("/video", async () => {
    const id = str(fd, "id");
    await mutate((db) => void (db.briefs = db.briefs.filter((b) => b.id !== id)));
    return "Brief deleted.";
  });
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

export async function addMetricAction(fd: FormData) {
  const platform = PlatformSchema.parse(str(fd, "platform"));
  const format = FormatSchema.parse(str(fd, "format"));
  await act(`/analytics?platform=${platform}&format=${format}`, async () => {
    const defs = metricsFor(platform, format);
    if (!defs) throw new Error(`${format} is not tracked for ${platform}.`);
    const metrics: Record<string, number> = {};
    for (const m of defs.metrics) {
      const raw = str(fd, `m_${m.key}`);
      if (raw === "") continue;
      const v = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(v) || v < 0) throw new Error(`${m.label} must be a number of 0 or more.`);
      metrics[m.key] = v;
    }
    if (Object.keys(metrics).length === 0) throw new Error("Enter at least one metric.");
    const postedAt = new Date(str(fd, "postedAt"));
    if (Number.isNaN(postedAt.getTime())) throw new Error("Enter when the post went live.");
    await mutate((db) => {
      const brand = activeBrand(db);
      db.metrics.push({ id: newId("metric"), brandId: brand.id, contentId: str(fd, "contentId") || null, platform, format, postedAt: postedAt.toISOString(), hook: str(fd, "hook"), pillarId: str(fd, "pillarId"), cta: str(fd, "cta"), url: str(fd, "url"), metrics, source: "manual", isSample: false, syncedAt: null });
    });
    return "Metrics saved.";
  });
}

export async function syncMetricsAction() {
  await act("/analytics", async () => {
    const r = await runMetricsSync();
    const head = `Updated ${r.updated} post(s), ${r.failed} failed, ${r.skipped} skipped.`;
    return r.notes.length ? `${head} ${r.notes.slice(0, 3).join(" ")}` : r.updated ? head : `${head} Nothing to update: metrics are read for posts published in the last 90 days on connected platforms.`;
  });
}

export async function importCsvAction(fd: FormData) {
  await act("/analytics", async () => {
    const r = parseMetricsCsv(String(fd.get("csv") ?? ""));
    if (r.rows.length === 0) throw new Error(r.errors.join(" ") || "Nothing to import.");
    await mutate((db) => {
      const brand = activeBrand(db);
      db.metrics.push(...r.rows.map((row) => ({ ...row, id: newId("metric"), brandId: brand.id, isSample: false })));
    });
    const notes = [...r.errors, ...r.warnings];
    return `Imported ${r.rows.length} row(s).${notes.length ? ` Skipped or adjusted: ${notes.slice(0, 5).join(" ")}` : ""}`;
  });
}

export async function deleteMetricAction(fd: FormData) {
  await act("/analytics", async () => {
    const id = str(fd, "id");
    await mutate((db) => void (db.metrics = db.metrics.filter((m) => m.id !== id)));
    return "Row deleted.";
  });
}

/* ------------------------------------------------------------------ */
/* Experiments                                                         */
/* ------------------------------------------------------------------ */

export async function addRecommendedExperimentsAction() {
  await act("/experiments", async () => {
    const n = await mutate((db) => {
      const brand = activeBrand(db);
      const recs = recommendExperiments(brand.id, scorePosts(analysisMetrics(db.metrics, brand.id)));
      const existing = new Set(db.experiments.filter((e) => e.brandId === brand.id && e.status !== "concluded" && e.status !== "abandoned").map((e) => e.hypothesis));
      const fresh = recs.filter((r) => !existing.has(r.hypothesis));
      db.experiments.push(...fresh);
      for (const e of fresh) db.learning.push({ id: newId("learn"), brandId: brand.id, at: nowIso(), kind: "hypothesis", text: e.hypothesis, experimentId: e.id });
      return fresh.length;
    });
    return n ? `Added ${n} proposed experiment(s).` : "No new experiments to add; current ones already cover the recommendations.";
  });
}

export async function addExperimentAction(fd: FormData) {
  await act("/experiments", async () => {
    const hypothesis = str(fd, "hypothesis");
    if (!hypothesis) throw new Error("Write a hypothesis.");
    const [p, f] = str(fd, "target").split("/");
    const variable = str(fd, "variable") as (typeof EXPERIMENT_VARIABLES)[number];
    if (!EXPERIMENT_VARIABLES.includes(variable)) throw new Error("Pick what you are changing.");
    await mutate((db) => {
      const brand = activeBrand(db);
      const id = newId("exp");
      db.experiments.push({ id, brandId: brand.id, hypothesis, platform: PlatformSchema.parse(p), format: FormatSchema.parse(f), variable, change: str(fd, "change"), primaryMetric: str(fd, "primaryMetric") || "Primary engagement metric", baseline: str(fd, "baseline"), impact: num(fd, "impact", 3), effort: num(fd, "effort", 3), status: "proposed", startDate: null, endDate: null, result: "", learning: "", createdAt: nowIso(), isSample: false });
      db.learning.push({ id: newId("learn"), brandId: brand.id, at: nowIso(), kind: "hypothesis", text: hypothesis, experimentId: id });
    });
    return "Experiment added.";
  });
}

export async function updateExperimentAction(fd: FormData) {
  await act("/experiments", async () => {
    const id = str(fd, "id");
    const status = str(fd, "status");
    if (!["proposed", "running", "concluded", "abandoned"].includes(status)) throw new Error("Unknown status.");
    await mutate((db) => {
      const e = db.experiments.find((x) => x.id === id);
      if (!e) throw new Error("Experiment not found.");
      if (status === "concluded" && !str(fd, "result")) throw new Error("Record the result before concluding.");
      e.status = status as typeof e.status;
      if (status === "running" && !e.startDate) e.startDate = todayIst();
      if (status === "concluded" || status === "abandoned") e.endDate = todayIst();
      if (str(fd, "result")) e.result = str(fd, "result");
      if (str(fd, "learning")) e.learning = str(fd, "learning");
      if (status === "concluded") db.learning.push({ id: newId("learn"), brandId: e.brandId, at: nowIso(), kind: "result", text: `${e.result}${e.learning ? ` — Learning: ${e.learning}` : ""}`, experimentId: e.id });
    });
    return `Experiment ${status}.`;
  });
}

export async function addObservationAction(fd: FormData) {
  await act("/experiments", async () => {
    const text = str(fd, "text");
    if (!text) throw new Error("Write the observation.");
    await mutate((db) => void db.learning.push({ id: newId("learn"), brandId: activeBrand(db).id, at: nowIso(), kind: "observation", text, experimentId: null }));
    return "Added to the learning log.";
  });
}

/* ------------------------------------------------------------------ */
/* Community inbox                                                     */
/* ------------------------------------------------------------------ */

export async function addCommentsAction(fd: FormData) {
  await act("/inbox", async () => {
    const platform = PlatformSchema.parse(str(fd, "platform"));
    const raw = lines(fd, "comments");
    if (raw.length === 0) throw new Error("Paste at least one comment.");
    const n = await mutate((db) => {
      const brand = activeBrand(db);
      for (const line of raw) {
        const m = line.match(/^(@?[\w.\- ]{1,40}):\s+(.+)$/);
        const author = m ? m[1]!.trim() : "unknown";
        const text = m ? m[2]!.trim() : line;
        const classification = classifyComment(text);
        db.inbox.push({ id: newId("cmt"), brandId: brand.id, platform, author, text, postRef: str(fd, "postRef"), receivedAt: nowIso(), classification, suggestedReply: draftReply(brand, { author, text, classification }), replyStatus: "drafted", approvedBy: null, ...INBOX_API_DEFAULTS, isSample: false });
      }
      return raw.length;
    });
    return `Classified ${n} comment(s). Nothing is posted until you approve and post it yourself.`;
  });
}

export async function updateReplyAction(fd: FormData) {
  await act("/inbox", async () => {
    const id = str(fd, "id");
    const intent = str(fd, "do");
    const actor = await actorOf(fd);
    await mutate((db) => {
      const item = db.inbox.find((i) => i.id === id);
      if (!item) throw new Error("Comment not found.");
      const brand = db.brands.find((b) => b.id === item.brandId) ?? activeBrand(db);
      if (item.replyStatus === "drafted") item.suggestedReply = String(fd.get("reply") ?? item.suggestedReply);
      if (intent === "send" && item.replyStatus === "approved") return;
      if (intent === "approve" || intent === "send") {
        if (!actor) throw new Error("Enter your name to approve a reply.");
        if (!item.suggestedReply.trim()) throw new Error("The reply is empty.");
        if (/\[[^\]]{3,}\]/.test(item.suggestedReply)) throw new Error("Fill in the [bracketed] part before approving.");
        const approvers = brand.approvalPolicy.replyApprovers;
        if (approvers.length && !approvers.some((a) => a.toLowerCase() === actor.toLowerCase())) throw new Error(`${actor} cannot approve replies. Approvers: ${approvers.join(", ")}.`);
        item.replyStatus = "approved";
        item.approvedBy = actor;
      } else if (intent === "posted") {
        if (item.replyStatus !== "approved") throw new Error("Approve the reply before marking it posted.");
        item.replyStatus = "posted-manually";
      } else if (intent === "ignore") {
        item.replyStatus = "ignored";
      } else if (intent === "reopen") {
        if (item.replyStatus === "posted") throw new Error("This reply was already sent on the platform. Edit or delete it there.");
        item.replyStatus = "drafted";
        item.replyError = null;
        item.approvedBy = null;
      }
    });
    if (intent === "send") {
      const r = await sendReply(id);
      if (!r.ok) throw new Error(r.message);
      return r.message;
    }
    return intent === "approve" ? "Reply approved. Send it, or post it on the platform and mark it posted." : "Updated.";
  });
}

export async function runCommunityAction() {
  await act("/inbox", async () => {
    const r = await runCommunityManager();
    return `Community Manager: ${r.added} new comment(s), ${r.sent} auto-repl${r.sent === 1 ? "y" : "ies"} sent, ${r.failed} problem(s).${r.notes.length ? ` ${r.notes.slice(0, 3).join(" ")}` : ""}`;
  });
}

export async function setAutoReplyAction(fd: FormData) {
  await act("/inbox", async () => {
    const mode = str(fd, "autoReply") === "safe" ? "safe" : "off";
    await mutate((db) => {
      db.settings.autoReply = mode;
    });
    return mode === "safe" ? "Auto-reply is on for praise and quiz answers. Everything else still waits for you." : "Auto-reply is off. Every reply waits for approval.";
  });
}

/** Team engagement page: names and social handles (rows name_0/handles_0 ...; a blank name removes the row). */
export async function saveTeamMembersAction(fd: FormData) {
  await act("/team", async () => {
    const members: Array<{ name: string; handles: string[] }> = [];
    for (let i = 0; i < 50; i++) {
      if (!fd.has(`name_${i}`)) break;
      const name = str(fd, `name_${i}`).replace(/\s+/g, " ").slice(0, 60);
      if (!name) continue;
      members.push({ name, handles: parseHandles(str(fd, `handles_${i}`)).slice(0, 10) });
    }
    await mutate((db) => {
      db.settings.teamMembers = members;
    });
    return `Saved ${members.length} team member${members.length === 1 ? "" : "s"}.`;
  });
}

/** A team member logs likes, shares or reposts (platforms don't report who did these on Instagram, YouTube or LinkedIn). */
export async function logTeamEngagementAction(fd: FormData) {
  const days = str(fd, "days") || "30";
  await act(`/team?days=${encodeURIComponent(days)}`, async () => {
    const name = str(fd, "member");
    const kinds = fd.getAll("kind").map(String).filter((k): k is "like" | "share" | "repost" => k === "like" || k === "share" || k === "repost");
    const postIds = fd.getAll("post").map(String);
    const undo = str(fd, "undo") === "1";
    if (!name) throw new Error("Pick your name first.");
    if (!kinds.length) throw new Error("Tick at least one of Liked, Shared or Reposted.");
    if (!postIds.length) throw new Error("Tick at least one post.");
    let changed = 0;
    await mutate((db) => {
      if (!db.settings.teamMembers.some((m) => m.name === name)) throw new Error(`${name} isn't in the team list.`);
      const at = new Date().toISOString();
      for (const p of db.content) {
        if (!postIds.includes(p.id)) continue;
        const list = (p.teamActions ??= []);
        for (const kind of kinds) {
          const i = list.findIndex((a) => a.name === name && a.kind === kind);
          if (undo && i >= 0) { list.splice(i, 1); changed++; }
          if (!undo && i < 0) { list.push({ name, kind, at }); changed++; }
        }
      }
    });
    return undo ? `Removed ${changed} entr${changed === 1 ? "y" : "ies"} for ${name}.` : `Logged ${changed} entr${changed === 1 ? "y" : "ies"} for ${name}.`;
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export async function saveBrandAction(fd: FormData) {
  await act("/settings", async () => {
    await mutate((db) => {
      const brand = activeBrand(db);
      const pillars = lines(fd, "pillars").map((l) => {
        const [id, name, description] = l.split("|").map((s) => s.trim());
        if (!id || !name) throw new Error(`Pillar line "${l}" needs at least "id | name".`);
        return { id: id.toLowerCase().replace(/[^a-z0-9-]/g, "-"), name, description: description ?? "" };
      });
      if (pillars.length === 0) throw new Error("Add at least one content pillar.");
      const facts = lines(fd, "facts").map((l, i) => {
        const verified = /^\[x\]/i.test(l);
        const body = l.replace(/^\[(x| )\]\s*/i, "");
        const [text, source] = body.split("|").map((s) => s.trim());
        return { id: `fact_${i + 1}`, text: text ?? "", source: source ?? "", verified };
      }).filter((f) => f.text);
      const platforms = fd.getAll("platforms").map((p) => PlatformSchema.parse(String(p)));
      if (platforms.length === 0) throw new Error("Select at least one platform.");
      const next = BrandSchema.parse({
        ...brand,
        name: str(fd, "name"),
        organisation: str(fd, "organisation"),
        category: str(fd, "category"),
        website: str(fd, "website"),
        audience: lines(fd, "audience"),
        voice: str(fd, "voice").split(",").map((s) => s.trim()).filter(Boolean),
        languages: str(fd, "languages").split(",").map((s) => s.trim()).filter(Boolean),
        pillars,
        facts,
        hashtags: str(fd, "hashtags").split(/\s+/).filter(Boolean),
        defaultCtas: lines(fd, "defaultCtas"),
        avoid: lines(fd, "avoid"),
        platforms,
        accountKey: str(fd, "accountKey").toUpperCase(),
        logoFile: str(fd, "logoFile").replace(/^"|"$/g, ""),
        tagline: str(fd, "tagline"),
        approvalPolicy: {
          requireReview: fd.get("requireReview") === "on",
          approvers: str(fd, "approvers").split(",").map((s) => s.trim()).filter(Boolean),
          replyApprovers: str(fd, "replyApprovers").split(",").map((s) => s.trim()).filter(Boolean),
        },
      });
      if (next.logoFile && !existsSync(next.logoFile)) throw new Error(`Logo file not found: ${next.logoFile}`);
      if (next.accountKey && !/^[A-Z][A-Z0-9_]*$/.test(next.accountKey)) throw new Error("Account key: use capital letters, digits and _ only, starting with a letter (e.g. ZEROWASTE).");
      const clash = db.brands.find((b) => b.id !== brand.id && accountKey(b) === accountKey(next));
      if (clash) throw new Error(`Account key ${accountKey(next)} is already used by ${clash.name}. Each brand needs its own key so its posts can't go to another brand's accounts.`);
      db.brands = db.brands.map((b) => (b.id === brand.id ? next : b));
    });
    return "Brand profile saved.";
  });
}

export async function setModeAction(fd: FormData) {
  await act("/settings", async () => {
    const mode = GenerationModeSchema.parse(str(fd, "mode"));
    await mutate((db) => void (db.settings.generationMode = mode));
    return `Generation mode set to ${mode}.`;
  });
}

export async function addTrendNoteAction(fd: FormData) {
  await act("/settings", async () => {
    const text = str(fd, "text");
    if (!text) throw new Error("Write the trend note.");
    await mutate((db) => {
      const brand = activeBrand(db);
      brand.trendNotes.push({ id: newId("trend"), text, addedAt: nowIso() });
    });
    return "Trend note added. Generate ideas in Content Studio to turn it into an idea.";
  });
}

export async function removeTrendNoteAction(fd: FormData) {
  await act("/settings", async () => {
    const id = str(fd, "id");
    await mutate((db) => {
      const brand = activeBrand(db);
      brand.trendNotes = brand.trendNotes.filter((t) => t.id !== id);
    });
    return "Trend note removed.";
  });
}

export async function addBrandAction(fd: FormData) {
  await act("/settings", async () => {
    const name = str(fd, "name");
    if (!name) throw new Error("Enter a brand name.");
    await mutate((db) => {
      const id = newId("brand");
      const fresh = BrandSchema.parse({ id, name, category: str(fd, "category"), pillars: [{ id: "general", name: "General", description: "" }] });
      if (db.brands.some((b) => accountKey(b) === accountKey(fresh))) throw new Error(`A brand with account key ${accountKey(fresh)} already exists. Use a different name, then set its account key in Settings.`);
      db.brands.push(fresh);
      db.settings.activeBrandId = id;
    });
    return `Created ${name} and switched to it. Fill in its profile below.`;
  });
}

export async function switchBrandAction(fd: FormData) {
  const back = str(fd, "back") || "/";
  await act(back, async () => {
    const id = str(fd, "brandId");
    await mutate((db) => {
      if (!db.brands.some((b) => b.id === id)) throw new Error("Brand not found.");
      db.settings.activeBrandId = id;
    });
    return "Switched brand.";
  });
}

export async function clearSampleDataAction() {
  await act("/settings", async () => {
    const n = await mutate((db) => {
      const before = db.metrics.length + db.inbox.length + db.experiments.length + db.briefs.length + db.content.length;
      db.metrics = db.metrics.filter((m) => !m.isSample);
      db.inbox = db.inbox.filter((m) => !m.isSample);
      db.experiments = db.experiments.filter((m) => !m.isSample);
      db.briefs = db.briefs.filter((m) => !m.isSample);
      db.content = db.content.filter((m) => !m.isSample);
      db.learning = db.learning.filter((l) => !l.id.startsWith("sample_"));
      return before - (db.metrics.length + db.inbox.length + db.experiments.length + db.briefs.length + db.content.length);
    });
    return `Removed ${n} sample record(s).`;
  });
}

/* ------------------------------------------------------------------ */
/* Trend Watcher                                                       */
/* ------------------------------------------------------------------ */

export async function runTrendsAction() {
  await act("/trends", async () => {
    const r = await runTrendWatcher();
    return `Trend Watcher: ${r.added} new item(s).${r.notes.length ? ` ${r.notes.join(" ")}` : ""}`;
  });
}

const TREND_FITS: Record<string, string[]> = { "google-trends": ["myth", "edu"], news: ["myth", "edu"], youtube: ["edu", "habits"], search: ["edu", "habits"] };

export async function trendToIdeaAction(fd: FormData) {
  await act("/trends", async () => {
    const id = str(fd, "id");
    await mutate((db) => {
      const t = db.trends.find((x) => x.id === id);
      if (!t) throw new Error("Trend not found.");
      const brand = db.brands.find((b) => b.id === t.brandId) ?? activeBrand(db);
      const fits = t.source === "climate-day" ? (CLIMATE_DAYS.find((d) => d.name === t.title)?.fits ?? []) : (TREND_FITS[t.source] ?? []);
      const title = t.source === "climate-day" ? `${t.title} (${t.date})` : `Trend: ${t.title}`;
      const relevance = t.score >= 80 ? 5 : t.score >= 60 ? 4 : 3;
      const impact = t.source === "google-trends" || t.source === "climate-day" ? 4 : 3;
      const effort = 2;
      db.ideas.push({ id: newId("idea"), brandId: brand.id, title: title.slice(0, 140), pillarId: pillarFor(brand, fits), angle: [t.angle, t.url ? `Source: ${t.url}` : ""].filter(Boolean).join(" "), audienceQuestion: "", source: "trend-watcher", relevance, impact, effort, priority: priorityScore(relevance, impact, effort), status: "backlog", createdAt: nowIso(), isSample: false });
      t.status = "used";
    });
    return "Added to the idea backlog (Content Studio). Check facts before writing the post.";
  });
}

export async function setTrendStatusAction(fd: FormData) {
  await act("/trends", async () => {
    const id = str(fd, "id");
    const status = str(fd, "status") === "new" ? "new" : "dismissed";
    await mutate((db) => {
      const t = db.trends.find((x) => x.id === id);
      if (!t) throw new Error("Trend not found.");
      t.status = status;
    });
    return status === "new" ? "Restored." : "Dismissed.";
  });
}

/* ------------------------------------------------------------------ */
/* Competitor Watch                                                    */
/* ------------------------------------------------------------------ */

export async function addCompetitorAction(fd: FormData) {
  await act("/competitors", async () => {
    const name = str(fd, "name");
    if (!name) throw new Error("Give the competitor a name.");
    const instagram = str(fd, "instagram").replace(/^@/, "");
    const youtube = str(fd, "youtube");
    const id = newId("comp");
    await mutate((db) => {
      const brand = activeBrand(db);
      if (db.competitors.some((c) => c.brandId === brand.id && c.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already on the list.`);
      db.competitors.push({ id, brandId: brand.id, name, instagram, youtube, website: str(fd, "website"), notes: str(fd, "notes"), profiles: [], lastSyncAt: null, lastSyncNotes: [], createdAt: nowIso() });
    });
    if (!instagram && !youtube) return `Added ${name}. Add their posts by hand below (no Instagram or YouTube handle to read).`;
    const r = await runCompetitorWatch({ onlyId: id });
    return `Added ${name}.${r.updated ? " Read their public posts." : ""}${r.notes.length ? ` ${r.notes.join(" ")}` : ""}`;
  });
}

export async function removeCompetitorAction(fd: FormData) {
  await act("/competitors", async () => {
    const id = str(fd, "id");
    await mutate((db) => {
      db.competitors = db.competitors.filter((c) => c.id !== id);
      db.competitorPosts = db.competitorPosts.filter((p) => p.competitorId !== id);
    });
    return "Removed, with its posts.";
  });
}

export async function syncCompetitorsAction() {
  await act("/competitors", async () => {
    const r = await runCompetitorWatch();
    return `Competitor Watch: updated ${r.updated} account(s).${r.notes.length ? ` ${r.notes.slice(0, 4).join(" ")}` : ""}`;
  });
}

export async function addCompetitorPostAction(fd: FormData) {
  await act("/competitors#add-post", async () => {
    const competitorId = str(fd, "competitorId");
    const platform = PlatformSchema.parse(str(fd, "platform"));
    const format = FormatSchema.parse(str(fd, "format"));
    const date = str(fd, "postedAt");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Pick the date it was posted.");
    const time = /^\d{2}:\d{2}$/.test(str(fd, "time")) ? str(fd, "time") : "12:00";
    const views = str(fd, "views");
    const followers = str(fd, "followers");
    await mutate((db) => {
      const comp = db.competitors.find((c) => c.id === competitorId);
      if (!comp) throw new Error("Pick a competitor.");
      db.competitorPosts.push({ id: newId("cpost"), competitorId, platform, format, postedAt: new Date(`${date}T${time}:00+05:30`).toISOString(), hook: str(fd, "hook"), url: str(fd, "url"), externalId: null, likes: Math.max(0, num(fd, "likes", 0)), comments: Math.max(0, num(fd, "comments", 0)), views: views ? Math.max(0, Number(views) || 0) : null, source: "manual", syncedAt: nowIso() });
      if (followers && Number(followers) >= 0) comp.profiles = [...comp.profiles.filter((p) => p.platform !== platform), { platform, followers: Number(followers), posts: null, at: nowIso() }];
    });
    return "Post added.";
  });
}

export async function deleteCompetitorPostAction(fd: FormData) {
  await act("/competitors", async () => {
    const id = str(fd, "id");
    await mutate((db) => {
      db.competitorPosts = db.competitorPosts.filter((p) => p.id !== id);
    });
    return "Post removed.";
  });
}

export async function competitorIdeaAction(fd: FormData) {
  await act("/competitors", async () => {
    const id = str(fd, "id");
    const lift = str(fd, "lift");
    await mutate((db) => {
      const p = db.competitorPosts.find((x) => x.id === id);
      if (!p) throw new Error("Post not found.");
      const comp = db.competitors.find((c) => c.id === p.competitorId);
      const brand = db.brands.find((b) => b.id === comp?.brandId) ?? activeBrand(db);
      const fits = /\?|quiz|myth|fact/i.test(p.hook) ? ["myth", "community"] : /how|tip|step|way/i.test(p.hook) ? ["habits", "edu"] : ["edu"];
      db.ideas.push({ id: newId("idea"), brandId: brand.id, title: `Our take on: ${p.hook || `${comp?.name ?? "competitor"}'s ${p.format}`}`.slice(0, 140), pillarId: pillarFor(brand, fits), angle: `${comp?.name ?? "A competitor"}'s ${p.platform} ${p.format} got ${lift || "well above"}× their usual engagement. Make your own version with your facts, visuals and voice; don't copy their words, footage or audio.${p.url ? ` Reference: ${p.url}` : ""}`, audienceQuestion: "", source: "competitor-watch", relevance: 4, impact: 4, effort: 2, priority: priorityScore(4, 4, 2), status: "backlog", createdAt: nowIso(), isSample: false });
    });
    return "Added to the idea backlog (Content Studio).";
  });
}

/* ------------------------------------------------------------------ */
/* Team sign-in and one-tap approvals                                  */
/* ------------------------------------------------------------------ */

export async function loginAction(fd: FormData) {
  const next = safeNext(str(fd, "next"));
  const cfg = authConfig();
  if (!cfg) redirect(next);
  const name = cleanName(str(fd, "newName") || str(fd, "name"));
  const back = (msg: string) => `/login?err=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}`;
  if (!name) redirect(back("Pick your name, or type it (letters only, at least 2)."));
  const h = await headers();
  const ip = clientIp(h);
  const wait = loginThrottle.waitMinutes(ip);
  if (wait) redirect(back(`Too many wrong codes. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`));
  if (!codeMatches(str(fd, "code"), cfg.code)) {
    loginThrottle.fail(ip);
    await new Promise((r) => setTimeout(r, 800)); // slows down guessing
    redirect(back("That team code isn't right. Ask the app owner for it."));
  }
  loginThrottle.success(ip);
  // Over https (the public address), the cookie is only ever sent encrypted.
  const secure = h.get("x-forwarded-proto") === "https" || h.has("cf-connecting-ip");
  (await cookies()).set(SESSION_COOKIE, signSession(name, cfg.secret), { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SESSION_MAX_AGE });
  await mutate((db) => {
    if (!db.settings.team.some((n) => n.toLowerCase() === name.toLowerCase())) db.settings.team.push(name);
  });
  redirect(next);
}

export async function logoutAction() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

export async function approveScheduleAction(fd: FormData) {
  const id = str(fd, "id");
  await act(str(fd, "back") || "/approve", async () => {
    const actor = await actorOf(fd);
    if (!actor) throw new Error("Enter your name: approvals are recorded.");
    return mutate((db) => {
      const i = db.content.findIndex((c) => c.id === id);
      if (i === -1) throw new Error("Post not found.");
      const brand = db.brands.find((b) => b.id === db.content[i]!.brandId) ?? activeBrand(db);
      const r = approveAndSchedule(db.content[i]!, actor, brand);
      db.content[i] = r.piece;
      return r.message;
    });
  });
}

export async function sendBackAction(fd: FormData) {
  const id = str(fd, "id");
  await act(str(fd, "back") || "/approve", async () => {
    const actor = await actorOf(fd);
    if (!actor) throw new Error("Enter your name: changes are recorded.");
    await mutate((db) => {
      const i = db.content.findIndex((c) => c.id === id);
      if (i === -1) throw new Error("Post not found.");
      const brand = db.brands.find((b) => b.id === db.content[i]!.brandId) ?? activeBrand(db);
      db.content[i] = sendBack(db.content[i]!, actor, str(fd, "note"), brand);
    });
    return "Sent back with your note.";
  });
}

/** Makes a talking Earth Buddy video from a post, in a look that differs from recent videos, and attaches it. */
export async function makeBuddyVideoAction(fd: FormData) {
  const id = str(fd, "id");
  await act(str(fd, "back") || `/content/${id}`, async () => {
    const db = await readDb();
    const piece = db.content.find((c) => c.id === id);
    if (!piece) throw new Error("Post not found.");
    if (piece.status === "published") throw new Error("This post is already published.");
    if (!VIDEO_FORMATS.includes(piece.format)) throw new Error(`${piece.format.replace("-", " ")} posts don't use a video.`);
    const brand = db.brands.find((b) => b.id === piece.brandId) ?? activeBrand(db);
    const wanted = (BUDDY_STYLES as readonly string[]).includes(str(fd, "style")) ? (str(fd, "style") as BuddyStyle) : "auto";
    const tuning = videoTuning(analysisMetrics(db.metrics, brand.id));
    const scenes = scriptFromPiece(brand, piece, tuning.maxPoints);
    if (scenes.length < 3) throw new Error("The post needs a hook and some text before a video can be made from it.");
    const tracks = (await readLibrary(musicDir(dataFile()))).filter((t) => existsSync(t.file));
    const history = db.settings.videoLooks as Look[];
    const picked = pickLook(history, wanted, scenes, tracks.map((t) => t.file), brandAssets(brand, dataFile()).screens.length > 0);
    const look = { ...picked, music: pickMusic(tracks, picked.style, `${piece.topic} ${piece.hook}`, history) };
    const r = await exclusiveRender(() => renderBuddy(brand, scenes, look, { outDir: videosDir(dataFile()), dataFile: dataFile() }));
    const credit = tracks.find((t) => t.file === look.music)?.credit ?? "";
    const who = await actorOf(fd);
    const sentBack = await mutate((d) => {
      const i = d.content.findIndex((c) => c.id === id);
      if (i === -1) throw new Error("Post not found.");
      const before = d.content[i]!;
      d.content[i] = applyEdit(before, { mediaUrls: [r.file], ...withCredit(before, credit) }, who || "earth-buddy-video");
      d.settings.videoLooks = [...d.settings.videoLooks, { ...look, at: nowIso(), file: r.file }].slice(-50);
      return before.status !== d.content[i]!.status;
    });
    const style = BUDDY_STYLE_LABEL[look.style].toLowerCase();
    return `New Earth Buddy video made (${r.durationSec}s, ${style}, ${look.theme} colours).${tuning.reason ? ` ${tuning.reason}` : ""}${sentBack ? " The post was approved, so it went back for approval." : ""}`;
  });
}

/** Saves (or updates) the numbers for one published post, typed in from the platform's app. */
export async function savePostNumbersAction(fd: FormData) {
  const id = str(fd, "id");
  await act(`/content/${id}#numbers`, async () => {
    return mutate((db) => {
      const piece = db.content.find((c) => c.id === id);
      if (!piece) throw new Error("Post not found.");
      const defs = metricsFor(piece.platform, piece.format);
      if (!defs) throw new Error(`${piece.format} isn't tracked for ${piece.platform}.`);
      const metrics: Record<string, number> = {};
      for (const m of defs.metrics) {
        const raw = str(fd, `m_${m.key}`);
        if (raw === "") continue;
        const v = Number(raw.replace(/,/g, ""));
        if (!Number.isFinite(v) || v < 0) throw new Error(`${m.label} must be a number of 0 or more.`);
        metrics[m.key] = v;
      }
      if (!Object.keys(metrics).length) throw new Error("Enter at least one number.");
      const existing = db.metrics.find((m) => m.contentId === id && !m.isSample);
      if (existing) {
        existing.metrics = { ...existing.metrics, ...metrics };
        existing.url = existing.url || piece.publishedUrl || "";
        return "Numbers updated.";
      }
      const posted = piece.history.find((h) => h.to === "published")?.at ?? piece.updatedAt;
      db.metrics.push({ id: newId("metric"), brandId: piece.brandId, contentId: id, platform: piece.platform, format: piece.format, postedAt: posted, hook: piece.hook, pillarId: piece.pillarId, cta: piece.cta, url: piece.publishedUrl ?? "", metrics, source: "manual", isSample: false, syncedAt: null });
      return "Numbers saved. They now show on the Results page.";
    });
  });
}

/* ------------------------------------------------------------------ */
/* Blog Writer and SEO / LLMO / ASO tracking                           */
/* ------------------------------------------------------------------ */

export async function runBlogNowAction() {
  await act("/tracking", async () => {
    const { runBlogWriter } = await import("@/lib/blog/agent");
    // Writing takes a few minutes: start it and come back to the page.
    void runBlogWriter({ force: true }).catch((err) => log.error("Blog Writer failed", { error: (err as Error).message }));
    return "Blog Writer started. The draft shows up here (and in the website's /admin) in about 3–5 minutes; refresh to see it.";
  });
}

export async function runTrackingNowAction() {
  await act("/tracking", async () => {
    const { runTracking } = await import("@/lib/tracking/agent");
    void runTracking({ force: true }).catch((err) => log.error("Tracking failed", { error: (err as Error).message }));
    return "Tracking started. The SEO crawl and checks take a few minutes; refresh to see the new numbers.";
  });
}

export async function runGrowthNowAction() {
  await act("/tracking", async () => {
    const { runGrowthAgent } = await import("@/lib/growth/agent");
    void runGrowthAgent({ force: true }).catch((err) => log.error("Growth agent failed", { error: (err as Error).message }));
    return "Growth agent started. Website fixes take up to 25 minutes (Claude edits a review branch); refresh to see them.";
  });
}

export async function setGrowthFixStatusAction(fd: FormData) {
  await act("/tracking", async () => {
    const id = str(fd, "id");
    const status = str(fd, "status");
    if (status !== "merged" && status !== "dismissed") throw new Error("Unknown status.");
    await mutate((d) => {
      const f = d.growthFixes.find((x) => x.id === id);
      if (f) f.status = status;
    });
    return status === "merged" ? "Marked as done." : "Dismissed.";
  });
}
