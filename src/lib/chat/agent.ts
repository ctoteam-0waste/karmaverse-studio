import { existsSync } from "node:fs";
import { z } from "zod";
import { dataFile, mutate, readDb } from "../db";
import { logger } from "../logger";
import { claudeClient, type LlmClient } from "../llm/anthropic";
import { parseJsonResult } from "../llm/json";
import { brandContext } from "../llm/prompts";
import { addDays, newId, nowIso, todayIst } from "../util";
import { ChatIdeaSchema, ContentPieceSchema, type Brand, type Chat, type ChatMessage, type ChatVideo, type ChatVideoKind, type ContentPiece, type Database } from "../schemas";
import { CARTOON_STORIES, ENGAGEMENT_RULES, ScriptSchemas, renderCartoon, scenesFromScript, type SeriesScript } from "../video/series";
import { BUDDY_STYLES, brandAssets, pickLook, pickMusic, renderBuddy, speakable, tidy, type BuddyScene, type Look } from "../video/buddy";
import { CHARACTERS, characterById, pickCharacter } from "../video/characters";
import { videosDir } from "../video/maker";
import { exclusiveRender } from "../video/render-lock";
import { musicDir, readLibrary } from "../music/agent";
import { competitorReport } from "../competitors/agent";
import { plannedInstant } from "../publishing/agent";

const log = logger("chat");

/**
 * Chat: make, change and post videos by talking.
 *
 * A team member writes in plain words ("make a 30-second quiz about Diwali waste",
 * "use Dadi and make it shorter", "post it on Instagram and YouTube tomorrow at 7",
 * "what should we make this week, like our competitors?"). Claude answers with a
 * reply and at most one action; this file carries it out:
 * - make_video: writes the script and renders it with the existing renderers
 *   (Earth Buddy series styles, explainers, cartoon stories). A change request is
 *   just a new make_video with an edited script.
 * - post_video: creates one post per platform with the latest video, in review.
 *   Nothing goes live until someone presses Approve.
 * - suggest_ideas: video ideas grounded in competitor results and trends, each
 *   with a "Make this" button in the chat.
 */

export const ExplainerSchema = z.object({
  hook: z.string().min(3).max(140),
  points: z.array(z.string().min(3).max(140)).min(2).max(5),
  question: z.string().min(3).max(140).optional(),
  style: z.enum(BUDDY_STYLES).optional(),
});
export type ExplainerScript = z.infer<typeof ExplainerSchema>;

const KIND_SCHEMAS: Record<ChatVideoKind, z.ZodTypeAny> = {
  quiz: ScriptSchemas.quiz,
  myth: ScriptSchemas.myth,
  hack: ScriptSchemas.hack,
  cartoon: ScriptSchemas.cartoon,
  explainer: ExplainerSchema,
};

const KINDS = ["quiz", "myth", "hack", "cartoon", "explainer"] as const;
const POST_PLATFORMS = ["instagram", "facebook", "youtube"] as const;
type PostPlatform = (typeof POST_PLATFORMS)[number];

const PostCopySchema = z.object({
  hook: z.string().default(""),
  caption: z.string().default(""),
  description: z.string().default(""),
  hashtags: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
});

export const ChatActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("make_video"), kind: z.enum(KINDS), topic: z.string().default(""), character: z.string().optional(), script: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal("post_video"),
    platforms: z.array(z.enum(POST_PLATFORMS)).min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    copy: z.record(z.string(), PostCopySchema).default({}),
  }),
  z.object({ type: z.literal("suggest_ideas"), ideas: z.array(ChatIdeaSchema).min(1).max(8) }),
]);
export type ChatAction = z.infer<typeof ChatActionSchema>;

export const ChatAnswerSchema = z.object({ reply: z.string().min(1), action: ChatActionSchema.nullable().default(null) });
export type ChatAnswer = z.infer<typeof ChatAnswerSchema>;

/** The closing line of every chat video now that the app is on both stores. */
export const CHAT_CTA = { say: "Search KarmaVerse on the App Store or Google Play, and make every sustainable gesture count!", text: "Search KarmaVerse on the App Store or Google Play!", button: "Get KarmaVerse: App Store & Google Play" };

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

