import { describe, expect, it } from "vitest";
import { buildSeed } from "@/lib/sample-data";
import type { LlmClient } from "@/lib/llm/anthropic";
import type { ChatVideo } from "@/lib/schemas";

const fake = (...answers: unknown[]): LlmClient & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    complete: async ({ user }) => {
      calls.push(user);
      return JSON.stringify(answers[Math.min(calls.length - 1, answers.length - 1)]);
    },
  };
};

describe("Chat", () => {
  it("checks scripts per kind, including the cartoon line count", async () => {
    const { checkScript } = await import("@/lib/chat/agent");
    expect(checkScript("quiz", { hook: "Only 1 in 10 get this!", question: "Where does a chai cup go?", options: ["Wet", "Dry", "Neither"], answer: 1, explain: "Paper cups go in dry waste." }).ok).toBe(true);
    expect(checkScript("explainer", { hook: "3 kitchen swaps", points: ["Steel box"] }).ok).toBe(false);
    const bad = checkScript("cartoon", { story: "garmi", title_small: "Garmi", title_big: "BIJLI BACHAO", lines: Array.from({ length: 6 }, () => ({ say: "नमस्ते दोस्तों", sub: "Namaste dosto" })) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/needs exactly 7 lines/);
  });

  it("ends every chat video with both app stores", async () => {
    const { explainerScenes, seriesScenes, CHAT_CTA } = await import("@/lib/chat/agent");
    const brand = buildSeed().brands[0]!;
    const ex = explainerScenes({ hook: "3 swaps for your kitchen", points: ["Steel dabba", "Cloth bag"], question: "Which one do you use?" });
    expect(ex.map((s) => s.kind)).toEqual(["hook", "point", "point", "question", "cta"]);
    expect(ex.at(-1)?.text).toBe(CHAT_CTA.text);
    const hack = seriesScenes(brand, "hack", { hook: "Cut your bill in 3 steps", steps: ["Switch off at the plug", "Use the fan, not AC"], payoff: "Lower bill" });
    expect(hack.at(-1)?.text).toMatch(/App Store or Google Play/);
  });

  it("answers with ideas, then posts the latest video for review", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { addChatMessage, runChatTurn } = await import("@/lib/chat/agent");
    const db = buildSeed();
    const brand = db.brands[0]!;
    db.content = [];
    db.competitors = [{ id: "cmp_1", brandId: brand.id, name: "Green Rivals", instagram: "greenrivals", youtube: "", website: "", notes: "", profiles: [], lastSyncAt: null, lastSyncNotes: [], createdAt: "2026-11-01T00:00:00.000Z" }];
    await writeDbForTests(db);

    // 1. Ideas
    const first = await addChatMessage(brand.id, null, "What should we make this week?", "Om");
    const ideas = fake({ reply: "Here are 2 ideas.", action: { type: "suggest_ideas", ideas: [{ title: "Chai cup quiz", kind: "quiz", hook: "Where does your chai cup go?", why: "Quizzes get 2x comments for Green Rivals", inspiredBy: "Green Rivals quiz reel" }, { title: "Monsoon hack", kind: "hack" }] } });
    await runChatTurn(first.chatId, first.replyId, ideas);
    expect(ideas.calls[0]).toMatch(/COMPETITORS WATCHED: Green Rivals/);
    let after = await readDb();
    let chat = after.chats.find((c) => c.id === first.chatId)!;
    expect(chat.title).toBe("What should we make this week?");
    expect(chat.messages.at(-1)).toMatchObject({ status: "done", text: "Here are 2 ideas." });
    expect(chat.messages.at(-1)!.ideas.map((i) => i.title)).toEqual(["Chai cup quiz", "Monsoon hack"]);

    // 2. Posting with no video yet is refused politely.
    const second = await addChatMessage(brand.id, first.chatId, "Post it on Instagram", "Om");
    const post = { reply: "Posted for review.", action: { type: "post_video", platforms: ["instagram", "youtube"], date: "2099-01-05", time: "19:00", copy: { instagram: { hook: "Chai cup quiz", caption: "Where does it go? 👇", hashtags: ["#KarmaVerse"] }, youtube: { hook: "Chai cup quiz #Shorts", description: "Answer in the comments." } } } };
    await runChatTurn(second.chatId, second.replyId, fake(post));
    after = await readDb();
    expect(after.chats[0]!.messages.at(-1)!.text).toMatch(/no finished video/);
    expect(after.content).toHaveLength(0);

    // 3. With a finished video in the chat, posts are created in review (never live).
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "chatvid-")), "buddy_test.mp4");
    writeFileSync(file, "x");
    const video: ChatVideo = { kind: "quiz", script: "{}", topic: "Chai cup quiz", character: "dadi", file, durationSec: 24, credit: "Music: test (CC BY 4.0)" };
    after.chats[0]!.messages[1]!.video = video;
    await writeDbForTests(after);
    const third = await addChatMessage(brand.id, first.chatId, "Post it on Instagram and YouTube", "Om");
    await runChatTurn(third.chatId, third.replyId, fake(post));
    after = await readDb();
    chat = after.chats[0]!;
    expect(chat.messages.at(-1)!.postIds).toHaveLength(2);
    const [ig, yt] = after.content;
    expect(ig).toMatchObject({ platform: "instagram", format: "reel", status: "needs-review", mediaUrls: [file], plannedDate: "2099-01-05", plannedTime: "19:00", character: "dadi" });
    expect(ig!.caption).toMatch(/Where does it go\?[\s\S]*Music: test/);
    expect(yt).toMatchObject({ platform: "youtube", format: "short", hook: "Chai cup quiz #Shorts" });
    expect(yt!.description).toMatch(/Music: test/);
  });

  it("asks Claude once more when a script doesn't fit, and fails cleanly after that", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { addChatMessage, runChatTurn } = await import("@/lib/chat/agent");
    const db = buildSeed();
    await writeDbForTests(db);
    const r = await addChatMessage(db.brands[0]!.id, null, "Make a cartoon", "Om");
    const client = fake({ reply: "Making it.", action: { type: "make_video", kind: "cartoon", topic: "heat", script: { story: "garmi", title_small: "x", title_big: "yy", lines: [] } } });
    await runChatTurn(r.chatId, r.replyId, client);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]).toMatch(/COULD NOT BE USED/);
    const m = (await readDb()).chats[0]!.messages.at(-1)!;
    expect(m.status).toBe("failed");
    expect(m.error).toMatch(/didn't fit the cartoon format/);
  });

  it("reports a Claude failure on the message instead of hanging", async () => {
    const { writeDbForTests, readDb } = await import("@/lib/db");
    const { addChatMessage, runChatTurn } = await import("@/lib/chat/agent");
    const db = buildSeed();
    await writeDbForTests(db);
    const r = await addChatMessage(db.brands[0]!.id, null, "hello", "Om");
    await runChatTurn(r.chatId, r.replyId, { complete: async () => { throw new Error("signed out"); } });
    const m = (await readDb()).chats[0]!.messages.at(-1)!;
    expect(m).toMatchObject({ status: "failed" });
    expect(m.error).toMatch(/signed out/);
  });
});

