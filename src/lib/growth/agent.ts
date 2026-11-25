import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Brand, Database, GrowthFix, LlmoResult, Trend } from "../schemas";
import { activeBrand, mutate, readDb } from "../db";
import { logger } from "../logger";
import { newId } from "../util";
import { git } from "../blog/agent";
import { marketingDir } from "../tracking/agent";
import { claudeClient, isClaudeConfigured, type LlmClient } from "../llm/anthropic";
import { runClaudeAgent } from "../llm/claude-cli";
import { parseJsonResult } from "../llm/json";
import { searchQueries, websiteToken, type SearchQuery, type WebsiteEnv } from "../website/google";

const log = logger("growth-agent");
const run = promisify(execFile);

/**
 * Growth agent: reads the SEO, LLMO and ASO results and prepares fixes for a
 * person to review. Nothing goes live on its own:
 * - Website (SEO + AI answers): Claude edits a copy of the karmaverse.earth
 *   code on a new GitHub branch. Someone merges it (and Netlify deploys).
 * - Play Store (ASO): a proposed title and descriptions to paste into Play Console.
 * - Content: searches where the sites show up but rank low, and questions AI
 *   assistants answer without mentioning KarmaVerse, become topics for the
 *   Blog Writer and for posts (Trends page).
 *
 * Content opportunities refresh daily; website and Play listing fixes weekly.
 */

const DAY = 86_400_000;
export const WEBSITE_EVERY_DAYS = Number(process.env.GROWTH_WEBSITE_EVERY_DAYS || 7);
export const ASO_EVERY_DAYS = Number(process.env.GROWTH_ASO_EVERY_DAYS || 7);

export function growthSiteDir(): string {
  return process.env.GROWTH_SITE_DIR?.trim().replace(/^"|"$/g, "") || "C:\\Users\\OM\\mrsnoopy14-3r_0";
}

export function growthDue(db: Pick<Database, "settings">, now = new Date()): boolean {
  if (process.env.GROWTH_AGENT === "off") return false;
  const last = db.settings.lastGrowthRun?.at;
  return !last || now.getTime() - Date.parse(last) >= DAY;
}

/** True when the newest fix of this kind is older than `days` (failed runs retry the next day). */
export function kindDue(fixes: Pick<GrowthFix, "kind" | "at" | "status">[], kind: GrowthFix["kind"], days: number, now = new Date()): boolean {
  const last = fixes.filter((f) => f.kind === kind).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!last) return true;
  const wait = last.status === "failed" ? 1 : days;
  return now.getTime() - Date.parse(last.at) >= wait * DAY - 60 * 60 * 1000;
}

/* ------------------------------------------------------------------ */
/* Content opportunities                                               */
/* ------------------------------------------------------------------ */

// Searches for the brands by name (incl. "3r", "3r company") are navigation, not blog topics.
const BRAND_QUERY = /karma\s?verse|karmacoin|karma coin|3r\s?zero|0waste|zerowaste|^3\s?r\b|\b3\s?r (com|company|waste|recycling)/i;

