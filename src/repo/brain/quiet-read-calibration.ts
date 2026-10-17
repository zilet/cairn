// CALIBRATION FROM THE ATHLETE'S OWN HISTORY — per SIGNAL, not per read.
//
// The three adherence loops (read-adherence.ts: the rest ladder, the easy ladder, the
// long "trains anyway" loop) pool every quiet morning together. What they cannot say is
// WHICH signal the athlete keeps outrunning: an easy read stood on a below-band HRV
// night, the athlete trained hard, nothing afterwards said it cost him — eight times —
// and the ninth HRV morning still read "easy", because the agent was free to cite that
// same brake again (src/dayread.ts agentCautionLacksBrake only asks that the brake be
// FRESH and DECIDING), and the deterministic floor's easy read was keyed on the read,
// not on the brake under it.
//
// So this module answers one narrow question per brake field: has THIS signal, on this
// athlete, stopped predicting a quiet day? Evidence is per DATE (the rolling model reads
// one morning read per date — never the ledger's recompute rows), over the last
// QUIET_CALIBRATION_WINDOW_DAYS, from the read the athlete was actually given:
//
//   • a comparable morning is an EASY read the brake stood on (quietReadKeys), or a
//     train morning this calibration itself OPENED (`quiet_read_calibration.applied`),
//     keyed on the retired brakes (so the evidence keeps accruing once it acts, and an
//     honored or costly opened morning hands the brake back). A train morning another
//     law decided — a stated day the calendar dosed, the plan, the long loop — is never
//     evidence, even with a retired brake still on its board: it was not a quiet read the
//     athlete outran;
//     mornings the rest ladders eased are theirs, and the stated week's own dose is
//     evidence for neither direction;
//   • its answer is the SAME test every other loop and the verdict use: went above
//     easy and harmVerdictOnDay read `clean` (an override at no cost), went above easy
//     and it read `harm` (a cost), stayed at or under easy (honored), or anything
//     unanswered (`unknown`, ungraded work) — which counts for neither side;
//   • a signal RETIRES only when: at least QUIET_CALIBRATION_MIN_COMPARABLE answered
//     mornings; the rate shrunk toward a coin flip by QUIET_CALIBRATION_PRIOR_MORNINGS
//     imagined mornings is at or above QUIET_CALIBRATION_RETIRE_RATE; NO cost anywhere
//     in the window (one harmful override holds the signal for the whole window — a
//     wrong loud read is costlier than a wrong quiet one); and the newest answered
//     morning was an override (the athlete last agreeing with the read holds it).
//
// Why this exists, from the production ledger (83 judged dates, 2026-07-26..10-16): 36
// easy reads, 29 trained through with nothing afterwards saying it cost anything. 31 of
// the 33 easy reads before 2026-09-23 were the AGENT's — free, until that day's
// named-brake law, to read a train baseline quieter on any fresh deciding brake — while
// every loop acted only on the deterministic read beneath it. Since that law the agent
// must name a brake, and this module is what tells it which ones the record has retired.
//
// THE BRIDGE. Reads have published the brakes under them (`signals.deciding_brakes`) and
// the agent's named brake has reached the ledger only since this module; the mornings
// before carry no signal at all. Those LEGACY mornings form one pooled record, and while
// a brake has no keyed record of its own (no answered morning on it yet), that pooled
// record answers for it — under the SAME rule, the same floor and the same holds. The
// window ages the pool out on its own within QUIET_CALIBRATION_WINDOW_DAYS, and the first
// keyed answer about a brake replaces the pool for it, so the bridge cannot outlive the
// data it bridges.
//
// What a retired signal does is small and lives in day-read.ts: it stops being a brake
// the agent may cite to read a train day quieter (dayReadCitableBrakes), and an easy
// read the deterministic floor stood on it alone opens to the learned train read — the
// existing "train, with the caveat" path, through every one of that path's holds (a
// plan day due, the legs not saturated, no second run, no fresh word from the athlete).
// It is asked only after every floor has spoken (calendarDoseFloor: rest-grade
// readiness, a short night, the athlete's own word, anything clinical, a fresh safety
// override, an applied recovery week, an endurance-hold directive, a dose overrun, a
// longest run, a fueling hold, a calendar hold) and only of the SOFT brake fields
// below — the same body-trend and load-arithmetic set the calendar may dose. Nothing
// here can reach pain, injury, a health finding or a clinician gate.
//
// MACHINE register only: the counts and the rate are never rendered to the athlete.
import { addDaysISO, daysBetweenISO } from "../shared.js";
import { type ReadAdherenceDay, harmVerdictOnDay, readAdherenceModel } from "./read-adherence.js";

