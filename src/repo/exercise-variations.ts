// exercise-variations.ts — deterministic, pure exercise variation/alternatives library.
// No DB writes, no agent calls. All logic is keyword-based classification + curated data.

export type Equipment =
  | "barbell"
  | "dumbbell"
  | "machine"
  | "cable"
  | "bodyweight"
  | "kettlebell";

export type MovementPattern =
  | "squat"
  | "hinge"
  | "horizontal-push"
  | "vertical-push"
  | "horizontal-pull"
  | "vertical-pull"
  | "lunge"
  | "hip-extension"
  | "calf"
  | "core"
  | "carry"
  | "curl"
  | "triceps"
  | "lateral-raise";

export interface ExerciseVariation {
  name: string;
  pattern: MovementPattern;
  equipment: Equipment;
  why: string;
}

// Internal extended entry used in the curated map.
interface ExerciseEntry {
  name: string;
  equipment: Equipment;
  injuryRisk?: string[]; // injury areas this exercise is risky for
}

// ─── Curated exercise data ────────────────────────────────────────────────────

const EXERCISE_MAP: Record<MovementPattern, ExerciseEntry[]> = {
  squat: [
    { name: "Back Squat", equipment: "barbell" },
    { name: "Front Squat", equipment: "barbell" },
    { name: "Box Squat", equipment: "barbell" },
    { name: "Safety Bar Squat", equipment: "barbell" },
    { name: "Zercher Squat", equipment: "barbell" },
    { name: "Hack Squat", equipment: "machine" },
    { name: "Leg Press", equipment: "machine" },
    { name: "Goblet Squat", equipment: "kettlebell" },
    { name: "DB Goblet Squat", equipment: "dumbbell" },
  ],
  hinge: [
    { name: "Conventional Deadlift", equipment: "barbell", injuryRisk: ["lower-back"] },
    { name: "Romanian Deadlift", equipment: "barbell", injuryRisk: ["lower-back"] },
    { name: "Sumo Deadlift", equipment: "barbell", injuryRisk: ["lower-back"] },
    { name: "Trap Bar Deadlift", equipment: "barbell" },
    { name: "Stiff-Leg Deadlift", equipment: "dumbbell", injuryRisk: ["lower-back"] },
    { name: "Single-Leg RDL", equipment: "dumbbell" },
    { name: "Good Morning", equipment: "barbell", injuryRisk: ["lower-back"] },
    { name: "Kettlebell Swing", equipment: "kettlebell" },
  ],
  "horizontal-push": [
    { name: "Barbell Bench Press", equipment: "barbell", injuryRisk: ["shoulder"] },
    { name: "DB Bench Press", equipment: "dumbbell", injuryRisk: ["shoulder"] },
    { name: "Incline Bench Press", equipment: "barbell", injuryRisk: ["shoulder"] },
    { name: "Incline DB Press", equipment: "dumbbell", injuryRisk: ["shoulder"] },
    { name: "Decline Bench Press", equipment: "barbell" },
    { name: "Push-Up", equipment: "bodyweight" },
    { name: "Cable Chest Press", equipment: "cable" },
    { name: "Machine Chest Press", equipment: "machine" },
    { name: "DB Chest Fly", equipment: "dumbbell" },
  ],
  "vertical-push": [
    { name: "Barbell Overhead Press", equipment: "barbell", injuryRisk: ["shoulder"] },
    { name: "DB Overhead Press", equipment: "dumbbell", injuryRisk: ["shoulder"] },
    { name: "Seated DB Overhead Press", equipment: "dumbbell", injuryRisk: ["shoulder"] },
    { name: "Arnold Press", equipment: "dumbbell", injuryRisk: ["shoulder"] },
    { name: "Machine Shoulder Press", equipment: "machine" },
    { name: "Landmine Press", equipment: "barbell" },
    { name: "Pike Push-Up", equipment: "bodyweight" },
    { name: "Cable Overhead Press", equipment: "cable" },
  ],
  "horizontal-pull": [
    { name: "Barbell Bent Over Row", equipment: "barbell", injuryRisk: ["lower-back"] },
    { name: "DB Row", equipment: "dumbbell" },
    { name: "Seated Cable Row", equipment: "cable" },
    { name: "T-Bar Row", equipment: "barbell", injuryRisk: ["lower-back"] },
    { name: "Chest-Supported Row", equipment: "machine" },
    { name: "Inverted Row", equipment: "bodyweight" },
    { name: "Pendlay Row", equipment: "barbell", injuryRisk: ["lower-back"] },
    { name: "Meadows Row", equipment: "barbell" },
  ],
  "vertical-pull": [
    { name: "Pull-Up", equipment: "bodyweight" },
    { name: "Chin-Up", equipment: "bodyweight" },
    { name: "Lat Pulldown", equipment: "machine" },
    { name: "Wide-Grip Pulldown", equipment: "machine" },
    { name: "Cable Pullover", equipment: "cable" },
    { name: "Assisted Pull-Up", equipment: "machine" },
    { name: "Single-Arm Lat Pulldown", equipment: "cable" },
  ],
  lunge: [
    { name: "Walking Lunge", equipment: "dumbbell" },
    { name: "Bulgarian Split Squat", equipment: "dumbbell", injuryRisk: ["knee"] },
    { name: "Reverse Lunge", equipment: "dumbbell" },
    { name: "Step-Up", equipment: "dumbbell" },
    { name: "Lateral Lunge", equipment: "bodyweight" },
    { name: "Front Foot Elevated Split Squat", equipment: "bodyweight", injuryRisk: ["knee"] },
    { name: "Barbell Lunge", equipment: "barbell" },
  ],
  "hip-extension": [
    { name: "Hip Thrust", equipment: "barbell" },
    { name: "DB Hip Thrust", equipment: "dumbbell" },
    { name: "Glute Bridge", equipment: "bodyweight" },
    { name: "Single-Leg Hip Thrust", equipment: "bodyweight" },
    { name: "Cable Kickback", equipment: "cable" },
    { name: "Donkey Kick", equipment: "bodyweight" },
    { name: "Nordic Curl", equipment: "bodyweight" },
  ],
  calf: [
    { name: "Standing Calf Raise", equipment: "machine" },
    { name: "Seated Calf Raise", equipment: "machine" },
    { name: "Donkey Calf Raise", equipment: "machine" },
    { name: "Single-Leg Calf Raise", equipment: "bodyweight" },
    { name: "DB Calf Raise", equipment: "dumbbell" },
  ],
  core: [
    { name: "Plank", equipment: "bodyweight" },
    { name: "Dead Bug", equipment: "bodyweight" },
    { name: "Ab Wheel Rollout", equipment: "bodyweight" },
    { name: "Cable Crunch", equipment: "cable" },
    { name: "Hanging Leg Raise", equipment: "bodyweight" },
    { name: "Russian Twist", equipment: "bodyweight" },
    { name: "Pallof Press", equipment: "cable" },
    { name: "Side Plank", equipment: "bodyweight" },
  ],
  carry: [
    { name: "Farmer's Walk", equipment: "dumbbell" },
    { name: "Suitcase Carry", equipment: "dumbbell" },
    { name: "Overhead Carry", equipment: "dumbbell" },
    { name: "Double KB Carry", equipment: "kettlebell" },
  ],
  curl: [
    { name: "Barbell Curl", equipment: "barbell" },
    { name: "DB Bicep Curl", equipment: "dumbbell" },
    { name: "Hammer Curl", equipment: "dumbbell" },
    { name: "Preacher Curl", equipment: "machine" },
    { name: "Incline DB Curl", equipment: "dumbbell" },
    { name: "Cable Curl", equipment: "cable" },
    { name: "Concentration Curl", equipment: "dumbbell" },
  ],
  triceps: [
    { name: "Tricep Pushdown", equipment: "cable" },
    { name: "Skull Crusher", equipment: "barbell" },
    { name: "Overhead Tricep Extension", equipment: "dumbbell" },
    { name: "Dips", equipment: "bodyweight" },
    { name: "Close-Grip Bench Press", equipment: "barbell" },
    { name: "Cable Overhead Tricep Extension", equipment: "cable" },
    { name: "DB Kickback", equipment: "dumbbell" },
  ],
  "lateral-raise": [
    { name: "Dumbbell Lateral Raise", equipment: "dumbbell" },
    { name: "Cable Lateral Raise", equipment: "cable" },
    { name: "Machine Lateral Raise", equipment: "machine" },
    { name: "Upright Row", equipment: "barbell" },
    { name: "DB Front Raise", equipment: "dumbbell" },
  ],
};

