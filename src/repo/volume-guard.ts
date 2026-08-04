// Training VOLUME has no ladder back up.
//
// Progressive overload moves load and reps; nothing in the progression or push
// ladder can RAISE an item's `sets` (daily-composition only ever takes a Math.min
// against the plan). So a set reduction is permanent unless something deliberately
// restores it.
//
// The path that actually fired is the deterministic one: applyFuelProtection
// (progression.ts) halves `sets` on a fuel-protection deload, buildProgressionProposal
// re-emits that halved value as the new baseline, and each apply halves what the last
// one left — 5 → 3 → 2 → 1 with nothing able to climb back. An agent-authored revision
// can reach the same write, so the guards below sit on the `changes[]` apply path —
// the one every incremental prescription edit goes through — rather than on any one
// proposer. A `parsed.days` RESTRUCTURE deliberately bypasses them: it rewrites the
// whole template instead of stepping one item, and the autonomy layer holds it as
// `training_structure` (announce/ask, never quiet), which is the guard that fits it.
// This module owns the two halves of the incremental path:
//
//   1. the bookkeeping: what each applied change did to `sets`, and what value it
//      owes the athlete back, written into the decision's own action JSON (no
//      schema of its own — brain_decisions.action_json is the durable record);
//   2. the road back up: at a natural boundary, once the condition that forced the
//      cut has cleared, ONE set per item per boundary until the recorded prior
//      value is reached — never past it, never against a number the athlete has
//      since chosen themselves.
//
// A set-reducing change is also structural, not a bounded load step: `changesReduceSets`
// is the deterministic detector the autonomy layer uses so a plan-wide volume cut
// can never take the tier meant for one lift's load nudge.
import { db } from "../db.js";
import { normalizeExerciseName } from "./exercise-canon.js";

// WHY the volume came off, recorded at the moment of the cut. A restore trigger
// speaks about the thing that cleared, so it may only act on the debt IT created:
// "fuelling has settled" is a lie over a cut that pain or a deload block asked for.
// `fuel` is stamped by the fuel-protection path (progression.ts) and carried forward
// by each restore step; everything else is `policy` — recorded, owed, but not the
// fuel loop's to give back.
export type VolumeCutCause = "fuel" | "policy";

function normalizeVolumeCause(value: unknown): VolumeCutCause | null {
  const text = String(value ?? "").trim();
  return text === "fuel" || text === "policy" ? text : null;
}

// One item's volume history across a single applied revision. `restore_to` is the
// value the item is owed back; `applied_sets` is what the plan was actually left
// at, and doubles as the proof-of-chain — if the plan no longer reads that number,
// the athlete has moved it themselves and Cairn does not argue.
export interface VolumeRestoreItem {
  day_number: number;
  exercise: string;
  prior_sets: number;
  applied_sets: number;
  restore_to: number;
  cause: VolumeCutCause;
}

export interface OpenVolumeRestore extends VolumeRestoreItem {
  current_sets: number;
}

function itemKey(dayNumber: unknown, exercise: unknown): string {
  return `${Number(dayNumber)}|${normalizeExerciseName(String(exercise ?? ""))}`;
}

function intOrNull(value: unknown): number | null {
  return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null;
}

// The stored `sets` for one strength prescription, or null when the item is not on
// that day at all (removed, rotated out, or the day itself is gone).
function currentPlanSets(dayNumber: number, exercise: string): number | null {
  const row = db
    .prepare(
      `SELECT pi.sets AS sets
         FROM plan_items pi
         JOIN plan_days pd ON pd.id = pi.plan_day_id
         JOIN exercises e ON e.id = pi.exercise_id
        WHERE pd.day_number = ? AND lower(e.name) = lower(?)
          AND (pi.kind IS NULL OR pi.kind != 'cardio')`
    )
    .get(Number(dayNumber), String(exercise ?? "")) as any;
  return row ? intOrNull(row.sets) : null;
}

// Does this proposal's changes[] LOWER the prescribed volume anywhere? Answered
// against what the plan currently holds, never against the model's own account of
// its intent. Removing a movement outright counts — a removal is the largest
// volume cut a single change can make.
export function changesReduceSets(changes: unknown): boolean {
  if (!Array.isArray(changes)) return false;
  for (const change of changes) {
    const dayNumber = Number((change as any)?.day_number);
    const exercise = String((change as any)?.exercise ?? "").trim();
    if (!Number.isFinite(dayNumber) || !exercise) continue;
    const requested = intOrNull((change as any)?.sets);
    const removes = (change as any)?.remove === true || requested === 0;
    const current = currentPlanSets(dayNumber, exercise);
    if (current == null) continue; // an ADD has no volume to cut
    if (removes) return true;
    if (requested != null && requested < current) return true;
  }
  return false;
}

