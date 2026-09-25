// Who authored a Garmin activity, and what its numbers actually mean.
//
// Cairn writes strength sessions BACK to Garmin (src/garminExport.ts), so some of
// what the sync reads back is Cairn's own echo. Two of Garmin's fields mean something
// DIFFERENT on that echo than on a watch recording, and reading them the same way
// silently corrupts the athlete's own log:
//
//   • movingDuration on a Cairn-authored strength shell is the sum of the ACTIVE set
//     slots Cairn wrote (45 s apiece), not the time the athlete spent training. A
//     34-minute session came back as 6 minutes.
//   • calories on that shell is Garmin's own auto-calculation for an activity it has
//     no heart rate for — a constant 65.534 marked `isAutoCalcCalories` — or, once the
//     exporter has set it, Cairn's OWN estimate. Neither is a measurement, and summing
//     either into the day claims an energy cost nobody observed.
//
// The rules live here, pure and db-free, so the sync adapter, the exporter and the
// repair migration all read them the same way. The authorship MARKER is the anchor:
// it travels with the activity, survives our own bookkeeping being wrong, and nothing
// but Cairn writes it.

import { finite } from "../lib/numbers.js";

/** The suffix every activity Cairn creates on Garmin carries. */
export const CAIRN_ACTIVITY_MARKER = " · Cairn";

/** Garmin's own cap on an activity name. */
export const GARMIN_ACTIVITY_NAME_MAX = 80;

/**
 * The constant Garmin stores as `calories` on a manual activity it auto-calculated
 * with nothing to calculate from. Not a measurement — an artifact of the encoding.
 */
export const GARMIN_AUTOCALC_CALORIE_SENTINEL = 65.534;

/** The session's title, trimmed so the MARKER always survives the length cap. */
export function cairnShellActivityName(title: string | null | undefined): string {
  const base = String(title ?? "").trim() || "Strength";
  const room = GARMIN_ACTIVITY_NAME_MAX - CAIRN_ACTIVITY_MARKER.length;
  return `${base.slice(0, room).trim() || "Strength"}${CAIRN_ACTIVITY_MARKER}`;
}

/** Did Cairn create this activity? Read off the name it gave itself. */
export function isCairnAuthoredName(name: string | null | undefined): boolean {
  return String(name ?? "")
    .trimEnd()
    .endsWith(CAIRN_ACTIVITY_MARKER);
}

export interface GarminDurationSource {
  duration?: unknown;
  movingDuration?: unknown;
}

/**
 * How long this activity lasted, in seconds.
 *
 * For a RUN or a RIDE `movingDuration` is the better number — it drops the time the
 * athlete stood at a crossing. For STRENGTH it is not a moving time at all: the watch
 * (and Cairn's own export) reports the summed length of the ACTIVE set slots, so a
 * session with rest between sets collapses to a fraction of itself. Lifting is the
 * whole elapsed block, rest included, which is exactly `duration`.
 *
 * A Cairn-authored activity of ANY type takes `duration` for the same reason: the
 * slots are ones Cairn invented at a default length, and the only honest total is the
 * span it asked Garmin to record.
 */
export function garminActivityDurationSec(
  activity: GarminDurationSource | null | undefined,
  opts: { strength?: boolean; cairnAuthored?: boolean } = {}
): number | null {
  const elapsed = finite(activity?.duration);
  const moving = finite(activity?.movingDuration);
  if (opts.strength || opts.cairnAuthored) return elapsed ?? moving;
  return moving ?? elapsed;
}

export interface GarminCalorieSource {
  calories?: unknown;
  isAutoCalcCalories?: unknown;
}

/**
 * The calories this activity actually measured, or null when it measured none.
 *
 * Garmin auto-calculates a figure for a manual activity that carries no heart rate
 * and flags it `isAutoCalcCalories`. On an activity the ATHLETE entered by hand that
 * estimate is still theirs and is kept. On a shell CAIRN created it is never a
 * measurement, whatever it says: either Garmin's placeholder for a payload we invented,
 * or the estimate Cairn itself sent (repo/strength-energy.ts) echoing back. Both read
 * as absent. The sentinel value is treated as absent wherever it appears: it is an
 * encoding artifact, never a real 65.534 kcal.
 */
export function garminActivityCalories(
  activity: GarminCalorieSource | null | undefined,
  opts: { cairnAuthored?: boolean } = {}
): number | null {
  const calories = finite(activity?.calories);
  if (calories == null) return null;
  if (calories === GARMIN_AUTOCALC_CALORIE_SENTINEL) return null;
  if (opts.cairnAuthored) return null;
  return calories;
}
