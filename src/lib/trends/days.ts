/**
 * Climate and sustainability days with fixed dates (UN and Indian observances),
 * each with a post angle for a climate-action brand. Events whose dates change
 * every year (COP, festivals) are left out; add those as trend notes.
 */

export interface ClimateDay {
  /** "MM-DD", or a rule for days that move: "last-sat-03" (last Saturday of March), "3rd-sat-09". */
  when: string;
  name: string;
  why: string;
  angle: string;
  /** Pillar words this day fits best (matched against the brand's pillar names). */
  fits: string[];
}

export const CLIMATE_DAYS: ClimateDay[] = [
  { when: "02-02", name: "World Wetlands Day", why: "Wetlands store carbon and protect against floods.", angle: "One everyday habit that keeps waste out of lakes and drains, and how members earn for it", fits: ["habits", "edu"] },
  { when: "03-03", name: "World Wildlife Day", why: "Plastic waste harms wildlife on land and in water.", angle: "Myth or fact: what happens to the plastic we throw away (with a sourced fact)", fits: ["myth", "circular"] },
  { when: "03-18", name: "Global Recycling Day", why: "Recycling is the brand's core action.", angle: "A swipe-through guide: what can and can't be recycled at home", fits: ["circular", "habits"] },
  { when: "03-21", name: "International Day of Forests", why: "Recycled paper saves trees.", angle: "How much paper a household throws away in a month, and the easy swap", fits: ["habits", "edu"] },
  { when: "03-22", name: "World Water Day", why: "Clean water and less waste go together.", angle: "Three water-saving habits, as a quiz", fits: ["habits", "community"] },
  { when: "03-30", name: "International Day of Zero Waste", why: "The UN day for zero waste: the brand's mission.", angle: "Zero-waste challenge: one week, one bag, earn KarmaCoins for every step", fits: ["community", "circular"] },
  { when: "last-sat-03", name: "Earth Hour", why: "Global lights-off hour; easy community action.", angle: "Invite followers to switch off for an hour and share a photo", fits: ["community", "habits"] },
  { when: "04-22", name: "Earth Day", why: "The biggest climate day of the year for social media.", angle: "Earth Day pledge carousel: pick one action, comment it, earn for doing it", fits: ["community", "impact"] },
  { when: "05-22", name: "International Day for Biological Diversity", why: "Biodiversity loss is linked to waste and pollution.", angle: "Myth vs fact on biodiversity and plastic (sourced)", fits: ["myth", "edu"] },
  { when: "06-03", name: "World Bicycle Day", why: "Cycling cuts transport emissions.", angle: "Cycle-to-work challenge: share your ride, earn KarmaCoins", fits: ["community", "habits"] },
  { when: "06-05", name: "World Environment Day", why: "UN's main environment day; huge reach in India.", angle: "Announce a community challenge for the week and show the app's daily quiz", fits: ["community", "product", "impact"] },
  { when: "06-08", name: "World Oceans Day", why: "Most ocean plastic starts on land.", angle: "How one recycled bottle stays out of the sea: a short explainer", fits: ["edu", "circular"] },
  { when: "06-17", name: "Desertification and Drought Day", why: "Land and soil health.", angle: "Composting at home in three steps", fits: ["habits", "edu"] },
  { when: "07-01", name: "Plastic Free July (starts)", why: "A month-long global plastic-free challenge.", angle: "31-day plastic-free challenge with a daily tip and quiz", fits: ["community", "habits"] },
  { when: "07-03", name: "International Plastic Bag Free Day", why: "Single-use bags are an easy swap.", angle: "Poll: how many plastic bags came home with you this week?", fits: ["habits", "community"] },
  { when: "07-28", name: "World Nature Conservation Day", why: "Conservation starts with daily choices.", angle: "Five small daily actions, each worth KarmaCoins", fits: ["habits", "product"] },
  { when: "09-07", name: "International Day of Clean Air for blue skies", why: "Air quality matters to every Indian city.", angle: "How burning waste affects air quality, and what to do instead (sourced)", fits: ["myth", "edu"] },
  { when: "3rd-sat-09", name: "World Cleanup Day", why: "Global volunteer cleanup day.", angle: "Organise or join a neighbourhood cleanup; share before/after photos", fits: ["community", "impact"] },
  { when: "09-16", name: "World Ozone Day", why: "A climate success story.", angle: "Climate action works: the ozone layer story in one carousel", fits: ["edu", "myth"] },
  { when: "09-29", name: "International Day of Awareness of Food Loss and Waste", why: "Food waste is a big source of methane.", angle: "Quiz: which food is wasted most at home?", fits: ["habits", "edu"] },
  { when: "10-02", name: "Gandhi Jayanti / Swachh Bharat Diwas", why: "India's cleanliness day.", angle: "Swachhta starts at home: segregation in 3 bins", fits: ["habits", "community"] },
  { when: "10-14", name: "International E-Waste Day", why: "Old phones and chargers need proper recycling.", angle: "What to do with old phones and chargers", fits: ["circular", "edu"] },
  { when: "10-16", name: "World Food Day", why: "Food waste and climate.", angle: "Leftover makeover: one tip, one quiz question", fits: ["habits"] },
  { when: "10-24", name: "International Day of Climate Action", why: "A day about everyday climate action.", angle: "Small actions add up: show the community's combined actions (verified numbers only)", fits: ["impact", "community"] },
  { when: "10-31", name: "World Cities Day", why: "Cities produce most waste and emissions.", angle: "What a cleaner city needs from each household, as a carousel", fits: ["circular", "community"] },
  { when: "12-02", name: "National Pollution Control Day (India)", why: "India's pollution awareness day.", angle: "Myth vs fact on everyday pollution (sourced)", fits: ["myth", "edu"] },
  { when: "12-05", name: "World Soil Day", why: "Composting returns nutrients to soil.", angle: "Composting quiz: what can and can't go in?", fits: ["habits", "edu"] },
  { when: "12-14", name: "National Energy Conservation Day (India)", why: "Saving energy at home.", angle: "Five energy-saving habits worth KarmaCoins", fits: ["habits", "product"] },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** The date of a day in a given year, as YYYY-MM-DD. */
export function dayDate(when: string, year: number): string {
  const rule = when.match(/^(last|1st|2nd|3rd|4th)-sat-(\d{2})$/);
  if (!rule) return `${year}-${when}`;
  const month = Number(rule[2]);
  if (rule[1] === "last") {
    const last = new Date(Date.UTC(year, month, 0));
    last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() + 1) % 7));
    return `${year}-${pad(month)}-${pad(last.getUTCDate())}`;
  }
  const nth = Number(rule[1]![0]);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstSat = 1 + ((6 - first.getUTCDay() + 7) % 7);
  return `${year}-${pad(month)}-${pad(firstSat + (nth - 1) * 7)}`;
}

/** Days falling within `days` days after `today` (YYYY-MM-DD), soonest first. */
export function upcomingDays(today: string, days: number): Array<ClimateDay & { date: string; inDays: number }> {
  const t = Date.parse(`${today}T00:00:00Z`);
  const year = Number(today.slice(0, 4));
  const out: Array<ClimateDay & { date: string; inDays: number }> = [];
  for (const d of CLIMATE_DAYS) {
    for (const y of [year, year + 1]) {
      const date = dayDate(d.when, y);
      const inDays = Math.round((Date.parse(`${date}T00:00:00Z`) - t) / 86_400_000);
      if (inDays >= 0 && inDays <= days) out.push({ ...d, date, inDays });
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}
