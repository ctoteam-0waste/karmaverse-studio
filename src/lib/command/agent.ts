import { z } from "zod";
import { mutate, readDb } from "../db";
import { logger } from "../logger";
import { claudeClient, type LlmClient } from "../llm/anthropic";
import { parseJsonResult } from "../llm/json";
import { plannedInstant } from "../publishing/agent";
import { CHARACTERS, CHARACTER_IDS } from "../video/characters";
import { newId, nowIso, todayIst } from "../util";
import type { Brand, Command, CommandChange, ContentPiece, Database } from "../schemas";

const log = logger("command");

/**
 * "Tell the team": a person types what they want in the app ("more Hindi videos",
 * "goal: 500 Instagram followers by 31 Dec", "move tomorrow's reel to 7 pm", "use Dadi
 * in the next myth video"). Claude turns it into a short list of allowed actions; this
 * file applies them and records how to undo each one.
 *
 * Safety: only the actions below exist. Publishing still follows the approval rules: an
 * edit to an approved or scheduled post sends it back to review, so nothing new goes
 * live without a person approving it.
 */

const BRAND_LISTS = ["voice", "avoid", "languages", "hashtags", "defaultCtas", "audience"] as const;
type BrandList = (typeof BRAND_LISTS)[number];
const AGENTS = ["tracking", "growth", "blog", "trends", "metrics", "community", "media", "publishing"] as const;

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_instruction"), text: z.string().min(3) }),
  z.object({ type: z.literal("remove_instruction"), id: z.string() }),
  z.object({ type: z.literal("add_goal"), text: z.string().min(3) }),
  z.object({ type: z.literal("remove_goal"), id: z.string() }),
  z.object({ type: z.literal("brand_add"), field: z.enum(BRAND_LISTS), value: z.string().min(1) }),
  z.object({ type: z.literal("brand_remove"), field: z.enum(BRAND_LISTS), value: z.string().min(1) }),
  z.object({ type: z.literal("set_auto_publish"), on: z.boolean() }),
  z.object({ type: z.literal("set_auto_reply"), mode: z.enum(["off", "safe"]) }),
  z.object({ type: z.literal("add_trend_note"), text: z.string().min(3) }),
  z.object({ type: z.literal("add_idea"), title: z.string().min(3), angle: z.string().default(""), pillarId: z.string().default("") }),
  z.object({
    type: z.literal("edit_post"),
    id: z.string(),
    hook: z.string().optional(),
    caption: z.string().optional(),
    description: z.string().optional(),
    plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    plannedTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
    character: z.enum(CHARACTER_IDS as [string, ...string[]]).optional(),
  }),
  z.object({ type: z.literal("run_agent"), agent: z.enum(AGENTS) }),
]);
export type CommandAction = z.infer<typeof ActionSchema>;

export const CommandAnswerSchema = z.object({
  reply: z.string().default(""),
  actions: z.array(ActionSchema).max(25).default([]),
});

const EDITABLE: ContentPiece["status"][] = ["draft", "needs-review", "approved", "scheduled", "failed"];

