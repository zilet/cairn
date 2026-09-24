// PRESCRIPTION AUTHORSHIP — when was this plan slot's prescription written, and has
// the athlete trained it since? ONE module answers it; every brain consumer asks here
// and none re-derives it (plan_items.prescribed_at, v111).
//
// WRITE side — the stamp. A slot's prescription identity is its movement, its rep
// range and its target (load or seconds). Every plan write path asks `stampForWrite`
// what to store: an unchanged identity keeps the date it already had (a pre-v111 NULL
// stays NULL, which reads as settled), a changed or brand-new one is authored today.
// Sets are VOLUME, not identity, when the brain steps them (a recovery week, a one-set
// trim or a set catch-up is not a new prescription). But two writers author the set
// count on purpose, and for them it IS identity: a PERSON in the editor (their number
// is theirs), and a RESTRUCTURE (a redraw's set count is a deliberate choice). Both
// re-stamp a slot whose sets they change, which is what keeps the set-count catch-up
// from walking a deliberate cut back on older logs — no second ledger read needed.
// An Undo that restores a snapshot carries the snapshot's own stamp back.
//
// READ side — the answer. `slotAuthorship` turns a stamp plus the lift's latest logged
// exposure into the three facts consumers use:
//   - `fresh`    written within PRESCRIPTION_SETTLE_DAYS: a plateau measured under an
//                older prescription says nothing about it (no rotation, no "flat");
//   - `untested` written AFTER the lift was last logged: nothing has been trained at
//                it, so the plan's own sets/reps/load stand as a hold — no re-ground,
//                catch-up, earned floor, reach, or in-flight anchor off older work;
//   - `since`    the date evidence about THIS prescription starts (the set-count
//                catch-up and re-grounding count only exposures on or after it).
import { db } from "../db.js";
import { isoDate, isoDay } from "../lib/dates.js";
import { daysBetweenISO, localDateISO } from "./shared.js";

/** How long a freshly written prescription runs before a plateau read may judge it. */
export const PRESCRIPTION_SETTLE_DAYS = 14;

// "brain" = an in-place step (a target step, a rep/set tweak, a catch-up);
// "restructure" = a whole-day rewrite from a drafted week; "person" = the athlete's save.
export type PrescriptionWriter = "person" | "restructure" | "brain";

export interface PrescriptionFields {
  exercise_id?: unknown;
  sets?: unknown;
  rep_low?: unknown;
  rep_high?: unknown;
  target_weight?: unknown;
  target_seconds?: unknown;
}

const num = (v: unknown): string => (v == null || v === "" || !Number.isFinite(Number(v)) ? "" : String(Number(v)));

/** The slot's prescription identity for a writer. Sets count unless the brain is stepping them. */
export function prescriptionKey(item: PrescriptionFields, by: PrescriptionWriter = "brain"): string {
  const base = [
    num(item.exercise_id),
    num(item.rep_low),
    num(item.rep_high),
    num(item.target_weight),
    num(item.target_seconds),
  ];
  return (by === "brain" ? base : [...base, num(item.sets)]).join("|");
}

/**
 * The `prescribed_at` to store for a write. `prev` is the slot as it stood (null for a
 * brand-new slot). Unchanged identity keeps prev's stamp; anything else is today.
 * `restore` is a stamp a snapshot carried back (an Undo): it wins outright.
 */
export function stampForWrite(
  prev: (PrescriptionFields & { prescribed_at?: string | null }) | null | undefined,
  next: PrescriptionFields,
  opts: { by: PrescriptionWriter; today?: string; restore?: string | null }
): string | null {
  if (opts.restore !== undefined) return opts.restore;
  const today = opts.today ?? localDateISO();
  if (!prev) return today;
  return prescriptionKey(prev, opts.by) === prescriptionKey(next, opts.by) ? (prev.prescribed_at ?? null) : today;
}

export interface SlotAuthorship {
  prescribed_at: string | null;
  /** Days since it was written, as of `date`; null for an unstamped (settled) slot. */
  age_days: number | null;
  /** Written within PRESCRIPTION_SETTLE_DAYS. */
  fresh: boolean;
  /** Written after the lift's latest logged exposure: nothing has been trained at it yet. */
  untested: boolean;
  /** Evidence about THIS prescription starts here (null = all history counts). */
  since: string | null;
}

// A stored stamp or session date as a real day key, or null.
const stampDay = (value: unknown): string | null => isoDate(isoDay(value));

