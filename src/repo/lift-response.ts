// How a lift RESPONDS to the loading it is given — the read that lets progression pick
// the right next move for a stalled lift instead of one default. The first question it
// answers: is this lift's next load step too coarse for it (an isolation stack whose
// smallest jump is a large fraction of the working weight), so that a stall calls for a
// higher rep range at the same weight rather than a deload.
//
// Consumed by progression.ts. Must never: write to the plan itself, change what counts
// as a stall, or move a barbell compound off its deload ladder.
import { db } from "../db.js";
import { USER_VETO_SQL } from "./brain-decisions.js";
import {
  canonicalGroup,
  classifyMuscleGroup,
  detectImplement,
  expandExerciseAbbreviations,
  ISOLATION_GROUPS,
  normalizedExerciseKey,
  progressionLineageIds,
} from "./exercise-canon.js";
import { classifyPattern, type MovementPattern } from "./exercise-variations.js";
// A cycle (progression imports this module), resolved at call time: nothing here runs
// at module init, and nextLoadStep is a hoisted function declaration.
import { nextLoadStep } from "./progression.js";
import { localDateISO } from "./shared.js";

/** The next load step, as a fraction of the working weight, at which it reads coarse. */
export const COARSE_STEP_FRACTION = 0.08;
/** How far a rep-range move lifts both ends of the range. */
export const REP_RANGE_MOVE = 3;
/** The highest rep_high a rep-range move may write; past it the ordinary ladder answers. */
export const REP_RANGE_CEILING = 25;
/** The smallest real jump on a pinned weight stack (cable or selectorized machine). */
export const STACK_MIN_STEP = 5;

// Single-joint patterns whose muscle group is not itself an isolation group — a lateral
// raise files under "shoulders", which also holds the overhead press. ISOLATION_GROUPS
// stays the first answer; the pattern only covers the groups it cannot tell apart.
const SINGLE_JOINT_PATTERNS: ReadonlySet<MovementPattern> = new Set<MovementPattern>([
  "lateral-raise",
  "rear-delt",
  "curl",
  "triceps",
  "calf",
]);

// Single-joint work the pattern table files elsewhere or not at all: a fly or pec deck
// (chest), a leg extension or leg curl (the curl reads as a hinge), a triceps extension
// with no group word, the hip abductor/adductor. Back and hip extensions are excluded —
// those are hinges.
const SINGLE_JOINT_NAME_RE =
  /\b(pec decks?|flyes?|flys?|leg extensions?|leg curls?|hamstring curls?|(?:triceps?|overhead|cable|rope) extensions?|abduct\w*|adduct\w*)\b/;
// A name that says the load is a pinned stack even when no implement word is in it.
const STACK_NAME_RE =
  /\b(pushdowns?|push downs?|pec decks?|ropes?|stack|selectori[sz]ed|leg extensions?|leg curls?|hamstring curls?|face pulls?|abduct\w*|adduct\w*)\b/;
// Implements with their own (finer) loading grid: never a stack, whatever else the name says.
const FREE_OR_PLATE_IMPLEMENTS = new Set([
  "a barbell",
  "dumbbells",
  "a kettlebell",
  "an EZ bar",
  "a smith machine",
  "a trap bar",
  "a hex bar",
  "a landmine",
  "a band",
]);

function nameKey(name: string): string {
  return expandExerciseAbbreviations(String(name ?? "")).toLowerCase();
}

/** An isolation lift: its group is an isolation group, or its pattern or name is single-joint. */
export function isIsolationLift(name: string, group: string | null | undefined): boolean {
  const g = canonicalGroup(group ?? null) ?? classifyMuscleGroup(String(name ?? ""));
  if (g && ISOLATION_GROUPS.has(g)) return true;
  const pattern = classifyPattern(String(name ?? ""), group ?? undefined);
  if (pattern != null && SINGLE_JOINT_PATTERNS.has(pattern)) return true;
  return SINGLE_JOINT_NAME_RE.test(nameKey(name));
}

/**
 * A pinned weight stack: the name carries a cable or machine implement, or a stack
 * movement word (pushdown, pec deck, leg extension…), and no free-weight or plate
 * implement. Its real jump is at least STACK_MIN_STEP whatever the plate grid says.
 */
export function isStackLoaded(name: string): boolean {
  const implement = detectImplement(String(name ?? ""));
  if (implement && FREE_OR_PLATE_IMPLEMENTS.has(implement)) return false;
  if (implement === "a cable machine" || implement === "a machine") return true;
  return STACK_NAME_RE.test(nameKey(name));
}

/**
 * Pure. True when this is an isolation lift whose next real load step is at least
 * COARSE_STEP_FRACTION of the working weight. The step is the engine's own
 * `nextLoadStep` (plate grid and per-session cap); on a pinned stack it is never less
 * than STACK_MIN_STEP (a 57.5 lb rope pushdown's next pin is 62.5, not 60). Dumbbell and
 * barbell isolation keep the engine step. Bodyweight (null), assisted (negative) and zero
 * loads are never coarse: there is no stack to jump.
 */
export function coarseLoadStep(
  name: string,
  weight: number | null | undefined,
  group: string | null | undefined
): boolean {
  if (weight == null) return false;
  const w = Number(weight);
  if (!Number.isFinite(w) || w <= 0) return false;
  if (!isIsolationLift(name, group)) return false;
  const engineStep = nextLoadStep(w, group ?? null) - w;
  const step = isStackLoaded(name) ? Math.max(engineStep, STACK_MIN_STEP) : engineStep;
  return step > 0 && step / w >= COARSE_STEP_FRACTION;
}

