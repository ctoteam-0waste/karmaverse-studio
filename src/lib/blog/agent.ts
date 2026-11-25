import { teamDirection } from "../llm/prompts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { BlogPost, Brand, Database, Trend } from "../schemas";
import { claudeClient, isClaudeConfigured, type LlmClient } from "../llm/anthropic";
import { mutate, readDb } from "../db";
import { logger } from "../logger";
import { newId, nowIso, todayIst } from "../util";

const run = promisify(execFile);
const log = logger("blog-writer");

/**
 * N. Blog Writer.
 *
 * Once a day, picks the best trend that has no article yet (a climate day a week
 * or more away, or a strong news story) and has Claude write an SEO article for
 * the 3R ZeroWaste website, following the website's own writing rules
 * (src/lib/admin/ai.ts in the website repo). The article is saved as a DRAFT in
 * content/blog and pushed to GitHub, so it shows up in the website's /admin to
 * review, add a cover image and publish. Nothing goes live on its own.
 */

export const BLOG_EVERY_MS = 24 * 60 * 60 * 1000;
export const CATEGORIES = ["ESG", "Circular Economy", "EPR", "Carbon & Net Zero", "KarmaVerse", "Community & Events"];

export function siteDir(): string {
  return process.env.BLOG_SITE_DIR?.trim().replace(/^"|"$/g, "") || "C:\\Users\\OM\\Downloads\\3r-zerowaste-website\\3r-zerowaste";
}

export function blogDue(db: Pick<Database, "settings">, now = new Date()): boolean {
  if (process.env.BLOG_WRITER === "off") return false;
  const last = db.settings.lastBlogRun?.at;
  return !last || now.getTime() - Date.parse(last) >= BLOG_EVERY_MS;
}

/* ------------------------------------------------------------------ */
/* Choosing a topic                                                    */
/* ------------------------------------------------------------------ */

