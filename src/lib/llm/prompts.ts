import type { Brand, Format, Idea, Platform } from "../schemas";

/** Shared brand context so every prompt carries the same rules. */
export function brandContext(brand: Brand): string {
  const verified = brand.facts.filter((f) => f.verified).map((f) => `- ${f.text}`);
  const unverified = brand.facts.filter((f) => !f.verified).map((f) => `- ${f.text}`);
  const pillars = brand.pillars.map((p) => `- ${p.id}: ${p.name} — ${p.description}`);
  return [
    `BRAND: ${brand.name}${brand.organisation ? ` by ${brand.organisation}` : ""}`,
    `CATEGORY: ${brand.category}`,
    `AUDIENCE: ${brand.audience.join("; ")}`,
    `VOICE: ${brand.voice.join(", ")}`,
    `LANGUAGES: ${brand.languages.join(", ")}`,
    `CONTENT PILLARS:\n${pillars.join("\n")}`,
    `VERIFIED FACTS (you may state these):\n${verified.join("\n") || "- none"}`,
    `UNVERIFIED FACTS (never state as fact; if needed write [CONFIRM: ...]):\n${unverified.join("\n") || "- none"}`,
    `NEVER USE: ${brand.avoid.join("; ") || "-"}`,
    `BRAND HASHTAGS: ${brand.hashtags.join(" ")}`,
    ...teamDirection(brand),
    "",
    "HARD RULES:",
    "- Do not invent statistics, testimonials, product features, partner names or reward amounts. Use [CONFIRM: ...] placeholders instead.",
    "- Do not promise views, followers, virality or guaranteed rewards.",
    "- Adapt each platform version: different length, tone, structure and CTA. Never paste the same text across platforms.",
  ].join("\n");
}

/** The team's standing instructions and goals from the "Tell the team" box (newest last; newer wins on conflict). */
export function teamDirection(brand: Pick<Brand, "instructions" | "goals">): string[] {
  const rules = (brand.instructions ?? []).filter((i) => i.active).map((i) => `- ${i.text}`);
  const goals = (brand.goals ?? []).filter((g) => g.active).map((g) => `- ${g.text}`);
  return [
    ...(rules.length ? [`TEAM INSTRUCTIONS (always follow; if two conflict, the later one wins; the hard rules below still apply):\n${rules.join("\n")}`] : []),
    ...(goals.length ? [`GOALS THE TEAM WANTS (choose angles, hooks and CTAs that move these):\n${goals.join("\n")}`] : []),
  ];
}

export const CONTENT_SYSTEM =
  "You are a senior social media strategist and copywriter. You return only valid JSON that matches the requested shape, with no commentary.";

export function contentPrompt(brand: Brand, idea: Pick<Idea, "title" | "angle" | "pillarId" | "audienceQuestion">, targets: Array<{ platform: Platform; format: Format }>): string {
  const list = targets.map((t) => `- ${t.platform} / ${t.format}`).join("\n");
  return [
    brandContext(brand),
    "",
    "TASK: Write platform-specific versions of this content idea.",
    `IDEA: ${idea.title}`,
    idea.angle ? `ANGLE: ${idea.angle}` : "",
    idea.audienceQuestion ? `AUDIENCE QUESTION IT ANSWERS: ${idea.audienceQuestion}` : "",
    `PILLAR: ${idea.pillarId}`,
    `VERSIONS NEEDED:\n${list}`,
    "",
    "PLATFORM GUIDANCE:",
    "- instagram reel: hook under 10 words for the first 2 seconds; short caption with line breaks; 5–8 hashtags; CTA to save, share or comment; thumbnailConcept = cover text + visual.",
    "- instagram carousel: hook = slide 1 headline; caption lists the slide outline (Slide 1..7); 5–8 hashtags; CTA to save.",
    "- youtube short: hook = title under 60 characters with a searchable keyword; description 2–3 lines; keywords 5–8; 2–3 hashtags including #Shorts.",
    "- youtube long-video: hook = title; description with a summary and [chapters TBD]; keywords; thumbnailConcept with 3–4 words of text.",
    "- linkedin: professional, first line is the hook, 120–220 words, short paragraphs, max 3 hashtags, end with a genuine question.",
    "- facebook: warm and conversational for communities and families, 40–90 words, 1–3 hashtags, end with a question.",
    "- x: one sharp post, caption including hashtags must fit 280 characters (links count as 23), 1–2 hashtags, end with a question or a reason to reply.",
    "",
    "RETURN JSON: an array, one object per version:",
    '[{"platform":"instagram","format":"reel","hook":"...","caption":"...","description":"","keywords":["..."],"hashtags":["#..."],"cta":"...","thumbnailConcept":"..."}]',
  ]
    .filter(Boolean)
    .join("\n");
}

export const BRIEF_SYSTEM =
  "You are a video creative director who writes production briefs for small teams using free editing software. You return only valid JSON with no commentary.";

export function briefPrompt(brand: Brand, idea: Pick<Idea, "title" | "angle" | "pillarId">, platform: Platform, format: Format, durationSec: number): string {
  return [
    brandContext(brand),
    "",
    "TASK: Write a complete video production brief.",
    `IDEA: ${idea.title}`,
    idea.angle ? `ANGLE: ${idea.angle}` : "",
    `PLATFORM / FORMAT: ${platform} / ${format}`,
    `TARGET DURATION: ${durationSec} seconds`,
    "",
    "Include: objective, audience, exactly 3 alternative opening hooks, a timestamped script (seconds), a scene-by-scene storyboard with camera, framing, transition and B-roll, subtitle notes, voiceover direction, music mood, editing instructions, thumbnail concept, 3 title options, final CTA, effort level (low/medium/high) with estimated hours, and free editing tools to use.",
    "Script and storyboard timestamps must start at 0, be in order and end at the target duration.",
    "",
    "RETURN JSON with exactly these keys:",
    '{"title":"","objective":"","audience":"","hooks":["","",""],"durationSec":30,"script":[{"start":0,"end":3,"voiceover":"","onScreenText":""}],"storyboard":[{"scene":1,"start":0,"end":3,"visual":"","camera":"","framing":"","transition":"","bRoll":""}],"subtitleNotes":"","voiceover":"","musicMood":"","editingInstructions":[""],"thumbnailConcept":"","titleOptions":["","",""],"cta":"","effort":{"level":"low","hours":2},"freeTools":[""]}',
  ]
    .filter(Boolean)
    .join("\n");
}
