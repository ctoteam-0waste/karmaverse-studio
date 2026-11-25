import type { Brand, ContentPiece, Idea, InboxItem, Platform, Format } from "../schemas";
import { addDays, clamp, newId, nowIso, round, weekdayOf, WEEKDAY_NAMES } from "../util";
import { IDEA_BANK, pillarKind } from "./idea-bank";

/* ------------------------------------------------------------------ */
/* Priority scoring                                                    */
/* ------------------------------------------------------------------ */

/**
 * Priority 0–100. Audience relevance matters most, then expected impact,
 * then ease of production. Under-covered pillars get a bonus of up to 10.
 */
export function priorityScore(relevance: number, impact: number, effort: number, gapBonus = 0): number {
  const r = (relevance - 1) / 4;
  const i = (impact - 1) / 4;
  const e = (5 - effort) / 4;
  return round(clamp((r * 0.5 + i * 0.3 + e * 0.2) * 90 + gapBonus, 0, 100), 0);
}

/* ------------------------------------------------------------------ */
/* Audience questions and content gaps                                 */
/* ------------------------------------------------------------------ */

export interface PillarCoverage {
  pillarId: string;
  name: string;
  planned: number;
  share: number;
  isGap: boolean;
}

/** Counts content per pillar over the window (planned or created). */
export function pillarCoverage(brand: Brand, content: ContentPiece[], fromDate: string, toDate: string): PillarCoverage[] {
  const inWindow = content.filter((c) => {
    const d = c.plannedDate ?? c.createdAt.slice(0, 10);
    return c.brandId === brand.id && d >= fromDate && d <= toDate;
  });
  const total = inWindow.length || 1;
  const fairShare = 1 / Math.max(brand.pillars.length, 1);
  return brand.pillars.map((p) => {
    const planned = inWindow.filter((c) => c.pillarId === p.id).length;
    const share = planned / total;
    return { pillarId: p.id, name: p.name, planned, share, isGap: share < fairShare * 0.5 };
  });
}

/** Audience questions come from real inbox comments classified as questions. */
export function audienceQuestions(inbox: InboxItem[], brandId: string, limit = 10): string[] {
  return inbox
    .filter((i) => i.brandId === brandId && i.classification.intent === "question" && !i.classification.flags.includes("customer-support"))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, limit)
    .map((i) => i.text);
}

/* ------------------------------------------------------------------ */
/* Fixed-date observances (movable festivals must be added by the team) */
/* ------------------------------------------------------------------ */

export const FIXED_OBSERVANCES: Array<{ month: number; day: number; name: string }> = [
  { month: 1, day: 26, name: "Republic Day (India)" },
  { month: 3, day: 18, name: "Global Recycling Day" },
  { month: 3, day: 22, name: "World Water Day" },
  { month: 4, day: 22, name: "Earth Day" },
  { month: 6, day: 5, name: "World Environment Day" },
  { month: 7, day: 3, name: "International Plastic Bag Free Day" },
  { month: 8, day: 15, name: "Independence Day (India)" },
  { month: 9, day: 16, name: "World Ozone Day" },
  { month: 10, day: 2, name: "Gandhi Jayanti / Swachh Bharat Diwas" },
  { month: 10, day: 14, name: "International E-Waste Day" },
  { month: 11, day: 14, name: "Children's Day (India)" },
  { month: 12, day: 5, name: "World Soil Day" },
];

