import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { dataFile } from "@/lib/db";
import { SERVABLE, videosDir } from "@/lib/video/maker";

export const dynamic = "force-dynamic";

/** Streams a rendered video from data/videos, with Range support so the player can seek. */
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  // Only plain file names in data/videos; never a path.
  if (!SERVABLE.test(name)) return new Response("Not found", { status: 404 });
  const file = path.join(videosDir(dataFile()), name);
  const info = await stat(file).catch(() => null);
  if (!info) return new Response("Not found", { status: 404 });

  const type = name.endsWith(".png") ? "image/png" : name.endsWith(".jpg") ? "image/jpeg" : name.endsWith(".pdf") ? "application/pdf" : "video/mp4";
  const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  if (new URL(request.url).searchParams.has("download")) headers["content-disposition"] = `attachment; filename="${name}"`;

  const range = request.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${info.size}` } });
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...headers, "content-length": String(info.size) } });
}