export const QUIET_CALIBRATION_WINDOW_DAYS = 56;
export const QUIET_CALIBRATION_MIN_COMPARABLE = 8;
export const QUIET_CALIBRATION_PRIOR_MORNINGS = 4;
const QUIET_CALIBRATION_PRIOR_RATE = 0.5;
// Two of every three comparable mornings went past the read at no cost, AFTER the prior
// has pulled a thin record toward a coin flip (eight-for-eight clean reads 0.83; six
// clean of eight reads 0.67 and just retires; five of eight does not).
export const QUIET_CALIBRATION_RETIRE_RATE = 2 / 3;

// The brakes a record may retire: the body's trend readings and the week's own load
// arithmetic — the calendar's soft-dose set (day-read.ts CALENDAR_SOFT_DOSE_FIELDS).
// Never sleep (a short night is a floor), a felt tap (the athlete's own word), session
// quality (their own rating), the mesocycle (structure) or anything on
// health_constraints / energy_fueling / life_capacity.
export const CALIBRATABLE_BRAKE_FIELDS: ReadonlySet<string> = new Set([
  "hrv",
  "resting_hr",
  "training_readiness",
  "acute_load",
  "hybrid_interference",
  "run_intensity_discipline",
  "generic_activity_load",
]);

export type QuietCalibrationOutcome = "clean_override" | "costly_override" | "honored" | "unknown";

export interface QuietCalibrationMorning {
  date: string;
  keys: string[];
  outcome: QuietCalibrationOutcome;
}

export interface QuietCalibrationKeyStat {
  key: string;
  answered: number;
  clean: number;
  costly: number;
  honored: number;
  // Two decimals, machine register only.
  shrunk_rate: number;
  retired: boolean;
}

export interface QuietReadCalibration {
  as_of: string;
  window_days: number;
  mornings: number;
  keys: QuietCalibrationKeyStat[];
  // Brakes retired on their OWN keyed record.
  retired: string[];
  // The pooled legacy record (mornings with no recorded signal) passes the rule — it
  // answers for any soft brake with no keyed record yet (see THE BRIDGE above).
  legacy_retires: boolean;
}

// The pooled key for a morning whose signal was never recorded. Never a brake field, so
// it can never be retired, cited or matched by name.
export const LEGACY_UNKEYED = "legacy_unkeyed";

const EMPTY = (asOf: string): QuietReadCalibration => ({
  as_of: asOf,
  window_days: QUIET_CALIBRATION_WINDOW_DAYS,
  mornings: 0,
  keys: [],
  retired: [],
  legacy_retires: false,
});

