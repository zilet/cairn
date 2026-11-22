// WHY each food guide is the number it is, and what the nutrient does for the goal in
// force. Pure words over the figures repo/fuel-guides.ts already derived: nothing here
// reads the database or decides a number, so a guide and its explanation can never
// disagree. Three parts, each one or two plain sentences the Intake card prints under
// "Why": `made_of` (the arithmetic, in the athlete's own weight), `effect` (what it does,
// shaped by the goal mode and the day's work) and `source` (the published basis by name).
//
// The published figures quoted here, each checked against its primary source:
//   - carbohydrate by training load, 3-5 / 5-7 / 6-10 g per kg a day, and 30-60 g an hour
//     during exercise of 1-2.5 h; fat 20-35% of energy: Thomas, Erdman & Burke, "Nutrition
//     and Athletic Performance" (ACSM / AND / DC joint position), Med Sci Sports Exerc
//     2016;48(3):543-568;
//   - protein: gains level off near 1.6 g per kg a day of total intake (break point 1.62,
//     interval 1.03-2.20): Morton et al., Br J Sports Med 2018;52(6):376-384. In a deficit,
//     2.3-3.1 g per kg of FAT-FREE mass for lean resistance-trained people: Helms, Zinn,
//     Rowlands & Brown, Int J Sport Nutr Exerc Metab 2014;24(2):127-138. The ISSN position
//     stand (Jäger et al., J Int Soc Sports Nutr 2017;14:20) gives 1.4-2.0 g per kg of body
//     weight for most exercising people and 2.3-3.1 g per kg a day in hypocaloric periods.
//     About four meals: Schoenfeld & Aragon, J Int Soc Sports Nutr 2018;15:10;
//   - rate of loss: about 0.5-1% of body weight a week (Helms, Aragon & Fitschen, J Int
//     Soc Sports Nutr 2014;11:20). Of two target rates, 0.7% and 1.4% a week, the slower
//     group GAINED lean mass and the faster one's was unchanged, all while lifting (Garthe
//     et al., Int J Sport Nutr Exerc Metab 2011;21(2):97-104) — so the words never say a
//     faster pace loses muscle, only that the slower one did better;
//   - low-fat diets lowered testosterone in men across six intervention studies, a small
//     base: Whittaker & Wu, J Steroid Biochem Mol Biol 2021;210:105878. The 0.5 g per kg
//     figure is the FALLBACK minimum of a narrative review whose first recommendation is
//     20-30% of energy: Ruiz-Castellano et al., Nutrients 2021;13(9):3255;
//   - fiber 14 g per 1,000 kcal (Dietary Guidelines for Americans 2020-2025); 25-29 g a
//     day and above: Reynolds et al., Lancet 2019;393(10170):434-445;
//   - saturated fat under 10% of energy (DGA 2020-2025), 5-6% to lower LDL (Eckel et al.,
//     2013 AHA/ACC lifestyle guideline, Circulation 2014;129(25 Suppl 2):S76-99);
//   - seafood 1-2 meals a week: Rimm et al., AHA science advisory, Circulation 2018;
//     138(1):e35-e47.
// Every string holds the reading grammar (no score, no gate, no engineering words).
import { LB_PER_KG } from "./display-words.js";
import type { CarbTier } from "./fuel-demand.js";

export interface FuelWhy {
  /** Where the eaten grams came from, off the athlete's own log (set by fuel-guides.ts). */
  from?: string;
  made_of: string;
  effect: string;
  source: string;
}

export type FuelWhyKey = "energy" | "protein" | "carbs" | "fat" | "fiber" | "saturated_fat" | "omega_3";

/** Loss a week, as a share of body weight, that studies of trained people find keeps lean mass. */
export const LEAN_SAFE_LOSS_SHARE = { low: 0.005, high: 0.01 } as const;
/** Where gains in lean mass level off when energy is not short, g per kg a day. */
export const PROTEIN_PLATEAU_G_PER_KG = 1.6;

export interface FuelWhyInput {
  mode: string | null;
  kg: number | null;
  /** "153 lb" / "69 kg", in the athlete's unit. */
  weight_words: string | null;
  weight_unit: "lb" | "kg";
  kcal: number | null;
  protein_g: number | null;
  /** True when the kcal target is one the athlete set or accepted. */
  own_target: boolean;
  carbs: {
    tier: CarbTier;
    band: { low: number; high: number };
    within_target: boolean;
    high_g: number;
    yours: boolean;
  } | null;
  fat: { low_g: number; yours: boolean; share_low_g: number | null; share_high_g: number | null } | null;
  fiber: { per_kcal: boolean; lab_led: boolean };
  saturated_fat: { lipid: boolean } | null;
}

