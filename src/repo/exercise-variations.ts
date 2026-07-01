// exercise-variations.ts — deterministic, pure exercise variation/alternatives library.
// No DB writes, no agent calls. All logic is keyword-based classification + curated data.
import { canonicalGroup, classifyMuscleGroup, isMobility, type MuscleGroup } from "./exercise-canon.js";

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
  | "lateral-raise"
  // Previously-unclassifiable families — no swap candidates existed for these, so a
  // face pull / shrug / rear-delt fly / tibialis raise / hip abduction had no variety.
  | "rear-delt"
  | "shrug"
  | "tibialis"
  | "abduction";

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
  "rear-delt": [
    { name: "Face Pull", equipment: "cable" },
    { name: "Reverse Pec Deck", equipment: "machine" },
    { name: "Rear Delt Fly", equipment: "dumbbell" },
    { name: "Cable Rear Delt Fly", equipment: "cable" },
    { name: "Band Pull-Apart", equipment: "bodyweight" },
    { name: "Prone Rear Delt Raise", equipment: "dumbbell" },
  ],
  shrug: [
    { name: "Barbell Shrug", equipment: "barbell" },
    { name: "Dumbbell Shrug", equipment: "dumbbell" },
    { name: "Trap Bar Shrug", equipment: "barbell" },
    { name: "Cable Shrug", equipment: "cable" },
    { name: "Machine Shrug", equipment: "machine" },
  ],
  tibialis: [
    { name: "Tibialis Raise", equipment: "bodyweight" },
    { name: "Weighted Tibialis Raise", equipment: "machine" },
    { name: "Banded Dorsiflexion", equipment: "bodyweight" },
    { name: "DB Tibialis Raise", equipment: "dumbbell" },
  ],
  abduction: [
    { name: "Hip Abduction Machine", equipment: "machine" },
    { name: "Cable Hip Abduction", equipment: "cable" },
    { name: "Banded Lateral Walk", equipment: "bodyweight" },
    { name: "Side-Lying Leg Raise", equipment: "bodyweight" },
    { name: "Seated Band Abduction", equipment: "bodyweight" },
  ],
};

// ─── Classification rules ────────────────────────────────────────────────────

