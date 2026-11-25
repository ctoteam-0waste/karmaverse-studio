import type { Experiment, Format, Platform, PostMetric } from "../schemas";
import { FORMATS, PLATFORMS } from "../schemas";
import { median, newId, nowIso, round } from "../util";
import { metricsFor, primaryScore, volumeMetric } from "./metrics";

/** Minimum posts in a group before we call anything a pattern. */
export const MIN_SAMPLE = 3;

export interface ScoredPost {
  post: PostMetric;
  score: number | null;
  volume: number | null;
  ratios: Record<string, number | null>;
  /** Score relative to the median of EARLIER posts with the same platform + format. */
  vsHistory: { median: number; diff: number; priorCount: number } | null;
}

export function groupKey(platform: Platform, format: Format): string {
  return `${platform}/${format}`;
}

/**
 * The metrics a brand's analysis should use: once it has any real data,
 * invented sample rows are left out so they can't skew the advice.
 */
export function analysisMetrics(all: PostMetric[], brandId: string): PostMetric[] {
  const mine = all.filter((m) => m.brandId === brandId);
  return mine.some((m) => !m.isSample) ? mine.filter((m) => !m.isSample) : mine;
}

export function scorePosts(posts: PostMetric[]): ScoredPost[] {
  const sorted = [...posts].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
  const history = new Map<string, number[]>();

  return sorted.map((post) => {
    const defs = metricsFor(post.platform, post.format);
    const score = primaryScore(post.platform, post.format, post.metrics);
    const vk = volumeMetric(post.platform, post.format);
    const ratios: Record<string, number | null> = {};
    for (const [k, def] of Object.entries(defs?.ratios ?? {})) ratios[k] = def.compute(post.metrics);

    const key = groupKey(post.platform, post.format);
    const prior = history.get(key) ?? [];
    const med = median(prior);
    const vsHistory = score !== null && med !== null && prior.length >= MIN_SAMPLE && med > 0 ? { median: med, diff: (score - med) / med, priorCount: prior.length } : null;
    if (score !== null) history.set(key, [...prior, score]);

    return { post, score, volume: post.metrics[vk] ?? null, ratios, vsHistory };
  });
}

/* ------------------------------------------------------------------ */
/* Group summaries                                                     */
/* ------------------------------------------------------------------ */

export interface GroupSummary {
  platform: Platform;
  format: Format;
  count: number;
  scoreLabel: string;
  scoreFormat: "percent" | "number";
  medianScore: number | null;
  medianVolume: number | null;
  volumeLabel: string;
  best: ScoredPost | null;
  worst: ScoredPost | null;
  /** Median of the last 3 vs the 3 before; null when fewer than 6 posts. */
  trend: number | null;
  enoughData: boolean;
}