/** Trends worth an article, best first: climate days 7-40 days away (time to rank), then strong news. */
export function blogCandidates(trends: Trend[], blogged: Set<string>, today: string): Trend[] {
  const days = (d: string) => Math.round((Date.parse(`${d.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  // Climate days first, then searches people already make (Growth agent), then news.
  const rank = (t: Trend) => (t.source === "climate-day" ? 100 + t.score : t.source === "search" ? 50 + t.score : t.score);
  return trends
    .filter((t) => !blogged.has(t.id) && t.status !== "dismissed")
    .filter((t) =>
      t.source === "climate-day" ? days(t.date) >= 7 && days(t.date) <= 40
      : t.source === "search" ? t.score >= 60 && t.status === "new" && Date.now() - Date.parse(t.foundAt) < 14 * 86_400_000
      : (t.source === "news" || t.source === "google-trends") && t.score >= 70 && Date.now() - Date.parse(t.foundAt) < 5 * 86_400_000,
    )
    .sort((a, b) => rank(b) - rank(a));
}

/* ------------------------------------------------------------------ */
/* Website context                                                     */
/* ------------------------------------------------------------------ */

export interface SiteContext {
  posts: Array<{ slug: string; title: string; category: string }>;
  pages: string;
  seoRules: string;
}

/** Simple front matter reader (key: value lines between --- fences). */
export function frontMatter(md: string): { data: Record<string, string>; body: string } {
  const m = md.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: md };
  const data: Record<string, string> = {};
  for (const l of m[1]!.split(/\r?\n/)) {
    const kv = l.match(/^([A-Za-z_]+):\s*(.*?)\s*(#.*)?$/);
    if (kv) data[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { data, body: m[2]! };
}

const FALLBACK_RULES = `SEO and engagement requirements:
- Title: 50–60 characters, focus keyword near the start. Summary 140–160 characters with the focus keyword. Slug 3–6 words with the focus keyword.
- Focus keyword in the first 100 words and at least one H2. ## H2 sections phrased the way people search; short paragraphs; lists and a table where useful.
- After the opening hook add "## Key takeaways" (3–5 bullets). End with "## Frequently asked questions" (3–5 ### questions), then a short call to action linking to /contact or /karmaverse.
- 2–4 internal links to the posts and pages listed. No external links unless an official government source you are certain of.`;

export async function readSite(dir = siteDir()): Promise<SiteContext> {
  const blogDir = path.join(dir, "content", "blog");
  const files = (await readdir(blogDir)).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  const posts = await Promise.all(
    files.map(async (f) => {
      const { data } = frontMatter(await readFile(path.join(blogDir, f), "utf8"));
      return { slug: f.replace(/\.md$/, ""), title: data.title ?? f, category: data.category ?? "" };
    }),
  );
  let seoRules = FALLBACK_RULES;
  let pages = "- /contact — Talk to the team\n- /karmaverse — KarmaVerse app";
  try {
    const ai = await readFile(path.join(dir, "src", "lib", "admin", "ai.ts"), "utf8");
    seoRules = ai.match(/const SEO_RULES = `([\s\S]*?)`;/)?.[1] ?? seoRules;
    const found = [...ai.matchAll(/\{\s*path:\s*"([^"]+)",\s*about:\s*"([^"]+)"\s*\}/g)].map((m) => `- ${m[1]} — ${m[2]}`);
    if (found.length) pages = found.join("\n");
  } catch {
    /* the rules file moved: use the fallback */
  }
  return { posts, pages, seoRules };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export function blogPrompt(brand: Brand, trend: Trend, site: SiteContext, today: string): string {
  const posts = site.posts.map((p) => `- /blog/${p.slug} — "${p.title}" (${p.category})`).join("\n") || "- (none yet)";
  const facts = brand.facts.filter((f) => f.verified).map((f) => `- ${f.text}`).join("\n");
  const about =
    trend.source === "climate-day"
      ? `An upcoming observance: ${trend.title} on ${trend.date}. ${trend.detail} Suggested angle: ${trend.angle}`
      : trend.source === "search"
        ? `A search opportunity found by the Growth agent: ${trend.title}. ${trend.detail} ${trend.angle} Make this phrase (or its closest natural wording) the focus keyword, and write the most genuinely helpful answer to what the searcher wants.`
        : `A news story trending in India this week: "${trend.title}" (${trend.detail.split(" · ")[0] ?? "news"}, ${trend.url}). Use ONLY what the headline says about the story itself; do not add numbers, names or quotes from it. Write an evergreen, practical article on the issue behind it.`;
  return `You are the content strategist and senior writer for 3R ZeroWaste (https://0waste.co.in), a Gurugram-based sustainability company: ESG and BRSR reporting, EPR compliance, circular economy and waste management, carbon and net-zero planning, and the KarmaVerse app that rewards people for sustainable actions. Readers are mostly Indian businesses (sustainability, compliance and CSR teams), housing societies, schools and eco-conscious individuals.

Voice: clear, practical, warm and confident. Plain English, short paragraphs, Indian context and examples. No hype, no filler, no politics or blame.

Accuracy matters more than anything — this is published under the company's name:
- Never invent statistics, survey results, quotes, client names, case-study results or dates.
- Only state rules, deadlines and figures you are confident are correct and current; otherwise describe them qualitatively or tell readers to check the official source.
- Never write [CONFIRM] or other bracketed placeholders.
Verified facts about KarmaVerse you may use:
${facts || "- none"}
${teamDirection(brand).length ? `\n${teamDirection(brand).join("\n")}\n` : ""}
Existing blog posts (link to the relevant ones; never duplicate their topic):
${posts}

Site pages you may link to:
${site.pages}

Blog categories: ${CATEGORIES.join(", ")}.

---

Write a complete, ready-to-review blog post (about 1,300 words) from this trend:

"""${about}"""

Choose the best focus keyword: the phrase people in India would actually search for. Today is ${today}.

${site.seoRules}

Reply with ONLY the post in this exact format (front matter, then the Markdown article), with nothing before or after it:

---
title: <title>
summary: <meta description>
slug: <slug>
category: <one of the blog categories>
focusKeyword: <focus keyword>
keywords: <4–8 related search phrases, comma separated>
---

<the full article in Markdown>`;
}

export interface Article {
  title: string;
  summary: string;
  slug: string;
  category: string;
  focusKeyword: string;
  keywords: string;
  body: string;
}

export function parseArticle(text: string): Article {
  const start = text.indexOf("---");
  if (start < 0) throw new Error("Claude's answer had no front matter.");
  const { data, body } = frontMatter(text.slice(start).trim() + "\n");
  const slug = (data.slug || data.title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
  const a: Article = {
    title: data.title ?? "",
    summary: data.summary ?? "",
    slug,
    category: CATEGORIES.includes(data.category ?? "") ? data.category! : "Circular Economy",
    focusKeyword: data.focusKeyword ?? "",
    keywords: data.keywords ?? "",
    body: body.trim(),
  };
  if (!a.title || !a.slug || a.body.split(/\s+/).length < 500) throw new Error("The article came back incomplete.");
  if (/\[(CONFIRM|TBD|TODO|insert)[^\]]*\]/i.test(a.body)) throw new Error("The article has placeholders.");
  return a;
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function toMarkdown(a: Article, date: string, cover: number): string {
  return [
    "---",
    `title: ${q(a.title)}`,
    `summary: ${q(a.summary)}`,
    `category: ${q(a.category)}`,
    `date: ${date}`,
    `author: "3R ZeroWaste Team"`,
    `focusKeyword: ${q(a.focusKeyword)}`,
    `keywords: ${q(a.keywords)}`,
    `cover: ${cover}`,
    "draft: true",
    "---",
    "",
    a.body,
    "",
  ].join("\n");
}

export async function git(dir: string, args: string[]): Promise<string> {
  const full = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe");
  const r = await run(existsSync(full) ? full : "git", ["-C", dir, ...args], { windowsHide: true, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return r.stdout.trim();
}

/** Saves the draft in the website repo and pushes just that file to GitHub. */
export async function saveDraft(a: Article, date: string, dir = siteDir(), push = process.env.BLOG_PUSH !== "off"): Promise<{ file: string; slug: string; pushed: boolean; note: string }> {
  const blogDir = path.join(dir, "content", "blog");
  let note = "";
  if (push) {
    try {
      await git(dir, ["pull", "--ff-only", "origin", "main"]);
    } catch (err) {
      note = `Could not update the website copy first (${(err as Error).message.split("\n")[0]}).`;
    }
  }
  let slug = a.slug;
  for (let n = 2; existsSync(path.join(blogDir, `${slug}.md`)); n++) slug = `${a.slug}-${n}`;
  const rel = `content/blog/${slug}.md`;
  const file = path.join(dir, rel);
  await writeFile(file, toMarkdown({ ...a, slug }, date, 1 + Math.floor(Math.random() * 4)), "utf8");
  if (!push) return { file, slug, pushed: false, note: "Saved locally (pushing is off)." };
  try {
    await git(dir, ["add", "--", rel]);
    await git(dir, ["commit", "-m", `Blog draft: ${a.title}`, "--", rel]);
    await git(dir, ["push", "origin", "HEAD:main"]);
    return { file, slug, pushed: true, note };
  } catch (err) {
    return { file, slug, pushed: false, note: `${note} Saved, but not pushed to GitHub: ${(err as Error).message.split("\n")[0]}`.trim() };
  }
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

let running: Promise<string[]> | null = null;

export function runBlogWriter(opts: { client?: LlmClient; force?: boolean } = {}): Promise<string[]> {
  running ??= doRun(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doRun(opts: { client?: LlmClient; force?: boolean }): Promise<string[]> {
  const db = await readDb();
  const notes: string[] = [];
  const finish = async () => {
    await mutate((d) => {
      d.settings.lastBlogRun = { at: nowIso(), notes: notes.slice(0, 6) };
    });
    return notes;
  };
  if (!opts.force && !blogDue(db)) return notes;
  if (!opts.client && !isClaudeConfigured()) {
    notes.push("Claude isn't available on this PC, so no article was written.");
    return finish();
  }
  if (!existsSync(path.join(siteDir(), "content", "blog"))) {
    notes.push(`Website folder not found: ${siteDir()} (set BLOG_SITE_DIR in .env.local).`);
    return finish();
  }
  const brand = db.brands.find((b) => b.id === db.settings.activeBrandId) ?? db.brands[0];
  if (!brand) return finish();
  const today = todayIst();
  const trend = blogCandidates(db.trends.filter((t) => t.brandId === brand.id), new Set(db.blogPosts.map((b) => b.trendId ?? "")), today)[0];
  if (!trend) {
    notes.push("No suitable trend for an article today.");
    return finish();
  }
  const entry: BlogPost = { id: newId("blog"), slug: "", title: trend.title, focusKeyword: "", category: "", trendId: trend.id, trendTitle: trend.title, words: 0, file: "", pushed: false, status: "failed", error: "", createdAt: nowIso() };
  try {
    const site = await readSite();
    const text = await (opts.client ?? claudeClient()).complete({ system: "You are a careful senior SEO writer. Follow the format exactly.", user: blogPrompt(brand, trend, site, today), maxTokens: 8000 });
    const a = parseArticle(text);
    const saved = await saveDraft(a, today);
    Object.assign(entry, { slug: saved.slug, title: a.title, focusKeyword: a.focusKeyword, category: a.category, words: a.body.split(/\s+/).length, file: saved.file, pushed: saved.pushed, status: "draft", error: saved.note });
    notes.push(`Drafted "${a.title}" (${entry.words} words)${saved.pushed ? ", now in the website's /admin to review" : ""}.`);
    if (saved.note) notes.push(saved.note);
    log.info("Blog draft written", { slug: saved.slug, pushed: saved.pushed, trend: trend.title });
  } catch (err) {
    entry.error = (err as Error).message.slice(0, 300);
    notes.push(`Could not write an article: ${entry.error}`);
    log.warn("Blog draft failed", { error: entry.error });
  }
  await mutate((d) => {
    d.blogPosts = [...d.blogPosts, entry].slice(-200);
  });
  return finish();
}
