// The capability read: progress judged per MOVEMENT UNIT and per MUSCLE GROUP, with the
// single lift as evidence. Contract: src/contracts/strength-capability.ts.
//
// The athlete substitutes freely (three pulldowns, four pressdowns, several rows and
// presses), so a read keyed on one exercise splits one muscle's progress across its
// variants and goes quiet on every swap. This read asks a different question: is the
// MOVEMENT getting stronger, whichever variation carried it, and is each MUSCLE being
// built? Deterministic, read-only, no agent, no schema, nothing stored, and never a
// score: directional words only.
//
// The evidence base it holds to:
//   - Strength is partly specific to the exercise. Each variant's estimate is its own
//     number and only its RELATIVE change carries across variants (variant-transfer.ts);
//     two histories are never merged, a load is never compared across lifts.
//   - Concurrent training interferes mainly with lower-body maximal strength, so a flat
//     leg unit while the running load ramps is the legs carrying the run build, not a
//     plateau (`run_build`).
//   - In a deficit, holding strength is success (`cut`).
//
// 1. UNITS. A compound lift's unit is its movement pattern (classifyPattern), the
//    horizontal push split by press slot the way movement regions split it (a slotless
//    horizontal push, a machine chest press or a push-up, presses flat). An isolation
//    lift's unit is its movement region (all pushdowns are one unit): the curated table
//    first, then the progress-only families (capability-region.ts: tibialis, hip
//    abduction and adduction, front raise, upright row, shrug, straight-arm pulldown,
//    chest fly, hip thrust, glute kickback, back extension, carry, four core families),
//    then the agent's profile, falling back to ONE catch-all per pattern, labelled in
//    plain words ("Other triceps work"). A catch-all of fewer than CATCH_ALL_MIN_LIFTS
//    lifts beside a named unit of its pattern is not listed (its sets still count for the
//    muscle). Compound or not is movement-standing's `isCompoundLift`, except that a
//    "raise" only a group hint files is never a compound. Names resolve through
//    `resolveExerciseName`, never raw. A lift with no pattern and no region forms no unit
//    and is absent, never guessed.
// 2. SERIES. Per variant, one exposure per comparable session
//    (`sessionCountsTowardLiftTrajectory`): the best Epley of the session. Bodyweight work
//    (pull-ups, dips, assisted work) reads on effective load, bodyweight plus added load
//    minus assist, so less assist is harder (CLAUDE.md "Assist is a sign"). An exposure
//    that was lighter ON PURPOSE (`exposureLighterOnPurpose`, a running recovery week, a
//    post-race window) is set aside for direction. Hard sets: a working set at
//    HARD_SET_LOAD_FRACTION of that session's working load (`sessionWorkingLoad`) or more
//    that reached the rep floor, RIR four or less or not logged.
// 3. CHANGE. A variant's capacity envelope (`capacityEnvelopeAsOf`) now against the one
//    a window earlier, movement-standing's thresholds. With no earlier window: its last
//    three exposures against its first three (four or more exposures), else a transfer
//    from a sibling (variant-transfer.ts), else nothing: the variant contributes nothing
//    yet and the unit carries on from its other contributors.
// 4. VERDICT. The unit's change is the mean of its contributors' changes weighted by
//    recent hard sets times lead tier. Evidence is counted in SESSIONS across the
//    contributors carrying a change: fewer than UNIT_MIN_SESSIONS is not enough yet;
//    slipping needs the decline on SLIPPING_MIN_EXPOSURES honest sessions and at least
//    SLIPPING_MIN_WINDOW_SESSIONS honest sessions in the current window; otherwise it holds.
// 5. MUSCLES. Weekly hard sets per canonical group (`effectiveVolumeByGroup`, counted
//    shares, so a band can never be read off touched shares), banded against
//    MUSCLE_LANDMARKS with program-state's trend rule. Direction: the unit verdicts
//    crediting the group (primary or counted share; a touched share never votes; a unit
//    never credits a group in UNIT_NEVER_CREDITS, so a tibialis raise is no calf work),
//    weighted by share times hard sets, AND the main unit (the most of that work) must
//    agree; slipping also needs slipping units carrying MUSCLE_SLIPPING_MIN_WORK_SHARE.
// 6. OVERALL over the compound units on the plan now.
//
// Memoized per request on the date, the wall day and the training-data version, the way
// program state is; inside one call, the calendar's lighter days and the carded sessions
// are each read once, never once per lift. Any read that throws makes the whole read
// `available:false`, or the one unit `not_enough`: a direction is never fabricated.
import { db } from "../db.js";
import { runWithBrainSnapshot } from "../brain/snapshot.js";
import { finite, plausibleRir } from "../lib/numbers.js";
import type {
  CapabilityContributor,
  CapabilityMuscle,
  CapabilityQualifier,
  CapabilityUnit,
  CapabilityVerdict,
  StrengthCapabilityRead,
} from "../contracts/strength-capability.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { cutReaffirmation } from "./cut-target.js";
import { violatesReadingGrammar } from "./day-read-grammar.js";
import {
  bodyRegion,
  canonicalGroup,
  isKnownBodyweightMovement,
  isMobility,
  isPlaceholderExerciseName,
  MUSCLE_GROUPS,
  MUSCLE_LANDMARKS,
  movementKey,
  type MuscleGroup,
  normalizeExerciseName,
  resolveExerciseName,
} from "./exercise-canon.js";
import { classifyPattern, effectiveVolumeByGroup, type VolumeSet } from "./exercise-variations.js";
import { sessionCountsTowardLiftTrajectory } from "./lift-comparability.js";
import { isCompoundLift, type LiftLeadTier, liftLeadTier } from "./movement-standing.js";
import { movementRegionKey } from "./movement-region.js";
import { progressRegionKey } from "./capability-region.js";
import { isCountedShare, muscleCreditsShared } from "./muscle-credit.js";
import { athleteBodyweightLb } from "./performance.js";
import { getEnduranceGoal } from "./profile.js";
import {
  finishedCapabilityRead,
  getProgramState,
  LIFT_CURRENT_WINDOW_DAYS,
  type ProgramState,
} from "./program-state.js";
import { raceBuild } from "./race-build.js";
import { finishedRacesBetween, raceRecoverySpan } from "./race-recovery.js";
import { activeRecoveryWeek } from "./recovery-week.js";
import { activeRecoveryWeekLedger, completedRecoveryWeekLedger } from "./recovery-week-ledger.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import { capacityEnvelopeAsOf, type StrengthExposure } from "./strength-objectives.js";
import { currentTrainingDataVersion } from "./training-cache.js";
import { variantTransfer } from "./variant-transfer.js";
import { exposureLighterOnPurpose, lighterOnPurposeReader } from "./whole-person-trajectory.js";
import { MIN_WORKING_REPS, sessionWorkingLoad } from "./working-load.js";

// ---------- the knobs ----------

/** How far back the read looks: four windows of four weeks. */
export const CAPABILITY_READ_DAYS = 112;
/** One window: the capacity envelope's own freshness span (movement-standing's MOVEMENT_WINDOW_DAYS). */
export const CAPABILITY_WINDOW_DAYS = 28;
// Direction thresholds, the same size and asymmetry as movement-standing's
// MOVEMENT_BETTER_CHANGE / MOVEMENT_WORSE_CHANGE (a test pins the equality). Declared
// here, not read from that module at load time: a top-level read of a cycle-mate's
// binding breaks a load order (test/moduleLoadOrder.test.js).
export const CAPABILITY_CLIMBING_CHANGE = 0.01;
export const CAPABILITY_SLIPPING_CHANGE = -0.015;
/**
 * A slide is said only when at least this many honest SESSIONS in the current window sit
 * below the earlier value (counted once per session, however many of the unit's variants
 * were trained in it).
 */
export const SLIPPING_MIN_EXPOSURES = 2;
/**
 * ...and only when the unit (or the variant) was trained in at least this many honest,
 * comparable sessions inside the current window. Session-to-session noise in an estimated
 * max runs a few percent, so two sessions cannot tell a slide from a bad day: a unit with
 * two or fewer never reads slipping (it holds).
 */
