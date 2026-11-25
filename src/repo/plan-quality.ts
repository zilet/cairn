import {
  MUSCLE_LANDMARKS,
  normalizeExerciseName,
  normalizedExerciseKey,
  resolveExerciseName,
  type MuscleGroup,
} from "./exercise-canon.js";
import { classifyPattern, type MovementPattern, type VolumeShareOptions } from "./exercise-variations.js";
import { isCountedShare, muscleCreditsShared } from "./muscle-credit.js";
import { finite } from "../lib/numbers.js";
import { type VolumeFloorContext, weeklySetTargets } from "./volume-floor.js";
import { statedSplitIssues } from "./stated-split.js";

export type PlanQualitySeverity = "error" | "warning";

export interface PlanQualityIssue {
  severity: PlanQualitySeverity;
  code: string;
  message: string;
  day_number?: number;
  exercises?: string[];
  muscle_group?: string;
  /** On a `movement_pattern_gap`: which family is missing (MOVEMENT_PATTERN_FAMILIES key). */
  pattern?: MovementPatternFamily;
}

export interface PlanQualityReport {
  ok: boolean;
  errors: PlanQualityIssue[];
  warnings: PlanQualityIssue[];
}

export interface PlanQualityDay {
  day_number?: unknown;
  // 'training' (default) | 'rest'. A rest day is a legitimate, deliberate part of a
  // week — the ONLY thing this compiler asks of it is that it stays empty. Nothing
  // below counts it as a strength day, a pattern gap, or a thin day, because it is
  // none of those: emptiness is what a rest day is FOR.
  day_type?: unknown;
  items?: unknown;
  // What the day is called — read only by the stated-split check below.
  name?: unknown;
  focus?: unknown;
}

// Implement-agnostic slot for loaded horizontal chest presses. This intentionally
// distinguishes flat/incline/decline while folding barbell vs dumbbell: two incline
// presses on one day are redundant; flat + incline can still be deliberate.
export function pressSlotKey(name: string): string | null {
  const n = normalizeExerciseName(name);
  if (/\b(overhead|ohp|fly|push up|pushup|close grip)\b/.test(n)) return null;
  const angled = /\b(incline|decline|flat)\b/.test(n);
  if (!/\bbench\b/.test(n) && !(angled && /\bpress\b/.test(n))) return null;
  const angle = /\bincline\b/.test(n) ? "incline" : /\bdecline\b/.test(n) ? "decline" : "flat";
  return `horizontal-press:${angle}`;
}

/** Press angles already occupied by a session — one loaded movement per slot. */
export function occupiedPressSlots(names: readonly string[]): Set<string> {
  const slots = new Set<string>();
  for (const name of names) {
    const slot = pressSlotKey(name);
    if (slot) slots.add(slot);
  }
  return slots;
}

function issue(
  severity: PlanQualitySeverity,
  code: string,
  message: string,
  extra: Omit<PlanQualityIssue, "severity" | "code" | "message"> = {}
): PlanQualityIssue {
  return { severity, code, message, ...extra };
}

export interface PlanQualityOptions {
  /**
   * The athlete's volume-floor context (volume-floor.ts). Omitted or null → no
   * under-dose check at all, which is what a caller with no live athlete (a unit
   * fixture, an import) gets. The compiler stays pure: callers resolve it.
   */
  volumeFloor?: VolumeFloorContext | null;
  /**
   * The split the athlete named, in their words (stated-split.ts). Omitted or null → no
   * split check. A week that departs from it is a WARNING, never a refusal.
   */
  statedSplit?: string | null;
}

/**
 * Effective planned weekly sets per canonical group — direct sets plus the counted (half)
 * synergist shares (muscle-credit.ts). `{ shares: "touched" }` folds the quarter shares in
 * too: the whole picture, never what the floor, the bands or the ledger count.
 */
export function plannedWeeklyGroupSets(days: PlanQualityDay[], opts: VolumeShareOptions = {}): Map<MuscleGroup, number> {
  // Only the arithmetic is wanted here, so the same-lift check skips the catalog reads.
  const read = validateTrainingPlanInternal(days, {}, { resolveIdentity: false });
  return opts.shares === "touched" ? read.touchedSets : read.groupSets;
}

