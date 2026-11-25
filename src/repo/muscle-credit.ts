// Which muscles an exercise trains, and how much of a set each one earns.
//
// THE one answer to "which muscles does this exercise train": a primary group at a full
// share and its synergists at a part share. Every volume, dose and per-group progress read
// asks here; nothing re-derives a group from a name or a pattern on its own.
//
// The model, in three parts:
//   - PRIMARY. The stored group when there is one (canonicalized), else the name classifier
//     (exercise-canon.ts `classifyMuscleGroup`). Share 1, and it carries the set's tonnage.
//     Mobility never counts; a core movement credits core alone (it is never a press or a
//     row, whatever its name says: "Flat Bench Knee Raise").
//   - SYNERGISTS by NAMED LIFT. One movement pattern hides different lifts (a deadlift and a
//     leg curl are both "hinge"), so the name is read first against `NAMED_LIFTS`. A row
//     applies only when the classifier agrees with it on the lift's own prime mover, so a
//     "Leg Press Calf Raise" never borrows the leg press's glutes.
//   - SYNERGISTS by PATTERN, when no named lift matches: the long-standing half set per
//     secondary (a press lends triceps, a row lends biceps). Nothing new is invented here.
//
// Two shares, and what each one is for:
//   - HALF (0.5) is COUNTED. A real second mover: it counts toward weekly volume, the
//     contextual floor, the dose ledger, the volume bands and the acute residual, exactly as
//     every secondary always did.
//   - QUARTER (0.25) is TOUCHED. Trained, but not enough to stand in for direct work. It is
//     never counted toward a volume band, the floor or the ledger (`COUNTED_SHARE_MIN`), so a
//     group can never read "high" or "covered" off quarter shares alone; readers that want the
//     whole picture (the muscle trajectory, a "what got worked" view) ask for touched shares.
//
// Pure and deterministic: no schema, no agent, remembered per (name, stored group).
import { canonicalGroup, classifyMuscleGroup, expandExerciseAbbreviations, type MuscleGroup, resolveGroup } from "./exercise-canon.js";
import { appliedProfileFor, type AppliedExerciseProfile, exerciseProfileEpoch } from "./exercise-profile-lookup.js";
import { classifyPattern, classifyPatternCurated, type MovementPattern } from "./exercise-variations.js";

export interface MuscleCredit {
  group: MuscleGroup;
  /** The part of one working set this group earns: 1 for the primary, under 1 for a synergist. */
  share: number;
  role: "primary" | "secondary";
}

/** A real second mover: counted toward weekly volume, exactly like every secondary always was. */
export const HALF_SHARE = 0.5;
/** Trained, but not enough to count toward a band, the floor or the ledger. */
export const TOUCHED_SHARE = 0.25;
/** The smallest share a weekly-volume read counts. Anything under it is "touched" only. */
export const COUNTED_SHARE_MIN = HALF_SHARE;

const H = HALF_SHARE;
const Q = TOUCHED_SHARE;

type Synergists = ReadonlyArray<readonly [MuscleGroup, number]>;

// The long-standing pattern table: what a lift lends when its name is not one of the named
// lifts below. Every share here is the half set it has always been.
const PATTERN_SYNERGISTS: Partial<Record<MovementPattern, Synergists>> = {
  squat: [["glutes", H]],
  hinge: [["glutes", H]],
  lunge: [["glutes", H]],
  "hip-extension": [["hamstrings", H]],
  "horizontal-push": [
    ["triceps", H],
    ["shoulders", H],
  ],
  "vertical-push": [["triceps", H]],
  "horizontal-pull": [
    ["biceps", H],
    ["rear delts", H],
  ],
  "vertical-pull": [["biceps", H]],
};

export interface NamedLift {
  /** What the row is, for a reader. */
  lift: string;
  /** The lift's own prime mover. The row applies only when the name classifier agrees. */
  primary: MuscleGroup;
  /** Matched against the normalized name with abbreviations spelled out ("rdl" → "romanian deadlift"). */
  match: RegExp;
  /** A name that also matches `unless` is not this lift. */
  unless?: RegExp;
  synergists: Synergists;
  /** Why, when it is not obvious. */
  why?: string;
  /** A name this row is written for (the test suite checks the classifier agrees). */
  example: string;
}

