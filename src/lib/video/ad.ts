import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Brand, Format } from "../schemas";
import { logger } from "../logger";
import { newId } from "../util";
import { cleanText, ffmpegBinary, probeClip, VERTICAL, wrap, type RenderResult } from "./maker";
import type { Caption } from "./subtitles";

const log = logger("video-ad");

/**
 * Advert style for the Video Maker: a short, animated, branded edit around one
 * clip (usually a mascot or presenter that speaks).
 *
 *   1. Hook   – logo pops in, headline slides in line by line, gold underline sweeps.
 *   2. Clip   – the clip in a gold-framed card; optionally a phone mock-up beside it
 *               cycling through real app screens; messages that change above it;
 *               subtitles of what is said; a pulsing call-to-action button.
 *   3. Outro  – logo pops in, CTA button, website, a note, chime.
 *
 * Three sizes from the same content: 9:16 (Reels, Shorts, Stories), 1:1 (feeds),
 * 16:9 (YouTube, LinkedIn). Light theme with brand green and gold, generated sound
 * effects, optional music that ducks under speech, mastered to about −16 LUFS.
 */

export type Aspect = "9:16" | "1:1" | "16:9";
export const ASPECTS: Aspect[] = ["9:16", "1:1", "16:9"];
export const ASPECT_LABEL: Record<Aspect, string> = { "9:16": "Vertical 9:16 (Reels, Shorts, Stories)", "1:1": "Square 1:1 (Instagram/Facebook/LinkedIn feed)", "16:9": "Wide 16:9 (YouTube, LinkedIn, website)" };

export function aspectFor(format: Format): Aspect {
  return VERTICAL.includes(format) ? "9:16" : format === "long-video" ? "16:9" : "1:1";
}

export interface AdContent {
  headline: string;
  cta: string;
  /** Small line on the end card, e.g. "Available on Android". */
  footnote?: string;
  /** Short messages shown one after another above the clip (replaces the static headline there). */
  beats?: string[];
  /** Silence the clip's own sound (e.g. its narration is off-message); music carries the advert. */
  muteClip?: boolean;
  /** Real app screens shown in a phone beside the clip, one after another: image paths, or "video.mp4@12.5" for a video from 12.5 s. */
  appScreens?: string[];
  /** Timed subtitles of what the clip says (times relative to the clip's start). */
  captions?: Caption[];
}

export interface AdOptions {
  outDir: string;
  musicFile?: string;
  aspect?: Aspect;
  ffmpegPath?: string;
}

export const AD_COLORS = { green: "0x0B3C04", gold: "0xBD7D05", ink: "0x1B1B1B", bg0: "0xFFFFFF", bg1: "0xE3F1E5" } as const;

export const FONT_BLACK = ["C:/Windows/Fonts/seguibl.ttf", "C:/Windows/Fonts/ariblk.ttf", "C:/Windows/Fonts/arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"];
export const FONT_BOLD = ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"];
export const FONT_REG = ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"];
export const pick = (list: string[]) => list.find((f) => existsSync(f));
export const ffPath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

