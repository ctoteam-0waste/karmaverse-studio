"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { activeBrand, mutate, readDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { addCommand, runCommand, undoChange } from "@/lib/command/agent";
import { logger } from "@/lib/logger";
import { nowIso } from "@/lib/util";

const log = logger("command-actions");
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function back(key: "ok" | "err", msg: string): never {
  revalidatePath("/", "layout");
  redirect(`/command?${key}=${encodeURIComponent(msg)}`);
}

/** Saves the message and starts working on it in the background (it takes Claude 20-60 seconds). */
export async function sendCommandAction(fd: FormData) {
  const text = str(fd, "text");
  if (text.length < 3) back("err", "Type what you want first.");
  if (text.length > 4000) back("err", "That's very long. Split it into a few shorter messages.");
  const by = (await currentUser()) ?? (str(fd, "actor") || "team");
  const db = await readDb();
  const cmd = await addCommand(activeBrand(db).id, text, by);
  void runCommand(cmd.id).catch((err) => log.error("Command run failed", { id: cmd.id, error: (err as Error).message }));
  back("ok", "Got it. Working on it now; this page updates by itself.");
}

export async function retryCommandAction(fd: FormData) {
  const id = str(fd, "id");
  await mutate((db) => {
    const c = db.commands.find((x) => x.id === id);
    if (c && c.status === "failed") Object.assign(c, { status: "pending", error: "" });
  });
  void runCommand(id).catch((err) => log.error("Command retry failed", { id, error: (err as Error).message }));
  back("ok", "Trying again.");
}

export async function undoChangeAction(fd: FormData) {
  let msg: string;
  try {
    msg = await undoChange(str(fd, "command"), str(fd, "change"));
  } catch (err) {
    back("err", (err as Error).message);
  }
  back("ok", msg!);
}

/** Retire (or bring back) a standing instruction or goal by hand. */
export async function toggleDirectionAction(fd: FormData) {
  const kind = str(fd, "kind") === "goal" ? "goals" : "instructions";
  const id = str(fd, "id");
  const active = str(fd, "active") === "1";
  await mutate((db) => {
    const brand = activeBrand(db);
    const item = brand[kind].find((x) => x.id === id);
    if (item) item.active = active;
  });
  back("ok", active ? "Back on." : "Retired. Writers won't follow it any more.");
}

/** Adds an instruction or goal directly, without asking Claude. */
export async function addDirectionAction(fd: FormData) {
  const kind = str(fd, "kind") === "goal" ? "goals" : "instructions";
  const text = str(fd, "text");
  if (text.length < 3) back("err", "Type it first.");
  const by = (await currentUser()) ?? "team";
  await mutate((db) => {
    const brand = activeBrand(db);
    brand[kind].push({ id: `${kind === "goals" ? "goal" : "rule"}_${Date.now().toString(36)}`, text, by, addedAt: nowIso(), active: true });
  });
  back("ok", kind === "goals" ? "Goal added. Writers will aim for it." : "Instruction added. Every writer follows it from now on.");
}
