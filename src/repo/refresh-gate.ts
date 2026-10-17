// The material-change gate for the two background agent reads that used to re-run on
// every write: the week-ahead sketch and the quiet cross-domain insight.
//
// Both were keyed on signals that move far more often than anything they say:
//   • the week-ahead key folded in the in-process training-data COUNTER, which every
//     Garmin sync pass bumps (several times a day, whether or not a value changed) and
//     every restart resets to zero — so a sync or a deploy minted a new key, and the
//     next Today open spent a ~35 s coaching run on an unchanged week;
//   • the insight generator ran on every review-worthy signal (a weigh-in, a Garmin
//     training-status flip, a plan restamp) with nothing remembering that it had just
//     answered the same picture minutes earlier — fifty runs, two stored insights, in
//     the fourteen days that prompted this.
//
// Each op now reads TWO restart-stable, value-based fingerprints over durable state:
//   • MATERIAL — the facts that genuinely change what the read would say: the plan and
//     its targets, schedules, goals and stated intent, a finished session, a logged run
//     or ride, a new night of sleep, a check-in, a symptom or life-context change, a new
//     lab/directive. Any move here refreshes IMMEDIATELY — never debounced.
//   • DRIFT — inputs the prompt can see that move without changing the picture much: a
//     weigh-in, Garmin's training-status label, a session still in progress, today's
//     composition, and (insight only) the day's food log. A drift move refreshes only
//     once the last answer is older than the op's minimum interval.
// Neither carries a process counter, a wall-clock stamp, or a sync's bookkeeping
// column (updated_at / synced_at), so a sync that rewrites the same numbers, a restart,
// or a backfill moves neither. Over-inclusion only costs a run; a fact query that fails
// falls back to its table's coarse row-count/high-water odometer, so a broken query can
// never quietly read as "unchanged".
//
// What is deliberately NOT here, and why:
//   • training_readiness's VALUE — the stored Garmin number is the day's LAST sync, so it
//     is post-workout on any day the athlete trained (CLAUDE.md "Morning readiness").
//     Its PRESENCE for the read day is material: the morning reading arriving is news.
//   • today's resting HR value — Garmin revises the day's RHR as the day goes on; past
//     nights' values and today's presence are material.
//   • steps, stress, body battery, calories, race predictions — telemetry the sketch and
//     the connection pass do not turn on; the next material change carries them in.
//
// Observability: the counters below are in-process (since this process started, the
// same build scope getAgentStats reports) and are surfaced as
// getAgentStats().refresh_gate / .skipped_unchanged. They never write a row, so a
// Today open that consults the gate stays memo-neutral.
import crypto from "node:crypto";
import { db } from "../db.js";
import { addDaysISO } from "../lib/dates.js";

// The same canonical sha1 as repo/chat.ts's fingerprint(), kept local so this leaf does
// not pull the chat module (and its imports) into every reader of the gate.
function fingerprint(parts: unknown): string {
  const canonical = (v: any): any => {
    if (v == null) return null;
    if (typeof v === "bigint") return Number(v);
    if (Array.isArray(v)) return v.map(canonical);
    if (typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
      return out;
    }
    return v;
  };
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(canonical(parts)))
    .digest("hex");
}

export type RefreshGateOp = "week_ahead" | "insight";

export interface RefreshInputs {
  material: string;
  drift: string;
}

/** A drift-only change refreshes the week-ahead sketch at most this often. */
export const WEEK_AHEAD_DRIFT_MIN_MS = 4 * 60 * 60 * 1000;
/** A drift-only change re-asks the insight generator at most this often. */
export const INSIGHT_DRIFT_MIN_MS = 3 * 60 * 60 * 1000;
/** A failed insight ask holds the door on the SAME inputs for this long. */
export const INSIGHT_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

