import { createHash } from "node:crypto";
import { PLATFORMS, type Brand, type ContentPiece, type Database } from "../schemas";
import { transition } from "../agents/calendar";
import { mutate, readDb } from "../db";
import { logger } from "../logger";
import { nowIso } from "../util";
import { brandEnv, prefixed } from "./accounts";
import { CONNECTORS, defaultDeps, missingEnv, PublishError, type Connector, type ConnectorDeps, type ConnectorEnv } from "./connectors";
import { asHosted, hostConfig, hostPiece, hostProblems, needsHosting } from "./media-host";

const log = logger("publishing-agent");

/**
 * G. Publishing Agent.
 *
 * Posts content that a person has approved AND scheduled, at its planned time,
 * through the official platform APIs. It never touches drafts or content in
 * review, and it never edits what was approved.
 *
 * Safety:
 * - Each post is "claimed" (publishingStartedAt) and saved before the platform
 *   call, so overlapping runs can't post it twice.
 * - If a claim is older than CLAIM_TIMEOUT_MS with no result (the app was closed
 *   mid-call), the post is marked failed rather than retried, because it may
 *   already be live.
 * - Missing credentials leave the post scheduled for a person to post by hand.
 * - Each brand publishes only with its own accounts (see ./accounts.ts).
 * - Instagram/Facebook posts with files on this computer are uploaded by the
 *   Media Host first (see ./media-host.ts), when it is set up.
 */

export const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
export const AGENT_NAME = "publishing-agent";

