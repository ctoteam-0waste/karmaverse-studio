import type { Brand, Format, Idea, Platform, VideoBrief } from "../schemas";
import { clip, newId, nowIso, round } from "../util";
import { pillarKind } from "./idea-bank";
import { verifiedFact } from "./content";

type IdeaLike = Pick<Idea, "title" | "angle" | "pillarId" | "audienceQuestion"> & { id?: string };

export const FREE_TOOLS = [
  "DaVinci Resolve (free version) — editing, colour, Fairlight audio",
  "Shotcut (open source) — simple cuts, captions, exports",
  "Kdenlive (open source) — multi-track editing with subtitle tool",
  "Canva (free plan) — thumbnails and title cards",
  "Audacity (open source) — voiceover cleanup",
];

export function defaultDuration(format: Format): number {
  if (format === "long-video") return 300;
  if (format === "story") return 15;
  return 30;
}

interface Beat {
  share: number;
  voiceover: string;
  onScreen: string;
  visual: string;
  camera: string;
  framing: string;
  transition: string;
  bRoll: string;
}

function beatsFor(brand: Brand, idea: IdeaLike, longForm: boolean, hook: string): Beat[] {
  const kind = pillarKind(brand.pillars.find((p) => p.id === idea.pillarId) ?? { id: idea.pillarId, name: "" });
  // Brand facts only belong in product and impact videos; elsewhere the editor fills point 3.
  const fact = kind === "product" || kind === "impact" ? verifiedFact(brand, idea.title) : null;
  const showsApp = kind === "product";
  const core: Beat[] = [
    {
      share: longForm ? 0.04 : 0.1,
      voiceover: hook,
      onScreen: hook,
      visual: "Presenter or hands with the main object, mid-action — no logo intro",
      camera: "Handheld, slight push-in",
      framing: "Close-up, subject in the centre third",
      transition: "Hard cut",
      bRoll: "",
    },
    {
      share: longForm ? 0.12 : 0.17,
      voiceover: idea.audienceQuestion ? `A lot of you asked: ${idea.audienceQuestion}` : "Here's the problem most people don't notice.",
      onScreen: idea.audienceQuestion || "The problem",
      visual: "Show the everyday situation the viewer recognises",
      camera: "Static on a tripod",
      framing: "Medium shot",
      transition: "Jump cut",
      bRoll: "Real household or street footage of the problem",
    },
    {
      share: longForm ? 0.22 : 0.2,
      voiceover: "First: [point 1 — one practical step].",
      onScreen: "1. [point 1]",
      visual: showsApp ? "Screen recording of the app step (blur personal data)" : "Demonstrate point 1",
      camera: showsApp ? "Screen capture" : "Overhead or over-the-shoulder",
      framing: "Tight on the action",
      transition: "Whip pan or quick cut on movement",
      bRoll: "Close-up insert of the key detail",
    },
    {
      share: longForm ? 0.22 : 0.2,
      voiceover: "Second: [point 2].",
      onScreen: "2. [point 2]",
      visual: "Demonstrate point 2",
      camera: "Handheld follow",
      framing: "Medium close-up",
      transition: "Cut on action",
      bRoll: "Second angle of the same action",
    },
    {
      share: longForm ? 0.25 : 0.2,
      voiceover: fact ? `And remember: ${fact}` : "And the part people miss: [point 3 or verified fact — CONFIRM].",
      onScreen: fact ? "Good to know" : "3. [point 3]",
      visual: "Result or payoff shot",
      camera: "Slow push-in",
      framing: "Medium shot with the result clearly visible",
      transition: "Match cut",
      bRoll: "Satisfying 'after' shot",
    },
  ];
  core.push({
    share: longForm ? 0.15 : 0.13,
    voiceover: `${brand.defaultCtas[0] ?? "Follow for more"}.`,
    onScreen: brand.defaultCtas[0] ?? "Follow for more",
    visual: "Presenter to camera or end card with brand colours",
    camera: "Static",
    framing: "Medium close-up, leave space for end-screen elements",
    transition: "Fade to end card",
    bRoll: "",
  });
  return core;
}

/**
 * Builds a structured production brief in Template mode.
 * This is a plan for a human editor — it does not render a video.
 */
