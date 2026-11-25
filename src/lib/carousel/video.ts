import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Brand, Platform } from "../schemas";
import { logger } from "../logger";
import { newId } from "../util";
import { cleanText, ffmpegBinary, probeClip } from "../video/maker";
import type { Slide } from "./maker";

const log = logger("carousel-video");

/**
 * The video version of a carousel: the slides one after another, each with a
 * slow zoom, joined by swipe transitions with a whoosh, over music (ducking is
 * not needed: there is no speech). Vertical slides make a Reel / Short.
 */

export const SWIPE = 0.45;

/** Seconds on screen per slide: cover 2.6 s, closing 3.6 s, content slides by amount of text (2.6–4.6 s). */
export function slideDurations(slides: Slide[]): number[] {
  const content = slides.map((s) => Math.min(4.6, Math.max(2.6, 1.8 + (s.title.length + s.body.length) / 28)));
  return [2.6, ...content, 3.6];
}

function run(bin: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-3000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`))));
  });
}

export async function renderCarouselVideo(slideFiles: string[], durations: number[], opts: { outDir: string; musicFile?: string; ffmpegPath?: string }): Promise<{ file: string; durationSec: number }> {
  if (slideFiles.length < 2) throw new Error("A carousel video needs at least two slides.");
  if (durations.length !== slideFiles.length) throw new Error("One duration per slide is needed.");
  const ff = opts.ffmpegPath ?? ffmpegBinary();
  const { width: W, height: H } = await probeClip(ff, slideFiles[0]!);
  const dir = await mkdtemp(path.join(tmpdir(), "sga-carvid-"));
  try {
    const n = slideFiles.length;
    const inputs: string[] = [];
    // Each slide is held a little longer so the transition overlaps it.
    slideFiles.forEach((f, i) => inputs.push("-loop", "1", "-t", (durations[i]! + SWIPE).toFixed(2), "-i", f));
    const v: string[] = [];
    slideFiles.forEach((_, i) => {
      const d = durations[i]! + SWIPE;
      // Slow push-in (4%) on every slide.
      v.push(`[${i}:v]scale=w='${W}*(1+0.04*t/${d.toFixed(2)})':h='${H}*(1+0.04*t/${d.toFixed(2)})':eval=frame,crop=${W}:${H},setsar=1,fps=30,format=yuv420p,settb=AVTB[s${i}]`);
    });
    let cur = "[s0]";
    let offset = 0;
    for (let i = 1; i < n; i++) {
      offset += durations[i - 1]!;
      const out = i === n - 1 ? "[v]" : `[x${i}]`;
      // Each slide stream lasts its time + SWIPE, so the swipe to slide i starts when slide i-1's time is up.
      v.push(`${cur}[s${i}]xfade=transition=slideleft:duration=${SWIPE}:offset=${offset.toFixed(3)}${out}`);
      cur = out;
    }
    const total = durations.reduce((a, b) => a + b, 0) + SWIPE;
    // A whoosh at every swipe.
    const swipes = Array.from({ length: n - 1 }, (_, i) => durations.slice(0, i + 1).reduce((a, b) => a + b, 0));
    let next = n;
    const a: string[] = [];
    const whooshIn = next++;
    inputs.push("-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.5:d=0.6:r=44100,bandpass=f=1600:width_type=o:w=2.5,afade=t=in:d=0.25,afade=t=out:st=0.25:d=0.35,volume=0.5");
    a.push(`[${whooshIn}:a]asplit=${swipes.length}${swipes.map((_, i) => `[w${i}]`).join("")}`);
    swipes.forEach((t, i) => a.push(`[w${i}]adelay=${Math.round((t - 0.2) * 1000)}|${Math.round((t - 0.2) * 1000)}[wd${i}]`));
    a.push(`${swipes.map((_, i) => `[wd${i}]`).join("")}amix=inputs=${swipes.length}:normalize=0,apad=whole_dur=${total.toFixed(2)},atrim=0:${total.toFixed(2)}[fx]`);
    if (opts.musicFile) {
      const im = next++;
      inputs.push("-stream_loop", "-1", "-i", opts.musicFile);
      a.push(`[${im}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(2)},loudnorm=I=-18:TP=-2:LRA=11,aresample=44100,afade=t=out:st=${(total - 1.5).toFixed(2)}:d=1.5[m]`, `[m][fx]amix=inputs=2:normalize=0:duration=first[pre]`);
    } else {
      a.push(`[fx]anull[pre]`);
    }
    a.push(`[pre]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,aformat=channel_layouts=stereo[a]`);
    await mkdir(opts.outDir, { recursive: true });
    const out = path.join(opts.outDir, `${newId("video")}.mp4`);
    await run(ff, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", [...v, ...a].join(";"), "-map", "[v]", "-map", "[a]", "-t", total.toFixed(2), "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-r", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out], dir);
    log.info("Carousel video rendered", { slides: n, seconds: Math.round(total) });
    return { file: out, durationSec: Math.round(total * 10) / 10 };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Post text                                                           */
/* ------------------------------------------------------------------ */

/**
 * The post text for a carousel, written from its slides: hook, what each slide
 * covers, the call to action and where to find the brand. Platform-aware:
 * LinkedIn is plainer and numbered; Instagram/Facebook use light emoji.
 */
export function captionFromSlides(brand: Brand, platform: Platform, hook: string, slides: Slide[], cta: string): string {
  const titles = slides.map((s) => cleanText(s.title)).filter(Boolean);
  const site = brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const h = cleanText(hook);
  const c = cleanText(cta).replace(/[.!]$/, "");
  if (platform === "linkedin") {
    return [h, "", "In this carousel:", ...titles.map((t, i) => `${i + 1}. ${t}`), "", `${c}.`, site ? `Learn more: ${site}` : "", "", "What's one small step your team has taken? Tell us in the comments."].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  }
  if (platform === "x") return `${h}\n\n${titles.slice(0, 3).map((t) => `• ${t}`).join("\n")}\n\n${c}`;
  const where = platform === "instagram" ? "Link in bio" : site ? site : "";
  return [`${h} 🌍`, "", "Swipe 👉 to see:", ...titles.map((t) => `✅ ${t}`), "", `${c}. Save this and share it with someone who'd like it.`, where ? `\n${where}` : ""].join("\n").trim();
}
