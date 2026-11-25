import { describe, expect, it } from "vitest";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import { buildSeed } from "@/lib/sample-data";
import { bestPostingTimes, classifyHook, diagnose, parseMetricsCsv, recommendExperiments, scorePosts, summarise } from "@/lib/analytics/engine";
import { primaryScore } from "@/lib/analytics/metrics";
import { applyEdit, generateCalendar, transition, TransitionError } from "@/lib/agents/calendar";
import { generateIdeas } from "@/lib/agents/strategy";
import type { ContentPiece } from "@/lib/schemas";
import { needsMedia } from "@/lib/agents/media-maker";

const seed = buildSeed();

describe("analytics engine", () => {
  it("uses platform-specific primary scores", () => {
    expect(primaryScore("instagram", "reel", { likes: 10, comments: 0, shares: 0, saves: 0, reach: 100 })).toBeCloseTo(0.1);
    expect(primaryScore("youtube", "short", { avgPercentViewed: 70 })).toBeCloseTo(0.7);
    expect(primaryScore("linkedin", "text-post", { reactions: 5, comments: 0, reposts: 0, clicks: 5, impressions: 100 })).toBeCloseTo(0.1);
    expect(primaryScore("instagram", "reel", { likes: 10 })).toBeNull();
  });

  it("only compares a post with earlier posts of the same platform and format", () => {
    const scored = scorePosts(seed.metrics);
    for (const s of scored.filter((x) => x.vsHistory)) {
      const peers = seed.metrics.filter((m) => m.platform === s.post.platform && m.format === s.post.format && m.postedAt < s.post.postedAt);
      expect(s.vsHistory!.priorCount).toBe(peers.length);
    }
    const groups = summarise(scored).map((g) => `${g.platform}/${g.format}`);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it("labels posting-time advice as an experiment when history is thin", () => {
    const times = bestPostingTimes(scorePosts(seed.metrics.filter((m) => m.platform === "facebook")));
    expect(times.every((t) => t.basis === "experiment")).toBe(true);
  });

  it("classifies hook styles", () => {
    expect(classifyHook("Myth or fact: plastic is always recycled")).toBe("myth-or-fact");
    expect(classifyHook("Stop throwing these in the bin")).toBe("warning");
    expect(classifyHook("3 swaps for a greener morning")).toBe("number-list");
    expect(classifyHook("Do you know where your charger goes?")).toBe("question");
  });

  it("diagnoses weak posts from evidence and refuses with too little data", () => {
    const scored = scorePosts(seed.metrics);
    const weakest = scored.filter((s) => s.post.platform === "instagram" && s.post.format === "reel").sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0]!;
    const d = diagnose(weakest, scored);
    expect(d.findings.length).toBeGreaterThan(0);
    const lonely = scorePosts(seed.metrics.slice(0, 2));
    expect(diagnose(lonely[0]!, lonely).findings[0]).toMatch(/need 3/);
  });

  it("recommends experiments sorted by impact per effort", () => {
    const exps = recommendExperiments(brand.id, scorePosts(seed.metrics));
    expect(exps.length).toBeGreaterThan(0);
    for (let i = 1; i < exps.length; i++) expect(exps[i - 1]!.impact / exps[i - 1]!.effort).toBeGreaterThanOrEqual(exps[i]!.impact / exps[i]!.effort);
  });

  it("imports CSV with validation, quoted commas and unknown-column warnings", () => {
    const csv = [
      "platform,format,postedAt,hook,pillarId,cta,url,reach,likes,comments,shares,saves,madeUp",
      'instagram,reel,2026-10-01T19:00:00+05:30,"Hook, with comma",myths,Save,,1000,50,5,5,10,7',
      "tiktok,video,2026-10-01,x,,,,1,1,1,1,1,1",
      "instagram,reel,not-a-date,x,,,,1,1,1,1,1,1",
    ].join("\n");
    const r = parseMetricsCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.hook).toBe("Hook, with comma");
    expect(r.rows[0]!.metrics).toEqual({ reach: 1000, likes: 50, comments: 5, shares: 5, saves: 10 });
    expect(r.errors).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes("madeUp"))).toBe(true);
  });
});

