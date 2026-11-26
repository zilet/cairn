// Strength by MOVEMENT, not by exact lift: where each of the big patterns stands and which
// way it has moved, read from its main compound lifts so a rotation inside a pattern
// (a Pendlay row to a bent-over row) never reads as a reset.
//
// Facts only, never sentences: the Horizon standing row (standing-read.ts) words them.
//
//   - Members: the lifts logged in the last two windows whose swap family
//     (classifyPattern) is the movement. A regional isolation lift is never a member,
//     whatever that table files it under: a leg curl is knee flexion, not a hinge, and a
//     leg extension is not a squat (movement-region.ts).
//   - Lead: the best-ranked member trained inside the current window (a benchmark-standard
//     free-weight compound, then any free-weight compound, then a machine), the one with
//     the most working sets there.
//   - Capacity: a lift's "now" is THE capacity envelope (capacityEnvelopeAsOf over
//     strengthObjectiveHistory: the best Epley of its latest three exposures inside 28
//     days), read today and as it stood one window earlier. Never re-derived here.
//   - Direction is the PATTERN's, not one lift's: each member comparable in both windows
//     contributes its relative change, weighted by its working sets now and by its rank
//     (compounds above machines). A lift with no reading in the earlier window is new and
//     contributes nothing; a lift no longer trained has no "now" and contributes nothing.
//   - An exposure lighter ON PURPOSE (a recovery-dose session, a card that asked for less
//     and was met) is set aside for direction, the same law the whole-person strength read
//     holds (exposureLighterOnPurpose), so a deload never reads as a slide.
//   - A bodyweight lead (pull-ups, dips, push-ups, assisted work) carries no est-1RM: its
//     "now" is the best unassisted reps, and its direction reads off effective load
//     (bodyweight plus added load, minus assist) times reps, so more reps or less assist
//     is harder (CLAUDE.md "Assist is a sign").
import { db } from "../db.js";
import { finite } from "../lib/numbers.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { isKnownBodyweightMovement, isMobility, isPlaceholderExerciseName } from "./exercise-canon.js";
import { classifyPattern, inferEquipment, type MovementPattern } from "./exercise-variations.js";
import { isAccessoryRegion, movementRegionKey } from "./movement-region.js";
import { athleteBodyweightLb, isBenchmarkLiftForPattern } from "./performance.js";
import {
  capacityEnvelopeAsOf,
  listStrengthObjectives,
  type StrengthExposure,
  strengthObjectiveHistory,
} from "./strength-objectives.js";
import { strengthObjectiveTrackedExercise } from "./strength-objective-carry.js";
import { normalizedExerciseKey } from "./exercise-canon.js";
import { exposureLighterOnPurpose } from "./whole-person-trajectory.js";
// Read at call time only (program state -> strength-capability -> this module is a cycle).
import { getProgramState } from "./program-state.js";
import { unitOfLift } from "./capability-consumers.js";
import { PLAN_ITEM_EFFECT_TIER, planItemEffectTier } from "../domain/training/plan-item-order.js";

export type MovementKey = "squat" | "hinge" | "push" | "press" | "row" | "pull";

export interface MovementStandingLine {
  key: MovementKey;
  /** "Squat", "Hinge", "Push", "Overhead press", "Row", "Pull". */
  label: string;
  /** The compound lift leading the read today (its stored name); null when the pattern is not trained. */
  lead_lift: string | null;
  /** The lead lift's capacity today in lb (est-1RM envelope), or null (bodyweight lead, or none). */
  now_lb: number | null;
  /** For a bodyweight lead (pull-ups): the best recent reps at bodyweight. */
  now_reps: number | null;
  /**
   * For a bodyweight lead whose best recent set (by effective load) carried added load or
   * assist: that load in lb, positive added (a weighted pull-up), negative assist. Null when
   * the best set was at bodyweight, or for a loaded lead. Never an est-1RM.
   */
  now_added_lb: number | null;
  /** The reps of that set; null with no `now_added_lb`. */
  now_added_reps: number | null;
  direction: "better" | "holding" | "worse" | null;
  /** The pattern's relative change over the window, as a fraction (0.03 = 3% up). Internal to wording; null when not comparable. */
  change: number | null;
  /** The day the window is read from (about four weeks back), or null. */
  since: string | null;
  /** How many lifts of the pattern were comparable across the window. */
  lifts_compared: number;
}