/**
 * Pure. `lastExposure` is the lift's latest logged session date (null = never logged).
 * A slot with no history at all is not "untested" here — that is the no-history case,
 * which every consumer already handles on its own terms.
 */
export function slotAuthorship(
  prescribedAt: unknown,
  lastExposure: unknown,
  date: string = localDateISO()
): SlotAuthorship {
  const at = stampDay(prescribedAt);
  const last = stampDay(lastExposure);
  const age = at ? daysBetweenISO(String(date).slice(0, 10), at) : null;
  return {
    prescribed_at: at,
    age_days: age,
    fresh: age != null && age >= 0 && age < PRESCRIPTION_SETTLE_DAYS,
    untested: !!at && !!last && last < at,
    since: at,
  };
}

// ---- batched reads (one query each, never per item) --------------------------

/** plan_item id → prescribed_at for every plan slot. */
export function planSlotStamps(): Map<number, string | null> {
  const out = new Map<number, string | null>();
  try {
    const rows = db.prepare(`SELECT id, prescribed_at FROM plan_items`).all() as Array<{
      id: number;
      prescribed_at: string | null;
    }>;
    for (const row of rows) out.set(Number(row.id), stampDay(row.prescribed_at));
  } catch {
    /* pre-v111 schema: every slot reads as settled */
  }
  return out;
}

/**
 * exercise_id → the NEWEST stamp among that movement's plan slots. A lift on two days
 * reads as freshly prescribed if either slot is — the conservative answer for a
 * per-exercise consumer (the program-state plateau read) that has no day to ask about.
 */
export function newestStampByExercise(): Map<number, string> {
  const out = new Map<number, string>();
  try {
    const rows = db
      .prepare(
        `SELECT exercise_id, MAX(prescribed_at) AS at FROM plan_items WHERE exercise_id IS NOT NULL GROUP BY exercise_id`
      )
      .all() as Array<{ exercise_id: number; at: string | null }>;
    for (const row of rows) {
      const at = stampDay(row.at);
      if (at) out.set(Number(row.exercise_id), at);
    }
  } catch {
    /* pre-v111 schema */
  }
  return out;
}

/** One slot's stamp (a single-slot consumer; batch callers use planSlotStamps). */
export function slotStamp(planItemId: number): string | null {
  try {
    const row = db.prepare(`SELECT prescribed_at FROM plan_items WHERE id = ?`).get(Number(planItemId)) as
      | { prescribed_at: string | null }
      | undefined;
    return stampDay(row?.prescribed_at);
  } catch {
    return null;
  }
}

/**
 * Re-stamp one slot after an in-place update (a target step, a rep/set edit): compare
 * the row as it now stands against `prev` and store what stampForWrite says. Returns
 * the stored stamp.
 */
export function restampSlot(
  planItemId: number,
  prev: PrescriptionFields & { prescribed_at?: string | null },
  by: PrescriptionWriter
): string | null {
  const now = db
    .prepare(`SELECT exercise_id, sets, rep_low, rep_high, target_weight, target_seconds FROM plan_items WHERE id = ?`)
    .get(Number(planItemId)) as PrescriptionFields | undefined;
  if (!now) return prev.prescribed_at ?? null;
  const stamp = stampForWrite(prev, now, { by });
  if (stamp !== (prev.prescribed_at ?? null)) {
    db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE id = ?`).run(stamp, Number(planItemId));
  }
  return stamp;
}

/**
 * `day|exercise` (planPrescriptionKey's shape: day number, lowercased name) → stamp,
 * for every strength slot. Carried beside an Undo snapshot so a restored slot gets its
 * own date back instead of reading as freshly written.
 */
export function stampsByPlanKey(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  try {
    const rows = db
      .prepare(
        `SELECT pd.day_number AS day_number, e.name AS exercise, pi.prescribed_at AS prescribed_at
           FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id
           JOIN exercises e ON e.id = pi.exercise_id
          WHERE pi.kind IS NULL OR pi.kind != 'cardio'`
      )
      .all() as Array<{ day_number: number; exercise: string; prescribed_at: string | null }>;
    for (const row of rows) {
      const key = `${Number(row.day_number)}|${String(row.exercise).trim().toLowerCase()}`;
      if (!(key in out)) out[key] = stampDay(row.prescribed_at);
    }
  } catch {
    /* pre-v111 schema */
  }
  return out;
}
