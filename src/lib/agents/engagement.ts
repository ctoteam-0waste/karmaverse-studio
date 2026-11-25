import type { Brand, ContentPiece, Format, InboxItem, Platform, PostMetric } from "../schemas";
import { PLATFORM_FORMATS } from "../schemas";
import { bestPostingTimes, classifyHook, groupKey, bucketForHour, hookPatterns, type HookType, type ScoredPost } from "../analytics/engine";
import { addDays, clip, round } from "../util";
import { DEFAULT_FORMAT, X_MAX, xLength } from "./content";
import { postText } from "../publishing/connectors";
import { DAILY_CADENCE } from "./strategy";

/**
 * H. Growth Booster Agent.
 *
 * Helps each post earn more views and meaningful engagement, using only the
 * post itself and this brand's own logged metrics:
 *
 * 1. Boost check before publishing: hook, CTA, hashtags, posting window, media,
 *    platform-specific details. Scores 0–100 with concrete fixes.
 * 2. Hook alternatives in other styles, led by the style that performs best in
 *    this brand's data.
 * 3. After-publish tasks for the first 48 hours (reply to comments, Story share,
 *    pin a comment) and a reminder to log metrics after 7 days.
 * 4. Repurpose winners: posts that beat their own history, suggested for
 *    platforms where that topic hasn't been posted yet.
 * 5. Consistency: posts per platform in the last and next 7 days vs the plan.
 *
 * It never buys, fakes or automates engagement (no bots, follow/unfollow,
 * engagement pods or mass comments). Platform guidance below is labelled as
 * guidance: the brand's own data overrides it once there is enough of it.
 */

export type CheckStatus = "pass" | "improve" | "fix";

export interface BoostCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Points earned out of `max`. */
  points: number;
  max: number;
}

export interface BoostReport {
  pieceId: string;
  score: number;
  checks: BoostCheck[];
  hookIdeas: Array<{ style: HookType; hook: string }>;
}

interface Guide {
  hookMax: number;
  hookWhy: string;
  tags: [number, number];
  needsMedia: boolean;
}

/** Platform guidance (general best practice, not this brand's data). */
const GUIDE: Record<Platform, Guide> = {
  instagram: { hookMax: 125, hookWhy: "Instagram cuts captions after about 125 characters with “more”.", tags: [3, 5], needsMedia: true },
  facebook: { hookMax: 120, hookWhy: "Facebook shows only the first lines before “See more”.", tags: [0, 3], needsMedia: false },
  linkedin: { hookMax: 150, hookWhy: "LinkedIn shows about two lines before “…see more”; the first line must earn the click.", tags: [1, 3], needsMedia: false },
  x: { hookMax: 100, hookWhy: "On X the first line decides whether people stop; the whole post must fit 280 characters.", tags: [0, 2], needsMedia: false },
  youtube: { hookMax: 60, hookWhy: "YouTube titles longer than about 60 characters get cut off on phones.", tags: [2, 5], needsMedia: true },
};

const CTA_WORDS = /\b(save|share|send|tag|comment|tell us|reply|follow|subscribe|vote|download|book|join|try|link)\b/i;

/* ------------------------------------------------------------------ */
/* Hook alternatives                                                   */
/* ------------------------------------------------------------------ */

function coreTopic(topic: string): string {
  return topic
    .replace(/^(answering you|trend|myth( or fact)?|how to|why|what|pov):?\s*/i, "")
    .replace(/[?.!]+$/, "")
    .trim();
}

const lower = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

export function hookVariant(style: HookType, topic: string): string {
  const t = coreTopic(topic);
  switch (style) {
    case "question":
      return `Do you know the right way to handle ${lower(t)}?`;
    case "myth-or-fact":
      return `Myth or fact: ${lower(t)}`;
    case "number-list":
      return `3 things nobody tells you about ${lower(t)}`;
    case "how-to":
      return `How to get ${lower(t)} right in 30 seconds`;
    case "pov-story":
      return `POV: you finally figured out ${lower(t)}`;
    case "warning":
      return `Stop doing this with ${lower(t)}`;
    case "statement":
      return `${t}: what actually works`;
  }
}