// Ordered: the FIRST row that matches (and agrees on the prime mover) wins, so a specific
// lift sits above the general one it would otherwise fall into (a Romanian deadlift above
// "deadlift", a split squat above "squat", an upright row above "row").
export const NAMED_LIFTS: readonly NamedLift[] = [
  // ---- single-joint work: one joint moves, nothing else is trained ----
  { lift: "leg extension", primary: "quads", match: /\bleg extensions?\b/, synergists: [], example: "Leg Extension" },
  {
    lift: "sissy squat",
    primary: "quads",
    match: /\bsissy\b/,
    synergists: [],
    why: "a knee-only squat: the hips barely move",
    example: "Sissy Squat",
  },
  {
    lift: "leg curl / nordic curl",
    primary: "hamstrings",
    match: /\b(?:leg|hamstring|lying|seated) curls?\b|\bnordic\b/,
    synergists: [],
    why: "knee flexion: the glutes are not a mover (the hinge pattern used to lend them half a set)",
    example: "Lying Leg Curl",
  },
  {
    lift: "glute-ham raise",
    primary: "hamstrings",
    match: /\bglute ham\b|\bghr\b/,
    synergists: [["glutes", Q]],
    example: "Glute Ham Raise",
  },
  { lift: "calf raise", primary: "calves", match: /\bcalf\b|\bcalves\b/, synergists: [], example: "Standing Calf Raise" },

  // ---- rear delts and the upper back ----
  {
    lift: "face pull / reverse fly",
    primary: "rear delts",
    match: /\bface pulls?\b|\brear delt\b|\breverse (?:fly|flye|flyes|pec|delt)\b|\brear (?:fly|flye|raise)\b/,
    synergists: [["back", Q]],
    why: "the mid traps and rhomboids pull the shoulder blades back",
    example: "Face Pull",
  },
  {
    lift: "shrug",
    primary: "shoulders",
    match: /\bshrugs?\b/,
    synergists: [["forearms", Q]],
    why: "a heavy hold works the grip (the traps themselves are filed under shoulders)",
    example: "Barbell Shrug",
  },
  {
    lift: "upright row",
    primary: "shoulders",
    match: /\bupright rows?\b/,
    synergists: [],
    why: "delts and upper traps, both filed under shoulders, so nothing else is credited",
    example: "Upright Row",
  },

  // ---- chest flys: no elbow extension, so no triceps ----
  {
    lift: "chest fly",
    primary: "chest",
    match: /\b(?:fly|flye|flyes|flies)\b|\bcrossovers?\b|\bpec deck\b/,
    synergists: [["shoulders", Q]],
    why: "the front delt assists; the elbow stays fixed, so the triceps do no work",
    example: "Cable Fly",
  },

  // ---- hinges ----
  {
    lift: "romanian / stiff-leg deadlift",
    primary: "hamstrings",
    match: /\bromanian\b|\bstiff legg?(?:ed)?\b/,
    synergists: [
      ["glutes", H],
      ["back", Q],
      ["forearms", Q],
    ],
    why: "the spinal erectors hold the hinge without moving; the grip holds the bar",
    example: "Romanian Deadlift",
  },
  {
    lift: "good morning",
    primary: "hamstrings",
    match: /\bgood mornings?\b/,
    synergists: [
      ["glutes", H],
      ["back", Q],
    ],
    why: "the bar sits on the back, so the erectors hold the hinge",
    example: "Good Morning",
  },
  {
    lift: "kettlebell swing",
    primary: "hamstrings",
    match: /\bswings?\b/,
    synergists: [["glutes", H]],
    example: "Kettlebell Swing",
  },
  {
    lift: "trap-bar / sumo deadlift",
    primary: "hamstrings",
    match: /\b(?:trap bar|hex bar|sumo)\b.*\bdeadlifts?\b/,
    synergists: [
      ["glutes", H],
      ["back", H],
      ["quads", Q],
      ["forearms", Q],
      ["core", Q],
    ],
    why: "a more upright pull: the legs push the floor away, so the quads join in",
    example: "Trap Bar Deadlift",
  },
  {
    lift: "deadlift",
    primary: "hamstrings",
    match: /\bdeadlifts?\b/,
    synergists: [
      ["glutes", H],
      ["back", H],
      ["forearms", Q],
      ["core", Q],
    ],
    why: "the erectors and lats hold a heavy bar from the floor: a real back dose, not a stabiliser",
    example: "Conventional Deadlift",
  },
  {
    lift: "back extension",
    primary: "back",
    match: /\bback extensions?\b|\bhyperextensions?\b/,
    synergists: [
      ["glutes", Q],
      ["hamstrings", Q],
    ],
    why: "the erectors lead; the hips extend with them",
    example: "45 Degree Back Extension",
  },

  // ---- squats and single-leg work ----
  {
    lift: "lunge / split squat / step-up",
    primary: "quads",
    match: /\blunges?\b|\bsplit squats?\b|\bstep ups?\b/,
    synergists: [["glutes", H]],
    example: "Bulgarian Split Squat",
  },
  {
    lift: "leg press / hack squat",
    primary: "quads",
    match: /\bleg press\b|\bhack\b|\bpendulum\b|\bbelt squats?\b|\bsmith\b.*\bsquats?\b|\bmachine squats?\b/,
    synergists: [["glutes", H]],
    why: "the machine holds the trunk, so neither the core nor the back is trained",
    example: "Leg Press",
  },
  {
    lift: "goblet squat",
    primary: "quads",
    match: /\bgoblet\b/,
    synergists: [
      ["glutes", H],
      ["core", Q],
    ],
    why: "the weight in front keeps the trunk working",
    example: "Goblet Squat",
  },
  {
    lift: "front squat",
    primary: "quads",
    match: /\bfront squats?\b|\bzercher\b/,
    synergists: [
      ["glutes", H],
      ["core", Q],
      ["back", Q],
    ],
    why: "the bar in front makes the trunk and upper back hold the torso upright",
    example: "Front Squat",
  },
  {
    lift: "back squat",
    primary: "quads",
    match: /\bsquats?\b/,
    synergists: [
      ["glutes", H],
      ["core", Q],
      ["back", Q],
    ],
    why: "a loaded bar on the back: the trunk braces and the erectors hold the torso",
    example: "Back Squat",
  },

  // ---- presses ----
  {
    lift: "close-grip bench press",
    primary: "triceps",
    match: /\bclose grip bench\b|\bcgbp\b/,
    synergists: [
      ["chest", H],
      ["shoulders", Q],
    ],
    why: "still a bench press: the chest moves the bar alongside the triceps",
    example: "Close-Grip Bench Press",
  },
  {
    lift: "chest dip",
    primary: "chest",
    match: /\bchest dips?\b|\b(?:lean|leaning|forward) dips?\b/,
    synergists: [
      ["triceps", H],
      ["shoulders", H],
    ],
    example: "Chest Dip",
  },
  {
    lift: "bench dip",
    primary: "triceps",
    match: /\bbench dips?\b/,
    synergists: [["shoulders", Q]],
    why: "hands behind on a bench: the triceps do nearly all of it",
    example: "Bench Dip",
  },
  {
    lift: "triceps dip",
    primary: "triceps",
    match: /\btriceps? dips?\b/,
    synergists: [
      ["chest", Q],
      ["shoulders", Q],
    ],
    why: "an upright dip keeps most of the work on the triceps",
    example: "Tricep Dip",
  },
  {
    lift: "dip",
    primary: "triceps",
    match: /\bdips?\b/,
    synergists: [
      ["chest", H],
      ["shoulders", Q],
    ],
    why: "parallel-bar dips load the lower chest heavily alongside the triceps",
    example: "Dips",
  },
  {
    lift: "pike push-up",
    primary: "shoulders",
    match: /\bpike push ?ups?\b/,
    synergists: [["triceps", H]],
    example: "Pike Push-Up",
  },
  {
    lift: "push-up",
    primary: "chest",
    match: /\bpush ?ups?\b/,
    synergists: [
      ["triceps", H],
      ["shoulders", H],
      ["core", Q],
    ],
    why: "a moving plank: the trunk holds the line",
    example: "Push-Up",
  },
  {
    lift: "landmine press",
    primary: "shoulders",
    match: /\blandmine press\b/,
    synergists: [
      ["triceps", H],
      ["chest", Q],
    ],
    why: "the angled path brings the upper chest in",
    example: "Landmine Press",
  },
  {
    lift: "standing overhead press",
    primary: "shoulders",
    match: /\b(?:overhead|military) press\b/,
    unless: /\b(?:seated|machine|smith)\b/,
    synergists: [
      ["triceps", H],
      ["core", Q],
    ],
    why: "standing, the trunk braces under the bar (seated or machine work falls to the pattern)",
    example: "Barbell Overhead Press",
  },

  // ---- pulls ----
  {
    lift: "pullover / straight-arm pulldown",
    primary: "back",
    match: /\bpullovers?\b|\bstraight arm\b/,
    synergists: [["triceps", Q]],
    why: "shoulder extension with a fixed elbow: the long head of the triceps works, the biceps barely",
    example: "Straight Arm Pulldown",
  },
  {
    lift: "pull-up / chin-up / pulldown",
    primary: "back",
    match: /\bpull ?ups?\b|\bchin ?ups?\b|\bpull ?downs?\b/,
    synergists: [
      ["biceps", H],
      ["forearms", Q],
    ],
    why: "the grip holds the whole set; a pull-up and a pulldown train the same movers",
    example: "Pull-Up",
  },
  {
    lift: "bent-over row",
    primary: "back",
    match: /\bbent over\b|\bpendlay\b|\bt bar\b|\byates\b|\bbarbell rows?\b/,
    synergists: [
      ["biceps", H],
      ["rear delts", H],
      ["forearms", Q],
      ["core", Q],
    ],
    why: "an unsupported hinge: the trunk braces for the whole set",
    example: "Barbell Bent Over Row",
  },
  {
    lift: "inverted row",
    primary: "back",
    match: /\binverted rows?\b|\b(?:ring|trx|bodyweight) rows?\b/,
    synergists: [
      ["biceps", H],
      ["rear delts", H],
      ["core", Q],
    ],
    why: "a reverse plank: the trunk holds the line",
    example: "Inverted Row",
  },
  {
    lift: "row",
    primary: "back",
    match: /\brows?\b/,
    synergists: [
      ["biceps", H],
      ["rear delts", H],
      ["forearms", Q],
    ],
    why: "a supported or cable row: the pad or seat takes the trunk out, the grip still works",
    example: "Chest-Supported Row",
  },

  // ---- carries and grip ----
  {
    lift: "loaded carry",
    primary: "forearms",
    match: /\bfarmer|\bcarry\b|\bcarries\b/,
    synergists: [
      ["shoulders", Q],
      ["core", Q],
    ],
    why: "the upper traps hold the load (filed under shoulders) and the trunk stays upright",
    example: "Farmer's Walk",
  },

  // ---- curls ----
  {
    lift: "hammer / reverse curl",
    primary: "biceps",
    match: /\bhammer curls?\b|\breverse (?:grip )?curls?\b|\bzottman\b/,
    synergists: [["forearms", Q]],
    why: "a neutral or overhand grip puts the brachioradialis to work",
    example: "Hammer Curl",
  },
];