/** What Claude sees: the brand's current direction, settings, upcoming posts and recent results. */
export function commandContext(db: Database, brand: Brand, now = new Date()): string {
  const soon = db.content
    .filter((c) => c.brandId === brand.id && EDITABLE.includes(c.status))
    .map((c) => ({ c, at: plannedInstant(c) }))
    .filter(({ at }) => !at || at.getTime() > now.getTime() - 86_400_000)
    .sort((a, b) => (a.at?.getTime() ?? Infinity) - (b.at?.getTime() ?? Infinity))
    .slice(0, 40)
    .map(({ c }) => `- ${c.id} | ${c.plannedDate ?? "no date"} ${c.plannedTime ?? ""} | ${c.platform} ${c.format}${c.series ? ` (${c.series})` : ""} | ${c.status}${c.character ? ` | host ${c.character}` : ""} | ${c.topic} | hook: ${c.hook.slice(0, 90)}`);
  const acct = db.accountStats.filter((a) => a.brandId === brand.id).slice(-6).map((a) => `- ${a.platform}: ${JSON.stringify(a).slice(0, 220)}`);
  const web = db.websiteStats.at(-1);
  return [
    `TODAY (IST): ${todayIst(now)}`,
    `BRAND: ${brand.name}${brand.organisation ? ` by ${brand.organisation}` : ""}`,
    `PILLARS: ${brand.pillars.map((p) => `${p.id} (${p.name})`).join(", ")}`,
    ...BRAND_LISTS.map((f) => `${f.toUpperCase()}: ${(brand[f] as string[]).join(" | ") || "-"}`),
    `ACTIVE INSTRUCTIONS:\n${brand.instructions.filter((i) => i.active).map((i) => `- ${i.id}: ${i.text}`).join("\n") || "- none"}`,
    `ACTIVE GOALS:\n${brand.goals.filter((g) => g.active).map((g) => `- ${g.id}: ${g.text}`).join("\n") || "- none"}`,
    `SETTINGS: autoPublish=${db.settings.autoPublish}, autoReply=${db.settings.autoReply}`,
    `VIDEO HOSTS (character ids): ${CHARACTERS.map((c) => `${c.id} = ${c.name}: ${c.about}`).join("; ")}`,
    `UPCOMING POSTS (id | date time | platform format | status | topic | hook):\n${soon.join("\n") || "- none"}`,
    `RECENT ACCOUNT NUMBERS:\n${acct.join("\n") || "- none yet"}`,
    web ? `WEBSITE (last 28 days, ${web.date}): ${web.visitors} visitors, ${web.sessions} sessions, ${web.fromSocial} sessions from social, search clicks ${web.search?.clicks ?? "?"}` : "WEBSITE: no data yet",
  ].join("\n");
}

export const COMMAND_SYSTEM = `You run KarmaVerse Studio (the social media system) for the team. A team member typed a message. Turn it into actions from the allowed list and a short, friendly reply.

ALLOWED ACTIONS (JSON objects, "type" decides the shape):
- {"type":"add_instruction","text":"..."}: a standing rule every writer follows from now on (tone, language mix, topics to push or avoid, video length, CTA wording, how to reply). Write it as a clear, self-contained rule.
- {"type":"remove_instruction","id":"..."} / {"type":"remove_goal","id":"..."}: retire one listed earlier.
- {"type":"add_goal","text":"..."}: an outcome the team wants, with the number and date if given (e.g. "Reach 500 Instagram followers by 2026-12-31").
- {"type":"brand_add"|"brand_remove","field":"voice|avoid|languages|hashtags|defaultCtas|audience","value":"..."}: change the brand profile lists.
- {"type":"set_auto_publish","on":true|false}, {"type":"set_auto_reply","mode":"off"|"safe"}.
- {"type":"add_trend_note","text":"..."}: something happening that posts should react to.
- {"type":"add_idea","title":"...","angle":"...","pillarId":"<one of the pillar ids>"}: a new post idea.
- {"type":"edit_post","id":"<post id from the list>", optional "hook","caption","description","plannedDate":"YYYY-MM-DD","plannedTime":"HH:MM","character":"<host id>"}: change one upcoming post. Only change what was asked.
- {"type":"run_agent","agent":"tracking|growth|blog|trends|metrics|community|media|publishing"}: run that part now.

RULES:
- Use ids exactly as listed. Never invent post ids.
- Questions ("how are we doing?") get an answer in "reply" from the numbers given, with no actions. Never make up numbers.
- If the message can't be done with these actions (e.g. posting on a new platform, paying for ads), say so plainly in the reply and suggest the closest thing you can do.
- Don't repeat an instruction or goal that is already active.
- Keep "reply" under 80 words, plain language, and say what you changed.

RETURN ONLY JSON: {"reply":"...","actions":[...]}`;

/* ------------------------------------------------------------------ */
/* Applying actions                                                    */
/* ------------------------------------------------------------------ */

type Undo = Record<string, unknown> & { kind: string };

