// How a lift RESPONDS to the loading it is given — the read that lets progression pick
// the right next move for a stalled lift instead of one default. The first question it
// answers: is this lift's next load step too coarse for it (an isolation stack whose
// smallest jump is a large fraction of the working weight), so that a stall calls for a
// higher rep range at the same weight rather than a deload.
//
// Consumed by progression.ts. Must never: write to the plan itself, change what counts
// as a stall, or move a barbell compound off its deload ladder.
import { db } from "../db.js";
import { canonicalGroup, classifyMuscleGroup, ISOLATION_GROUPS, normalizedExerciseKey } from "./exercise-canon.js";
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

/** An isolation lift: its group is an isolation group, or its pattern is single-joint. */
export function isIsolationLift(name: string, group: string | null | undefined): boolean {
  const g = canonicalGroup(group ?? null) ?? classifyMuscleGroup(String(name ?? ""));
  if (g && ISOLATION_GROUPS.has(g)) return true;
  const pattern = classifyPattern(String(name ?? ""), group ?? undefined);
  return pattern != null && SINGLE_JOINT_PATTERNS.has(pattern);
}

/**
 * Pure. True when this is an isolation lift whose next ordinary load step (the engine's
 * own `nextLoadStep`, the plate grid and per-session cap) is at least
 * COARSE_STEP_FRACTION of the working weight — a 15 lb lateral raise whose next step is
 * 20. Bodyweight (null), assisted (negative) and zero loads are never coarse: there is
 * no stack to jump.
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
  const step = nextLoadStep(w, group ?? null) - w;
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
 */
export function lastAppliedRepRangeMove(
  exerciseName: string,
  asOf: string = localDateISO()
): { day: string; rep_low: number | null; rep_high: number | null } | null {
  const key = normalizedExerciseKey(String(exerciseName ?? ""));
  if (!key) return null;
  const until = String(asOf ?? "").slice(0, 10);
  let rows: Array<{ parsed_json: string | null; created_at: string }> = [];
  try {
    rows = db
      .prepare(
        `SELECT parsed_json, created_at FROM plan_proposals
          WHERE status = 'applied' AND parsed_json LIKE '%rep_range%'
          ORDER BY created_at DESC, id DESC`
      )
      .all() as Array<{ parsed_json: string | null; created_at: string }>;
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
    return { day, rep_low: num(hit.rep_low), rep_high: num(hit.rep_high) };
  }
  return null;
}
