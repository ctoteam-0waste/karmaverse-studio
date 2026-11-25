import { characterBrief } from "./characters";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Brand, ContentPiece, Trend, VideoSeries } from "../schemas";
import { brandContext } from "../llm/prompts";
import { READY_TO_POST } from "../services/generation";
import { logger } from "../logger";
import { newId } from "../util";
import { brandAssets, speakable, tidy, type BuddyScene, type BuddyStyle } from "./buddy";
import { ffmpegBinary } from "./maker";

const log = logger("video-series");

/**
 * Video series.
 *
 * Every reel and short belongs to a series, so the feed has formats people
 * come back for instead of the same explainer every day:
 * - news:    Earth Buddy explains one real climate story of the day (source credited).
 * - quiz:    a question with three options, a 3-2-1 countdown, then the answer.
 * - myth:    a common myth gets a red MYTH stamp, then the FACT.
 * - hack:    one practical eco hack in 2-4 animated steps.
 * - cartoon: a short animated story with Earth Buddy and two kids (Hindi voice).
 *
 * YouTube Shorts carry the daily news; Instagram and Facebook rotate the other
 * series on different days, so the two never show the same series on the same day.
 */

export const SERIES_LABEL: Record<VideoSeries, string> = {
  news: "Daily climate news",
  quiz: "Quiz",
  myth: "Myth vs fact",
  hack: "Eco hack",
  cartoon: "Cartoon story",
};

/** Instagram / Facebook rotation (by day). */
export const ROTATION: VideoSeries[] = ["myth", "hack", "cartoon", "quiz"];

const dayIndex = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

export function isVideoPost(p: Pick<ContentPiece, "platform" | "format">): boolean {
  return p.platform !== "x" && p.platform !== "linkedin" && ["reel", "short", "story"].includes(p.format);
}

/** The series a video post gets on its planned day. `hasNews` = a fresh news story is available. */
export function seriesFor(p: Pick<ContentPiece, "platform" | "format" | "plannedDate">, hasNews = true): VideoSeries | null {
  if (!isVideoPost(p) || !p.plannedDate) return null;
  const i = dayIndex(p.plannedDate);
  if (p.platform === "youtube") return hasNews ? "news" : ROTATION[(i + 1) % ROTATION.length]!;
  if (p.platform === "facebook") return ROTATION[(i + 2) % ROTATION.length]!;
  return ROTATION[i % ROTATION.length]!;
}

/** Fresh news a news video can be about: found in the last 3 days, on-topic, not used yet. Best first. */
export function newsCandidates(trends: Trend[], brandId: string, now = new Date()): Trend[] {
  return trends
    .filter((t) => t.brandId === brandId && t.status === "new" && (t.source === "news" || t.source === "google-trends") && t.score >= 60 && now.getTime() - Date.parse(t.foundAt) < 3 * 86_400_000 && !!t.url)
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
}

/* ------------------------------------------------------------------ */
/* Scripts                                                             */
/* ------------------------------------------------------------------ */

const line = z.string().min(3).max(140);

export const CARTOON_STORIES = {
  garmi: { lines: 7, about: "summer heat and saving electricity", scenes: ["title card", "a scorching hot day: angry sun, heat waves, Earth Buddy sweating", "an empty room with the fan and light left on", "the two kids (Chhotu and Pinky) switch them off and plant a sapling", "the sky cools down and the plant grows", "everyone celebrates together", "closing card"] },
  battery: { lines: 7, about: "old batteries and e-waste", scenes: ["title card", "a TV shows breaking news (the headline field)", "an X-ray look inside a battery", "the danger of throwing batteries in the dustbin (fire, toxic leaks)", "collecting e-waste properly; an electric car drives past", "everyone happy, with two big words on screen (happy_1, happy_2)", "closing card"] },
  subah: { lines: 6, about: "a greener morning routine", scenes: ["title card", "closing the tap while brushing teeth", "carrying a steel bottle instead of buying plastic", "taking a cloth/jute bag to the vegetable stall", "everyone happy, with two big words on screen (happy_1, happy_2)", "closing card"] },
  plastic: { lines: 6, about: "sorting waste at home", scenes: ["title card", "litter lying around a park", "sorting items into wet and dry bins", "dry waste turning into new things (recycling loop)", "everyone happy, with two big words on screen (happy_1, happy_2)", "closing card"] },
} as const;
export type CartoonStory = keyof typeof CARTOON_STORIES;

