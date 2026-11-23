// The last two weeks of food, read against each day's OWN guides, and the one lever most
// worth a look for the goal in force. A read over reads: the days are the ones the log
// reads complete (classifyIntakeDay, through completedIntakeWindow), each day's guides are
// dayFuelGuides' own, and the weight side is weightTrendRead. Nothing is derived twice.
//
// The laws (docs/VISION.md; CLAUDE.md "Logged intake is evidence only when the day reads
// complete"):
//   - only closed COMPLETE days speak; a partial or unlogged day is absent, never low, and
//     with fewer than PATTERN_MIN_DAYS of them there is no read at all;
//   - a line says where days landed, as information; it never counts a streak or a miss;
//   - the lever is ONE suggestion with its reason, or none. It never moves a target.
// Every string holds the reading grammar.
import { withDayEnergy } from "./day-energy.js";
import { carbBasis, fuelDemandWeek } from "./fuel-demand.js";
import type { DayFuelDemand } from "./fuel-demand.js";
import { LEAN_SAFE_LOSS_SHARE } from "./fuel-guide-why.js";
import { dayFuelGuides, eatenSources, fatKinds } from "./fuel-guides.js";
import type { FuelGuide, FuelGuideKey } from "./fuel-guides.js";
import { completedIntakeWindow } from "./intake-window.js";
import { getDayIntake } from "./nutrition.js";
import { weightTrendRead } from "./weight-trend.js";

export const PATTERN_WINDOW_DAYS = 14;
export const PATTERN_MIN_DAYS = 5;
/** Energy within this share of the target reads "close to your number". */
const ENERGY_CLOSE_SHARE = 0.07;
/** Protein within this many grams of the target reads "about on your number". */
const PROTEIN_CLOSE_G = 10;
/** The weight line and the trend differ by at least this much before the lever names it, lb a week. */
const PACE_GAP_LB_WK = 0.3;

export type FuelPatternKey = "energy" | "protein" | "carbs" | "fat" | "fat_quality" | "fiber" | "saturated_fat";

export interface FuelPatternLine {
  key: FuelPatternKey;
  label: string;
  words: string;
}

export interface FuelPattern {
  since: string;
  through: string;
  complete_days: number;
  /** "Your last 12 complete days". */
  title: string;
  lines: FuelPatternLine[];
  /** The one thing most worth a look, with its reason; null when nothing asks for a change. */
  lever: { key: FuelPatternKey; words: string; why: string } | null;
  /** A lab-led guide landing past its line on most days, said beside the lever so it is never hidden behind it. */
  also: { key: FuelPatternKey; words: string; why: string } | null;
  /** The standing caveat about what a food log leaves out. */
  caveat: string;
}

/** Said under every pattern: the log is the evidence, and it is never the whole day. */
export const LOG_CAVEAT = "This reads what was logged. Cooking oil and small bites usually are not, so the real figures sit a little higher.";

export interface FuelPatternOpts {
  directives?: any[];
}

interface Landed {
  n: number;
  under: number;
  over: number;
  inside: number;
  by: number;
}

const kcalWords = (n: number) => (Math.round(n / 10) * 10).toLocaleString("en-US");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const tenth = (n: number) => (Math.round(Math.abs(n) * 10) / 10).toString();

function landedOf(days: FuelGuide[]): Landed {
  const out: Landed = { n: 0, under: 0, over: 0, inside: 0, by: 0 };
  let bySum = 0;
  let byCount = 0;
  for (const g of days) {
    if (!g.landing) continue;
    out.n++;
    out[g.landing.where]++;
    if (g.landing.where !== "inside") {
      bySum += g.landing.by_g;
      byCount++;
    }
  }
  out.by = byCount ? Math.round(bySum / byCount / 5) * 5 : 0;
  return out;
}

const mostly = (count: number, n: number) => count * 2 > n;

