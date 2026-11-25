import type { Brand, Format, GeneratedPlatformContent, Idea, Platform } from "../schemas";
import { PLATFORM_FORMATS } from "../schemas";
import { clip, pick, slugTag } from "../util";
import { pillarKind, type PillarKind } from "./idea-bank";

type IdeaLike = Pick<Idea, "title" | "angle" | "pillarId" | "audienceQuestion">;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function kindOf(brand: Brand, pillarId: string): PillarKind {
  const p = brand.pillars.find((x) => x.id === pillarId);
  return p ? pillarKind(p) : "edu";
}

/** A verified fact the copy may state, or null. Unverified facts are never used. */
export function verifiedFact(brand: Brand, seed: string): string | null {
  const facts = brand.facts.filter((f) => f.verified);
  return facts.length ? pick(facts, seed).text : null;
}

function pillarTags(kind: PillarKind): string[] {
  const map: Record<PillarKind, string[]> = {
    habits: ["#SustainableLiving", "#EcoHabits", "#SmallSwaps"],
    myths: ["#MythVsFact", "#ClimateFacts", "#SustainabilityMyths"],
    edu: ["#LearnOnInstagram", "#EcoTips", "#WasteSegregation"],
    community: ["#EcoChallenge", "#CommunityAction", "#GreenCommunity"],
    product: ["#HowTo", "#AppTips", "#RecyclingMadeEasy"],
    circular: ["#CircularEconomy", "#ReduceReuseRecycle", "#ConsciousConsumer"],
    bts: ["#BehindTheScenes", "#StartupIndia", "#BuildingInPublic"],
    impact: ["#ImpactUpdate", "#ClimateAction", "#CommunityImpact"],
  };
  return map[kind];
}

function hashtags(brand: Brand, kind: PillarKind, idea: IdeaLike, count: number): string[] {
  const topic = slugTag(idea.title.split(":")[0]!.split(" ").slice(0, 3).join(" "));
  const all = [...brand.hashtags.slice(0, 2), ...pillarTags(kind), topic, ...brand.hashtags.slice(2)];
  return [...new Set(all)].filter((t) => t.length > 1).slice(0, count);
}

function ctaFor(brand: Brand, platform: Platform, format: Format, kind: PillarKind): string {
  if (kind === "product") return brand.defaultCtas.find((c) => /book|download|app/i.test(c)) ?? "Try it in the app";
  if (platform === "linkedin") return "What has worked in your organisation? Tell us in the comments.";
  if (format === "carousel" || kind === "edu" || kind === "myths") return "Save this for later and share it with someone who needs it.";
  if (kind === "community") return "Comment 'I'm in' to join.";
  return pick(brand.defaultCtas, `${platform}${format}${kind}`) ?? "Tell us in the comments.";
}

function shortHook(idea: IdeaLike, kind: PillarKind, seed: string): string {
  const base = idea.title.replace(/^Answering you: /, "").replace(/^Trend: /, "");
  const byKind: Record<PillarKind, string[]> = {
    habits: [`Try this today: ${base}`, `Start here: ${base}`],
    myths: [`Myth or fact? ${base.replace(/^Myth( or fact)?:?\s*/i, "")}`, `Stop believing this: ${base.replace(/^Myth( or fact)?:?\s*/i, "")}`],
    edu: [`${base} — explained fast`, `In 30 seconds: ${base}`],
    community: [`Join us: ${base}`, `Are you in? ${base}`],
    product: [`How it works: ${base}`, `Watch: ${base}`],
    circular: [`Before you throw it away: ${base}`, `${base}`],
    bts: [`Behind the scenes: ${base}`, `${base}`],
    impact: [`Update: ${base}`, `${base}`],
  };
  return pick(byKind[kind], seed);
}

/* ------------------------------------------------------------------ */
/* Platform adapters                                                   */
/* ------------------------------------------------------------------ */

function instagramReel(brand: Brand, idea: IdeaLike, kind: PillarKind): GeneratedPlatformContent {
  const hook = shortHook(idea, kind, `${idea.title}ig`);
  const fact = verifiedFact(brand, idea.title);
  const caption = [
    hook,
    "",
    idea.angle ? `${idea.angle}.` : "",
    kind === "product" && fact ? fact : "",
    "",
    `👇 ${ctaFor(brand, "instagram", "reel", kind)}`,
  ]
    .filter((l, i, arr) => l !== "" || arr[i - 1] !== "")
    .join("\n");
  return {
    platform: "instagram",
    format: "reel",
    hook,
    caption,
    description: "",
    keywords: [],
    hashtags: hashtags(brand, kind, idea, 7),
    cta: ctaFor(brand, "instagram", "reel", kind),
    thumbnailConcept: `Cover text: "${clip(hook, 40)}". Close-up of the main object or a face reacting, brand colours, text in the centre safe area.`,
  };
}

