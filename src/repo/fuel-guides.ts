// The day's food GUIDES — one engine read of "what are good amounts of carbs, fat, fiber
// and saturated fat today, and how is the week going on omega-3s", so the Intake card can
// answer more than protein and energy without a surface inventing a number.
//
// Every figure is DERIVED here from the athlete's own target, bodyweight, the day's work
// and labs, and each carries a `basis_words` the card can say in a few words. A guide is a
// RANGE, a FLOOR or a CEILING in grams, never a single must-hit number; omega-3 (which is
// not captured in grams) is a WEEKLY read in words. The laws:
//   - a guide is a suggestion, never a gate, and adherence-neutral: a day still being
//     eaten speaks only of what is left to place (`room`), never a shortfall; only a
//     closed COMPLETE day (classifyIntakeDay) says where it landed (`landing`), as
//     information; a partial closed day says nothing about landing at all;
//   - an unknown eaten side is null, never a zero (saturated fat is summed only when
//     every entry of the day carries it);
//   - guides scale with the DAY's target (which already carries the cut and the
//     adaptive loop) and never move kcal or protein; protein + the fat floor + the top of
//     the carb range fit inside the kcal target — fat holds its floor and carbs flex, the
//     precedence carbRangeForTier already uses;
//   - the athlete's own accepted carbs_g / fat_g win (`source: "yours"`).
// Nothing here throws into a nutrition surface: each part degrades to absent.
import { db } from "../db.js";
import { FAT_CEILING_SHARE, FAT_FLOOR_SHARE, carbBasis, dayFuelDemand } from "./fuel-demand.js";
import type { CarbBasis, DayFuelDemand } from "./fuel-demand.js";
import { fiberFloorG, FIBER_FLOOR_G } from "./fiber-floor.js";
import { fuelHealthLeans } from "./fuel-ideas.js";
import { dayIntakeCoverage, getDayIntake } from "./nutrition.js";
import { nutritionRelevantDirectives } from "./nutrition-progress.js";
import { matchOptimalZone } from "./propagation-data.js";
import { prioritizeMarkers } from "./propagation.js";
import { listSupplements } from "./supplements.js";
import { addDaysISO, localDateISO } from "./shared.js";

// ---------- the rules (each published source named; see the stream report) ----------
// Fat: the ACSM / AND / DC joint position "Nutrition and Athletic Performance" (2016) band
// of 20-35% of energy — FAT_FLOOR_SHARE / FAT_CEILING_SHARE, shared with the carb range —
// with a bodyweight floor beside it: at least 0.5 g per kg a day during a fat-loss phase
// (Ruiz-Castellano, Espinar, Contreras, Mata, Aragon & Martinez-Sanz, "Achieving an Optimal
// Fat Loss Phase in Resistance-Trained Athletes: A Narrative Review", Nutrients 2021;
// 13(9):3255 — low-fat diets, at or under 20% of energy, can lower testosterone). The
// higher of the two floors holds.
export const FAT_FLOOR_G_PER_KG = 0.5;
// Saturated fat: under 10% of energy (Dietary Guidelines for Americans 2020-2025); 5-6%
// for an adult who would benefit from lowering LDL (2013 AHA/ACC Guideline on Lifestyle
// Management to Reduce Cardiovascular Risk) — the top of that band when an active lipid
// finding leans lower.
export const SAT_FAT_CEILING_SHARE = 0.1;
export const SAT_FAT_LIPID_CEILING_SHARE = 0.06;
// Omega-3: the AHA's "two servings of (oily) fish a week" (AHA Science Advisory, Rimm et
// al., "Seafood Long-Chain n-3 Polyunsaturated Fatty Acids and Cardiovascular Disease",
// Circulation 2018). Counted as days with an omega-3 source over the last seven days.
export const OMEGA_3_DAYS_PER_WEEK = 2;
const WEEK_DAYS = 7;
// Fewer logged days than this in the week and a weekly line says nothing: too thin to read.
const WEEKLY_MIN_LOGGED_DAYS = 3;

export type FuelGuideKey = "carbs" | "fat" | "fiber" | "saturated_fat" | "omega_3" | "sodium" | "added_sugar";
export type FuelGuideKind = "range" | "floor" | "ceiling" | "weekly";
export type FuelGuideDayState = "in_progress" | "complete" | "partial" | "nothing_logged";