function guideLine(key: FuelPatternKey, label: string, kind: FuelGuide["kind"], l: Landed): FuelPatternLine | null {
  if (l.n < PATTERN_MIN_DAYS) return null;
  const of = `${l.n} days`;
  let words: string;
  if (kind === "floor") words = `${label} reached its floor on ${l.inside} of ${of}.`;
  else if (kind === "ceiling") words = `${label} stayed under its ceiling on ${l.inside} of ${of}.`;
  else if (mostly(l.under, l.n))
    words = `${label} landed under the day's range on ${l.under} of ${of}${l.by ? `, by about ${l.by} g` : ""}.`;
  else if (mostly(l.over, l.n))
    words = `${label} landed over the day's range on ${l.over} of ${of}${l.by ? `, by about ${l.by} g` : ""}.`;
  else words = `${label} landed inside the day's range on ${l.inside} of ${of}.`;
  return { key, label, words };
}

const GUIDE_ROWS: { key: FuelPatternKey & FuelGuideKey; label: string }[] = [
  { key: "carbs", label: "Carbs" },
  { key: "fat", label: "Fat" },
  { key: "fiber", label: "Fiber" },
  { key: "saturated_fat", label: "Saturated fat" },
];

/**
 * The pattern as of `today` (the window closes yesterday). Deterministic and read-only;
 * null when the complete days are too few to read.
 */