const g5 = (n: number) => Math.round(n / 5) * 5;
const one = (n: number) => (Math.round(n * 10) / 10).toString();
const SAME_ENERGY = "Fat loss follows the day's energy, whichever of carbs or fat it comes from.";

const TIER_THIRD: Record<CarbTier, string> = { light: "bottom", moderate: "middle", high: "top" };
const TIER_DAY: Record<CarbTier, string> = {
  light: "a lighter day",
  moderate: "a day with about an hour of training",
  high: "a day of long or hard endurance work",
};

function energyWhy(i: FuelWhyInput): FuelWhy | null {
  if (!i.kcal) return null;
  const lose = i.mode === "lose";
  const base = `${i.own_target ? "Your own number is the week's average" : "The week's average is worked out from your weight, your activity and your goal"}; each day's number moves around it with the planned work, by about half of what that work costs.`;
  let pace = "";
  if (lose && i.kg) {
    const perKgUnit = i.weight_unit === "lb" ? LB_PER_KG : 1;
    const low = one(i.kg * perKgUnit * LEAN_SAFE_LOSS_SHARE.low);
    const high = one(i.kg * perKgUnit * LEAN_SAFE_LOSS_SHARE.high);
    pace = ` About 0.5–1% of body weight a week is the pace recommended for keeping muscle while cutting; at ${i.weight_words} that is ${low}–${high} ${i.weight_unit} a week.`;
  }
  const effect = lose
    ? "A cut runs on the week's average, so a long-run day can hold more and a rest day less without changing the pace of the loss. Eating well under it speeds the loss and leaves less fuel for training. In the one trial that compared two paces, the slower group gained lean mass and the faster one did not."
    : i.mode === "gain"
      ? "A small surplus is what lets training turn into muscle. A large one mostly adds fat."
      : "Eating at about what you burn gives training its full fuel and holds your weight where it is.";
  const cost = "Running costs about 1 kcal per kg per km (Margaria 1963).";
  return { made_of: base + pace, effect, source: lose ? `Garthe 2011; Helms, Aragon and Fitschen 2014. ${cost}` : cost };
}

function proteinWhy(i: FuelWhyInput): FuelWhy | null {
  if (!i.protein_g) return null;
  const made =
    i.kg && i.weight_words
      ? `${Math.round(i.protein_g)} g is ${one(i.protein_g / i.kg)} g per kg at ${i.weight_words}.`
      : "Your protein number.";
  const effect =
    i.mode === "lose"
      ? "In a cut, protein and lifting together are what keep muscle while the fat goes, and protein is the most filling part of a meal. Spread over about four meals is the usual advice."
      : "Protein is the material training turns into muscle. Past about 1.6 g per kg a day, more adds little while energy is plentiful.";
  const source =
    i.mode === "lose"
      ? "Helms 2014: 2.3–3.1 g per kg of lean mass for lean lifters while cutting. ISSN position stand 2017: 1.4–2.0 g per kg of body weight for most training people, more in a deficit. Morton 2018: gains level off near 1.6 g per kg when energy is not short."
      : "Morton 2018; ISSN position stand 2017.";
  return { made_of: made, effect, source };
}

function carbsWhy(i: FuelWhyInput): FuelWhy | null {
  const c = i.carbs;
  if (!c) return null;
  const band = `${c.band.low}–${c.band.high} g per kg`;
  const grams = i.kg ? `${g5(c.band.low * i.kg)}–${g5(c.band.high * i.kg)} g at ${i.weight_words}` : "";
  const published = `The sports-nutrition range for ${TIER_DAY[c.tier]} is ${band}${grams ? `, ${grams}` : ""}.`;
  let made = published;
  if (c.yours) made = `Your own number. ${published}`;
  else if (c.within_target) {
    const under = i.kg != null && c.high_g < c.band.low * i.kg;
    made = under
      ? `${published} Your target holds less than that${i.mode === "lose" ? " while you cut" : ""}, so this is the ${TIER_THIRD[c.tier]} third of what it has room for once protein and the fat floor are in.`
      : `${published} This is the ${TIER_THIRD[c.tier]} third of what your target has room for once protein and the fat floor are in.`;
  }
  const effect =
    c.tier === "high"
      ? `Carbs are what long and hard running burns. They refill the muscles' glycogen, and a run past an hour goes better with 30–60 g an hour during it. ${SAME_ENERGY}`
      : c.tier === "moderate"
        ? `Carbs fuel the hardest sets and refill the muscle afterwards. ${SAME_ENERGY}`
        : "A lighter day burns less glycogen, so it asks for fewer carbs. The room goes to fat and vegetables.";
  return { made_of: made, effect, source: "ACSM, Academy of Nutrition and Dietetics and Dietitians of Canada, Nutrition and Athletic Performance, 2016." };
}

