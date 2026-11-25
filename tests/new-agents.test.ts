import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import { buildSeed } from "@/lib/sample-data";
import { ContentPieceSchema, type ContentPiece } from "@/lib/schemas";
import type { ConnectorDeps } from "@/lib/publishing/connectors";
import { asHosted, cloudinarySignature, hostConfig, hostPiece, hostProblems } from "@/lib/publishing/media-host";
import { CONNECTORS } from "@/lib/publishing/connectors";
import { quizAnswerOf, quizGuess, safeToAutoReply, triageComment } from "@/lib/agents/community";
import { dayDate, upcomingDays } from "@/lib/trends/days";
import { climateDays, parseRss, relevance } from "@/lib/trends/agent";
import { competitorReport, igFormat, isoSeconds } from "@/lib/competitors/agent";

function piece(over: Partial<ContentPiece> = {}): ContentPiece {
  const now = "2026-10-20T10:00:00.000Z";
  return ContentPieceSchema.parse({ id: `post_${Math.random().toString(36).slice(2, 10)}`, brandId: brand.id, platform: "instagram", format: "carousel", pillarId: "habits", topic: "Quiz", hook: "Quick eco-quiz", caption: "Comment your answer", status: "scheduled", approvedBy: "Asha", plannedDate: "2026-10-20", plannedTime: "09:00", createdAt: now, updatedAt: now, ...over });
}

function fakeFetch(routes: Array<[string, (init?: RequestInit) => Response]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = routes.find(([k]) => url.includes(k));
    if (!r) return new Response(JSON.stringify({ error: { message: `no route for ${url}` } }), { status: 404 });
    return r[1](init);
  }) as typeof fetch;
  return { fn, calls };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const deps = (fetchImpl: typeof fetch, env: Record<string, string>): ConnectorDeps => ({ fetch: fetchImpl, env, sleep: async () => undefined });

/* ------------------------------------------------------------------ */

