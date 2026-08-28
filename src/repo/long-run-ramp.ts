// ============================================================================
// long-run-ramp.ts — the week's long run, prescribed at ramp-safe distance.
//
// The template says what the long run is FOR ("12 km, easy"); it does not say
// what today's legs have earned. Written into a plan once, a template distance
// is a fixed number the athlete either reaches or fails against — an athlete
// whose longest run in three months is 9.8 km, handed a 12 km card every week,
// is being asked for a 22% jump on repeat, and connective tissue pays for that
// on a slower clock than the aerobic system does.
//
// So the template target becomes a DESTINATION rather than a prescription, and
// what lands on the card is the smaller of it and one sustainable step past what
// the athlete has actually run:
//
//     prescribed = min(template, longest-in-90-days × SUSTAINABLE_LONG_STEP_FACTOR)
//
// Every week the longest grows, the ceiling grows with it, and the prescription
// climbs toward the template on its own until the template IS the answer and the
// ramp becomes invisible. Nothing here invents a longer run than the template
// asked for: the template is always an upper bound.
//
// The one other brake is the WEEKLY one. A long-run step and a weekly-volume step
// are the same tissue paying twice, so a week already at or past the sustainable
// weekly build holds the long run at the trailing longest instead of stepping it.
//
// Both factors are imported from run-ramp.ts, which is their home — the ceiling
// the plan enforces and the ceiling the race ramp measures against must never be
// two different numbers.
//
// The arithmetic is a pure function so it is testable without a database; the DB
// reads are separate, null-safe, and never throw.
// ============================================================================
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { weeklyKm } from "./program-state.js";
import { SUSTAINABLE_LONG_STEP_FACTOR, SUSTAINABLE_WEEKLY_BUILD_FACTOR } from "./run-ramp.js";
import { addDaysISO } from "./shared.js";

/**
 * Below this, distance is not the thing being trained. A 3 km easy shakeout is a
 * recovery jog whatever else is in the week, and ramping it would be arithmetic
 * applied to something that is not a long run. It is also the FLOOR the anchor
 * cannot fall below, so an athlete with no run history at all is offered a real
 * beginner's long run rather than nothing.
 */
export const LONG_RUN_MIN_KM = 5;

/** How far back "the longest run they have actually done" looks. */
export const LONG_RUN_LOOKBACK_DAYS = 90;

export interface LongRunRampInput {
  /** What the template asks for. Always an upper bound on the answer. */
  templateKm: number;
  /** Longest single run in the trailing window, or null when there is no history. */
  trailingLongestKm: number | null;
  /** Kilometres run in the seven days ending yesterday. */
  lastWeekKm: number;
  /** The chronic base: mean weekly kilometres over the three weeks before that. */
  chronicWeeklyKm: number;
}

export interface LongRunRamp {
  /** What goes on the card. */
  prescribed_km: number;
  /** What the template asked for. */
  template_km: number;
  /** The ramp-safe ceiling this week. */
  ceiling_km: number;
  /** What the ceiling was computed from (the trailing longest, floored). */
  anchor_km: number;
  /** True when the template is still out ahead — the card is a step toward it. */
  building: boolean;
  /** True when the weekly volume is already at the build ceiling, so no step this week. */
  weekly_build_hold: boolean;
}

/** Half a kilometre is the finest distance worth putting in front of a runner. */
function toHalfKm(km: number): number {
  return Math.round(km * 2) / 2;
}

const finite = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * The arithmetic, with no database and no side effects.
 *
 * Returns null when there is nothing to shape: a template that is not a real long
 * run, or one already at or under the ramp-safe ceiling (where the ceiling has
 * nothing to say and the template stands exactly as written).
 */
export function longRunRamp(input: LongRunRampInput): LongRunRamp | null {
  const template = finite(input.templateKm);
  if (template == null || template < LONG_RUN_MIN_KM) return null;

  const trailing = finite(input.trailingLongestKm);
  const anchor = Math.max(trailing != null && trailing > 0 ? trailing : 0, LONG_RUN_MIN_KM);

  const lastWeek = finite(input.lastWeekKm) ?? 0;
  const chronic = finite(input.chronicWeeklyKm) ?? 0;
  // A week already carrying its full sustainable build has spent this week's step.
  // Requires a real chronic base: with nothing behind it there is no ratio to be
  // over, and treating "no history" as "already ramping" would freeze a beginner at
  // the floor forever.
  const weeklyBuildHold = chronic > 0 && lastWeek >= chronic * SUSTAINABLE_WEEKLY_BUILD_FACTOR;

  const ceiling = toHalfKm(weeklyBuildHold ? anchor : anchor * SUSTAINABLE_LONG_STEP_FACTOR);
  const prescribed = Math.min(template, ceiling);
  return {
    prescribed_km: prescribed,
    template_km: template,
    ceiling_km: ceiling,
    anchor_km: Math.round(anchor * 100) / 100,
    building: prescribed < template,
    weekly_build_hold: weeklyBuildHold,
  };
}

