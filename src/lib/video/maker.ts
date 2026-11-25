import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Brand, ContentPiece, Format, VideoBrief } from "../schemas";
import { logger } from "../logger";
import { newId } from "../util";

const log = logger("video-maker");

/**
 * I. Video Maker Agent.
 *
 * Renders a finished MP4 on this computer from a Video Director brief or a post:
 * one captioned scene per script line, on a brand-colour gradient or over your
 * own clips, with an optional voiceover from the voices installed in Windows.
 * Ends on a call-to-action card. Free and offline (ffmpeg + Windows speech).
 *
 * It does not generate camera footage or AI avatars: for real-life shots, pass
 * your clips as backgrounds.
 */

export interface Scene {
  text: string;
  voice: string;
  /** Planned length; stretched if the voiceover is longer. */
  minSec: number;
  kind: "hook" | "body" | "cta";
}

export interface RenderOptions {
  /** "none" for silent captions only. */
  voice: string;
  /** Local video/image files used as scene backgrounds, in turn. Empty = brand gradient. */
  clips: string[];
  outDir: string;
  /** Background music file, mixed quietly under the voice. */
  musicFile?: string;
  /** Injected for tests. */
  ffmpegPath?: string;
}

export interface RenderResult {
  file: string;
  durationSec: number;
  scenes: number;
  notes: string[];
}

/** File names the app serves from data/videos: one plain name, no folders or "..". */
export const SERVABLE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*\.(mp4|png|jpg|pdf)$/i;

export const VERTICAL: Format[] = ["reel", "short", "story"];
export const VIDEO_FORMATS: Format[] = ["reel", "short", "story", "long-video"];

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = /\[[^\]]{3,}\]/;

/** Removes emoji and symbols the caption font can't draw. */
export function cleanText(s: string): string {
  return s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/#\w+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ctaScene(brand: Brand, cta: string): Scene {
  const site = brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return { kind: "cta", text: [cleanText(cta), site].filter(Boolean).join("\n"), voice: cleanText(cta), minSec: 3 };
}

export function scenesFromBrief(brand: Brand, brief: VideoBrief): Scene[] {
  const scenes: Scene[] = brief.script.map((l, i): Scene => ({
    kind: i === 0 ? "hook" : "body",
    text: cleanText(l.onScreenText || l.voiceover),
    voice: cleanText(l.voiceover),
    minSec: Math.max(1.5, l.end - l.start),
  }));
  const last = scenes.at(-1);
  if (!last || !last.voice.toLowerCase().includes(cleanText(brief.cta).toLowerCase().slice(0, 15))) scenes.push(ctaScene(brand, brief.cta));
  else last.kind = "cta";
  return scenes.filter((s) => s.text || s.voice);
}

/** For a post without a brief: hook, then up to 5 short lines of the caption, then the CTA. */
export function scenesFromPiece(brand: Brand, piece: ContentPiece): Scene[] {
  const lines = (piece.caption || piece.description)
    .split(/\r?\n/)
    .map(cleanText)
    .filter((l) => l && l !== cleanText(piece.hook) && l !== cleanText(piece.cta) && !/^(slide|frame) \d/i.test(l))
    .slice(0, 5);
  const scenes: Scene[] = [
    { kind: "hook", text: cleanText(piece.hook), voice: cleanText(piece.hook), minSec: 2.5 },
    ...lines.map((l): Scene => ({ kind: "body", text: l, voice: l, minSec: 3 })),
    ctaScene(brand, piece.cta || brand.defaultCtas[0] || "Follow for more"),
  ];
  return scenes.filter((s) => s.text);
}

export function planProblems(scenes: Scene[]): string[] {
  const p: string[] = [];
  if (scenes.length < 2) p.push("Need at least a hook and one more line to make a video.");
  const gaps = scenes.filter((s) => PLACEHOLDER.test(s.text) || PLACEHOLDER.test(s.voice));
  if (gaps.length) p.push(`Fill in the [bracketed] parts of the script first (${gaps.length} scene${gaps.length > 1 ? "s" : ""}).`);
  return p;
}

