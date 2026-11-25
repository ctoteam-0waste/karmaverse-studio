import { CHARACTERS, characterAssets, characterById } from "./characters";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Brand, ContentPiece } from "../schemas";
import { logger } from "../logger";
import { newId } from "../util";
import { ffmpegBinary } from "./maker";

const log = logger("earth-buddy-video");

/**
 * Earth Buddy videos.
 *
 * Turns a post into a short talking-mascot video (scripts/video/earth_buddy.py)
 * and gives each one a different look: style, colour theme, mascot position and
 * music rotate, avoiding the combinations used for recent videos.
 */

export const BUDDY_STYLES = ["cards", "kinetic", "list", "phone", "chat", "notes"] as const;
export type BuddyStyle = (typeof BUDDY_STYLES)[number];
export const BUDDY_STYLE_LABEL: Record<BuddyStyle, string> = {
  cards: "Info cards (numbers count up)",
  kinetic: "Big bold words",
  list: "Step-by-step list",
  phone: "App screens in a phone",
  chat: "Chat messages (typing…)",
  notes: "Notes page that types itself",
};
export const BUDDY_THEMES = ["forest", "night", "sky", "sunset"] as const;
export const BUDDY_LAYOUTS = ["left", "center", "right"] as const;

export interface BuddyScene {
  kind: "hook" | "point" | "stat" | "quote" | "question" | "cta";
  /** Shown in the speech bubble. */
  text: string;
  /** Spoken by the voice (numbers and symbols written out). */
  say: string;
  /** Large text on the card or screen (defaults to text). */
  big?: string;
  label?: string;
  cap?: string;
  num?: number;
  unit?: string;
  lakh?: boolean;
}

export interface Look {
  style: BuddyStyle;
  theme: (typeof BUDDY_THEMES)[number];
  layout: (typeof BUDDY_LAYOUTS)[number];
  music: string;
  /** Who presented the video (see ./characters.ts). */
  character?: string;
}

/* ------------------------------------------------------------------ */
/* Script                                                              */
/* ------------------------------------------------------------------ */

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/** Display text: no links, hashtags, emoji or bullet marks. */
export function tidy(s: string): string {
  return s
    .replace(/https?:\/\/\S+/g, "")
    .replace(/#\w+/g, "")
    .replace(EMOJI, "")
    .replace(/^\s*([•\-*]|\d+[.)](?=\s)|\d️?⃣)\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the voice should say: symbols and abbreviations written out. */
export function speakable(s: string): string {
  return tidy(s)
    .replace(/\b3R\b/g, "Three R")
    .replace(/CO₂|CO2/g, "C O two")
    .replace(/(\d)\s*[–-]\s*(\d)/g, "$1 to $2")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/(\d)\+/g, "$1 plus")
    .replace(/(\d)\s*kg\b/gi, "$1 kilos")
    .replace(/₹\s*(\d[\d,.]*)/g, "$1 rupees")
    .replace(/\bFY\b/g, "financial year")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();
}

const SKIP = /^(read the (full )?story|full story|learn more|link in bio|search .*google play|join karmaverse|poori story|subscribe)/i;
const STAT = /^(?:over |more than )?([\d,]+(?:\.\d+)?)\s*(lakh\+?|kg|%|\+)?\s+(.{3,})$/i;

/** One stat scene from a line like "9,63,379 kg of waste diverted" or "18.5 lakh+ citizens engaged". */
export function statFrom(line: string): Pick<BuddyScene, "num" | "unit" | "lakh" | "cap"> | null {
  const m = tidy(line).match(STAT);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 10) return null;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit.startsWith("lakh")) return { num: n * 100000, unit: unit.endsWith("+") ? "+" : "", lakh: true, cap: m[3]!.replace(/^of\s+/i, "") };
  return { num: n, unit: unit === "kg" ? "kg" : unit, cap: m[3]!.replace(/^of\s+/i, "") };
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** The scenes Earth Buddy speaks for a post: hook, up to `maxPoints` points, the post's question, then the call to action. */
export function scriptFromPiece(brand: Brand, piece: ContentPiece, maxPoints = 4): BuddyScene[] {
  const body = (piece.platform === "youtube" ? piece.description : piece.caption) || "";
  const hook = tidy(piece.hook) || tidy(piece.topic);
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^([•\-*]|\d+[.)](?=\s)|\d️?⃣|\p{Extended_Pictographic})/u.test(l)).map(tidy).filter((l) => l.length > 3 && !SKIP.test(l));
  const prose = lines.filter((l) => !bullets.includes(tidy(l))).flatMap(sentences).map(tidy).filter((l) => l.length > 3 && !SKIP.test(l) && tidy(l) !== hook);
  const question = prose.find((s) => s.endsWith("?") && s !== hook);
  const points = (bullets.length >= 2 ? bullets : prose.filter((s) => s !== question && !/^(comment|share|tag|send this)/i.test(s))).slice(0, Math.max(1, maxPoints));

  const scenes: BuddyScene[] = [{ kind: "hook", text: hook, say: speakable(hook), label: /\bnews\b/i.test(hook + body.slice(0, 80)) ? "IN THE NEWS" : undefined }];
  for (const p of points) {
    const stat = statFrom(p);
    if (stat) scenes.push({ kind: "stat", text: p, say: speakable(p), ...stat });
    else if (/^[“"].+[”"]/.test(p)) scenes.push({ kind: "quote", text: p, say: speakable(p), big: p.replace(/^[“"]|[”"].*$/g, "") });
    else scenes.push({ kind: "point", text: p, say: speakable(p) });
  }
  if (question) scenes.push({ kind: "question", text: question, say: speakable(question) });
  const app = brand.name;
  scenes.push({ kind: "cta", text: `Search ${app} on Google Play!`, say: `Search ${app} on Google Play, and make every sustainable gesture count!` });
  return scenes;
}

