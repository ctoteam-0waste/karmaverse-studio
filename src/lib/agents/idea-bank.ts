/**
 * Starter idea bank used by the free Template mode.
 *
 * Tuned for sustainability brands (the initial KarmaVerse configuration).
 * For brands in other categories, use Manual or Claude API mode, or add a bank here.
 * Ideas never contain statistics; anything that needs a number says [CONFIRM: ...].
 */

export type PillarKind = "habits" | "myths" | "edu" | "community" | "product" | "circular" | "bts" | "impact";

export interface IdeaTemplate {
  title: string;
  angle: string;
  question: string;
  relevance: number;
  impact: number;
  effort: number;
}

export const IDEA_BANK: Record<PillarKind, IdeaTemplate[]> = {
  habits: [
    { title: "3 swaps for a lower-waste morning routine", angle: "Show the before/after of one ordinary morning", question: "Where do I even start with sustainable living?", relevance: 5, impact: 4, effort: 2 },
    { title: "The 10-second habit that keeps recyclables clean", angle: "Rinse-and-dry demo at the kitchen sink", question: "Why does my recycling get rejected?", relevance: 5, impact: 4, effort: 1 },
    { title: "Hostel and PG room: 5 easy sustainable habits", angle: "Made for students living away from home", question: "Can I be sustainable on a student budget?", relevance: 4, impact: 4, effort: 2 },
    { title: "What to keep in your bag to skip single-use plastic", angle: "Flat-lay of a real daily bag", question: "How do I avoid plastic when I'm out all day?", relevance: 4, impact: 3, effort: 1 },
  ],
  myths: [
    { title: "Myth or fact: all plastic with a recycling symbol gets recycled", angle: "Explain resin codes simply; cite a public source", question: "Does the recycling symbol mean it will be recycled?", relevance: 5, impact: 5, effort: 2 },
    { title: "Myth: one person's actions don't matter", angle: "Collective action framed without guilt", question: "Does my effort actually make a difference?", relevance: 4, impact: 4, effort: 2 },
    { title: "Myth or fact: e-waste is safe in the regular dustbin", angle: "Why old chargers and batteries need separate handling", question: "What do I do with dead chargers and batteries?", relevance: 5, impact: 5, effort: 2 },
    { title: "3 sustainability myths Indian families still believe", angle: "Quick-fire myth busting, one per slide", question: "Which green habits are actually worth it?", relevance: 4, impact: 4, effort: 2 },
  ],
  edu: [
    { title: "Wet vs dry waste explained in 30 seconds", angle: "Two bins, ten household items, sort them live", question: "How do I segregate waste properly at home?", relevance: 5, impact: 4, effort: 1 },
    { title: "What 'circular economy' means, using a phone as the example", angle: "Follow one phone from purchase to recycling", question: "What does circular economy actually mean?", relevance: 4, impact: 3, effort: 3 },
    { title: "Composting 101 for apartments", angle: "Small-space setup that doesn't smell", question: "Can I compost if I live in a flat?", relevance: 4, impact: 4, effort: 3 },
    { title: "Why e-waste needs special recycling", angle: "What's inside a gadget, explained simply", question: "Why can't e-waste go with normal trash?", relevance: 5, impact: 4, effort: 2 },
  ],
  community: [
    { title: "7-day zero-waste challenge: daily tasks", angle: "One small task a day; followers post in Stories", question: "How can I build the habit with others?", relevance: 5, impact: 5, effort: 2 },
    { title: "Society vs society: recycling leaderboard", angle: "Friendly competition between housing societies", question: "How can my society get involved?", relevance: 5, impact: 5, effort: 3 },
    { title: "Member spotlight: one family's sustainable switch (with consent)", angle: "Real member, their words, verified details only", question: "Do real people actually do this?", relevance: 4, impact: 5, effort: 3 },
    { title: "Ask the community: your best reuse hack", angle: "Comment prompt; feature the best answers next week", question: "What reuse ideas actually work?", relevance: 4, impact: 4, effort: 1 },
  ],
  product: [
    { title: "How to book a doorstep pickup in the app", angle: "Screen-recording walkthrough, start to finish", question: "How does the pickup work?", relevance: 5, impact: 4, effort: 1 },
    { title: "Your first week on {brand}: what to try", angle: "Three actions to try in week one", question: "I just downloaded the app — now what?", relevance: 5, impact: 4, effort: 2 },
    { title: "Where your coins come from and how to redeem them", angle: "Wallet walkthrough; no reward amounts unless confirmed", question: "How do rewards work?", relevance: 5, impact: 4, effort: 1 },
    { title: "The daily eco-quiz: try today's question", angle: "Show one question; answer in comments", question: "What is the eco-quiz?", relevance: 4, impact: 4, effort: 1 },
  ],
  circular: [
    { title: "Repair before replace: 4 things worth fixing", angle: "Local repair shops and simple DIY fixes", question: "Is it worth repairing old stuff?", relevance: 4, impact: 4, effort: 2 },
    { title: "What happens to your waste after pickup", angle: "Follow the journey from doorstep to recycler", question: "Where does my recycling actually go?", relevance: 5, impact: 5, effort: 3 },
    { title: "Buy less, choose better: a 30-second checklist before buying", angle: "Pause-before-purchase checklist", question: "How do I shop more responsibly?", relevance: 4, impact: 3, effort: 1 },
    { title: "Festival season without the waste pile", angle: "Gifting, packaging and decor that can be reused", question: "How do I celebrate festivals sustainably?", relevance: 5, impact: 4, effort: 2 },
  ],
  bts: [
    { title: "A day with the pickup team", angle: "Real footage, team in their own words", question: "Who are the people behind this?", relevance: 4, impact: 4, effort: 3 },
    { title: "Why we started {brand}", angle: "Founder story in 60 seconds", question: "Why should I trust this brand?", relevance: 4, impact: 4, effort: 2 },
    { title: "A product decision we changed after your feedback", angle: "Show the before/after and credit the community", question: "Does the team listen to users?", relevance: 4, impact: 4, effort: 2 },
    { title: "Building in public: this month's wins and misses", angle: "Honest monthly update", question: "How is the company doing?", relevance: 3, impact: 3, effort: 2 },
  ],
  impact: [
    { title: "This month's community impact update", angle: "Only verified numbers: [CONFIRM: kg collected, members, pickups]", question: "What difference is the community making?", relevance: 4, impact: 4, effort: 2 },
    { title: "Campaign update: progress so far", angle: "Progress against a stated goal with verified figures", question: "How is the campaign going?", relevance: 4, impact: 4, effort: 2 },
    { title: "Partner story: what we did together", angle: "Only with partner approval; no logos until cleared", question: "Who does {brand} work with?", relevance: 3, impact: 4, effort: 3 },
    { title: "How we measure impact (and what we don't count)", angle: "Transparent methodology builds credibility", question: "Are these impact numbers real?", relevance: 4, impact: 3, effort: 2 },
  ],
};

const KEYWORDS: Array<[PillarKind, RegExp]> = [
  ["myths", /myth|fact/i],
  ["habits", /habit|swap|routine/i],
  ["community", /community|challenge|user|story|member/i],
  ["product", /product|demo|app|feature/i],
  ["circular", /circular|consumption|reuse|repair/i],
  ["bts", /behind|team|company|building/i],
  ["impact", /impact|campaign|update|evidence/i],
  ["edu", /educat|explain|learn|video/i],
];

export function pillarKind(pillar: { id: string; name: string }): PillarKind {
  const direct: Record<string, PillarKind> = {
    habits: "habits",
    myths: "myths",
    "edu-shorts": "edu",
    community: "community",
    product: "product",
    circular: "circular",
    bts: "bts",
    impact: "impact",
  };
  if (direct[pillar.id]) return direct[pillar.id]!;
  for (const [kind, re] of KEYWORDS) if (re.test(pillar.name) || re.test(pillar.id)) return kind;
  return "edu";
}