function namedLift(text: string, nameGroup: MuscleGroup | null): NamedLift | null {
  if (!text || !nameGroup) return null;
  for (const row of NAMED_LIFTS) {
    if (!row.match.test(text)) continue;
    if (row.unless?.test(text)) continue;
    // The row describes THIS lift only when the classifier agrees on its prime mover.
    if (row.primary !== nameGroup) continue;
    return row;
  }
  return null;
}

// The agent's profile as a credit source, GAP-FILLING only. It speaks in exactly two places,
// both where the tables answer nothing: the primary of a lift with no stored group and no name
// classification, and the synergists of a lift no named-lift row and no movement pattern
// describes. A named lift or a known pattern is the curated answer, even when it lends nothing
// (a leg extension lends nothing on purpose); a person's stored group is never moved.
function profileSecondaries(profile: AppliedExerciseProfile | null, primary: MuscleGroup): Synergists {
  if (!profile) return [];
  const out: Array<readonly [MuscleGroup, number]> = [];
  for (const [rawGroup, share] of profile.secondary) {
    const group = canonicalGroup(rawGroup);
    if (!group || group === primary || group === "mobility") continue;
    if (share !== H && share !== Q) continue;
    if (!out.some(([g]) => g === group)) out.push([group, share] as const);
  }
  return out;
}

