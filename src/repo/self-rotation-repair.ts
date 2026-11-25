// ============================================================================
// self-rotation-repair.ts — undo what the alias self-rotation left on the plan.
//
// Before the one resolver reached the swap path (plan.ts applyPlanSwap, 2026-11-25), the
// progression engine could "rotate" a slot into its OWN lift under another spelling: a
// slot holding "Dumbbell Biceps Curl" swapped for "DB Bicep Curl". The apply rewrote the
// slot's note to "Rotated in for Dumbbell Biceps Curl — picking up from your last working
// 50 lb.", re-grounded its prescription and re-stamped its prescribed_at, so the slot read
// as a fresh, untested prescription (prescription-authorship.ts).
//
// This repair finds exactly that shape and nothing else: a plan item whose note OPENS with
// a rotation sentence naming a lift that resolves (resolveExerciseName, or the expanded
// key when that spelling's row has since been merged away) to the item's OWN exercise.
// For each, it walks the decision ledger (brain_rollbacks, before/after snapshots and
// stamps) back through every self-rotation that slot took, newest first, to the state
// before the EARLIEST one:
//   - the note: the false sentence goes; it is replaced by the pre-rotation note when the
//     ledger has one that is not itself a self-rotation, and anything appended after the
//     sentence since (a coach-note layer) is kept;
//   - prescribed_at returns to the pre-rotation stamp ONLY when (a) the newest
//     self-rotation is the write that left the slot's current stamp (nothing re-stamped it
//     since) and (b) the slot's prescription now — sets, reps, target load/seconds — is
//     exactly what it was before the earliest self-rotation (the rule Undo's
//     withRestoredStamps uses). Otherwise the stamp stays: the slot really was prescribed
//     anew, and saying otherwise would hand an untested load to the progression engine as
//     tested.
// A genuine rotation (the note names a DIFFERENT lift) is never touched. Idempotent: a
// repaired note no longer opens with a self-rotation sentence. It runs once per database
// at boot (SELF_ROTATION_REPAIR_KEY), before the server takes a request or the scheduler
// ticks.
// ============================================================================
import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { invalidateDayRead } from "./day-read-cache.js";
import { expandedExerciseKey, resolveExerciseName } from "./exercise-canon.js";
import { normalizeStamp } from "./prescription-authorship.js";
import { bumpTrainingDataVersion } from "./training-cache.js";

export const SELF_ROTATION_REPAIR_KEY = "self_rotation_note_repair_v1";

// The sentence(s) applyPlanSwap's movementStartNote wrote: the bare lead ("Rotated in for
// X."), the baseline cue, a grounded load ("… 52.5 lb." — the decimal point is not a
// sentence end), or a related-lift idea, which runs to a second "Log …" sentence.
const RELATED_SENTENCE =
  /^Rotated in for (.+?) — (?:nothing logged on this one yet|no history here yet|untested so far)\b[^\n]*?(?:Log what you actually lift|Log the real number|Log what it really is)\./;
const ONE_SENTENCE = /^Rotated in for ([^\n]+?)(?: — [^\n]*?)?\.(?=\s|$)/;

/** The rotation sentence a note opens with, the lift it names, and whatever follows it. */
export function rotationSentence(note: unknown): { sentence: string; lift: string; rest: string } | null {
  const text = String(note ?? "").trim();
  const m = RELATED_SENTENCE.exec(text) ?? ONE_SENTENCE.exec(text);
  if (!m) return null;
  const lift = m[1].replace(/ — .*$/, "").trim();
  if (!lift) return null;
  return { sentence: m[0], lift, rest: text.slice(m[0].length).trim() };
}

/** The lift a "Rotated in for X …" note names, or null when the note is not one. */
export function rotatedInFor(note: unknown): string | null {
  return rotationSentence(note)?.lift ?? null;
}

// Is `name` this exercise row, by the resolver or (for a spelling whose own row was
// merged away since) by the expanded key? Equality only, never a looser match.
function namesRow(name: string, exerciseId: number, exerciseName: string): boolean {
  try {
    const resolved = resolveExerciseName(name).exercise_id;
    if (resolved != null) return Number(resolved) === Number(exerciseId);
  } catch {
    /* fall through to the key */
  }
  const a = expandedExerciseKey(name);
  return !!a && a === expandedExerciseKey(exerciseName);
}