export const ScriptSchemas = {
  news: z.object({ headline: line, source: z.string().min(2).max(60), points: z.array(line).min(1).max(2), action: line, question: line }),
  quiz: z.object({ hook: line, question: line, options: z.array(z.string().min(1).max(40)).length(3), answer: z.number().int().min(0).max(2), explain: line }),
  myth: z.object({ hook: line, pairs: z.array(z.object({ myth: line, fact: line })).min(1).max(2) }),
  hack: z.object({ hook: line, steps: z.array(line).min(2).max(4), payoff: line }),
  cartoon: z.object({
    story: z.enum(Object.keys(CARTOON_STORIES) as [CartoonStory, ...CartoonStory[]]),
    title_small: z.string().min(2).max(30),
    title_big: z.string().min(2).max(30),
    headline: z.string().max(80).optional(),
    happy_1: z.string().max(20).optional(),
    happy_2: z.string().max(20).optional(),
    lines: z.array(z.object({ say: z.string().min(2).max(220), sub: z.string().min(2).max(120) })).min(6).max(7),
  }),
} satisfies Record<VideoSeries, z.ZodTypeAny>;

export type SeriesScript<S extends VideoSeries = VideoSeries> = z.infer<(typeof ScriptSchemas)[S]>;

const POST_FIELDS = '"hook":"...","caption":"...","description":"...","keywords":["..."],"hashtags":["#..."],"cta":"...","thumbnailConcept":"..."';

const VIDEO_SHAPE: Record<VideoSeries, string> = {
  news: '{"headline":"the story in under 14 words","source":"publication name","points":["what it means for an ordinary household, under 16 words"],"action":"one thing viewers can do today","question":"a question for the comments"}',
  quiz: '{"hook":"a challenge line, e.g. Only 1 in 10 get this right!","question":"the quiz question","options":["A","B","C"],"answer":1,"explain":"why, in one short sentence"}',
  myth: '{"hook":"e.g. 2 myths about X you still believe","pairs":[{"myth":"the myth as people say it","fact":"the correct fact, simply"}]}',
  hack: '{"hook":"e.g. Cut your electricity bill in 3 steps","steps":["step 1","step 2","step 3"],"payoff":"the result, in a few words"}',
  cartoon: '{"story":"garmi","title_small":"small top title (Hinglish)","title_big":"BIG TITLE (2-3 words)","headline":"(battery story only) TV headline","happy_1":"(battery/subah/plastic) first big word line","happy_2":"second big word line","lines":[{"say":"Hindi in Devanagari, spoken","sub":"the same line in Hinglish (Latin letters) for subtitles"}]}',
};

const SERIES_RULES: Record<VideoSeries, string> = {
  news:
    "SERIES: Daily climate news (20-30 seconds). Report ONLY what the headline below says; never add numbers, names or claims that are not in it. Explain in plain words what it means for an ordinary family in India and one thing they can do today. Credit the source by name in the caption (e.g. 'Source: The Hindu'). On YouTube also put the link on its own line at the end of the description; on Instagram and Facebook do not paste the link (it isn't clickable there). Calm, factual, no fear-mongering, no politics or blame.",
  quiz:
    "SERIES: Quiz (about 25 seconds). One multiple-choice question on everyday sustainability (waste sorting, energy, water, food, transport, climate basics) whose answer is common knowledge and certain. Exactly three short options; only one is right. The caption asks people to comment their answer BEFORE watching to the end, without giving it away.",
  myth:
    "SERIES: Myth vs fact (20-25 seconds). One or two myths people in India commonly believe about the topic, each busted with a simple, certain fact (no statistics unless they are in the verified facts). Friendly, never mocking.",
  hack:
    "SERIES: Eco hack (20-25 seconds). One practical hack anyone can do at home today with no special products, in 2-4 short steps of under 12 words each, and the payoff. Concrete actions, not advice like 'be mindful'.",
  cartoon:
    "SERIES: Cartoon story (25-35 seconds) with Earth Buddy and two kids, Chhotu and Pinky. Pick the story whose scenes best fit the topic, then write exactly one spoken line per scene, in order (the number of lines must match the story). Lines are short (under 15 words), warm and fun, in simple Hindi written in Devanagari for the voice, each with a Hinglish subtitle in Latin letters. The last line invites people to download KarmaVerse.",
};

