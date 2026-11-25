import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ContentPiece, WebsiteStat } from "../schemas";

/**
 * Website tracking: reads Google Analytics 4 (visitors, where they came from,
 * which social posts sent them) and Google Search Console (Google search
 * clicks and impressions) with one Google service account.
 *
 * Setup (once): create a service account in Google Cloud, enable the
 * "Google Analytics Data API" and "Google Search Console API", download its
 * JSON key, then
 * - GA4 Admin → Property access management → add the service account email as Viewer
 * - Search Console → Settings → Users and permissions → add it (Restricted is enough)
 * and set in .env.local:
 *   GOOGLE_SERVICE_ACCOUNT_FILE=C:\path\to\key.json
 *   GA4_PROPERTY_ID=123456789          (numeric property ID, not G-8Z7CRL6KKG)
 *   GSC_SITE=sc-domain:karmaverse.earth (or https://karmaverse.earth/)
 */

export const WEBSITE_DAYS = 28;

export type WebsiteEnv = {
  GOOGLE_SERVICE_ACCOUNT_FILE?: string;
  /** Alternative to a service account: a signed-in Google user (scripts/google-connect.mjs). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GA4_PROPERTY_ID?: string;
  GSC_SITE?: string;
};

const hasUser = (env: WebsiteEnv) => !!(env.GOOGLE_REFRESH_TOKEN?.trim() && env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());

export function websiteConfigured(env: WebsiteEnv): { ga4: boolean; gsc: boolean } {
  const key = !!env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim() || hasUser(env);
  return { ga4: key && !!env.GA4_PROPERTY_ID?.trim(), gsc: key && !!env.GSC_SITE?.trim() };
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Access token from a refresh token (signed-in user). */
export async function userToken(env: WebsiteEnv, fetcher: Fetcher = fetch): Promise<string> {
  const res = await fetcher("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!.trim(), client_secret: env.GOOGLE_CLIENT_SECRET!.trim(), refresh_token: env.GOOGLE_REFRESH_TOKEN!.trim(), grant_type: "refresh_token" }) });
  const j = (await res.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !j.access_token) throw new Error(`Google sign-in failed (${res.status}): ${j.error_description ?? j.error ?? "no token"}. Run: node scripts/google-connect.mjs`);
  return j.access_token;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Signs a service-account JWT and swaps it for an access token. */
export async function googleToken(keyFile: string, scopes: string[], fetcher: Fetcher = fetch, now = new Date()): Promise<string> {
  const key = JSON.parse(readFileSync(keyFile, "utf8")) as { client_email: string; private_key: string; token_uri?: string };
  const aud = key.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now.getTime() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: key.client_email, scope: scopes.join(" "), aud, iat, exp: iat + 3600 }))}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
  const res = await fetcher(aud, { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }) });
  const j = (await res.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !j.access_token) throw new Error(`Google sign-in failed (${res.status}): ${j.error_description ?? j.error ?? "no token"}`);
  return j.access_token;
}

async function post<T>(fetcher: Fetcher, url: string, token: string, body: unknown, label: string): Promise<T> {
  const res = await fetcher(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`${label} failed (${res.status}): ${j.error?.message ?? "unknown error"}`);
  return j;
}

type Ga4Report = { rows?: Array<{ dimensionValues?: Array<{ value: string }>; metricValues?: Array<{ value: string }> }> };

const n = (v: string | undefined) => (v === undefined || v === "" ? 0 : Number(v));
const SOCIAL = /instagram|facebook|fb|youtube|linkedin|lnkd|t\.co|twitter|x\.com|threads|whatsapp/i;

export type Ga4Data = Pick<WebsiteStat, "visitors" | "newVisitors" | "sessions" | "pageViews" | "engagementRate" | "fromSocial" | "sources" | "pages" | "posts" | "channels" | "daily" | "events" | "eventsByChannel" | "aiSources" | "outbound">;

/** Actions on the site that matter (sent by the KarmaVerse web app). */
export const KEY_EVENTS = ["sign_up", "login", "schedule_pickup", "pickup_completed", "reward_view", "reward_redeemed", "click", "file_download"];

