import { describe, expect, it } from "vitest";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import { ALLOWED_FILE, AsoSchema, compareUrl, parseStatus, kindDue, llmoGaps, opportunityTrends, parseSummary, searchOpportunities, websitePrompt } from "@/lib/growth/agent";
import { blogCandidates, blogPrompt } from "@/lib/blog/agent";
import type { LlmoResult } from "@/lib/schemas";

const q = (query: string, impressions: number, position: number, site = "sc-domain:karmaverse.earth") => ({ site, query, page: "https://karmaverse.earth/", clicks: 0, impressions, position });
const llmo = (over: Partial<LlmoResult>): LlmoResult => ({ date: "2026-11-18", platform: "claude", promptId: "p", prompt: "What are recycling reward apps in India?", mentioned: false, accurate: null, excerpt: "", competitors: ["Recykal"], notes: "", ...over });

describe("Growth agent", () => {
  it("finds searches that rank too low to get clicks, skipping brand searches and noise", () => {
    const o = searchOpportunities([q("karma recycling", 9, 43.3), q("scrap pickup gurugram", 40, 18), q("karmaverse", 72, 1), q("waste app", 3, 10), q("e-waste recycling app", 20, 2.5), q("3r", 133, 6.6), q("3r company", 25, 5.8), q("3 r recycling", 7, 9.3),q("scrap pickup gurugram", 10, 30, "sc-domain:0waste.co.in")]);
    expect(o.map((x) => x.query)).toEqual(["scrap pickup gurugram"]);
    expect(o[0]!.impressions).toBe(40);
  });

  it("turns opportunities and AI-answer gaps into Trends the Blog Writer uses", () => {
    const now = new Date();
    const gaps = llmoGaps([llmo({ promptId: "a" }), llmo({ promptId: "b", prompt: "What is KarmaVerse?" }), llmo({ promptId: "c", mentioned: true, accurate: true })]);
    expect(gaps.map((g) => g.promptId)).toEqual(["a"]);
    const trends = opportunityTrends(brand.id, [q("scrap pickup gurugram", 40, 18)], gaps, now);
    expect(trends.map((t) => t.source)).toEqual(["search", "search"]);
    expect(trends[0]!.id).toBe("search_scrap-pickup-gurugram");
    const picked = blogCandidates(trends, new Set(), now.toISOString().slice(0, 10));
    expect(picked[0]!.id).toBe("search_scrap-pickup-gurugram");
    expect(blogPrompt(brand, picked[0]!, { posts: [], pages: "", seoRules: "" }, "2026-11-19")).toContain("search opportunity");
  });

  it("only lets the agent change public files, the SEO page generator and netlify.toml", () => {
    for (const f of ["public/index.html", "public/llms.txt", "public/faq/index.html", "public/sitemap.xml", "scripts/generate-seo-pages.js", "netlify.toml"]) expect(ALLOWED_FILE.test(f)).toBe(true);
    for (const f of ["src/App.tsx", "public/.well-known/assetlinks.json", "public/email/x.html", "package.json", "scripts/other.js", ".env"]) expect(ALLOWED_FILE.test(f)).toBe(false);
  });

  it("reads git status even when the first line lost its leading space", () => {
    expect(parseStatus("M public/index.html\n M netlify.toml\n?? public/faq/index.html\nR  a.txt -> public/b.txt")).toEqual([
      { code: "M", file: "public/index.html" },
      { code: "M", file: "netlify.toml" },
      { code: "??", file: "public/faq/index.html" },
      { code: "R", file: "public/b.txt" },
    ]);
  });

  it("reads Claude's summary and builds the GitHub review link", () => {
    expect(parseSummary("Done!\nTITLE: FAQ page and canonical fixes\n- Added an FAQ page\n- Fixed the blog canonical\n")).toEqual({ title: "FAQ page and canonical fixes", lines: ["Added an FAQ page", "Fixed the blog canonical"] });
    expect(compareUrl("https://github.com/ctoteam-0waste/mrsnoopy14-3r_0.git", "growth/2026-11-19")).toBe("https://github.com/ctoteam-0waste/mrsnoopy14-3r_0/compare/main...growth%2F2026-11-19?expand=1");
  });

  it("runs website and Play listing fixes weekly, retrying failures the next day", () => {
    const now = new Date("2026-11-19T10:00:00Z");
    expect(kindDue([], "website", 7, now)).toBe(true);
    expect(kindDue([{ kind: "website", at: "2026-11-15T10:00:00Z", status: "ready" }], "website", 7, now)).toBe(false);
    expect(kindDue([{ kind: "website", at: "2026-11-18T09:30:00Z", status: "failed" }], "website", 7, now)).toBe(true);
    expect(kindDue([{ kind: "aso", at: "2026-11-15T10:00:00Z", status: "ready" }], "website", 7, now)).toBe(true);
  });

  it("the website prompt carries the brand rules and the findings", () => {
    const p = websitePrompt({ brand, seoReport: "SEO", brandReport: "BRAND", fixes: "- [SEO · High] Soft 404", llmo: "- claude: x", queries: "- q", today: "2026-11-19" });
    expect(p).toContain("NOT a cryptocurrency");
    expect(p).toContain("Do not touch anything in src/");
    expect(p).toContain("Soft 404");
  });

  it("Play listing proposals must fit Google Play's limits", () => {
    expect(AsoSchema.safeParse({ title: "KarmaVerse: Climate Action Rewards", shortDescription: "x".repeat(20), fullDescription: "y".repeat(400) }).success).toBe(false);
    expect(AsoSchema.safeParse({ title: "KarmaVerse: Climate Rewards", shortDescription: "Earn reward points for everyday sustainable actions.", fullDescription: "y".repeat(400) }).success).toBe(true);
  });
});
