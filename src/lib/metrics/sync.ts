import type { AccountStat, ContentPiece, Database, Platform, PostMetric } from "../schemas";
import { ACCOUNT_DAYS, ACCOUNT_FETCHERS } from "./account";
import { readWebsite, type WebsiteEnv } from "../website/google";
import { readPlay, type PlayEnv } from "../aso/play";
import type { WebsiteStat } from "../schemas";
import { mutate, readDb } from "../db";
import { logger } from "../logger";
import { newId } from "../util";
import { brandEnv } from "../publishing/accounts";
import { call, defaultDeps, igBase, json, linkedinVersion, oauth1Header, PublishError, type ConnectorDeps, type ConnectorEnv } from "../publishing/connectors";

const log = logger("metrics-agent");

/**
 * J. Metrics Agent.
 *
 * Reads real results for published posts from each platform's API and saves
 * them in Analytics (source "api"), so the Growth Analyst and Growth Booster
 * learn from real numbers without anyone typing them in.
 *
 * - Runs every 6 hours while the app is running, and on demand.
 * - Updates posts published in the last 90 days; each post keeps one row that
 *   is refreshed on every run.
 * - Needs read permissions in addition to the posting ones (see READ_SCOPES).
 *   A missing permission is reported, never guessed around.
 */

export const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_AGE_DAYS = 90;

/** Extra permissions each platform needs for reading metrics. */
export const READ_SCOPES: Record<Platform, string> = {
  youtube: "OAuth scopes youtube.readonly and yt-analytics.readonly (plus youtube.upload), and the YouTube Analytics API enabled in Google Cloud",
  instagram: "instagram_business_manage_insights (Instagram Login) or instagram_manage_insights (Facebook Login)",
  facebook: "read_insights and pages_read_engagement on the Page token",
  linkedin: "r_organization_social on the LinkedIn token",
  x: "nothing extra (public metrics come with the posting keys)",
};

export type Fetched = { metrics: Record<string, number>; notes: string[] };

