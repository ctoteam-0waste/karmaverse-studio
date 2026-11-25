import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import { alignWords, buildCaptions, draftTranscript, type TimedWord } from "@/lib/video/subtitles";
import { ASPECTS, balancedWrap, layoutFor, parseScreen, placeMedia, renderAd, renderCover } from "@/lib/video/ad";
import { ffmpegBinary, probeClip } from "@/lib/video/maker";

let ff: string | null = null;
try {
  ff = ffmpegBinary();
} catch {
  ff = null;
}

// What the recogniser "heard" (with mistakes), one word per 0.5 s.
const heardText = "want to schedule a kick to open it easy tap schedule a big oakland home".split(" ");
const heard: TimedWord[] = heardText.map((w, i) => ({ word: w, start: i * 0.5, end: i * 0.5 + 0.4 }));

describe("subtitles", () => {
  it("times script words from recognised words and interpolates misheard ones", () => {
    const t = alignWords("Want to schedule a pickup? It's easy.".split(" "), heard, 10);
    expect(t[0]).toMatchObject({ word: "Want", start: 0 });
    expect(t[2]!.start).toBe(1.0); // "schedule" matched
    // "pickup?" was misheard ("kick to open it") but still lands between its neighbours.
    expect(t[4]!.start).toBeGreaterThan(t[3]!.start);
    expect(t[4]!.start).toBeLessThan(t[6]!.start);
  });

  it("splits a checked script into short captions, never across lines, gold for key words", () => {
    const caps = buildCaptions("Want to schedule a pickup? It's easy.\nTap Schedule a Pickup on Home.\nEarn KarmaCoins for recycling", heard, 12);
    expect(caps.every((c) => c.text.split(" ").length <= 5 && c.text.length <= 30)).toBe(true);
    expect(caps.map((c) => c.text)).toContain("Want to schedule a pickup?");
    expect(caps.find((c) => /KarmaCoins/.test(c.text))!.highlight).toBe(true);
    for (let i = 1; i < caps.length; i++) expect(caps[i]!.start).toBeGreaterThanOrEqual(caps[i - 1]!.end - 1e-9);
    expect(caps.at(-1)!.end).toBeLessThanOrEqual(12);
  });

  it("spreads captions over the clip when there is no speech recognition", () => {
    const caps = buildCaptions("One two three four five six seven eight", [], 10);
    expect(caps[0]!.start).toBeCloseTo(0.2, 1);
    expect(caps.at(-1)!.end).toBeLessThanOrEqual(10);
  });

  it("drafts a transcript split at pauses", () => {
    const w: TimedWord[] = [{ word: "hello", start: 0, end: 0.3 }, { word: "there", start: 0.35, end: 0.6 }, { word: "next", start: 1.5, end: 1.8 }];
    expect(draftTranscript(w)).toBe("Hello there\nNext");
  });
});

describe("advert layouts", () => {
  it("keeps the card and phone inside the frame for every size", () => {
    for (const a of ASPECTS) {
      const L = layoutFor(a);
      for (const withPhone of [false, true]) {
        const p = placeMedia(L, 1920, 1080, withPhone);
        expect(p.card.x).toBeGreaterThanOrEqual(0);
        expect(p.card.x + p.card.w).toBeLessThanOrEqual(L.W);
        expect(p.card.y + p.card.h).toBeLessThanOrEqual(L.H);
        if (p.phone) {
          expect(p.phone.x).toBeGreaterThan(p.card.x + p.card.w);
          expect(p.phone.x + p.phone.w).toBeLessThanOrEqual(L.W);
          expect(p.phone.y + p.phone.h).toBeLessThanOrEqual(L.H);
        }
      }
      expect(L.clip.cta.y).toBeLessThan(L.H - 40);
    }
  });

  it("wraps headlines into even lines, never one word alone", () => {
    expect(balancedWrap("Climate action starts with you", 16)).toEqual(["Climate action", "starts with you"]);
    // Too narrow for two lines: three lines, but the last still has more than one word.
    expect(balancedWrap("Climate action starts with you", 14).at(-1)!.split(" ").length).toBeGreaterThan(1);
    expect(balancedWrap("Earn KarmaCoins for every green step", 34)).toEqual(["Earn KarmaCoins for", "every green step"]);
    expect(balancedWrap("Short", 20)).toEqual(["Short"]);
  });

  it("reads app screens given as images or video@seconds", () => {
    expect(parseScreen("C:\a\home.png")).toEqual({ file: "C:\a\home.png", start: null });
    expect(parseScreen("C:\a\demo.mp4@65.2")).toEqual({ file: "C:\a\demo.mp4", start: 65.2 });
  });
});

describe.skipIf(!ff)("advert sizes, phone and cover (needs ffmpeg)", () => {
  it("renders a square advert with a phone of app screens and subtitles, plus a cover", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sga-square-"));
    try {
      const clip = path.join(dir, "clip.mp4");
      execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=1280x720:r=25:d=4", "-f", "lavfi", "-i", "sine=f=300:d=4", "-shortest", "-c:v", "libx264", "-c:a", "aac", clip]);
      const s1 = path.join(dir, "s1.png"), s2 = path.join(dir, "s2.png");
      execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=360x780", "-frames:v", "1", s1]);
      execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=360x780", "-frames:v", "1", s2]);
      const r = await renderAd({ ...brand, logoFile: "" }, "reel", clip, { headline: "Climate action", cta: "Start today", appScreens: [s1, s2], captions: [{ text: "Earn KarmaCoins", start: 0.2, end: 3.5, highlight: true }] }, { outDir: dir, aspect: "1:1" });
      const info = await probeClip(ff!, r.file);
      expect([info.width, info.height]).toEqual([1080, 1080]);
      // Inside the phone, the first screen (red) shows early in the clip part and the second (blue) later.
      const L = layoutFor("1:1");
      const ph = placeMedia(L, 1280, 720, true).phone!;
      const px = (t: number) => {
        const raw = execFileSync(ff!, ["-loglevel", "error", "-ss", String(t), "-i", r.file, "-frames:v", "1", "-vf", `crop=2:2:${ph.x + Math.round(ph.w / 2)}:${ph.y + Math.round(ph.h / 2)}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        return [raw[0]!, raw[1]!, raw[2]!];
      };
      const early = px(3.4), late = px(5.8);
      expect(early[0]).toBeGreaterThan(150);
      expect(early[2]).toBeLessThan(100);
      expect(late[2]).toBeGreaterThan(150);
      expect(late[0]).toBeLessThan(100);

      const cover = await renderCover({ ...brand, logoFile: "" }, "16:9", clip, "Climate action starts with you", { outDir: dir });
      const ci = await probeClip(ff!, cover);
      expect([ci.width, ci.height]).toEqual([1920, 1080]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
