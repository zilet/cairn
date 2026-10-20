// ---------- a plan change scoped to a date: "adapted for the race until Nov 1" ----------
// A taper trim the athlete agrees to is not a new program. It is an OPTIMAL PLAN
// ADAPTATION scoped to the race, and the day after the race the plan goes back to the
// lifting it was built for, with nobody having to remember to ask. So a plan change may
// carry `until: "YYYY-MM-DD"` (PlanChange.until, passed through from the proposal's
// changes[] entry). The change lands on the template at once, exactly as any other; this
// module remembers what the slot held BEFORE it — the whole item for a lift set aside,
// with its position and neighbours, so it comes back where it stood — and on the first
// day after `until` the scheduler's daily boundary pass puts it back
// (expirePlanAdaptations, src/domain/brain/autonomy-service.ts, which owns the ledger
// row and its Undo; this module owns the rows and the plan writes).
//
// Who wins in between:
//   - a PERSON's own save of that slot (plan-annotation-release.ts marks the decision
//     `person_superseded` for it): theirs stands, the restore is skipped and says so;
//   - a PERSON's own request through chat (an explicit_user_request proposal) touching
//     the same day and lift: the row is superseded when it lands, and theirs stands;
//   - a RESTRUCTURE that rebuilds the day (a new name, a new day, the day gone, or the
//     slot itself rewritten): the row is superseded — the new plan is the plan, and a
//     lift "coming back" into a day it no longer belongs to is the bug this guards;
//   - a day whose movement set moved since (for a lift set aside, the restore checks the
//     day's set against the one the change left, `day_fingerprint`): the lift stays out
//     and the restore record says why — re-inserting it beside a rewritten day is a guess;
//   - the change's own Undo: the row is cancelled (the Undo already put the slot back);
//   - a change made around pain (a clinical decision, or a reason tied to a training
//     symptom): the return is ASKED, never applied by itself (`asked`);
//   - anything the brain did meanwhile (a progression step on a lighter taper load) does
//     NOT win — the race was the reason for the change, and after it the regular plan
//     returns. That is the point of scoping it.
// A LAYER (`layer: 'trip'`, the Brief's one-day "Easier" on a trip) is the exception to
// "a newer scoped change re-scopes the slot": it lies ON TOP of whatever the slot holds
// — a race adaptation included — and never supersedes it. Its `before` is the slot as it
// stood (the race-adapted prescription), so its restore returns there, and the row
// beneath stays in force until its own end. A row beneath that comes due while a layer
// still covers its slot waits for the layer (its end moves to the layer's), so the two
// unwind newest-first and nothing is written back over a layer.
// Idempotent and durable: a row is resolved in the same savepoint as its plan write, so a
// restart re-runs nothing and a second pass on the same day finds nothing due. The
// restore's own Undo puts the adaptation back in force for one more week.
//
// Athlete-facing words for this path say "adapted for the race until <date>", never
// "removed" or "dropped": the lift is resting for a reason and a date, not gone.
import { db } from "../db.js";
import { addDaysISO } from "../lib/dates.js";
import { isPersonSuperseded, personSupersededMarker, planChangeKey } from "./plan-annotation-release.js";
import { getEnduranceGoal } from "./profile.js";
import { localDateISO } from "./shared.js";

export type PlanAdaptationKind = "updated" | "removed" | "added" | "swapped";
// `kept`: an `asked` return that settled to the safe default — the adaptation stays as it
// is (the athlete said keep, the ask was set aside, or it went unanswered past its window;
// plan-adaptation-asks.ts). Terminal, with the reason in `resolution_note`.
export type PlanAdaptationStatus = "active" | "restored" | "skipped" | "cancelled" | "superseded" | "asked" | "kept";

/** One plan item row as the adaptation stores it (no hydration, no derived fields). */
export interface AdaptationItemRow {
  id: number;
  plan_day_id: number;
  position: number;
  exercise_id: number | null;
  exercise: string;
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  target_weight: number | null;
  note: string | null;
  warmup_sets: number | null;
  target_seconds: number | null;
  kind: string | null;
  superset_group: number | null;
  prescribed_at: string | null;
  // Only on a `before` snapshot of a lift set aside: who stood either side of it.
  prev_exercise_id?: number | null;
  next_exercise_id?: number | null;
}

export interface PlanAdaptationRow {
  id: number;
  proposal_id: number | null;
  decision_id: number | null;
  day_number: number;
  plan_day_id: number | null;
  day_name: string | null;
  day_fingerprint: string | null;
  exercise: string;
  exercise_id: number | null;
  kind: PlanAdaptationKind;
  until_date: string;
  reason: string | null;
  before: AdaptationItemRow | null;
  after: AdaptationItemRow | null;
  status: PlanAdaptationStatus;
  resolved_at: string | null;
  resolution_note: string | null;
  restore_decision_id: number | null;
  /** NULL for an ordinary scoped change; 'trip' for a one-day overlay on the slot. */
  layer: PlanAdaptationLayer | null;
  created_at: string | null;
}

/** The overlays a change may declare (`changes[].layer`); anything else is no layer. */
export type PlanAdaptationLayer = "trip";

export function planAdaptationLayer(value: unknown): PlanAdaptationLayer | null {
  return value === "trip" ? "trip" : null;
}

/** Whether a row is the race's adaptation: never a layer, and ending within the race's week. */
export function adaptationRowIsForRace(row: Pick<PlanAdaptationRow, "layer" | "until_date">): boolean {
  return !row.layer && adaptationIsForRace(row.until_date, row.until_date);
}