export interface WeeklyFloorShortfall {
  group: string;
  /** Effective weekly sets the week gives the group (direct 1, counted secondary half). */
  planned: number;
  /** The group's weekly floor (volume-floor.ts weeklySetTargets low). */
  low: number;
}

// THE definition of "a group under its weekly floor": the week's counted sets for the
// group below its landmark low, for every group the floor context lists, in a week with
// at least two lifting days (a one-day plan is a fragment, not a week). The plan
// compiler's `muscle_density_low` warning, the redraw precheck
// (verify-floors.ts planVolumeFloorViolations) and the coverage ask (plan-coverage.ts)
// all read it here, so they can never disagree about what a gap is.
function floorShortfallsFrom(
  groupSets: Map<MuscleGroup, number>,
  strengthDays: number,
  ctx: VolumeFloorContext | null | undefined
): WeeklyFloorShortfall[] {
  if (strengthDays < 2) return [];
  const out: WeeklyFloorShortfall[] = [];
  for (const target of weeklySetTargets(ctx)) {
    const planned = groupSets.get(target.group as MuscleGroup) ?? 0;
    if (planned < target.low) out.push({ group: target.group, planned, low: target.low });
  }
  return out;
}

/** Every floored group a week leaves under its weekly floor (see floorShortfallsFrom). Pure. */
export function weeklyFloorShortfalls(
  days: PlanQualityDay[],
  ctx: VolumeFloorContext | null | undefined
): WeeklyFloorShortfall[] {
  const read = validateTrainingPlanInternal(days, {}, { resolveIdentity: false });
  return floorShortfallsFrom(read.groupSets, read.strengthDays, ctx);
}

/**
 * Both coverage answers off ONE arithmetic pass (no catalog reads): the floored groups under
 * their floor (floorShortfallsFrom) and the movement families a broad week leaves out (the
 * compiler's `movement_pattern_gap`). Pure.
 */
export function planCoverageShortfalls(
  days: PlanQualityDay[],
  ctx: VolumeFloorContext | null | undefined
): { groups: WeeklyFloorShortfall[]; patterns: MovementPatternFamily[] } {
  const read = validateTrainingPlanInternal(days, {}, { resolveIdentity: false });
  const patterns = read.report.warnings
    .filter((w) => w.code === "movement_pattern_gap" && w.pattern)
    .map((w) => w.pattern as MovementPatternFamily);
  return { groups: floorShortfallsFrom(read.groupSets, read.strengthDays, ctx), patterns };
}

/** Pure structural/quality compiler for a candidate training week. */
export function validateTrainingPlan(days: PlanQualityDay[], opts: PlanQualityOptions = {}): PlanQualityReport {
  return validateTrainingPlanInternal(days, opts).report;
}

// The movement families a broad strength week is expected to touch. Coverage is
// contextual, never a hard rule (see the gap check below); the key is what a reader
// that has to NAME the missing family (plan-coverage.ts) keys on.
export type MovementPatternFamily = "knee-dominant" | "hinge" | "horizontal-push" | "upper-pull" | "trunk";
export const MOVEMENT_PATTERN_FAMILIES: ReadonlyArray<{
  key: MovementPatternFamily;
  label: string;
  patterns: readonly MovementPattern[];
}> = [
  { key: "knee-dominant", label: "knee-dominant lower body", patterns: ["squat", "lunge"] },
  { key: "hinge", label: "hip hinge / posterior chain", patterns: ["hinge", "hip-extension"] },
  { key: "horizontal-push", label: "horizontal push", patterns: ["horizontal-push"] },
  { key: "upper-pull", label: "upper-body pull", patterns: ["horizontal-pull", "vertical-pull"] },
  { key: "trunk", label: "trunk / anti-movement", patterns: ["core", "carry"] },
];

// The stored lift a name resolves to, or "" when the resolver cannot be read.
function resolvedLiftKey(name: string): string {
  try {
    return resolveExerciseName(name).key;
  } catch {
    return "";
  }
}