export function fuelPattern(today: string, opts: FuelPatternOpts = {}): FuelPattern | null {
  const window = completedIntakeWindow(PATTERN_WINDOW_DAYS, today);
  const dates = window.days.filter((d) => d.credible).map((d) => d.date);
  if (dates.length < PATTERN_MIN_DAYS) return null;

  const todayTarget = getDayIntake(today).target ?? null;
  const basis = carbBasis(todayTarget, undefined, today);
  const demands = new Map<string, DayFuelDemand>();
  try {
    for (const day of fuelDemandWeek(window.since, PATTERN_WINDOW_DAYS, { today, carbBasis: basis }).days) demands.set(day.date, day);
  } catch {
    /* a day with no demand read carries no carb range, and says nothing about carbs */
  }

  const energy: number[] = [];
  const energyTarget: number[] = [];
  const protein: number[] = [];
  const proteinTarget: number[] = [];
  const byGuide = new Map<string, FuelGuide[]>();
  const windowEntries: any[] = [];
  for (const date of dates) {
    const plain = getDayIntake(date);
    // The guides are judged against the DAY's number, the energy line against the average.
    const intake = withDayEnergy(plain, { today });
    const kcal = Number(plain.target?.kcal);
    if (intake.known?.kcal && kcal > 0) {
      energy.push(Number(intake.totals.kcal));
      energyTarget.push(kcal);
    }
    const p = Number(intake.target?.protein_g);
    if (intake.known?.protein_g && p > 0) {
      protein.push(Number(intake.totals.protein_g));
      proteinTarget.push(p);
    }
    const guides = dayFuelGuides(date, {
      today,
      intake,
      basis,
      demand: demands.get(date) ?? null,
      directives: opts.directives,
      gramsOnly: true,
    });
    if (guides.day_state !== "complete") continue;
    if (Array.isArray(intake.entries)) windowEntries.push(...intake.entries);
    for (const g of guides.guides) byGuide.set(g.key, [...(byGuide.get(g.key) ?? []), g]);
  }

  const lines: FuelPatternLine[] = [];
  const eAvg = mean(energy);
  const eTarget = mean(energyTarget);
  let energyGap: number | null = null;
  if (eAvg != null && eTarget != null && energy.length >= PATTERN_MIN_DAYS) {
    energyGap = eAvg - eTarget;
    const close = Math.abs(energyGap) <= eTarget * ENERGY_CLOSE_SHARE;
    lines.push({
      key: "energy",
      label: "Energy",
      words: close
        ? `Logged energy averaged about ${kcalWords(eAvg)} kcal, close to your weekly number.`
        : `Logged energy averaged about ${kcalWords(eAvg)} kcal, about ${kcalWords(Math.abs(energyGap))} ${energyGap < 0 ? "under" : "over"} your weekly number.`,
    });
    if (close) energyGap = 0;
  }
  const pAvg = mean(protein);
  const pTarget = mean(proteinTarget);
  let proteinGap: number | null = null;
  if (pAvg != null && pTarget != null && protein.length >= PATTERN_MIN_DAYS) {
    proteinGap = pAvg - pTarget;
    const close = Math.abs(proteinGap) <= PROTEIN_CLOSE_G;
    lines.push({
      key: "protein",
      label: "Protein",
      words: close
        ? `Logged protein averaged ${Math.round(pAvg)} g, about on your number.`
        : `Logged protein averaged ${Math.round(pAvg)} g, ${Math.round(Math.abs(proteinGap))} ${proteinGap < 0 ? "under" : "over"} your number.`,
    });
  }
  const landed = new Map<string, Landed>();
  for (const row of GUIDE_ROWS) {
    const days = byGuide.get(row.key) ?? [];
    if (!days.length) continue;
    const l = landedOf(days);
    landed.set(row.key, l);
    const line = guideLine(row.key, row.label, days[0].kind, l);
    if (line) lines.push(line);
  }
  if (!lines.length) return null;
  // Which kinds of fat, across the meals that carry the split.
  const kinds = fatKinds(windowEntries);
  if (kinds && kinds.meals * 2 > kinds.of) {
    const tenths = Math.round((kinds.unsaturated_g / (kinds.unsaturated_g + kinds.saturated_g)) * 10);
    const at = lines.findIndex((l) => l.key === "fat");
    lines.splice(at < 0 ? lines.length : at + 1, 0, {
      key: "fat_quality",
      label: "Kinds of fat",
      words: `About ${tenths} of every 10 g of logged fat were unsaturated, the kind in olive oil, avocado, nuts and fish.`,
    });
  }

  const lipidLed = (byGuide.get("saturated_fat") ?? []).some((g) => g.lab_led);
  const lever = leverFor({ today, energyGap, proteinGap, pTarget, landed, lipidLed });
  const sat = landed.get("saturated_fat");
  // Where it came from across these days, so the pattern is something to act on.
  const satFrom = eatenSources(windowEntries, "saturated_fat");
  const satSources = satFrom ? ` Across these days: ${satFrom.charAt(0).toLowerCase()}${satFrom.slice(1)}` : "";
  if (lever?.key === "saturated_fat") lever.why += satSources;
  const also =
    lipidLed && lever?.key !== "saturated_fat" && sat && sat.n >= PATTERN_MIN_DAYS && mostly(sat.over, sat.n)
      ? { key: "saturated_fat" as const, words: SAT_OVER_WORDS, why: `${SAT_SWAP_WHY} Your lipids are why the ceiling sits lower for you.${satSources}` }
      : null;
  return {
    since: dates[0],
    through: dates[dates.length - 1],
    complete_days: dates.length,
    title: `Your last ${dates.length} complete days`,
    lines,
    lever,
    also,
    caveat: LOG_CAVEAT,
  };
}

const SAT_OVER_WORDS = "Saturated fat has landed clearly over its ceiling on most of these days.";
const SAT_SWAP_WHY = "Olive oil, nuts and fish in place of butter, cheese and fatty meat lowers it without changing the energy.";

interface LeverInput {
  today: string;
  energyGap: number | null;
  proteinGap: number | null;
  pTarget: number | null;
  landed: Map<string, Landed>;
  lipidLed: boolean;
}

