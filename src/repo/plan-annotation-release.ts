// ---------- a person's plan save releases the brain's claim on what it rewrote ----------
// An applied coaching decision lights up the plan items it changed (the plan read's
// `brain_change_*` fields, keyed `day|exercise`) and offers a one-tap Undo. Both are
// claims about the prescription THAT decision wrote. Once the athlete saves a lift
// themselves, the prescription is theirs: a card reading "resetting to 192.5 lb" under
// a lift they just set to 185 is a stale claim, and an Undo that walks their value back
// to the decision's `before` would overwrite their edit.
//
// The release is recorded on the DECISION, never by rewriting its history: the row
// stays `applied` (its surprise-budget and learning semantics are untouched) and its
// context gains `person_superseded` — the keys the athlete took over and the day they
// did. The plan read stops annotating a released key and Undo leaves a released item
// exactly as it stands (mergeTrainingRollback's `released` predicate). Undo itself is
// retired only when a whole-plan save took over every key the decision recorded:
// `action.changes` is not the whole story (removals and day name/focus are not in it,
// and it is capped), so a per-key release keeps Undo for whatever it still restores.
// The decision's pending per-lift expectations about a released lift step aside too
// (`superseded`), so the evaluator never grades the brain on a prescription it no
// longer wrote.
import { db } from "../db.js";
import { getBrainDecision, patchBrainDecision } from "./brain-decisions.js";
import { localDateISO } from "./shared.js";

export const PERSON_SUPERSEDED_CONTEXT_KEY = "person_superseded";

export type PersonSupersededMarker = {
  /** `day|exercise` keys the athlete's own save took over. */
  keys: string[];
  /** Local day of the (latest) save that released them. */
  on: string;
};

// The same key decorateAccountablePlan and planPrescriptionKey build.
export function planChangeKey(dayNumber: unknown, exercise: unknown): string | null {
  const day = Number(dayNumber);
  const name = String(exercise ?? "")
    .trim()
    .toLowerCase();
  return Number.isFinite(day) && name ? `${day}|${name}` : null;
}

export function personSupersededMarker(context: unknown): PersonSupersededMarker | null {
  const raw = (context as Record<string, unknown> | null)?.[PERSON_SUPERSEDED_CONTEXT_KEY] as any;
  if (!raw || typeof raw !== "object") return null;
  const keys = Array.isArray(raw.keys) ? raw.keys.filter((k: unknown): k is string => typeof k === "string") : [];
  if (!keys.length) return null;
  return { keys, on: typeof raw.on === "string" ? raw.on : "" };
}

/** Is this `day|exercise` key no longer the decision's to annotate or undo? */
export function isPersonSuperseded(marker: PersonSupersededMarker | null, key: string | null): boolean {
  if (!marker || !key) return false;
  return marker.keys.includes(key);
}

// ---------- does the plan still hold what the decision wrote? ----------
// A decision's note is a claim about the prescription IT set. Rows written before a
// person's save released anything (or changed through any other path) can still name a
// lift whose numbers have since moved: "resetting to 192.5 lb" over a squat now at 185.
// So a change entry is compared, field by field, against the item as it stands — only
// the fields the entry actually recorded (a number, or an explicit null). An entry that
// recorded none of them (a bare reason, a days-only restructure) proves nothing either
// way and answers `null`, which callers treat as the old behavior.
const RECORDED_PRESCRIPTION_FIELDS = ["sets", "rep_low", "rep_high", "target_weight", "target_seconds"] as const;

function sameRecordedValue(recorded: unknown, current: unknown): boolean {
  if (recorded == null || current == null) return recorded == null && current == null;
  const a = Number(recorded);
  const b = Number(current);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
}

export function changeMatchesPrescription(change: any, item: any): boolean | null {
  let compared = false;
  for (const field of RECORDED_PRESCRIPTION_FIELDS) {
    if (!change || !Object.hasOwn(change, field)) continue;
    const recorded = change[field];
    if (recorded !== null && !Number.isFinite(Number(recorded))) continue;
    compared = true;
    if (!sameRecordedValue(recorded, item?.[field])) return false;
  }
  return compared ? true : null;
}

/**
 * The `day|exercise` keys where the plan no longer holds what this decision recorded.
 * Undo treats them exactly like a person-released key: the item stays as it stands.
 */
