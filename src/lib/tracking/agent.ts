import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Database, LlmoResult, TrackingSnapshot } from "../schemas";
import { claudeClient, isClaudeConfigured, type LlmClient } from "../llm/anthropic";
import { mutate, readDb } from "../db";
import { logger } from "../logger";
import { nowIso, todayIst } from "../util";
import { frontMatter, siteDir } from "../blog/agent";

const run = promisify(execFile);
const log = logger("tracking");

/**
 * O. SEO / LLMO / ASO tracking (track + suggest; nothing on a live site changes).
 *
 * Once a day it runs the read-only monitoring toolkit on the Desktop
 * (seo,llmo,aso/marketing/run_all.py: SEO crawl of karmaverse.earth, brand-fact
 * scan, Play Store listing check, competitor snapshot, reports), then reads its
 * snapshots into a daily row so the Tracking page can show trends and a fix list.
 *
 * Once a week it runs the LLMO prompt set against Claude (through the
 * subscription, without web search) and records whether the answer mentions
 * KarmaVerse, in the toolkit's results.yaml (method "api") and here. Other
 * assistants (ChatGPT, Gemini, Perplexity...) stay NOT TESTED until someone
 * records them by hand.
 */

export const TRACK_EVERY_MS = 24 * 60 * 60 * 1000;
export const LLMO_EVERY_DAYS = 7;
export const TESTER = "KarmaVerse Studio (Claude via subscription, no web search)";

export function marketingDir(): string {
  return process.env.MARKETING_DIR?.trim().replace(/^"|"$/g, "") || "C:\\Users\\OM\\Desktop\\seo,llmo,aso\\marketing";
}

export function trackingDue(db: Pick<Database, "settings">, now = new Date()): boolean {
  if (process.env.TRACKING === "off") return false;
  const last = db.settings.lastTrackingRun?.at;
  return !last || now.getTime() - Date.parse(last) >= TRACK_EVERY_MS;
}

const python = () => process.env.PYTHON?.trim() || "python";

async function py(dir: string, args: string[], timeout = 15 * 60_000): Promise<string> {
  const r = await run(python(), args, { cwd: dir, windowsHide: true, timeout, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  return r.stdout;
}

async function latestJson<T>(dir: string, prefix: string): Promise<T | null> {
  if (!existsSync(dir)) return null;
  const f = (await readdir(dir)).filter((x) => x.startsWith(prefix) && x.endsWith(".json")).sort().pop();
  return f ? (JSON.parse(await readFile(path.join(dir, f), "utf8")) as T) : null;
}

/* ------------------------------------------------------------------ */
/* Reading the toolkit's snapshots                                     */
/* ------------------------------------------------------------------ */

interface SeoSnap {
  date: string;
  sites: Array<{ pages?: unknown[] }>;
  findings: Array<{ severity: string; url: string; issue: string; action: string; status: string }>;
  resolved?: unknown[];
}
interface AsoSnap {
  checks: Array<{ available?: boolean; jsonld_rating_value?: number | null; jsonld_rating_count?: number | null; installs?: string }>;
  deviations?: Array<{ field?: string; issue?: string; detail?: string }>;
}
interface BrandSnap {
  results: Record<string, { fact_id: string; scan_status: string; sources_disagree: boolean; distinct_values?: unknown[] }>;
}

const SEV_ORDER = ["Critical", "High", "Medium", "Low", "Info"];

export function summarise(seo: SeoSnap | null, aso: AsoSnap | null, brand: BrandSnap | null): Pick<TrackingSnapshot, "seo" | "aso" | "brand" | "fixes"> {
  const fixes: TrackingSnapshot["fixes"] = [];
  let seoRow: TrackingSnapshot["seo"] = null;
  if (seo) {
    const open = seo.findings.filter((f) => f.status !== "RESOLVED" && !/WONT_FIX|FALSE_POSITIVE|ACKNOWLEDGED/.test(f.status));
    const n = (s: string) => open.filter((f) => f.severity === s).length;
    seoRow = { critical: n("Critical"), high: n("High"), medium: n("Medium"), low: n("Low"), resolved: seo.resolved?.length ?? 0, pages: seo.sites.reduce((a, s) => a + (s.pages?.length ?? 0), 0) };
    // One fix per issue type (the same issue on many URLs is one job).
    const seen = new Set<string>();
    for (const f of [...open].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))) {
      if (seen.has(f.issue)) continue;
      seen.add(f.issue);
      fixes.push({ area: "SEO", severity: f.severity, title: f.issue, action: f.action, url: f.url });
    }
  }
  let asoRow: TrackingSnapshot["aso"] = null;
  if (aso) {
    const c = aso.checks[0] ?? {};
    asoRow = { available: aso.checks.some((x) => x.available), rating: c.jsonld_rating_value ?? null, installs: c.installs ?? "", reviews: c.jsonld_rating_count ?? null, findings: aso.deviations?.length ?? 0 };
    if (!asoRow.available) fixes.unshift({ area: "ASO", severity: "Critical", title: "Play Store listing not reachable", action: "Check the listing in Play Console.", url: "" });
    for (const d of aso.deviations ?? []) fixes.push({ area: "ASO", severity: "Medium", title: d.issue ?? d.field ?? "Listing differs from the approved baseline", action: d.detail ?? "Compare with aso/listing-baseline.md.", url: "" });
  }
  let brandRow: TrackingSnapshot["brand"] = null;
  if (brand) {
    const all = Object.values(brand.results);
    const conflicts = all.filter((r) => r.sources_disagree);
    brandRow = { conflicts: conflicts.length, findings: all.filter((r) => r.scan_status !== "OK" && r.scan_status !== "CONSISTENT").length };
    for (const r of conflicts.slice(0, 5))
      fixes.push({ area: "Brand", severity: "Medium", title: `Sources disagree on "${r.fact_id.replace(/_/g, " ")}"`, action: `Pick the correct value in brand/source-of-truth.yaml (${r.distinct_values?.length ?? 2} versions seen across the site, app and listing).`, url: "" });
  }
  return { seo: seoRow, aso: asoRow, brand: brandRow, fixes: fixes.slice(0, 15) };
}