/* ------------------------------------------------------------------ */
/* Look                                                                */
/* ------------------------------------------------------------------ */

const APP_WORDS = /\b(app|quiz|wallet|redeem|refer|track|pickup|book|coins?)\b/i;

/** The style that suits the script best. */
export function bestStyle(scenes: BuddyScene[], hasScreens: boolean): BuddyStyle {
  const stats = scenes.filter((s) => s.kind === "stat").length;
  const points = scenes.filter((s) => s.kind === "point").length;
  if (stats >= 2) return "cards";
  if (points >= 3) return "list";
  if (hasScreens && scenes.some((s) => APP_WORDS.test(s.text))) return "phone";
  // A hook that asks something reads naturally as a chat.
  if (/\?/.test(scenes[0]?.text ?? "") || scenes.some((s) => s.kind === "question")) return "chat";
  return "kinetic";
}

/**
 * Picks a look that differs from recent videos. With style "auto" the best-fitting
 * style is used unless the last video used it too; theme, layout and music always
 * rotate away from the last few.
 */
export function pickLook(history: Look[], wanted: BuddyStyle | "auto", scenes: BuddyScene[], music: string[], hasScreens: boolean, rand: () => number = Math.random): Look {
  const recent = history.slice(-4);
  const last = recent[recent.length - 1];
  let style: BuddyStyle = wanted === "auto" ? bestStyle(scenes, hasScreens) : wanted;
  // Avoid the styles of the last three videos so feeds don't look the same day after day.
  const recentStyles = recent.slice(-3).map((l) => l.style);
  if (wanted === "auto" && (last?.style === style || recentStyles.includes(style))) {
    const points = scenes.filter((x) => x.kind === "point" || x.kind === "stat").length;
    const suitable = BUDDY_STYLES.filter((s) => s !== style && (s !== "phone" || hasScreens) && ((s !== "list" && s !== "notes") || points >= 2));
    const fresh = suitable.filter((s) => !recentStyles.includes(s));
    const options = fresh.length ? fresh : suitable.filter((s) => s !== last?.style);
    style = options[Math.floor(rand() * options.length)] ?? style;
  }
  const leastUsed = <T extends string>(all: readonly T[], used: T[]): T => {
    const fresh = all.filter((x) => !used.includes(x));
    const pool = fresh.length ? fresh : all.filter((x) => x !== used[used.length - 1]);
    return pool[Math.floor(rand() * pool.length)] ?? all[0]!;
  };
  return {
    style,
    theme: leastUsed(BUDDY_THEMES, recent.map((l) => l.theme)),
    layout: leastUsed(BUDDY_LAYOUTS, recent.slice(-1).map((l) => l.layout)),
    music: music.length ? leastUsed(music, recent.map((l) => l.music)) : "",
  };
}

/* ------------------------------------------------------------------ */
/* Music                                                               */
/* ------------------------------------------------------------------ */

/** Moods that suit a video, best first, from its topic and style. */
export function moodsFor(style: BuddyStyle, topic: string): string[] {
  if (/diwali|holi|festival|wedding|navratri|puja/i.test(topic)) return ["indian", "uplifting"];
  if (/news|growth|milestone|award|impact update|annual/i.test(topic)) return ["corporate", "uplifting"];
  if (/myth|fact|quiz|\bvs\b|wet or dry|guess|true or false/i.test(topic)) return ["playful", "energetic"];
  if (style === "chat" || style === "notes") return ["lofi", "calm"];
  if (style === "kinetic") return ["energetic", "playful"];
  if (style === "phone") return ["energetic", "uplifting"];
  return ["uplifting", "indian", "calm"];
}

