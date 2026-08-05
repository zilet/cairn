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
  const days = liftDays(exerciseIds, asOf);
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
    const history = verificationHistory(lift.exercise_ids, asOf);
    // A lift with no logged history has no estimate to verify — nothing is being
    // extrapolated, so nothing is stale.
    if (history.current_est_1rm == null) continue;
    const event = lastCalibration("strength_topset", lift.key, asOf);
    const anchoredOn =
      history.last_verified && event?.date
        ? history.last_verified > event.date
          ? history.last_verified
          : event.date
        : (history.last_verified ?? event?.date ?? null);
    const freshness = freshnessFor(daysBetween(anchoredOn, asOf), STRENGTH_ANCHORED_DAYS, STRENGTH_AGING_DAYS);
    const progressions = progressionsSince(lift, anchoredOn, asOf);
    items.push({
      key: lift.key,
      domain: "strength",
      label: strengthLabel(lift.name),
      last_anchored: anchoredOn,
      freshness,
      // Stale alone is not a reason. The estimate has to be STEERING something:
      // the plan has raised this lift's target repeatedly on top of a number no
      // heavy set has confirmed.
      due: needsAnchor(freshness) && progressions >= UNVERIFIED_PROGRESSIONS_DUE,
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
  const out: CalibrationSuggestion[] = [];
  for (const item of items) {
    if (!item.due) continue;
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
  return out.slice(0, MAX_SUGGESTIONS);
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