describe("Sign-in lockout", () => {
  it("locks an address after 5 wrong codes for 15 minutes, and everyone after 30 an hour", async () => {
    const { LoginThrottle } = await import("@/lib/auth");
    const t = new LoginThrottle();
    const now = 1_000_000_000;
    for (let i = 0; i < 4; i++) t.fail("1.1.1.1", now);
    expect(t.waitMinutes("1.1.1.1", now)).toBe(0);
    t.fail("1.1.1.1", now);
    expect(t.waitMinutes("1.1.1.1", now)).toBe(15);
    expect(t.waitMinutes("1.1.1.1", now + 15 * 60_000)).toBe(0);
    expect(t.waitMinutes("2.2.2.2", now)).toBe(0);
    for (let i = 0; i < 30; i++) t.fail(`10.0.0.${i}`, now);
    expect(t.waitMinutes("3.3.3.3", now)).toBeGreaterThan(0);
    const fresh = new LoginThrottle();
    fresh.fail("4.4.4.4", now);
    fresh.success("4.4.4.4");
    expect(fresh.waitMinutes("4.4.4.4", now)).toBe(0);
  });

  it("reads the visitor address from Cloudflare first", async () => {
    const { clientIp } = await import("@/lib/auth");
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(clientIp(h({ "cf-connecting-ip": "5.5.5.5", "x-forwarded-for": "6.6.6.6" }))).toBe("5.5.5.5");
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 7.7.7.7" }))).toBe("6.6.6.6");
    expect(clientIp(h({}))).toBe("local");
  });
});
