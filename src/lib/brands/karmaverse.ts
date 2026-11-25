import type { Brand } from "../schemas";

/**
 * Initial brand profile for KarmaVerse.
 *
 * Facts are marked `verified: true` only when they come from the brand's own
 * published website. Facts taken from draft Play Store assets are left
 * unverified until the team confirms them in Settings. Generated content only
 * states verified facts; unverified ones appear as [CONFIRM: ...] placeholders.
 */
export const KARMAVERSE_BRAND: Brand = {
  id: "brand_karmaverse",
  name: "KarmaVerse",
  organisation: "3R ZeroWaste",
  category:
    "Sustainability, sustainable habits, responsible consumption, climate awareness, and rewards for sustainable gestures",
  website: "https://karmaverse.earth",
  audience: [
    "Indian students",
    "Young professionals",
    "Communities and housing societies",
    "Environmentally conscious consumers",
    "Potential institutional partners",
  ],
  voice: ["relatable", "credible", "optimistic", "practical", "modern", "India-aware"],
  languages: ["English", "Hinglish"],
  pillars: [
    { id: "habits", name: "Easy sustainable habits", description: "Small swaps anyone can start today." },
    { id: "myths", name: "Myths and facts", description: "Common sustainability myths, corrected with sources." },
    { id: "edu-shorts", name: "Educational short videos", description: "One idea explained in under a minute." },
    { id: "community", name: "Community challenges and user stories", description: "Challenges, leaderboards and real member stories (with consent)." },
    { id: "product", name: "Product education and demos", description: "How to use the KarmaVerse app: pickups, quiz, wallet." },
    { id: "circular", name: "Responsible consumption and circular economy", description: "Repair, reuse, recycle and what happens to waste." },
    { id: "bts", name: "Behind the scenes", description: "Building the company: team, pickups, decisions." },
    { id: "impact", name: "Impact stories and campaign updates", description: "Evidence-based updates using verified numbers only." },
  ],
  facts: [
    {
      id: "fact_ecosystem",
      text: "KarmaVerse is a sustainability rewards ecosystem from 3R ZeroWaste.",
      source: "karmaverse.earth (site description)",
      verified: true,
    },
    {
      id: "fact_earn",
      text: "Members earn KarmaCoins for everyday eco-friendly actions, from doorstep recycling pickups to eco-quizzes.",
      source: "karmaverse.earth (site description)",
      verified: true,
    },
    {
      id: "fact_redeem",
      text: "KarmaCoins can be redeemed for rewards.",
      source: "karmaverse.earth (site description)",
      verified: true,
    },
    {
      id: "fact_pickup_steps",
      text: "A doorstep pickup is booked in 2 steps: choose items, then date, time slot and address.",
      source: "Draft Play Store screenshots (not yet approved)",
      verified: false,
    },
    {
      id: "fact_tracking",
      text: "Pickups can be tracked live, from order placed to coins credited after weighing.",
      source: "Draft Play Store screenshots (not yet approved)",
      verified: false,
    },
    {
      id: "fact_quiz",
      text: "The Daily Eco-Quiz has 3 questions a day, 20 seconds each, 10 coins per question.",
      source: "Draft Play Store screenshots (not yet approved)",
      verified: false,
    },
    {
      id: "fact_android",
      text: "The KarmaVerse app is available on Android.",
      source: "Team (chat, 26 Oct 2026)",
      verified: true,
    },
  ],
  hashtags: ["#KarmaVerse", "#MyKarmaCoins", "#SustainableIndia", "#ZeroWasteIndia", "#RecycleIndia"],
  defaultCtas: [
    "Download the KarmaVerse app (link in bio)",
    "Book a doorstep pickup in the app",
    "Take today's eco-quiz in the app",
    "Save this for later",
    "Share this with someone who needs it",
    "Tell us in the comments",
  ],
  avoid: [
    "guaranteed rewards or earnings",
    "carbon-neutral or net-zero claims without evidence",
    "invented statistics",
    "guilt-tripping or doom language",
  ],
  platforms: ["instagram", "youtube", "linkedin", "facebook"],
  accountKey: "KARMAVERSE",
  // Set in Settings (the team logo is stored at data/brand/brand_karmaverse-logo-full.jpeg).
  logoFile: "",
  tagline: "Earn • Impact • Elevate",
  approvalPolicy: { requireReview: true, approvers: [], replyApprovers: [] },
  trendNotes: [],
  instructions: [],
  goals: [],
};