function apply(db: Database, brandId: string, a: CommandAction, by: string): { label: string; undo: Undo | null } | { skip: string } {
  const brand = db.brands.find((b) => b.id === brandId);
  if (!brand) return { skip: "brand not found" };
  switch (a.type) {
    case "add_instruction": {
      if (brand.instructions.some((i) => i.active && i.text.trim().toLowerCase() === a.text.trim().toLowerCase())) return { skip: "already an instruction" };
      const id = newId("rule");
      brand.instructions.push({ id, text: a.text.trim(), by, addedAt: nowIso(), active: true });
      return { label: `New standing instruction: “${a.text.trim()}”`, undo: { kind: "instruction_active", id, active: false } };
    }
    case "remove_instruction": {
      const r = brand.instructions.find((i) => i.id === a.id && i.active);
      if (!r) return { skip: `no active instruction ${a.id}` };
      r.active = false;
      return { label: `Retired instruction: “${r.text}”`, undo: { kind: "instruction_active", id: r.id, active: true } };
    }
    case "add_goal": {
      if (brand.goals.some((g) => g.active && g.text.trim().toLowerCase() === a.text.trim().toLowerCase())) return { skip: "already a goal" };
      const id = newId("goal");
      brand.goals.push({ id, text: a.text.trim(), by, addedAt: nowIso(), active: true });
      return { label: `New goal: “${a.text.trim()}”`, undo: { kind: "goal_active", id, active: false } };
    }
    case "remove_goal": {
      const g = brand.goals.find((x) => x.id === a.id && x.active);
      if (!g) return { skip: `no active goal ${a.id}` };
      g.active = false;
      return { label: `Retired goal: “${g.text}”`, undo: { kind: "goal_active", id: g.id, active: true } };
    }
    case "brand_add": {
      const list = brand[a.field as BrandList] as string[];
      if (list.some((v) => v.toLowerCase() === a.value.toLowerCase())) return { skip: `${a.field} already has ${a.value}` };
      list.push(a.value);
      return { label: `Brand ${a.field}: added “${a.value}”`, undo: { kind: "brand_remove", field: a.field, value: a.value } };
    }
    case "brand_remove": {
      const list = brand[a.field as BrandList] as string[];
      const i = list.findIndex((v) => v.toLowerCase() === a.value.toLowerCase());
      if (i === -1) return { skip: `${a.field} has no ${a.value}` };
      const [old] = list.splice(i, 1);
      return { label: `Brand ${a.field}: removed “${old}”`, undo: { kind: "brand_add", field: a.field, value: old, index: i } };
    }
    case "set_auto_publish": {
      const before = db.settings.autoPublish;
      if (before === a.on) return { skip: "no change" };
      db.settings.autoPublish = a.on;
      return { label: `Auto-publish turned ${a.on ? "on" : "off"}`, undo: { kind: "setting", key: "autoPublish", value: before } };
    }
    case "set_auto_reply": {
      const before = db.settings.autoReply;
      if (before === a.mode) return { skip: "no change" };
      db.settings.autoReply = a.mode;
      return { label: `Automatic replies: ${a.mode === "safe" ? "on for praise and quiz answers" : "off"}`, undo: { kind: "setting", key: "autoReply", value: before } };
    }
    case "add_trend_note": {
      const id = newId("note");
      brand.trendNotes.push({ id, text: a.text.trim(), addedAt: nowIso() });
      return { label: `Trend note: “${a.text.trim()}”`, undo: { kind: "trend_note_remove", id } };
    }
    case "add_idea": {
      const id = newId("idea");
      const pillarId = brand.pillars.some((p) => p.id === a.pillarId) ? a.pillarId : (brand.pillars[0]?.id ?? "general");
      db.ideas.push({ id, brandId, title: a.title.trim(), pillarId, angle: a.angle, audienceQuestion: "", source: "manual", relevance: 4, impact: 4, effort: 2, priority: 70, status: "backlog", createdAt: nowIso(), isSample: false });
      return { label: `New idea: “${a.title.trim()}”`, undo: { kind: "idea_remove", id } };
    }
    case "edit_post": {
      const i = db.content.findIndex((c) => c.id === a.id && c.brandId === brandId);
      const p = db.content[i];
      if (!p) return { skip: `no post ${a.id}` };
      if (!EDITABLE.includes(p.status)) return { skip: `post ${a.id} is ${p.status}` };
      const fields = (["hook", "caption", "description", "plannedDate", "plannedTime", "character"] as const).filter((k) => a[k] !== undefined && a[k] !== p[k]);
      if (!fields.length) return { skip: "no change" };
      const before: Record<string, unknown> = { status: p.status, approvedBy: p.approvedBy, approvedAt: p.approvedAt };
      for (const k of fields) before[k] = p[k] ?? null;
      const next: ContentPiece = { ...p, updatedAt: nowIso() };
      for (const k of fields) (next as Record<string, unknown>)[k] = a[k];
      // A new host means the video must be made again.
      if (fields.includes("character") && next.mediaUrls.some((u) => /\.mp4$/i.test(u))) {
        before.mediaUrls = p.mediaUrls;
        next.mediaUrls = next.mediaUrls.filter((u) => !/\.mp4$/i.test(u));
      }
      // Text or video changes to an approved post need approval again; a new time alone does not.
      const reApprove = ["approved", "scheduled"].includes(p.status) && fields.some((k) => k !== "plannedDate" && k !== "plannedTime");
      if (reApprove) {
        next.status = "needs-review";
        next.approvedBy = null;
        next.approvedAt = null;
        next.history = [...p.history, { at: nowIso(), from: p.status, to: "needs-review", by: `${by || "team"} (Tell the team)`, note: "Changed from the Tell the team box; needs approval again." }];
      }
      db.content[i] = next;
      const what = fields.map((k) => (k === "plannedDate" || k === "plannedTime" ? `${k === "plannedDate" ? "date" : "time"} → ${a[k]}` : k === "character" ? `host → ${a[k]}` : k)).join(", ");
      return { label: `Post “${p.topic}” (${p.platform}): ${what}${reApprove ? " (back in review for approval)" : ""}`, undo: { kind: "post_restore", id: p.id, before } };
    }
    case "run_agent":
      return { label: `Started: ${a.agent}`, undo: null };
  }
}