export function mismatchedChangeKeys(action: any, planDays: any[]): Set<string> {
  const current = new Map<string, any>();
  for (const day of Array.isArray(planDays) ? planDays : []) {
    for (const item of Array.isArray(day?.items) ? day.items : []) {
      const key = planChangeKey(day?.day_number, item?.exercise);
      if (key && !current.has(key)) current.set(key, item);
    }
  }
  const out = new Set<string>();
  for (const change of Array.isArray(action?.changes) ? action.changes : []) {
    const key = planChangeKey(change?.day_number, change?.exercise);
    if (!key || !current.has(key)) continue;
    if (changeMatchesPrescription(change, current.get(key)) === false) out.add(key);
  }
  return out;
}

function decisionChangeKeys(action: any): string[] {
  const keys = new Set<string>();
  for (const change of Array.isArray(action?.changes) ? action.changes : []) {
    const key = planChangeKey(change?.day_number, change?.exercise);
    if (key) keys.add(key);
  }
  return [...keys];
}

function exerciseOfKey(key: string): string {
  return key.slice(key.indexOf("|") + 1);
}

// A released lift's pending per-lift expectations (subject_key = the exercise) step aside
// as `superseded` — the arbitration's own "no longer this decision's to answer" status,
// which the maturity pass never picks up again (unlike `canceled`, which it re-reads and
// would grade against a decision that is still `applied`). A lift the decision still owns
// on another day keeps its window. Session-wide windows (no subject) are untouched.
function supersedeReleasedExpectations(decisionId: number, releasedKeys: string[], ownKeys: string[]): void {
  const stillOwned = new Set(ownKeys.filter((key) => !releasedKeys.includes(key)).map(exerciseOfKey));
  const exercises = [...new Set(releasedKeys.map(exerciseOfKey))].filter((name) => !stillOwned.has(name));
  if (!exercises.length) return;
  db.prepare(
    `UPDATE brain_expectations SET status = 'superseded'
      WHERE decision_id = ? AND status IN ('pending','mature')
        AND subject_key IS NOT NULL AND LOWER(TRIM(subject_key)) IN (${exercises.map(() => "?").join(",")})`
  ).run(decisionId, ...exercises);
}

/**
 * Release every applied training decision's claim on the `day|exercise` keys a person's
 * save changed. `retireUndoWhenFullyReleased` is for a whole-plan save only: a decision
 * whose every recorded key was taken over stops offering Undo.
 *
 * Returns the ids of the decisions it touched. Idempotent — a key already released is
 * not re-stamped. Call inside the save's own transaction so a refused save releases
 * nothing.
 */
export function releasePlanAnnotationsForPersonSave(
  keys: Iterable<string>,
  opts: { retireUndoWhenFullyReleased?: boolean; on?: string } = {}
): number[] {
  const wanted = new Set(keys);
  if (!wanted.size) return [];
  const on = opts.on ?? localDateISO();
  const rows = db
    .prepare(
      `SELECT id, action_json, context_json FROM brain_decisions
        WHERE status = 'applied' AND domain = 'training'
        ORDER BY id DESC LIMIT 500`
    )
    .all() as Array<{ id: number; action_json: string | null; context_json: string | null }>;
  const touched: number[] = [];
  for (const row of rows) {
    let action: any = null;
    let context: any = null;
    try {
      action = row.action_json ? JSON.parse(row.action_json) : null;
      context = row.context_json ? JSON.parse(row.context_json) : null;
    } catch {
      continue;
    }
    const own = decisionChangeKeys(action);
    const released = new Set(personSupersededMarker(context)?.keys ?? []);
    const hits = own.filter((key) => wanted.has(key) && !released.has(key));
    if (!hits.length) continue;
    for (const key of hits) released.add(key);
    const retireUndo = opts.retireUndoWhenFullyReleased === true && own.every((key) => released.has(key));
    const current = getBrainDecision(Number(row.id));
    if (!current) continue;
    const marker: PersonSupersededMarker = { keys: [...released].sort(), on };
    patchBrainDecision(Number(row.id), {
      context: {
        ...((current.context as Record<string, unknown>) ?? {}),
        [PERSON_SUPERSEDED_CONTEXT_KEY]: marker,
        ...(retireUndo ? { rollback_available: false } : {}),
      },
      ...(retireUndo ? { reversible: false } : {}),
    });
    supersedeReleasedExpectations(Number(row.id), [...released], own);
    touched.push(Number(row.id));
  }
  return touched;
}
