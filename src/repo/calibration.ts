// CALIBRATION — the elite-coach testing loop, as data. A coach does not trust
// a months-old threshold number or a formula-extrapolated 1RM forever: from
// time to time, when a quantity has gone stale AND current decisions depend on
// it, they schedule a test — a 30-minute steady run to anchor threshold HR, a
// fixed-HR benchmark to read aerobic efficiency, a heavy top set to re-anchor
// an estimated 1RM. This module owns that ladder for endurance and strength
// alike: what is calibrated, how stale it is, whether a test is worth
// suggesting, and how a completed test (detected from logged work — the
// athlete is never made to fill in a form) folds back into the models.
//
// VISION discipline: calibration is a SUGGESTION surfaced at natural openings,
// pull never push — no notification, no nag, no gate on training without it.
// Staleness alone never forces anything; a test is only suggested when the
// stale quantity is actually steering a live decision.
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { normalizedExerciseKey } from "./exercise-canon.js";
import { getHrModel, type HrModel } from "./hr-model.js";
import { getEnduranceGoal } from "./profile.js";
import { localDateISO } from "./shared.js";

export type CalibrationKind = "lthr_tt" | "benchmark_run" | "strength_topset";

export type CalibrationEvent = {
  id: number;
  kind: CalibrationKind;
  date: string;
  /** What the test anchors: "lthr", "easy_pace", or an exercise key for strength. */
  target_key: string | null;
  result: Record<string, unknown>;
  source: "detected" | "stated";
  created_at: string;
};

export type CalibrationStatusItem = {
  key: string;
  domain: "endurance" | "strength";
  label: string;
  last_anchored: string | null;
  /** Athlete-facing freshness word, never a number-of-days score. */
  freshness: "anchored" | "aging" | "stale" | "never";
  /** True only when the stale quantity is steering a live decision. */
  due: boolean;
};

export type CalibrationSuggestion = {
  kind: CalibrationKind;
  target_key: string | null;
  /** Athlete-facing suggestion prose — variant-set discipline applies. */
  line: string;
  /** How the test folds into existing work, e.g. "replaces this week's quality slot". */
  placement: string;
};

// ---------- staleness horizons ----------
// Days, INTERNAL only: the athlete never sees a day count, only the freshness
// word it resolves to. Each horizon is the honest life of the quantity itself —
// threshold HR moves slowly with fitness, an easy-pace read moves faster, and a
// formula-extrapolated 1RM drifts as soon as the plan starts adding load to it.
const LTHR_ANCHORED_DAYS = 90;
const LTHR_AGING_DAYS = 150;
const EASY_PACE_ANCHORED_DAYS = 45;
const EASY_PACE_AGING_DAYS = 90;
const STRENGTH_ANCHORED_DAYS = 42;
const STRENGTH_AGING_DAYS = 70;

// A verifying set is one heavy enough that the estimate could not have hidden
// behind it: at least this fraction of the est-1RM the plan was already using.
const VERIFYING_FRACTION = 0.92;
// How many times the plan may raise a lift's target on an unverified estimate
// before a heavy set is worth asking for.
const UNVERIFIED_PROGRESSIONS_DUE = 3;
// At most this many main lifts are tracked — a coach watches the lifts the
// program is built on, not every accessory.
const MAX_TRACKED_LIFTS = 6;
// And at most this many tests are ever suggested at once. Calibration is a quiet
// opening, not a to-do list.
const MAX_SUGGESTIONS = 2;
// How far back logged work is read when reconstructing verification history.
const STRENGTH_HISTORY_DAYS = 400;

// ---------- the unverified-slide hold, and its bounds ----------
// A regressing lift whose estimate nothing heavy has confirmed gets ONE pause
// instead of a deload — the slide may be the formula drifting rather than the
// athlete. That pause is a one-shot, not a policy, so it carries two bounds.
//
// DEPTH: past a full deload's worth of slide there is nothing conservative left
// about holding — the lift has already fallen further than the deload would have
// taken it, and calling that estimate noise stops being honest. Deliberately the
// same tenth `DELOAD_FRAC` uses in progression.ts (not imported: progression
// imports this module, and a cycle for one number is a poor trade).
const UNVERIFIED_HOLD_SLIDE_FRAC = 0.1;
// DURATION: the hold's whole story is "let one heavy set settle it". A slide
// still running a month later has had that chance, so the deload arm takes over.
// The engine keeps no record of a hold (a hold produces no proposal), so the
// repeat is derived from the slide itself: a peak this old means a hold fired on
// this same unbroken slide roughly a window ago.
const UNVERIFIED_HOLD_WINDOW_DAYS = 28;
// The window the slide is measured over — the same two months progression.ts
// treats as "recently" for a repeated deload.
const UNVERIFIED_HOLD_PEAK_DAYS = 60;

// ---------- detection thresholds ----------
const TT_MIN_MINUTES = 25;
const TT_MAX_MINUTES = 45;
const TT_MIN_FRACTION_OF_LTHR = 0.95;
const TT_MIN_AEROBIC_TE = 3.5;
const TT_AVG_TO_LTHR = 1.01;
const BENCHMARK_MIN_KM = 4;
const BENCHMARK_MAX_KM = 8;
const BENCHMARK_HR_TOLERANCE = 4;
// The benchmark is run at the top of the easy band, a couple of beats under the
// ceiling so a drift upward doesn't push it into a different kind of run.
const BENCHMARK_HR_BELOW_Z2_TOP = 2;

