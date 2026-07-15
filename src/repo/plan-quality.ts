import {
  MUSCLE_LANDMARKS,
  canonicalGroup,
  classifyMuscleGroup,
  normalizeExerciseName,
  normalizedExerciseKey,
  type MuscleGroup,
} from "./exercise-canon.js";
import { classifyPattern, indirectGroupsForExercise, type MovementPattern } from "./exercise-variations.js";

export type PlanQualitySeverity = "error" | "warning";

export interface PlanQualityIssue {
  severity: PlanQualitySeverity;
  code: string;
  message: string;
  day_number?: number;
  exercises?: string[];
  muscle_group?: string;
}

export interface PlanQualityReport {
  ok: boolean;
  errors: PlanQualityIssue[];
  warnings: PlanQualityIssue[];
}

export interface PlanQualityDay {
  day_number?: unknown;
  items?: unknown;
}

const finite = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

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

function issue(
  severity: PlanQualitySeverity,
  code: string,
  message: string,
  extra: Omit<PlanQualityIssue, "severity" | "code" | "message"> = {}
): PlanQualityIssue {
  return { severity, code, message, ...extra };
}

/** Pure structural/quality compiler for a candidate training week. */
export function validateTrainingPlan(days: PlanQualityDay[]): PlanQualityReport {
  const errors: PlanQualityIssue[] = [];
  const warnings: PlanQualityIssue[] = [];
  const seenDays = new Set<number>();
  const patterns = new Set<MovementPattern>();
  const groupSets = new Map<MuscleGroup, number>();
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
    const strength = items.filter(
      (item) => item && typeof item === "object" && String(item.kind ?? "strength").toLowerCase() !== "cardio"
    );
    if (strength.length) strengthDays += 1;
    strengthItems += strength.length;
    const byCanonical = new Map<string, string[]>();
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
      const key = normalizedExerciseKey(exercise);
      byCanonical.set(key, [...(byCanonical.get(key) ?? []), exercise]);
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
        if (weight != null || repLow != null || repHigh != null) {
          errors.push(
            issue(
              "error",
              "timed_load_incoherence",
              `${exercise} on day ${dayLabel} is timed work, so it cannot also prescribe load or reps.`,
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

      const group = canonicalGroup(item.muscle_group) ?? classifyMuscleGroup(exercise);
      const pattern = classifyPattern(exercise, group ?? undefined);
      if (pattern) patterns.add(pattern);
      if (sets != null && sets > 0 && group) {
        groupSets.set(group, (groupSets.get(group) ?? 0) + sets);
        for (const secondary of indirectGroupsForExercise(exercise, group)) {
          groupSets.set(secondary, (groupSets.get(secondary) ?? 0) + sets * 0.5);
        }
      }
    }

    for (const exercises of byCanonical.values()) {
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
    const families: Array<[string, MovementPattern[]]> = [
      ["knee-dominant lower body", ["squat", "lunge"]],
      ["hip hinge / posterior chain", ["hinge", "hip-extension"]],
      ["horizontal push", ["horizontal-push"]],
      ["upper-body pull", ["horizontal-pull", "vertical-pull"]],
      ["trunk / anti-movement", ["core", "carry"]],
    ];
    for (const [label, options] of families) {
      if (!options.some((pattern) => patterns.has(pattern)))
        warnings.push(
          issue(
            "warning",
            "movement_pattern_gap",
            `This broad strength week has no clear ${label} pattern; confirm that the omission matches the athlete's goal, recovery, and constraints.`
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
  return { ok: errors.length === 0, errors, warnings };
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
