import type { Platform } from "../schemas";
import { call, igBase, json, type ConnectorDeps, type ConnectorEnv } from "../publishing/connectors";

/**
 * Account-level reach and clicks (last 28 days), read with the same tokens
 * the Metrics Agent already uses. These answer "how many people did we reach,
 * and how many clicked through", which per-post numbers can't: Instagram only
 * counts link clicks for the profile (bio link and website button).
 */

export const ACCOUNT_DAYS = 28;

export type AccountNumbers = {
  /** People (unique accounts) who saw any of your content. */
  reach?: number;
  /** Times your content was shown or played. */
  views?: number;
  /** Visits to the profile / Page. */
  profileViews?: number;
  /** Taps on the bio link, website button or post links. */
  linkClicks?: number;
  /** Accounts that liked, commented, shared, saved or replied. */
  engaged?: number;
  followers?: number;
};

export type AccountFetched = { numbers: AccountNumbers; notes: string[] };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

async function instagram(env: ConnectorEnv, deps: ConnectorDeps, now: Date): Promise<AccountFetched> {
  const { base, token } = igBase(env);
  const id = env.INSTAGRAM_ACCOUNT_ID!;
  const until = Math.floor(now.getTime() / 1000);
  const since = until - ACCOUNT_DAYS * 86_400;
  const out: AccountNumbers = {};
  const notes: string[] = [];
  const keys: Record<string, keyof AccountNumbers> = { reach: "reach", views: "views", profile_views: "profileViews", accounts_engaged: "engaged" };
  let clicks: number | undefined;
  // One metric per request, so one unsupported metric doesn't hide the rest.
  for (const m of [...Object.keys(keys), "website_clicks", "profile_links_taps"]) {
    try {
      const r = await call("instagram account insights", deps, `${base}/${id}/insights?metric=${m}&period=day&metric_type=total_value&since=${since}&until=${until}&access_token=${encodeURIComponent(token)}`, { method: "GET" }, { idempotent: true });
      const v = num((await json<{ data?: Array<{ total_value?: { value?: unknown } }> }>(r)).data?.[0]?.total_value?.value);
      if (v === undefined) continue;
      if (keys[m]) out[keys[m]!] = v;
      else clicks = (clicks ?? 0) + v;
    } catch (err) {
      notes.push(`Instagram ${m}: ${(err as Error).message}`);
    }
  }
  if (clicks !== undefined) out.linkClicks = clicks;
  try {
    const r = await call("instagram account", deps, `${base}/${id}?fields=followers_count&access_token=${encodeURIComponent(token)}`, { method: "GET" }, { idempotent: true });
    const f = num((await json<{ followers_count?: unknown }>(r)).followers_count);
    if (f !== undefined) out.followers = f;
  } catch (err) {
    notes.push(`Instagram followers: ${(err as Error).message}`);
  }
  return { numbers: out, notes };
}

async function facebook(env: ConnectorEnv, deps: ConnectorDeps): Promise<AccountFetched> {
  const base = `https://graph.facebook.com/${env.META_GRAPH_VERSION || "v24.0"}`;
  const token = encodeURIComponent(env.META_PAGE_ACCESS_TOKEN!);
  const out: AccountNumbers = {};
  const notes: string[] = [];
  const page = await json<{ id: string; followers_count?: number; fan_count?: number }>(await call("facebook page", deps, `${base}/me?fields=id,followers_count,fan_count&access_token=${token}`, { method: "GET" }, { idempotent: true }));
  const f = num(page.followers_count) ?? num(page.fan_count);
  if (f !== undefined) out.followers = f;
  // Meta replaced "impressions" with "media views" in late 2025.
  const keys: Record<string, keyof AccountNumbers> = { page_total_media_view_unique: "reach", page_media_view: "views", page_views_total: "profileViews", page_post_engagements: "engaged" };
  for (const [m, k] of Object.entries(keys)) {
    try {
      const r = await call("facebook page insights", deps, `${base}/${page.id}/insights?metric=${m}&period=days_28&access_token=${token}`, { method: "GET" }, { idempotent: true });
      const v = num((await json<{ data?: Array<{ values?: Array<{ value?: unknown }> }> }>(r)).data?.[0]?.values?.slice(-1)[0]?.value);
      if (v !== undefined) out[k] = v;
    } catch (err) {
      notes.push(`Facebook ${m}: ${(err as Error).message}`);
    }
  }
  return { numbers: out, notes };
}

async function youtube(env: ConnectorEnv, deps: ConnectorDeps): Promise<AccountFetched> {
  const tokenRes = await call("youtube token", deps, "https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: env.YOUTUBE_CLIENT_ID!, client_secret: env.YOUTUBE_CLIENT_SECRET!, refresh_token: env.YOUTUBE_REFRESH_TOKEN!, grant_type: "refresh_token" }) }, { idempotent: true });
  const { access_token } = await json<{ access_token: string }>(tokenRes);
  const r = await call("youtube channel", deps, "https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true", { method: "GET", headers: { Authorization: `Bearer ${access_token}` } }, { idempotent: true });
  const s = (await json<{ items?: Array<{ statistics?: Record<string, string> }> }>(r)).items?.[0]?.statistics;
  const out: AccountNumbers = {};
  const f = num(s?.subscriberCount);
  if (f !== undefined) out.followers = f;
  return { numbers: out, notes: ["YouTube reach and click-through rate for Shorts are only in YouTube Studio; views per video are counted from each post."] };
}

export const ACCOUNT_FETCHERS: Partial<Record<Platform, (env: ConnectorEnv, deps: ConnectorDeps, now: Date) => Promise<AccountFetched>>> = { instagram, facebook, youtube };

/** Link clicks ÷ people reached, or null when either is missing. */
export function clickRate(n: AccountNumbers): number | null {
  return n.reach && n.linkClicks !== undefined ? n.linkClicks / n.reach : null;
}
