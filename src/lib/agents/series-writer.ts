import { pickCharacter } from "../video/characters";
import { z } from "zod";
import type { Brand, ContentPiece, Database, Trend, VideoSeries } from "../schemas";
import { claudeClient, type LlmClient } from "../llm/anthropic";
import { parseJsonResult } from "../llm/json";
import { CONTENT_SYSTEM } from "../llm/prompts";
import { mutate } from "../db";
import { logger } from "../logger";
import { nowIso } from "../util";
import { applyEdit } from "./calendar";
import { lintContent } from "./content";
import { ScriptSchemas, newsCandidates, parseScript, seriesFor, seriesPrompt, SERIES_LABEL, type SeriesScript } from "../video/series";

const log = logger("series-writer");

/**
 * Writes a video post as part of a series (news, quiz, myth vs fact, eco hack,
 * cartoon story): the platform copy and the video script, in one Claude call.
 * The script is stored on the post as JSON and rendered by the Media Maker.
 */

export interface StoredScript {
  series: VideoSeries;
  /** News publish date (news series), shown on the headline card. */
  date?: string;
  script: SeriesScript;
}

export function readStoredScript(p: Pick<ContentPiece, "series" | "videoScript">): StoredScript | null {
  if (!p.series || !p.videoScript) return null;
  try {
    const raw = JSON.parse(p.videoScript) as { series?: VideoSeries; date?: string; script?: unknown };
    const script = parseScript(p.series, JSON.stringify(raw.script ?? null));
    return script ? { series: p.series, date: raw.date, script } : null;
  } catch {
    return null;
  }
}

const postFields = {
  hook: z.string().min(1),
  caption: z.string().default(""),
  description: z.string().default(""),
  keywords: z.array(z.string()).default([]),
  hashtags: z.array(z.string()).default([]),
  cta: z.string().default(""),
  thumbnailConcept: z.string().default(""),
};

export function answerSchema(series: VideoSeries) {
  return z.object({ ...postFields, video: ScriptSchemas[series] });
}

export interface SeriesWriteResult {
  ok: boolean;
  series: VideoSeries;
  note: string;
}

/** Writes one series post with Claude and saves it. Returns null when the post isn't a series post. */
export async function writeSeriesPost(db: Database, brand: Brand, piece: ContentPiece, client: LlmClient = claudeClient(), now = new Date()): Promise<SeriesWriteResult | null> {
  const news = newsCandidates(db.trends, brand.id, now);
  const series = seriesFor(piece, news.length > 0);
  if (!series) return null;
  const story: Trend | undefined = series === "news" ? news[0] : undefined;
  // Who presents it: the chosen character, or the next in the rotation (cartoons have their own cast).
  const recent = db.content.filter((c) => c.series && c.series !== "cartoon" && c.character).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).map((c) => c.character);
  const character = series === "cartoon" ? undefined : pickCharacter(recent, piece.character);
  const text = await client.complete({ system: CONTENT_SYSTEM, user: seriesPrompt(brand, piece, series, story, character), maxTokens: 3000 });
  const a = parseJsonResult(text, answerSchema(series));
  if (series === "cartoon") {
    const want = { garmi: 7, battery: 7, subah: 6, plastic: 6 }[(a.video as SeriesScript<"cartoon">).story];
    if ((a.video as SeriesScript<"cartoon">).lines.length !== want) throw new Error(`Cartoon script has the wrong number of lines (needs ${want}).`);
  }
  const blanks = lintContent(brand, [a.hook, a.caption, a.description].join("\n")).filter((w) => w.level === "block");
  if (blanks.length) throw new Error(`Post has blanks: ${blanks.map((b) => b.message).join("; ")}`);
  const stored: StoredScript = { series, script: a.video as SeriesScript, ...(story ? { date: story.date } : {}) };
  const saved = await mutate((d) => {
    const i = d.content.findIndex((c) => c.id === piece.id);
    const cur = d.content[i];
    if (!cur || cur.status !== "draft" || cur.generatedBy !== "template") return false;
    const next = applyEdit(cur, { hook: a.hook, caption: a.caption, description: a.description, keywords: a.keywords, hashtags: a.hashtags, cta: a.cta, thumbnailConcept: a.thumbnailConcept }, "post-writer");
    d.content[i] = {
      ...next,
      topic: story ? story.title : next.topic,
      generatedBy: "anthropic",
      series,
      videoScript: JSON.stringify(stored),
      sourceUrl: story?.url ?? "",
      ...(character ? { character } : {}),
      history: [...next.history, { at: nowIso(), from: "draft", to: "draft", by: "post-writer", note: `Written by Claude as a ${SERIES_LABEL[series]} video.` }],
    };
    if (story) {
      const t = d.trends.find((x) => x.id === story.id);
      if (t) t.status = "used";
    }
    return true;
  });
  if (!saved) return { ok: false, series, note: "changed meanwhile" };
  log.info("Wrote series post", { id: piece.id, series, platform: piece.platform, date: piece.plannedDate });
  return { ok: true, series, note: `${SERIES_LABEL[series]}: ${piece.platform} "${story?.title ?? piece.topic}" (${piece.plannedDate})` };
}
