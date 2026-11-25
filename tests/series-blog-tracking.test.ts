import { describe, expect, it } from "vitest";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import type { Trend } from "@/lib/schemas";
import { newsCandidates, parseScript, scenesFromScript, seriesFor, seriesPrompt, ROTATION } from "@/lib/video/series";
import { answerSchema, readStoredScript } from "@/lib/agents/series-writer";
import { parseJsonResult } from "@/lib/llm/json";
import { blogCandidates, blogPrompt, frontMatter, parseArticle, toMarkdown } from "@/lib/blog/agent";
import { judgeAnswer, llmoDue, parsePrompts, summarise } from "@/lib/tracking/agent";

const trend = (over: Partial<Trend>): Trend => ({
  id: "t1", brandId: brand.id, source: "news", title: "Delhi air quality severe again", url: "https://example.com/n", date: "2026-11-18T05:00:00.000Z",
  detail: "The Hindu · search: air pollution India", score: 80, angle: "", status: "new", foundAt: new Date().toISOString(), ...over,
});

describe("video series", () => {
  it("YouTube Shorts get the daily news; Instagram and Facebook rotate different series on the same day", () => {
    for (let d = 1; d <= 8; d++) {
      const date = `2026-11-${String(10 + d).padStart(2, "0")}`;
      expect(seriesFor({ platform: "youtube", format: "short", plannedDate: date })).toBe("news");
      const ig = seriesFor({ platform: "instagram", format: "reel", plannedDate: date });
      const fb = seriesFor({ platform: "facebook", format: "reel", plannedDate: date });
      expect(ROTATION).toContain(ig);
      expect(ig).not.toBe(fb);
    }
    // No fresh news: the Short gets another series instead.
    expect(seriesFor({ platform: "youtube", format: "short", plannedDate: "2026-11-20" }, false)).not.toBe("news");
    // Carousels, LinkedIn and long videos are not series videos.
    expect(seriesFor({ platform: "instagram", format: "carousel", plannedDate: "2026-11-20" })).toBeNull();
    expect(seriesFor({ platform: "youtube", format: "long-video", plannedDate: "2026-11-20" })).toBeNull();
  });

  it("only fresh, on-topic, unused news with a link is used", () => {
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const list = newsCandidates([trend({}), trend({ id: "t2", foundAt: old }), trend({ id: "t3", status: "used" }), trend({ id: "t4", source: "climate-day" }), trend({ id: "t5", score: 40 })], brand.id);
    expect(list.map((t) => t.id)).toEqual(["t1"]);
  });

  it("builds quiz scenes with a countdown hold and the answer reveal", () => {
    const s = scenesFromScript(brand, "quiz", { hook: "Only 1 in 10 get this right!", question: "Where does a greasy pizza box go?", options: ["Dry waste", "Wet waste", "Recycling"], answer: 1, explain: "Grease ruins paper recycling." });
    expect(s.map((x) => x.kind)).toEqual(["hook", "quiz", "answer", "cta"]);
    expect(s[1]!.hold).toBe(3);
    expect(s[1]!.say).toContain("A: Dry waste");
    expect(s[2]!.say).toContain("It's B, Wet waste");
  });

  it("builds news, myth and hack scenes", () => {
    expect(scenesFromScript(brand, "news", { headline: "Delhi AQI severe", source: "The Hindu", points: ["More coughs."], action: "Compost leaves.", question: "How is your air?" }, "2026-11-18").map((x) => x.kind)).toEqual(["headline", "point", "action", "question", "cta"]);
    expect(scenesFromScript(brand, "myth", { hook: "2 myths", pairs: [{ myth: "All plastic is recycled.", fact: "Most types are not." }] }).map((x) => x.kind)).toEqual(["hook", "myth", "fact", "cta"]);
    const hack = scenesFromScript(brand, "hack", { hook: "3 steps", steps: ["One thing.", "Two things."], payoff: "Done!" });
    expect(hack.map((x) => x.kind)).toEqual(["hook", "step", "step", "payoff", "cta"]);
    expect(hack[1]!.say).toBe("Step 1. One thing.");
  });

  it("reads Claude's answer and stores/reads the script", () => {
    const text = '```json\n{"hook":"Guess the bin!","caption":"Comment your answer 👇","hashtags":["#KarmaVerse"],"video":{"hook":"Only 1 in 10 get this right!","question":"Where does a greasy pizza box go?","options":["Dry","Wet","Recycling"],"answer":1,"explain":"Grease ruins recycling."}}\n```';
    const a = parseJsonResult(text, answerSchema("quiz"));
    expect(a.video).toMatchObject({ answer: 1 });
    const stored = readStoredScript({ series: "quiz", videoScript: JSON.stringify({ series: "quiz", script: a.video }) });
    expect(stored?.script).toMatchObject({ answer: 1 });
    expect(parseScript("quiz", JSON.stringify({ ...a.video, options: ["only one"] }))).toBeNull();
    expect(readStoredScript({ series: "quiz", videoScript: "not json" })).toBeNull();
  });

  it("the news prompt carries only the headline's facts and asks for the source credit", () => {
    const p = seriesPrompt(brand, { platform: "youtube", format: "short", topic: "x", hook: "", pillarId: "edu" }, "news", trend({}));
    expect(p).toContain("HEADLINE: Delhi air quality severe again");
    expect(p).toContain("LINK: https://example.com/n");
    expect(p).toContain("do credit the news source");
    expect(seriesPrompt(brand, { platform: "instagram", format: "reel", topic: "Saving water", hook: "", pillarId: "edu" }, "cartoon")).toContain("garmi (7 lines");
  });
});