// ─── Classification rules ────────────────────────────────────────────────────

// Ordered list of [pattern, keyword-matchers]. First match wins.
// Keywords are tested case-insensitively against the full exercise name.
const PATTERN_RULES: Array<[MovementPattern, RegExp[]]> = [
  // More specific patterns first to avoid false matches
  ["hip-extension", [/hip thrust/i, /glute bridge/i, /cable kickback/i, /donkey kick/i, /nordic curl/i]],
  ["lunge", [/\blunge\b/i, /bulgarian split squat/i, /split squat/i, /step.?up/i, /lateral lunge/i]],
  ["calf", [/calf raise/i, /donkey calf/i, /calf/i]],
  ["carry", [/farmer.?s walk/i, /farmer walk/i, /suitcase carry/i, /overhead carry/i, /\bcarry\b/i]],
  // Hamstring knee-flexion (a "curl" by name) is posterior-chain, NOT a biceps
  // curl — must be matched BEFORE the biceps rule below so "Leg Curl" doesn't
  // get bicep-curl variations. Swaps to the hamstring/hinge family.
  ["hinge", [/leg curl/i, /hamstring curl/i, /lying curl/i, /nordic ham/i]],
  ["curl", [/\bcurl\b/i, /preacher/i]],
  ["triceps", [/tricep/i, /skull crusher/i, /\bdips?\b/i, /close.?grip bench/i, /pushdown/i, /kickback/i]],
  ["lateral-raise", [/lateral raise/i, /upright row/i, /front raise/i]],
  ["core", [/\bplank\b/i, /dead bug/i, /ab wheel/i, /rollout/i, /cable crunch/i, /hanging leg raise/i, /russian twist/i, /pallof/i, /side plank/i, /\bcrunch\b/i, /leg raise/i]],
  ["vertical-pull", [/pull.?up/i, /chin.?up/i, /lat pulldown/i, /pulldown/i, /cable pullover/i]],
  ["vertical-push", [/overhead press/i, /shoulder press/i, /arnold press/i, /pike push.?up/i, /landmine press/i, /overhead/i]],
  ["horizontal-pull", [/bent.?over row/i, /\brow\b/i, /t.?bar row/i, /chest.?supported row/i, /inverted row/i, /pendlay/i, /meadows row/i, /seated.*row/i]],
  ["horizontal-push", [/bench press/i, /chest press/i, /push.?up/i, /chest fly/i, /db fly/i, /incline press/i, /decline press/i]],
  ["hinge", [/deadlift/i, /rdl/i, /romanian/i, /good morning/i, /kettlebell swing/i, /kb swing/i, /stiff.?leg/i]],
  ["squat", [/squat/i, /hack squat/i, /leg press/i, /goblet/i]],
];