describe("calendar and approval workflow", () => {
  const ideas = generateIdeas(brand, { content: [], inbox: [], existingIdeas: [], today: "2026-10-26" });

  it("creates ~30 days of drafts with date, platform, pillar, format, topic, hook, status and target", () => {
    const items = generateCalendar(brand, ideas, seed.metrics, { startDate: "2026-10-26", days: 30 });
    expect(items.length).toBeGreaterThanOrEqual(40);
    const dates = items.map((i) => i.plannedDate!);
    expect(dates.every((d) => d >= "2026-10-26" && d <= "2026-11-24")).toBe(true);
    for (const i of items) {
      expect(i.status).toBe("draft");
      expect(i.targetMetric?.metric).toBeTruthy();
      expect(i.hook && i.topic && i.pillarId).toBeTruthy();
    }
    const reel = items.find((i) => i.platform === "instagram" && i.format === "reel")!;
    expect(reel.targetMetric!.target).toMatch(/median/);
    const fb = items.find((i) => i.platform === "facebook" && i.format === "reel")!;
    expect(fb.targetMetric!.target).toMatch(/baseline/i);
  });

  it("plans one post a day on every platform and keeps days that already have a post", () => {
    const week = generateCalendar(brand, ideas, [], { startDate: "2026-11-05", days: 7 });
    expect(week).toHaveLength(7 * brand.platforms.length);
    for (const platform of brand.platforms) {
      const days = week.filter((i) => i.platform === platform).map((i) => i.plannedDate);
      expect(new Set(days).size).toBe(7);
    }
    const existing = [{ brandId: brand.id, platform: "instagram" as const, plannedDate: "2026-11-06", isSample: false }];
    const kept = generateCalendar(brand, ideas, [], { startDate: "2026-11-05", days: 7, existing });
    expect(kept).toHaveLength(week.length - 1);
    expect(kept.some((i) => i.platform === "instagram" && i.plannedDate === "2026-11-06")).toBe(false);
    expect(kept.some((i) => i.format === "document-carousel")).toBe(false);
  });

  it("knows which posts need a video or slides made", () => {
    expect(needsMedia({ platform: "instagram", format: "reel", mediaUrls: [] })).toBe(true);
    expect(needsMedia({ platform: "facebook", format: "image-post", mediaUrls: [] })).toBe(true);
    expect(needsMedia({ platform: "instagram", format: "reel", mediaUrls: ["a.mp4"] })).toBe(false);
    expect(needsMedia({ platform: "linkedin", format: "text-post", mediaUrls: [] })).toBe(false);
    expect(needsMedia({ platform: "x", format: "image-post", mediaUrls: [] })).toBe(false);
  });

  it("refuses to build a calendar without ideas", () => {
    expect(() => generateCalendar(brand, [], [], { startDate: "2026-10-26" })).toThrow(/backlog is empty/);
  });

  const base = (): ContentPiece => ({
    ...generateCalendar(brand, ideas, [], { startDate: "2026-10-26", days: 1 })[0]!,
    caption: "Clean caption with no placeholders.",
    description: "",
  });
  const policy = { requireReview: true, approvers: ["Asha"], replyApprovers: [] };

  it("enforces draft → review → approved → scheduled → published", () => {
    let p = base();
    expect(() => transition(p, { to: "approved", actor: "Asha" }, policy, brand)).toThrow(TransitionError);
    p = transition(p, { to: "needs-review", actor: "Ravi" }, policy, brand);
    expect(() => transition(p, { to: "approved", actor: "Ravi" }, policy, brand)).toThrow(/not an approver/);
    p = transition(p, { to: "approved", actor: "asha" }, policy, brand);
    expect(p.approvedBy).toBe("asha");
    p = transition(p, { to: "scheduled", actor: "Ravi" }, policy, brand);
    expect(() => transition(p, { to: "published", actor: "Ravi" }, policy, brand)).toThrow(/live post URL/);
    p = transition(p, { to: "published", actor: "Ravi", publishedUrl: "https://instagram.com/p/x" }, policy, brand);
    expect(p.status).toBe("published");
    expect(p.history.map((h) => h.to)).toEqual(["draft", "needs-review", "approved", "scheduled", "published"]);
    expect(() => transition(p, { to: "draft", actor: "Ravi" }, policy, brand)).toThrow(/final/);
  });

  it("blocks approval while placeholders remain", () => {
    let p = { ...base(), caption: "Point 1 [CONFIRM: kg collected]" };
    p = transition(p, { to: "needs-review", actor: "Ravi" }, policy, brand);
    expect(() => transition(p, { to: "approved", actor: "Asha" }, policy, brand)).toThrow(/CONFIRM/);
  });

  it("sends edited approved content back to review", () => {
    let p = base();
    p = transition(p, { to: "needs-review", actor: "R" }, policy, brand);
    p = transition(p, { to: "approved", actor: "Asha" }, policy, brand);
    const edited = applyEdit(p, { caption: "New words" }, "Ravi");
    expect(edited.status).toBe("needs-review");
    expect(edited.approvedBy).toBeNull();
    const dateOnly = applyEdit(p, { plannedDate: "2026-10-30" }, "Ravi");
    expect(dateOnly.status).toBe("approved");
  });

  it("records failures with a reason and allows rescheduling", () => {
    let p = base();
    for (const to of ["needs-review", "approved", "scheduled"] as const) p = transition(p, { to, actor: "Asha" }, policy, brand);
    p = transition(p, { to: "failed", actor: "Asha", failureReason: "Upload error" }, policy, brand);
    expect(p.failureReason).toBe("Upload error");
    p = transition(p, { to: "scheduled", actor: "Asha" }, policy, brand);
    expect(p.failureReason).toBeNull();
  });
});

describe("post writer", () => {
  it("rewrites template drafts with Claude only in Claude mode, and asks for ready-to-post copy", async () => {
    const { READY_TO_POST, generateContent } = await import("@/lib/services/generation");
    let prompt = "";
    const client = { complete: async ({ user }: { user: string }) => ((prompt = user), JSON.stringify([{ platform: "instagram", format: "reel", hook: "Hi", caption: "Text" }])) };
    const ideas = generateIdeas(brand, { content: [], inbox: [], existingIdeas: [], today: "2026-10-26" });
    const r = await generateContent(brand, ideas[0]!, [{ platform: "instagram", format: "reel" }], "anthropic", client, { readyToPost: true });
    expect(r.generatedBy).toBe("anthropic");
    expect(prompt.endsWith(READY_TO_POST)).toBe(true);
    const { writerOn } = await import("@/lib/agents/media-maker");
    expect(writerOn({ settings: { ...seed.settings, generationMode: "template" } })).toBe(false);
  });
});