function instagramCarousel(brand: Brand, idea: IdeaLike, kind: PillarKind): GeneratedPlatformContent {
  const hook = shortHook(idea, kind, `${idea.title}carousel`);
  const slides = [
    `Slide 1: ${hook}`,
    `Slide 2: The problem — ${idea.audienceQuestion || "why this matters"}`,
    "Slide 3: Point 1 [one clear tip or fact]",
    "Slide 4: Point 2 [one clear tip or fact]",
    "Slide 5: Point 3 [one clear tip or fact]",
    "Slide 6: Quick recap in one line",
    `Slide 7: ${ctaFor(brand, "instagram", "carousel", kind)}`,
  ];
  return {
    platform: "instagram",
    format: "carousel",
    hook,
    caption: [hook, "", "Swipe through 👉", "", ...slides, "", ctaFor(brand, "instagram", "carousel", kind)].join("\n"),
    description: "",
    keywords: [],
    hashtags: hashtags(brand, kind, idea, 6),
    cta: ctaFor(brand, "instagram", "carousel", kind),
    thumbnailConcept: `Slide 1 cover: bold headline "${clip(hook, 45)}" on brand background, one simple icon.`,
  };
}

function instagramStory(brand: Brand, idea: IdeaLike, kind: PillarKind): GeneratedPlatformContent {
  const hook = `Quick poll: ${idea.audienceQuestion || idea.title}`;
  return {
    platform: "instagram",
    format: "story",
    hook,
    caption: `Frame 1: ${hook} (poll sticker)\nFrame 2: The answer + one tip\nFrame 3: Link sticker or 'More in our latest post'`,
    description: "",
    keywords: [],
    hashtags: [],
    cta: "Vote in the poll",
    thumbnailConcept: "",
  };
}

function youtubeShort(brand: Brand, idea: IdeaLike, kind: PillarKind): GeneratedPlatformContent {
  const title = clip(idea.title.replace(/^Answering you: /, ""), 58);
  const keywords = [...new Set([idea.title.split(":")[0]!.toLowerCase(), kind === "edu" ? "how to" : kind, "sustainability india", "eco tips", "recycling", brand.name.toLowerCase()])].slice(0, 7);
  return {
    platform: "youtube",
    format: "short",
    hook: title,
    caption: "",
    description: [`${idea.angle || idea.title}.`, idea.audienceQuestion ? `Answers: ${idea.audienceQuestion}` : "", `Subscribe for one practical sustainability tip at a time.`].filter(Boolean).join("\n"),
    keywords,
    hashtags: ["#Shorts", ...brand.hashtags.slice(0, 2)],
    cta: "Subscribe for more quick tips",
    thumbnailConcept: "Shorts use a frame from the video; pick a frame with the main object and the on-screen title visible.",
  };
}

function youtubeLong(brand: Brand, idea: IdeaLike, kind: PillarKind): GeneratedPlatformContent {
  const title = idea.title.replace(/^Answering you: /, "");
  return {
    platform: "youtube",
    format: "long-video",
    hook: clip(title, 70),
    caption: "",
    description: [`${idea.angle || title}.`, "", "In this video:", "00:00 Intro", "[chapters TBD after edit]", "", `About ${brand.name}: ${verifiedFact(brand, title) ?? "[CONFIRM: one-line brand description]"}`].join("\n"),
    keywords: [title.toLowerCase(), "sustainability", "india", kind, brand.name.toLowerCase()],
    hashtags: brand.hashtags.slice(0, 3),
    cta: "Subscribe and tell us what to cover next",
    thumbnailConcept: `3–4 words max (e.g. "${title.split(" ").slice(0, 3).join(" ")}"), a face or hand holding the key object, high contrast, readable at phone size.`,
  };
}

function linkedinPost(brand: Brand, idea: IdeaLike, kind: PillarKind, format: Format): GeneratedPlatformContent {
  const hook = kind === "bts" || kind === "impact" ? idea.title : `${idea.audienceQuestion || idea.title}`;
  const fact = verifiedFact(brand, `${idea.title}li`);
  const body = [
    hook,
    "",
    `${idea.angle || "Here is what we have learned"}.`,
    "",
    "Three things that stand out:",
    "1. [Insight 1, specific and practical]",
    "2. [Insight 2, specific and practical]",
    "3. [Insight 3, with a verified number if available: CONFIRM]",
    "",
    fact ? `Context: ${fact}` : "",
    "",
    ctaFor(brand, "linkedin", format, kind),
  ].filter((l, i, arr) => l !== "" || arr[i - 1] !== "");
  return {
    platform: "linkedin",
    format,
    hook,
    caption: body.join("\n"),
    description: format === "document-carousel" ? "Document carousel: 6–8 pages, one insight per page, brand template, final page with the question." : "",
    keywords: [],
    hashtags: [...pillarTags(kind).slice(0, 2), "#Sustainability"].slice(0, 3),
    cta: ctaFor(brand, "linkedin", format, kind),
    thumbnailConcept: format === "document-carousel" ? `Cover page: "${clip(hook, 50)}"` : "",
  };
}

