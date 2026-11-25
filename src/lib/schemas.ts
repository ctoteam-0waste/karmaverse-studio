import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Platforms, formats and statuses                                     */
/* ------------------------------------------------------------------ */

export const PLATFORMS = ["instagram", "youtube", "linkedin", "facebook", "x"] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof PlatformSchema>;

export const FORMATS = [
  "reel",
  "carousel",
  "story",
  "short",
  "long-video",
  "text-post",
  "document-carousel",
  "image-post",
] as const;
export const FormatSchema = z.enum(FORMATS);
export type Format = z.infer<typeof FormatSchema>;

/** Which formats each platform supports in this app. */
export const PLATFORM_FORMATS: Record<Platform, Format[]> = {
  instagram: ["reel", "carousel", "story", "image-post"],
  youtube: ["short", "long-video"],
  linkedin: ["text-post", "document-carousel", "image-post"],
  facebook: ["reel", "image-post", "text-post"],
  x: ["text-post", "image-post"],
};

export const CONTENT_STATUSES = [
  "draft",
  "needs-review",
  "approved",
  "scheduled",
  "published",
  "failed",
] as const;
export const ContentStatusSchema = z.enum(CONTENT_STATUSES);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

export const GENERATION_MODES = ["template", "manual", "anthropic"] as const;
export const GenerationModeSchema = z.enum(GENERATION_MODES);
export type GenerationMode = z.infer<typeof GenerationModeSchema>;

/* ------------------------------------------------------------------ */
/* Brand                                                               */
/* ------------------------------------------------------------------ */

export const PillarSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
});
export type Pillar = z.infer<typeof PillarSchema>;

export const BrandFactSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  source: z.string().default(""),
  /** Only verified facts may be stated as fact in generated content. */
  verified: z.boolean().default(false),
});
export type BrandFact = z.infer<typeof BrandFactSchema>;

export const ApprovalPolicySchema = z.object({
  /** Content must pass through "needs-review" before it can be approved. */
  requireReview: z.boolean().default(true),
  /** If non-empty, only these names may approve content. */
  approvers: z.array(z.string()).default([]),
  /** Community replies always need a human; this only controls who may approve them. */
  replyApprovers: z.array(z.string()).default([]),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const BrandSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  organisation: z.string().default(""),
  category: z.string().default(""),
  website: z.string().default(""),
  audience: z.array(z.string()).default([]),
  voice: z.array(z.string()).default([]),
  languages: z.array(z.string()).default(["English"]),
  pillars: z.array(PillarSchema).default([]),
  facts: z.array(BrandFactSchema).default([]),
  hashtags: z.array(z.string()).default([]),
  defaultCtas: z.array(z.string()).default([]),
  /** Words or claims the brand must never use. */
  avoid: z.array(z.string()).default([]),
  platforms: z.array(PlatformSchema).default([...PLATFORMS]),
  /** Prefix for this brand's platform tokens in .env.local (e.g. KARMAVERSE → KARMAVERSE_META_PAGE_ID). Empty = derived from the name. */
  accountKey: z.string().default(""),
  /** Logo image file on this computer (PNG with transparency works best). Used by the Video Maker. */
  logoFile: z.string().default(""),
  /** Short brand line shown in video end cards, e.g. "Earn • Impact • Elevate". */
  tagline: z.string().default(""),
  approvalPolicy: ApprovalPolicySchema.default({ requireReview: true, approvers: [], replyApprovers: [] }),
  /** Free-text notes from the team about trends they have seen (manual trend input). */
  trendNotes: z.array(z.object({ id: z.string(), text: z.string(), addedAt: z.string() })).default([]),
  /** Standing instructions from the team ("Tell the team" box); every writer follows the active ones. */
  instructions: z.array(z.object({ id: z.string(), text: z.string(), by: z.string().default(""), addedAt: z.string(), active: z.boolean().default(true) })).default([]),
  /** Outcomes the team wants (e.g. "500 Instagram followers by 31 Dec"); writers and the planner aim for them. */
  goals: z.array(z.object({ id: z.string(), text: z.string(), by: z.string().default(""), addedAt: z.string(), active: z.boolean().default(true) })).default([]),
});
export type Brand = z.infer<typeof BrandSchema>;

