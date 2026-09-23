import { round1 } from "../lib/numbers.js";
// ============================================================================
// run-ramp.ts — the GOAL-ANCHORED half of run planning, as pure arithmetic.
//
// weeklyRunPlan (run-progression.ts) is reactive by construction: it anchors on
// what the athlete actually ran and steps ~10% off it. That is the right floor
// and the wrong ceiling — an athlete with a dated race and a time target has a
// destination, and a purely reactive build never notices it is not going to
// arrive. A 21.1 km race wants a peak somewhere near 40 km/wk; stepping 10% off
// 12 km/wk with 13 weeks left reaches ~40 only if nothing ever eases, and the
// plan never said so.
//
// So this module answers ONE question with no side effects and no database:
// given the race, today, what the athlete last ran and their recent longest run,
// what would THIS week have to look like for the build to arrive on time — and
// is that reachable at all inside the sustainable weekly step?
//
// It is deliberately pure so the arithmetic is unit-testable in isolation and so
// no consumer can accidentally make it a source of truth about the athlete's
// state: every input is passed in. It never returns a score, never returns a
// verdict, and `feasible:false` is information for an honest sentence — the
// suggestion still stands, it just says what it is.
// ============================================================================

/**
 * The hard ceiling on ONE week's volume step, and the bar a sustained build is
 * measured against. Connective tissue pays for optimism on a slower clock than
 * the aerobic system, so a race timeline that would need a bigger sustained step
 * than this is reported as out of reach rather than quietly prescribed.
 *
 * This is the home of the number: run-progression.ts imports it as its own
 * MAX_WEEKLY_BUILD_FACTOR so the ceiling the plan enforces and the ceiling the
 * ramp measures against can never drift apart.
 */
export const SUSTAINABLE_WEEKLY_BUILD_FACTOR = 1.12;

/**
 * The same rule for the long run: one step past the longest they have actually
 * done. Held here beside the weekly ceiling because the constrained trajectory
 * below uses both, and run-progression.ts caps the prescribed long run with it.
 */
export const SUSTAINABLE_LONG_STEP_FACTOR = 1.15;

/**
 * How many CALENDAR weeks before race week peak weekly volume lands. Every count
 * that shapes the arrival (race week 0, the final taper week 1, the peak week 2,
 * the long-run peak 3) is read in calendar weeks to the race's own Monday — see
 * `weeksToRaceWeek`.
 */
const PEAK_WEEKS_OUT = 2;
/** Taper shape, as fractions of peak weekly volume. */
const RACE_WEEK_FRACTION = 0.45;
const FINAL_TAPER_FRACTION = 0.7;
/** A reset week every 4th, counting back from the peak. */
const DOWN_WEEK_EVERY = 4;
const DOWN_WEEK_FRACTION = 0.75;
/**
 * A reset is recovery, not lost ground: the week after one steps off the level the
 * reset paused (the week before it), not off the reset itself — PROVIDED the reset
 * week was actually run as a lighter week. Below this share of the paused level it
 * was an absence (illness, a trip), and the ordinary reactive anchor stands.
 * weeklyRunPlan and the race-build ladder read the same number.
 */
export const RESET_TAKEN_FRACTION = 0.6;
/** Long-run peak lands here, i.e. 3 weeks out, and holds through the peak week. */
const LONG_PEAK_WEEKS_OUT = 3;
/** A long run is at most this share of the race distance, and never over 20 km. */
const LONG_PEAK_OF_DISTANCE = 0.85;
const LONG_PEAK_CEILING_KM = 20;

// ---- how a week's volume is carried by its runs ------------------------------
// weeklyRunPlan distributes a week's kilometres across its runs within per-run caps,
// and the race ladder and the fit read have to know what those caps let a week hold —
// or the ladder promises a 41 km week the engine can only fill to 31. The numbers
// live here, beside the weekly step, so the engine that prescribes a week and the
// reads that project one share them.

