import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Brand, ContentPiece } from "../schemas";
import { dataFile } from "../db";
import { logger } from "../logger";
import { newId } from "../util";
import { AD_COLORS, FONT_BLACK, FONT_BOLD, FONT_REG, ffPath, fit, lines, pick, prepareLogo, renderPhoneFrame } from "../video/ad";
import { cleanText, ffmpegBinary } from "../video/maker";

const log = logger("carousel");

/**
 * L. Carousel Maker Agent.
 *
 * Turns a post into a branded slider (carousel): a cover slide with the hook and
 * a "Swipe" prompt, numbered content slides (optionally with a real app screen in
 * a phone), and a closing slide with the logo, call to action and website.
 * Background shapes continue from one slide into the next, so swiping feels like
 * one design. Output: JPEG slides (Instagram/Facebook/LinkedIn image posts) and a
 * PDF of the same slides (LinkedIn document carousels).
 */

export type SlideSize = "4:5" | "1:1" | "9:16";
export const SLIDE_DIMS: Record<SlideSize, { W: number; H: number }> = { "4:5": { W: 1080, H: 1350 }, "1:1": { W: 1080, H: 1080 }, "9:16": { W: 1080, H: 1920 } };
export const MAX_SLIDES = 10;

export interface Slide {
  title: string;
  body: string;
}

/**
 * Slide designs. "classic" is drawn with ffmpeg below; the others are drawn by
 * scripts/carousel/designs.py (Pillow): a notes-app page, a social-post card, and
 * bold colour blocks. They rotate so the feed doesn't look the same every day.
 */
export const CAROUSEL_DESIGNS = ["classic", "notes", "post", "bold"] as const;
export type CarouselDesign = (typeof CAROUSEL_DESIGNS)[number];
export const CAROUSEL_DESIGN_LABEL: Record<CarouselDesign, string> = {
  classic: "Classic (logo and numbered slides)",
  notes: "Notes page",
  post: "Social post card",
  bold: "Bold colour blocks",
};

/** Rotates designs day by day (YYYY-MM-DD), so posts on consecutive days look different. */
export function designFor(date: string | null | undefined): CarouselDesign {
  const day = Math.floor(Date.parse(`${date || new Date().toISOString().slice(0, 10)}T00:00:00Z`) / 86_400_000);
  return CAROUSEL_DESIGNS[((Number.isFinite(day) ? day : 0) % CAROUSEL_DESIGNS.length + CAROUSEL_DESIGNS.length) % CAROUSEL_DESIGNS.length]!;
}

export interface CarouselOptions {
  outDir: string;
  size?: SlideSize;
  /** Slide design (default classic). Designs other than classic don't support phone images. */
  design?: CarouselDesign;
  /** Images shown in a phone on content slides, in order (one per slide; slides without one have text only). */
  images?: string[];
  cta: string;
  footnote?: string;
  ffmpegPath?: string;
}

export interface CarouselResult {
  slides: string[];
  pdf: string;
  notes: string[];
}

const PLACEHOLDER = /\[[^\]]{3,}\]/;

/** "Title | body" per line. A line without "|" is a title only. */
export function parseSlides(text: string): Slide[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [title, ...rest] = l.split("|");
      return { title: (title ?? "").trim(), body: rest.join("|").trim() };
    })
    .filter((s) => s.title || s.body);
}

export function slidesToText(slides: Slide[]): string {
  return slides.map((s) => (s.body ? `${s.title} | ${s.body}` : s.title)).join("\n");
}

/**
 * Slides from a post: the "Slide N: …" outline the content agent writes for
 * carousels, otherwise the hook as the cover and short caption lines as slides.
 * The cover and closing slides are added by the renderer, so they're left out here.
 */
export function slidesFromPiece(piece: Pick<ContentPiece, "hook" | "caption" | "cta" | "description">): Slide[] {
  const text = `${piece.caption}\n${piece.description}`;
  const outline = [...text.matchAll(/^Slide\s*\d+\s*[:.-]\s*(.+)$/gim)].map((m) => m[1]!.trim());
  const items = outline.length
    ? outline
    : text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l !== piece.hook.trim() && l !== piece.cta.trim() && !/swipe through/i.test(l));
  const body = items
    .filter((l) => cleanText(l).toLowerCase() !== cleanText(piece.hook).toLowerCase() && cleanText(l).toLowerCase() !== cleanText(piece.cta).toLowerCase())
    .slice(0, MAX_SLIDES - 2);
  return body.map((l) => {
    const m = l.match(/^(.{3,60}?)\s+[—:–-]\s+(.+)$/);
    return m ? { title: m[1]!.trim(), body: m[2]!.trim() } : { title: l, body: "" };
  });
}