/** Searches where a site already appears but on page 1's bottom or page 2–4: one good article can win the clicks. */
export function searchOpportunities(rows: SearchQuery[]): Array<SearchQuery & { score: number }> {
  const best = new Map<string, SearchQuery>();
  for (const r of rows) {
    const q = r.query.trim().toLowerCase();
    if (!q || BRAND_QUERY.test(q) || r.impressions < 5 || r.position < 4 || r.position > 40) continue;
    const prev = best.get(q);
    if (!prev || r.impressions > prev.impressions) best.set(q, { ...r, query: q });
  }
  return [...best.values()]
    .map((r) => ({ ...r, score: Math.min(95, Math.round(50 + Math.log2(r.impressions) * 6 + (r.position <= 15 ? 10 : 0))) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
}

/** Category questions (not about the brand by name) where the AI answer didn't mention KarmaVerse. */
export function llmoGaps(results: LlmoResult[]): LlmoResult[] {
  const latest = new Map<string, LlmoResult>();
  for (const r of results) latest.set(r.promptId, r);
  return [...latest.values()].filter((r) => !/karma/i.test(r.prompt) && !r.mentioned);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export function opportunityTrends(brandId: string, rows: SearchQuery[], gaps: LlmoResult[], now = new Date()): Trend[] {
  const at = now.toISOString();
  const fromSearch: Trend[] = searchOpportunities(rows).map((o) => ({
    id: `search_${slug(o.query)}`,
    brandId,
    source: "search",
    title: `People search Google for “${o.query}”`,
    url: o.page,
    date: at.slice(0, 10),
    detail: `${o.site.replace(/^sc-domain:/, "")} shows up ${o.impressions} times a month at position ${o.position} (${o.clicks} clicks). Page 1 top 3 gets most clicks.`,
    score: o.score,
    angle: `A helpful, specific answer to “${o.query}”; link to ${o.page || "the most relevant page"}.`,
    status: "new",
    foundAt: at,
  }));
  const fromAi: Trend[] = gaps.map((g) => ({
    id: `search_ai_${slug(g.promptId)}`,
    brandId,
    source: "search",
    title: `AI assistants answer “${g.prompt}” without mentioning KarmaVerse`,
    url: "",
    date: at.slice(0, 10),
    detail: g.competitors.length ? `They name ${g.competitors.slice(0, 5).join(", ")} instead.` : "They name other apps or none.",
    score: 70,
    angle: `Answer the question honestly (other options included), and explain clearly where KarmaVerse by 3R ZeroWaste fits, so AI assistants and search engines learn it.`,
    status: "new",
    foundAt: at,
  }));
  return [...fromSearch, ...fromAi];
}

async function readSearch(now: Date): Promise<{ rows: SearchQuery[]; notes: string[] }> {
  const env = process.env as WebsiteEnv & Record<string, string | undefined>;
  const sites = (env.GROWTH_GSC_SITES ?? [env.GSC_SITE, "sc-domain:0waste.co.in"].filter(Boolean).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  if (!sites.length || !(env.GOOGLE_REFRESH_TOKEN || env.GOOGLE_SERVICE_ACCOUNT_FILE)) return { rows: [], notes: ["Search Console isn't connected, so search opportunities were skipped."] };
  const token = await websiteToken(env);
  const rows: SearchQuery[] = [];
  const notes: string[] = [];
  for (const s of [...new Set(sites)]) {
    try {
      rows.push(...(await searchQueries(s, token, fetch, now)));
    } catch (err) {
      notes.push(`Search Console ${s}: ${(err as Error).message}`);
    }
  }
  return { rows, notes };
}

/* ------------------------------------------------------------------ */
/* Website fixes (review branch)                                       */
/* ------------------------------------------------------------------ */

/** Files the agent may change on the website; anything else it touches is reverted. */
export const ALLOWED_FILE = /^(public\/(?!email\/|\.well-known\/)[\w\-/.]+\.(html|txt|xml|json)|scripts\/generate-seo-pages\.js|netlify\.toml)$/;

const read = (file: string, max: number): string => {
  try {
    const t = readFileSync(file, "utf8");
    return t.length > max ? `${t.slice(0, max)}\n…(cut)` : t;
  } catch {
    return "(not available)";
  }
};

export function websitePrompt(input: { brand: Brand; seoReport: string; brandReport: string; fixes: string; llmo: string; queries: string; today: string }): string {
  const facts = input.brand.facts.filter((f) => f.verified).map((f) => `- ${f.text}`).join("\n") || "- none";
  return `You are improving the public website karmaverse.earth (this folder is its code: an Expo web app on Netlify; static SEO pages are generated by scripts/generate-seo-pages.js; public/ holds index.html, llms.txt, robots.txt, sitemap.xml). Your changes go to a review branch; a person checks them before anything goes live.

Goal: more organic visitors from Google and correct answers from AI assistants (ChatGPT, Claude, Perplexity, Google AI Overviews) about KarmaVerse.

You may ONLY edit: files in public/ (html, txt, xml, json — not public/email or public/.well-known), scripts/generate-seo-pages.js and netlify.toml. Do not touch anything in src/. Keep every existing route and redirect working.

Brand rules (must follow):
- KarmaVerse by 3R ZeroWaste: a climate-action app from India that rewards everyday sustainable actions. Frame it as climate action, not as a doorstep scrap pickup service (pickups are one of the actions).
- KarmaCoins XP are in-app reward points, NOT a cryptocurrency, token, NFT or blockchain asset. On the web, "Karmaverse" is also the name of an unrelated crypto game (KNOT token, "Karmaverse Zombie"); help search engines and AI tell them apart by always saying "KarmaVerse by 3R ZeroWaste" and stating the not-crypto fact where relevant.
- Never invent numbers, awards, partners, users, reviews or claims like "India's first". Use only these verified facts:
${facts}
- No politics. Plain, warm English.

What the monitors found (most serious first):
${input.fixes}

SEO audit (latest):
${input.seoReport}

Brand consistency (sources disagree; prefer the verified facts above, and don't guess where unsure):
${input.brandReport}

AI answers test:
${input.llmo}

Google searches where the site shows (last 28 days):
${input.queries}

Do the most valuable, safe fixes you can complete well in this session, for example:
1. Technical SEO: canonical/sitemap consistency, real 404s, redirect chains, titles and meta descriptions (50–160 characters), <lastmod>, internal links to final URLs.
2. AI answers (LLMO): a clear llms.txt; an FAQ section or page with plain questions and answers ("What is KarmaVerse?", "Is KarmaCoins XP a cryptocurrency?", "How do I earn rewards for sustainable actions?") and matching FAQPage JSON-LD; Organization/SoftwareApplication JSON-LD with sameAs links that already exist on the site.
3. Content gaps for the searches above, only where an existing page can honestly answer them.
Check the file before editing. Keep changes small, correct and consistent. If something is already fixed, skip it.

When done, reply with ONLY this (no other text):
TITLE: <one line describing the change set>
- <change 1, in plain language for a non-technical reviewer>
- <change 2>
…`;
}

export function parseSummary(text: string): { title: string; lines: string[] } {
  const t = text.trim();
  const title = t.match(/^TITLE:\s*(.+)$/m)?.[1]?.trim() ?? "Website SEO and AI-answer fixes";
  const lines = t.split(/\r?\n/).filter((l) => /^\s*[-•*]\s+/.test(l)).map((l) => l.replace(/^\s*[-•*]\s+/, "").trim()).filter(Boolean).slice(0, 20);
  return { title, lines };
}

/** `git status --porcelain` lines (the first may have lost its leading space to trimming). */
export function parseStatus(out: string): Array<{ code: string; file: string }> {
  return out
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*(\S{1,2})\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ code: m[1]!, file: m[2]!.split(" -> ").pop()!.trim().replace(/^"|"$/g, "").replace(/\\/g, "/") }));
}

/** The GitHub page that opens a pull request for the branch. */
export function compareUrl(remote: string, branch: string): string | undefined {
  const m = remote.trim().match(/github\.com[/:]([^/]+)\/(.+?)(\.git)?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/main...${encodeURIComponent(branch)}?expand=1` : undefined;
}

async function isMerged(dir: string, ref: string): Promise<boolean> {
  try {
    await git(dir, ["merge-base", "--is-ancestor", ref, "origin/main"]);
    return true;
  } catch {
    return false;
  }
}

/** Newest agent branch not yet merged into main (so fixes build on each other), else main. */
async function baseRef(dir: string): Promise<string> {
  const refs = (await git(dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes/origin/growth", "refs/remotes/origin/seo-fixes"])).split(/\r?\n/).filter(Boolean);
  for (const r of refs) if (!(await isMerged(dir, r))) return r;
  return "origin/main";
}

async function websiteFix(db: Database, brand: Brand, today: string, queries: SearchQuery[], now: Date): Promise<GrowthFix> {
  const dir = growthSiteDir();
  const base: GrowthFix = { id: newId("growth"), kind: "website", date: today, at: now.toISOString(), status: "failed", title: "Website SEO and AI-answer fixes", summary: [], error: "" };
  if (!existsSync(path.join(dir, ".git"))) return { ...base, error: `Website code not found at ${dir} (set GROWTH_SITE_DIR).` };
  const branch = `growth/${today}`;
  const wt = path.join(tmpdir(), `kv-growth-${today}`);
  try {
    await git(dir, ["fetch", "origin", "--prune"]);
    const from = await baseRef(dir);
    if (existsSync(wt)) {
      await git(dir, ["worktree", "remove", "--force", wt]).catch(() => undefined);
      rmSync(wt, { recursive: true, force: true });
    }
    await git(dir, ["worktree", "prune"]);
    await git(dir, ["worktree", "add", "-B", branch, wt, from]);

    const mk = marketingDir();
    const last = db.tracking[db.tracking.length - 1];
    const fixes = (last?.fixes ?? []).map((f) => `- [${f.area} · ${f.severity}] ${f.title}${f.url ? ` (${f.url})` : ""} → ${f.action}`).join("\n") || "- (none listed)";
    const llmo = db.llmoResults.slice(-30).map((r) => `- ${r.platform}: "${r.prompt}" → ${r.mentioned ? (r.accurate ? "correct" : "confused with something else") : "not mentioned"}${r.competitors.length ? `; named ${r.competitors.join(", ")}` : ""}`).join("\n");
    const q = queries.filter((x) => /karmaverse/.test(x.site)).sort((a, b) => b.impressions - a.impressions).slice(0, 30).map((x) => `- "${x.query}" → ${x.page} · ${x.impressions} shown · position ${x.position} · ${x.clicks} clicks`).join("\n") || "- (no data)";
    const prompt = websitePrompt({ brand, seoReport: read(path.join(mk, "reports", "seo-audit-latest.md"), 9000), brandReport: read(path.join(mk, "reports", "brand-consistency-latest.md"), 6000), fixes, llmo, queries: q, today });
    const answer = await runClaudeAgent({ cwd: wt, prompt, timeoutMs: 25 * 60 * 1000 });
    const { title, lines } = parseSummary(answer);

    // Keep only allowed files.
    const changed: string[] = [];
    for (const { code, file } of parseStatus(await git(wt, ["status", "--porcelain", "-uall"]))) {
      if (ALLOWED_FILE.test(file)) changed.push(file);
      else if (code === "??") rmSync(path.join(wt, file), { force: true, recursive: true });
      else await git(wt, ["checkout", "--", file]);
    }
    if (!changed.length) return { ...base, status: "nothing", title: "No website changes needed this week", summary: lines };
    if (changed.includes("scripts/generate-seo-pages.js")) await run(process.execPath, ["--check", path.join(wt, "scripts", "generate-seo-pages.js")], { windowsHide: true });
    for (const f of changed) if (f.endsWith(".json")) JSON.parse(readFileSync(path.join(wt, f), "utf8"));

    await git(wt, ["add", "--", ...changed]);
    await git(wt, ["commit", "-m", `Growth agent: ${title}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n\nPrepared automatically by KarmaVerse Studio for review. Not deployed until merged.`]);
    if (process.env.GROWTH_PUSH !== "off") await git(wt, ["push", "-u", "origin", branch, "--force-with-lease"]);
    const remote = await git(dir, ["remote", "get-url", "origin"]);
    return { ...base, status: "ready", title, summary: lines, branch, files: changed, compareUrl: compareUrl(remote, branch) };
  } catch (err) {
    return { ...base, error: (err as Error).message.slice(0, 500) };
  } finally {
    await git(dir, ["worktree", "remove", "--force", wt]).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Play Store listing (ASO)                                            */
/* ------------------------------------------------------------------ */

export const AsoSchema = z.object({
  title: z.string().min(3).max(30),
  shortDescription: z.string().min(10).max(80),
  fullDescription: z.string().min(300).max(4000),
  keywords: z.array(z.string()).max(30).default([]),
  reasons: z.array(z.string()).max(12).default([]),
});

export function asoPrompt(brand: Brand, input: { listing: string; keywords: string; tracking: string; competitors: string; queries: string; llmo: string }): string {
  const facts = brand.facts.filter((f) => f.verified).map((f) => `- ${f.text}`).join("\n") || "- none";
  return `You are an App Store Optimisation expert for Google Play in India. Improve the Play Store listing of the KarmaVerse app (package com.karmacredits.app) to get found by more people searching Play and Google.

Rules (must follow):
- KarmaVerse by 3R ZeroWaste rewards everyday sustainable actions (climate action). KarmaCoins XP are in-app reward points, NOT crypto, tokens or NFTs. Say so clearly; "Karmaverse" is also an unrelated crypto game.
- Only these verified facts; never invent numbers, awards, user counts, ratings or "India's first/best":
${facts}
- Google Play policy: no keyword stuffing, no ALL CAPS, no emoji or "#1/best/free" in the title, no references to other apps' names, no calls to rate the app. Title max 30 characters, short description max 80, full description max 4000 (aim for 2,000–3,000; short paragraphs and a few "•" lists; keywords used naturally, the main ones 3–5 times).
- Climate-action framing, not a scrap-pickup service; pickups are one of the actions.

Current listing (as served):
${input.listing}

Keyword research file:
${input.keywords}

Keyword tracking:
${input.tracking}

Competitor listings:
${input.competitors}

Google searches that already reach our sites:
${input.queries}

AI answer gaps (questions where assistants don't mention KarmaVerse):
${input.llmo}

Reply with ONLY JSON:
{"title": "...", "shortDescription": "...", "fullDescription": "...", "keywords": ["main keywords targeted"], "reasons": ["why each main change should help, one line each"]}`;
}

async function asoFix(db: Database, brand: Brand, today: string, queries: SearchQuery[], client: LlmClient, now: Date): Promise<GrowthFix> {
  const mk = marketingDir();
  const base: GrowthFix = { id: newId("growth"), kind: "aso", date: today, at: now.toISOString(), status: "failed", title: "Play Store listing proposal", summary: [], error: "" };
  try {
    const prompt = asoPrompt(brand, {
      listing: read(path.join(mk, "reports", "aso-listing-latest.md"), 5000),
      keywords: read(path.join(mk, "aso", "keywords.yaml"), 7000),
      tracking: read(path.join(mk, "aso", "keyword-tracking.md"), 2000),
      competitors: read(path.join(mk, "aso", "competitor-snapshot.md"), 6000),
      queries: queries.sort((a, b) => b.impressions - a.impressions).slice(0, 25).map((x) => `- "${x.query}" (${x.impressions} shown, position ${x.position})`).join("\n") || "- (no data)",
      llmo: llmoGaps(db.llmoResults).map((g) => `- ${g.prompt}`).join("\n") || "- none",
    });
    const text = await client.complete({ system: "You are a careful ASO specialist. Reply with JSON only.", user: prompt, maxTokens: 4000 });
    const a = parseJsonResult(text, AsoSchema);
    if (/crypto|nft|blockchain/i.test(a.fullDescription) && !/not\s+(a\s+)?(crypto|cryptocurrency)/i.test(a.fullDescription)) throw new Error("The proposal mentions crypto without saying KarmaCoins XP are not crypto.");
    if (/india'?s first|#1|best app/i.test(`${a.title} ${a.shortDescription} ${a.fullDescription}`)) throw new Error("The proposal makes an unverified claim (first / #1 / best).");
    const file = path.join(mk, "aso", "listing-proposal-latest.md");
    try {
      writeFileSync(file, `# Play listing proposal (${today}, Growth agent — review before using)\n\n## Title (${a.title.length}/30)\n${a.title}\n\n## Short description (${a.shortDescription.length}/80)\n${a.shortDescription}\n\n## Full description (${a.fullDescription.length}/4000)\n${a.fullDescription}\n\n## Keywords targeted\n${a.keywords.join(", ")}\n\n## Why\n${a.reasons.map((r) => `- ${r}`).join("\n")}\n`);
    } catch {
      /* the studio copy is enough */
    }
    return { ...base, status: "ready", summary: a.reasons, aso: a };
  } catch (err) {
    return { ...base, error: (err as Error).message.slice(0, 500) };
  }
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

let running: Promise<string[]> | null = null;

export function runGrowthAgent(opts: { client?: LlmClient; force?: boolean; now?: Date; only?: GrowthFix["kind"] } = {}): Promise<string[]> {
  running ??= doRun(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doRun(opts: { client?: LlmClient; force?: boolean; now?: Date; only?: GrowthFix["kind"] }): Promise<string[]> {
  const now = opts.now ?? new Date();
  const today = new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const db = await readDb();
  const brand = activeBrand(db);
  const notes: string[] = [];
  await mutate((d) => {
    d.settings.lastGrowthRun = { at: now.toISOString(), notes: ["Running…"] };
  });

  // 1. Content opportunities (daily).
  let queries: SearchQuery[] = [];
  try {
    const s = await readSearch(now);
    queries = s.rows;
    notes.push(...s.notes);
  } catch (err) {
    notes.push(`Search Console: ${(err as Error).message}`);
  }
  const opps = opportunityTrends(brand.id, queries, llmoGaps(db.llmoResults), now);

  // 2. Merged branches.
  const dir = growthSiteDir();
  const merged = new Set<string>();
  for (const f of db.growthFixes.filter((x) => x.kind === "website" && x.status === "ready" && x.branch)) {
    try {
      if (await isMerged(dir, `origin/${f.branch}`)) merged.add(f.id);
    } catch {
      /* offline */
    }
  }

  const added: GrowthFix[] = [];
  const claudeOk = !!opts.client || isClaudeConfigured();
  // 3. Website fixes (weekly).
  if (claudeOk && opts.only !== "aso" && (opts.force || kindDue(db.growthFixes, "website", WEBSITE_EVERY_DAYS, now)) && process.env.GROWTH_WEBSITE !== "off") {
    const f = await websiteFix(db, brand, today, queries, now);
    added.push(f);
    notes.push(f.status === "ready" ? `Website: ${f.files?.length} file(s) changed on branch ${f.branch}, waiting for review.` : f.status === "nothing" ? "Website: nothing to change." : `Website fixes failed: ${f.error}`);
  }
  // 4. Play listing (weekly).
  if (claudeOk && opts.only !== "website" && (opts.force || kindDue(db.growthFixes, "aso", ASO_EVERY_DAYS, now))) {
    const f = await asoFix(db, brand, today, queries, opts.client ?? claudeClient(), now);
    added.push(f);
    notes.push(f.status === "ready" ? "Play listing: new proposal ready to review." : `Play listing proposal failed: ${f.error}`);
  }
  if (!claudeOk) notes.push("Claude isn't available, so only content opportunities were refreshed.");

  await mutate((d) => {
    for (const t of opps) {
      const prev = d.trends.find((x) => x.id === t.id);
      if (prev) Object.assign(prev, { ...t, status: prev.status, foundAt: prev.status === "new" ? t.foundAt : prev.foundAt });
      else d.trends.push(t);
    }
    for (const f of d.growthFixes) if (merged.has(f.id)) f.status = "merged";
    // A new website branch includes the earlier unmerged ones.
    if (added.some((a) => a.kind === "website" && a.status === "ready")) for (const f of d.growthFixes) if (f.kind === "website" && f.status === "ready") f.status = "dismissed";
    d.growthFixes.push(...added);
    d.settings.lastGrowthRun = { at: now.toISOString(), notes: [`${opps.length} content opportunities (searches and AI-answer gaps).`, ...notes] };
  });
  log.info("Growth agent finished", { opportunities: opps.length, fixes: added.map((a) => `${a.kind}:${a.status}`) });
  return notes;
}