/** A lone easy run with no quality session beside it is recovery: this band, never a second long run. */
export const RECOVERY_EASY_CAP_KM = 7;
/** The quality session's share of the week, and its floor. */
export const QUALITY_WEEK_SHARE = 0.18;
const QUALITY_MIN_KM = 5;
/** The long run never carries more than this share of the week. */
export const LONG_RUN_WEEK_SHARE_CAP = 0.55;
/** A single easy run that carries the week's aerobic volume: at most this share of the week… */
const EASY_RUN_WEEK_SHARE_CAP = 0.35;
/** …clearly shorter than the long run… */
const EASY_RUN_OF_LONG_CAP = 0.7;
// …and one step past the longest mid-week run already run (SUSTAINABLE_LONG_STEP_FACTOR,
// the same one-step rule the long run lives by).

/** The runs a week is made of, beyond its long run. */
export interface RunWeekShape {
  easy_runs: number;
  quality: boolean;
}

/** The recovery band a lone easy run sits in when it is recovery (no quality beside it). */
export function recoveryEasyCapKm(longKm: number): number {
  return round1(Math.min(RECOVERY_EASY_CAP_KM, Math.max(3, longKm * EASY_RUN_OF_LONG_CAP)));
}

/**
 * How far a LONE easy run may go on a week that also carries a quality session. On
 * that week the easy run is not recovery — it is the aerobic volume day between the
 * quality and the long run, and a flat 7 km cap left a three-run week unable to hold
 * the volume the build asked of it (the kilometres were simply dropped). So the cap
 * scales with the week (≤ 35% of it), stays clearly under the long run (≤ 70% of it),
 * and never goes more than one step past the longest mid-week run the athlete has
 * actually run (`demonstratedMidweekKm`). It never drops below the recovery band it
 * replaced, and with no mid-week run on record it IS that band.
 */
export function easyRunCapKm(weeklyKm: number, longKm: number, demonstratedMidweekKm: number | null | undefined): number {
  const floor = recoveryEasyCapKm(longKm);
  const shown = Number(demonstratedMidweekKm);
  if (!(Number.isFinite(shown) && shown > 0)) return floor;
  const scaled = Math.min(
    shown * SUSTAINABLE_LONG_STEP_FACTOR,
    weeklyKm * EASY_RUN_WEEK_SHARE_CAP,
    longKm * EASY_RUN_OF_LONG_CAP
  );
  return round1(Math.max(floor, scaled));
}

/** The quality session's distance for a week of `weeklyKm` (the engine's qualitySpec floor for pace work). */
export function qualityRunKm(weeklyKm: number): number {
  return round1(Math.max(QUALITY_MIN_KM, weeklyKm * QUALITY_WEEK_SHARE));
}

/**
 * What a week of `shape` actually prescribes when asked for `weeklyKm` around a long
 * run of `longKm` — the same per-run caps weeklyRunPlan distributes under. The long
 * run keeps its share cap, the quality session its share, and the easy runs take the
 * remainder up to their cap; kilometres past the caps stay unspent rather than piling
 * onto the long run. Pure: the ladder walks it week by week, and the fit read uses it
 * to say where the build really lands.
 */
export function deliverableRunWeek(
  weeklyKm: number,
  longKm: number,
  shape: RunWeekShape,
  demonstratedMidweekKm: number | null | undefined
): { km: number; long_km: number; quality_km: number; easy_km: number } {
  const w = Math.max(0, weeklyKm);
  const long = round1(Math.min(Math.max(0, longKm), w * LONG_RUN_WEEK_SHARE_CAP));
  const quality = shape.quality ? qualityRunKm(w) : 0;
  const easyRuns = Math.max(0, Math.round(shape.easy_runs));
  let easy = 0;
  if (easyRuns > 0) {
    easy = round1(Math.max(3, (w - long - quality) / easyRuns));
    if (easyRuns === 1) {
      easy = Math.min(easy, shape.quality ? easyRunCapKm(w, long, demonstratedMidweekKm) : recoveryEasyCapKm(long));
    }
    easy = round1(Math.min(easy, Math.max(long, 3)));
  }
  return { km: round1(long + quality + easyRuns * easy), long_km: long, quality_km: quality, easy_km: easy };
}