/** Longest single logged run in the trailing window before `date`. Null-safe. */
export function trailingLongestRunKm(date: string, lookbackDays = LONG_RUN_LOOKBACK_DAYS): number | null {
  try {
    const from = addDaysISO(date, -Math.max(1, lookbackDays));
    if (!from) return null;
    const sport = activitySportWhere("activities", RUN_SPORT_PATTERNS);
    const row = db
      .prepare(
        `SELECT MAX(distance_km) AS km FROM activities
          WHERE date >= ? AND date <= ? AND distance_km IS NOT NULL AND distance_km > 0 AND (${sport.sql})`
      )
      .get(from, date, ...sport.params) as any;
    const km = Number(row?.km);
    return Number.isFinite(km) && km > 0 ? Math.round(km * 100) / 100 : null;
  } catch {
    return null;
  }
}

/**
 * The longest distance the WEEK TEMPLATE prescribes, across every plan day. This is
 * what makes "the long run" a property of the week rather than of one card: a 6 km
 * midweek aerobic run and a 12 km Sunday run are both cardio rows, and only the
 * second is the one this module shapes. Null when the template prescribes no
 * distance at all (a time-only or interval-only endurance week).
 */
export function templateLongRunKm(): number | null {
  try {
    const row = db
      .prepare(
        `SELECT MAX(target_distance_km) AS km FROM plan_items
          WHERE kind = 'cardio' AND target_distance_km IS NOT NULL AND target_distance_km > 0`
      )
      .get() as any;
    const km = Number(row?.km);
    return Number.isFinite(km) && km > 0 ? km : null;
  } catch {
    return null;
  }
}

/** The two running-volume figures the weekly brake needs, read the canonical way. */
export function runVolumeContext(date: string): { lastWeekKm: number; chronicWeeklyKm: number } {
  try {
    const acuteEnd = addDaysISO(date, -1);
    const lastWeekKm = acuteEnd ? weeklyKm(acuteEnd, 0, RUN_SPORT_PATTERNS) : 0;
    const prior = [1, 2, 3].map((weekBack) => weeklyKm(date, weekBack, RUN_SPORT_PATTERNS));
    return { lastWeekKm, chronicWeeklyKm: prior.reduce((a, b) => a + b, 0) / prior.length };
  } catch {
    return { lastWeekKm: 0, chronicWeeklyKm: 0 };
  }
}

/**
 * The whole question, answered for one date and one template distance: is this the
 * week's long run, and if so what should today's card actually say? Null means
 * "leave the item exactly as the template wrote it".
 */
export function longRunPrescription(date: string, templateKm: unknown): LongRunRamp | null {
  const template = finite(templateKm);
  if (template == null || template < LONG_RUN_MIN_KM) return null;
  const weekLongest = templateLongRunKm();
  // Only the week's OWN longest prescription is the long run. A tolerance rather
  // than equality so a 12 and a 12.0 stored through different writers still match.
  if (weekLongest == null || template < weekLongest - 0.01) return null;
  const volume = runVolumeContext(date);
  return longRunRamp({
    templateKm: template,
    trailingLongestKm: trailingLongestRunKm(date),
    lastWeekKm: volume.lastWeekKm,
    chronicWeeklyKm: volume.chronicWeeklyKm,
  });
}

// ---------- the athlete's own words for it ----------
// A ramped long run must SAY it is ramped, or the card silently contradicts the
// plan the athlete wrote and reads as a bug. Two sets, because the two cases are
// genuinely different sentences: an ordinary build step, and a week whose volume
// has already spent its step. Several phrasings each — the long run is the same
// weekday every week, so one literal would print verbatim for a whole block.
const LONG_RUN_BUILDING_NOTE: ReadonlyArray<(km: string, target: string) => string> = [
  (km, target) => `Building toward ${target} km — ${km} today, one honest step past your longest.`,
  (km, target) => `${km} km today. The plan's ${target} is where this is heading; the step gets you there.`,
  (km, target) => `A step up rather than a leap: ${km} km now, ${target} once your legs have met this one.`,
  (km, target) => `Working up to ${target} km — today's is ${km}, which is the next honest distance.`,
  (km, target) => `${km} km today, on the way to ${target}. Each week's longest earns the next one.`,
];

const LONG_RUN_HELD_NOTE: ReadonlyArray<(km: string, target: string) => string> = [
  (km, target) => `Holding at ${km} km — your week's mileage is already climbing, so ${target} waits.`,
  (km, target) => `${km} km today — this week's volume has done its building, so ${target} keeps for another week.`,
  (km, target) => `Keeping the long run at ${km} km this week; the miles around it are already up, and ${target} keeps.`,
  (km, target) => `${km} km rather than a step toward ${target} — the week is carrying enough of a build already.`,
];

/** How a ramped long run explains itself. Rotated by date like every athlete-facing line. */
export function longRunRampNote(ramp: LongRunRamp, date: string): string {
  const km = String(ramp.prescribed_km);
  const target = String(ramp.template_km);
  return ramp.weekly_build_hold
    ? pickDayVariant(LONG_RUN_HELD_NOTE, date, "long_run_ramp:held")(km, target)
    : pickDayVariant(LONG_RUN_BUILDING_NOTE, date, "long_run_ramp:building")(km, target);
}
