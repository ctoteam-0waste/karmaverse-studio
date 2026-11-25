import type { Format, Platform } from "../schemas";

/**
 * Metric definitions per platform + format.
 *
 * These are the metrics each platform's native analytics (Instagram Insights,
 * YouTube Studio, LinkedIn page analytics, Meta Business Suite) report for that
 * format. Metrics from different platforms are never mixed in one comparison:
 * every comparison in this app is within the same platform AND format.
 */

export interface MetricDef {
  key: string;
  label: string;
  unit?: "count" | "seconds" | "percent" | "hours";
}

export interface ScoreDef {
  /** Name shown in the UI, e.g. "Engagement rate (per reach)". */
  label: string;
  /** Short explanation of why this is the primary score for this format. */
  why: string;
  /** Returns null when the needed metrics are missing. */
  compute: (m: Record<string, number>) => number | null;
  format: "percent" | "number";
}

export interface FormatMetrics {
  metrics: MetricDef[];
  primary: ScoreDef;
  /** Secondary ratios used for diagnosis. */
  ratios: Record<string, ScoreDef>;
}

const ratio = (num: number | undefined, den: number | undefined): number | null =>
  num === undefined || den === undefined || den <= 0 ? null : num / den;

const sum = (m: Record<string, number>, keys: string[]): number | undefined => {
  let total = 0;
  for (const k of keys) {
    const v = m[k];
    if (v === undefined) return undefined;
    total += v;
  }
  return total;
};

/* Instagram ------------------------------------------------------------- */

const igReel: FormatMetrics = {
  metrics: [
    { key: "views", label: "Views" },
    { key: "reach", label: "Accounts reached" },
    { key: "avgWatchTimeSec", label: "Avg watch time", unit: "seconds" },
    { key: "durationSec", label: "Reel length", unit: "seconds" },
    { key: "likes", label: "Likes" },
    { key: "comments", label: "Comments" },
    { key: "shares", label: "Shares" },
    { key: "saves", label: "Saves" },
    { key: "profileVisits", label: "Profile visits" },
    { key: "follows", label: "Follows" },
  ],
  primary: {
    label: "Engagement rate (per reach)",
    why: "Likes, comments, shares and saves divided by accounts reached.",
    compute: (m) => ratio(sum(m, ["likes", "comments", "shares", "saves"]), m.reach),
    format: "percent",
  },
  ratios: {
    shareRate: { label: "Share rate", why: "Shares per account reached", compute: (m) => ratio(m.shares, m.reach), format: "percent" },
    saveRate: { label: "Save rate", why: "Saves per account reached", compute: (m) => ratio(m.saves, m.reach), format: "percent" },
    watchRatio: {
      label: "Watch ratio",
      why: "Avg watch time divided by Reel length (proxy for retention)",
      compute: (m) => ratio(m.avgWatchTimeSec, m.durationSec),
      format: "percent",
    },
    profileVisitRate: { label: "Profile visit rate", why: "Profile visits per account reached", compute: (m) => ratio(m.profileVisits, m.reach), format: "percent" },
    followRate: { label: "Follow rate", why: "Follows per account reached", compute: (m) => ratio(m.follows, m.reach), format: "percent" },
  },
};

const igCarousel: FormatMetrics = {
  metrics: [
    { key: "reach", label: "Accounts reached" },
    { key: "impressions", label: "Impressions" },
    { key: "likes", label: "Likes" },
    { key: "comments", label: "Comments" },
    { key: "shares", label: "Shares" },
    { key: "saves", label: "Saves" },
    { key: "profileVisits", label: "Profile visits" },
    { key: "follows", label: "Follows" },
  ],
  primary: igReel.primary,
  ratios: {
    shareRate: igReel.ratios.shareRate!,
    saveRate: igReel.ratios.saveRate!,
    profileVisitRate: igReel.ratios.profileVisitRate!,
    followRate: igReel.ratios.followRate!,
  },
};

