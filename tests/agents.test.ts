import { describe, expect, it } from "vitest";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import { generateIdeas, priorityScore, weeklyStrategy, observancesBetween, pillarCoverage } from "@/lib/agents/strategy";
import { generatePlatformVersion, lintContent } from "@/lib/agents/content";
import { generateVideoBrief, briefToMarkdown } from "@/lib/agents/video";
import { classifyComment, draftReply } from "@/lib/agents/community";
import { buildSeed } from "@/lib/sample-data";
import { DatabaseSchema, VideoBriefSchema } from "@/lib/schemas";

const idea = { title: "Myth or fact: e-waste is safe in the regular dustbin", angle: "Why chargers need separate handling", pillarId: "myths", audienceQuestion: "What do I do with dead chargers?" };

describe("strategy agent", () => {
  it("scores relevance above ease and stays within 0–100", () => {
    expect(priorityScore(5, 5, 1)).toBe(90);
    expect(priorityScore(1, 1, 5)).toBe(0);
    expect(priorityScore(5, 3, 3)).toBeGreaterThan(priorityScore(3, 3, 1));
    expect(priorityScore(5, 5, 1, 50)).toBe(100);
  });

  it("generates a deduplicated, sorted backlog covering every pillar", () => {
    const ideas = generateIdeas(brand, { content: [], inbox: [], existingIdeas: [], today: "2026-10-26" });
    expect(ideas.length).toBeGreaterThan(20);
    expect(new Set(ideas.map((i) => i.title)).size).toBe(ideas.length);
    for (const p of brand.pillars) expect(ideas.some((i) => i.pillarId === p.id)).toBe(true);
    for (let i = 1; i < ideas.length; i++) expect(ideas[i - 1]!.priority).toBeGreaterThanOrEqual(ideas[i]!.priority);
    const again = generateIdeas(brand, { content: [], inbox: [], existingIdeas: ideas, today: "2026-10-26" });
    expect(again).toHaveLength(0);
  });

  it("turns real audience questions into high-relevance ideas", () => {
    const seed = buildSeed();
    const ideas = generateIdeas(brand, { content: [], inbox: seed.inbox, existingIdeas: [], today: "2026-10-26" });
    const fromInbox = ideas.filter((i) => i.source === "inbox");
    expect(fromInbox.length).toBeGreaterThan(0);
    expect(fromInbox.every((i) => i.relevance === 5)).toBe(true);
  });

  it("fills a weekly plan without overusing one pillar", () => {
    const ideas = generateIdeas(brand, { content: [], inbox: [], existingIdeas: [], today: "2026-10-26" });
    const plan = weeklyStrategy(brand, ideas, "2026-10-26");
    expect(plan.slots).toHaveLength(10);
    const counts = new Map<string, number>();
    for (const s of plan.slots) counts.set(s.pillarId, (counts.get(s.pillarId) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
  });

  it("finds fixed-date observances and flags uncovered pillars as gaps", () => {
    expect(observancesBetween("2026-11-10", 7).map((o) => o.name)).toContain("Children's Day (India)");
    const cov = pillarCoverage(brand, [], "2026-10-01", "2026-10-31");
    expect(cov.every((c) => c.planned === 0)).toBe(true);
  });
});

describe("platform content agent", () => {
  it("adapts copy per platform instead of copying it", () => {
    const ig = generatePlatformVersion(brand, idea, "instagram", "reel");
    const li = generatePlatformVersion(brand, idea, "linkedin", "text-post");
    const yt = generatePlatformVersion(brand, idea, "youtube", "short");
    const fb = generatePlatformVersion(brand, idea, "facebook", "image-post");
    expect(new Set([ig.caption, li.caption, fb.caption]).size).toBe(3);
    expect(li.hashtags.length).toBeLessThanOrEqual(3);
    expect(ig.hashtags.length).toBeGreaterThanOrEqual(5);
    expect(yt.hashtags).toContain("#Shorts");
    expect(yt.hook.length).toBeLessThanOrEqual(60);
    expect(yt.description.length).toBeGreaterThan(0);
  });

  it("rejects formats a platform does not support", () => {
    expect(() => generatePlatformVersion(brand, idea, "youtube", "carousel")).toThrow(/not a supported format/);
  });

  it("never states unverified facts", () => {
    const unverified = brand.facts.filter((f) => !f.verified).map((f) => f.text);
    for (const platform of ["instagram", "linkedin", "facebook", "youtube"] as const) {
      const fmt = platform === "youtube" ? "long-video" : platform === "linkedin" ? "text-post" : platform === "instagram" ? "reel" : "image-post";
      const v = generatePlatformVersion(brand, { ...idea, pillarId: "product" }, platform, fmt);
      for (const f of unverified) expect(`${v.caption}${v.description}`).not.toContain(f);
    }
  });

  it("blocks approval-unsafe copy", () => {
    expect(lintContent(brand, "Guaranteed rewards for everyone!").some((w) => w.level === "warn")).toBe(true);
    expect(lintContent(brand, "We collected 500 kg").some((w) => /number/.test(w.message))).toBe(true);
    expect(lintContent(brand, "Point 1 [CONFIRM: number]").some((w) => w.level === "block")).toBe(true);
    expect(lintContent(brand, "Clean, simple copy.")).toHaveLength(0);
  });
});

describe("video director", () => {
  it("produces a valid brief whose timestamps are ordered and end at the duration", () => {
    for (const [format, duration] of [["reel", 30], ["long-video", 300], ["short", 45]] as const) {
      const b = generateVideoBrief(brand, idea, format === "long-video" || format === "short" ? "youtube" : "instagram", format, duration);
      expect(VideoBriefSchema.safeParse(b).success).toBe(true);
      expect(b.hooks).toHaveLength(3);
      expect(b.script[0]!.start).toBe(0);
      expect(b.script.at(-1)!.end).toBe(duration);
      for (let i = 1; i < b.script.length; i++) expect(b.script[i]!.start).toBe(b.script[i - 1]!.end);
      expect(b.storyboard).toHaveLength(b.script.length);
    }
  });

  it("exports markdown that says no video was rendered", () => {
    const md = briefToMarkdown(generateVideoBrief(brand, idea, "instagram", "reel"));
    expect(md).toContain("## Storyboard");
    expect(md).toContain("No video has been rendered");
  });
});

describe("community assistant", () => {
  const cases: Array<[string, string, boolean]> = [
    ["Loved this! Sharing with my building group 💚", "praise", false],
    ["How do I know if my society is covered?", "question", false],
    ["Booked a pickup 3 days ago and the agent never came", "support", true],
    ["Follow for follow! check my page www.spam.biz", "spam", false],
    ["This is fraud, I will go to consumer court", "escalation", true],
    ["You should add a Hindi version please", "feedback", false],
    ["Worst app, totally useless", "complaint", true],
    ["Kya schools bhi join kar sakte hain?", "question", false],
    ["How do I know if my society is covered for pickup?", "question", false],
    ["Where are my coins from last week?", "support", true],
  ];
  it.each(cases)("classifies %j as %s", (text, intent, needsHuman) => {
    const c = classifyComment(text);
    expect(c.intent).toBe(intent);
    expect(c.needsHuman).toBe(needsHuman);
  });

  it("never drafts a public reply to spam and asks support cases to DM without posting personal data", () => {
    const spam = classifyComment("crypto tips at www.x.biz follow for follow");
    expect(draftReply(brand, { author: "@x", text: "", classification: spam })).toBe("");
    const support = classifyComment("my coins are not credited");
    const reply = draftReply(brand, { author: "@vik.r", text: "", classification: support });
    expect(reply).toMatch(/DM/);
    expect(reply).toMatch(/not here in the comments/);
  });
});

describe("sample data", () => {
  it("is valid and every performance record is marked as sample", () => {
    const seed = buildSeed();
    expect(DatabaseSchema.safeParse(seed).success).toBe(true);
    expect(seed.metrics.every((m) => m.isSample)).toBe(true);
    expect(seed.inbox.every((m) => m.isSample)).toBe(true);
    expect(seed.experiments.every((m) => m.isSample)).toBe(true);
  });
});

describe("text clipping", () => {
  it("never cuts words in titles", async () => {
    const { clip } = await import("@/lib/util");
    expect(clip("Myth or fact: all plastic with a recycling symbol gets recycled", 40)).toBe("Myth or fact: all plastic with a");
    expect(clip("short", 40)).toBe("short");
    const b = generateVideoBrief(brand, { title: "Myth or fact: all plastic with a recycling symbol gets recycled", angle: "", pillarId: "myths", audienceQuestion: "" }, "instagram", "reel");
    for (const t of b.titleOptions) expect(t.length).toBeLessThanOrEqual(60);
    expect(b.script.map((l) => l.voiceover).join(" ")).not.toContain("available on Android");
  });
});