// Ordered list of [pattern, keyword-matchers]. First match wins.
// Keywords are tested case-insensitively against the full exercise name.
const PATTERN_RULES: Array<[MovementPattern, RegExp[]]> = [
  // More specific patterns first to avoid false matches
  // Previously-unmapped families — matched FIRST so a "face pull" / "shrug" /
  // "tibialis raise" / "hip abduction" resolves to its own family (they used to
  // fall through to null → no swap candidates).
  ["rear-delt", [/face pull/i, /rear delt/i, /reverse (pec|fly|flye|delt)/i, /rear (fly|flye)/i, /band pull.?apart/i, /prone (y|t)\b/i]],
  ["shrug", [/\bshrug/i]],
  ["tibialis", [/tibialis/i, /\btib raise/i, /dorsiflex/i]],
  ["abduction", [/abduction/i, /abductor/i, /hip abduct/i, /lateral (band )?walk/i, /side.?lying leg raise/i]],
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
  "rear delts": "rear-delt",
  "rear delt": "rear-delt",
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

// ─── equipment / preference ranking ──────────────────────────────────────────

// Free-text equipment/preference profile → the concrete Equipment types available.
// "full gym" / "commercial" / "everything" → all. Otherwise pick out the tokens that
// are named. Empty / unrecognized → [] (no constraint — rank neutrally). Pure.
const ALL_EQUIPMENT: Equipment[] = ["barbell", "dumbbell", "machine", "cable", "kettlebell", "bodyweight"];
const EQUIPMENT_TOKENS: Array<[Equipment, RegExp]> = [
  // NB: not a bare "bar" — that's in "pull-up bar" (a bodyweight station), not a barbell.
  ["barbell", /\bbarbell\b|\bbb\b/i],
  ["dumbbell", /\bdumbbell|\bdb\b|\bdumbell/i],
  ["machine", /\bmachine|\bsmith\b|\bhack\b|\bleg press\b|\bcable machine/i],
  ["cable", /\bcable|\bpulley/i],
  ["kettlebell", /\bkettlebell|\bkb\b/i],
  ["bodyweight", /\bbodyweight|\bbw\b|\bcalisthenic|\bpull.?up bar|\bdip station/i],
];
export function parseEquipment(text?: string | null): Equipment[] {
  const s = String(text ?? "").trim();
  if (!s) return [];
  if (/\b(full gym|commercial gym|everything|fully equipped|globo|big gym)\b/i.test(s)) return [...ALL_EQUIPMENT];
  const out = new Set<Equipment>();
  for (const [eq, re] of EQUIPMENT_TOKENS) if (re.test(s)) out.add(eq);
  return [...out];
}

// Loading rank for "bias toward heavier COMPOUND progression" — barbell/machine
// carry the most progressive load, bodyweight the least. Lower = heavier/compound.
const EQUIPMENT_LOAD_RANK: Record<Equipment, number> = {
  barbell: 0,
  machine: 1,
  cable: 2,
  dumbbell: 3,
  kettlebell: 4,
  bodyweight: 5,
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
    // Ranking (opt-in — omit for the legacy curated order). When provided the passing
    // candidates are RANKED, then sliced to `limit`, rather than taken in map order.
    availableEquipment?: Equipment[];  // rank movements the athlete can actually load first
    preferCompound?: boolean;          // bias toward heavier compound loading (barbell/machine first)
    excludeNames?: string[];           // movements already in the plan — don't re-suggest them
  },
): ExerciseVariation[] {
  const limit = opts?.limit ?? 5;
  const pattern = classifyPattern(exerciseName);
  if (!pattern) return [];

  const normalised = exerciseName.trim().toLowerCase();
  const entries = EXERCISE_MAP[pattern];
  const avoid = new Set<Equipment>(opts?.avoidEquipment ?? []);
  const injuryAreas = opts?.injuryAreas ?? [];
  const exclude = new Set<string>((opts?.excludeNames ?? []).map((n) => String(n).trim().toLowerCase()));
  const available = opts?.availableEquipment && opts.availableEquipment.length ? new Set<Equipment>(opts.availableEquipment) : null;
  const ranking = !!available || !!opts?.preferCompound || exclude.size > 0;

  const results: ExerciseVariation[] = [];
  for (const entry of entries) {
    // Exclude the exercise itself
    if (entry.name.toLowerCase() === normalised) continue;

    // Exclude movements already programmed (variety = something NEW), when provided.
    if (exclude.has(entry.name.toLowerCase())) continue;

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
    // Without ranking, keep the cheap early break (legacy behavior). With ranking we
    // must collect all candidates first, then sort, then slice.
    if (!ranking && results.length >= limit) break;
  }

  if (ranking) {
    results.sort((a, b) => {
      // Available equipment first (0 = available / no constraint, 1 = unavailable).
      const aAvail = available ? (available.has(a.equipment) ? 0 : 1) : 0;
      const bAvail = available ? (available.has(b.equipment) ? 0 : 1) : 0;
      if (aAvail !== bAvail) return aAvail - bAvail;
      // Then bias toward heavier compound loading when asked.
      if (opts?.preferCompound) {
        const d = EQUIPMENT_LOAD_RANK[a.equipment] - EQUIPMENT_LOAD_RANK[b.equipment];
        if (d !== 0) return d;
      }
      return 0; // otherwise stable (preserve curated order)
    });
    return results.slice(0, limit);
  }
  return results;
}

// ─── Group → concrete movements (for the "what changed" digest) ───────────────

// Canonical muscle group → the movement patterns that train it, so the program
// digest can offer concrete "things to do" for a due group. Mirrors the canonical
// taxonomy in exercise-canon.ts. Pure + deterministic — no DB, no agent.
const GROUP_PATTERNS: Record<string, MovementPattern[]> = {
  chest: ["horizontal-push"],
  shoulders: ["vertical-push", "lateral-raise", "shrug"],
  "rear delts": ["rear-delt", "lateral-raise", "horizontal-pull"],
  triceps: ["triceps"],
  back: ["horizontal-pull", "vertical-pull", "shrug"],
  biceps: ["curl"],
  forearms: ["carry"],
  quads: ["squat", "lunge"],
  hamstrings: ["hinge"],
  glutes: ["hip-extension", "abduction"],
  calves: ["calf", "tibialis"],
  core: ["core", "carry"],
};

// A few concrete exercise names that train `group`, drawn from the curated library
// and round-robined across its patterns for variety (e.g. quads → Back Squat,
// Walking Lunge, Front Squat). Returns [] for a group we don't map (e.g. mobility,
// where the caller supplies its own curated list).
export function examplesForGroup(group: string, n = 3): string[] {
  const pats = GROUP_PATTERNS[(group || "").toLowerCase()];
  if (!pats || !pats.length) return [];
  const out: string[] = [];
  for (let i = 0; out.length < n && i < 8; i++) {
    for (const p of pats) {
      const e = EXERCISE_MAP[p][i];
      if (e && !out.includes(e.name)) {
        out.push(e.name);
        if (out.length >= n) break;
      }
    }
  }
  return out.slice(0, n);
}