/**
 * The most a prescribed week may carry against the four closed weeks before it, as a
 * multiple of their mean. program-state reads a week at 1.5× that mean as "spiking"
 * and the engine then holds, drops the quality session and cuts the long run — so a
 * week the engine itself prescribed must stay clear of that bar, or running it as
 * written trips the brake the very next Monday (a resume off a reset after a light
 * stretch did exactly that: 24 → 35.5 km, then a held week). The margin under 1.5
 * absorbs the brake's trailing seven-day window not lining up with Mon–Sun.
 */
export const PRESCRIBED_ACWR_CEILING = 1.4;

/**
 * The ACWR headroom for the week after `priorWeeksKm` (the closed weeks before it,
 * most recent last; the last four count). Null when there is no real chronic base to
 * measure against — fewer than three of the four weeks with running, or a mean under
 * `chronicFloorKm` — the same low-base guard the spike read applies, under which no
 * spike is ever read and so nothing needs holding back.
 */
export function acwrCeilingKm(priorWeeksKm: readonly number[], chronicFloorKm: number): number | null {
  const four = priorWeeksKm.slice(-4).map((k) => (Number.isFinite(k) && k > 0 ? k : 0));
  if (four.length < 4) return null;
  const chronic = four.reduce((a, b) => a + b, 0) / 4;
  if (four.filter((k) => k > 0).length < 3 || chronic < chronicFloorKm) return null;
  return round1(chronic * PRESCRIBED_ACWR_CEILING);
}

/** What `raceRamp` needs to say where the build lands in the runs the week really has. */
export interface RaceRampCapacity {
  shape: RunWeekShape;
  /** The longest recent run that was not its week's long run, km. */
  demonstratedMidweekKm?: number | null;
}

/** The minimal shape of an endurance goal this module needs. */
export interface RaceRampGoal {
  is_race?: boolean;
  date?: string | null;
  distance_km?: number | null;
  target?: string | null;
  weeks_to_race?: number | null;
  phase?: string | null;
}

/**
 * How the athlete's reachable trajectory sits against what the race distance and
 * time usually lean on. A FIT, never a grade — see the note on `fit` below.
 */
export type RaceRampFit = "fits" | "stretch" | "beyond_horizon";