// Muscle-group fallback hints when name alone is ambiguous
const MUSCLE_GROUP_HINTS: Record<string, MovementPattern> = {
  chest: "horizontal-push",
  shoulders: "vertical-push",
  back: "horizontal-pull",
  lats: "vertical-pull",
  glutes: "hip-extension",
  quads: "squat",
  hamstrings: "hinge",
  calves: "calf",
  biceps: "curl",
  triceps: "triceps",
  core: "core",
  abs: "core",
};

// ─── Why-string generators ───────────────────────────────────────────────────

function buildVariationWhy(entry: ExerciseEntry, pattern: MovementPattern): string {
  const equip = entry.equipment;
  const patternLabel = pattern.replace(/-/g, " ");
  switch (equip) {
    case "bodyweight":
      return `bodyweight ${patternLabel} — same movement, no equipment needed, great to unstick a plateau`;
    case "machine":
      return `machine ${patternLabel} — removes stabiliser demand and spinal load, easier to isolate the target muscle`;
    case "cable":
      return `cable ${patternLabel} — constant tension through the full range, slightly different feel to free weights`;
    case "kettlebell":
      return `kettlebell ${patternLabel} — same pattern with a shifted centre of mass, adds grip and stability challenge`;
    case "dumbbell":
      return `dumbbell ${patternLabel} — unilateral option in the same pattern, exposes and corrects side-to-side imbalances`;
    case "barbell":
      return `barbell ${patternLabel} — heavier loading potential in the same movement pattern to drive strength adaptation`;
  }
}

