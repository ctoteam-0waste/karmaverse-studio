import type { Brand, Database, Trend } from "../schemas";
import { mutate, readDb } from "../db";
import { logger } from "../logger";
import { newId, toDateKey } from "../util";
import { brandEnv } from "../publishing/accounts";
import { call, defaultDeps, json, type ConnectorDeps, type ConnectorEnv } from "../publishing/connectors";
import { youtubeAccessToken } from "../community/comments";
import { upcomingDays } from "./days";

const log = logger("trend-watcher");

/**
 * M. Trend Watcher.
 *
 * Once a day, finds things worth posting about soon, scored for fit with the brand:
 * - Climate days in the next 45 days (UN and Indian observances), with an angle.
 * - Google Trends: today's trending searches in India that touch climate,
 *   pollution, waste, energy or weather (public RSS, no key).
 * - Google News: this week's Indian news on the brand's topics (public RSS).
 * - YouTube: the most-viewed videos this week on the brand's topics in India
 *   (uses the brand's YouTube connection, if any).
 *
 * Headlines are shown as found and never published: the team checks facts
 * before using one. Trending Reels audio has no public API, so it isn't covered.
 */

export const TRENDS_EVERY_MS = 24 * 60 * 60 * 1000;
const DAYS_AHEAD = 45;

/** Climate-action words (matched at word starts); a trending search must contain one to be relevant. */
export const CLIMATE_WORDS = [
  "climate", "carbon", "emission", "pollut", "aqi", "air quality", "smog", "stubble", "plastic", "recycl", "waste", "garbage", "landfill",
  "compost", "sustainab", "environment", "go green", "green energy", "solar", "renewable", "electric vehicle", "ev\\b", "heatwave", "heat wave",
  "flood", "cyclone", "drought", "water crisis", "trees?\\b", "forest", "biodiversity", "net zero", "cop ?3\\d", "clean air", "clean energy", "el ni[nñ]o", "extreme weather",
  "swachh", "e-waste", "energy sav", "ecolog", "eco-friendly", "wildlife",
].map((w) => new RegExp("\\b" + w, "i"));

export function brandWords(brand: Brand): string[] {
  const own = [...brand.hashtags.map((h) => h.replace(/^#/, "")), brand.category, ...brand.pillars.map((p) => p.name)]
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 5 && !["india", "indian", "videos", "stories", "updates", "short", "easy", "behind", "scenes", "product"].includes(w));
  return [...new Set(own)];
}

/** 0-100 fit: climate words count most, then the brand's own words, then recency. */
export function relevance(text: string, brand: Brand, ageDays = 0): number {
  const t = text.toLowerCase();
  const climate = CLIMATE_WORDS.filter((w) => w.test(t)).length;
  const own = brandWords(brand).filter((w) => new RegExp("\\b" + w).test(t)).length;
  if ((!climate && !own) || POLITICAL.test(t)) return 0;
  return Math.round(Math.max(0, Math.min(100, 35 + climate * 15 + own * 10 - Math.max(0, ageDays - 1) * 4)));
}

/** Party politics and outrage framing: a brand stays out of these, however popular. */
export const POLITICAL = /\b(hypocris|expos(es|ed|ing)\b|slams?\b|destroys?\b|shuts? down|schools?\s+(the\s+)?(eu|europe|west)|cooks the|bjp|congress|aap\b|tmc\b|modi|rahul gandhi|election|rally|cult\b|propaganda|anti-national)/i;

/** Pillar that best fits a set of words (by pillar id or name), else the first pillar. */
export function pillarFor(brand: Brand, fits: string[]): string {
  for (const f of fits) {
    const p = brand.pillars.find((x) => x.id.includes(f) || x.name.toLowerCase().includes(f));
    if (p) return p.id;
  }
  return brand.pillars[0]?.id ?? "general";
}

/* ------------------------------------------------------------------ */
/* RSS                                                                 */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\s+/g, " ")
    .trim();
}

export interface RssItem {
  title: string;
  link: string;
  date: string;
  fields: Record<string, string>;
}

/** Minimal RSS reader: each <item>'s child elements as text (first occurrence wins). */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const fields: Record<string, string> = {};
    // Nested elements (Google Trends' <ht:news_item>) are read too.
    const walk = (xmlPart: string) => {
      for (const f of xmlPart.matchAll(/<([\w:]+)[^>]*>([\s\S]*?)<\/\1>/g)) {
        fields[f[1]!] ??= decode(f[2]!);
        if (/<[\w:]+[^>]*>/.test(f[2]!.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ""))) walk(f[2]!);
      }
    };
    walk(m[1]!);
    const pub = fields.pubDate ? new Date(fields.pubDate) : null;
    items.push({ title: fields.title ?? "", link: fields.link ?? "", date: pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : "", fields });
  }
  return items.filter((i) => i.title);
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