/** What a UI shows for one live adaptation. */
export interface ActivePlanAdaptation {
  day_number: number;
  exercise: string;
  kind: PlanAdaptationKind;
  until: string;
  reason: string | null;
  decision_id: number | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function hydrate(row: any): PlanAdaptationRow {
  return {
    id: Number(row.id),
    proposal_id: row.proposal_id == null ? null : Number(row.proposal_id),
    decision_id: row.decision_id == null ? null : Number(row.decision_id),
    day_number: Number(row.day_number),
    plan_day_id: row.plan_day_id == null ? null : Number(row.plan_day_id),
    day_name: row.day_name == null ? null : String(row.day_name),
    day_fingerprint: row.day_fingerprint == null ? null : String(row.day_fingerprint),
    exercise: String(row.exercise ?? ""),
    exercise_id: row.exercise_id == null ? null : Number(row.exercise_id),
    kind: String(row.kind) as PlanAdaptationKind,
    until_date: String(row.until_date),
    reason: row.reason == null ? null : String(row.reason),
    before: parseJson<AdaptationItemRow>(row.before_json),
    after: parseJson<AdaptationItemRow>(row.after_json),
    status: String(row.status) as PlanAdaptationStatus,
    resolved_at: row.resolved_at == null ? null : String(row.resolved_at),
    resolution_note: row.resolution_note == null ? null : String(row.resolution_note),
    restore_decision_id: row.restore_decision_id == null ? null : Number(row.restore_decision_id),
    layer: planAdaptationLayer(row.layer),
    created_at: row.created_at == null ? null : String(row.created_at),
  };
}

// ---------- the end date a change carries ----------

/**
 * The validated `until` of a change: null when it carries none. A malformed date or one
 * already behind us THROWS — a scoped change whose scope cannot be honoured must not land
 * as a permanent one, which is exactly the incident this exists for. The proposal apply
 * turns the throw into a skipped part, and so a refused, unsaved whole.
 */
export function adaptationUntil(value: unknown, today = localDateISO()): string | null {
  if (value == null || value === "") return null;
  const day = String(value).trim().slice(0, 10);
  if (!ISO_DAY.test(day) || addDaysISO(day, 0) !== day) {
    throw new Error(`"${String(value)}" is not a date this change can be scoped to (YYYY-MM-DD)`);
  }
  if (day < today) throw new Error(`this change was scoped to end on ${day}, which has already passed`);
  return day;
}

// ---------- the slot as it stood ----------

const ITEM_ROW_SQL = `SELECT pi.id, pi.plan_day_id, pi.position, pi.exercise_id, e.name AS exercise, pi.sets,
       pi.rep_low, pi.rep_high, pi.target_weight, pi.note, pi.warmup_sets, pi.target_seconds,
       pi.kind, pi.superset_group, pi.prescribed_at
  FROM plan_items pi
  JOIN plan_days pd ON pd.id = pi.plan_day_id
  LEFT JOIN exercises e ON e.id = pi.exercise_id
 WHERE pd.day_number = ? AND (pi.kind IS NULL OR pi.kind != 'cardio')`;

function itemRow(row: any): AdaptationItemRow {
  const n = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    id: Number(row.id),
    plan_day_id: Number(row.plan_day_id),
    position: Number(row.position),
    exercise_id: n(row.exercise_id),
    exercise: String(row.exercise ?? ""),
    sets: n(row.sets),
    rep_low: n(row.rep_low),
    rep_high: n(row.rep_high),
    target_weight: n(row.target_weight),
    note: row.note == null ? null : String(row.note),
    warmup_sets: n(row.warmup_sets),
    target_seconds: n(row.target_seconds),
    kind: row.kind == null ? null : String(row.kind),
    superset_group: n(row.superset_group),
    prescribed_at: row.prescribed_at == null ? null : String(row.prescribed_at),
  };
}

/** Every strength slot on a plan day, in order — read BEFORE a scoped change writes. */
export function planDayRowsForAdaptation(dayNumber: number): AdaptationItemRow[] {
  return (db.prepare(`${ITEM_ROW_SQL} ORDER BY pi.position, pi.id`).all(Number(dayNumber)) as any[]).map(itemRow);
}

/** The plan day as a restore must find it again: its row id, its name, its movement set. */
interface PlanDayState {
  id: number;
  name: string;
  fingerprint: string;
}

function dayState(dayNumber: number): PlanDayState | null {
  const day = db.prepare(`SELECT id, name FROM plan_days WHERE day_number = ?`).get(Number(dayNumber)) as any;
  if (!day) return null;
  const ids = (
    db
      .prepare(`SELECT exercise_id FROM plan_items WHERE plan_day_id = ? AND (kind IS NULL OR kind != 'cardio')`)
      .all(Number(day.id)) as any[]
  )
    .map((row) => (row.exercise_id == null ? "-" : String(Number(row.exercise_id))))
    .sort();
  return { id: Number(day.id), name: String(day.name ?? ""), fingerprint: ids.join(",") };
}

/** Whether the day at the row's day_number is still the day the change landed on. */
function sameDay(row: PlanAdaptationRow, state: PlanDayState | null): boolean {
  if (!state) return false;
  if (row.plan_day_id != null && row.plan_day_id !== state.id) return false;
  return row.day_name == null || sameName(row.day_name, state.name);
}

function sameName(a: unknown, b: unknown): boolean {
  return (
    String(a ?? "")
      .trim()
      .toLowerCase() ===
    String(b ?? "")
      .trim()
      .toLowerCase()
  );
}

function rowNamed(rows: AdaptationItemRow[], name: unknown): AdaptationItemRow | null {
  return rows.find((row) => sameName(row.exercise, name)) ?? null;
}

function liveRow(dayNumber: number, exerciseId: number | null, name: string): AdaptationItemRow | null {
  const rows = planDayRowsForAdaptation(dayNumber);
  return (exerciseId != null ? rows.find((row) => row.exercise_id === exerciseId) : null) ?? rowNamed(rows, name);
}

// The ordinary (non-layer) row a re-scope inherits from: a layer is never re-scoped.
function activeRowFor(dayNumber: number, exercise: string): PlanAdaptationRow | null {
  const row = db
    .prepare(
      `SELECT * FROM plan_adaptations
        WHERE status = 'active' AND layer IS NULL AND day_number = ? AND LOWER(TRIM(exercise)) = LOWER(TRIM(?))
        ORDER BY id DESC LIMIT 1`
    )
    .get(Number(dayNumber), exercise) as any;
  return row ? hydrate(row) : null;
}

function activeRowsOnDay(dayNumber: number): PlanAdaptationRow[] {
  return (
    db
      .prepare(`SELECT * FROM plan_adaptations WHERE status = 'active' AND day_number = ? ORDER BY id`)
      .all(Number(dayNumber)) as any[]
  ).map(hydrate);
}

function resolve(id: number, status: PlanAdaptationStatus, note: string | null, restoreDecisionId?: number | null) {
  db.prepare(
    `UPDATE plan_adaptations
        SET status = ?, resolution_note = ?, resolved_at = datetime('now'),
            restore_decision_id = COALESCE(?, restore_decision_id)
      WHERE id = ?`
  ).run(status, note, restoreDecisionId ?? null, id);
}