export interface FuelGuide {
  key: FuelGuideKey;
  label: string;
  kind: FuelGuideKind;
  /** Grams: a range's ends, a floor's low, a ceiling's high. Null when not applicable. */
  low_g: number | null;
  high_g: number | null;
  /** What the day carries so far; null when unknown (never a zero standing in for it). */
  eaten_g: number | null;
  basis_words: string;
  source: "yours" | "derived";
  lab_led: boolean;
  /** In progress only, eaten known: grams still to place (a range's low/high, a floor's low, a ceiling's high). */
  room?: { low_g: number | null; high_g: number | null } | null;
  /** A closed COMPLETE day only, eaten known: where it landed, as information. */
  landing?: { where: "inside" | "under" | "over"; by_g: number } | null;
  /** Carbs with the athlete's own number: the day-shape range said beside it. */
  day_shape?: { low_g: number; high_g: number } | null;
  /** Saturated fat: the day's coarse band in words when grams are unknown. */
  eaten_band?: "low" | "moderate" | "high" | null;
  /**
   * The finished words a renderer frames and never works out again (the Fuel contract's
   * rule): `text` is the guide itself ("around 230–250 g today", "30 g or more", "under
   * 24 g"); `note` is what is left to place (in progress) or where it landed (a closed
   * complete day), then the basis. `track` is the picture's geometry on a 0–1 scale.
   */
  text?: string;
  note?: string;
  track?: { lo: number; hi: number; mark: number | null } | null;
  /** A row on the Intake card: carbs, fat, fiber always; saturated fat when its eaten side is known or a lab finding leads it. */
  on_card?: boolean;
  /** Weekly lines: the one sentence, and its counts. */
  words?: string | null;
  weekly?: { days_with: number; days_logged: number; supplement: boolean } | null;
}

export interface FuelGuides {
  date: string;
  day_state: FuelGuideDayState;
  target_kcal: number | null;
  protein_g: number | null;
  guides: FuelGuide[];
}

type Intake = ReturnType<typeof getDayIntake>;

export interface FuelGuidesOpts {
  today?: string;
  intake?: Intake;
  demand?: DayFuelDemand | null;
  basis?: CarbBasis | null;
  /** Test injection: the active nutrition-relevant directives. */
  directives?: any[];
}

const up5 = (n: number) => Math.ceil(n / 5) * 5;
const down5 = (n: number) => Math.floor(n / 5) * 5;
const positive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function dayState(date: string, today: string, count: number): FuelGuideDayState {
  if (!count) return "nothing_logged";
  if (date >= today) return "in_progress";
  try {
    return dayIntakeCoverage(date).coverage === "complete" ? "complete" : "partial";
  } catch {
    return "partial";
  }
}

function roomFor(kind: FuelGuideKind, low: number | null, high: number | null, eaten: number) {
  if (kind === "range" && low != null && high != null) {
    if (eaten >= high) return null;
    return { low_g: Math.max(0, low - eaten), high_g: high - eaten };
  }
  if (kind === "floor" && low != null) return eaten < low ? { low_g: low - eaten, high_g: null } : null;
  if (kind === "ceiling" && high != null) return eaten < high ? { low_g: null, high_g: high - eaten } : null;
  return null;
}

function landingFor(kind: FuelGuideKind, low: number | null, high: number | null, eaten: number) {
  if (low != null && kind !== "ceiling" && eaten < low) return { where: "under" as const, by_g: low - eaten };
  if (high != null && kind !== "floor" && eaten > high) return { where: "over" as const, by_g: eaten - high };
  return { where: "inside" as const, by_g: 0 };
}

// ---------- the words (finished here; the card frames them) ----------
const gram = (n: number) => Math.round(n).toLocaleString("en-US");
const span = (low: number, high: number) => (low === high ? gram(high) : `${gram(low)}–${gram(high)}`);

function guideText(g: FuelGuide): string {
  const { low_g: low, high_g: high } = g;
  if (g.kind === "floor" && low != null) return `${gram(low)} g or more`;
  if (g.kind === "ceiling" && high != null) return `under ${gram(high)} g`;
  if (low == null || high == null) return "";
  if (g.source === "yours") return `around ${gram(high)} g, your number`;
  if (g.key === "carbs") return `around ${span(low, high)} g today`;
  return low === high ? `around ${gram(high)} g` : `${span(low, high)} g`;
}

