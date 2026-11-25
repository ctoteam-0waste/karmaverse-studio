import type { Brand, Competitor, CompetitorPost, ContentPiece, Database, Format, Platform, PostMetric } from "../schemas";
import { mutate, readDb } from "../db";
import { logger } from "../logger";
import { newId } from "../util";
import { brandEnv } from "../publishing/accounts";
import { call, defaultDeps, json, type ConnectorDeps, type ConnectorEnv } from "../publishing/connectors";
import { youtubeAccessToken } from "../community/comments";

const log = logger("competitor-watch");

/**
 * N. Competitor Watch.
 *
 * Tracks what similar brands post and what works for them, from public data only:
 * - YouTube: subscribers and the latest 25 videos with views, likes and comments
 *   (Data API, using the brand's YouTube connection).
 * - Instagram: followers and the latest 25 posts with likes and comments, via
 *   Business Discovery (needs a Facebook-login token: the brand's
 *   META_PAGE_ACCESS_TOKEN with instagram_basic, and a business/creator account).
 * - LinkedIn, Facebook and X don't offer this for other accounts; add their
 *   posts by hand.
 *
 * The report compares formats, posting times and hooks, normalised per
 * competitor so a big account doesn't drown out a small one. It is for
 * learning, never copying: ideas made from it say so.
 */

export const COMPETITORS_EVERY_MS = 24 * 60 * 60 * 1000;
const POSTS_PER_SYNC = 25;

export function competitorsDue(db: Pick<Database, "settings" | "competitors">, now = new Date()): boolean {
  if (!db.competitors.some((c) => c.instagram || c.youtube)) return false;
  const last = db.settings.lastCompetitorSync?.at;
  return !last || now.getTime() - new Date(last).getTime() >= COMPETITORS_EVERY_MS;
}

type Fetched = { followers: number | null; postCount: number | null; posts: Array<Omit<CompetitorPost, "id" | "competitorId" | "syncedAt" | "source">> };

/* ------------------------------------------------------------------ */
/* YouTube                                                             */
/* ------------------------------------------------------------------ */