function fatWhy(i: FuelWhyInput): FuelWhy | null {
  const f = i.fat;
  if (!f) return null;
  let made = "Your own number.";
  if (!f.yours) {
    const share =
      f.share_low_g != null && f.share_high_g != null
        ? `A fifth to a third of today's energy is ${Math.round(f.share_low_g)}–${Math.round(f.share_high_g)} g`
        : "A fifth to a third of the day's energy";
    const floor = i.kg ? `, with a fallback minimum of half a gram per kg (${Math.round(i.kg * 0.5)} g at ${i.weight_words})` : "";
    made = `${share}${floor}. The top of the range leaves room for the day's carbs.`;
  }
  return {
    made_of: made,
    effect:
      "Fat is not one thing. Unsaturated fat (olive oil, avocado, nuts) and the omega-3s in oily fish are the kinds to favour: in place of saturated fat they lower LDL cholesterol. Saturated fat (butter, cheese, fatty meat, coconut) is the one with a ceiling of its own. All of it carries vitamins A, D, E and K and is raw material for hormones, and diets held under a fifth of energy lowered testosterone in men in a small set of trials.",
    source: "ACSM joint position 2016; AHA/ACC lifestyle guideline 2013; Whittaker and Wu 2021; Ruiz-Castellano 2021.",
  };
}

function fiberWhy(i: FuelWhyInput): FuelWhy {
  return {
    made_of: i.fiber.per_kcal ? "14 g for each 1,000 kcal of your target." : "14 g for each 1,000 kcal of your target, and never under 30 g.",
    effect: `Fiber keeps a meal filling, feeds the gut, and the soluble kind (oats, beans, psyllium) lowers LDL cholesterol.${i.fiber.lab_led ? " Your labs are why it is marked here." : ""}`,
    source: "Dietary Guidelines for Americans 2020–2025; Reynolds 2019.",
  };
}

function saturatedWhy(i: FuelWhyInput): FuelWhy | null {
  if (!i.saturated_fat) return null;
  return {
    made_of: i.saturated_fat.lipid
      ? "6% of today's energy, the level heart guidelines use when LDL or ApoB is worth lowering. The general ceiling is 10% of energy."
      : "A tenth of today's energy.",
    effect:
      "Saturated fat raises LDL and ApoB in most people. Swapping it for unsaturated fat (olive oil, nuts, fish) lowers them. Swapping it for sugar does not.",
    source: "AHA/ACC lifestyle guideline 2013; Dietary Guidelines for Americans 2020–2025.",
  };
}

const OMEGA_WHY: FuelWhy = {
  made_of: "One to two servings of oily fish a week, counted here as days with an omega-3 food.",
  effect:
    "EPA and DHA, the omega-3s in oily fish, are the ones tied to heart health. Plant sources such as flax and walnuts convert to them poorly.",
  source: "American Heart Association science advisory, 2018.",
};

/** Every explanation the day can give; a part with nothing to stand on is absent. */
export function fuelGuideWhys(input: FuelWhyInput): Partial<Record<FuelWhyKey, FuelWhy>> {
  const out: Partial<Record<FuelWhyKey, FuelWhy>> = {};
  const put = (key: FuelWhyKey, why: FuelWhy | null) => {
    if (why) out[key] = why;
  };
  put("energy", energyWhy(input));
  put("protein", proteinWhy(input));
  put("carbs", carbsWhy(input));
  put("fat", fatWhy(input));
  put("fiber", fiberWhy(input));
  put("saturated_fat", saturatedWhy(input));
  put("omega_3", OMEGA_WHY);
  return out;
}