// The pure rule — what the replay test pins. One morning per DATE: a repeated date
// (a recompute, a duplicate row) keeps its LAST entry, so a churny day can never count
// twice. Only mornings strictly before `asOf` and inside the window count.
export function calibrateQuietReads(history: readonly QuietCalibrationMorning[], asOf: string): QuietReadCalibration {
  const lastClosed = addDaysISO(asOf, -1);
  const from = addDaysISO(asOf, -QUIET_CALIBRATION_WINDOW_DAYS);
  if (!lastClosed || !from) return EMPTY(asOf);
  const byDate = new Map<string, QuietCalibrationMorning>();
  for (const morning of history ?? []) {
    const date = String(morning?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > lastClosed) continue;
    byDate.set(date, morning);
  }
  const ordered = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const perKey = new Map<string, QuietCalibrationMorning[]>();
  for (const morning of ordered) {
    for (const key of new Set(Array.isArray(morning.keys) ? morning.keys : [])) {
      if (typeof key !== "string" || !key) continue;
      const list = perKey.get(key) ?? [];
      list.push(morning);
      perKey.set(key, list);
    }
  }
  const keys: QuietCalibrationKeyStat[] = [];
  for (const [key, mornings] of [...perKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const answered = mornings.filter((morning) => morning.outcome !== "unknown");
    const clean = answered.filter((morning) => morning.outcome === "clean_override").length;
    const costly = answered.filter((morning) => morning.outcome === "costly_override").length;
    const honored = answered.filter((morning) => morning.outcome === "honored").length;
    const shrunk =
      (clean + QUIET_CALIBRATION_PRIOR_MORNINGS * QUIET_CALIBRATION_PRIOR_RATE) /
      (answered.length + QUIET_CALIBRATION_PRIOR_MORNINGS);
    const retired =
      (CALIBRATABLE_BRAKE_FIELDS.has(key) || key === LEGACY_UNKEYED) &&
      answered.length >= QUIET_CALIBRATION_MIN_COMPARABLE &&
      costly === 0 &&
      shrunk >= QUIET_CALIBRATION_RETIRE_RATE &&
      answered.at(-1)?.outcome === "clean_override";
    keys.push({
      key,
      answered: answered.length,
      clean,
      costly,
      honored,
      shrunk_rate: Math.round(shrunk * 100) / 100,
      retired,
    });
  }
  return {
    as_of: asOf,
    window_days: QUIET_CALIBRATION_WINDOW_DAYS,
    mornings: ordered.length,
    keys,
    retired: keys.filter((stat) => stat.retired && stat.key !== LEGACY_UNKEYED).map((stat) => stat.key),
    legacy_retires: keys.some((stat) => stat.key === LEGACY_UNKEYED && stat.retired),
  };
}

// Is this brake retired for this athlete: on its own record, or — while it has none —
// on the pooled legacy record. Only ever a soft brake.
export function brakeRetired(calibration: QuietReadCalibration | null, field: string): boolean {
  if (!calibration || !CALIBRATABLE_BRAKE_FIELDS.has(field)) return false;
  if (calibration.retired.includes(field)) return true;
  const own = calibration.keys.find((stat) => stat.key === field);
  return calibration.legacy_retires && !(own && own.answered > 0);
}

// Does the calibration retire EVERY one of these brakes? False for an empty list: a
// read with no brake under it is not this module's question (the pooled loops own it).
export function calibrationRetiresAll(calibration: QuietReadCalibration | null, fields: readonly string[]): boolean {
  if (!calibration || !fields.length) return false;
  return fields.every((field) => brakeRetired(calibration, field));
}

// Which model days are comparable, and what each answered (see the header).
export function quietCalibrationMorning(day: ReadAdherenceDay): QuietCalibrationMorning | null {
  if (day.own_dose === true) return null;
  // No recorded signal → the pooled legacy key; a recorded empty list → no brake under
  // the read, which this module has nothing to say about.
  const keys = Array.isArray(day.quiet_keys) ? day.quiet_keys : [LEGACY_UNKEYED];
  if (!keys.length) return null;
  const comparable =
    (day.read === "easy" && !day.softened && day.learned_opened !== true) ||
    (day.read === "train" && day.calibrated === true);
  if (!comparable) return null;
  // Above easy beyond the stated week's own dose — the easy ladder's own test.
  const above = typeof day.passed_easy === "boolean" ? day.passed_easy : day.load === "hard" || day.load === "moderate";
  if (!above) {
    // Ungraded work on an easy read answers nothing (readAdherenceOutcome's `unclear`).
    if (day.read === "easy" && day.outcome === "unclear") return { date: day.date, keys, outcome: "unknown" };
    return { date: day.date, keys, outcome: "honored" };
  }
  let status: string = "unknown";
  try {
    status = harmVerdictOnDay(day.date).status;
  } catch {
    status = "unknown";
  }
  return {
    date: day.date,
    keys,
    outcome: status === "clean" ? "clean_override" : status === "harm" ? "costly_override" : "unknown",
  };
}

// The calibration as of `asOf`, off the same per-date morning model every loop reads.
// Fail-soft: any failure is "nothing retired", never an exception.
export function quietReadCalibration(asOf: string): QuietReadCalibration {
  try {
    const model = readAdherenceModel(asOf, QUIET_CALIBRATION_WINDOW_DAYS + 2, QUIET_CALIBRATION_WINDOW_DAYS + 2);
    const history: QuietCalibrationMorning[] = [];
    for (const day of model.recent) {
      const age = daysBetweenISO(asOf, day.date);
      if (age == null || age < 1 || age > QUIET_CALIBRATION_WINDOW_DAYS) continue;
      const morning = quietCalibrationMorning(day);
      if (morning) history.push(morning);
    }
    return calibrateQuietReads(history, asOf);
  } catch {
    return EMPTY(asOf);
  }
}
