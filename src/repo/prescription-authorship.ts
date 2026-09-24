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
 * The stamp a write made NOW stores. A person's save and a drafted week store the full
 * UTC instant, so an edit made after a session on the same day reads as AFTER it (the
 * morning's sets were done under the old prescription). A brain step stores the day:
 * it is authored FROM the evidence already logged — a step applied at a session's
 * finish is that session's own consequence — so a same-day session counts as its
 * exposure (a bare day reads as the start of that day).
 */
export function stampNow(by: PrescriptionWriter, now: Date = new Date()): string {
  return by === "brain" ? localDateISO(now) : now.toISOString();
}

// A deliberate set REDUCTION is a new prescription whoever writes it (a conductor's
// plan_update cut must not be walked back by the catch-up); a brain's set INCREASE
// (the catch-up itself) is volume, not identity.
function setsReduced(prev: PrescriptionFields, next: PrescriptionFields): boolean {
  const before = Number(prev.sets);
  const after = Number(next.sets);
  return prev.sets != null && next.sets != null && Number.isFinite(before) && Number.isFinite(after) && after < before;
}

/**
 * The `prescribed_at` to store for a write. `prev` is the slot as it stood (null for a
 * brand-new slot). Unchanged identity keeps prev's stamp; anything else is stamped now
 * (stampNow). `restore` is a stamp a snapshot carried back (an Undo): it wins outright.
 */
export function stampForWrite(
  prev: (PrescriptionFields & { prescribed_at?: string | null }) | null | undefined,
  next: PrescriptionFields,
  opts: { by: PrescriptionWriter; today?: string; restore?: string | null }
): string | null {
  if (opts.restore !== undefined) return opts.restore;
  const now = opts.today ?? stampNow(opts.by);
  if (!prev) return now;
  if (setsReduced(prev, next)) return now;
  return prescriptionKey(prev, opts.by) === prescriptionKey(next, opts.by) ? (prev.prescribed_at ?? null) : now;
}

export interface SlotAuthorship {
  /** The stored stamp: a bare day (legacy / brain step) or a full UTC instant. */
  prescribed_at: string | null;
  /** Days since it was written (by its local day), as of `date`; null for an unstamped slot. */
  age_days: number | null;
  /** Written within PRESCRIPTION_SETTLE_DAYS. */
  fresh: boolean;
  /** Written after the lift's latest logged exposure: nothing has been trained at it yet. */
  untested: boolean;
  /** The local day evidence about THIS prescription starts on (null = all history counts). */
  since: string | null;
  /**
   * On `since`'s own day, the UTC instant (SQLite `datetime` shape, comparable with
   * logged_sets.created_at) from which a set counts; null for a bare-day stamp, where
   * the whole day counts. Build SQL with `sinceClause`.
   */
  since_at: string | null;
}

/** A logged exposure: the session's day and, when known, its first set's created_at (UTC). */
export type Exposure = string | { date: unknown; first_at?: unknown } | null | undefined;

// A stored session date as a real day key, or null.
const stampDay = (value: unknown): string | null => isoDate(isoDay(value));

// A timestamp (ISO or SQLite "YYYY-MM-DD HH:MM:SS", read as UTC) → epoch ms, or null.
function instantMs(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) return null;
  const iso = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// The SQLite `datetime('now')` shape of an instant, so it compares with created_at.
const sqliteInstant = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** A stored stamp normalised: a bare real day, a full ISO instant, or null. */
export function normalizeStamp(value: unknown): string | null {
  const day = isoDate(String(value ?? "").trim());
  if (day) return day;
  const ms = instantMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

// The stamp's local day and (for an instant) its SQLite-shaped UTC time.
function stampParts(stamp: unknown): { day: string; at: string | null } | null {
  const normal = normalizeStamp(stamp);
  if (!normal) return null;
  if (!normal.includes("T")) return { day: normal, at: null };
  const ms = Date.parse(normal);
  return { day: localDateISO(new Date(ms)), at: sqliteInstant(ms) };
}

/**
 * Pure. `lastExposure` is the lift's latest logged session — its day, and ideally its
 * first set's created_at. A session on an earlier day predates the stamp and one on a
 * later day follows it; on the stamp's OWN day, an instant stamp is compared with the
 * session's first set (an evening edit after a morning session leaves the slot
 * untested), and a bare-day stamp reads as the start of the day (the session counts).
 * A slot with no history at all is not "untested" here — that is the no-history case,
 * which every consumer already handles on its own terms.
 */
export function slotAuthorship(
  prescribedAt: unknown,
  lastExposure: Exposure,
  date: string = localDateISO()
): SlotAuthorship {
  const stamp = stampParts(prescribedAt);
  const exposure =
    lastExposure == null
      ? null
      : typeof lastExposure === "object"
        ? { day: stampDay(lastExposure.date), first: instantMs(lastExposure.first_at) }
        : { day: stampDay(lastExposure), first: instantMs(lastExposure) };
  const age = stamp ? daysBetweenISO(String(date).slice(0, 10), stamp.day) : null;
  let untested = false;
  if (stamp && exposure?.day) {
    if (exposure.day < stamp.day) untested = true;
    else if (exposure.day === stamp.day && stamp.at && exposure.first != null)
      untested = sqliteInstant(exposure.first) < stamp.at;
  }
  return {
    prescribed_at: normalizeStamp(prescribedAt),
    age_days: age,
    fresh: age != null && age >= 0 && age < PRESCRIPTION_SETTLE_DAYS,
    untested,
    since: stamp?.day ?? null,
    since_at: stamp?.at ?? null,
  };
}

/**
 * The SQL that keeps only sets logged under the current prescription: a later day, or
 * on `since`'s day a set created at/after `since_at` (the whole day for a bare stamp).
 * `session` / `set` are the query's aliases for sessions and logged_sets.
 */
export function sinceClause(
  authorship: Pick<SlotAuthorship, "since" | "since_at">,
  session = "s",
  set = "ls"
): { sql: string; args: string[] } {
  if (!authorship.since) return { sql: "1 = 1", args: [] };
  if (!authorship.since_at) return { sql: `${session}.date >= ?`, args: [authorship.since] };
  return {
    sql: `(${session}.date > ? OR (${session}.date = ? AND ${set}.created_at >= ?))`,
    args: [authorship.since, authorship.since, authorship.since_at],
  };
}

/** The first set's created_at of one session for a set of exercise ids (the exposure instant). */
export function sessionFirstSetAt(sessionId: unknown, exerciseIds: readonly number[]): string | null {
  if (sessionId == null || !exerciseIds.length) return null;
  try {
    const row = db
      .prepare(
        `SELECT MIN(created_at) AS at FROM logged_sets WHERE session_id = ? AND exercise_id IN (${exerciseIds.map(() => "?").join(",")})`
      )
      .get(Number(sessionId), ...exerciseIds) as { at?: string | null } | undefined;
    return row?.at ? String(row.at) : null;
  } catch {
    return null;
  }
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
    for (const row of rows) out.set(Number(row.id), normalizeStamp(row.prescribed_at));
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
      const at = normalizeStamp(row.at);
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
    return normalizeStamp(row?.prescribed_at);
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
      if (!(key in out)) out[key] = normalizeStamp(row.prescribed_at);
    }
  } catch {
    /* pre-v111 schema */
  }
  return out;
}
