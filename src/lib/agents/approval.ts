import type { Brand, ContentPiece } from "../schemas";
import { plannedInstant } from "../publishing/agent";
import { transition, TransitionError } from "./calendar";

/**
 * One-tap approval: approves a post in review and, when it has a planned date,
 * schedules it in the same step so the Publishing Agent posts it on time.
 */
export function approveAndSchedule(piece: ContentPiece, actor: string, brand: Brand, now = new Date()): { piece: ContentPiece; message: string } {
  if (!["needs-review", "approved"].includes(piece.status)) throw new TransitionError(`This post is ${piece.status.replace("-", " ")}, so there is nothing to approve.`);
  let p = piece.status === "needs-review" ? transition(piece, { to: "approved", actor, note: "Approved." }, brand.approvalPolicy, brand) : piece;
  const at = plannedInstant(p);
  if (!at) return { piece: p, message: "Approved. It has no planned date yet: open it and pick one to schedule it." };
  const when = at.toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  // A missed time is not scheduled: it would go out the moment it's approved, which nobody expects from "Approve".
  if (at.getTime() <= now.getTime()) return { piece: p, message: `Approved, but its planned time (${when}) has passed. Open it and pick a new date to schedule it.` };
  p = transition(p, { to: "scheduled", actor, note: `Scheduled for ${when} IST.` }, brand.approvalPolicy, brand);
  return { piece: p, message: `Approved and scheduled for ${when}.` };
}

/** Sends a post in review back to draft with the reviewer's note, so the team knows what to change. */
export function sendBack(piece: ContentPiece, actor: string, note: string, brand: Brand): ContentPiece {
  const to = piece.status === "scheduled" ? "approved" : "draft";
  let p = piece;
  if (to === "approved") p = transition(p, { to: "approved", actor, note: `Unscheduled: ${note || "sent back"}` }, brand.approvalPolicy, brand);
  return transition(p, { to: p.status === "approved" ? "needs-review" : "draft", actor, note: note ? `Sent back: ${note}` : "Sent back for changes." }, brand.approvalPolicy, brand);
}

/** True when a post's planned time is already behind us. */
export function isOverdue(piece: Pick<ContentPiece, "plannedDate" | "plannedTime">, now = new Date()): boolean {
  const at = plannedInstant(piece);
  return Boolean(at && at.getTime() <= now.getTime());
}