// While the day is eaten: what is left to place, never a shortfall.
function roomWords(g: FuelGuide): string {
  const room = g.room;
  if (!room) return g.kind === "floor" && g.eaten_g != null && g.low_g != null && g.eaten_g >= g.low_g ? "reached" : "";
  if (g.kind === "range" && room.high_g != null) {
    return room.low_g != null && room.low_g > 0 && room.low_g !== room.high_g
      ? `room for about ${span(room.low_g, room.high_g)} g more`
      : `room for up to ${gram(room.high_g)} g more`;
  }
  if (g.kind === "floor" && room.low_g != null) return `about ${gram(room.low_g)} g more reaches it`;
  if (g.kind === "ceiling" && room.high_g != null) return `${gram(room.high_g)} g of room under it`;
  return "";
}

// A closed complete day: where it landed, plainly, without a verdict.
function landingWords(g: FuelGuide): string {
  const l = g.landing;
  if (!l) return "";
  if (l.where === "inside") return g.kind === "floor" ? "reached" : "landed inside";
  if (l.where === "under") return g.kind === "floor" ? `under the floor by ${gram(l.by_g)} g` : `${gram(l.by_g)} g under the range`;
  return g.kind === "ceiling" ? `over by ${gram(l.by_g)} g` : `${gram(l.by_g)} g over the range`;
}

function noteFor(g: FuelGuide, state: FuelGuideDayState): string {
  const where = state === "in_progress" ? roomWords(g) : state === "complete" ? landingWords(g) : "";
  const seen = state === "in_progress" ? "today's meals so far read" : "the day's meals read";
  const band = g.eaten_g == null && g.eaten_band ? `${seen} mostly ${g.eaten_band} in it` : "";
  const shape = g.day_shape ? `today's work suits ${span(g.day_shape.low_g, g.day_shape.high_g)} g` : "";
  return [where, band, shape, g.basis_words].filter(Boolean).join(" · ");
}

// The picture: the guide as a band on a neutral track, the eaten amount as a mark.
function trackFor(g: FuelGuide): FuelGuide["track"] {
  const low = g.low_g ?? 0;
  const top = Math.max(g.high_g ?? low * 1.5, g.eaten_g ?? 0) * 1.15;
  if (!(top > 0)) return null;
  const frac = (n: number) => Math.round(Math.max(0, Math.min(1, n / top)) * 1000) / 1000;
  return {
    lo: g.kind === "ceiling" ? 0 : frac(low),
    hi: g.kind === "floor" ? 1 : frac(g.high_g ?? 0),
    mark: g.eaten_g == null ? null : frac(g.eaten_g),
  };
}

/** Room while the day is eaten, landing once it closed complete, nothing on a partial day; then the words. */
function placed(guide: FuelGuide, state: FuelGuideDayState): FuelGuide {
  const e = guide.eaten_g;
  const g: FuelGuide = {
    ...guide,
    room: e != null && state === "in_progress" ? roomFor(guide.kind, guide.low_g, guide.high_g, e) : null,
    landing: e != null && state === "complete" ? landingFor(guide.kind, guide.low_g, guide.high_g, e) : null,
  };
  const onCard = g.key !== "saturated_fat" || g.eaten_g != null || g.lab_led;
  return { ...g, text: guideText(g), note: noteFor(g, state), track: trackFor(g), on_card: onCard };
}

const CARB_TIER_WORDS: Record<string, string> = {
  light: "for a lighter day",
  moderate: "for today's training",
  high: "for today's endurance work",
};

