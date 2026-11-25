import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The video cast. Earth Buddy is the brand mascot (a photo whose mouth is stretched);
 * the others are drawn by scripts/video/characters.py with three mouth frames each
 * (data/brand/characters/<id>-0|1|2.png), so they lip-sync too.
 *
 * Each character has its own voice (edge-tts Indian English voices, pitched for age)
 * and a persona the script writer follows, so a video sounds like that character.
 */
export interface Character {
  id: string;
  name: string;
  emoji: string;
  /** One line for people choosing in the app. */
  about: string;
  /** How the script writer should make this character talk. */
  persona: string;
  voice: string;
  rate: string;
  pitch: string;
}

export const CHARACTERS = [
  {
    id: "earth-buddy",
    name: "Earth Buddy",
    emoji: "🌍",
    about: "The KarmaVerse mascot: a cheerful globe in a green hoodie.",
    persona: "Earth Buddy, the planet itself as a cheerful friend: upbeat, encouraging, speaks for the Earth (\"I feel cooler when you...\").",
    voice: "en-IN-NeerjaExpressiveNeural",
    rate: "+4%",
    pitch: "+12Hz",
  },
  {
    id: "chhotu",
    name: "Chhotu",
    emoji: "👦",
    about: "A curious 9-year-old boy who asks the questions kids ask.",
    persona: "Chhotu, a curious, cheeky 9-year-old boy: asks 'why?', is amazed by facts ('Whoa!'), short excited sentences, a little mischief.",
    voice: "en-IN-PrabhatNeural",
    rate: "+10%",
    pitch: "+45Hz",
  },
  {
    id: "pinky",
    name: "Pinky",
    emoji: "👧",
    about: "A smart, bossy-in-a-cute-way girl who loves challenges.",
    persona: "Pinky, a smart 10-year-old girl who loves challenges and keeping score: confident, playful dares ('Bet you can't...'), counts things.",
    voice: "en-IN-NeerjaExpressiveNeural",
    rate: "+10%",
    pitch: "+40Hz",
  },
  {
    id: "didi",
    name: "Eco Didi",
    emoji: "👩",
    about: "A young eco-hero big sister with practical, no-nonsense tips.",
    persona: "Eco Didi, a confident young woman and big-sister figure: practical, warm, a little witty, gives real how-to steps and busts excuses.",
    voice: "en-IN-NeerjaExpressiveNeural",
    rate: "+2%",
    pitch: "+0Hz",
  },
  {
    id: "dadi",
    name: "Dadi",
    emoji: "👵",
    about: "A wise, funny grandmother with old-school reuse hacks.",
    persona: "Dadi, a loving, funny grandmother: compares 'our days' with today, old-school reuse hacks that are smart again, gentle teasing ('beta'), proverbs.",
    voice: "en-IN-NeerjaNeural",
    rate: "-6%",
    pitch: "-16Hz",
  },
  {
    id: "binny",
    name: "Binny the Bin",
    emoji: "♻️",
    about: "A talking recycling bin who knows what goes where.",
    persona: "Binny, a talking green recycling bin: dramatic and funny about what people throw in it ('Not a banana peel, please!'), loves clean dry waste.",
    voice: "en-IN-PrabhatNeural",
    rate: "+6%",
    pitch: "+18Hz",
  },
  {
    id: "taru",
    name: "Taru the Tree",
    emoji: "🌳",
    about: "A calm old neem tree who explains the bigger picture.",
    persona: "Taru, a calm old neem tree: slow, kind, a little poetic, explains the bigger picture (air, heat, time), ends with a simple ask.",
    voice: "en-IN-PrabhatNeural",
    rate: "-8%",
    pitch: "-22Hz",
  },
] as const satisfies readonly Character[];

export type CharacterId = (typeof CHARACTERS)[number]["id"];
export const CHARACTER_IDS = CHARACTERS.map((c) => c.id) as CharacterId[];

export function characterById(id: string | null | undefined): Character | null {
  return CHARACTERS.find((c) => c.id === id) ?? null;
}

/** Image files for the renderer: the mascot photo, or the three drawn mouth frames. */
export function characterAssets(id: string, dataFile: string, mascotPhoto: string): { mascot: string; frames: string[] } {
  if (id === "earth-buddy") return { mascot: mascotPhoto, frames: [] };
  const dir = path.join(path.dirname(dataFile), "brand", "characters");
  const frames = [0, 1, 2].map((n) => path.join(dir, `${id}-${n}.png`));
  return frames.every((f) => existsSync(f)) ? { mascot: frames[0]!, frames } : { mascot: mascotPhoto, frames: [] };
}

/**
 * Who leads the next video. A chosen character wins; otherwise rotate for variety:
 * avoid the last two leads, and give Earth Buddy (the brand face) about one video in three.
 */
export function pickCharacter(recent: Array<string | undefined>, wanted?: string | null, rand: () => number = Math.random): CharacterId {
  if (wanted && CHARACTER_IDS.includes(wanted as CharacterId)) return wanted as CharacterId;
  const last = recent.filter(Boolean).slice(-2) as string[];
  const sinceBuddy = [...recent].reverse().findIndex((c) => c === "earth-buddy");
  if (sinceBuddy === -1 ? recent.length >= 2 : sinceBuddy >= 2) return "earth-buddy";
  const pool = CHARACTER_IDS.filter((c) => c !== "earth-buddy" && !last.includes(c));
  return pool[Math.floor(rand() * pool.length)] ?? "earth-buddy";
}

/** The line added to the script writer's prompt so the script suits the character. */
export function characterBrief(id: string): string {
  const c = characterById(id) ?? CHARACTERS[0];
  return `HOST: this video is presented by ${c.persona} Write every spoken line in this character's voice and personality (the character talks to camera; keep the facts and rules the same). Keep the brand CTA at the end.`;
}
