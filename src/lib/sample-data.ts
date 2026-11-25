import type { Database, Experiment, InboxItem, PostMetric } from "./schemas";
import { KARMAVERSE_BRAND } from "./brands/karmaverse";
import { classifyComment, draftReply, INBOX_API_DEFAULTS } from "./agents/community";
import { generateIdeas } from "./agents/strategy";

/**
 * SAMPLE DATA — every record here has isSample: true and is labelled "Sample"
 * in the UI. The numbers are invented for demonstration only and are NOT
 * KarmaVerse's real performance. Delete them from Settings once real data is in.
 */

const B = KARMAVERSE_BRAND.id;

type Row = [string, PostMetric["platform"], PostMetric["format"], string, string, string, Record<string, number>];

// [postedAt (IST), platform, format, hook, pillarId, cta, metrics]
const ROWS: Row[] = [
  ["2026-09-02T19:05:00+05:30", "instagram", "reel", "Your raddi is worth more than you think", "product", "Download the app (link in bio)", { views: 2100, reach: 1650, avgWatchTimeSec: 9, durationSec: 28, likes: 96, comments: 11, shares: 14, saves: 22, profileVisits: 41, follows: 9 }],
  ["2026-09-05T13:10:00+05:30", "instagram", "reel", "3 swaps for a lower-waste morning", "habits", "Save this for later", { views: 1500, reach: 1200, avgWatchTimeSec: 8, durationSec: 30, likes: 61, comments: 4, shares: 7, saves: 19, profileVisits: 18, follows: 4 }],
  ["2026-09-09T19:20:00+05:30", "instagram", "reel", "Myth or fact: the recycling symbol means it gets recycled?", "myths", "Share this with someone who needs it", { views: 4300, reach: 3500, avgWatchTimeSec: 14, durationSec: 27, likes: 210, comments: 38, shares: 61, saves: 74, profileVisits: 95, follows: 31 }],
  ["2026-09-13T09:00:00+05:30", "instagram", "reel", "A day with our pickup team", "bts", "Follow for more", { views: 1300, reach: 1050, avgWatchTimeSec: 11, durationSec: 40, likes: 72, comments: 9, shares: 5, saves: 6, profileVisits: 22, follows: 5 }],
  ["2026-09-18T19:10:00+05:30", "instagram", "reel", "Stop throwing these 3 things in the dustbin", "edu-shorts", "Save this for later", { views: 3900, reach: 3100, avgWatchTimeSec: 12, durationSec: 25, likes: 180, comments: 22, shares: 48, saves: 91, profileVisits: 70, follows: 20 }],
  ["2026-09-24T13:30:00+05:30", "instagram", "reel", "How to book a doorstep pickup in 2 steps", "product", "Book a pickup in the app", { views: 1700, reach: 1400, avgWatchTimeSec: 10, durationSec: 30, likes: 58, comments: 6, shares: 6, saves: 15, profileVisits: 33, follows: 6 }],
  ["2026-10-01T19:00:00+05:30", "instagram", "reel", "Myth: e-waste is safe in the regular bin", "myths", "Share this with someone who needs it", { views: 5200, reach: 4200, avgWatchTimeSec: 13, durationSec: 26, likes: 240, comments: 41, shares: 77, saves: 88, profileVisits: 120, follows: 38 }],
  ["2026-10-08T09:15:00+05:30", "instagram", "reel", "Why we started KarmaVerse", "bts", "Follow for more", { views: 1100, reach: 900, avgWatchTimeSec: 12, durationSec: 55, likes: 64, comments: 12, shares: 3, saves: 4, profileVisits: 25, follows: 7 }],
  ["2026-10-15T19:25:00+05:30", "instagram", "reel", "Do you know where your old charger goes?", "circular", "Tell us in the comments", { views: 2900, reach: 2300, avgWatchTimeSec: 11, durationSec: 29, likes: 120, comments: 35, shares: 21, saves: 30, profileVisits: 52, follows: 14 }],
  ["2026-09-07T12:00:00+05:30", "instagram", "carousel", "Wet vs dry waste: the cheat sheet", "edu-shorts", "Save this for later", { reach: 1900, impressions: 2600, likes: 88, comments: 7, shares: 25, saves: 120, profileVisits: 30, follows: 8 }],
  ["2026-09-21T12:00:00+05:30", "instagram", "carousel", "5 sustainability myths Indian families believe", "myths", "Save this for later", { reach: 2400, impressions: 3300, likes: 130, comments: 19, shares: 44, saves: 150, profileVisits: 45, follows: 15 }],
  ["2026-10-05T12:30:00+05:30", "instagram", "carousel", "Festival season without the waste pile", "circular", "Save this for later", { reach: 2100, impressions: 2900, likes: 97, comments: 10, shares: 31, saves: 104, profileVisits: 28, follows: 9 }],
  ["2026-10-19T19:00:00+05:30", "instagram", "carousel", "Our September in numbers", "impact", "Follow for more", { reach: 1100, impressions: 1500, likes: 52, comments: 3, shares: 4, saves: 9, profileVisits: 14, follows: 2 }],
  ["2026-09-03T18:00:00+05:30", "youtube", "short", "Recycling symbol myth in 25 seconds", "myths", "Subscribe for more quick tips", { views: 3100, avgPercentViewed: 71, avgViewDurationSec: 18, likes: 140, comments: 12, shares: 20, subscribersGained: 18 }],
  ["2026-09-12T18:00:00+05:30", "youtube", "short", "Wet vs dry waste explained", "edu-shorts", "Subscribe for more quick tips", { views: 2200, avgPercentViewed: 64, avgViewDurationSec: 17, likes: 90, comments: 6, shares: 9, subscribersGained: 9 }],
  ["2026-09-26T18:00:00+05:30", "youtube", "short", "How the pickup works", "product", "Download the app (link in bio)", { views: 900, avgPercentViewed: 48, avgViewDurationSec: 14, likes: 28, comments: 2, shares: 1, subscribersGained: 2 }],
  ["2026-10-10T18:00:00+05:30", "youtube", "short", "Stop putting batteries in the bin", "edu-shorts", "Subscribe for more quick tips", { views: 4100, avgPercentViewed: 76, avgViewDurationSec: 19, likes: 180, comments: 15, shares: 33, subscribersGained: 25 }],
  ["2026-10-20T18:00:00+05:30", "youtube", "short", "A day with our pickup team", "bts", "Subscribe for more quick tips", { views: 1200, avgPercentViewed: 52, avgViewDurationSec: 21, likes: 40, comments: 4, shares: 2, subscribersGained: 3 }],
  ["2026-09-08T10:00:00+05:30", "linkedin", "text-post", "Why we're building a rewards platform for sustainable gestures", "bts", "What has worked in your organisation? Tell us in the comments.", { impressions: 3400, reactions: 120, comments: 18, reposts: 9, clicks: 60, followersGained: 22 }],
  ["2026-09-22T10:00:00+05:30", "linkedin", "text-post", "3 lessons from our first 100 doorstep pickups", "impact", "What has worked in your organisation? Tell us in the comments.", { impressions: 5200, reactions: 210, comments: 34, reposts: 15, clicks: 95, followersGained: 40 }],
  ["2026-10-06T10:00:00+05:30", "linkedin", "text-post", "How housing societies can run an e-waste drive", "community", "What has worked in your organisation? Tell us in the comments.", { impressions: 2800, reactions: 80, comments: 9, reposts: 5, clicks: 41, followersGained: 12 }],
  ["2026-10-20T10:00:00+05:30", "linkedin", "text-post", "What is a circular economy, really?", "circular", "What has worked in your organisation? Tell us in the comments.", { impressions: 3000, reactions: 96, comments: 11, reposts: 6, clicks: 38, followersGained: 15 }],
  ["2026-09-10T19:30:00+05:30", "facebook", "image-post", "Has your family tried segregating waste?", "habits", "Tell us in the comments", { reach: 1400, impressions: 1900, reactions: 45, comments: 14, shares: 6, clicks: 12 }],
  ["2026-09-28T19:30:00+05:30", "facebook", "image-post", "Festival cleaning checklist", "circular", "Tell us in the comments", { reach: 1800, impressions: 2400, reactions: 60, comments: 8, shares: 22, clicks: 19 }],
  ["2026-10-12T19:30:00+05:30", "facebook", "image-post", "Which of these do you throw away?", "edu-shorts", "Tell us in the comments", { reach: 1600, impressions: 2100, reactions: 52, comments: 21, shares: 9, clicks: 10 }],
];