export interface RaceRamp {
  /** Weeks between today and race day, ceil(days/7) — the count the reset cadence and the rationale speak. */
  weeks_to_race: number;
  /**
   * Calendar weeks from today's week to the week holding the race (0 = race week,
   * 1 = the final taper week, 2 = the peak week) — the count the arrival is shaped
   * by. Equals `weeks_to_race` for a race on a Monday, one less on any other day.
   */
  weeks_to_race_week: number;
  /** One of the two taper weeks: the final taper week or race week itself. */
  taper_week: boolean;
  /**
   * This week's ask, km — from the CONSTRAINED trajectory, so it is always
   * something the athlete can reach in one safe step from where they are.
   */
  required_km: number;
  /** This week's long run, km, held to the same one-safe-step rule. */
  required_long_km: number;
  /**
   * What the ideal arrival curve would have wanted this week. Comparison only:
   * nothing prescribes this, because when it is out of reach it is a quota.
   */
  ideal_required_km: number;
  /** The weekly volume the race distance usually leans on, km. */
  ideal_peak_km: number;
  /** Where the fastest SAFE build from today's anchor actually lands by race week, km. */
  constrained_peak_km: number;
  /** The longest single run the ideal curve climbs toward, km. */
  peak_long_km: number;
  /** Is this a scheduled reset week on the ramp's own cadence? */
  down_week: boolean;
  /** The sustained weekly step the ideal curve would take. */
  needed_build_factor: number;
  /** False when the IDEAL curve would need a sustained step above the ceiling. */
  feasible: boolean;
  /**
   * Where the reachable trajectory lands against the ideal peak: it reaches it
   * ("fits"), comes close ("stretch", within ~15%), or lands somewhere else
   * entirely ("beyond_horizon"). An athlete whose life will not hold 40 km weeks
   * is not failing at anything; this only decides which sentence gets said.
   */
  fit: RaceRampFit;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Whole weeks from today to the race, matching getEnduranceGoal's ceil(days/7). */
function weeksBetween(todayISO: string, raceISO: string): number | null {
  const a = Date.parse(`${String(todayISO).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(raceISO).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.ceil(Math.round((b - a) / 864e5) / 7);
}

/**
 * Calendar weeks from `todayISO`'s Monday to the Monday of the week holding the
 * race. The arrival is shaped in THESE, not in ceil(days/7): from a Monday,
 * ceil(days/7) calls the week of a Sunday race "1 week out", so every arrival rung
 * sat a week late — peak volume landed the week immediately before race week, and
 * race week itself took only the final-taper step. A half wants its peak ~3 weeks
 * before race day, a trimmed week, then race week.
 */
function weeksToRaceWeek(todayISO: string, raceISO: string): number | null {
  const monday = (iso: string): number => {
    const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5;
  };
  const a = monday(todayISO);
  const b = monday(raceISO);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / (7 * 864e5));
}

/**
 * Peak weekly volume a race distance asks for. Bands rather than one multiple:
 * a 5–10 km race is a higher multiple of its own distance than a marathon, and
 * both are clamped so neither end produces a number nobody should train at.
 * Under 8 km there is no meaningful volume ramp — a parkrun is trained by
 * quality and consistency, not by a mileage curve — so those return null and
 * the reactive plan is left alone entirely.
 */
export function peakWeeklyKm(distanceKm: number): number | null {
  if (!Number.isFinite(distanceKm) || distanceKm < 8) return null;
  if (distanceKm >= 15) return round1(clamp(2.0 * distanceKm, 25, 45));
  return round1(clamp(2.2 * distanceKm, 20, 40));
}

/** The longest single run the build climbs to for a race distance. */
export function peakLongKm(distanceKm: number): number {
  return round1(Math.min(LONG_PEAK_OF_DISTANCE * distanceKm, LONG_PEAK_CEILING_KM));
}

/**
 * Is the week `weeksOut` from the race a scheduled reset on the ramp's cadence?
 * Counted BACK from the peak week so the cadence is anchored to the race rather
 * than to an arbitrary calendar ordinal, and the peak week itself never resets.
 */
function isRampDownWeek(weeksOut: number): boolean {
  const stepsFromPeak = weeksOut - PEAK_WEEKS_OUT;
  return stepsFromPeak > 0 && stepsFromPeak % DOWN_WEEK_EVERY === 0;
}

/**
 * Was the week holding `dateISO` one of the ramp's scheduled reset weeks? The same
 * cadence `raceRamp().down_week` reads, asked of another week — weeklyRunPlan asks it
 * of LAST week, because the week after a reset steps off the level the reset paused,
 * not off the reset itself. False with no dated race to count to.
 */
export function isRampDownWeekOn(goal: RaceRampGoal | null | undefined, dateISO: string): boolean {
  if (!goal || goal.is_race === false || !goal.date) return false;
  const distance = Number(goal.distance_km);
  if (!Number.isFinite(distance) || peakWeeklyKm(distance) == null) return false;
  const weeks = weeksBetween(dateISO, goal.date);
  return weeks != null && weeks >= 0 && isRampDownWeek(weeks);
}

/**
 * One week of the long-run curve: from `longBase` (the long run already run) toward
 * the race's long-run peak, `out` calendar weeks from race week, held to one safe
 * step. raceRamp's `required_long_km`, and the long run its fit walk carries.
 */
function longRunStep(longBase: number, out: number, longPeak: number): number {
  let idealLongKm: number;
  if (out <= 0) {
    idealLongKm = round1(longPeak * 0.3);
  } else if (out === 1) {
    idealLongKm = round1(longPeak * 0.55);
  } else if (out <= LONG_PEAK_WEEKS_OUT) {
    idealLongKm = round1(Math.max(longBase, longPeak));
  } else if (longPeak <= longBase) {
    idealLongKm = round1(longBase);
  } else {
    const steps = Math.max(1, out - PEAK_WEEKS_OUT);
    idealLongKm = round1(longBase * (longPeak / longBase) ** (1 / steps));
  }
  return out <= 1 ? idealLongKm : round1(Math.min(idealLongKm, longBase * SUSTAINABLE_LONG_STEP_FACTOR));
}

/**
 * What this week has to look like for the build to arrive at peak volume by two
 * weeks out — and whether that is reachable at all.
 *
 * The sustained step is geometric from the CURRENT anchor to the peak, solved over
 * the weeks that build. A scheduled reset week does not build — but it is recovery,
 * not lost ground: the week after it steps off the level the reset paused
 * (RESET_TAKEN_FRACTION, the rule weeklyRunPlan and the ladder already follow), so
 * the reset costs the build one week of stepping and nothing more. (Modelling it as
 * a 0.75× the remaining weeks had to climb back charged every reset ~25% of the
 * base a second time, and read a build that arrives as one that cannot.) The weeks
 * are counted in CALENDAR weeks to race week, like the arrival itself: this week
 * through the peak week, never the final taper week.
 *
 * `capacity` — the runs the athlete's week is made of — makes the fit read say where
 * the build lands in THOSE runs (`deliverableRunWeek`), not in a volume a three-run
 * week cannot hold. Without it the walk is volume only.
 *
 * Returns null when there is nothing to ramp toward — no dated race, a race
 * already past, no distance, or a distance short enough that mileage is not the
 * limiter.
 */
export function raceRamp(
  goal: RaceRampGoal | null | undefined,
  todayISO: string,
  anchorKm: number,
  prevLongKm: number,
  capacity?: RaceRampCapacity | null
): RaceRamp | null {
  if (!goal || goal.is_race === false) return null;
  const distance = Number(goal.distance_km);
  const peak = Number.isFinite(distance) ? peakWeeklyKm(distance) : null;
  if (peak == null) return null;

  const fromDate = goal.date ? weeksBetween(todayISO, goal.date) : null;
  const weeks = fromDate ?? (Number.isFinite(Number(goal.weeks_to_race)) ? Number(goal.weeks_to_race) : null);
  if (weeks == null) return null;
  if (
    goal.date &&
    Date.parse(`${String(goal.date).slice(0, 10)}T00:00:00Z`) < Date.parse(`${String(todayISO).slice(0, 10)}T00:00:00Z`)
  ) {
    return null; // the race is behind us — nothing to ramp toward
  }
  if (weeks < 0) return null;

  const anchor = Number.isFinite(anchorKm) && anchorKm > 0 ? anchorKm : 6;
  const longPeak = peakLongKm(distance);
  const downWeek = isRampDownWeek(weeks);
  // The arrival — race week, the final taper week, the peak — is shaped in CALENDAR
  // weeks to race week (see weeksToRaceWeek), and so is the feasibility walk below.
  // The reset CADENCE keeps the ceil count, so a reset week never moves under an
  // athlete already in it.
  const out = (goal.date ? weeksToRaceWeek(todayISO, goal.date) : null) ?? weeks;
  // The weeks from this one through the peak week, each with its ceil count so the
  // walk asks the same reset cadence the plan follows. `weeks - out` is 0 for a race
  // on a Monday and 1 on any other day.
  const stepWeeks: number[] = [];
  for (let o = out; o >= PEAK_WEEKS_OUT; o--) stepWeeks.push(o + (weeks - out));

  // --- the sustained weekly step arriving on time would take ---
  // Solved over the weeks that build: the resets in the span pause the build, they
  // do not take ground away (see the note above).
  let needed = 1;
  if (out > PEAK_WEEKS_OUT && peak > anchor) {
    const buildSteps = Math.max(1, stepWeeks.filter((w) => !isRampDownWeek(w)).length);
    needed = (peak / anchor) ** (1 / buildSteps);
  }
  const needed_build_factor = Math.round(needed * 1000) / 1000;
  const feasible = needed_build_factor <= SUSTAINABLE_WEEKLY_BUILD_FACTOR + 1e-9;

  // --- what the IDEAL curve would ask of this week ---
  // Comparison only. Nothing downstream prescribes this number: when it is out of
  // reach it is exactly the quota this module must never hand an athlete.
  const ideal_required_km =
    out <= 0
      ? round1(peak * RACE_WEEK_FRACTION)
      : out === 1
        ? round1(peak * FINAL_TAPER_FRACTION)
        : out === PEAK_WEEKS_OUT
          ? round1(peak)
          : round1(anchor * (downWeek ? DOWN_WEEK_FRACTION : needed));

  // --- the CONSTRAINED trajectory: the fastest SAFE path from where they are ---
  // Every week takes the largest step the body is allowed (or a scheduled reset),
  // from today's real anchor, and never past the destination. Where that lands on
  // race week is what this athlete's current running can actually support — which
  // is the honest thing to compare a finish time against, and the only thing the
  // plan is ever allowed to ask for.
  //
  // A reset week pauses the walk (the level resumes after it), and with `capacity`
  // each build week holds only what its runs can carry — the engine anchors the next
  // week on what was run, so that is the level the walk steps on from.
  //
  // In the taper there is no build left to walk: the peak has already happened, and
  // it is read back off the anchor (last week WAS the peak week, or the final taper
  // week at its share of it) rather than walked forward from a taper week.
  const longBase = Number.isFinite(prevLongKm) && prevLongKm > 0 ? prevLongKm : Math.max(3, anchor * 0.3);
  const constrained_peak_km = (() => {
    if (out <= 0) return round1(Math.min(peak, anchor / FINAL_TAPER_FRACTION));
    if (out === 1) return round1(Math.min(peak, anchor));
    let level = anchor;
    let long = longBase;
    let shownMidweek = Number(capacity?.demonstratedMidweekKm) > 0 ? Number(capacity?.demonstratedMidweekKm) : 0;
    stepWeeks.forEach((w, i) => {
      if (isRampDownWeek(w)) return;
      long = longRunStep(long, out - i, longPeak);
      let km = Math.min(peak, level * SUSTAINABLE_WEEKLY_BUILD_FACTOR);
      if (capacity) {
        const carried = deliverableRunWeek(km, long, capacity.shape, shownMidweek || null);
        km = Math.min(km, carried.km);
        shownMidweek = Math.max(shownMidweek, carried.easy_km, carried.quality_km);
      }
      level = km;
    });
    return round1(Math.min(peak, capacity ? level : Math.max(anchor, level)));
  })();

  // How the two compare, in three plain bands. This is a FIT, never a grade: an
  // athlete whose life will not hold 40 km weeks is not failing at anything, and
  // the only thing this decides is which sentence gets said.
  const reach = peak > 0 ? constrained_peak_km / peak : 1;
  const fit: RaceRampFit = reach >= 1 - 1e-9 ? "fits" : reach >= 0.85 ? "stretch" : "beyond_horizon";

  // --- this week's ask, from the CONSTRAINED trajectory ---
  // The largest safe step, and never more than the ideal curve wanted anyway (a
  // race twenty weeks out has no business demanding the ceiling every week just
  // because the ceiling exists). Taper weeks step DOWN from the anchor, which is
  // reachable by construction.
  const safeStepKm = round1(anchor * (downWeek ? DOWN_WEEK_FRACTION : SUSTAINABLE_WEEKLY_BUILD_FACTOR));
  const required_km =
    out <= 0
      ? round1(anchor * RACE_WEEK_FRACTION)
      : out === 1
        ? round1(anchor * FINAL_TAPER_FRACTION)
        : round1(Math.min(safeStepKm, ideal_required_km));

  // --- this week's long run ---
  // Anchored on what the athlete has DEMONSTRATED, not on a share of the week:
  // a comfortable 9 km already run is the floor the curve climbs from. With no
  // long run on record, a conservative share of the weekly anchor seeds it. The
  // ideal curve is then held to the same one-safe-step rule as the weekly volume.
  const required_long_km = longRunStep(longBase, out, longPeak);

  return {
    weeks_to_race: weeks,
    weeks_to_race_week: out,
    taper_week: out <= 1,
    required_km,
    required_long_km,
    ideal_required_km,
    ideal_peak_km: round1(peak),
    constrained_peak_km,
    peak_long_km: longPeak,
    down_week: downWeek,
    needed_build_factor,
    feasible,
    fit,
  };
}