// Null-safe: Number(null) is 0, so a missing column would otherwise read as a
// real zero (see the same guard in hr-model.ts).
function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoDay(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

function daysBetween(fromISO: string | null | undefined, toISO: string): number | null {
  if (!fromISO) return null;
  const a = Date.parse(`${isoDay(fromISO)}T00:00:00Z`);
  const b = Date.parse(`${isoDay(toISO)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 864e5);
}

function shiftISO(dateISO: string, days: number): string {
  const ms = Date.parse(`${isoDay(dateISO)}T00:00:00Z`);
  if (!Number.isFinite(ms)) return isoDay(dateISO);
  return new Date(ms + days * 864e5).toISOString().slice(0, 10);
}

/** anchored / aging / stale from an age in days, or "never" when nothing anchors it. */
function freshnessFor(ageDays: number | null, anchoredMax: number, agingMax: number): CalibrationStatusItem["freshness"] {
  if (ageDays == null) return "never";
  if (ageDays < anchoredMax) return "anchored";
  if (ageDays <= agingMax) return "aging";
  return "stale";
}

// A quantity that has never been anchored is at least as un-anchored as a stale
// one — both are "the model is running on an estimate".
function needsAnchor(freshness: CalibrationStatusItem["freshness"]): boolean {
  return freshness === "stale" || freshness === "never";
}

// ---------- the ledger ----------

function rowToEvent(row: any): CalibrationEvent {
  let result: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row?.result_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed as Record<string, unknown>;
  } catch {
    /* an unreadable payload is an empty one — the DATE is what anchors */
  }
  return {
    id: Number(row.id),
    kind: String(row.kind) as CalibrationKind,
    date: isoDay(row.date),
    target_key: row.target_key ?? null,
    result,
    source: row.source === "stated" ? "stated" : "detected",
    created_at: String(row.created_at ?? ""),
  };
}

function insertEvent(
  event: Omit<CalibrationEvent, "id" | "created_at">,
  refId: number | null
): CalibrationEvent | null {
  const date = isoDay(event.date) || localDateISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // Idempotence for the detected path: the same activity or session re-read (a
  // Garmin re-sync, a re-finish) must refresh nothing and stack nothing.
  if (refId != null) {
    const existing = db
      .prepare(
        `SELECT * FROM calibration_events
         WHERE kind = ? AND ref_id = ? AND IFNULL(target_key,'') = IFNULL(?,'') LIMIT 1`
      )
      .get(event.kind, refId, event.target_key ?? null) as any;
    if (existing) return rowToEvent(existing);
  }
  const info = db
    .prepare(
      `INSERT INTO calibration_events (kind, date, target_key, result_json, source, ref_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.kind,
      date,
      event.target_key ?? null,
      JSON.stringify(event.result ?? {}),
      event.source === "stated" ? "stated" : "detected",
      refId
    );
  const row = db.prepare(`SELECT * FROM calibration_events WHERE id = ?`).get(Number(info.lastInsertRowid));
  return row ? rowToEvent(row) : null;
}

/** Record a completed calibration (detected from logged work, or stated). */
export function recordCalibrationEvent(
  event: Omit<CalibrationEvent, "id" | "created_at">
): CalibrationEvent | null {
  return insertEvent(event, null);
}

/** The most recent event anchoring a target, at or before a date. */
export function lastCalibration(kind: CalibrationKind, targetKey: string | null, asOf: string): CalibrationEvent | null {
  const row = db
    .prepare(
      `SELECT * FROM calibration_events
       WHERE kind = ? AND IFNULL(target_key,'') = IFNULL(?,'') AND date <= ?
       ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(kind, targetKey ?? null, asOf) as any;
  return row ? rowToEvent(row) : null;
}

/** Recent calibrations, newest first — provenance for surfaces and coach context. */
export function recentCalibrations(limit = 8, dateISO?: string): CalibrationEvent[] {
  const asOf = isoDay(dateISO || localDateISO());
  const rows = db
    .prepare(`SELECT * FROM calibration_events WHERE date <= ? ORDER BY date DESC, id DESC LIMIT ?`)
    .all(asOf, Math.max(1, Math.min(50, Math.trunc(limit) || 8))) as any[];
  return rows.map(rowToEvent);
}

// ---------- strength: what the plan is progressing, and what verified it ----------

interface MainLift {
  key: string;
  name: string;
  exercise_ids: number[];
  day_number: number;
  position: number;
}

// The main lifts of the ACTIVE plan whose progression is formula-driven: a loaded,
// reps-based movement carrying a prescribed weight the plan raises over time. The
// first couple of movements on a day are its main work; the accessories after them
// are not what a coach re-tests.
function mainPlanLifts(): MainLift[] {
  const rows = db
    .prepare(
      `SELECT d.day_number AS day_number, i.position AS position, e.id AS exercise_id, e.name AS name
       FROM plan_items i
       JOIN plan_days d ON d.id = i.plan_day_id
       JOIN exercises e ON e.id = i.exercise_id
       WHERE COALESCE(i.kind, 'strength') = 'strength'
         AND COALESCE(e.mode, 'reps') = 'reps'
         AND i.target_weight IS NOT NULL AND i.target_weight > 0
       ORDER BY d.day_number ASC, i.position ASC`
    )
    .all() as Array<{ day_number: number; position: number; exercise_id: number; name: string }>;

  const perDay = new Map<number, number>();
  const byKey = new Map<string, MainLift>();
  for (const row of rows) {
    const rank = perDay.get(row.day_number) ?? 0;
    perDay.set(row.day_number, rank + 1);
    if (rank >= 2) continue; // the day's main work, not its accessories
    const key = normalizedExerciseKey(row.name);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.exercise_ids.includes(row.exercise_id)) existing.exercise_ids.push(row.exercise_id);
      continue;
    }
    byKey.set(key, {
      key,
      name: row.name,
      exercise_ids: [row.exercise_id],
      day_number: row.day_number,
      position: row.position,
    });
  }
  // Every exercise row sharing the normalized key counts as the same lift, so a
  // re-created duplicate row never splits a lift's history in two.
  const all = db.prepare(`SELECT id, name FROM exercises`).all() as Array<{ id: number; name: string }>;
  for (const ex of all) {
    const lift = byKey.get(normalizedExerciseKey(ex.name));
    if (lift && !lift.exercise_ids.includes(ex.id)) lift.exercise_ids.push(ex.id);
  }
  return [...byKey.values()].slice(0, MAX_TRACKED_LIFTS);
}

function epley(weight: number, reps: number): number {
  return weight * (1 + reps / 30);
}

// An explicit "take it to failure" marker. The data model has no AMRAP column, so
// the athlete's own words on the set are the only place one can be declared.
const AMRAP_NOTE = /\bamrap\b|\bto failure\b|\bmax reps\b/i;

interface LiftDay {
  date: string;
  /** Best est-1RM the day's sets support (Epley on the best set). */
  est_1rm: number;
  /** The heaviest loaded set of the day and what it was taken for. */
  top: { weight: number; reps: number; note: string | null };
  amrap: boolean;
}

function liftDays(exerciseIds: number[], asOf: string): LiftDay[] {
  if (!exerciseIds.length) return [];
  const placeholders = exerciseIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.date AS date, ls.weight AS weight, ls.reps AS reps, ls.note AS note
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       WHERE ls.exercise_id IN (${placeholders})
         AND ls.weight IS NOT NULL AND ls.weight > 0
         AND ls.reps IS NOT NULL AND ls.reps > 0
         AND s.date <= ? AND s.date >= ?
       ORDER BY s.date ASC`
    )
    .all(...exerciseIds, asOf, shiftISO(asOf, -STRENGTH_HISTORY_DAYS)) as Array<{
    date: string;
    weight: number;
    reps: number;
    note: string | null;
  }>;

  const byDate = new Map<string, LiftDay>();
  for (const row of rows) {
    const weight = num(row.weight);
    const reps = num(row.reps);
    if (weight == null || reps == null || weight <= 0 || reps <= 0) continue;
    const date = isoDay(row.date);
    const est = epley(weight, reps);
    const amrap = AMRAP_NOTE.test(String(row.note ?? ""));
    const day = byDate.get(date);
    if (!day) {
      byDate.set(date, { date, est_1rm: est, top: { weight, reps, note: row.note ?? null }, amrap });
      continue;
    }
    if (est > day.est_1rm) day.est_1rm = est;
    if (weight > day.top.weight) day.top = { weight, reps, note: row.note ?? null };
    if (amrap) day.amrap = true;
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

interface VerificationHistory {
  /** est-1RM the plan is currently progressing from, or null with no history. */
  current_est_1rm: number | null;
  /** The last day a set actually verified that estimate. */
  last_verified: string | null;
  /** The verifying day's top set, when there is one. */
  last_verified_set: { weight: number; reps: number; est_1rm: number; prior_est_1rm: number } | null;
}

// Walk the lift's logged days forward, carrying the estimate the plan HAD before
// each day. A day verifies when its heaviest set is at least VERIFYING_FRACTION
// of that prior estimate (so a formula extrapolated from fives is confirmed by a
// genuinely heavy single or triple), or when the athlete marked a set AMRAP.
function verificationHistory(exerciseIds: number[], asOf: string): VerificationHistory {
  return historyFromDays(liftDays(exerciseIds, asOf));
}

function historyFromDays(days: LiftDay[]): VerificationHistory {
  let running: number | null = null;
  let lastVerified: string | null = null;
  let lastSet: VerificationHistory["last_verified_set"] = null;
  for (const day of days) {
    const prior = running;
    const verified = day.amrap || (prior != null && day.top.weight >= VERIFYING_FRACTION * prior);
    if (verified) {
      lastVerified = day.date;
      lastSet = {
        weight: day.top.weight,
        reps: day.top.reps,
        est_1rm: Math.round(day.est_1rm * 10) / 10,
        prior_est_1rm: prior == null ? 0 : Math.round(prior * 10) / 10,
      };
    }
    running = running == null ? day.est_1rm : Math.max(running, day.est_1rm);
  }
  return {
    current_est_1rm: running == null ? null : Math.round(running * 10) / 10,
    last_verified: lastVerified,
    last_verified_set: lastSet,
  };
}

// ---------- the slide, and how far it has run ----------
// Read off the SAME logged days the verification walk uses, so nothing here needs
// a second query or the program state.

interface SlideRead {
  /** The lift's latest est-1RM sits under its own recent peak. */
  regressing: boolean;
  /** …by more than a deload's worth. A slide that deep is not formula noise. */
  deep: boolean;
  /** …and it has been running longer than one hold window. */
  continued: boolean;
}

const NO_SLIDE: SlideRead = { regressing: false, deep: false, continued: false };

function slideFromDays(days: LiftDay[], asOf: string): SlideRead {
  const since = shiftISO(asOf, -UNVERIFIED_HOLD_PEAK_DAYS);
  const window = days.filter((day) => day.date >= since);
  if (window.length < 2) return NO_SLIDE;
  let peak = 0;
  let peakDate: string | null = null;
  for (const day of window) {
    // The MOST RECENT day holding the peak owns it — a lift that touched its top
    // (an exact-or-greater est-1RM match; a near-rebound does not reset the clock)
    // again last week has not been sliding for two months, whatever it did before.
    if (day.est_1rm >= peak) {
      peak = day.est_1rm;
      peakDate = day.date;
    }
  }
  const latest = window[window.length - 1]?.est_1rm ?? 0;
  if (!(peak > 0) || !(latest < peak)) return NO_SLIDE;
  const age = daysBetween(peakDate, asOf);
  return {
    regressing: true,
    deep: latest < peak * (1 - UNVERIFIED_HOLD_SLIDE_FRAC),
    continued: age != null && age > UNVERIFIED_HOLD_WINDOW_DAYS,
  };
}

// How many times the plan has RAISED this lift's prescribed target since a date.
// Applied proposals are the audit trail: the plan itself keeps no per-target
// history, but every applied change carries the exercise it moved and the weight
// it moved it to.
function progressionsSince(lift: MainLift, sinceISO: string | null, asOf: string): number {
  const from = sinceISO ?? shiftISO(asOf, -STRENGTH_HISTORY_DAYS);
  const rows = db
    .prepare(
      `SELECT parsed_json FROM plan_proposals
       WHERE status = 'applied' AND parsed_json IS NOT NULL
         AND date(created_at) > ? AND date(created_at) <= ?`
    )
    .all(from, asOf) as Array<{ parsed_json: string }>;
  let count = 0;
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(row.parsed_json);
    } catch {
      continue;
    }
    const changes = Array.isArray(parsed?.changes) ? parsed.changes : [];
    const hit = changes.some((change: any) => {
      const name = String(change?.exercise ?? "");
      if (!name || normalizedExerciseKey(name) !== lift.key) return false;
      return num(change?.target_weight) != null;
    });
    if (hit) count += 1;
  }
  return count;
}

// ---------- what a heavy set has actually confirmed ----------
// One internal read, four public questions. Every consumer below — INCLUDING the
// plan-lift loop in calibrationStatus — goes through `liftRead` rather than
// re-walking the 400-day history or re-deciding which confirmation speaks: the
// walk is the expensive part of this module, and a second copy of the
// newest-confirmation-wins rule is how the surfaces and the brain would drift
// into disagreeing about the same lift.

interface StrengthAnchor {
  /** The lift's normalized key, or "" when the name resolves to nothing. */
  key: string;
  /** The est-1RM the plan is currently progressing from, formula or otherwise. */
  running_est_1rm: number | null;
  /** The day a heavy set last stood behind the estimate, from either source. */
  anchored_on: string | null;
  /** The est-1RM that verifying day supports — a number a set was actually taken at. */
  verified_est_1rm: number | null;
}

/**
 * Every exercise row that IS this lift. A re-created duplicate row must never
 * split a lift's history in two — the same rule mainPlanLifts() applies, reused
 * here for a lift named directly rather than found through the plan.
 */
function exerciseIdsForLift(exerciseName: string): { key: string; ids: number[] } {
  const key = normalizedExerciseKey(String(exerciseName ?? ""));
  if (!key) return { key: "", ids: [] };
  const rows = db.prepare(`SELECT id, name FROM exercises`).all() as Array<{ id: number; name: string }>;
  return { key, ids: rows.filter((row) => normalizedExerciseKey(row.name) === key).map((row) => Number(row.id)) };
}

/**
 * ONE read of a lift, from ONE walk of its history.
 *
 * Everything this module answers about a strength lift — which confirmation
 * speaks, how fresh it is, how much its estimate deserves to be trusted, and
 * whether it is mid-slide — is derived here, from the single 400-day walk that is
 * the expensive part of the module. `key`/`ids` arrive pre-resolved so a caller
 * that already knows them (the plan-lift loop) does not re-resolve or re-walk.
 */
interface LiftRead {
  key: string;
  days: LiftDay[];
  history: VerificationHistory;
  anchor: StrengthAnchor;
  freshness: CalibrationStatusItem["freshness"];
  confidence: EstimateConfidence;
  slide: SlideRead;
}

function liftRead(key: string, ids: number[], asOf: string): LiftRead {
  if (!key || !ids.length) {
    return {
      key,
      days: [],
      history: { current_est_1rm: null, last_verified: null, last_verified_set: null },
      anchor: { key, running_est_1rm: null, anchored_on: null, verified_est_1rm: null },
      freshness: "never",
      confidence: "unverified",
      slide: NO_SLIDE,
    };
  }
  const days = liftDays(ids, asOf);
  const history = historyFromDays(days);
  const anchor = anchorFrom(key, history, asOf);
  const freshness = freshnessFor(daysBetween(anchor.anchored_on, asOf), STRENGTH_ANCHORED_DAYS, STRENGTH_AGING_DAYS);
  return {
    key,
    days,
    history,
    anchor,
    freshness,
    confidence: freshness === "anchored" ? "verified" : freshness === "aging" ? "aging" : "unverified",
    slide: slideFromDays(days, asOf),
  };
}

/** The same read, for a lift named directly rather than found through the plan. */
function strengthAnchor(exerciseName: string, asOf: string): StrengthAnchor {
  const { key, ids } = exerciseIdsForLift(exerciseName);
  return liftRead(key, ids, asOf).anchor;
}

function anchorFrom(key: string, history: VerificationHistory, asOf: string): StrengthAnchor {
  const event = lastCalibration("strength_topset", key, asOf);
  const eventEst = event ? num((event.result as any)?.est_1rm) : null;
  // Whichever confirmation is NEWER speaks. They normally agree — the recorded
  // event is written FROM this same history at session finish — but a detection
  // that never ran (enrichment off, a hand-imported DB) must not make a genuinely
  // verified lift read unverified, and an event carried across an import must not
  // be outranked by a history that no longer holds the sets behind it.
  const eventDate = event?.date ?? null;
  const historyDate = history.last_verified;
  const anchoredOn =
    eventDate && historyDate ? (historyDate > eventDate ? historyDate : eventDate) : (historyDate ?? eventDate);
  const verified =
    anchoredOn == null
      ? null
      : anchoredOn === eventDate && eventEst != null
        ? eventEst
        : (history.last_verified_set?.est_1rm ?? eventEst);
  return {
    key,
    running_est_1rm: history.current_est_1rm,
    anchored_on: anchoredOn,
    verified_est_1rm: verified,
  };
}

export interface VerifiedStrengthAnchor {
  /** The est-1RM a heavy set actually stood behind. */
  est_1rm: number;
  /** The day it stood behind it. */
  anchored_on: string;
}

/**
 * The est-1RM a FRESH heavy set confirms for this lift, when one has.
 *
 * A verified top set is authoritative over Epley-from-ordinary-sets: the formula
 * extrapolates a single-rep ceiling from work the athlete never took near it, and
 * a plan that then progresses off that extrapolation is raising load against a
 * number nothing has ever stood behind. So a caller writing a "this should hold"
 * baseline prefers this over the running estimate — INCLUDING when this is lower.
 * A running estimate that has climbed above the last verified set since is exactly
 * the unconfirmed extrapolation this ladder exists to distrust.
 *
 * Bounded by the same STRENGTH_ANCHORED_DAYS horizon the freshness word uses: past
 * it the confirmation itself has aged, and an aged number must not override a
 * fresher read of the athlete.
 */
export function verifiedStrengthAnchor(exerciseName: string, dateISO?: string): VerifiedStrengthAnchor | null {
  const asOf = isoDay(dateISO || localDateISO());
  const anchor = strengthAnchor(exerciseName, asOf);
  if (!anchor.anchored_on || anchor.verified_est_1rm == null || anchor.verified_est_1rm <= 0) return null;
  const age = daysBetween(anchor.anchored_on, asOf);
  if (age == null || age >= STRENGTH_ANCHORED_DAYS) return null;
  return { est_1rm: anchor.verified_est_1rm, anchored_on: anchor.anchored_on };
}

/**
 * Did a heavy set verify this lift INSIDE a given window?
 *
 * The evaluation-time half of the same question: an outcome window that contains
 * a confirmation is measuring a real number, and one that does not is measuring a
 * formula against itself.
 */
export function verifiedTopSetInWindow(
  exerciseName: string,
  windowStart: string,
  windowEnd: string
): { date: string; est_1rm: number | null } | null {
  const start = isoDay(windowStart);
  const end = isoDay(windowEnd);
  if (!start || !end || start > end) return null;
  const { key, ids } = exerciseIdsForLift(exerciseName);
  if (!key || !ids.length) return null;
  const event = lastCalibration("strength_topset", key, end);
  if (event && event.date >= start) return { date: event.date, est_1rm: num((event.result as any)?.est_1rm) };
  // No recorded event does not mean no verification: detection runs at session
  // finish, so an imported DB or a window whose sessions predate the ladder still
  // holds the sets that verify it.
  const history = verificationHistory(ids, end);
  if (history.last_verified && history.last_verified >= start) {
    return { date: history.last_verified, est_1rm: history.last_verified_set?.est_1rm ?? null };
  }
  return null;
}

// ---------- status ----------

function enduranceGoalActive(asOf: string): boolean {
  try {
    const goal = getEnduranceGoal(asOf);
    if (!goal) return false;
    // A race already run steers nothing until a new goal is set.
    if (goal.is_race && typeof goal.days_to_race === "number" && goal.days_to_race < 0) return false;
    return true;
  } catch {
    return false;
  }
}

function strengthLabel(name: string): string {
  // Athlete-facing text never carries an underscore (the reading grammar treats
  // one as leaked engineering prose), and a stored exercise name can.
  return String(name).replace(/_/g, " ").trim();
}

/** Per-quantity calibration state across both domains. */
export function calibrationStatus(dateISO?: string): { as_of: string; items: CalibrationStatusItem[] } {
  const asOf = isoDay(dateISO || localDateISO());
  const items: CalibrationStatusItem[] = [];
  const model = getHrModel(asOf);
  const goal = enduranceGoalActive(asOf);

  // Threshold HR. Only a field test anchors it — a sustained-effort estimate is
  // precisely the thing a test would replace.
  const lthrEvent = lastCalibration("lthr_tt", "lthr", asOf);
  const lthrFreshness = freshnessFor(daysBetween(lthrEvent?.date, asOf), LTHR_ANCHORED_DAYS, LTHR_AGING_DAYS);
  items.push({
    key: "lthr",
    domain: "endurance",
    label: "Threshold heart rate",
    last_anchored: lthrEvent?.date ?? null,
    freshness: lthrFreshness,
    // Decision-relevant when a goal is actually steering run prescriptions AND
    // there is enough running for zones to mean anything. With no endurance goal
    // the zones steer nothing, so a stale estimate costs nothing either.
    due: needsAnchor(lthrFreshness) && goal && model.confidence !== "insufficient",
  });

  // The easy-pace benchmark: one fixed-pulse run, re-run periodically, is how
  // aerobic efficiency becomes readable at all.
  const benchmarkEvent = lastCalibration("benchmark_run", "easy_pace", asOf);
  const benchmarkFreshness = freshnessFor(
    daysBetween(benchmarkEvent?.date, asOf),
    EASY_PACE_ANCHORED_DAYS,
    EASY_PACE_AGING_DAYS
  );
  items.push({
    key: "easy_pace",
    domain: "endurance",
    label: "Easy-pace benchmark",
    last_anchored: benchmarkEvent?.date ?? null,
    freshness: benchmarkFreshness,
    due: needsAnchor(benchmarkFreshness) && goal && !!model.zones,
  });

  for (const lift of mainPlanLifts()) {
    // ONE read per lift, shared with everything else this module answers about it
    // (which confirmation speaks, how fresh it is, whether it is mid-slide).
    const read = liftRead(lift.key, lift.exercise_ids, asOf);
    // A lift with no logged history has no estimate to verify — nothing is being
    // extrapolated, so nothing is stale.
    if (read.history.current_est_1rm == null) continue;
    const anchoredOn = read.anchor.anchored_on;
    const progressions = progressionsSince(lift, anchoredOn, asOf);
    items.push({
      key: lift.key,
      domain: "strength",
      label: strengthLabel(lift.name),
      last_anchored: anchoredOn,
      freshness: read.freshness,
      // Stale alone is not a reason. The estimate has to be STEERING something,
      // and it does in two ways: the plan has raised this lift's target repeatedly
      // on top of a number no heavy set has confirmed, OR the progression engine is
      // holding the lift right now BECAUSE the estimate is unconfirmed. The hold IS
      // the "current decisions depend on it" condition this ladder was built for —
      // and a hold the athlete is never offered the test for is a dead end, since
      // the hold's own story is "let a heavy set settle it".
      // The hold clause deliberately does NOT sit behind needsAnchor: the hold
      // fires on any non-verified confidence, which includes the "aging" band
      // (anchored 42-70 days ago) that needsAnchor excludes — and a lift held
      // with "let a heavy set settle it" while the ladder declines to offer the
      // test is the exact dead end the fairness work exists to close.
      due:
        (needsAnchor(read.freshness) && progressions >= UNVERIFIED_PROGRESSIONS_DUE) ||
        unverifiedHoldFromRead(read),
    });
  }

  return { as_of: asOf, items };
}

// ---------- suggestions ----------
// Variant sets, rotated by day: a stable input fires the same rule every morning,
// and one literal sentence printed for weeks reads as a broken app. Every line
// here is held to the reading grammar (no engineering words, no scores, no gate).

const LTHR_LINES: readonly [string, ...string[]] = [
  "It's been a while since a steady half-hour effort showed where your threshold actually sits — one would sharpen every zone you run in.",
  "Your running zones are resting on an estimate right now; a 30-minute steady effort would put a measured number under them.",
  "A 30-minute steady run would re-anchor the pulse your easy days are built around.",
];

const LTHR_PLACEMENTS: readonly [string, ...string[]] = [
  "It folds into this week's quality slot — no extra day needed.",
  "Take it where this week's quality run already sits.",
  "Run it in place of this week's harder session.",
];

const EASY_PACE_LINES: readonly [string, ...string[]] = [
  "A short run held at one steady easy pulse would show how much your aerobic engine has moved.",
  "Four to eight kilometres at a fixed easy heart rate is the cleanest read on what your easy days are buying you.",
  "One easy-pulse run, the same heart rate start to finish, would tell us how the base is coming along.",
];

const EASY_PACE_PLACEMENTS: readonly [string, ...string[]] = [
  "It folds into one of this week's easy runs.",
  "Any easy run this week can carry it.",
  "Take it on your next easy day, same route as usual.",
];

const STRENGTH_LINES: readonly [string, ...string[]] = [
  "A heavy top set on {lift} would confirm what your working weights have been climbing toward.",
  "{lift} has been climbing on an estimate — one heavy set would show the real ceiling.",
  "Your {lift} target has moved a few times now; a single heavy set would prove it out.",
];

const STRENGTH_PLACEMENTS: readonly [string, ...string[]] = [
  "The first heavy set of your next push day, taken to a solid top single or triple.",
  "Slot it at the front of your next session while you're fresh — one honest top set.",
  "Open your next session with it: work up, then one strong triple.",
];

/**
 * Tests worth suggesting right now (stale AND decision-relevant).
 *
 * `opts.status` lets a caller that has ALREADY computed the status hand it in.
 * Deriving it walks every main plan lift's 400-day verification history, so a
 * surface that returns both (GET /api/calibration/status) would otherwise pay for
 * that walk twice per request.
 */
export function dueCalibrations(
  dateISO?: string,
  opts?: { status?: ReturnType<typeof calibrationStatus> }
): CalibrationSuggestion[] {
  const asOf = isoDay(dateISO || localDateISO());
  const { items } = opts?.status ?? calibrationStatus(asOf);
  const endurance: CalibrationSuggestion[] = [];
  const strength: CalibrationSuggestion[] = [];
  for (const item of items) {
    if (!item.due) continue;
    const out = item.domain === "strength" ? strength : endurance;
    if (item.key === "lthr") {
      out.push({
        kind: "lthr_tt",
        target_key: "lthr",
        line: pickDayVariant(LTHR_LINES, asOf, "calibration:lthr:line"),
        placement: pickDayVariant(LTHR_PLACEMENTS, asOf, "calibration:lthr:placement"),
      });
    } else if (item.key === "easy_pace") {
      out.push({
        kind: "benchmark_run",
        target_key: "easy_pace",
        line: pickDayVariant(EASY_PACE_LINES, asOf, "calibration:easy-pace:line"),
        placement: pickDayVariant(EASY_PACE_PLACEMENTS, asOf, "calibration:easy-pace:placement"),
      });
    } else {
      out.push({
        kind: "strength_topset",
        target_key: item.key,
        line: pickDayVariant(STRENGTH_LINES, asOf, `calibration:${item.key}:line`).replace("{lift}", item.label),
        placement: pickDayVariant(STRENGTH_PLACEMENTS, asOf, `calibration:${item.key}:placement`),
      });
    }
  }
  // DOMAIN FAIRNESS. The two slots are shared, not first-come: a runner who also
  // lifts has two endurance quantities aging on their own clocks, and taking the
  // list in item order handed them both slots forever — so a strength test was
  // never offered, and the progression engine's "let a heavy set settle it" hold
  // had no reachable way to be settled. Endurance still speaks first; it just no
  // longer speaks twice while the other domain is waiting.
  const out: CalibrationSuggestion[] = [];
  for (let i = 0; out.length < MAX_SUGGESTIONS && i < Math.max(endurance.length, strength.length); i++) {
    if (endurance[i]) out.push(endurance[i]);
    if (out.length < MAX_SUGGESTIONS && strength[i]) out.push(strength[i]);
  }
  return out;
}

// ---------- detection ----------
// Conservative by construction. A false anchor poisons every zone band for
// months, and the cost of missing one is only that the next test gets suggested
// again — so when the shape is ambiguous, nothing is recorded.

/** Inspect a synced run for a test signature (steady 30-min effort, fixed-HR benchmark). */
export function detectRunCalibration(garminActivityId: number): CalibrationEvent | null {
  const id = Math.trunc(Number(garminActivityId));
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = db
    .prepare(
      `SELECT id, date, type, avg_hr, distance_km, aerobic_te, COALESCE(moving_min, duration_min) AS minutes
       FROM garmin_activities WHERE id = ?`
    )
    .get(id) as
    | { id: number; date: string; type: string | null; avg_hr: number | null; distance_km: number | null; aerobic_te: number | null; minutes: number | null }
    | undefined;
  if (!row) return null;
  if (!/run/i.test(String(row.type ?? ""))) return null;
  const date = isoDay(row.date);
  const avgHr = num(row.avg_hr);
  const minutes = num(row.minutes);
  if (avgHr == null || avgHr <= 0) return null;

  const model: HrModel = getHrModel(date);

  // (1) A threshold time trial: the right length, held near the threshold the
  // model already believes in, and hard enough that the watch agrees it was a
  // real effort. All three, or it is just a run.
  //
  // And the threshold it is held against has to be worth holding against. On the
  // FALLBACK rung the model has no threshold evidence at all — lthr is simply a
  // fraction of the observed max, and it sits low enough that an ordinary tempo run
  // clears the "near threshold" bar. Trusting a detection there would let that run
  // become an uncapped field-test anchor, flip confidence to "anchored", and stop
  // the ladder ever suggesting the genuine test that would replace it. On fallback
  // the detection stays quiet and the suggestion keeps standing.
  if (
    model.lthr_basis !== "fallback" &&
    model.lthr != null &&
    minutes != null &&
    minutes >= TT_MIN_MINUTES &&
    minutes <= TT_MAX_MINUTES &&
    avgHr >= TT_MIN_FRACTION_OF_LTHR * model.lthr &&
    (num(row.aerobic_te) ?? 0) >= TT_MIN_AEROBIC_TE
  ) {
    return insertEvent(
      {
        kind: "lthr_tt",
        date,
        target_key: "lthr",
        result: {
          lthr: Math.round(avgHr * TT_AVG_TO_LTHR),
          avg_hr: Math.round(avgHr),
          minutes: Math.round(minutes),
          garmin_activity_id: row.id,
        },
        source: "detected",
      },
      row.id
    );
  }

  // (2) The fixed-HR benchmark: the right distance, held within a few beats of
  // the benchmark pulse. What it anchors is the PACE that pulse bought.
  const distance = num(row.distance_km);
  if (
    model.zones &&
    distance != null &&
    minutes != null &&
    minutes > 0 &&
    distance >= BENCHMARK_MIN_KM &&
    distance <= BENCHMARK_MAX_KM
  ) {
    const benchmarkHr = model.zones.z2_top - BENCHMARK_HR_BELOW_Z2_TOP;
    if (Math.abs(avgHr - benchmarkHr) <= BENCHMARK_HR_TOLERANCE) {
      return insertEvent(
        {
          kind: "benchmark_run",
          date,
          target_key: "easy_pace",
          result: {
            pace_min_per_km: Math.round((minutes / distance) * 100) / 100,
            avg_hr: Math.round(avgHr),
            benchmark_hr: benchmarkHr,
            distance_km: Math.round(distance * 100) / 100,
            garmin_activity_id: row.id,
          },
          source: "detected",
        },
        row.id
      );
    }
  }
  return null;
}

/**
 * Inspect a finished strength session for calibration sets (AMRAP / heavy top set).
 *
 * The est-1RM itself stays owned by the existing Epley path — a verifying set
 * refreshes WHEN the estimate was last confirmed, it does not redefine it.
 */
export function detectStrengthCalibration(sessionId: number): CalibrationEvent[] {
  const id = Math.trunc(Number(sessionId));
  if (!Number.isFinite(id) || id <= 0) return [];
  const session = db.prepare(`SELECT id, date FROM sessions WHERE id = ?`).get(id) as
    | { id: number; date: string }
    | undefined;
  if (!session) return [];
  const date = isoDay(session.date);
  const lifts = mainPlanLifts();
  if (!lifts.length) return [];
  const trained = new Set(
    (db.prepare(`SELECT DISTINCT exercise_id FROM logged_sets WHERE session_id = ?`).all(id) as Array<{
      exercise_id: number;
    }>).map((r) => Number(r.exercise_id))
  );

  const out: CalibrationEvent[] = [];
  for (const lift of lifts) {
    if (!lift.exercise_ids.some((exId) => trained.has(exId))) continue;
    const history = verificationHistory(lift.exercise_ids, date);
    // Only THIS session's day counts — an older verification is already recorded.
    if (history.last_verified !== date || !history.last_verified_set) continue;
    const event = insertEvent(
      {
        kind: "strength_topset",
        date,
        target_key: lift.key,
        result: {
          exercise: lift.name,
          weight: history.last_verified_set.weight,
          reps: history.last_verified_set.reps,
          est_1rm: history.last_verified_set.est_1rm,
          verified_against: history.last_verified_set.prior_est_1rm,
          session_id: session.id,
        },
        source: "detected",
      },
      session.id
    );
    if (event) out.push(event);
  }
  return out;
}

// ---------- the compact coach-context view ----------

export interface CalibrationCoachView {
  due: Array<{ kind: CalibrationKind; target_key: string | null; line: string; placement: string }>;
  recently_anchored: Array<{ kind: CalibrationKind; target_key: string | null; date: string }>;
}

/**
 * What a prompt needs to know: which tests are worth an opening, and what has
 * recently been confirmed (so the coach doesn't ask for a test the athlete just
 * ran). Suggestions only — nothing here gates anything.
 */
export function calibrationForCoach(dateISO?: string): CalibrationCoachView {
  const asOf = isoDay(dateISO || localDateISO());
  const recent = recentCalibrations(4, asOf).filter((event) => {
    const age = daysBetween(event.date, asOf);
    return age != null && age <= 60;
  });
  return {
    due: dueCalibrations(asOf),
    recently_anchored: recent.map((event) => ({ kind: event.kind, target_key: event.target_key, date: event.date })),
  };
}

// How much a lift's est-1RM deserves to be trusted, from the verification ledger
// above. Two consumers, and they are NOT interchangeable: `estimateConfidenceFor`
// is the reading (used to decide how bold a peak-week top set may be), and
// `unverifiedRegressionHold` is the scoped, bounded decision the progression
// engine's regressing branch consults.
export type EstimateConfidence = "verified" | "aging" | "unverified";

/**
 * How much this lift's est-1RM deserves to be trusted right now.
 *
 * Deliberately the SAME ladder the athlete-facing freshness word runs on
 * (`freshnessFor` against STRENGTH_ANCHORED_DAYS / STRENGTH_AGING_DAYS) rather
 * than a second set of horizons: a lift the calibration card calls "anchored"
 * and a lift the progression ladder calls "verified" must never be able to
 * disagree about the same day.
 *
 * "never" collapses into "unverified", which is the literal truth: a lift no
 * heavy set has ever confirmed is running on a formula. Same for a name that
 * resolves to nothing — the honest answer to "how confirmed is this estimate?"
 * for an estimate we cannot find is "not".
 *
 * This is a READING, not a decision. It does NOT by itself soften a deload:
 * "unverified" is near-universal on real data (a verifying set is an AMRAP or a
 * set at 0.92× the running estimate, which ordinary work rarely is), so a
 * consumer that held every unverified regression would have switched its deload
 * arm off. `unverifiedRegressionHold` is the decision, and it is scoped and
 * bounded; read that when the question is "what should happen to this lift".
 */
export function estimateConfidenceFor(exerciseName: string, dateISO?: string): EstimateConfidence {
  const asOf = isoDay(dateISO || localDateISO());
  const { key, ids } = exerciseIdsForLift(String(exerciseName ?? ""));
  return liftRead(key, ids, asOf).confidence;
}

export interface UnverifiedRegressionHold {
  /** How much the estimate behind this lift deserves to be trusted. */
  confidence: EstimateConfidence;
  /** A hold is the honest answer for this lift today. */
  holds: boolean;
  /** The ladder can actually surface a heavy-set test for this lift. */
  tracked: boolean;
  /** The slide is deeper than a deload would have taken it. */
  deep: boolean;
  /** The slide has been running longer than one hold window. */
  continued: boolean;
}

// A hold, from a read that already knows everything it needs.
function unverifiedHoldFromRead(read: LiftRead): boolean {
  if (read.confidence === "verified") return false;
  if (!read.slide.regressing) return false;
  if (read.slide.deep || read.slide.continued) return false;
  return isTrackedMainLift(read.key);
}

// Is this lift one the calibration ladder can put a test in front of? Only the
// first couple of loaded movements on each plan day, capped at MAX_TRACKED_LIFTS.
function isTrackedMainLift(key: string): boolean {
  if (!key) return false;
  try {
    return mainPlanLifts().some((lift) => lift.key === key);
  } catch {
    return false;
  }
}

/**
 * Should a regressing lift PAUSE rather than deload, because the slip may be the
 * estimate drifting rather than the athlete?
 *
 * A one-shot pause, not a policy. Three things have to be true, and each one
 * exists because the unbounded version of this was strictly worse than the deload
 * it replaced:
 *
 *   • the lift is TRACKED — a main plan lift the calibration ladder will actually
 *     offer a heavy-set test for. The hold's story is "let one heavy set settle
 *     it", and on an accessory nothing ever offers that set, so the story is a
 *     dead end and the lift sits at its current weight indefinitely. On an
 *     accessory the Epley noise the hold guards against is cheap; a silent
 *     dead-end is not, so accessories keep the ordinary deload.
 *   • the slide is SHALLOW. Past a deload's own depth the lift has already fallen
 *     further than the deload would have taken it — holding there is not the
 *     conservative arm, it is just the inactive one.
 *   • the slide is FRESH. A slide still running a window later has already had its
 *     heavy set offered and not taken; the deload arm takes over.
 *
 * The caller supplies "is this lift regressing" from the program state; this
 * answers everything else. Its own slide read (off the logged est-1RM days) is
 * what bounds the hold, and is deliberately the same one calibrationStatus uses
 * to decide the test is due — so the hold and the test that ends it agree.
 */
export function unverifiedRegressionHold(exerciseName: string, dateISO?: string): UnverifiedRegressionHold {
  const asOf = isoDay(dateISO || localDateISO());
  const { key, ids } = exerciseIdsForLift(String(exerciseName ?? ""));
  const read = liftRead(key, ids, asOf);
  return {
    confidence: read.confidence,
    holds: unverifiedHoldFromRead(read),
    tracked: isTrackedMainLift(read.key),
    deep: read.slide.deep,
    continued: read.slide.continued,
  };
}
