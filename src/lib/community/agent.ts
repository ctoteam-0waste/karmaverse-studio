import type { ContentPiece, Database, InboxItem, Platform } from "../schemas";
import { mutate, readDb } from "../db";
import { logger } from "../logger";
import { newId } from "../util";
import { INBOX_API_DEFAULTS, safeToAutoReply, triageComment } from "../agents/community";
import { externalIdOf } from "../metrics/sync";
import { brandEnv } from "../publishing/accounts";
import { defaultDeps, PublishError, type ConnectorDeps } from "../publishing/connectors";
import { canUseComments, COMMENT_READERS, COMMENT_SCOPES, readFacebookReactions, REPLY_MAX, REPLY_SENDERS, type RemoteComment } from "./comments";

const log = logger("community-manager");

/**
 * L. Community Manager.
 *
 * Reads new comments on the brand's published posts (last 30 days) through
 * the official APIs, classifies them and drafts replies into the Community
 * Inbox. Replies go out only when:
 * - a person approves one and clicks "Send", or
 * - Auto-reply is "safe" and the comment is praise or a quiz answer with
 *   nothing sensitive in it (thanks and "Correct! 🎉" replies). Questions,
 *   complaints, support, legal and anything flagged always wait for a person.
 *
 * Runs every 15 minutes while the app is running, and on demand.
 * DMs are not read: Instagram/Facebook messaging needs a separate app review.
 */

export const COMMUNITY_EVERY_MS = 15 * 60 * 1000;
const MAX_POST_AGE_DAYS = 30;
/** Comments older than this are added to the inbox but never answered automatically. */
const AUTO_REPLY_MAX_AGE_MS = 3 * 86_400_000;
/** Auto-replies per run, so a burst of comments never looks like a bot. */
const AUTO_REPLY_PER_RUN = 15;
const SEND_TIMEOUT_MS = 15 * 60 * 1000;
export const AUTO_ACTOR = "community-manager (auto)";

export interface CommunitySummary {
  at: string;
  added: number;
  sent: number;
  failed: number;
  notes: string[];
}

function publishedAt(p: ContentPiece): string {
  return [...p.history].reverse().find((h) => h.to === "published")?.at ?? p.updatedAt;
}

export function communityTargets(db: Pick<Database, "content">, now: Date): ContentPiece[] {
  const oldest = now.getTime() - MAX_POST_AGE_DAYS * 86_400_000;
  return db.content.filter((c) => c.status === "published" && !c.isSample && new Date(publishedAt(c)).getTime() >= oldest);
}

export function communityDue(db: Pick<Database, "settings">, now = new Date()): boolean {
  const last = db.settings.lastCommunitySync?.at;
  return !last || now.getTime() - new Date(last).getTime() >= COMMUNITY_EVERY_MS;
}

let running: Promise<CommunitySummary> | null = null;