// ─── honest volume model (ONE truth) ──────────────────────────────────────────
// The three volume readers (programBalance, muscleVolume, getVolumeByMuscle) used to
// disagree — some counted warmups as working sets, weighted an RIR-5 set the same as
// a grinder, gave zero indirect credit, and bypassed the canon taxonomy. This shared,
// pure aggregator is the ONE effective-volume truth they all fold onto:
//   - WARMUPS excluded (a ramp-up set well below the day's top working weight),
//   - proximity-to-failure WEIGHTING (a set left far from failure counts less),
//   - INDIRECT credit (a movement's secondary muscles earn ~0.5 a set),
//   - CANON taxonomy (stored group, else classify by name; mobility never counts).

// Effort weight by reps-in-reserve: ≤3 RIR is a real working set; a set left far from
// failure (RIR 5+) counts less. Null RIR (not logged) is trusted as a full set.
export function setEffortWeight(rir: number | null | undefined): number {
  const r = Number(rir);
  if (rir == null || !Number.isFinite(r)) return 1;
  if (r <= 3) return 1;
  if (r < 5) return 0.75;
  return 0.5;
}

// Movement pattern → the secondary muscle groups it trains indirectly (a press hits
// triceps, a row hits biceps, a squat hits glutes). Isolation/neutral patterns carry
// no meaningful indirect load.
const INDIRECT_BY_PATTERN: Partial<Record<MovementPattern, MuscleGroup[]>> = {
  squat: ["glutes"],
  hinge: ["glutes"],
  lunge: ["glutes"],
  "hip-extension": ["hamstrings"],
  "horizontal-push": ["triceps", "shoulders"],
  "vertical-push": ["triceps"],
  "horizontal-pull": ["biceps", "rear delts"],
  "vertical-pull": ["biceps"],
};

export function indirectGroupsForExercise(name: string, muscleGroup?: string | null): MuscleGroup[] {
  const p = classifyPattern(name, muscleGroup ?? undefined);
  return p && INDIRECT_BY_PATTERN[p] ? INDIRECT_BY_PATTERN[p]! : [];
}

const INDIRECT_CREDIT = 0.5;   // a secondary muscle earns half a working set
const WARMUP_FRAC = 0.55;      // a set under 55% of the day's top load is a ramp-up warmup

export interface VolumeSet {
  date: string;
  exercise: string;
  muscle_group: string | null;
  weight: number | null;
  reps?: number | null;
  rir?: number | null;
}

export interface GroupVolume {
  sets: number;         // effective working sets (warmups excluded, RIR-weighted, incl. indirect)
  tonnage: number;      // weight×reps over DIRECT working sets only (never indirect)
  last_date: string | null;
}

// Fold logged sets into effective working-set volume per canonical group. Pure.
export function effectiveVolumeByGroup(sets: VolumeSet[]): Map<MuscleGroup, GroupVolume> {
  // The day's TOP working weight per (exercise, date), to spot ramp-up warmups.
  const topByExDate = new Map<string, number>();
  for (const s of sets) {
    const w = s.weight != null ? Math.abs(Number(s.weight)) : 0;
    if (!(w > 0)) continue;
    const k = `${String(s.exercise).toLowerCase()}|${s.date}`;
    if (w > (topByExDate.get(k) ?? 0)) topByExDate.set(k, w);
  }

  const out = new Map<MuscleGroup, GroupVolume>();
  const bump = (g: MuscleGroup, credit: number, date: string, tonnage: number) => {
    const cur = out.get(g) ?? { sets: 0, tonnage: 0, last_date: null };
    cur.sets += credit;
    cur.tonnage += tonnage;
    if (!cur.last_date || date > cur.last_date) cur.last_date = date;
    out.set(g, cur);
  };

  for (const s of sets) {
    const primary = canonicalGroup(s.muscle_group) ?? classifyMuscleGroup(s.exercise);
    if (!primary || isMobility(primary)) continue;
    // Warmup exclusion: a loaded set well below the day's top load for that lift.
    const w = s.weight != null ? Math.abs(Number(s.weight)) : 0;
    if (w > 0) {
      const top = topByExDate.get(`${String(s.exercise).toLowerCase()}|${s.date}`) ?? 0;
      if (top > 0 && w < top * WARMUP_FRAC) continue; // ramp-up warmup — not working volume
    }
    const effort = setEffortWeight(s.rir);
    const tonnage = s.weight != null && s.reps != null && Number(s.weight) > 0 && Number(s.reps) > 0
      ? Number(s.weight) * Number(s.reps)
      : 0;
    bump(primary, effort, s.date, tonnage);
    for (const g of indirectGroupsForExercise(s.exercise, s.muscle_group)) {
      if (g === primary || isMobility(g)) continue;
      bump(g, INDIRECT_CREDIT * effort, s.date, 0); // indirect earns half a set, no tonnage
    }
  }
  return out;
}
