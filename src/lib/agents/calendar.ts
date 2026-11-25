import type { ApprovalPolicy, Brand, ContentPiece, ContentStatus, Idea, PostMetric } from "../schemas";
import { addDays, newId, nowIso, round, weekdayOf } from "../util";
import { analysisMetrics, bestPostingTimes, groupKey, scorePosts, summarise } from "../analytics/engine";
import { generatePlatformVersion, lintContent } from "./content";
import { DAILY_CADENCE, type Slot } from "./strategy";

/* ------------------------------------------------------------------ */
/* Status workflow                                                     */
/* ------------------------------------------------------------------ */

export const TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  draft: ["needs-review"],
  "needs-review": ["approved", "draft"],
  approved: ["scheduled", "needs-review", "draft"],
  scheduled: ["published", "failed", "approved"],
  failed: ["scheduled", "draft"],
  published: [],
};

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

export interface TransitionInput {
  to: ContentStatus;
  actor: string;
  note?: string;
  publishedUrl?: string;
  failureReason?: string;
}

/**
 * Applies one status change, enforcing the brand's approval policy.
 * Publishing (by a person or the Publishing Agent) always requires prior approval.
 */
export function transition(piece: ContentPiece, input: TransitionInput, policy: ApprovalPolicy, brand?: Brand): ContentPiece {
  const { to, actor } = input;
  const from = piece.status;
  let allowed = TRANSITIONS[from];
  if (!policy.requireReview && from === "draft") allowed = [...allowed, "approved"];
  if (!allowed.includes(to)) throw new TransitionError(`Cannot move from "${from}" to "${to}". Allowed: ${allowed.join(", ") || "none (final)"}.`);
  if (!actor.trim()) throw new TransitionError("Enter your name so the change is recorded.");

  const now = nowIso();
  const next: ContentPiece = { ...piece, status: to, updatedAt: now };

  if (to === "approved") {
    if (policy.approvers.length && !policy.approvers.some((a) => a.toLowerCase() === actor.trim().toLowerCase())) {
      throw new TransitionError(`${actor} is not an approver. Approvers: ${policy.approvers.join(", ")}.`);
    }
    if (brand) {
      const blocks = lintContent(brand, [piece.hook, piece.caption, piece.description].join("\n")).filter((w) => w.level === "block");
      if (blocks.length) throw new TransitionError(`Fix before approving: ${blocks.map((b) => b.message).join(" ")}`);
    }
    next.approvedBy = actor.trim();
    next.approvedAt = now;
  }
  if (to === "draft" || to === "needs-review") {
    next.approvedBy = null;
    next.approvedAt = null;
  }
  if (to === "scheduled") {
    if (!piece.approvedBy) throw new TransitionError("Only approved content can be scheduled.");
    if (!piece.plannedDate) throw new TransitionError("Set a planned date before scheduling.");
  }
  if (to === "published") {
    if (!piece.approvedBy) throw new TransitionError("Content must be approved before it is published.");
    const url = input.publishedUrl?.trim();
    if (!url) throw new TransitionError("Paste the live post URL to confirm it is published.");
    next.publishedUrl = url;
  }
  if (to === "failed") next.failureReason = input.failureReason?.trim() || "Not specified";
  if (from === "failed" && to !== "failed") next.failureReason = null;

  next.history = [...piece.history, { at: now, from, to, by: actor.trim(), note: input.note ?? "" }];
  return next;
}

