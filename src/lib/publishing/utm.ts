import type { ContentPiece } from "../schemas";

/**
 * Website click tracking: links to our own sites in post text get UTM tags,
 * so Google Analytics shows which platform and which post sent each visitor.
 *
 * utm_source   = platform (instagram, facebook, youtube, linkedin, x)
 * utm_medium   = social
 * utm_campaign = video series or content pillar
 * utm_content  = the post's id in the studio (matched back on the Results page)
 *
 * Play Store links get the same tags in the `referrer` parameter, which Play
 * Console reports as install sources.
 */

export const OWN_HOSTS = /(^|\.)(karmaverse\.earth|0waste\.co\.in)$/i;

type Piece = Pick<ContentPiece, "id" | "platform" | "pillarId"> & { series?: string | null };

export function utmParams(piece: Piece, campaign?: string): Record<string, string> {
  return {
    utm_source: piece.platform,
    utm_medium: "social",
    utm_campaign: (campaign ?? piece.series ?? piece.pillarId ?? "post") || "post",
    utm_content: piece.id,
  };
}

function tagOne(raw: string, piece: Piece): string {
  // Keep trailing punctuation outside the link ("…karmaverse.earth." or "(karmaverse.earth)").
  const trail = raw.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
  const link = trail ? raw.slice(0, -trail.length) : raw;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return raw;
  }
  const params = utmParams(piece);
  if (OWN_HOSTS.test(url.hostname)) {
    if ([...url.searchParams.keys()].some((k) => k.startsWith("utm_"))) return raw;
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString() + trail;
  }
  if (url.hostname === "play.google.com" && url.pathname.startsWith("/store/apps/details") && !url.searchParams.has("referrer")) {
    url.searchParams.set("referrer", new URLSearchParams(params).toString());
    return url.toString() + trail;
  }
  return raw;
}

/** Adds UTM tags to links to our own sites (and the Play Store) in a post's text. */
export function tagLinks(text: string, piece: Piece): string {
  return text.replace(/https?:\/\/[^\s<>"']+/g, (raw) => tagOne(raw, piece));
}

/** The tagged link to put in the Instagram bio (or any profile link). */
export function bioLink(site: string, platform: string): string {
  const url = new URL(site);
  url.searchParams.set("utm_source", platform);
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", "bio");
  return url.toString();
}