export interface MovementStanding {
  available: boolean;
  lines: MovementStandingLine[];
}

// ---------- the knobs ----------

/** One window: the capacity envelope's own freshness span, and the lift row's "four weeks ago". */
export const MOVEMENT_WINDOW_DAYS = 28;

// Direction thresholds, relative to the earlier envelope. The strength journey calls a
// lift rising at +0.5 lb/week and falling at -0.75 lb/week, which the week page's lift row
// reads over its four-week window as +2 lb toward and -3 lb back. On the est-1RMs these
// patterns carry (roughly 150-300 lb) that is about +1% and -1.5%, so the pattern uses
// the same size and the same asymmetry: it takes a little more to call a slide than a
// climb, because one light day moves an Epley estimate down more easily than up.
export const MOVEMENT_BETTER_CHANGE = 0.01;
export const MOVEMENT_WORSE_CHANGE = -0.015;

// How much a member's change counts, by rank. A benchmark-standard free-weight compound
// is the movement's truest read; another free-weight compound nearly so; a machine or
// cable version loads the pattern with less of the body and moves on a coarser stack, so
// it counts half. Multiplied by the member's working sets in the current window.
export const MOVEMENT_TIER_WEIGHT: Readonly<Record<LiftLeadTier, number>> = { 0: 1, 1: 0.75, 2: 0.5, 3: 0.25 };

const MOVEMENTS: ReadonlyArray<{ key: MovementKey; label: string; pattern: MovementPattern }> = [
  { key: "squat", label: "Squat", pattern: "squat" },
  { key: "hinge", label: "Hinge", pattern: "hinge" },
  { key: "push", label: "Push", pattern: "horizontal-push" },
  { key: "press", label: "Overhead press", pattern: "vertical-push" },
  { key: "row", label: "Row", pattern: "horizontal-pull" },
  { key: "pull", label: "Pull", pattern: "vertical-pull" },
];

// ---------- lift rank (shared with the muscle-group read) ----------

/** 0 benchmark-standard free-weight compound, 1 other free-weight compound, 2 machine/cable compound, 3 accessory. */
export type LiftLeadTier = 0 | 1 | 2 | 3;

// A fly or a pullover rides a compound swap family by name but is isolation work.
const FLY_LIKE = /\bfly\b|\bflye|\bflyes\b|\bflies\b|pec deck|\bpullover\b|crossover/i;

/** Is this lift compound work (the plan's primary effect tier, never a fly or a regional isolation lift)? */
export function isCompoundLift(exercise: string, group?: string | null): boolean {
  const name = String(exercise ?? "");
  if (!name || FLY_LIKE.test(name)) return false;
  return planItemEffectTier({ exercise: name, muscle_group: group ?? null }) === PLAN_ITEM_EFFECT_TIER.primary;
}

/** Which lift should lead a read: lower leads. */
export function liftLeadTier(exercise: string, group?: string | null): LiftLeadTier {
  if (!isCompoundLift(exercise, group)) return 3;
  const equipment = inferEquipment(exercise);
  const machine = equipment === "machine" || equipment === "cable";
  if (machine) return 2;
  const pattern = classifyPattern(exercise, group ?? undefined);
  return pattern && isBenchmarkLiftForPattern(pattern, exercise) ? 0 : 1;
}

// ---------- the read ----------

type SetRow = {
  session_id: number;
  date: string;
  exercise_id: number;
  exercise: string;
  muscle_group: string | null;
  equipment: string | null;
  input_profile: string | null;
  weight: number | null;
  reps: number;
};

type Member = {
  name: string;
  group: string | null;
  tier: LiftLeadTier;
  bodyweight: boolean;
  sets: SetRow[];
  setsNow: number;
  lastDate: string;
};

