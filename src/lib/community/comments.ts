import type { Platform } from "../schemas";
import { call, igBase, json, linkedinVersion, oauth1Header, PublishError, type ConnectorDeps, type ConnectorEnv } from "../publishing/connectors";

/**
 * Comment readers and reply senders for the Community Manager, using each
 * platform's official API and the brand's own tokens.
 *
 * Reading and replying need permissions beyond posting (see COMMENT_SCOPES).
 * A missing permission is reported, never worked around.
 */

export interface RemoteComment {
  /** Platform's id for the comment (used to reply and to avoid duplicates). */
  id: string;
  author: string;
  text: string;
  at: string;
  /** The brand's own comment: never added to the inbox. */
  own: boolean;
  /** The brand already replied on the platform. */
  answered: boolean;
}

export const COMMENT_SCOPES: Record<Platform, { read: string; reply: string }> = {
  instagram: { read: "instagram_business_manage_comments (Instagram Login) or instagram_manage_comments (Facebook Login)", reply: "instagram_business_manage_comments (Instagram Login) or instagram_manage_comments (Facebook Login)" },
  facebook: { read: "pages_read_engagement and pages_read_user_content on the Page token", reply: "pages_manage_engagement" },
  youtube: { read: "the youtube.force-ssl scope: get a new refresh token with it added (Publishing page steps)", reply: "the same youtube.force-ssl scope" },
  linkedin: { read: "r_organization_social", reply: "w_organization_social" },
  x: { read: "a paid X API plan (Basic or higher); the free plan can't read replies", reply: "Read and Write keys (free plan works)" },
};

/** Env vars needed before comments can be read for a platform. */
export const COMMENT_NEEDS: Record<Platform, string[]> = {
  instagram: ["INSTAGRAM_ACCOUNT_ID"],
  facebook: ["META_PAGE_ID", "META_PAGE_ACCESS_TOKEN"],
  youtube: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"],
  linkedin: ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_AUTHOR_URN"],
  x: ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"],
};

export function canUseComments(platform: Platform, env: ConnectorEnv): boolean {
  if (platform === "instagram" && !env.INSTAGRAM_ACCESS_TOKEN && !env.META_PAGE_ACCESS_TOKEN) return false;
  return COMMENT_NEEDS[platform].every((k) => env[k]?.trim());
}

const MAX = 50;
const metaBase = (env: ConnectorEnv) => `https://graph.facebook.com/${env.META_GRAPH_VERSION?.trim() || "v24.0"}`;
const form = (p: Record<string, string>) => new URLSearchParams(p);

/* ------------------------------------------------------------------ */
/* Instagram                                                           */
/* ------------------------------------------------------------------ */

interface IgComment {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  from?: { id?: string; username?: string };
  replies?: { data?: Array<{ from?: { id?: string } }> };
}

