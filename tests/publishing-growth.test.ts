import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import { buildSeed } from "@/lib/sample-data";
import { scorePosts } from "@/lib/analytics/engine";
import { afterPublishTasks, boostCheck, cadenceCheck, hookIdeas, repurposeWinners } from "@/lib/agents/engagement";
import { classifyHook } from "@/lib/analytics/engine";
import { CONNECTORS, linkedinCommentary, linkedinVersion, postText, type ConnectorDeps } from "@/lib/publishing/connectors";
import { CLAIM_TIMEOUT_MS, plannedInstant } from "@/lib/publishing/agent";
import type { ContentPiece, PostMetric } from "@/lib/schemas";

const SETUP_DATA_FILE = process.env.DATA_FILE;

function piece(over: Partial<ContentPiece> = {}): ContentPiece {
  const now = "2026-10-20T10:00:00.000Z";
  return {
    id: over.id ?? `post_${Math.random().toString(36).slice(2, 10)}`,
    brandId: brand.id,
    ideaId: null,
    platform: "facebook",
    format: "text-post",
    pillarId: "habits",
    topic: "Composting at home",
    hook: "Do you compost at home?",
    caption: "Do you compost at home?\n\nHere is the easiest way to start.\n\nTell us in the comments?",
    description: "",
    keywords: [],
    hashtags: ["#Compost"],
    cta: "Tell us in the comments",
    thumbnailConcept: "",
    mediaUrls: [],
    extraMedia: [],
    subtitles: "",
    slides: "",
    hostedMedia: {},
    plannedDate: "2026-10-20",
    plannedTime: "19:00",
    targetMetric: null,
    status: "scheduled",
    approvedBy: "Asha",
    approvedAt: now,
    publishedUrl: null,
    failureReason: null,
    publishingStartedAt: null,
    externalId: null,
    generatedBy: "template",
    history: [],
    createdAt: now,
    updatedAt: now,
    isSample: false,
    ...over,
  };
}

/** Fake fetch: matches routes by substring, records every call. */
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

const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
const deps = (fetchImpl: typeof fetch, env: Record<string, string>): ConnectorDeps => ({ fetch: fetchImpl, env, sleep: async () => undefined });

