import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseJsonResult, ParseError } from "@/lib/llm/json";
import { withRetry, RetryableError } from "@/lib/retry";
import { generateContent, generateBrief, parseManualContent } from "@/lib/services/generation";
import { KARMAVERSE_BRAND as brand } from "@/lib/brands/karmaverse";
import type { LlmClient } from "@/lib/llm/anthropic";
import { exportPiece, exportCalendarCsv } from "@/lib/publishing/adapters";
import { generateCalendar } from "@/lib/agents/calendar";
import { generateIdeas } from "@/lib/agents/strategy";

const SETUP_DATA_FILE = process.env.DATA_FILE;

const idea = { title: "Wet vs dry waste explained", angle: "Sort 10 items live", pillarId: "edu-shorts", audienceQuestion: "" };

describe("JSON result parsing", () => {
  const S = z.object({ a: z.number() });
  it("reads fenced or wrapped JSON", () => {
    expect(parseJsonResult('Sure!\n```json\n{"a": 1}\n```', S)).toEqual({ a: 1 });
    expect(parseJsonResult('Here: {"a": 2} thanks', S)).toEqual({ a: 2 });
  });
  it("explains bad input", () => {
    expect(() => parseJsonResult("no json", S)).toThrow(ParseError);
    expect(() => parseJsonResult('{"a": "x"}', S)).toThrow(/expected shape/);
  });
});

describe("retry", () => {
  it("retries only retryable errors, then succeeds", async () => {
    let n = 0;
    const out = await withRetry("t", async () => {
      n++;
      if (n < 3) throw new RetryableError("busy");
      return "ok";
    }, { sleep: async () => undefined });
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });
  it("does not retry normal errors", async () => {
    let n = 0;
    await expect(withRetry("t", async () => { n++; throw new Error("bad request"); }, { sleep: async () => undefined })).rejects.toThrow("bad request");
    expect(n).toBe(1);
  });
});

describe("generation modes", () => {
  it("template mode works offline", async () => {
    const r = await generateContent(brand, idea, [{ platform: "instagram", format: "reel" }, { platform: "linkedin", format: "text-post" }], "template");
    expect(r.versions).toHaveLength(2);
    expect(r.generatedBy).toBe("template");
  });

  it("manual mode returns a prompt and parses the pasted answer", async () => {
    const r = await generateContent(brand, idea, [{ platform: "instagram", format: "reel" }], "manual");
    expect(r.manualPrompt).toContain("VERIFIED FACTS");
    expect(r.manualPrompt).toContain("UNVERIFIED FACTS");
    const pasted = parseManualContent('```json\n[{"platform":"instagram","format":"reel","hook":"H","caption":"C","hashtags":["#a"],"cta":"Save"}]\n```');
    expect(pasted[0]!.hook).toBe("H");
  });

  it("API mode uses the client, fills missing versions, and falls back on failure", async () => {
    const ok: LlmClient = { complete: async () => '[{"platform":"instagram","format":"reel","hook":"From Claude","caption":"x"}]' };
    const r = await generateContent(brand, idea, [{ platform: "instagram", format: "reel" }, { platform: "facebook", format: "image-post" }], "anthropic", ok);
    expect(r.generatedBy).toBe("anthropic");
    expect(r.versions[0]!.hook).toBe("From Claude");
    expect(r.versions).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/facebook\/image-post/);

    const broken: LlmClient = { complete: async () => { throw new Error("401"); } };
    const fb = await generateContent(brand, idea, [{ platform: "instagram", format: "reel" }], "anthropic", broken);
    expect(fb.generatedBy).toBe("template");
    expect(fb.warnings[0]).toMatch(/Claude failed/);
  });

  it("Claude mode without a key or Claude Code falls back to template with a clear warning", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    const savedCli = process.env.CLAUDE_CLI;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CLI = "Z:/nowhere/claude.exe"; // pretend Claude Code isn't installed
    const r = await generateBrief(brand, idea, "instagram", "reel", 30, "anthropic");
    expect(r.brief?.generatedBy).toBe("template");
    expect(r.warnings[0]).toMatch(/ANTHROPIC_API_KEY/);
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
    if (savedCli === undefined) delete process.env.CLAUDE_CLI;
    else process.env.CLAUDE_CLI = savedCli;
  });
});

describe("exports", () => {
  it("produces ready-to-paste text and CSV with the manual step spelled out", () => {
    const items = generateCalendar(brand, generateIdeas(brand, { content: [], inbox: [], existingIdeas: [], today: "2026-10-26" }), [], { startDate: "2026-10-26", days: 7 });
    const text = exportPiece(items[0]!);
    expect(text).toContain("MANUAL STEP");
    const csv = exportCalendarCsv(items);
    expect(csv.split("\n")[0]).toContain("target_metric");
    // Count record breaks outside quoted cells (captions contain newlines).
    let records = 1;
    let quoted = false;
    for (const ch of csv) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "\n" && !quoted) records++;
    }
    expect(records).toBe(items.length + 1);
  });
});

describe("database", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sga-"));
    process.env.DATA_FILE = path.join(dir, "db.json");
  });
  afterAll(() => {
    process.env.DATA_FILE = SETUP_DATA_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds on first read, serialises concurrent writes and rejects corrupt files", async () => {
    const { readDb, mutate, DatabaseError } = await import("@/lib/db");
    // Several requests hitting a fresh install at once must not race on the seed file.
    const first = await Promise.all([readDb(), readDb(), readDb(), readDb()]);
    expect(first.every((d) => d.brands.length === 1)).toBe(true);
    const db = await readDb();
    expect(db.brands[0]!.name).toBe("KarmaVerse");
    expect(existsSync(process.env.DATA_FILE!)).toBe(true);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mutate((d) => {
          d.learning.push({ id: `l${i}`, brandId: d.brands[0]!.id, at: new Date().toISOString(), kind: "observation", text: `n${i}`, experimentId: null });
        }),
      ),
    );
    const after = await readDb();
    expect(after.learning.filter((l) => l.kind === "observation")).toHaveLength(10);

    writeFileSync(process.env.DATA_FILE!, "{ not json");
    await expect(readDb()).rejects.toBeInstanceOf(DatabaseError);
  });
});