async function runAgent(name: (typeof AGENTS)[number]): Promise<void> {
  // Imported here so this file doesn't pull every agent into pages that only list commands.
  switch (name) {
    case "tracking": return void (await (await import("../tracking/agent")).runTracking({ force: true }));
    case "growth": return void (await (await import("../growth/agent")).runGrowthAgent({ force: true }));
    case "blog": return void (await (await import("../blog/agent")).runBlogWriter({ force: true }));
    case "trends": return void (await (await import("../trends/agent")).runTrendWatcher());
    case "metrics": return void (await (await import("../metrics/sync")).runMetricsSync());
    case "community": return void (await (await import("../community/agent")).runCommunityManager());
    case "media": return void (await (await import("../agents/media-maker")).runMediaMaker());
    case "publishing": return void (await (await import("../publishing/agent")).runPublishingAgent());
  }
}

/** Saves a new command (pending). Run it with runCommand. */
export async function addCommand(brandId: string, text: string, by: string): Promise<Command> {
  const cmd: Command = { id: newId("cmd"), brandId, text: text.trim(), by, at: nowIso(), status: "pending", reply: "", changes: [], error: "", finishedAt: null };
  await mutate((db) => {
    db.commands = [...db.commands, cmd].slice(-200);
  });
  return cmd;
}

const running = new Set<string>();

