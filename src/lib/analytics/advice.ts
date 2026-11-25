import type { ContentPiece, Platform, PostMetric } from "../schemas";
import { PLATFORMS } from "../schemas";

/**
 * Plain-language results and improvement advice.
 *
 * Every platform reports different numbers (plays vs views, reactions vs likes),
 * so they are mapped onto the same five: views, likes, comments, shares, saves.
 * Advice is derived from those numbers and always says which numbers it used.
 */

export interface Normalised {
  views: number | null;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  /** Share of the video watched on average, 0–1, when the platform reports it. */
  watch: number | null;
  /** People reached (unique accounts), when the platform reports it. */
  reach: number | null;
  /** Link clicks, when the platform reports them. */
  clicks: number | null;
}

const pick = (m: Record<string, number>, keys: string[]): number | undefined => keys.map((k) => m[k]).find((v) => v !== undefined);

export function normalise(m: Record<string, number>): Normalised {
  const duration = m.durationSec;
  const watch =
    m.avgPercentViewed !== undefined ? m.avgPercentViewed / 100
    : m.avgWatchTimeSec !== undefined && duration ? m.avgWatchTimeSec / duration
    : m.avgViewDurationSec !== undefined && duration ? m.avgViewDurationSec / duration
    : null;
  return {
    views: pick(m, ["views", "impressions", "reach"]) ?? null,
    likes: pick(m, ["likes", "reactions"]) ?? 0,
    comments: pick(m, ["comments", "replies"]) ?? 0,
    shares: pick(m, ["shares", "reposts"]) ?? 0,
    saves: pick(m, ["saves", "bookmarks"]) ?? 0,
    watch: watch === null ? null : Math.max(0, Math.min(1.5, watch)),
    reach: m.reach ?? null,
    clicks: pick(m, ["clicks", "linkClicks"]) ?? null,
  };
}