/** Three hook rewrites in styles other than the current one, best-performing style first. */
export function hookIdeas(piece: Pick<ContentPiece, "platform" | "format" | "hook" | "topic">, scored: ScoredPost[]): Array<{ style: HookType; hook: string }> {
  const current = classifyHook(piece.hook);
  const ranked = hookPatterns(scored)
    .filter((r) => r.group === groupKey(piece.platform, piece.format) && r.lift !== null && (r.lift ?? 0) > 0)
    .map((r) => r.label as HookType);
  const defaults: HookType[] = ["question", "myth-or-fact", "number-list", "how-to", "warning", "pov-story"];
  const order = [...new Set([...ranked, ...defaults])].filter((s) => s !== current);
  const max = GUIDE[piece.platform].hookMax;
  return order.slice(0, 3).map((style) => ({ style, hook: clip(hookVariant(style, piece.topic), max) }));
}

/* ------------------------------------------------------------------ */
/* Boost check                                                         */
/* ------------------------------------------------------------------ */

function check(id: string, label: string, max: number, status: CheckStatus, detail: string): BoostCheck {
  return { id, label, status, detail, max, points: status === "pass" ? max : status === "improve" ? Math.round(max / 2) : 0 };
}

export function boostCheck(piece: ContentPiece, scored: ScoredPost[]): BoostReport {
  const g = GUIDE[piece.platform];
  const group = groupKey(piece.platform, piece.format);
  const text = [piece.hook, piece.caption, piece.description].join("\n");
  const checks: BoostCheck[] = [];

  // 1. Placeholders: nothing else matters if the post can't go out.
  checks.push(/\[[^\]]{3,}\]/.test(text) ? check("placeholders", "Ready to post", 15, "fix", "Fill in the [bracketed] parts first.") : check("placeholders", "Ready to post", 15, "pass", "No placeholders left."));

  // 2. Hook length.
  const hook = piece.hook.trim();
  if (!hook) checks.push(check("hook-length", "Hook", 15, "fix", "Write a hook: it decides whether people stop scrolling."));
  else if (hook.length > g.hookMax) checks.push(check("hook-length", "Hook", 15, "improve", `${hook.length} characters; aim for ${g.hookMax} or fewer. ${g.hookWhy}`));
  else checks.push(check("hook-length", "Hook", 15, "pass", `${hook.length} characters, within ${g.hookMax}.`));

  // 3. Hook style vs this brand's data.
  const patterns = hookPatterns(scored).filter((r) => r.group === group && r.lift !== null);
  const best = patterns[0];
  const style = classifyHook(hook);
  if (!best || (best.lift ?? 0) <= 0.1) {
    checks.push(check("hook-style", "Hook style", 10, "pass", `"${style}" hook. Not enough ${piece.platform} ${piece.format} history to favour a style yet; vary styles to learn which works.`));
  } else if (best.label === style) {
    checks.push(check("hook-style", "Hook style", 10, "pass", `"${style}" hooks do best for you here (+${round((best.lift ?? 0) * 100, 0)}% vs your median, ${best.count} posts).`));
  } else {
    checks.push(check("hook-style", "Hook style", 10, "improve", `This is a "${style}" hook. Your "${best.label}" hooks score +${round((best.lift ?? 0) * 100, 0)}% vs your median on ${piece.platform} ${piece.format}s (${best.count} posts). Try one below.`));
  }

  // 4. Call to action.
  const cta = piece.cta.trim();
  const asksQuestion = /\?\s*(👇)?\s*$/m.test(piece.caption) || /\?/.test(cta);
  if (!cta && !asksQuestion) checks.push(check("cta", "Call to action", 15, "fix", "Add one clear ask: save, share, comment, or answer a question."));
  else if (cta && !CTA_WORDS.test(cta) && !asksQuestion) checks.push(check("cta", "Call to action", 15, "improve", `"${clip(cta, 60)}" is vague. Say exactly what to do (e.g. "Save this for your next grocery run").`));
  else if (piece.platform !== "youtube" && cta && !piece.caption.toLowerCase().includes(cta.toLowerCase().slice(0, 20)) && !asksQuestion) checks.push(check("cta", "Call to action", 15, "improve", "The CTA isn't in the post text. Put it at the end of the caption so people see it."));
  else checks.push(check("cta", "Call to action", 15, "pass", asksQuestion ? "Ends with a question, which invites comments." : "Clear ask."));

  // 5. Hashtags.
  const n = piece.hashtags.length;
  const [lo, hi] = g.tags;
  const shortsTag = piece.platform === "youtube" && piece.format === "short" && !piece.hashtags.some((h) => h.toLowerCase() === "#shorts");
  if (shortsTag) checks.push(check("hashtags", "Hashtags", 10, "improve", "Add #Shorts so the video is easier to find as a Short."));
  else if (n < lo || n > hi) checks.push(check("hashtags", "Hashtags", 10, "improve", `${n} hashtag(s); ${lo}–${hi} works better on ${piece.platform}. Use specific topic tags over generic ones.`));
  else checks.push(check("hashtags", "Hashtags", 10, "pass", `${n} hashtag(s), within ${lo}–${hi}.`));

  // 6. Posting window vs data.
  const time = bestPostingTimes(scored).find((t) => t.group === group);
  const planned = piece.plannedTime?.match(/(\d{1,2})[:.](\d{2})/);
  if (!piece.plannedDate || !planned) {
    checks.push(check("timing", "Posting time", 10, "improve", "Set a planned date and time so the post goes out when your audience is active."));
  } else if (time?.basis === "data" && time.bucket) {
    const bucket = bucketForHour(Number(planned[1]));
    checks.push(
      bucket === time.bucket
        ? check("timing", "Posting time", 10, "pass", `Planned for ${time.bucket}, your best window for ${piece.platform} ${piece.format}s.`)
        : check("timing", "Posting time", 10, "improve", `Planned for ${bucket}; your data favours ${time.bucket}. ${time.note}`),
    );
  } else {
    checks.push(check("timing", "Posting time", 10, "pass", "Not enough history to pick a window yet; keep rotating times and logging metrics."));
  }

  // 7. Media.
  if (piece.mediaUrls.length === 0) checks.push(check("media", "Media attached", 10, g.needsMedia ? "fix" : "improve", g.needsMedia ? `${piece.platform} needs the image or video. Add its public URL.` : "Posts with an image or video usually get more reach than text alone."));
  else checks.push(check("media", "Media attached", 10, "pass", `${piece.mediaUrls.length} file(s) attached.`));

  // 8. Platform-specific details.
  if (piece.platform === "youtube") {
    const ok = piece.description.length >= 100 && piece.keywords.length >= 3;
    checks.push(check("platform", "YouTube search", 15, ok ? "pass" : "improve", ok ? "Description and tags help search." : "Write a description of 100+ characters with the main keyword in the first line, and add 3+ tags."));
  } else if (piece.platform === "x") {
    const len = xLength(postText(piece));
    checks.push(check("platform", "Fits in one post", 15, len <= X_MAX ? "pass" : "fix", len <= X_MAX ? `${len}/${X_MAX} characters with hashtags.` : `${len}/${X_MAX} characters with hashtags. Shorten it or X will reject it.`));
  } else if (piece.platform === "linkedin") {
    const firstLine = piece.caption.split("\n")[0] ?? "";
    const ok = firstLine.length <= 150 && piece.caption.includes("\n\n");
    checks.push(check("platform", "LinkedIn readability", 15, ok ? "pass" : "improve", ok ? "Short first line and spaced paragraphs." : "Keep the first line under 150 characters and break the text into short paragraphs."));
  } else if (piece.format === "carousel" || piece.format === "image-post") {
    const ok = /save|share|send/i.test(piece.caption + piece.cta);
    checks.push(check("platform", "Saves and shares", 15, ok ? "pass" : "improve", ok ? "Asks for a save or share, the signals that spread carousels." : "Carousels spread through saves and shares: end with \"Save this\" or \"Send this to someone who…\"."));
  } else if (piece.format === "reel" || piece.format === "short") {
    const ok = piece.thumbnailConcept.trim().length > 0;
    checks.push(check("platform", "Cover and first frame", 15, ok ? "pass" : "improve", ok ? "Cover planned. Make sure the payoff shows in the first 2 seconds." : "Plan a cover with 3–5 words, and show the payoff in the first 2 seconds."));
  } else {
    checks.push(check("platform", "Readability", 15, piece.caption.length > 0 ? "pass" : "fix", piece.caption.length > 0 ? "Has post text." : "Add the post text."));
  }

  const max = checks.reduce((a, c) => a + c.max, 0);
  const got = checks.reduce((a, c) => a + c.points, 0);
  return { pieceId: piece.id, score: Math.round((got / max) * 100), checks, hookIdeas: hookIdeas(piece, scored) };
}