export function slideProblems(slides: Slide[]): string[] {
  const p: string[] = [];
  if (slides.length === 0) p.push("Add at least one content slide.");
  if (slides.length > MAX_SLIDES - 2) p.push(`At most ${MAX_SLIDES - 2} content slides (a carousel holds ${MAX_SLIDES} with the cover and closing slides).`);
  const gaps = slides.filter((s) => PLACEHOLDER.test(s.title) || PLACEHOLDER.test(s.body)).length;
  if (gaps) p.push(`Fill in the [bracketed] parts first (${gaps} slide${gaps > 1 ? "s" : ""}).`);
  return p;
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

/* ------------------------------------------------------------------ */
/* PDF (for LinkedIn document carousels)                               */
/* ------------------------------------------------------------------ */

/** Writes a PDF with one full-page JPEG per page (DCTDecode; no dependencies). */
export async function writeJpegPdf(jpegs: string[], out: string, W: number, H: number): Promise<void> {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Buffer | string) => {
    const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    parts.push(buf);
    size += buf.length;
  };
  const obj = (n: number, body: Array<Buffer | string>) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    for (const b of body) push(b);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const n = jpegs.length;
  // 1 catalog, 2 pages, then for page i: 3+3i page, 4+3i content, 5+3i image.
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, [`<< /Type /Pages /Count ${n} /Kids [${jpegs.map((_, i) => `${3 + 3 * i} 0 R`).join(" ")}] >>`]);
  for (const [i, file] of jpegs.entries()) {
    const img = await readFile(file);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(3 + 3 * i, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${5 + 3 * i} 0 R >> >> /Contents ${4 + 3 * i} 0 R >>`]);
    obj(4 + 3 * i, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    obj(5 + 3 * i, [`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`, img, "\nendstream"]);
  }
  const total = 3 + 3 * n;
  const xref = size;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let k = 1; k < total; k++) push(`${String(offsets[k]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  await writeFile(out, Buffer.concat(parts));
}

/* ------------------------------------------------------------------ */
/* Pillow designs                                                      */
/* ------------------------------------------------------------------ */

async function renderDesigned(brand: Brand, hook: string, content: Slide[], design: Exclude<CarouselDesign, "classic">, opts: CarouselOptions): Promise<CarouselResult> {
  const { W, H } = SLIDE_DIMS[opts.size ?? "4:5"];
  const brandDir = path.join(path.dirname(dataFile()), "brand");
  const logo = brand.logoFile && existsSync(brand.logoFile) ? brand.logoFile : path.join(brandDir, `${brand.id}-logo-full.jpeg`);
  const mascot = path.join(brandDir, "earth-buddy-mascot.jpeg");
  for (const f of [logo, mascot]) if (!existsSync(f)) throw new Error(`Missing image for the ${design} design: ${f}`);
  await mkdir(opts.outDir, { recursive: true });
  const dir = await mkdtemp(path.join(tmpdir(), "sga-design-"));
  const set = newId("slides");
  const site = brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const spec = {
    design, W, H,
    hook: cleanText(hook),
    slides: content.map((s) => ({ title: cleanText(s.title), body: cleanText(s.body) })),
    cta: cleanText(opts.cta), brand: brand.name, handle: site, site,
    logo, mascot, out_dir: opts.outDir, prefix: set,
  };
  try {
    const specFile = path.join(dir, "spec.json");
    await writeFile(specFile, JSON.stringify(spec), "utf8");
    const script = path.join(process.cwd(), "scripts", "carousel", "designs.py");
    const python = process.env.PYTHON?.trim() || "python";
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(/*turbopackIgnore: true*/ python, [script, specFile], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let stdout = "", stderr = "";
      p.stdout.on("data", (d: Buffer) => (stdout += d));
      p.stderr.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-3000)));
      p.on("error", (err) => reject(new Error(`Could not start Python (${python}): ${err.message}`)));
      p.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`The slide designer stopped (code ${code}): ${stderr.trim().split("\n").slice(-3).join(" ")}`))));
    });
    const slides = (JSON.parse(out.trim().split("\n").pop() ?? "{}") as { slides: string[] }).slides.map((f) => path.normalize(f));
    const pdf = path.join(opts.outDir, `${set}.pdf`);
    await writeJpegPdf(slides, pdf, W, H);
    log.info("Carousel rendered", { slides: slides.length, size: opts.size ?? "4:5", design });
    return { slides, pdf, notes: [] };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