/** Wraps text to lines of at most `width` characters, at word boundaries. */
export function wrap(text: string, width: number): string {
  return text
    .split("\n")
    .map((para) => {
      const out: string[] = [];
      let line = "";
      for (const word of para.split(" ")) {
        if (line && (line + " " + word).length > width) {
          out.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      if (line) out.push(line);
      return out.join("\n");
    })
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function ffmpegBinary(): string {
  // Loaded at runtime so bundling never inlines the path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("ffmpeg-static") as string | null;
  if (!p || !existsSync(p)) throw new Error("ffmpeg is not installed. Run `npm ci` (it downloads ffmpeg), then restart the app.");
  return p;
}

function run(bin: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`))));
  });
}

let voiceCache: { at: number; voices: string[] } | null = null;

/** Voices installed in Windows (System.Speech), cached for 10 minutes. Empty elsewhere. */
export async function listVoices(): Promise<string[]> {
  if (voiceCache && Date.now() - voiceCache.at < 600_000) return voiceCache.voices;
  const voices = await readVoices();
  voiceCache = { at: Date.now(), voices };
  return voices;
}

async function readVoices(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  return new Promise((resolve) => {
    const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }"], { windowsHide: true });
    let out = "";
    ps.stdout.on("data", (d: Buffer) => (out += d.toString()));
    ps.on("error", () => resolve([]));
    ps.on("close", () => resolve(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
  });
}

/** Speaks each line into its own WAV file in one PowerShell call. */
async function speak(lines: string[], voice: string, dir: string): Promise<void> {
  const jobs = lines.map((text, i) => ({ text, file: path.join(dir, `v${i}.wav`) }));
  await writeFile(path.join(dir, "voice.json"), JSON.stringify({ voice, jobs }), "utf8");
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$cfg = Get-Content -Raw -Encoding UTF8 voice.json | ConvertFrom-Json",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$s.SelectVoice($cfg.voice)",
    "$s.Rate = 0",
    "foreach ($j in $cfg.jobs) { $s.SetOutputToWaveFile($j.file); $s.Speak($j.text) }",
    "$s.Dispose()",
  ].join("; ");
  await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], dir);
}

/** Duration of a PCM WAV file from its header. */
export function wavSeconds(buf: Buffer): number {
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(off + 16);
    if (id === "data") return byteRate ? size / byteRate : 0;
    off += 8 + size + (size % 2);
  }
  return 0;
}

const FONT_CANDIDATES = ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"];
const FONT_REGULAR = ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];

/** ffmpeg filter-argument escaping for a file path (the drive colon must be escaped). */
const ffPath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

const isImage = (p: string) => /\.(jpe?g|png|webp)$/i.test(p);

/**
 * Renders the scenes to one MP4. Each scene is rendered to the same codec
 * settings, then joined without re-encoding.
 */
export async function renderVideo(brand: Brand, format: Format, scenes: Scene[], opts: RenderOptions): Promise<RenderResult> {
  const problems = planProblems(scenes);
  if (problems.length) throw new Error(problems.join(" "));
  for (const c of opts.clips) if (!existsSync(c)) throw new Error(`Background file not found: ${c}`);
  const ff = opts.ffmpegPath ?? ffmpegBinary();
  const fontBold = FONT_CANDIDATES.find((f) => existsSync(f));
  const fontReg = FONT_REGULAR.find((f) => existsSync(f)) ?? fontBold;
  if (!fontBold) throw new Error("No caption font found (looked for Arial / Segoe UI / DejaVu).");

  const vertical = VERTICAL.includes(format);
  const [W, H] = vertical ? [1080, 1920] : [1920, 1080];
  const fontSize = vertical ? 84 : 76;
  const wrapAt = vertical ? 20 : 34;
  const notes: string[] = [];
  const dir = await mkdtemp(path.join(tmpdir(), "sga-video-"));

  try {
    // 1. Voiceover, one file per scene.
    const useVoice = opts.voice && opts.voice !== "none" && process.platform === "win32";
    if (opts.voice && opts.voice !== "none" && !useVoice) notes.push("Voiceover needs Windows; the video was made without it.");
    const voiced = useVoice ? scenes.map((s) => s.voice || s.text) : [];
    if (useVoice) await speak(voiced, opts.voice, dir);

    // 2. Scene timing: planned length, stretched to fit the voice.
    const durations: number[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const voiceSec = useVoice ? wavSeconds(await readFile(path.join(dir, `v${i}.wav`))) : 0;
      durations.push(Math.max(scenes[i]!.minSec, voiceSec + 0.5, 1.5));
    }
    const total = durations.reduce((a, b) => a + b, 0);

    // 3. Render each scene.
    const brandName = cleanText(brand.name);
    await writeFile(path.join(dir, "brand.txt"), brandName, "utf8");
    let elapsed = 0;
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i]!;
      const d = durations[i]!;
      await writeFile(path.join(dir, `t${i}.txt`), wrap(s.text, s.kind === "cta" ? wrapAt + 4 : wrapAt), "utf8");
      const clip = opts.clips.length ? opts.clips[i % opts.clips.length]! : null;

      const inputs: string[] = [];
      if (clip && isImage(clip)) inputs.push("-loop", "1", "-t", d.toFixed(2), "-i", clip);
      else if (clip) inputs.push("-stream_loop", "-1", "-t", d.toFixed(2), "-i", clip);
      else inputs.push("-f", "lavfi", "-t", d.toFixed(2), "-i", `gradients=s=${W}x${H}:c0=0x0b3d20:c1=0x1f7a45:x0=0:y0=0:x1=${W}:y1=${H}:speed=0.008:r=30`);
      if (useVoice) inputs.push("-i", `v${i}.wav`);
      else inputs.push("-f", "lavfi", "-t", d.toFixed(2), "-i", "anullsrc=r=44100:cl=stereo");

      const bg = clip
        ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,drawbox=c=black@0.45:t=fill[bg]`
        : `[0:v]setsar=1,fps=30[bg]`;
      const accent = s.kind === "hook" ? "0xfacc15" : "white";
      const size = s.kind === "hook" ? Math.round(fontSize * 1.1) : s.kind === "cta" ? Math.round(fontSize * 0.9) : fontSize;
      const fade = `alpha='min(1,t/0.35)'`;
      const progressStart = elapsed / total;
      const progressEnd = (elapsed + d) / total;
      // Progress bar: a yellow strip slid in from the left with overlay (its `t` is time; drawbox's `t` is thickness).
      inputs.push("-f", "lavfi", "-t", d.toFixed(2), "-i", `color=c=0xfacc15:s=${W}x14:r=30`);
      const graph = [
        `${bg};[bg]drawtext=fontfile='${ffPath(fontReg!)}':textfile=brand.txt:fontcolor=white@0.85:fontsize=${Math.round(fontSize * 0.5)}:x=(w-text_w)/2:y=${vertical ? 140 : 60}`,
        `drawtext=fontfile='${ffPath(fontBold)}':textfile=t${i}.txt:fontcolor=${accent}:fontsize=${size}:line_spacing=${Math.round(size * 0.3)}:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.35:boxborderw=${Math.round(size * 0.5)}:${fade}`,
        `drawbox=x=0:y=ih-14:w=iw:h=14:c=white@0.2:t=fill[base]`,
      ].join(",") + `;[base][2:v]overlay=x='-W+W*(${progressStart.toFixed(4)}+${(progressEnd - progressStart).toFixed(4)}*t/${d.toFixed(2)})':y=H-14:eval=frame,format=yuv420p[v]`;
      await run(ff, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "1:a", "-t", d.toFixed(2), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-r", "30", "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k", `s${i}.mp4`], dir);
      elapsed += d;
    }

    // 4. Join.
    await writeFile(path.join(dir, "list.txt"), scenes.map((_, i) => `file 's${i}.mp4'`).join("\n"), "utf8");
    await mkdir(opts.outDir, { recursive: true });
    const name = `${newId("video")}.mp4`;
    const out = path.join(opts.outDir, name);
    if (opts.musicFile && existsSync(opts.musicFile)) {
      await run(ff, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], dir);
      // Music levelled and faded out at the end; with a voiceover it ducks automatically while the voice speaks.
      const music = `[1:a]aresample=44100,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(2)},loudnorm=I=-20:TP=-2:LRA=11,aresample=44100,volume=0.9,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5[m]`;
      const mix = useVoice
        ? `${music};[0:a]asplit=2[voice][key];[m][key]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450:makeup=1[duck];[voice][duck]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[a]`
        : `${music};[0:a][m]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[a]`;
      await run(ff, ["-y", "-loglevel", "error", "-i", "joined.mp4", "-stream_loop", "-1", "-i", opts.musicFile, "-filter_complex", mix, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out], dir);
    } else {
      await run(ff, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", out], dir);
    }

    if (format === "short" && total > 180) notes.push(`The video is ${Math.round(total)}s; YouTube only treats videos of 3 minutes or less as Shorts.`);
    if (format === "reel" && total > 90) notes.push(`The video is ${Math.round(total)}s; Reels perform best under 90 seconds.`);
    log.info("Video rendered", { file: out, seconds: Math.round(total), scenes: scenes.length });
    return { file: out, durationSec: Math.round(total * 10) / 10, scenes: scenes.length, notes };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Wrap an existing clip                                               */
/* ------------------------------------------------------------------ */

/** Clip length and frame size, read from ffmpeg's stream info. */
export async function probeClip(ff: string, file: string): Promise<{ seconds: number; width: number; height: number }> {
  const err = await new Promise<string>((resolve, reject) => {
    const child = spawn(ff, ["-hide_banner", "-i", file], { windowsHide: true });
    let s = "";
    child.stderr.on("data", (d: Buffer) => (s += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(s)); // exits 1 without an output file; that's expected
  });
  // Images report no duration ("N/A"): seconds is 0 for them.
  const m = err.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const size = err.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  if (!m && !size) throw new Error(`Could not read ${path.basename(file)}. Is it a video or image file?`);
  return { seconds: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0, width: Number(size?.[1] ?? 1920), height: Number(size?.[2] ?? 1080) };
}

export interface WrapContent {
  title: string;
  cta: string;
}

/**
 * Puts an existing clip, uncropped and with its own sound, into a branded frame:
 * title above, call to action below, brand gradient behind, then a short end
 * card with the CTA and website. For clips that already have narration
 * (mascot explainers, app walkthroughs, landscape recordings for Shorts).
 */
export async function renderWrapped(brand: Brand, format: Format, clip: string, content: WrapContent, opts: Omit<RenderOptions, "voice" | "clips">): Promise<RenderResult> {
  if (!existsSync(clip)) throw new Error(`Clip not found: ${clip}`);
  if (isImage(clip)) throw new Error("“Use the clip as it is” needs a video file, not an image.");
  const title = cleanText(content.title);
  const cta = cleanText(content.cta);
  if (!title) throw new Error("Add a hook/title: it's shown above the clip.");
  if (PLACEHOLDER.test(title) || PLACEHOLDER.test(cta)) throw new Error("Fill in the [bracketed] parts of the hook and CTA first.");
  const ff = opts.ffmpegPath ?? ffmpegBinary();
  const fontBold = FONT_CANDIDATES.find((f) => existsSync(f));
  const fontReg = FONT_REGULAR.find((f) => existsSync(f)) ?? fontBold;
  if (!fontBold) throw new Error("No caption font found (looked for Arial / Segoe UI / DejaVu).");

  const vertical = VERTICAL.includes(format);
  const [W, H] = vertical ? [1080, 1920] : [1920, 1080];
  const info = await probeClip(ff, clip);
  const clipSec = info.seconds;
  if (clipSec < 0.5) throw new Error(`${path.basename(clip)} doesn't look like a video (no length).`);
  // Size of the clip inside the frame (even numbers for the encoder).
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const [cw, ch] = vertical ? [W, even((W * info.height) / info.width)] : [even((H * 0.72 * info.width) / info.height), even(H * 0.72)];
  if (vertical && ch > H * 0.6) throw new Error("This clip is already tall (portrait). Use it directly as the post's media instead of wrapping it.");
  const endSec = 3;
  const total = clipSec + endSec;
  const site = brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const dir = await mkdtemp(path.join(tmpdir(), "sga-wrap-"));
  try {
    await writeFile(path.join(dir, "brand.txt"), cleanText(brand.name), "utf8");
    await writeFile(path.join(dir, "title.txt"), wrap(title, vertical ? 22 : 40), "utf8");
    await writeFile(path.join(dir, "cta.txt"), wrap(cta, vertical ? 26 : 48), "utf8");
    await writeFile(path.join(dir, "end.txt"), [wrap(cta, vertical ? 20 : 36), site].filter(Boolean).join("\n\n"), "utf8");

    // Vertical: clip fills the width in the middle. Landscape: clip fills 72% of the height.
    const box = `scale=${cw}:${ch}`;
    const during = `enable='lt(t,${clipSec.toFixed(2)})'`;
    const after = `enable='gte(t,${clipSec.toFixed(2)})'`;
    const fs = vertical ? 76 : 60;
    const graph = [
      `[1:v]${box},setsar=1,fps=30[clip]`,
      `[0:v][clip]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:shortest=0,` +
        `drawtext=fontfile='${ffPath(fontReg!)}':textfile=brand.txt:fontcolor=white@0.85:fontsize=${Math.round(fs * 0.55)}:x=(w-text_w)/2:y=${vertical ? 140 : 40},` +
        `drawtext=fontfile='${ffPath(fontBold)}':textfile=title.txt:fontcolor=0xfacc15:fontsize=${fs}:line_spacing=${Math.round(fs * 0.25)}:x=(w-text_w)/2:y=${vertical ? `(h-${ch})/2-text_h-90` : "h*0.14-text_h/2"}:${during},` +
        `drawtext=fontfile='${ffPath(fontReg!)}':textfile=cta.txt:fontcolor=white:fontsize=${Math.round(fs * 0.7)}:line_spacing=${Math.round(fs * 0.2)}:x=(w-text_w)/2:y=${vertical ? `(h+${ch})/2+90` : "h*0.9-text_h/2"}:${during},` +
        `drawtext=fontfile='${ffPath(fontBold)}':textfile=end.txt:fontcolor=white:fontsize=${fs}:line_spacing=${Math.round(fs * 0.3)}:x=(w-text_w)/2:y=(h-text_h)/2:${after},` +
        `format=yuv420p[v]`,
      `[1:a]aresample=44100,aformat=channel_layouts=stereo,apad=whole_dur=${total.toFixed(2)}[a]`,
    ].join(";");
    await mkdir(opts.outDir, { recursive: true });
    const name = `${newId("video")}.mp4`;
    const out = path.join(opts.outDir, name);
    await run(
      ff,
      ["-y", "-loglevel", "error", "-f", "lavfi", "-t", total.toFixed(2), "-i", `gradients=s=${W}x${H}:c0=0x0b3d20:c1=0x1f7a45:x0=0:y0=0:x1=${W}:y1=${H}:speed=0.008:r=30`, "-i", clip, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-t", total.toFixed(2), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out],
      dir,
    );
    const notes: string[] = [];
    if (format === "short" && total > 180) notes.push(`The video is ${Math.round(total)}s; YouTube only treats videos of 3 minutes or less as Shorts.`);
    log.info("Clip wrapped", { file: out, seconds: Math.round(total) });
    return { file: out, durationSec: Math.round(total * 10) / 10, scenes: 2, notes };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Where rendered videos are stored: next to the database. */
export function videosDir(dataFile: string): string {
  return path.join(path.dirname(dataFile), "videos");
}
