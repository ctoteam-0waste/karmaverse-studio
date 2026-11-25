import type { AsoStat } from "../schemas";

/**
 * ASO: reads Google Play Console data with the Play sign-in
 * (scripts/google-connect.mjs --play → PLAY_REFRESH_TOKEN). All read-only.
 *
 * - Android vitals (Play Developer Reporting API): crash rate, ANR rate, users.
 * - Reviews and ratings (Play Android Developer API): reviews from the last week, star split.
 * - Installs, uninstalls, store visitors, conversion (Play's monthly report files in
 *   Cloud Storage), only when PLAY_REPORTS_BUCKET is set
 *   (Play Console → Download reports → Copy Cloud Storage URI).
 */

export type PlayEnv = { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; PLAY_REFRESH_TOKEN?: string; PLAY_PACKAGE?: string; PLAY_REPORTS_BUCKET?: string };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const playConfigured = (env: PlayEnv) => !!(env.PLAY_REFRESH_TOKEN?.trim() && env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
export const playPackage = (env: PlayEnv) => env.PLAY_PACKAGE?.trim() || "com.karmacredits.app";

async function token(env: PlayEnv, fetcher: Fetcher): Promise<string> {
  const r = await fetcher("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!.trim(), client_secret: env.GOOGLE_CLIENT_SECRET!.trim(), refresh_token: env.PLAY_REFRESH_TOKEN!.trim(), grant_type: "refresh_token" }) });
  const j = (await r.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!j.access_token) throw new Error(`Play sign-in failed: ${j.error_description ?? j.error ?? r.status}. Run: node scripts/google-connect.mjs data/google-oauth-client.json --play`);
  return j.access_token;
}

async function api<T>(fetcher: Fetcher, url: string, tok: string, body?: unknown): Promise<T> {
  const r = await fetcher(url, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) {
    const msg = j.error?.message ?? `HTTP ${r.status}`;
    throw new Error(/has not been used|is disabled/.test(msg) ? `${msg.split(".")[0]}. Enable it in Google Cloud (project of the Play sign-in).` : msg);
  }
  return j;
}

const ymd = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });

type MetricRow = { startTime?: { year: number; month: number; day: number }; metrics?: Array<{ metric: string; decimalValue?: { value: string } }> };

/** Average of a daily metric over the rows that have it, weighted by distinctUsers when present. */
export function weightedRate(rows: MetricRow[], metric: string): number | null {
  let num = 0, den = 0;
  for (const r of rows) {
    const get = (m: string) => Number(r.metrics?.find((x) => x.metric === m)?.decimalValue?.value ?? NaN);
    const v = get(metric), users = get("distinctUsers");
    if (!Number.isFinite(v)) continue;
    const w = Number.isFinite(users) && users > 0 ? users : 1;
    num += v * w;
    den += w;
  }
  return den ? num / den : null;
}

/** Play report CSVs are UTF-16LE with a BOM. */
export function decodeReport(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  return new TextDecoder("utf-8").decode(b);
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l: string) => {
    const out: string[] = [];
    let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const head = split(lines[0]!);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i] ?? `c${i}`, v])));
}

const num = (s: string | undefined) => (s === undefined || s === "" ? 0 : Number(s.replace(/[,%]/g, "")) || 0);
const col = (row: Record<string, string>, ...names: string[]) => {
  const k = Object.keys(row).find((key) => names.some((n) => key.toLowerCase() === n.toLowerCase()));
  return k ? row[k] : undefined;
};

/** Sums a month's daily installs overview rows that fall inside [from, to]. */
export function sumInstalls(rows: Array<Record<string, string>>, from: string, to: string) {
  const inRange = rows.filter((r) => { const d = col(r, "Date") ?? ""; return d >= from && d <= to; });
  const last = inRange.sort((a, b) => (col(a, "Date") ?? "").localeCompare(col(b, "Date") ?? "")).at(-1);
  return {
    installs: inRange.reduce((s, r) => s + num(col(r, "Daily User Installs", "Daily Device Installs")), 0),
    uninstalls: inRange.reduce((s, r) => s + num(col(r, "Daily User Uninstalls", "Daily Device Uninstalls")), 0),
    activeDevices: last ? num(col(last, "Active Device Installs")) : undefined,
    totalInstalls: last ? num(col(last, "Total User Installs")) : undefined,
  };
}

export function sumStore(rows: Array<Record<string, string>>, from: string, to: string) {
  const inRange = rows.filter((r) => { const d = col(r, "Date") ?? ""; return d >= from && d <= to; });
  const visitors = inRange.reduce((s, r) => s + num(col(r, "Store listing visitors")), 0);
  const acquisitions = inRange.reduce((s, r) => s + num(col(r, "Store listing acquisitions")), 0);
  return { visitors, acquisitions, conversion: visitors ? acquisitions / visitors : undefined };
}