type Found = Omit<Trend, "id" | "brandId" | "status" | "foundAt">;

export function climateDays(brand: Brand, today: string): Found[] {
  return upcomingDays(today, DAYS_AHEAD).map((d) => ({
    source: "climate-day" as const,
    title: d.name,
    url: "",
    date: d.date,
    detail: `${d.inDays === 0 ? "Today" : `In ${d.inDays} day${d.inDays === 1 ? "" : "s"}`}. ${d.why}`,
    // Best when there are 5-21 days to prepare.
    score: d.inDays < 3 ? 70 : d.inDays <= 21 ? 90 : 75,
    angle: `${d.angle}. Pillar: ${brand.pillars.find((p) => p.id === pillarFor(brand, d.fits))?.name ?? "any"}.`,
  }));
}

async function googleTrends(brand: Brand, deps: ConnectorDeps): Promise<Found[]> {
  const res = await call("google trends", deps, "https://trends.google.com/trending/rss?geo=IN", { method: "GET" }, { idempotent: true });
  const out: Found[] = [];
  for (const it of parseRss(await res.text())) {
    const news = it.fields["ht:news_item_title"] ?? "";
    const score = relevance(`${it.title} ${news}`, brand);
    if (score < 50) continue;
    out.push({
      source: "google-trends",
      title: it.title,
      url: it.fields["ht:news_item_url"] || `https://trends.google.com/trends/explore?geo=IN&q=${encodeURIComponent(it.title)}`,
      date: it.date,
      detail: [it.fields["ht:approx_traffic"] ? `${it.fields["ht:approx_traffic"]} searches` : "", news].filter(Boolean).join(" · "),
      score,
      angle: `People in India are searching "${it.title}" today. Answer the question behind it with one verified fact and one action people can take; post within 24 hours.`,
    });
  }
  return out;
}