const SHAPES: Record<ChatVideoKind, string> = {
  quiz: '{"hook":"a challenge line","question":"the quiz question","options":["A","B","C"],"answer":1,"explain":"why, in one short sentence"}  (about 25 s)',
  myth: '{"hook":"e.g. 2 myths about X you still believe","pairs":[{"myth":"...","fact":"..."}]}  (1-2 pairs, 20-25 s)',
  hack: '{"hook":"e.g. Cut your bill in 3 steps","steps":["step 1","step 2","step 3"],"payoff":"the result"}  (2-4 steps, 20-25 s)',
  cartoon: '{"story":"<story id>","title_small":"small top title","title_big":"BIG TITLE (2-3 words)","headline":"(battery only)","happy_1":"(battery/subah/plastic) big word","happy_2":"big word","lines":[{"say":"spoken line","sub":"subtitle"}]}  (animated cartoon with Earth Buddy and two kids, 25-40 s; the number of lines must match the story)',
  explainer: '{"hook":"opening line","points":["2-5 short points"],"question":"a question for the comments","style":"cards|kinetic|list|phone|chat|notes"}  (Earth Buddy explainer, 20-35 s; style: cards = numbers count up, kinetic = big bold words, list = step list, phone = real app screens, chat = chat bubbles, notes = handwritten notes)',
};

export const CHAT_SYSTEM = `You are the video producer inside KarmaVerse Studio. Team members chat with you to make short vertical videos, change them, post them, and get ideas. Reply like a friendly colleague: short, clear, plain words (English, Hindi or Hinglish, matching the person).

You can do ONE action per answer:
1. {"type":"make_video","kind":"quiz|myth|hack|cartoon|explainer","topic":"...","character":"<host id, optional>","script":{...}}
   Makes a new video. To CHANGE the current video ("shorter", "use Dadi", "change the ending", "more Hindi"), send make_video again with the edited script; keep everything they didn't ask to change.
2. {"type":"post_video","platforms":["instagram","facebook","youtube"],"date":"YYYY-MM-DD","time":"HH:MM","copy":{"instagram":{"hook":"...","caption":"...","hashtags":["#..."]},"facebook":{"caption":"...","hashtags":[]},"youtube":{"hook":"title under 70 characters","description":"...","hashtags":["#Shorts"],"keywords":["..."]}}}
   Only when they ask to post and the chat already has a finished video. Uses the latest video. Pick a free slot from the calendar (14:00 or 19:00 IST) unless they give a time; never a time in the past. Posts go to review: tell them to press Approve in the chat.
3. {"type":"suggest_ideas","ideas":[{"title":"...","kind":"quiz|myth|hack|cartoon|explainer","hook":"the first line people hear","why":"why it should work, citing the competitor post or trend","inspiredBy":"competitor name + their post, or trend, or ''"}]}
   When they ask what to make, or for ideas like competitors. 3-6 ideas. Learn from what works for competitors (formats, hooks, topics) but never copy their words; make it ours.
Or no action ("action": null) for questions, or when something is unclear (ask ONE short question).

VIDEO SCRIPT SHAPES:
${KINDS.map((k) => `- ${k}: ${SHAPES[k]}`).join("\n")}
Every line shown on screen must be under 16 words. Do not add a closing call-to-action line: the app adds "Search KarmaVerse on the App Store or Google Play" at the end.

CARTOON STORIES (pick the one whose scenes fit; write one line per scene in order):
${Object.entries(CARTOON_STORIES).map(([k, s]) => `- ${k} (${s.lines} lines, ${s.about}): ${s.scenes.join("; ")}`).join("\n")}
Cartoon lines: under 15 words; "say" is spoken (Hindi in Devanagari, or English if they asked for English), "sub" is the subtitle in Latin letters.

HOSTS (character ids): ${CHARACTERS.map((c) => `${c.id} = ${c.name}: ${c.about}`).join("; ")}

${ENGAGEMENT_RULES}

RULES:
- Never invent statistics, reward amounts, partner names or app features beyond the brand facts. If the person gives a fact, you may use it.
- Climate-action framing; keep doorstep pickup out of hooks unless they ask for it. No politics.
- Keep "reply" under 70 words. Say what you made or changed. Rendering takes 1-5 minutes; the chat shows the video when ready.

RETURN ONLY JSON: {"reply":"...","action":{...} or null}`;

