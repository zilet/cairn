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

/** How many weeks before the race peak weekly volume lands. */
const PEAK_WEEKS_OUT = 2;
/** Taper shape, as fractions of peak weekly volume. */
const RACE_WEEK_FRACTION = 0.45;
const FINAL_TAPER_FRACTION = 0.7;
/** A reset week every 4th, counting back from the peak. */
const DOWN_WEEK_EVERY = 4;
const DOWN_WEEK_FRACTION = 0.75;
/** Long-run peak lands here, i.e. 3 weeks out, and holds through the peak week. */
const LONG_PEAK_WEEKS_OUT = 3;
/** A long run is at most this share of the race distance, and never over 20 km. */
const LONG_PEAK_OF_DISTANCE = 0.85;
const LONG_PEAK_CEILING_KM = 20;

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
  /** Weeks between today and race day (0 = race week). */
  weeks_to_race: number;
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

function round1(n: number): number {
  return Math.round(n * 10) / 10;
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
 * What this week has to look like for the build to arrive at peak volume by two
 * weeks out — and whether that is reachable at all.
 *
 * The sustained step is geometric from the CURRENT anchor to the peak, and it
 * pays for the scheduled reset weeks on the way: a week at 0.75× is ground the
 * remaining build weeks have to climb back, so the factor is solved over the
 * build weeks alone rather than pretending a reset is free. That is what makes
 * a short runway read as short instead of comfortable.
 *
 * Returns null when there is nothing to ramp toward — no dated race, a race
 * already past, no distance, or a distance short enough that mileage is not the
 * limiter.
 */
export function raceRamp(
  goal: RaceRampGoal | null | undefined,
  todayISO: string,
  anchorKm: number,
  prevLongKm: number
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

  // --- the sustained weekly step arriving on time would take ---
  // Steps from the anchor to the peak week: this week, then one per week down to
  // two weeks out. The reset weeks in that span are subtracted from the weeks
  // that can build, and their cumulative 0.75× is added to the ground to cover.
  let needed = 1;
  if (weeks > PEAK_WEEKS_OUT && peak > anchor) {
    const totalSteps = weeks - 1;
    const downCount = Math.floor((weeks - PEAK_WEEKS_OUT) / DOWN_WEEK_EVERY);
    const buildSteps = Math.max(1, totalSteps - downCount);
    const ground = peak / anchor / DOWN_WEEK_FRACTION ** downCount;
    needed = ground ** (1 / buildSteps);
  }
  const needed_build_factor = Math.round(needed * 1000) / 1000;
  const feasible = needed_build_factor <= SUSTAINABLE_WEEKLY_BUILD_FACTOR + 1e-9;

  // --- what the IDEAL curve would ask of this week ---
  // Comparison only. Nothing downstream prescribes this number: when it is out of
  // reach it is exactly the quota this module must never hand an athlete.
  const ideal_required_km =
    weeks <= 0
      ? round1(peak * RACE_WEEK_FRACTION)
      : weeks === 1
        ? round1(peak * FINAL_TAPER_FRACTION)
        : weeks === PEAK_WEEKS_OUT
          ? round1(peak)
          : round1(anchor * (downWeek ? DOWN_WEEK_FRACTION : needed));

  // --- the CONSTRAINED trajectory: the fastest SAFE path from where they are ---
  // Every week takes the largest step the body is allowed (or a scheduled reset),
  // from today's real anchor, and never past the destination. Where that lands on
  // race week is what this athlete's current running can actually support — which
  // is the honest thing to compare a finish time against, and the only thing the
  // plan is ever allowed to ask for.
  const constrained_peak_km = (() => {
    let km = anchor;
    for (let w = weeks; w >= PEAK_WEEKS_OUT; w--) {
      km *= isRampDownWeek(w) ? DOWN_WEEK_FRACTION : SUSTAINABLE_WEEKLY_BUILD_FACTOR;
    }
    return round1(Math.min(peak, Math.max(anchor, km)));
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
    weeks <= 0
      ? round1(anchor * RACE_WEEK_FRACTION)
      : weeks === 1
        ? round1(anchor * FINAL_TAPER_FRACTION)
        : round1(Math.min(safeStepKm, ideal_required_km));

  // --- this week's long run ---
  // Anchored on what the athlete has DEMONSTRATED, not on a share of the week:
  // a comfortable 9 km already run is the floor the curve climbs from. With no
  // long run on record, a conservative share of the weekly anchor seeds it. The
  // ideal curve is then held to the same one-safe-step rule as the weekly volume.
  const longBase = Number.isFinite(prevLongKm) && prevLongKm > 0 ? prevLongKm : Math.max(3, anchor * 0.3);
  let idealLongKm: number;
  if (weeks <= 0) {
    idealLongKm = round1(longPeak * 0.3);
  } else if (weeks === 1) {
    idealLongKm = round1(longPeak * 0.55);
  } else if (weeks <= LONG_PEAK_WEEKS_OUT) {
    idealLongKm = round1(Math.max(longBase, longPeak));
  } else if (longPeak <= longBase) {
    idealLongKm = round1(longBase);
  } else {
    const steps = Math.max(1, weeks - PEAK_WEEKS_OUT);
    idealLongKm = round1(longBase * (longPeak / longBase) ** (1 / steps));
  }
  const required_long_km =
    weeks <= 1 ? idealLongKm : round1(Math.min(idealLongKm, longBase * SUSTAINABLE_LONG_STEP_FACTOR));

  return {
    weeks_to_race: weeks,
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