/** The platform's id for a post: from the API result, or parsed from a pasted URL. */
export function externalIdOf(piece: Pick<ContentPiece, "platform" | "externalId" | "publishedUrl">): string | null {
  if (piece.externalId) return piece.externalId;
  const url = piece.publishedUrl ?? "";
  if (piece.platform === "youtube") return url.match(/(?:v=|shorts\/|youtu\.be\/)([\w-]{11})/)?.[1] ?? null;
  if (piece.platform === "x") return url.match(/status\/(\d+)/)?.[1] ?? null;
  if (piece.platform === "linkedin") return url.match(/(urn:li:(?:share|ugcPost):\d+)/)?.[1] ?? null;
  return null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

function put(out: Record<string, number>, key: string, v: unknown) {
  const n = num(v);
  if (n !== undefined && n >= 0) out[key] = n;
}

/* ------------------------------------------------------------------ */
/* YouTube                                                             */
/* ------------------------------------------------------------------ */

async function youtube(id: string, piece: ContentPiece, env: ConnectorEnv, deps: ConnectorDeps): Promise<Fetched> {
  const tokenRes = await call("youtube token", deps, "https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: env.YOUTUBE_CLIENT_ID!, client_secret: env.YOUTUBE_CLIENT_SECRET!, refresh_token: env.YOUTUBE_REFRESH_TOKEN!, grant_type: "refresh_token" }) }, { idempotent: true });
  const token = await json<{ access_token: string; scope?: string }>(tokenRes);
  const auth = { Authorization: `Bearer ${token.access_token}` };
  const out: Record<string, number> = {};
  const notes: string[] = [];

  try {
    const r = await call("youtube stats", deps, `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(id)}`, { method: "GET", headers: auth }, { idempotent: true });
    const s = (await json<{ items?: Array<{ statistics?: Record<string, string> }> }>(r)).items?.[0]?.statistics;
    if (!s) notes.push("YouTube returned no statistics (video deleted or not yet processed).");
    else {
      put(out, "views", s.viewCount);
      put(out, "likes", s.likeCount);
      put(out, "comments", s.commentCount);
    }
  } catch (err) {
    notes.push(`View counts: ${(err as Error).message}`);
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const metrics = "views,averageViewPercentage,averageViewDuration,estimatedMinutesWatched,subscribersGained,shares,likes,comments";
    const r = await call("youtube analytics", deps, `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2005-01-01&endDate=${today}&metrics=${metrics}&filters=video==${encodeURIComponent(id)}`, { method: "GET", headers: auth }, { idempotent: true });
    const rep = await json<{ columnHeaders?: Array<{ name: string }>; rows?: unknown[][] }>(r);
    const row = rep.rows?.[0];
    if (row && rep.columnHeaders) {
      const v = (name: string) => row[rep.columnHeaders!.findIndex((h) => h.name === name)];
      put(out, "views", v("views"));
      put(out, "avgPercentViewed", v("averageViewPercentage"));
      put(out, "avgViewDurationSec", v("averageViewDuration"));
      const minutes = num(v("estimatedMinutesWatched"));
      if (minutes !== undefined && piece.format === "long-video") out.watchTimeHours = Math.round((minutes / 60) * 100) / 100;
      put(out, "subscribersGained", v("subscribersGained"));
      put(out, "shares", v("shares"));
    } else {
      notes.push("YouTube Analytics has no data for this video yet (it usually lags 2–3 days).");
    }
  } catch (err) {
    notes.push(`Watch-time metrics: ${(err as Error).message}`);
  }
  if (piece.format === "long-video") notes.push("Impressions and click-through rate aren't in the API; add them from YouTube Studio if you track them.");
  return { metrics: out, notes };
}

/* ------------------------------------------------------------------ */
/* Instagram                                                           */
/* ------------------------------------------------------------------ */

const IG_KEYS: Record<string, string> = { reach: "reach", likes: "likes", comments: "comments", shares: "shares", saved: "saves", views: "views", profile_visits: "profileVisits", follows: "follows", replies: "replies" };

async function instagram(id: string, piece: ContentPiece, env: ConnectorEnv, deps: ConnectorDeps): Promise<Fetched> {
  const { base, token } = igBase(env);
  const sets =
    piece.format === "reel"
      ? [["reach", "likes", "comments", "shares", "saved", "views", "ig_reels_avg_watch_time"], ["reach", "likes", "comments", "shares", "saved"]]
      : piece.format === "story"
        ? [["reach", "replies"], ["reach"]]
        : [["reach", "likes", "comments", "shares", "saved", "views", "profile_visits", "follows"], ["reach", "likes", "comments", "shares", "saved"]];
  const notes: string[] = [];
  for (const [n, metrics] of sets.entries()) {
    try {
      const r = await call("instagram insights", deps, `${base}/${id}/insights?metric=${metrics.join(",")}&access_token=${encodeURIComponent(token)}`, { method: "GET" }, { idempotent: true });
      const data = (await json<{ data?: Array<{ name: string; values?: Array<{ value: unknown }>; total_value?: { value: unknown } }> }>(r)).data ?? [];
      const out: Record<string, number> = {};
      for (const d of data) {
        const value = d.total_value?.value ?? d.values?.[0]?.value;
        if (d.name === "ig_reels_avg_watch_time") {
          const ms = num(value);
          if (ms !== undefined) out.avgWatchTimeSec = Math.round(ms / 100) / 10;
        } else if (IG_KEYS[d.name]) put(out, IG_KEYS[d.name]!, value);
      }
      if (n > 0) notes.push("Some Instagram metrics weren't available for this post; the basic ones were saved.");
      if (piece.format === "reel") notes.push("Add the Reel length (seconds) by hand to see the watch ratio.");
      return { metrics: out, notes };
    } catch (err) {
      if (n === sets.length - 1) throw err;
    }
  }
  return { metrics: {}, notes };
}

/* ------------------------------------------------------------------ */
/* Facebook                                                            */
/* ------------------------------------------------------------------ */

async function facebook(id: string, piece: ContentPiece, env: ConnectorEnv, deps: ConnectorDeps): Promise<Fetched> {
  const base = `https://graph.facebook.com/${env.META_GRAPH_VERSION || "v24.0"}`;
  const token = encodeURIComponent(env.META_PAGE_ACCESS_TOKEN!);
  const out: Record<string, number> = {};
  const notes: string[] = [];

  if (piece.format === "reel") {
    // Reels are read by their video id (in the /reel/<id> link), not the feed post id.
    const vid = (piece.publishedUrl ?? "").match(/\/(?:reel|videos)\/(\d+)/)?.[1] ?? id;
    const v = await call("facebook reel", deps, `${base}/${vid}?fields=views,length,likes.summary(true).limit(0),comments.summary(true).limit(0)&access_token=${token}`, { method: "GET" }, { idempotent: true });
    const video = await json<{ views?: number; length?: number; likes?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }>(v);
    put(out, "views", video.views);
    put(out, "durationSec", video.length);
    put(out, "reactions", video.likes?.summary?.total_count);
    put(out, "comments", video.comments?.summary?.total_count);
    try {
      const r = await call("facebook reel insights", deps, `${base}/${vid}/video_insights?metric=blue_reels_play_count,fb_reels_total_plays,post_video_avg_time_watched,post_video_social_actions,post_video_likes_by_reaction_type&access_token=${token}`, { method: "GET" }, { idempotent: true });
      for (const d of (await json<{ data?: Array<{ name: string; values?: Array<{ value: unknown }> }> }>(r)).data ?? []) {
        const val = d.values?.[0]?.value;
        if (d.name === "blue_reels_play_count" || d.name === "fb_reels_total_plays") {
          const n = num(val);
          if (n !== undefined && n > (out.views ?? -1)) out.views = n;
        }
        if (d.name === "post_video_avg_time_watched") {
          const ms = num(val);
          if (ms !== undefined) out.avgWatchTimeSec = Math.round(ms / 100) / 10;
        }
        if (d.name === "post_video_social_actions" && val && typeof val === "object") {
          const a = val as Record<string, unknown>;
          put(out, "shares", a.SHARE ?? a.share ?? 0);
          if (a.COMMENT !== undefined) put(out, "comments", Math.max(num(a.COMMENT) ?? 0, out.comments ?? 0));
        }
        if (d.name === "post_video_likes_by_reaction_type" && val && typeof val === "object") {
          const total = Object.values(val as Record<string, unknown>).reduce<number>((s, x) => s + (num(x) ?? 0), 0);
          if (total > (out.reactions ?? 0)) out.reactions = total;
        }
      }
    } catch (err) {
      notes.push(`Watch time and shares: ${(err as Error).message}`);
    }
    out.shares ??= 0;
    return { metrics: out, notes };
  }

  const r = await call("facebook post", deps, `${base}/${id}?fields=reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares&access_token=${token}`, { method: "GET" }, { idempotent: true });
  const p = await json<{ reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } }; shares?: { count?: number } }>(r);
  put(out, "reactions", p.reactions?.summary?.total_count);
  put(out, "comments", p.comments?.summary?.total_count);
  put(out, "shares", p.shares?.count ?? 0);
  try {
    // Meta replaced post_impressions(_unique) with media views in late 2025.
    const ins = await call("facebook post insights", deps, `${base}/${id}/insights?metric=post_total_media_view_unique,post_media_view,post_clicks&access_token=${token}`, { method: "GET" }, { idempotent: true });
    for (const d of (await json<{ data?: Array<{ name: string; values?: Array<{ value: unknown }> }> }>(ins)).data ?? []) {
      const v = d.values?.[0]?.value;
      if (d.name === "post_total_media_view_unique") put(out, "reach", v);
      if (d.name === "post_media_view") put(out, "impressions", v);
      if (d.name === "post_clicks") put(out, "clicks", v);
    }
  } catch (err) {
    notes.push(`Reach and clicks: ${(err as Error).message}`);
  }
  return { metrics: out, notes };
}

