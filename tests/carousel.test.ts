import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import { generatePlatformVersion } from "@/lib/agents/content";
import { parseSlides, renderCarousel, slideProblems, slidesFromPiece, slidesToText, writeJpegPdf } from "@/lib/carousel/maker";
import { ffmpegBinary, probeClip } from "@/lib/video/maker";

let ff: string | null = null;
try {
  ff = ffmpegBinary();
} catch {
  ff = null;
}

describe("carousel slides", () => {
  it("reads 'Title | text' lines and writes them back", () => {
    const s = parseSlides("Small actions | Recycle at home\nEarn KarmaCoins\n\n | only text");
    expect(s).toEqual([{ title: "Small actions", body: "Recycle at home" }, { title: "Earn KarmaCoins", body: "" }, { title: "", body: "only text" }]);
    expect(slidesToText(s.slice(0, 2))).toBe("Small actions | Recycle at home\nEarn KarmaCoins");
  });

  it("takes the content agent's slide outline, leaving out the cover and CTA slides", () => {
    const v = generatePlatformVersion(brand, { title: "Wet vs dry waste explained", angle: "", pillarId: "edu-shorts", audienceQuestion: "Which bin does this go in?" }, "instagram", "carousel");
    const slides = slidesFromPiece(v);
    expect(slides.length).toBeGreaterThanOrEqual(4);
    expect(slides.some((s) => s.title.toLowerCase() === v.hook.toLowerCase())).toBe(false);
    expect(slideProblems(slides).join(" ")).toMatch(/bracketed/); // template points still need writing
  });

  it("limits the number of slides", () => {
    expect(slideProblems(Array.from({ length: 9 }, (_, i) => ({ title: `S${i}`, body: "" }))).join(" ")).toMatch(/At most 8/);
    expect(slideProblems([])).not.toHaveLength(0);
  });
});

describe.skipIf(!ff)("carousel rendering (needs ffmpeg)", () => {
  it("writes a valid multi-page PDF from JPEGs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sga-pdf-"));
    try {
      const a = path.join(dir, "a.jpg"), b = path.join(dir, "b.jpg");
      for (const [f, c] of [[a, "red"], [b, "blue"]] as const) execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${c}:s=200x250`, "-frames:v", "1", f]);
      const pdf = path.join(dir, "out.pdf");
      await writeJpegPdf([a, b], pdf, 200, 250);
      const text = readFileSync(pdf).toString("latin1");
      expect(text.startsWith("%PDF-1.4")).toBe(true);
      expect(text).toContain("/Count 2");
      expect((text.match(/\/Subtype \/Image/g) ?? []).length).toBe(2);
      // startxref points at the xref table.
      const at = Number(text.match(/startxref\n(\d+)/)![1]);
      expect(text.slice(at, at + 4)).toBe("xref");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    }, 60_000);

  it("renders cover, content (with a phone image) and closing slides plus a PDF", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sga-carousel-test-"));
    try {
      const shot = path.join(dir, "screen.png");
      execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x1f7a45:s=360x780", "-frames:v", "1", shot]);
      const r = await renderCarousel({ ...brand, logoFile: "" }, "Climate action starts with you", [{ title: "Small everyday actions", body: "Recycle at home and take a daily eco-quiz." }, { title: "Earn KarmaCoins", body: "" }], { outDir: dir, cta: "Start your climate action today", footnote: "Available on Android", images: [shot] });
      expect(r.slides).toHaveLength(4);
      for (const s of r.slides) {
        const i = await probeClip(ff!, s);
        expect([i.width, i.height]).toEqual([1080, 1350]);
      }
      expect(readFileSync(r.pdf).toString("latin1")).toContain("/Count 4");
      // The phone (green screen) is on slide 2, on the right (feed slides put text left, phone right).
      const raw = execFileSync(ff!, ["-loglevel", "error", "-i", r.slides[1]!, "-vf", "crop=2:2:816:714", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      expect(raw[1]!).toBeGreaterThan(raw[0]! + 40);
      await expect(renderCarousel(brand, "Hook", [{ title: "Point [fill this in]", body: "" }], { outDir: dir, cta: "Go" })).rejects.toThrow(/bracketed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 400_000);
});

describe("carousel text and video", () => {
  const slides = [{ title: "Quick eco-quiz", body: "" }, { title: "Play daily, earn KarmaCoins", body: "Every quiz earns coins." }];

  it("writes platform-specific post text from the slides", async () => {
    const { captionFromSlides } = await import("@/lib/carousel/video");
    const ig = captionFromSlides(brand, "instagram", "Can you get this right?", slides, "Take today's eco-quiz in the app");
    expect(ig).toMatch(/^Can you get this right\? 🌍/);
    expect(ig).toContain("✅ Play daily, earn KarmaCoins");
    expect(ig).toContain("Link in bio");
    const li = captionFromSlides(brand, "linkedin", "Can you get this right?", slides, "Take today's eco-quiz in the app");
    expect(li).toContain("2. Play daily, earn KarmaCoins");
    expect(li).not.toMatch(/✅|🌍/);
    expect(li).toContain("karmaverse.earth");
  });

  it("gives longer slides more time", async () => {
    const { slideDurations } = await import("@/lib/carousel/video");
    const d = slideDurations([{ title: "Short", body: "" }, { title: "A much longer title here", body: "With a body that takes a while to read through properly." }]);
    expect(d).toHaveLength(4);
    expect(d[0]).toBe(2.6);
    expect(d[3]).toBe(3.6);
    expect(d[2]!).toBeGreaterThan(d[1]!);
  });

  it.skipIf(!ff)("turns slides into a video with swipes and sound", async () => {
    const { renderCarouselVideo } = await import("@/lib/carousel/video");
    const dir = mkdtempSync(path.join(tmpdir(), "sga-carvid-"));
    try {
      const files = ["red", "green", "blue"].map((c) => {
        const f = path.join(dir, `${c}.jpg`);
        execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${c}:s=1080x1920`, "-frames:v", "1", f]);
        return f;
      });
      const r = await renderCarouselVideo(files, [2, 2, 2], { outDir: dir });
      const info = await probeClip(ff!, r.file);
      expect([info.width, info.height]).toEqual([1080, 1920]);
      expect(info.seconds).toBeGreaterThan(6.2);
      expect(info.seconds).toBeLessThan(6.8);
      // Middle of slide 2 is green, middle of slide 3 is blue.
      const px = (t: number) => execFileSync(ff!, ["-loglevel", "error", "-ss", String(t), "-i", r.file, "-frames:v", "1", "-vf", "crop=2:2:540:960", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      expect(px(3.0)[1]!).toBeGreaterThan(100);
      expect(px(5.2)[2]!).toBeGreaterThan(150);
      // A whoosh around the first swipe.
      const vol = spawnSync(ff!, ["-hide_banner", "-ss", "1.7", "-t", "0.6", "-i", r.file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
      expect(Number(vol.match(/max_volume: (-?[\d.]+) dB/)?.[1] ?? -99)).toBeGreaterThan(-30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