/** The prompt for one series post: platform copy plus the video script, as one JSON object. */
/** What keeps people watching short vertical videos; applies to every series. */
export const ENGAGEMENT_RULES = [
  "ENGAGEMENT (people decide in the first 2 seconds):",
  "- The first spoken line is the hook: a surprising fact, a bold claim, a 'Stop!' or a question the viewer wants answered. Never start with a greeting or the brand name.",
  "- Open a loop early ('the last one surprised me') and pay it off at the end, so people watch to the end.",
  "- One idea per line; everyday Indian examples (chai cup, Diwali, monsoon, auto-rickshaw, society WhatsApp group) beat abstract words.",
  "- Speak to one person ('you'), with energy; use a number when it helps ('3 things', '10 seconds').",
  "- End with one clear, small action and a question people can answer in the comments.",
].join("\n");

export function seriesPrompt(brand: Brand, piece: Pick<ContentPiece, "platform" | "format" | "topic" | "hook" | "pillarId">, series: VideoSeries, news?: Pick<Trend, "title" | "url" | "detail" | "date">, character?: string): string {
  const stories = Object.entries(CARTOON_STORIES)
    .map(([k, s]) => `- ${k} (${s.lines} lines, about ${s.about}): ${s.scenes.map((x, i) => `${i + 1}. ${x}`).join("; ")}`)
    .join("\n");
  return [
    brandContext(brand),
    "",
    `TASK: Write one ${piece.platform} ${piece.format} post and the script for its video.`,
    series === "news" && news
      ? `NEWS STORY (the only facts you may use about it):\nHEADLINE: ${news.title}\nSOURCE: ${news.detail.split(" · ")[0] ?? ""}\nLINK: ${news.url}\nPUBLISHED: ${news.date.slice(0, 10)}`
      : `TOPIC: ${piece.topic}${piece.hook ? `\nCURRENT HOOK: ${piece.hook}` : ""}\nPILLAR: ${piece.pillarId}`,
    "",
    SERIES_RULES[series],
    series === "cartoon" ? `STORIES:\n${stories}` : "",
    series !== "cartoon" && character ? characterBrief(character) : "",
    ENGAGEMENT_RULES,
    "",
    "POST GUIDANCE:",
    piece.platform === "youtube"
      ? "- youtube short: hook = title under 60 characters with a searchable keyword; description 2-3 lines; keywords 5-8; 2-3 hashtags including #Shorts."
      : piece.platform === "facebook"
        ? "- facebook reel: warm and conversational, 40-90 words, 1-3 hashtags, end with a question."
        : "- instagram reel: hook under 10 words; short caption with line breaks; 5-8 hashtags; CTA to save, share or comment.",
    "",
    "Every line shown in the video (headline, points, steps, myths, facts, options, questions) must be under 16 words: people read it on a phone in two seconds.",
    'RETURN JSON: one object: {' + POST_FIELDS + ',"video":' + VIDEO_SHAPE[series] + "}",
    READY_TO_POST.trim() + (series === "news" ? " (Exception for this news post: do credit the news source and include its link.)" : ""),
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

export interface SeriesScene extends Omit<BuddyScene, "kind"> {
  kind: BuddyScene["kind"] | "headline" | "action" | "quiz" | "answer" | "myth" | "fact" | "step" | "payoff";
  question?: string;
  options?: string[];
  answer?: number;
  explain?: string;
  hold?: number;
  source?: string;
  date?: string;
}

function sc(kind: SeriesScene["kind"], text: string, extra: Partial<SeriesScene> = {}): SeriesScene {
  const { say, ...rest } = extra;
  return { kind, text: tidy(text), say: speakable(say ?? text), ...rest };
}

const niceDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};

/** Scenes Earth Buddy speaks for a series script (cartoon is rendered separately). */
export function scenesFromScript(brand: Brand, series: Exclude<VideoSeries, "cartoon">, script: SeriesScript, newsDate = ""): SeriesScene[] {
  const out: SeriesScene[] = [];
  if (series === "news") {
    const s = script as SeriesScript<"news">;
    out.push(sc("headline", s.headline, { source: s.source, date: niceDate(newsDate) }));
    for (const p of s.points) out.push(sc("point", p));
    out.push(sc("action", s.action));
    out.push(sc("question", s.question));
  } else if (series === "quiz") {
    const s = script as SeriesScript<"quiz">;
    const letters = ["A", "B", "C"];
    out.push(sc("hook", s.hook, { label: "QUIZ TIME" }));
    out.push(sc("quiz", s.question, { question: s.question, options: s.options, answer: s.answer, hold: 3, say: `${s.question} ${s.options.map((o, i) => `${letters[i]}: ${o}.`).join(" ")}` }));
    out.push(sc("answer", `${letters[s.answer]}! ${s.explain}`, { question: s.question, options: s.options, answer: s.answer, explain: s.explain, say: `It's ${letters[s.answer]}, ${s.options[s.answer]}! ${s.explain}` }));
  } else if (series === "myth") {
    const s = script as SeriesScript<"myth">;
    out.push(sc("hook", s.hook));
    for (const p of s.pairs) {
      out.push(sc("myth", p.myth, { say: `Myth: ${p.myth}` }));
      out.push(sc("fact", p.fact, { say: `Fact: ${p.fact}` }));
    }
  } else {
    const s = script as SeriesScript<"hack">;
    out.push(sc("hook", s.hook));
    s.steps.forEach((st, i) => out.push(sc("step", st, { say: `Step ${i + 1}. ${st}` })));
    out.push(sc("payoff", s.payoff));
  }
  out.push({ kind: "cta", text: `Search ${brand.name} on Google Play!`, say: `Search ${brand.name} on Google Play, and make every sustainable gesture count!` });
  return out;
}

export function parseScript<S extends VideoSeries>(series: S, json: string): SeriesScript<S> | null {
  try {
    const r = ScriptSchemas[series].safeParse(JSON.parse(json));
    return r.success ? (r.data as SeriesScript<S>) : null;
  } catch {
    return null;
  }
}

/** Earth Buddy style for a series. */
export const SERIES_STYLE: Record<Exclude<VideoSeries, "cartoon">, BuddyStyle | "news" | "quiz" | "myth" | "hack"> = { news: "news", quiz: "quiz", myth: "myth", hack: "hack" };

/* ------------------------------------------------------------------ */
/* Cartoon                                                             */
/* ------------------------------------------------------------------ */

/** Renders a cartoon story (scripts/video/cartoon_story.py). Takes about 5 minutes. */
export async function renderCartoon(brand: Brand, script: SeriesScript<"cartoon">, opts: { outDir: string; dataFile: string; music: string; python?: string; ctaTop?: string; ctaButton?: string }): Promise<{ file: string; durationSec: number }> {
  const story = CARTOON_STORIES[script.story];
  if (script.lines.length !== story.lines) throw new Error(`The ${script.story} story needs ${story.lines} lines, got ${script.lines.length}.`);
  const assets = brandAssets(brand, opts.dataFile);
  const work = await mkdtemp(path.join(tmpdir(), "cartoon-"));
  const out = path.join(opts.outDir, `${newId("cartoon")}.mp4`);
  const spec = {
    ffmpeg: ffmpegBinary(),
    work,
    out,
    music: opts.music,
    logo: assets.logo,
    partnerLogo: assets.partnerLogo,
    mascot: assets.mascot,
    // Bright reel look: punchier colours, big word captions, stickers, progress bar.
    reel: true,
    story: script.story,
    lines: script.lines,
    title_small: script.title_small,
    title_big: script.title_big,
    headline: script.headline,
    happy_1: script.happy_1?.toUpperCase(),
    happy_2: script.happy_2?.toUpperCase(),
    cta_top: opts.ctaTop || "KarmaVerse download karo!",
    cta_button: opts.ctaButton || `Search “${brand.name}”`,
    cta_site: brand.website.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  };
  const specFile = path.join(work, "spec.json");
  await writeFile(specFile, JSON.stringify(spec), "utf8");
  const script_ = path.join(process.cwd(), "scripts", "video", "cartoon_story.py");
  const python = opts.python || process.env.PYTHON?.trim() || "python";
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const p = spawn(/*turbopackIgnore: true*/ python, [script_, specFile], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", (err) => reject(new Error(`Could not start Python (${python}): ${err.message}`)));
      p.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`The cartoon renderer stopped (code ${code}): ${stderr.trim().split("\n").slice(-3).join(" ")}`))));
    });
    const r = JSON.parse(output.trim().split("\n").pop() ?? "{}") as { file: string; durationSec: number };
    log.info("Cartoon story made", { file: r.file, story: script.story, seconds: r.durationSec });
    return r;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
