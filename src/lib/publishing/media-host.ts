import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ContentPiece, Platform } from "../schemas";
import { logger } from "../logger";
import { call, isLocalPath, json, PublishError, type ConnectorDeps, type ConnectorEnv } from "./connectors";

const log = logger("media-host");

/**
 * K. Media Host.
 *
 * Instagram and Facebook download a post's images and videos from a public
 * https link; they can't read files on this computer. Before such a post is
 * published, the Media Host uploads its local files and swaps in the public
 * links. Each file is uploaded once per post (the links are kept on the post).
 *
 * Two ways to host, set in .env.local (shared by all brands):
 * - CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME (free plan is
 *   enough). PNG images are delivered as JPEG, which Instagram needs.
 * - MEDIA_PUBLIC_BASE_URL=https://your-public-address, when this app itself is
 *   reachable from the internet. Only files the app made (data/videos) are served.
 * - Otherwise (the default) images go to the brand's Facebook Page as hidden,
 *   unpublished photos, and Meta's own image link is used. Nothing new to sign up
 *   for, and nothing appears on the Page. Videos aren't hosted this way: the
 *   Instagram and Facebook connectors upload local videos themselves.
 *   Set MEDIA_HOST=off to switch this off.
 */

export const PUBLIC_MEDIA_PLATFORMS: Platform[] = ["instagram", "facebook"];

export type HostConfig =
  | { kind: "cloudinary"; cloud: string; key: string; secret: string; folder: string }
  | { kind: "app"; base: string }
  | { kind: "meta" };

export function hostConfig(env: ConnectorEnv): HostConfig | null {
  const url = env.CLOUDINARY_URL?.trim();
  const folder = env.CLOUDINARY_FOLDER?.trim() || "social-growth-agent";
  const m = url?.match(/^cloudinary:\/\/([^:]+):([^@]+)@([\w-]+)/);
  if (m) return { kind: "cloudinary", key: decodeURIComponent(m[1]!), secret: decodeURIComponent(m[2]!), cloud: m[3]!, folder };
  const cloud = env.CLOUDINARY_CLOUD_NAME?.trim();
  const key = env.CLOUDINARY_API_KEY?.trim();
  const secret = env.CLOUDINARY_API_SECRET?.trim();
  if (cloud && key && secret) return { kind: "cloudinary", cloud, key, secret, folder };
  const base = env.MEDIA_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (base && /^https:\/\//i.test(base)) return { kind: "app", base };
  if (env.MEDIA_HOST?.trim().toLowerCase() === "off") return null;
  return { kind: "meta" };
}

export function describeHost(cfg: HostConfig | null): string {
  if (!cfg) return "Not set up";
  if (cfg.kind === "meta") return "Facebook Page (hidden photos; images only)";
  return cfg.kind === "cloudinary" ? `Cloudinary (${cfg.cloud}, folder ${cfg.folder})` : `This app at ${cfg.base}`;
}

const localFile = (p: string) => (p.trim().startsWith("file://") ? decodeURIComponent(new URL(p.trim()).pathname.replace(/^\/([a-z]:)/i, "$1")) : p.trim());

/** Names the app serves at /api/videos/<name> (see src/app/api/videos/[name]/route.ts). */
export const SERVED_NAME = /^(video_[a-z0-9]+\.mp4|cover_[a-z0-9]+\.png|slides_[a-z0-9]+(_\d{2}\.jpg|\.pdf))$/i;

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;

/** Does this host take this file? The Facebook Page host takes images only; videos stay local for the connectors. */
const hosts = (cfg: HostConfig, u: string) => isLocalPath(u) && (cfg.kind !== "meta" || IMAGE.test(localFile(u)));

/** Does this post need its local files hosted before it can be published? */
export function needsHosting(piece: Pick<ContentPiece, "platform" | "mediaUrls">): boolean {
  return PUBLIC_MEDIA_PLATFORMS.includes(piece.platform) && piece.mediaUrls.some(isLocalPath);
}

/** What a local file's public link will look like, for readiness checks before uploading. */
function expectedUrl(file: string, cfg: HostConfig): string {
  const name = path.basename(localFile(file));
  if (cfg.kind === "app") return `${cfg.base}/api/videos/${name}`;
  if (cfg.kind === "meta") return `https://scontent.xx.fbcdn.net/hosted/${name.replace(/\.\w+$/, ".jpg")}`;
  return `https://res.cloudinary.com/${cfg.cloud}/${IMAGE.test(name) ? "image" : "video"}/upload/${cfg.folder}/${name.replace(/\.(png|webp|gif)$/i, ".jpg")}`;
}

/** Problems that would stop hosting a file (missing, or not servable by the app). */
export function hostProblems(piece: Pick<ContentPiece, "platform" | "mediaUrls">, cfg: HostConfig | null): string[] {
  if (!needsHosting(piece)) return [];
  if (!cfg) return [];
  const out: string[] = [];
  for (const u of piece.mediaUrls.filter((x) => hosts(cfg, x))) {
    const f = localFile(u);
    if (!existsSync(f)) out.push(`File not found on this computer: "${u}".`);
    else if (cfg.kind === "app" && !SERVED_NAME.test(path.basename(f))) out.push(`"${path.basename(f)}" wasn't made by this app, so MEDIA_PUBLIC_BASE_URL can't serve it. Use Cloudinary, or paste a public link.`);
  }
  return out;
}

/**
 * The post as the platform will see it once hosted: local paths replaced by
 * the links already made, or by the expected link. Used for readiness checks.
 */
export function asHosted(piece: ContentPiece, cfg: HostConfig | null): ContentPiece {
  if (!cfg || !needsHosting(piece)) return piece;
  return { ...piece, mediaUrls: piece.mediaUrls.map((u) => (hosts(cfg, u) ? piece.hostedMedia[u] || expectedUrl(u, cfg) : u)) };
}

/** Cloudinary signature: SHA-1 of the sorted params plus the API secret. */
export function cloudinarySignature(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(base + secret).digest("hex");
}

const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf" };

/** Uploads one local file and returns its public https link. */
export async function hostFile(file: string, cfg: HostConfig, deps: ConnectorDeps): Promise<string> {
  const f = localFile(file);
  const name = path.basename(f);
  if (!existsSync(f)) throw new PublishError(`File not found on this computer: "${file}".`);
  if (cfg.kind === "app") {
    if (!SERVED_NAME.test(name)) throw new PublishError(`"${name}" wasn't made by this app, so MEDIA_PUBLIC_BASE_URL can't serve it. Use Cloudinary, or paste a public link.`);
    return `${cfg.base}/api/videos/${name}`;
  }
  if (cfg.kind === "meta") return hostOnPage(f, name, deps);
  const bytes = await readFile(f);
  const params = { folder: cfg.folder, timestamp: String(Math.floor(Date.now() / 1000)), use_filename: "true", unique_filename: "true" };
  const signature = cloudinarySignature(params, cfg.secret);
  const body = () => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes)], { type: TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream" }), name);
    for (const [k, v] of Object.entries(params)) fd.append(k, v);
    fd.append("api_key", cfg.key);
    fd.append("signature", signature);
    return { method: "POST", body: fd } as RequestInit;
  };
  const res = await call("media host upload", deps, `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloud)}/auto/upload`, body, { idempotent: true });
  const r = await json<{ secure_url?: string; resource_type?: string; format?: string }>(res);
  if (!r.secure_url) throw new PublishError("Cloudinary did not return a link for the upload.");
  // Instagram publishes JPEG only: ask Cloudinary to deliver other image types as JPEG.
  const url = r.resource_type === "image" && r.format && r.format !== "jpg" && r.format !== "jpeg" ? r.secure_url.replace(/\.\w+$/, ".jpg") : r.secure_url;
  log.info("Hosted media", { file: name, url });
  return url;
}

