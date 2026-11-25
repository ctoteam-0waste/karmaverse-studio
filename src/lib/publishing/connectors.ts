import type { ContentPiece, Platform } from "../schemas";
import { logger } from "../logger";
import { RetryableError, withRetry } from "../retry";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { X_MAX, xLength } from "../agents/content";
import { tagLinks } from "./utm";

const log = logger("connectors");

/**
 * Live publishing connectors for the official platform APIs.
 *
 * Credentials come only from environment variables (.env.local). A connector
 * that is missing credentials reports "not connected" and the Publishing Agent
 * leaves the post scheduled for a person to post by hand.
 *
 * Endpoints follow the official docs linked in ./adapters.ts. Platforms change
 * versions and permissions often: if a call fails with a version or permission
 * error, update the *_VERSION variable or the app's permissions first.
 */

export interface PublishResult {
  externalId: string;
  url: string;
  notes: string[];
}

/** A failure that will not fix itself by retrying (bad token, rejected media, missing permission). */
export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

export interface ConnectorEnv {
  [key: string]: string | undefined;
}

export interface ConnectorDeps {
  fetch: typeof fetch;
  env: ConnectorEnv;
  /** Injected so tests don't wait. */
  sleep: (ms: number) => Promise<void>;
}

export interface Connector {
  platform: Platform;
  /** Env vars that must be set for this connector to publish. */
  required: string[];
  /** At least one of these env vars must be set. */
  requiredOneOf?: string[];
  /** Problems with this post that would make publishing fail. Empty = ready. */
  check(piece: ContentPiece): string[];
  /**
   * publishAt: hand the post to the platform now, and let the platform publish it at that
   * time (only when canSchedule). Then it goes out even if this computer is off.
   */
  publish(piece: ContentPiece, deps: ConnectorDeps, opts?: PublishOptions): Promise<PublishResult>;
  /** The platform can hold a post and publish it at a set time (native scheduling). */
  canSchedule?: boolean;
  /** Deletes a post queued with publishAt (when it was moved, edited or unscheduled here). */
  cancel?(externalId: string, deps: ConnectorDeps): Promise<void>;
}

export interface PublishOptions {
  publishAt?: Date;
}