/* ------------------------------------------------------------------ */
/* Ideas (strategy backlog)                                            */
/* ------------------------------------------------------------------ */

export const IDEA_STATUSES = ["backlog", "approved", "rejected", "used"] as const;
export const IdeaSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  title: z.string().min(1),
  pillarId: z.string(),
  angle: z.string().default(""),
  audienceQuestion: z.string().default(""),
  source: z.enum(["strategy-agent", "manual", "inbox", "trend-note", "trend-watcher", "competitor-watch"]).default("manual"),
  /** 1–5: how relevant to the brand's audience. */
  relevance: z.number().int().min(1).max(5),
  /** 1–5: expected effect on meaningful engagement. */
  impact: z.number().int().min(1).max(5),
  /** 1–5: production effort (5 = hardest). */
  effort: z.number().int().min(1).max(5),
  priority: z.number().min(0).max(100),
  status: z.enum(IDEA_STATUSES).default("backlog"),
  createdAt: z.string(),
  isSample: z.boolean().default(false),
});
export type Idea = z.infer<typeof IdeaSchema>;

/* ------------------------------------------------------------------ */
/* Content pieces (also the calendar entries)                          */
/* ------------------------------------------------------------------ */

export const StatusChangeSchema = z.object({
  at: z.string(),
  from: ContentStatusSchema.nullable(),
  to: ContentStatusSchema,
  by: z.string().default("system"),
  note: z.string().default(""),
});
export type StatusChange = z.infer<typeof StatusChangeSchema>;

export const TargetMetricSchema = z.object({
  metric: z.string(),
  target: z.string(),
});

export const VIDEO_SERIES = ["news", "quiz", "myth", "hack", "cartoon"] as const;
export const VideoSeriesSchema = z.enum(VIDEO_SERIES);
export type VideoSeries = z.infer<typeof VideoSeriesSchema>;

export const ContentPieceSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  ideaId: z.string().nullable().default(null),
  platform: PlatformSchema,
  format: FormatSchema,
  pillarId: z.string(),
  topic: z.string(),
  hook: z.string(),
  caption: z.string().default(""),
  /** YouTube description or LinkedIn long body. */
  description: z.string().default(""),
  keywords: z.array(z.string()).default([]),
  hashtags: z.array(z.string()).default([]),
  cta: z.string().default(""),
  thumbnailConcept: z.string().default(""),
  /** Public URLs of the image(s) or video to publish. Instagram and YouTube need at least one. */
  mediaUrls: z.array(z.string()).default([]),
  /** Other versions made by the Video Maker (other sizes, cover images). Not published automatically. */
  extraMedia: z.array(z.object({ label: z.string(), file: z.string() })).default([]),
  /** Checked script of what the video's clip says, used for subtitles. */
  subtitles: z.string().default(""),
  /** Carousel slide text, one slide per line: "Title | text". */
  slides: z.string().default(""),
  plannedDate: z.string().nullable().default(null),
  plannedTime: z.string().nullable().default(null),
  targetMetric: TargetMetricSchema.nullable().default(null),
  status: ContentStatusSchema.default("draft"),
  approvedBy: z.string().nullable().default(null),
  approvedAt: z.string().nullable().default(null),
  publishedUrl: z.string().nullable().default(null),
  failureReason: z.string().nullable().default(null),
  /** Set by the Publishing Agent while a platform call is in flight, so a post is never sent twice. */
  publishingStartedAt: z.string().nullable().default(null),
  /** Platform's id for the published post (from the API). */
  externalId: z.string().nullable().default(null),
  /**
   * Queued on the platform ahead of time (Facebook/YouTube native scheduling), so it goes out
   * even when this computer is off. at = the publish time the platform has; sig = what was sent,
   * so an edit or a new time here cancels and re-queues it.
   */
  platformQueue: z
    .object({ at: z.string(), externalId: z.string().default(""), url: z.string().default(""), sig: z.string().default(""), queuedAt: z.string(), error: z.string().optional() })
    .nullable()
    .optional(),
  /** Public links the Media Host made for this post's local files: local path -> https URL. */
  hostedMedia: z.record(z.string(), z.string()).default({}),
  /** People who reacted to the published post, where the platform says (Facebook only), refreshed by the Community Manager. */
  reactors: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  /** Likes, shares and reposts team members logged themselves (platforms don't say who liked or shared on Instagram, YouTube or LinkedIn). */
  teamActions: z.array(z.object({ name: z.string(), kind: z.enum(["like", "share", "repost"]), at: z.string() })).optional(),
  generatedBy: GenerationModeSchema.default("template"),
  /** Video series this reel/short belongs to (news, quiz, myth vs fact, eco hack, cartoon story); null = classic explainer. */
  series: VideoSeriesSchema.nullable().optional(),
  /** The series script Claude wrote for the video (JSON), rendered by the Media Maker. */
  videoScript: z.string().optional(),
  /** News story the post is about (news series), credited in the caption. */
  sourceUrl: z.string().optional(),
  /** Who leads the video (see src/lib/video/characters.ts); empty = picked automatically for variety. */
  character: z.string().optional(),
  history: z.array(StatusChangeSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  isSample: z.boolean().default(false),
});
export type ContentPiece = z.infer<typeof ContentPieceSchema>;