/* ------------------------------------------------------------------ */
/* LinkedIn                                                            */
/* ------------------------------------------------------------------ */

async function linkedin(id: string, _piece: ContentPiece, env: ConnectorEnv, deps: ConnectorDeps): Promise<Fetched> {
  const org = env.LINKEDIN_AUTHOR_URN!;
  if (!org.startsWith("urn:li:organization:")) return { metrics: {}, notes: ["LinkedIn post statistics are only available for company pages."] };
  const param = id.startsWith("urn:li:ugcPost:") ? "ugcPosts" : "shares";
  const url = `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(org)}&${param}=List(${encodeURIComponent(id)})`;
  const r = await call("linkedin statistics", deps, url, { method: "GET", headers: { Authorization: `Bearer ${env.LINKEDIN_ACCESS_TOKEN}`, "LinkedIn-Version": linkedinVersion(env), "X-Restli-Protocol-Version": "2.0.0" } }, { idempotent: true });
  const s = (await json<{ elements?: Array<{ totalShareStatistics?: Record<string, unknown> }> }>(r)).elements?.[0]?.totalShareStatistics;
  const out: Record<string, number> = {};
  if (s) {
    put(out, "impressions", s.impressionCount);
    put(out, "reactions", s.likeCount);
    put(out, "comments", s.commentCount);
    put(out, "reposts", s.shareCount);
    put(out, "clicks", s.clickCount);
  }
  return { metrics: out, notes: s ? [] : ["LinkedIn returned no statistics for this post yet."] };
}