function creditsRead(exercise: string, storedGroup: string | null, useProfile = true): readonly MuscleCredit[] {
  return creditsDetail(exercise, storedGroup, useProfile).credits;
}

export interface CreditsDetail {
  credits: readonly MuscleCredit[];
  /** The tables settled this lift's mechanics (a named lift or a movement pattern), even if they lend nothing. */
  settled: boolean;
}

function creditsDetail(exercise: string, storedGroup: string | null, useProfile: boolean): CreditsDetail {
  const name = String(exercise ?? "");
  const nameGroup = classifyMuscleGroup(name);
  const profile = useProfile ? appliedProfileFor(name) : null;
  let primary = resolveGroup(name, storedGroup);
  let primaryFromProfile = false;
  if (!primary && profile) {
    const filled = canonicalGroup(profile.primary_group);
    if (filled) {
      primary = filled;
      primaryFromProfile = true;
    }
  }
  if (!primary || primary === "mobility") return { credits: [], settled: false };
  const credits: MuscleCredit[] = [{ group: primary, share: 1, role: "primary" }];
  // A core movement is never a press or a row: "Flat Bench Knee Raise" matches the push
  // rules on the word "bench" and must not lend triceps or shoulders anything.
  if (primary === "core") return { credits, settled: true };

  const add = (group: MuscleGroup, share: number) => {
    if (group === primary || group === "mobility" || !(share > 0)) return;
    const existing = credits.find((c) => c.group === group);
    if (existing) existing.share = Math.max(existing.share, share);
    else credits.push({ group, share, role: "secondary" });
  };

  let settled = false;
  const lift = namedLift(expandExerciseAbbreviations(name), nameGroup);
  if (lift) {
    settled = true;
    // A stored group that files the lift elsewhere ("Dips" kept under chest) still leaves
    // the lift's own prime mover working: it earns the counted half set.
    if (lift.primary !== primary) add(lift.primary, H);
    for (const [group, share] of lift.synergists) add(group, share);
  } else {
    // The stored group's own spelling first ("lats" reads as a vertical pull), then the
    // resolved primary — the hint the plan compiler always gave an unrecognized name. A primary
    // the AGENT supplied is no hint: only the name's own pattern speaks then.
    const pattern = primaryFromProfile
      ? classifyPatternCurated(name)
      : (classifyPatternCurated(name, storedGroup ?? undefined) ?? classifyPatternCurated(name, primary));
    if (pattern) {
      settled = true;
      for (const [group, share] of PATTERN_SYNERGISTS[pattern] ?? []) add(group, share);
    } else {
      for (const [group, share] of profileSecondaries(profile, primary)) add(group, share);
    }
  }
  return { credits, settled };
}