/**
 * Uploads an image to the brand's Facebook Page as an unpublished photo (it
 * never shows on the Page) and returns Meta's link to the full-size image.
 */
async function hostOnPage(f: string, name: string, deps: ConnectorDeps): Promise<string> {
  const pageId = deps.env.META_PAGE_ID?.trim();
  const token = deps.env.META_PAGE_ACCESS_TOKEN?.trim();
  if (!pageId || !token) throw new PublishError("Images are hosted on the Facebook Page, but META_PAGE_ID / META_PAGE_ACCESS_TOKEN are missing. Connect Facebook, or set CLOUDINARY_URL.");
  const base = `https://graph.facebook.com/${deps.env.META_GRAPH_VERSION?.trim() || "v24.0"}`;
  const bytes = await readFile(f);
  const body = () => {
    const fd = new FormData();
    fd.append("source", new Blob([new Uint8Array(bytes)], { type: TYPES[path.extname(name).toLowerCase()] ?? "image/jpeg" }), name);
    fd.append("published", "false");
    fd.append("access_token", token);
    return { method: "POST", body: fd } as RequestInit;
  };
  const up = await json<{ id?: string }>(await call("media host upload (Facebook Page)", deps, `${base}/${encodeURIComponent(pageId)}/photos`, body, { idempotent: true }));
  if (!up.id) throw new PublishError("Facebook did not return an id for the hosted image.");
  const info = await json<{ images?: Array<{ source: string; width: number }> }>(
    await call("media host link (Facebook Page)", deps, `${base}/${up.id}?fields=images&access_token=${encodeURIComponent(token)}`, { method: "GET" }, { idempotent: true }),
  );
  const best = [...(info.images ?? [])].sort((a, b) => b.width - a.width)[0];
  if (!best?.source) throw new PublishError("Facebook did not return a link for the hosted image.");
  log.info("Hosted media on Facebook Page", { file: name, photoId: up.id });
  return best.source;
}

/**
 * Hosts a post's local files (reusing links already made) and returns the post
 * with public links, plus the full local-to-link map to save on the post.
 */
export async function hostPiece(piece: ContentPiece, cfg: HostConfig, deps: ConnectorDeps): Promise<{ piece: ContentPiece; hosted: Record<string, string>; uploaded: number }> {
  const hosted = { ...piece.hostedMedia };
  let uploaded = 0;
  for (const u of piece.mediaUrls) {
    if (!hosts(cfg, u) || hosted[u]) continue;
    hosted[u] = await hostFile(u, cfg, deps);
    uploaded++;
  }
  return { piece: { ...piece, mediaUrls: piece.mediaUrls.map((u) => (hosts(cfg, u) ? hosted[u]! : u)) }, hosted, uploaded };
}