/** Shape an LLM (or a pasted manual result) must return for one platform version. */
export const GeneratedPlatformContentSchema = z.object({
  platform: PlatformSchema,
  format: FormatSchema,
  hook: z.string().min(1),
  caption: z.string().default(""),
  description: z.string().default(""),
  keywords: z.array(z.string()).default([]),
  hashtags: z.array(z.string()).default([]),
  cta: z.string().default(""),
  thumbnailConcept: z.string().default(""),
});
export type GeneratedPlatformContent = z.infer<typeof GeneratedPlatformContentSchema>;

/* ------------------------------------------------------------------ */
/* Video production briefs                                             */
/* ------------------------------------------------------------------ */

export const ScriptLineSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  voiceover: z.string(),
  onScreenText: z.string().default(""),
});

export const SceneSchema = z.object({
  scene: z.number().int().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  visual: z.string(),
  camera: z.string(),
  framing: z.string(),
  transition: z.string(),
  bRoll: z.string().default(""),
});

export const VideoBriefSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  ideaId: z.string().nullable().default(null),
  contentId: z.string().nullable().default(null),
  platform: PlatformSchema,
  format: FormatSchema,
  title: z.string(),
  objective: z.string(),
  audience: z.string(),
  hooks: z.array(z.string()).length(3),
  durationSec: z.number().int().min(5).max(1800),
  script: z.array(ScriptLineSchema).min(1),
  storyboard: z.array(SceneSchema).min(1),
  subtitleNotes: z.string(),
  voiceover: z.string(),
  musicMood: z.string(),
  editingInstructions: z.array(z.string()),
  thumbnailConcept: z.string(),
  titleOptions: z.array(z.string()).min(1),
  cta: z.string(),
  effort: z.object({ level: z.enum(["low", "medium", "high"]), hours: z.number().min(0) }),
  freeTools: z.array(z.string()),
  /** Last MP4 made from this brief by the Video Maker (absolute path). */
  videoFile: z.string().nullable().default(null),
  generatedBy: GenerationModeSchema.default("template"),
  createdAt: z.string(),
  isSample: z.boolean().default(false),
});
export type VideoBrief = z.infer<typeof VideoBriefSchema>;

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

export const PostMetricSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  contentId: z.string().nullable().default(null),
  platform: PlatformSchema,
  format: FormatSchema,
  postedAt: z.string(),
  hook: z.string().default(""),
  pillarId: z.string().default(""),
  cta: z.string().default(""),
  url: z.string().default(""),
  /** Raw platform metrics. Keys depend on platform + format (see analytics/metrics.ts). */
  metrics: z.record(z.string(), z.number().min(0)),
  source: z.enum(["manual", "csv-import", "api"]).default("manual"),
  isSample: z.boolean().default(false),
  /** When the Metrics Agent last refreshed this row from the platform. */
  syncedAt: z.string().nullable().default(null),
});
export type PostMetric = z.infer<typeof PostMetricSchema>;

/* ------------------------------------------------------------------ */
/* Experiments and learning log                                        */
/* ------------------------------------------------------------------ */

