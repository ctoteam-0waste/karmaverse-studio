import type { ContentPiece } from "../schemas";

/**
 * WhatsApp share pack: one message with every live link for a day, written so
 * people actually open and forward it. It leads with what's interesting (the
 * post's hook and a teaser from its caption), asks the post's own question so
 * people comment, and gives a concrete "forward this to…" reason that fits the
 * topic. People forward things that are useful, surprising or make them look
 * good to the person they send it to; a plain "please like and share" isn't one.
 */

const ICON: Record<string, string> = { youtube: "▶️", facebook: "📘", instagram: "📸", linkedin: "💼", x: "✖️" };
const NAME: Record<string, string> = { youtube: "YouTube", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", x: "X" };

export interface ShareLink {
  platform: string;
  format: string;
  label: string;
  url: string;
  hook: string;
  contentId: string;
  /** Up to three short caption lines that make people curious. */
  teaser: string[];
  /** The question the post asks its audience, if any. */
  question: string;
}

const clean = (s: string) => s.replace(/\s*#\w+/g, "").replace(/\s*\((story|reel)\)\s*$/i, "").trim();
/** Letters and digits only, for spotting a line that just repeats the hook. */
const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Short, interesting lines from a caption (skips hashtags, notes to the team, slide outlines and the hook itself). */
export function teaserFrom(caption: string, hook: string): string[] {
  const h = bare(clean(hook));
  return caption
    .split(/\r?\n/)
    .map((l) => clean(l))
    .filter((l) => l.length >= 8 && l.length <= 110 && !l.includes("?"))
    .filter((l) => !(h && (bare(l) === h || bare(l).startsWith(h) || h.startsWith(bare(l)))) && !/^(slide\s*\d|swipe|if posting by hand|source:|\(fy|search|google play|link in bio|full story)/i.test(l))
    .slice(0, 3);
}

/** The audience question in a caption (its last line with a "?"), cut after the question mark. */
export function questionFrom(caption: string): string {
  const line = caption
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes("?") && l.length <= 160)
    .pop();
  if (!line) return "";
  const q = line.slice(0, line.indexOf("?") + 1).trim();
  return q.length >= 10 ? q : "";
}

/** Live links for posts published on `date` (IST), one per platform and format, newest first. */
export function liveLinks(content: ContentPiece[], date: string): ShareLink[] {
  const day = (c: ContentPiece) => {
    const at = c.history.find((h) => h.to === "published")?.at ?? c.updatedAt;
    return new Date(at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  };
  const seen = new Set<string>();
  return content
    .filter((c) => c.status === "published" && c.publishedUrl && day(c) === date)
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
    .filter((c) => {
      const key = c.publishedUrl!;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => {
      const text = c.format === "story" ? "" : [c.caption, c.platform === "youtube" ? c.description : ""].join("\n");
      return {
        platform: c.platform,
        format: c.format,
        label: `${NAME[c.platform] ?? c.platform} ${c.format === "reel" || c.format === "short" ? (c.platform === "youtube" ? "Short" : "Reel") : c.format === "story" ? "Story" : "post"}`,
        url: c.publishedUrl!,
        hook: c.hook,
        contentId: c.id,
        teaser: teaserFrom(text, c.hook),
        question: questionFrom(text),
      };
    });
}

/** Who to forward it to, by topic: a specific person is far more likely to get it than "family & friends". */
export function forwardReason(topic: string): string {
  if (/news|growth|lakh|impact|milestone|award/i.test(topic)) return "apne family group mein: dikhao ki India mein climate action sach mein ho raha hai 🇮🇳";
  if (/\b(ac|tv|fridge|appliance|e-?waste|gadget|charger|phone)\b/i.test(topic)) return "us dost ko jiske ghar mein purana AC, TV ya phone pada hai 😄";
  if (/hostel|pg|student|college/i.test(topic)) return "apne hostel ya PG group mein 🎒";
  if (/myth|fact|recycl|plastic/i.test(topic)) return "us dost ko jo har plastic ko recyclable samajhta hai 😅";
  if (/festival|diwali|holi|wedding|party/i.test(topic)) return "us group mein jahan festival ki planning chal rahi hai 🎉";
  if (/office|work|team|company/i.test(topic)) return "apne office group mein 💼";
  return "us ek dost ko jo planet ki parwah karta hai 💚";
}

/** Questions to fall back on when the post doesn't ask one, rotated by `seed`. */
const QUESTIONS = ["Aap is mein se kya already karte ho?", "Aapke ghar mein sabse pehle kya badlega?", "Aapka favourite green habit kya hai?", "Aap kis baat se sabse zyada surprised hue?"];

export function shareMessage(links: ShareLink[], opts: { brand: string; topic: string; seed: number }): string {
  // Lead with a post that has a real caption (stories usually don't).
  const lead = links.find((l) => l.format !== "story" && l.teaser.length) ?? links.find((l) => l.format !== "story") ?? links[0];
  const hook = clean(lead?.hook ?? opts.topic) || `New from ${opts.brand}`;
  const question = links.map((l) => l.question).find(Boolean) || QUESTIONS[opts.seed % QUESTIONS.length]!;
  const lines = [
    `*${hook}* 👀`,
    ...(lead?.teaser.length ? ["", ...lead.teaser] : []),
    "",
    links.length > 1 ? "👇 *Dekho, jahan bhi aap hote ho:*" : "👇 *Dekho:*",
    ...links.flatMap((l) => [`${ICON[l.platform] ?? "🔗"} ${l.label}: ${l.url}`]),
    "",
    `💬 ${question} Comment mein batao!`,
    `📤 Forward karo ${forwardReason(`${opts.topic} ${hook}`)}`,
    "❤️ Ek like se yeh aur logon tak pahunchta hai.",
    "",
    `_${opts.brand} · Chhote steps, bada impact 🌍_`,
  ];
  return lines.join("\n");
}

/** Short version for a WhatsApp Status (shown over the video): the hook, then the links. */
export function statusText(links: ShareLink[], brand: string): string {
  const lead = links.find((l) => l.format !== "story") ?? links[0];
  const hook = clean(lead?.hook ?? "") || brand;
  return [`${hook} 👀 Dekho 👇`, ...links.slice(0, 3).map((l) => `${ICON[l.platform] ?? "🔗"} ${l.url}`)].join("\n");
}