function buildAlternativeWhy(original: string, entry: ExerciseEntry, pattern: MovementPattern): string {
  const equip = entry.equipment;
  const patternLabel = pattern.replace(/-/g, " ");
  if (equip === "bodyweight") {
    return `bodyweight substitute for ${original} — same ${patternLabel} pattern, no equipment needed`;
  }
  if (equip === "machine") {
    return `machine alternative to ${original} — same ${patternLabel} pattern, removes spinal load and stabiliser demand`;
  }
  return `${equip} swap for ${original} — same ${patternLabel} movement, different loading tool`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify an exercise name (and optional muscle_group hint) into one of the
 * 14 movement patterns. Returns null when the exercise cannot be mapped.
 */
export function classifyPattern(
  exerciseName: string,
  muscleGroup?: string,
): MovementPattern | null {
  const name = exerciseName.trim();

  // Primary: keyword rules on the name
  for (const [pattern, regexes] of PATTERN_RULES) {
    for (const re of regexes) {
      if (re.test(name)) return pattern;
    }
  }

  // Fallback: muscle_group hint
  if (muscleGroup) {
    const hint = MUSCLE_GROUP_HINTS[muscleGroup.toLowerCase().trim()];
    if (hint) return hint;
  }

  return null;
}

/**
 * Return same-pattern exercises, excluding the input exercise itself.
 * Default limit is 5.
 */
export function suggestVariations(
  exerciseName: string,
  opts?: { limit?: number },
): ExerciseVariation[] {
  const limit = opts?.limit ?? 5;
  const pattern = classifyPattern(exerciseName);
  if (!pattern) return [];

  const normalised = exerciseName.trim().toLowerCase();
  const entries = EXERCISE_MAP[pattern];

  const results: ExerciseVariation[] = [];
  for (const entry of entries) {
    if (entry.name.toLowerCase() === normalised) continue;
    results.push({
      name: entry.name,
      pattern,
      equipment: entry.equipment,
      why: buildVariationWhy(entry, pattern),
    });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Return swaps for an exercise that honour the given constraints.
 * - bodyweightOnly: only bodyweight exercises
 * - avoidEquipment: exclude exercises that use any of these equipment types
 * - injuryAreas: skip exercises flagged as risky for the listed areas
 * Default limit is 5.
 */
export function suggestAlternatives(
  exerciseName: string,
  opts?: {
    avoidEquipment?: Equipment[];
    bodyweightOnly?: boolean;
    injuryAreas?: string[];
    limit?: number;
  },
): ExerciseVariation[] {
  const limit = opts?.limit ?? 5;
  const pattern = classifyPattern(exerciseName);
  if (!pattern) return [];

  const normalised = exerciseName.trim().toLowerCase();
  const entries = EXERCISE_MAP[pattern];
  const avoid = new Set<Equipment>(opts?.avoidEquipment ?? []);
  const injuryAreas = opts?.injuryAreas ?? [];

  const results: ExerciseVariation[] = [];
  for (const entry of entries) {
    // Exclude the exercise itself
    if (entry.name.toLowerCase() === normalised) continue;

    // bodyweightOnly filter
    if (opts?.bodyweightOnly && entry.equipment !== "bodyweight") continue;

    // avoidEquipment filter
    if (avoid.has(entry.equipment)) continue;

    // injury area filter — skip if this exercise is flagged for any of the
    // provided injury areas. Substring match in BOTH directions so an athlete's
    // free-text area ("right shoulder", "lower back tweak") still matches a
    // canonical risk tag ("shoulder", "lower-back").
    if (
      injuryAreas.length > 0 &&
      entry.injuryRisk &&
      entry.injuryRisk.some((risk) =>
        injuryAreas.some((a) => {
          const lo = a.toLowerCase();
          return lo.includes(risk) || risk.includes(lo);
        }),
      )
    ) {
      continue;
    }

    results.push({
      name: entry.name,
      pattern,
      equipment: entry.equipment,
      why: buildAlternativeWhy(exerciseName.trim(), entry, pattern),
    });
    if (results.length >= limit) break;
  }
  return results;
}