function sampleMetrics(): PostMetric[] {
  return ROWS.map(([postedAt, platform, format, hook, pillarId, cta, metrics], i) => ({
    id: `sample_metric_${String(i + 1).padStart(2, "0")}`,
    brandId: B,
    contentId: null,
    platform,
    format,
    postedAt: new Date(postedAt).toISOString(),
    hook,
    pillarId,
    cta,
    url: "",
    metrics,
    source: "manual",
    isSample: true,
    syncedAt: null,
  }));
}

const COMMENTS: Array<[InboxItem["platform"], string, string, string]> = [
  ["instagram", "@riya.k", "How do I know if my society is covered for pickup?", "2026-10-22T10:12:00Z"],
  ["instagram", "@aman_gurgaon", "Booked a pickup 3 days ago and the agent never came. Still waiting.", "2026-10-22T11:40:00Z"],
  ["instagram", "@greenmom", "Loved this! Sharing with my building group 💚", "2026-10-22T12:03:00Z"],
  ["youtube", "@techbhai", "Can I give old laptops too or only phones?", "2026-10-23T08:20:00Z"],
  ["instagram", "@promo.king", "Follow for follow! Check my page for crypto tips www.example.biz", "2026-10-23T09:00:00Z"],
  ["facebook", "Sunita Sharma", "You should add a Hindi version of the app please", "2026-10-23T14:30:00Z"],
  ["instagram", "@vik.r", "My coins are not credited after pickup. This is fraud, I will go to consumer court.", "2026-10-24T07:45:00Z"],
  ["linkedin", "Priya Menon", "Great initiative. Kya schools bhi join kar sakte hain?", "2026-10-24T16:10:00Z"],
];