/**
 * Remember one scoped change, right after applyPlanChange wrote it (inside the same
 * proposal savepoint, so a rolled-back proposal leaves no row). `dayBefore` is the day as
 * planDayRowsForAdaptation read it before the write. A slot already adapted keeps its
 * ORIGINAL `before`: re-scoping a taper trim must still come back to the regular plan,
 * never to the first trim. A `layer` is the exception: it lies over the slot as it
 * stands and leaves the row beneath in force (see the header).
 */
export function recordPlanAdaptation(input: {
  proposal_id: number | null;
  day_number: number;
  until: string;
  reason?: string | null;
  result: { action: string; exercise: string; from?: string | null };
  dayBefore: AdaptationItemRow[];
  layer?: PlanAdaptationLayer | null;
}): number | null {
  const kind = (["updated", "removed", "added", "swapped"] as const).find((k) => k === input.result.action);
  if (!kind) return null;
  const dayNumber = Number(input.day_number);
  const name = String(input.result.exercise ?? "").trim();
  if (!name) return null;
  const priorName = kind === "swapped" ? String(input.result.from ?? "") : name;
  let before: AdaptationItemRow | null = kind === "added" ? null : rowNamed(input.dayBefore, priorName);
  if (before && kind === "removed") {
    const index = input.dayBefore.indexOf(before);
    before = {
      ...before,
      prev_exercise_id: index > 0 ? input.dayBefore[index - 1].exercise_id : null,
      next_exercise_id: index + 1 < input.dayBefore.length ? input.dayBefore[index + 1].exercise_id : null,
    };
  }
  const after = kind === "removed" ? null : rowNamed(planDayRowsForAdaptation(dayNumber), name);
  // An earlier adaptation of the same slot hands its original state forward: what comes
  // back after the race is the regular plan, never the first trim. A layer inherits
  // nothing and supersedes nothing: its `before` is the slot as it stands now.
  const layer = planAdaptationLayer(input.layer);
  const earlier = layer ? null : activeRowFor(dayNumber, priorName);
  let effectiveKind: PlanAdaptationKind = kind;
  if (earlier) {
    resolve(earlier.id, "superseded", "re-scoped by a newer adaptation of the same lift");
    // Added for the race and set aside again before it: nothing is left to undo.
    if (earlier.kind === "added" && kind === "removed") return null;
    if (earlier.kind === "added" || !earlier.before) {
      // It was never on the regular plan: it still leaves with the race.
      effectiveKind = "added";
      before = null;
    } else if (kind === "removed") {
      // Neighbours as the day stood now, the prescription as the regular plan had it.
      before = {
        ...earlier.before,
        prev_exercise_id: before?.prev_exercise_id ?? null,
        next_exercise_id: before?.next_exercise_id ?? null,
      };
    } else {
      before = earlier.before;
      effectiveKind = after && before.exercise_id !== after.exercise_id ? "swapped" : "updated";
    }
  }
  // The day as this change left it — its row, its name and its movement set — so the
  // restore can tell the same day from a rebuilt one (refreshed for the whole proposal
  // once every part of it has landed: refreshPlanAdaptationDays).
  const state = dayState(dayNumber);
  const info = db
    .prepare(
      `INSERT INTO plan_adaptations
         (proposal_id, day_number, plan_day_id, day_name, day_fingerprint, exercise, exercise_id, kind, until_date,
          reason, before_json, after_json, layer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.proposal_id ?? null,
      dayNumber,
      state?.id ?? null,
      state?.name ?? null,
      state?.fingerprint ?? null,
      name,
      after?.exercise_id ?? before?.exercise_id ?? null,
      effectiveKind,
      input.until,
      input.reason ? String(input.reason).slice(0, 500) : null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      layer
    );
  return Number(info.lastInsertRowid);
}

/** Point a proposal's scoped changes at the ledger row that records them. */
export function linkPlanAdaptationsToDecision(proposalId: number, decisionId: number): void {
  if (!(Number(proposalId) > 0) || !(Number(decisionId) > 0)) return;
  db.prepare(`UPDATE plan_adaptations SET decision_id = ? WHERE proposal_id = ? AND decision_id IS NULL`).run(
    Number(decisionId),
    Number(proposalId)
  );
}

/** The change itself was undone: its adaptations have nothing left to restore. */
export function cancelPlanAdaptationsForProposal(proposalId: number, note = "the change was undone"): number {
  if (!(Number(proposalId) > 0)) return 0;
  return Number(
    db
      .prepare(
        `UPDATE plan_adaptations SET status = 'cancelled', resolution_note = ?, resolved_at = datetime('now')
          WHERE proposal_id = ? AND status = 'active'`
      )
      .run(note, Number(proposalId)).changes
  );
}

// ---------- the plan moving under an adaptation ----------

/**
 * Re-read the day each live adaptation on `dayNumbers` sits on, after a write this
 * module accepts as part of the adaptation's own story: the proposal that carried it
 * (all of its parts, scoped or not), a later coaching change on the same day, the
 * restore pass, or the restore's Undo. Only a row still on the SAME day (row id and
 * name) is refreshed — a rebuilt day is never quietly re-keyed into looking like the
 * one the change landed on. `rekey` (the restore's Undo, which itself put the day back)
 * also refreshes the day's id and name.
 */
export function refreshPlanAdaptationDays(dayNumbers: Iterable<number>, opts: { rekey?: boolean } = {}): void {
  const update = db.prepare(
    `UPDATE plan_adaptations SET plan_day_id = ?, day_name = ?, day_fingerprint = ? WHERE id = ?`
  );
  for (const dayNumber of new Set([...dayNumbers].map(Number).filter(Number.isFinite))) {
    const rows = activeRowsOnDay(dayNumber);
    if (!rows.length) continue;
    const state = dayState(dayNumber);
    if (!state) continue;
    for (const row of rows) {
      if (!opts.rekey && !sameDay(row, state)) continue;
      update.run(state.id, state.name, state.fingerprint, row.id);
    }
  }
}

// A write this module (or the Undo of one of its rows) makes itself must not read as
// a restructure of the day: the plan-write hooks stand down inside this scope.
let ownedWrites = 0;

export function withPlanAdaptationWritesOwned<T>(write: () => T): T {
  ownedWrites += 1;
  try {
    return write();
  } finally {
    ownedWrites -= 1;
  }
}

const PRESCRIPTION_FIELDS = ["sets", "rep_low", "rep_high", "target_weight", "target_seconds"] as const;

function slotIn(rows: AdaptationItemRow[], exerciseId: number | null, name: string): AdaptationItemRow | null {
  return (exerciseId != null ? rows.find((row) => row.exercise_id === exerciseId) : null) ?? rowNamed(rows, name);
}

export interface PlanDayRewriteGuard {
  /** Call after the write, with who wrote it (savePlanDay's `by`). */
  settle(by?: string | null): void;
}

/**
 * THE HOOK savePlanDay takes around a whole-day rewrite (replacePlan reaches it per day).
 * Null — and no further work — when nothing on the day is adapted. After the write:
 *   - the day renamed (a rebuilt day: "Lower" is now "Upper"): every live adaptation on
 *     it is superseded, whoever wrote it — there is nothing of the old day to return to;
 *   - a RESTRUCTURE (`by: "restructure"`, the drafted-week apply) that changed what the
 *     row stands on — the movement set under a lift set aside, the adapted slot's own
 *     prescription, or the slot gone — supersedes that row: the new plan is the plan.
 * Any other writer leaves the row in force; the restore's own checks judge it then (a
 * person's save is theirs through the person_superseded marker, a lift set aside stays
 * out when the day's set moved). An adaptation-owned write never reaches here.
 */
export function planDayRewriteGuard(dayNumber: number): PlanDayRewriteGuard | null {
  if (ownedWrites > 0) return null;
  let rows: PlanAdaptationRow[];
  try {
    rows = activeRowsOnDay(dayNumber);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const before = dayState(dayNumber);
  const beforeItems = planDayRowsForAdaptation(dayNumber);
  return {
    settle(by) {
      const after = dayState(dayNumber);
      const afterItems = planDayRowsForAdaptation(dayNumber);
      for (const row of rows) {
        const renamed = !after || (before != null && after.id !== before.id) || !sameName(after.name, row.day_name ?? before?.name);
        if (renamed) {
          resolve(
            row.id,
            "superseded",
            after
              ? `plan day ${dayNumber} was rebuilt as ${after.name} since, so ${row.exercise} stays as the new day has it`
              : `plan day ${dayNumber} was taken off the plan since`
          );
          continue;
        }
        if (by !== "restructure") continue;
        if (row.kind === "removed") {
          if (before?.fingerprint !== after.fingerprint) {
            resolve(row.id, "superseded", `the day was rewritten since, so ${row.exercise} stays as the new plan has it`);
          }
          continue;
        }
        const name = row.after?.exercise ?? row.exercise;
        const was = slotIn(beforeItems, row.after?.exercise_id ?? null, name);
        const now = slotIn(afterItems, row.after?.exercise_id ?? null, name);
        const rewritten = !was || !now || PRESCRIPTION_FIELDS.some((field) => (was as any)[field] !== (now as any)[field]);
        if (rewritten) {
          resolve(row.id, "superseded", `the day was rewritten since, so ${name} stays as the new plan has it`);
        }
      }
    },
  };
}

/** deletePlanDay's hook: a day taken off the plan has nothing left to return to. */
export function supersedePlanAdaptationsForDeletedDay(dayNumber: number): number {
  if (ownedWrites > 0) return 0;
  try {
    return Number(
      db
        .prepare(
          `UPDATE plan_adaptations SET status = 'superseded', resolution_note = ?, resolved_at = datetime('now')
            WHERE status = 'active' AND day_number = ?`
        )
        .run(`plan day ${Number(dayNumber)} was taken off the plan since`, Number(dayNumber)).changes
    );
  } catch {
    return 0;
  }
}

/**
 * A person's own request (an explicit_user_request proposal: their words in chat, their
 * apply) landed on a slot an earlier adaptation holds: that slot is theirs now, so its
 * after-the-race restore is superseded. Matched by day and lift — the change's exercise,
 * either side of a swap — against what the adaptation set aside, wrote or brought in.
 * A change that itself carries `until` re-scopes the slot instead (recordPlanAdaptation).
 */
export function supersedePlanAdaptationsForRequest(proposalId: number, changes: unknown[]): number {
  let count = 0;
  for (const change of Array.isArray(changes) ? changes : []) {
    const c = change as any;
    if (!c || c.until || String(c.kind ?? "").toLowerCase() === "cardio") continue;
    const dayNumber = Number(c.day_number);
    if (!Number.isFinite(dayNumber)) continue;
    const names = [c.exercise, c.swap?.from, c.swap?.to].filter((n) => typeof n === "string" && n.trim());
    if (!names.length) continue;
    for (const row of activeRowsOnDay(dayNumber)) {
      if (row.proposal_id === Number(proposalId)) continue;
      const held = [row.exercise, row.before?.exercise, row.after?.exercise];
      if (!names.some((name) => held.some((h) => sameName(h, name)))) continue;
      resolve(row.id, "superseded", `${row.exercise} was changed at your request since, so it stays as you asked`);
      count += 1;
    }
  }
  return count;
}

/** Whether a proposal's apply recorded adaptations (its Undo then owns their rows). */
export function proposalHasPlanAdaptations(proposalId: number): boolean {
  if (!(Number(proposalId) > 0)) return false;
  return db.prepare(`SELECT 1 FROM plan_adaptations WHERE proposal_id = ? LIMIT 1`).get(Number(proposalId)) != null;
}

/**
 * The after-the-race restore was undone: the athlete wants the adaptation longer. Its
 * rows go back in force with a fresh end `until` (the caller passes a week from today),
 * re-keyed to the day as the Undo left it. Returns the rows put back.
 */
export function reactivatePlanAdaptationsForUndoneRestore(restoreDecisionId: number, until: string): PlanAdaptationRow[] {
  if (!(Number(restoreDecisionId) > 0)) return [];
  const rows = (
    db
      .prepare(`SELECT * FROM plan_adaptations WHERE restore_decision_id = ? AND status = 'restored' ORDER BY id`)
      .all(Number(restoreDecisionId)) as any[]
  ).map(hydrate);
  if (!rows.length) return [];
  const update = db.prepare(
    `UPDATE plan_adaptations
        SET status = 'active', until_date = ?, resolved_at = NULL,
            resolution_note = ?
      WHERE id = ?`
  );
  for (const row of rows) update.run(until, `kept one more week, until ${until}: the return to the regular plan was undone`, row.id);
  refreshPlanAdaptationDays(
    rows.map((row) => row.day_number),
    { rekey: true }
  );
  return rows.map((row) => ({ ...row, status: "active" as const, until_date: until }));
}

/** The return of these rows waits for the athlete's yes on decision `decisionId`. */
export function markPlanAdaptationsAsked(ids: number[], decisionId: number, note: string): void {
  for (const id of ids) resolve(id, "asked", note, decisionId);
}

/** Every row whose return is still waiting on the athlete (`asked`), oldest first. */
export function askedPlanAdaptations(): PlanAdaptationRow[] {
  return rowsWithStatus("asked");
}

/**
 * Settle `asked` rows for good: `restored` (the athlete's yes landed the return) or
 * `kept` (the safe default — the adaptation stays). Only rows still `asked` move, so a
 * second pass is a no-op. Returns how many moved.
 */
export function settleAskedPlanAdaptations(ids: number[], status: "restored" | "kept", note: string): number {
  const update = db.prepare(
    `UPDATE plan_adaptations SET status = ?, resolution_note = ?, resolved_at = datetime('now')
      WHERE id = ? AND status = 'asked'`
  );
  let moved = 0;
  for (const id of ids) moved += Number(update.run(status, note, id).changes) || 0;
  return moved;
}

// ---------- the ledger row behind an adaptation ----------

interface DecisionRef {
  id: number;
  status: string;
  risk_class: string | null;
  autonomy_tier: string | null;
  context: Record<string, unknown> | null;
  action: Record<string, unknown> | null;
}

const DECISION_COLUMNS = `id, status, risk_class, autonomy_tier, context_json, action_json`;

// A read never writes (the request memo serves only while nothing was written); only the
// restore pass, which writes anyway, stores the link it found.
function decisionOf(row: PlanAdaptationRow, persist = false): DecisionRef | null {
  const pick = (r: any): DecisionRef | null =>
    r
      ? {
          id: Number(r.id),
          status: String(r.status),
          risk_class: r.risk_class == null ? null : String(r.risk_class),
          autonomy_tier: r.autonomy_tier == null ? null : String(r.autonomy_tier),
          context: parseJson(r.context_json),
          action: parseJson(r.action_json),
        }
      : null;
  if (row.decision_id != null) {
    return pick(db.prepare(`SELECT ${DECISION_COLUMNS} FROM brain_decisions WHERE id = ?`).get(row.decision_id));
  }
  if (row.proposal_id == null) return null;
  const found = pick(
    db
      .prepare(
        `SELECT ${DECISION_COLUMNS} FROM brain_decisions
          WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ? AND status IN ('applied', 'reverted')
          ORDER BY id DESC LIMIT 1`
      )
      .get(String(row.proposal_id))
  );
  if (found && persist) db.prepare(`UPDATE plan_adaptations SET decision_id = ? WHERE id = ?`).run(found.id, row.id);
  return found;
}

// A change made around pain is not the system's to undo on a date. The original
// decision says so in any of its own words: a clinical risk class or the clinician tier,
// a clinical mark on its context, a review hold on the same proposal that was held at the
// clinical ceiling, the proposal's server-stamped clinical provenance, or a reason whose
// provenance points at a training symptom / pain report. (An `ask` tier alone is NOT one:
// every change a person applied by hand is recorded at `ask`.)
const PAIN_PROVENANCE = /symptom|pain|injur/i;
const PAIN_WORDS = /\b(pain|painful|hurts?|hurting|injur(?:y|ed|ies))\b/i;

function provenanceTiedToPain(entry: any): boolean {
  const p = entry?.reason_provenance;
  if (!p || typeof p !== "object") return false;
  return PAIN_PROVENANCE.test(String(p.source_ref_type ?? "")) || PAIN_PROVENANCE.test(String(p.reason_code ?? ""));
}

function clinicalMarks(decision: { risk_class?: unknown; autonomy_tier?: unknown; context?: any } | null): boolean {
  if (!decision) return false;
  if (decision.risk_class === "clinical" || decision.autonomy_tier === "clinician") return true;
  const context = decision.context ?? {};
  return context.clinical === true || context.review_reason_code === "clinical_ceiling";
}

export function adaptationRestoreNeedsAsk(row: PlanAdaptationRow, decision: DecisionRef | null = decisionOf(row)): boolean {
  if (clinicalMarks(decision)) return true;
  const action = (decision?.action ?? {}) as any;
  const entries = [
    ...(Array.isArray(action.reason_provenance) ? action.reason_provenance : []),
    ...(Array.isArray(action.changes) ? action.changes : []),
  ];
  if (entries.some(provenanceTiedToPain)) return true;
  if (PAIN_WORDS.test(String(row.reason ?? ""))) return true;
  if (row.proposal_id == null) return false;
  try {
    const holds = db
      .prepare(
        `SELECT risk_class, autonomy_tier, context_json FROM brain_decisions
          WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ?`
      )
      .all(String(row.proposal_id)) as any[];
    if (holds.some((hold) => clinicalMarks({ ...hold, context: parseJson(hold.context_json) }))) return true;
    const proposal = db.prepare(`SELECT parsed_json FROM plan_proposals WHERE id = ?`).get(row.proposal_id) as any;
    const parsed = parseJson<any>(proposal?.parsed_json);
    if (parsed?.clinical_provenance && typeof parsed.clinical_provenance === "object") return true;
    const change = (Array.isArray(parsed?.changes) ? parsed.changes : []).find(
      (c: any) => Number(c?.day_number) === row.day_number && [c?.exercise, c?.swap?.to, c?.swap?.from].some((n) => sameName(n, row.exercise))
    );
    if (change && (provenanceTiedToPain(change) || PAIN_WORDS.test(String(change.reason ?? "")))) return true;
  } catch {
    // An unreadable ledger is not evidence of pain; the restore keeps its plain path.
  }
  return false;
}

// ---------- reads ----------

function rowsWithStatus(status: PlanAdaptationStatus): PlanAdaptationRow[] {
  return (db.prepare(`SELECT * FROM plan_adaptations WHERE status = ? ORDER BY id`).all(status) as any[]).map(hydrate);
}

/**
 * The adaptations in force on `date`: active, not yet past their end date, and backed by
 * a change that still stands (an Undo of it cancels them). For any surface that wants to
 * say "adapted for the race until Nov 1" beside a lift.
 */
export function activePlanAdaptations(date: string = localDateISO()): ActivePlanAdaptation[] {
  const out: ActivePlanAdaptation[] = [];
  for (const row of rowsWithStatus("active")) {
    if (row.until_date < date) continue;
    const decision = decisionOf(row);
    if (decision?.status === "reverted") continue;
    out.push({
      day_number: row.day_number,
      exercise: row.exercise,
      kind: row.kind,
      until: row.until_date,
      reason: row.reason,
      decision_id: decision?.id ?? row.decision_id,
    });
  }
  return out;
}

/**
 * THE HOOK the plan day-detail payload carries as `adaptations` (one property; the
 * builder stays the builder's): the live adaptations on that plan day.
 */
export function planDayAdaptations(dayNumber: number | null | undefined, date: string = localDateISO()): ActivePlanAdaptation[] {
  if (dayNumber == null || !Number.isFinite(Number(dayNumber))) return [];
  try {
    return activePlanAdaptations(date).filter((a) => a.day_number === Number(dayNumber));
  } catch {
    return [];
  }
}

// ---------- the restore ----------

export interface PlanAdaptationRestoreOutcome {
  restored: PlanAdaptationRow[];
  skipped: Array<PlanAdaptationRow & { note: string }>;
  cancelled: PlanAdaptationRow[];
  /** Due, but made around pain: the caller asks before anything is written (still `active`). */
  asked: PlanAdaptationRow[];
}

const RESTORE_FIELDS = [
  "sets",
  "rep_low",
  "rep_high",
  "target_weight",
  "note",
  "warmup_sets",
  "target_seconds",
  "superset_group",
  "prescribed_at",
] as const;

function writeBackInPlace(targetId: number, before: AdaptationItemRow): void {
  db.prepare(
    `UPDATE plan_items SET exercise_id = ?, ${RESTORE_FIELDS.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`
  ).run(before.exercise_id, ...RESTORE_FIELDS.map((f) => (before as any)[f] ?? null), targetId);
}

// A lift set aside comes back where it stood: after the neighbour that preceded it, else
// before the one that followed it, else at its old index. Slots after it shift down one.
function reinsert(planDayId: number, dayNumber: number, before: AdaptationItemRow): void {
  const rows = planDayRowsForAdaptation(dayNumber);
  const prev = before.prev_exercise_id != null ? rows.find((r) => r.exercise_id === before.prev_exercise_id) : null;
  const next = before.next_exercise_id != null ? rows.find((r) => r.exercise_id === before.next_exercise_id) : null;
  const end = rows.length ? Math.max(...rows.map((r) => r.position)) + 1 : 0;
  const at = prev ? prev.position + 1 : next ? next.position : Math.min(Math.max(0, before.position), end);
  db.prepare(`UPDATE plan_items SET position = position + 1 WHERE plan_day_id = ? AND position >= ?`).run(planDayId, at);
  db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, exercise_id, kind, ${RESTORE_FIELDS.join(", ")})
     VALUES (?, ?, ?, 'strength', ${RESTORE_FIELDS.map(() => "?").join(", ")})`
  ).run(planDayId, at, before.exercise_id, ...RESTORE_FIELDS.map((f) => (before as any)[f] ?? null));
}

function exerciseStillExists(id: number | null): boolean {
  return id != null && db.prepare(`SELECT 1 FROM exercises WHERE id = ?`).get(id) != null;
}

/**
 * Put back every adaptation whose end date is behind `today` — the plan writes and the
 * row resolutions only. The caller wraps this in a savepoint and records the ledger row
 * (expirePlanAdaptations); `restoreDecisionId` is stamped by it afterwards. Rows are
 * walked per day in their original order, so several lifts set aside together come back
 * in the order they stood.
 */
export function restoreDuePlanAdaptations(today: string = localDateISO()): PlanAdaptationRestoreOutcome {
  const outcome: PlanAdaptationRestoreOutcome = { restored: [], skipped: [], cancelled: [], asked: [] };
  const active = rowsWithStatus("active");
  // Per day, layers first (newest on top unwinds first), then the order the slots stood.
  const due = active
    .filter((row) => row.until_date < today)
    .sort(
      (a, b) =>
        a.day_number - b.day_number ||
        (b.layer ? 1 : 0) - (a.layer ? 1 : 0) ||
        (a.before?.position ?? 0) - (b.before?.position ?? 0) ||
        a.id - b.id
    );
  // A layer still in force over a slot this row holds: the row waits for it.
  const coveringLayer = (row: PlanAdaptationRow): PlanAdaptationRow | null => {
    if (row.layer || row.kind === "removed") return null;
    const slot = row.after ?? null;
    return (
      active.find(
        (other) =>
          other.layer &&
          other.id !== row.id &&
          other.until_date >= today &&
          other.day_number === row.day_number &&
          other.before != null &&
          (slot?.exercise_id != null
            ? other.before.exercise_id === slot.exercise_id
            : sameName(other.before.exercise, slot?.exercise ?? row.exercise))
      ) ?? null
    );
  };
  const postpone = db.prepare(`UPDATE plan_adaptations SET until_date = ?, resolution_note = ? WHERE id = ?`);
  const skip = (row: PlanAdaptationRow, note: string) => {
    resolve(row.id, "skipped", note);
    outcome.skipped.push({ ...row, note });
  };
  // Each day as it stood when the pass began: a lift set aside comes back only into the
  // day the change left (several set aside together each compare against the same day).
  const startState = new Map<number, PlanDayState | null>();
  for (const row of due) if (!startState.has(row.day_number)) startState.set(row.day_number, dayState(row.day_number));
  for (const row of due) {
    const decision = decisionOf(row, true);
    if (decision?.status === "reverted") {
      resolve(row.id, "cancelled", "the change was undone before the race");
      outcome.cancelled.push(row);
      continue;
    }
    const state = startState.get(row.day_number) ?? null;
    if (!state) {
      skip(row, `plan day ${row.day_number} no longer exists`);
      continue;
    }
    // The day the change landed on — by row and by name. A day rebuilt since (a
    // restructure that wrote "Upper" where "Lower" stood) is not that day.
    if (!sameDay(row, state)) {
      skip(row, `plan day ${row.day_number} was rebuilt as ${state.name} since, so ${row.exercise} stays as the new day has it`);
      continue;
    }
    // A person's own save of this slot since the change is theirs, and it stands.
    const key = planChangeKey(row.day_number, row.exercise);
    const priorKey = row.before ? planChangeKey(row.day_number, row.before.exercise) : null;
    const marker = personSupersededMarker(decision?.context ?? null);
    if (isPersonSuperseded(marker, key) || isPersonSuperseded(marker, priorKey)) {
      skip(row, `${row.exercise} was changed by hand since, so it stays as you have it`);
      continue;
    }
    // A trip version still lies over this slot: writing the regular plan back now would
    // land under it and be overwritten by its own restore. The row ends with the layer.
    const layer = coveringLayer(row);
    if (layer) {
      postpone.run(layer.until_date, `waits for the trip version on top of it, until ${layer.until_date}`, row.id);
      continue;
    }
    // Made around pain: nothing is written; the caller asks for the return instead.
    if (adaptationRestoreNeedsAsk(row, decision)) {
      outcome.asked.push(row);
      continue;
    }
    const current = row.after ? liveRow(row.day_number, row.after.exercise_id, row.after.exercise) : null;
    if (row.kind === "removed") {
      const before = row.before;
      if (!before || !exerciseStillExists(before.exercise_id)) {
        skip(row, `${row.exercise} could not be found to bring back`);
        continue;
      }
      if (liveRow(row.day_number, before.exercise_id, before.exercise)) {
        skip(row, `${row.exercise} is already back on the day`);
        continue;
      }
      // The day's movements moved since the change left it (a lift added, swapped or
      // taken out by hand or by a rewrite): re-inserting into a different day is a guess.
      if (row.day_fingerprint != null && row.day_fingerprint !== state.fingerprint) {
        skip(row, `the day has changed since, so ${row.exercise} stays out until you add it back`);
        continue;
      }
      reinsert(state.id, row.day_number, before);
    } else if (row.kind === "added") {
      // Race-only work: it leaves with the race. Already gone is already done.
      if (current) db.prepare(`DELETE FROM plan_items WHERE id = ?`).run(current.id);
    } else {
      const before = row.before;
      if (!before) {
        skip(row, `there was no earlier prescription for ${row.exercise} to return to`);
        continue;
      }
      if (!current) {
        skip(row, `${row.exercise} is no longer on the day`);
        continue;
      }
      if (
        row.kind === "swapped" &&
        before.exercise_id !== current.exercise_id &&
        liveRow(row.day_number, before.exercise_id, before.exercise)
      ) {
        skip(row, `${before.exercise} is already back on the day`);
        continue;
      }
      if (!exerciseStillExists(before.exercise_id)) {
        skip(row, `${before.exercise} could not be found to bring back`);
        continue;
      }
      writeBackInPlace(current.id, before);
    }
    resolve(row.id, "restored", null);
    outcome.restored.push(row);
  }
  // Anything still in force on a day this pass wrote reads the day as it is now.
  refreshPlanAdaptationDays(outcome.restored.map((row) => row.day_number));
  return outcome;
}

/**
 * The return of `rows` as ordinary plan changes, for a draft the athlete answers (the
 * restore of a change made around pain is asked, never applied by itself). A lift set
 * aside is added back with its old prescription, a rewritten slot gets its old numbers,
 * a swap swaps back, and race-only work leaves.
 */
export function restoreChangesForAsk(rows: PlanAdaptationRow[], reason: string): any[] {
  const prescription = (b: AdaptationItemRow) => ({
    sets: b.sets,
    rep_low: b.rep_low,
    rep_high: b.rep_high,
    target_weight: b.target_weight,
    ...(b.target_seconds != null ? { target_seconds: b.target_seconds } : {}),
  });
  const out: any[] = [];
  for (const row of rows) {
    const before = row.before;
    if (row.kind === "added") {
      out.push({ day_number: row.day_number, exercise: row.exercise, remove: true, reason });
    } else if (before && row.kind === "swapped" && row.after && !sameName(row.after.exercise, before.exercise)) {
      out.push({ day_number: row.day_number, swap: { from: row.after.exercise, to: before.exercise }, ...prescription(before), reason });
    } else if (before) {
      out.push({ day_number: row.day_number, exercise: before.exercise, ...prescription(before), reason });
    }
  }
  return out;
}

export function stampRestoreDecision(ids: number[], decisionId: number): void {
  const stamp = db.prepare(`UPDATE plan_adaptations SET restore_decision_id = ? WHERE id = ?`);
  for (const id of ids) stamp.run(decisionId, id);
}

// ---------- the words ----------

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 1" — the calendar words the athlete reads for an end date. */
export function adaptationDateWords(iso: string): string {
  const t = Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(t)) return String(iso);
  const d = new Date(t);
  return `${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function weekdayWords(iso: string): string {
  const t = Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(t) ? `${WEEKDAY[new Date(t).getUTCDay()]}, ${adaptationDateWords(iso)}` : String(iso);
}

/**
 * Whether a change ending on `until` is scoped to the dated race: the race is on file and
 * falls within the week around that end. Anything else is a plain temporary change.
 */
export function adaptationIsForRace(until: string, asOf: string = localDateISO()): boolean {
  try {
    const goal = getEnduranceGoal(asOf) as any;
    const race = goal?.is_race ? String(goal.date ?? "").slice(0, 10) : "";
    if (!ISO_DAY.test(race)) return false;
    const from = addDaysISO(until, -7) ?? until;
    const to = addDaysISO(until, 7) ?? until;
    return race >= from && race <= to;
  } catch {
    return false;
  }
}

/** "adapted for the race until Nov 1" / "adapted until Nov 1". */
export function adaptedUntilWords(until: string, forRace: boolean): string {
  return `adapted ${forRace ? "for the race " : ""}until ${adaptationDateWords(until)}`;
}

export function listWords(names: string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= 1) return unique[0] ?? "";
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  if (unique.length === 3) return `${unique[0]}, ${unique[1]} and ${unique[2]}`;
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} more`;
}

