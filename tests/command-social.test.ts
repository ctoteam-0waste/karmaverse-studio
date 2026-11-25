import { describe, expect, it } from "vitest";
import { buildSeed } from "@/lib/sample-data";
import { brandContext } from "@/lib/llm/prompts";
import { pickCharacter, characterAssets, CHARACTER_IDS } from "@/lib/video/characters";
import { socialFunnel, socialPlatformOf } from "@/lib/website/social";
import type { LlmClient } from "@/lib/llm/anthropic";
import type { ContentPiece, WebsiteStat } from "@/lib/schemas";

const fake = (answer: unknown): LlmClient => ({ complete: async () => JSON.stringify(answer) });

describe("Tell the team", () => {
  it("applies instructions, goals, settings and post edits, and undoes them", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { addCommand, runCommand, undoChange } = await import("@/lib/command/agent");
    const db = buildSeed();
    const brand = db.brands[0]!;
    const t = "2026-11-20T00:00:00.000Z";
    const scheduled: ContentPiece = {
      id: "post_sched", brandId: brand.id, ideaId: null, platform: "instagram", format: "reel", pillarId: brand.pillars[0]?.id ?? "habits",
      topic: "Reuse jars", hook: "Stop throwing jars away", caption: "Old caption", description: "", keywords: [], hashtags: [], cta: "", thumbnailConcept: "",
      mediaUrls: [], extraMedia: [], subtitles: "", slides: "", plannedDate: "2026-12-01", plannedTime: "19:00", targetMetric: null,
      status: "scheduled", approvedBy: "Asha", approvedAt: t, publishedUrl: null, failureReason: null, publishingStartedAt: null, externalId: null,
      hostedMedia: {}, generatedBy: "template", history: [], createdAt: t, updatedAt: t, isSample: false,
    };
    db.content = [scheduled];
    db.settings.autoPublish = false;
    await writeDbForTests(db);

    const cmd = await addCommand(brand.id, "More Hinglish, goal 500 followers, turn on auto-publish, Dadi in that reel", "Om");
    const done = await runCommand(cmd.id, fake({
      reply: "Done.",
      actions: [
        { type: "add_instruction", text: "Write Instagram captions in Hinglish." },
        { type: "add_goal", text: "Reach 500 Instagram followers by 2026-12-31" },
        { type: "set_auto_publish", on: true },
        { type: "edit_post", id: "post_sched", caption: "Naya caption", character: "dadi" },
        { type: "edit_post", id: "post_missing", caption: "x" },
      ],
    }));
    expect(done?.status).toBe("done");
    expect(done?.changes).toHaveLength(4);
    expect(done?.error).toMatch(/no post post_missing/);

    let after = await readDb();
    const b = after.brands[0]!;
    expect(b.instructions.map((i) => i.text)).toContain("Write Instagram captions in Hinglish.");
    expect(b.goals[0]?.text).toMatch(/500 Instagram followers/);
    expect(after.settings.autoPublish).toBe(true);
    // A changed caption on a scheduled post goes back to review: nothing new goes live unapproved.
    expect(after.content[0]).toMatchObject({ caption: "Naya caption", character: "dadi", status: "needs-review", approvedBy: null });
    expect(brandContext(b)).toMatch(/TEAM INSTRUCTIONS[\s\S]*Hinglish[\s\S]*GOALS THE TEAM WANTS[\s\S]*500/);

    for (const ch of done!.changes) await undoChange(cmd.id, ch.id);
    after = await readDb();
    expect(after.brands[0]!.instructions.every((i) => !i.active)).toBe(true);
    expect(after.settings.autoPublish).toBe(false);
    expect(after.content[0]).toMatchObject({ caption: scheduled.caption, status: "scheduled", approvedBy: "Asha" });
    expect(brandContext(after.brands[0]!)).not.toMatch(/TEAM INSTRUCTIONS/);
  });

  it("marks the command failed when Claude's answer can't be read", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { addCommand, runCommand } = await import("@/lib/command/agent");
    await writeDbForTests(buildSeed());
    const brand = (await readDb()).brands[0]!;
    const cmd = await addCommand(brand.id, "do something", "Om");
    await runCommand(cmd.id, { complete: async () => "not json" });
    expect((await readDb()).commands.at(-1)).toMatchObject({ status: "failed" });
  });
});

describe("video characters", () => {
  it("uses a chosen host, otherwise rotates with Earth Buddy about every third video", () => {
    expect(pickCharacter([], "dadi")).toBe("dadi");
    expect(pickCharacter(["chhotu", "pinky"], undefined, () => 0)).toBe("earth-buddy");
    const next = pickCharacter(["earth-buddy", "didi"], undefined, () => 0);
    expect(next).not.toBe("didi");
    expect(next).not.toBe("earth-buddy");
    expect(CHARACTER_IDS).toHaveLength(7);
  });

  it("finds the drawn mouth frames for the new characters", () => {
    const a = characterAssets("binny", "data/db.json", "data/brand/earth-buddy-mascot.jpeg");
    expect(a.frames).toHaveLength(3);
    expect(characterAssets("earth-buddy", "data/db.json", "m.jpeg")).toEqual({ mascot: "m.jpeg", frames: [] });
  });
});

describe("social funnel", () => {
  it("counts social visits by platform, including ones Analytics files as referrals", () => {
    expect(socialPlatformOf("m.facebook.com")).toBe("facebook");
    expect(socialPlatformOf("l.instagram.com")).toBe("instagram");
    expect(socialPlatformOf("google")).toBeNull();
    const web = {
      date: "2026-11-25", at: "", visitors: 100, newVisitors: 80, sessions: 200, pageViews: 500, engagementRate: 0.5, fromSocial: 3,
      sources: [
        { source: "m.facebook.com", medium: "referral", sessions: 4, visitors: 4 },
        { source: "instagram", medium: "social", sessions: 5, visitors: 5 },
        { source: "google", medium: "organic", sessions: 90, visitors: 50 },
      ],
      pages: [], posts: [{ contentId: "p1", source: "instagram", sessions: 3 }],
      channels: [{ channel: "Organic Social", sessions: 6, engaged: 4, users: 6 }, { channel: "Organic Search", sessions: 90, engaged: 60, users: 50 }],
      eventsByChannel: [{ name: "sign_up", channel: "Organic Social", count: 2 }, { name: "sign_up", channel: "Direct", count: 9 }],
      aiSources: [{ source: "chatgpt.com", sessions: 3, engaged: 3 }],
      search: { clicks: 50, impressions: 200, ctr: 0.25, position: 4, queries: [{ query: "karmaverse", clicks: 30, impressions: 60, position: 1 }, { query: "recycling app", clicks: 1, impressions: 40, position: 20 }] },
    } as unknown as WebsiteStat;
    const f = socialFunnel(web)!;
    expect(f.visits).toBe(9);
    expect(f.byPlatform.map((p) => p.platform)).toEqual(["instagram", "facebook"]);
    expect(f.actions.sign_up).toBe(2);
    expect(f.brandSearch).toEqual({ clicks: 30, impressions: 60 });
    expect(f.aiVisits).toBe(3);
    expect(f.byPost).toEqual([{ contentId: "p1", visits: 3 }]);
  });
});