function eatenOf(intake: Intake, key: "carbs_g" | "fat_g" | "fiber_g"): number | null {
  if (!intake.count || !intake.known?.[key]) return null;
  const n = Number(intake.totals?.[key]);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function saturatedEaten(entries: any[]): { grams: number | null; band: FuelGuide["eaten_band"] } {
  if (!entries.length) return { grams: null, band: null };
  const grams = entries.map((e) => Number(e?.nutrition_pattern?.saturated_fat_g));
  const allGrams = entries.every((e) => e?.nutrition_pattern?.saturated_fat_g != null) && grams.every(Number.isFinite);
  const bands = entries.map((e) => String(e?.nutrition_pattern?.saturated_fat ?? ""));
  let band: FuelGuide["eaten_band"] = null;
  if (bands.every((b) => b === "low" || b === "moderate" || b === "high")) {
    const counts = { low: 0, moderate: 0, high: 0 } as Record<"low" | "moderate" | "high", number>;
    for (const b of bands) counts[b as "low" | "moderate" | "high"]++;
    band = (["moderate", "low", "high"] as const).reduce((best, b) => (counts[b] > counts[best] ? b : best), "moderate");
  }
  return { grams: allGrams ? Math.round(grams.reduce((a, b) => a + b, 0)) : null, band };
}

// ---------- the weekly lines ----------
interface WeekDay {
  omega: boolean;
  omegaKnown: boolean;
  sodiumHigh: boolean;
  sugarHigh: boolean;
}

function weekOfFood(date: string): WeekDay[] {
  const since = addDaysISO(date, -(WEEK_DAYS - 1)) ?? date;
  const rows = db
    .prepare(
      `SELECT COALESCE(date, substr(created_at, 1, 10)) AS day, parsed_json FROM food_notes
        WHERE COALESCE(date, substr(created_at, 1, 10)) BETWEEN ? AND ?`
    )
    .all(since, date) as any[];
  const byDay = new Map<string, WeekDay>();
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
    } catch {
      parsed = null;
    }
    const day = byDay.get(row.day) ?? { omega: false, omegaKnown: false, sodiumHigh: false, sugarHigh: false };
    const p = parsed?.nutrition_pattern;
    if (p && typeof p === "object") {
      if (typeof p.omega_3_source === "boolean") day.omegaKnown = true;
      if (p.omega_3_source === true) day.omega = true;
      if (p.sodium === "high") day.sodiumHigh = true;
      if (p.added_sugar === "high") day.sugarHigh = true;
    }
    byDay.set(row.day, day);
  }
  return [...byDay.values()];
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven"];

function omegaSupplement(): { name: string } | null {
  try {
    const hit = listSupplements().find((s: any) => {
      const omega = s?.category === "omega-3" || /omega|fish[- ]?oil|\bepa\b|\bdha\b|cod liver|algae oil/i.test(String(s?.name ?? ""));
      return omega && /daily|every day|most days/i.test(String(s?.frequency ?? ""));
    });
    return hit ? { name: String(hit.name || "omega-3") } : null;
  } catch {
    return null;
  }
}

// The latest Omega-3 index reading's STANDING in words, never its value.
function omegaIndexWords(): string | null {
  try {
    const marker = prioritizeMarkers().markers.find(
      (m: any) => matchOptimalZone(String(m?.name ?? ""))?.label === "Omega-3 index"
    );
    if (!marker || typeof (marker as any).in_optimal !== "boolean") return null;
    return (marker as any).in_optimal
      ? "Your last omega-3 index reads in range."
      : "Your last omega-3 index reads below its range.";
  } catch {
    return null;
  }
}

function weeklyGuide(key: FuelGuideKey, label: string, words: string, weekly: FuelGuide["weekly"], labLed: boolean): FuelGuide {
  return {
    key,
    label,
    kind: "weekly",
    low_g: null,
    high_g: null,
    eaten_g: null,
    basis_words: key === "omega_3" ? "two servings of oily fish a week" : "your labs",
    source: "derived",
    lab_led: labLed,
    words,
    weekly,
  };
}

function omegaLine(week: WeekDay[]): FuelGuide | null {
  const logged = week.length;
  const known = week.some((d) => d.omegaKnown);
  const supplement = omegaSupplement();
  const days = week.filter((d) => d.omega).length;
  const index = omegaIndexWords();
  let words: string | null = null;
  if (supplement) {
    words =
      days > 0
        ? `You take an omega-3 supplement daily, beside an omega-3 food on ${COUNT_WORDS[days]} of the last seven days.`
        : "You take an omega-3 supplement daily.";
  } else if (logged >= WEEKLY_MIN_LOGGED_DAYS && known) {
    words =
      days === 0
        ? `None of the last ${COUNT_WORDS[logged]} logged days carried an omega-3 source. Two servings of oily fish a week is the usual guide.`
        : days < OMEGA_3_DAYS_PER_WEEK
          ? `An omega-3 source on ${COUNT_WORDS[days]} of the last seven days. Two a week is the usual guide.`
          : `An omega-3 source on ${COUNT_WORDS[days]} of the last seven days, in line with the usual two a week.`;
  }
  if (!words) return null;
  return weeklyGuide(
    "omega_3",
    "Omega-3",
    index ? `${words} ${index}` : words,
    { days_with: days, days_logged: logged, supplement: !!supplement },
    !!index
  );
}

const SUGAR_LAB_RE = /triglycer|a1c|glucose|insulin/i;

