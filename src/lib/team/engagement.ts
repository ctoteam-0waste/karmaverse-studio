import type { ContentPiece, Database, Platform } from "../schemas";

/**
 * Team engagement: which team members commented on which published posts
 * (from the comments the Community Manager collects), plus what they did in the
 * app (approvals and other workflow steps recorded in each post's history).
 *
 * Platforms don't say who liked, shared or watched a post, so comments are the
 * only per-person engagement we can see.
 */

export interface TeamMember {
  name: string;
  handles: string[];
}

export interface MemberComment {
  platform: Platform;
  text: string;
  at: string;
  contentId: string | null;
}

export interface MemberStats {
  name: string;
  handles: string[];
  comments: MemberComment[];
  /** Facebook reactions (likes, loves…) matched to this member by display name. */
  likes: number;
  shares: number;
  reposts: number;
  /** Published posts this member commented on, liked, shared or reposted. */
  postsEngaged: number;
  /** Share of the listed recent posts this member commented on (0..1). */
  coverage: number;
  /** Workflow steps in the app (approve, schedule, edit...). */
  appActions: number;
  approvals: number;
  lastActive: string | null;
}

export interface PostRow {
  id: string;
  platform: Platform;
  title: string;
  publishedAt: string;
  url: string | null;
  /** member name -> number of comments on this post */
  byMember: Record<string, number>;
  /** members who liked (Facebook reactions, or logged by the member) */
  likedBy: string[];
  sharedBy: string[];
  repostedBy: string[];
  /** comments from people outside the team */
  others: number;
  /** Latest platform totals from the Metrics Agent (null when not synced yet). */
  totals: { views: number | null; likes: number | null; comments: number | null };
}

export interface TeamEngagement {
  members: MemberStats[];
  posts: PostRow[];
  /** Comments whose author matched no one, most frequent first (helps find missing handles). */
  unmatchedAuthors: Array<{ author: string; count: number }>;
}

/** "@Anikait.Bansal " -> "anikait.bansal"; display names keep their spaces. */
export function normHandle(s: string): string {
  return s.trim().replace(/^@+/, "").toLowerCase();
}

/** Parses a free-text handle list: commas, spaces or new lines between handles; display names in quotes keep spaces. */
export function parseHandles(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\n,]+/)) {
    const t = part.trim();
    if (!t) continue;
    if (/\s/.test(t) && !t.startsWith("@")) out.push(t); // a display name like "Akash Kumar" (Facebook)
    else out.push(...t.split(/\s+/).filter(Boolean));
  }
  return [...new Set(out)];
}

function memberFor(author: string, members: TeamMember[]): TeamMember | undefined {
  const a = normHandle(author);
  if (!a) return undefined;
  return members.find((m) => m.handles.some((h) => normHandle(h) === a));
}

/** Does a history actor ("Ayushi Singh", "Ayushi", "ceo@... (in chat)") belong to this member? */
function actorIsMember(by: string, m: TeamMember): boolean {
  const first = m.name.trim().toLowerCase().split(/\s+/)[0];
  if (!first) return false;
  const actor = by.trim().toLowerCase();
  return actor === m.name.trim().toLowerCase() || actor.split(/\s+/)[0] === first;
}

function title(p: ContentPiece): string {
  return (p.hook || p.topic).replace(/\s+/g, " ").trim();
}

function publishedAt(p: ContentPiece): string {
  const h = [...p.history].reverse().find((x) => x.to === "published");
  return h?.at ?? p.updatedAt;
}

