// ---------- fuel ideas: three meal ideas for the rest of today ----------
//
// Meal plans stopped drafting on a schedule; what replaces them is ideas on demand.
// This is the deterministic floor of that: up to three ideas built from what the
// athlete actually eats again and again, each sized as ONE MEAL of the rest of today,
// protein first, inside the observed intake band (intake-band.ts).
//
// THE RULES:
//   - An idea is never a plan and never eaten. It carries a `prefill` for the
//     composer's "Start from this"; nothing is logged until the person logs it.
//   - A STAPLE REPEATS. A whole meal counts only once it is logged on at least
//     FUEL_STAPLE_MIN_DAYS different days; being eaten near this hour is a tie-break,
//     never a way round that (it used to be, and one-off dinners came back as
//     "staples"). The athlete's recurring COMPONENTS — ingredient rows logged on
//     enough days — also build ideas: a protein food they keep coming back to, with
//     the sides they keep eating it with, in their own food words.
//   - AN IDEA IS ONE MEAL. The room left (protein owed, energy under the bound) is
//     shared across the meals plausibly still ahead today (`mealWindowsAhead`, the
//     shared meal windows): about three on a morning with nothing logged, one in the
//     evening. A portion is NEVER sized up to fill room; it is sized DOWN (a smaller
//     or a half portion) when the usual portion runs past this meal's share, and no
//     single idea carries more than half the day's protein anchor.
//   - PROTEIN FIRST. Ideas rank by how much of this meal's protein share they cover.
//     A portion shrinks to fit the energy share ONLY when the smaller portion still
//     covers this meal's protein share — an idea never trades owed protein away to
//     fit. When the protein-carrying portion does not fit, it is offered anyway and
//     says so.
//   - The band bounds energy only, and only when there IS a band the ideas can lean
//     on: with no band — or a band too loose to size inside (mixed weeks, or low
//     confidence) — the ideas make no energy claim.
//   - DURING A CUT the room is not the no-gain ceiling (that is observed maintenance,
//     and filling it would quietly undo the cut the athlete chose). A 'lose' goal
//     bounds the room by the lowest of: the ceiling, the band's loss edge (the most
//     eaten in a week the weight still came down — the athlete's own evidence), and a
//     target the athlete set or accepted (never the formula's guess).
//   - NEVER ALCOHOL. An alcohol item is stripped from an idea (title and, where the
//     estimate itemises it, its numbers); a staple that is mostly alcohol is skipped.
//   - NEVER A SUPPLEMENT. A logged supplement (psyllium husk, creatine, fish oil —
//     `supplementFoodKind`, supplements.ts) is never a component or a side, and is
//     stripped from a whole meal's words and numbers the same way alcohol is. Whey /
//     a protein shake is a protein food as well: it may carry an idea, never a side.
//   - Titles are the athlete's words without their parenthetical qualifiers
//     ("Rice (cooked)" → "Rice"); the prefill keeps the amounts.
//   - Active nutrition findings (a lipid or blood-pressure pattern) nudge the ORDER
//     only — an idea whose own estimate is low in saturated fat or sodium, or carries
//     fiber, ranks a little higher. Nothing is excluded and nothing is said about it.
//   - No agent turn. An agent refinement, if one is ever layered on, must never block
//     this response.

import type { ClientFuelEnergyBound, ClientFuelIdea, ClientFuelIdeas, ClientIntakeBand } from "../contracts/fuel.js";
import { db } from "../db.js";
import { intakeBand } from "./intake-band.js";
import { dayIntakeCoverage, dayIntakeTarget, frequentFoodKey, frequentFoods, getDayIntake } from "./nutrition.js";
import { dayEnergyTarget } from "./day-energy.js";
import { nutritionRelevantDirectives } from "./nutrition-progress.js";
import { computeGoalCheck } from "./profile.js";
import { supplementFoodKind } from "./supplements.js";
import { addDaysISO, clipText, joinList, localDateISO, localHourFraction, mealWindowsAhead } from "./shared.js";

export const FUEL_IDEAS_COUNT = 3;
export const FUEL_STAPLE_WINDOW_DAYS = 90;
// A staple repeats: one logged day is an event, two is a habit worth building on.
export const FUEL_STAPLE_MIN_DAYS = 2;
// Longest idea title; a longer one is cut at a list boundary ("…, and more") or a word.
export const FUEL_IDEA_TITLE_MAX = 60;
// A recurring component leads an idea when its usual amount carries real protein.
const LEAD_MIN_PROTEIN_G = 15;
const LEAD_MIN_PROTEIN_SHARE = 0.25; // of its kcal, from protein
const LEAD_CANDIDATES = 6;
const SIDES_PER_IDEA = 2;
// Portions offered, largest first. Never above the usual: an idea is never sized up.
const PORTIONS = [1, 0.75, 0.5] as const;
const PORTION_WORDS: Record<number, string> = {
  1: "your usual portion",
  0.75: "a smaller portion",
  0.5: "a half portion",
};