function bandLines(week: WeekDay[], directives: any[], leans: ReturnType<typeof fuelHealthLeans>): FuelGuide[] {
  const logged = week.length;
  if (logged < WEEKLY_MIN_LOGGED_DAYS) return [];
  const most = (n: number) => n * 2 > logged;
  const out: FuelGuide[] = [];
  const sodiumDays = week.filter((d) => d.sodiumHigh).length;
  if (leans.lower_sodium && most(sodiumDays)) {
    out.push(
      weeklyGuide(
        "sodium",
        "Salt",
        "Most of the last week's logged days read high in salt. Your blood pressure makes that one worth a look.",
        { days_with: sodiumDays, days_logged: logged, supplement: false },
        true
      )
    );
  }
  const sugarText = directives.map((d) => `${d?.marker ?? ""} ${d?.directive ?? ""}`).join(" ");
  const sugarDays = week.filter((d) => d.sugarHigh).length;
  if (SUGAR_LAB_RE.test(sugarText) && most(sugarDays)) {
    out.push(
      weeklyGuide(
        "added_sugar",
        "Added sugar",
        "Most of the last week's logged days read high in added sugar. Your blood sugar and triglyceride markers make that one worth a look.",
        { days_with: sugarDays, days_logged: logged, supplement: false },
        true
      )
    );
  }
  return out;
}

// ---------- the day's gram guides ----------
function guide(fields: Omit<FuelGuide, "source" | "lab_led"> & Partial<Pick<FuelGuide, "source" | "lab_led">>): FuelGuide {
  return { source: "derived", lab_led: false, ...fields };
}

/**
 * The day's guides. Deterministic and read-only; `opts.intake` / `demand` / `basis` let
 * the day route hand over what it already read, so nothing is derived twice.
 */