const igStory: FormatMetrics = {
  metrics: [
    { key: "reach", label: "Accounts reached" },
    { key: "replies", label: "Replies" },
    { key: "stickerTaps", label: "Sticker taps" },
    { key: "exits", label: "Exits" },
    { key: "linkClicks", label: "Link clicks" },
  ],
  primary: {
    label: "Interaction rate (per reach)",
    why: "Replies and sticker taps divided by accounts reached.",
    compute: (m) => ratio(sum(m, ["replies", "stickerTaps"]), m.reach),
    format: "percent",
  },
  ratios: {
    exitRate: { label: "Exit rate", why: "Exits per account reached (lower is better)", compute: (m) => ratio(m.exits, m.reach), format: "percent" },
    clickRate: { label: "Link click rate", why: "Link clicks per account reached", compute: (m) => ratio(m.linkClicks, m.reach), format: "percent" },
  },
};

/* YouTube --------------------------------------------------------------- */

const ytShort: FormatMetrics = {
  metrics: [
    { key: "views", label: "Views" },
    { key: "avgPercentViewed", label: "Avg percentage viewed", unit: "percent" },
    { key: "avgViewDurationSec", label: "Avg view duration", unit: "seconds" },
    { key: "likes", label: "Likes" },
    { key: "comments", label: "Comments" },
    { key: "shares", label: "Shares" },
    { key: "subscribersGained", label: "Subscribers gained" },
  ],
  primary: {
    label: "Avg percentage viewed",
    why: "Retention is the clearest quality signal for Shorts.",
    compute: (m) => (m.avgPercentViewed === undefined ? null : m.avgPercentViewed / 100),
    format: "percent",
  },
  ratios: {
    likeRate: { label: "Like rate", why: "Likes per view", compute: (m) => ratio(m.likes, m.views), format: "percent" },
    shareRate: { label: "Share rate", why: "Shares per view", compute: (m) => ratio(m.shares, m.views), format: "percent" },
    subRate: { label: "Subscribers per 1k views", why: "Subscribers gained per 1,000 views", compute: (m) => { const r = ratio(m.subscribersGained, m.views); return r === null ? null : r * 1000; }, format: "number" },
  },
};

const ytLong: FormatMetrics = {
  metrics: [
    { key: "impressions", label: "Impressions" },
    { key: "ctr", label: "Impressions click-through rate", unit: "percent" },
    { key: "views", label: "Views" },
    { key: "watchTimeHours", label: "Watch time", unit: "hours" },
    { key: "avgViewDurationSec", label: "Avg view duration", unit: "seconds" },
    { key: "avgPercentViewed", label: "Avg percentage viewed", unit: "percent" },
    { key: "likes", label: "Likes" },
    { key: "comments", label: "Comments" },
    { key: "subscribersGained", label: "Subscribers gained" },
  ],
  primary: ytShort.primary,
  ratios: {
    ctr: { label: "Impressions CTR", why: "How often the thumbnail and title earn a click", compute: (m) => (m.ctr === undefined ? null : m.ctr / 100), format: "percent" },
    subRate: ytShort.ratios.subRate!,
  },
};

/* LinkedIn -------------------------------------------------------------- */

const liPost: FormatMetrics = {
  metrics: [
    { key: "impressions", label: "Impressions" },
    { key: "reactions", label: "Reactions" },
    { key: "comments", label: "Comments" },
    { key: "reposts", label: "Reposts" },
    { key: "clicks", label: "Clicks" },
    { key: "followersGained", label: "Followers gained" },
  ],
  primary: {
    label: "Engagement rate (per impression)",
    why: "Reactions, comments, reposts and clicks divided by impressions (LinkedIn reports impressions, not reach).",
    compute: (m) => ratio(sum(m, ["reactions", "comments", "reposts", "clicks"]), m.impressions),
    format: "percent",
  },
  ratios: {
    commentRate: { label: "Comment rate", why: "Comments per impression", compute: (m) => ratio(m.comments, m.impressions), format: "percent" },
    clickRate: { label: "Click rate", why: "Clicks per impression", compute: (m) => ratio(m.clicks, m.impressions), format: "percent" },
  },
};

/* Facebook -------------------------------------------------------------- */