describe("Blog Writer", () => {
  it("prefers climate days a week or more away, then strong recent news, and skips blogged trends", () => {
    const today = "2026-11-18";
    const list = blogCandidates(
      [
        trend({ id: "n1", score: 85 }),
        trend({ id: "d1", source: "climate-day", date: "2026-12-05", score: 90 }),
        trend({ id: "d2", source: "climate-day", date: "2026-11-20", score: 90 }), // too soon to rank
        trend({ id: "n2", score: 60 }), // too weak
        trend({ id: "n3", score: 95 }),
      ],
      new Set(["n3"]),
      today,
    );
    expect(list.map((t) => t.id)).toEqual(["d1", "n1"]);
  });

  it("parses the article and writes it as a draft with front matter", () => {
    const body = Array.from({ length: 600 }, () => "word").join(" ");
    const a = parseArticle(`Here you go\n---\ntitle: Composting at home: a guide\nsummary: How to compost.\nslug: Composting at Home Guide!\ncategory: Circular Economy\nfocusKeyword: composting at home\nkeywords: compost, wet waste\n---\n\n${body}`);
    expect(a.slug).toBe("composting-at-home-guide");
    const md = toMarkdown(a, "2026-11-18", 2);
    const fm = frontMatter(md);
    expect(fm.data).toMatchObject({ title: "Composting at home: a guide", draft: "true", category: "Circular Economy", date: "2026-11-18", cover: "2" });
    expect(() => parseArticle("---\ntitle: x\nslug: x\n---\nshort")).toThrow(/incomplete/);
    expect(() => parseArticle(`---\ntitle: x\nslug: x\n---\n${body} [CONFIRM: number]`)).toThrow(/placeholders/);
  });

  it("the prompt includes the site's existing posts and rules", () => {
    const p = blogPrompt(brand, trend({}), { posts: [{ slug: "brsr-core-explained", title: "BRSR Core", category: "ESG" }], pages: "- /contact — Contact", seoRules: "RULES HERE" }, "2026-11-18");
    expect(p).toContain("/blog/brsr-core-explained");
    expect(p).toContain("RULES HERE");
    expect(p).toContain("Use ONLY what the headline says");
  });
});

describe("Tracking", () => {
  it("summarises open SEO findings by severity and lists one fix per issue", () => {
    const s = summarise(
      {
        date: "2026-11-18",
        sites: [{ pages: [1, 2, 3] }],
        findings: [
          { severity: "High", url: "https://k/a", issue: "Canonical URL redirects", action: "Fix canonical", status: "OPEN" },
          { severity: "High", url: "https://k/b", issue: "Canonical URL redirects", action: "Fix canonical", status: "NEW" },
          { severity: "Low", url: "https://k/s", issue: "No lastmod", action: "Add lastmod", status: "OPEN" },
          { severity: "Critical", url: "https://k/c", issue: "Gone", action: "x", status: "RESOLVED" },
        ],
        resolved: [1],
      },
      { checks: [{ available: true, jsonld_rating_value: null }] },
      { results: { a: { fact_id: "contact_email", scan_status: "UNRESOLVED FACT", sources_disagree: true, distinct_values: [1, 2] } } },
    );
    expect(s.seo).toMatchObject({ critical: 0, high: 2, low: 1, resolved: 1, pages: 3 });
    expect(s.fixes.filter((f) => f.area === "SEO").map((f) => f.title)).toEqual(["Canonical URL redirects", "No lastmod"]);
    expect(s.aso?.available).toBe(true);
    expect(s.brand?.conflicts).toBe(1);
  });

  it("reads the LLMO prompt set and judges answers", () => {
    expect(parsePrompts("prompts:\n  - id: brand-what-is\n    prompt: What is KarmaVerse?\n    category: brand\n  - id: x\n    prompt: \"Other?\"\n")).toEqual([
      { id: "brand-what-is", prompt: "What is KarmaVerse?" },
      { id: "x", prompt: "Other?" },
    ]);
    expect(judgeAnswer("KarmaVerse is an Indian app by 3R ZeroWaste that rewards sustainable actions.")).toMatchObject({ mentioned: true, accurate: true });
    // The crypto game of the same name (seen with web search) is not ours, even without crypto words near the name.
    expect(judgeAnswer("KarmaVerse is the name of at least two different projects, both in gaming. Its first title is Karmaverse Zombie.")).toMatchObject({ mentioned: true, accurate: false });
    expect(judgeAnswer("KarmaVerse is an NFT metaverse project.")).toMatchObject({ mentioned: true, accurate: false });
    expect(judgeAnswer("Try Recykal or Olio.")).toMatchObject({ mentioned: false, accurate: null, competitors: ["Recykal", "Olio"] });
    // Real answers from the first run: the name only echoed from the question, or a different "KarmaCoin".
    expect(judgeAnswer(`I don't have reliable information about something called "KarmaVerse," so I'd rather not guess.`)).toMatchObject({ mentioned: false, accurate: null });
    expect(judgeAnswer("I'm not certain which KarmaVerse you mean, since the name is used by a few different things.")).toMatchObject({ mentioned: false });
    expect(judgeAnswer("KarmaCoin (also written Karma Coin) is a cryptocurrency project that aims to make digital money simple.")).toMatchObject({ mentioned: true, accurate: false });
    expect(llmoDue([], "2026-11-18")).toBe(true);
    expect(llmoDue([{ date: "2026-11-15", platform: "claude", promptId: "a", prompt: "", mentioned: false, accurate: null, excerpt: "", competitors: [], notes: "" }], "2026-11-18")).toBe(false);
  });
});
