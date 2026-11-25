import { describe, expect, it } from "vitest";
import { buildSeed } from "@/lib/sample-data";
import { ContentPieceSchema, DatabaseSchema } from "@/lib/schemas";
import { normHandle, parseHandles, teamEngagement } from "@/lib/team/engagement";
import { facebookObjectIds } from "@/lib/community/comments";

const NOW = new Date("2026-11-17T10:00:00Z");

function db() {
  const d = DatabaseSchema.parse(buildSeed());
  const brandId = d.brands[0]!.id;
  d.content = [];
  d.inbox = [];
  d.settings.teamMembers = [
    { name: "Anikait", handles: ["@anikaitbansal"] },
    { name: "Prerna", handles: ["@Prerana__Rout"] },
    { name: "Ayushi", handles: [] },
  ];
  const post = (id: string, at: string, approvedBy = "Ayushi Singh") =>
    ContentPieceSchema.parse({
      id, brandId, platform: "instagram", format: "reel", pillarId: "habits", topic: id, hook: `Hook ${id}`,
      status: "published", publishedUrl: `https://instagram.com/reel/${id}`, createdAt: at, updatedAt: at, isSample: false,
      history: [
        { at, from: "needs-review", to: "approved", by: approvedBy, note: "" },
        { at, from: "scheduled", to: "published", by: "publishing-agent", note: "" },
      ],
    });
  d.content.push(post("p1", "2026-11-16T09:00:00Z"), post("p2", "2026-11-10T09:00:00Z"), post("old", "2026-09-01T09:00:00Z"));
  const comment = (id: string, author: string, contentId: string, at = "2026-11-16T10:00:00Z") => ({
    id, brandId, platform: "instagram" as const, author, text: `hi from ${author}`, postRef: "", receivedAt: at,
    classification: { intent: "praise" as const, sentiment: "positive" as const, needsHuman: false, flags: [], reason: "" },
    suggestedReply: "", replyStatus: "drafted" as const, approvedBy: null, externalId: null, contentId,
    replyExternalId: null, replyError: null, replySendingAt: null, isSample: false,
  });
  d.inbox.push(
    comment("c1", "@anikaitbansal", "p1"),
    comment("c2", "anikaitbansal", "p1"),
    comment("c3", "@prerana__rout", "p2"),
    comment("c4", "@random_fan", "p1"),
  );
  return { d: DatabaseSchema.parse(d), brandId };
}

describe("team engagement", () => {
  it("matches comments to members by handle, ignoring @ and case", () => {
    const { d, brandId } = db();
    const t = teamEngagement(d, brandId, { days: 30, now: NOW });
    const by = Object.fromEntries(t.members.map((m) => [m.name, m]));
    expect(by.Anikait!.comments).toHaveLength(2);
    expect(by.Prerna!.comments).toHaveLength(1);
    expect(by.Ayushi!.comments).toHaveLength(0);
    expect(t.unmatchedAuthors).toEqual([{ author: "@random_fan", count: 1 }]);
  });

  it("builds the post x member grid for posts in the window only", () => {
    const { d, brandId } = db();
    const t = teamEngagement(d, brandId, { days: 30, now: NOW });
    expect(t.posts.map((p) => p.id)).toEqual(["p1", "p2"]);
    const p1 = t.posts.find((p) => p.id === "p1")!;
    expect(p1.byMember).toEqual({ Anikait: 2 });
    expect(p1.others).toBe(1);
    const anikait = t.members.find((m) => m.name === "Anikait")!;
    expect(anikait.postsEngaged).toBe(1);
    expect(anikait.coverage).toBeCloseTo(0.5);
  });

  it("counts approvals from post history by first name", () => {
    const { d, brandId } = db();
    const t = teamEngagement(d, brandId, { days: 30, now: NOW });
    const ayushi = t.members.find((m) => m.name === "Ayushi")!;
    expect(ayushi.approvals).toBe(2);
    expect(ayushi.lastActive).toBe("2026-11-16T09:00:00Z");
  });

  it("counts Facebook reactions per member by display name", () => {
    const { d, brandId } = db();
    d.settings.teamMembers[0]!.handles.push("Anikait Bansal");
    d.content.find((p) => p.id === "p1")!.reactors = [{ name: "Anikait Bansal", type: "like" }, { name: "Stranger", type: "love" }];
    const t = teamEngagement(d, brandId, { days: 30, now: NOW });
    expect(t.members.find((m) => m.name === "Anikait")!.likes).toBe(1);
    expect(t.posts.find((p) => p.id === "p1")!.likedBy).toEqual(["Anikait"]);
    expect(t.unmatchedAuthors.some((a) => a.author === "Stranger (Facebook like)")).toBe(true);
  });

  it("counts likes, shares and reposts the team logged, once per post", () => {
    const { d, brandId } = db();
    const at = "2026-11-16T12:00:00Z";
    d.content.find((p) => p.id === "p2")!.teamActions = [
      { name: "Ayushi", kind: "like", at }, { name: "Ayushi", kind: "share", at }, { name: "Ayushi", kind: "repost", at },
      { name: "Ayushi", kind: "like", at }, { name: "Nobody", kind: "like", at },
    ];
    const t = teamEngagement(d, brandId, { days: 30, now: NOW });
    const ayushi = t.members.find((m) => m.name === "Ayushi")!;
    expect([ayushi.likes, ayushi.shares, ayushi.reposts, ayushi.postsEngaged]).toEqual([1, 1, 1, 1]);
    const p2 = t.posts.find((p) => p.id === "p2")!;
    expect([p2.likedBy, p2.sharedBy, p2.repostedBy]).toEqual([["Ayushi"], ["Ayushi"], ["Ayushi"]]);
  });

  it("prefixes bare Facebook post ids with the Page id", () => {
    expect(facebookObjectIds("122109588777536075", "1425457437310575")).toEqual(["1425457437310575_122109588777536075", "122109588777536075"]);
    expect(facebookObjectIds("1425457437310575_1221", "1425457437310575")).toEqual(["1425457437310575_1221"]);
  });

  it("parses handle lists and normalises handles", () => {
    expect(parseHandles("@a, @b\n@c @d")).toEqual(["@a", "@b", "@c", "@d"]);
    expect(parseHandles("Akash Kumar, @akash.k")).toEqual(["Akash Kumar", "@akash.k"]);
    expect(normHandle(" @@Prerana__Rout ")).toBe("prerana__rout");
  });
});
