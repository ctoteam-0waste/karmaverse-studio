import { describe, expect, it } from "vitest";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import { authConfig, cleanName, codeMatches, safeNext, signSession, verifySession } from "@/lib/auth";
import { approveAndSchedule, isOverdue, sendBack } from "@/lib/agents/approval";
import { designFor } from "@/lib/carousel/maker";
import { bestStyle, pickLook, pickMusic, scriptFromPiece, speakable, statFrom, type Look } from "@/lib/video/buddy";
import { fmtWhen, pinComment } from "@/components/ui";
import { todayIst } from "@/lib/util";
import type { ContentPiece, PostMetric } from "@/lib/schemas";
import { adviceFor, normalise, platformResults, videoTuning } from "@/lib/analytics/advice";
import { forwardReason, liveLinks, questionFrom, shareMessage, statusText, teaserFrom } from "@/lib/agents/share";
import { FETCHERS } from "@/lib/metrics/sync";

function piece(over: Partial<ContentPiece> = {}): ContentPiece {
  const now = "2026-11-03T10:00:00.000Z";
  return {
    id: over.id ?? "post_test",
    brandId: brand.id,
    ideaId: null,
    platform: "facebook",
    format: "reel",
    pillarId: "habits",
    topic: "Test",
    hook: "We're in the news!",
    caption: "We're in the news!\n\n📈 15–20% growth every year since 2020\n♻️ 9,63,379 kg of waste diverted for resource recovery\n👥 18.5 lakh+ citizens engaged\n\nWhich number surprised you most? Comment below 👇\n\nRead the story: https://example.com/a",
    description: "",
    keywords: [],
    hashtags: ["#KarmaVerse"],
    cta: "Comment",
    thumbnailConcept: "",
    mediaUrls: [],
    extraMedia: [],
    subtitles: "",
    slides: "",
    hostedMedia: {},
    plannedDate: "2026-11-05",
    plannedTime: "19:00",
    targetMetric: null,
    status: "needs-review",
    approvedBy: null,
    approvedAt: null,
    publishedUrl: null,
    failureReason: null,
    publishingStartedAt: null,
    externalId: null,
    generatedBy: "manual",
    history: [],
    createdAt: now,
    updatedAt: now,
    isSample: false,
    ...over,
  };
}

const NOW = new Date("2026-11-04T06:00:00+05:30");

describe("team sign-in", () => {
  it("is off without TEAM_CODE and keyed by the code when on", () => {
    expect(authConfig({})).toBeNull();
    const a = authConfig({ TEAM_CODE: "4821", APP_SECRET: "s" })!;
    const b = authConfig({ TEAM_CODE: "9999", APP_SECRET: "s" })!;
    expect(a.code).toBe("4821");
    expect(verifySession(signSession("Ayushi", a.secret), b.secret)).toBeNull(); // changing the code signs everyone out
  });

  it("verifies signed names and rejects tampering", () => {
    const cookie = signSession("Ayushi", "k");
    expect(verifySession(cookie, "k")).toBe("Ayushi");
    expect(verifySession(cookie.replace(/^[^.]+/, Buffer.from("Gourav").toString("base64url")), "k")).toBeNull();
    expect(verifySession("garbage", "k")).toBeNull();
    expect(verifySession(undefined, "k")).toBeNull();
  });

  it("checks the code, names and redirect targets", () => {
    expect(codeMatches(" 4821 ", "4821")).toBe(true);
    expect(codeMatches("4822", "4821")).toBe(false);
    expect(cleanName("  Shiv   Rao ")).toBe("Shiv Rao");
    expect(cleanName("<script>")).toBe("");
    expect(cleanName("A")).toBe("");
    expect(safeNext("/approve?x=1")).toBe("/approve?x=1");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext("/login")).toBe("/");
  });
});