export function observancesBetween(fromDate: string, days: number): Array<{ date: string; name: string }> {
  const out: Array<{ date: string; name: string }> = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(fromDate, i);
    const m = Number(d.slice(5, 7));
    const day = Number(d.slice(8, 10));
    for (const o of FIXED_OBSERVANCES) if (o.month === m && o.day === day) out.push({ date: d, name: o.name });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Idea generation (template mode)                                     */
/* ------------------------------------------------------------------ */

export interface IdeaContext {
  content: ContentPiece[];
  inbox: InboxItem[];
  existingIdeas: Idea[];
  today: string;
}

/**
 * Builds a prioritised idea backlog from: the pillar idea bank, real audience
 * questions from the inbox, and the team's own trend notes. Skips titles that
 * already exist in the backlog.
 */
export function generateIdeas(brand: Brand, ctx: IdeaContext): Idea[] {
  const coverage = pillarCoverage(brand, ctx.content, addDays(ctx.today, -30), addDays(ctx.today, 30));
  const gapIds = new Set(coverage.filter((c) => c.isGap).map((c) => c.pillarId));
  const existing = new Set(ctx.existingIdeas.filter((i) => i.brandId === brand.id).map((i) => i.title.toLowerCase()));
  const created = nowIso();
  const ideas: Idea[] = [];

  const push = (idea: Omit<Idea, "id" | "brandId" | "createdAt" | "priority" | "status" | "isSample">, gap: boolean) => {
    if (existing.has(idea.title.toLowerCase())) return;
    existing.add(idea.title.toLowerCase());
    ideas.push({
      ...idea,
      id: newId("idea"),
      brandId: brand.id,
      createdAt: created,
      status: "backlog",
      isSample: false,
      priority: priorityScore(idea.relevance, idea.impact, idea.effort, gap ? 10 : 0),
    });
  };

  for (const pillar of brand.pillars) {
    const bank = IDEA_BANK[pillarKind(pillar)];
    for (const t of bank) {
      push(
        {
          title: t.title.replaceAll("{brand}", brand.name),
          pillarId: pillar.id,
          angle: t.angle.replaceAll("{brand}", brand.name),
          audienceQuestion: t.question.replaceAll("{brand}", brand.name),
          source: "strategy-agent",
          relevance: t.relevance,
          impact: t.impact,
          effort: t.effort,
        },
        gapIds.has(pillar.id),
      );
    }
  }

  // Real questions from the audience are the most relevant ideas we have.
  const eduPillar = brand.pillars.find((p) => pillarKind(p) === "edu") ?? brand.pillars[0];
  for (const q of audienceQuestions(ctx.inbox, brand.id, 5)) {
    if (!eduPillar) break;
    push(
      {
        title: `Answering you: "${q.length > 70 ? `${q.slice(0, 67)}...` : q}"`,
        pillarId: eduPillar.id,
        angle: "Reply-to-comment video or carousel answering a real follower question",
        audienceQuestion: q,
        source: "inbox",
        relevance: 5,
        impact: 4,
        effort: 1,
      },
      false,
    );
  }

  for (const note of brand.trendNotes) {
    if (!eduPillar) break;
    push(
      {
        title: `Trend: ${note.text.slice(0, 80)}`,
        pillarId: eduPillar.id,
        angle: "Adapt this trend only if it fits the audience; check audio and format licensing on the platform",
        audienceQuestion: "",
        source: "trend-note",
        relevance: 3,
        impact: 4,
        effort: 2,
      },
      false,
    );
  }

  return ideas.sort((a, b) => b.priority - a.priority);
}

/* ------------------------------------------------------------------ */
/* Weekly and monthly strategy                                         */
/* ------------------------------------------------------------------ */

export interface Slot {
  weekday: number;
  platform: Platform;
  format: Format;
}

/** Default weekly cadence: 10 posts a week across 4 platforms. Editable in code. */
export const DEFAULT_CADENCE: Slot[] = [
  { weekday: 1, platform: "instagram", format: "reel" },
  { weekday: 2, platform: "youtube", format: "short" },
  { weekday: 2, platform: "linkedin", format: "text-post" },
  { weekday: 3, platform: "instagram", format: "carousel" },
  { weekday: 3, platform: "facebook", format: "image-post" },
  { weekday: 4, platform: "youtube", format: "short" },
  { weekday: 4, platform: "linkedin", format: "document-carousel" },
  { weekday: 5, platform: "instagram", format: "reel" },
  { weekday: 6, platform: "instagram", format: "reel" },
  { weekday: 0, platform: "facebook", format: "reel" },
  { weekday: 2, platform: "x", format: "text-post" },
  { weekday: 5, platform: "x", format: "text-post" },
];

/**
 * One post every day on every platform (what the 30-day calendar plans).
 * Formats rotate through the week: mostly short video (reach), with carousels
 * or slide posts on two days (saves and shares). Days are 0 = Sunday … 6 = Saturday.
 */
const daily = (platform: Platform, byDay: Format[]): Slot[] => byDay.map((format, weekday) => ({ weekday, platform, format }));
export const DAILY_CADENCE: Slot[] = [
  ...daily("instagram", ["reel", "reel", "reel", "carousel", "reel", "carousel", "reel"]),
  ...daily("facebook", ["reel", "reel", "image-post", "reel", "reel", "image-post", "reel"]),
  ...daily("youtube", ["short", "short", "short", "short", "short", "short", "short"]),
  ...daily("linkedin", ["text-post", "text-post", "image-post", "text-post", "image-post", "text-post", "text-post"]),
  ...daily("x", ["text-post", "text-post", "text-post", "text-post", "text-post", "text-post", "text-post"]),
];

export interface WeeklyPlan {
  weekStart: string;
  focusPillars: string[];
  observances: Array<{ date: string; name: string }>;
  slots: Array<{ date: string; day: string; platform: Platform; format: Format; ideaId: string; ideaTitle: string; pillarId: string }>;
  notes: string[];
}

/**
 * Assigns the highest-priority approved (or backlog) ideas to the cadence,
 * rotating pillars so no pillar takes more than two slots a week.
 */
export function weeklyStrategy(brand: Brand, ideas: Idea[], weekStart: string, cadence: Slot[] = DEFAULT_CADENCE): WeeklyPlan {
  const pool = ideas
    .filter((i) => i.brandId === brand.id && (i.status === "approved" || i.status === "backlog"))
    .sort((a, b) => (a.status === b.status ? b.priority - a.priority : a.status === "approved" ? -1 : 1));

  const perPillar = new Map<string, number>();
  const used = new Set<string>();
  const slots: WeeklyPlan["slots"] = [];
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  for (const date of days) {
    const wd = weekdayOf(date);
    for (const s of cadence.filter((c) => c.weekday === wd && brand.platforms.includes(c.platform))) {
      const idea =
        pool.find((i) => !used.has(i.id) && (perPillar.get(i.pillarId) ?? 0) < 2) ?? pool.find((i) => !used.has(i.id));
      if (!idea) continue;
      used.add(idea.id);
      perPillar.set(idea.pillarId, (perPillar.get(idea.pillarId) ?? 0) + 1);
      slots.push({ date, day: WEEKDAY_NAMES[wd]!, platform: s.platform, format: s.format, ideaId: idea.id, ideaTitle: idea.title, pillarId: idea.pillarId });
    }
  }

  const focus = [...perPillar.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
  const notes: string[] = [];
  if (slots.length < cadence.length) notes.push("Not enough ideas in the backlog to fill every slot. Generate or add more ideas.");
  return { weekStart, focusPillars: focus, observances: observancesBetween(weekStart, 7), slots, notes };
}

export interface MonthlyPlan {
  start: string;
  weeks: Array<{ weekStart: string; theme: string; pillars: string[] }>;
  observances: Array<{ date: string; name: string }>;
}

export function monthlyStrategy(brand: Brand, start: string): MonthlyPlan {
  const pillars = brand.pillars.map((p) => p.id);
  const themes = ["Start simple", "Bust the myths", "Do it together", "Show the impact"];
  const weeks = [0, 1, 2, 3].map((w) => ({
    weekStart: addDays(start, w * 7),
    theme: themes[w]!,
    pillars: [pillars[(w * 2) % pillars.length], pillars[(w * 2 + 1) % pillars.length]].filter((p): p is string => Boolean(p)),
  }));
  return { start, weeks, observances: observancesBetween(start, 30) };
}