export interface FuelStaple {
  key: string;
  title: string;
  /** What "Start from this" drops into the composer (defaults to the title). */
  prefill?: string;
  kcal: number;
  protein_g: number;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g?: number | null;
  /** The estimate's own coarse bands, when it carries them. */
  saturated_fat?: string | null;
  sodium?: string | null;
  times_logged: number;
  last_logged: string | null;
  usual_now: boolean;
  /** "staple" = a whole meal that repeats; "components" = built from recurring items. */
  source?: "staple" | "components";
  /** The food the idea is built around, so two ideas never lead with the same one. */
  lead_key?: string;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// An idea key travels in `?exclude=key,key`, split on commas, and carries "@portion".
const safeKey = (key: string): string => key.replace(/[,@]/g, " ").replace(/\s+/g, " ").trim();
const foodKey = (text: string): string => safeKey(frequentFoodKey(text));
/** A logged row's identity as a card prints it: bracketed qualifiers do not split a food. */
const componentKey = (text: string): string => foodKey(stripQualifiers(text) || text);

// A side named after the lead reads as a phrase: "Chicken breast with asparagus",
// not "…with Asparagus". Proper adjectives and acronyms keep their capital.
const PROPER_FOOD_WORD =
  /^(?:Greek|Icelandic|Italian|French|Thai|Mexican|Swiss|Dijon|Parmesan|Cheddar|Caesar|Cajun|Korean|Japanese|Indian|Chinese|Turkish|Spanish|English|Irish|Polish|Serbian|Brussels|Nordic)\b/;
const sideWord = (text: string): string =>
  /^[A-Z][a-z]/.test(text) && !PROPER_FOOD_WORD.test(text) ? text[0].toLowerCase() + text.slice(1) : text;

// ---- alcohol: never part of an idea ----
// Word-bounded, and not when the word is a cooking use ("red wine vinegar",
// "beer-battered") or a soft drink ("ginger beer", "alcohol-free").
const ALCOHOL_RE =
  /\b(?:wine|beer|lager|ale|ipa|stout|porter|pilsner|cider|spirits?|liquor|liqueur|vodka|whiske?y|bourbon|scotch|gin|rum|tequila|mezcal|brandy|cognac|rakija|rakia|raki|grappa|schnapps|slivovitz|palinka|ouzo|sake|soju|prosecco|champagne|cava|cocktails?|margaritas?|martinis?|negroni|spritz|mojitos?|sangria|mead|alcohol|alcoholic)\b(?![-\s]*(?:vinegar|batter|battered|braised|sauce|reduction|glaze|free|cake|raisin))/i;
const NOT_ALCOHOL_RE = /\b(?:non[-\s]?alcoholic|alcohol[-\s]free|ginger\s+(?:beer|ale)|root\s+beer)\b/i;

export function isAlcoholFood(text: unknown): boolean {
  const s = String(text ?? "");
  return ALCOHOL_RE.test(s) && !NOT_ALCOHOL_RE.test(s);
}

// A meal summary's list parts: "A with B, C, trail mix & D" → ["A with B", "C", "trail mix", "D"].
const listParts = (text: string): string[] =>
  text
    .split(/\s*(?:,|;|\s&\s|\s\+\s)\s*/)
    .map((part) => part.replace(/^(?:and|plus)\s+/i, "").trim())
    .filter(Boolean);

// One list part with any clause the predicate names removed: "steak with red wine" →
// "steak"; "mac and cheese with beer" → "mac and cheese". "" when the whole part goes.
function dropClause(part: string, drop: (text: string) => boolean): string {
  const pieces = part.split(/(\s+(?:with|and|plus)\s+)/i);
  const kept: string[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    if (drop(pieces[i])) continue;
    if (kept.length) kept.push(pieces[i - 1] ?? " and ");
    kept.push(pieces[i]);
  }
  return kept.join("").trim();
}

/**
 * The athlete's own meal words with every alcohol item taken out. PURE. Returns the
 * text unchanged when it names no alcohol, and "" when nothing but alcohol is left.
 */
export function stripAlcohol(text: string): string {
  const s = String(text ?? "").trim();
  if (!isAlcoholFood(s)) return s;
  const parts = listParts(s)
    .map((part) => dropClause(part, isAlcoholFood))
    .filter((part) => part && !isAlcoholFood(part));
  return joinList(parts);
}

export const isSupplementOnly = (text: unknown): boolean => supplementFoodKind(text) === "supplement";

/**
 * The athlete's own meal words with every supplement item taken out (whey and other
 * protein foods stay). PURE. Unchanged when it names none; "" when nothing else is left.
 */
export function stripSupplements(text: string): string {
  const s = String(text ?? "").trim();
  if (!listParts(s).some(isSupplementOnly) && !isSupplementOnly(s)) return s;
  const parts = listParts(s)
    .map((part) => dropClause(part, isSupplementOnly))
    .filter((part) => part && !isSupplementOnly(part));
  return joinList(parts);
}

/** First letter up: a list whose first part was taken out still starts a title. PURE. */
const capFirst = (text: string): string => text.replace(/^\s*\p{Ll}/u, (c) => c.toUpperCase());

/** "Rice (cooked)" → "Rice". PURE. Bracketed qualifiers read as clutter on a card. */
export function stripQualifiers(text: string): string {
  return String(text ?? "")
    .replace(/\s*[([][^()[\]]*[)\]]/g, "")
    .replace(/\s+([,;.])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A card-sized title from the athlete's own words. PURE. Parenthetical qualifiers
 * ("(cooked)") are dropped; short text is otherwise kept as written; a long list is cut at a list boundary and says so ("…, and more"); a
 * single long phrase is cut at a word, never mid-word.
 */
export function capIdeaTitle(text: string, max = FUEL_IDEA_TITLE_MAX): string {
  const raw = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  // A title that is nothing but a qualifier ("(leftovers)") keeps its words.
  const s = stripQualifiers(raw) || capFirst(raw.replace(/^[([]\s*|\s*[)\]]$/g, "").trim());
  if (s.length <= max) return s;
  const parts = listParts(s);
  for (let n = parts.length - 1; n >= 1; n--) {
    const cut = `${parts.slice(0, n).join(", ")}, and more`;
    if (cut.length <= max) return cut;
  }
  return clipText(parts[0] ?? s, max, { wordBoundary: true }).replace(/\s+(?:with|and|of|in|on|plus)…$/i, "…");
}

interface ComponentAcc {
  title: string;
  /** A protein supplement (whey, a shake): it may lead an idea, never be a side. */
  protein_supplement: boolean;
  days: Set<string>;
  last: string | null;
  macros: {
    kcal: number;
    protein_g: number;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
  } | null;
  amount: string | null;
}

interface MealAcc {
  title: string;
  days: Set<string>;
  last: string | null;
  estimate: any | null;
}

/**
 * The athlete's staples. PURE over the food log. Two kinds:
 *   - whole meals logged on at least FUEL_STAPLE_MIN_DAYS distinct days in the window,
 *     each with the numbers of its newest estimate that carries both kcal and protein
 *     (a meal with no known protein cannot be ranked protein-first), alcohol taken out;
 *   - ideas built from recurring COMPONENTS: an ingredient row logged on enough days
 *     that carries real protein, with the (at most two) other recurring items it was
 *     eaten with on enough days.
 * Foods usually eaten near `hour` (frequentFoods) are flagged `usual_now` — a
 * tie-break only; it never makes a one-off meal a staple.
 */
export function fuelStaples(asOf: string = localDateISO(), hour?: number): FuelStaple[] {
  const since = addDaysISO(asOf, -FUEL_STAPLE_WINDOW_DAYS) ?? asOf;
  const rows = db
    .prepare(
      `SELECT id, COALESCE(date, substr(created_at, 1, 10)) AS day, meal, parsed_json
         FROM food_notes
        WHERE COALESCE(date, substr(created_at, 1, 10)) >= ?
          AND COALESCE(date, substr(created_at, 1, 10)) <= ?
        ORDER BY id DESC`
    )
    .all(since, asOf) as any[];
  const meals = new Map<string, MealAcc>();
  const comps = new Map<string, ComponentAcc>();
  // Days two components were eaten in the same meal: pairs.get(a).get(b).
  const pairs = new Map<string, Map<string, Set<string>>>();
  const touch = <T>(map: Map<string, T>, key: string, make: () => T): T => {
    let cur = map.get(key);
    if (!cur) {
      cur = make();
      map.set(key, cur);
    }
    return cur;
  };
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
    } catch {
      parsed = null;
    }
    const day = String(row.day ?? "").slice(0, 10);
    const title = String(parsed?.summary ?? row.meal ?? "").trim();
    const key = title ? foodKey(title) : "";
    if (key) {
      const cur = touch(meals, key, () => ({ title, days: new Set<string>(), last: null, estimate: null }));
      if (day) cur.days.add(day);
      if (!cur.last || day > cur.last) cur.last = day || cur.last;
      const kcal = num(parsed?.kcal);
      // Rows are id-DESC, so the first occurrence carrying both is the newest estimate.
      if (!cur.estimate && kcal != null && kcal > 0 && num(parsed?.protein_g) != null) cur.estimate = parsed;
    }
    const inMeal = new Set<string>();
    for (const ing of Array.isArray(parsed?.ingredients) ? parsed.ingredients : []) {
      const item = String(ing?.item ?? "").trim();
      if (!item || isAlcoholFood(item)) continue;
      const supplement = supplementFoodKind(item);
      if (supplement === "supplement") continue;
      // Grouped on the words a card prints: "Rice (cooked)" and "Rice (white)" are one rice.
      const ck = componentKey(item);
      if (!ck) continue;
      inMeal.add(ck);
      const cur = touch(comps, ck, () => ({
        title: item,
        protein_supplement: supplement === "protein",
        days: new Set<string>(),
        last: null,
        macros: null,
        amount: null,
      }));
      if (day) cur.days.add(day);
      if (!cur.last || day > cur.last) cur.last = day || cur.last;
      const kcal = num(ing?.kcal);
      const protein = num(ing?.protein_g);
      if (!cur.macros && kcal != null && kcal > 0 && protein != null) {
        cur.macros = {
          kcal,
          protein_g: protein,
          carbs_g: num(ing?.carbs_g),
          fat_g: num(ing?.fat_g),
          fiber_g: num(ing?.fiber_g),
        };
        cur.amount = ing?.amount ? String(ing.amount).trim() : null;
      }
    }
    if (day)
      for (const a of inMeal)
        for (const b of inMeal)
          if (a !== b)
            touch(
              touch(pairs, a, () => new Map()),
              b,
              () => new Set<string>()
            ).add(day);
  }

  let usualNow = new Set<string>();
  try {
    usualNow = new Set(frequentFoods(hour).map((f) => foodKey(f.summary)));
  } catch {
    usualNow = new Set();
  }
  const out: FuelStaple[] = [];

  // Whole meals that repeat.
  for (const [key, v] of meals) {
    if (!v.estimate || v.days.size < FUEL_STAPLE_MIN_DAYS) continue;
    const est = v.estimate;
    const rowsOf: any[] = Array.isArray(est.ingredients) ? est.ingredients : [];
    const alcohol = rowsOf.filter((ing) => isAlcoholFood(ing?.item));
    const drinkSum = (k: string) => alcohol.reduce((acc, ing) => acc + (num(ing?.[k]) ?? 0), 0);
    // Supplements leave the idea too: out of the words and out of the numbers.
    const pills = rowsOf.filter((ing) => !isAlcoholFood(ing?.item) && isSupplementOnly(ing?.item));
    const takenOut = (k: string) => drinkSum(k) + pills.reduce((acc, ing) => acc + (num(ing?.[k]) ?? 0), 0);
    let kcal = Number(est.kcal);
    // Mostly alcohol: nothing worth offering once it is taken out.
    if (drinkSum("kcal") * 2 >= kcal) continue;
    const cleaned = capFirst(stripSupplements(stripAlcohol(v.title)));
    if (!cleaned) continue;
    kcal -= takenOut("kcal");
    if (!(kcal > 0)) continue;
    const less = (k: string) => {
      const n = num(est[k]);
      return n == null ? null : Math.max(0, n - takenOut(k));
    };
    const lead = rowsOf
      .filter(
        (ing) => ing?.item && !isAlcoholFood(ing.item) && !isSupplementOnly(ing.item) && num(ing?.protein_g) != null
      )
      .sort((a, b) => Number(b.protein_g) - Number(a.protein_g))[0];
    out.push({
      key,
      title: capIdeaTitle(cleaned),
      prefill: cleaned,
      kcal,
      protein_g: less("protein_g") ?? 0,
      carbs_g: less("carbs_g"),
      fat_g: less("fat_g"),
      fiber_g: less("fiber_g"),
      saturated_fat: est.nutrition_pattern?.saturated_fat ?? null,
      sodium: est.nutrition_pattern?.sodium ?? null,
      times_logged: v.days.size,
      last_logged: v.last,
      usual_now: usualNow.has(key),
      source: "staple",
      lead_key: lead ? componentKey(String(lead.item)) : key,
    });
  }

  // Ideas from recurring components, around a protein food the athlete keeps eating.
  const recurring = new Map([...comps].filter(([, c]) => c.macros && c.days.size >= FUEL_STAPLE_MIN_DAYS));
  const density = (c: ComponentAcc) => (c.macros ? (c.macros.protein_g * 4) / c.macros.kcal : 0);
  const leads = [...recurring]
    .filter(([, c]) => c.macros!.protein_g >= LEAD_MIN_PROTEIN_G && density(c) >= LEAD_MIN_PROTEIN_SHARE)
    .sort(([ak, a], [bk, b]) => b.days.size - a.days.size || density(b) - density(a) || ak.localeCompare(bk))
    .slice(0, LEAD_CANDIDATES);
  for (const [leadKey, lead] of leads) {
    const together = pairs.get(leadKey) ?? new Map<string, Set<string>>();
    const sides = [...recurring]
      .filter(
        ([k, c]) => k !== leadKey && !c.protein_supplement && (together.get(k)?.size ?? 0) >= FUEL_STAPLE_MIN_DAYS
      )
      .sort(
        ([ak, a], [bk, b]) =>
          (together.get(bk)?.size ?? 0) - (together.get(ak)?.size ?? 0) ||
          (b.macros!.fiber_g ?? 0) - (a.macros!.fiber_g ?? 0) ||
          a.macros!.kcal - b.macros!.kcal ||
          ak.localeCompare(bk)
      )
      .slice(0, SIDES_PER_IDEA);
    const parts = [lead, ...sides.map(([, c]) => c)];
    const sum = (k: "kcal" | "protein_g") => parts.reduce((acc, c) => acc + c.macros![k], 0);
    const sumKnown = (k: "carbs_g" | "fat_g" | "fiber_g") =>
      parts.some((c) => c.macros![k] != null) ? parts.reduce((acc, c) => acc + (c.macros![k] ?? 0), 0) : null;
    const title = sides.length ? `${lead.title} with ${joinList(sides.map(([, c]) => sideWord(c.title)))}` : lead.title;
    const times = Math.min(lead.days.size, ...sides.map(([k]) => together.get(k)?.size ?? 0));
    out.push({
      key: `items ${leadKey}`,
      title: capIdeaTitle(title),
      prefill: joinList(
        parts.map((c, i) => {
          const name = stripQualifiers(i ? sideWord(c.title) : c.title) || c.title;
          return c.amount ? `${name} (${c.amount})` : name;
        })
      ),
      kcal: sum("kcal"),
      protein_g: sum("protein_g"),
      carbs_g: sumKnown("carbs_g"),
      fat_g: sumKnown("fat_g"),
      fiber_g: sumKnown("fiber_g"),
      saturated_fat: null,
      sodium: null,
      times_logged: times,
      last_logged: lead.last,
      usual_now: [...usualNow].some((k) => k.includes(leadKey)),
      source: "components",
      lead_key: leadKey,
    });
  }
  return out;
}

interface Sized {
  staple: FuelStaple;
  portion: number;
  kcal: number;
  protein: number;
  covered: number;
  fits: boolean | null;
}

export interface FuelEnergyBound {
  /** The kcal the day's room is measured under; null = no energy claim at all. */
  kcal: number | null;
  kind: ClientFuelEnergyBound | null;
}

// A target the athlete set or accepted, never the formula's guess. `dayIntakeTarget`
// reports every row in nutrition_targets as "accepted"; "user" is the stated spelling.
const STATED_TARGET_SOURCES = new Set(["accepted", "user"]);

/**
 * What today's energy room is measured under (rules in the header). PURE. `target` is
 * `dayIntakeTarget(goal)` — its `mode` says whether this is a cut, its `source` whether
 * the kcal is a target the athlete set or accepted, or only the formula's.
 */
export function fuelEnergyBound(
  band: Pick<ClientIntakeBand, "status" | "band" | "energy_ceiling_kcal" | "confidence">,
  target: { kcal: number; mode: string; source: string } | null
): FuelEnergyBound {
  const none: FuelEnergyBound = { kcal: null, kind: null };
  if (band.status !== "ok" || !band.band || band.energy_ceiling_kcal == null) return none;
  // A loose read sizes nothing: its ceiling may be one noisy week.
  if (band.band.mixed || band.confidence === "low") return none;
  const ceiling = band.energy_ceiling_kcal;
  if (target?.mode !== "lose") return { kcal: ceiling, kind: "observed_ceiling" };
  // Ties go to the cut's own bound, so the words say what actually holds the room.
  const candidates: Array<{ kcal: number; kind: ClientFuelEnergyBound }> = [];
  if (STATED_TARGET_SOURCES.has(target.source) && target.kcal > 0)
    candidates.push({ kcal: target.kcal, kind: "accepted_target" });
  if (band.band.low_is_loss_edge) candidates.push({ kcal: band.band.low_kcal, kind: "loss_edge" });
  candidates.push({ kcal: ceiling, kind: "observed_ceiling" });
  let best = candidates[0];
  for (const c of candidates) if (c.kcal < best.kcal) best = c;
  return { kcal: best.kcal, kind: best.kind };
}

/** One meal's share of the room left today. */
export interface FuelMealShare {
  /** This meal's share of the protein still owed; null when unknown. */
  protein_g: number | null;
  /** This meal's share of the energy room; null = no energy claim. */
  energy_kcal: number | null;
  /** The most protein any one idea may carry (half the day's anchor); null = no anchor. */
  protein_cap_g?: number | null;
}

/**
 * Size one staple as ONE meal (rules in the header). PURE. Never above the usual
 * portion. Largest portion that fits this meal's energy share while still covering
 * its protein share; else the smallest portion that still covers it, marked as not
 * fitting. Null
 * when even a half portion carries more than half the day's protein anchor.
 */
export function sizeFuelIdea(staple: FuelStaple, share: FuelMealShare): Sized | null {
  const at = (portion: number): Sized => {
    const kcal = staple.kcal * portion;
    const protein = staple.protein_g * portion;
    return {
      staple,
      portion,
      kcal,
      protein,
      covered: share.protein_g == null ? protein : Math.min(protein, Math.max(0, share.protein_g)),
      fits: share.energy_kcal == null ? null : kcal <= share.energy_kcal,
    };
  };
  const cap = share.protein_cap_g;
  const options = PORTIONS.map(at).filter((s) => cap == null || s.protein <= cap + 1e-9);
  if (!options.length) return null;
  const owed = share.protein_g != null && share.protein_g > 0 ? Math.min(share.protein_g, options[0].protein) : 0;
  const keeps = (s: Sized) => s.protein >= owed - 1e-9;
  // Largest portion that fits and keeps; else the smallest that still keeps (closest
  // to fitting without giving owed protein away); else the largest under the cap.
  return options.find((s) => s.fits !== false && keeps(s)) ?? [...options].reverse().find(keeps) ?? options[0];
}

const BOUND_WORDS: Record<ClientFuelEnergyBound, { fits: string; past: string }> = {
  observed_ceiling: { fits: "in your observed range", past: "your observed range" },
  loss_edge: {
    fits: "under the intake your weight still came down at",
    past: "the intake your weight still came down at",
  },
  accepted_target: { fits: "under the target you set", past: "the target you set" },
};

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five"];

// The protein anchor is a goal to aim at, not a line to hit: within this many grams
// of it the day reads as "about there" — nothing is still to go, and no idea is sized
// or ranked around the last few grams. The client's Fuel card holds the same rule
// (fuel-today-model.ts).
export const PROTEIN_ABOUT_THERE_G = 10;

interface WhyContext {
  proteinNeed: number | null;
  /** True when protein is short of the anchor but within PROTEIN_ABOUT_THERE_G of it. */
  aboutThere?: boolean;
  energyRoom: number | null;
  mealsAhead: number;
  boundKind: ClientFuelEnergyBound | null;
}

// Whether an idea is a protein food at all. Below this it is never spoken as a step
// toward the protein still owed: a melon or a crumble is offered for what it does
// bring (fiber, fullness for few calories, carbs), never as "0 g toward the 2 g".
const PROTEIN_FOOD_MIN_G = 8;
const PROTEIN_FOOD_MIN_SHARE = 0.2; // of its kcal, from protein, with at least 4 g
const FIBER_NOTE_MIN_G = 3;
// Only a truly light food (a few melon cubes) is "light and filling"; a 70 kcal handful
// of trail mix is spoken by its macro instead.
const LIGHT_IDEA_KCAL = 40;

function isProteinFood(s: Sized): boolean {
  if (s.protein >= PROTEIN_FOOD_MIN_G) return true;
  return s.protein >= 4 && s.kcal > 0 && (s.protein * 4) / s.kcal >= PROTEIN_FOOD_MIN_SHARE;
}

// What a non-protein idea brings, in words: fiber when it is a real source, else
// fullness for few calories, else the macro carrying its energy. Null with no numbers.
function whatItBrings(s: Sized): string | null {
  const fiber = (s.staple.fiber_g ?? 0) * s.portion;
  const carbs = s.staple.carbs_g == null ? null : s.staple.carbs_g * s.portion;
  const fat = s.staple.fat_g == null ? null : s.staple.fat_g * s.portion;
  const light = s.kcal < LIGHT_IDEA_KCAL;
  if (fiber >= FIBER_NOTE_MIN_G)
    return `About ${Math.round(fiber)} g fiber${light ? ", filling for few calories" : ""}`;
  if (light) return "Light and filling for few calories";
  if (carbs == null && fat == null) return null;
  return (carbs ?? 0) * 4 >= (fat ?? 0) * 9
    ? `Mostly carbs, about ${Math.round(carbs ?? 0)} g`
    : `Mostly fat, about ${Math.round(fat ?? 0)} g`;
}

// The spoken reason: what the idea brings toward the day — protein toward what is
// still owed when it IS a protein food, otherwise what it does bring and that it is
// not one — then the idea as ONE meal of the day. The day's whole room is never
// quoted as if this meal should use it; every number carries its unit; no score.
function ideaWhy(s: Sized, ctx: WhyContext): string {
  const { proteinNeed, energyRoom, mealsAhead } = ctx;
  const words = BOUND_WORDS[ctx.boundKind ?? "observed_ceiling"];
  const protein = Math.round(s.protein);
  const kcal = Math.round(s.kcal);
  const owed = proteinNeed != null && proteinNeed > 0;
  const proteinFood = isProteinFood(s);
  const brings = proteinFood ? null : whatItBrings(s);
  let lead: string;
  const need = Math.round(proteinNeed ?? 0);
  if (brings && owed)
    lead = `${brings} — not a protein food, so pair it with one for the ${need} g protein still to go`;
  else if (brings && proteinNeed != null)
    lead = `${brings}; protein is ${ctx.aboutThere ? "about there" : "already met"} today`;
  else if (brings) lead = `One of your staples, not a protein food: ${brings[0].toLowerCase()}${brings.slice(1)}`;
  else if (owed && protein >= need) lead = `About ${protein} g protein, enough for the ${need} g still to go`;
  else if (owed) lead = `About ${protein} g protein toward the ${need} g still to go`;
  else if (proteinNeed != null)
    lead = `Protein is ${ctx.aboutThere ? "about there" : "already met"} today; this adds about ${protein} g`;
  else if (s.staple.source === "components") lead = `Built from foods you log often, about ${protein} g protein`;
  else lead = `One of your staples, about ${protein} g protein`;
  const meals = `the ${COUNT_WORDS[mealsAhead] ?? mealsAhead} meals still ahead`;
  // Only a protein food earns its place past the energy room on protein's account.
  const first = owed && proteinFood ? "; protein comes first" : "";
  if (s.fits === true) {
    return mealsAhead > 1
      ? `${lead}. At about ${kcal} kcal it is one of ${meals}, and leaves room for the rest of the day.`
      : `${lead}. At about ${kcal} kcal it fits what is left ${words.fits}.`;
  }
  if (s.fits === false) {
    return mealsAhead > 1 && energyRoom != null && s.kcal <= energyRoom
      ? `${lead}. At about ${kcal} kcal it takes more than one meal's share of today's room${first}.`
      : `${lead}. It runs past ${words.past} today${first}.`;
  }
  return mealsAhead > 1 ? `${lead}, sized as one of ${meals}.` : `${lead}.`;
}

// ---- health leans: active nutrition findings nudge the order, never the set ----
export interface FuelHealthLeans {
  lower_saturated_fat: boolean;
  more_fiber: boolean;
  lower_sodium: boolean;
}

/** What the active nutrition-relevant directives lean toward, read off their words. PURE. */
export function fuelHealthLeans(directives: any[]): FuelHealthLeans {
  const text = (directives ?? [])
    .map((d) => `${d?.marker ?? ""} ${d?.directive ?? ""} ${d?.rationale ?? ""}`)
    .join(" ");
  return {
    lower_saturated_fat: /saturated|\bldl|apo\s*-?b\b|cholesterol|lipid|non-hdl|triglycer/i.test(text),
    more_fiber: /\bfib(?:er|re)s?\b/i.test(text),
    lower_sodium: /sodium|\bsalt\b|blood pressure|hypertens/i.test(text),
  };
}

/** How many of the leans this staple's own estimate lines up with. PURE. */
export function fuelHealthAlignment(staple: FuelStaple, leans: FuelHealthLeans): number {
  let n = 0;
  if (leans.lower_saturated_fat && staple.saturated_fat === "low") n++;
  if (leans.lower_sodium && staple.sodium === "low") n++;
  if (leans.more_fiber && (staple.fiber_g ?? 0) >= 5) n++;
  return n;
}

export interface FuelIdeasOptions {
  hour?: number;
  /** Idea keys or staple keys to skip ("Another idea"). */
  exclude?: string[];
}

// A meal with no numbers at all: still being estimated, or never estimated.
const unestimatedMeal = (entry: any): boolean =>
  ["kcal", "protein_g", "fiber_g"].every((key) => entry?.[key] == null || !Number.isFinite(Number(entry[key])));

/**
 * What is logged so far, marked for what it is: a partial sum (unless the day reads
 * complete) over the meals that carry numbers, with the unestimated ones left out and
 * counted. PURE over `getDayIntake`'s shape.
 */
export function todaySoFar(
  day: { entries: any[] },
  state: ClientFuelIdeas["today_so_far"]["state"],
  date: string
): ClientFuelIdeas["today_so_far"] {
  const counted = day.entries.filter((entry) => !unestimatedMeal(entry));
  const unestimated = day.entries.length - counted.length;
  const sum = (key: "kcal" | "protein_g" | "fiber_g") =>
    Math.round(
      counted.reduce((acc, entry) => acc + (Number.isFinite(Number(entry?.[key])) ? Number(entry[key]) : 0), 0)
    );
  const kcal = sum("kcal");
  const protein_g = sum("protein_g");
  const fiber_g = sum("fiber_g");
  const isToday = date === localDateISO();
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const numbers = `${protein_g} g protein, ${kcal.toLocaleString("en-US")} kcal and ${fiber_g} g fiber`;
  let words: string;
  if (state === "nothing logged") words = isToday ? "Nothing logged yet today." : "Nothing was logged that day.";
  else if (!counted.length)
    words = `${n(unestimated, "meal is", "meals are")} logged${isToday ? " so far" : ""}, with no numbers yet, so there is no sum to show.`;
  else if (state === "complete" && !unestimated) words = `The day's total: ${numbers}.`;
  else if (state === "complete")
    words = `Logged that day: ${numbers} from ${n(counted.length, "meal", "meals")} — not the whole day.`;
  else
    words = `So far${isToday ? " today" : ""}: ${numbers} from ${n(counted.length, "meal", "meals")} — in progress, not the day's total.`;
  if (unestimated && counted.length)
    words += ` ${n(unestimated, "more meal has", "more meals have")} no numbers yet and ${unestimated === 1 ? "isn't" : "aren't"} counted.`;
  return {
    kcal,
    protein_g,
    fiber_g,
    state,
    partial: state !== "complete" || unestimated > 0,
    meals_counted: counted.length,
    meals_unestimated: unestimated,
    words,
  };
}

// How many meals the rest of `date` plausibly still holds: the shared meal windows not
// yet closed at `hour` and not already covered by a logged meal — at least one.
export function fuelMealsAhead(
  date: string,
  hour: number | undefined,
  logged: Array<{ meal?: unknown; eaten_at?: unknown }>
): number {
  const today = localDateISO();
  const at = date < today ? 24 : date > today ? 0 : (hour ?? Math.floor(localHourFraction()));
  return Math.max(1, mealWindowsAhead(at, logged).length);
}

function setWords(count: number): string {
  if (!count) return "No staples to build ideas from yet. They appear once a few meals repeat.";
  if (count >= FUEL_IDEAS_COUNT)
    return "Ideas from your own staples, each one meal of the day — not a plan. Nothing is logged until you log it.";
  const lead = count === 1 ? "Only one idea so far" : `Only ${COUNT_WORDS[count] ?? count} ideas so far`;
  return `${lead}: an idea needs a food you have logged on more than one day, and more appear as meals repeat. Not a plan — nothing is logged until you log it.`;
}

/**
 * Up to three ideas for the rest of `date` (default today), each sized as one meal,
 * deterministic. Never logs, never drafts a plan, never asks an agent.
 */
export function fuelIdeas(date: string = localDateISO(), opts: FuelIdeasOptions = {}): ClientFuelIdeas {
  let goal: any = null;
  try {
    goal = computeGoalCheck();
  } catch {
    goal = null;
  }
  const band = intakeBand(date, { goal });
  const anchor = band.protein_anchor;
  const day = getDayIntake(date);
  const totals = day.totals;
  const coverage = day.count ? dayIntakeCoverage(date).coverage : "none";
  const state: ClientFuelIdeas["today_so_far"]["state"] = !day.count
    ? "nothing logged"
    : date < localDateISO() && coverage === "complete"
      ? "complete"
      : "in progress";

  // A meal still being estimated (or whose estimate never landed) has no numbers, so
  // today's sum is only a floor: no "still to go" and no energy room is claimed off it,
  // never a zero standing in for the unknown meal.
  const proteinKnown = !day.count || day.known?.protein_g === true;
  const kcalKnown = !day.count || day.known?.kcal === true;
  const shortfall = anchor && proteinKnown ? Math.max(0, anchor.protein_g - totals.protein_g) : null;
  const aboutThere = shortfall != null && shortfall > 0 && shortfall <= PROTEIN_ABOUT_THERE_G;
  const proteinNeed = aboutThere ? 0 : shortfall;
  let target: ReturnType<typeof dayIntakeTarget> = null;
  try {
    target = dayIntakeTarget(goal);
  } catch {
    target = null;
  }
  // Ideas are sized to the DAY's number (repo/day-energy.ts): whichever bound holds the
  // room (the accepted target, the loss edge, the observed ceiling) is a weekly figure, so
  // the day's planned shift moves it — a long-run day's dinner is offered more room and a
  // rest day's less, and the week's total is unchanged.
  const weekly = fuelEnergyBound(band, target);
  let dayShift = 0;
  try {
    if (target && weekly.kcal != null) dayShift = dayEnergyTarget(date, target.kcal).shift_kcal;
  } catch {
    dayShift = 0;
  }
  const bound = weekly.kcal != null ? { ...weekly, kcal: weekly.kcal + dayShift } : weekly;
  const energyRoom = bound.kcal != null && kcalKnown ? Math.round(bound.kcal - totals.kcal) : null;

  // One meal's share of what is left.
  const mealsAhead = fuelMealsAhead(date, opts.hour, day.entries);
  const share: FuelMealShare = {
    protein_g: proteinNeed == null ? null : proteinNeed / mealsAhead,
    energy_kcal: energyRoom == null ? null : Math.max(0, energyRoom) / mealsAhead,
    protein_cap_g: anchor && anchor.protein_g > 0 ? anchor.protein_g / 2 : null,
  };

  let leans: FuelHealthLeans = { lower_saturated_fat: false, more_fiber: false, lower_sodium: false };
  try {
    leans = fuelHealthLeans(nutritionRelevantDirectives());
  } catch {
    // No findings read: the order stands on protein alone.
  }

  const excluded = new Set((opts.exclude ?? []).map((k) => safeKey(String(k).split("@")[0])));
  const eatenToday = new Set(day.entries.map((e: any) => foodKey(String(e.summary ?? ""))));
  const staples = fuelStaples(date, opts.hour).filter((s) => !excluded.has(s.key) && !eatenToday.has(s.key));

  const fitRank = (f: boolean | null) => (f === true ? 2 : f === null ? 1 : 0);
  const ranked = staples
    .map((staple) => sizeFuelIdea(staple, share))
    .filter((s): s is Sized => s != null)
    .map((s) => ({ s, aligned: fuelHealthAlignment(s.staple, leans) }))
    .sort(
      (a, b) =>
        (proteinNeed != null && proteinNeed > 0 ? Math.round(b.s.covered / 5) - Math.round(a.s.covered / 5) : 0) ||
        fitRank(b.s.fits) - fitRank(a.s.fits) ||
        b.aligned - a.aligned ||
        b.s.staple.protein_g / b.s.staple.kcal - a.s.staple.protein_g / a.s.staple.kcal ||
        Number(b.s.staple.usual_now) - Number(a.s.staple.usual_now) ||
        b.s.staple.times_logged - a.s.staple.times_logged ||
        a.s.staple.key.localeCompare(b.s.staple.key)
    );
  // Two ideas never lead with the same food, nor print the same title.
  const leads = new Set<string>();
  const titles = new Set<string>();
  const sized: Sized[] = [];
  for (const { s } of ranked) {
    const lead = s.staple.lead_key ?? s.staple.key;
    const shown = s.staple.title.trim().toLowerCase();
    if (leads.has(lead) || titles.has(shown)) continue;
    leads.add(lead);
    titles.add(shown);
    sized.push(s);
    if (sized.length >= FUEL_IDEAS_COUNT) break;
  }

  const round = (n: number | null) => (n == null ? null : Math.round(n));
  const ideas: ClientFuelIdea[] = sized.map((s) => {
    const portion_words = PORTION_WORDS[s.portion] ?? "your usual portion";
    const base = s.staple.prefill ?? s.staple.title;
    return {
      key: `${s.staple.key}@${s.portion}`,
      title: s.staple.title,
      portion: s.portion,
      portion_words,
      kcal: round(s.kcal),
      protein_g: round(s.protein),
      carbs_g: s.staple.carbs_g == null ? null : Math.round(s.staple.carbs_g * s.portion),
      fat_g: s.staple.fat_g == null ? null : Math.round(s.staple.fat_g * s.portion),
      fiber_g: s.staple.fiber_g == null ? null : Math.round(s.staple.fiber_g * s.portion),
      fits_band: s.fits,
      why: ideaWhy(s, { proteinNeed, aboutThere, energyRoom, mealsAhead, boundKind: bound.kind }),
      prefill: s.portion === 1 ? base : `${base} (${portion_words})`,
      times_logged: s.staple.times_logged,
      last_logged: s.staple.last_logged,
      source: s.staple.source ?? "staple",
    };
  });

  return {
    kind: "ideas",
    date,
    protein_anchor: anchor,
    today_so_far: todaySoFar(day, state, date),
    room: {
      protein_g: proteinNeed == null ? null : Math.round(proteinNeed),
      energy_kcal: energyRoom,
      energy_bound: bound.kind,
      meals_ahead: mealsAhead,
      meal_share: { protein_g: round(share.protein_g), energy_kcal: round(share.energy_kcal) },
    },
    band_status: band.status,
    ideas,
    words: setWords(ideas.length),
  };
}