function sampleInbox(): InboxItem[] {
  return COMMENTS.map(([platform, author, text, receivedAt], i) => {
    const classification = classifyComment(text);
    return {
      id: `sample_inbox_${i + 1}`,
      brandId: B,
      platform,
      author,
      text,
      postRef: "",
      receivedAt,
      classification,
      suggestedReply: draftReply(KARMAVERSE_BRAND, { author, text, classification }),
      replyStatus: "drafted",
      approvedBy: null,
      ...INBOX_API_DEFAULTS,
      isSample: true,
    };
  });
}

function sampleExperiments(): Experiment[] {
  return [
    {
      id: "sample_exp_1",
      brandId: B,
      hypothesis: "Myth-or-fact hooks outperform statement hooks on Instagram Reels.",
      platform: "instagram",
      format: "reel",
      variable: "hook",
      change: "Use a myth-or-fact opener on the next 4 Reels; keep posting time at 19:00.",
      primaryMetric: "Engagement rate (per reach)",
      baseline: "Sample baseline",
      impact: 4,
      effort: 1,
      status: "running",
      startDate: "2026-10-20",
      endDate: null,
      result: "",
      learning: "",
      createdAt: "2026-10-20T09:00:00.000Z",
      isSample: true,
    },
  ];
}

export function buildSeed(): Database {
  const inbox = sampleInbox();
  // Ideas are real starter suggestions (not sample performance data), so they are kept when samples are cleared.
  // Ideas sourced from the sample inbox are skipped so clearing samples leaves nothing fake behind.
  const ideas = generateIdeas(KARMAVERSE_BRAND, { content: [], inbox: [], existingIdeas: [], today: new Date().toISOString().slice(0, 10) });
  return {
    version: 1,
    settings: { activeBrandId: B, generationMode: "template", autoPublish: false, team: [], teamMembers: [], videoLooks: [], lastPublishRun: null, lastMetricsSync: null, autoReply: "off", lastCommunitySync: null, lastTrendScan: null, lastCompetitorSync: null },
    brands: [KARMAVERSE_BRAND],
    ideas,
    content: [],
    briefs: [],
    metrics: sampleMetrics(),
    experiments: sampleExperiments(),
    learning: [
      { id: "sample_learn_1", brandId: B, at: "2026-10-20T09:00:00.000Z", kind: "hypothesis", text: "Sample: myth-or-fact hooks may beat statement hooks on Reels.", experimentId: "sample_exp_1" },
    ],
    inbox,
    trends: [],
    competitors: [],
    competitorPosts: [],
    blogPosts: [],
    accountStats: [],
    websiteStats: [],
    growthFixes: [],
    asoStats: [],
    commands: [],
    chats: [],
    tracking: [],
    llmoResults: [],
  };
}