/**
 * The credit the CURATED tables give alone (no profile read), and whether they settled the lift's
 * mechanics. For the exercise detail's "does the agent disagree" read; not a hot path.
 */
export function curatedMuscleCredit(exercise: string, storedGroup?: string | null): CreditsDetail {
  return creditsDetail(String(exercise ?? ""), storedGroup == null ? null : String(storedGroup), false);
}

// Pure (constant tables, no global regexes): remembered per (stored group, name) in a
// bounded process-wide table, like classifyPattern — a Today open asks it thousands of
// times over a hundred names.
const CREDIT_CACHE_MAX = 4096;
const creditCache = new Map<string, readonly MuscleCredit[]>();
// The profile index the cache was filled under; a changed profile set drops every entry.
let creditCacheEpoch = -1;

/**
 * The cached credit list, shared and read-only. For hot internal readers (the volume
 * aggregators) that only iterate it; everyone else takes `muscleCreditFor`'s copy.
 */
export function muscleCreditsShared(exercise: string, storedGroup?: string | null): readonly MuscleCredit[] {
  const stored = storedGroup == null ? null : String(storedGroup);
  if (typeof exercise !== "string") return creditsRead(String(exercise ?? ""), stored);
  const epoch = exerciseProfileEpoch();
  if (epoch !== creditCacheEpoch) {
    creditCache.clear();
    creditCacheEpoch = epoch;
  }
  const key = `${stored ?? ""}\u0000${exercise}`;
  const hit = creditCache.get(key);
  if (hit) return hit;
  const value = Object.freeze(creditsRead(exercise, stored).map((c) => Object.freeze(c))) as readonly MuscleCredit[];
  if (creditCache.size >= CREDIT_CACHE_MAX) creditCache.clear();
  creditCache.set(key, value);
  return value;
}