// A fact query that fails (an interrupted migration, a column not yet added) must not
// read as "unchanged" — that is the direction that hides a change. It falls back to the
// table's own coarse odometer (row count + high-water rowid), which still sees every
// insert and delete; only when even that fails is it a fixed token.
function coarse(table: string): string {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(rowid),0) AS m FROM ${table}`).get() as any;
    return `coarse:${r?.n ?? 0}:${r?.m ?? 0}`;
  } catch {
    return "unavailable";
  }
}

function rows(table: string, sql: string, ...params: unknown[]): unknown {
  try {
    return db.prepare(sql).all(...(params as any[]));
  } catch {
    return coarse(table);
  }
}

function one(table: string, sql: string, ...params: unknown[]): unknown {
  try {
    return db.prepare(sql).get(...(params as any[])) ?? null;
  } catch {
    return coarse(table);
  }
}

// The profile row by VALUE, minus the two columns that move without the picture
// moving: updated_at (bookkeeping) and weight_lb (every weigh-in writes it; the
// weigh-in itself is a DRIFT input below). A new profile column is covered the day it
// is added — the safe direction for a gate whose failure mode is hiding a change.
const PROFILE_DRIFT_COLUMNS = new Set(["updated_at", "weight_lb"]);

function profileMaterial(): unknown {
  const row = one("profile", `SELECT * FROM profile WHERE id = 1`);
  if (!row || typeof row !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (!PROFILE_DRIFT_COLUMNS.has(k)) out[k] = v;
  }
  return out;
}

function settingsMaterial(): unknown {
  // Only the settings a coaching read is shaped by: the athlete's stated posture, the
  // autonomy stance, and the units its prose is written in. Agent routing, sync
  // cursors and credentials are not the athlete's picture.
  return one("settings", `SELECT training_drive, lead_mode, run_units, weight_units FROM settings WHERE id = 1`);
}

/**
 * The training/recovery/life facts both reads treat as MATERIAL. `date` is the read
 * day (device zone); windows are inclusive and anchored to it, so they move only when
 * the day does.
 */
function sharedMaterial(date: string): Record<string, unknown> {
  const d = String(date).slice(0, 10);
  const from14 = addDaysISO(d, -13) ?? d;
  const from7 = addDaysISO(d, -6) ?? d;
  const from2 = addDaysISO(d, -2) ?? d;
  const ahead14 = addDaysISO(d, 14) ?? d;
  return {
    date: d,
    profile: profileMaterial(),
    settings: settingsMaterial(),
    // The plan and every target on it — an earned load step IS a changed plan.
    plan_days: rows("plan_days", `SELECT id, day_number, name, focus, day_type FROM plan_days ORDER BY id`),
    plan_items: rows(
      "plan_items",
      `SELECT id, plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, target_seconds,
              warmup_sets, kind, target_distance_km, target_duration_min, target_zone, interval_json,
              superset_group, note
         FROM plan_items ORDER BY id`
    ),
    plan_exercises: rows(
      "exercises",
      `SELECT id, name, mode, muscle_group, per_side FROM exercises
        WHERE id IN (SELECT exercise_id FROM plan_items) ORDER BY id`
    ),
    blocks: rows(
      "program_blocks",
      `SELECT id, goal, focus, phase, week_index, total_weeks, started_at, status FROM program_blocks ORDER BY id`
    ),
    objectives: rows(
      "strength_objectives",
      `SELECT id, exercise_key, target_kind, status, superseded_at, completed_at, achieved_date
         FROM strength_objectives ORDER BY id`
    ),
    phases: rows(
      "journey_phases",
      `SELECT id, kind, start_date, end_date, target_weight_lb, target_bodyfat_pct, planned_rate_lb_wk, status
         FROM journey_phases ORDER BY id`
    ),
    // A session counts once it is DONE (finished, or a past day's left open): its sets,
    // load and the athlete's felt ratings. Today's session still in progress is drift.
    sessions: rows(
      "sessions",
      `SELECT s.id, s.date, s.plan_day_id, s.kind, s.soreness, s.performance, s.joint_pain,
              (SELECT COUNT(*) FROM logged_sets ls WHERE ls.session_id = s.id) AS sets,
              (SELECT TOTAL(COALESCE(ls.weight,0) * COALESCE(ls.reps,0) + COALESCE(ls.duration_sec,0))
                 FROM logged_sets ls WHERE ls.session_id = s.id) AS work
         FROM sessions s
        WHERE s.date >= ? AND s.date <= ? AND (s.finished_at IS NOT NULL OR s.date < ?)
        ORDER BY s.id`,
      from14,
      d,
      d
    ),
    // Runs, rides and every other logged effort — by value (rounded the way a re-sync
    // that recomputes a decimal does not move it), never by synced_at.
    activities: rows(
      "activities",
      `SELECT id, date, type, ROUND(COALESCE(duration_min,0)) AS min, ROUND(COALESCE(distance_km,0), 1) AS km, rpe
         FROM activities WHERE date >= ? AND date <= ? ORDER BY id`,
      from14,
      d
    ),
    garmin_activities: rows(
      "garmin_activities",
      `SELECT id, date, type, ROUND(COALESCE(duration_min,0)) AS min, ROUND(COALESCE(distance_km,0), 1) AS km, session_id
         FROM garmin_activities WHERE date >= ? AND date <= ? ORDER BY id`,
      from14,
      d
    ),
    // Nights of sleep. Rows are dated by the WAKE day, so a night arriving for the read
    // day is a new row value here; a mid-day sync that rewrites the same night is not.
    // A day row that carries no night yet (the first sync after midnight writes today's
    // steps) is not a night and is left out until one lands on it.
    garmin_nights: rows(
      "garmin_daily_metrics",
      `SELECT date, sleep_min, hrv_ms, hrv_status,
              CASE WHEN date < ? THEN resting_hr ELSE resting_hr IS NOT NULL END AS rhr,
              training_readiness IS NOT NULL AS readiness_in
         FROM garmin_daily_metrics
        WHERE date >= ? AND date <= ?
          AND (sleep_min IS NOT NULL OR hrv_ms IS NOT NULL OR (date < ? AND resting_hr IS NOT NULL))
        ORDER BY source_id, date`,
      d,
      from2,
      d,
      d
    ),
    nights: rows(
      "daily_metrics",
      `SELECT source, date, sleep_min, hrv_ms,
              CASE WHEN date < ? THEN resting_hr ELSE resting_hr IS NOT NULL END AS rhr
         FROM daily_metrics
        WHERE date >= ? AND date <= ?
          AND (sleep_min IS NOT NULL OR hrv_ms IS NOT NULL OR (date < ? AND resting_hr IS NOT NULL))
        ORDER BY source, date`,
      d,
      from2,
      d,
      d
    ),
    checkins: rows(
      "checkins",
      `SELECT id, date, mood, energy, sleep_feel, soreness FROM checkins WHERE date >= ? AND date <= ? ORDER BY id`,
      from7,
      d
    ),
    symptoms: rows(
      "training_symptom_events",
      `SELECT id, area_text, status, scope, onset_on, last_reported_on, resolved_on, recurrence_count, legacy_unconfirmed
         FROM training_symptom_events
        WHERE resolved_on IS NULL OR resolved_on >= ?
        ORDER BY id`,
      from14
    ),
    symptom_reports: one("symptom_reports", `SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m FROM symptom_reports`),
    // Life context in force around the window: an injury, a trip, an illness — added,
    // re-dated, archived or resolved.
    context: rows(
      "context_events",
      `SELECT id, kind, title, detail, start_date, end_date, archived, resolved_at, expected_recovery_days, meta_json
         FROM context_events
        WHERE (end_date IS NULL OR end_date >= ?) AND (start_date IS NULL OR start_date <= ?)
        ORDER BY id`,
      from14,
      ahead14
    ),
    directives: rows(
      "health_directives",
      `SELECT id, status, domain, directive_key, uncertain, trigger_date FROM health_directives
        WHERE status != 'dismissed' ORDER BY id`
    ),
    labs: one("health_documents", `SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m FROM health_documents`),
  };
}

function sharedDrift(date: string): Record<string, unknown> {
  const d = String(date).slice(0, 10);
  return {
    weight: one("bodyweight_log", `SELECT id, date, weight_lb FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT 1`),
    training_status: rows(
      "garmin_daily_metrics",
      `SELECT source_id, training_status FROM garmin_daily_metrics
        WHERE date = ? AND training_status IS NOT NULL ORDER BY source_id`,
      d
    ),
    open_session: rows(
      "sessions",
      `SELECT s.id, s.plan_day_id, (SELECT COUNT(*) FROM logged_sets ls WHERE ls.session_id = s.id) AS sets
         FROM sessions s WHERE s.date = ? AND s.finished_at IS NULL ORDER BY s.id`,
      d
    ),
    composition: rows(
      "daily_session_compositions",
      `SELECT id, status, plan_day_id, session_id FROM daily_session_compositions
        WHERE date = ? AND superseded_at IS NULL ORDER BY id`,
      d
    ),
    outcome: rows(
      "daily_session_outcomes",
      `SELECT id, status FROM daily_session_outcomes WHERE date = ? ORDER BY id`,
      d
    ),
  };
}

/** The week-ahead MATERIAL fingerprint alone (it is part of the cache key). */
export function weekAheadMaterialFingerprint(date: string): string {
  return fingerprint({ op: "week_ahead", v: 1, ...sharedMaterial(date) });
}

/** The week-ahead DRIFT fingerprint alone (it rides in the cached answer). */
export function weekAheadDriftInputs(date: string): string {
  return fingerprint({ op: "week_ahead", v: 1, ...sharedDrift(date) });
}

/**
 * The connection pass's DATA fingerprints. Its material set is the shared one plus the
 * fuel and body facts it reads (targets, supplements, measurements); the day's food log
 * is drift — a meal logged moves it, an unchanged day does not. The said-corpus (what
 * the generator already said and the territory it covered) is folded in by the caller,
 * AFTER a run, so the generator's own new insight never reads as news to itself.
 */
export function insightDataInputs(date: string): RefreshInputs {
  const d = String(date).slice(0, 10);
  const from7 = addDaysISO(d, -6) ?? d;
  return {
    material: fingerprint({
      op: "insight",
      v: 1,
      ...sharedMaterial(d),
      targets: rows(
        "nutrition_targets",
        `SELECT id, effective_date, target_kcal, protein_g, carbs_g, fat_g FROM nutrition_targets ORDER BY id DESC LIMIT 5`
      ),
      supplements: rows("supplements", `SELECT id, name, dose, frequency, active FROM supplements ORDER BY id`),
      measurements: one("body_measurements", `SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m FROM body_measurements`),
    }),
    drift: fingerprint({
      op: "insight",
      v: 1,
      ...sharedDrift(d),
      food: rows(
        "food_notes",
        `SELECT date, COUNT(*) AS n, COALESCE(MAX(id),0) AS m, COALESCE(MAX(person_edited_at),'') AS e,
                SUM(CASE WHEN parsed_json IS NOT NULL THEN 1 ELSE 0 END) AS parsed
           FROM food_notes WHERE date >= ? AND date <= ? GROUP BY date ORDER BY date`,
        from7,
        d
      ),
    }),
  };
}

/** The generator's dedupe floor, as one fingerprint (what was said + covered territory). */
export function insightCorpusFingerprint(recent: string[], keys: string[]): string {
  return fingerprint({
    recent: [...recent].map((t) => String(t).trim().toLowerCase()).sort(),
    keys: [...keys].map((k) => String(k).trim()).sort(),
  });
}

export type RefreshVerdict =
  | { refresh: false; reason: "unchanged" | "drift_deferred" | "failure_backoff" }
  | { refresh: true; reason: "first" | "material" | "drift" | "retry" | "expired" };

export interface RefreshAnswer {
  material: string;
  drift: string;
  /** Epoch ms the answer was computed from these inputs. */
  at: number;
  /** answered = the generator ran and said something (or calmly found nothing). */
  outcome: "answered" | "failed";
}

/**
 * THE rule, shared by both ops. A material move always refreshes; a drift-only move
 * refreshes once the last answer is older than `driftMinMs`; identical inputs never
 * re-ask. A FAILED answer holds the door on the same inputs for `failureBackoffMs`
 * (a broken CLI is not asked again on every signal), but never against a material move.
 */
export function refreshVerdict(
  prev: RefreshAnswer | null,
  cur: RefreshInputs,
  opts: { driftMinMs: number; failureBackoffMs?: number; now?: number }
): RefreshVerdict {
  if (!prev) return { refresh: true, reason: "first" };
  if (prev.material !== cur.material) return { refresh: true, reason: "material" };
  const now = opts.now ?? Date.now();
  const age = Number.isFinite(prev.at) ? now - prev.at : Number.POSITIVE_INFINITY;
  if (prev.outcome === "failed") {
    const backoff = opts.failureBackoffMs ?? 0;
    return age >= backoff ? { refresh: true, reason: "retry" } : { refresh: false, reason: "failure_backoff" };
  }
  if (prev.drift === cur.drift) return { refresh: false, reason: "unchanged" };
  return age >= opts.driftMinMs ? { refresh: true, reason: "drift" } : { refresh: false, reason: "drift_deferred" };
}

// ---------- observability (in-process; never writes) ----------
type GateCounts = {
  skipped_unchanged: number;
  drift_deferred: number;
  failure_backoff: number;
  refreshed_first: number;
  refreshed_material: number;
  refreshed_drift: number;
  refreshed_retry: number;
  refreshed_expired: number;
};

function emptyCounts(): GateCounts {
  return {
    skipped_unchanged: 0,
    drift_deferred: 0,
    failure_backoff: 0,
    refreshed_first: 0,
    refreshed_material: 0,
    refreshed_drift: 0,
    refreshed_retry: 0,
    refreshed_expired: 0,
  };
}

const counts: Record<RefreshGateOp, GateCounts> = { week_ahead: emptyCounts(), insight: emptyCounts() };
const countingSince = new Date().toISOString();

/** Count one gate decision. */
export function noteRefreshVerdict(op: RefreshGateOp, verdict: RefreshVerdict): void {
  const c = counts[op];
  if (!c) return;
  switch (verdict.reason) {
    case "unchanged":
      c.skipped_unchanged++;
      break;
    case "drift_deferred":
      c.drift_deferred++;
      break;
    case "failure_backoff":
      c.failure_backoff++;
      break;
    case "first":
      c.refreshed_first++;
      break;
    case "material":
      c.refreshed_material++;
      break;
    case "drift":
      c.refreshed_drift++;
      break;
    case "retry":
      c.refreshed_retry++;
      break;
    case "expired":
      c.refreshed_expired++;
      break;
  }
}

// The week-ahead is consulted on every Today open, so "how many opens found it fresh"
// would count opens, not saved runs. What it counts instead is the counterfactual the
// gate replaced: each DISTINCT input state the previous rule (a key over the in-process
// training counter and the whole training backstop) would have spent a run on, but
// which this gate served from the answer already on hand.
const weekAheadLegacySeen = new Set<string>();

/** The week-ahead answered under `legacyKey` (a run just landed) — not a skip. */
export function noteWeekAheadLegacyComputed(legacyKey: string): void {
  if (!legacyKey) return;
  if (weekAheadLegacySeen.size > 500) weekAheadLegacySeen.clear();
  weekAheadLegacySeen.add(legacyKey);
}

/** A fresh/deferred serve under `legacyKey`: one skip the first time that state is seen. */
export function noteWeekAheadServedWithoutRun(legacyKey: string, reason: "unchanged" | "drift_deferred"): void {
  if (!legacyKey || weekAheadLegacySeen.has(legacyKey)) return;
  noteWeekAheadLegacyComputed(legacyKey);
  noteRefreshVerdict("week_ahead", { refresh: false, reason });
}

export function refreshGateStats(): { since: string } & Record<RefreshGateOp, GateCounts> {
  return {
    since: countingSince,
    week_ahead: { ...counts.week_ahead },
    insight: { ...counts.insight },
  };
}

/** Test seam: zero the in-process counters. */
export function resetRefreshGateStats(): void {
  counts.week_ahead = emptyCounts();
  counts.insight = emptyCounts();
  weekAheadLegacySeen.clear();
}