/** Any edit to approved or scheduled content sends it back for review. */
export function applyEdit(piece: ContentPiece, patch: Partial<Pick<ContentPiece, "hook" | "caption" | "description" | "cta" | "hashtags" | "keywords" | "thumbnailConcept" | "mediaUrls" | "plannedDate" | "plannedTime" | "topic">>, actor: string): ContentPiece {
  if (piece.status === "published") throw new TransitionError("Published content cannot be edited here. Edit it on the platform.");
  const now = nowIso();
  const contentChanged = (["hook", "caption", "description", "cta", "hashtags", "keywords", "thumbnailConcept", "mediaUrls", "topic"] as const).some(
    (k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(piece[k]),
  );
  const next: ContentPiece = { ...piece, ...patch, updatedAt: now };
  if (contentChanged && (piece.status === "approved" || piece.status === "scheduled")) {
    next.status = "needs-review";
    next.approvedBy = null;
    next.approvedAt = null;
    next.history = [...piece.history, { at: now, from: piece.status, to: "needs-review", by: actor || "system", note: "Edited after approval; needs review again." }];
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* 30-day calendar                                                     */
/* ------------------------------------------------------------------ */

const DEFAULT_TIME: Record<string, string> = { "morning (6–11)": "09:00", "midday (11–16)": "13:00", "evening (16–21)": "19:00", "night (21–6)": "21:30" };

/** FIXED_POST_TIME (e.g. "14:00") pins every newly planned post to one time instead of the learned/experiment slot. */
function fixedPostTime(): string | null {
  const t = process.env.FIXED_POST_TIME?.trim();
  return t && /^\d{1,2}:\d{2}$/.test(t) ? t : null;
}

export interface CalendarOptions {
  startDate: string;
  days?: number;
  cadence?: Slot[];
  /** Posts already planned; a date + platform that already has one is left alone. */
  existing?: Pick<ContentPiece, "brandId" | "platform" | "plannedDate" | "isSample">[];
}

/**
 * Creates draft content pieces for the next N days. Uses the highest-priority
 * ideas, rotates pillars, writes platform-specific copy (template mode), and sets
 * a target metric from history where history exists.
 */
export function generateCalendar(brand: Brand, ideas: Idea[], metrics: PostMetric[], opts: CalendarOptions): ContentPiece[] {
  const days = opts.days ?? 30;
  const cadence = (opts.cadence ?? DAILY_CADENCE).filter((s) => brand.platforms.includes(s.platform));
  const taken = new Set((opts.existing ?? []).filter((c) => c.brandId === brand.id && !c.isSample && c.plannedDate).map((c) => `${c.plannedDate}|${c.platform}`));
  const pool = ideas.filter((i) => i.brandId === brand.id && (i.status === "approved" || i.status === "backlog")).sort((a, b) => b.priority - a.priority);
  if (pool.length === 0) throw new Error("The idea backlog is empty. Generate ideas in Content Studio first.");

  const scored = scorePosts(analysisMetrics(metrics, brand.id));
  const summaries = summarise(scored);
  const times = bestPostingTimes(scored);
  const created = nowIso();
  const out: ContentPiece[] = [];
  const recentPillars: string[] = [];
  let cursor = 0;

  for (let d = 0; d < days; d++) {
    const date = addDays(opts.startDate, d);
    for (const slot of cadence.filter((c) => c.weekday === weekdayOf(date) && !taken.has(`${date}|${c.platform}`))) {
      // Prefer an idea whose pillar wasn't used in the last 3 posts.
      let idea = pool.find((_, i) => i >= cursor && !recentPillars.slice(-3).includes(pool[i]!.pillarId));
      if (!idea) idea = pool[cursor % pool.length]!;
      cursor = (pool.indexOf(idea) + 1) % pool.length;
      recentPillars.push(idea.pillarId);

      const v = generatePlatformVersion(brand, idea, slot.platform, slot.format);
      const g = summaries.find((s) => s.platform === slot.platform && s.format === slot.format);
      const time = times.find((t) => t.group === groupKey(slot.platform, slot.format));
      const target =
        g && g.enoughData && g.medianScore !== null
          ? { metric: g.scoreLabel, target: g.scoreFormat === "percent" ? `≥ ${round(g.medianScore * 100, 2)}% (current median)` : `≥ ${round(g.medianScore, 2)} (current median)` }
          : { metric: g?.scoreLabel ?? "Primary engagement metric", target: "Set baseline (not enough history)" };

      out.push({
        id: newId("post"),
        brandId: brand.id,
        ideaId: idea.id,
        platform: slot.platform,
        format: slot.format,
        pillarId: idea.pillarId,
        topic: idea.title,
        hook: v.hook,
        caption: v.caption,
        description: v.description,
        keywords: v.keywords,
        hashtags: v.hashtags,
        cta: v.cta,
        thumbnailConcept: v.thumbnailConcept,
        mediaUrls: [],
        extraMedia: [],
        subtitles: "",
        slides: "",
        hostedMedia: {},
        plannedDate: date,
        plannedTime: fixedPostTime() ?? `${DEFAULT_TIME[time?.bucket ?? "evening (16–21)"] ?? "19:00"}${time?.basis === "experiment" || !time ? " (experiment)" : ""}`,
        targetMetric: target,
        status: "draft",
        approvedBy: null,
        approvedAt: null,
        publishedUrl: null,
        failureReason: null,
        publishingStartedAt: null,
        externalId: null,
        generatedBy: "template",
        history: [{ at: created, from: null, to: "draft", by: "calendar-agent", note: `Generated by ${days}-day calendar` }],
        createdAt: created,
        updatedAt: created,
        isSample: false,
      });
    }
  }
  return out;
}