// ONE LIFT, TWICE ON A DAY. Two names are the same lift when the resolver
// (exercise-canon.ts resolveExerciseName — exact, one alias hop, key, unique expanded
// key) lands them on the same stored exercise: "DB Bicep Curl" through its alias row and
// "Dumbbell Biceps Curl" stored are one lift, which the conservative key alone never saw.
// The conservative key still joins two names on its own, so a name the resolver cannot
// place keeps exactly the behaviour it had. Groups come back in first-appearance order.
function sameLiftGroups(names: readonly string[], resolveIdentity: boolean): string[][] {
  const parent = names.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const firstByKey = new Map<string, number>();
  const join = (key: string, index: number) => {
    const first = firstByKey.get(key);
    if (first == null) firstByKey.set(key, index);
    else parent[find(index)] = find(first);
  };
  names.forEach((name, index) => {
    join(`key:${normalizedExerciseKey(name)}`, index);
    if (!resolveIdentity) return;
    const resolved = resolvedLiftKey(name);
    if (resolved) join(`lift:${resolved}`, index);
  });
  const groups = new Map<number, string[]>();
  names.forEach((name, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), name]);
  });
  return [...groups.values()];
}

function validateTrainingPlanInternal(
  days: PlanQualityDay[],
  opts: PlanQualityOptions,
  internal: { resolveIdentity?: boolean } = {}
): {
  report: PlanQualityReport;
  groupSets: Map<MuscleGroup, number>;
  touchedSets: Map<MuscleGroup, number>;
  strengthDays: number;
} {
  const errors: PlanQualityIssue[] = [];
  const warnings: PlanQualityIssue[] = [];
  const seenDays = new Set<number>();
  const patterns = new Set<MovementPattern>();
  const groupSets = new Map<MuscleGroup, number>();
  const touchedSets = new Map<MuscleGroup, number>();
  let strengthItems = 0;
  let strengthDays = 0;

  for (const [dayIndex, rawDay] of (Array.isArray(days) ? days : []).entries()) {
    const rawDayNumber = rawDay?.day_number;
    const dayNumber = rawDayNumber == null || rawDayNumber === "" ? dayIndex + 1 : finite(rawDayNumber);
    if (dayNumber == null || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 14) {
      errors.push(
        issue(
          "error",
          "invalid_day_number",
          `Day number must be an integer from 1 to 14 (received ${String(rawDayNumber)}).`,
          dayNumber == null ? {} : { day_number: dayNumber }
        )
      );
    } else if (seenDays.has(dayNumber)) {
      errors.push(
        issue("error", "duplicate_day_number", `Day ${dayNumber} appears more than once.`, { day_number: dayNumber })
      );
    }
    if (dayNumber != null && Number.isInteger(dayNumber)) seenDays.add(dayNumber);
    const dayLabel = dayNumber ?? "?";
    const dayExtra = dayNumber == null ? {} : { day_number: dayNumber };

    const items = Array.isArray(rawDay?.items) ? (rawDay.items as any[]) : [];
    const restDay = String(rawDay?.day_type ?? "training").toLowerCase() === "rest";
    if (restDay && items.length) {
      errors.push(
        issue(
          "error",
          "rest_day_has_items",
          `Day ${dayLabel} is marked as a rest day, so it cannot also prescribe ${items.length} item(s).`,
          dayExtra
        )
      );
    }
    const strength = items.filter(
      (item) => item && typeof item === "object" && String(item.kind ?? "strength").toLowerCase() !== "cardio"
    );
    if (strength.length) strengthDays += 1;
    strengthItems += strength.length;
    const dayExercises: string[] = [];
    const byPressSlot = new Map<string, string[]>();
    let daySets = 0;

    for (const item of strength) {
      const exercise = String(item.exercise ?? "").trim();
      if (!exercise) {
        errors.push(
          issue("error", "missing_exercise", `Day ${dayLabel} has a strength item without an exercise name.`, dayExtra)
        );
        continue;
      }
      dayExercises.push(exercise);
      const slot = pressSlotKey(exercise);
      if (slot) byPressSlot.set(slot, [...(byPressSlot.get(slot) ?? []), exercise]);

      const sets = finite(item.sets);
      if (sets == null || !Number.isInteger(sets) || sets < 1 || sets > 20) {
        errors.push(
          issue("error", "invalid_sets", `${exercise} on day ${dayLabel} needs 1–20 working sets.`, {
            ...dayExtra,
            exercises: [exercise],
          })
        );
      } else {
        daySets += sets;
      }

      const repLow = finite(item.rep_low);
      const repHigh = finite(item.rep_high);
      const seconds = finite(item.target_seconds);
      const weight = finite(item.target_weight);
      const declaredMode = String(item.mode ?? "").toLowerCase();
      // An omitted mode may still be inferred from a seconds prescription for
      // legacy/imported plan rows. An explicit reps mode is authoritative,
      // however: target_seconds then makes the row incoherent instead of silently
      // reclassifying it as timed work.
      const timed = declaredMode === "timed" || (!declaredMode && item.target_seconds != null);
      const badRep = (value: number | null) => value != null && (!Number.isInteger(value) || value < 1 || value > 100);
      if (
        (item.rep_low != null && repLow == null) ||
        (item.rep_high != null && repHigh == null) ||
        badRep(repLow) ||
        badRep(repHigh)
      ) {
        errors.push(
          issue("error", "invalid_reps", `${exercise} on day ${dayLabel} needs whole-number reps from 1–100.`, {
            ...dayExtra,
            exercises: [exercise],
          })
        );
      }
      if (repLow != null && repHigh != null && repLow > repHigh) {
        errors.push(
          issue("error", "reversed_rep_range", `${exercise} on day ${dayLabel} has rep_low above rep_high.`, {
            ...dayExtra,
            exercises: [exercise],
          })
        );
      }
      if (item.target_weight != null && weight == null) {
        errors.push(
          issue("error", "invalid_target_weight", `${exercise} on day ${dayLabel} has a non-numeric target weight.`, {
            ...dayExtra,
            exercises: [exercise],
          })
        );
      }
      if (timed) {
        if (seconds == null || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
          errors.push(
            issue(
              "error",
              "invalid_timed_target",
              `${exercise} on day ${dayLabel} needs a target_seconds value from 1–3600.`,
              { ...dayExtra, exercises: [exercise] }
            )
          );
        }
        // A timed item may carry a load (a carry, a weighted plank: lb × time;
        // negative = assist, null = bodyweight) — but never a rep target. The code
        // keeps its historical name so existing callers still match it.
        if (repLow != null || repHigh != null) {
          errors.push(
            issue(
              "error",
              "timed_load_incoherence",
              `${exercise} on day ${dayLabel} is timed work, so it cannot also prescribe reps.`,
              { ...dayExtra, exercises: [exercise] }
            )
          );
        }
      } else if (seconds != null) {
        errors.push(
          issue(
            "error",
            "reps_timed_incoherence",
            `${exercise} on day ${dayLabel} is reps-based but also has target_seconds.`,
            { ...dayExtra, exercises: [exercise] }
          )
        );
      }

      // Which groups the item's sets credit is muscle-credit.ts's one answer — the same
      // shares the logged-volume read (effectiveVolumeByGroup) folds, so a planned set and
      // a logged one count alike. Quarter shares are touched, never counted here.
      const stored = item.muscle_group == null ? null : String(item.muscle_group);
      const credits = muscleCreditsShared(exercise, stored);
      const pattern = classifyPattern(exercise, stored ?? undefined) ?? classifyPattern(exercise, credits[0]?.group);
      if (pattern) patterns.add(pattern);
      if (sets != null && sets > 0) {
        for (const credit of credits) {
          const share = credit.role === "primary" ? 1 : credit.share;
          touchedSets.set(credit.group, (touchedSets.get(credit.group) ?? 0) + sets * share);
          if (credit.role === "primary" || isCountedShare(credit.share))
            groupSets.set(credit.group, (groupSets.get(credit.group) ?? 0) + sets * share);
        }
      }
    }

    for (const exercises of sameLiftGroups(dayExercises, internal.resolveIdentity !== false)) {
      if (exercises.length > 1)
        errors.push(
          issue(
            "error",
            "canonical_duplicate",
            `Day ${dayLabel} repeats the same canonical exercise (${exercises.join(", ")}).`,
            { ...dayExtra, exercises }
          )
        );
    }
    for (const [slot, exercises] of byPressSlot) {
      if (exercises.length > 1)
        errors.push(
          issue(
            "error",
            "duplicate_press_angle",
            `Day ${dayLabel} duplicates ${slot.split(":")[1]} pressing (${exercises.join(", ")}); use one movement per loaded press angle.`,
            { ...dayExtra, exercises }
          )
        );
    }
    if (daySets > 30)
      warnings.push(
        issue(
          "warning",
          "excessive_day_density",
          `Day ${dayLabel} has ${daySets} planned working sets; review whether that density is recoverable and purposeful.`,
          dayExtra
        )
      );
  }

  // Coverage is contextual, never a hard rule: a specialist, rehab, travel, or race
  // week may intentionally omit a pattern. Only flag conspicuous gaps in a broad week.
  if (strengthDays >= 3 && strengthItems >= 6) {
    for (const family of MOVEMENT_PATTERN_FAMILIES) {
      if (!family.patterns.some((pattern) => patterns.has(pattern)))
        warnings.push(
          issue(
            "warning",
            "movement_pattern_gap",
            `This broad strength week has no clear ${family.label} pattern; confirm that the omission matches the athlete's goal, recovery, and constraints.`,
            { pattern: family.key }
          )
        );
    }
  }
  for (const [group, sets] of groupSets) {
    const landmark = MUSCLE_LANDMARKS[group];
    if (landmark && sets > landmark.high)
      warnings.push(
        issue(
          "warning",
          "muscle_density_high",
          `${group} volume is above the established high weekly landmark (${sets.toFixed(1)} effective planned sets); review recovery and goal fit.`,
          { muscle_group: group }
        )
      );
  }
  // UNDER-dose, the mirror of the check above — contextual by construction: the
  // targets are empty unless the athlete's intent prioritizes muscle or strength and
  // no deliberate light window is in force, and a group their endurance work already
  // carries is not listed at all (volume-floor.ts). A one-day plan is a fragment, not
  // a week, so it is not measured as one.
  for (const short of floorShortfallsFrom(groupSets, strengthDays, opts.volumeFloor)) {
    warnings.push(
      issue(
        "warning",
        "muscle_density_low",
        `${short.group} volume is below the low weekly landmark (${short.planned.toFixed(1)} effective planned sets against ${short.low}); for a muscle and strength priority it needs more working sets across the week.`,
        { muscle_group: short.group }
      )
    );
  }
  if (opts.statedSplit) {
    const liftingDays = (Array.isArray(days) ? days : []).filter(
      (day) =>
        String(day?.day_type ?? "training").toLowerCase() !== "rest" &&
        Array.isArray(day?.items) &&
        (day.items as any[]).some((item) => String(item?.kind ?? "strength") !== "cardio")
    );
    for (const found of statedSplitIssues(liftingDays, opts.statedSplit)) {
      warnings.push(
        issue("warning", found.code, found.message, found.day_number == null ? {} : { day_number: found.day_number })
      );
    }
  }
  return { report: { ok: errors.length === 0, errors, warnings }, groupSets, touchedSets, strengthDays };
}

export function qualityIssueKey(value: PlanQualityIssue): string {
  return `${value.code}|${value.day_number ?? "week"}|${(value.exercises ?? []).map(normalizedExerciseKey).sort().join(",")}`;
}

export class PlanQualityError extends Error {
  readonly report: PlanQualityReport;
  constructor(
    report: PlanQualityReport,
    message = report.errors[0]?.message ?? "Training plan failed quality validation"
  ) {
    super(message);
    this.name = "PlanQualityError";
    this.report = report;
  }
}