export async function blogStats(dir = siteDir()): Promise<TrackingSnapshot["blog"]> {
  const blogDir = path.join(dir, "content", "blog");
  if (!existsSync(blogDir)) return null;
  const files = (await readdir(blogDir)).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  let drafts = 0;
  for (const f of files) if (/^true$/i.test(frontMatter(await readFile(path.join(blogDir, f), "utf8")).data.draft ?? "")) drafts++;
  return { posts: files.length - drafts, drafts };
}

/* ------------------------------------------------------------------ */
/* LLMO                                                                */
/* ------------------------------------------------------------------ */

export function parsePrompts(yaml: string): Array<{ id: string; prompt: string }> {
  return [...yaml.matchAll(/^\s*-\s*id:\s*(\S+)\s*\n\s*prompt:\s*(.+)$/gm)].map((m) => ({ id: m[1]!, prompt: m[2]!.trim().replace(/^["']|["']$/g, "") }));
}

const BRAND = /karma\s?verse|3r\s?zero\s?waste|karmacoin/i;
const CONFUSED = /\b(nfts?|crypto\w*|blockchain|metaverse|web3|token sale|play-to-earn)\b/i;
/** Marks of the real KarmaVerse: its company or its website. */
const OURS = /3\s?R\s?Zero\s?Waste|karmaverse\.earth|0waste\.co\.in/i;
/** The assistant only repeats the name from the question but says it doesn't know it. */
const UNKNOWN = /\b(don'?t|do not|doesn'?t) (have|know)( any)?( reliable| specific| verified| much)? (information|details|knowledge)|not (certain|sure) which|can'?t tell which|not familiar with|i'?m not aware of|no (reliable )?information (about|on)/i;
const KNOWN_COMPETITORS = ["Kabadiwalla Connect", "The Kabadiwala", "Scrapuncle", "Recykal", "Olio", "Meri LiFE", "Kabadiwalla", "ScrapBuddy", "Cashify", "Too Good To Go", "JouleBug", "Ecosia"];

export function judgeAnswer(answer: string): Pick<LlmoResult, "mentioned" | "accurate" | "excerpt" | "competitors" | "notes"> {
  const named = BRAND.test(answer);
  const idx = answer.search(BRAND);
  const excerpt = named ? answer.slice(Math.max(0, idx - 80), idx + 220).replace(/\s+/g, " ").trim() : "";
  // Repeating the name from the question while saying "I don't know it" is not a mention.
  const unknown = named && UNKNOWN.test(answer.slice(0, 600));
  const mentioned = named && !unknown;
  const confused = mentioned && CONFUSED.test(excerpt);
  // "Correct" means the answer is about the real KarmaVerse: it ties it to 3R ZeroWaste or
  // karmaverse.earth. (On the web, "Karmaverse" is also a crypto game, the KNOT token.)
  const ours = OURS.test(answer);
  const accurate = mentioned ? ours && !confused : null;
  return {
    mentioned,
    accurate,
    excerpt,
    competitors: KNOWN_COMPETITORS.filter((c) => answer.toLowerCase().includes(c.toLowerCase())),
    notes: unknown
      ? "Doesn't know KarmaVerse: says it has no reliable information (automatic check)."
      : confused || (mentioned && !ours)
        ? "Describes something else (e.g. the crypto game Karmaverse / KNOT token), not 3R ZeroWaste's KarmaVerse (automatic check; read the excerpt)."
        : "",
  };
}

export function llmoDue(results: LlmoResult[], today: string, platform = "claude"): boolean {
  const last = results.filter((r) => r.platform === platform).map((r) => r.date).sort().pop();
  return !last || (Date.parse(today) - Date.parse(last)) / 86_400_000 >= LLMO_EVERY_DAYS;
}

/** The two weekly tests: Claude from what it knows, and Claude with web search. */
export const LLMO_PLATFORMS = [
  { platform: "claude", webSearch: false, tester: TESTER },
  { platform: "claude_web", webSearch: true, tester: "KarmaVerse Studio (Claude via subscription, with web search)" },
] as const;

const OWN_SITES = /karmaverse\.earth|0waste\.co\.in/i;
const OWN_URL = /https?:\/\/[^\s)\]]*(karmaverse\.earth|0waste\.co\.in)[^\s)\]]*/i;

async function runLlmo(dir: string, client: LlmClient, today: string, platform: string, webSearch: boolean, tester: string): Promise<LlmoResult[]> {
  const prompts = parsePrompts(await readFile(path.join(dir, "llmo", "prompts.yaml"), "utf8"));
  const out: LlmoResult[] = [];
  for (const p of prompts) {
    let answer: string;
    try {
      answer = await client.complete({
        system: webSearch
          ? "You are a helpful assistant with web search. Search the web as you normally would, then answer the user's question for someone in India and list the URLs you used."
          : "You are a helpful assistant. Answer the user's question as you normally would for someone in India.",
        user: p.prompt,
        maxTokens: 1200,
        webSearch,
      });
    } catch (err) {
      log.warn("LLMO prompt failed", { id: p.id, error: (err as Error).message });
      continue;
    }
    const j = judgeAnswer(answer);
    const cited = webSearch && OWN_SITES.test(answer);
    const r: LlmoResult = { date: today, platform, promptId: p.id, prompt: p.prompt, ...j, ...(webSearch ? { cited } : {}) };
    out.push(r);
    // Also record it in the toolkit (append-only results.yaml) so its own report includes it.
    try {
      await py(dir, [
        "llmo/record_result.py", "--date", today, "--platform", platform, "--prompt-id", p.id,
        "--brand-mentioned", j.mentioned ? "yes" : "no", "--brand-description", j.excerpt.slice(0, 300) || "", "--citation-found", cited ? "yes" : "no",
        ...(cited ? ["--citation-source", answer.match(OWN_URL)?.[0] ?? "karmaverse.earth"] : []),
        "--competitors", j.competitors.join(", "), "--notes", j.notes || "Automatic weekly test.", "--method", "api", "--tester", tester,
      ], 60_000);
    } catch (err) {
      log.warn("Could not record LLMO result in the toolkit", { id: p.id, error: (err as Error).message.split("\n")[0] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

let running: Promise<string[]> | null = null;

export function runTracking(opts: { force?: boolean; client?: LlmClient; skipToolkit?: boolean } = {}): Promise<string[]> {
  running ??= doRun(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doRun(opts: { force?: boolean; client?: LlmClient; skipToolkit?: boolean }): Promise<string[]> {
  const db = await readDb();
  if (!opts.force && !trackingDue(db)) return [];
  const notes: string[] = [];
  const dir = marketingDir();
  const today = todayIst();
  // Mark the run first, so a slow crawl isn't started twice.
  await mutate((d) => {
    d.settings.lastTrackingRun = { at: nowIso(), notes: ["Running…"] };
  });
  let llmo: LlmoResult[] = [];
  if (!existsSync(path.join(dir, "run_all.py"))) {
    notes.push(`Monitoring toolkit not found at ${dir} (set MARKETING_DIR in .env.local).`);
  } else {
    if (!opts.skipToolkit) {
      try {
        const out = await py(dir, ["run_all.py"]);
        const summary = out.split("=== Summary ===")[1]?.trim().split(/\r?\n/).filter((l) => !/\bOK$/.test(l.trim())) ?? [];
        notes.push(summary.length ? `Checks finished with problems: ${summary.join("; ")}` : "All SEO / ASO / brand checks ran.");
      } catch (err) {
        // run_all exits 1 when any step failed; the snapshots that did run are still read below.
        const e = err as { stdout?: string; message: string };
        const summary = e.stdout?.split("=== Summary ===")[1]?.trim().split(/\r?\n/).filter((l) => !/\bOK$/.test(l.trim())) ?? [];
        notes.push(summary.length ? `Some checks failed: ${summary.join("; ")}` : `Checks failed: ${e.message.split("\n")[0]}`);
      }
    }
    for (const t of LLMO_PLATFORMS) {
      if (!llmoDue(db.llmoResults, today, t.platform) || !(opts.client || isClaudeConfigured())) continue;
      const got = await runLlmo(dir, opts.client ?? claudeClient(), today, t.platform, t.webSearch, t.tester);
      llmo.push(...got);
      notes.push(`AI-answer test${t.webSearch ? " with web search" : ""}: Claude described KarmaVerse correctly in ${got.filter((r) => r.mentioned && r.accurate !== false).length} of ${got.length} questions.`);
    }
  }
  const [seo, aso, brand, blog] = await Promise.all([
    latestJson<SeoSnap>(path.join(dir, "seo", "snapshots"), "seo-").catch(() => null),
    latestJson<AsoSnap>(path.join(dir, "aso", "snapshots"), "listing-").catch(() => null),
    latestJson<BrandSnap>(path.join(dir, "brand", "snapshots"), "brand-").catch(() => null),
    blogStats().catch(() => null),
  ]);
  const sum = summarise(seo, aso, brand);
  await mutate((d) => {
    d.llmoResults = [...d.llmoResults, ...llmo].slice(-1000);
    const latest = new Map<string, LlmoResult>();
    for (const r of d.llmoResults) latest.set(`${r.platform}|${r.promptId}`, r);
    const lr = [...latest.values()].filter((r) => r.platform === "claude");
    const web = [...latest.values()].filter((r) => r.platform === "claude_web");
    const snap: TrackingSnapshot = {
      date: today,
      at: nowIso(),
      ...sum,
      blog,
      llmo: lr.length ? { tested: lr.length, mentioned: lr.filter((r) => r.mentioned).length, accurate: lr.filter((r) => r.accurate).length } : null,
      llmoWeb: web.length ? { tested: web.length, mentioned: web.filter((r) => r.mentioned).length, accurate: web.filter((r) => r.accurate).length, cited: web.filter((r) => r.cited).length } : null,
    };
    d.tracking = [...d.tracking.filter((t) => t.date !== today), snap].slice(-400);
    d.settings.lastTrackingRun = { at: nowIso(), notes: notes.slice(0, 6) };
  });
  log.info("Tracking run finished", { notes });
  return notes;
}
