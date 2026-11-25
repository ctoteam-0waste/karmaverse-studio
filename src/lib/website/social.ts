import type { WebsiteStat } from "../schemas";

/**
 * How many people social media sends onward: to the website (and what they do there),
 * to Google searches for the brand (SEO), to AI assistants (LLMO) and to the Play Store (ASO).
 *
 * Google Analytics files some social visits under "Referral" (e.g. m.facebook.com), so
 * platforms are read from the visit source too, and the larger of the two counts is used.
 */

export const SOCIAL_PLATFORMS = ["instagram", "facebook", "youtube", "linkedin", "x", "whatsapp"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

const SOURCE_PATTERNS: Array<[SocialPlatform, RegExp]> = [
  ["instagram", /(^|\.)instagram\.com$|^instagram$|^ig$/i],
  ["facebook", /(^|\.)facebook\.com$|^facebook$|^fb$|(^|\.)fb\.(com|me)$/i],
  ["youtube", /(^|\.)youtube\.com$|^youtube$|^youtu\.be$/i],
  ["linkedin", /(^|\.)linkedin\.com$|^linkedin$|^lnkd\.in$/i],
  ["x", /^t\.co$|(^|\.)twitter\.com$|^x\.com$|^x$|^twitter$/i],
  ["whatsapp", /whatsapp|^wa\.me$/i],
];

export function socialPlatformOf(source: string): SocialPlatform | null {
  const s = source.trim().toLowerCase();
  return SOURCE_PATTERNS.find(([, re]) => re.test(s))?.[0] ?? null;
}

const SOCIAL_CHANNELS = ["Organic Social", "Paid Social"];
const BRAND_QUERY = /karma\s?verse|karmacoin|3r\s?zero\s?waste/i;
export const SOCIAL_ACTIONS = ["sign_up", "login", "schedule_pickup", "pickup_completed", "reward_view", "reward_redeemed"] as const;

export interface SocialFunnel {
  /** Visits to the website that came from social media (last 28 days). */
  visits: number;
  /** Same, as a share of all website visits. */
  share: number;
  byPlatform: Array<{ platform: SocialPlatform; visits: number; people: number }>;
  /** Actions people from social took on the website (GA4 events by channel). */
  actions: Record<string, number>;
  /** Visits by tagged post (utm_content = post id). */
  byPost: Array<{ contentId: string; visits: number }>;
  /** Google searches for the brand name: the SEO side-effect of social awareness. */
  brandSearch: { clicks: number; impressions: number } | null;
  aiVisits: number;
  searchVisits: number;
  totalVisits: number;
  /** Clicks from the website to the Play Store. */
  playClicks: number;
}

export function socialFunnel(web: WebsiteStat | undefined): SocialFunnel | null {
  if (!web) return null;
  const per = new Map<SocialPlatform, { visits: number; people: number }>();
  for (const s of web.sources) {
    const p = socialPlatformOf(s.source) ?? (s.medium === "social" ? socialPlatformOf(s.source.split(".")[0] ?? "") : null);
    if (!p) continue;
    const cur = per.get(p) ?? { visits: 0, people: 0 };
    per.set(p, { visits: cur.visits + s.sessions, people: cur.people + s.visitors });
  }
  const fromSources = [...per.values()].reduce((a, b) => a + b.visits, 0);
  const channel = (name: string) => web.channels?.find((c) => c.channel === name)?.sessions ?? 0;
  const fromChannels = SOCIAL_CHANNELS.reduce((a, c) => a + channel(c), 0);
  const visits = Math.max(fromSources, fromChannels, web.fromSocial ?? 0);
  const totalVisits = web.sessions ?? 0;

  const actions: Record<string, number> = {};
  for (const e of web.eventsByChannel ?? []) {
    if (SOCIAL_CHANNELS.includes(e.channel) && (SOCIAL_ACTIONS as readonly string[]).includes(e.name)) actions[e.name] = (actions[e.name] ?? 0) + e.count;
  }

  const byPost = new Map<string, number>();
  for (const p of web.posts ?? []) byPost.set(p.contentId, (byPost.get(p.contentId) ?? 0) + p.sessions);

  const brandRows = (web.search?.queries ?? []).filter((q) => BRAND_QUERY.test(q.query));
  const brandSearch = web.search ? { clicks: brandRows.reduce((a, q) => a + q.clicks, 0), impressions: brandRows.reduce((a, q) => a + q.impressions, 0) } : null;

  return {
    visits,
    share: totalVisits ? visits / totalVisits : 0,
    byPlatform: [...per.entries()].map(([platform, v]) => ({ platform, ...v })).sort((a, b) => b.visits - a.visits),
    actions,
    byPost: [...byPost.entries()].map(([contentId, v]) => ({ contentId, visits: v })).sort((a, b) => b.visits - a.visits),
    brandSearch,
    aiVisits: (web.aiSources ?? []).reduce((a, s) => a + s.sessions, 0) || channel("AI Assistant"),
    searchVisits: channel("Organic Search"),
    totalVisits,
    playClicks: (web.outbound ?? []).filter((o) => /play\.google\.com/.test(o.url)).reduce((a, o) => a + o.count, 0),
  };
}

/** Change between the oldest and newest daily snapshot (each is a 28-day total), for trend arrows. */
export function funnelTrend(rows: WebsiteStat[]): { from: string; to: string; visits: number; brandClicks: number; aiVisits: number } | null {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return null;
  const a = socialFunnel(sorted[0]!)!;
  const b = socialFunnel(sorted.at(-1)!)!;
  return {
    from: sorted[0]!.date,
    to: sorted.at(-1)!.date,
    visits: b.visits - a.visits,
    brandClicks: (b.brandSearch?.clicks ?? 0) - (a.brandSearch?.clicks ?? 0),
    aiVisits: b.aiVisits - a.aiVisits,
  };
}