/** (likes + comments + shares + saves) ÷ views, or null without views. */
export function engagementRate(n: Normalised): number | null {
  return n.views ? (n.likes + n.comments + n.shares + n.saves) / n.views : null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export interface PlatformResult {
  platform: Platform;
  posts: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  engagement: number | null;
  watch: number | null;
  best: { metric: PostMetric; n: Normalised } | null;
  rows: Array<{ metric: PostMetric; n: Normalised; rate: number | null }>;
}

export function platformResults(metrics: PostMetric[]): PlatformResult[] {
  return PLATFORMS.map((platform) => {
    const rows = metrics
      .filter((m) => m.platform === platform)
      .map((metric) => {
        const n = normalise(metric.metrics);
        return { metric, n, rate: engagementRate(n) };
      })
      .sort((a, b) => b.metric.postedAt.localeCompare(a.metric.postedAt));
    const sum = (k: "likes" | "comments" | "shares" | "saves") => rows.reduce((s, r) => s + r.n[k], 0);
    const views = rows.reduce((s, r) => s + (r.n.views ?? 0), 0);
    const totalEng = sum("likes") + sum("comments") + sum("shares") + sum("saves");
    const watches = rows.map((r) => r.n.watch).filter((w): w is number => w !== null);
    const best = [...rows].sort((a, b) => (b.n.likes + b.n.comments * 2 + b.n.shares * 3) - (a.n.likes + a.n.comments * 2 + a.n.shares * 3) || (b.n.views ?? 0) - (a.n.views ?? 0))[0];
    return { platform, posts: rows.length, views, likes: sum("likes"), comments: sum("comments"), shares: sum("shares"), saves: sum("saves"), engagement: views ? totalEng / views : null, watch: median(watches), best: best ? { metric: best.metric, n: best.n } : null, rows };
  });
}

/* ------------------------------------------------------------------ */
/* Advice                                                              */
/* ------------------------------------------------------------------ */

export interface Tip {
  /** Higher shows first. */
  priority: number;
  icon: string;
  title: string;
  /** The numbers behind the tip. */
  why: string;
  how: string[];
  link?: { href: string; label: string };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const LABEL: Record<Platform, string> = { instagram: "Instagram", youtube: "YouTube", linkedin: "LinkedIn", facebook: "Facebook", x: "X" };

export interface AdviceInput {
  results: PlatformResult[];
  content: ContentPiece[];
  /** Earth Buddy video looks, with the file they were rendered to. */
  looks: Array<{ style: string; theme: string; file?: string }>;
  /** Platforms the app can read numbers from automatically. */
  autoRead: Platform[];
  /** Notes from the last sync, to spot missing permissions. */
  syncNotes: string[];
}

export function adviceFor(input: AdviceInput): Tip[] {
  const tips: Tip[] = [];
  const withData = input.results.filter((r) => r.posts > 0);
  const published = input.content.filter((c) => c.status === "published");

  // 1. Reach: are people seeing the posts at all?
  for (const r of withData) {
    const perPost = r.views / r.posts;
    if (perPost < 100) {
      const how = [
        "Share every new post's link in your team and customer WhatsApp groups within the first hour: early views tell the platform to show it to more people.",
        "Post at least 4 times a week, at the same times, so followers learn when to expect you.",
      ];
      if (r.platform === "facebook") how.unshift("Grow the Page's followers: posts are shown to followers first, so a small Page reaches few people. Use \"Invite friends\" on the Page and add the Page link to your WhatsApp status and email signature.", "Boost your best reel for ₹300–500 a day for 3 days, targeted to your city (ages 25–50).");
      if (r.platform === "youtube") how.unshift("Post 3 or more Shorts a week: YouTube tests new channels with small audiences first.", "Use searchable words in the title (\"recycle old AC\", \"e-waste Gurugram\").");
      if (r.platform === "instagram") how.unshift("Add trending audio in the Instagram app before posting (the app can't), and use 3–5 local hashtags (#Gurugram #DelhiNCR).", "Turn on \"Also share to Facebook\" and post a Story linking to every Reel.");
      tips.push({ priority: 90, icon: "📣", title: `Few people are seeing your ${LABEL[r.platform]} posts`, why: `${Math.round(perPost)} views per post on average (${r.posts} post${r.posts === 1 ? "" : "s"}).`, how });
    }
  }

  // 2. Watch time: do viewers stay?
  const videoRows = withData.flatMap((r) => r.rows).filter((x) => ["reel", "short", "story", "long-video"].includes(x.metric.format));
  const watches = videoRows.map((x) => x.n.watch).filter((w): w is number => w !== null);
  const mw = median(watches);
  if (mw !== null && mw < 0.5) {
    tips.push({
      priority: 85,
      icon: "⏱️",
      title: "Viewers leave your videos early",
      why: `On average people watch ${pct(mw)} of each video. Good Reels and Shorts keep 60%+.`,
      how: [
        "Put the payoff in the first 2 seconds: the number, the reward or the surprise, written on screen.",
        "Keep videos to 15–25 seconds with one idea each. The video maker now makes shorter videos automatically while watch time is low.",
        "Cut slow intros and logo openers; start with Earth Buddy already talking.",
      ],
    });
  } else if (mw !== null && mw >= 0.6) {
    tips.push({ priority: 40, icon: "🎯", title: "Your videos hold attention well", why: `People watch ${pct(mw)} of each video on average.`, how: ["You can try slightly longer videos (30–45 seconds) with one more point, or a part 2 for the best one."] });
  }
  if (!watches.length && videoRows.length) {
    const ytNote = input.syncNotes.find((n) => /YouTube Analytics API has not been used|youtubeanalytics/i.test(n));
    const ytApiOff = Boolean(ytNote);
    const ytLink = ytNote?.match(/https:\/\/console\.developers\.google\.com\S+?(?=\s|$)/)?.[0]?.replace(/[.,)]+$/, "");
    tips.push({
      priority: 70,
      icon: "📈",
      title: "Turn on watch-time tracking",
      why: "There are no watch-time numbers yet, so the app can't tell where viewers stop watching.",
      how: ytApiOff
        ? ["One-time setup: open the Google Cloud link, click Enable on \"YouTube Analytics API\", then tap Sync numbers now here."]
        : ["Watch time arrives a day or two after posting. Facebook and Instagram share it once a reel has views."],
      link: ytApiOff ? { href: ytLink ?? "https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com", label: "Enable YouTube Analytics API" } : undefined,
    });
  }

  // 3. Engagement: people watch but don't react.
  const viewed = withData.flatMap((r) => r.rows).filter((x) => (x.n.views ?? 0) >= 20);
  const rates = viewed.map((x) => x.rate).filter((x): x is number => x !== null);
  const mr = median(rates);
  if (mr !== null && mr < 0.04) {
    tips.push({
      priority: 80,
      icon: "💬",
      title: "People watch but don't like or comment",
      why: `${pct(mr)} of viewers react (likes, comments, shares). 4–6% is a healthy target for a growing account.`,
      how: [
        "End every video and caption with ONE easy question (\"AC, TV or fridge? 👇\"), not a list of asks.",
        "Pin the first comment yourself and reply to every comment within the first hour.",
        "Ask for a specific action: \"Send this to the friend whose storeroom is full\" works better than \"please share\".",
      ],
    });
  }
  const allViews = withData.reduce((s, r) => s + r.views, 0);
  const allComments = withData.reduce((s, r) => s + r.comments, 0);
  const allShares = withData.reduce((s, r) => s + r.shares, 0);
  if (allViews >= 20 && allComments === 0) tips.push({ priority: 75, icon: "🗨️", title: "No comments yet", why: `${allViews} views across platforms, 0 comments.`, how: ["Ask a question people can answer in one word or one emoji.", "Ask 3–4 team members to comment in their own words in the first hour and reply to each other: threads get shown to more people."] });
  if (allViews >= 50 && allShares === 0) tips.push({ priority: 60, icon: "🔁", title: "Nobody is sharing yet", why: `${allViews} views, 0 shares.`, how: ["Make posts people want to pass on: quick tips lists, surprising numbers, \"did you know\" facts.", "Say who to send it to: \"Tag the friend who never throws anything away\"."] });

  // 4. What's working: do more of the best post.
  const best = withData.map((r) => r.best).filter(Boolean).sort((a, b) => (b!.n.likes + b!.n.comments) - (a!.n.likes + a!.n.comments))[0];
  if (best && best.n.likes + best.n.comments > 0) {
    tips.push({ priority: 50, icon: "⭐", title: "Do more like your best post", why: `"${best.metric.hook || "Untitled"}" on ${LABEL[best.metric.platform]}: ${best.n.views ?? "?"} views, ${best.n.likes} likes, ${best.n.comments} comments.`, how: ["Make a follow-up on the same topic (part 2) within a week.", "Reuse its first line pattern in your next hooks."] });
  }

  // 5. Earth Buddy styles compared, once there are enough videos.
  const byFile = new Map(input.content.filter((c) => c.mediaUrls[0]).map((c) => [c.id, c.mediaUrls[0]!.replace(/\\/g, "/").toLowerCase()]));
  const styleScores = new Map<string, number[]>();
  for (const x of videoRows) {
    const file = x.metric.contentId ? byFile.get(x.metric.contentId) : undefined;
    const look = file && input.looks.find((l) => l.file && l.file.replace(/\\/g, "/").toLowerCase() === file);
    if (look && x.rate !== null) styleScores.set(look.style, [...(styleScores.get(look.style) ?? []), x.rate]);
  }
  const ranked = [...styleScores.entries()].filter(([, v]) => v.length >= 2).map(([s, v]) => [s, median(v)!] as const).sort((a, b) => b[1] - a[1]);
  if (ranked.length >= 2) tips.push({ priority: 55, icon: "🎬", title: `"${ranked[0]![0]}" Earth Buddy videos get the most reactions`, why: ranked.map(([s, v]) => `${s}: ${pct(v)}`).join(", "), how: ["Pick that style in the video maker more often, but keep mixing in others so the feed doesn't feel repetitive."] });

  // 6. Missing numbers: posts made by hand.
  const manual = published.filter((c) => !input.autoRead.includes(c.platform));
  if (manual.length) tips.push({ priority: 65, icon: "📝", title: `Add numbers for ${manual.length} post${manual.length === 1 ? "" : "s"} made by hand`, why: `${[...new Set(manual.map((c) => LABEL[c.platform]))].join(", ")} can't be read automatically yet.`, how: ["Open the post, scroll to \"Add this post's numbers\" and copy views, likes, comments and shares from the app (after about 3 days)."], link: { href: `/content/${manual[0]!.id}#numbers`, label: "Add numbers" } });

  if (!withData.length) tips.push({ priority: 100, icon: "⏳", title: "No results yet", why: "Numbers appear after posts go live (the app checks every 6 hours).", how: ["Publish a few posts, then come back in a day or two."] });
  return tips.sort((a, b) => b.priority - a.priority);
}

/** Video checklist that applies to every Earth Buddy video, whatever the numbers. */
export const VIDEO_CHECKLIST = [
  "First 2 seconds: big text with the benefit or number, and Earth Buddy already talking.",
  "15–30 seconds, one idea. Long lists belong in a carousel.",
  "Words on screen the whole time: most people watch without sound.",
  "End with one question people can answer in a word or an emoji.",
  "A different look each time (the video maker rotates styles, colours and music).",
  "Hinglish versions for Delhi NCR audiences; English for LinkedIn.",
];

/**
 * How the video maker should adjust from results: while viewers leave early,
 * cover fewer points so videos are shorter.
 */
export function videoTuning(metrics: PostMetric[]): { maxPoints: number; reason: string } {
  const w = median(metrics.filter((m) => ["reel", "short", "story"].includes(m.format)).map((m) => normalise(m.metrics).watch).filter((x): x is number => x !== null));
  if (w === null) return { maxPoints: 4, reason: "" };
  if (w < 0.4) return { maxPoints: 2, reason: `Shorter video: viewers watch ${pct(w)} on average.` };
  if (w < 0.6) return { maxPoints: 3, reason: `Slightly shorter video: viewers watch ${pct(w)} on average.` };
  return { maxPoints: 4, reason: "" };
}