// The most recent applied decisions that carry volume bookkeeping, newest first.
function recentVolumeRestoreRows(limit = 200): VolumeRestoreItem[][] {
  let rows: Array<{ action_json: string | null }> = [];
  try {
    rows = db
      .prepare(
        `SELECT action_json FROM brain_decisions
          WHERE status = 'applied' AND json_extract(action_json, '$.volume_restore') IS NOT NULL
          ORDER BY id DESC LIMIT ?`
      )
      .all(Math.max(1, Math.trunc(limit))) as any[];
  } catch {
    return [];
  }
  const out: VolumeRestoreItem[][] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row.action_json ?? "{}"))?.volume_restore;
      if (Array.isArray(parsed)) out.push(parsed.filter(Boolean) as VolumeRestoreItem[]);
    } catch {
      // A malformed ledger row is skipped, never allowed to sink the pass.
    }
  }
  return out;
}

// The newest recorded volume entry for one plan item — the head of its restore
// chain, or null when the item has never been stepped.
function latestVolumeRestoreItem(dayNumber: number, exercise: string): VolumeRestoreItem | null {
  const key = itemKey(dayNumber, exercise);
  for (const items of recentVolumeRestoreRows()) {
    for (const item of items) {
      if (itemKey(item?.day_number, item?.exercise) === key) return item;
    }
  }
  return null;
}

/**
 * Turn one apply's per-change results into the volume bookkeeping stored on its
 * decision. Only items whose `sets` actually MOVED are recorded, and only two
 * shapes carry a restore debt:
 *
 *   - a reduction, which owes back the value it came down from (carrying forward
 *     an older, higher debt when this cut lands on top of an unfinished chain, so
 *     two successive cuts cannot quietly lower the target);
 *   - a restore step, which declares the target it is climbing toward via
 *     `parsed.volume_restore` so the chain survives its own increase.
 *
 * An ordinary increase records nothing — there is nothing owed.
 *
 * An item named more than once in one revision collapses to a SINGLE entry that
 * spans the whole revision: `prior_sets` from the first occurrence (where the
 * revision found it) and `applied_sets` from the last (where it actually left it).
 * Keeping the first occurrence's applied value would record a chain the plan does
 * not match, and openVolumeRestoreTargets reads that mismatch as an athlete edit —
 * so the debt would be silently voided rather than owed.
 */
export function volumeRestoreLedger(affected: unknown, parsed: unknown): VolumeRestoreItem[] {
  const declared = new Map<string, number>();
  const declaredCause = new Map<string, VolumeCutCause>();
  for (const entry of Array.isArray((parsed as any)?.volume_restore) ? (parsed as any).volume_restore : []) {
    const key = itemKey((entry as any)?.day_number, (entry as any)?.exercise);
    const target = intOrNull((entry as any)?.restore_to);
    if (target != null) declared.set(key, target);
    const cause = normalizeVolumeCause((entry as any)?.cause);
    if (cause) declaredCause.set(key, cause);
  }
  const proposalCause = normalizeVolumeCause((parsed as any)?.volume_cause);
  const out: VolumeRestoreItem[] = [];
  const index = new Map<string, number>();
  for (const item of Array.isArray(affected) ? affected : []) {
    const dayNumber = intOrNull((item as any)?.day_number);
    const exercise = String((item as any)?.exercise ?? "").trim();
    const priorSets = intOrNull((item as any)?.prior_sets);
    const appliedSets = intOrNull((item as any)?.sets);
    if (dayNumber == null || !exercise || priorSets == null || appliedSets == null) continue;
    const key = itemKey(dayNumber, exercise);
    const existing = index.get(key);
    if (existing != null) {
      // Second (or third) change on one item: only where it ENDED UP is new.
      out[existing].applied_sets = appliedSets;
      continue;
    }
    if (appliedSets === priorSets) continue;
    let restoreTo = declared.get(key) ?? null;
    if (restoreTo == null && appliedSets < priorSets) {
      // A cut landing on an unfinished chain inherits that chain's target, so
      // 5 → 4 → 3 still owes 5 back rather than 4.
      const open = latestVolumeRestoreItem(dayNumber, exercise);
      const inherited = open && open.applied_sets === priorSets ? intOrNull(open.restore_to) : null;
      restoreTo = Math.max(priorSets, inherited ?? priorSets);
    }
    if (restoreTo == null) continue;
    const cause =
      normalizeVolumeCause((item as any)?.volume_cause) ?? declaredCause.get(key) ?? proposalCause ?? "policy";
    index.set(key, out.length);
    out.push({
      day_number: dayNumber,
      exercise,
      prior_sets: priorSets,
      applied_sets: appliedSets,
      restore_to: restoreTo,
      cause,
    });
  }
  // A revision that moved an item and moved it straight back owes nothing.
  return out.filter((entry) => entry.applied_sets !== entry.prior_sets).slice(0, 24);
}