describe("publishing connectors", () => {
  it("reads planned time as IST and defaults to 09:00", () => {
    expect(plannedInstant({ plannedDate: "2026-11-01", plannedTime: "19:00 (experiment)" })!.toISOString()).toBe("2026-11-01T13:30:00.000Z");
    expect(plannedInstant({ plannedDate: "2026-11-01", plannedTime: null })!.toISOString()).toBe("2026-11-01T03:30:00.000Z");
    expect(plannedInstant({ plannedDate: null, plannedTime: "10:00" })).toBeNull();
  });

  it("checks platform requirements before publishing", () => {
    expect(CONNECTORS.instagram.check(piece({ platform: "instagram", format: "reel" })).join(" ")).toMatch(/media URL/);
    expect(CONNECTORS.instagram.check(piece({ platform: "instagram", format: "reel", mediaUrls: ["https://cdn.example.com/a.jpg"] })).join(" ")).toMatch(/video/);
    expect(CONNECTORS.instagram.check(piece({ platform: "instagram", format: "reel", mediaUrls: ["https://cdn.example.com/a.mp4"] }))).toEqual([]);
    expect(CONNECTORS.linkedin.check(piece({ platform: "linkedin", format: "document-carousel" })).join(" ")).toMatch(/by hand/);
    expect(CONNECTORS.facebook.check(piece({ caption: "Fill [this in]" })).join(" ")).toMatch(/placeholders/);
    expect(CONNECTORS.youtube.check(piece({ platform: "youtube", format: "short", mediaUrls: ["http://insecure/a.mp4"] })).join(" ")).toMatch(/https/);
  });

  it("formats LinkedIn commentary with escaped characters and real hashtags", () => {
    expect(linkedinCommentary("Hi (team) #Zero_Waste!")).toBe("Hi \\(team\\) {hashtag|\\#|Zero_Waste}!");
    expect(linkedinVersion({}, new Date("2026-10-26T00:00:00Z"))).toBe("202608");
    expect(linkedinVersion({ LINKEDIN_API_VERSION: "202605" })).toBe("202605");
  });

  it("appends hashtags that are not already in the caption", () => {
    expect(postText(piece({ caption: "Hello #Compost", hashtags: ["#Compost", "#ZeroWaste"] }))).toBe("Hello #Compost\n\n#ZeroWaste");
  });

  it("publishes an Instagram Reel: container, wait, publish, permalink", async () => {
    let polls = 0;
    const f = fakeFetch([
      ["/media_publish", () => ok({ id: "M1" })],
      ["/IG1/media", () => ok({ id: "C1" })],
      ["/C1?fields=status_code", () => ok({ status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" })],
      ["/M1?fields=permalink", () => ok({ permalink: "https://www.instagram.com/reel/abc/" })],
    ]);
    const r = await CONNECTORS.instagram.publish(piece({ platform: "instagram", format: "reel", mediaUrls: ["https://cdn.example.com/a.mp4"] }), deps(f.fn, { INSTAGRAM_ACCOUNT_ID: "IG1", META_PAGE_ACCESS_TOKEN: "tok" }));
    expect(r).toMatchObject({ externalId: "M1", url: "https://www.instagram.com/reel/abc/" });
    const create = new URLSearchParams(String(f.calls[0]!.init!.body));
    expect(create.get("media_type")).toBe("REELS");
    expect(create.get("caption")).toContain("#Compost");
    expect(polls).toBe(2);
  });

  it("publishes a Facebook Reel from a file on this computer: start, upload bytes, finish", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fbreel-"));
    const file = path.join(dir, "ad.mp4");
    writeFileSync(file, "12345");
    const f = fakeFetch([
      ["rupload.facebook.com", () => ok({ success: true })],
      ["/P1/video_reels", (init) => (new URLSearchParams(String(init!.body)).get("upload_phase") === "start" ? ok({ video_id: "V1", upload_url: "https://rupload.facebook.com/video-upload/V1" }) : ok({ success: true, post_id: "PO1" }))],
    ]);
    const p = piece({ format: "reel", mediaUrls: [file] });
    expect(CONNECTORS.facebook.check(p)).toEqual([]);
    const r = await CONNECTORS.facebook.publish(p, deps(f.fn, { META_PAGE_ID: "P1", META_PAGE_ACCESS_TOKEN: "tok" }));
    expect(r).toMatchObject({ externalId: "PO1", url: "https://www.facebook.com/reel/V1" });
    const upload = f.calls[1]!;
    expect((upload.init!.headers as Record<string, string>).file_size).toBe("5");
    const finish = new URLSearchParams(String(f.calls[2]!.init!.body));
    expect(finish.get("video_state")).toBe("PUBLISHED");
    expect(finish.get("description")).toContain("#Compost");
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes a LinkedIn video: initialize, upload parts, finalize, post", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "livid-"));
    const file = path.join(dir, "ad.mp4");
    writeFileSync(file, "0123456789");
    const f = fakeFetch([
      ["action=initializeUpload", () => ok({ value: { video: "urn:li:video:V1", uploadToken: "", uploadInstructions: [{ uploadUrl: "https://up.example/1", firstByte: 0, lastByte: 5 }, { uploadUrl: "https://up.example/2", firstByte: 6, lastByte: 9 }] } })],
      ["up.example", () => new Response("", { status: 200, headers: { etag: "E" } })],
      ["action=finalizeUpload", () => new Response("", { status: 200 })],
      ["/rest/posts", () => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:1" } })],
    ]);
    const p = piece({ platform: "linkedin", mediaUrls: [file] });
    expect(CONNECTORS.linkedin.check(p)).toEqual([]);
    const r = await CONNECTORS.linkedin.publish(p, deps(f.fn, { LINKEDIN_ACCESS_TOKEN: "tok", LINKEDIN_AUTHOR_URN: "urn:li:organization:1" }));
    expect(r.externalId).toBe("urn:li:share:1");
    expect(JSON.parse(String(f.calls[3]!.init!.body)).finalizeUploadRequest.uploadedPartIds).toEqual(["E", "E"]);
    expect(JSON.parse(String(f.calls[4]!.init!.body)).content).toEqual({ media: { id: "urn:li:video:V1" } });
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not retry a non-idempotent create on a server error (avoids double posts)", async () => {
    let n = 0;
    const f = fakeFetch([["/feed", () => (n++, new Response("{}", { status: 500 }))]]);
    await expect(CONNECTORS.facebook.publish(piece(), deps(f.fn, { META_PAGE_ID: "P1", META_PAGE_ACCESS_TOKEN: "tok" }))).rejects.toThrow(/facebook post failed \(500\)/);
    expect(n).toBe(1);
  });

  it("retries on 429 rate limits", async () => {
    let n = 0;
    const f = fakeFetch([
      ["/feed", () => (++n === 1 ? new Response("{}", { status: 429 }) : ok({ id: "P1_9" }))],
      ["permalink_url", () => ok({ permalink_url: "https://www.facebook.com/p/9" })],
    ]);
    const r = await CONNECTORS.facebook.publish(piece(), deps(f.fn, { META_PAGE_ID: "P1", META_PAGE_ACCESS_TOKEN: "tok" }));
    expect(r.url).toBe("https://www.facebook.com/p/9");
    expect(n).toBe(2);
  });

  it("uploads a YouTube Short with a refreshed token and resumable upload", async () => {
    const f = fakeFetch([
      ["oauth2.googleapis.com/token", () => ok({ access_token: "AT" })],
      ["cdn.example.com", () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } })],
      ["uploadType=resumable", () => new Response(null, { status: 200, headers: { location: "https://upload.example/session1" } })],
      ["upload.example/session1", () => ok({ id: "VID", status: { privacyStatus: "private" } })],
    ]);
    const r = await CONNECTORS.youtube.publish(
      piece({ platform: "youtube", format: "short", hook: "Compost in 30 seconds", description: "How to start.", mediaUrls: ["https://cdn.example.com/s.mp4"], hashtags: ["#Shorts"] }),
      deps(f.fn, { YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b", YOUTUBE_REFRESH_TOKEN: "c" }),
    );
    expect(r.url).toBe("https://www.youtube.com/shorts/VID");
    expect(r.notes.join(" ")).toMatch(/set the video to private/);
    const meta = JSON.parse(String(f.calls[2]!.init!.body));
    expect(meta.snippet.title).toBe("Compost in 30 seconds");
    expect(meta.status.privacyStatus).toBe("public");
  });
});

describe("publishing agent", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sga-pub-"));
    process.env.DATA_FILE = path.join(dir, "db.json");
  });
  afterAll(() => {
    process.env.DATA_FILE = SETUP_DATA_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes only due, scheduled, approved posts; skips unconnected platforms; never double-posts", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { runPublishingAgent } = await import("@/lib/publishing/agent");
    const db = buildSeed();
    db.content = [
      piece({ id: "due" }),
      piece({ id: "future", plannedDate: "2026-12-01" }),
      piece({ id: "draft", status: "draft", approvedBy: null }),
      piece({ id: "li", platform: "linkedin" }),
      piece({ id: "stale", publishingStartedAt: new Date(Date.parse("2026-10-20T14:00:00Z") - CLAIM_TIMEOUT_MS - 1000).toISOString() }),
      piece({ id: "broken", caption: "Fill [this] in" }),
    ];
    await writeDbForTests(db);

    let posts = 0;
    const f = fakeFetch([
      ["/feed", () => (posts++, ok({ id: "P1_1" }))],
      ["permalink_url", () => ok({ permalink_url: "https://www.facebook.com/p/1" })],
    ]);
    const env = { META_PAGE_ID: "P1", META_PAGE_ACCESS_TOKEN: "tok" };
    const now = new Date("2026-10-20T14:00:00Z"); // 19:30 IST
    const [a, b] = await Promise.all([runPublishingAgent({ now, deps: deps(f.fn, env) }), runPublishingAgent({ now, deps: deps(f.fn, env) })]);
    expect(a).toBe(b); // concurrent calls share one run
    expect(posts).toBe(1);

    const after = await readDb();
    const by = (id: string) => after.content.find((c) => c.id === id)!;
    expect(by("due")).toMatchObject({ status: "published", publishedUrl: "https://www.facebook.com/p/1", externalId: "P1_1", publishingStartedAt: null });
    expect(by("due").history.at(-1)).toMatchObject({ from: "scheduled", to: "published", by: "publishing-agent" });
    expect(by("future").status).toBe("scheduled");
    expect(by("draft").status).toBe("draft");
    expect(by("li").status).toBe("scheduled");
    expect(by("stale").status).toBe("failed");
    expect(by("stale").failureReason).toMatch(/result is unknown/);
    expect(by("broken").status).toBe("failed");
    expect(a.notes.join(" ")).toMatch(/not connected \(set KARMAVERSE_LINKEDIN_ACCESS_TOKEN, KARMAVERSE_LINKEDIN_AUTHOR_URN\)/);
    expect(after.settings.lastPublishRun).toMatchObject({ published: 1, failed: 2, skipped: 1 });

    // A second run publishes nothing new.
    await runPublishingAgent({ now, deps: deps(f.fn, env) });
    expect(posts).toBe(1);
  });

  it("marks the post failed with the platform's message when the API rejects it", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { runPublishingAgent } = await import("@/lib/publishing/agent");
    const db = buildSeed();
    db.content = [piece({ id: "x" })];
    await writeDbForTests(db);
    const f = fakeFetch([["/feed", () => new Response(JSON.stringify({ error: { message: "Invalid OAuth access token." } }), { status: 400 })]]);
    const r = await runPublishingAgent({ onlyId: "x", deps: deps(f.fn, { META_PAGE_ID: "P1", META_PAGE_ACCESS_TOKEN: "bad" }) });
    expect(r.failed).toBe(1);
    const p = (await readDb()).content[0]!;
    expect(p.status).toBe("failed");
    expect(p.failureReason).toMatch(/Invalid OAuth access token/);
  });

  it("queues upcoming Facebook posts on the platform, marks them published at the time, and re-queues after an edit", async () => {
    const { writeDbForTests, readDb, mutate } = await import("@/lib/db");
    const { runPublishingAgent } = await import("@/lib/publishing/agent");
    const db = buildSeed();
    db.content = [
      piece({ id: "tomorrow", plannedDate: "2026-10-21", plannedTime: "19:00" }),
      piece({ id: "soon", plannedDate: "2026-10-20", plannedTime: "19:40" }), // 10 minutes away: too close to queue
      piece({ id: "far", plannedDate: "2026-11-20" }), // beyond the 7-day window
      piece({ id: "ig", platform: "instagram", format: "image-post", plannedDate: "2026-10-21" }), // no scheduling API
      piece({ id: "unapproved", plannedDate: "2026-10-21", approvedBy: null }),
    ];
    await writeDbForTests(db);

    const sent: Array<Record<string, string>> = [];
    let deleted = 0;
    const f = fakeFetch([
      ["/feed", (init) => (sent.push(Object.fromEntries(new URLSearchParams(String(init?.body)))), ok({ id: `P1_${sent.length}` }))],
      ["permalink_url", () => ok({ permalink_url: "https://www.facebook.com/p/q" })],
      ["P1_1?access_token", () => (deleted++, ok({ success: true }))],
    ]);
    const env = { META_PAGE_ID: "P1", META_PAGE_ACCESS_TOKEN: "tok" };
    const now = new Date("2026-10-20T14:00:00Z"); // 19:30 IST
    const r = await runPublishingAgent({ now, deps: deps(f.fn, env) });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ published: "false", scheduled_publish_time: String(Date.parse("2026-10-21T19:00:00+05:30") / 1000) });
    expect(r.notes.join(" ")).toMatch(/Queued facebook .* even if this computer is off/);
    let by = (id: string) => after.content.find((c) => c.id === id)!;
    let after = await readDb();
    expect(by("tomorrow")).toMatchObject({ status: "scheduled", publishingStartedAt: null, platformQueue: { externalId: "P1_1", url: "https://www.facebook.com/p/q" } });
    for (const id of ["soon", "far", "ig", "unapproved"]) expect(by(id).platformQueue ?? null).toBeNull();

    // An edit here cancels the queued copy and queues the new text.
    await mutate((d) => {
      const p = d.content.find((c) => c.id === "tomorrow")!;
      p.caption = "Edited caption";
    });
    await runPublishingAgent({ now, deps: deps(f.fn, env) });
    expect(deleted).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message).toMatch(/Edited caption/);

    // At the planned time it is marked published without posting again.
    await runPublishingAgent({ now: new Date("2026-10-21T13:31:00Z"), deps: deps(f.fn, env) });
    after = await readDb();
    by = (id: string) => after.content.find((c) => c.id === id)!;
    expect(by("tomorrow")).toMatchObject({ status: "published", externalId: "P1_2", publishedUrl: "https://www.facebook.com/p/q" });
    expect(sent.filter((s) => /Edited caption/.test(s.message ?? ""))).toHaveLength(1);
  });

  it("queues YouTube uploads as private with publishAt", async () => {
    const { CONNECTORS } = await import("@/lib/publishing/connectors");
    const dir2 = mkdtempSync(path.join(tmpdir(), "yt-q-"));
    const file = path.join(dir2, "v.mp4");
    writeFileSync(file, "fake");
    let meta: { status?: Record<string, unknown> } = {};
    const f = fakeFetch([
      ["oauth2.googleapis.com/token", () => ok({ access_token: "at" })],
      ["uploadType=resumable", (init) => ((meta = JSON.parse(String(init?.body))), new Response("", { status: 200, headers: { location: "https://upload.example/u1" } }))],
      ["upload.example/u1", () => ok({ id: "VID1", status: { privacyStatus: "private" } })],
    ]);
    const at = new Date("2026-10-22T13:30:00Z");
    const res = await CONNECTORS.youtube!.publish(piece({ platform: "youtube", format: "short", hook: "Title", mediaUrls: [file] }), deps(f.fn, { YOUTUBE_CLIENT_ID: "c", YOUTUBE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r" }), { publishAt: at });
    expect(meta.status).toMatchObject({ privacyStatus: "private", publishAt: at.toISOString() });
    expect(res.externalId).toBe("VID1");
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe("growth booster", () => {
  const seed = buildSeed();
  const scored = scorePosts(seed.metrics);

  it("scores a strong post high and flags what is missing", () => {
    const good = boostCheck(piece({ mediaUrls: ["https://cdn.example.com/a.jpg"] }), scored);
    expect(good.score).toBeGreaterThanOrEqual(80);
    const weak = boostCheck(piece({ platform: "instagram", format: "reel", hook: "x".repeat(200), cta: "", caption: "Some text [fill]", hashtags: [], plannedTime: null }), scored);
    expect(weak.score).toBeLessThan(50);
    const ids = weak.checks.filter((c) => c.status !== "pass").map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["placeholders", "hook-length", "cta", "hashtags", "timing", "media"]));
  });

  it("asks for #Shorts on YouTube Shorts", () => {
    const r = boostCheck(piece({ platform: "youtube", format: "short", hashtags: ["#Compost"] }), scored);
    expect(r.checks.find((c) => c.id === "hashtags")!.detail).toMatch(/#Shorts/);
  });

  it("offers hook rewrites in other styles", () => {
    const ideas = hookIdeas(piece({ platform: "instagram", format: "reel", hook: "Myth or fact: compost smells" }), scored);
    expect(ideas).toHaveLength(3);
    expect(ideas.every((i) => i.style !== "myth-or-fact")).toBe(true);
    for (const i of ideas) expect(classifyHook(i.hook)).toBe(i.style);
  });

  it("lists after-publish tasks and asks for metrics after 7 days", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const fresh = piece({ id: "fresh", status: "published", platform: "instagram", format: "reel", publishedUrl: "https://ig/p/1", history: [{ at: "2026-10-26T11:00:00Z", from: "scheduled", to: "published", by: "x", note: "" }] });
    const old = piece({ id: "old", status: "published", publishedUrl: "https://fb/p/2", history: [{ at: "2026-10-10T11:00:00Z", from: "scheduled", to: "published", by: "x", note: "" }] });
    const tasks = afterPublishTasks([fresh, old], [], [], now);
    expect(tasks.filter((t) => t.pieceId === "fresh").some((t) => t.urgent && /comment/i.test(t.task))).toBe(true);
    expect(tasks.some((t) => t.pieceId === "fresh" && /Story/.test(t.task))).toBe(true);
    expect(tasks.some((t) => t.pieceId === "old" && /Log this post's metrics/.test(t.task))).toBe(true);
    const logged: PostMetric = { ...seed.metrics[0]!, contentId: "old" };
    expect(afterPublishTasks([old], [], [logged], now).some((t) => /metrics/.test(t.task))).toBe(false);
  });

  it("suggests repurposing posts that beat their history onto other platforms", () => {
    const wins = repurposeWinners(brand, [], scored, 10);
    for (const w of wins) {
      expect(w.lift).toBeGreaterThanOrEqual(0.2);
      expect(w.targets.some((t) => t.platform === w.from.platform)).toBe(false);
    }
  });

  it("checks posting consistency against the weekly plan", () => {
    const rows = cadenceCheck(brand, [piece({ status: "approved", plannedDate: "2026-10-27" })], "2026-10-26");
    expect(rows.find((r) => r.platform === "facebook")).toMatchObject({ next7: 1 });
    expect(rows.find((r) => r.platform === "instagram")!.status).toBe("fix");
  });
});

describe("per-brand accounts", () => {
  const other = { ...brand, id: "brand_zw", name: "3R ZeroWaste", accountKey: "" };
  const db = { brands: [brand, other] };

  it("derives account keys and keeps brands' credentials apart", async () => {
    const { accountKey, brandEnv } = await import("@/lib/publishing/accounts");
    expect(accountKey(brand)).toBe("KARMAVERSE");
    expect(accountKey(other)).toBe("BRAND_3R_ZEROWASTE");
    const env = { META_PAGE_ID: "KV_PAGE", META_PAGE_ACCESS_TOKEN: "kv", BRAND_3R_ZEROWASTE_META_PAGE_ID: "ZW_PAGE", META_GRAPH_VERSION: "v25.0" };
    expect(brandEnv(brand, db, env)).toMatchObject({ META_PAGE_ID: "KV_PAGE", META_PAGE_ACCESS_TOKEN: "kv", META_GRAPH_VERSION: "v25.0" });
    // The second brand gets its own page id, never the default brand's token.
    const zw = brandEnv(other, db, env);
    expect(zw.META_PAGE_ID).toBe("ZW_PAGE");
    expect(zw.META_PAGE_ACCESS_TOKEN).toBeUndefined();
    expect(zw.META_GRAPH_VERSION).toBe("v25.0");
  });

  it("reports a brand without its own tokens as not connected, with prefixed names", async () => {
    const { connectionStatus } = await import("@/lib/publishing/agent");
    const fb = connectionStatus(other, db, { META_PAGE_ID: "KV", META_PAGE_ACCESS_TOKEN: "kv" }).find((s) => s.platform === "facebook")!;
    expect(fb.connected).toBe(false);
    expect(fb.missing).toEqual(["BRAND_3R_ZEROWASTE_META_PAGE_ID", "BRAND_3R_ZEROWASTE_META_PAGE_ACCESS_TOKEN"]);
    const ig = connectionStatus(other, db, {}).find((s) => s.platform === "instagram")!;
    expect(ig.missing).toContain("BRAND_3R_ZEROWASTE_INSTAGRAM_ACCESS_TOKEN or BRAND_3R_ZEROWASTE_META_PAGE_ACCESS_TOKEN");
  });
});

describe("X connector", () => {
  it("signs OAuth 1.0a requests (X's documented example)", async () => {
    const { oauth1Header } = await import("@/lib/publishing/connectors");
    const h = oauth1Header(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      { consumerKey: "xvz1evFS4wEEPTGEFPHBog", consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" },
      { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      "1318622958",
    );
    expect(h).toContain(`oauth_signature="${encodeURIComponent("hCtSmYh+iHYCEqBWrE7C7hYmtUk=")}"`);
  });

  it("counts X length like X does (links = 23, emoji = 2) and template copy fits", async () => {
    const { xLength, generatePlatformVersion, X_MAX } = await import("@/lib/agents/content");
    expect(xLength("hi https://example.com/a/very/long/path/that/is/long")).toBe(3 + 23);
    expect(xLength("👇")).toBe(2);
    const v = generatePlatformVersion(brand, { title: "A really long topic title about segregating household e-waste correctly at home in India", angle: "Most people mix batteries, chargers and old phones with dry waste, which makes recycling them much harder for everyone involved", pillarId: "habits", audienceQuestion: "" }, "x", "text-post");
    expect(xLength(postText({ ...piece(), platform: "x", caption: v.caption, hashtags: v.hashtags }))).toBeLessThanOrEqual(X_MAX);
  });

  it("checks length and media, then posts text with an OAuth header", async () => {
    expect(CONNECTORS.x.check(piece({ platform: "x", caption: "a".repeat(300) })).join(" ")).toMatch(/280/);
    expect(CONNECTORS.x.check(piece({ platform: "x", mediaUrls: ["https://cdn.example.com/a.jpg"] })).join(" ")).toMatch(/text only/);
    const f = fakeFetch([["api.x.com/2/tweets", () => new Response(JSON.stringify({ data: { id: "123", text: "hi" } }), { status: 201 })]]);
    const r = await CONNECTORS.x.publish(piece({ platform: "x" }), deps(f.fn, { X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_TOKEN_SECRET: "d" }));
    expect(r).toMatchObject({ externalId: "123", url: "https://x.com/i/web/status/123" });
    const init = f.calls[0]!.init!;
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^OAuth oauth_consumer_key="a"/);
    expect(JSON.parse(String(init.body)).text).toContain("#Compost");
  });
});

describe("local media files", () => {
  it("uploads a video from this computer to YouTube (Instagram images still need a public link)", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const dir = mkdtempSync(path.join(tmpdir(), "sga-media-"));
    const file = path.join(dir, "clip.mp4");
    writeFileSync(file, Buffer.from([0, 1, 2, 3, 4]));
    const yt = piece({ platform: "youtube", format: "long-video", hook: "Demo", description: "Demo video", mediaUrls: [file] });
    expect(CONNECTORS.youtube.check(yt)).toEqual([]);
    expect(CONNECTORS.youtube.check({ ...yt, mediaUrls: [path.join(dir, "missing.mp4")] }).join(" ")).toMatch(/not found/);
    // Instagram videos upload directly now; local images still need the Media Host.
    expect(CONNECTORS.instagram.check(piece({ platform: "instagram", format: "reel", mediaUrls: [file] }))).toEqual([]);
    expect(CONNECTORS.instagram.check(piece({ platform: "instagram", format: "image-post", mediaUrls: [path.join(dir, "photo.jpg")] })).join(" ")).toMatch(/once the Media Host is set up/);

    let uploaded = 0;
    const f = fakeFetch([
      ["oauth2.googleapis.com/token", () => ok({ access_token: "AT" })],
      ["uploadType=resumable", () => new Response(null, { status: 200, headers: { location: "https://upload.example/s" } })],
      ["upload.example/s", (init) => ((uploaded = (init!.body as ArrayBuffer).byteLength), ok({ id: "LOCAL1", status: { privacyStatus: "private" } }))],
    ]);
    const r = await CONNECTORS.youtube.publish(yt, deps(f.fn, { YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b", YOUTUBE_REFRESH_TOKEN: "c", YOUTUBE_PRIVACY: "private" }));
    expect(r.url).toBe("https://www.youtube.com/watch?v=LOCAL1");
    expect(uploaded).toBe(5);
    expect(f.calls.some((c) => c.url.includes("clip.mp4"))).toBe(false);
    expect((f.calls[1]!.init!.headers as Record<string, string>)["X-Upload-Content-Type"]).toBe("video/mp4");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("metrics agent", () => {
  const ytEnv = { YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b", YOUTUBE_REFRESH_TOKEN: "c" };

  it("finds platform ids from API results or pasted URLs", async () => {
    const { externalIdOf } = await import("@/lib/metrics/sync");
    expect(externalIdOf({ platform: "youtube", externalId: null, publishedUrl: "https://www.youtube.com/watch?v=TPVVXB81mz0" })).toBe("TPVVXB81mz0");
    expect(externalIdOf({ platform: "youtube", externalId: null, publishedUrl: "https://youtube.com/shorts/abcdefghijk?feature=share" })).toBe("abcdefghijk");
    expect(externalIdOf({ platform: "x", externalId: null, publishedUrl: "https://x.com/mykarmaverse/status/1850000000000000001" })).toBe("1850000000000000001");
    expect(externalIdOf({ platform: "instagram", externalId: null, publishedUrl: "https://www.instagram.com/p/abc/" })).toBeNull();
    expect(externalIdOf({ platform: "instagram", externalId: "1789", publishedUrl: null })).toBe("1789");
  });

  it("reads YouTube views and watch time and maps them to Analytics keys", async () => {
    const { FETCHERS } = await import("@/lib/metrics/sync");
    const f = fakeFetch([
      ["oauth2.googleapis.com/token", () => ok({ access_token: "AT" })],
      ["youtube/v3/videos?part=statistics", () => ok({ items: [{ statistics: { viewCount: "1200", likeCount: "80", commentCount: "9" } }] })],
      ["youtubeanalytics.googleapis.com", () => ok({ columnHeaders: ["views", "averageViewPercentage", "averageViewDuration", "estimatedMinutesWatched", "subscribersGained", "shares", "likes", "comments"].map((name) => ({ name })), rows: [[1250, 64.5, 21, 430, 12, 30, 81, 9]] })],
    ]);
    const r = await FETCHERS.youtube("VID", piece({ platform: "youtube", format: "short" }), ytEnv, deps(f.fn, ytEnv));
    expect(r.metrics).toEqual({ views: 1250, likes: 80, comments: 9, avgPercentViewed: 64.5, avgViewDurationSec: 21, subscribersGained: 12, shares: 30 });
    const { primaryScore } = await import("@/lib/analytics/metrics");
    expect(primaryScore("youtube", "short", r.metrics)).toBeCloseTo(0.645);
  });

  it("explains a missing read permission instead of failing silently", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { runMetricsSync } = await import("@/lib/metrics/sync");
    const db = buildSeed();
    db.content = [piece({ id: "yt1", platform: "youtube", format: "short", status: "published", externalId: "VID", history: [{ at: new Date().toISOString(), from: "scheduled", to: "published", by: "x", note: "" }] })];
    await writeDbForTests(db);
    const insufficient = () => new Response(JSON.stringify({ error: { message: "Request had insufficient authentication scopes." } }), { status: 403 });
    const f = fakeFetch([
      ["oauth2.googleapis.com/token", () => ok({ access_token: "AT" })],
      ["youtube/v3/videos", insufficient],
      ["youtubeanalytics", insufficient],
    ]);
    const r = await runMetricsSync({ deps: deps(f.fn, { KARMAVERSE_YOUTUBE_CLIENT_ID: "a", KARMAVERSE_YOUTUBE_CLIENT_SECRET: "b", KARMAVERSE_YOUTUBE_REFRESH_TOKEN: "c" }) });
    expect(r.failed).toBe(1);
    expect(r.notes.join(" ")).toMatch(/insufficient authentication scopes/);
    expect((await readDb()).settings.lastMetricsSync).toMatchObject({ failed: 1 });
  });

  it("keeps one row per post, refreshes it, and falls back to basic Instagram metrics", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { runMetricsSync } = await import("@/lib/metrics/sync");
    const db = buildSeed();
    const published = [{ at: new Date().toISOString(), from: "scheduled" as const, to: "published" as const, by: "x", note: "" }];
    db.content = [
      piece({ id: "ig1", platform: "instagram", format: "reel", status: "published", externalId: "M1", history: published }),
      piece({ id: "x1", platform: "x", format: "text-post", status: "published", publishedUrl: "https://x.com/a/status/42", history: published }),
      piece({ id: "fb1", status: "published", externalId: "P_1", history: published }),
    ];
    await writeDbForTests(db);
    let likes = 10;
    const f = fakeFetch([
      ["ig_reels_avg_watch_time", () => new Response(JSON.stringify({ error: { message: "(#100) metric not supported" } }), { status: 400 })],
      ["/M1/insights", () => ok({ data: [{ name: "reach", values: [{ value: 1000 }] }, { name: "likes", total_value: { value: likes } }, { name: "saved", values: [{ value: 7 }] }] })],
      ["api.x.com/2/tweets/42", () => ok({ data: { public_metrics: { impression_count: 500, like_count: 5, retweet_count: 1, quote_count: 1, reply_count: 2, bookmark_count: 3 } } })],
    ]);
    const env = { KARMAVERSE_INSTAGRAM_ACCOUNT_ID: "IG", KARMAVERSE_INSTAGRAM_ACCESS_TOKEN: "t", KARMAVERSE_X_API_KEY: "a", KARMAVERSE_X_API_SECRET: "b", KARMAVERSE_X_ACCESS_TOKEN: "c", KARMAVERSE_X_ACCESS_TOKEN_SECRET: "d" };
    const r1 = await runMetricsSync({ deps: deps(f.fn, env) });
    expect(r1).toMatchObject({ updated: 2, skipped: 1 }); // Facebook isn't connected
    likes = 25;
    await runMetricsSync({ deps: deps(f.fn, env) });
    const after = await readDb();
    const ig = after.metrics.filter((m) => m.contentId === "ig1");
    expect(ig).toHaveLength(1);
    expect(ig[0]).toMatchObject({ source: "api", metrics: { reach: 1000, likes: 25, saves: 7 } });
    expect(after.metrics.find((m) => m.contentId === "x1")!.metrics).toEqual({ impressions: 500, likes: 5, reposts: 2, replies: 2, bookmarks: 3 });

    // Once real rows exist, analysis leaves the sample rows out.
    const { analysisMetrics } = await import("@/lib/analytics/engine");
    const used = analysisMetrics(after.metrics, brand.id);
    expect(used.every((m) => !m.isSample)).toBe(true);
    expect(analysisMetrics(buildSeed().metrics, brand.id).length).toBe(buildSeed().metrics.length);
  });
});