/* ------------------------------------------------------------------ */
/* After-publish tasks                                                 */
/* ------------------------------------------------------------------ */

export interface GrowthTask {
  pieceId: string;
  platform: Platform;
  topic: string;
  url: string | null;
  task: string;
  why: string;
  urgent: boolean;
}

function publishedAt(p: ContentPiece): string | null {
  const h = [...p.history].reverse().find((x) => x.to === "published");
  return h?.at ?? null;
}

export function afterPublishTasks(content: ContentPiece[], inbox: InboxItem[], metrics: PostMetric[], now: Date): GrowthTask[] {
  const out: GrowthTask[] = [];
  const nowMs = now.getTime();
  for (const p of content.filter((c) => c.status === "published")) {
    const at = publishedAt(p);
    if (!at) continue;
    const ageH = (nowMs - new Date(at).getTime()) / 3_600_000;
    const base = { pieceId: p.id, platform: p.platform, topic: p.topic, url: p.publishedUrl };

    if (ageH <= 48) {
      const pending = inbox.filter((i) => i.replyStatus === "drafted" && i.classification.intent !== "spam" && p.publishedUrl && i.postRef && (i.postRef === p.publishedUrl || p.publishedUrl.includes(i.postRef))).length;
      out.push({ ...base, task: pending ? `Reply to ${pending} comment(s) waiting in the inbox` : "Check for new comments and reply to each one", why: "Replies in the first hours keep the conversation, and the post's reach, going.", urgent: ageH <= 3 });
      if (p.platform === "youtube") out.push({ ...base, task: "Pin a comment that asks a question or links the next video", why: "A pinned question is the easiest place for viewers to start commenting.", urgent: false });
      if (p.platform === "instagram" && p.format !== "story") out.push({ ...base, task: "Share it to your Story with a poll or question sticker", why: "Stories send followers who missed it in the feed back to the post.", urgent: ageH <= 24 });
      if (p.platform === "x") out.push({ ...base, task: "Reply to replies and quote-post one good reply", why: "Conversation in the replies is what keeps a post circulating on X.", urgent: ageH <= 3 });
      if (p.platform === "facebook" || p.platform === "linkedin") out.push({ ...base, task: "Add a first comment with the link or a follow-up question", why: "Keeps the post text clean and gives people an easy reply.", urgent: false });
    }
    if (ageH >= 7 * 24 && ageH <= 30 * 24 && !metrics.some((m) => m.contentId === p.id || (m.url && m.url === p.publishedUrl))) {
      out.push({ ...base, task: "Log this post's metrics (Analytics → Add metrics)", why: "The Growth Booster learns what works only from logged results.", urgent: false });
    }
  }
  return out.sort((a, b) => Number(b.urgent) - Number(a.urgent));
}