/** Asks Claude what the command means, applies the actions, and records each change. */
export async function runCommand(id: string, client: LlmClient = claudeClient()): Promise<Command | null> {
  if (running.has(id)) return null;
  running.add(id);
  try {
    const db = await readDb();
    const cmd = db.commands.find((c) => c.id === id);
    const brand = db.brands.find((b) => b.id === cmd?.brandId);
    if (!cmd || !brand || cmd.status === "done") return cmd ?? null;
    await mutate((d) => {
      const c = d.commands.find((x) => x.id === id);
      if (c) c.status = "running";
    });

    let answer: z.infer<typeof CommandAnswerSchema>;
    try {
      const text = await client.complete({ system: COMMAND_SYSTEM, user: `${commandContext(db, brand)}\n\nMESSAGE FROM ${cmd.by || "a team member"}:\n${cmd.text}`, maxTokens: 2500 });
      answer = parseJsonResult(text, CommandAnswerSchema);
    } catch (err) {
      const message = (err as Error).message;
      log.error("Command failed", { id, error: message });
      await mutate((d) => {
        const c = d.commands.find((x) => x.id === id);
        if (c) Object.assign(c, { status: "failed", error: `Claude couldn't work this out: ${message.slice(0, 300)}`, finishedAt: nowIso() });
      });
      return null;
    }

    const toRun: Array<(typeof AGENTS)[number]> = [];
    const done = await mutate((d) => {
      const changes: CommandChange[] = [];
      const skipped: string[] = [];
      for (const a of answer.actions) {
        const r = apply(d, cmd.brandId, a, cmd.by);
        if ("skip" in r) skipped.push(r.skip);
        else {
          changes.push({ id: newId("chg"), label: r.label, undo: r.undo, undoneAt: null });
          if (a.type === "run_agent") toRun.push(a.agent);
        }
      }
      const c = d.commands.find((x) => x.id === id)!;
      Object.assign(c, { status: "done", reply: answer.reply, changes, finishedAt: nowIso(), error: skipped.length ? `Skipped: ${skipped.join("; ")}` : "" });
      return { ...c };
    });
    for (const name of toRun) void runAgent(name).catch((err) => log.error("Agent from command failed", { name, error: (err as Error).message }));
    log.info("Command done", { id, changes: done.changes.length });
    return done;
  } finally {
    running.delete(id);
  }
}

/** Reverses one change a command made. */
export async function undoChange(commandId: string, changeId: string): Promise<string> {
  return mutate((db) => {
    const cmd = db.commands.find((c) => c.id === commandId);
    const ch = cmd?.changes.find((c) => c.id === changeId);
    if (!cmd || !ch) throw new Error("That change was not found.");
    if (ch.undoneAt) return "Already undone.";
    if (!ch.undo) throw new Error("This one can't be undone (it started a job).");
    const u = ch.undo as Undo;
    const brand = db.brands.find((b) => b.id === cmd.brandId)!;
    switch (u.kind) {
      case "instruction_active": {
        const r = brand.instructions.find((i) => i.id === u.id);
        if (r) r.active = Boolean(u.active);
        break;
      }
      case "goal_active": {
        const g = brand.goals.find((x) => x.id === u.id);
        if (g) g.active = Boolean(u.active);
        break;
      }
      case "brand_remove": {
        const list = brand[u.field as BrandList] as string[];
        const i = list.findIndex((v) => v === u.value);
        if (i !== -1) list.splice(i, 1);
        break;
      }
      case "brand_add": {
        const list = brand[u.field as BrandList] as string[];
        if (!list.includes(String(u.value))) list.splice(Math.min(Number(u.index) || 0, list.length), 0, String(u.value));
        break;
      }
      case "setting":
        if (u.key === "autoPublish") db.settings.autoPublish = Boolean(u.value);
        if (u.key === "autoReply") db.settings.autoReply = u.value === "safe" ? "safe" : "off";
        break;
      case "trend_note_remove":
        brand.trendNotes = brand.trendNotes.filter((n) => n.id !== u.id);
        break;
      case "idea_remove":
        db.ideas = db.ideas.filter((x) => x.id !== u.id);
        break;
      case "post_restore": {
        const i = db.content.findIndex((c) => c.id === u.id);
        if (i === -1) throw new Error("That post no longer exists.");
        const p = db.content[i]!;
        if (p.status === "published") throw new Error("That post is already published, so it can't be changed back.");
        const before = u.before as Record<string, unknown>;
        const next = { ...p, ...before, updatedAt: nowIso() } as ContentPiece;
        // A post that had no host before gets none back (null isn't a valid host).
        if (next.character == null) delete next.character;
        if (before.status !== p.status) next.history = [...p.history, { at: nowIso(), from: p.status, to: before.status as ContentPiece["status"], by: "Tell the team (undo)", note: "Change undone." }];
        db.content[i] = next;
        break;
      }
      default:
        throw new Error("Unknown change.");
    }
    ch.undoneAt = nowIso();
    return `Undone: ${ch.label}`;
  });
}
