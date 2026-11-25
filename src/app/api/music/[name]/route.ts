import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { dataFile } from "@/lib/db";
import { musicDir } from "@/lib/music/agent";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4" };

/** Streams a Music Agent track for preview, with Range support so the player can seek. */
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  // Only plain file names the Music Agent stores (Openverse ids); never a path.
  if (!/^[0-9a-f-]{36}\.(mp3|ogg|wav|flac|m4a)$/i.test(name)) return new Response("Not found", { status: 404 });
  const file = path.join(musicDir(dataFile()), name);
  const info = await stat(file).catch(() => null);
  if (!info) return new Response("Not found", { status: 404 });
  const headers = { "content-type": TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  const range = request.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${info.size}` } });
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...headers, "content-length": String(info.size) } });
}
