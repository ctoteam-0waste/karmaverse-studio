import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger";
import { RetryableError, withRetry } from "../retry";
import { ffmpegBinary } from "../video/maker";

const log = logger("music-agent");

/**
 * K. Music Agent.
 *
 * Finds background music that is safe for brand videos, checks that it really is
 * music, keeps it in a local library, and picks the best match for a video.
 *
 * Source: Openverse (api.openverse.org), a search engine for openly licensed
 * media (Freesound, Wikimedia Commons, …). Only these licences are accepted:
 *   - CC0 / Public Domain Mark: free for any use, no credit needed.
 *   - CC BY: free for any use; the artist must be credited (the app adds the
 *     credit line to the post automatically).
 * ShareAlike (BY-SA) and NonCommercial / NoDerivatives licences are never used.
 *
 * Checks on every downloaded track (ffmpeg): 20 s–5 min long, not mostly silence,
 * not too quiet, and "musical" (low spectral flatness; noise and whooshes are flat).
 */

export const MOODS = {
  uplifting: { label: "Uplifting / inspiring", queries: ["acoustic uplifting", "cheerful", "uplifting", "inspiring", "good times", "audionautix"] },
  calm: { label: "Calm / nature", queries: ["calm acoustic", "peaceful piano", "relaxing guitar", "meditation", "nature calm"] },
  energetic: { label: "Energetic / upbeat", queries: ["upbeat", "happy ukulele", "energetic", "funky", "positive pop"] },
  lofi: { label: "Lo-fi / chill", queries: ["lofi", "lo-fi hip hop", "chillhop", "chill beat", "chillout"] },
  playful: { label: "Playful / quirky", queries: ["playful", "quirky", "whistle happy", "pizzicato", "comedy light"] },
  indian: { label: "Indian (sitar, tabla, flute)", queries: ["sitar", "tabla", "bansuri", "indian flute", "indian music", "raga"] },
  corporate: { label: "Corporate / news", queries: ["corporate", "news background", "business motivation", "technology positive", "presentation"] },
} as const;
export type Mood = keyof typeof MOODS;

const ALLOWED = new Set(["cc0", "pdm", "by"]);
const GOOD = /uplift|inspir|cheer|happy|bright|positiv|acoustic|ukulele|piano|guitar|corporate|business|success|motivat|background|optimis|good times|sunny|hope|joy|calm|peace|relax|upbeat|energetic|funk|pop|meditat|nature|lo-?fi|chill|playful|quirky|whistl|pizzicato|sitar|tabla|bansuri|flute|indian|raga|news|technology/i;
const BAD = /\bsfx\b|sound ?effect|\bfx\b|jingle|riser|uplifter|whoosh|swoosh|noise|alarm|horror|scary|dark|sad|danger|alien|drone|impact|hit\b|stinger|transition|glitch|beep|notification|voice|speech|spoken|podcast|interview|crowd|applause|jeer|stadium/i;

export interface Track {
  id: string;
  title: string;
  creator: string;
  license: "cc0" | "pdm" | "by";
  licenseVersion: string;
  licenseUrl: string;
  source: string;
  landingUrl: string;
  /** Local file in the library. */
  file: string;
  durationSec: number;
  mood: Mood;
  score: number;
  /** Credit line to publish with the video ("" when not required). */
  credit: string;
  /** Spectral flatness (0 = tonal music … 1 = noise). */
  flatness: number;
  loudnessLufs: number;
  addedAt: string;
}

interface OpenverseAudio {
  id: string;
  title: string;
  creator: string | null;
  license: string;
  license_version: string | null;
  license_url: string | null;
  source: string;
  foreign_landing_url: string | null;
  url: string;
  filetype: string | null;
  duration: number | null;
  tags?: Array<{ name: string }>;
  genres?: string[] | null;
}

export interface MusicDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  ffmpeg?: string;
}