// One lever, the first that applies, in the order a coach would raise them: the energy
// that sets the pace of the goal, then the fuel for the work, then protein, fiber and
// saturated fat.
function leverFor(i: LeverInput): FuelPattern["lever"] {
  const carbs = i.landed.get("carbs");
  const carbsUnder = !!carbs && carbs.n >= PATTERN_MIN_DAYS && mostly(carbs.under, carbs.n);
  const carbRoom = carbsUnder ? " Most of the room is carbohydrate, which is what the running and the hardest sets use." : "";

  let trend: ReturnType<typeof weightTrendRead> | null = null;
  try {
    trend = weightTrendRead(i.today);
  } catch {
    trend = null;
  }
  const rate = trend?.rate_lb_wk ?? null;
  const needed = trend?.needed_lb_wk ?? null;
  const unit = trend?.units === "kg" ? "kg" : "lb";
  const said = (lbValue: number | null, own: number | null) => tenth(own ?? lbValue ?? 0);
  if (trend && rate != null && needed != null && i.energyGap != null) {
    const paceWords = `Your weight is moving about ${said(rate, trend.rate_value)} ${unit} a week, and the line you set needs ${said(needed, trend.needed_value)}.`;
    if (trend.mode === "lose" && i.energyGap < 0 && rate <= needed - PACE_GAP_LB_WK) {
      const share = trend.current?.lb ? Math.abs(rate) / trend.current.lb : null;
      const pct = share != null ? tenth(share * 100) : null;
      const why =
        share == null
          ? "The slower line leaves more fuel for training."
          : share <= LEAN_SAFE_LOSS_SHARE.high
            ? `That pace is ${pct}% of your weight a week, inside the 0.5–1% of body weight a week usually suggested for keeping muscle while cutting, so nothing is going wrong. The slower line you chose leaves more fuel for training.`
            : `That pace is ${pct}% of your weight a week, past the 0.5–1% of body weight a week usually suggested for keeping muscle while cutting.`;
      return {
        key: "energy",
        words: `${paceWords} Eating closer to your own number would bring the two together.`,
        why: `${why}${carbRoom} If the log misses oil and small bites, the gap is smaller than it reads.`,
      };
    }
    if (trend.mode === "gain" && i.energyGap < 0 && rate <= needed - PACE_GAP_LB_WK) {
      return {
        key: "energy",
        words: `${paceWords} Eating up to your own number is what closes that.`,
        why: `Muscle is built from a small surplus, and the week's average is what counts.${carbRoom}`,
      };
    }
    if (trend.mode === "lose" && i.energyGap > 0 && rate >= needed + PACE_GAP_LB_WK) {
      return {
        key: "energy",
        words: `${paceWords} Energy has averaged over your number across these days.`,
        why: "The week's average is what moves weight, so one or two of the larger days are usually where the room is. Protein stays where it is.",
      };
    }
  }
  if (carbsUnder && carbs) {
    return {
      key: "carbs",
      words: "Carbs have landed under the day's range on most of these days.",
      why: "They are the fuel for long and hard sessions. More of them on those days, inside the same energy, is where it would show first.",
    };
  }
  if (i.proteinGap != null && i.pTarget != null && i.proteinGap < -Math.max(PROTEIN_CLOSE_G, i.pTarget * 0.1)) {
    return {
      key: "protein",
      words: "Protein has averaged under your number across these days.",
      why: "It is what keeps and builds muscle alongside the lifting. One more protein-led meal or snack a day usually closes it.",
    };
  }
  const fiber = i.landed.get("fiber");
  if (fiber && fiber.n >= PATTERN_MIN_DAYS && !mostly(fiber.inside, fiber.n) && fiber.inside * 2 !== fiber.n) {
    return {
      key: "fiber",
      words: "Fiber has reached its floor on fewer than half of these days.",
      why: "A serving of beans, oats or berries a day usually closes it, and it makes the same energy more filling.",
    };
  }
  const sat = i.landed.get("saturated_fat");
  if (sat && sat.n >= PATTERN_MIN_DAYS && mostly(sat.over, sat.n)) {
    return {
      key: "saturated_fat",
      words: SAT_OVER_WORDS,
      why: `${SAT_SWAP_WHY}${i.lipidLed ? " Your lipids are why the ceiling sits lower for you." : ""}`,
    };
  }
  return null;
}