export function defaultDeps(): ConnectorDeps {
  return { fetch, env: process.env, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
}

export function missingEnv(c: Connector, env: ConnectorEnv): string[] {
  const missing = c.required.filter((k) => !env[k]?.trim());
  if (c.requiredOneOf && !c.requiredOneOf.some((k) => env[k]?.trim())) missing.push(c.requiredOneOf.join(" or "));
  return missing;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const isVideo = (url: string) => /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(url);
const isHttpUrl = (url: string) => /^https:\/\/\S+$/i.test(url);

/** A file on this computer: C:\\…, \\\\server\\…, /home/…, or file://… */
export const isLocalPath = (p: string) => /^([a-z]:[\\/]|\\\\|\/|file:\/\/)/i.test(p.trim());

const LOCAL_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

/**
 * Media rules. `local: true` is for connectors that upload the bytes themselves
 * (YouTube, LinkedIn), so a file on this computer works. Instagram and Facebook
 * fetch media from a URL, so they need a public https link.
 */
function mediaProblems(piece: ContentPiece, opts: { required: boolean; video?: boolean; max?: number; local?: boolean }): string[] {
  const out: string[] = [];
  if (opts.required && piece.mediaUrls.length === 0) out.push(`Add a public media URL: ${piece.platform} ${piece.format} posts need ${opts.video ? "a video" : "an image or video"}.`);
  for (const u of piece.mediaUrls) {
    if (opts.local && isLocalPath(u)) {
      if (!existsSync(localFile(u))) out.push(`File not found on this computer: "${u}".`);
    } else if (!isHttpUrl(u)) {
      out.push(opts.local ? `Media "${u}" must be a public https:// link or a file path on this computer (e.g. C:\\Videos\\reel.mp4).` : `Media URL "${u}" must be a public https:// link the platform can download. Files on this computer work for ${piece.platform} once the Media Host is set up (CLOUDINARY_URL in .env.local; see the Publishing page).`);
    }
  }
  if (opts.video && piece.mediaUrls[0] && !isVideo(piece.mediaUrls[0])) out.push("The first media URL must be a video file (.mp4 or .mov).");
  if (opts.max && piece.mediaUrls.length > opts.max) out.push(`At most ${opts.max} media files for this format.`);
  return out;
}

function placeholderProblems(piece: ContentPiece): string[] {
  return /\[[^\]]{3,}\]/.test([piece.hook, piece.caption, piece.description].join("\n")) ? ["Text still has [bracketed] placeholders."] : [];
}

/** Post text for feed platforms: caption, then hashtags not already in it. */
export function postText(piece: ContentPiece): string {
  const body = tagLinks(piece.caption.trim() || piece.hook.trim(), piece);
  const extra = piece.hashtags.filter((h) => !body.toLowerCase().includes(h.toLowerCase()));
  return extra.length ? `${body}\n\n${extra.join(" ")}` : body;
}

interface CallOptions {
  /** Safe to repeat (GET, status polls, uploads to a fixed URL). Non-idempotent creates are never retried on 5xx. */
  idempotent: boolean;
}

/** One HTTP call with retries on rate limits (and on 5xx/network only when idempotent). */
export async function call(label: string, deps: ConnectorDeps, url: string, init: RequestInit | (() => RequestInit), opts: CallOptions): Promise<Response> {
  return withRetry(
    label,
    async () => {
      let res: Response;
      try {
        res = await deps.fetch(url, typeof init === "function" ? init() : init);
      } catch (err) {
        const msg = `Network error during ${label}: ${(err as Error).message}`;
        if (opts.idempotent) throw new RetryableError(msg);
        throw new PublishError(`${msg}. The post may or may not have been created; check the platform before retrying.`);
      }
      if (res.status === 429 || (opts.idempotent && res.status >= 500)) {
        const retryAfter = Number(res.headers.get("retry-after"));
        throw new RetryableError(`${label} returned ${res.status}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        log.error(`${label} failed`, { status: res.status, body: text.slice(0, 500) });
        throw new PublishError(`${label} failed (${res.status}): ${apiMessage(text)}`);
      }
      return res;
    },
    { attempts: 3, baseDelayMs: 1000, sleep: deps.sleep },
  );
}

/** Pulls the human-readable message out of Meta / Google / LinkedIn error bodies. */
function apiMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string; error_user_msg?: string } | string; message?: string; error_description?: string };
    if (typeof j.error === "object" && j.error) return j.error.error_user_msg || j.error.message || body.slice(0, 200);
    return j.message || j.error_description || (typeof j.error === "string" ? j.error : "") || body.slice(0, 200);
  } catch {
    return body.slice(0, 200) || "no details";
  }
}

const form = (params: Record<string, string>) => new URLSearchParams(params);

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const localFile = (p: string) => (p.trim().startsWith("file://") ? fileURLToPath(p.trim()) : p.trim());

async function download(deps: ConnectorDeps, url: string): Promise<{ bytes: ArrayBuffer; type: string }> {
  if (isLocalPath(url)) {
    const file = localFile(url);
    const buf = await readFile(file).catch((err: Error) => {
      throw new PublishError(`Could not read "${file}": ${err.message}`);
    });
    return { bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, type: LOCAL_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" };
  }
  const res = await call("media download", deps, url, { method: "GET" }, { idempotent: true });
  return { bytes: await res.arrayBuffer(), type: res.headers.get("content-type") || "application/octet-stream" };
}

/* ------------------------------------------------------------------ */
/* Instagram (Graph API content publishing)                            */
/* ------------------------------------------------------------------ */

export function igBase(env: ConnectorEnv): { base: string; token: string } {
  const version = env.META_GRAPH_VERSION?.trim() || "v24.0";
  // Instagram Login tokens use graph.instagram.com; Facebook Login (Page) tokens use graph.facebook.com.
  const igToken = env.INSTAGRAM_ACCESS_TOKEN?.trim();
  return igToken
    ? { base: `https://graph.instagram.com/${version}`, token: igToken }
    : { base: `https://graph.facebook.com/${version}`, token: env.META_PAGE_ACCESS_TOKEN?.trim() ?? "" };
}

async function igWaitReady(deps: ConnectorDeps, base: string, token: string, containerId: string): Promise<void> {
  // Video containers take a while to process. Poll for up to ~5 minutes.
  for (let i = 0; i < 60; i++) {
    const res = await call("instagram status", deps, `${base}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`, { method: "GET" }, { idempotent: true });
    const s = await json<{ status_code?: string; status?: string }>(res);
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new PublishError(`Instagram could not process the media (${s.status_code}${s.status ? `: ${s.status}` : ""}). Check the file format and that the URL is public.`);
    await deps.sleep(5000);
  }
  throw new PublishError("Instagram was still processing the media after 5 minutes. Check the post in Instagram before retrying.");
}

const instagram: Connector = {
  platform: "instagram",
  required: ["INSTAGRAM_ACCOUNT_ID"],
  requiredOneOf: ["INSTAGRAM_ACCESS_TOKEN", "META_PAGE_ACCESS_TOKEN"],
  check(piece) {
    const p = [...placeholderProblems(piece)];
    // Videos on this computer are uploaded directly (resumable upload), so reels and video stories don't need the Media Host.
    if (piece.format === "reel") p.push(...mediaProblems(piece, { required: true, video: true, max: 1, local: true }));
    else if (piece.format === "story") p.push(...mediaProblems(piece, { required: true, max: 1, local: Boolean(piece.mediaUrls[0] && isVideo(piece.mediaUrls[0])) }));
    else p.push(...mediaProblems(piece, { required: true, max: 10 }));
    for (const u of piece.mediaUrls) if (!isVideo(u) && /\.(png|webp|gif)(\?|$)/i.test(u)) p.push(`Instagram publishing needs JPEG images; "${u}" looks like another format.`);
    return p;
  },
  async publish(piece, deps) {
    const igId = deps.env.INSTAGRAM_ACCOUNT_ID!.trim();
    const { base, token } = igBase(deps.env);
    const create = async (params: Record<string, string>) => {
      const res = await call("instagram create container", deps, `${base}/${igId}/media`, { method: "POST", body: form({ ...params, access_token: token }) }, { idempotent: false });
      return (await json<{ id: string }>(res)).id;
    };
    /** A video container: a public URL is fetched by Instagram; a local file is sent with a resumable upload. */
    const videoContainer = async (params: Record<string, string>, src: string) => {
      if (!isLocalPath(src)) return create({ ...params, video_url: src });
      const res = await call("instagram create container", deps, `${base}/${igId}/media`, { method: "POST", body: form({ ...params, upload_type: "resumable", access_token: token }) }, { idempotent: false });
      const c = await json<{ id: string; uri?: string }>(res);
      const file = await download(deps, src);
      const version = base.split("/").pop();
      await call("instagram video upload", deps, c.uri || `https://rupload.facebook.com/ig-api-upload/${version}/${c.id}`, { method: "POST", headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(file.bytes.byteLength) }, body: file.bytes }, { idempotent: true });
      return c.id;
    };
    const caption = postText(piece);
    const urls = piece.mediaUrls;
    let containerId: string;

    if (piece.format === "reel") {
      containerId = await videoContainer({ media_type: "REELS", caption, share_to_feed: "true" }, urls[0]!);
    } else if (piece.format === "story") {
      containerId = isVideo(urls[0]!) ? await videoContainer({ media_type: "STORIES" }, urls[0]!) : await create({ media_type: "STORIES", image_url: urls[0]! });
    } else if (urls.length > 1) {
      const children: string[] = [];
      for (const u of urls) {
        const id = await create(isVideo(u) ? { media_type: "VIDEO", video_url: u, is_carousel_item: "true" } : { image_url: u, is_carousel_item: "true" });
        await igWaitReady(deps, base, token, id);
        children.push(id);
      }
      containerId = await create({ media_type: "CAROUSEL", children: children.join(","), caption });
    } else {
      containerId = await create({ image_url: urls[0]!, caption });
    }

    await igWaitReady(deps, base, token, containerId);
    const pub = await call("instagram publish", deps, `${base}/${igId}/media_publish`, { method: "POST", body: form({ creation_id: containerId, access_token: token }) }, { idempotent: false });
    const mediaId = (await json<{ id: string }>(pub)).id;
    const notes: string[] = [];
    let url = `https://www.instagram.com/`;
    try {
      const r = await call("instagram permalink", deps, `${base}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`, { method: "GET" }, { idempotent: true });
      url = (await json<{ permalink?: string }>(r)).permalink || url;
    } catch {
      notes.push("Published, but the permalink could not be read; open Instagram to copy the link.");
    }
    return { externalId: mediaId, url, notes };
  },
};

/* ------------------------------------------------------------------ */
/* Facebook (Pages API)                                                */
/* ------------------------------------------------------------------ */

const facebook: Connector = {
  platform: "facebook",
  required: ["META_PAGE_ID", "META_PAGE_ACCESS_TOKEN"],
  check(piece) {
    const p = [...placeholderProblems(piece)];
    // Reels are uploaded byte-for-byte (Reels API), so a file on this computer works without the Media Host.
    if (piece.format === "reel") p.push(...mediaProblems(piece, { required: true, video: true, max: 1, local: true }));
    else if (piece.format === "image-post") p.push(...mediaProblems(piece, { required: true, max: 10 }));
    else p.push(...mediaProblems(piece, { required: false }));
    return p;
  },
  canSchedule: true,
  async cancel(externalId, deps) {
    const token = deps.env.META_PAGE_ACCESS_TOKEN!.trim();
    const base = `https://graph.facebook.com/${deps.env.META_GRAPH_VERSION?.trim() || "v24.0"}`;
    await call("facebook cancel scheduled", deps, `${base}/${externalId}?access_token=${encodeURIComponent(token)}`, { method: "DELETE" }, { idempotent: true });
  },
  async publish(piece, deps, opts = {}) {
    const pageId = deps.env.META_PAGE_ID!.trim();
    const token = deps.env.META_PAGE_ACCESS_TOKEN!.trim();
    const base = `https://graph.facebook.com/${deps.env.META_GRAPH_VERSION?.trim() || "v24.0"}`;
    const message = postText(piece);
    const notes: string[] = [];
    let postId: string;
    // Native scheduling: Facebook holds the post and publishes it itself (10 minutes to 30 days ahead).
    const when: Record<string, string> = opts.publishAt ? { published: "false", scheduled_publish_time: String(Math.floor(opts.publishAt.getTime() / 1000)) } : {};

    if (piece.format === "reel") {
      // Reels API: start a session, upload the bytes (or hand over a public URL), then publish.
      // Needs only pages_manage_posts, not publish_video.
      const start = await call("facebook reel start", deps, `${base}/${pageId}/video_reels`, { method: "POST", body: form({ upload_phase: "start", access_token: token }) }, { idempotent: false });
      const { video_id: videoId, upload_url: uploadUrl } = await json<{ video_id: string; upload_url: string }>(start);
      const src = piece.mediaUrls[0]!;
      if (isLocalPath(src)) {
        const file = await download(deps, src);
        await call("facebook reel upload", deps, uploadUrl, { method: "POST", headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(file.bytes.byteLength) }, body: file.bytes }, { idempotent: true });
      } else {
        await call("facebook reel upload", deps, uploadUrl, { method: "POST", headers: { Authorization: `OAuth ${token}`, file_url: src } }, { idempotent: true });
      }
      const state: Record<string, string> = opts.publishAt
        ? { video_state: "SCHEDULED", scheduled_publish_time: String(Math.floor(opts.publishAt.getTime() / 1000)) }
        : { video_state: "PUBLISHED" };
      const fin = await call("facebook reel publish", deps, `${base}/${pageId}/video_reels`, { method: "POST", body: form({ upload_phase: "finish", video_id: videoId, ...state, description: message, access_token: token }) }, { idempotent: false });
      const j = await json<{ post_id?: string }>(fin);
      notes.push(opts.publishAt ? "Queued on Facebook as a scheduled Reel." : "Posted as a Reel. Facebook may take a few minutes to process it.");
      // A scheduled Reel is cancelled by deleting the video, so keep the video id for it.
      return { externalId: opts.publishAt ? videoId : j.post_id || videoId, url: `https://www.facebook.com/reel/${videoId}`, notes };
    }
    if (piece.format === "image-post" && piece.mediaUrls.length === 1) {
      const r = await call("facebook photo", deps, `${base}/${pageId}/photos`, { method: "POST", body: form({ url: piece.mediaUrls[0]!, message, ...when, access_token: token }) }, { idempotent: false });
      const j = await json<{ id: string; post_id?: string }>(r);
      postId = j.post_id || j.id;
    } else if (piece.mediaUrls.length > 0) {
      // Multi-photo post: upload unpublished photos, then attach them to one feed post.
      const ids: string[] = [];
      for (const u of piece.mediaUrls) {
        const r = await call("facebook photo upload", deps, `${base}/${pageId}/photos`, { method: "POST", body: form({ url: u, published: "false", access_token: token }) }, { idempotent: false });
        ids.push((await json<{ id: string }>(r)).id);
      }
      const params: Record<string, string> = { message, ...when, access_token: token };
      ids.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
      const r = await call("facebook post", deps, `${base}/${pageId}/feed`, { method: "POST", body: form(params) }, { idempotent: false });
      postId = (await json<{ id: string }>(r)).id;
    } else {
      const r = await call("facebook post", deps, `${base}/${pageId}/feed`, { method: "POST", body: form({ message, ...when, access_token: token }) }, { idempotent: false });
      postId = (await json<{ id: string }>(r)).id;
    }
    if (opts.publishAt) notes.push("Queued on Facebook; Facebook publishes it at the planned time.");

    let url = `https://www.facebook.com/${postId}`;
    try {
      const r = await call("facebook permalink", deps, `${base}/${postId}?fields=permalink_url&access_token=${encodeURIComponent(token)}`, { method: "GET" }, { idempotent: true });
      url = (await json<{ permalink_url?: string }>(r)).permalink_url || url;
    } catch {
      notes.push("Published, but the permalink could not be read.");
    }
    return { externalId: postId, url, notes };
  },
};

/* ------------------------------------------------------------------ */
/* LinkedIn (Posts API)                                                */
/* ------------------------------------------------------------------ */

/** LinkedIn's version header is YYYYMM; versions are retired after about a year. Default: two months ago. */
export function linkedinVersion(env: ConnectorEnv, now = new Date()): string {
  const set = env.LINKEDIN_API_VERSION?.trim();
  if (set) return set;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * LinkedIn "little text" commentary: reserved characters must be escaped, and
 * hashtags must use the {hashtag|\#|tag} template or they show as plain text.
 */
export function linkedinCommentary(text: string): string {
  const parts = text.split(/(#[\p{L}\p{N}_]+)/u);
  return parts
    .map((part) => {
      const m = part.match(/^#([\p{L}\p{N}_]+)$/u);
      if (m) return `{hashtag|\\#|${m[1]}}`;
      return part.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
    })
    .join("");
}

const linkedin: Connector = {
  platform: "linkedin",
  required: ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_AUTHOR_URN"],
  check(piece) {
    const p = [...placeholderProblems(piece)];
    if (piece.format === "document-carousel") p.push("LinkedIn document carousels can't be published through the API. Post this one by hand.");
    if (piece.format === "image-post") p.push(...mediaProblems(piece, { required: true, max: 20, local: true }));
    else p.push(...mediaProblems(piece, { required: false, local: true }));
    if (piece.mediaUrls.some(isVideo) && piece.mediaUrls.length > 1) p.push("A LinkedIn video post can have only one file: the video.");
    if (postText(piece).length > 3000) p.push("LinkedIn posts are limited to 3,000 characters.");
    return p;
  },
  async publish(piece, deps) {
    const token = deps.env.LINKEDIN_ACCESS_TOKEN!.trim();
    const author = deps.env.LINKEDIN_AUTHOR_URN!.trim();
    const headers = {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": linkedinVersion(deps.env),
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    };

    // Video: initialize, PUT each part, finalize with the parts' ETags, then attach the video URN.
    let video = "";
    if (piece.mediaUrls[0] && isVideo(piece.mediaUrls[0])) {
      const file = await download(deps, piece.mediaUrls[0]);
      const init = await call("linkedin video init", deps, "https://api.linkedin.com/rest/videos?action=initializeUpload", { method: "POST", headers, body: JSON.stringify({ initializeUploadRequest: { owner: author, fileSizeBytes: file.bytes.byteLength, uploadCaptions: false, uploadThumbnail: false } }) }, { idempotent: false });
      const { value } = await json<{ value: { video: string; uploadToken?: string; uploadInstructions: Array<{ uploadUrl: string; firstByte: number; lastByte: number }> } }>(init);
      const etags: string[] = [];
      for (const part of value.uploadInstructions) {
        const r = await call("linkedin video upload", deps, part.uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body: file.bytes.slice(part.firstByte, part.lastByte + 1) }, { idempotent: true });
        etags.push(r.headers.get("etag") ?? "");
      }
      await call("linkedin video finalize", deps, "https://api.linkedin.com/rest/videos?action=finalizeUpload", { method: "POST", headers, body: JSON.stringify({ finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken ?? "", uploadedPartIds: etags } }) }, { idempotent: false });
      video = value.video;
    }

    const images: string[] = [];
    for (const u of video ? [] : piece.mediaUrls) {
      const init = await call("linkedin image init", deps, "https://api.linkedin.com/rest/images?action=initializeUpload", { method: "POST", headers, body: JSON.stringify({ initializeUploadRequest: { owner: author } }) }, { idempotent: false });
      const { value } = await json<{ value: { uploadUrl: string; image: string } }>(init);
      const file = await download(deps, u);
      await call("linkedin image upload", deps, value.uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type }, body: file.bytes }, { idempotent: true });
      images.push(value.image);
    }

    const body: Record<string, unknown> = {
      author,
      commentary: linkedinCommentary(postText(piece)),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (video) body.content = { media: { id: video } };
    if (images.length === 1) body.content = { media: { id: images[0] } };
    if (images.length > 1) body.content = { multiImage: { images: images.map((id) => ({ id })) } };

    const res = await call("linkedin post", deps, "https://api.linkedin.com/rest/posts", { method: "POST", headers, body: JSON.stringify(body) }, { idempotent: false });
    const urn = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id") || "";
    if (!urn) return { externalId: "", url: "https://www.linkedin.com/", notes: ["LinkedIn accepted the post but returned no id; open the page to copy the link."] };
    return { externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/`, notes: [] };
  },
};

/* ------------------------------------------------------------------ */
/* YouTube (Data API v3 resumable upload)                              */
/* ------------------------------------------------------------------ */

async function youtubeAccessToken(deps: ConnectorDeps): Promise<string> {
  const tokenRes = await call(
    "youtube token",
    deps,
    "https://oauth2.googleapis.com/token",
    { method: "POST", body: form({ client_id: deps.env.YOUTUBE_CLIENT_ID!.trim(), client_secret: deps.env.YOUTUBE_CLIENT_SECRET!.trim(), refresh_token: deps.env.YOUTUBE_REFRESH_TOKEN!.trim(), grant_type: "refresh_token" }) },
    { idempotent: true },
  );
  return (await json<{ access_token: string }>(tokenRes)).access_token;
}

const youtube: Connector = {
  platform: "youtube",
  required: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"],
  check(piece) {
    const p = [...placeholderProblems(piece), ...mediaProblems(piece, { required: true, video: true, max: 1, local: true })];
    if (!piece.hook.trim()) p.push("Add a title (the hook field).");
    if (piece.hook.length > 100) p.push("YouTube titles are limited to 100 characters.");
    if (/[<>]/.test(piece.hook + piece.description)) p.push("YouTube does not allow < or > in titles or descriptions.");
    if (piece.description.length > 5000) p.push("YouTube descriptions are limited to 5,000 characters.");
    return p;
  },
  canSchedule: true,
  async cancel(externalId, deps) {
    const accessToken = await youtubeAccessToken(deps);
    await call("youtube cancel scheduled", deps, `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(externalId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }, { idempotent: true });
  },
  async publish(piece, deps, opts = {}) {
    const accessToken = await youtubeAccessToken(deps);
    const video = await download(deps, piece.mediaUrls[0]!);
    const isShort = piece.format === "short";
    const tags = [...new Set(piece.hashtags.map((h) => h.replace(/^#/, "")))];
    const description = [tagLinks(piece.description.trim(), piece), piece.hashtags.join(" ")].filter(Boolean).join("\n\n");
    // Native scheduling: upload as private with publishAt, and YouTube makes it public at that time.
    const privacy = opts.publishAt ? "private" : deps.env.YOUTUBE_PRIVACY?.trim() || "public";
    const publishAt = opts.publishAt ? { publishAt: opts.publishAt.toISOString() } : {};

    const init = await call(
      "youtube upload init",
      deps,
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": video.type.startsWith("video/") ? video.type : "video/*",
          "X-Upload-Content-Length": String(video.bytes.byteLength),
        },
        body: JSON.stringify({
          snippet: { title: piece.hook.trim(), description, tags: [...new Set([...piece.keywords, ...tags])].slice(0, 30), categoryId: deps.env.YOUTUBE_CATEGORY_ID?.trim() || "22" },
          status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, ...publishAt },
        }),
      },
      { idempotent: false },
    );
    const uploadUrl = init.headers.get("location");
    if (!uploadUrl) throw new PublishError("YouTube did not return an upload URL.");
    const up = await call("youtube upload", deps, uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": video.type }, body: video.bytes }, { idempotent: true });
    const v = await json<{ id: string; status?: { privacyStatus?: string } }>(up);
    const notes: string[] = [];
    if (v.status?.privacyStatus && v.status.privacyStatus !== privacy) {
      notes.push(`YouTube set the video to ${v.status.privacyStatus}. Un-audited API projects can only upload private videos; apply for the API audit or change it in YouTube Studio.`);
    }
    if (opts.publishAt) notes.push("Queued on YouTube; YouTube makes it public at the planned time.");
    if (isShort) notes.push("YouTube treats it as a Short only if the video is vertical or square and 3 minutes or shorter.");
    return { externalId: v.id, url: isShort ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`, notes };
  },
};

/* ------------------------------------------------------------------ */
/* X (API v2, OAuth 1.0a user context)                                 */
/* ------------------------------------------------------------------ */

/** RFC 3986 percent-encoding, as OAuth 1.0a requires. */
const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface OAuth1Keys {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/**
 * OAuth 1.0a Authorization header (HMAC-SHA1). Query parameters and any
 * form-encoded body parameters are signed; a JSON body is not.
 */
export function oauth1Header(method: string, url: string, keys: OAuth1Keys, bodyParams: Record<string, string> = {}, nonce = randomBytes(16).toString("hex"), timestamp = String(Math.floor(Date.now() / 1000))): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: keys.token,
    oauth_version: "1.0",
  };
  const u = new URL(url);
  const all: Array<[string, string]> = [...Object.entries(oauth), ...u.searchParams.entries(), ...Object.entries(bodyParams)];
  const paramString = all
    .map(([k, v]) => [pct(k), pct(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), pct(`${u.origin}${u.pathname}`), pct(paramString)].join("&");
  const signature = createHmac("sha1", `${pct(keys.consumerSecret)}&${pct(keys.tokenSecret)}`).update(base).digest("base64");
  return "OAuth " + Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(", ");
}

const x: Connector = {
  platform: "x",
  required: ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"],
  check(piece) {
    const p = [...placeholderProblems(piece)];
    if (piece.mediaUrls.length) p.push("The X connector posts text only for now. Remove the media URLs or post this one by hand.");
    if (piece.format === "image-post" && piece.mediaUrls.length === 0) p.push("Image posts on X need media, which this connector can't upload yet. Change the format to text-post or post by hand.");
    const len = xLength(postText(piece));
    if (len > X_MAX) p.push(`X posts are limited to ${X_MAX} characters; this one is about ${len} with hashtags.`);
    if (!postText(piece).trim()) p.push("The post text is empty.");
    return p;
  },
  async publish(piece, deps) {
    const url = "https://api.x.com/2/tweets";
    const keys = { consumerKey: deps.env.X_API_KEY!.trim(), consumerSecret: deps.env.X_API_SECRET!.trim(), token: deps.env.X_ACCESS_TOKEN!.trim(), tokenSecret: deps.env.X_ACCESS_TOKEN_SECRET!.trim() };
    // Signed per attempt, so a retry after a 429 gets a fresh nonce and timestamp.
    const res = await call("x post", deps, url, () => ({ method: "POST", headers: { Authorization: oauth1Header("POST", url, keys), "Content-Type": "application/json" }, body: JSON.stringify({ text: postText(piece) }) }), { idempotent: false });
    const j = await json<{ data?: { id?: string } }>(res);
    const id = j.data?.id;
    if (!id) return { externalId: "", url: "https://x.com/", notes: ["X accepted the post but returned no id; open the account to copy the link."] };
    return { externalId: id, url: `https://x.com/i/web/status/${id}`, notes: [] };
  },
};

export const CONNECTORS: Record<Platform, Connector> = { instagram, facebook, linkedin, youtube, x };