const defaultDeps = (): MusicDeps => ({ fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

export function musicDir(dataFile: string): string {
  return path.join(path.dirname(dataFile), "music");
}

const libraryFile = (dir: string) => path.join(dir, "library.json");

export async function readLibrary(dir: string): Promise<Track[]> {
  try {
    const list = JSON.parse(await readFile(libraryFile(dir), "utf8")) as Track[];
    return list.filter((t) => existsSync(t.file));
  } catch {
    return [];
  }
}

async function writeLibrary(dir: string, tracks: Track[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = `${libraryFile(dir)}.tmp`;
  await writeFile(tmp, JSON.stringify(tracks, null, 2), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, libraryFile(dir));
}

/** Credit line for CC BY tracks; empty for CC0 / public domain. */
export function creditFor(t: Pick<Track, "license" | "licenseVersion" | "title" | "creator" | "source" | "landingUrl">): string {
  if (t.license !== "by") return "";
  return `Music: "${t.title}" by ${t.creator || "unknown artist"} (${t.source}), CC BY ${t.licenseVersion || "4.0"}${t.landingUrl ? ` ${t.landingUrl}` : ""}`;
}

/** Ranks a search result before downloading it. Returns null when it must not be used. */
export function preScore(r: Pick<OpenverseAudio, "license" | "duration" | "title" | "tags" | "filetype">, minSec = 20): number | null {
  if (!ALLOWED.has(r.license)) return null;
  const sec = (r.duration ?? 0) / 1000;
  if (sec < minSec || sec > 300) return null;
  const text = `${r.title} ${(r.tags ?? []).map((t) => t.name).join(" ")}`;
  if (BAD.test(text)) return null;
  if (r.filetype && !/mp3|ogg|wav|flac|m4a/i.test(r.filetype)) return null;
  let s = r.license === "by" ? 1 : 2;
  s += Math.min(4, (text.match(new RegExp(GOOD.source, "gi")) ?? []).length);
  if (sec >= 30 && sec <= 240) s += 1;
  return s;
}

async function search(q: string, deps: MusicDeps): Promise<OpenverseAudio[]> {
  const url = `https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q)}&license=cc0,pdm,by&page_size=20`;
  return withRetry(
    `openverse "${q}"`,
    async () => {
      let res: Response;
      try {
        res = await deps.fetch(url, { headers: { "User-Agent": "social-growth-agent/0.1 (music agent)" }, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        throw new RetryableError(`Openverse did not answer: ${(err as Error).message}`);
      }
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`Openverse returned ${res.status}`);
      if (!res.ok) throw new Error(`Openverse returned ${res.status}`);
      return ((await res.json()) as { results?: OpenverseAudio[] }).results ?? [];
    },
    { attempts: 2, baseDelayMs: 2000, sleep: deps.sleep },
  );
}

function ffRun(ff: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ff, args, { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

/** Flatness, loudness, silence share and length of an audio file. */
export async function analyse(ff: string, file: string): Promise<{ flatness: number; lufs: number; silentShare: number; seconds: number }> {
  const flat = await ffRun(ff, ["-hide_banner", "-t", "60", "-i", file, "-af", "aformat=channel_layouts=mono,aspectralstats=measure=flatness,ametadata=mode=print:key=lavfi.aspectralstats.1.flatness:file=-", "-f", "null", "-"]);
  const vals = [...flat.matchAll(/flatness=([0-9.]+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const loud = await ffRun(ff, ["-hide_banner", "-i", file, "-af", "ebur128,silencedetect=n=-45dB:d=1", "-f", "null", "-"]);
  const lufs = Number([...loud.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1] ?? -70);
  const seconds = Number(loud.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/)?.slice(1).reduce((a, v, i) => a + Number(v) * [3600, 60, 1][i]!, 0) ?? 0);
  const silent = [...loud.matchAll(/silence_duration: ([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  return { flatness: vals.length ? vals[vals.length >> 1]! : 1, lufs, silentShare: seconds ? silent / seconds : 1, seconds };
}

export interface FindResult {
  added: Track[];
  rejected: string[];
  errors: string[];
}

/** Searches, downloads, checks and adds up to `want` new tracks for a mood. */
export async function findMusic(dir: string, mood: Mood, want = 4, deps: MusicDeps = defaultDeps()): Promise<FindResult> {
  const ff = deps.ffmpeg ?? ffmpegBinary();
  const library = await readLibrary(dir);
  const known = new Set(library.map((t) => t.id));
  const result: FindResult = { added: [], rejected: [], errors: [] };
  const seen = new Map<string, { r: OpenverseAudio; s: number }>();

  for (const q of MOODS[mood].queries) {
    try {
      for (const r of await search(q, deps)) {
        const s = preScore(r);
        if (s !== null && !known.has(r.id) && !seen.has(r.id)) seen.set(r.id, { r, s });
      }
    } catch (err) {
      result.errors.push(`Search "${q}": ${(err as Error).message}`);
    }
    if (seen.size >= want * 4) break;
  }

  await mkdir(dir, { recursive: true });
  const ranked = [...seen.values()].sort((a, b) => b.s - a.s);
  for (const { r, s } of ranked) {
    if (result.added.length >= want) break;
    const ext = (r.filetype || path.extname(new URL(r.url).pathname).slice(1) || "mp3").toLowerCase();
    const file = path.join(dir, `${r.id}.${ext}`);
    try {
      const res = await deps.fetch(r.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`download ${res.status}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      const a = await analyse(ff, file);
      const why = a.flatness > 0.11 ? "sounds like noise or an effect, not music" : a.silentShare > 0.3 ? "mostly silence" : a.lufs < -40 ? "too quiet" : a.seconds < 20 ? "too short" : "";
      if (why) {
        result.rejected.push(`"${r.title}": ${why}`);
        await rm(file, { force: true });
        continue;
      }
      const track: Track = {
        id: r.id,
        title: r.title,
        creator: r.creator ?? "",
        license: r.license as Track["license"],
        licenseVersion: r.license_version ?? "",
        licenseUrl: r.license_url ?? "",
        source: r.source,
        landingUrl: r.foreign_landing_url ?? "",
        file,
        durationSec: Math.round(a.seconds),
        mood,
        // Tonal, well-produced tracks score higher.
        score: s + (a.flatness < 0.03 ? 1 : 0) + (a.lufs > -24 ? 1 : 0),
        credit: "",
        flatness: Math.round(a.flatness * 1000) / 1000,
        loudnessLufs: Math.round(a.lufs * 10) / 10,
        addedAt: new Date().toISOString(),
      };
      track.credit = creditFor(track);
      result.added.push(track);
    } catch (err) {
      result.errors.push(`"${r.title}": ${(err as Error).message}`);
      await rm(file, { force: true }).catch(() => undefined);
    }
  }
  await writeLibrary(dir, [...library, ...result.added]);
  log.info("Music search finished", { mood, added: result.added.length, rejected: result.rejected.length, errors: result.errors.length });
  return result;
}

/** Deletes a track and its file from the library. Returns it, or null if it wasn't there. */
export async function removeTrack(dir: string, id: string): Promise<Track | null> {
  const lib = await readLibrary(dir);
  const t = lib.find((x) => x.id === id) ?? null;
  if (!t) return null;
  await rm(t.file, { force: true });
  await writeLibrary(dir, lib.filter((x) => x.id !== id));
  return t;
}

/** The best library track for a mood and length (longest-enough first, then score). */
export function pickTrack(library: Track[], mood: Mood, videoSec: number): Track | null {
  const pool = library.filter((t) => t.mood === mood);
  const list = pool.length ? pool : library;
  if (!list.length) return null;
  return [...list].sort((a, b) => Number(b.durationSec >= videoSec) - Number(a.durationSec >= videoSec) || b.score - a.score)[0]!;
}

/** Picks a track, searching Openverse first if the library has nothing for this mood. */
export async function musicFor(dir: string, mood: Mood, videoSec: number, deps?: MusicDeps): Promise<{ track: Track | null; notes: string[] }> {
  let library = await readLibrary(dir);
  const notes: string[] = [];
  if (!library.some((t) => t.mood === mood)) {
    const r = await findMusic(dir, mood, 3, deps);
    if (!r.added.length) notes.push(`The Music Agent couldn't find ${MOODS[mood].label.toLowerCase()} music right now (${[...r.errors, ...r.rejected].slice(0, 2).join("; ") || "no suitable results"}).`);
    library = await readLibrary(dir);
  }
  return { track: pickTrack(library, mood, videoSec), notes };
}