/**
 * Plan items that are still owed volume back. An item drops out when it has left
 * the plan, when it has already reached its recorded target, or when the plan no
 * longer reads the number Cairn last left it at — that last one is a manual edit,
 * and the athlete's own choice ends the chain rather than fighting it.
 *
 * `cause` scopes the answer to one trigger's own debt. The chain's newest entry
 * still owns the item either way, so a cut of a different cause landing on top does
 * not hand the item to the wrong trigger — it takes the item out of scope until its
 * own trigger clears.
 */
export function openVolumeRestoreTargets(opts: { cause?: VolumeCutCause } = {}): OpenVolumeRestore[] {
  const seen = new Set<string>();
  const out: OpenVolumeRestore[] = [];
  for (const items of recentVolumeRestoreRows()) {
    for (const item of items) {
      const dayNumber = intOrNull(item?.day_number);
      const exercise = String(item?.exercise ?? "").trim();
      const appliedSets = intOrNull(item?.applied_sets);
      const restoreTo = intOrNull(item?.restore_to);
      if (dayNumber == null || !exercise || appliedSets == null || restoreTo == null) continue;
      const key = itemKey(dayNumber, exercise);
      if (seen.has(key)) continue; // newest entry per item owns its chain
      seen.add(key);
      const cause = normalizeVolumeCause(item?.cause) ?? "policy";
      if (opts.cause && cause !== opts.cause) continue;
      const currentSets = currentPlanSets(dayNumber, exercise);
      if (currentSets == null) continue; // no longer on the plan
      if (currentSets !== appliedSets) continue; // the athlete moved it since — their number stands
      if (currentSets >= restoreTo) continue; // already home
      out.push({
        day_number: dayNumber,
        exercise,
        prior_sets: intOrNull(item?.prior_sets) ?? restoreTo,
        applied_sets: appliedSets,
        restore_to: restoreTo,
        cause,
        current_sets: currentSets,
      });
    }
  }
  return out;
}

export const VOLUME_RESTORE_AGENT = "volume-restore";
export const VOLUME_RESTORE_INSTRUCTION = "restore held training volume";

// Athlete-facing, and held to the reading grammar: a plain sentence about what is
// coming back, with no engineering vocabulary, no number-as-grade and no gate. The
// opening clause names the thing that actually cleared — the fuel story is only ever
// told over volume the fuel path itself took away.
function restoreReason(target: OpenVolumeRestore, nextSets: number): string {
  const opening = target.cause === "fuel" ? "Fuelling has settled" : "What asked for less has settled";
  return nextSets < target.restore_to
    ? `${opening}, so ${target.exercise} takes a set back — ${nextSets} now, working back to ${target.restore_to}.`
    : `${opening}, so ${target.exercise} is back to its full ${target.restore_to} sets.`;
}

/**
 * The proposal payload that steps every owed item up by ONE set — or null when
 * nothing is owed. Pure: the caller creates the proposal and routes it through
 * autonomy. Idempotent by construction, because the step is computed from what the
 * plan currently holds, so a repeat pass over an unapplied draft yields the same
 * payload and a pass after the target is reached yields null.
 */
export function volumeRestorePayload(opts: { cause?: VolumeCutCause } = {}): {
  summary: string;
  rationale: string;
  changes: Array<{
    day_number: number;
    exercise: string;
    sets: number;
    reason: string;
    volume_cause: VolumeCutCause;
  }>;
  volume_restore: Array<{ day_number: number; exercise: string; restore_to: number; cause: VolumeCutCause }>;
} | null {
  const targets = openVolumeRestoreTargets(opts).slice(0, 12);
  if (!targets.length) return null;
  const changes = targets.map((target) => {
    const nextSets = Math.min(target.restore_to, target.current_sets + 1);
    return {
      day_number: target.day_number,
      exercise: target.exercise,
      sets: nextSets,
      reason: restoreReason(target, nextSets),
      // The step carries the cut's own cause forward, so a partly-climbed chain is
      // still recognisable to the trigger that owns it on the next boundary.
      volume_cause: target.cause,
    };
  });
  return {
    summary: `Easing training volume back on ${changes.length} lift${changes.length === 1 ? "" : "s"}`,
    rationale: "What asked for less volume has settled, so each lift that was trimmed takes one set back this week.",
    changes,
    // The targets ride WITH the proposal so the decision it writes carries the
    // chain forward — without this, its own increase would look like an ordinary
    // step up and the remaining debt would be forgotten.
    volume_restore: targets.map((target) => ({
      day_number: target.day_number,
      exercise: target.exercise,
      restore_to: target.restore_to,
      cause: target.cause,
    })),
  };
}

// Any still-open restore draft, so a daily pass can retire it before minting a
// fresh one instead of stacking identical "a set comes back" cards.
export function openVolumeRestoreDraftIds(): number[] {
  const rows = db
    .prepare(`SELECT id FROM plan_proposals WHERE status = 'draft' AND agent = ?`)
    .all(VOLUME_RESTORE_AGENT) as any[];
  return rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
}