/** The range one rep-range move writes, or null when it would pass REP_RANGE_CEILING. */
export function movedRepRange(repLow: number, repHigh: number): { rep_low: number; rep_high: number } | null {
  const low = Math.trunc(Number(repLow));
  const high = Math.trunc(Number(repHigh));
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 1 || high < low) return null;
  const next = { rep_low: low + REP_RANGE_MOVE, rep_high: high + REP_RANGE_MOVE };
  return next.rep_high <= REP_RANGE_CEILING ? next : null;
}

// A UTC `created_at` stamp → its local day (fail-soft).
function localDayOf(stamp: unknown): string | null {
  const text = String(stamp ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const iso = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? localDateISO(new Date(ms)) : text.slice(0, 10);
}

/**
 * The latest APPLIED rep-range move on this lift, on or before `asOf`: the range it
 * wrote. Read from the proposal ledger's `progression_escalation: "rep_range"` marker
 * (buildProgressionProposal writes it). No window: a lift that has already been moved
 * up a range is answered by the ordinary ladder from then on, whenever it next stalls,
 * so the move can never loop. Fail-soft — an unreadable row counts as nothing.
 *
 * `vetoed` is the athlete's answer to it: the brain decision that landed the proposal
 * was undone or refused (brain-decisions.ts `USER_VETO_SQL`, the same "no" the
 * re-propose etiquette reads). Undo walks the plan back but leaves the proposal
 * `applied`, so without this the restored range reads as a move never taken and the
 * same move re-proposes and quiet-applies again at the next boundary. A vetoed move is
 * spent: the ordinary ladder answers the lift from then on.
 */
export function lastAppliedRepRangeMove(
  exerciseName: string,
  asOf: string = localDateISO()
): { day: string; rep_low: number | null; rep_high: number | null; vetoed: boolean } | null {
  const key = normalizedExerciseKey(String(exerciseName ?? ""));
  if (!key) return null;
  const until = String(asOf ?? "").slice(0, 10);
  let rows: Array<{ parsed_json: string | null; created_at: string; vetoed: number | null }> = [];
  try {
    rows = db
      .prepare(
        `SELECT p.parsed_json, p.created_at,
                EXISTS (SELECT 1 FROM brain_decisions
                         WHERE source_ref_type = 'plan_proposal'
                           AND source_ref_key = CAST(p.id AS TEXT)
                           AND ${USER_VETO_SQL}) AS vetoed
           FROM plan_proposals p
          WHERE p.status = 'applied' AND p.parsed_json LIKE '%rep_range%'
          ORDER BY p.created_at DESC, p.id DESC`
      )
      .all() as Array<{ parsed_json: string | null; created_at: string; vetoed: number | null }>;
  } catch {
    return null;
  }
  for (const row of rows) {
    const day = localDayOf(row?.created_at);
    if (!day || day > until) continue;
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(row?.parsed_json ?? ""));
    } catch {
      continue;
    }
    const changes = Array.isArray(parsed?.changes) ? parsed.changes : [];
    const hit = changes.find(
      (change: any) =>
        change?.progression_escalation === "rep_range" && normalizedExerciseKey(String(change?.exercise ?? "")) === key
    );
    if (!hit) continue;
    const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    return { day, rep_low: num(hit.rep_low), rep_high: num(hit.rep_high), vetoed: Number(row?.vetoed) === 1 };
  }
  return null;
}

/**
 * Did this lift BOUNCE off its last load step? In the log's session tops (newest last):
 * a session at `load`, then a heavier one whose top set fell below `repLow`, then a
 * return to `load` or lighter — the step was taken and did not hold. Looks back
 * `lookbackSessions` sessions. Fail-soft: no history reads as no bounce.
 */
export function bouncedOffLoadStep(name: string, load: number, repLow: number, lookbackSessions = 8): boolean {
  const w = Number(load);
  const floor = Number(repLow);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(floor)) return false;
  const ids = progressionLineageIds(name);
  if (!ids.length) return false;
  let rows: Array<{ date: string; top: number | null; reps: number | null }> = [];
  try {
    const inIds = ids.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT s.date AS date, MAX(ls.weight) AS top,
                (SELECT MAX(l2.reps) FROM logged_sets l2
                  WHERE l2.session_id = s.id AND l2.exercise_id IN (${inIds})
                    AND l2.weight = (SELECT MAX(l3.weight) FROM logged_sets l3
                                      WHERE l3.session_id = s.id AND l3.exercise_id IN (${inIds}))) AS reps
           FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
          WHERE ls.exercise_id IN (${inIds}) AND ls.reps IS NOT NULL AND ls.weight IS NOT NULL
          GROUP BY s.id ORDER BY s.date DESC, s.id DESC LIMIT ?`
      )
      .all(...ids, ...ids, ...ids, Math.max(3, Math.trunc(lookbackSessions))) as typeof rows;
  } catch {
    return false;
  }
  const tops = rows.reverse().map((r) => ({ top: Number(r.top), reps: r.reps == null ? null : Number(r.reps) }));
  for (let i = 0; i + 2 < tops.length; i++) {
    if (Math.abs(tops[i].top - w) > 0.1) continue;
    const next = tops[i + 1];
    if (!(next.top > w + 0.1) || next.reps == null || next.reps >= floor) continue;
    if (tops.slice(i + 2).some((t) => t.top <= w + 0.1)) return true;
  }
  return false;
}