export async function readGa4(propertyId: string, token: string, fetcher: Fetcher = fetch): Promise<Ga4Data> {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId.trim())}:batchRunReports`;
  const dateRanges = [{ startDate: `${WEBSITE_DAYS}daysAgo`, endDate: "today" }];
  const res = await post<{ reports?: Ga4Report[] }>(fetcher, url, token, {
    requests: [
      { dateRanges, metrics: [{ name: "activeUsers" }, { name: "newUsers" }, { name: "sessions" }, { name: "screenPageViews" }, { name: "engagementRate" }] },
      { dateRanges, dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }], metrics: [{ name: "sessions" }, { name: "activeUsers" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 25 },
      { dateRanges, dimensions: [{ name: "landingPage" }], metrics: [{ name: "sessions" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 10 },
      { dateRanges, dimensions: [{ name: "sessionManualAdContent" }, { name: "sessionSource" }], metrics: [{ name: "sessions" }], dimensionFilter: { filter: { fieldName: "sessionMedium", stringFilter: { value: "social" } } }, limit: 100 },
    ],
  }, "Google Analytics");
  const [totals, bySource, byPage, byPost] = res.reports ?? [];
  type Row = NonNullable<Ga4Report["rows"]>[number];
  const more = await post<{ reports?: Ga4Report[] }>(fetcher, url, token, {
    requests: [
      { dateRanges, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "totalUsers" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }] },
      { dateRanges, dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }], limit: 1000 },
      { dateRanges, dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 50 },
      { dateRanges, dimensions: [{ name: "eventName" }, { name: "sessionDefaultChannelGroup" }], metrics: [{ name: "eventCount" }], dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: KEY_EVENTS } } }, limit: 500 },
      { dateRanges, dimensions: [{ name: "sessionSource" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }], dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "AI Assistant" } } }, limit: 20 },
    ],
  }, "Google Analytics").catch(() => ({ reports: [] as Ga4Report[] }));
  const [byChannel, byDay, byEvent, eventChannel, bySourceAi] = more.reports ?? [];
  const outbound = await post<Ga4Report>(fetcher, url.replace(":batchRunReports", ":runReport"), token, { dateRanges, dimensions: [{ name: "linkUrl" }], metrics: [{ name: "eventCount" }], dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { value: "click" } } }, limit: 20 }, "Google Analytics").catch(() => ({ rows: [] as Row[] }));
  const dv = (r: Row, i: number) => r.dimensionValues?.[i]?.value ?? "";
  const mv = (r: Row, i: number) => n(r.metricValues?.[i]?.value);
  const isoDay = (d: string) => (d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);
  const t = totals?.rows?.[0]?.metricValues ?? [];
  const sources = (bySource?.rows ?? []).map((r) => ({ source: r.dimensionValues?.[0]?.value ?? "", medium: r.dimensionValues?.[1]?.value ?? "", sessions: n(r.metricValues?.[0]?.value), visitors: n(r.metricValues?.[1]?.value) }));
  return {
    visitors: n(t[0]?.value),
    newVisitors: n(t[1]?.value),
    sessions: n(t[2]?.value),
    pageViews: n(t[3]?.value),
    engagementRate: n(t[4]?.value),
    fromSocial: sources.filter((s) => s.medium === "social" || SOCIAL.test(s.source)).reduce((a, s) => a + s.sessions, 0),
    sources: sources.slice(0, 10),
    pages: (byPage?.rows ?? []).map((r) => ({ page: r.dimensionValues?.[0]?.value ?? "", sessions: n(r.metricValues?.[0]?.value) })),
    posts: (byPost?.rows ?? []).map((r) => ({ contentId: r.dimensionValues?.[0]?.value ?? "", source: r.dimensionValues?.[1]?.value ?? "", sessions: n(r.metricValues?.[0]?.value) })).filter((p) => p.contentId && p.contentId !== "(not set)"),
    channels: (byChannel?.rows ?? []).map((r) => ({ channel: dv(r, 0), sessions: mv(r, 0), engaged: mv(r, 1), users: mv(r, 2) })),
    daily: (byDay?.rows ?? []).map((r) => ({ date: isoDay(dv(r, 0)), channel: dv(r, 1), sessions: mv(r, 0), engaged: mv(r, 1) })).sort((a, b) => a.date.localeCompare(b.date)),
    events: (byEvent?.rows ?? []).map((r) => ({ name: dv(r, 0), count: mv(r, 0), users: mv(r, 1) })),
    eventsByChannel: (eventChannel?.rows ?? []).map((r) => ({ name: dv(r, 0), channel: dv(r, 1), count: mv(r, 0) })),
    aiSources: (bySourceAi?.rows ?? []).map((r) => ({ source: dv(r, 0), sessions: mv(r, 0), engaged: mv(r, 1) })),
    outbound: (outbound.rows ?? []).map((r) => ({ url: dv(r, 0), count: mv(r, 0) })).filter((o) => o.url),
  };
}

export type GscData = Pick<WebsiteStat, "search">;

export async function readGsc(site: string, token: string, fetcher: Fetcher = fetch, now = new Date()): Promise<GscData> {
  // Search Console data lags about 2 days.
  const end = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const start = new Date(now.getTime() - (WEBSITE_DAYS + 2) * 86_400_000).toISOString().slice(0, 10);
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.trim())}/searchAnalytics/query`;
  type Rows = { rows?: Array<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }> };
  const total = await post<Rows>(fetcher, url, token, { startDate: start, endDate: end }, "Search Console");
  const queries = await post<Rows>(fetcher, url, token, { startDate: start, endDate: end, dimensions: ["query"], rowLimit: 25 }, "Search Console");
  const daily = await post<Rows>(fetcher, url, token, { startDate: start, endDate: end, dimensions: ["date"], rowLimit: 100 }, "Search Console").catch((): Rows => ({ rows: [] }));
  const pages = await post<Rows>(fetcher, url, token, { startDate: start, endDate: end, dimensions: ["page"], rowLimit: 15 }, "Search Console").catch((): Rows => ({ rows: [] }));
  const t = total.rows?.[0];
  return {
    search: {
      clicks: t?.clicks ?? 0,
      impressions: t?.impressions ?? 0,
      ctr: t?.ctr ?? 0,
      position: t?.position ?? null,
      queries: (queries.rows ?? []).map((r) => ({ query: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 })),
      daily: (daily.rows ?? []).map((r) => ({ date: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions })).sort((a, b) => a.date.localeCompare(b.date)),
      pages: (pages.rows ?? []).map((r) => ({ page: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 })),
    },
  };
}