export function generateVideoBrief(brand: Brand, idea: IdeaLike, platform: Platform, format: Format, durationSec = defaultDuration(format)): VideoBrief {
  const longForm = format === "long-video";
  const base = idea.title.replace(/^Answering you: /, "");
  const hooks: [string, string, string] = [
    `Stop scrolling if you've ever wondered: ${idea.audienceQuestion || base}`,
    `${base} — in ${longForm ? "a few minutes" : `${durationSec} seconds`}.`,
    `Most people get this wrong: ${base.toLowerCase()}`,
  ];
  const beats = beatsFor(brand, idea, longForm, hooks[0]);

  // Turn shares into exact second boundaries that end at durationSec.
  let t = 0;
  const bounds = beats.map((b, i) => {
    const start = t;
    const end = i === beats.length - 1 ? durationSec : round(t + b.share * durationSec, 0);
    t = end;
    return { start, end };
  });

  const script = beats.map((b, i) => ({ start: bounds[i]!.start, end: bounds[i]!.end, voiceover: b.voiceover, onScreenText: b.onScreen }));
  const storyboard = beats.map((b, i) => ({
    scene: i + 1,
    start: bounds[i]!.start,
    end: bounds[i]!.end,
    visual: b.visual,
    camera: b.camera,
    framing: b.framing,
    transition: b.transition,
    bRoll: b.bRoll,
  }));

  const hours = longForm ? 6 + durationSec / 120 : 1.5 + durationSec / 30;
  const level = hours <= 2.5 ? "low" : hours <= 5 ? "medium" : "high";

  return {
    id: newId("brief"),
    brandId: brand.id,
    ideaId: idea.id ?? null,
    contentId: null,
    platform,
    format,
    title: base,
    objective: longForm
      ? "Build search traffic and trust with a complete, practical answer."
      : "Earn watch-through and shares by delivering one useful idea fast.",
    audience: brand.audience.slice(0, 2).join(" and ") || "Core audience",
    hooks,
    durationSec,
    script,
    storyboard,
    subtitleNotes: "Burn in captions (most viewers watch muted). Max 2 lines, 32 characters per line, high-contrast box, keep clear of the bottom 20% where platform UI sits.",
    voiceover: `Warm, ${brand.voice.slice(0, 3).join(", ")}; conversational pace; record in a quiet room close to the mic. ${brand.languages.includes("Hinglish") ? "Hinglish is fine for Reels and Shorts." : ""}`.trim(),
    musicMood: longForm ? "Light, optimistic background bed at low volume; drop it under explanations." : "Upbeat, positive; use audio from the platform's licensed library or royalty-free sources only.",
    editingInstructions: [
      "Cut every pause; the first frame must already show action.",
      longForm ? "Add chapter markers matching the script sections." : "Keep every shot under 3 seconds unless it is the payoff.",
      "Add on-screen text from the script at each timestamp.",
      "Normalise audio to about -14 LUFS; duck music under voice.",
      "Blur faces of anyone who has not given consent, number plates and personal data on screens.",
      "Export 1080x1920 (vertical) for Reels/Shorts or 1920x1080 for long-form, H.264.",
    ],
    thumbnailConcept: longForm
      ? `3–4 words ("${base.split(" ").slice(0, 3).join(" ")}"), a face showing a clear emotion or a hand holding the key object, high contrast, brand colours.`
      : "Choose a frame where the main object and on-screen title are both visible.",
    titleOptions: [...new Set([clip(base, 60), clip(hooks[2], 60), clip(idea.audienceQuestion || `${base} explained`, 60)])],
    cta: brand.defaultCtas[0] ?? "Follow for more",
    effort: { level, hours: round(hours, 1) },
    freeTools: FREE_TOOLS,
    generatedBy: "template",
    createdAt: nowIso(),
    isSample: false,
    videoFile: null,
  };
}

/** Plain-text export a human editor can follow in any free editor. */
export function briefToMarkdown(b: VideoBrief): string {
  const ts = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  return [
    `# ${b.title}`,
    "",
    `Platform: ${b.platform} / ${b.format} · Duration: ${b.durationSec}s · Effort: ${b.effort.level} (~${b.effort.hours} h)`,
    "",
    `**Objective:** ${b.objective}`,
    `**Audience:** ${b.audience}`,
    "",
    "## Opening hooks (pick one)",
    ...b.hooks.map((h, i) => `${i + 1}. ${h}`),
    "",
    "## Script",
    ...b.script.map((l) => `- ${ts(l.start)}–${ts(l.end)} | VO: ${l.voiceover} | Text: ${l.onScreenText}`),
    "",
    "## Storyboard",
    ...b.storyboard.map((s) => `- Scene ${s.scene} (${ts(s.start)}–${ts(s.end)}): ${s.visual}. Camera: ${s.camera}. Framing: ${s.framing}. Transition: ${s.transition}.${s.bRoll ? ` B-roll: ${s.bRoll}.` : ""}`),
    "",
    `## Subtitles\n${b.subtitleNotes}`,
    `## Voiceover\n${b.voiceover}`,
    `## Music\n${b.musicMood}`,
    "## Editing",
    ...b.editingInstructions.map((e) => `- ${e}`),
    "",
    `## Thumbnail\n${b.thumbnailConcept}`,
    "## Title options",
    ...b.titleOptions.map((t) => `- ${t}`),
    "",
    `## CTA\n${b.cta}`,
    "",
    "## Free tools",
    ...b.freeTools.map((t) => `- ${t}`),
    "",
    "_This is a production plan. No video has been rendered._",
  ].join("\n");
}