describe("one-tap approval", () => {
  it("approves and schedules a post with a future date", () => {
    const r = approveAndSchedule(piece(), "Ayushi", brand, NOW);
    expect(r.piece).toMatchObject({ status: "scheduled", approvedBy: "Ayushi" });
    expect(r.message).toMatch(/scheduled for Thu, 5 Nov/i);
    expect(r.piece.history.map((h) => h.to)).toEqual(["approved", "scheduled"]);
  });

  it("approves but does not schedule when the planned time has passed (no surprise posting)", () => {
    const r = approveAndSchedule(piece({ plannedDate: "2026-11-01" }), "Ayushi", brand, NOW);
    expect(r.piece.status).toBe("approved");
    expect(r.message).toMatch(/passed/);
    expect(isOverdue(piece({ plannedDate: "2026-11-01" }), NOW)).toBe(true);
  });

  it("approves without a date and schedules an already-approved post", () => {
    expect(approveAndSchedule(piece({ plannedDate: null }), "Ayushi", brand, NOW).piece.status).toBe("approved");
    const approved = approveAndSchedule(piece({ plannedDate: null }), "Ayushi", brand, NOW).piece;
    expect(approveAndSchedule({ ...approved, plannedDate: "2026-11-05" }, "Gourav", brand, NOW).piece.status).toBe("scheduled");
  });

  it("refuses posts that aren't waiting", () => {
    expect(() => approveAndSchedule(piece({ status: "published" }), "Ayushi", brand, NOW)).toThrow(/nothing to approve/);
  });

  it("sends posts back with the note", () => {
    const d = sendBack(piece(), "Ayushi", "Use the Hinglish video", brand);
    expect(d.status).toBe("draft");
    expect(d.history.at(-1)?.note).toBe("Sent back: Use the Hinglish video");
    const s = approveAndSchedule(piece(), "Ayushi", brand, NOW).piece;
    expect(sendBack(s, "Ayushi", "", brand).status).toBe("needs-review");
  });
});

describe("plain-language helpers", () => {
  it("labels planned times relative to today in IST", () => {
    expect(fmtWhen("2026-11-04", "19:00", NOW)).toBe("Today, 7:00 pm");
    expect(fmtWhen("2026-11-05", "09:30 (experiment)", NOW)).toBe("Tomorrow, 9:30 am");
    expect(fmtWhen("2026-11-03", null, NOW)).toBe("Yesterday, 9:00 am");
    expect(fmtWhen(null, null, NOW)).toBe("No date yet");
  });

  it("uses India's date just after midnight", () => {
    expect(todayIst(new Date("2026-11-03T19:30:00Z"))).toBe("2026-11-04");
  });

  it("finds the comment to pin", () => {
    expect(pinComment("FIRST COMMENT TO PIN: Which one? 👇")).toBe("Which one? 👇");
    expect(pinComment("notes")).toBe("");
  });
});

