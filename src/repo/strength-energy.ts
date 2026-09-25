// What a finished Cairn strength session plausibly cost, for GARMIN's calendar only.
//
// A session Cairn writes back as a manual shell (src/garminExport.ts) carries no
// heart rate, so Garmin fills its calories with a 65.534 kcal placeholder. This is a
// defensible replacement: gross kcal = MET × bodyweight kg × hours, the same GROSS
// convention Garmin's own activity calories use (resting energy included).
//
// It is NEVER an input to Cairn's own energy math. The day totals that feed the
// expenditure prior are read with every Cairn shell's contribution taken back out
// (repo/garmin-shell-energy.ts), so this number can only ever reach Garmin, never
// echo back into the athlete's TDEE.
//
// MET values, 2024 Adult Compendium of Physical Activities (conditioning exercise):
//   02054  3.5  resistance (weight) training, multiple exercises, 8–15 reps at varied
//               resistance — the default
//   02052  5.0  resistance (weight) training, squats, deadlift, slow or explosive effort —
//               when loaded squat/hinge compounds are at least half the working sets
//   02055  5.8  resistance training, circuit, reciprocal supersets — when the set
//               timestamps show paired/circuit density (see CIRCUIT_* below)

import { db } from "../db.js";
import { resolvedCurrentBodyweight } from "./bodyweight.js";
import { classifyPattern } from "./exercise-variations.js";
import { isAccessoryRegion, movementRegionKey } from "./movement-region.js";
import { getProfile } from "./profile.js";
import { LB_PER_KG } from "./shared.js";

export const STRENGTH_MET = {
  general: { met: 3.5, code: "02054" },
  heavy_compound: { met: 5.0, code: "02052" },
  circuit: { met: 5.8, code: "02055" },
} as const;

export type StrengthEnergyBasis = keyof typeof STRENGTH_MET;

/** Loaded squat/hinge work must be at least this share of the working sets. */
export const HEAVY_COMPOUND_SHARE = 0.5;
/**
 * Straight sets with 2–3 minutes of rest run ~0.25–0.35 sets per minute. Paired sets
 * and circuits (short transitions, the partner lift as the "rest") run at 0.5 or more.
 * Above ~1.2 per minute the timestamps are batch logging, not training, and prove
 * nothing. The density must hold across at least CIRCUIT_MIN_SETS over at least
 * CIRCUIT_MIN_SPAN_MIN, so a burst of three quick sets never reads as a circuit.
 */
export const CIRCUIT_MIN_SETS_PER_MIN = 0.5;
export const CIRCUIT_MAX_SETS_PER_MIN = 1.2;
export const CIRCUIT_MIN_SETS = 10;
export const CIRCUIT_MIN_SPAN_MIN = 15;
/**
 * The working time a set list can account for: ~3.5 minutes per set (the set plus
 * its rest) and ~8 minutes of warm-up. A session left open (108 minutes for 12 sets)
 * is capped here instead of billing the athlete's drive home.
 */
export const MINUTES_PER_SET = 3.5;
export const WARMUP_MIN = 8;

export interface StrengthEnergySet {
  exercise: string;
  muscle_group?: string | null;
  mode?: string | null;
  /** Cairn pounds; negative = assisted, null = bodyweight. */
  weight?: number | null;
  reps?: number | null;
  duration_sec?: number | null;
  /** SQLite UTC "YYYY-MM-DD HH:MM:SS" (logged_sets.created_at). */
  created_at?: string | null;
}