export const EXPERIMENT_VARIABLES = ["hook", "posting-time", "format", "cta", "length", "thumbnail", "topic"] as const;
export const ExperimentSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  hypothesis: z.string().min(1),
  platform: PlatformSchema,
  format: FormatSchema,
  variable: z.enum(EXPERIMENT_VARIABLES),
  change: z.string(),
  primaryMetric: z.string(),
  baseline: z.string().default(""),
  impact: z.number().int().min(1).max(5),
  effort: z.number().int().min(1).max(5),
  status: z.enum(["proposed", "running", "concluded", "abandoned"]).default("proposed"),
  startDate: z.string().nullable().default(null),
  endDate: z.string().nullable().default(null),
  result: z.string().default(""),
  learning: z.string().default(""),
  createdAt: z.string(),
  isSample: z.boolean().default(false),
});
export type Experiment = z.infer<typeof ExperimentSchema>;

export const LearningEntrySchema = z.object({
  id: z.string(),
  brandId: z.string(),
  at: z.string(),
  kind: z.enum(["hypothesis", "result", "observation"]),
  text: z.string(),
  experimentId: z.string().nullable().default(null),
});
export type LearningEntry = z.infer<typeof LearningEntrySchema>;

/* ------------------------------------------------------------------ */
/* Community inbox                                                     */
/* ------------------------------------------------------------------ */