/* ------------------------------------------------------------------ */
/* X                                                                   */
/* ------------------------------------------------------------------ */

async function x(id: string, _piece: ContentPiece, env: ConnectorEnv, deps: ConnectorDeps): Promise<Fetched> {
  const url = `https://api.x.com/2/tweets/${encodeURIComponent(id)}?tweet.fields=public_metrics`;
  const keys = { consumerKey: env.X_API_KEY!, consumerSecret: env.X_API_SECRET!, token: env.X_ACCESS_TOKEN!, tokenSecret: env.X_ACCESS_TOKEN_SECRET! };
  const r = await call("x metrics", deps, url, () => ({ method: "GET", headers: { Authorization: oauth1Header("GET", url, keys) } }), { idempotent: true });
  const m = (await json<{ data?: { public_metrics?: Record<string, number> } }>(r)).data?.public_metrics;
  const out: Record<string, number> = {};
  if (m) {
    put(out, "impressions", m.impression_count);
    put(out, "likes", m.like_count);
    put(out, "reposts", (m.retweet_count ?? 0) + (m.quote_count ?? 0));
    put(out, "replies", m.reply_count);
    put(out, "bookmarks", m.bookmark_count);
  }
  return { metrics: out, notes: m ? [] : ["X returned no metrics for this post."] };
}

export const FETCHERS: Record<Platform, (id: string, piece: ContentPiece, env: ConnectorEnv, deps: ConnectorDeps) => Promise<Fetched>> = { youtube, instagram, facebook, linkedin, x };

/** Env vars a platform needs before its metrics can be read. */
const NEEDS: Record<Platform, string[]> = {
  youtube: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"],
  instagram: ["INSTAGRAM_ACCOUNT_ID"],
  facebook: ["META_PAGE_ACCESS_TOKEN"],
  linkedin: ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_AUTHOR_URN"],
  x: ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"],
};