export function summarise(scored: ScoredPost[]): GroupSummary[] {
  const out: GroupSummary[] = [];
  for (const platform of PLATFORMS) {
    for (const format of FORMATS) {
      const group = scored.filter((s) => s.post.platform === platform && s.post.format === format);
      if (group.length === 0) continue;
      const defs = metricsFor(platform, format);
      const scores = group.map((g) => g.score).filter((s): s is number => s !== null);
      const vols = group.map((g) => g.volume).filter((v): v is number => v !== null);
      const withScore = group.filter((g) => g.score !== null);
      const sortedByScore = [...withScore].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      let trend: number | null = null;
      if (scores.length >= 6) {
        const recent = median(scores.slice(-3));
        const before = median(scores.slice(-6, -3));
        if (recent !== null && before !== null && before > 0) trend = (recent - before) / before;
      }
      const vk = volumeMetric(platform, format);
      out.push({
        platform,
        format,
        count: group.length,
        scoreLabel: defs?.primary.label ?? "Score",
        scoreFormat: defs?.primary.format ?? "percent",
        medianScore: median(scores),
        medianVolume: median(vols),
        volumeLabel: defs?.metrics.find((m) => m.key === vk)?.label ?? vk,
        best: sortedByScore[0] ?? null,
        worst: sortedByScore.length > 1 ? sortedByScore[sortedByScore.length - 1]! : null,
        trend,
        enoughData: group.length >= MIN_SAMPLE,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Patterns: hooks, CTAs, posting time                                 */
/* ------------------------------------------------------------------ */

export const HOOK_TYPES = ["question", "myth-or-fact", "number-list", "how-to", "pov-story", "warning", "statement"] as const;
export type HookType = (typeof HOOK_TYPES)[number];

export function classifyHook(hook: string): HookType {
  const h = hook.toLowerCase();
  if (/\bmyth\b|\bfact\b|\bwrong\b/.test(h)) return "myth-or-fact";
  if (/^(stop|don't|never|avoid|warning)\b/.test(h)) return "warning";
  if (/^pov\b|\bday in\b|\bstory\b|\bwe (started|built)\b/.test(h)) return "pov-story";
  if (/^\d+|\b\d+ (ways|things|swaps|tips|habits|mistakes)\b/.test(h)) return "number-list";
  if (/^how\b|\bhow to\b|\bexplained\b|\bstep\b/.test(h)) return "how-to";
  if (h.includes("?") || /^(why|what|which|do|does|can|is|are|kya|kaise)\b/.test(h)) return "question";
  return "statement";
}

export interface PatternRow {
  group: string;
  label: string;
  count: number;
  medianScore: number | null;
  /** Relative to the group median; null if not enough data. */
  lift: number | null;
}

function patternRows(scored: ScoredPost[], labelOf: (s: ScoredPost) => string | null): PatternRow[] {
  const rows: PatternRow[] = [];
  const groups = new Map<string, ScoredPost[]>();
  for (const s of scored) {
    if (s.score === null) continue;
    const k = groupKey(s.post.platform, s.post.format);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const [group, items] of groups) {
    const groupMedian = median(items.map((i) => i.score!));
    const byLabel = new Map<string, number[]>();
    for (const i of items) {
      const l = labelOf(i);
      if (!l) continue;
      byLabel.set(l, [...(byLabel.get(l) ?? []), i.score!]);
    }
    for (const [label, scores] of byLabel) {
      const m = median(scores);
      rows.push({
        group,
        label,
        count: scores.length,
        medianScore: m,
        lift: scores.length >= 2 && items.length >= MIN_SAMPLE && m !== null && groupMedian ? (m - groupMedian) / groupMedian : null,
      });
    }
  }
  return rows.sort((a, b) => (b.lift ?? -Infinity) - (a.lift ?? -Infinity));
}

export function hookPatterns(scored: ScoredPost[]): PatternRow[] {
  return patternRows(scored, (s) => (s.post.hook ? classifyHook(s.post.hook) : null));
}

export function ctaPatterns(scored: ScoredPost[]): PatternRow[] {
  return patternRows(scored, (s) => {
    const c = s.post.cta.toLowerCase();
    if (!c) return null;
    if (/save/.test(c)) return "save";
    if (/share|tag/.test(c)) return "share/tag";
    if (/comment|tell us/.test(c)) return "comment";
    if (/download|app|book|link/.test(c)) return "app/link";
    if (/follow|subscribe/.test(c)) return "follow";
    return "other";
  });
}

export function pillarPatterns(scored: ScoredPost[]): PatternRow[] {
  return patternRows(scored, (s) => s.post.pillarId || null);
}

export function hourBucket(iso: string, timeZone = "Asia/Kolkata"): string {
  return bucketForHour(Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone }).format(new Date(iso))));
}

/** Posting window for an hour of the day (0–23, local time). */
export function bucketForHour(hour: number): string {
  if (hour >= 6 && hour < 11) return "morning (6–11)";
  if (hour >= 11 && hour < 16) return "midday (11–16)";
  if (hour >= 16 && hour < 21) return "evening (16–21)";
  return "night (21–6)";
}

export interface TimeRecommendation {
  group: string;
  bucket: string | null;
  basis: "data" | "experiment";
  note: string;
}

/** Recommends a posting window from history, or labels the suggestion an experiment. */
export function bestPostingTimes(scored: ScoredPost[], timeZone = "Asia/Kolkata"): TimeRecommendation[] {
  const rows = patternRows(scored, (s) => hourBucket(s.post.postedAt, timeZone));
  const groups = [...new Set(scored.map((s) => groupKey(s.post.platform, s.post.format)))];
  return groups.map((group) => {
    const candidates = rows.filter((r) => r.group === group && r.count >= MIN_SAMPLE && r.lift !== null).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
    const best = candidates[0];
    if (best && candidates.length >= 2) {
      return { group, bucket: best.label, basis: "data", note: `Based on ${best.count} posts in this window vs other windows with ${MIN_SAMPLE}+ posts each.` };
    }
    return {
      group,
      bucket: "evening (16–21)",
      basis: "experiment",
      note: `Not enough history to compare time windows (need ${MIN_SAMPLE}+ posts in at least two windows). Treat evening as a starting experiment, then rotate windows.`,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Diagnosis                                                           */
/* ------------------------------------------------------------------ */

export interface Diagnosis {
  postId: string;
  findings: string[];
  suggestions: string[];
}

/** Evidence-based reasons a post under-performed. Only uses metrics that exist. */
export function diagnose(target: ScoredPost, all: ScoredPost[]): Diagnosis {
  const peers = all.filter((s) => s.post.id !== target.post.id && s.post.platform === target.post.platform && s.post.format === target.post.format);
  const findings: string[] = [];
  const suggestions: string[] = [];
  if (peers.length < MIN_SAMPLE) {
    return { postId: target.post.id, findings: [`Only ${peers.length} other ${target.post.platform} ${target.post.format} posts to compare with; need ${MIN_SAMPLE}.`], suggestions: ["Keep posting this format and log metrics; diagnosis becomes reliable after a few more posts."] };
  }
  const defs = metricsFor(target.post.platform, target.post.format);
  for (const [key, val] of Object.entries(target.ratios)) {
    if (val === null) continue;
    const peerMed = median(peers.map((p) => p.ratios[key]).filter((v): v is number => v !== null && v !== undefined));
    if (peerMed === null || peerMed === 0) continue;
    const diff = (val - peerMed) / peerMed;
    if (diff > -0.25) continue;
    const label = defs?.ratios[key]?.label ?? key;
    findings.push(`${label} was ${round(Math.abs(diff) * 100, 0)}% below the median of ${peers.length} similar posts.`);
    if (key === "watchRatio" || key === "exitRate") suggestions.push("Retention dropped: test a faster hook (action in frame 1) and cut the intro.");
    if (key === "shareRate") suggestions.push("Few shares: make the post more useful or relatable to send to a friend (checklist, myth-buster, 'tag someone').");
    if (key === "saveRate") suggestions.push("Few saves: add a reference element worth keeping (steps, checklist, summary slide).");
    if (key === "profileVisitRate" || key === "followRate" || key === "subRate") suggestions.push("Low follow-through: end with a reason to follow (series name, 'part 2 tomorrow').");
    if (key === "ctr") suggestions.push("Low click-through: test a new thumbnail with fewer words and a clearer face/object, and a more specific title.");
    if (key === "clickRate") suggestions.push("Few clicks: put one clear link CTA earlier and say what they get by clicking.");
    if (key === "commentRate") suggestions.push("Few comments: end with a specific, easy-to-answer question.");
  }
  const vol = target.volume;
  const peerVol = median(peers.map((p) => p.volume).filter((v): v is number => v !== null));
  if (vol !== null && peerVol && vol < peerVol * 0.6 && target.score !== null) {
    const peerScore = median(peers.map((p) => p.score).filter((v): v is number => v !== null));
    if (peerScore !== null && target.score >= peerScore) {
      findings.push("Distribution was low but people who saw it engaged normally.");
      suggestions.push("The content worked; distribution didn't. Test a different posting window or a stronger first frame for non-followers.");
    }
  }
  if (findings.length === 0) findings.push("No ratio fell more than 25% below similar posts. Differences are within normal variation.");
  return { postId: target.post.id, findings, suggestions: [...new Set(suggestions)] };
}

/* ------------------------------------------------------------------ */
/* Experiment recommendations                                          */
/* ------------------------------------------------------------------ */

export function recommendExperiments(brandId: string, scored: ScoredPost[]): Experiment[] {
  const out: Experiment[] = [];
  const created = nowIso();
  const base = (platform: Platform, format: Format) => ({ id: newId("exp"), brandId, platform, format, status: "proposed" as const, startDate: null, endDate: null, result: "", learning: "", createdAt: created, isSample: false });

  for (const g of summarise(scored)) {
    const fmt = (n: number | null) => (n === null ? "n/a" : g.scoreFormat === "percent" ? `${round(n * 100, 2)}%` : `${round(n, 2)}`);
    if (!g.enoughData) {
      out.push({ ...base(g.platform, g.format), hypothesis: `Posting ${g.platform} ${g.format}s consistently for 3 weeks will establish a baseline.`, variable: "format", change: "Post at least 2 per week and log metrics after 7 days.", primaryMetric: g.scoreLabel, baseline: `${g.count} post(s) so far`, impact: 3, effort: 2 });
      continue;
    }
    const hooks = hookPatterns(scored).filter((r) => r.group === groupKey(g.platform, g.format) && r.lift !== null);
    const topHook = hooks[0];
    if (topHook && (topHook.lift ?? 0) > 0.15) {
      out.push({ ...base(g.platform, g.format), hypothesis: `"${topHook.label}" hooks outperform other hooks on ${g.platform} ${g.format}s.`, variable: "hook", change: `Use a ${topHook.label} hook on the next 4 posts; keep topic mix and posting time the same.`, primaryMetric: g.scoreLabel, baseline: `Group median ${fmt(g.medianScore)}`, impact: 4, effort: 1 });
    }
    const t = bestPostingTimes(scored).find((r) => r.group === groupKey(g.platform, g.format));
    if (t?.basis === "experiment") {
      out.push({ ...base(g.platform, g.format), hypothesis: `A different posting window changes reach for ${g.platform} ${g.format}s.`, variable: "posting-time", change: "Alternate morning and evening for 2 weeks; change nothing else.", primaryMetric: g.volumeLabel, baseline: `Median ${g.volumeLabel.toLowerCase()} ${g.medianVolume ?? "n/a"}`, impact: 3, effort: 1 });
    }
    if (g.trend !== null && g.trend < -0.15) {
      out.push({ ...base(g.platform, g.format), hypothesis: `Recent ${g.platform} ${g.format}s are slipping because the opening is weaker than earlier posts.`, variable: "hook", change: "Rewrite hooks to show the payoff in the first 2 seconds for the next 3 posts.", primaryMetric: g.scoreLabel, baseline: `Last 3 vs previous 3: ${round(g.trend * 100, 0)}%`, impact: 4, effort: 2 });
    }
  }
  return out.sort((a, b) => b.impact / b.effort - a.impact / a.effort);
}

/* ------------------------------------------------------------------ */
/* CSV import                                                          */
/* ------------------------------------------------------------------ */

export interface CsvImportResult {
  rows: Array<Omit<PostMetric, "id" | "brandId" | "isSample">>;
  errors: string[];
  warnings: string[];
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const BASE_COLUMNS = ["platform", "format", "postedAt", "hook", "pillarId", "cta", "url"];

/**
 * CSV columns: platform, format, postedAt (ISO date/time), hook, pillarId, cta, url,
 * then one column per metric key for that platform + format (see Analytics page).
 */
export function parseMetricsCsv(text: string): CsvImportResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const errors: string[] = [];
  const warnings: string[] = [];
  if (lines.length < 2) return { rows: [], errors: ["The CSV needs a header row and at least one data row."], warnings };
  const header = parseCsvLine(lines[0]!);
  for (const req of ["platform", "format", "postedAt"]) if (!header.includes(req)) errors.push(`Missing required column "${req}".`);
  if (errors.length) return { rows: [], errors, warnings };

  const rows: CsvImportResult["rows"] = [];
  lines.slice(1).forEach((line, idx) => {
    const n = idx + 2;
    const cells = parseCsvLine(line);
    const get = (k: string) => cells[header.indexOf(k)] ?? "";
    const platform = get("platform").toLowerCase() as Platform;
    const format = get("format").toLowerCase() as Format;
    if (!PLATFORMS.includes(platform)) return void errors.push(`Row ${n}: unknown platform "${get("platform")}".`);
    const defs = metricsFor(platform, format);
    if (!defs) return void errors.push(`Row ${n}: format "${format}" is not tracked for ${platform}.`);
    const postedAt = new Date(get("postedAt"));
    if (Number.isNaN(postedAt.getTime())) return void errors.push(`Row ${n}: postedAt "${get("postedAt")}" is not a valid date.`);

    const allowed = new Set(defs.metrics.map((m) => m.key));
    const metrics: Record<string, number> = {};
    header.forEach((col, i) => {
      if (BASE_COLUMNS.includes(col)) return;
      const raw = cells[i] ?? "";
      if (raw === "") return;
      if (!allowed.has(col)) {
        warnings.push(`Row ${n}: "${col}" is not a ${platform} ${format} metric and was ignored.`);
        return;
      }
      const v = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(v) || v < 0) warnings.push(`Row ${n}: "${col}" value "${raw}" is not a valid number and was ignored.`);
      else metrics[col] = v;
    });
    if (Object.keys(metrics).length === 0) return void errors.push(`Row ${n}: no valid metric values.`);
    rows.push({ contentId: null, platform, format, postedAt: postedAt.toISOString(), hook: get("hook"), pillarId: get("pillarId"), cta: get("cta"), url: get("url"), metrics, source: "csv-import", syncedAt: null });
  });
  return { rows, errors, warnings: [...new Set(warnings)] };
}