export const SLIPPING_MIN_WINDOW_SESSIONS = 3;
/**
 * Any verdict at all needs at least this many honest, comparable sessions across the
 * contributors that carry a change. Fewer is "not enough yet", never a direction: one
 * session then and one now is two data points, not a trend.
 */
export const UNIT_MIN_SESSIONS = 3;
/** The own-history fallback (last three against first three) needs this many exposures. */
export const FALLBACK_MIN_EXPOSURES = 4;
/** A hard set sits at this fraction of the session's working load or above. */
export const HARD_SET_LOAD_FRACTION = 0.8;
/** ...and is taken at this many reps in reserve or fewer (or with none logged). */
export const HARD_SET_MAX_RIR = 4;
/** The endurance acute:chronic ratio (program state) at which the running load is ramping. */
export const RUN_RAMP_ACWR = 1.15;
/** The muscle read's volume window, in weeks: program state's own band window. */
export const MUSCLE_VOLUME_WEEKS = 3;
// A contributor that has a change but logged no hard set (every set far from failure)
// still votes, lightly: its estimate moved, the sets just were not hard.
const MIN_VOTE_SETS = 0.5;
// Directional vote of a verdict, for the muscle and overall means.
const VERDICT_SCORE: Readonly<Record<string, number>> = { climbing: 1, holding: 0, slipping: -1 };
const DIRECTION_SHARE = 1 / 3;
// Movement-standing's tier weights (MOVEMENT_TIER_WEIGHT), restated for the load-order
// reason above; the test suite pins the equality.
export const CAPABILITY_TIER_WEIGHT: Readonly<Record<LiftLeadTier, number>> = { 0: 1, 1: 0.75, 2: 0.5, 3: 0.25 };

// ---------- unit identity ----------

type UnitIdentity = { key: string; kind: "pattern" | "region"; compound: boolean };

// The compound units in reading order; everything else follows by label.
const COMPOUND_ORDER = [
  "squat",
  "hinge",
  "lunge",
  "horizontal-push:flat",
  "horizontal-push:incline",
  "horizontal-push:decline",
  "vertical-push",
  "horizontal-pull",
  "vertical-pull",
];

// The noun a sentence uses for a unit ("Your squat strength is holding steady."), and,
// capitalized, its label. Never the key, never a lift name.
const UNIT_PHRASE: Readonly<Record<string, string>> = {
  squat: "squat",
  hinge: "hinge",
  lunge: "single-leg",
  "hip-extension": "hip extension",
  "horizontal-push:flat": "flat press",
  "horizontal-push:incline": "incline press",
  "horizontal-push:decline": "decline press",
  "vertical-push": "overhead press",
  "horizontal-pull": "row",
  "vertical-pull": "pulldown and pull-up",
  carry: "carry",
  dip: "dip",
  "vertical-press": "overhead press",
  "knee-extension": "leg extension",
  "knee-flexion": "leg curl",
  "calf:straight": "standing calf raise",
  "calf:bent": "seated calf raise",
  "curl:supinated": "curl",
  "curl:neutral": "hammer curl",
  "curl:pronated": "reverse curl",
  "triceps:pushdown": "pushdown",
  "triceps:overhead": "overhead triceps",
  "triceps:lying": "lying triceps",
  "triceps:kickback": "kickback",
  "triceps:extension": "triceps extension",
  "lateral-raise": "lateral raise",
  "rear-delt": "rear-delt",
  // The progress-only regions (capability-region.ts).
  tibialis: "tibialis raise",
  "hip-adduction": "hip adduction",
  "hip-abduction": "hip abduction",
  "front-raise": "front raise",
  "upright-row": "upright row",
  shrug: "shrug",
  "straight-arm-pull": "straight-arm pulldown",
  "chest-fly": "chest fly",
  "hip-thrust": "hip thrust",
  "glute-kickback": "glute kickback",
  "back-extension": "back extension",
  "core:lateral": "side core",
  "core:rotation": "core rotation",
  "core:anti-extension": "core bracing",
  "core:flexion": "crunch and leg raise",
};

// A catch-all unit (`<pattern>:accessory`: lifts of one pattern no region table names)
// is labelled by what it trains, in plain words: "Other triceps work" beside a named
// triceps unit, "Triceps work" alone. Never "<Pattern> accessory".
const CATCH_ALL_NOUN: Readonly<Record<string, string>> = {
  squat: "leg",
  hinge: "hinge",
  lunge: "single-leg",
  "hip-extension": "glute",
  "horizontal-push": "chest",
  "vertical-push": "shoulder",
  "horizontal-pull": "upper-back",
  "vertical-pull": "lat",
  calf: "calf",
  core: "core",
  carry: "carry",
  curl: "arm curl",
  triceps: "triceps",
  "lateral-raise": "shoulder raise",
  "rear-delt": "rear-delt",
  shrug: "shrug",
  tibialis: "shin",
  abduction: "hip",
};

/**
 * A catch-all holding fewer lifts than this, beside a named unit of its own pattern, is
 * not listed as a unit (one leftover lift is not a movement read); its hard sets still
 * count toward the muscle's weekly sets.
 */
export const CATCH_ALL_MIN_LIFTS = 2;

const CATCH_ALL_SUFFIX = ":accessory";

function catchAllPattern(key: string): string | null {
  return key.endsWith(CATCH_ALL_SUFFIX) ? key.slice(0, -CATCH_ALL_SUFFIX.length) : null;
}

function unitPhrase(key: string, besideNamed = false): string {
  const known = UNIT_PHRASE[key];
  if (known) return known;
  const pattern = catchAllPattern(key);
  if (pattern) {
    const noun = CATCH_ALL_NOUN[pattern] ?? pattern.replace(/[:-]+/g, " ");
    return besideNamed ? `other ${noun}` : noun;
  }
  return key.replace(/[:-]+/g, " ").trim();
}

