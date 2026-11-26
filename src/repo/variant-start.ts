// ============================================================================
// variant-start.ts — the first target for a variant entering the plan, from its unit.
//
// A lift that enters the plan with no history of its own (a swap, a ladder rotation, the
// append path) used to arrive with no stored load: its only starting number was the
// related-lift idea in the live prescription (related-lift.ts), never stored. The
// movement unit knows more: the athlete's current working load on a sibling variant of
// the SAME unit, read across through a ratio this repo can stand behind
// (variant-transfer.ts — learned from his own log where both were done, else the
// conservative table, which only ever reads downward from the harder anchor).
//
//   start = floor_to_step(sibling working load x ratio x NEW_VARIANT_START_FACTOR)
//
// rounded DOWN to the lift's own load step (load-grid.ts loadIncrement), so the first
// session is submaximal and the number is one the equipment can be set to. The slot it is
// written into is stamped by the ordinary write path (prescription-authorship.ts), so it
// reads UNTESTED until it has been lifted: nothing judges it, and the progression engine's
// plan-ahead rule re-grounds it down to what the log shows if the guess was high.
//
// Kept to the safe cases: positive loads only (an assist number belongs to a different
// regime), reps-mode work only (a hold belongs to its exact grip), a sibling trained inside
// SIBLING_CURRENT_DAYS, and no ratio means no number (the caller keeps today's behaviour).
// A lift that HAS a working weight of its own keeps it — unless that history is stale (no
// session inside LIFT_CURRENT_WINDOW_DAYS) and a LEARNED ratio is on record, when the
// start is the lower of the two: an old number is evidence, but a long break may have
// cost some of it.
//
// Evidence: strength is partly specific to the exercise, so a sibling's load transfers
// only through a ratio; a conservative first session (about a tenth under the estimate)
// leaves room for the skill of a new variant. The factor itself is a coaching convention,
// not a measured constant.
// ============================================================================
import { db } from "../db.js";
import { isKnownBodyweightMovement, progressionLineageIds, resolveExerciseName } from "./exercise-canon.js";
import { recentWorkingWeight } from "./exercises.js";
import { sessionCountsTowardLiftTrajectory } from "./lift-comparability.js";
import { loadIncrement } from "./load-grid.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import { capabilityUnitOf } from "./strength-capability.js";
import type { StrengthExposure } from "./strength-objectives.js";
import { variantTransfer } from "./variant-transfer.js";

/** The first session on a new variant sits this far under the transferred estimate. */
export const NEW_VARIANT_START_FACTOR = 0.9;
/** A sibling counts as current when it was trained inside this many days. */
export const SIBLING_CURRENT_DAYS = 42;
/** A lift's own history is current when it was trained inside this many days (program state's LIFT_CURRENT_WINDOW_DAYS, restated: a load-order cycle). */
export const OWN_HISTORY_CURRENT_DAYS = 28;
/** How far back the exposure series for a learned ratio is read. */
const SERIES_DAYS = 365;

export interface VariantStart {
  /** The stored first target (lb, positive). */
  weight: number;
  source: string;
  basis: "learned" | "table";
}

const epley = (load: number, reps: number) => load * (1 + reps / 30);

// One honest exposure per comparable session (positive loads only): the session's best
// Epley, the shape the capability read and variant-transfer.ts work in.
function exposuresOf(name: string, date: string): StrengthExposure[] {
  const ids = progressionLineageIds(name);
  if (!ids.length) return [];
  const from = addDaysISO(date, -SERIES_DAYS) ?? date;
  const inIds = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ls.session_id AS session_id, s.date AS date, ls.weight AS weight, ls.reps AS reps
         FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id IN (${inIds}) AND s.date BETWEEN ? AND ?
          AND ls.weight > 0 AND ls.reps > 0 AND ls.duration_sec IS NULL
        ORDER BY s.date, ls.id`
    )
    .all(...ids, from, date) as any[];
  const best = new Map<number, StrengthExposure>();
  for (const row of rows) {
    const sessionId = Number(row.session_id);
    const load = Number(row.weight);
    const reps = Number(row.reps);
    const est = epley(load, reps);
    const prior = best.get(sessionId);
    if (!prior || est > prior.est_1rm)
      best.set(sessionId, { date: String(row.date).slice(0, 10), top_weight: load, top_reps: reps, est_1rm: est });
  }
  return [...best.entries()]
    .filter(([sessionId]) => sessionCountsTowardLiftTrajectory(sessionId))
    .map(([, exposure]) => exposure)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function lastTrained(name: string): string | null {
  const ids = progressionLineageIds(name);
  if (!ids.length) return null;
  const inIds = ids.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT MAX(s.date) AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id WHERE ls.exercise_id IN (${inIds})`
    )
    .get(...ids) as any;
  return row?.d ? String(row.d).slice(0, 10) : null;
}

