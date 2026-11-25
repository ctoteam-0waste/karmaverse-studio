import { z } from "zod";
import type { Brand, Format, GeneratedPlatformContent, GenerationMode, Idea, Platform, VideoBrief } from "../schemas";
import { GeneratedPlatformContentSchema, VideoBriefSchema, PLATFORM_FORMATS } from "../schemas";
import { generatePlatformVersion } from "../agents/content";
import { generateVideoBrief } from "../agents/video";
import { claudeClient, isClaudeConfigured, type LlmClient } from "../llm/anthropic";
import { parseJsonResult } from "../llm/json";
import { BRIEF_SYSTEM, CONTENT_SYSTEM, briefPrompt, contentPrompt } from "../llm/prompts";
import { logger } from "../logger";
import { newId, nowIso } from "../util";

const log = logger("generation");

type IdeaLike = Pick<Idea, "title" | "angle" | "pillarId" | "audienceQuestion"> & { id?: string };
export type Target = { platform: Platform; format: Format };

export interface ContentResult {
  versions: GeneratedPlatformContent[];
  generatedBy: GenerationMode;
  warnings: string[];
  /** Present in manual mode: copy into Claude chat, paste the answer back. */
  manualPrompt?: string;
}

const VersionsSchema = z.array(GeneratedPlatformContentSchema).min(1);

function checkTargets(targets: Target[]): void {
  for (const t of targets) if (!PLATFORM_FORMATS[t.platform].includes(t.format)) throw new Error(`${t.format} is not supported on ${t.platform}.`);
}

/** Added for the background Post Writer: its copy goes straight to the approver, so no blanks. */
export const READY_TO_POST =
  "\n\nREADY TO POST: this copy goes straight to the approver, so it must be complete. Never write [CONFIRM: ...] or any other [bracketed] placeholder, and do not cite sources. If a point would need a fact that is not in the verified facts above, leave that point out or rephrase it as general, practical advice. Position KarmaVerse as a climate-tech brand about everyday sustainable action: do not lead with or centre recycling or doorstep pickups (mention them only in passing, if at all), and stay away from politics.";

export async function generateContent(brand: Brand, idea: IdeaLike, targets: Target[], mode: GenerationMode, client?: LlmClient, opts: { readyToPost?: boolean } = {}): Promise<ContentResult> {
  checkTargets(targets);
  if (mode === "manual") {
    return { versions: [], generatedBy: "manual", warnings: [], manualPrompt: `SYSTEM: ${CONTENT_SYSTEM}\n\n${contentPrompt(brand, idea, targets)}` };
  }
  if (mode === "anthropic") {
    if (!isClaudeConfigured() && !client) {
      return {
        versions: targets.map((t) => generatePlatformVersion(brand, idea, t.platform, t.format)),
        generatedBy: "template",
        warnings: ["Claude mode is selected but neither ANTHROPIC_API_KEY nor Claude Code (subscription) was found, so the free template generator was used."],
      };
    }
    try {
      const text = await (client ?? claudeClient()).complete({ system: CONTENT_SYSTEM, user: contentPrompt(brand, idea, targets) + (opts.readyToPost ? READY_TO_POST : "") });
      const versions = parseJsonResult(text, VersionsSchema);
      const wanted = new Set(targets.map((t) => `${t.platform}/${t.format}`));
      const kept = versions.filter((v) => wanted.has(`${v.platform}/${v.format}`));
      const missing = targets.filter((t) => !kept.some((v) => v.platform === t.platform && v.format === t.format));
      const filled = missing.map((t) => generatePlatformVersion(brand, idea, t.platform, t.format));
      return {
        versions: [...kept, ...filled],
        generatedBy: "anthropic",
        warnings: missing.length ? [`Claude did not return ${missing.map((m) => `${m.platform}/${m.format}`).join(", ")}; template versions were used for those.`] : [],
      };
    } catch (err) {
      log.error("Claude content generation failed; falling back to template", { error: (err as Error).message });
      return {
        versions: targets.map((t) => generatePlatformVersion(brand, idea, t.platform, t.format)),
        generatedBy: "template",
        warnings: [`Claude failed (${(err as Error).message}). Template versions were used instead.`],
      };
    }
  }
  return { versions: targets.map((t) => generatePlatformVersion(brand, idea, t.platform, t.format)), generatedBy: "template", warnings: [] };
}

/** Parses a JSON answer pasted back from Claude chat (manual mode). */
export function parseManualContent(text: string): GeneratedPlatformContent[] {
  const parsed = parseJsonResult(text, z.union([VersionsSchema, GeneratedPlatformContentSchema]));
  return Array.isArray(parsed) ? parsed : [parsed];
}

/* ------------------------------------------------------------------ */
/* Video briefs                                                        */
/* ------------------------------------------------------------------ */

const BriefBodySchema = VideoBriefSchema.omit({ id: true, brandId: true, ideaId: true, contentId: true, platform: true, format: true, generatedBy: true, createdAt: true, isSample: true, videoFile: true });

export interface BriefResult {
  brief: VideoBrief | null;
  warnings: string[];
  manualPrompt?: string;
}

function finishBrief(brand: Brand, idea: IdeaLike, platform: Platform, format: Format, body: z.infer<typeof BriefBodySchema>, mode: GenerationMode): VideoBrief {
  const brief: VideoBrief = { ...body, id: newId("brief"), brandId: brand.id, ideaId: idea.id ?? null, contentId: null, platform, format, generatedBy: mode, createdAt: nowIso(), isSample: false, videoFile: null };
  return VideoBriefSchema.parse(brief);
}

export async function generateBrief(brand: Brand, idea: IdeaLike, platform: Platform, format: Format, durationSec: number, mode: GenerationMode, client?: LlmClient): Promise<BriefResult> {
  checkTargets([{ platform, format }]);
  if (mode === "manual") {
    return { brief: null, warnings: [], manualPrompt: `SYSTEM: ${BRIEF_SYSTEM}\n\n${briefPrompt(brand, idea, platform, format, durationSec)}` };
  }
  if (mode === "anthropic" && (isClaudeConfigured() || client)) {
    try {
      const text = await (client ?? claudeClient()).complete({ system: BRIEF_SYSTEM, user: briefPrompt(brand, idea, platform, format, durationSec), maxTokens: 6000 });
      return { brief: finishBrief(brand, idea, platform, format, parseJsonResult(text, BriefBodySchema), "anthropic"), warnings: [] };
    } catch (err) {
      log.error("Claude brief generation failed; falling back to template", { error: (err as Error).message });
      return { brief: generateVideoBrief(brand, idea, platform, format, durationSec), warnings: [`Claude failed (${(err as Error).message}). A template brief was created instead.`] };
    }
  }
  const warnings = mode === "anthropic" ? ["Neither ANTHROPIC_API_KEY nor Claude Code (subscription) was found, so the free template generator was used."] : [];
  return { brief: generateVideoBrief(brand, idea, platform, format, durationSec), warnings };
}

export function parseManualBrief(brand: Brand, idea: IdeaLike, platform: Platform, format: Format, text: string): VideoBrief {
  return finishBrief(brand, idea, platform, format, parseJsonResult(text, BriefBodySchema), "manual");
}