function unitLabel(key: string, besideNamed = false): string {
  const phrase = unitPhrase(key, besideNamed);
  return capitalize(catchAllPattern(key) && !UNIT_PHRASE[key] ? `${phrase} work` : phrase);
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const PRESS_SLOT = /^horizontal-press:(flat|incline|decline)$/;
// A "raise" no name rule files is never a compound, whatever the group hint says: a
// cable Y raise filed under shoulders is not an overhead press.
const RAISE_WORD = /\braises?\b/i;

/** The unit a lift belongs to, or null when it has no pattern and no region. */
export function capabilityUnitOf(name: string, group: string | null): UnitIdentity | null {
  // Authority: the curated region table, then the progress-only families
  // (capability-region.ts), then (for a compound) the pattern, and only where the tables
  // say nothing the agent-filled profile (exercise-profile.ts). Today's card never takes
  // the progress families or the profile fill.
  const curated = movementRegionKey(name, group);
  if (!curated) {
    const family = progressRegionKey(name);
    if (family) return { key: family, kind: "region", compound: false };
  }
  const region = curated ?? movementRegionKey(name, group, { profile: true });
  const pattern = classifyPattern(name, group ?? undefined, { profile: true });
  const raiseByGroupOnly = RAISE_WORD.test(name) && !classifyPattern(name);
  if (!raiseByGroupOnly && isCompoundLift(name, group)) {
    if (pattern === "horizontal-push" || (region && PRESS_SLOT.test(region))) {
      const slot = region ? PRESS_SLOT.exec(region)?.[1] : null;
      return { key: `horizontal-push:${slot ?? "flat"}`, kind: "pattern", compound: true };
    }
    if (pattern) return { key: pattern, kind: "pattern", compound: true };
    if (region) return { key: region, kind: "region", compound: true };
    return null;
  }
  if (region) return { key: region, kind: "region", compound: false };
  if (pattern) return { key: `${pattern}${CATCH_ALL_SUFFIX}`, kind: "pattern", compound: false };
  return null;
}

// ---------- the read's rows ----------

type CapSet = {
  session_id: number;
  date: string;
  exercise_id: number;
  exercise: string;
  muscle_group: string | null;
  equipment: string | null;
  input_profile: string | null;
  weight: number | null;
  reps: number;
  rir: number | null;
};

type Exposure = StrengthExposure & { session_id: number; aside: boolean };

type HardSet = { date: string; exercise: string; muscle_group: string | null };

type Variant = {
  id: number;
  name: string;
  group: string | null;
  unit: UnitIdentity;
  tier: LiftLeadTier;
  bodyweight: boolean;
  sets: CapSet[];
  lastTrained: string;
  /** One per comparable session, date order. */
  exposures: Exposure[];
  hardSets: HardSet[];
  hardNow: number;
  hardPrev: number;
  inPlan: boolean;
  /** Its movement pattern (classifyPattern), for the catch-all rule. */
  pattern: string | null;
};

type VariantRead = {
  change: number | null;
  /** The earlier value the change is read against (own, or transferred). */
  reference: number | null;
  transfer: CapabilityContributor["transfer"];
  /** Sessions whose honest exposure in the current window sits at or below the slipping line. */
  declines: number[];
  direction: CapabilityVerdict;
};

// How much evidence a verdict stands on: honest comparable sessions in the read, the ones
// in the current window, and the current-window sessions below the slipping line.
type Evidence = { sessions: number; sessionsNow: number; declines: number };

type ReadContext = {
  date: string;
  /** One window back: the day the earlier envelope is read as of (never named `then`: a thenable). */
  earlier: string;
  prevFrom: string;
  cut: boolean;
  recovery: boolean;
  runBuild: boolean;
  /** Unit keys any plan item falls in. */
  planUnits: Set<string>;
};

function readRows(from: string, to: string): CapSet[] {
  // Deliberately NOT wrapped: a failed query is a failed read (available:false).
  return (
    db
      .prepare(
        `SELECT s.id AS session_id, s.date AS date, e.id AS exercise_id, e.name AS exercise,
                e.muscle_group AS muscle_group, e.equipment AS equipment, e.input_profile AS input_profile,
                ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
           FROM logged_sets ls
           JOIN sessions s ON s.id = ls.session_id
           JOIN exercises e ON e.id = ls.exercise_id
          WHERE s.date BETWEEN ? AND ? AND ls.reps > 0 AND ls.duration_sec IS NULL
            AND COALESCE(e.mode, 'reps') <> 'timed'
          ORDER BY s.date, ls.id`
      )
      .all(from, to) as any[]
  ).map((row) => ({
    session_id: Number(row.session_id),
    date: String(row.date).slice(0, 10),
    exercise_id: Number(row.exercise_id),
    exercise: String(row.exercise ?? ""),
    muscle_group: row.muscle_group == null ? null : String(row.muscle_group),
    equipment: row.equipment == null ? null : String(row.equipment),
    input_profile: row.input_profile == null ? null : String(row.input_profile).toLowerCase(),
    weight: finite(row.weight),
    reps: Number(row.reps),
    rir: plausibleRir(row.rir),
  }));
}

// What is on the plan now, as identities. A LIFT is on the plan by program state's own
// family match (program-state.ts `planLiftIndex`, private there, restated here; keep the
// two in step): its row id, the row its name resolves to, its resolver key, or a shared
// movement key. A UNIT is on the plan when any plan item falls in it
// (`capabilityUnitOf`), so the pulldown he substitutes at the gym keeps the plan's pulldown
// unit on the plan and inside the overall read.
type PlanIndex = { ids: Set<number>; keys: Set<string>; families: Set<string>; units: Set<string> };

type Resolve = (name: string) => ReturnType<typeof resolveExerciseName>;

function planIndex(resolve: Resolve = resolveExerciseName): PlanIndex {
  const index: PlanIndex = { ids: new Set(), keys: new Set(), families: new Set(), units: new Set() };
  // Deliberately NOT wrapped: a failed plan read is a failed read (available:false).
  const rows = db
    .prepare(
      `SELECT DISTINCT e.id AS id, e.name AS name, e.muscle_group AS muscle_group
         FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
        WHERE pi.exercise_id IS NOT NULL AND COALESCE(pi.kind, 'strength') != 'cardio'`
    )
    .all() as any[];
  for (const row of rows) {
    const name = String(row.name ?? "");
    const group = row.muscle_group == null ? null : String(row.muscle_group);
    index.ids.add(Number(row.id));
    const resolved = resolve(name);
    if (resolved.exercise_id != null) index.ids.add(Number(resolved.exercise_id));
    if (resolved.key) index.keys.add(resolved.key);
    for (const n of [name, resolved.canonical]) {
      const family = movementKey(n) || normalizeExerciseName(n);
      if (family) index.families.add(family);
    }
    const unit = capabilityUnitOf(resolved.canonical || name, group);
    if (unit) index.units.add(unit.key);
  }
  return index;
}

// Is this lift itself written on the plan (program state's rule, literal per lift)?
function liftOnPlan(
  plan: PlanIndex,
  rowId: number,
  resolved: ReturnType<typeof resolveExerciseName>,
  name: string
): boolean {
  return (
    plan.ids.has(rowId) ||
    (resolved.exercise_id != null && plan.ids.has(Number(resolved.exercise_id))) ||
    (!!resolved.key && plan.keys.has(resolved.key)) ||
    plan.families.has(movementKey(name) || normalizeExerciseName(name))
  );
}

// ---- bodyweight work (a commented private copy of movement-standing.ts) ----
// movement-standing.ts keeps `isBodyweightMember` and its effective-load series private;
// the same rules are restated here so this read holds bodyweight work to them. Keep the
// two in step.
const WEIGHTED_OR_ASSISTED_WORD = /\b(?:weighted|assisted)\b/gi;
// Only orders bodyweight sets against each other when no bodyweight is on record
// (movement-standing's RANKING_BODYWEIGHT_LB). Never shown, never compared across lifts.
const RANKING_BODYWEIGHT_LB = 170;

function isBodyweightVariant(name: string, sets: CapSet[]): boolean {
  const stated = sets.find((row) => row.input_profile)?.input_profile ?? null;
  if (stated === "bodyweight") return true;
  if (stated === "loaded") return false;
  const equipment = sets.find((row) => row.equipment)?.equipment ?? null;
  const bare = name.replace(WEIGHTED_OR_ASSISTED_WORD, " ").replace(/\s+/g, " ").trim();
  if (bare && isKnownBodyweightMovement(bare, equipment)) return true;
  if (sets.some((row) => row.weight != null && row.weight < 0)) return true;
  const unloaded = sets.filter((row) => row.weight == null || row.weight <= 0).length;
  return unloaded * 2 >= sets.length;
}

// The load a set's estimate reads: the plates for loaded work; for bodyweight work the
// effective load (bodyweight plus added, assist negative), held at TODAY's bodyweight so
// a cut never reads as a weaker pull-up. Without a known bodyweight only plain
// bodyweight sets compare (the bodyweight cancels out of every ratio).
function estimateLoad(set: CapSet, bodyweight: boolean, bw: number | null): number | null {
  if (!bodyweight) return set.weight != null && set.weight > 0 ? set.weight : null;
  const added = set.weight ?? 0;
  if (bw == null) return added === 0 ? 1 : null;
  const load = bw + added;
  return load > 0 ? load : null;
}

// The load a set is ranked at inside its session (the hard-set test).
function rankLoad(set: CapSet, bodyweight: boolean, bw: number | null): number | null {
  if (!bodyweight) return set.weight != null && set.weight > 0 ? set.weight : null;
  const load = (bw ?? RANKING_BODYWEIGHT_LB) + (set.weight ?? 0);
  return load > 0 ? load : null;
}

const epley = (load: number, reps: number) => load * (1 + reps / 30);

// ---------- context reads (each fail-soft: a failed read is an absent qualifier) ----------

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function raceBuildRamping(date: string): boolean {
  const goal = getEnduranceGoal(date);
  if (!goal?.is_race || !goal.date || String(goal.date).slice(0, 10) < date) return false;
  const build = raceBuild(date, { weekLayout: null, templateRing: true });
  if (!build.available) return false;
  const week = build.weeks.find((w) => w.current) ?? null;
  return week != null && (week.kind === "build" || week.kind === "peak");
}

// Running load ramping, from the reads that already own it: the endurance acute:chronic
// ratio, the hybrid read asking to shift the legs, or a race build in a build or peak week.
function runBuildActive(date: string, programState: ProgramState | null): boolean {
  const acwr = finite(programState?.endurance?.acute_chronic_ratio);
  if (acwr != null && acwr >= RUN_RAMP_ACWR) return true;
  if (programState?.hybrid?.status === "shift-legs") return true;
  return safe(() => raceBuildRamping(date), false);
}

// Days whose lifting was lighter on purpose for a reason outside the card: a race and the
// post-race window after it. Fail-soft: none.
function postRaceDates(from: string, to: string): Set<string> {
  const out = new Set<string>();
  for (const race of safe(() => finishedRacesBetween(addDaysISO(from, -7) ?? from, to), [])) {
    out.add(race.run_date);
    const span = raceRecoverySpan(race);
    if (!span) continue;
    for (let day = span.from; day <= span.to; day = addDaysISO(day, 1) ?? "9999-12-31") out.add(day);
  }
  return out;
}

// ---------- the calendar's lighter days, asked once per read (cost) ----------
//
// The per-lift reads below used to ask the same session- and date-level questions once
// per (lift, session): a few thousand small queries outside a request scope, a couple of
// hundred inside one. These two readers ask each question once per READ instead, and
// answer exactly what the per-call reads answer. Nothing here outlives the call.

/**
 * Is `date` inside a running recovery week (`activeRecoveryWeek(date) != null`), for
 * dates in [from, to], asked once per read. Before the earliest stored recovery cycle,
 * `activeRecoveryWeek` can only answer from the recovery-week LEDGER, whose window is one
 * fixed span ([applied_on, until)); that span is read once. From the earliest cycle on,
 * every date is asked as before (once). A failed read of either falls back to asking.
 * Exported for the test that holds it to `activeRecoveryWeek`.
 */
export function recoveryWeekReader(from: string, to: string): (date: string) => boolean {
  const asked = new Map<string, boolean>();
  const ask = (date: string): boolean => {
    let hit = asked.get(date);
    if (hit == null) {
      hit = safe(() => activeRecoveryWeek(date) != null, false);
      asked.set(date, hit);
    }
    return hit;
  };
  let firstCycle: string;
  let ledger: { applied_on: string; until: string } | null;
  try {
    const row = db.prepare(`SELECT MIN(effective_on) AS first FROM recovery_cycles`).get() as { first?: unknown };
    firstCycle = row?.first == null ? "9999-12-31" : String(row.first).slice(0, 10);
    ledger = activeRecoveryWeekLedger(to) ?? completedRecoveryWeekLedger(to);
  } catch {
    return ask;
  }
  return (date: string): boolean => {
    if (date < from || date > to || date >= firstCycle) return ask(date);
    return ledger != null && date >= ledger.applied_on && date < ledger.until;
  };
}

/**
 * The sessions in [from, to] that carry a stored card outcome, or null when the read
 * failed (ask every session). A session with none was never prescribed anything, so no
 * card asked it for less (`exposureLighterOnPurpose` reads that row and nothing else once
 * the session counts toward the trajectory).
 */
function cardedSessionIds(from: string, to: string): Set<number> | null {
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT o.session_id AS session_id
           FROM daily_session_outcomes o JOIN sessions s ON s.id = o.session_id
          WHERE s.date BETWEEN ? AND ?`
      )
      .all(from, to) as Array<{ session_id: unknown }>;
    return new Set(rows.map((row) => Number(row.session_id)));
  } catch {
    return null;
  }
}

type AsideReads = {
  onDate: (date: string) => boolean;
  carded: Set<number> | null;
  /** `exposureLighterOnPurpose(sessionId, lift)` for a session that counts toward the trajectory, batched once per read. */
  lighter: (sessionId: number, exercise: string) => boolean;
};

// ---------- per-variant series ----------

function buildVariant(variant: Variant, bw: number | null, ctx: ReadContext, aside: AsideReads): void {
  const bySession = new Map<number, CapSet[]>();
  for (const set of variant.sets) {
    const list = bySession.get(set.session_id);
    if (list) list.push(set);
    else bySession.set(set.session_id, [set]);
  }
  for (const [sessionId, sets] of bySession) {
    const date = sets[0].date;
    // Hard sets: volume is volume, whatever the session's comparability.
    const ranked = sets.map((s) => ({ set: s, load: rankLoad(s, variant.bodyweight, bw) }));
    const working = sessionWorkingLoad(ranked.map((r) => ({ weight: r.load, reps: r.set.reps })));
    if (working != null) {
      for (const { set, load } of ranked) {
        if (load == null || load < working * HARD_SET_LOAD_FRACTION) continue;
        if (set.reps < MIN_WORKING_REPS) continue;
        if (set.rir != null && set.rir > HARD_SET_MAX_RIR) continue;
        variant.hardSets.push({ date, exercise: variant.name, muscle_group: variant.group });
        if (date >= ctx.earlier) variant.hardNow++;
        else if (date >= ctx.prevFrom) variant.hardPrev++;
      }
    }
    if (!sessionCountsTowardLiftTrajectory(sessionId)) continue;
    let best: StrengthExposure | null = null;
    for (const set of sets) {
      const load = estimateLoad(set, variant.bodyweight, bw);
      if (load == null) continue;
      const est = epley(load, set.reps);
      if (!best || est > best.est_1rm) best = { date, top_weight: load, top_reps: set.reps, est_1rm: est };
    }
    if (!best) continue;
    // The session counts (not a compliant recovery session), so what remains of
    // exposureLighterOnPurpose is the card's own ask: only a carded session can have one.
    // Asked through the read's one batched reader (every carded session's outcome row in
    // one query), with the recovery-dose read skipped because the line above just did it.
    const lighter =
      aside.onDate(date) ||
      ((aside.carded == null || aside.carded.has(sessionId)) && safe(() => aside.lighter(sessionId, variant.name), false));
    variant.exposures.push({ ...best, session_id: sessionId, aside: lighter });
  }
  variant.exposures.sort((a, b) => a.date.localeCompare(b.date) || a.session_id - b.session_id);
}

const honestOf = (v: Variant): StrengthExposure[] => v.exposures.filter((e) => !e.aside);

function bestOf(points: StrengthExposure[]): StrengthExposure | null {
  return points.reduce<StrengthExposure | null>((best, p) => (!best || p.est_1rm > best.est_1rm ? p : best), null);
}

function longestGapDays(points: StrengthExposure[]): number {
  let longest = 0;
  for (let i = 1; i < points.length; i++) {
    const gap = daysBetweenISO(points[i].date, points[i - 1].date) ?? 0;
    if (gap > longest) longest = gap;
  }
  return longest;
}

function declinesBelow(v: Variant, reference: number, ctx: ReadContext): number[] {
  const line = reference * (1 + CAPABILITY_SLIPPING_CHANGE);
  return v.exposures
    .filter((e) => !e.aside && e.date >= ctx.earlier && e.est_1rm <= line + 1e-9)
    .map((e) => e.session_id);
}

// The honest comparable sessions one variant stands on, all and in the current window.
function addSessions(v: Variant, ctx: ReadContext, all: Set<number>, now: Set<number>): void {
  for (const e of v.exposures) {
    if (e.aside) continue;
    all.add(e.session_id);
    if (e.date >= ctx.earlier) now.add(e.session_id);
  }
}

// The verdict from a change and the evidence under it. Fail closed: too few sessions is
// not enough yet, and a decline on thin evidence holds rather than slips.
function directionOf(change: number | null, evidence: Evidence): CapabilityVerdict {
  if (change == null || !Number.isFinite(change)) return "not_enough";
  if (evidence.sessions < UNIT_MIN_SESSIONS) return "not_enough";
  if (change >= CAPABILITY_CLIMBING_CHANGE) return "climbing";
  if (
    change <= CAPABILITY_SLIPPING_CHANGE &&
    evidence.declines >= SLIPPING_MIN_EXPOSURES &&
    evidence.sessionsNow >= SLIPPING_MIN_WINDOW_SESSIONS
  )
    return "slipping";
  return "holding";
}

const NO_READ: VariantRead = { change: null, reference: null, transfer: "none", declines: [], direction: "not_enough" };

function finishRead(
  v: Variant,
  change: number,
  reference: number,
  transfer: VariantRead["transfer"],
  ctx: ReadContext
): VariantRead {
  const declines = change < 0 ? declinesBelow(v, reference, ctx) : [];
  const all = new Set<number>();
  const now = new Set<number>();
  addSessions(v, ctx, all, now);
  const direction = directionOf(change, { sessions: all.size, sessionsNow: now.size, declines: declines.length });
  return { change, reference, transfer, declines, direction };
}

// A variant's change: its own two windows, its own last three against its first three,
// a transfer from a sibling, or nothing.
function readVariant(v: Variant, siblings: Variant[], ctx: ReadContext): VariantRead {
  const all: StrengthExposure[] = v.exposures;
  const honest = honestOf(v);
  const rawNow = capacityEnvelopeAsOf(all, ctx.date);
  // Not trained in the current window: no "now", contributes nothing.
  if (!rawNow) return NO_READ;
  const rawThen = capacityEnvelopeAsOf(all, ctx.earlier);
  const honestNow = capacityEnvelopeAsOf(honest, ctx.date);
  const honestThen = rawThen && rawThen.est_1rm > 0 ? capacityEnvelopeAsOf(honest, ctx.earlier) : null;
  // Only the earlier window's HONEST envelope is a baseline: an earlier window that was all
  // lighter on purpose (a deload) is none, so a climb is never measured against it and the
  // next rule reads instead.
  if (honestThen && honestThen.est_1rm > 0) {
    if (honestNow)
      return finishRead(v, honestNow.est_1rm / honestThen.est_1rm - 1, honestThen.est_1rm, "own", ctx);
    // The CURRENT window was all lighter on purpose: the raw change counts only upward,
    // so a deload never reads as a slide.
    return finishRead(v, Math.max(0, rawNow.est_1rm / honestThen.est_1rm - 1), honestThen.est_1rm, "own", ctx);
  }
  if (!honestNow) return NO_READ;
  if (honest.length >= FALLBACK_MIN_EXPOSURES) {
    // A lift back after a break starts fresh (program state's rule): a series with a gap
    // longer than the current window would compare today with numbers from before the
    // rest, so it gives no read, never a slide off stale sessions.
    if (longestGapDays(honest) > LIFT_CURRENT_WINDOW_DAYS) return NO_READ;
    const first = bestOf(honest.slice(0, 3));
    const last = bestOf(honest.slice(-3));
    if (first && last && first.est_1rm > 0)
      return finishRead(v, last.est_1rm / first.est_1rm - 1, first.est_1rm, "own", ctx);
  }
  // Chain-link across a swap: a sibling's earlier envelope, through a ratio.
  const candidates = siblings
    .map((s) => ({ s, honest: honestOf(s) }))
    .map((c) => ({ ...c, earlierEnv: capacityEnvelopeAsOf(c.honest, ctx.earlier) }))
    .filter((c) => c.earlierEnv && c.earlierEnv.est_1rm > 0)
    .sort((a, b) => a.s.tier - b.s.tier || b.s.hardPrev - a.s.hardPrev || a.s.name.localeCompare(b.s.name));
  // A learned ratio from the first sibling that has one, else the first table edge: asked
  // in candidate order and stopped at the first learned ratio (the bridge search is the
  // costliest step of the read).
  type Pick = { c: (typeof candidates)[number]; t: ReturnType<typeof variantTransfer> };
  let pick: Pick | null = null;
  let table: Pick | null = null;
  for (const c of candidates) {
    const t = variantTransfer({ name: v.name, exposures: honest }, { name: c.s.name, exposures: c.honest });
    if (t.kind === "learned") {
      pick = { c, t };
      break;
    }
    if (t.kind === "table" && !table) table = { c, t };
  }
  pick ??= table;
  if (!pick || pick.t.kind === "none" || !pick.c.earlierEnv) return NO_READ;
  const reference = pick.c.earlierEnv.est_1rm * pick.t.ratio;
  if (!(reference > 0)) return NO_READ;
  let change = honestNow.est_1rm / reference - 1;
  // The table's ratios sit at the low end of the usual range, so its estimate of the
  // earlier value is low: it may confirm a hold or show a slide, never manufacture a climb.
  if (pick.t.kind === "table") change = Math.min(0, change);
  return finishRead(v, change, reference, pick.t.kind, ctx);
}

// ---------- sentences (variant sets keyed on the fact asserted) ----------

type LeadQualifier = CapabilityQualifier | "none";

const UNIT_LINES: Readonly<Record<string, readonly string[]>> = {
  "climbing:none": [
    "Your {p} strength is climbing, whichever variation you use.",
    "Your {p} work is getting stronger across the variations.",
    "Your {p} strength is moving up.",
  ],
  "holding:none": ["Your {p} strength is holding steady.", "Your {p} work is holding where it was."],
  "holding:cut": [
    "Your {p} strength is holding through the cut, which is the win in a deficit.",
    "Holding through the cut: your {p} strength is right where it was.",
  ],
  "holding:run_build": [
    "Your legs are carrying the run build, and your {p} strength is holding.",
    "With the run build on your legs, your {p} strength is holding right on track.",
  ],
  "holding:recovery": [
    "A lighter week is running, and your {p} strength is holding.",
    "Your {p} strength is holding through the lighter week.",
  ],
  "slipping:none": ["Your {p} strength has slipped a little lately.", "Your {p} work has eased off a little lately."],
  "slipping:cut": [
    "Your {p} strength has eased a little during the cut.",
    "The cut is costing your {p} strength a little lately.",
  ],
  "slipping:run_build": [
    "Your {p} strength has eased while your legs carry the run build.",
    "Your legs are carrying the run build, and your {p} strength has eased a little.",
  ],
  "slipping:recovery": [
    "Your {p} strength has eased a little, with a lighter week running.",
    "A lighter week is running, and your {p} strength has eased a little.",
  ],
  "not_enough:none": [
    "Not enough comparable sessions yet to read your {p} strength.",
    "Your {p} work needs a few more comparable sessions before it reads clearly.",
  ],
};

const MUSCLE_LINES: Readonly<Record<string, readonly string[]>> = {
  "progressing:none": [
    "Your {g} {is} progressing across the lifts that train {them}.",
    "Your {g} {is} getting stronger, whichever lifts carry the work.",
  ],
  "holding:none": ["Your {g} {is} holding steady.", "Your {g} {is} holding where {they} {was}."],
  "holding:cut": [
    "Your {g} {is} holding through the cut.",
    "Holding through the cut: your {g} {is} right where {they} {was}.",
  ],
  "holding:run_build": [
    "Your {g} {is} carrying the run build and holding.",
    "With the run build on your legs, your {g} {is} holding.",
  ],
  "holding:recovery": ["Your {g} {is} holding through the lighter week."],
  "slipping:none": ["Your {g} {has} eased a little lately."],
  "slipping:cut": ["Your {g} {has} eased a little during the cut."],
  "slipping:run_build": ["Your {g} {has} eased a little while carrying the run build."],
  "slipping:recovery": ["Your {g} {has} eased a little, with a lighter week running."],
  "not_enough:none": [
    "Not enough comparable sessions yet to read your {g}.",
    "Your {g} need{s} a few more comparable sessions before {they} read{s} clearly.",
  ],
};

const OVERALL_LINES: Readonly<Record<string, readonly string[]>> = {
  "climbing:none": ["Overall, your main lifts are getting stronger.", "Across your main lifts, strength is climbing."],
  "holding:none": ["Overall, your strength is holding steady.", "Across your main lifts, strength is holding."],
  "holding:cut": [
    "Overall, your strength is holding through the cut, which is the goal right now.",
    "Your main lifts are holding through the cut.",
  ],
  "holding:run_build": ["Overall, your strength is holding while your legs carry the run build."],
  "holding:recovery": ["Overall, your strength is holding through the lighter week."],
  "slipping:none": ["Overall, your main lifts have eased a little lately."],
  "slipping:cut": ["Overall, your main lifts have eased a little during the cut."],
  "slipping:run_build": ["Overall, your main lifts have eased a little while your legs carry the run build."],
  "slipping:recovery": ["Overall, your main lifts have eased a little, with a lighter week running."],
  "not_enough:none": ["Not enough comparable sessions yet for an overall read."],
};

// The safe floor for each verdict, used only if a composed line ever broke the reading grammar.
const FLOOR_LINE: Readonly<Record<string, string>> = {
  climbing: "Strength is climbing.",
  progressing: "Strength is climbing.",
  holding: "Strength is holding steady.",
  slipping: "Strength has eased a little lately.",
  not_enough: "Not enough comparable sessions yet.",
};

function leadQualifier(qualifiers: readonly CapabilityQualifier[]): LeadQualifier {
  // The most specific explanation speaks: a lighter week, then the run build, then the cut.
  if (qualifiers.includes("recovery")) return "recovery";
  if (qualifiers.includes("run_build")) return "run_build";
  if (qualifiers.includes("cut")) return "cut";
  return "none";
}

function pickLine(
  table: Readonly<Record<string, readonly string[]>>,
  verdict: string,
  qualifiers: readonly CapabilityQualifier[],
  date: string,
  keyPrefix: string,
  fill: (template: string) => string
): string {
  const lead =
    verdict === "climbing" || verdict === "progressing" || verdict === "not_enough"
      ? "none"
      : leadQualifier(qualifiers);
  const factKey = `${verdict}:${lead}`;
  const set = table[factKey] ?? table[`${verdict}:none`] ?? [];
  const template = set.length ? pickDayVariant(set, date, `${keyPrefix}:${factKey}`) : "";
  const line = template ? fill(template) : "";
  return line && !violatesReadingGrammar(line) ? line : (FLOOR_LINE[verdict] ?? FLOOR_LINE.not_enough);
}

// "Your chest is", "your quads are": most group names are plural nouns.
const SINGULAR_GROUPS = new Set(["chest", "back", "core"]);

function fillMuscle(template: string, group: string): string {
  const singular = SINGULAR_GROUPS.has(group);
  return template
    .replace(/\{g\}/g, group)
    .replace(/\{is\}/g, singular ? "is" : "are")
    .replace(/\{has\}/g, singular ? "has" : "have")
    .replace(/\{was\}/g, singular ? "was" : "were")
    .replace(/\{them\}/g, singular ? "it" : "them")
    .replace(/\{they\}/g, singular ? "it" : "they")
    .replace(/\{s\}/g, singular ? "s" : "");
}

// ---------- the read ----------

function scoreMean(votes: Array<{ verdict: string; weight: number }>): number | null {
  let sum = 0;
  let weights = 0;
  for (const vote of votes) {
    const score = VERDICT_SCORE[vote.verdict];
    if (score == null || !(vote.weight > 0)) continue;
    sum += score * vote.weight;
    weights += vote.weight;
  }
  return weights > 0 ? sum / weights : null;
}

const voteSets = (v: Variant, read: VariantRead) =>
  read.change != null ? Math.max(v.hardNow, MIN_VOTE_SETS) : v.hardNow;

function hardSetsTrend(now: number, prev: number): CapabilityUnit["hard_sets_trend"] {
  if (now <= 0 && prev <= 0) return null;
  if (now > prev * 1.2) return "rising";
  if (now < prev * 0.8) return "falling";
  return "steady";
}

function isLowerBody(variants: Variant[]): boolean {
  let lower = 0;
  for (const v of variants) {
    const primary = muscleCreditsShared(v.name, v.group)[0]?.group ?? null;
    if (primary && bodyRegion(primary) === "lower") lower++;
  }
  return lower * 2 > variants.length;
}

type UnitBuild = { unit: CapabilityUnit; variants: Variant[]; reads: Map<number, VariantRead> };

function buildUnit(identity: UnitIdentity, variants: Variant[], ctx: ReadContext, besideNamed = false): UnitBuild {
  const phrase = unitPhrase(identity.key, besideNamed);
  const label = unitLabel(identity.key, besideNamed);
  const reads = new Map<number, VariantRead>();
  const inPlan = ctx.planUnits.has(identity.key) || variants.some((v) => v.inPlan);
  const qualifiersFor = (verdict: CapabilityVerdict): CapabilityQualifier[] => {
    if (verdict !== "holding" && verdict !== "slipping") return [];
    const out: CapabilityQualifier[] = [];
    if (ctx.cut) out.push("cut");
    if (ctx.runBuild && isLowerBody(variants)) out.push("run_build");
    if (ctx.recovery) out.push("recovery");
    return out;
  };
  const contributorsOf = (): CapabilityContributor[] =>
    [...variants]
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          b.hardNow - a.hardNow ||
          b.lastTrained.localeCompare(a.lastTrained) ||
          a.name.localeCompare(b.name)
      )
      .map((v) => {
        const read = reads.get(v.id) ?? NO_READ;
        return {
          exercise: v.name,
          exercise_id: v.id,
          in_plan: v.inPlan,
          last_trained: v.lastTrained || null,
          exposures: v.exposures.filter((e) => !e.aside).length,
          direction: read.direction,
          transfer: read.transfer,
        };
      });
  try {
    let weighted = 0;
    let weights = 0;
    // Evidence is counted in SESSIONS across the contributors that carry a change: two
    // variants trained in one session are one session, never two.
    const sessions = new Set<number>();
    const sessionsNow = new Set<number>();
    const declines = new Set<number>();
    for (const v of variants) {
      const read = readVariant(
        v,
        variants.filter((s) => s !== v),
        ctx
      );
      reads.set(v.id, read);
      if (read.change == null || !Number.isFinite(read.change)) continue;
      const weight = Math.max(v.hardNow, MIN_VOTE_SETS) * CAPABILITY_TIER_WEIGHT[v.tier];
      weighted += read.change * weight;
      weights += weight;
      addSessions(v, ctx, sessions, sessionsNow);
      if (read.change < 0) for (const id of read.declines) declines.add(id);
    }
    const change = weights > 0 ? weighted / weights : null;
    const verdict = directionOf(change, {
      sessions: sessions.size,
      sessionsNow: sessionsNow.size,
      declines: declines.size,
    });
    const qualifiers = qualifiersFor(verdict);
    const now = variants.reduce((sum, v) => sum + v.hardNow, 0);
    const prev = variants.reduce((sum, v) => sum + v.hardPrev, 0);
    return {
      unit: {
        key: identity.key,
        label,
        kind: identity.kind,
        compound: identity.compound,
        in_plan: inPlan,
        verdict,
        qualifiers,
        hard_sets_trend: hardSetsTrend(now, prev),
        line: pickLine(UNIT_LINES, verdict, qualifiers, ctx.date, `capability:${identity.key}`, (t) =>
          t.replace(/\{p\}/g, phrase)
        ),
        contributors: contributorsOf(),
      },
      variants,
      reads,
    };
  } catch {
    // A unit whose read threw says not enough yet: never a fabricated direction.
    reads.clear();
    return {
      unit: {
        key: identity.key,
        label,
        kind: identity.kind,
        compound: identity.compound,
        in_plan: inPlan,
        verdict: "not_enough",
        qualifiers: [],
        hard_sets_trend: null,
        line: pickLine(UNIT_LINES, "not_enough", [], ctx.date, `capability:${identity.key}`, (t) =>
          t.replace(/\{p\}/g, phrase)
        ),
        contributors: contributorsOf(),
      },
      variants,
      reads,
    };
  }
}

function unitOrder(a: CapabilityUnit, b: CapabilityUnit): number {
  if (a.compound !== b.compound) return a.compound ? -1 : 1;
  const ai = COMPOUND_ORDER.indexOf(a.key);
  const bi = COMPOUND_ORDER.indexOf(b.key);
  if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  return a.label.localeCompare(b.label);
}

// A unit never credits a group its movement does not train, whatever the shared credit
// table files it under. Tibialis anterior is not a calf: a tibialis raise is dorsiflexion,
// the calves plantar-flex, and the canon only files it beside them for want of a group of
// its own. So a tibialis unit neither votes in the calves' direction nor adds to their sets.
export const UNIT_NEVER_CREDITS: Readonly<Record<string, readonly string[]>> = { tibialis: ["calves"] };

// The muscle's direction follows the units that carry its recent work: each crediting
// unit weighs share x its contributors' hard sets in the current window. The direction
// needs MUSCLE_DIRECTION_SHARE of that weighted vote, AND agreement from the MAIN unit (the
// one carrying the most of the muscle's recent work): a muscle never reads progressing
// while its main unit is not climbing, nor slipping while its main unit is not slipping.
/** The weighted vote a muscle's direction needs (a third, the overall read's own share). */
export const MUSCLE_DIRECTION_SHARE = DIRECTION_SHARE;
/** A muscle reads slipping only when its slipping units carry at least this share of its recent work. */
export const MUSCLE_SLIPPING_MIN_WORK_SHARE = 0.5;

type MuscleVote = { build: UnitBuild; weight: number };

function muscleVerdict(votes: MuscleVote[]): CapabilityMuscle["verdict"] {
  const mean = scoreMean(votes.map((u) => ({ verdict: u.build.unit.verdict, weight: u.weight })));
  if (mean == null) return "not_enough";
  // The main unit: the most work; ties go to the unit read first (compound, then key order).
  let main: MuscleVote | null = null;
  let total = 0;
  let slipping = 0;
  for (const vote of votes) {
    if (!(vote.weight > 0)) continue;
    total += vote.weight;
    if (vote.build.unit.verdict === "slipping") slipping += vote.weight;
    if (!main || vote.weight > main.weight + 1e-9) main = vote;
  }
  const lead = main?.build.unit.verdict ?? null;
  if (mean >= MUSCLE_DIRECTION_SHARE && lead === "climbing") return "progressing";
  if (
    mean <= -MUSCLE_DIRECTION_SHARE &&
    lead === "slipping" &&
    total > 0 &&
    slipping / total >= MUSCLE_SLIPPING_MIN_WORK_SHARE - 1e-9
  )
    return "slipping";
  return "holding";
}

type VolumeSource = { unitKey: string; hardSets: HardSet[] };
// Every set the muscle read counts is already a hard set: each counts in full.
const COUNT_IN_FULL = () => 1;

function muscleReads(builds: UnitBuild[], unlisted: Variant[], ctx: ReadContext): CapabilityMuscle[] {
  // Weekly hard sets per group over program state's band window. Every set here is
  // already a hard set, so each counts in full (no RIR discount) and no warm-up rule
  // applies (the weight is withheld: the hard-set test already judged the load). Counted
  // per unit, so a group the unit never credits (UNIT_NEVER_CREDITS) is left out; a lift
  // not listed as a unit (a lone catch-all lift) still counts here.
  const start = addDaysISO(ctx.date, -(MUSCLE_VOLUME_WEEKS * 7 - 1)) ?? ctx.date;
  const half = addDaysISO(ctx.date, -Math.floor((MUSCLE_VOLUME_WEEKS * 7) / 2)) ?? ctx.date;
  const sources: VolumeSource[] = [
    ...builds.map((b) => ({ unitKey: b.unit.key, hardSets: b.variants.flatMap((v) => v.hardSets) })),
    ...unlisted.map((v) => ({ unitKey: v.unit.key, hardSets: v.hardSets })),
  ];
  const full = new Map<string, number>();
  const recent = new Map<string, number>();
  for (const source of sources) {
    const excluded = UNIT_NEVER_CREDITS[source.unitKey] ?? [];
    const rows: VolumeSet[] = source.hardSets
      .filter((s) => s.date >= start && s.date <= ctx.date)
      .map((s) => ({
        date: s.date,
        exercise: s.exercise,
        muscle_group: s.muscle_group,
        weight: null,
        reps: null,
        rir: null,
      }));
    if (!rows.length) continue;
    const add = (into: Map<string, number>, volume: ReturnType<typeof effectiveVolumeByGroup>) => {
      for (const [group, v] of volume) if (!excluded.includes(group)) into.set(group, (into.get(group) ?? 0) + v.sets);
    };
    const recentRows = rows.filter((r) => r.date >= half);
    add(full, effectiveVolumeByGroup(rows, COUNT_IN_FULL));
    add(recent, effectiveVolumeByGroup(recentRows, COUNT_IN_FULL));
  }

  // Which units credit each group, and how heavily: share x the contributor's vote sets.
  // A touched (quarter) share never votes and never lists the unit.
  const byGroup = new Map<string, MuscleVote[]>();
  for (const build of builds) {
    const excluded = UNIT_NEVER_CREDITS[build.unit.key] ?? [];
    const weights = new Map<string, number>();
    for (const v of build.variants) {
      const read = build.reads.get(v.id) ?? NO_READ;
      for (const credit of muscleCreditsShared(v.name, v.group)) {
        const group = canonicalGroup(credit.group);
        if (!group || isMobility(group) || excluded.includes(group)) continue;
        if (credit.role !== "primary" && !isCountedShare(credit.share)) continue;
        weights.set(group, (weights.get(group) ?? 0) + credit.share * voteSets(v, read));
      }
    }
    for (const [group, weight] of weights) {
      const list = byGroup.get(group) ?? [];
      list.push({ build, weight });
      byGroup.set(group, list);
    }
  }

  const out: CapabilityMuscle[] = [];
  for (const group of MUSCLE_GROUPS) {
    if (group === "mobility") continue;
    const units = byGroup.get(group) ?? [];
    const total = full.get(group) ?? 0;
    if (!units.length && !(total > 0)) continue;
    const recentSets = recent.get(group) ?? 0;
    const firstHalf = total - recentSets;
    const weekly = Math.round((total / MUSCLE_VOLUME_WEEKS) * 10) / 10;
    const landmark = MUSCLE_LANDMARKS[group];
    const band = weekly < (landmark?.low ?? 6) ? "low" : weekly > (landmark?.high ?? 20) ? "high" : "productive";
    const volumeTrend: CapabilityMuscle["volume_trend"] =
      total <= 0 ? null : recentSets > firstHalf * 1.2 ? "rising" : recentSets < firstHalf * 0.8 ? "falling" : "stable";
    const verdict = muscleVerdict(units);
    const qualifiers: CapabilityQualifier[] = [];
    if (ctx.cut) qualifiers.push("cut");
    if (ctx.runBuild && bodyRegion(group as MuscleGroup) === "lower") qualifiers.push("run_build");
    if (ctx.recovery) qualifiers.push("recovery");
    out.push({
      group,
      verdict,
      weekly_hard_sets: weekly,
      band,
      volume_trend: volumeTrend,
      units: units.map((u) => u.build.unit.key),
      line: pickLine(MUSCLE_LINES, verdict, qualifiers, ctx.date, `capability-muscle:${group}`, (t) =>
        fillMuscle(t, group)
      ),
    });
  }
  return out;
}

function overallRead(builds: UnitBuild[], hasPlan: boolean, ctx: ReadContext): StrengthCapabilityRead["overall"] {
  // The compound units on the plan now; with no plan at all, every compound unit read.
  const compound = builds.filter((b) => b.unit.compound && (!hasPlan || b.unit.in_plan));
  const votes = compound.map((b) => ({
    verdict: b.unit.verdict,
    weight: b.variants.reduce(
      (sum, v) => sum + voteSets(v, b.reads.get(v.id) ?? NO_READ) * CAPABILITY_TIER_WEIGHT[v.tier],
      0
    ),
  }));
  const mean = scoreMean(votes);
  const verdict: CapabilityVerdict =
    mean == null
      ? "not_enough"
      : mean >= DIRECTION_SHARE
        ? "climbing"
        : mean <= -DIRECTION_SHARE
          ? "slipping"
          : "holding";
  const qualifiers: CapabilityQualifier[] = [];
  if (verdict === "holding" || verdict === "slipping") {
    if (ctx.cut) qualifiers.push("cut");
    if (compound.some((b) => b.unit.qualifiers.includes("run_build"))) qualifiers.push("run_build");
    if (ctx.recovery) qualifiers.push("recovery");
  }
  return { verdict, line: pickLine(OVERALL_LINES, verdict, qualifiers, ctx.date, "capability-overall", (t) => t) };
}

export interface CapabilityReadOpts {
  /** An already-built program state for this date (its endurance and hybrid reads), to avoid a recompute. */
  programState?: ProgramState;
}

function computeCapabilityRead(d: string, opts: CapabilityReadOpts): StrengthCapabilityRead {
  const then = addDaysISO(d, -CAPABILITY_WINDOW_DAYS) ?? d;
  const prevFrom = addDaysISO(d, -2 * CAPABILITY_WINDOW_DAYS) ?? d;
  const from = addDaysISO(d, -CAPABILITY_READ_DAYS) ?? d;
  const rows = readRows(from, d);
  // Each stored name resolved once per read, shared by the plan index and the log: the
  // resolver is request-memoized, but outside a request (the scheduler, a test) nothing is.
  const resolvedByName = new Map<string, ReturnType<typeof resolveExerciseName>>();
  const resolve = (name: string): ReturnType<typeof resolveExerciseName> => {
    let resolved = resolvedByName.get(name);
    if (!resolved) {
      resolved = resolveExerciseName(name);
      resolvedByName.set(name, resolved);
    }
    return resolved;
  };
  const plan = planIndex(resolve);

  const programState = opts.programState ?? safe<ProgramState | null>(() => getProgramState(d), null);
  const ctx: ReadContext = {
    date: d,
    earlier: then,
    prevFrom,
    cut: safe(() => cutReaffirmation(d).source !== "not_a_cut", false),
    recovery: safe(() => activeRecoveryWeek(d) != null, false),
    runBuild: safe(() => runBuildActive(d, programState), false),
    planUnits: plan.units,
  };

  // Lighter on purpose by the calendar: a recovery week running that day, a race and its
  // window. Asked once per read, never once per lift.
  const raceDays = postRaceDates(from, d);
  const inRecoveryWeek = recoveryWeekReader(from, d);
  const carded = cardedSessionIds(from, d);
  const aside: AsideReads = {
    onDate: (date: string): boolean => raceDays.has(date) || inRecoveryWeek(date),
    carded,
    // A failed carded read (null) leaves the reader empty: every session then falls back
    // to the single read, exactly as before.
    lighter: safe(
      () => lighterOnPurposeReader(carded ?? [], { recoveryChecked: true }),
      (sessionId: number, exercise: string) => exposureLighterOnPurpose(sessionId, exercise, { recoveryChecked: true })
    ),
  };

  // Variants, by the resolver's stored lift.
  const variants = new Map<number, Variant>();
  for (const row of rows) {
    if (!row.exercise || isPlaceholderExerciseName(row.exercise) || isMobility(row.muscle_group)) continue;
    const resolved = resolve(row.exercise);
    const id = Number(resolved.exercise_id ?? row.exercise_id);
    let variant = variants.get(id);
    if (!variant) {
      const name = resolved.canonical || row.exercise;
      const unit = capabilityUnitOf(name, row.muscle_group);
      if (!unit) continue;
      variant = {
        id,
        name,
        group: row.muscle_group,
        unit,
        tier: liftLeadTier(name, row.muscle_group),
        bodyweight: false,
        sets: [],
        lastTrained: row.date,
        exposures: [],
        hardSets: [],
        hardNow: 0,
        hardPrev: 0,
        inPlan: liftOnPlan(plan, row.exercise_id, resolved, name),
        pattern: classifyPattern(name, row.muscle_group ?? undefined, { profile: true }),
      };
      variants.set(id, variant);
    }
    variant.sets.push(row);
    if (row.date > variant.lastTrained) variant.lastTrained = row.date;
  }

  const bw = safe(() => athleteBodyweightLb(), null);
  const byUnit = new Map<string, { identity: UnitIdentity; variants: Variant[] }>();
  for (const variant of variants.values()) {
    variant.bodyweight = isBodyweightVariant(variant.name, variant.sets);
    buildVariant(variant, bw, ctx, aside);
    const entry = byUnit.get(variant.unit.key) ?? { identity: variant.unit, variants: [] };
    entry.variants.push(variant);
    byUnit.set(variant.unit.key, entry);
  }

  // A unit untrained for two windows is not part of the read: its lifts have gone quiet.
  const live = [...byUnit.values()].filter(({ variants: members }) => members.some((v) => v.lastTrained >= prevFrom));
  // The catch-alls (`<pattern>:accessory`): at most one per pattern by construction. One
  // beside a NAMED unit of its own pattern is "Other ... work", and is listed only when it
  // holds at least CATCH_ALL_MIN_LIFTS lifts: a lone leftover lift beside a named unit is
  // not a movement read, so it is not listed (its hard sets still reach the muscle read).
  const namedPatterns = new Set<string>();
  for (const { identity, variants: members } of live) {
    if (catchAllPattern(identity.key)) continue;
    for (const v of members) if (v.pattern) namedPatterns.add(v.pattern);
  }
  const builds: UnitBuild[] = [];
  const unlisted: Variant[] = [];
  for (const { identity, variants: members } of live) {
    const pattern = catchAllPattern(identity.key);
    const besideNamed = pattern != null && namedPatterns.has(pattern);
    if (besideNamed && members.length < CATCH_ALL_MIN_LIFTS) {
      unlisted.push(...members);
      continue;
    }
    builds.push(buildUnit(identity, members, ctx, besideNamed));
  }
  builds.sort((a, b) => unitOrder(a.unit, b.unit));

  return {
    available: true,
    date: d,
    overall: overallRead(builds, plan.ids.size > 0, ctx),
    units: builds.map((b) => b.unit),
    muscles: muscleReads(builds, unlisted, ctx),
  };
}

function unavailable(date: string): StrengthCapabilityRead {
  return { available: false, date, overall: null, units: [], muscles: [] };
}

function capabilityReadSafe(d: string, opts: CapabilityReadOpts): StrengthCapabilityRead {
  try {
    return computeCapabilityRead(d, opts);
  } catch {
    return unavailable(d);
  }
}

/** Progress per movement unit and per muscle group as of `date`, the single lift as evidence. */
export function capabilityRead(date: string = localDateISO(), opts: CapabilityReadOpts = {}): StrengthCapabilityRead {
  const d = typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : localDateISO();
  // Asked outside a request (the scheduler, a script, a test), the call opens its own
  // snapshot scope for its duration (`runWithBrainSnapshot` joins an existing one), so
  // the per-session reads every lift repeats (a session's recovery dose and stored card,
  // an exercise's identity) are read once per call instead of once per lift: a few
  // thousand queries down to the per-session floor. The read writes nothing, and every
  // memo still holds only while the write odometer has not moved (request-memo.ts).
  return runWithBrainSnapshot(() => {
    // Request-memoized for the bare form, keyed the way program state is; an injected
    // program state is an object the key cannot name, so it computes directly.
    if (opts.programState) return capabilityReadSafe(d, opts);
    try {
      // A failed read throws through the memo, so a failure is never remembered: the
      // next ask reads again. Program state is finished BY this read (its capability
      // pass), and computing the read asks program state first — so a bare read is served
      // the read the pass already computed (`finishedCapabilityRead`), never a second
      // computation of the same read. Only inside a pass, or when the pass's read was
      // unavailable, is it computed here.
      return requestMemo(
        `strength_capability:${d}:${localDateISO()}:${currentTrainingDataVersion()}`,
        () => finishedCapabilityRead(d) ?? computeCapabilityRead(d, opts),
        copyDeep
      );
    } catch {
      return unavailable(d);
    }
  });
}