export function teamEngagement(db: Database, brandId: string, opts: { days?: number; now?: Date } = {}): TeamEngagement {
  const members = db.settings.teamMembers;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 30) * 86_400_000).toISOString();

  const unmatchedReactors = new Map<string, number>();
  const published = db.content
    .filter((p) => p.brandId === brandId && p.status === "published" && !p.isSample)
    .map((p) => ({ p, at: publishedAt(p) }))
    .filter((x) => x.at >= since)
    .sort((a, b) => b.at.localeCompare(a.at));

  // Latest metrics snapshot per post.
  const latest = new Map<string, Record<string, number>>();
  for (const m of [...db.metrics].filter((x) => x.contentId && !x.isSample).sort((a, b) => (a.syncedAt ?? "").localeCompare(b.syncedAt ?? ""))) {
    latest.set(m.contentId!, m.metrics as Record<string, number>);
  }
  const totalsFor = (id: string): PostRow["totals"] => {
    const m = latest.get(id);
    if (!m) return { views: null, likes: null, comments: null };
    const n = (v: unknown) => (typeof v === "number" ? v : null);
    return { views: n(m.views) ?? n(m.reach), likes: n(m.likes) ?? n(m.reactions), comments: n(m.comments) };
  };

  const rows = new Map<string, PostRow>(
    published.map(({ p, at }) => [p.id, { id: p.id, platform: p.platform, title: title(p), publishedAt: at, url: p.publishedUrl, byMember: {}, likedBy: [], sharedBy: [], repostedBy: [], others: 0, totals: totalsFor(p.id) }]),
  );

  const stats = new Map<string, MemberStats>(
    members.map((m) => [m.name, { name: m.name, handles: m.handles, comments: [], likes: 0, shares: 0, reposts: 0, postsEngaged: 0, coverage: 0, appActions: 0, approvals: 0, lastActive: null }]),
  );

  for (const { p } of published) {
    for (const r of p.reactors ?? []) {
      const m = memberFor(r.name, members);
      if (!m) {
        unmatchedReactors.set(r.name, (unmatchedReactors.get(r.name) ?? 0) + 1);
        continue;
      }
      const row = rows.get(p.id)!;
      if (row.likedBy.includes(m.name)) continue;
      row.likedBy.push(m.name);
      stats.get(m.name)!.likes++;
    }
  }
  // Likes, shares and reposts the team logged themselves on the Team page.
  for (const { p } of published) {
    const row = rows.get(p.id)!;
    for (const a of p.teamActions ?? []) {
      const s = stats.get(a.name);
      if (!s) continue;
      const list = a.kind === "like" ? row.likedBy : a.kind === "share" ? row.sharedBy : row.repostedBy;
      if (list.includes(a.name)) continue;
      list.push(a.name);
      if (a.kind === "like") s.likes++;
      else if (a.kind === "share") s.shares++;
      else s.reposts++;
      if (!s.lastActive || a.at > s.lastActive) s.lastActive = a.at;
    }
  }
  const unmatched = new Map<string, number>();
  const bump = (s: MemberStats, at: string) => {
    if (!s.lastActive || at > s.lastActive) s.lastActive = at;
  };

  for (const c of db.inbox) {
    if (c.brandId !== brandId || c.isSample) continue;
    const m = memberFor(c.author, members);
    const row = c.contentId ? rows.get(c.contentId) : undefined;
    if (!m) {
      if (row) row.others++;
      if (c.receivedAt >= since) unmatched.set(c.author, (unmatched.get(c.author) ?? 0) + 1);
      continue;
    }
    const s = stats.get(m.name)!;
    s.comments.push({ platform: c.platform, text: c.text, at: c.receivedAt, contentId: c.contentId });
    bump(s, c.receivedAt);
    if (row) row.byMember[m.name] = (row.byMember[m.name] ?? 0) + 1;
  }

  for (const p of db.content) {
    if (p.brandId !== brandId) continue;
    for (const h of p.history) {
      if (h.at < since) continue;
      const m = members.find((x) => actorIsMember(h.by, x));
      if (!m) continue;
      const s = stats.get(m.name)!;
      s.appActions++;
      if (h.to === "approved") s.approvals++;
      bump(s, h.at);
    }
  }

  const posts = [...rows.values()];
  for (const s of stats.values()) {
    s.comments.sort((a, b) => b.at.localeCompare(a.at));
    s.postsEngaged = posts.filter((r) => (r.byMember[s.name] ?? 0) > 0 || [r.likedBy, r.sharedBy, r.repostedBy].some((l) => l.includes(s.name))).length;
    s.coverage = posts.length ? s.postsEngaged / posts.length : 0;
  }

  return {
    members: [...stats.values()],
    posts,
    unmatchedAuthors: [...unmatched.entries(), ...[...unmatchedReactors.entries()].map(([n, c]) => [`${n} (Facebook like)`, c] as [string, number])]
      .map(([author, count]) => ({ author, count }))
      .sort((a, b) => b.count - a.count),
  };
}