export interface SelfRotationRepair {
  plan_item_id: number;
  day_number: number;
  exercise: string;
  note_was: string;
  note_now: string | null;
  prescribed_at_was: string | null;
  prescribed_at_now: string | null;
}

interface RollbackStamps {
  before: any[];
  after: any[];
  before_stamps: Record<string, string | null>;
  after_stamps: Record<string, string | null>;
}

function rollbackStampPayloads(): RollbackStamps[] {
  try {
    const rows = db
      .prepare(
        `SELECT payload_json FROM brain_rollbacks
          WHERE payload_json LIKE '%"before_stamps"%' ORDER BY decision_id DESC`
      )
      .all() as Array<{ payload_json: string }>;
    const out: RollbackStamps[] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(String(row.payload_json));
        if (payload && typeof payload.before_stamps === "object" && typeof payload.after_stamps === "object") {
          out.push({
            before: Array.isArray(payload.before) ? payload.before : [],
            after: Array.isArray(payload.after) ? payload.after : [],
            before_stamps: payload.before_stamps ?? {},
            after_stamps: payload.after_stamps ?? {},
          });
        }
      } catch {
        /* an unreadable payload recovers nothing */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function splitKey(key: string): { day: number; exercise: string } | null {
  const at = key.indexOf("|");
  if (at <= 0) return null;
  const day = Number(key.slice(0, at));
  const exercise = key.slice(at + 1);
  return Number.isFinite(day) && exercise ? { day, exercise } : null;
}

// The prescription fields a stamp vouches for (prescription-authorship.ts).
const PRESCRIPTION_FIELDS = ["sets", "rep_low", "rep_high", "target_weight", "target_seconds"] as const;
const fieldValue = (value: unknown): number | null =>
  value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
function samePrescription(a: any, b: any): boolean {
  return !!a && !!b && PRESCRIPTION_FIELDS.every((field) => fieldValue(a[field]) === fieldValue(b[field]));
}

interface SlotState {
  note: string;
  stamp: string | null;
  slot: any;
}

/**
 * Walk the ledger back from the slot's current state through every self-rotation it
 * took. Returns the state before the earliest one (`target`), and whether the newest
 * self-rotation is what left the CURRENT stamp. Null when no ledger entry shows the
 * self-rotation that wrote the current note.
 */
function preRotationState(
  payloads: readonly RollbackStamps[],
  item: { day_number: number; exercise_id: number; exercise: string; prescribed_at: string | null; sentence: string }
): { target: SlotState; stampIntact: boolean } | null {
  const ours = (name: string) => namesRow(name, item.exercise_id, item.exercise);
  const isSelfRotation = (note: unknown) => {
    const lift = rotatedInFor(note);
    return !!lift && ours(lift);
  };
  const slotIn = (plan: any[]) => {
    const day = plan.find((d: any) => Number(d?.day_number) === item.day_number);
    return (Array.isArray(day?.items) ? day.items : []).find((it: any) => ours(String(it?.exercise ?? ""))) ?? null;
  };
  const stampFor = (stamps: Record<string, string | null>): string | null | undefined => {
    const hit = Object.entries(stamps).find(([key]) => {
      const parts = splitKey(key);
      return !!parts && parts.day === item.day_number && ours(parts.exercise);
    });
    return hit ? normalizeStamp(hit[1]) : undefined;
  };

  // The newest apply that wrote the note's rotation sentence: its after-snapshot carries
  // exactly that sentence on this slot and its before-snapshot did not.
  let index = payloads.findIndex((p) => {
    const after = slotIn(p.after);
    if (!after || String(after.note ?? "").trim() !== item.sentence) return false;
    const before = slotIn(p.before);
    return !before || String(before.note ?? "").trim() !== item.sentence;
  });
  // Identical text twice: the newest apply that LEFT this sentence may have found it
  // already there (its before-note equals it). Prefer it when it wrote the current stamp.
  const current = normalizeStamp(item.prescribed_at);
  const restamper = payloads.findIndex((p) => {
    const after = slotIn(p.after);
    return !!after && String(after.note ?? "").trim() === item.sentence && stampFor(p.after_stamps) === current;
  });
  if (restamper >= 0 && (index < 0 || restamper < index)) index = restamper;
  if (index < 0) return null;
  const stampIntact = current != null && stampFor(payloads[index].after_stamps) === current;

  let step = payloads[index];
  for (;;) {
    const before = slotIn(step.before);
    const beforeStamp = stampFor(step.before_stamps);
    const state: SlotState = {
      note: before?.note == null ? "" : String(before.note).trim(),
      stamp: beforeStamp === undefined ? null : beforeStamp,
      slot: before,
    };
    if (!before || beforeStamp === undefined || !isSelfRotation(state.note)) return { target: state, stampIntact };
    // The state before this apply was ITSELF a self-rotation: find the older apply that
    // left exactly that note and stamp, and keep walking. A broken chain ends here, on a
    // self-rotation state the caller never restores a stamp to.
    const at = payloads.indexOf(step);
    const older = payloads.slice(at + 1).find((p) => {
      const after = slotIn(p.after);
      return !!after && String(after.note ?? "").trim() === state.note && stampFor(p.after_stamps) === state.stamp;
    });
    if (!older) return { target: state, stampIntact };
    step = older;
  }
}

/** Find and repair every self-rotation note on the plan. Idempotent. */
export function repairSelfRotationNotes(): { repaired: SelfRotationRepair[] } {
  const rows = db
    .prepare(
      `SELECT pi.id AS id, pi.note AS note, pi.exercise_id AS exercise_id, pi.prescribed_at AS prescribed_at,
              pi.sets AS sets, pi.rep_low AS rep_low, pi.rep_high AS rep_high,
              pi.target_weight AS target_weight, pi.target_seconds AS target_seconds,
              pd.day_number AS day_number, e.name AS exercise
         FROM plan_items pi
         JOIN plan_days pd ON pd.id = pi.plan_day_id
         JOIN exercises e ON e.id = pi.exercise_id
        WHERE pi.note LIKE 'Rotated in for %'`
    )
    .all() as any[];
  const repaired: SelfRotationRepair[] = [];
  let payloads: RollbackStamps[] | null = null;
  for (const row of rows) {
    const parsed = rotationSentence(row.note);
    if (!parsed || !namesRow(parsed.lift, Number(row.exercise_id), String(row.exercise))) continue;
    payloads ??= rollbackStampPayloads();
    const item = {
      day_number: Number(row.day_number),
      exercise_id: Number(row.exercise_id),
      exercise: String(row.exercise),
      prescribed_at: row.prescribed_at ?? null,
      sentence: parsed.sentence,
    };
    const walked = preRotationState(payloads, item);
    const target = walked?.target ?? null;
    const targetIsSelf = !!target && !!rotatedInFor(target.note) && namesRow(rotatedInFor(target.note)!, item.exercise_id, item.exercise);
    // The pre-rotation note, when the ledger has one that is not itself a self-rotation;
    // whatever was appended after the false sentence since stays.
    const prior = target && !targetIsSelf && target.note ? target.note : "";
    const noteNow = [prior, parsed.rest].filter(Boolean).join("\n") || null;
    const restoreStamp =
      !!walked && walked.stampIntact && !targetIsSelf && !!target?.slot && samePrescription(target.slot, row);
    const stampNow = restoreStamp ? (target?.stamp ?? null) : (row.prescribed_at ?? null);
    db.prepare(`UPDATE plan_items SET note = ?, prescribed_at = ? WHERE id = ?`).run(noteNow, stampNow, row.id);
    repaired.push({
      plan_item_id: Number(row.id),
      day_number: item.day_number,
      exercise: item.exercise,
      note_was: String(row.note),
      note_now: noteNow,
      prescribed_at_was: item.prescribed_at,
      prescribed_at_now: stampNow,
    });
  }
  if (repaired.length) {
    // A slot's authorship moved, so every cached read of it does: the program-state and
    // progression caches (training data version) and the day read's agent prose.
    bumpTrainingDataVersion();
    try {
      invalidateDayRead();
    } catch {
      /* nothing cached is what invalidation wanted */
    }
  }
  return { repaired };
}

/** The boot pass: once per database, recorded in app_state with what it changed. */
export function repairSelfRotationNotesOnce(): SelfRotationRepair[] | null {
  if (getAppState(SELF_ROTATION_REPAIR_KEY)) return null;
  const { repaired } = repairSelfRotationNotes();
  setAppState(SELF_ROTATION_REPAIR_KEY, JSON.stringify({ at: new Date().toISOString(), repaired }));
  return repaired;
}