async function readInstagram(postId: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<RemoteComment[]> {
  const { base, token } = igBase(env);
  const me = env.INSTAGRAM_ACCOUNT_ID!.trim();
  const url = `${base}/${encodeURIComponent(postId)}/comments?fields=id,text,username,timestamp,from{id,username},replies{from{id}}&limit=${MAX}&access_token=${encodeURIComponent(token)}`;
  const data = (await json<{ data?: IgComment[] }>(await call("instagram comments", deps, url, { method: "GET" }, { idempotent: true }))).data ?? [];
  return data
    .filter((c) => c.text)
    .map((c) => ({
      id: c.id,
      author: `@${c.username || c.from?.username || "instagram user"}`,
      text: c.text!,
      at: c.timestamp ?? new Date().toISOString(),
      own: c.from?.id === me,
      answered: (c.replies?.data ?? []).some((r) => r.from?.id === me),
    }));
}

async function replyInstagram(commentId: string, message: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<string> {
  const { base, token } = igBase(env);
  const r = await call("instagram reply", deps, `${base}/${encodeURIComponent(commentId)}/replies`, { method: "POST", body: form({ message, access_token: token }) }, { idempotent: false });
  return (await json<{ id: string }>(r)).id;
}

/* ------------------------------------------------------------------ */
/* Facebook                                                            */
/* ------------------------------------------------------------------ */

interface FbComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
  comments?: { data?: Array<{ from?: { id?: string } }> };
}

/**
 * Facebook ids worth trying for a post: reels are stored as the bare post id
 * ("1221…"), which Graph treats as a deprecated "status" unless it is prefixed
 * with the Page id ("PAGEID_1221…"); a video id works on its own.
 */
export function facebookObjectIds(id: string, pageId: string): string[] {
  const t = id.trim();
  if (t.includes("_") || !pageId) return [t];
  return [`${pageId}_${t}`, t];
}

/** GET on the first Facebook id form that works; rethrows the last error. */
async function fbGet<T>(label: string, postId: string, query: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<T> {
  let last: unknown;
  for (const id of facebookObjectIds(postId, env.META_PAGE_ID?.trim() ?? "")) {
    try {
      const url = `${metaBase(env)}/${encodeURIComponent(id)}/${query}&access_token=${encodeURIComponent(env.META_PAGE_ACCESS_TOKEN!.trim())}`;
      return await json<T>(await call(label, deps, url, { method: "GET" }, { idempotent: true }));
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** People who reacted to a Facebook post (Like, Love…), by display name. */
export async function readFacebookReactions(postId: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<Array<{ name: string; type: string }>> {
  const data = (await fbGet<{ data?: Array<{ id?: string; name?: string; type?: string }> }>("facebook reactions", postId, `reactions?fields=id,name,type&limit=${MAX}`, env, deps)).data ?? [];
  return data.filter((r) => r.name).map((r) => ({ name: r.name!, type: (r.type ?? "LIKE").toLowerCase() }));
}

async function readFacebook(postId: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<RemoteComment[]> {
  const page = env.META_PAGE_ID!.trim();
  const data = (await fbGet<{ data?: FbComment[] }>("facebook comments", postId, `comments?fields=id,message,created_time,from{id,name},comments.limit(10){from{id}}&filter=toplevel&order=reverse_chronological&limit=${MAX}`, env, deps)).data ?? [];
  return data
    .filter((c) => c.message)
    .map((c) => ({
      id: c.id,
      // Facebook hides commenter names unless the app has pages_read_user_content.
      author: c.from?.name || "Facebook user",
      text: c.message!,
      at: c.created_time ? new Date(c.created_time).toISOString() : new Date().toISOString(),
      own: c.from?.id === page,
      answered: (c.comments?.data ?? []).some((r) => r.from?.id === page),
    }));
}

async function replyFacebook(commentId: string, message: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<string> {
  const r = await call("facebook reply", deps, `${metaBase(env)}/${encodeURIComponent(commentId)}/comments`, { method: "POST", body: form({ message, access_token: env.META_PAGE_ACCESS_TOKEN!.trim() }) }, { idempotent: false });
  return (await json<{ id: string }>(r)).id;
}

/* ------------------------------------------------------------------ */
/* YouTube                                                             */
/* ------------------------------------------------------------------ */

export async function youtubeAccessToken(env: ConnectorEnv, deps: ConnectorDeps): Promise<string> {
  const r = await call("youtube token", deps, "https://oauth2.googleapis.com/token", { method: "POST", body: form({ client_id: env.YOUTUBE_CLIENT_ID!.trim(), client_secret: env.YOUTUBE_CLIENT_SECRET!.trim(), refresh_token: env.YOUTUBE_REFRESH_TOKEN!.trim(), grant_type: "refresh_token" }) }, { idempotent: true });
  return (await json<{ access_token: string }>(r)).access_token;
}

interface YtThread {
  snippet?: {
    channelId?: string;
    topLevelComment?: { id: string; snippet?: { authorDisplayName?: string; textOriginal?: string; textDisplay?: string; publishedAt?: string; authorChannelId?: { value?: string } } };
  };
  replies?: { comments?: Array<{ snippet?: { authorChannelId?: { value?: string } } }> };
}

async function readYoutube(videoId: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<RemoteComment[]> {
  const token = await youtubeAccessToken(env, deps);
  const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet,replies&videoId=${encodeURIComponent(videoId)}&maxResults=${MAX}&order=time&textFormat=plainText`;
  let items: YtThread[];
  try {
    items = (await json<{ items?: YtThread[] }>(await call("youtube comments", deps, url, { method: "GET", headers: { Authorization: `Bearer ${token}` } }, { idempotent: true }))).items ?? [];
  } catch (err) {
    // Private videos and videos with comments turned off have no comments to read.
    if (/commentsDisabled|disabled comments/i.test((err as Error).message)) return [];
    throw err;
  }
  const out: RemoteComment[] = [];
  for (const t of items) {
    const top = t.snippet?.topLevelComment;
    const s = top?.snippet;
    const text = s?.textOriginal || s?.textDisplay;
    if (!top || !text) continue;
    const channel = t.snippet?.channelId;
    out.push({
      id: top.id,
      author: s?.authorDisplayName || "YouTube user",
      text,
      at: s?.publishedAt ?? new Date().toISOString(),
      own: Boolean(channel && s?.authorChannelId?.value === channel),
      answered: Boolean(channel && (t.replies?.comments ?? []).some((r) => r.snippet?.authorChannelId?.value === channel)),
    });
  }
  return out;
}

async function replyYoutube(commentId: string, message: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<string> {
  const token = await youtubeAccessToken(env, deps);
  const r = await call(
    "youtube reply",
    deps,
    "https://www.googleapis.com/youtube/v3/comments?part=snippet",
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: message } }) },
    { idempotent: false },
  );
  return (await json<{ id: string }>(r)).id;
}

/* ------------------------------------------------------------------ */
/* LinkedIn                                                            */
/* ------------------------------------------------------------------ */

const liHeaders = (env: ConnectorEnv) => ({
  Authorization: `Bearer ${env.LINKEDIN_ACCESS_TOKEN!.trim()}`,
  "LinkedIn-Version": linkedinVersion(env),
  "X-Restli-Protocol-Version": "2.0.0",
});

interface LiComment {
  id?: string;
  commentUrn?: string;
  $URN?: string;
  actor?: string;
  message?: { text?: string };
  created?: { time?: number };
}

/** LinkedIn comment ids are saved as "postUrn|commentUrn", because a reply needs both. */
export function linkedinCommentId(postUrn: string, commentUrn: string): string {
  return `${postUrn}|${commentUrn}`;
}

async function readLinkedin(postUrn: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<RemoteComment[]> {
  const org = env.LINKEDIN_AUTHOR_URN!.trim();
  const r = await call("linkedin comments", deps, `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(postUrn)}/comments?count=${MAX}`, { method: "GET", headers: liHeaders(env) }, { idempotent: true });
  const els = (await json<{ elements?: LiComment[] }>(r)).elements ?? [];
  return els
    .filter((c) => c.message?.text && (c.commentUrn || c.$URN))
    .map((c) => ({
      id: linkedinCommentId(postUrn, (c.commentUrn || c.$URN)!),
      // Names need extra member permissions; the comment is shown with a generic author.
      author: c.actor?.startsWith("urn:li:organization:") ? "LinkedIn page" : "LinkedIn member",
      text: c.message!.text!,
      at: c.created?.time ? new Date(c.created.time).toISOString() : new Date().toISOString(),
      own: c.actor === org,
      answered: false,
    }));
}

async function replyLinkedin(id: string, message: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<string> {
  const [postUrn, commentUrn] = id.split("|");
  if (!postUrn || !commentUrn) throw new PublishError("This LinkedIn comment has no post id saved, so it can't be answered through the API.");
  const res = await call(
    "linkedin reply",
    deps,
    `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(commentUrn)}/comments`,
    { method: "POST", headers: { ...liHeaders(env), "Content-Type": "application/json" }, body: JSON.stringify({ actor: env.LINKEDIN_AUTHOR_URN!.trim(), object: postUrn, parentComment: commentUrn, message: { text: message } }) },
    { idempotent: false },
  );
  return res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id") || "";
}

/* ------------------------------------------------------------------ */
/* X                                                                   */
/* ------------------------------------------------------------------ */

const xKeys = (env: ConnectorEnv) => ({ consumerKey: env.X_API_KEY!.trim(), consumerSecret: env.X_API_SECRET!.trim(), token: env.X_ACCESS_TOKEN!.trim(), tokenSecret: env.X_ACCESS_TOKEN_SECRET!.trim() });

async function readX(postId: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<RemoteComment[]> {
  const keys = xKeys(env);
  const meUrl = "https://api.x.com/2/users/me";
  const me = (await json<{ data?: { id?: string } }>(await call("x me", deps, meUrl, () => ({ method: "GET", headers: { Authorization: oauth1Header("GET", meUrl, keys) } }), { idempotent: true }))).data?.id;
  const url = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(`conversation_id:${postId} -is:retweet`)}&max_results=${MAX}&tweet.fields=author_id,created_at,in_reply_to_user_id&expansions=author_id&user.fields=username`;
  const j = await json<{ data?: Array<{ id: string; text: string; author_id?: string; created_at?: string }>; includes?: { users?: Array<{ id: string; username: string }> } }>(
    await call("x replies", deps, url, () => ({ method: "GET", headers: { Authorization: oauth1Header("GET", url, keys) } }), { idempotent: true }),
  );
  const users = new Map((j.includes?.users ?? []).map((u) => [u.id, u.username]));
  return (j.data ?? []).map((t) => ({ id: t.id, author: `@${users.get(t.author_id ?? "") ?? "x user"}`, text: t.text, at: t.created_at ?? new Date().toISOString(), own: Boolean(me && t.author_id === me), answered: false }));
}

async function replyX(tweetId: string, message: string, env: ConnectorEnv, deps: ConnectorDeps): Promise<string> {
  const url = "https://api.x.com/2/tweets";
  const keys = xKeys(env);
  const r = await call("x reply", deps, url, () => ({ method: "POST", headers: { Authorization: oauth1Header("POST", url, keys), "Content-Type": "application/json" }, body: JSON.stringify({ text: message, reply: { in_reply_to_tweet_id: tweetId } }) }), { idempotent: false });
  return (await json<{ data?: { id?: string } }>(r)).data?.id ?? "";
}

/* ------------------------------------------------------------------ */

export const COMMENT_READERS: Record<Platform, (postId: string, env: ConnectorEnv, deps: ConnectorDeps) => Promise<RemoteComment[]>> = {
  instagram: readInstagram,
  facebook: readFacebook,
  youtube: readYoutube,
  linkedin: readLinkedin,
  x: readX,
};

export const REPLY_SENDERS: Record<Platform, (commentId: string, message: string, env: ConnectorEnv, deps: ConnectorDeps) => Promise<string>> = {
  instagram: replyInstagram,
  facebook: replyFacebook,
  youtube: replyYoutube,
  linkedin: replyLinkedin,
  x: replyX,
};

/** Platform length limits for replies. */
export const REPLY_MAX: Record<Platform, number> = { instagram: 2200, facebook: 8000, youtube: 10000, linkedin: 1250, x: 280 };