export const INTENTS = ["question", "feedback", "praise", "complaint", "support", "spam", "escalation", "other"] as const;
export const ClassificationSchema = z.object({
  intent: z.enum(INTENTS),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  flags: z.array(z.enum(["legal", "customer-support", "harmful", "privacy", "abusive", "spam-link", "sensitive"])),
  needsHuman: z.boolean(),
  reason: z.string(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const InboxItemSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  platform: PlatformSchema,
  author: z.string(),
  text: z.string().min(1),
  postRef: z.string().default(""),
  receivedAt: z.string(),
  classification: ClassificationSchema,
  suggestedReply: z.string().default(""),
  replyStatus: z.enum(["drafted", "approved", "posted", "posted-manually", "ignored"]).default("drafted"),
  approvedBy: z.string().nullable().default(null),
  /** Platform's id for the comment (set when the Community Manager read it from the API). */
  externalId: z.string().nullable().default(null),
  /** The published post this comment is on. */
  contentId: z.string().nullable().default(null),
  /** Platform's id for the reply the Community Manager sent. */
  replyExternalId: z.string().nullable().default(null),
  /** Why sending the reply failed, if it did. */
  replyError: z.string().nullable().default(null),
  /** Set while a reply is being sent, so it is never sent twice. */
  replySendingAt: z.string().nullable().default(null),
  isSample: z.boolean().default(false),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

/* ------------------------------------------------------------------ */
/* Trend Watcher                                                       */
/* ------------------------------------------------------------------ */

export const TrendSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  /** Where it came from: a climate day, Google Trends, news, YouTube, or a search opportunity (Growth agent). */
  source: z.enum(["climate-day", "google-trends", "news", "youtube", "search"]),
  title: z.string(),
  url: z.string().default(""),
  /** Climate day date (YYYY-MM-DD) or when the item was published. */
  date: z.string().default(""),
  /** Short context: traffic, channel, views, or why the day matters. */
  detail: z.string().default(""),
  /** 0-100: how well it fits the brand (keywords, timing). */
  score: z.number().min(0).max(100),
  /** Suggested angle for a post; the team checks facts before using it. */
  angle: z.string().default(""),
  status: z.enum(["new", "used", "dismissed"]).default("new"),
  foundAt: z.string(),
});
export type Trend = z.infer<typeof TrendSchema>;

/* ------------------------------------------------------------------ */
/* Competitor Watch                                                    */
/* ------------------------------------------------------------------ */

export const CompetitorSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  name: z.string().min(1),
  /** Instagram username (business or creator account), without @. */
  instagram: z.string().default(""),
  /** YouTube handle (@name) or channel id (UC...). */
  youtube: z.string().default(""),
  website: z.string().default(""),
  notes: z.string().default(""),
  /** Latest public numbers per platform. */
  profiles: z
    .array(z.object({ platform: PlatformSchema, followers: z.number().min(0).nullable(), posts: z.number().min(0).nullable(), at: z.string() }))
    .default([]),
  lastSyncAt: z.string().nullable().default(null),
  lastSyncNotes: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Competitor = z.infer<typeof CompetitorSchema>;

export const CompetitorPostSchema = z.object({
  id: z.string(),
  competitorId: z.string(),
  platform: PlatformSchema,
  format: FormatSchema,
  postedAt: z.string(),
  /** First line of the caption or the video title. */
  hook: z.string().default(""),
  url: z.string().default(""),
  /** Platform's id, so a re-sync updates the row instead of adding a copy. */
  externalId: z.string().nullable().default(null),
  likes: z.number().min(0).default(0),
  comments: z.number().min(0).default(0),
  views: z.number().min(0).nullable().default(null),
  source: z.enum(["api", "manual"]).default("manual"),
  syncedAt: z.string(),
});
export type CompetitorPost = z.infer<typeof CompetitorPostSchema>;

/* ------------------------------------------------------------------ */
/* Database root                                                       */
/* ------------------------------------------------------------------ */

export const SettingsSchema = z.object({
  activeBrandId: z.string(),
  generationMode: GenerationModeSchema.default("template"),
  /** When on, the Publishing Agent posts scheduled (approved) content at its planned time. */
  autoPublish: z.boolean().default(false),
  /** Names people signed in with, offered as one-tap choices on the sign-in page. */
  team: z.array(z.string()).default([]),
  /** Team members and their social handles, for the Team engagement page. */
  teamMembers: z
    .array(z.object({ name: z.string(), handles: z.array(z.string()).default([]) }))
    .default([
      { name: "Akash", handles: ["@akashhh._pvt"] },
      { name: "Shashi", handles: ["@itz_cincinnati"] },
      { name: "Anikait", handles: ["@anikaitbansal"] },
      { name: "Ayushi", handles: ["@ayushiiishhh"] },
      { name: "Prerna", handles: ["@prerana__rout"] },
      { name: "Shahwaj", handles: ["@sahnwajj.khan"] },
      { name: "Gourav Pati", handles: [] },
    ]),
  /** Looks of recent Earth Buddy videos, so the next one can look different. */
  videoLooks: z.array(z.object({ style: z.string(), theme: z.string(), layout: z.string(), music: z.string(), at: z.string(), file: z.string().optional(), character: z.string().optional() })).default([]),
  /** Last Publishing Agent run, shown on the Publishing page. */
  lastPublishRun: z
    .object({ at: z.string(), published: z.number(), failed: z.number(), skipped: z.number(), notes: z.array(z.string()) })
    .nullable()
    .default(null),
  /** Community Manager: "safe" sends replies to praise and quiz answers automatically; everything else waits for approval. */
  autoReply: z.enum(["off", "safe"]).default("off"),
  /** Last Community Manager run. */
  lastCommunitySync: z
    .object({ at: z.string(), added: z.number(), sent: z.number(), failed: z.number(), notes: z.array(z.string()) })
    .nullable()
    .default(null),
  /** Last Trend Watcher scan. */
  lastTrendScan: z.object({ at: z.string(), added: z.number(), notes: z.array(z.string()) }).nullable().default(null),
  /** Last Competitor Watch sync. */
  lastCompetitorSync: z.object({ at: z.string(), updated: z.number(), notes: z.array(z.string()) }).nullable().default(null),
  /** Whether Claude (the writer) answered last time; shown as a warning when it stops working. */
  writerHealth: z.object({ ok: z.boolean(), at: z.string(), message: z.string().default("") }).nullable().optional(),
  /** Last Blog Writer run (trend -> draft article on the 3R website). */
  lastBlogRun: z.object({ at: z.string(), notes: z.array(z.string()) }).nullable().optional(),
  /** Last Growth agent run (SEO / LLMO / ASO fixes prepared for review). */
  lastGrowthRun: z.object({ at: z.string(), notes: z.array(z.string()) }).nullable().optional(),
  /** Last SEO / LLMO / ASO tracking run. */
  lastTrackingRun: z.object({ at: z.string(), notes: z.array(z.string()) }).nullable().optional(),
  /** Last Metrics Agent run. */
  lastMetricsSync: z
    .object({ at: z.string(), updated: z.number(), failed: z.number(), skipped: z.number(), notes: z.array(z.string()) })
    .nullable()
    .default(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

/* ------------------------------------------------------------------ */
/* Blog Writer, SEO / LLMO / ASO tracking                              */
/* ------------------------------------------------------------------ */

/** A blog article the Blog Writer drafted on the 3R ZeroWaste website. */
export const BlogPostSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  focusKeyword: z.string().default(""),
  category: z.string().default(""),
  /** The trend it was written from. */
  trendId: z.string().nullable().default(null),
  trendTitle: z.string().default(""),
  words: z.number().default(0),
  /** Where it was saved: the website repo file, and whether it was pushed to GitHub. */
  file: z.string().default(""),
  pushed: z.boolean().default(false),
  status: z.enum(["draft", "failed"]).default("draft"),
  error: z.string().default(""),
  createdAt: z.string(),
});
export type BlogPost = z.infer<typeof BlogPostSchema>;

/** One day's tracking numbers (from the SEO / ASO / brand checks). */
export const TrackingSnapshotSchema = z.object({
  date: z.string(),
  at: z.string(),
  seo: z.object({ critical: z.number(), high: z.number(), medium: z.number(), low: z.number(), resolved: z.number(), pages: z.number() }).nullable().default(null),
  aso: z.object({ available: z.boolean(), rating: z.number().nullable(), installs: z.string().default(""), reviews: z.number().nullable(), findings: z.number() }).nullable().default(null),
  brand: z.object({ conflicts: z.number(), findings: z.number() }).nullable().default(null),
  blog: z.object({ posts: z.number(), drafts: z.number() }).nullable().default(null),
  llmo: z.object({ tested: z.number(), mentioned: z.number(), accurate: z.number() }).nullable().default(null),
  /** The same questions answered with web search (closer to ChatGPT / Perplexity search answers). */
  llmoWeb: z.object({ tested: z.number(), mentioned: z.number(), accurate: z.number(), cited: z.number() }).nullable().optional(),
  /** Top things to fix, in order. */
  fixes: z.array(z.object({ area: z.string(), severity: z.string(), title: z.string(), action: z.string(), url: z.string().default("") })).default([]),
});
export type TrackingSnapshot = z.infer<typeof TrackingSnapshotSchema>;

/** One AI-answer test: did the assistant mention the brand, and correctly? */
export const LlmoResultSchema = z.object({
  date: z.string(),
  platform: z.string(),
  promptId: z.string(),
  prompt: z.string(),
  mentioned: z.boolean(),
  accurate: z.boolean().nullable().default(null),
  excerpt: z.string().default(""),
  competitors: z.array(z.string()).default([]),
  notes: z.string().default(""),
  /** The answer linked to karmaverse.earth or 0waste.co.in (web-search answers). */
  cited: z.boolean().optional(),
});
export type LlmoResult = z.infer<typeof LlmoResultSchema>;

/** Account-level reach and clicks for the last 28 days, one row per brand, platform and day. */
export const AccountStatSchema = z.object({
  brandId: z.string(),
  platform: PlatformSchema,
  date: z.string(),
  at: z.string(),
  days: z.number().default(28),
  reach: z.number().optional(),
  views: z.number().optional(),
  profileViews: z.number().optional(),
  linkClicks: z.number().optional(),
  engaged: z.number().optional(),
  followers: z.number().optional(),
});
export type AccountStat = z.infer<typeof AccountStatSchema>;

/** Website tracking (Google Analytics 4 + Search Console), last 28 days, one row per day. */
export const WebsiteStatSchema = z.object({
  date: z.string(),
  at: z.string(),
  visitors: z.number().optional(),
  newVisitors: z.number().optional(),
  sessions: z.number().optional(),
  pageViews: z.number().optional(),
  engagementRate: z.number().optional(),
  /** Sessions from social platforms (tagged links or social referrers). */
  fromSocial: z.number().optional(),
  sources: z.array(z.object({ source: z.string(), medium: z.string(), sessions: z.number(), visitors: z.number() })).default([]),
  pages: z.array(z.object({ page: z.string(), sessions: z.number() })).default([]),
  /** Sessions per post, from utm_content on tagged links. */
  posts: z.array(z.object({ contentId: z.string(), source: z.string(), sessions: z.number() })).default([]),
  /** Visits per channel (Organic Search, Direct, Organic Social, AI Assistant, Referral…). */
  channels: z.array(z.object({ channel: z.string(), sessions: z.number(), engaged: z.number(), users: z.number() })).optional(),
  /** Visits per day and channel (YYYY-MM-DD). */
  daily: z.array(z.object({ date: z.string(), channel: z.string(), sessions: z.number(), engaged: z.number() })).optional(),
  /** Every Google Analytics event (page_view, sign_up, schedule_pickup…) with how many people did it. */
  events: z.array(z.object({ name: z.string(), count: z.number(), users: z.number() })).optional(),
  /** Key actions per channel, to see which channel brings sign-ups and pickups. */
  eventsByChannel: z.array(z.object({ name: z.string(), channel: z.string(), count: z.number() })).optional(),
  /** Visits from AI assistants (chatgpt.com, perplexity.ai, gemini…). */
  aiSources: z.array(z.object({ source: z.string(), sessions: z.number(), engaged: z.number() })).optional(),
  /** Clicks on links that leave the site (Play Store, maps, social). */
  outbound: z.array(z.object({ url: z.string(), count: z.number() })).optional(),
  search: z
    .object({
      clicks: z.number(),
      impressions: z.number(),
      ctr: z.number(),
      position: z.number().nullable(),
      queries: z.array(z.object({ query: z.string(), clicks: z.number(), impressions: z.number(), position: z.number() })),
      daily: z.array(z.object({ date: z.string(), clicks: z.number(), impressions: z.number() })).optional(),
      pages: z.array(z.object({ page: z.string(), clicks: z.number(), impressions: z.number(), position: z.number() })).optional(),
    })
    .optional(),
});
export type WebsiteStat = z.infer<typeof WebsiteStatSchema>;

/** A fix the Growth agent prepared for a person to review (website branch or Play listing text). */
export const GrowthFixSchema = z.object({
  id: z.string(),
  kind: z.enum(["website", "aso"]),
  date: z.string(),
  at: z.string(),
  status: z.enum(["ready", "failed", "nothing", "merged", "dismissed"]),
  title: z.string(),
  /** What was changed or proposed, one line each, in plain language. */
  summary: z.array(z.string()).default([]),
  error: z.string().default(""),
  /** Website: the review branch, the files it changes and the GitHub "create pull request" link. */
  branch: z.string().optional(),
  files: z.array(z.string()).optional(),
  compareUrl: z.string().optional(),
  /** ASO: the proposed Play Store listing. */
  aso: z
    .object({ title: z.string(), shortDescription: z.string(), fullDescription: z.string(), keywords: z.array(z.string()), reasons: z.array(z.string()) })
    .optional(),
});
export type GrowthFix = z.infer<typeof GrowthFixSchema>;

/** Google Play (ASO) for the last 28 days, one row per day it was read. */
export const AsoStatSchema = z.object({
  date: z.string(),
  at: z.string(),
  packageName: z.string(),
  from: z.string(),
  to: z.string(),
  crashRate: z.number().nullable().optional(),
  userPerceivedCrashRate: z.number().nullable().optional(),
  anrRate: z.number().nullable().optional(),
  userPerceivedAnrRate: z.number().nullable().optional(),
  vitalsUsers: z.number().nullable().optional(),
  installs: z.number().optional(),
  uninstalls: z.number().optional(),
  totalInstalls: z.number().optional(),
  activeDevices: z.number().optional(),
  storeVisitors: z.number().optional(),
  storeAcquisitions: z.number().optional(),
  conversion: z.number().optional(),
  rating: z.number().optional(),
  reviews: z.array(z.object({ id: z.string(), stars: z.number(), text: z.string(), at: z.string(), version: z.string() })).default([]),
});
export type AsoStat = z.infer<typeof AsoStatSchema>;

/* ------------------------------------------------------------------ */
/* "Tell the team": instructions typed in the app                      */
/* ------------------------------------------------------------------ */

/** One change a command made, with what is needed to undo it. */
export const CommandChangeSchema = z.object({
  id: z.string(),
  /** Plain-language description shown in the app. */
  label: z.string(),
  /** Machine-readable undo data (see src/lib/command/agent.ts). */
  undo: z.record(z.string(), z.unknown()).nullable().default(null),
  undoneAt: z.string().nullable().default(null),
});
export type CommandChange = z.infer<typeof CommandChangeSchema>;

export const CommandSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  text: z.string(),
  by: z.string().default(""),
  at: z.string(),
  status: z.enum(["pending", "running", "done", "failed"]).default("pending"),
  /** Claude's short answer to the person. */
  reply: z.string().default(""),
  changes: z.array(CommandChangeSchema).default([]),
  error: z.string().default(""),
  finishedAt: z.string().nullable().default(null),
});
export type Command = z.infer<typeof CommandSchema>;

