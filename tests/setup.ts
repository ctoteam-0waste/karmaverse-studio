import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Every test file gets its own throwaway database, so no test can ever write to
// the real data/db.json, even if it forgets to set DATA_FILE itself.
process.env.DATA_FILE = path.join(mkdtempSync(path.join(tmpdir(), "sga-test-")), "db.json");