function fmtVideo(v: ChatVideo): string {
  return `[video kind=${v.kind}${v.character ? ` host=${v.character}` : ""}${v.durationSec ? ` ${v.durationSec}s` : ""}${v.file ? "" : " (not rendered)"}] script=${v.script}`;
}

/** What Claude sees besides the system prompt. */
export function chatContext(db: Database, brand: Brand, chat: Chat, now = new Date()): string {
  const today = todayIst(now);
  const report = competitorReport(brand, db.competitors, db.competitorPosts, { content: db.content, metrics: db.metrics }, now);
  const comp = db.competitors.filter((c) => c.brandId === brand.id);
  const competitors = comp.length
    ? [
        `COMPETITORS WATCHED: ${comp.map((c) => c.name).join(", ")}`,
        report.insights.length ? `INSIGHTS:\n${report.insights.map((i) => `- ${i}`).join("\n")}` : "",
        report.top.length ? `THEIR BEST POSTS (engagement vs their usual):\n${report.top.slice(0, 10).map((t) => `- ${t.competitor.name} ${t.post.platform} ${t.post.format} x${t.lift.toFixed(1)}: "${t.post.hook.slice(0, 120)}"`).join("\n")}` : "THEIR POSTS: not synced yet",
        report.formats.length ? `FORMATS THAT WIN: ${report.formats.slice(0, 5).map((f) => `${f.platform} ${f.format} x${f.lift.toFixed(1)}`).join(", ")}` : "",
        report.hooks.length ? `HOOK PATTERNS THAT WIN: ${report.hooks.slice(0, 5).map((h) => `${h.pattern} x${h.lift.toFixed(1)}`).join(", ")}` : "",
      ].filter(Boolean)
    : ["COMPETITORS: none added yet (ideas come from trends and our own results)."];
  const trends = db.trends
    .filter((t) => t.brandId === brand.id && t.status === "new")
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((t) => `- ${t.title}`);
  const recent = db.content
    .filter((c) => c.brandId === brand.id && c.status === "published")
    .sort((a, b) => (b.plannedDate ?? "").localeCompare(a.plannedDate ?? ""))
    .slice(0, 12)
    .map((c) => `- ${c.plannedDate} ${c.platform}: ${c.topic}`);
  const busy: string[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(today, i);
    const taken = db.content
      .filter((c) => c.brandId === brand.id && c.plannedDate === day && ["approved", "scheduled", "needs-review", "published"].includes(c.status) && POST_PLATFORMS.includes(c.platform as PostPlatform))
      .map((c) => `${c.platform} ${c.plannedTime ?? ""}`);
    busy.push(`- ${day}: ${taken.join(", ") || "free"}`);
  }
  const history = chat.messages
    .filter((m) => m.status !== "working")
    .slice(-14)
    .map((m) => (m.role === "user" ? `USER (${m.by || "team"}): ${m.text}` : `YOU: ${m.text}${m.video ? `\n  ${fmtVideo(m.video)}` : ""}${m.ideas.length ? `\n  ideas: ${m.ideas.map((i) => i.title).join(" | ")}` : ""}${m.postIds.length ? `\n  posts created: ${m.postIds.length}` : ""}`));
  return [
    brandContext(brand),
    "",
    `NOW (IST): ${today} ${new Date(now.getTime() + 330 * 60_000).toISOString().slice(11, 16)}`,
    ...competitors,
    `TRENDS:\n${trends.join("\n") || "- none"}`,
    `OUR RECENT POSTS (avoid repeating):\n${recent.join("\n") || "- none"}`,
    `CALENDAR, NEXT 7 DAYS (instagram/facebook/youtube posts already planned):\n${busy.join("\n")}`,
    "",
    `CONVERSATION SO FAR:\n${history.join("\n")}`,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Scripts and scenes                                                  */
/* ------------------------------------------------------------------ */

/** Checks a script against its kind; returns the error to send back to Claude. */
export function checkScript(kind: ChatVideoKind, script: unknown): { ok: true; script: unknown } | { ok: false; error: string } {
  const r = KIND_SCHEMAS[kind].safeParse(script);
  if (!r.success) return { ok: false, error: r.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || kind}: ${i.message}`).join("; ") };
  if (kind === "cartoon") {
    const s = r.data as SeriesScript<"cartoon">;
    const need = CARTOON_STORIES[s.story].lines;
    if (s.lines.length !== need) return { ok: false, error: `cartoon story "${s.story}" needs exactly ${need} lines, got ${s.lines.length}` };
  }
  return { ok: true, script: r.data };
}

const ctaScene = (): BuddyScene => ({ kind: "cta", text: CHAT_CTA.text, say: CHAT_CTA.say });

export function explainerScenes(s: ExplainerScript): BuddyScene[] {
  const scenes: BuddyScene[] = [{ kind: "hook", text: tidy(s.hook), say: speakable(s.hook) }];
  for (const p of s.points) scenes.push({ kind: "point", text: tidy(p), say: speakable(p) });
  if (s.question) scenes.push({ kind: "question", text: tidy(s.question), say: speakable(s.question) });
  scenes.push(ctaScene());
  return scenes;
}

/** Series scenes with the chat's closing line (both app stores). */
export function seriesScenes(brand: Brand, kind: "quiz" | "myth" | "hack", script: unknown) {
  const scenes = scenesFromScript(brand, kind, script as SeriesScript);
  if (scenes.at(-1)?.kind === "cta") scenes[scenes.length - 1] = ctaScene() as never;
  return scenes;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

async function renderChatVideo(db: Database, brand: Brand, kind: ChatVideoKind, script: unknown, topic: string, wanted?: string) {
  const tracks = (await readLibrary(musicDir(dataFile()))).filter((t) => existsSync(t.file));
  const history = db.settings.videoLooks as Look[];
  const out = { outDir: videosDir(dataFile()), dataFile: dataFile() };
  if (kind === "cartoon") {
    const music = pickMusic(tracks, "kinetic", `playful ${topic}`, history);
    const r = await exclusiveRender(() => renderCartoon(brand, script as SeriesScript<"cartoon">, { ...out, music, ctaTop: "KarmaVerse download karo!", ctaButton: "App Store & Google Play" }));
    return { file: r.file, durationSec: r.durationSec, character: "earth-buddy", look: { style: "cartoon", theme: "story", layout: "center", music }, credit: tracks.find((t) => t.file === music)?.credit ?? "" };
  }
  const character = pickCharacter(history.map((l) => l.character), wanted && characterById(wanted) ? wanted : null);
  let scenes: BuddyScene[];
  let look: Look & { style: string };
  if (kind === "explainer") {
    const s = script as ExplainerScript;
    scenes = explainerScenes(s);
    const picked = pickLook(history, s.style ?? "auto", scenes, tracks.map((t) => t.file), brandAssets(brand, dataFile()).screens.length > 0);
    look = { ...picked, music: pickMusic(tracks, picked.style, topic, history) };
  } else {
    scenes = seriesScenes(brand, kind, script) as never;
    const picked = pickLook(history, "auto", scenes, tracks.map((t) => t.file), false);
    look = { ...picked, style: kind, music: pickMusic(tracks, picked.style, `${kind} ${topic}`, history) } as never;
  }
  const r = await exclusiveRender(() => renderBuddy(brand, scenes, look as never, { ...out, ticker: topic, character, ctaButton: CHAT_CTA.button }));
  return { file: r.file, durationSec: r.durationSec, character, look, credit: tracks.find((t) => t.file === look.music)?.credit ?? "" };
}

/* ------------------------------------------------------------------ */
/* Posts                                                               */
/* ------------------------------------------------------------------ */

const FORMAT: Record<PostPlatform, "reel" | "short"> = { instagram: "reel", facebook: "reel", youtube: "short" };

export function postsFromVideo(brand: Brand, video: ChatVideo, action: Extract<ChatAction, { type: "post_video" }>, by: string, now = nowIso()): ContentPiece[] {
  return action.platforms.map((platform) => {
    const c = PostCopySchema.parse(action.copy[platform] ?? {});
    const credit = video.credit ? `\n\n${video.credit}` : "";
    const hook = (c.hook || video.topic || "New video").slice(0, platform === "youtube" ? 100 : 300);
    return ContentPieceSchema.parse({
      id: newId("post"),
      brandId: brand.id,
      platform,
      format: FORMAT[platform],
      pillarId: brand.pillars[0]?.id ?? "general",
      topic: video.topic || hook,
      hook,
      caption: platform === "youtube" ? "" : `${c.caption.trim() || hook}${credit}`,
      description: platform === "youtube" ? `${c.description.trim()}${credit}` : "",
      hashtags: c.hashtags,
      keywords: c.keywords,
      mediaUrls: [video.file],
      plannedDate: action.date,
      plannedTime: action.time,
      status: "needs-review",
      generatedBy: "anthropic",
      character: video.character || undefined,
      history: [{ at: now, from: "draft", to: "needs-review", by, note: "Made in Chat." }],
      createdAt: now,
      updatedAt: now,
    });
  });
}

/* ------------------------------------------------------------------ */
/* Running a turn                                                      */
/* ------------------------------------------------------------------ */

/** Adds the person's message and a working reply; returns their ids. */
export async function addChatMessage(brandId: string, chatId: string | null, text: string, by: string): Promise<{ chatId: string; replyId: string }> {
  const at = nowIso();
  return mutate((db) => {
    let chat = chatId ? db.chats.find((c) => c.id === chatId && c.brandId === brandId) : undefined;
    if (!chat) {
      chat = { id: newId("chat"), brandId, title: text.replace(/\s+/g, " ").trim().slice(0, 60), createdBy: by, createdAt: at, updatedAt: at, messages: [] };
      db.chats = [...db.chats, chat].slice(-100);
    }
    const reply: ChatMessage = { id: newId("msg"), role: "assistant", text: "", by: "Claude", at, status: "working", progress: "Thinking…", video: null, ideas: [], postIds: [], error: "" };
    chat.messages.push({ id: newId("msg"), role: "user", text: text.trim(), by, at, status: "done", progress: "", video: null, ideas: [], postIds: [], error: "" }, reply);
    chat.updatedAt = at;
    return { chatId: chat.id, replyId: reply.id };
  });
}

async function patchReply(chatId: string, replyId: string, patch: Partial<ChatMessage>, extra?: (db: Database) => void) {
  await mutate((db) => {
    const chat = db.chats.find((c) => c.id === chatId);
    const m = chat?.messages.find((x) => x.id === replyId);
    if (!chat || !m) return;
    Object.assign(m, patch);
    chat.updatedAt = nowIso();
    extra?.(db);
  });
}

async function ask(client: LlmClient, db: Database, brand: Brand, chat: Chat, fix?: string): Promise<ChatAnswer> {
  const user = `${chatContext(db, brand, chat)}${fix ? `\n\nYOUR LAST ANSWER COULD NOT BE USED: ${fix}\nReturn corrected JSON.` : ""}`;
  const text = await client.complete({ system: CHAT_SYSTEM, user, maxTokens: 3000 });
  try {
    return parseJsonResult(text, ChatAnswerSchema);
  } catch (err) {
    // Claude sometimes answers in plain words (e.g. for a request no action covers).
    // Ask once more for JSON; if it still writes prose, show the prose as the reply.
    if (!/No JSON found/.test((err as Error).message) || !text.trim()) throw err;
    if (fix !== NO_JSON) return ask(client, db, brand, chat, NO_JSON);
    return { reply: text.trim().slice(0, 3000), action: null };
  }
}

const NO_JSON = "it was plain text. Reply ONLY with the JSON object {\"reply\": ..., \"action\": ... or null}; put any explanation inside \"reply\".";

const running = new Set<string>();

/** Answers the latest message in a chat: asks Claude, then makes the video, posts or ideas. */
export async function runChatTurn(chatId: string, replyId: string, client: LlmClient = claudeClient()): Promise<void> {
  if (running.has(replyId)) return;
  running.add(replyId);
  try {
    const db = await readDb();
    const chat = db.chats.find((c) => c.id === chatId);
    const brand = db.brands.find((b) => b.id === chat?.brandId);
    if (!chat || !brand) return;
    const by = [...chat.messages].reverse().find((m) => m.role === "user")?.by || "team";

    let answer: ChatAnswer;
    try {
      answer = await ask(client, db, brand, chat);
      // One retry when the script doesn't fit its shape.
      if (answer.action?.type === "make_video") {
        const chk = checkScript(answer.action.kind, answer.action.script);
        if (!chk.ok) answer = await ask(client, db, brand, chat, chk.error);
      }
    } catch (err) {
      const message = (err as Error).message;
      log.error("Chat answer failed", { chatId, error: message });
      return patchReply(chatId, replyId, { status: "failed", progress: "", error: `Claude couldn't answer: ${message.slice(0, 300)}` });
    }

    const a = answer.action;
    if (!a) return patchReply(chatId, replyId, { status: "done", progress: "", text: answer.reply });

    if (a.type === "suggest_ideas") return patchReply(chatId, replyId, { status: "done", progress: "", text: answer.reply, ideas: a.ideas });

    if (a.type === "post_video") {
      const latest = [...chat.messages].reverse().find((m) => m.video?.file && existsSync(m.video.file))?.video;
      if (!latest) return patchReply(chatId, replyId, { status: "done", progress: "", text: "There's no finished video in this chat yet. Ask me to make one first." });
      const when = plannedInstant({ plannedDate: a.date, plannedTime: a.time });
      if (when && when.getTime() < Date.now()) return patchReply(chatId, replyId, { status: "done", progress: "", text: `${a.date} ${a.time} has already passed. Tell me a later time.` });
      const posts = postsFromVideo(brand, latest, a, by);
      return patchReply(chatId, replyId, { status: "done", progress: "", text: answer.reply, postIds: posts.map((p) => p.id) }, (d) => {
        d.content.push(...posts);
      });
    }

    // make_video
    const chk = checkScript(a.kind, a.script);
    if (!chk.ok) return patchReply(chatId, replyId, { status: "failed", progress: "", text: answer.reply, error: `The script didn't fit the ${a.kind} format: ${chk.error}. Try asking again in other words.` });
    const video: ChatVideo = { kind: a.kind, script: JSON.stringify(chk.script), topic: a.topic, character: a.character ?? "", file: "", durationSec: null, credit: "" };
    await patchReply(chatId, replyId, { text: answer.reply, video, progress: a.kind === "cartoon" ? "Animating the cartoon (about 3-6 minutes)…" : "Making the video (about 1-3 minutes)…" });
    try {
      const r = await renderChatVideo(db, brand, a.kind, chk.script, a.topic, a.character);
      await patchReply(chatId, replyId, { status: "done", progress: "", video: { ...video, file: r.file, durationSec: r.durationSec, character: r.character, credit: r.credit } }, (d) => {
        d.settings.videoLooks = [...d.settings.videoLooks, { ...r.look, character: r.character, at: nowIso(), file: r.file }].slice(-50);
      });
      log.info("Chat video made", { chatId, kind: a.kind, file: r.file });
    } catch (err) {
      const message = (err as Error).message;
      log.error("Chat video failed", { chatId, error: message });
      await patchReply(chatId, replyId, { status: "failed", progress: "", error: `The video couldn't be made: ${message.slice(0, 300)}` });
    }
  } finally {
    running.delete(replyId);
  }
}

/** A message still "working" this long after it started was cut off (the app restarted). */
export const STALE_MS = 25 * 60 * 1000;
export const isStale = (m: Pick<ChatMessage, "status" | "at">, now = Date.now()) => m.status === "working" && now - Date.parse(m.at) > STALE_MS;