describe("Media Host", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sga-host-"));
  const slide1 = path.join(dir, "slides_abc_01.jpg");
  const cover = path.join(dir, "cover_abc.png");
  writeFileSync(slide1, "jpeg");
  writeFileSync(cover, "png");

  it("reads Cloudinary or app settings from the environment", () => {
    expect(hostConfig({ CLOUDINARY_URL: "cloudinary://123:s3cr%40t@demo-cloud" })).toEqual({ kind: "cloudinary", key: "123", secret: "s3cr@t", cloud: "demo-cloud", folder: "social-growth-agent" });
    expect(hostConfig({ MEDIA_PUBLIC_BASE_URL: "https://app.example.com/" })).toEqual({ kind: "app", base: "https://app.example.com" });
    // Without either, images are hosted on the brand's Facebook Page (unless switched off).
    expect(hostConfig({ MEDIA_PUBLIC_BASE_URL: "http://insecure.example.com" })).toEqual({ kind: "meta" });
    expect(hostConfig({})).toEqual({ kind: "meta" });
    expect(hostConfig({ MEDIA_HOST: "off" })).toBeNull();
  });

  it("hosts images on the Facebook Page as unpublished photos and leaves videos local", async () => {
    const video = path.join(dir, "video_abc.mp4");
    writeFileSync(video, "mp4");
    const f = fakeFetch([
      ["/PAGE1/photos", (init) => {
        const fd = init!.body as FormData;
        expect(fd.get("published")).toBe("false");
        return ok({ id: "PHOTO1" });
      }],
      ["/PHOTO1?fields=images", () => ok({ images: [{ source: "https://scontent.fbcdn.net/small.jpg", width: 320 }, { source: "https://scontent.fbcdn.net/big.jpg", width: 1080 }] })],
    ]);
    const cfg = hostConfig({})!;
    const p = piece({ mediaUrls: [slide1, video], hostedMedia: {} });
    expect(CONNECTORS.instagram.check(asHosted(piece({ mediaUrls: [slide1] }), cfg))).toEqual([]);
    const r = await hostPiece(p, cfg, deps(f.fn, { META_PAGE_ID: "PAGE1", META_PAGE_ACCESS_TOKEN: "T" }));
    expect(r.piece.mediaUrls).toEqual(["https://scontent.fbcdn.net/big.jpg", video]);
    expect(r.uploaded).toBe(1);
    await expect(hostPiece(piece({ mediaUrls: [slide1], hostedMedia: {} }), cfg, deps(f.fn, {}))).rejects.toThrow(/META_PAGE_ID/);
  });

  it("signs uploads the way Cloudinary documents", () => {
    // Example from Cloudinary's "Generating authentication signatures" guide.
    expect(cloudinarySignature({ eager: "w_400,h_300,c_pad|w_260,h_200,c_crop", public_id: "sample_image", timestamp: "1315060510" }, "abcd")).toBe("bfd09f95f331f558cbd1320e67aa8d488770583e");
  });

  it("lets Instagram posts with local files pass the checks once hosting is set up", () => {
    const p = piece({ mediaUrls: [slide1, cover] });
    expect(CONNECTORS.instagram.check(p).join(" ")).toMatch(/Media Host/);
    const cfg = hostConfig({ CLOUDINARY_URL: "cloudinary://1:2@demo" });
    expect(hostProblems(p, cfg)).toEqual([]);
    expect(CONNECTORS.instagram.check(asHosted(p, cfg))).toEqual([]);
    // App hosting serves only files the app made, and PNG stays PNG (Instagram rejects it).
    const app = hostConfig({ MEDIA_PUBLIC_BASE_URL: "https://app.example.com" });
    expect(CONNECTORS.instagram.check(asHosted(p, app)).join(" ")).toMatch(/JPEG/);
    expect(hostProblems(piece({ mediaUrls: [path.join(dir, "holiday.jpg")] }), app).join(" ")).toMatch(/not found/);
  });

  it("uploads each file once and turns PNG into a JPEG link", async () => {
    let n = 0;
    const f = fakeFetch([
      ["api.cloudinary.com/v1_1/demo/auto/upload", (init) => {
        n++;
        const fd = init!.body as FormData;
        expect(fd.get("api_key")).toBe("1");
        expect(String(fd.get("signature"))).toMatch(/^[0-9a-f]{40}$/);
        const name = (fd.get("file") as File).name;
        return ok(name.endsWith(".png") ? { secure_url: "https://res.cloudinary.com/demo/image/upload/v1/sga/cover_abc.png", resource_type: "image", format: "png" } : { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/sga/${name}`, resource_type: "image", format: "jpg" });
      }],
    ]);
    const cfg = hostConfig({ CLOUDINARY_URL: "cloudinary://1:2@demo" })!;
    const p = piece({ mediaUrls: [slide1, cover], hostedMedia: {} });
    const r = await hostPiece(p, cfg, deps(f.fn, {}));
    expect(r.piece.mediaUrls).toEqual(["https://res.cloudinary.com/demo/image/upload/v1/sga/slides_abc_01.jpg", "https://res.cloudinary.com/demo/image/upload/v1/sga/cover_abc.jpg"]);
    expect(r.uploaded).toBe(2);
    const again = await hostPiece({ ...p, hostedMedia: r.hosted }, cfg, deps(f.fn, {}));
    expect(again.uploaded).toBe(0);
    expect(n).toBe(2);
  });

  it("publishes an Instagram carousel from local slides through the Publishing Agent", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { runPublishingAgent } = await import("@/lib/publishing/agent");
    const db = buildSeed();
    const p = piece({ id: "post_host", mediaUrls: [slide1, slide1.replace("_01", "_02")] });
    writeFileSync(slide1.replace("_01", "_02"), "jpeg");
    db.content.push(p);
    await writeDbForTests(db);
    const f = fakeFetch([
      ["api.cloudinary.com", (init) => ok({ secure_url: `https://res.cloudinary.com/demo/image/upload/${((init!.body as FormData).get("file") as File).name}`, resource_type: "image", format: "jpg" })],
      ["/media_publish", () => ok({ id: "IGMEDIA1" })],
      ["/media?", () => ok({ id: "C" })],
      ["/media", () => ok({ id: "C" })],
      ["fields=status_code", () => ok({ status_code: "FINISHED" })],
      ["fields=permalink", () => ok({ permalink: "https://www.instagram.com/p/abc/" })],
    ]);
    const env = { CLOUDINARY_URL: "cloudinary://1:2@demo", KARMAVERSE_INSTAGRAM_ACCOUNT_ID: "17841", KARMAVERSE_INSTAGRAM_ACCESS_TOKEN: "IGTOKEN" };
    const r = await runPublishingAgent({ onlyId: "post_host", deps: deps(f.fn, env) });
    expect(r.published).toBe(1);
    const children = f.calls.filter((c) => c.url.endsWith("/17841/media") && String(c.init?.body).includes("is_carousel_item"));
    expect(children.map((c) => new URLSearchParams(String(c.init!.body)).get("image_url"))).toEqual(["https://res.cloudinary.com/demo/image/upload/slides_abc_01.jpg", "https://res.cloudinary.com/demo/image/upload/slides_abc_02.jpg"]);
    const saved = (await readDb()).content.find((c) => c.id === "post_host")!;
    expect(saved.status).toBe("published");
    expect(Object.keys(saved.hostedMedia)).toHaveLength(2);
    expect(saved.mediaUrls[0]).toBe(slide1);
  });
});

/* ------------------------------------------------------------------ */

describe("Community Manager", () => {
  const quiz = piece({ slides: "Quick eco-quiz | Comment A, B, C or D\nThe answer: C | Less production energy" });

  it("finds the quiz answer and reads guesses without mistaking words for options", () => {
    expect(quizAnswerOf(quiz)).toBe("C");
    expect(quizAnswerOf(piece({ caption: "Can you answer a simple question? Comment your answer below" }))).toBeNull();
    expect(["C", "c)", "Option b", "my answer is d", "C!", "(a) obviously", "it's B"].map(quizGuess)).toEqual(["C", "C", "B", "D", "C", "A", "B"]);
    expect(["A great initiative", "Can I join?", "Doing this daily", "Answer please"].map(quizGuess)).toEqual([null, null, null, null]);
  });

  it("drafts quiz replies and only lets safe ones go out on their own", () => {
    const right = triageComment(brand, quiz, "@riya.k", "C");
    expect(right.quiz).toBe(true);
    expect(right.reply).toMatch(/^Correct, riya! 🎉/);
    const wrong = triageComment(brand, quiz, "@aman", "b");
    expect(wrong.reply).toMatch(/The answer is C/);
    expect(safeToAutoReply({ classification: right.classification, suggestedReply: right.reply })).toBe(true);
    const support = triageComment(brand, quiz, "@vik", "C. Also my coins are not credited");
    expect(support.quiz).toBe(false);
    expect(safeToAutoReply({ classification: support.classification, suggestedReply: support.reply })).toBe(false);
    const question = triageComment(brand, quiz, "@sam", "How do I book a pickup?");
    expect(safeToAutoReply({ classification: question.classification, suggestedReply: question.reply })).toBe(false);
    const praise = triageComment(brand, null, "@meera", "Love this 💚");
    expect(safeToAutoReply({ classification: praise.classification, suggestedReply: praise.reply })).toBe(true);
  });

  it("reads Instagram comments, skips its own, and auto-replies only to safe ones once", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { runCommunityManager } = await import("@/lib/community/agent");
    const db = buildSeed();
    db.settings.autoReply = "safe";
    const now = new Date("2026-10-27T10:00:00Z");
    db.content.push({ ...quiz, id: "post_quiz", status: "published", externalId: "IGMEDIA", publishedUrl: "https://www.instagram.com/p/q/", history: [{ at: "2026-10-26T10:00:00Z", from: "scheduled", to: "published", by: "publishing-agent", note: "" }] });
    await writeDbForTests(db);
    const recent = "2026-10-27T09:00:00+0000";
    const f = fakeFetch([
      ["/IGMEDIA/comments", () => ok({ data: [
        { id: "c1", text: "C", username: "riya.k", timestamp: recent, from: { id: "u1" } },
        { id: "c2", text: "How do I book a pickup?", username: "sam", timestamp: recent, from: { id: "u2" } },
        { id: "c3", text: "Thanks all!", username: "karmaverse", timestamp: recent, from: { id: "17841" } },
        { id: "c4", text: "B", username: "old", timestamp: "2026-10-01T09:00:00+0000", from: { id: "u4" } },
      ] })],
      ["/c1/replies", () => ok({ id: "r1" })],
    ]);
    const env = { KARMAVERSE_INSTAGRAM_ACCOUNT_ID: "17841", KARMAVERSE_INSTAGRAM_ACCESS_TOKEN: "IGTOKEN" };
    const r = await runCommunityManager({ now, deps: deps(f.fn, env) });
    expect(r.added).toBe(3);
    expect(r.sent).toBe(1);
    const inbox = (await readDb()).inbox.filter((i) => i.contentId === "post_quiz");
    expect(inbox.find((i) => i.externalId === "c1")).toMatchObject({ replyStatus: "posted", replyExternalId: "r1", approvedBy: "community-manager (auto)" });
    expect(inbox.find((i) => i.externalId === "c2")?.replyStatus).toBe("drafted");
    expect(inbox.find((i) => i.externalId === "c4")?.replyStatus).toBe("drafted"); // too old to answer on its own
    expect(new URLSearchParams(String(f.calls.find((c) => c.url.includes("/c1/replies"))!.init!.body)).get("message")).toMatch(/^Correct, riya!/);

    // A second run adds nothing new and sends nothing again.
    const again = await runCommunityManager({ now: new Date(now.getTime() + 20 * 60_000), deps: deps(f.fn, env) });
    expect(again.added).toBe(0);
    expect(f.calls.filter((c) => c.url.includes("/replies")).length).toBe(1);
  });

  it("sends an approved reply once and records failures without retrying", async () => {
    const { mutate, readDb } = await import("@/lib/db");
    const { sendReply } = await import("@/lib/community/agent");
    const id = (await readDb()).inbox.find((i) => i.externalId === "c2")!.id;
    await mutate((d) => {
      const it = d.inbox.find((i) => i.id === id)!;
      it.replyStatus = "approved";
      it.suggestedReply = "Hi Sam! Book it in the app under Pickups.";
    });
    const env = { KARMAVERSE_INSTAGRAM_ACCOUNT_ID: "17841", KARMAVERSE_INSTAGRAM_ACCESS_TOKEN: "IGTOKEN" };
    const bad = fakeFetch([["/c2/replies", () => new Response(JSON.stringify({ error: { message: "(#10) Application does not have permission" } }), { status: 403 })]]);
    const r1 = await sendReply(id, { deps: deps(bad.fn, env) });
    expect(r1.ok).toBe(false);
    expect(r1.message).toMatch(/instagram_business_manage_comments/);
    expect((await readDb()).inbox.find((i) => i.id === id)).toMatchObject({ replyStatus: "approved", replySendingAt: null });
    const good = fakeFetch([["/c2/replies", () => ok({ id: "r2" })]]);
    expect((await sendReply(id, { deps: deps(good.fn, env) })).ok).toBe(true);
    expect((await sendReply(id, { deps: deps(good.fn, env) })).ok).toBe(false);
    expect(good.calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */

describe("Trend Watcher", () => {
  it("dates climate days, including the ones that move", () => {
    expect(dayDate("06-05", 2026)).toBe("2026-06-05");
    expect(dayDate("last-sat-03", 2026)).toBe("2026-03-28");
    expect(dayDate("3rd-sat-09", 2026)).toBe("2026-09-19");
    const next = upcomingDays("2026-10-27", 45).map((d) => `${d.date} ${d.name}`);
    expect(next[0]).toBe("2026-10-31 World Cities Day");
    expect(next).toContain("2026-12-05 World Soil Day");
    expect(climateDays(brand, "2026-10-27")[0]!.detail).toMatch(/^In 4 days/);
  });

  it("keeps only searches about climate, waste or pollution", () => {
    expect(relevance("Delhi AQI today", brand)).toBeGreaterThanOrEqual(50);
    expect(relevance("plastic ban Maharashtra", brand)).toBeGreaterThanOrEqual(50);
    expect(relevance("Green Day concert", brand)).toBe(0);
    expect(relevance("India vs Australia", brand)).toBe(0);
    expect(relevance("Minister EXPOSES Europe's climate hypocrisy", brand)).toBe(0);
    expect(relevance("Environment Minister highlights recycling push", brand)).toBeGreaterThanOrEqual(50);
    expect(Number.isInteger(relevance("plastic waste", brand, 2.7))).toBe(true);
    // "economy" is a brand word (circular economy pillar) but not enough on its own.
    expect(relevance("economy news", brand)).toBeLessThan(50);
  });

  it("reads Google Trends and News RSS", () => {
    const xml = `<rss><channel><item><title>delhi aqi</title><ht:approx_traffic>50000+</ht:approx_traffic><pubDate>Tue, 27 Oct 2026 04:00:00 -0700</pubDate><ht:news_item><ht:news_item_title><![CDATA[Delhi&#39;s air turns &quot;severe&quot;]]></ht:news_item_title><ht:news_item_url>https://news.example/aqi</ht:news_item_url></ht:news_item></item><item><title>cricket</title></item></channel></rss>`;
    const items = parseRss(xml);
    expect(items).toHaveLength(2);
    expect(items[0]!.fields["ht:news_item_title"]).toBe(`Delhi's air turns "severe"`);
    expect(items[0]!.date).toBe("2026-10-27T11:00:00.000Z");
  });

  it("saves new trends once and keeps their status on later runs", async () => {
    const { writeDbForTests, readDb, mutate } = await import("@/lib/db");
    const { runTrendWatcher } = await import("@/lib/trends/agent");
    await writeDbForTests(buildSeed());
    const rss = (title: string) => new Response(`<rss><channel><item><title>${title}</title><link>https://news.example/1</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate><source>Example Times</source></item></channel></rss>`, { status: 200 });
    const f = fakeFetch([
      ["trends.google.com", () => rss("delhi pollution")],
      ["news.google.com", () => rss("Plastic waste rules tightened - Example Times")],
    ]);
    const now = new Date("2026-10-27T06:00:00Z");
    const r = await runTrendWatcher({ now, deps: deps(f.fn, {}) });
    const trends = (await readDb()).trends;
    expect(trends.some((t) => t.source === "google-trends" && t.title === "delhi pollution")).toBe(true);
    expect(trends.filter((t) => t.source === "news").map((t) => t.title)).toEqual(["Plastic waste rules tightened"]);
    expect(trends.some((t) => t.source === "climate-day" && t.title === "World Cities Day")).toBe(true);
    expect(r.added).toBe(trends.length);
    await mutate((d) => {
      d.trends.find((t) => t.title === "delhi pollution")!.status = "dismissed";
    });
    const again = await runTrendWatcher({ now: new Date(now.getTime() + 86_400_000), deps: deps(f.fn, {}) });
    expect(again.added).toBe(0);
    expect((await readDb()).trends.find((t) => t.title === "delhi pollution")!.status).toBe("dismissed");
  });
});

/* ------------------------------------------------------------------ */

describe("Competitor Watch", () => {
  it("parses durations and Instagram formats", () => {
    expect(isoSeconds("PT1M5S")).toBe(65);
    expect(isoSeconds("PT45S")).toBe(45);
    expect(isoSeconds("PT1H2M")).toBe(3720);
    expect(igFormat({ media_type: "VIDEO", media_product_type: "REELS" })).toBe("reel");
    expect(igFormat({ media_type: "CAROUSEL_ALBUM" })).toBe("carousel");
    expect(igFormat({ media_type: "IMAGE" })).toBe("image-post");
  });

  it("compares formats fairly between big and small accounts", () => {
    const comps = [
      { id: "big", brandId: brand.id, name: "Big", instagram: "big", youtube: "", website: "", notes: "", profiles: [{ platform: "instagram" as const, followers: 100000, posts: 10, at: "" }], lastSyncAt: null, lastSyncNotes: [], createdAt: "" },
      { id: "small", brandId: brand.id, name: "Small", instagram: "small", youtube: "", website: "", notes: "", profiles: [], lastSyncAt: null, lastSyncNotes: [], createdAt: "" },
    ];
    let i = 0;
    const post = (competitorId: string, format: "reel" | "image-post", likes: number, hook = "Tips") => ({ id: `p${i++}`, competitorId, platform: "instagram" as const, format, postedAt: `2026-10-${String(10 + (i % 15)).padStart(2, "0")}T13:30:00.000Z`, hook, url: "", externalId: null, likes, comments: 0, views: null, source: "manual" as const, syncedAt: "" });
    const posts = [
      post("big", "image-post", 1000), post("big", "image-post", 1000), post("big", "image-post", 1000), post("big", "reel", 3000, "Why does this happen?"), post("big", "reel", 3000, "Is this true?"),
      post("small", "image-post", 10), post("small", "image-post", 10), post("small", "image-post", 10), post("small", "reel", 30, "Can you guess?"), post("small", "reel", 30, "What is it?"),
    ];
    const r = competitorReport(brand, comps, posts, { content: [], metrics: [] }, new Date("2026-10-27T00:00:00Z"));
    expect(r.formats[0]).toMatchObject({ format: "reel", lift: 3, posts: 4 });
    expect(r.formats[1]).toMatchObject({ format: "image-post", lift: 1, posts: 6 });
    expect(r.rows.find((x) => x.competitor.id === "big")).toMatchObject({ followers: 100000, bestFormat: { format: "reel", times: 3 } });
    expect(r.hooks[0]).toMatchObject({ pattern: "Asks a question", lift: 3 });
    expect(r.insights.join(" ")).toMatch(/reels do best/);
    expect(r.top[0]!.lift).toBe(3);
  });

  it("reads a YouTube channel's latest videos and updates them on the next sync", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { runCompetitorWatch } = await import("@/lib/competitors/agent");
    const db = buildSeed();
    db.competitors.push({ id: "comp1", brandId: brand.id, name: "Eco Channel", instagram: "", youtube: "@ecochannel", website: "", notes: "", profiles: [], lastSyncAt: null, lastSyncNotes: [], createdAt: "2026-10-01T00:00:00Z" });
    await writeDbForTests(db);
    let views = "1000";
    const f = fakeFetch([
      ["oauth2.googleapis.com/token", () => ok({ access_token: "T" })],
      ["/channels?", () => ok({ items: [{ statistics: { subscriberCount: "5000", videoCount: "40" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] })],
      ["/playlistItems?", () => ok({ items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }] })],
      ["/videos?", () => ok({ items: [
        { id: "v1", snippet: { title: "3 tips to cut plastic #shorts", publishedAt: "2026-10-20T10:00:00Z" }, statistics: { viewCount: views, likeCount: "50", commentCount: "5" }, contentDetails: { duration: "PT40S" } },
        { id: "v2", snippet: { title: "Climate explained", publishedAt: "2026-10-18T10:00:00Z" }, statistics: { viewCount: "300", likeCount: "20", commentCount: "2" }, contentDetails: { duration: "PT12M" } },
      ] })],
    ]);
    const env = { KARMAVERSE_YOUTUBE_CLIENT_ID: "a", KARMAVERSE_YOUTUBE_CLIENT_SECRET: "b", KARMAVERSE_YOUTUBE_REFRESH_TOKEN: "c" };
    expect((await runCompetitorWatch({ deps: deps(f.fn, env) })).updated).toBe(1);
    expect(f.calls.find((c) => c.url.includes("/channels?"))!.url).toContain("forHandle=%40ecochannel");
    views = "2500";
    await runCompetitorWatch({ deps: deps(f.fn, env) });
    const after = await readDb();
    const posts = after.competitorPosts.filter((p) => p.competitorId === "comp1");
    expect(posts).toHaveLength(2);
    expect(posts.find((p) => p.externalId === "v1")).toMatchObject({ format: "short", views: 2500, likes: 50 });
    expect(posts.find((p) => p.externalId === "v2")?.format).toBe("long-video");
    expect(after.competitors[0]!.profiles).toEqual([expect.objectContaining({ platform: "youtube", followers: 5000 })]);
  });
});