/** Planned time in IST (UTC+05:30, no DST). Accepts "19:00" and "19:00 (experiment)"; defaults to 09:00. */
export function plannedInstant(piece: Pick<ContentPiece, "plannedDate" | "plannedTime">): Date | null {
  if (!piece.plannedDate || !/^\d{4}-\d{2}-\d{2}$/.test(piece.plannedDate)) return null;
  const m = (piece.plannedTime ?? "").match(/(\d{1,2})[:.](\d{2})/);
  const hh = m ? Math.min(23, Number(m[1])) : 9;
  const mm = m ? Math.min(59, Number(m[2])) : 0;
  return new Date(`${piece.plannedDate}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);
}

export interface ConnectionStatus {
  platform: ContentPiece["platform"];
  connected: boolean;
  /** Env var names to add for this brand (already prefixed). */
  missing: string[];
}

export function connectionStatus(brand: Brand, db: Pick<Database, "brands">, env: ConnectorEnv = process.env): ConnectionStatus[] {
  const benv = brandEnv(brand, db, env);
  return PLATFORMS.map((platform) => {
    const c = CONNECTORS[platform];
    const missing = missingEnv(c, benv);
    return { platform: c.platform, connected: missing.length === 0, missing: prefixed(brand, missing) };
  });
}

export interface ReadyCheck {
  connected: boolean;
  problems: string[];
}

/** What would stop this post from auto-publishing. */
export function readiness(piece: ContentPiece, db: Pick<Database, "brands">, env: ConnectorEnv = process.env, connectors: Record<string, Connector> = CONNECTORS): ReadyCheck {
  const c = connectors[piece.platform]!;
  const brand = db.brands.find((b) => b.id === piece.brandId);
  const missing = brand ? missingEnv(c, brandEnv(brand, db, env)) : c.required;
  const host = hostConfig(env);
  return { connected: missing.length === 0, problems: [...hostProblems(piece, host), ...c.check(asHosted(piece, host))] };
}

export interface RunOptions {
  now?: Date;
  /** Publish only this post, ignoring its planned time (the "Publish now" button). */
  onlyId?: string;
  deps?: ConnectorDeps;
  connectors?: Record<string, Connector>;
}

export interface RunSummary {
  at: string;
  published: number;
  failed: number;
  skipped: number;
  notes: string[];
}

let running: Promise<RunSummary> | null = null;

/** Runs the agent once. Concurrent calls in this process share one run. */
export function runPublishingAgent(opts: RunOptions = {}): Promise<RunSummary> {
  running ??= doRun(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doRun(opts: RunOptions): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? defaultDeps();
  const connectors = opts.connectors ?? CONNECTORS;
  const host = hostConfig(deps.env);
  const summary: RunSummary = { at: now.toISOString(), published: 0, failed: 0, skipped: 0, notes: [] };
  const fail = (db: Database, i: number, reason: string) => {
    const p = db.content[i]!;
    db.content[i] = { ...transition({ ...p, publishingStartedAt: null }, { to: "failed", actor: AGENT_NAME, failureReason: reason, note: reason }, policyOf(db, p)), publishingStartedAt: null };
    summary.failed++;
    summary.notes.push(`Failed: ${p.platform} "${p.topic}": ${reason}`);
  };

  // 0. Hand the next days' Facebook/YouTube posts to the platforms, so they go out even if this PC is off.
  if (!opts.onlyId && process.env.QUEUE_AHEAD !== "off") {
    try {
      await queueAhead(now, deps, connectors, summary);
    } catch (err) {
      log.error("Queue-ahead failed", { error: (err as Error).message });
    }
  }

  // Cheap read first: most minutes nothing is due, and then nothing is written.
  const due = (p: ContentPiece) => {
    if (p.status !== "scheduled") return false;
    if (opts.onlyId) return p.id === opts.onlyId;
    if (p.publishingStartedAt) return now.getTime() - new Date(p.publishingStartedAt).getTime() > CLAIM_TIMEOUT_MS;
    const at = plannedInstant(p);
    return Boolean(at && at.getTime() <= now.getTime());
  };
  if (!opts.onlyId && !(await readDb()).content.some(due)) return summary;

  // 1. Claim due posts (and resolve stale claims) under the database lock.
  const claimed = await mutate((db) => {
    const out: Array<{ piece: ContentPiece; env: ConnectorEnv }> = [];
    db.content.forEach((p, i) => {
      const brand = db.brands.find((b) => b.id === p.brandId);
      if (!brand) return;
      if (opts.onlyId && p.id !== opts.onlyId) return;
      if (p.status !== "scheduled") return;
      if (p.publishingStartedAt) {
        if (now.getTime() - new Date(p.publishingStartedAt).getTime() > CLAIM_TIMEOUT_MS) {
          fail(db, i, "The app stopped while publishing, so the result is unknown. Check the platform: if the post is live, mark it published with its URL; if not, schedule it again.");
        }
        return;
      }
      const at = plannedInstant(p);
      if (!opts.onlyId && (!at || at.getTime() > now.getTime())) return;

      // Already queued on the platform: the platform published it at the planned time.
      const q = p.platformQueue;
      if (q?.externalId && !q.error) {
        if (opts.onlyId && at && at.getTime() > now.getTime()) {
          summary.notes.push(`Already queued on ${p.platform}: it goes out there at ${new Date(q.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}. To post it sooner, change its time here first.`);
          return;
        }
        const note = `Published by ${p.platform} at its planned time (queued in advance, so it went out even if this computer was off).`;
        db.content[i] = { ...transition(p, { to: "published", actor: AGENT_NAME, publishedUrl: q.url, note }, policyOf(db, p)), externalId: q.externalId };
        summary.published++;
        summary.notes.push(`Published ${p.platform} "${p.topic}" (queued in advance): ${q.url}`);
        return;
      }

      const c = connectors[p.platform]!;
      const env = brandEnv(brand, db, deps.env);
      const missing = missingEnv(c, env);
      if (missing.length) {
        summary.skipped++;
        summary.notes.push(`Skipped ${brand.name} ${p.platform} "${p.topic}": not connected (set ${prefixed(brand, missing).join(", ")}). Post it by hand.`);
        return;
      }
      const problems = [...hostProblems(p, host), ...c.check(asHosted(p, host))];
      if (problems.length) return fail(db, i, problems.join(" "));
      if (!p.approvedBy) return fail(db, i, "Not approved.");
      db.content[i] = { ...p, publishingStartedAt: now.toISOString() };
      out.push({ piece: db.content[i]!, env });
    });
    if (opts.onlyId && out.length === 0 && summary.failed === 0 && summary.skipped === 0) {
      const p = db.content.find((x) => x.id === opts.onlyId);
      if (!p) summary.notes.push("Post not found.");
      else if (p.publishingStartedAt) summary.notes.push("This post is already being published.");
      else summary.notes.push(`Only scheduled posts can be published (this one is ${p.status}).`);
    }
    return out;
  });

  // 2. Publish each claimed post, outside the lock (platform calls can be slow).
  for (const { piece, env } of claimed) {
    let result: { url: string; externalId: string; notes: string[] } | null = null;
    let error = "";
    let hosted: Record<string, string> | null = null;
    try {
      let toSend = piece;
      if (host && needsHosting(piece)) {
        // The brand's own credentials, for hosting images on its Facebook Page.
        const h = await hostPiece(piece, host, { ...deps, env: { ...deps.env, ...env } });
        toSend = h.piece;
        hosted = h.hosted;
      }
      result = await connectors[piece.platform]!.publish(toSend, { ...deps, env });
    } catch (err) {
      error = err instanceof PublishError ? err.message : `Unexpected error: ${(err as Error).message}`;
      log.error("Publish failed", { id: piece.id, platform: piece.platform, error });
    }
    await mutate((db) => {
      const i = db.content.findIndex((c) => c.id === piece.id);
      if (i === -1) return;
      if (hosted) db.content[i] = { ...db.content[i]!, hostedMedia: hosted };
      if (!result) return fail(db, i, error);
      const p = { ...db.content[i]!, publishingStartedAt: null };
      const note = [`Published automatically via ${piece.platform} API.`, ...result.notes].join(" ");
      db.content[i] = { ...transition(p, { to: "published", actor: AGENT_NAME, publishedUrl: result.url, note }, policyOf(db, p)), externalId: result.externalId || null };
      summary.published++;
      summary.notes.push(`Published ${piece.platform} "${piece.topic}": ${result.url}${result.notes.length ? ` (${result.notes.join(" ")})` : ""}`);
    });
  }

  // 3. Record the run, but don't rewrite the file every minute for the same "skipped" notes.
  const notes = summary.notes.slice(0, 20);
  const last = (await readDb()).settings.lastPublishRun;
  const repeat = !summary.published && !summary.failed && !opts.onlyId && JSON.stringify(last?.notes) === JSON.stringify(notes);
  if ((summary.published || summary.failed || summary.skipped || opts.onlyId) && !repeat) {
    await mutate((db) => {
      db.settings.lastPublishRun = { ...summary, notes };
    });
    log.info("Publishing run finished", { published: summary.published, failed: summary.failed, skipped: summary.skipped });
  }
  return summary;
}

function policyOf(db: Database, p: ContentPiece) {
  return (db.brands.find((b) => b.id === p.brandId) ?? db.brands[0]!).approvalPolicy;
}

/* ------------------------------------------------------------------ */
/* Queue ahead: native platform scheduling (works while this PC is off) */
/* ------------------------------------------------------------------ */

/** How far ahead approved Facebook/YouTube posts are handed to the platform. */
export const QUEUE_AHEAD_DAYS = Math.min(28, Math.max(1, Number(process.env.QUEUE_AHEAD_DAYS) || 7));
/** Facebook needs at least 10 minutes' notice; inside this window the normal publish path is used. */
export const QUEUE_MIN_LEAD_MS = 20 * 60 * 1000;
/** After a failed queue attempt, wait this long before trying again (the post still publishes normally). */
const QUEUE_RETRY_MS = 6 * 60 * 60 * 1000;

/** What was sent to the platform; a change here means the queued copy is out of date. */
export function queueSig(p: ContentPiece): string {
  const parts = [p.platform, p.format, p.hook, p.caption, p.description, p.hashtags.join(" "), p.keywords.join(" "), p.mediaUrls.join("|"), p.cta];
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * Hands approved, scheduled Facebook and YouTube posts due in the next QUEUE_AHEAD_DAYS to the
 * platform with their publish time, and cancels queued copies that were edited, moved or
 * unscheduled here. Instagram, LinkedIn and X have no reliable scheduling API, so they keep
 * using the normal path (this computer posts them at the planned time).
 */
export async function queueAhead(now: Date, deps: ConnectorDeps, connectors: Record<string, Connector>, summary: RunSummary): Promise<void> {
  const horizon = now.getTime() + QUEUE_AHEAD_DAYS * 86_400_000;
  const db0 = await readDb();

  // 1. Cancel queued copies that no longer match (edited, new time, or not scheduled any more).
  const stale = db0.content.filter((p) => {
    const q = p.platformQueue;
    if (!q?.externalId || q.error || p.status === "published") return false;
    if (Date.parse(q.at) <= now.getTime() + 2 * 60_000) return false; // already going out
    const at = plannedInstant(p);
    return p.status !== "scheduled" || !at || at.toISOString() !== q.at || queueSig(p) !== q.sig;
  });
  for (const p of stale) {
    const c = connectors[p.platform];
    const brand = db0.brands.find((b) => b.id === p.brandId);
    if (!c?.cancel || !brand) continue;
    let note = "";
    try {
      await c.cancel(p.platformQueue!.externalId, { ...deps, env: brandEnv(brand, db0, deps.env) });
      note = `Removed the queued ${p.platform} copy of "${p.topic}" (it was changed here).`;
    } catch (err) {
      note = `Could not remove the queued ${p.platform} copy of "${p.topic}" (${(err as Error).message}). Delete it by hand in ${p.platform === "youtube" ? "YouTube Studio" : "Meta Business Suite > Planner"}, or it will still go out.`;
      log.error("Cancel queued post failed", { id: p.id, error: (err as Error).message });
    }
    summary.notes.push(note);
    await mutate((db) => {
      const i = db.content.findIndex((x) => x.id === p.id);
      if (i !== -1) db.content[i] = { ...db.content[i]!, platformQueue: null };
    });
  }

  // 2. Queue what is approved, scheduled and due within the window.
  const host = hostConfig(deps.env);
  const claimed = await mutate((db) => {
    const out: Array<{ piece: ContentPiece; env: ConnectorEnv; at: Date }> = [];
    db.content.forEach((p, i) => {
      if (p.status !== "scheduled" || !p.approvedBy || p.publishingStartedAt) return;
      const c = connectors[p.platform];
      if (!c?.canSchedule) return;
      const q = p.platformQueue;
      if (q?.externalId && !q.error) return;
      if (q?.error && now.getTime() - Date.parse(q.queuedAt) < QUEUE_RETRY_MS) return;
      const at = plannedInstant(p);
      if (!at || at.getTime() < now.getTime() + QUEUE_MIN_LEAD_MS || at.getTime() > horizon) return;
      const brand = db.brands.find((b) => b.id === p.brandId);
      if (!brand) return;
      const env = brandEnv(brand, db, deps.env);
      if (missingEnv(c, env).length) return;
      // Not ready yet (e.g. the Media Maker hasn't made the video): try again next minute.
      if ([...hostProblems(p, host), ...c.check(asHosted(p, host))].length) return;
      db.content[i] = { ...p, publishingStartedAt: now.toISOString() };
      out.push({ piece: db.content[i]!, env, at });
    });
    return out;
  });

  for (const { piece, env, at } of claimed) {
    let result: { url: string; externalId: string; notes: string[] } | null = null;
    let hosted: Record<string, string> | null = null;
    let error = "";
    try {
      let toSend = piece;
      if (host && needsHosting(piece)) {
        const h = await hostPiece(piece, host, { ...deps, env: { ...deps.env, ...env } });
        toSend = h.piece;
        hosted = h.hosted;
      }
      result = await connectors[piece.platform]!.publish(toSend, { ...deps, env }, { publishAt: at });
    } catch (err) {
      error = err instanceof PublishError ? err.message : `Unexpected error: ${(err as Error).message}`;
      log.error("Queue ahead failed", { id: piece.id, platform: piece.platform, error });
    }
    await mutate((db) => {
      const i = db.content.findIndex((c) => c.id === piece.id);
      if (i === -1) return;
      const p = { ...db.content[i]!, publishingStartedAt: null, ...(hosted ? { hostedMedia: hosted } : {}) };
      p.platformQueue = result
        ? { at: at.toISOString(), externalId: result.externalId, url: result.url, sig: queueSig(piece), queuedAt: now.toISOString() }
        : { at: at.toISOString(), externalId: "", url: "", sig: "", queuedAt: now.toISOString(), error };
      db.content[i] = p;
    });
    summary.notes.push(
      result
        ? `Queued ${piece.platform} "${piece.topic}" for ${at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}: it goes out even if this computer is off.`
        : `Could not queue ${piece.platform} "${piece.topic}" in advance (${error}). This computer will post it at the planned time instead, if it is on.`,
    );
  }
}