// Every stored lift in the same unit, other than the incoming one.
function siblingsInUnit(
  name: string,
  group: string | null,
  unitKey: string
): Array<{ name: string; group: string | null }> {
  const self = resolveExerciseName(name).exercise_id;
  const rows = db
    .prepare(`SELECT id, name, muscle_group FROM exercises WHERE COALESCE(mode, 'reps') <> 'timed'`)
    .all() as any[];
  const out: Array<{ name: string; group: string | null }> = [];
  for (const row of rows) {
    if (self != null && Number(row.id) === Number(self)) continue;
    const sibling = String(row.name ?? "");
    const siblingGroup = row.muscle_group == null ? group : String(row.muscle_group);
    if (capabilityUnitOf(sibling, siblingGroup)?.key !== unitKey) continue;
    out.push({ name: sibling, group: siblingGroup });
  }
  return out;
}

/**
 * The unit-derived first target for `name`, or null (no unit, no current sibling, no ratio,
 * a non-positive result): the caller then keeps today's behaviour. `opts.learnedOnly` asks
 * only for a learned ratio (the stale-history case).
 */
export function unitStartingLoad(
  name: string,
  group: string | null,
  opts: { date?: string; learnedOnly?: boolean } = {}
): VariantStart | null {
  const date = String(opts.date || localDateISO()).slice(0, 10);
  const bare = String(name ?? "").trim();
  if (!bare || isKnownBodyweightMovement(bare, null)) return null;
  const unit = capabilityUnitOf(bare, group);
  if (!unit) return null;
  const ownExposures = exposuresOf(bare, date);
  const step = loadIncrement(bare, group);
  const candidates: Array<VariantStart & { rank: number }> = [];
  for (const sibling of siblingsInUnit(bare, group, unit.key)) {
    const trained = lastTrained(sibling.name);
    if (!trained || (daysBetweenISO(date, trained) ?? Number.POSITIVE_INFINITY) > SIBLING_CURRENT_DAYS) continue;
    const working = recentWorkingWeight(sibling.name);
    if (working == null || !(working > 0)) continue;
    const transfer = variantTransfer(
      { name: bare, exposures: ownExposures },
      { name: sibling.name, exposures: exposuresOf(sibling.name, date) }
    );
    if (transfer.kind === "none") continue;
    if (opts.learnedOnly && transfer.kind !== "learned") continue;
    const raw = working * transfer.ratio * NEW_VARIANT_START_FACTOR;
    const weight = Math.floor(raw / step + 1e-9) * step;
    if (!(weight >= step)) continue;
    candidates.push({
      weight,
      source: resolveExerciseName(sibling.name).canonical || sibling.name,
      basis: transfer.kind,
      rank: transfer.kind === "learned" ? 0 : 1,
    });
  }
  // A learned ratio outranks the table; between equals, the LOWER start (the conservative read).
  candidates.sort((a, b) => a.rank - b.rank || a.weight - b.weight || a.source.localeCompare(b.source));
  const pick = candidates[0];
  return pick ? { weight: pick.weight, source: pick.source, basis: pick.basis } : null;
}

/**
 * The stored first target for a lift ENTERING the plan, given its own recent working
 * weight (null when it has none). Null keeps today's behaviour (the caller's own tiers).
 *   - no history of its own: the unit start (learned, else table);
 *   - stale history (nothing inside OWN_HISTORY_CURRENT_DAYS) and a learned ratio: the lower
 *     of its own old number and the unit start;
 *   - current history, assisted or bodyweight work: null (its own number stands).
 */
export function enteringVariantStart(
  name: string,
  group: string | null,
  ownWeight: number | null,
  date: string = localDateISO()
): VariantStart | null {
  try {
    if (ownWeight == null) return unitStartingLoad(name, group, { date });
    if (!(ownWeight > 0)) return null;
    const trained = lastTrained(name);
    const stale = trained == null || (daysBetweenISO(date, trained) ?? 0) > OWN_HISTORY_CURRENT_DAYS;
    if (!stale) return null;
    const start = unitStartingLoad(name, group, { date, learnedOnly: true });
    return start && start.weight < ownWeight ? start : null;
  } catch {
    // A failed read is no number: the caller's own tiers answer.
    return null;
  }
}