/** News searches for the brand: its category plus the climate topics it covers. */
export function newsQueries(brand: Brand): string[] {
  const base = ["climate action India", "plastic waste India", "recycling India", "air pollution India"];
  const tags = brand.hashtags.map((h) => h.replace(/^#/, "").replace(/([a-z])([A-Z])/g, "$1 $2")).filter((h) => !h.toLowerCase().includes(brand.name.toLowerCase().replace(/\s+/g, "")));
  return [...new Set([...base, ...tags.slice(0, 2)])].slice(0, 6);
}

async function googleNews(brand: Brand, deps: ConnectorDeps, now: Date): Promise<Found[]> {
  const out: Found[] = [];
  for (const q of newsQueries(brand)) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:7d`)}&hl=en-IN&gl=IN&ceid=IN:en`;
    let items: RssItem[];
    try {
      items = parseRss(await (await call("google news", deps, url, { method: "GET" }, { idempotent: true })).text());
    } catch (err) {
      log.warn("News search failed", { q, error: (err as Error).message });
      continue;
    }
    for (const it of items.slice(0, 8)) {
      const ageDays = it.date ? (now.getTime() - Date.parse(it.date)) / 86_400_000 : 3;
      const score = relevance(it.title, brand, ageDays);
      if (score < 50) continue;
      const source = it.fields.source ?? "";
      const title = source && it.title.endsWith(` - ${source}`) ? it.title.slice(0, -source.length - 3) : it.title;
      out.push({ source: "news", title, url: it.link, date: it.date, detail: [source, `search: ${q}`].filter(Boolean).join(" · "), score, angle: "React to this story: what it means for an ordinary household and one action to take. Link the source; don't repeat numbers you haven't checked." });
    }
  }
  return out;
}

async function youtubeTrends(brand: Brand, env: ConnectorEnv, deps: ConnectorDeps, now: Date): Promise<Found[]> {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET || !env.YOUTUBE_REFRESH_TOKEN) return [];
  const token = await youtubeAccessToken(env, deps);
  const auth = { Authorization: `Bearer ${token}` };
  const after = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const out: Found[] = [];
  for (const q of ["sustainability tips", "climate change India"]) {
    const s = await call("youtube search", deps, `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&regionCode=IN&relevanceLanguage=en&maxResults=8&publishedAfter=${encodeURIComponent(after)}&q=${encodeURIComponent(q)}`, { method: "GET", headers: auth }, { idempotent: true });
    const items = (await json<{ items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; publishedAt?: string } }> }>(s)).items ?? [];
    const ids = items.map((i) => i.id?.videoId).filter(Boolean) as string[];
    if (!ids.length) continue;
    const v = await call("youtube video stats", deps, `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${ids.join(",")}`, { method: "GET", headers: auth }, { idempotent: true });
    const stats = new Map(((await json<{ items?: Array<{ id: string; statistics?: { viewCount?: string }; contentDetails?: { duration?: string } }> }>(v)).items ?? []).map((x) => [x.id, x]));
    for (const it of items) {
      const id = it.id?.videoId;
      if (!id) continue;
      const views = Number(stats.get(id)?.statistics?.viewCount ?? 0);
      const title = decode(it.snippet?.title ?? "");
      // Only videos actually about the brand's topics (relevance also drops politics).
      const fit = relevance(title, brand);
      if (fit < 50) continue;
      const dur = stats.get(id)?.contentDetails?.duration ?? "";
      const short = /^PT(\d+S|[0-2]M(\d+S)?)$/.test(dur) || /#shorts/i.test(title);
      out.push({
        source: "youtube",
        title,
        url: short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
        date: it.snippet?.publishedAt ?? "",
        detail: `${views.toLocaleString("en-IN")} views this week · ${it.snippet?.channelTitle ?? ""}${short ? " · Short" : ""}`,
        score: Math.min(100, fit + (views > 100_000 ? 20 : views > 10_000 ? 10 : 0)),
        angle: `Working on YouTube this week${short ? " (as a Short)" : ""}. Make your own take on the topic and format; never reuse their footage or audio.`,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

export interface TrendSummary {
  at: string;
  added: number;
  notes: string[];
}

export function trendsDue(db: Pick<Database, "settings">, now = new Date()): boolean {
  const last = db.settings.lastTrendScan?.at;
  return !last || now.getTime() - new Date(last).getTime() >= TRENDS_EVERY_MS;
}

const keyOf = (t: Pick<Trend, "brandId" | "source" | "title" | "date">) => `${t.brandId}|${t.source}|${t.title.toLowerCase().replace(/\W+/g, " ").trim()}${t.source === "climate-day" ? `|${t.date}` : ""}`;

let running: Promise<TrendSummary> | null = null;

export function runTrendWatcher(opts: { now?: Date; deps?: ConnectorDeps } = {}): Promise<TrendSummary> {
  running ??= doRun(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doRun(opts: { now?: Date; deps?: ConnectorDeps }): Promise<TrendSummary> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? defaultDeps();
  const db = await readDb();
  const today = toDateKey(now);
  const summary: TrendSummary = { at: now.toISOString(), added: 0, notes: [] };
  const found: Array<{ brandId: string; items: Found[] }> = [];

  for (const brand of db.brands) {
    const items: Found[] = climateDays(brand, today);
    const sources: Array<[string, () => Promise<Found[]>]> = [
      ["Google Trends", () => googleTrends(brand, deps)],
      ["Google News", () => googleNews(brand, deps, now)],
      ["YouTube", () => youtubeTrends(brand, brandEnv(brand, db, deps.env), deps, now)],
    ];
    for (const [name, fn] of sources) {
      try {
        items.push(...(await fn()));
      } catch (err) {
        summary.notes.push(`${brand.name}: ${name} unavailable (${(err as Error).message}).`);
        log.warn("Trend source failed", { source: name, error: (err as Error).message });
      }
    }
    found.push({ brandId: brand.id, items });
  }

  await mutate((d) => {
    // Forget old items: news after 14 days, past climate days, anything after 60 days.
    const cutoff = now.getTime() - 14 * 86_400_000;
    d.trends = d.trends.filter((t) => {
      if (t.source === "climate-day") return t.date >= today || t.status !== "new";
      if (now.getTime() - Date.parse(t.foundAt) > 60 * 86_400_000) return false;
      return t.status !== "new" || Date.parse(t.foundAt) >= cutoff;
    });
    const seen = new Map(d.trends.map((t) => [keyOf(t), t]));
    for (const { brandId, items } of found) {
      for (const it of items) {
        const existing = seen.get(keyOf({ ...it, brandId }));
        if (existing) {
          // Keep the status; refresh the numbers (days left, views).
          existing.detail = it.detail;
          existing.score = it.score;
          continue;
        }
        const t: Trend = { ...it, id: newId("trend"), brandId, status: "new", foundAt: now.toISOString() };
        d.trends.push(t);
        seen.set(keyOf(t), t);
        summary.added++;
      }
    }
    d.settings.lastTrendScan = { ...summary, notes: summary.notes.slice(0, 10) };
  });
  log.info("Trend scan finished", { added: summary.added });
  return summary;
}