function run(bin: string, args: string[], cwd: string, capture = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => capture && out.push(d));
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`))));
  });
}

/* ------------------------------------------------------------------ */
/* Layout presets                                                      */
/* ------------------------------------------------------------------ */

interface Box {
  top: number;
  bottom: number;
  /** Horizontal centre of the text column. */
  cx: number;
  /** Column width (for wrapping). */
  width: number;
}

interface Layout {
  W: number;
  H: number;
  hook: { logoW: number; logoY: number; size: number; wrap: number; centerY: number; underline: number };
  clip: {
    logo: { w: number; cx: number; y: number };
    text: Box & { size: number; wrap: number };
    media: { left: number; right: number; top: number; bottom: number };
    caption: { cx: number; y: number; size: number; wrap: number };
    cta: { cx: number; y: number; size: number };
    site: { cx: number; y: number; size: number } | null;
  };
  outro: { logoW: number; logoY: number; gap: number; cta: number; site: number; foot: number };
}

export function layoutFor(aspect: Aspect): Layout {
  if (aspect === "1:1") {
    return {
      W: 1080, H: 1080,
      hook: { logoW: 620, logoY: 80, size: 88, wrap: 18, centerY: 640, underline: 380 },
      clip: {
        logo: { w: 300, cx: 540, y: 22 },
        text: { top: 160, bottom: 250, cx: 540, width: 1000, size: 50, wrap: 34 },
        media: { left: 40, right: 1040, top: 264, bottom: 790 },
        caption: { cx: 540, y: 806, size: 40, wrap: 40 },
        cta: { cx: 540, y: 962, size: 40 },
        site: null,
      },
      outro: { logoW: 720, logoY: 170, gap: 70, cta: 44, site: 52, foot: 36 },
    };
  }
  if (aspect === "16:9") {
    return {
      W: 1920, H: 1080,
      hook: { logoW: 660, logoY: 80, size: 96, wrap: 30, centerY: 640, underline: 520 },
      clip: {
        logo: { w: 440, cx: 480, y: 70 },
        text: { top: 300, bottom: 640, cx: 480, width: 800, size: 72, wrap: 20 },
        media: { left: 900, right: 1860, top: 70, bottom: 880 },
        caption: { cx: 1380, y: 905, size: 42, wrap: 44 },
        cta: { cx: 480, y: 720, size: 46 },
        site: { cx: 480, y: 850, size: 38 },
      },
      outro: { logoW: 900, logoY: 130, gap: 70, cta: 48, site: 56, foot: 38 },
    };
  }
  return {
    W: 1080, H: 1920,
    hook: { logoW: 760, logoY: 230, size: 106, wrap: 16, centerY: 1000, underline: 460 },
    clip: {
      logo: { w: 430, cx: 540, y: 110 },
      text: { top: 340, bottom: 540, cx: 540, width: 1000, size: 74, wrap: 20 },
      media: { left: 40, right: 1040, top: 570, bottom: 1440 },
      caption: { cx: 540, y: 1468, size: 52, wrap: 28 },
      cta: { cx: 540, y: 1660, size: 50 },
      site: { cx: 540, y: 1790, size: 40 },
    },
    outro: { logoW: 860, logoY: 560, gap: 150, cta: 50, site: 64, foot: 42 },
  };
}

/** Where the clip card and (optional) phone sit inside the media area. */
export function placeMedia(L: Layout, clipW: number, clipH: number, withPhone: boolean) {
  const { left, right, top, bottom } = L.clip.media;
  const mw = right - left, mh = bottom - top, gap = 36;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (withPhone) {
    const phoneH = even(mh);
    const phoneW = even(phoneH * 0.4615);
    const cardS = even(Math.min(mh * 0.74, mw - phoneW - gap));
    const groupW = cardS + gap + phoneW;
    const x0 = Math.round(left + (mw - groupW) / 2);
    return { card: { x: x0, y: Math.round(top + (mh - cardS) / 2), w: cardS, h: cardS, square: true }, phone: { x: x0 + cardS + gap, y: top, w: phoneW, h: phoneH } };
  }
  const scale = Math.min(mw / clipW, mh / clipH);
  const w = even(clipW * scale), h = even(clipH * scale);
  return { card: { x: Math.round(left + (mw - w) / 2), y: Math.round(top + (mh - h) / 2), w, h, square: false }, phone: null };
}

/* ------------------------------------------------------------------ */
/* Logo preparation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Trims the logo to its content and, if it has no transparency (e.g. a JPEG
 * on white), makes the white background transparent. Returns a PNG path and its size.
 */
export async function prepareLogo(ff: string, logo: string, dir: string): Promise<{ file: string; w: number; h: number }> {
  const { width: W, height: H } = await probeClip(ff, logo);
  const raw = await run(ff, ["-loglevel", "error", "-i", logo, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], dir, true);
  let hasAlpha = false;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = raw[i + 3]!;
      if (a < 250) hasAlpha = true;
      if (a > 40 && raw[i]! + raw[i + 1]! + raw[i + 2]! < 700) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("The logo looks empty (all white or transparent).");
  const pad = 6;
  const cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad);
  const cw = Math.min(W - cx, maxX - minX + 1 + pad * 2), ch = Math.min(H - cy, maxY - minY + 1 + pad * 2);
  const file = path.join(dir, "logo.png");
  const key = hasAlpha ? "" : ",colorkey=0xFFFFFF:0.10:0.08";
  await run(ff, ["-y", "-loglevel", "error", "-i", logo, "-frames:v", "1", "-vf", `crop=${cw}:${ch}:${cx}:${cy},format=rgba${key}`, file], dir);
  return { file, w: cw, h: ch };
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

/** Ease-out cubic from 0→1 between t0 and t0+d, as an ffmpeg expression. */
const ease = (t0: number, d: number) => `(1-pow(1-min(1,max(0,(t-${t0})/${d})),3))`;
/** Pop: 0 → 1.08 → 1, starting at t0. */
const pop = (t0: number) => `if(lt(t,${t0}),0.001,if(lt(t,${t0 + 0.42}),1.08*${ease(t0, 0.42)},if(lt(t,${t0 + 0.62}),1.08-0.08*(t-${t0 + 0.42})/0.2,1)))`;
const fadeIn = (t0: number, d = 0.3) => `alpha='min(1,max(0,(t-${t0})/${d}))'`;

export interface TextLine {
  file: string;
  text: string;
}

/**
 * Wraps into the fewest lines that fit `width`, then evens them out, so a headline
 * never ends with one word alone ("Climate action starts with / you").
 */
export function balancedWrap(text: string, width: number): string[] {
  const first = wrap(text, width).split("\n").filter(Boolean);
  if (first.length < 2) return first;
  for (let w = Math.ceil(text.length / first.length); w < width; w++) {
    const t = wrap(text, w).split("\n").filter(Boolean);
    if (t.length === first.length) return t;
  }
  return first;
}

export async function lines(dir: string, prefix: string, text: string, width: number): Promise<TextLine[]> {
  const ls = balancedWrap(text, width);
  const out: TextLine[] = [];
  for (const [i, l] of ls.entries()) {
    const file = `${prefix}${i}.txt`;
    await writeFile(path.join(dir, file), l, "utf8");
    out.push({ file, text: l });
  }
  return out;
}

/** One drawtext per line, centred on `cx` (this ffmpeg can't centre multi-line text), sliding in with a stagger. */
function kinetic(ls: TextLine[], o: { font: string; size: number; color: string; top: number; cx: number; t0: number; stagger: number; slide: number }): string[] {
  const lh = Math.round(o.size * 1.16);
  return ls.map((l, i) => {
    const t0 = o.t0 + i * o.stagger;
    const dir = i % 2 === 0 ? -1 : 1;
    return `drawtext=fontfile='${ffPath(o.font)}':textfile=${l.file}:fontcolor=${o.color}:fontsize=${o.size}:x='${o.cx}-text_w/2+${dir * o.slide}*(1-${ease(t0, 0.45)})':y=${o.top + i * lh}:${fadeIn(t0)}`;
  });
}

/** Largest size (≤ max) at which `n` lines fit into `height`. */
export const fit = (max: number, n: number, height: number) => Math.max(26, Math.min(max, Math.floor(height / (n * 1.16))));

const SFX = {
  whoosh: (d = 0.7) => `anoisesrc=color=pink:amplitude=0.6:d=${d}:r=44100,bandpass=f=1400:width_type=o:w=2.5,afade=t=in:d=${(d * 0.45).toFixed(2)},afade=t=out:st=${(d * 0.45).toFixed(2)}:d=${(d * 0.55).toFixed(2)},volume=0.55`,
  pop: () => `aevalsrc='0.55*sin(2*PI*(420+900*exp(-28*t))*t)*exp(-11*t)':d=0.4:s=44100`,
  chime: () => `aevalsrc='0.45*(sin(2*PI*880*t)+0.8*sin(2*PI*1108.73*t)+0.6*sin(2*PI*1318.51*t))*exp(-3.2*t)':d=1.6:s=44100`,
};

/**
 * Soft brand gradient with three translucent circles drifting slowly behind
 * everything (bg.mp4 in `dir`). Circles are drawn once, then only moved.
 */
async function renderBackground(ff: string, dir: string, W: number, H: number, seconds: number): Promise<void> {
  const circle = async (name: string, size: number, color: string, alpha: number) => {
    const [r, g, b] = [parseInt(color.slice(2, 4), 16), parseInt(color.slice(4, 6), 16), parseInt(color.slice(6, 8), 16)];
    const R = size / 2;
    await run(ff, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black@0:s=${size}x${size},format=rgba,geq=r=${r}:g=${g}:b=${b}:a='${Math.round(alpha * 255)}*clip((${R}-hypot(X-${R},Y-${R}))/3,0,1)'`, "-frames:v", "1", name], dir);
  };
  const base = Math.min(W, H);
  const big = Math.round(base * 0.9), mid = Math.round(base * 0.5), small = Math.round(base * 0.28);
  await circle("c1.png", big, AD_COLORS.green, 0.07);
  await circle("c2.png", mid, AD_COLORS.gold, 0.1);
  await circle("c3.png", small, AD_COLORS.green, 0.1);
  const d = seconds.toFixed(2);
  const graph = [
    `[0:v][1:v]overlay=x='-${Math.round(big * 0.35)}+60*sin(2*PI*t/11)':y='-${Math.round(big * 0.3)}+80*cos(2*PI*t/13)':eval=frame[a]`,
    `[a][2:v]overlay=x='W-${Math.round(mid * 0.7)}+70*cos(2*PI*t/9)':y='H*0.62+90*sin(2*PI*t/10)':eval=frame[b]`,
    `[b][3:v]overlay=x='W*0.08+50*sin(2*PI*t/7)':y='H*0.8+60*cos(2*PI*t/8)':eval=frame,format=yuv420p[v]`,
  ].join(";");
  await run(
    ff,
    ["-y", "-loglevel", "error", "-f", "lavfi", "-t", d, "-i", `gradients=s=${W}x${H}:c0=${AD_COLORS.bg0}:c1=${AD_COLORS.bg1}:x0=0:y0=0:x1=${W}:y1=${H}:speed=0.006:r=30`, "-loop", "1", "-t", d, "-i", "c1.png", "-loop", "1", "-t", d, "-i", "c2.png", "-loop", "1", "-t", d, "-i", "c3.png", "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", "30", "bg.mp4"],
    dir,
  );
}