/* ------------------------------------------------------------------ */
/* Repurpose winners                                                   */
/* ------------------------------------------------------------------ */

export interface RepurposeSuggestion {
  metricId: string;
  topic: string;
  hook: string;
  pillarId: string;
  from: { platform: Platform; format: Format };
  lift: number;
  targets: Array<{ platform: Platform; format: Format }>;
}

/** Posts that beat their own platform+format history by 20%+, with platforms where the topic hasn't been posted. */
export function repurposeWinners(brand: Brand, content: ContentPiece[], scored: ScoredPost[], limit = 5): RepurposeSuggestion[] {
  const out: RepurposeSuggestion[] = [];
  const winners = scored.filter((s) => s.vsHistory && s.vsHistory.diff >= 0.2).sort((a, b) => b.vsHistory!.diff - a.vsHistory!.diff);
  for (const w of winners) {
    const piece = w.post.contentId ? content.find((c) => c.id === w.post.contentId) : undefined;
    const topic = piece?.topic || w.post.hook;
    if (!topic) continue;
    const key = coreTopic(topic).toLowerCase();
    const covered = new Set(content.filter((c) => coreTopic(c.topic).toLowerCase() === key).map((c) => c.platform));
    covered.add(w.post.platform);
    const targets = brand.platforms.filter((p) => !covered.has(p)).map((platform) => ({ platform, format: pickFormat(platform, w.post.format) }));
    if (targets.length === 0) continue;
    out.push({ metricId: w.post.id, topic, hook: w.post.hook, pillarId: piece?.pillarId || w.post.pillarId, from: { platform: w.post.platform, format: w.post.format }, lift: w.vsHistory!.diff, targets });
    if (out.length >= limit) break;
  }
  return out;
}

