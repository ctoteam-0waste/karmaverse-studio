import type { ContentPiece, Platform } from "../schemas";

/**
 * Publishing integrations.
 *
 * Platform API requirements (checked against official documentation on
 * 26 Oct 2026; re-check when a call fails, because platforms change them).
 * Live API calls are in ./connectors.ts and run through the Publishing Agent
 * (./agent.ts). A platform without credentials stays export-only: the app
 * prepares the text below and a person posts it.
 */

export interface AdapterInfo {
  platform: Platform;
  mode: "export-only";
  officialApi: string;
  accountRequirement: string;
  permissions: string[];
  access: string;
  limits: string[];
  notSupported: string[];
  docs: string;
}

export const ADAPTERS: Record<Platform, AdapterInfo> = {
  instagram: {
    platform: "instagram",
    mode: "export-only",
    officialApi: "Instagram Platform content publishing (Graph API)",
    accountRequirement: "Instagram professional account (and Page Publishing Authorization if the linked Page requires it).",
    permissions: ["instagram_business_basic + instagram_business_content_publish (Instagram Login)", "or instagram_basic + instagram_content_publish (+ pages_read_engagement with Facebook Login)"],
    access: "Meta app with Standard or Advanced Access; Advanced Access requires App Review.",
    limits: [
      "Rolling 24-hour cap on API-published posts (docs state 100 in one place and 50 in another; query GET /<IG_ID>/content_publishing_limit for the live value). A carousel counts as one post.",
      "Media must be hosted at a public URL when publishing; images must be JPEG.",
      "Unpublished containers expire after 24 hours.",
    ],
    notSupported: ["Shopping tags", "Filters"],
    docs: "https://developers.facebook.com/docs/instagram-platform/content-publishing",
  },
  facebook: {
    platform: "facebook",
    mode: "export-only",
    officialApi: "Facebook Pages API (/{page-id}/feed, /photos, /videos)",
    accountRequirement: "A Facebook Page where the user can perform CREATE_CONTENT, MANAGE and MODERATE tasks.",
    permissions: ["pages_manage_posts", "pages_read_engagement", "pages_manage_engagement", "pages_read_user_engagement"],
    access: "Page access token via Facebook Login; App Review for Advanced Access.",
    limits: ["Scheduled posts must be 10 minutes to 30 days in the future (scheduled_publish_time)."],
    notSupported: ["Editing posts that were not created by the same app"],
    docs: "https://developers.facebook.com/docs/pages-api/posts",
  },
  youtube: {
    platform: "youtube",
    mode: "export-only",
    officialApi: "YouTube Data API v3 (videos.insert, thumbnails.set)",
    accountRequirement: "A YouTube channel and a Google Cloud project with OAuth consent configured.",
    permissions: ["https://www.googleapis.com/auth/youtube.upload"],
    access: "OAuth 2.0 user consent. Higher quota needs the YouTube API Services audit and quota extension form.",
    limits: [
      "Default quota: 10,000 units per day for most endpoints; videos.insert and search.list each have their own daily call limit (100 per day at the time of checking).",
      "Uploads from unverified (un-audited) API projects may be restricted to private; check current YouTube API docs before relying on public uploads.",
    ],
    notSupported: [],
    docs: "https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits",
  },
  x: {
    platform: "x",
    mode: "export-only",
    officialApi: "X API v2 (POST /2/tweets)",
    accountRequirement: "An X developer account and a Project/App with Read and Write permission, plus the account's user access token and secret (OAuth 1.0a).",
    permissions: ["Read and Write app permission", "OAuth 1.0a user context (API key + secret, access token + secret)"],
    access: "Posting volume depends on the X API plan; the free tier has a small monthly post cap. Check current pricing in the developer portal.",
    limits: ["280 characters for standard accounts (links count as 23).", "Generate the access token after setting Read and Write, or posts are rejected with 403."],
    notSupported: ["Media upload is not in this connector yet: X posts with media must be posted by hand."],
    docs: "https://docs.x.com/x-api/posts/create-post",
  },
  linkedin: {
    platform: "linkedin",
    mode: "export-only",
    officialApi: "LinkedIn Posts API (Community Management API product)",
    accountRequirement: "The connecting member must be an admin of the LinkedIn company page.",
    permissions: ["w_organization_social (company page)", "w_member_social (personal profile)"],
    access: "Community Management API is a restricted product; LinkedIn reviews the use case before access (reported 1–2 weeks). Access tokens expire after 60 days.",
    limits: ["Every request needs a Linkedin-Version header (YYYYMM).", "LinkedIn does not publish exact rate limits."],
    notSupported: ["Document carousels, polls and articles are reported as not publishable via the API; post those manually."],
    docs: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
  },
};

/* ------------------------------------------------------------------ */
/* Exports (the manual publishing step)                                */
/* ------------------------------------------------------------------ */

/** Ready-to-paste text for one piece of content. */
export function exportPiece(p: ContentPiece): string {
  const lines: string[] = [];
  lines.push(`PLATFORM: ${p.platform} / ${p.format}`);
  if (p.plannedDate) lines.push(`POST ON: ${p.plannedDate}${p.plannedTime ? ` at ${p.plannedTime}` : ""}`);
  lines.push(`STATUS: ${p.status}${p.approvedBy ? ` (approved by ${p.approvedBy})` : ""}`);
  lines.push("");
  if (p.platform === "youtube") {
    lines.push(`TITLE:\n${p.hook}`, "", `DESCRIPTION:\n${p.description}`, "", `TAGS:\n${p.keywords.join(", ")}`);
    if (p.hashtags.length) lines.push("", `HASHTAGS:\n${p.hashtags.join(" ")}`);
  } else {
    lines.push(`POST TEXT:\n${p.caption}`);
    if (p.hashtags.length) lines.push("", p.hashtags.join(" "));
    if (p.description) lines.push("", `NOTES:\n${p.description}`);
  }
  if (p.thumbnailConcept) lines.push("", `COVER / THUMBNAIL:\n${p.thumbnailConcept}`);
  if (p.mediaUrls.length) lines.push("", `MEDIA:\n${p.mediaUrls.join("\n")}`);
  lines.push("", "MANUAL STEP: post this on the platform, then paste the live URL in the app and mark it Published.");
  return lines.join("\n");
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportCalendarCsv(items: ContentPiece[]): string {
  const header = ["date", "time", "platform", "format", "pillar", "topic", "hook", "status", "target_metric", "target", "caption", "hashtags"];
  const rows = items
    .filter((i) => i.plannedDate)
    .sort((a, b) => (a.plannedDate ?? "").localeCompare(b.plannedDate ?? ""))
    .map((i) =>
      [i.plannedDate ?? "", i.plannedTime ?? "", i.platform, i.format, i.pillarId, i.topic, i.hook, i.status, i.targetMetric?.metric ?? "", i.targetMetric?.target ?? "", i.caption, i.hashtags.join(" ")]
        .map((v) => csvCell(String(v)))
        .join(","),
    );
  return [header.join(","), ...rows].join("\n");
}