describe("Earth Buddy video script and looks", () => {
  it("writes numbers and symbols out for the voice", () => {
    expect(speakable("3R ZeroWaste grew 15–20% in 50+ cities 🌍")).toBe("Three R ZeroWaste grew 15 to 20 percent in 50 plus cities");
    expect(speakable("22,83,208 kg of CO₂ avoided #Climate")).toBe("22,83,208 kilos of C O two avoided");
  });

  it("turns stat lines into count-up scenes", () => {
    expect(statFrom("9,63,379 kg of waste diverted")).toEqual({ num: 963379, unit: "kg", cap: "waste diverted" });
    expect(statFrom("18.5 lakh+ citizens engaged")).toEqual({ num: 1850000, unit: "+", lakh: true, cap: "citizens engaged" });
    expect(statFrom("Book in a few taps")).toBeNull();
  });

  it("uses numbered lines as list points without eating decimals", () => {
    const s = scriptFromPiece(brand, piece({ hook: "3 easy habits", caption: "3 easy habits\n1. Carry a cloth bag\n2. Say no to straws\n3. Recycle old phones\nWhich one do you do?" }));
    expect(s.filter((x) => x.kind === "point").map((x) => x.text)).toEqual(["Carry a cloth bag", "Say no to straws", "Recycle old phones"]);
    expect(bestStyle(s, false)).toBe("list");
  });

  it("builds hook, points, question and call to action from a post", () => {
    const s = scriptFromPiece(brand, piece());
    expect(s[0]).toMatchObject({ kind: "hook", label: "IN THE NEWS" });
    expect(s.filter((x) => x.kind === "stat")).toHaveLength(2);
    expect(s.find((x) => x.kind === "question")?.text).toBe("Which number surprised you most?");
    expect(s.at(-1)?.kind).toBe("cta");
    expect(s.some((x) => /https?:|Read the story/.test(x.text))).toBe(false);
    expect(bestStyle(s, true)).toBe("cards");
  });

  it("picks a different look from recent videos", () => {
    const scenes = scriptFromPiece(brand, piece());
    const history: Look[] = [{ style: "cards", theme: "forest", layout: "left", music: "a" }];
    for (let i = 0; i < 20; i++) {
      const look = pickLook(history, "auto", scenes, ["a", "b"], true);
      expect(look.style).not.toBe("cards");
      expect(look.theme).not.toBe("forest");
      expect(look.layout).not.toBe("left");
      expect(look.music).toBe("b");
    }
    expect(pickLook(history, "cards", scenes, [], true).style).toBe("cards"); // an explicit choice is kept
  });

  it("avoids the styles of the last three videos", () => {
    const scenes = scriptFromPiece(brand, piece());
    const look = (style: Look["style"]): Look => ({ style, theme: "forest", layout: "left", music: "" });
    const history = [look("cards"), look("chat"), look("notes")];
    for (let i = 0; i < 20; i++) expect(["cards", "chat", "notes"]).not.toContain(pickLook(history, "auto", scenes, [], true).style);
  });

  it("picks music by mood and never repeats a recent track", () => {
    const tracks = [
      { file: "lofi1", mood: "lofi" }, { file: "lofi2", mood: "lofi" },
      { file: "play1", mood: "playful" }, { file: "up1", mood: "uplifting" }, { file: "corp1", mood: "corporate" },
    ];
    const look = (music: string): Look => ({ style: "cards", theme: "forest", layout: "left", music });
    expect(pickMusic(tracks, "chat", "small habits", [look("lofi1")])).toBe("lofi2");
    expect(pickMusic(tracks, "cards", "Myth or fact: plastic", [])).toBe("play1");
    expect(pickMusic(tracks, "cards", "We're in the news", [])).toBe("corp1");
    // Every lo-fi track used recently: falls back to another mood, not a repeat.
    expect(["lofi1", "lofi2"]).not.toContain(pickMusic(tracks, "notes", "habits", [look("lofi1"), look("lofi2")]));
    expect(pickMusic([], "chat", "x", [])).toBe("");
  });

  it("rotates carousel designs day by day", () => {
    const days = ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"].map(designFor);
    expect(new Set(days).size).toBe(4);
    expect(designFor("2026-11-09")).toBe(days[0]);
  });
});