function facebookPost(brand: Brand, idea: IdeaLike, kind: PillarKind, format: Format): GeneratedPlatformContent {
  const hook = shortHook(idea, kind, `${idea.title}fb`);
  return {
    platform: "facebook",
    format,
    hook,
    caption: [hook, "", `${idea.angle || idea.title}.`, "", idea.audienceQuestion ? `Has your family wondered: ${idea.audienceQuestion}` : "", "Tell us in the comments 👇"].filter(Boolean).join("\n"),
    description: "",
    keywords: [],
    hashtags: brand.hashtags.slice(0, 2),
    cta: "Tell us in the comments",
    thumbnailConcept: format === "reel" ? `Cover text: "${clip(hook, 40)}"` : "",
  };
}

/** X counts most characters as 1, links as 23 and emoji/CJK as 2. Approximate, on the safe side. */
export function xLength(text: string): number {
  let n = 0;
  for (const part of text.split(/(https?:\/\/\S+)/)) {
    if (/^https?:\/\//.test(part)) n += 23;
    else for (const ch of part) n += (ch.codePointAt(0) ?? 0) > 0x2fff ? 2 : 1;
  }
  return n;
}

export const X_MAX = 280;

function xPost(brand: Brand, idea: IdeaLike, kind: PillarKind, format: Format): GeneratedPlatformContent {
  const hook = shortHook(idea, kind, `${idea.title}x`);
  const tags = hashtags(brand, kind, idea, 2);
  const cta = kind === "product" ? ctaFor(brand, "x", format, kind) : "What would you add? Reply 👇";
  const tail = `\n\n${cta}`;
  let body = [hook, idea.angle ? `${idea.angle}.` : ""].filter(Boolean).join("\n\n");
  const room = X_MAX - xLength(tail) - xLength(`\n\n${tags.join(" ")}`);
  if (xLength(body) > room) body = clip(body, Math.max(40, room - 5));
  return {
    platform: "x",
    format,
    hook,
    caption: `${body}${tail}`,
    description: "",
    keywords: [],
    hashtags: tags,
    cta,
    thumbnailConcept: format === "image-post" ? `Image with 3–5 words: "${clip(hook, 40)}"` : "",
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function generatePlatformVersion(brand: Brand, idea: IdeaLike, platform: Platform, format: Format): GeneratedPlatformContent {
  if (!PLATFORM_FORMATS[platform].includes(format)) {
    throw new Error(`${format} is not a supported format on ${platform}.`);
  }
  const kind = kindOf(brand, idea.pillarId);
  switch (platform) {
    case "instagram":
      if (format === "carousel" || format === "image-post") return instagramCarousel(brand, idea, kind);
      if (format === "story") return instagramStory(brand, idea, kind);
      return instagramReel(brand, idea, kind);
    case "youtube":
      return format === "long-video" ? youtubeLong(brand, idea, kind) : youtubeShort(brand, idea, kind);
    case "linkedin":
      return linkedinPost(brand, idea, kind, format);
    case "facebook":
      return facebookPost(brand, idea, kind, format);
    case "x":
      return xPost(brand, idea, kind, format);
  }
}

/** Default format per platform when the user picks only platforms. */
export const DEFAULT_FORMAT: Record<Platform, Format> = {
  instagram: "reel",
  youtube: "short",
  linkedin: "text-post",
  facebook: "image-post",
  x: "text-post",
};

/* ------------------------------------------------------------------ */
/* Brand-safety lint                                                   */
/* ------------------------------------------------------------------ */

export interface LintWarning {
  level: "warn" | "block";
  message: string;
}

const RISKY = [
  { re: /\bguarantee(d)?\b/i, msg: "Avoid guarantees (views, rewards, results)." },
  { re: /\b(go|goes|went) viral\b/i, msg: "Do not promise virality." },
  { re: /\b\d+(\.\d+)?\s?(%|percent|kg|tonnes?|lakh|crore|million)\b/i, msg: "Contains a number. Make sure it is a verified fact or mark it [CONFIRM]." },
  { re: /\b(carbon[- ]neutral|net[- ]zero|100% (eco|green))\b/i, msg: "Environmental claim needs evidence before publishing." },
];

/** Flags claims that need evidence and any phrases the brand has banned. */
export function lintContent(brand: Brand, text: string): LintWarning[] {
  const out: LintWarning[] = [];
  for (const r of RISKY) if (r.re.test(text)) out.push({ level: "warn", message: r.msg });
  for (const phrase of brand.avoid) {
    const words = phrase.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    if (words.length && words.every((w) => text.toLowerCase().includes(w))) out.push({ level: "block", message: `Uses an avoided phrase: "${phrase}".` });
  }
  if (/\[CONFIRM/i.test(text)) out.push({ level: "block", message: "Has [CONFIRM] placeholders. Replace them with verified facts before approval." });
  else if (/\[[^\]]{3,}\]/.test(text)) out.push({ level: "block", message: "Has [bracketed] placeholders. Fill them in before approval." });
  return out;
}