/**
 * Background music for a video: a track in a suitable mood that none of the last
 * `avoid` videos used. Falls back to any unused track, then to the least recent one.
 */
export function pickMusic(tracks: Array<{ file: string; mood: string }>, style: BuddyStyle, topic: string, history: Look[], avoid = 8, rand: () => number = Math.random): string {
  if (!tracks.length) return "";
  const recent = history.slice(-avoid).map((l) => l.music);
  const unused = tracks.filter((t) => !recent.includes(t.file));
  for (const mood of moodsFor(style, topic)) {
    const pool = unused.filter((t) => t.mood === mood);
    if (pool.length) return pool[Math.floor(rand() * pool.length)]!.file;
  }
  if (unused.length) return unused[Math.floor(rand() * unused.length)]!.file;
  // Everything was used recently: take the one used longest ago.
  return [...tracks].sort((a, b) => history.map((l) => l.music).lastIndexOf(a.file) - history.map((l) => l.music).lastIndexOf(b.file))[0]!.file;
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

export function brandAssets(brand: Brand, dataFile: string): { logo: string; mascot: string; partnerLogo: string; screens: string[] } {
  const dir = path.join(path.dirname(dataFile), "brand");
  const screensDir = path.join(dir, "app-screens");
  const screens = existsSync(screensDir) ? readdirSync(screensDir).filter((f) => /\.(png|jpe?g)$/i.test(f)).map((f) => path.join(screensDir, f)) : [];
  return {
    logo: brand.logoFile && existsSync(brand.logoFile) ? brand.logoFile : path.join(dir, `${brand.id}-logo-full.jpeg`),
    mascot: path.join(dir, "earth-buddy-mascot.jpeg"),
    partnerLogo: path.join(dir, "3r-zerowaste-logo.jpg"),
    screens,
  };
}

export interface BuddyResult {
  file: string;
  durationSec: number;
  scenes: number;
}

/** Runs the Python renderer. Takes 1–3 minutes for a 30–60 second video. */
/** Scene shapes the renderer accepts: the classic ones and the series ones (see series.ts). */
export type RenderScene = { kind: string; text: string; say: string } & Record<string, unknown>;
export type RenderLook = Omit<Look, "style"> & { style: BuddyStyle | "news" | "quiz" | "myth" | "hack" };

export async function renderBuddy(brand: Brand, scenes: ReadonlyArray<RenderScene | BuddyScene>, look: RenderLook, opts: { outDir: string; dataFile: string; python?: string; ticker?: string; character?: string; ctaButton?: string }): Promise<BuddyResult> {
  const assets = brandAssets(brand, opts.dataFile);
  const cast = characterById(opts.character) ?? CHARACTERS[0];
  const host = characterAssets(cast.id, opts.dataFile, assets.mascot);
  for (const [k, f] of Object.entries({ logo: assets.logo, mascot: assets.mascot })) if (!existsSync(f)) throw new Error(`Missing ${k} image: ${f}`);
  const work = await mkdtemp(path.join(tmpdir(), "buddy-"));
  const out = path.join(opts.outDir, `${newId("buddy")}.mp4`);
  const spec = {
    ffmpeg: ffmpegBinary(),
    work,
    out,
    style: look.style,
    theme: look.theme,
    layout: look.layout,
    music: look.music,
    seed: Math.floor(Math.random() * 1000),
    logo: assets.logo,
    partnerLogo: assets.partnerLogo,
    mascot: host.mascot,
    frames: host.frames,
    voice: cast.voice,
    rate: cast.rate,
    pitch: cast.pitch,
    screens: assets.screens,
    title: scenes[0]?.text ?? "",
    ticker: opts.ticker ?? "",
    scenes,
    cta: { line1: "Every Sustainable Gesture Counts", button: opts.ctaButton || `Search “${brand.name}” on Google Play`, site: brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "") },
  };
  const specFile = path.join(work, "spec.json");
  await writeFile(specFile, JSON.stringify(spec), "utf8");
  const script = path.join(process.cwd(), "scripts", "video", "earth_buddy.py");
  const python = opts.python || process.env.PYTHON?.trim() || "python";
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const p = spawn(/*turbopackIgnore: true*/ python, [script, specFile], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", (err) => reject(new Error(`Could not start Python (${python}): ${err.message}. Set PYTHON in .env.local.`)));
      p.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`The video renderer stopped (code ${code}): ${stderr.trim().split("\n").slice(-3).join(" ")}`))));
    });
    const last = output.trim().split("\n").pop() ?? "{}";
    const r = JSON.parse(last) as BuddyResult;
    log.info("Earth Buddy video made", { file: r.file, style: look.style, theme: look.theme, seconds: r.durationSec });
    return r;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
