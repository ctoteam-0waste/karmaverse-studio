import type { Brand, Classification, ContentPiece, InboxItem } from "../schemas";

/**
 * Rule-based comment classifier (free, offline, works for English and common Hinglish).
 * It is deliberately cautious: anything legal, safety-related, account-specific
 * or abusive is routed to a human. Replies are drafts; nothing is posted.
 */

const RULES = {
  spamLink: /(https?:\/\/|www\.|bit\.ly|t\.me\/|wa\.me\/)/i,
  spamWords: /\b(follow ?for ?follow|f4f|dm (me|for) (promo|collab)|check my (page|profile)|crypto|forex|earn \$?\d+ (per|a) day|giveaway winner|click (the )?link)\b/i,
  legal: /\b(lawyer|legal action|consumer (court|forum)|fir\b|police|sue\b|notice|fraud|scam|cheat(ed|ing)?|defamation)\b/i,
  privacy: /\b(my (phone|number|address|data)|personal (data|information)|leak(ed)?|privacy)\b/i,
  harmful: /\b(kill|suicide|self[- ]harm|hurt (myself|someone)|bomb|threat)\b/i,
  abusive: /\b(idiot|stupid|bloody|shut up|chutiya|bewakoof|fake company|pagal)\b/i,
  support: /\b(pickup|pick-up|agent|coins?|karmacoins?|wallet|redeem|reward|otp|login|log in|sign ?up|app (is )?(not|crash)|not (working|credited|received|showing)|didn'?t (come|arrive|get)|booking|order|refund|payment)\b/i,
  supportProblem: /\b(not|didn'?t|never|no one|nobody|still|waiting|missing|wrong|problem|issue|error|crash|nahi|nahin)\b/i,
  question: /\?|^(how|what|why|when|where|which|who|can|could|do|does|is|are|will|should|kya|kaise|kab|kahan|kyun)\b/i,
  feedback: /\b(suggest|suggestion|should (add|have)|please add|would be (nice|great)|feature request|improve|wish)\b/i,
  praise: /\b(love|great|awesome|amazing|helpful|thank(s| you)|nice|good (job|work)|mast|badhiya|zabardast|superb|inspiring|👏|❤️|🙌|🔥)\b|👏|❤️|🙌|🔥|💚/i,
  negative: /\b(bad|worst|useless|disappoint|angry|frustrat|annoy|poor|terrible|hate|bakwas|bekaar|ghatiya)\b|😡|👎/i,
};

/** Fields of an inbox item that only comments read from a platform API have. */
export const INBOX_API_DEFAULTS = { externalId: null, contentId: null, replyExternalId: null, replyError: null, replySendingAt: null } as const;

export function classifyComment(text: string): Classification {
  const t = text.trim();
  const flags: Classification["flags"] = [];

  if (RULES.harmful.test(t)) flags.push("harmful");
  if (RULES.legal.test(t)) flags.push("legal");
  if (RULES.privacy.test(t)) flags.push("privacy");
  if (RULES.abusive.test(t)) flags.push("abusive");
  const isSpam = RULES.spamWords.test(t) || (RULES.spamLink.test(t) && !RULES.support.test(t));
  if (RULES.spamLink.test(t)) flags.push("spam-link");
  // Account-specific = a product word plus a problem, or a question about *their own* coins/pickup/booking.
  // General product questions ("Is my society covered for pickup?") stay as questions.
  const ownAccount = /\b(my|mera|meri|mere) (coins?|karmacoins?|pickup|booking|order|wallet|account|reward|points)\b/i.test(t);
  const isSupport = RULES.support.test(t) && (RULES.supportProblem.test(t) || ownAccount);
  if (isSupport) flags.push("customer-support");

  const negative = RULES.negative.test(t) || flags.includes("abusive");
  const positive = !negative && RULES.praise.test(t);
  const sentiment: Classification["sentiment"] = negative ? "negative" : positive ? "positive" : "neutral";

  let intent: Classification["intent"];
  let reason: string;
  if (flags.includes("harmful") || flags.includes("legal")) {
    intent = "escalation";
    reason = flags.includes("harmful") ? "Mentions harm or threats — a person must handle this, and follow your safety process." : "Legal or fraud language — route to a manager; do not reply publicly yet.";
  } else if (isSpam) {
    intent = "spam";
    reason = "Promotional or link spam. Hide or delete on the platform; do not reply.";
  } else if (isSupport) {
    intent = "support";
    reason = "Account-specific issue (pickup, coins, app). Needs a person to check the account; move to DM.";
  } else if (negative) {
    intent = "complaint";
    reason = "Negative experience. Acknowledge publicly, resolve privately.";
  } else if (RULES.feedback.test(t)) {
    intent = "feedback";
    reason = "Product or content suggestion. Thank them and log it.";
  } else if (RULES.question.test(t)) {
    intent = "question";
    reason = "General question. Can be answered publicly if the answer uses verified facts.";
  } else if (positive) {
    intent = "praise";
    reason = "Positive comment. Thank them and keep the conversation going.";
  } else {
    intent = "other";
    reason = "No clear intent.";
  }

  const needsHuman = intent === "escalation" || intent === "support" || intent === "complaint" || flags.some((f) => ["legal", "harmful", "privacy", "abusive"].includes(f));
  if (flags.includes("privacy") || flags.includes("abusive")) flags.push("sensitive");
  return { intent, sentiment, flags: [...new Set(flags)], needsHuman, reason };
}

/** Draft reply for a human to edit and approve. Returns "" when no public reply is appropriate. */
export function draftReply(brand: Brand, item: Pick<InboxItem, "author" | "text" | "classification">): string {
  const name = item.author.replace(/^@/, "").split(/[\s._]/)[0] || "there";
  const c = item.classification;
  switch (c.intent) {
    case "spam":
      return "";
    case "escalation":
      return `Hi ${name}, thank you for raising this. We take it seriously — please DM us your details so a member of our team can look into it personally.`;
    case "support":
      return `Hi ${name}, sorry about the trouble! Please DM us your registered phone number or booking ID (not here in the comments) and our team will check it for you today.`;
    case "complaint":
      return `Hi ${name}, we're sorry this wasn't a good experience. We'd like to make it right — could you DM us what happened?`;
    case "feedback":
      return `Thanks ${name}, that's a really useful suggestion! We've shared it with the ${brand.name} team. What would make it most useful for you?`;
    case "question":
      return `Great question, ${name}! [Answer using a verified fact only — check Settings > Brand facts.] Anything else you'd like to know?`;
    case "praise":
      return `Thank you, ${name}! 💚 That means a lot. What should we cover next?`;
    default:
      return `Thanks for commenting, ${name}! 🌱`;
  }
}

/* ------------------------------------------------------------------ */
/* Quiz posts                                                          */
/* ------------------------------------------------------------------ */

/** The correct option of a quiz post ("The answer: C" in its slides or caption), or null. */
export function quizAnswerOf(piece: Pick<ContentPiece, "slides" | "caption" | "description">): string | null {
  const m = [piece.slides, piece.caption, piece.description].join("\n").match(/\b[Aa]nswer(?:\s+is)?\s*[:\-–]?\s*\(?([A-D])\)?(?![\w'])/);
  return m ? m[1]! : null;
}

/** The option a comment picks ("C", "c)", "Option B", "my answer is d"), or null. "A great post" is not a guess. */
export function quizGuess(text: string): string | null {
  const t = text.trim();
  const named = t.match(/^\W*(?:(?:my\s+)?(?:option|answer|ans)(?:\s+is)?|i\s+think(?:\s+it'?s)?|it'?s|its)\s*[:\-]?\s*\(?([a-d])\)?(?![\w'])/i);
  if (named) return named[1]!.toUpperCase();
  const bare = t.match(/^\W*\(?([a-d])\)?\s*(?:[).:\-!]|$)/i);
  return bare ? bare[1]!.toUpperCase() : null;
}

/** Friendly reply to a quiz guess: celebrates a right answer, gently gives the right one otherwise. */
export function quizReply(author: string, guess: string, answer: string): string {
  const name = author.replace(/^@/, "").split(/[\s._]/)[0] || "there";
  return guess === answer
    ? `Correct, ${name}! 🎉 ${answer} it is. Swipe to the end to see why, and come back for the next quiz! 💚`
    : `Good try, ${name}! The answer is ${answer} 🌱 Swipe to see why, and try the next one!`;
}

/**
 * Classification and draft reply for a comment on a published post. Quiz
 * guesses on a quiz post get a quiz reply (when nothing else about the
 * comment needs a person).
 */
export function triageComment(brand: Brand, piece: Pick<ContentPiece, "slides" | "caption" | "description"> | null, author: string, text: string): { classification: Classification; reply: string; quiz: boolean } {
  const classification = classifyComment(text);
  const answer = piece ? quizAnswerOf(piece) : null;
  const guess = answer ? quizGuess(text) : null;
  if (answer && guess && classification.flags.length === 0 && !classification.needsHuman) {
    return {
      classification: { ...classification, intent: "other", reason: `Quiz answer: ${guess} (${guess === answer ? "correct" : `the answer is ${answer}`}).` },
      reply: quizReply(author, guess, answer),
      quiz: true,
    };
  }
  return { classification, reply: draftReply(brand, { author, text, classification }), quiz: false };
}

/** Safe for the Community Manager to answer without a person: thanks for praise and quiz replies only. */
export function safeToAutoReply(item: Pick<InboxItem, "classification" | "suggestedReply">): boolean {
  const c = item.classification;
  if (c.needsHuman || c.flags.length || c.sentiment === "negative" || !item.suggestedReply.trim()) return false;
  if (/\[[^\]]{3,}\]/.test(item.suggestedReply)) return false;
  return c.intent === "praise" || c.reason.startsWith("Quiz answer:");
}
