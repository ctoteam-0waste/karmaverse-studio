"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { activeBrand, mutate, readDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { authConfig } from "@/lib/auth";
import { addChatMessage, runChatTurn } from "@/lib/chat/agent";
import { approveAndSchedule } from "@/lib/agents/approval";
import { logger } from "@/lib/logger";

const log = logger("chat-actions");
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** The signed-in name; "team" when sign-in is off (local use). */
const who = async () => (await currentUser()) ?? (authConfig() ? null : "team");

function back(chatId: string, key?: "ok" | "err", msg?: string): never {
  revalidatePath("/chat");
  const q = new URLSearchParams();
  if (chatId) q.set("c", chatId);
  if (key && msg) q.set(key, msg);
  redirect(`/chat?${q.toString()}#end`);
}

/** Saves the message and starts the answer in the background (Claude, then maybe a render). */
export async function sendChatAction(fd: FormData) {
  const chatId = str(fd, "chat");
  const text = str(fd, "text");
  const by = await who();
  if (!by) redirect("/login?next=/chat");
  if (text.length < 2) back(chatId, "err", "Type a message first.");
  if (text.length > 3000) back(chatId, "err", "That's very long. Split it into shorter messages.");
  const db = await readDb();
  const r = await addChatMessage(activeBrand(db).id, chatId || null, text, by);
  void runChatTurn(r.chatId, r.replyId).catch((err) => log.error("Chat turn failed", { chatId: r.chatId, error: (err as Error).message }));
  back(r.chatId);
}

/** Approves the posts a chat message created and schedules them for their time. */
export async function approveChatPostsAction(fd: FormData) {
  const chatId = str(fd, "chat");
  const ids = str(fd, "ids").split(",").filter(Boolean);
  const actor = await who();
  if (!actor) redirect("/login?next=/chat");
  let msg = "";
  try {
    const notes = await mutate((db) => {
      const out: string[] = [];
      for (const id of ids) {
        const i = db.content.findIndex((c) => c.id === id);
        if (i === -1) continue;
        const p = db.content[i]!;
        if (!["needs-review", "approved"].includes(p.status)) {
          out.push(`${p.platform}: already ${p.status}`);
          continue;
        }
        const brand = db.brands.find((b) => b.id === p.brandId) ?? activeBrand(db);
        const r = approveAndSchedule(p, actor, brand);
        db.content[i] = r.piece;
        out.push(`${p.platform}: ${r.message}`);
      }
      return out;
    });
    msg = notes.join(" · ") || "Nothing to approve.";
  } catch (err) {
    back(chatId, "err", (err as Error).message);
  }
  back(chatId, "ok", msg);
}