/* ------------------------------------------------------------------ */
/* Chat (make, change and post videos by talking; see src/lib/chat)    */
/* ------------------------------------------------------------------ */

export const CHAT_VIDEO_KINDS = ["quiz", "myth", "hack", "cartoon", "explainer"] as const;
export type ChatVideoKind = (typeof CHAT_VIDEO_KINDS)[number];

export const ChatVideoSchema = z.object({
  kind: z.enum(CHAT_VIDEO_KINDS),
  /** The script as JSON (shape depends on kind), so the next message can change it. */
  script: z.string(),
  topic: z.string().default(""),
  character: z.string().default(""),
  /** Rendered file (full path in data/videos) once it is ready. */
  file: z.string().default(""),
  durationSec: z.number().nullable().default(null),
  /** Music credit line to add to captions (CC BY tracks). */
  credit: z.string().default(""),
});
export type ChatVideo = z.infer<typeof ChatVideoSchema>;

export const ChatIdeaSchema = z.object({
  title: z.string(),
  kind: z.enum(CHAT_VIDEO_KINDS).default("explainer"),
  hook: z.string().default(""),
  why: z.string().default(""),
  inspiredBy: z.string().default(""),
});
export type ChatIdea = z.infer<typeof ChatIdeaSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string().default(""),
  by: z.string().default(""),
  at: z.string(),
  /** Assistant messages: working while Claude thinks or a video renders. */
  status: z.enum(["working", "done", "failed"]).default("done"),
  /** What the assistant is doing right now, shown while working. */
  progress: z.string().default(""),
  video: ChatVideoSchema.nullable().default(null),
  ideas: z.array(ChatIdeaSchema).default([]),
  /** Posts created from this message (content ids). */
  postIds: z.array(z.string()).default([]),
  error: z.string().default(""),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  title: z.string().default("New chat"),
  createdBy: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(ChatMessageSchema).default([]),
});
export type Chat = z.infer<typeof ChatSchema>;

export const DatabaseSchema = z.object({
  version: z.literal(1),
  settings: SettingsSchema,
  brands: z.array(BrandSchema),
  ideas: z.array(IdeaSchema),
  content: z.array(ContentPieceSchema),
  briefs: z.array(VideoBriefSchema),
  metrics: z.array(PostMetricSchema),
  experiments: z.array(ExperimentSchema),
  learning: z.array(LearningEntrySchema),
  inbox: z.array(InboxItemSchema),
  trends: z.array(TrendSchema).default([]),
  competitors: z.array(CompetitorSchema).default([]),
  competitorPosts: z.array(CompetitorPostSchema).default([]),
  blogPosts: z.array(BlogPostSchema).default([]),
  tracking: z.array(TrackingSnapshotSchema).default([]),
  llmoResults: z.array(LlmoResultSchema).default([]),
  accountStats: z.array(AccountStatSchema).default([]),
  websiteStats: z.array(WebsiteStatSchema).default([]),
  growthFixes: z.array(GrowthFixSchema).default([]),
  asoStats: z.array(AsoStatSchema).default([]),
  commands: z.array(CommandSchema).default([]),
  chats: z.array(ChatSchema).default([]),
});
export type Database = z.infer<typeof DatabaseSchema>;