async function bucketReports(env: PlayEnv, tok: string, fetcher: Fetcher, from: string, to: string, notes: string[]): Promise<Partial<AsoStat>> {
  const bucket = env.PLAY_REPORTS_BUCKET?.trim().replace(/^gs:\/\//, "").replace(/\/.*$/, "");
  if (!bucket) return {};
  const pkg = playPackage(env);
  const months = [...new Set([from.slice(0, 7), to.slice(0, 7)])].map((m) => m.replace("-", ""));
  const get = async (prefix: string) => {
    const rows: Array<Record<string, string>> = [];
    for (const m of months) {
      const name = `${prefix}_${pkg}_${m}_overview.csv`;
      const r = await fetcher(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
      if (r.status === 404) continue;
      if (!r.ok) throw new Error(`report ${name}: HTTP ${r.status}`);
      rows.push(...parseCsv(decodeReport(await r.arrayBuffer())));
    }
    return rows;
  };
  const out: Partial<AsoStat> = {};
  try {
    Object.assign(out, sumInstalls(await get("stats/installs/installs"), from, to));
  } catch (e) { notes.push(`Installs report: ${(e as Error).message}`); }
  try {
    const s = sumStore(await get("stats/store_performance/store_performance"), from, to);
    if (s.visitors || s.acquisitions) Object.assign(out, { storeVisitors: s.visitors, storeAcquisitions: s.acquisitions, conversion: s.conversion });
  } catch (e) { notes.push(`Store performance report: ${(e as Error).message}`); }
  try {
    const ratings = await get("stats/ratings/ratings");
    const last = ratings.sort((a, b) => (col(a, "Date") ?? "").localeCompare(col(b, "Date") ?? "")).at(-1);
    const v = last ? Number(col(last, "Total Average Rating")) : NaN;
    if (Number.isFinite(v) && v > 0) out.rating = v;
  } catch (e) { notes.push(`Ratings report: ${(e as Error).message}`); }
  return out;
}

/** Reads everything the Play sign-in allows for the last 28 days. Errors become notes. */
export async function readPlay(env: PlayEnv, opts: { fetcher?: Fetcher; now?: Date } = {}): Promise<{ data: Omit<AsoStat, "date" | "at"> | null; notes: string[] }> {
  if (!playConfigured(env)) return { data: null, notes: [] };
  const fetcher = opts.fetcher ?? fetch;
  const now = opts.now ?? new Date();
  const pkg = playPackage(env);
  const notes: string[] = [];
  const tok = await token(env, fetcher);
  // Vitals lag about 2 days.
  const end = new Date(now.getTime() - 2 * 86_400_000), start = new Date(end.getTime() - 27 * 86_400_000);
  const from = start.toISOString().slice(0, 10), to = end.toISOString().slice(0, 10);
  const data: Omit<AsoStat, "date" | "at"> = { packageName: pkg, from, to, reviews: [] };

  const spec = { timelineSpec: { aggregationPeriod: "DAILY", startTime: { ...ymd(start), timeZone: { id: "America/Los_Angeles" } }, endTime: { ...ymd(end), timeZone: { id: "America/Los_Angeles" } } } };
  try {
    const c = await api<{ rows?: MetricRow[] }>(fetcher, `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${pkg}/crashRateMetricSet:query`, tok, { ...spec, metrics: ["crashRate", "userPerceivedCrashRate", "distinctUsers"] });
    data.crashRate = weightedRate(c.rows ?? [], "crashRate");
    data.userPerceivedCrashRate = weightedRate(c.rows ?? [], "userPerceivedCrashRate");
    data.vitalsUsers = Math.round(weightedRate(c.rows ?? [], "distinctUsers") ?? 0) || null;
  } catch (e) { notes.push(`Crash rate: ${(e as Error).message}`); }
  try {
    const a = await api<{ rows?: MetricRow[] }>(fetcher, `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${pkg}/anrRateMetricSet:query`, tok, { ...spec, metrics: ["anrRate", "userPerceivedAnrRate", "distinctUsers"] });
    data.anrRate = weightedRate(a.rows ?? [], "anrRate");
    data.userPerceivedAnrRate = weightedRate(a.rows ?? [], "userPerceivedAnrRate");
  } catch (e) { notes.push(`ANR rate: ${(e as Error).message}`); }
  try {
    type Review = { reviewId: string; authorName?: string; comments?: Array<{ userComment?: { text?: string; starRating?: number; lastModified?: { seconds?: string }; appVersionName?: string } }> };
    const r = await api<{ reviews?: Review[] }>(fetcher, `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/reviews?maxResults=100`, tok);
    data.reviews = (r.reviews ?? []).map((x) => {
      const u = x.comments?.find((c) => c.userComment)?.userComment ?? {};
      return { id: x.reviewId, stars: u.starRating ?? 0, text: (u.text ?? "").trim().slice(0, 500), at: u.lastModified?.seconds ? new Date(Number(u.lastModified.seconds) * 1000).toISOString() : "", version: u.appVersionName ?? "" };
    });
  } catch (e) { notes.push(`Reviews: ${(e as Error).message}`); }
  if (env.PLAY_REPORTS_BUCKET?.trim()) Object.assign(data, await bucketReports(env, tok, fetcher, from, to, notes));
  else notes.push("Installs, store visitors and conversion need PLAY_REPORTS_BUCKET (Play Console → Download reports → Copy Cloud Storage URI).");
  return { data, notes };
}
