// A lift goal follows its movement through a swap.
//
// An objective is set on one exact exercise. When the plan later swaps that exercise for a
// variant of the same movement pattern (a Pendlay row rotated to a bent-over row after a
// stall), the goal would otherwise sit on a lift nobody trains: its "now" ages out and the
// sets on the replacement count for nothing. The carry is the read that prevents that:
//
//   - it exists ONLY while the objective's own exercise is out of the plan,
//   - it follows RECORDED swaps only (applied proposals carrying `swap {from,to}`), never a
//     guess from what else happens to be in the plan,
//   - the replacement must be in the plan now and train the same movement pattern.
//
// Nothing is written: bring the original lift back and the carry is gone, the goal reading
// its own exercise again. Histories are still never merged by implement or name — only the
// replacement's sets from the swap day onward join the objective's own (see
// `strengthObjectiveTrackedHistory`, strength-objectives.ts).
//
// A REPS goal (`bodyweight_reps`, strength-reps.ts) never carries. Two bodyweight lifts of
// one pattern are still not one rep scale (ten chin-ups are not ten pull-ups), and
// deciding which pairs are would be a guess, so a swap simply leaves a reps goal on its
// own lift.
//
// Depends only on the DB, the name resolver and the pattern classifier, so the set-logging
// ledger can read it without importing the coaching graph.
import { db } from "../db.js";
import { normalizedExerciseKey, resolveExerciseName } from "./exercise-canon.js";
import { classifyPattern } from "./exercise-variations.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import { localDayOfStamp } from "./shared.js";

export interface StrengthObjectiveCarry {
  /** The lift that now carries the goal: the stored name of the swap's replacement. */
  exercise: string;
  exercise_key: string;
  /** The objective's own exercise, the one swapped out. */
  from: string;
  /** The local day the swap that started the carry was applied. */
  since: string;
}

const BODYWEIGHT_LIFT = /\b(?:pull|chin|push)[\s-]?ups?\b|\bdips?\b/i;

type RecordedSwap = { from_key: string; to: string; to_key: string; day: string };

function storedName(raw: string): string {
  const supplied = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const id = resolveExerciseName(supplied).exercise_id;
  const row = id == null ? null : (db.prepare(`SELECT name FROM exercises WHERE id = ?`).get(id) as { name: string });
  return row?.name ?? supplied;
}

function recordedSwaps(): RecordedSwap[] {
  const rows = db
    .prepare(
      `SELECT created_at, parsed_json FROM plan_proposals
        WHERE status = 'applied' AND parsed_json LIKE '%"swap"%' ORDER BY id`
    )
    .all() as Array<{ created_at: string; parsed_json: string | null }>;
  const out: RecordedSwap[] = [];
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(row.parsed_json ?? ""));
    } catch {
      continue;
    }
    const day = localDayOfStamp(row.created_at);
    if (!day || !Array.isArray(parsed?.changes)) continue;
    for (const change of parsed.changes) {
      const from = typeof change?.swap?.from === "string" ? change.swap.from : "";
      const to = typeof change?.swap?.to === "string" ? change.swap.to : "";
      if (!from || !to) continue;
      const toName = storedName(to);
      const fromKey = normalizedExerciseKey(storedName(from));
      const toKey = normalizedExerciseKey(toName);
      if (!fromKey || !toKey || fromKey === toKey) continue;
      out.push({ from_key: fromKey, to: toName, to_key: toKey, day });
    }
  }
  return out;
}

function plannedKeys(): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.name FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
        WHERE COALESCE(pi.kind,'strength') != 'cardio'`
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => normalizedExerciseKey(row.name)).filter(Boolean);
}

function carryInputs(): { swaps: RecordedSwap[]; planned: string[] } {
  return requestMemo(
    "strength_objective_carry_inputs",
    () => ({ swaps: recordedSwaps(), planned: plannedKeys() }),
    copyDeep
  );
}

/** The lift now carrying this objective's goal, or null while its own exercise is planned (or nothing recorded replaced it). */
export function strengthObjectiveCarry(objective: {
  exercise: string;
  exercise_key: string;
  target_kind?: string | null;
}): StrengthObjectiveCarry | null {
  if (objective.target_kind === "bodyweight_reps") return null;
  const own = objective.exercise_key || normalizedExerciseKey(objective.exercise);
  if (!own) return null;
  const { swaps, planned } = carryInputs();
  if (planned.includes(own)) return null;
  let at = own;
  let name: string | null = null;
  let since: string | null = null;
  for (const swap of swaps) {
    // A swap out of the lift the goal currently rides, or a fresh one out of the goal's own lift.
    if (swap.from_key !== at && swap.from_key !== own) continue;
    if (swap.from_key === own || since == null) since = swap.day;
    at = swap.to_key;
    name = swap.to;
  }
  if (!name || !since || at === own || !planned.includes(at)) return null;
  // A bodyweight lift and a loaded one are not one scale (a pull-up's load is the athlete,
  // a pulldown's the stack): a swap between them carries nothing.
  if (BODYWEIGHT_LIFT.test(objective.exercise) !== BODYWEIGHT_LIFT.test(name)) return null;
  const pattern = classifyPattern(objective.exercise);
  if (!pattern || classifyPattern(name) !== pattern) return null;
  return { exercise: name, exercise_key: at, from: objective.exercise, since };
}

/** The exercise an objective is tracked on today: the lift carrying it, else its own. */
export function strengthObjectiveTrackedExercise(objective: {
  exercise: string;
  exercise_key: string;
  target_kind?: string | null;
}): string {
  return strengthObjectiveCarry(objective)?.exercise ?? objective.exercise;
}