export function dayFuelGuides(date?: string, opts: FuelGuidesOpts = {}): FuelGuides {
  const today = opts.today || localDateISO();
  const d = date || today;
  const intake = opts.intake ?? getDayIntake(d);
  const target = intake.target ?? null;
  const kcal = positive(target?.kcal);
  const protein = positive(target?.protein_g);
  const basis = opts.basis !== undefined ? opts.basis : carbBasis(target, undefined, today);
  const demand = opts.demand !== undefined ? opts.demand : dayFuelDemand(d, { today, carbBasis: basis });
  const state = dayState(d, today, Number(intake.count) || 0);
  let directives: any[] = [];
  try {
    directives = opts.directives ?? nutritionRelevantDirectives();
  } catch {
    directives = [];
  }
  const leans = fuelHealthLeans(directives);
  const kg = positive(basis?.weight_kg);
  const guides: FuelGuide[] = [];

  // Fat first: its floor is what carbs must leave room for.
  const ownFat = positive(target?.fat_g);
  let fat: FuelGuide | null = null;
  let fatFloorForFit: number | null = null;
  if (ownFat) {
    fatFloorForFit = Math.round(ownFat);
    fat = guide({
      key: "fat",
      label: "Fat",
      kind: "range",
      low_g: fatFloorForFit,
      high_g: fatFloorForFit,
      eaten_g: eatenOf(intake, "fat_g"),
      basis_words: "your own number",
      source: "yours",
    });
  } else if (kcal || kg) {
    const shareFloor = kcal ? (kcal * FAT_FLOOR_SHARE) / 9 : 0;
    const weightFloor = kg ? kg * FAT_FLOOR_G_PER_KG : 0;
    const low = up5(Math.max(shareFloor, weightFloor));
    fatFloorForFit = low;
    const high = kcal ? Math.max(low, down5((kcal * FAT_CEILING_SHARE) / 9)) : null;
    const weightLed = weightFloor > shareFloor;
    fat = guide({
      key: "fat",
      label: "Fat",
      kind: high != null ? "range" : "floor",
      low_g: low,
      high_g: high,
      eaten_g: eatenOf(intake, "fat_g"),
      basis_words: !kcal
        ? "at least half a gram per kg of your weight"
        : weightLed
          ? "at least half a gram per kg of your weight, up to a third of today's energy"
          : "a fifth to a third of today's energy",
    });
  }

  // Carbs: the day-shape range (fuel-demand), fitted so protein + the fat floor + its top
  // stay inside the kcal target — fat holds its floor, carbs flex.
  const shape = demand?.carbs ?? null;
  let shapeLow = shape ? Math.round(Number(shape.grams.low)) : null;
  let shapeHigh = shape ? Math.round(Number(shape.grams.high)) : null;
  if (shapeHigh != null && shapeLow != null && kcal && protein && fatFloorForFit != null) {
    const most = Math.max(0, down5((kcal - protein * 4 - fatFloorForFit * 9) / 4));
    shapeHigh = Math.min(shapeHigh, most);
    shapeLow = Math.min(shapeLow, shapeHigh);
  }
  const ownCarbs = positive(target?.carbs_g);
  const hasShape = shapeLow != null && shapeHigh != null && shapeHigh > 0;
  const carbs = { key: "carbs" as const, label: "Carbs", kind: "range" as const, eaten_g: eatenOf(intake, "carbs_g") };
  if (ownCarbs) {
    const g = Math.round(ownCarbs);
    const day_shape = hasShape ? { low_g: shapeLow as number, high_g: shapeHigh as number } : null;
    guides.push(guide({ ...carbs, low_g: g, high_g: g, basis_words: "your own number", source: "yours", day_shape }));
  } else if (shape && hasShape) {
    const words = CARB_TIER_WORDS[shape.tier] ?? "for today";
    const basis_words = shape.basis === "within_target" ? `${words}, inside your target` : words;
    guides.push(guide({ ...carbs, low_g: shapeLow, high_g: shapeHigh, basis_words }));
  }

  // With the carb range fitted, fat's top leaves room for the carb range's bottom.
  if (fat && fat.source === "derived" && fat.high_g != null && kcal && protein && shapeLow != null) {
    const roomForFat = down5((kcal - protein * 4 - shapeLow * 4) / 9);
    fat = { ...fat, high_g: Math.max(fat.low_g ?? 0, Math.min(fat.high_g, roomForFat)) };
  }
  if (fat) guides.push(fat);

  // Fiber: the one fiber rule; labs lean more, said in words, no second number.
  const fiberLow = fiberFloorG(kcal);
  const lipid = leans.lower_saturated_fat;
  const fiberBase = fiberLow > FIBER_FLOOR_G ? "14 g per 1,000 kcal of today's target" : "the everyday floor for long-term health";
  guides.push(
    guide({
      key: "fiber",
      label: "Fiber",
      kind: "floor",
      low_g: fiberLow,
      high_g: null,
      eaten_g: eatenOf(intake, "fiber_g"),
      basis_words: leans.more_fiber ? `${fiberBase}; your ${lipid ? "lipids" : "labs"} ask for more of it, oats and beans especially` : fiberBase,
      lab_led: leans.more_fiber,
    })
  );

  // Saturated fat: a ceiling off the day's energy, tighter when a lipid finding leans lower.
  if (kcal) {
    const sat = saturatedEaten(Array.isArray(intake.entries) ? intake.entries : []);
    const share = lipid ? SAT_FAT_LIPID_CEILING_SHARE : SAT_FAT_CEILING_SHARE;
    guides.push(
      guide({
        key: "saturated_fat",
        label: "Saturated fat",
        kind: "ceiling",
        low_g: null,
        high_g: Math.round((kcal * share) / 9),
        eaten_g: intake.count ? sat.grams : null,
        eaten_band: intake.count && sat.grams == null ? sat.band : null,
        basis_words: lipid ? "kept lower, as your lipids ask" : "under a tenth of today's energy",
        lab_led: lipid,
      })
    );
  }

  const placedGuides = guides.map((g) => placed(g, state));
  try {
    const week = weekOfFood(d);
    const omega = omegaLine(week);
    if (omega) placedGuides.push(omega);
    placedGuides.push(...bandLines(week, directives, leans));
  } catch {
    /* the weekly lines are context; a failed read says nothing */
  }
  return { date: d, day_state: state, target_kcal: kcal, protein_g: protein, guides: placedGuides };
}

/**
 * GET /nutrition/day's body and the MCP get_day_intake tool's (MCP ⊆ REST): the day's log,
 * the day-shape demand read and the guides, each derived once.
 */
export function nutritionDayRead(date?: string, opts: { today?: string } = {}) {
  const intake = getDayIntake(date);
  const today = opts.today || localDateISO();
  const basis = carbBasis(intake.target, undefined, today);
  const fuel_demand = dayFuelDemand(date, { carbBasis: basis, ...(opts.today ? { today } : {}) });
  let guides: FuelGuides | null = null;
  try {
    guides = dayFuelGuides(intake.date, { today, intake, demand: fuel_demand, basis });
  } catch {
    guides = null;
  }
  return { ...intake, fuel_demand, guides };
}