/** Rounded-corner phone frame (dark bezel, transparent screen) and the matching outline mask. */
export async function renderPhoneFrame(ff: string, dir: string, w: number, h: number): Promise<{ bezel: number }> {
  const r = Math.round(w * 0.13);
  const b = Math.round(w * 0.045);
  const ri = r - b;
  const inside = (x: string, y: string, ww: string, hh: string, rr: number) => `lte(pow(max(max(${rr}-(${x}),(${x})-(${ww}-1-${rr})),0),2)+pow(max(max(${rr}-(${y}),(${y})-(${hh}-1-${rr})),0),2),${rr * rr})`;
  const outer = inside("X", "Y", "W", "H", r);
  const screen = `(gte(X,${b})*gte(Y,${b})*lte(X,W-1-${b})*lte(Y,H-1-${b})*${inside(`X-${b}`, `Y-${b}`, `W-${2 * b}`, `H-${2 * b}`, ri)})`;
  await run(ff, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black@0:s=${w}x${h},format=rgba,geq=r=16:g=20:b=24:a='255*${outer}*(1-${screen})'`, "-frames:v", "1", "phone-frame.png"], dir);
  await run(ff, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${w}x${h},format=gray,geq=lum='255*${outer}'`, "-frames:v", "1", "phone-mask.png"], dir);
  await run(ff, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black@0:s=${w}x${h},format=rgba,geq=r=0:g=0:b=0:a='46*${outer}'`, "-frames:v", "1", "phone-shadow.png"], dir);
  return { bezel: b };
}

/** "file" or "video.mp4@12.5" → path and start time. */
export function parseScreen(s: string): { file: string; start: number | null } {
  const m = s.trim().replace(/^"|"$/g, "").match(/^(.*?\.(?:mp4|mov|m4v|webm))@(\d+(?:\.\d+)?)$/i);
  return m ? { file: m[1]!, start: Number(m[2]) } : { file: s.trim().replace(/^"|"$/g, ""), start: null };
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

export async function renderAd(brand: Brand, format: Format, clip: string, content: AdContent, opts: AdOptions): Promise<RenderResult> {
  if (!existsSync(clip)) throw new Error(`Clip not found: ${clip}`);
  if (/\.(jpe?g|png|webp)$/i.test(clip)) throw new Error("The advert style needs a video clip, not an image.");
  const headline = cleanText(content.headline);
  const cta = cleanText(content.cta);
  if (!headline) throw new Error("Add a hook/title for the advert headline.");
  if (/\[[^\]]{3,}\]/.test(headline + cta)) throw new Error("Fill in the [bracketed] parts of the hook and CTA first.");
  if (opts.musicFile && !existsSync(opts.musicFile)) throw new Error(`Music file not found: ${opts.musicFile}`);
  const screens = (content.appScreens ?? []).map(parseScreen).filter((s) => s.file);
  for (const s of screens) if (!existsSync(s.file)) throw new Error(`App screen not found: ${s.file}`);
  const ff = opts.ffmpegPath ?? ffmpegBinary();
  const fBlack = pick(FONT_BLACK), fBold = pick(FONT_BOLD), fReg = pick(FONT_REG) ?? fBold;
  if (!fBlack || !fBold) throw new Error("No bold font found for the advert text.");

  const aspect = opts.aspect ?? aspectFor(format);
  const L = layoutFor(aspect);
  const { W, H } = L;
  const C = AD_COLORS;
  const site = brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const footnote = cleanText(content.footnote ?? "");
  const notes: string[] = [];
  const dir = await mkdtemp(path.join(tmpdir(), "sga-ad-"));
  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-r", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "160k"];
  // Each part takes its slice of one shared moving background, so the motion is continuous.
  const bg = (d: number, start: number) => ["-ss", start.toFixed(2), "-t", d.toFixed(2), "-i", "bg.mp4"];

  try {
    let logo: { file: string; w: number; h: number } | null = null;
    if (brand.logoFile && existsSync(brand.logoFile)) logo = await prepareLogo(ff, brand.logoFile, dir);
    else notes.push("No logo set for this brand (Settings → Logo file), so the brand name is shown as text.");
    await writeFile(path.join(dir, "brand.txt"), cleanText(brand.name), "utf8");
    // Logo width for a target width, limited so a tall/square logo doesn't take over the frame.
    const logoW = (target: number) => (logo ? Math.min(target, Math.round((target / 2.2) * (logo.w / logo.h))) : 0);
    const logoH = (w: number) => (logo ? Math.round((w * logo.h) / logo.w) : 0);

    const hookSec = 3.0;
    const outroSec = 3.8;
    const clipInfo = await probeClip(ff, clip);
    if (clipInfo.seconds < 0.5) throw new Error(`${path.basename(clip)} doesn't look like a video (no length).`);
    await renderBackground(ff, dir, W, H, hookSec + clipInfo.seconds + outroSec + 1);

    /* ---------- 1. Hook ---------- */
    {
      const P = L.hook;
      const hl = await lines(dir, "h", headline, P.wrap);
      const size = hl.length > 3 ? Math.round(P.size * 0.87) : P.size;
      const lw1 = logoW(P.logoW), lh1 = logoH(lw1);
      const top = Math.round(P.centerY - (hl.length * size * 1.16) / 2);
      const underlineY = top + hl.length * Math.round(size * 1.16) + 26;
      const inputs = [...bg(hookSec, 0)];
      if (logo) inputs.push("-loop", "1", "-t", hookSec.toFixed(2), "-i", logo.file);
      inputs.push("-f", "lavfi", "-t", hookSec.toFixed(2), "-i", `color=c=${C.gold}:s=${P.underline}x14:r=30`);
      const ul = logo ? 2 : 1;
      inputs.push("-f", "lavfi", "-i", SFX.pop(), "-f", "lavfi", "-i", SFX.whoosh(0.7));
      const v: string[] = [];
      if (logo) {
        v.push(`[1:v]format=rgba,scale=w='max(2,${lw1}*${pop(0.05)})':h=-1:eval=frame[lg]`, `[0:v][lg]overlay=x=(W-w)/2:y=${P.logoY}+(${lh1}-h)/2:eval=frame:format=auto[v1]`);
      } else {
        v.push(`[0:v]drawtext=fontfile='${ffPath(fBlack)}':textfile=brand.txt:fontcolor=${C.green}:fontsize=${Math.round(P.size * 0.85)}:x=(w-text_w)/2:y=${P.logoY + 60}:${fadeIn(0.05)}[v1]`);
      }
      v.push(`[v1]${kinetic(hl, { font: fBlack, size, color: C.green, top, cx: W / 2, t0: 0.35, stagger: 0.13, slide: 140 }).join(",")}[v2]`);
      v.push(`[v2][${ul}:v]overlay=x='-${P.underline}+((W+${P.underline})/2)*${ease(0.35 + hl.length * 0.13 + 0.15, 0.5)}':y=${underlineY}:eval=frame:shortest=1,format=yuv420p[v]`);
      const a = `[${ul + 1}:a]adelay=50|50[p];[${ul + 2}:a]adelay=300|300[w];[p][w]amix=inputs=2:normalize=0,apad=whole_dur=${hookSec},atrim=0:${hookSec}[a]`;
      await run(ff, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `${v.join(";")};${a}`, "-map", "[v]", "-map", "[a]", "-t", hookSec.toFixed(2), ...enc, "seg1.mp4"], dir);
    }

    /* ---------- 2. Clip (+ phone, messages, subtitles) ---------- */
    const clipSec = clipInfo.seconds;
    {
      const P = L.clip;
      const frame = 8;
      const place = placeMedia(L, clipInfo.width, clipInfo.height, screens.length > 0);
      const lw2 = logoW(P.logo.w), lh2 = logoH(lw2);
      await writeFile(path.join(dir, "cta.txt"), ` ${cta} `, "utf8");
      await writeFile(path.join(dir, "site.txt"), site, "utf8");

      const inputs = [...bg(clipSec, hookSec), "-i", clip];
      let next = 2;
      const iLogo = logo ? next++ : -1;
      if (logo) inputs.push("-loop", "1", "-t", clipSec.toFixed(2), "-i", logo.file);
      const iBar = next++;
      inputs.push("-f", "lavfi", "-t", clipSec.toFixed(2), "-i", `color=c=${C.gold}:s=${W}x10:r=30`);
      let iFrame = -1, iMask = -1, iShadow = -1;
      const iScreens: number[] = [];
      const slot = screens.length ? clipSec / screens.length : 0;
      if (place.phone) {
        await renderPhoneFrame(ff, dir, place.phone.w, place.phone.h);
        iFrame = next++;
        inputs.push("-loop", "1", "-t", clipSec.toFixed(2), "-i", "phone-frame.png");
        iMask = next++;
        inputs.push("-loop", "1", "-t", clipSec.toFixed(2), "-i", "phone-mask.png");
        iShadow = next++;
        inputs.push("-loop", "1", "-t", clipSec.toFixed(2), "-i", "phone-shadow.png");
        for (const [k, s] of screens.entries()) {
          iScreens.push(next++);
          if (s.start !== null) inputs.push("-ss", s.start.toFixed(2), "-t", (slot + 0.5).toFixed(2), "-i", s.file);
          else inputs.push("-loop", "1", "-t", clipSec.toFixed(2), "-i", s.file);
          void k;
        }
      }

      const z = `(1+0.05*t/${clipSec.toFixed(2)})`;
      const c = place.card;
      const crop = c.square ? `crop='min(iw,ih)':'min(iw,ih)',` : "";
      const v: string[] = [
        // Slow zoom inside the card, a gold frame and a soft shadow; the card slides up into place.
        `[1:v]fps=30,${crop}scale=w='${c.w}*${z}':h='${c.h}*${z}':eval=frame,crop=${c.w}:${c.h},setsar=1,pad=${c.w + frame * 2}:${c.h + frame * 2}:${frame}:${frame}:color=${C.gold}[card]`,
        `[0:v]drawbox=x=${c.x - frame + 14}:y=${c.y - frame + 22}:w=${c.w + frame * 2}:h=${c.h + frame * 2}:color=black@0.14:t=fill[bgs]`,
        `[bgs][card]overlay=x=${c.x - frame}:y='${c.y - frame}+380*(1-${ease(0, 0.6)})':eval=frame:shortest=1[v1]`,
      ];
      let cur = "[v1]";
      if (place.phone) {
        const ph = place.phone;
        const b = Math.round(ph.w * 0.045);
        const sw = ph.w - 2 * b, sh = ph.h - 2 * b;
        // Screens one after another (each fades in), inside a black screen, then the bezel and rounded outline.
        v.push(`color=c=black:s=${ph.w}x${ph.h}:r=30:d=${clipSec.toFixed(2)},format=rgba[ps0]`);
        let ps = "[ps0]";
        screens.forEach((s, k) => {
          const st = k * slot;
          const timing = s.start !== null ? `,setpts=PTS-STARTPTS+${st.toFixed(3)}/TB` : "";
          v.push(`[${iScreens[k]}:v]fps=30,scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},setsar=1,format=rgba${timing},fade=t=in:st=${st.toFixed(2)}:d=0.35:alpha=1[sc${k}]`);
          v.push(`${ps}[sc${k}]overlay=x=${b}:y=${b}:enable='between(t,${st.toFixed(2)},${(st + slot + 0.4).toFixed(2)})':eof_action=pass[ps${k + 1}]`);
          ps = `[ps${k + 1}]`;
        });
        v.push(`${ps}[${iFrame}:v]overlay=0:0[pf]`, `[${iMask}:v]format=gray[pm]`, `[pf][pm]alphamerge[phone]`);
        // Shadow, then the phone sliding in from the side.
        v.push(`${cur}[${iShadow}:v]overlay=x='${ph.x + 16}+${W}*(1-${ease(0.15, 0.7)})':y=${ph.y + 22}:eval=frame[v1s]`);
        v.push(`[v1s][phone]overlay=x='${ph.x}+${W}*(1-${ease(0.15, 0.7)})':y=${ph.y}:eval=frame:shortest=1[v1p]`);
        cur = "[v1p]";
      }
      if (logo) {
        v.push(`[${iLogo}:v]format=rgba,scale=${lw2}:-1[lg]`, `${cur}[lg]overlay=x=${Math.round(P.logo.cx - lw2 / 2)}:y=${P.logo.y}:format=auto[v2]`);
        cur = "[v2]";
      }

      // Above the card: the headline, or the messages one after another.
      const beats = (content.beats ?? []).map(cleanText).filter(Boolean);
      const T = P.text;
      const textTop = Math.max(T.top, logo ? P.logo.y + lh2 + 24 : T.top);
      const areaH = T.bottom - textTop;
      const parts: string[] = [];
      const groups = beats.length ? beats : [headline];
      const bSlot = clipSec / groups.length;
      for (const [bi, beat] of groups.entries()) {
        const bl = await lines(dir, `b${bi}_`, beat, T.wrap);
        const size = fit(T.size, bl.length, areaH);
        const lh = Math.round(size * 1.16);
        const top = Math.round(textTop + (areaH - bl.length * lh) / 2);
        const s0 = bi * bSlot, s1 = (bi + 1) * bSlot;
        for (const [li, l] of bl.entries()) {
          const t0 = s0 + 0.1 + li * 0.1;
          const dir2 = (bi + li) % 2 === 0 ? -1 : 1;
          const color = beats.length && bi === groups.length - 1 ? C.gold : C.green;
          const out = beats.length ? `min((t-${t0.toFixed(2)})/0.3,(${s1.toFixed(2)}-t)/0.25)` : `(t-${t0.toFixed(2)})/0.3`;
          parts.push(`drawtext=fontfile='${ffPath(fBlack)}':textfile=${l.file}:fontcolor=${color}:fontsize=${size}:x='${T.cx}-text_w/2+${dir2 * 110}*(1-${ease(t0, 0.4)})':y=${top + li * lh}:enable='between(t,${s0.toFixed(2)},${s1.toFixed(2)})':alpha='max(0,min(1,${out}))'`);
        }
      }

      // Subtitles: one box per caption line, gold when it carries a key word.
      const caps = content.captions ?? [];
      for (const [ci, cap] of caps.entries()) {
        const cl = await lines(dir, `cap${ci}_`, cleanText(cap.text), P.caption.wrap);
        const lh = Math.round(P.caption.size * 1.5);
        for (const [li, l] of cl.entries()) {
          parts.push(`drawtext=fontfile='${ffPath(fBold)}':textfile=${l.file}:fontcolor=white:fontsize=${P.caption.size}:box=1:boxcolor=${cap.highlight ? C.gold : `${C.green}@0.92`}:boxborderw=${Math.round(P.caption.size * 0.32)}:x=${P.caption.cx}-text_w/2:y=${P.caption.y + li * lh}:enable='between(t,${cap.start.toFixed(2)},${cap.end.toFixed(2)})'`);
        }
      }

      const ctaBox = Math.round(P.cta.size * 0.56);
      parts.push(`drawtext=fontfile='${ffPath(fBold)}':textfile=cta.txt:fontcolor=white:fontsize=${P.cta.size}:box=1:boxcolor=${C.gold}:boxborderw=${ctaBox}:x=${P.cta.cx}-text_w/2:y=${P.cta.y}:alpha='if(lt(t,0.7),0,0.82+0.18*sin(2*PI*1.1*(t-0.7)))'`);
      if (P.site) parts.push(`drawtext=fontfile='${ffPath(fReg!)}':textfile=site.txt:fontcolor=${C.ink}@0.75:fontsize=${P.site.size}:x=${P.site.cx}-text_w/2:y=${P.site.y}:${fadeIn(0.9)}`);
      parts.push(`drawbox=x=0:y=ih-10:w=iw:h=10:color=${C.green}@0.15:t=fill`);
      v.push(`${cur}${parts.join(",")}[v3]`, `[v3][${iBar}:v]overlay=x='-W+W*t/${clipSec.toFixed(2)}':y=H-10:eval=frame:shortest=1,format=yuv420p[v]`);

      // The clip's own sound, or silence when it's muted (music fills it later).
      const a = content.muteClip
        ? `anullsrc=r=44100:cl=stereo,atrim=0:${clipSec.toFixed(2)}[a]`
        : `[1:a]aresample=44100,aformat=channel_layouts=stereo,apad=whole_dur=${clipSec.toFixed(2)},atrim=0:${clipSec.toFixed(2)}[a]`;
      await run(ff, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `${v.join(";")};${a}`, "-map", "[v]", "-map", "[a]", "-t", clipSec.toFixed(2), ...enc, "seg2.mp4"], dir);
    }

    /* ---------- 3. Outro ---------- */
    {
      const P = L.outro;
      const lw3 = logoW(P.logoW), lh3 = logoH(lw3);
      const below = logo ? P.logoY + lh3 : P.logoY + 120;
      await writeFile(path.join(dir, "cta2.txt"), ` ${cta} `, "utf8");
      await writeFile(path.join(dir, "site2.txt"), site, "utf8");
      await writeFile(path.join(dir, "foot.txt"), footnote, "utf8");
      await writeFile(path.join(dir, "tag.txt"), cleanText(brand.tagline).toUpperCase(), "utf8");
      const inputs = [...bg(outroSec, hookSec + clipSec)];
      if (logo) inputs.push("-loop", "1", "-t", outroSec.toFixed(2), "-i", logo.file);
      inputs.push("-f", "lavfi", "-i", SFX.chime(), "-f", "lavfi", "-i", SFX.pop());
      const aChime = logo ? 2 : 1, aPop = aChime + 1;
      const v: string[] = [];
      if (logo) {
        v.push(`[1:v]format=rgba,scale=w='max(2,${lw3}*${pop(0.05)})':h=-1:eval=frame[lg]`, `[0:v][lg]overlay=x=(W-w)/2:y=${P.logoY}+(${lh3}-h)/2:eval=frame:format=auto[v2]`);
      } else {
        v.push(`[0:v]drawtext=fontfile='${ffPath(fBlack)}':textfile=brand.txt:fontcolor=${C.green}:fontsize=${Math.round(P.site * 1.8)}:x=(w-text_w)/2:y=${P.logoY}:${fadeIn(0.05)}[v2]`);
      }
      const tag = !logo && brand.tagline ? `drawtext=fontfile='${ffPath(fBold)}':textfile=tag.txt:fontcolor=${C.gold}:fontsize=${Math.round(P.cta * 0.85)}:x=(w-text_w)/2:y=${below + 30}:${fadeIn(0.4)},` : "";
      const base = below + P.gap;
      const siteY = base + Math.round(P.cta * 2.2) + 30;
      v.push(
        `[v2]${tag}drawtext=fontfile='${ffPath(fBold)}':textfile=cta2.txt:fontcolor=white:fontsize=${P.cta}:box=1:boxcolor=${C.gold}:boxborderw=${Math.round(P.cta * 0.56)}:x=(w-text_w)/2:y='${base}+60*(1-${ease(0.6, 0.45)})':alpha='if(lt(t,0.6),0,if(lt(t,1.1),(t-0.6)/0.5,0.85+0.15*sin(2*PI*1.1*(t-1.1))))',` +
          `drawtext=fontfile='${ffPath(fBlack)}':textfile=site2.txt:fontcolor=${C.green}:fontsize=${P.site}:x=(w-text_w)/2:y=${siteY}:${fadeIn(0.95)}` +
          (footnote ? `,drawtext=fontfile='${ffPath(fReg!)}':textfile=foot.txt:fontcolor=${C.ink}@0.7:fontsize=${P.foot}:x=(w-text_w)/2:y=${siteY + Math.round(P.site * 1.5)}:${fadeIn(1.15)}` : "") +
          `,format=yuv420p[v]`,
      );
      const a = `[${aChime}:a]adelay=80|80[c];[${aPop}:a]adelay=600|600[p];[c][p]amix=inputs=2:normalize=0,apad=whole_dur=${outroSec},atrim=0:${outroSec}[a]`;
      await run(ff, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `${v.join(";")};${a}`, "-map", "[v]", "-map", "[a]", "-t", outroSec.toFixed(2), ...enc, "seg3.mp4"], dir);
    }

    /* ---------- Join with transitions (+ optional music) ---------- */
    const T = 0.45;
    const off1 = hookSec - T;
    const off2 = hookSec + clipSec - 2 * T;
    const total = hookSec + clipSec + outroSec - 2 * T;
    const inputs = ["-i", "seg1.mp4", "-i", "seg2.mp4", "-i", "seg3.mp4"];
    let graph =
      `[0:v]settb=AVTB,fps=30[s0];[1:v]settb=AVTB,fps=30[s1];[2:v]settb=AVTB,fps=30[s2];` +
      `[s0][s1]xfade=transition=smoothup:duration=${T}:offset=${off1.toFixed(3)}[x1];[x1][s2]xfade=transition=circleopen:duration=${T}:offset=${off2.toFixed(3)},format=yuv420p[v];` +
      `[0:a][1:a]acrossfade=d=${T}[a1];[a1][2:a]acrossfade=d=${T}[mix]`;
    if (opts.musicFile) {
      inputs.push("-stream_loop", "-1", "-i", opts.musicFile);
      // Music levelled, then automatically ducked whenever the clip speaks (sidechain on the clip/effects mix),
      // so it fills the intro, pauses and end card and steps back under the voice. Muted clip: music plays fully.
      const music = `[3:a]aresample=44100,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(2)},loudnorm=I=-20:TP=-2:LRA=11,aresample=44100,volume=0.9,afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2`;
      graph += content.muteClip
        ? `;${music}[m];[mix][m]amix=inputs=2:normalize=0:duration=first[pre]`
        : `;${music}[m];[mix]asplit=2[voice][key];[m][key]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450:makeup=1[duck];[voice][duck]amix=inputs=2:normalize=0:duration=first[pre]`;
    } else {
      graph += `;[mix]anull[pre]`;
    }
    // Final loudness for social platforms (about -16 LUFS), whatever the music or clip.
    graph += `;[pre]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[a]`;
    await mkdir(opts.outDir, { recursive: true });
    const out = path.join(opts.outDir, `${newId("video")}.mp4`);
    await run(ff, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", ...enc, "-movflags", "+faststart", out], dir);

    if (format === "short" && aspect === "9:16" && total > 180) notes.push(`The video is ${Math.round(total)}s; YouTube only treats videos of 3 minutes or less as Shorts.`);
    if (!opts.musicFile) notes.push(content.muteClip ? "The clip is muted and there's no music, so the advert is silent apart from sound effects. Add a music file." : "No background music added. For a fuller advert, add a royalty-free track (for example from the YouTube Audio Library) as the music file.");
    log.info("Advert rendered", { file: out, aspect, seconds: Math.round(total), screens: screens.length, captions: content.captions?.length ?? 0 });
    return { file: out, durationSec: Math.round(total * 10) / 10, scenes: 3, notes };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Cover image                                                         */
/* ------------------------------------------------------------------ */

/**
 * A branded cover / thumbnail (PNG): logo, the headline, and a still of the clip
 * in the gold frame. 9:16 for Reels/Shorts covers, 1:1 for feeds, 16:9 for YouTube.
 */
export async function renderCover(brand: Brand, aspect: Aspect, clip: string, headline: string, opts: { outDir: string; at?: number; ffmpegPath?: string }): Promise<string> {
  const ff = opts.ffmpegPath ?? ffmpegBinary();
  const fBlack = pick(FONT_BLACK);
  if (!fBlack) throw new Error("No bold font found for the cover text.");
  const L = layoutFor(aspect);
  const { W, H } = L;
  const dir = await mkdtemp(path.join(tmpdir(), "sga-cover-"));
  try {
    const info = await probeClip(ff, clip);
    const at = Math.min(Math.max(0, opts.at ?? info.seconds * 0.3), Math.max(0, info.seconds - 0.1));
    let logo: { file: string; w: number; h: number } | null = null;
    if (brand.logoFile && existsSync(brand.logoFile)) logo = await prepareLogo(ff, brand.logoFile, dir);
    const wide = aspect === "16:9";
    const logoTarget = wide ? 560 : aspect === "1:1" ? 520 : 720;
    const lw = logo ? Math.min(logoTarget, Math.round((logoTarget / 2.2) * (logo.w / logo.h))) : 0;
    const lh = logo ? Math.round((lw * logo.h) / logo.w) : 0;
    const textCx = wide ? 500 : W / 2;
    const textTop = wide ? 120 + lh + 50 : (aspect === "1:1" ? 50 : 120) + lh + 50;
    const textW = wide ? 18 : aspect === "1:1" ? 18 : 14;
    const ls = await lines(dir, "t", cleanText(headline), textW);
    const size = fit(wide ? 104 : aspect === "1:1" ? 92 : 120, ls.length, wide ? 520 : aspect === "1:1" ? 300 : 560);
    const lhT = Math.round(size * 1.16);
    // Keep the still below the headline and its underline; shrink it if the headline is long.
    const textBottom = textTop + ls.length * lhT + 34;
    let stillS = wide ? 820 : aspect === "1:1" ? 470 : 760;
    let stillY = wide ? Math.round((H - stillS) / 2) : H - stillS - (aspect === "1:1" ? 50 : 160);
    if (!wide && stillY < textBottom + 40) {
      stillY = textBottom + 40;
      stillS = Math.min(stillS, H - stillY - 40);
    }
    const stillX = wide ? 1000 : Math.round((W - stillS) / 2);
    const v = [
      `[1:v]crop='min(iw,ih)':'min(iw,ih)',scale=${stillS}:${stillS},setsar=1,pad=${stillS + 16}:${stillS + 16}:8:8:color=${AD_COLORS.gold}[st]`,
      `[0:v]drawbox=x=${stillX + 6}:y=${stillY + 14}:w=${stillS + 16}:h=${stillS + 16}:color=black@0.14:t=fill[b0]`,
      `[b0][st]overlay=${stillX - 8}:${stillY - 8}[b1]`,
    ];
    let cur = "[b1]";
    if (logo) {
      v.push(`[2:v]format=rgba,scale=${lw}:-1[lg]`, `${cur}[lg]overlay=x=${Math.round(textCx - lw / 2)}:y=${wide ? 120 : aspect === "1:1" ? 50 : 120}:format=auto[b2]`);
      cur = "[b2]";
    }
    const texts = ls.map((l, i) => `drawtext=fontfile='${ffPath(fBlack)}':textfile=${l.file}:fontcolor=${AD_COLORS.green}:fontsize=${size}:x=${textCx}-text_w/2:y=${textTop + i * lhT}`);
    v.push(`${cur}${texts.join(",")},drawbox=x=${Math.round(textCx - 180)}:y=${textTop + ls.length * lhT + 20}:w=360:h=14:color=${AD_COLORS.gold}:t=fill,format=rgb24[o]`);
    const inputs = ["-f", "lavfi", "-i", `gradients=s=${W}x${H}:c0=${AD_COLORS.bg0}:c1=${AD_COLORS.bg1}:x0=0:y0=0:x1=${W}:y1=${H}:d=1`, "-ss", at.toFixed(2), "-i", clip];
    if (logo) inputs.push("-i", logo.file);
    await mkdir(opts.outDir, { recursive: true });
    const out = path.join(opts.outDir, `${newId("cover")}.png`);
    await run(ff, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", v.join(";"), "-map", "[o]", "-frames:v", "1", out], dir);
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
