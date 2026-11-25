import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSchema, type Brand, type Database } from "./schemas";
import { buildSeed } from "./sample-data";
import { logger } from "./logger";

const log = logger("db");

/**
 * Local JSON-file database.
 *
 * - One file (default ./data/db.json), validated with zod on every read.
 * - Writes go to a temp file and are renamed into place (atomic on Windows and Linux).
 * - Writes are serialised in-process so concurrent requests can't interleave.
 * - Created from sample data on first run.
 *
 * Swap this module for SQLite/Postgres later; the rest of the app only uses
 * readDb() and mutate().
 */

export function dataFile(): string {
  const set = process.env.DATA_FILE?.trim();
  // Safety net: tests must never touch the real database.
  if (!set && process.env.VITEST) throw new Error("Tests must set DATA_FILE (see tests/setup.ts); refusing to use data/db.json.");
  return set || path.join(process.cwd(), "data", "db.json");
}

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

let queue: Promise<unknown> = Promise.resolve();
let seeding: Promise<void> | null = null;

/** Creates the file from sample data exactly once, even if several requests arrive together. */
async function ensureSeeded(file: string): Promise<void> {
  try {
    await fs.access(file);
    return;
  } catch {
    // fall through and seed
  }
  seeding ??= (async () => {
    try {
      await fs.access(file);
    } catch {
      log.info("No database found, creating one from sample data", { file });
      await save(file, buildSeed());
    }
  })().finally(() => {
    seeding = null;
  });
  await seeding;
}

async function load(file: string): Promise<Database> {
  await ensureSeeded(file);
  const raw = await fs.readFile(file, "utf8");

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DatabaseError(`${file} is not valid JSON. Restore a backup or run "npm run reset-data" to start fresh.`);
  }
  const parsed = DatabaseSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DatabaseError(`${file} failed validation at ${issue?.path.join(".")}: ${issue?.message}. Fix the file or run "npm run reset-data".`);
  }
  return parsed.data;
}

async function save(file: string, db: Database): Promise<void> {
  const valid = DatabaseSchema.parse(db);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(valid, null, 2), "utf8");
  // On Windows, rename can briefly fail with EPERM/EBUSY while another process
  // (antivirus, indexer, editor) has the file open. Retry a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 5) {
        await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}

export async function readDb(): Promise<Database> {
  await queue.catch(() => undefined);
  return load(dataFile());
}

/** Read-modify-write under a lock. The callback may mutate `db` and return a value. */
export function mutate<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
  const run = async () => {
    const file = dataFile();
    const db = await load(file);
    const result = await fn(db);
    await save(file, db);
    return result;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export function activeBrand(db: Database): Brand {
  const brand = db.brands.find((b) => b.id === db.settings.activeBrandId) ?? db.brands[0];
  if (!brand) throw new DatabaseError("No brand is configured. Add one in Settings.");
  return brand;
}

/** For tests and the reset script. */
export async function writeDbForTests(db: Database): Promise<void> {
  await save(dataFile(), db);
}