describe("results, advice and sharing", () => {
  const metric = (platform: PostMetric["platform"], format: PostMetric["format"], m: Record<string, number>, contentId: string | null = null): PostMetric => ({ id: `m_${Math.random()}`, brandId: brand.id, contentId, platform, format, postedAt: "2026-11-03T10:00:00.000Z", hook: "Hook", pillarId: "", cta: "", url: "", metrics: m, source: "api", isSample: false, syncedAt: null });

  it("maps every platform's numbers onto views, likes, comments and shares", () => {
    expect(normalise({ views: 100, reactions: 5, comments: 2, avgWatchTimeSec: 14, durationSec: 28 })).toMatchObject({ views: 100, likes: 5, comments: 2, shares: 0, watch: 0.5 });
    expect(normalise({ impressions: 300, likes: 3, reposts: 1, replies: 2 })).toMatchObject({ views: 300, shares: 1, comments: 2 });
    expect(normalise({ avgPercentViewed: 72 }).watch).toBeCloseTo(0.72);
  });

  it("totals per platform and gives advice backed by the numbers", () => {
    const results = platformResults([metric("youtube", "short", { views: 25, likes: 4, comments: 0, avgPercentViewed: 31 }), metric("facebook", "reel", { views: 0, reactions: 0 })]);
    const yt = results.find((r) => r.platform === "youtube")!;
    expect(yt).toMatchObject({ posts: 1, views: 25, likes: 4 });
    const tips = adviceFor({ results, content: [], looks: [], autoRead: ["youtube", "facebook"], syncNotes: [] });
    const titles = tips.map((t) => t.title);
    expect(titles).toContain("Few people are seeing your YouTube posts");
    expect(titles).toContain("Viewers leave your videos early");
    expect(titles).toContain("No comments yet");
    expect(tips.find((t) => t.title.startsWith("Viewers leave"))!.why).toContain("31%");
  });

  it("makes videos shorter while viewers leave early", () => {
    expect(videoTuning([metric("youtube", "short", { avgPercentViewed: 31 })]).maxPoints).toBe(2);
    expect(videoTuning([metric("facebook", "reel", { avgWatchTimeSec: 14, durationSec: 28 })]).maxPoints).toBe(3);
    expect(videoTuning([]).maxPoints).toBe(4);
    expect(scriptFromPiece(brand, piece(), 2).filter((s) => s.kind === "stat" || s.kind === "point")).toHaveLength(2);
  });

  it("builds one WhatsApp message with every live link of the day", () => {
    const live = [
      piece({ id: "a", platform: "youtube", format: "short", status: "published", publishedUrl: "https://youtube.com/shorts/x", history: [{ at: "2026-11-04T12:30:00.000Z", from: "scheduled", to: "published", by: "agent", note: "" }] }),
      piece({ id: "b", platform: "facebook", format: "reel", status: "published", publishedUrl: "https://facebook.com/reel/1", history: [{ at: "2026-11-04T13:30:00.000Z", from: "scheduled", to: "published", by: "agent", note: "" }] }),
      piece({ id: "c", platform: "x", status: "published", publishedUrl: "https://x.com/s/1", history: [{ at: "2026-11-02T10:00:00.000Z", from: "scheduled", to: "published", by: "agent", note: "" }] }),
    ];
    const links = liveLinks(live, "2026-11-04");
    expect(links.map((l) => l.label)).toEqual(["Facebook Reel", "YouTube Short"]); // newest first
    const msg = shareMessage(links, { brand: "KarmaVerse", topic: "In the news", seed: 20261104 });
    expect(msg).toContain("https://youtube.com/shorts/x");
    expect(msg).toContain("https://facebook.com/reel/1");
    expect(msg).not.toContain("x.com");
    expect(statusText(links, "KarmaVerse").split("\n")).toHaveLength(3);
    expect(msg).toContain("Forward karo apne family group");
  });

  it("makes the WhatsApp message worth forwarding: hook, teaser, the post's question", () => {
    const caption = "We're in the news! 📰🌍\n\n📈 15–20% growth every year\n🏙️ 50+ cities\n(FY 2025–26)\n\nWhich number surprised you most? Comment below 👇\n\n#KarmaVerse #ClimateAction";
    // The first line only repeats the hook, so it's skipped.
    expect(teaserFrom(caption, "We're in the news! 📰")).toEqual(["📈 15–20% growth every year", "🏙️ 50+ cities"]);
    expect(questionFrom(caption)).toBe("Which number surprised you most?");
    expect(teaserFrom("If posting by hand: add a Link sticker", "x")).toEqual([]);
    const live = [piece({ id: "r", platform: "instagram", format: "reel", hook: "We're in the news! 📰", caption, status: "published", publishedUrl: "https://instagram.com/reel/1", history: [{ at: "2026-11-04T08:00:00.000Z", from: "scheduled", to: "published", by: "agent", note: "" }] })];
    const msg = shareMessage(liveLinks(live, "2026-11-04"), { brand: "KarmaVerse", topic: "In the news", seed: 1 });
    expect(msg.split("\n")[0]).toBe("*We're in the news! 📰* 👀");
    expect(msg).toContain("💬 Which number surprised you most? Comment mein batao!");
    expect(msg).not.toContain("#KarmaVerse");
    expect(forwardReason("Old AC or TV at home?")).toMatch(/purana AC/);
  });

  it("reads Facebook reel numbers by the reel's video id", async () => {
    const urls: string[] = [];
    const fetchFn = (async (u: string) => {
      urls.push(u);
      if (u.includes("/video_insights")) return new Response(JSON.stringify({ data: [{ name: "blue_reels_play_count", values: [{ value: 120 }] }, { name: "post_video_avg_time_watched", values: [{ value: 9500 }] }, { name: "post_video_social_actions", values: [{ value: { SHARE: 3, COMMENT: 4 } }] }] }), { status: 200 });
      return new Response(JSON.stringify({ views: 100, length: 28.1, likes: { summary: { total_count: 7 } }, comments: { summary: { total_count: 2 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = piece({ status: "published", externalId: "122099966505536075", publishedUrl: "https://www.facebook.com/reel/4385320008445781" });
    const r = await FETCHERS.facebook("122099966505536075", p, { META_PAGE_ACCESS_TOKEN: "t" }, { fetch: fetchFn, env: {}, sleep: async () => {} });
    expect(urls.every((u) => u.includes("/4385320008445781"))).toBe(true);
    expect(r.metrics).toMatchObject({ views: 120, durationSec: 28.1, reactions: 7, comments: 4, shares: 3, avgWatchTimeSec: 9.5 });
  });
});

describe("Instagram direct video upload", () => {
  it("uploads a reel from this computer with a resumable upload, then publishes", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { CONNECTORS } = await import("@/lib/publishing/connectors");
    const dir = mkdtempSync(path.join(tmpdir(), "igreel-"));
    const file = path.join(dir, "reel.mp4");
    writeFileSync(file, "1234567");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("/IG1/media_publish")) return ok({ id: "M1" });
      if (url.includes("/IG1/media")) return ok({ id: "C1", uri: "https://rupload.facebook.com/ig-api-upload/v24.0/C1" });
      if (url.includes("rupload.facebook.com")) return ok({ success: true });
      if (url.includes("/C1?fields=status_code")) return ok({ status_code: "FINISHED" });
      if (url.includes("/M1?fields=permalink")) return ok({ permalink: "https://www.instagram.com/reel/abc/" });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const p = piece({ platform: "instagram", format: "reel", mediaUrls: [file], status: "scheduled", approvedBy: "Ayushi" });
    expect(CONNECTORS.instagram.check(p)).toEqual([]);
    const r = await CONNECTORS.instagram.publish(p, { fetch: fetchFn, env: { INSTAGRAM_ACCOUNT_ID: "IG1", META_PAGE_ACCESS_TOKEN: "tok" }, sleep: async () => {} });
    expect(r).toMatchObject({ externalId: "M1", url: "https://www.instagram.com/reel/abc/" });
    const create = new URLSearchParams(String(calls[0]!.init!.body));
    expect(create.get("upload_type")).toBe("resumable");
    expect(create.get("video_url")).toBeNull();
    expect((calls[1]!.init!.headers as Record<string, string>).file_size).toBe("7");
    rmSync(dir, { recursive: true, force: true });
  });
});