export interface StrengthEnergyEstimate {
  kcal: number;
  met: number;
  minutes: number;
  bodyweight_kg: number;
  basis: StrengthEnergyBasis;
  compendium_code: string;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A set that did work: reps logged, or a timed hold with a duration. */
function isWorkingSet(set: StrengthEnergySet): boolean {
  const reps = num(set.reps);
  const seconds = num(set.duration_sec);
  return (reps != null && reps > 0) || (seconds != null && seconds > 0);
}

function isHeavyLowerCompound(set: StrengthEnergySet): boolean {
  const weight = num(set.weight);
  // Assisted (negative) and bodyweight (null) are never "heavy loaded" work.
  if (weight == null || weight <= 0) return false;
  const name = String(set.exercise ?? "");
  const pattern = classifyPattern(name, set.muscle_group ?? undefined);
  if (pattern !== "squat" && pattern !== "hinge") return false;
  // A leg curl files as a hinge and a leg extension as a squat in the swap table;
  // their region says they are isolation work.
  return !isAccessoryRegion(movementRegionKey(name, set.muscle_group ?? null));
}

function stampMs(stamp: string | null | undefined): number | null {
  const raw = String(stamp ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) return null;
  const normalized = raw.replace(" ", "T");
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function isCircuitDensity(sets: StrengthEnergySet[]): boolean {
  const times = sets
    .map((set) => stampMs(set.created_at))
    .filter((ms): ms is number => ms != null)
    .sort((a, b) => a - b);
  if (times.length < CIRCUIT_MIN_SETS) return false;
  const spanMin = (times[times.length - 1] - times[0]) / 60000;
  if (spanMin < CIRCUIT_MIN_SPAN_MIN) return false;
  const perMin = (times.length - 1) / spanMin;
  return perMin >= CIRCUIT_MIN_SETS_PER_MIN && perMin <= CIRCUIT_MAX_SETS_PER_MIN;
}

/**
 * The pure core: no DB, so MET selection, the open-session cap and the null cases are
 * unit-testable. Null when there is no bodyweight or no working set to bill.
 */
export function estimateStrengthKcal(input: {
  sets: StrengthEnergySet[];
  duration_min?: number | null;
  bodyweight_kg?: number | null;
}): StrengthEnergyEstimate | null {
  const kg = num(input.bodyweight_kg);
  if (kg == null || kg <= 0) return null;
  const working = (input.sets ?? []).filter((set) => set && isWorkingSet(set));
  if (!working.length) return null;

  let basis: StrengthEnergyBasis = "general";
  if (isCircuitDensity(working)) basis = "circuit";
  else if (working.filter(isHeavyLowerCompound).length / working.length >= HEAVY_COMPOUND_SHARE) {
    basis = "heavy_compound";
  }

  const cap = working.length * MINUTES_PER_SET + WARMUP_MIN;
  const duration = num(input.duration_min);
  const minutes = Math.round((duration != null && duration > 0 ? Math.min(duration, cap) : cap) * 10) / 10;
  const { met, code } = STRENGTH_MET[basis];
  return {
    kcal: Math.round(met * kg * (minutes / 60)),
    met,
    minutes,
    bodyweight_kg: Math.round(kg * 10) / 10,
    basis,
    compendium_code: code,
  };
}

/**
 * The estimate for one stored session. Bodyweight is Cairn's canonical reading AS OF
 * the session's date, so a later weigh-in never re-prices an old session (and never
 * re-sends its calories).
 */
export function estimateStrengthSessionKcal(sessionId: number): StrengthEnergyEstimate | null {
  const session = db.prepare(`SELECT date, duration_min FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!session) return null;
  const sets = (
    db
      .prepare(
        `SELECT e.name AS exercise, e.muscle_group AS muscle_group, e.mode AS mode,
                ls.weight AS weight, ls.reps AS reps, ls.duration_sec AS duration_sec, ls.created_at AS created_at
           FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
          WHERE ls.session_id = ?
          ORDER BY ls.id`
      )
      .all(sessionId) as any[]
  ).map((row) => ({
    exercise: String(row.exercise ?? ""),
    muscle_group: row.muscle_group == null ? null : String(row.muscle_group),
    mode: row.mode == null ? null : String(row.mode),
    weight: num(row.weight),
    reps: num(row.reps),
    duration_sec: num(row.duration_sec),
    created_at: row.created_at == null ? null : String(row.created_at),
  }));
  const date = String(session.date ?? "").slice(0, 10) || undefined;
  const bodyweight = resolvedCurrentBodyweight(getProfile(), date);
  const lb = num(bodyweight?.weight_lb);
  return estimateStrengthKcal({
    sets,
    duration_min: num(session.duration_min),
    bodyweight_kg: lb == null ? null : lb / LB_PER_KG,
  });
}