const fbPost: FormatMetrics = {
  metrics: [
    { key: "reach", label: "Reach" },
    { key: "impressions", label: "Impressions" },
    { key: "reactions", label: "Reactions" },
    { key: "comments", label: "Comments" },
    { key: "shares", label: "Shares" },
    { key: "clicks", label: "Link clicks" },
  ],
  primary: {
    label: "Engagement rate (per reach)",
    why: "Reactions, comments and shares divided by reach.",
    compute: (m) => ratio(sum(m, ["reactions", "comments", "shares"]), m.reach),
    format: "percent",
  },
  ratios: {
    shareRate: { label: "Share rate", why: "Shares per person reached", compute: (m) => ratio(m.shares, m.reach), format: "percent" },
    clickRate: { label: "Click rate", why: "Link clicks per person reached", compute: (m) => ratio(m.clicks, m.reach), format: "percent" },
  },
};

const fbReel: FormatMetrics = {
  metrics: [
    { key: "views", label: "Plays" },
    { key: "reach", label: "Reach" },
    { key: "avgWatchTimeSec", label: "Avg watch time", unit: "seconds" },
    { key: "durationSec", label: "Reel length", unit: "seconds" },
    { key: "reactions", label: "Reactions" },
    { key: "comments", label: "Comments" },
    { key: "shares", label: "Shares" },
  ],
  primary: fbPost.primary,
  ratios: {
    shareRate: fbPost.ratios.shareRate!,
    watchRatio: igReel.ratios.watchRatio!,
  },
};

/* X --------------------------------------------------------------------- */

const xPost: FormatMetrics = {
  metrics: [
    { key: "impressions", label: "Impressions" },
    { key: "likes", label: "Likes" },
    { key: "reposts", label: "Reposts" },
    { key: "replies", label: "Replies" },
    { key: "bookmarks", label: "Bookmarks" },
    { key: "clicks", label: "Link clicks" },
    { key: "profileVisits", label: "Profile visits" },
    { key: "follows", label: "Follows" },
  ],
  primary: {
    label: "Engagement rate (per impression)",
    why: "Likes, reposts, replies and bookmarks divided by impressions (X reports impressions, not reach).",
    compute: (m) => ratio(sum(m, ["likes", "reposts", "replies", "bookmarks"]), m.impressions),
    format: "percent",
  },
  ratios: {
    shareRate: { label: "Repost rate", why: "Reposts per impression", compute: (m) => ratio(m.reposts, m.impressions), format: "percent" },
    commentRate: { label: "Reply rate", why: "Replies per impression", compute: (m) => ratio(m.replies, m.impressions), format: "percent" },
    saveRate: { label: "Bookmark rate", why: "Bookmarks per impression", compute: (m) => ratio(m.bookmarks, m.impressions), format: "percent" },
    clickRate: { label: "Link click rate", why: "Link clicks per impression", compute: (m) => ratio(m.clicks, m.impressions), format: "percent" },
  },
};

const REGISTRY: Partial<Record<Platform, Partial<Record<Format, FormatMetrics>>>> = {
  instagram: { reel: igReel, carousel: igCarousel, story: igStory, "image-post": igCarousel },
  youtube: { short: ytShort, "long-video": ytLong },
  linkedin: { "text-post": liPost, "document-carousel": liPost, "image-post": liPost },
  facebook: { "image-post": fbPost, "text-post": fbPost, reel: fbReel },
  x: { "text-post": xPost, "image-post": xPost },
};

export function metricsFor(platform: Platform, format: Format): FormatMetrics | null {
  return REGISTRY[platform]?.[format] ?? null;
}

export function primaryScore(platform: Platform, format: Format, m: Record<string, number>): number | null {
  return metricsFor(platform, format)?.primary.compute(m) ?? null;
}

/** Headline volume metric per platform+format (views or reach or impressions). */
export function volumeMetric(platform: Platform, format: Format): string {
  const defs = metricsFor(platform, format)?.metrics.map((d) => d.key) ?? [];
  for (const k of ["views", "reach", "impressions"]) if (defs.includes(k)) return k;
  return defs[0] ?? "views";
}