// A reason written about a set-aside lift ("dropping heavy squat to keep legs fresh")
// is said the way this path speaks: a lift resting for the race, never one taken away.
const GONE_WORDS: Array<[RegExp, string]> = [
  [/\bdropping\b/gi, "resting"],
  [/\bdropped\b/gi, "resting"],
  [/\bdrop\b/gi, "rest"],
  [/\bremoving\b/gi, "setting aside"],
  [/\bremoved\b/gi, "set aside"],
  [/\bremove\b/gi, "set aside"],
];

export function adaptationReasonWords(text: unknown): string {
  let out = String(text ?? "").trim();
  for (const [pattern, word] of GONE_WORDS) {
    out = out.replace(pattern, (match) => (match[0] === match[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word));
  }
  return out;
}

/**
 * The applied decision's summary and rationale when its changes carry an end date. The
 * summary names what was adapted and when the regular plan returns; the rationale keeps
 * the coach's per-lift reasons in this path's words. A proposal that ALSO carries
 * lasting changes (no `until`) says those in the ordinary register beside it — they are
 * not temporary, and the adaptation's words never swallow them.
 */
export function adaptationDecisionWords(input: {
  until: string;
  exercises: string[];
  reasons: string[];
  today?: string;
  lasting?: { exercises: string[]; reasons: string[] } | null;
  /** Every scoped part is a layer (a trip version): never for the race, and it returns to the plan as it stood. */
  layered?: boolean;
}): { summary: string; rationale: string; for_race: boolean; restores_on: string } {
  const layered = input.layered === true;
  const forRace = !layered && adaptationIsForRace(input.until, input.today);
  const restoresOn = addDaysISO(input.until, 1) ?? input.until;
  const what = listWords(input.exercises) || "Your plan";
  const lastingNames = [...new Set((input.lasting?.exercises ?? []).filter(Boolean))].filter(
    (name) => !input.exercises.some((scoped) => sameName(scoped, name))
  );
  const mixed = lastingNames.length > 0;
  const plan = layered ? "the plan as it stood" : "the regular plan";
  const back = mixed
    ? `${input.exercises.length === 1 ? "it returns" : "they return"} to ${plan}`
    : layered
      ? "the plan as it stood returns"
      : "the regular plan returns";
  const adapted = `${what} ${adaptedUntilWords(input.until, forRace)}; ${back} ${weekdayWords(restoresOn)}.`;
  const lastingSentence = mixed
    ? ` ${listWords(lastingNames)} ${lastingNames.length === 1 ? "changes" : "change"} for good.`
    : "";
  const summary = `${adapted}${lastingSentence}`;
  const reasons = [...new Set(input.reasons.map(adaptationReasonWords).filter(Boolean))];
  const lead = mixed
    ? `${forRace ? "An adaptation for the race" : "A temporary adaptation"} of ${what}, in force until ${weekdayWords(input.until)}, after which ${input.exercises.length === 1 ? "it goes" : "they go"} back to ${plan} on its own.`
    : `${forRace ? "An adaptation for the race" : "A temporary adaptation"}, in force until ${weekdayWords(input.until)}, after which every lift goes back to ${plan} on its own.`;
  const lastingReasons = mixed
    ? [...new Set((input.lasting?.reasons ?? []).map((r) => String(r ?? "").trim()).filter(Boolean))]
    : [];
  const lastingLead = mixed ? [`The change to ${listWords(lastingNames)} is a lasting one.`] : [];
  const sentence = (r: string) => (/[.!?]$/.test(r) ? r : `${r}.`);
  return {
    summary: summary.slice(0, 300),
    rationale: [lead, ...reasons.map(sentence), ...lastingLead, ...lastingReasons.map(sentence)].join(" ").slice(0, 1_500),
    for_race: forRace,
    restores_on: restoresOn,
  };
}

/** The Changes feed's title for an adapted change (null when the row is not one). */
export function planAdaptationTitle(action: unknown): string | null {
  const scope = (action as any)?.plan_adaptation;
  const until = String(scope?.until ?? "");
  if (!ISO_DAY.test(until)) return null;
  const names = (Array.isArray((action as any)?.changes) ? (action as any).changes : [])
    .filter((c: any) => c?.until)
    .map((c: any) => String(c?.exercise ?? "").trim())
    .filter(Boolean);
  const what = listWords(names);
  const words = adaptedUntilWords(until, scope?.for_race === true);
  return what ? `${what} ${words}` : words[0].toUpperCase() + words.slice(1);
}

/** The restore decision's summary: back to the regular plan, by name. */
export function restoreDecisionWords(rows: PlanAdaptationRow[], forRace: boolean): { summary: string; rationale: string } {
  const names = rows.map((row) => (row.kind === "swapped" ? (row.before?.exercise ?? row.exercise) : row.exercise));
  const back = rows.filter((row) => row.kind !== "added").map((row) => row.before?.exercise ?? row.exercise);
  const leaving = rows.filter((row) => row.kind === "added").map((row) => row.exercise);
  // Only trip versions ended: the day goes back to the plan as it stood (a race
  // adaptation beneath stays in force), never "the regular plan".
  if (rows.length && rows.every((row) => row.layer === "trip")) {
    const day = rows.map((row) => row.until_date).sort().at(-1) ?? "";
    return {
      summary: `Back to the plan after the trip: ${listWords(back.length ? back : names)} ${back.length === 1 ? "is" : "are"} back as planned.`.slice(0, 300),
      rationale: `The lighter trip version ran on ${weekdayWords(day)} and has ended, so the day goes back to the plan as it stood. Undo keeps the trip version one more week.`,
    };
  }
  const lead = forRace ? "Back to the regular plan after the race" : "Back to the regular plan";
  const parts: string[] = [];
  if (back.length) parts.push(`${listWords(back)} ${back.length === 1 ? "is" : "are"} back as written before`);
  if (leaving.length) parts.push(`${listWords(leaving)} ${leaving.length === 1 ? "was" : "were"} only for the race`);
  const summary = `${lead}: ${parts.join("; ") || listWords(names)}.`;
  const until = rows.map((row) => row.until_date).sort().at(-1) ?? "";
  const rationale = `The ${forRace ? "race adaptation" : "adaptation"} ran until ${weekdayWords(until)} and has ended, so the plan returns to the lifting it was built for. Undo keeps the ${forRace ? "race adaptation" : "adaptation"} one more week.`;
  return { summary: summary.slice(0, 300), rationale };
}

/** What the restore's Undo says it did: the adaptation stays one more week. */
export function keptOneMoreWeekWords(until: string, forRace: boolean): string {
  return `Kept the ${forRace ? "race adaptation" : "adaptation"} one more week; the regular plan returns ${weekdayWords(addDaysISO(until, 1) ?? until)}.`;
}

/** The ask for a return made around pain: same words, waiting for a yes. */
export function askedRestoreWords(rows: PlanAdaptationRow[], forRace: boolean): { summary: string; rationale: string } {
  const words = restoreDecisionWords(rows, forRace);
  const names = listWords(rows.map((row) => row.before?.exercise ?? row.exercise));
  return {
    summary: `${forRace ? "The race adaptation has ended" : "The adaptation has ended"}: bring ${names} back to the regular plan?`.slice(0, 300),
    rationale: `${words.rationale.replace(/ Undo keeps.*$/, "")} This change was made around pain, so it comes back only when you say so.`,
  };
}