/** "PT1M5S" → 65 */
export function isoSeconds(d: string): number {
  const m = d.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

async function youtube(handle: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<Fetched> {
  const token = await youtubeAccessToken(env, deps);
  const auth = { Authorization: `Bearer ${token}` };
  const h = handle.trim().replace(/^https?:\/\/(www\.)?youtube\.com\//, "");
  const q = /^UC[\w-]{22}$/.test(h) ? `id=${h}` : `forHandle=${encodeURIComponent(h.startsWith("@") ? h : `@${h}`)}`;
  const ch = (await json<{ items?: Array<{ statistics?: { subscriberCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>(
    await call("youtube channel", deps, `https://www.googleapis.com/youtube/v3/channels?part=statistics,contentDetails&${q}`, { method: "GET", headers: auth }, { idempotent: true }),
  )).items?.[0];
  if (!ch) throw new Error(`YouTube channel "${handle}" not found. Use the @handle from the channel page or its UC… id.`);
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  const posts: Fetched["posts"] = [];
  if (uploads) {
    const pl = await json<{ items?: Array<{ contentDetails?: { videoId?: string } }> }>(await call("youtube uploads", deps, `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=${POSTS_PER_SYNC}&playlistId=${encodeURIComponent(uploads)}`, { method: "GET", headers: auth }, { idempotent: true }));
    const ids = (pl.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean) as string[];
    if (ids.length) {
      const vids = await json<{ items?: Array<{ id: string; snippet?: { title?: string; publishedAt?: string }; statistics?: Record<string, string>; contentDetails?: { duration?: string } }> }>(
        await call("youtube videos", deps, `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}`, { method: "GET", headers: auth }, { idempotent: true }),
      );
      for (const v of vids.items ?? []) {
        const title = v.snippet?.title ?? "";
        const short = isoSeconds(v.contentDetails?.duration ?? "") <= 60 || /#shorts?\b/i.test(title);
        posts.push({
          platform: "youtube",
          format: short ? "short" : "long-video",
          postedAt: v.snippet?.publishedAt ?? new Date().toISOString(),
          hook: title,
          url: short ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`,
          externalId: v.id,
          likes: Number(v.statistics?.likeCount ?? 0),
          comments: Number(v.statistics?.commentCount ?? 0),
          views: v.statistics?.viewCount !== undefined ? Number(v.statistics.viewCount) : null,
        });
      }
    }
  }
  const subs = ch.statistics?.hiddenSubscriberCount ? null : ch.statistics?.subscriberCount !== undefined ? Number(ch.statistics.subscriberCount) : null;
  return { followers: subs, postCount: ch.statistics?.videoCount !== undefined ? Number(ch.statistics.videoCount) : null, posts };
}

/* ------------------------------------------------------------------ */
/* Instagram (Business Discovery)                                      */
/* ------------------------------------------------------------------ */

interface IgMedia {
  id: string;
  caption?: string;
  like_count?: number;
  comments_count?: number;
  media_type?: string;
  media_product_type?: string;
  timestamp?: string;
  permalink?: string;
}

export function igFormat(m: Pick<IgMedia, "media_type" | "media_product_type">): Format {
  if (m.media_product_type === "REELS" || m.media_type === "VIDEO") return "reel";
  if (m.media_type === "CAROUSEL_ALBUM") return "carousel";
  return "image-post";
}

async function instagram(username: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<Fetched> {
  const token = env.META_PAGE_ACCESS_TOKEN?.trim();
  const me = env.INSTAGRAM_ACCOUNT_ID?.trim();
  if (!token || !me) throw new Error("Instagram competitor data needs the brand's INSTAGRAM_ACCOUNT_ID and a Facebook Page token (META_PAGE_ACCESS_TOKEN) with instagram_basic. Instagram-login tokens can't look up other accounts.");
  const u = username.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/.*$/, "");
  const fields = `business_discovery.username(${u}){followers_count,media_count,media.limit(${POSTS_PER_SYNC}){id,caption,like_count,comments_count,media_type,media_product_type,timestamp,permalink}}`;
  const base = `https://graph.facebook.com/${env.META_GRAPH_VERSION?.trim() || "v24.0"}`;
  const r = await json<{ business_discovery?: { followers_count?: number; media_count?: number; media?: { data?: IgMedia[] } } }>(
    await call("instagram business discovery", deps, `${base}/${encodeURIComponent(me)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`, { method: "GET" }, { idempotent: true }),
  );
  const bd = r.business_discovery;
  if (!bd) throw new Error(`Instagram account "${u}" not found, or it's a personal account (only business and creator accounts can be looked up).`);
  return {
    followers: bd.followers_count ?? null,
    postCount: bd.media_count ?? null,
    posts: (bd.media?.data ?? []).map((m) => ({
      platform: "instagram" as const,
      format: igFormat(m),
      postedAt: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString(),
      hook: (m.caption ?? "").split("\n")[0]!.slice(0, 200),
      url: m.permalink ?? "",
      externalId: m.id,
      // Hidden like counts come back missing; count them as 0 rather than guess.
      likes: m.like_count ?? 0,
      comments: m.comments_count ?? 0,
      views: null,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

export interface CompetitorSyncSummary {
  at: string;
  updated: number;
  notes: string[];
}

let running: Promise<CompetitorSyncSummary> | null = null;

export function runCompetitorWatch(opts: { now?: Date; deps?: ConnectorDeps; onlyId?: string } = {}): Promise<CompetitorSyncSummary> {
  running ??= doSync(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(opts: { now?: Date; deps?: ConnectorDeps; onlyId?: string }): Promise<CompetitorSyncSummary> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? defaultDeps();
  const db = await readDb();
  const summary: CompetitorSyncSummary = { at: now.toISOString(), updated: 0, notes: [] };
  const results: Array<{ id: string; platform: Platform; fetched: Fetched | null; notes: string[] }> = [];

  for (const comp of db.competitors.filter((c) => !opts.onlyId || c.id === opts.onlyId)) {
    const brand = db.brands.find((b) => b.id === comp.brandId);
    if (!brand) continue;
    const env = brandEnv(brand, db, deps.env);
    const jobs: Array<[Platform, string, (h: string, e: ConnectorEnv, d: ConnectorDeps) => Promise<Fetched>]> = [];
    if (comp.youtube) jobs.push(["youtube", comp.youtube, youtube]);
    if (comp.instagram) jobs.push(["instagram", comp.instagram, instagram]);
    for (const [platform, handle, fn] of jobs) {
      if (platform === "youtube" && !(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN)) {
        results.push({ id: comp.id, platform, fetched: null, notes: [`YouTube: connect ${brand.name}'s YouTube first (Publishing page).`] });
        continue;
      }
      try {
        results.push({ id: comp.id, platform, fetched: await fn(handle, env, { ...deps, env }), notes: [] });
      } catch (err) {
        const msg = (err as Error).message;
        results.push({ id: comp.id, platform, fetched: null, notes: [`${platform === "youtube" ? "YouTube" : "Instagram"}: ${msg}`] });
        log.warn("Competitor read failed", { competitor: comp.name, platform, error: msg });
      }
    }
  }

  await mutate((d) => {
    const touched = new Set<string>();
    for (const r of results) {
      const comp = d.competitors.find((c) => c.id === r.id);
      if (!comp) continue;
      if (!touched.has(comp.id)) {
        comp.lastSyncNotes = [];
        touched.add(comp.id);
      }
      comp.lastSyncNotes.push(...r.notes);
      comp.lastSyncAt = summary.at;
      if (!r.fetched) {
        summary.notes.push(...r.notes.map((n) => `${comp.name}: ${n}`));
        continue;
      }
      comp.profiles = [...comp.profiles.filter((p) => p.platform !== r.platform), { platform: r.platform, followers: r.fetched.followers, posts: r.fetched.postCount, at: summary.at }];
      for (const p of r.fetched.posts) {
        const existing = d.competitorPosts.find((x) => x.competitorId === comp.id && x.platform === p.platform && x.externalId === p.externalId);
        if (existing) Object.assign(existing, { likes: p.likes, comments: p.comments, views: p.views, syncedAt: summary.at });
        else d.competitorPosts.push({ ...p, id: newId("cpost"), competitorId: comp.id, source: "api", syncedAt: summary.at });
      }
      summary.updated++;
    }
    // Keep 180 days of posts.
    const oldest = now.getTime() - 180 * 86_400_000;
    d.competitorPosts = d.competitorPosts.filter((p) => Date.parse(p.postedAt) >= oldest);
    if (!opts.onlyId) d.settings.lastCompetitorSync = { ...summary, notes: summary.notes.slice(0, 20) };
  });
  log.info("Competitor sync finished", { updated: summary.updated });
  return summary;
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

export const engagementOf = (p: Pick<CompetitorPost, "likes" | "comments">) => p.likes + p.comments;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Weekday and hour in IST. */
export function istSlot(iso: string): { day: string; hour: number } {
  const d = new Date(Date.parse(iso) + 330 * 60_000);
  return { day: WEEKDAYS[d.getUTCDay()]!, hour: d.getUTCHours() };
}

export interface CompetitorSummaryRow {
  competitor: Competitor;
  platform: Platform;
  followers: number | null;
  postsLast30: number;
  perWeek: number;
  avgEngagement: number;
  /** Average engagement per post as a share of followers. */
  engagementRate: number | null;
  avgViews: number | null;
  bestFormat: { format: Format; times: number } | null;
}

export interface TopPost {
  post: CompetitorPost;
  competitor: Competitor;
  /** Engagement relative to that competitor's median on the platform. */
  lift: number;
}

export interface CompetitorReport {
  rows: CompetitorSummaryRow[];
  /** Formats ranked by typical lift over each competitor's median (at least 3 posts). */
  formats: Array<{ platform: Platform; format: Format; lift: number; posts: number }>;
  bestSlots: Array<{ day: string; hours: string; lift: number; posts: number }>;
  hooks: Array<{ pattern: string; lift: number; posts: number; without: number }>;
  top: TopPost[];
  own: Array<{ platform: Platform; perWeek: number; avgEngagement: number | null }>;
  insights: string[];
}

const OWN_ENGAGEMENT = ["likes", "reactions", "comments", "replies", "shares", "reposts", "saves"];

export function competitorReport(brand: Brand, competitors: Competitor[], posts: CompetitorPost[], own: { content: ContentPiece[]; metrics: PostMetric[] }, now: Date): CompetitorReport {
  const mine = competitors.filter((c) => c.brandId === brand.id);
  const ids = new Set(mine.map((c) => c.id));
  const all = posts.filter((p) => ids.has(p.competitorId));
  const since30 = now.getTime() - 30 * 86_400_000;
  const groups = new Map<string, CompetitorPost[]>();
  for (const p of all) groups.set(`${p.competitorId}|${p.platform}`, [...(groups.get(`${p.competitorId}|${p.platform}`) ?? []), p]);

  const rows: CompetitorSummaryRow[] = [];
  const lifted: Array<{ post: CompetitorPost; lift: number }> = [];
  for (const [key, ps] of groups) {
    const [cid, platform] = key.split("|") as [string, Platform];
    const comp = mine.find((c) => c.id === cid)!;
    const med = median(ps.map(engagementOf));
    for (const p of ps) lifted.push({ post: p, lift: med > 0 ? engagementOf(p) / med : 1 });
    const recent = ps.filter((p) => Date.parse(p.postedAt) >= since30);
    const followers = comp.profiles.find((x) => x.platform === platform)?.followers ?? null;
    const avg = ps.length ? ps.reduce((a, p) => a + engagementOf(p), 0) / ps.length : 0;
    const withViews = ps.filter((p) => p.views !== null);
    const byFormat = new Map<Format, number[]>();
    for (const p of ps) byFormat.set(p.format, [...(byFormat.get(p.format) ?? []), med > 0 ? engagementOf(p) / med : 1]);
    let best: CompetitorSummaryRow["bestFormat"] = null;
    if (byFormat.size > 1) {
      for (const [format, ls] of byFormat) if (ls.length >= 2 && (!best || median(ls) > best.times)) best = { format, times: round(median(ls), 2) };
    }
    rows.push({
      competitor: comp,
      platform,
      followers,
      postsLast30: recent.length,
      perWeek: round((recent.length / 30) * 7),
      avgEngagement: Math.round(avg),
      engagementRate: followers ? round((avg / followers) * 100, 2) : null,
      avgViews: withViews.length ? Math.round(withViews.reduce((a, p) => a + (p.views ?? 0), 0) / withViews.length) : null,
      bestFormat: best,
    });
  }
  rows.sort((a, b) => a.competitor.name.localeCompare(b.competitor.name) || a.platform.localeCompare(b.platform));

  // Formats: typical lift across competitors.
  const fm = new Map<string, number[]>();
  for (const l of lifted) fm.set(`${l.post.platform}|${l.post.format}`, [...(fm.get(`${l.post.platform}|${l.post.format}`) ?? []), l.lift]);
  const formats = [...fm]
    .filter(([, ls]) => ls.length >= 3)
    .map(([k, ls]) => {
      const [platform, format] = k.split("|") as [Platform, Format];
      return { platform, format, lift: round(median(ls), 2), posts: ls.length };
    })
    .sort((a, b) => b.lift - a.lift);

  // Posting times: day + 3-hour band, IST.
  const sm = new Map<string, number[]>();
  for (const l of lifted) {
    const s = istSlot(l.post.postedAt);
    const band = Math.floor(s.hour / 3) * 3;
    const k = `${s.day}|${band}`;
    sm.set(k, [...(sm.get(k) ?? []), l.lift]);
  }
  const bestSlots = [...sm]
    .filter(([, ls]) => ls.length >= 2)
    .map(([k, ls]) => {
      const [day, band] = k.split("|");
      const b = Number(band);
      return { day: day!, hours: `${String(b).padStart(2, "0")}:00–${String(b + 3).padStart(2, "0")}:00`, lift: round(median(ls), 2), posts: ls.length };
    })
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 5);

  // Hook patterns.
  const patterns: Array<[string, (h: string) => boolean]> = [
    ["Asks a question", (h) => h.includes("?")],
    ["Has a number", (h) => /\d/.test(h)],
    ["Says how-to / tips", (h) => /\b(how to|tips?|ways?|steps?|guide)\b/i.test(h)],
    ["Myth / fact / mistake", (h) => /\b(myth|fact|truth|mistake|wrong)\b/i.test(h)],
    ["Uses emoji", (h) => /\p{Extended_Pictographic}/u.test(h)],
  ];
  const hooks = patterns
    .map(([pattern, test]) => {
      const yes = lifted.filter((l) => l.post.hook && test(l.post.hook));
      const no = lifted.filter((l) => l.post.hook && !test(l.post.hook));
      return { pattern, lift: yes.length >= 3 && no.length >= 3 ? round(median(yes.map((l) => l.lift)) / Math.max(0.01, median(no.map((l) => l.lift))), 2) : 0, posts: yes.length, without: no.length };
    })
    .filter((h) => h.lift > 0)
    .sort((a, b) => b.lift - a.lift);

  const top = lifted
    .filter((l) => Date.parse(l.post.postedAt) >= now.getTime() - 60 * 86_400_000 && engagementOf(l.post) > 0)
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 8)
    .map((l) => ({ ...l, competitor: mine.find((c) => c.id === l.post.competitorId)! }));

  // The brand's own pace and engagement, for comparison.
  const ownPlatforms = [...new Set(rows.map((r) => r.platform))];
  const ownRows = ownPlatforms.map((platform) => {
    const published = own.content.filter((c) => c.brandId === brand.id && c.platform === platform && c.status === "published" && Date.parse(c.updatedAt) >= since30).length;
    const ms = own.metrics.filter((m) => m.brandId === brand.id && m.platform === platform && !m.isSample);
    const eng = ms.map((m) => OWN_ENGAGEMENT.reduce((a, k) => a + (m.metrics[k] ?? 0), 0));
    return { platform, perWeek: round((published / 30) * 7), avgEngagement: eng.length ? Math.round(eng.reduce((a, b) => a + b, 0) / eng.length) : null };
  });

  const insights: string[] = [];
  const f0 = formats[0];
  const fLast = formats[formats.length - 1];
  if (f0 && fLast && f0 !== fLast && f0.lift >= 1.2) insights.push(`On ${f0.platform}, ${f0.format}s do best for competitors: ${f0.lift}× their usual engagement, vs ${fLast.lift}× for ${fLast.format}s.`);
  const h0 = hooks[0];
  if (h0 && h0.lift >= 1.2) insights.push(`Hooks that ${h0.pattern.toLowerCase()} get ${h0.lift}× the engagement of hooks that don't (${h0.posts} posts).`);
  const s0 = bestSlots[0];
  if (s0 && s0.lift >= 1.2) insights.push(`Their best posting slot: ${s0.day} ${s0.hours} IST (${s0.lift}× usual, ${s0.posts} posts). Test it against yours.`);
  for (const o of ownRows) {
    const theirs = rows.filter((r) => r.platform === o.platform && r.postsLast30 > 0);
    if (!theirs.length) continue;
    const pace = median(theirs.map((r) => r.perWeek));
    if (pace >= o.perWeek * 1.5 && pace - o.perWeek >= 1) insights.push(`On ${o.platform}, competitors post about ${round(pace)}×/week; you posted ${o.perWeek}×/week in the last 30 days.`);
  }
  if (!all.length) insights.push("No competitor posts yet. Add competitors with their Instagram or YouTube handle, or add posts by hand.");
  return { rows, formats, bestSlots, hooks, top, own: ownRows, insights };
}
