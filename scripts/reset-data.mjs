// Deletes the local database so the app recreates it from sample data on next start.
// A timestamped backup is kept next to it.
import { existsSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";

const file = process.env.DATA_FILE?.trim() || path.join(process.cwd(), "data", "db.json");
if (existsSync(file)) {
  const backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(file, backup);
  rmSync(file);
  console.log(`Removed ${file}\nBackup saved to ${backup}\nStart the app to recreate it from sample data.`);
} else {
  console.log(`No database at ${file}. Start the app to create one.`);
}
