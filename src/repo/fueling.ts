// Fueling follow-through: the one-tap subjective read Today offers after a
// nutrition-target change APPLIES. Calm and adherence-neutral — a small 1-3
// "running low / steady / plenty" energy read (plus an optional hunger read and
// note), captured only while the change is inside its 7-day follow-through window
// and only on a day the athlete actually logged food. The answer is linked to the
// triggering nutrition_target decision so the next adaptive check-in can weigh the
// subjective signal against the change it followed. No scores, never a nag.
import { db } from "../db.js";
import { emitBrainEvent } from "../brainEvents.js";
import { listBrainDecisions } from "./brain-decisions.js";
import { invalidateDayRead } from "./day-read.js";
import { daysBetweenISO, localDateISO, localDayOfStamp } from "./shared.js";
import { bumpTrainingDataVersion } from "./training-cache.js";

// A target change follows through for a week: long enough to feel the difference,
// short enough that the offer disappears before it becomes background noise.
const FOLLOW_THROUGH_WINDOW_DAYS = 7;

export interface FuelingFeedbackInput {
  energy?: number | null;
  hunger?: number | null;
  note?: string | null;
}

// The 1-3 scale is clamped at the trust boundary (running low / steady / plenty).
function clampScale13(value: unknown): number | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(3, Math.max(1, Math.round(n)));
}

// The most recent APPLIED nutrition-target decision (newest-first by id), or null.
function latestAppliedTargetDecision(): any | null {
  return listBrainDecisions({ status: "applied", kind: "nutrition_target", limit: 1 })[0] ?? null;
}

// The local calendar day (YYYY-MM-DD) a decision took effect: prefer applied_at,
// fall back to effective_date. Null when neither is a usable date.
function appliedOnDate(decision: any): string | null {
  // `applied_at` is a UTC instant — framed in the active zone, not sliced, or an
  // evening apply opens its follow-through window a day late. `effective_date` is
  // already a local day.
  const raw = decision?.applied_at
    ? (localDayOfStamp(decision.applied_at) ?? "")
    : String(decision?.effective_date ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

// Whether `date` sits inside an applied change's follow-through window [applied, applied+7].
function withinWindow(appliedOn: string | null, date: string): boolean {
  if (!appliedOn) return false;
  const age = daysBetweenISO(date, appliedOn);
  return age != null && age >= 0 && age <= FOLLOW_THROUGH_WINDOW_DAYS;
}

function foodLoggedOn(date: string): boolean {
  return !!db.prepare(`SELECT 1 FROM food_notes WHERE date = ? LIMIT 1`).get(String(date));
}

export function getFuelingFeedback(date: string): any | null {
  return db.prepare(`SELECT * FROM fueling_feedback WHERE date = ?`).get(String(date)) ?? null;
}

// Is a fueling follow-up due for `date`? Due only when ALL hold: the latest applied
// nutrition_target decision took effect within the last 7 days, food was logged that
// day, and no feedback has been given for the day yet (so it disappears once answered).
export function fuelingFollowThroughDue(date: string = localDateISO()): {
  due: boolean;
  decision_id: number | null;
  applied_on: string | null;
  summary: string | null;
} {
  const d = String(date || localDateISO());
  const decision = latestAppliedTargetDecision();
  const appliedOn = decision ? appliedOnDate(decision) : null;
  const info = {
    due: false,
    decision_id: decision?.id ?? null,
    applied_on: appliedOn,
    summary: decision?.summary ?? null,
  };
  if (!decision || !withinWindow(appliedOn, d)) return info;
  if (!foodLoggedOn(d)) return info;
  if (getFuelingFeedback(d)) return info;
  return { ...info, due: true };
}

// Upsert the day's fueling read (one row per day). Values are coerced/clamped at the
// trust boundary. When an applied target change is still in its follow-through window,
// the row is stamped with that decision_id so the next check-in can weigh it.
export function setFuelingFeedback(date: string, fields: FuelingFeedbackInput = {}): any {
  const d = String(date || localDateISO());
  const energy = clampScale13(fields.energy);
  const hunger = clampScale13(fields.hunger);
  const note = fields.note == null ? null : String(fields.note).trim().slice(0, 500) || null;
  const decision = latestAppliedTargetDecision();
  const appliedOn = decision ? appliedOnDate(decision) : null;
  const decisionId = withinWindow(appliedOn, d) ? (decision?.id ?? null) : null;
  db.prepare(
    `INSERT INTO fueling_feedback (date, energy, hunger, note, decision_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       energy = excluded.energy, hunger = excluded.hunger,
       note = excluded.note, decision_id = excluded.decision_id`
  ).run(d, energy, hunger, note, decisionId);
  // Fueling feedback is an input to the shared under-fueling snapshot. Upserts
  // can keep row count/max-id and even SUM(energy+hunger) unchanged (1/3 →
  // 3/1), so the write-version is the collision-proof invalidation signal.
  bumpTrainingDataVersion();
  invalidateDayRead(d);
  if (d !== localDateISO()) invalidateDayRead();
  emitBrainEvent({
    kind: "fueling_feedback",
    domain: "nutrition",
    date: d,
    subject_key: "subjective-fuel",
    material: energy === 1 || hunger === 3,
    reason: "The athlete updated the one-tap fueling follow-through read.",
  });
  return getFuelingFeedback(d);
}

// Recent fueling reads, newest-first, bounded — for the check-in prompt + coach context.
export function listFuelingFeedback(days = 14): any[] {
  const n = Math.max(1, Math.min(90, Math.trunc(Number(days) || 14)));
  return db.prepare(`SELECT * FROM fueling_feedback ORDER BY date DESC, id DESC LIMIT ?`).all(n) as any[];
}
