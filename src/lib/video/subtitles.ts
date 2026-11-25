import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "../logger";

const log = logger("subtitles");

/**
 * Subtitles for clips that already speak.
 *
 * The words come from a script a person has checked (speech recognition is
 * only used for TIMING, because it gets many words wrong). On Windows the
 * built-in speech recogniser gives a time for each word it hears; the script is
 * matched to those words (longest common subsequence) and every script word gets
 * a time, interpolating where the recogniser misheard. Elsewhere, lines are
 * spread over the clip by length.
 */

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface Caption {
  text: string;
  start: number;
  end: number;
  /** Shown with the accent colour (contains a key brand word). */
  highlight: boolean;
}

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

/** Speech recognition with per-word times (Windows only; [] elsewhere or on failure). */
export async function recogniseWords(ff: string, clip: string): Promise<TimedWord[]> {
  if (process.platform !== "win32") return [];
  const dir = await mkdtemp(path.join(tmpdir(), "sga-stt-"));
  const wav = path.join(dir, "speech.wav");
  try {
    await new Promise<void>((resolve, reject) => {
      const c = spawn(ff, ["-y", "-loglevel", "error", "-i", clip, "-vn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", wav], { windowsHide: true });
      c.on("error", reject);
      c.on("close", (code) => (code === 0 ? resolve() : reject(new Error("could not extract the clip's sound"))));
    });
    const script = [
      "Add-Type -AssemblyName System.Speech",
      "$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()[0])",
      "$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))",
      `$r.SetInputToWaveFile('${wav.replace(/'/g, "''")}')`,
      "while ($true) { try { $res = $r.Recognize() } catch { break }; if (-not $res) { break }; foreach ($w in $res.Words) { $a = $res.GetAudioForWordRange($w, $w); [Console]::WriteLine(('{0}|{1}|{2}' -f $a.AudioPosition.TotalSeconds, ($a.AudioPosition + $a.Duration).TotalSeconds, $w.Text)) } }",
    ].join("; ");
    const out = await new Promise<string>((resolve) => {
      const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
      let s = "";
      p.stdout.on("data", (d: Buffer) => (s += d.toString()));
      p.on("error", () => resolve(""));
      p.on("close", () => resolve(s));
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.split("|"))
      .filter((p) => p.length === 3 && Number.isFinite(Number((p[0] ?? "").replace(",", "."))))
      .map(([a, b, w]) => ({ start: Number(a!.replace(",", ".")), end: Number(b!.replace(",", ".")), word: w!.trim() }));
  } catch (err) {
    log.warn("Speech recognition failed", { error: (err as Error).message });
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Rough transcript from recognised words, split into sentences at pauses (for a person to correct). */
export function draftTranscript(words: TimedWord[]): string {
  const lines: string[] = [];
  let cur: string[] = [];
  words.forEach((w, i) => {
    cur.push(w.word);
    const next = words[i + 1];
    if (!next || next.start - w.end > 0.3 || cur.length >= 10) {
      const s = cur.join(" ");
      lines.push(s[0]!.toUpperCase() + s.slice(1));
      cur = [];
    }
  });
  return lines.join("\n");
}

/** Gives every script word a time by matching it to recognised words (LCS) and interpolating the rest. */
export function alignWords(scriptWords: string[], heard: TimedWord[], clipSec: number): TimedWord[] {
  const a = scriptWords.map(norm);
  const b = heard.map((h) => norm(h.word));
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] && a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const match = new Array<number>(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] && a[i] === b[j]) {
      match[i] = j;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  const speechStart = heard[0]?.start ?? 0;
  const speechEnd = heard.at(-1)?.end ?? clipSec;
  const out: TimedWord[] = scriptWords.map((word, i) => (match[i]! >= 0 ? { word, start: heard[match[i]!]!.start, end: heard[match[i]!]!.end } : { word, start: NaN, end: NaN }));
  // Interpolate unmatched runs between the surrounding matched words (or the speech edges).
  for (let i = 0; i < n; ) {
    if (!Number.isNaN(out[i]!.start)) {
      i++;
      continue;
    }
    let k = i;
    while (k < n && Number.isNaN(out[k]!.start)) k++;
    const from = i > 0 ? out[i - 1]!.end : speechStart;
    const to = k < n ? out[k]!.start : speechEnd;
    const step = Math.max(0.05, (to - from) / (k - i));
    for (let x = i; x < k; x++) out[x] = { word: out[x]!.word, start: from + (x - i) * step, end: from + (x - i + 1) * step };
    i = k;
  }
  return out;
}

const KEY = /karmacoin|recycl|reward|earn|eco|climate|green|sustainab|planet/i;

/**
 * Turns a checked script (one sentence or phrase per line) into short captions
 * timed to the speech: at most `maxWords` words / `maxChars` characters each.
 */
export function buildCaptions(script: string, heard: TimedWord[], clipSec: number, maxWords = 5, maxChars = 26): Caption[] {
  const lines = script.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const words = lines.flatMap((l, li) => l.split(/\s+/).map((w, wi) => ({ w, li, first: wi === 0 })));
  if (!words.length) return [];
  let timed: TimedWord[];
  if (heard.length) timed = alignWords(words.map((x) => x.w), heard, clipSec);
  else {
    // No recogniser: spread words over the clip, weighted by length.
    const total = words.reduce((s, x) => s + x.w.length + 1, 0);
    let t = 0.2;
    const span = Math.max(1, clipSec - 0.4);
    timed = words.map((x) => {
      const d = ((x.w.length + 1) / total) * span;
      const r = { word: x.w, start: t, end: t + d };
      t += d;
      return r;
    });
  }
  // Chunk: never across script lines; break after punctuation or when too long.
  const caps: Caption[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((i) => words[i]!.w).join(" ");
    caps.push({ text, start: timed[cur[0]!]!.start, end: timed[cur.at(-1)!]!.end, highlight: KEY.test(text) });
    cur = [];
  };
  words.forEach((x, i) => {
    if (cur.length && words[cur[0]!]!.li !== x.li) flush();
    const len = cur.reduce((s, k) => s + words[k]!.w.length + 1, 0) + x.w.length;
    if (cur.length && (cur.length >= maxWords || len > maxChars)) flush();
    cur.push(i);
    if (/[.,!?;:]$/.test(x.w) && cur.length >= 2) flush();
  });
  flush();
  // Each caption stays until the next one starts (short gaps closed), at least 0.7 s, never past the clip.
  for (let i = 0; i < caps.length; i++) {
    const next = caps[i + 1];
    const c = caps[i]!;
    if (next && next.start - c.end < 0.6) c.end = next.start;
    c.end = Math.min(clipSec, Math.max(c.end, c.start + 0.7));
    if (next && c.end > next.start) c.end = next.start;
  }
  return caps;
}