/** The groups one set of this exercise credits, primary first. Empty when nothing can be told (or mobility). */
export function muscleCreditFor(exercise: string, storedGroup?: string | null): MuscleCredit[] {
  return muscleCreditsShared(exercise, storedGroup).map((c) => ({ ...c }));
}

/** The one primary-group resolver: the group a set of this exercise counts in full. Never mobility. */
export function primaryMuscleGroup(exercise: string, storedGroup?: string | null): MuscleGroup | null {
  return muscleCreditsShared(exercise, storedGroup)[0]?.group ?? null;
}

// Which prime movers a movement-pattern family can honestly have. Only a CHECK on the
// named-lift answer below (a "Plank to Push-Up" reads as core by pattern, so the push-up
// row's chest is not unanimous); never a source of a group by itself.
const PATTERN_PRIMARIES: Partial<Record<MovementPattern, readonly MuscleGroup[]>> = {
  squat: ["quads"],
  hinge: ["hamstrings", "glutes", "back"],
  lunge: ["quads", "glutes"],
  "hip-extension": ["glutes", "hamstrings"],
  "horizontal-push": ["chest", "triceps", "shoulders"],
  "vertical-push": ["shoulders", "triceps"],
  "horizontal-pull": ["back", "rear delts"],
  "vertical-pull": ["back"],
  calf: ["calves"],
  tibialis: ["calves"],
  core: ["core"],
  carry: ["forearms", "core", "shoulders"],
  curl: ["biceps", "forearms"],
  triceps: ["triceps"],
  "lateral-raise": ["shoulders"],
  "rear-delt": ["rear delts"],
  shrug: ["shoulders"],
  abduction: ["glutes"],
};

/**
 * The group the repo's curated knowledge settles for this exact lift, or null when it
 * does not settle one. Unanimous or nothing: the FIRST named-lift row the name matches
 * (the most specific lift it is), the name classifier, and the name's movement pattern
 * (when it has one) must all agree on the prime mover. A name the tables read two ways
 * ("Suitcase Carry": a carry row, a core classifier rule) is left to the agent or the
 * person; this never guesses.
 */
export function curatedMuscleGroup(exercise: string): MuscleGroup | null {
  const name = String(exercise ?? "");
  const text = expandExerciseAbbreviations(name);
  if (!text) return null;
  const row = NAMED_LIFTS.find((r) => r.match.test(text) && !r.unless?.test(text));
  if (!row) return null;
  if (classifyMuscleGroup(name) !== row.primary) return null;
  const pattern = classifyPattern(name);
  if (pattern && !PATTERN_PRIMARIES[pattern]?.includes(row.primary)) return null;
  return row.primary;
}

/** Does a weekly-volume read count this share? Primary and half shares count; quarter shares are touched only. */
export function isCountedShare(share: number): boolean {
  return share >= COUNTED_SHARE_MIN - 1e-9;
}