function canRead(platform: Platform, env: ConnectorEnv): boolean {
  if (platform === "instagram" && !env.INSTAGRAM_ACCESS_TOKEN && !env.META_PAGE_ACCESS_TOKEN) return false;
  return NEEDS[platform].every((k) => env[k]);
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

export interface SyncSummary {
  at: string;
  updated: number;
  failed: number;
  skipped: number;
  notes: string[];
}

function publishedAt(p: ContentPiece): string {
  return [...p.history].reverse().find((h) => h.to === "published")?.at ?? p.updatedAt;
}

/** Posts the agent should read now. */
export function syncTargets(db: Pick<Database, "content">, now: Date): ContentPiece[] {
  const oldest = now.getTime() - MAX_AGE_DAYS * 86_400_000;
  return db.content.filter((c) => c.status === "published" && !c.isSample && new Date(publishedAt(c)).getTime() >= oldest);
}

let running: Promise<SyncSummary> | null = null;

export function runMetricsSync(opts: { now?: Date; deps?: ConnectorDeps } = {}): Promise<SyncSummary> {
  running ??= doSync(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(opts: { now?: Date; deps?: ConnectorDeps }): Promise<SyncSummary> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? defaultDeps();
  const db = await readDb();
  const summary: SyncSummary = { at: now.toISOString(), updated: 0, failed: 0, skipped: 0, notes: [] };
  const results: Array<{ piece: ContentPiece; fetched: Fetched }> = [];

  for (const piece of syncTargets(db, now)) {
    const brand = db.brands.find((b) => b.id === piece.brandId);
    if (!brand) continue;
    const env = brandEnv(brand, db, deps.env);
    const label = `${brand.name} ${piece.platform} "${piece.topic}"`;
    if (!canRead(piece.platform, env)) {
      summary.skipped++;
      continue;
    }
    const id = externalIdOf(piece);
    if (!id) {
      summary.skipped++;
      summary.notes.push(`${label}: no platform id, so add its metrics by hand.`);
      continue;
    }
    try {
      const fetched = await FETCHERS[piece.platform](id, piece, env, { ...deps, env });
      if (Object.keys(fetched.metrics).length === 0) {
        summary.failed++;
        summary.notes.push(`${label}: no metrics returned. ${fetched.notes.join(" ")}`);
        continue;
      }
      results.push({ piece, fetched });
      if (fetched.notes.length) summary.notes.push(`${label}: ${fetched.notes.join(" ")}`);
    } catch (err) {
      summary.failed++;
      const msg = err instanceof PublishError ? err.message : (err as Error).message;
      const scopeHint = /scope|permission|403|insufficient|not authorized|\(#10\)|\(#200\)/i.test(msg) ? ` Needs ${READ_SCOPES[piece.platform]}.` : "";
      summary.notes.push(`${label}: ${msg}${scopeHint}`);
      log.warn("Metrics read failed", { platform: piece.platform, id: piece.id, error: msg });
    }
  }

  // Account-level reach and clicks (last 28 days), once per brand and platform.
  const accounts: AccountStat[] = [];
  const today = now.toISOString().slice(0, 10);
  for (const brand of db.brands) {
    const env = brandEnv(brand, db, deps.env);
    for (const platform of brand.platforms) {
      const fetch = ACCOUNT_FETCHERS[platform];
      if (!fetch || !canRead(platform, env)) continue;
      try {
        const got = await fetch(env, { ...deps, env }, now);
        if (Object.keys(got.numbers).length) accounts.push({ brandId: brand.id, platform, date: today, at: summary.at, days: ACCOUNT_DAYS, ...got.numbers });
        for (const n of got.notes) if (!/only in YouTube Studio/.test(n)) summary.notes.push(`${brand.name} ${platform} account: ${n}`);
      } catch (err) {
        summary.notes.push(`${brand.name} ${platform} account reach: ${(err as Error).message}`);
      }
    }
  }

  // Website visitors and Google search (GA4 + Search Console), when configured.
  const web = await readWebsite(deps.env as WebsiteEnv, { fetcher: deps.fetch, now });
  summary.notes.push(...web.notes);
  // Google Play (ASO), when the Play sign-in exists.
  const play = await readPlay(deps.env as PlayEnv, { fetcher: deps.fetch, now }).catch((err) => ({ data: null, notes: [`Google Play: ${(err as Error).message}`] }));
  summary.notes.push(...play.notes.filter((n) => !/need PLAY_REPORTS_BUCKET/.test(n)));

  await mutate((d) => {
    if (play.data) {
      d.asoStats = d.asoStats.filter((x) => x.date !== today);
      d.asoStats.push({ ...play.data, date: today, at: summary.at });
    }
    if (web.data) {
      d.websiteStats = d.websiteStats.filter((x) => x.date !== today);
      d.websiteStats.push({ sources: [], pages: [], posts: [], ...web.data, date: today, at: summary.at } as WebsiteStat);
    }
    for (const a of accounts) {
      d.accountStats = d.accountStats.filter((x) => !(x.brandId === a.brandId && x.platform === a.platform && x.date === a.date));
      d.accountStats.push(a);
    }
    for (const { piece, fetched } of results) {
      const existing = d.metrics.find((m) => m.contentId === piece.id && !m.isSample);
      if (existing) {
        existing.metrics = { ...existing.metrics, ...fetched.metrics };
        existing.source = "api";
        existing.syncedAt = summary.at;
      } else {
        const row: PostMetric = {
          id: newId("metric"),
          brandId: piece.brandId,
          contentId: piece.id,
          platform: piece.platform,
          format: piece.format,
          postedAt: publishedAt(piece),
          hook: piece.hook,
          pillarId: piece.pillarId,
          cta: piece.cta,
          url: piece.publishedUrl ?? "",
          metrics: fetched.metrics,
          source: "api",
          isSample: false,
          syncedAt: summary.at,
        };
        d.metrics.push(row);
      }
      summary.updated++;
    }
    d.settings.lastMetricsSync = { ...summary, notes: summary.notes.slice(0, 20) };
  });
  log.info("Metrics sync finished", { updated: summary.updated, failed: summary.failed, skipped: summary.skipped });
  return summary;
}

/** True when the last sync is older than SYNC_EVERY_MS. */
export function syncDue(db: Pick<Database, "settings">, now = new Date()): boolean {
  const last = db.settings.lastMetricsSync?.at;
  return !last || now.getTime() - new Date(last).getTime() >= SYNC_EVERY_MS;
}