export async function renderCarousel(brand: Brand, hook: string, content: Slide[], opts: CarouselOptions): Promise<CarouselResult> {
  const problems = slideProblems(content);
  if (problems.length) throw new Error(problems.join(" "));
  if (!cleanText(hook)) throw new Error("Add a hook: it's the cover slide's headline.");
  // One entry per content slide, in order; "" or "-" means no image on that slide.
  const images = (opts.images ?? []).map((s) => s.trim().replace(/^"|"$/g, "")).map((s) => (s === "-" ? "" : s));
  if (opts.design && opts.design !== "classic" && !images.some(Boolean)) return renderDesigned(brand, hook, content, opts.design, opts);
  for (const im of images) if (im && !existsSync(im)) throw new Error(`Image not found: ${im}`);
  const ff = opts.ffmpegPath ?? ffmpegBinary();
  const fBlack = pick(FONT_BLACK), fBold = pick(FONT_BOLD), fReg = pick(FONT_REG) ?? fBold;
  if (!fBlack || !fBold) throw new Error("No bold font found for the slide text.");
  const { W, H } = SLIDE_DIMS[opts.size ?? "4:5"];
  const C = AD_COLORS;
  const total = content.length + 2;
  const notes: string[] = [];
  const dir = await mkdtemp(path.join(tmpdir(), "sga-carousel-"));
  try {
    let logo: { file: string; w: number; h: number } | null = null;
    if (brand.logoFile && existsSync(brand.logoFile)) logo = await prepareLogo(ff, brand.logoFile, dir);
    else notes.push("No logo set for this brand (Settings → Logo file), so the brand name is shown as text.");
    const logoW = (target: number) => (logo ? Math.min(target, Math.round((target / 2.2) * (logo.w / logo.h))) : 0);
    const logoH = (w: number) => (logo ? Math.round((w * logo.h) / logo.w) : 0);
    await writeFile(path.join(dir, "brand.txt"), cleanText(brand.name), "utf8");

    // Circles drawn once; placed per slide so they continue across slide edges.
    const circle = async (name: string, size: number, color: string, alpha: number) => {
      const [r, g, b] = [parseInt(color.slice(2, 4), 16), parseInt(color.slice(4, 6), 16), parseInt(color.slice(6, 8), 16)];
      const R = size / 2;
      await run(ff, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black@0:s=${size}x${size},format=rgba,geq=r=${r}:g=${g}:b=${b}:a='${Math.round(alpha * 255)}*clip((${R}-hypot(X-${R},Y-${R}))/3,0,1)'`, "-frames:v", "1", name], dir);
    };
    await circle("c1.png", Math.round(W * 0.95), C.green, 0.08);
    await circle("c2.png", Math.round(W * 0.6), C.gold, 0.11);

    // Phone frame for image slides (sized for this slide height).
    // Tall slides (9:16): phone below the text. Feed slides (4:5, 1:1): text left, phone right.
    const side = H / W < 1.5;
    const phoneH = Math.round(H * (side ? (H > W ? 0.62 : 0.66) : 0.55));
    const phoneW = Math.round(phoneH * 0.4615 / 2) * 2;
    if (images.some(Boolean)) await renderPhoneFrame(ff, dir, phoneW, phoneH);

    const files: string[] = [];
    await mkdir(opts.outDir, { recursive: true });
    const set = newId("slides");

    for (let i = 0; i < total; i++) {
      const kind = i === 0 ? "cover" : i === total - 1 ? "end" : "content";
      const inputs = ["-f", "lavfi", "-i", `gradients=s=${W}x${H}:c0=${C.bg0}:c1=${C.bg1}:x0=0:y0=0:x1=${W}:y1=${H}:d=1`, "-i", "c1.png", "-i", "c2.png"];
      let next = 3;
      const iLogo = logo ? next++ : -1;
      if (logo) inputs.push("-i", logo.file);
      const img = kind === "content" ? images[i - 1] || undefined : undefined;
      let iImg = -1, iFrame = -1, iMask = -1;
      if (img) {
        iImg = next++;
        inputs.push("-i", img);
        iFrame = next++;
        inputs.push("-i", "phone-frame.png");
        iMask = next++;
        inputs.push("-i", "phone-mask.png");
      }
      // A big green circle drifts left across the set; a gold one sits across each slide edge.
      const c1x = Math.round(W * 0.55 - i * W * 0.32), c2x = Math.round(W - W * 0.3);
      const v: string[] = [`[0:v][1:v]overlay=${c1x}:${Math.round(-H * 0.18)}[b1]`, `[b1][2:v]overlay=${c2x}:${Math.round(H * 0.68)}[b2]`];
      let cur = "[b2]";
      const parts: string[] = [];
      const counter = `${i + 1}/${total}`;
      await writeFile(path.join(dir, `n${i}.txt`), counter, "utf8");

      if (kind === "cover") {
        const lw = logoW(Math.round(W * 0.62)), lh = logoH(lw);
        if (logo) {
          v.push(`[${iLogo}:v]format=rgba,scale=${lw}:-1[lg]`, `${cur}[lg]overlay=x=${Math.round((W - lw) / 2)}:y=${Math.round(H * 0.08)}:format=auto[c1]`);
          cur = "[c1]";
        }
        const top = Math.round(H * 0.08) + lh + Math.round(H * 0.08);
        const hl = await lines(dir, `cv${i}_`, cleanText(hook), 14);
        const areaH = Math.round(H * 0.82) - top;
        const size = fit(H > W ? 112 : 100, hl.length, areaH * 0.8);
        const lhT = Math.round(size * 1.16);
        const blockTop = top + Math.round((areaH * 0.8 - hl.length * lhT) / 2);
        hl.forEach((l, k) => parts.push(`drawtext=fontfile='${ffPath(fBlack)}':textfile=${l.file}:fontcolor=${C.green}:fontsize=${size}:x=(w-text_w)/2:y=${blockTop + k * lhT}`));
        parts.push(`drawbox=x=${Math.round(W / 2 - 170)}:y=${blockTop + hl.length * lhT + 24}:w=340:h=14:color=${C.gold}:t=fill`);
        await writeFile(path.join(dir, "swipe.txt"), " Swipe → ", "utf8");
        parts.push(`drawtext=fontfile='${ffPath(fBold)}':textfile=swipe.txt:fontcolor=white:fontsize=${Math.round(W * 0.042)}:box=1:boxcolor=${C.gold}:boxborderw=22:x=w-text_w-70:y=h-text_h-80`);
      } else if (kind === "content") {
        const s = content[i - 1]!;
        // Small logo top-left, counter top-right.
        const lw = logoW(Math.round(W * 0.3));
        if (logo) {
          v.push(`[${iLogo}:v]format=rgba,scale=${lw}:-1[lg]`, `${cur}[lg]overlay=x=60:y=50:format=auto[c1]`);
          cur = "[c1]";
        } else {
          parts.push(`drawtext=fontfile='${ffPath(fBlack)}':textfile=brand.txt:fontcolor=${C.green}:fontsize=40:x=60:y=60`);
        }
        parts.push(`drawtext=fontfile='${ffPath(fBold)}':textfile=n${i}.txt:fontcolor=${C.ink}@0.6:fontsize=36:x=w-text_w-60:y=70`);
        // Number badge.
        await writeFile(path.join(dir, `num${i}.txt`), String(i), "utf8");
        // Below the small logo (never over it), higher on slides with a phone.
        const badgeY = Math.max(Math.round(H * (img ? 0.11 : 0.2)), 50 + (logo ? logoH(lw) : 50) + 36);
        parts.push(`drawtext=fontfile='${ffPath(fBlack)}':textfile=num${i}.txt:fontcolor=white:fontsize=64:box=1:boxcolor=${C.gold}:boxborderw=26:x=90:y=${badgeY}`);
        const textTop = badgeY + (img ? 125 : 150);
        const textBottom = img && !side ? Math.round(H - phoneH - 90) : Math.round(H * 0.86);
        const tl = await lines(dir, `t${i}_`, cleanText(s.title), img ? (side ? 12 : 22) : 18);
        const bl = s.body ? await lines(dir, `d${i}_`, cleanText(s.body), img ? (side ? 24 : 40) : 34) : [];
        const avail = textBottom - textTop;
        const tSize = fit(img ? (side ? 62 : 66) : 82, tl.length, avail * (bl.length ? 0.5 : 0.9));
        const tLh = Math.round(tSize * 1.16);
        const bSize = fit(img ? 38 : 44, Math.max(1, bl.length), avail - tl.length * tLh - 40);
        const bLh = Math.round(bSize * 1.35);
        tl.forEach((l, k) => parts.push(`drawtext=fontfile='${ffPath(fBlack)}':textfile=${l.file}:fontcolor=${C.green}:fontsize=${tSize}:x=90:y=${textTop + k * tLh}`));
        bl.forEach((l, k) => parts.push(`drawtext=fontfile='${ffPath(fReg!)}':textfile=${l.file}:fontcolor=${C.ink}@0.85:fontsize=${bSize}:x=90:y=${textTop + tl.length * tLh + 30 + k * bLh}`));
        if (img) {
          const b = Math.round(phoneW * 0.045);
          const px = side ? W - phoneW - 70 : Math.round((W - phoneW) / 2);
          const py = side ? Math.max(200, Math.round((H - phoneH) / 2) + 40) : H - phoneH - 40;
          v.push(
            `color=c=black:s=${phoneW}x${phoneH},format=rgba[pb]`,
            `[${iImg}:v]scale=${phoneW - 2 * b}:${phoneH - 2 * b}:force_original_aspect_ratio=increase,crop=${phoneW - 2 * b}:${phoneH - 2 * b},setsar=1,format=rgba[sc]`,
            `[pb][sc]overlay=${b}:${b}[ps]`,
            `[ps][${iFrame}:v]overlay=0:0[pf]`,
            `[${iMask}:v]format=gray[pm]`,
            `[pf][pm]alphamerge[phone]`,
            `${cur}drawbox=x=${px + 14}:y=${py + 20}:w=${phoneW}:h=${phoneH}:color=black@0.10:t=fill[sh]`,
            `[sh][phone]overlay=${px}:${py}[c2]`,
          );
          cur = "[c2]";
        }
        // Progress dots along the bottom-left.
        for (let d = 0; d < total; d++) parts.push(`drawbox=x=${90 + d * 30}:y=${H - 70}:w=${d === i ? 44 : 14}:h=14:color=${d === i ? C.gold : `${C.green}@0.25`}:t=fill`);
      } else {
        const lw = logoW(Math.round(W * 0.78)), lh = logoH(lw);
        const ly = Math.round(H * 0.2);
        if (logo) {
          v.push(`[${iLogo}:v]format=rgba,scale=${lw}:-1[lg]`, `${cur}[lg]overlay=x=${Math.round((W - lw) / 2)}:y=${ly}:format=auto[c1]`);
          cur = "[c1]";
        } else {
          parts.push(`drawtext=fontfile='${ffPath(fBlack)}':textfile=brand.txt:fontcolor=${C.green}:fontsize=110:x=(w-text_w)/2:y=${ly}`);
        }
        const base = ly + (logo ? lh : 140) + Math.round(H * 0.08);
        // The button stays one box: one line, smaller text for long calls to action.
        const ctaText = cleanText(opts.cta);
        const ctaSize = ctaText.length <= 30 ? 50 : ctaText.length <= 40 ? 42 : 36;
        await writeFile(path.join(dir, "cta.txt"), ` ${ctaText} `, "utf8");
        parts.push(`drawtext=fontfile='${ffPath(fBold)}':textfile=cta.txt:fontcolor=white:fontsize=${ctaSize}:box=1:boxcolor=${C.gold}:boxborderw=28:x=(w-text_w)/2:y=${base}`);
        const site = brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
        await writeFile(path.join(dir, "site.txt"), site, "utf8");
        const siteY = base + 180;
        if (site) parts.push(`drawtext=fontfile='${ffPath(fBlack)}':textfile=site.txt:fontcolor=${C.green}:fontsize=64:x=(w-text_w)/2:y=${siteY}`);
        const foot = cleanText(opts.footnote ?? "");
        if (foot) {
          await writeFile(path.join(dir, "foot.txt"), foot, "utf8");
          parts.push(`drawtext=fontfile='${ffPath(fReg!)}':textfile=foot.txt:fontcolor=${C.ink}@0.7:fontsize=42:x=(w-text_w)/2:y=${siteY + 100}`);
        }
        await writeFile(path.join(dir, "save.txt"), "Save this · Share it with a friend", "utf8");
        parts.push(`drawtext=fontfile='${ffPath(fBold)}':textfile=save.txt:fontcolor=${C.green}@0.8:fontsize=38:x=(w-text_w)/2:y=h-130`);
      }
      v.push(`${cur}${parts.length ? parts.join(",") + "," : ""}format=rgb24[o]`);
      const out = path.join(opts.outDir, `${set}_${String(i + 1).padStart(2, "0")}.jpg`);
      await run(ff, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", v.join(";"), "-map", "[o]", "-frames:v", "1", "-q:v", "2", out], dir);
      files.push(out);
    }

    const pdf = path.join(opts.outDir, `${set}.pdf`);
    await writeJpegPdf(files, pdf, W, H);
    if (images.filter(Boolean).length > content.length) notes.push(`${images.length - content.length} image(s) weren't used (more images than content slides).`);
    log.info("Carousel rendered", { slides: files.length, size: opts.size ?? "4:5" });
    return { slides: files, pdf, notes };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