export function runCommunityManager(opts: { now?: Date; deps?: ConnectorDeps } = {}): Promise<CommunitySummary> {
  running ??= doRun(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doRun(opts: { now?: Date; deps?: ConnectorDeps }): Promise<CommunitySummary> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? defaultDeps();
  const db = await readDb();
  const summary: CommunitySummary = { at: now.toISOString(), added: 0, sent: 0, failed: 0, notes: [] };
  const found: Array<{ piece: ContentPiece; comments: RemoteComment[] }> = [];
  const warned = new Set<string>();

  for (const piece of communityTargets(db, now)) {
    const brand = db.brands.find((b) => b.id === piece.brandId);
    if (!brand) continue;
    const env = brandEnv(brand, db, deps.env);
    if (!canUseComments(piece.platform, env)) continue;
    const id = externalIdOf(piece);
    if (!id) continue;
    try {
      found.push({ piece, comments: await COMMENT_READERS[piece.platform](id, env, { ...deps, env }) });
    } catch (err) {
      summary.failed++;
      const msg = (err as Error).message;
      const key = `${brand.id}:${piece.platform}`;
      if (!warned.has(key)) {
        warned.add(key);
        const hint = /scope|permission|403|insufficient|not authorized|\(#10\)|\(#200\)|client-not-enrolled|Unsupported Authentication/i.test(msg) ? ` Needs ${COMMENT_SCOPES[piece.platform].read}.` : "";
        summary.notes.push(`${brand.name} ${piece.platform}: couldn't read comments: ${msg}${hint}`);
      }
      log.warn("Comment read failed", { platform: piece.platform, id: piece.id, error: msg });
    }
  }

  // Who reacted to each Facebook post (the only platform that names them), for the Team engagement page.
  const reactions = new Map<string, Array<{ name: string; type: string }>>();
  for (const piece of communityTargets(db, now)) {
    if (piece.platform !== "facebook") continue;
    const brand = db.brands.find((b) => b.id === piece.brandId);
    const id = externalIdOf(piece);
    if (!brand || !id) continue;
    const env = brandEnv(brand, db, deps.env);
    if (!canUseComments("facebook", env)) continue;
    try {
      reactions.set(piece.id, await readFacebookReactions(id, env, { ...deps, env }));
    } catch (err) {
      log.warn("Reaction read failed", { id: piece.id, error: (err as Error).message });
    }
  }

  const autoQueue: string[] = await mutate((d) => {
    for (const [pid, list] of reactions) {
      const p = d.content.find((x) => x.id === pid);
      if (p) p.reactors = list;
    }
    const seen = new Set(d.inbox.filter((i) => i.externalId).map((i) => `${i.platform}:${i.externalId}`));
    const queue: string[] = [];
    for (const { piece, comments } of found) {
      const brand = d.brands.find((b) => b.id === piece.brandId)!;
      for (const c of comments) {
        if (c.own || seen.has(`${piece.platform}:${c.id}`)) continue;
        seen.add(`${piece.platform}:${c.id}`);
        const t = triageComment(brand, piece, c.author, c.text);
        const item: InboxItem = {
          id: newId("cmt"),
          brandId: piece.brandId,
          platform: piece.platform,
          author: c.author,
          text: c.text,
          postRef: piece.publishedUrl || piece.topic,
          receivedAt: c.at,
          classification: t.classification,
          suggestedReply: t.reply,
          replyStatus: c.answered ? "posted-manually" : "drafted",
          approvedBy: null,
          ...INBOX_API_DEFAULTS,
          externalId: c.id,
          contentId: piece.id,
          isSample: false,
        };
        d.inbox.push(item);
        summary.added++;
        const fresh = now.getTime() - new Date(c.at).getTime() <= AUTO_REPLY_MAX_AGE_MS;
        if (d.settings.autoReply === "safe" && !c.answered && fresh && safeToAutoReply(item) && queue.length < AUTO_REPLY_PER_RUN) {
          item.replyStatus = "approved";
          item.approvedBy = AUTO_ACTOR;
          queue.push(item.id);
        }
      }
    }
    return queue;
  });

  for (const id of autoQueue) {
    const r = await sendReply(id, { deps, now });
    if (r.ok) summary.sent++;
    else {
      summary.failed++;
      if (summary.notes.length < 20) summary.notes.push(`Auto-reply not sent: ${r.message}`);
    }
  }

  await mutate((d) => {
    d.settings.lastCommunitySync = { ...summary, notes: summary.notes.slice(0, 20) };
  });
  log.info("Community run finished", { added: summary.added, sent: summary.sent, failed: summary.failed });
  return summary;
}

/** Can this inbox item be answered through the API? */
export function canSend(item: Pick<InboxItem, "externalId" | "platform" | "brandId">, db: Pick<Database, "brands">, env = process.env): boolean {
  const brand = db.brands.find((b) => b.id === item.brandId);
  return Boolean(item.externalId && brand && canUseComments(item.platform as Platform, brandEnv(brand, db, env)));
}

/**
 * Sends an approved reply. Claimed before the platform call so it is never
 * sent twice; a claim left behind by a closed app is reported, not retried.
 */
export async function sendReply(id: string, opts: { deps?: ConnectorDeps; now?: Date } = {}): Promise<{ ok: boolean; message: string }> {
  const deps = opts.deps ?? defaultDeps();
  const now = opts.now ?? new Date();
  const claim = await mutate((d) => {
    const item = d.inbox.find((i) => i.id === id);
    if (!item) return { error: "Comment not found." };
    if (item.replyStatus !== "approved") return { error: "Approve the reply first." };
    if (!item.externalId) return { error: "This comment was pasted in, not read from the platform, so reply on the platform and click \"I posted it\"." };
    if (item.replySendingAt) {
      if (now.getTime() - new Date(item.replySendingAt).getTime() > SEND_TIMEOUT_MS) {
        item.replySendingAt = null;
        item.replyError = "The app stopped while sending, so the result is unknown. Check the platform; if the reply is there, click \"I posted it\".";
      }
      return { error: item.replyError ?? "This reply is already being sent." };
    }
    const brand = d.brands.find((b) => b.id === item.brandId);
    if (!brand) return { error: "Brand not found." };
    const env = brandEnv(brand, d, deps.env);
    if (!canUseComments(item.platform, env)) return { error: `${brand.name} isn't connected to ${item.platform}.` };
    const text = item.suggestedReply.trim();
    if (!text) return { error: "The reply is empty." };
    if (/\[[^\]]{3,}\]/.test(text)) return { error: "Fill in the [bracketed] part first." };
    if (text.length > REPLY_MAX[item.platform]) return { error: `Replies on ${item.platform} are limited to ${REPLY_MAX[item.platform]} characters.` };
    item.replySendingAt = now.toISOString();
    item.replyError = null;
    return { item: { ...item }, env };
  });
  if ("error" in claim) return { ok: false, message: claim.error ?? "Not sent." };

  const { item, env } = claim;
  let replyId: string | null = null;
  let error = "";
  try {
    replyId = await REPLY_SENDERS[item.platform](item.externalId!, item.suggestedReply.trim(), env, { ...deps, env });
  } catch (err) {
    const msg = err instanceof PublishError ? err.message : `Unexpected error: ${(err as Error).message}`;
    const hint = /scope|permission|403|insufficient|not authorized|\(#10\)|\(#200\)/i.test(msg) ? ` Needs ${COMMENT_SCOPES[item.platform].reply}.` : "";
    error = msg + hint;
    log.warn("Reply failed", { platform: item.platform, id, error });
  }
  await mutate((d) => {
    const it = d.inbox.find((i) => i.id === id);
    if (!it) return;
    it.replySendingAt = null;
    if (replyId !== null) {
      it.replyStatus = "posted";
      it.replyExternalId = replyId || null;
      it.replyError = null;
    } else {
      it.replyError = error;
    }
  });
  return replyId !== null ? { ok: true, message: `Reply sent on ${item.platform}.` } : { ok: false, message: error };
}
