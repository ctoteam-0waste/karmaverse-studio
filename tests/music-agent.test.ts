import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyse, creditFor, findMusic, pickTrack, preScore, readLibrary, removeTrack, type Track } from "@/lib/music/agent";
import { ffmpegBinary } from "@/lib/video/maker";

let ff: string | null = null;
try {
  ff = ffmpegBinary();
} catch {
  ff = null;
}

const result = (over: Record<string, unknown> = {}) => ({
  id: "00000000-0000-0000-0000-000000000001",
  title: "Uplifting acoustic background",
  creator: "Artist",
  license: "cc0",
  license_version: "1.0",
  license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
  source: "freesound",
  foreign_landing_url: "https://freesound.org/s/1/",
  url: "https://cdn.example.com/a.mp3",
  filetype: "mp3",
  duration: 60_000,
  tags: [{ name: "happy" }],
  ...over,
});

describe("music agent: choosing", () => {
  it("only accepts licences that are safe for brand videos", () => {
    expect(preScore(result())).not.toBeNull();
    expect(preScore(result({ license: "by" }))).not.toBeNull();
    for (const license of ["by-sa", "by-nc", "by-nd", "by-nc-sa", "by-nc-nd", "sampling+"]) expect(preScore(result({ license }))).toBeNull();
  });

  it("skips sound effects, very short and very long audio", () => {
    expect(preScore(result({ title: "Whoosh transition SFX" }))).toBeNull();
    expect(preScore(result({ tags: [{ name: "riser" }] }))).toBeNull();
    expect(preScore(result({ duration: 8_000 }))).toBeNull();
    expect(preScore(result({ duration: 600_000 }))).toBeNull();
    expect(preScore(result({ license: "cc0" }))!).toBeGreaterThan(preScore(result({ license: "by" }))!);
  });

  it("writes a credit line only when the licence needs one", () => {
    const base = { title: "Dreams Of Good Times", creator: "UNIVERSFIELD", source: "freesound", landingUrl: "https://freesound.org/s/2/", licenseVersion: "4.0" };
    expect(creditFor({ ...base, license: "cc0" })).toBe("");
    expect(creditFor({ ...base, license: "by" })).toBe('Music: "Dreams Of Good Times" by UNIVERSFIELD (freesound), CC BY 4.0 https://freesound.org/s/2/');
  });

  it("picks a track for the mood that is long enough, then by score", () => {
    const t = (id: string, mood: Track["mood"], durationSec: number, score: number) => ({ id, mood, durationSec, score }) as Track;
    const lib = [t("short-best", "uplifting", 20, 9), t("long-ok", "uplifting", 90, 6), t("calm", "calm", 120, 10)];
    expect(pickTrack(lib, "uplifting", 30)!.id).toBe("long-ok");
    expect(pickTrack(lib, "calm", 30)!.id).toBe("calm");
    expect(pickTrack(lib, "energetic", 30)!.id).toBe("calm"); // falls back to any mood
    expect(pickTrack([], "calm", 30)).toBeNull();
  });
});

describe.skipIf(!ff)("music agent: checking and library (needs ffmpeg)", () => {
  const make = (dir: string, name: string, src: string) => {
    const f = path.join(dir, name);
    execFileSync(ff!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", src, "-ac", "2", "-b:a", "128k", f]);
    return f;
  };

  it("tells music-like tones from noise", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sga-music-"));
    try {
      const tone = make(dir, "tone.mp3", "aevalsrc='0.3*sin(2*PI*440*t)+0.2*sin(2*PI*554.37*t)+0.15*sin(2*PI*659.25*t)':d=25:s=44100");
      const noise = make(dir, "noise.mp3", "anoisesrc=color=white:amplitude=0.3:d=25:r=44100");
      const a = await analyse(ff!, tone);
      const b = await analyse(ff!, noise);
      expect(a.flatness).toBeLessThan(0.11);
      expect(b.flatness).toBeGreaterThan(0.11);
      expect(a.seconds).toBeGreaterThan(24);
      expect(a.lufs).toBeGreaterThan(-30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("searches, downloads, checks and stores tracks; rejects noise; removes tracks", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sga-music-lib-"));
    try {
      const tone = readFileSync(make(dir, "src-tone.mp3", "aevalsrc='0.3*sin(2*PI*392*t)+0.2*sin(2*PI*493.88*t)':d=30:s=44100"));
      const noise = readFileSync(make(dir, "src-noise.mp3", "anoisesrc=color=pink:amplitude=0.4:d=30:r=44100"));
      const results = [
        result({ id: "11111111-1111-1111-1111-111111111111", title: "Happy acoustic", url: "https://cdn.example.com/tone.mp3", license: "by", license_version: "4.0" }),
        result({ id: "22222222-2222-2222-2222-222222222222", title: "Bright background", url: "https://cdn.example.com/noise.mp3" }),
        result({ id: "33333333-3333-3333-3333-333333333333", title: "Not allowed", license: "by-nc" }),
      ];
      const fetchFake = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("api.openverse.org")) return new Response(JSON.stringify({ results }), { status: 200 });
        if (url.endsWith("tone.mp3")) return new Response(tone, { status: 200 });
        if (url.endsWith("noise.mp3")) return new Response(noise, { status: 200 });
        return new Response("no", { status: 404 });
      }) as typeof fetch;
      const r = await findMusic(dir, "uplifting", 4, { fetch: fetchFake, sleep: async () => undefined, ffmpeg: ff! });
      expect(r.added.map((t) => t.title)).toEqual(["Happy acoustic"]);
      expect(r.rejected.join(" ")).toMatch(/Bright background.*noise/);
      expect(r.added[0]!.credit).toMatch(/^Music: "Happy acoustic" by Artist/);
      expect((await readLibrary(dir)).length).toBe(1);
      // Running again doesn't add the same track twice.
      const again = await findMusic(dir, "uplifting", 4, { fetch: fetchFake, sleep: async () => undefined, ffmpeg: ff! });
      expect(again.added).toHaveLength(0);
      expect(await removeTrack(dir, "11111111-1111-1111-1111-111111111111")).not.toBeNull();
      expect(await readLibrary(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