/** Closest format on another platform: video stays video, static stays static. */
function pickFormat(platform: Platform, from: Format): Format {
  const video = ["reel", "short", "long-video"].includes(from);
  const options = PLATFORM_FORMATS[platform];
  if (video) return (["reel", "short"] as Format[]).find((f) => options.includes(f)) ?? DEFAULT_FORMAT[platform];
  if (from === "carousel" || from === "document-carousel") return (["carousel", "document-carousel"] as Format[]).find((f) => options.includes(f)) ?? DEFAULT_FORMAT[platform];
  return options.includes("image-post") ? "image-post" : DEFAULT_FORMAT[platform];
}

/* ------------------------------------------------------------------ */
/* Consistency                                                         */
/* ------------------------------------------------------------------ */

export interface CadenceRow {
  platform: Platform;
  target: number;
  last7: number;
  next7: number;
  status: CheckStatus;
  note: string;
}

export function cadenceCheck(brand: Brand, content: ContentPiece[], today: string): CadenceRow[] {
  return brand.platforms.map((platform) => {
    const target = DAILY_CADENCE.filter((s) => s.platform === platform).length;
    const mine = content.filter((c) => c.brandId === brand.id && c.platform === platform);
    const last7 = mine.filter((c) => c.status === "published" && (publishedAt(c) ?? "").slice(0, 10) > addDays(today, -7)).length;
    const next7 = mine.filter((c) => (c.status === "approved" || c.status === "scheduled") && c.plannedDate && c.plannedDate >= today && c.plannedDate < addDays(today, 7)).length;
    const status: CheckStatus = next7 >= target ? "pass" : next7 > 0 ? "improve" : "fix";
    const note = status === "pass" ? "On plan for the week ahead." : status === "improve" ? `${target - next7} more approved post(s) needed this week.` : `Nothing approved for the next 7 days; algorithms reward steady posting.`;
    return { platform, target, last7, next7, status, note };
  });
}