type MemberRead = {
  now: number | null; // envelope today (lb for loaded; effective-load units for bodyweight)
  change: number | null; // relative change, set-asides honoured; null when not comparable
  nowReps: number | null;
  /** Bodyweight work: the best recent set when it carried added load (+) or assist (-). */
  nowAdded: { lb: number; reps: number } | null;
};

function windowSets(from: string, to: string): SetRow[] {
  try {
    return (
      db
        .prepare(
          `SELECT s.id AS session_id, s.date AS date, e.id AS exercise_id, e.name AS exercise,
                  e.muscle_group AS muscle_group, e.equipment AS equipment, e.input_profile AS input_profile,
                  ls.weight AS weight, ls.reps AS reps
             FROM logged_sets ls
             JOIN sessions s ON s.id = ls.session_id
             JOIN exercises e ON e.id = ls.exercise_id
            WHERE s.date BETWEEN ? AND ? AND ls.reps > 0 AND COALESCE(e.mode, 'reps') <> 'timed'
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
    }));
  } catch {
    return [];
  }
}

// The dates of this lift whose exposure was lighter on purpose (asked once per session).
function setAsideDates(member: Member): Set<string> {
  const out = new Set<string>();
  const seen = new Set<number>();
  for (const row of member.sets) {
    if (seen.has(row.session_id)) continue;
    seen.add(row.session_id);
    let aside = false;
    try {
      aside = exposureLighterOnPurpose(row.session_id, member.name);
    } catch {
      aside = false;
    }
    if (aside) out.add(row.date);
  }
  return out;
}

// One member's change across the window. A lift with no earlier reading is NEW (null),
// a lift with no current reading is no longer trained (null). When setting aside the
// lighter-on-purpose exposures leaves too little to compare, a dip still never reads as
// a slide: the raw change counts only upward (the whole-person read's "held").
function compareEnvelopes(
  history: StrengthExposure[],
  aside: Set<string>,
  today: string,
  then: string
): { now: number | null; change: number | null } {
  const rawNow = capacityEnvelopeAsOf(history, today);
  const rawThen = capacityEnvelopeAsOf(history, then);
  if (!rawNow || !rawThen || !(rawThen.est_1rm > 0)) return { now: rawNow?.est_1rm ?? null, change: null };
  const honest = aside.size ? history.filter((point) => !aside.has(point.date)) : history;
  const honestNow = capacityEnvelopeAsOf(honest, today);
  const honestThen = capacityEnvelopeAsOf(honest, then);
  if (honestNow && honestThen && honestThen.est_1rm > 0)
    return { now: rawNow.est_1rm, change: honestNow.est_1rm / honestThen.est_1rm - 1 };
  return { now: rawNow.est_1rm, change: Math.max(0, rawNow.est_1rm / rawThen.est_1rm - 1) };
}

function readLoaded(member: Member, today: string, then: string): MemberRead {
  let history: StrengthExposure[] = [];
  try {
    history = strengthObjectiveHistory(member.name);
  } catch {
    history = [];
  }
  const { now, change } = compareEnvelopes(history, setAsideDates(member), today, then);
  return { now, change, nowReps: null, nowAdded: null };
}

// Bodyweight work as an exposure series: effective load = bodyweight + added load (assist
// is negative, so more assist is less load), Epley on that. Bodyweight is held at TODAY's
// value for both windows, so a cut never reads as a weaker pull-up. Without a known
// bodyweight only plain bodyweight sets compare (the bodyweight cancels out of the ratio).
function bodyweightHistory(member: Member, bodyweight: number | null): StrengthExposure[] {
  const byDate = new Map<string, StrengthExposure>();
  for (const row of member.sets) {
    const added = row.weight ?? 0;
    if (bodyweight == null && added !== 0) continue;
    const load = (bodyweight ?? 1) + added;
    if (!(load > 0)) continue;
    const point: StrengthExposure = {
      date: row.date,
      top_weight: load,
      top_reps: row.reps,
      est_1rm: load * (1 + row.reps / 30),
    };
    const current = byDate.get(point.date);
    if (!current || point.est_1rm > current.est_1rm) byDate.set(point.date, point);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Only orders a bodyweight lift's recent sets against each other when no bodyweight is on
// record (is +25 lb for 6 a better set than 12 at bodyweight?). Never shown, never compared.
const RANKING_BODYWEIGHT_LB = 170;

function readBodyweight(member: Member, today: string, then: string, bodyweight: number | null, nowFrom: string): MemberRead {
  const { change } = compareEnvelopes(bodyweightHistory(member, bodyweight), setAsideDates(member), today, then);
  let nowReps: number | null = null;
  // The best recent set by effective load (bodyweight plus added, minus assist), so the
  // "now" quotes the hardest thing done, whatever the set mix.
  let best: { lb: number; reps: number; effective: number } | null = null;
  const rankBodyweight = bodyweight ?? RANKING_BODYWEIGHT_LB;
  for (const row of member.sets) {
    if (row.date < nowFrom) continue;
    const added = row.weight ?? 0;
    if (added === 0 && (nowReps == null || row.reps > nowReps)) nowReps = row.reps;
    const load = rankBodyweight + added;
    if (!(load > 0)) continue;
    const effective = load * (1 + row.reps / 30);
    if (!best || effective > best.effective + 1e-9) best = { lb: added, reps: row.reps, effective };
  }
  const nowAdded = best && best.lb !== 0 ? { lb: best.lb, reps: best.reps } : null;
  return { now: null, change, nowReps, nowAdded };
}

const WEIGHTED_OR_ASSISTED_WORD = /\b(?:weighted|assisted)\b/gi;

// Bodyweight work whatever the day's set mix: the athlete said so (input profile), the
// movement is one (a weighted or assisted pull-up is still a pull-up), a set carried assist
// (assist is a sign only bodyweight work carries), or most of its sets carried no load. An
// added-load est-1RM is never this lift's capacity: Epley on the plates alone reads +10 lb
// to +25 lb as a 70 percent climb.
function isBodyweightMember(member: Member): boolean {
  const stated = member.sets.find((row) => row.input_profile)?.input_profile ?? null;
  if (stated === "bodyweight") return true;
  if (stated === "loaded") return false;
  const equipment = member.sets.find((row) => row.equipment)?.equipment ?? null;
  const bare = member.name.replace(WEIGHTED_OR_ASSISTED_WORD, " ").replace(/\s+/g, " ").trim();
  if (bare && isKnownBodyweightMovement(bare, equipment)) return true;
  if (member.sets.some((row) => row.weight != null && row.weight < 0)) return true;
  const unloaded = member.sets.filter((row) => row.weight == null || row.weight <= 0).length;
  return unloaded * 2 >= member.sets.length;
}

function directionOf(change: number | null): MovementStandingLine["direction"] {
  if (change == null) return null;
  if (change >= MOVEMENT_BETTER_CHANGE) return "better";
  if (change <= MOVEMENT_WORSE_CHANGE) return "worse";
  return "holding";
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

const DIRECTION_OF_VERDICT: Readonly<Record<string, MovementStandingLine["direction"]>> = {
  climbing: "better",
  holding: "holding",
  slipping: "worse",
  not_enough: null,
};

/** Where each movement stands as of `today`. */
export function movementStanding(today?: string): MovementStanding {
  const d = today && /^\d{4}-\d{2}-\d{2}/.test(today) ? today.slice(0, 10) : localDateISO();
  const then = addDaysISO(d, -MOVEMENT_WINDOW_DAYS) ?? d;
  const from = addDaysISO(d, -2 * MOVEMENT_WINDOW_DAYS) ?? d;
  // The current window, as the envelope counts it (exposures at most 28 days old).
  const nowFrom = then;

  const byMovement = new Map<MovementKey, Map<number, Member>>();
  for (const row of windowSets(from, d)) {
    if (!row.exercise || isPlaceholderExerciseName(row.exercise) || isMobility(row.muscle_group)) continue;
    const pattern = classifyPattern(row.exercise, row.muscle_group ?? undefined);
    const movement = MOVEMENTS.find((m) => m.pattern === pattern);
    if (!movement) continue;
    if (isAccessoryRegion(movementRegionKey(row.exercise, row.muscle_group))) continue;
    const members = byMovement.get(movement.key) ?? new Map<number, Member>();
    byMovement.set(movement.key, members);
    let member = members.get(row.exercise_id);
    if (!member) {
      member = {
        name: row.exercise,
        group: row.muscle_group,
        tier: liftLeadTier(row.exercise, row.muscle_group),
        bodyweight: false,
        sets: [],
        setsNow: 0,
        lastDate: row.date,
      };
      members.set(row.exercise_id, member);
    }
    member.sets.push(row);
    if (row.date >= nowFrom) member.setsNow++;
    if (row.date > member.lastDate) member.lastDate = row.date;
  }

  const bodyweight = athleteBodyweightLb();
  const goalKeys = new Set<string>();
  try {
    for (const objective of listStrengthObjectives()) {
      if (objective.status !== "active") continue;
      goalKeys.add(normalizedExerciseKey(strengthObjectiveTrackedExercise(objective)));
    }
  } catch {
    // no goals read: the tier and the sets decide
  }
  // The capability summary program state carries for this date (null when unavailable).
  const capability = (() => {
    try {
      const cap = getProgramState(d).capability ?? null;
      return cap?.available === true ? cap : null;
    } catch {
      return null;
    }
  })();
  const lines: MovementStandingLine[] = [];
  for (const movement of MOVEMENTS) {
    const members = [...(byMovement.get(movement.key)?.values() ?? [])];
    if (!members.length) continue;
    for (const member of members) member.bodyweight = isBodyweightMember(member);
    const trained = members.filter((member) => member.setsNow > 0);
    // Between lifts of one tier, the one the athlete holds a goal on leads: the bench they
    // named speaks for Push ahead of a dumbbell bench that happened to collect more sets.
    const goal = (member: Member) => (goalKeys.has(normalizedExerciseKey(member.name)) ? 0 : 1);
    const lead =
      [...trained].sort(
        (a, b) =>
          a.tier - b.tier ||
          goal(a) - goal(b) ||
          b.setsNow - a.setsNow ||
          b.lastDate.localeCompare(a.lastDate) ||
          a.name.localeCompare(b.name)
      )[0] ?? null;

    let weighted = 0;
    let weights = 0;
    let compared = 0;
    let leadRead: MemberRead | null = null;
    for (const member of trained) {
      const read = member.bodyweight
        ? readBodyweight(member, d, then, bodyweight, nowFrom)
        : readLoaded(member, d, then);
      if (member === lead) leadRead = read;
      if (read.change == null || !Number.isFinite(read.change)) continue;
      const weight = member.setsNow * MOVEMENT_TIER_WEIGHT[member.tier];
      if (!(weight > 0)) continue;
      weighted += read.change * weight;
      weights += weight;
      compared++;
    }
    let change = weights > 0 ? round3(weighted / weights) : null;
    const read = leadRead as MemberRead | null;
    // The DIRECTION is the capability read's (strength-capability.ts): the verdict of the
    // movement unit the lead lift belongs to, so the Horizon row and the capability read
    // can never disagree about one movement. The blended change stays as wording only, and
    // only while it points the same way; otherwise no "up"/"down" is said. A unit the read
    // could not place leaves this read's own direction standing.
    let direction = directionOf(change);
    const unit = lead ? unitOfLift(capability, lead.name) : null;
    if (unit) {
      const said = DIRECTION_OF_VERDICT[unit.verdict] ?? null;
      if (said !== direction) change = null;
      direction = said;
    }
    lines.push({
      key: movement.key,
      label: movement.label,
      lead_lift: lead?.name ?? null,
      now_lb: lead && !lead.bodyweight && read?.now != null ? Math.round(read.now) : null,
      now_reps: lead?.bodyweight ? (read?.nowReps ?? null) : null,
      now_added_lb: lead?.bodyweight && read?.nowAdded ? read.nowAdded.lb : null,
      now_added_reps: lead?.bodyweight && read?.nowAdded ? read.nowAdded.reps : null,
      direction,
      change,
      since: compared > 0 ? then : null,
      lifts_compared: compared,
    });
  }
  return { available: lines.some((line) => line.lead_lift != null), lines };
}
