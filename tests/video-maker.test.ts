import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import { generateVideoBrief } from "@/lib/agents/video";
import { cleanText, ffmpegBinary, planProblems, probeClip, renderVideo, renderWrapped, scenesFromBrief, scenesFromPiece, wavSeconds, wrap, type Scene } from "@/lib/video/maker";
import type { ContentPiece } from "@/lib/schemas";

let ff: string | null = null;
try {
  ff = ffmpegBinary();
} catch {
  ff = null;
}

/** MP4 duration from the mvhd box. */
function mp4Seconds(file: string): number {
  const b = readFileSync(file);
  const i = b.indexOf(Buffer.from("mvhd"));
  const v = b[i + 4];
  const scale = v === 1 ? b.readUInt32BE(i + 24) : b.readUInt32BE(i + 16);
  const dur = v === 1 ? Number(b.readBigUInt64BE(i + 28)) : b.readUInt32BE(i + 20);
  return dur / scale;
}

describe("video maker planning", () => {
  it("cleans emoji and hashtags, and wraps lines", () => {
    expect(cleanText("Save this 👇 #ZeroWaste now")).toBe("Save this now");
    expect(wrap("one two three four five six", 9)).toBe("one two\nthree\nfour five\nsix");
  });

  it("refuses briefs that still have [placeholders]", () => {
    const brief = generateVideoBrief(brand, { title: "Wet vs dry waste", angle: "", pillarId: "edu-shorts", audienceQuestion: "" }, "youtube", "short", 30);
    const scenes = scenesFromBrief(brand, brief);
    expect(planProblems(scenes).join(" ")).toMatch(/bracketed/);
    expect(scenes.at(-1)!.kind).toBe("cta");
  });

  it("builds scenes from a post: hook, caption lines, CTA with website", () => {
    const piece = { hook: "Stop throwing chargers in the bin", caption: "Stop throwing chargers in the bin\n\nThey contain metals that can be recovered.\nBook a doorstep pickup instead.\n\n👇 Save this", cta: "Save this", description: "" } as ContentPiece;
    const scenes = scenesFromPiece(brand, piece);
    expect(scenes.map((s) => s.kind)).toEqual(["hook", "body", "body", "cta"]);
    expect(scenes.at(-1)!.text).toContain("karmaverse.earth");
  });

  it("reads WAV duration from the header", () => {
    const b = Buffer.alloc(44);
    b.write("RIFF", 0);
    b.write("WAVEfmt ", 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt32LE(32000, 28); // byte rate
    b.write("data", 36);
    b.writeUInt32LE(64000, 40);
    expect(wavSeconds(b)).toBe(2);
  });
});

describe.skipIf(!ff)("video maker rendering (needs ffmpeg)", () => {
  const scenes: Scene[] = [
    { kind: "hook", text: "Myth or fact?", voice: "Myth or fact?", minSec: 1.5 },
    { kind: "body", text: "Old chargers go in a separate e-waste bag", voice: "", minSec: 1.5 },
    { kind: "cta", text: "Book a pickup\nkarmaverse.earth", voice: "", minSec: 1.5 },
  ];

  it("renders a vertical captioned video with sound", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "sga-render-"));
    try {
      const r = await renderVideo(brand, "short", scenes, { voice: "none", clips: [], outDir: out });
      expect(existsSync(r.file)).toBe(true);
      expect(statSync(r.file).size).toBeGreaterThan(10_000);
      expect(mp4Seconds(r.file)).toBeGreaterThan(4);
      expect(r.scenes).toBe(3);
      // The progress bar grows: count yellow pixels in the bottom strip early and late.
      const yellow = (sec: number) => {
        const raw = execFileSync(ff!, ["-loglevel", "error", "-ss", String(sec), "-i", r.file, "-frames:v", "1", "-vf", "crop=iw:2:0:ih-8", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        let n = 0;
        for (let i = 0; i + 2 < 1080 * 3; i += 3) if (raw[i]! > 200 && raw[i + 1]! > 160 && raw[i + 2]! < 100) n++;
        return n;
      };
      const early = yellow(0.2);
      const late = yellow(mp4Seconds(r.file) - 0.2);
      expect(late).toBeGreaterThan(1000);
      expect(early).toBeLessThan(late / 3);
      if (process.env.KEEP_FRAME) {
        execFileSync(ff!, ["-y", "-loglevel", "error", "-ss", "0.8", "-i", r.file, "-frames:v", "1", "-vf", "scale=360:-1", process.env.KEEP_FRAME]);
        copyFileSync(r.file, process.env.KEEP_FRAME.replace(/\.png$/, ".mp4"));
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(process.platform !== "win32")("adds a Windows voiceover and stretches scenes to fit it", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "sga-render-"));
    try {
      const long = "This sentence is deliberately long so that the spoken voiceover takes more than the one and a half seconds planned for this scene.";
      const r = await renderVideo(brand, "reel", [{ ...scenes[0]!, voice: long }, scenes[2]!], { voice: "Microsoft Zira Desktop", clips: [], outDir: out });
      expect(r.durationSec).toBeGreaterThan(5);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("wraps a landscape clip with its own sound into a vertical frame plus an end card", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "sga-wrap-test-"));
    try {
      const clip = path.join(out, "landscape.mp4");
      // 4 s, 1920x1080 test pattern with a 440 Hz tone.
      execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=1920x1080:r=25:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-shortest", "-c:v", "libx264", "-c:a", "aac", clip]);
      const r = await renderWrapped(brand, "short", clip, { title: "How to book a doorstep pickup", cta: "Download the app" }, { outDir: out });
      const info = await probeClip(ff!, r.file);
      expect([info.width, info.height]).toEqual([1080, 1920]);
      expect(info.seconds).toBeGreaterThan(6.5); // 4 s clip + 3 s end card
      expect(info.seconds).toBeLessThan(7.6);
      // The clip's sound is kept: the first second is not silent (volumedetect reports on stderr).
      const stats = spawnSync(ff!, ["-hide_banner", "-t", "1", "-i", r.file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
      const mean = Number(stats.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? -99);
      expect(mean).toBeGreaterThan(-40);
      await expect(renderWrapped(brand, "short", clip, { title: "Fill [this] in", cta: "" }, { outDir: out })).rejects.toThrow(/bracketed/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(!ff)("advert style (needs ffmpeg)", () => {
  it("trims a logo on white and makes the background transparent", async () => {
    const { prepareLogo } = await import("@/lib/video/ad");
    const dir = mkdtempSync(path.join(tmpdir(), "sga-logo-"));
    try {
      const logo = path.join(dir, "logo.jpg");
      // 400x200 white image with a 100x60 green block at (150,70).
      execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=400x200", "-vf", "drawbox=x=150:y=70:w=100:h=60:color=0x0B3C04:t=fill", "-frames:v", "1", logo]);
      const r = await prepareLogo(ff!, logo, dir);
      expect(r.w).toBeLessThan(130);
      expect(r.h).toBeLessThan(90);
      const raw = execFileSync(ff!, ["-loglevel", "error", "-i", r.file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
      expect(raw[3]).toBeLessThan(10); // corner (white padding) is transparent
      const mid = ((Math.floor(r.h / 2) * r.w) + Math.floor(r.w / 2)) * 4;
      expect(raw[mid + 3]).toBe(255); // logo itself is opaque
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("renders hook + clip + end card with transitions and keeps the clip's sound", async () => {
    const { renderAd } = await import("@/lib/video/ad");
    const dir = mkdtempSync(path.join(tmpdir(), "sga-ad-test-"));
    try {
      const clip = path.join(dir, "clip.mp4");
      execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=1280x720:r=25:d=3", "-f", "lavfi", "-i", "sine=f=330:d=3", "-shortest", "-c:v", "libx264", "-c:a", "aac", clip]);
      const r = await renderAd({ ...brand, logoFile: "" }, "short", clip, { headline: "Book a doorstep pickup", cta: "Download the app", footnote: "Available on Android" }, { outDir: dir });
      const info = await probeClip(ff!, r.file);
      expect([info.width, info.height]).toEqual([1080, 1920]);
      // 3.0 hook + 3 clip + 3.8 outro − 2 × 0.45 transitions ≈ 8.9 s
      expect(info.seconds).toBeGreaterThan(8.5);
      expect(info.seconds).toBeLessThan(9.4);
      expect(r.notes.join(" ")).toMatch(/No logo set/);
      const mid = spawnSync(ff!, ["-hide_banner", "-ss", "4", "-t", "1", "-i", r.file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
      expect(Number(mid.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? -99)).toBeGreaterThan(-35);

      // Muted clip + changing messages: the clip part is silent.
      const m = await renderAd({ ...brand, logoFile: "" }, "short", clip, { headline: "Climate action starts with you", cta: "Start today", beats: ["Small actions", "Big impact"], muteClip: true }, { outDir: dir });
      const quiet = spawnSync(ff!, ["-hide_banner", "-ss", "4", "-t", "1", "-i", m.file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
      expect(Number(quiet.match(/max_volume: (-?[\d.]+) dB/)?.[1] ?? 0)).toBeLessThan(-60);
      expect(m.notes.join(" ")).toMatch(/clip is muted/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it("ducks the music while the clip speaks and brings it back in the pauses", async () => {
    const { renderAd } = await import("@/lib/video/ad");
    const dir = mkdtempSync(path.join(tmpdir(), "sga-duck-"));
    try {
      // Clip: 6 s; silent for 3 s, then "speech" (a 1 kHz tone). Music: a steady 200 Hz tone.
      const clip = path.join(dir, "clip.mp4");
      execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=1280x720:r=25:d=6", "-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*1000*t)*gte(t,3)':d=6:s=44100", "-shortest", "-c:v", "libx264", "-c:a", "aac", clip]);
      const music = path.join(dir, "music.mp3");
      execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=200:d=20", music]);
      const r = await renderAd({ ...brand, logoFile: "" }, "short", clip, { headline: "Climate action", cta: "Start today" }, { outDir: dir, musicFile: music });
      // The clip part starts at 3.0 − 0.45 = 2.55 s in the final video.
      const band = (from: number, len: number) => {
        const err = spawnSync(ff!, ["-hide_banner", "-ss", String(from), "-t", String(len), "-i", r.file, "-af", "bandpass=f=200:width_type=h:w=60,volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
        return Number(err.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? -99);
      };
      const musicInPause = band(3.4, 1.8);
      const musicUnderVoice = band(6.3, 1.8);
      expect(musicInPause - musicUnderVoice).toBeGreaterThan(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