/** A Google access token for Analytics + Search Console (service account or signed-in user). */
export async function websiteToken(env: WebsiteEnv, fetcher: Fetcher = fetch, now = new Date()): Promise<string> {
  return env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim()
    ? googleToken(env.GOOGLE_SERVICE_ACCOUNT_FILE.trim(), ["https://www.googleapis.com/auth/analytics.readonly", "https://www.googleapis.com/auth/webmasters.readonly"], fetcher, now)
    : userToken(env, fetcher);
}

export type SearchQuery = { site: string; query: string; page: string; clicks: number; impressions: number; position: number };

/** Search queries with their best page (last 28 days), for finding content opportunities. */
export async function searchQueries(site: string, token: string, fetcher: Fetcher = fetch, now = new Date(), rows = 250): Promise<SearchQuery[]> {
  const end = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const start = new Date(now.getTime() - (WEBSITE_DAYS + 2) * 86_400_000).toISOString().slice(0, 10);
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.trim())}/searchAnalytics/query`;
  const r = await post<{ rows?: Array<{ keys?: string[]; clicks: number; impressions: number; position: number }> }>(fetcher, url, token, { startDate: start, endDate: end, dimensions: ["query", "page"], rowLimit: rows }, "Search Console");
  return (r.rows ?? []).map((x) => ({ site, query: x.keys?.[0] ?? "", page: x.keys?.[1] ?? "", clicks: x.clicks, impressions: x.impressions, position: Math.round(x.position * 10) / 10 }));
}

/** Reads whatever is configured. Errors become notes; nothing is guessed. */
export async function readWebsite(env: WebsiteEnv, opts: { fetcher?: Fetcher; now?: Date } = {}): Promise<{ data: Partial<WebsiteStat> | null; notes: string[] }> {
  const cfg = websiteConfigured(env);
  if (!cfg.ga4 && !cfg.gsc) return { data: null, notes: [] };
  const notes: string[] = [];
  const data: Partial<WebsiteStat> = {};
  let token: string;
  try {
    token = env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim() ? await googleToken(env.GOOGLE_SERVICE_ACCOUNT_FILE.trim(), ["https://www.googleapis.com/auth/analytics.readonly", "https://www.googleapis.com/auth/webmasters.readonly"], opts.fetcher, opts.now) : await userToken(env, opts.fetcher);
  } catch (err) {
    return { data: null, notes: [`Website tracking: ${(err as Error).message}`] };
  }
  if (cfg.ga4) {
    try {
      Object.assign(data, await readGa4(env.GA4_PROPERTY_ID!, token, opts.fetcher));
    } catch (err) {
      notes.push(`Google Analytics: ${(err as Error).message}${/permission|403/i.test((err as Error).message) ? " Add the service account email as Viewer in GA4 → Admin → Property access management." : ""}`);
    }
  }
  if (cfg.gsc) {
    try {
      Object.assign(data, await readGsc(env.GSC_SITE!, token, opts.fetcher, opts.now));
    } catch (err) {
      notes.push(`Search Console: ${(err as Error).message}${/permission|403/i.test((err as Error).message) ? " Add the service account email as a user in Search Console → Settings → Users and permissions." : ""}`);
    }
  }
  return { data: Object.keys(data).length ? data : null, notes };
}

/** Website visits per post (from utm_content), for the Results page. */
export function visitsByPost(stat: Pick<WebsiteStat, "posts"> | undefined, content: Pick<ContentPiece, "id">[]): Map<string, number> {
  const ids = new Set(content.map((c) => c.id));
  const out = new Map<string, number>();
  for (const p of stat?.posts ?? []) if (ids.has(p.contentId)) out.set(p.contentId, (out.get(p.contentId) ?? 0) + p.sessions);
  return out;
}
