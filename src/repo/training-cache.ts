// In-process invalidation signals for the deterministic TRAINING-read memos —
// getProgramState (repo/program-state.ts), getWeeklyStats (repo/sessions.ts) and
// estimateExpenditure (repo/expenditure.ts). This is the training-side twin of
// marker-cache.ts, and it exists for the same reason: those three reads are heavy
// (getProgramState alone fans out into ~100–200 synchronous queries — an N+1 over
// every distinct exercise, each an unbounded full-history est-1RM scan) and get
// recomputed several times per page render.
//
// It lives in its own LEAF module (imports nothing from the repo) so the many
// write-path modules — sessions / activities / plan / exercises / program-blocks /
// coach / profile / health(context) / nutrition(food) — can all bump the same
// counter without dragging a circular import into the memo modules.
//
// TWO signals, because the frequencies differ:
//   • trainingDataVersion — the strength/cardio/recovery/body/plan/context write
//     counter, folded into every training memo's key. Bumped by every write that
//     can shift a program/weekly/expenditure read (the fast, exact path).
//   • foodDataVersion — food-note writes only. estimateExpenditure keys on BOTH;
//     getProgramState / getWeeklyStats key on trainingDataVersion alone. Kept apart
//     because food is logged many times a day and must NOT invalidate the expensive
//     program-state memo (which never reads food notes).
//
// Each memo also folds in a cheap SQL row-count/max-id BACKSTOP (in its own module)
// so an out-of-band write that bypasses these counters — a DB restore/import, or the
// per-test table wipe — is still detected.
//
// test/_isolate.mjs wipes every table directly before EVERY test (bypassing these
// write paths) and rowids can COLLIDE across a wipe, so a same-shape next test could
// otherwise land on a colliding key and read a prior test's cached value. The isolate
// therefore calls resetTrainingDataCache(), which resets BOTH counters to 0 and drops
// every registered memo — a fresh-floor test never sees a prior test's training reads.

import { db } from "../db.js";

let trainingDataVersion = 0;
let foodDataVersion = 0;
let coachContextVersion = 0;

// Memo modules register a "drop my cached value" callback so the reset entry point
// (and the test isolate through it) can clear every training memo in one call.
const cacheClears: Array<() => void> = [];

export function bumpTrainingDataVersion(): void {
  trainingDataVersion++;
}

export function currentTrainingDataVersion(): number {
  return trainingDataVersion;
}

export function bumpFoodDataVersion(): void {
  foodDataVersion++;
}

export function currentFoodDataVersion(): number {
  return foodDataVersion;
}

/**
 * The manual escape hatch for the coach-context memo. The SQL backstop below sees every
 * insert, delete and update to the tables the context reads, so almost nothing needs
 * this — it is here for a coach input that lives OUTSIDE those tables (an in-process
 * model, a file on disk) and for a writer that wants to force a rebuild explicitly.
 */
export function bumpCoachContextVersion(): void {
  coachContextVersion++;
}

export function currentCoachContextVersion(): number {
  return coachContextVersion;
}

export function registerTrainingCacheClear(clear: () => void): void {
  cacheClears.push(clear);
}

// The BACKSTOP for the whole-coach-context memo (repo/coach.ts) — the same shape as
// trainingBackstopSignature below, over the much wider table set that ONE
// getCoachContext() build reads: training, endurance, nutrition, health, symptoms,
// life context, and the brain's own ledger.
//
// It is a CURATED list rather than "every table" on purpose. SQLite's own row-change
// odometer (`total_changes()`) looks like the perfect universal signal — it cannot miss
// a write, because SQLite counts it rather than us — until it is measured: the
// request-metric histogram and the diagnostic-event sink both write on EVERY request,
// so the odometer advances between any two reads and a memo keyed on it never hits
// once. The question that matters is not "did the database change" but "did anything
// the COACH READS change". The tables left out below — telemetry, request metrics,
// agent jobs/runs, chat rows, art, DICOM, idempotency keys, scheduler heartbeats, the
// AI cache — are bookkeeping this context never consults.
//
// COUNT catches deletes, MAX(rowid) catches inserts, and the two single-row tables are
// compared by VALUE because they are updated in place — the WHOLE row, so a new profile
// or settings column is covered the day it is added rather than the day someone
// remembers to add it here. Over-invalidation only ever costs a rebuild, and the memo's
// short TTL is the last backstop under all of it.
//
// UPDATES are the case COUNT + MAX(rowid) is blind to, and this context is full of
// them: a symptom resolved, a suggestion dismissed, a directive flipped, a session
// finished, a draft applied, a family member edited. `MAX(updated_at)` covers the
// tables that carry the column, but most of these do not — and asking every writer to
// remember a counter is precisely the failure mode this signature exists to avoid. So
// SQLite counts the updates for us: one TEMP trigger per covered table, incrementing a
// TEMP row. Temp objects live on this connection only — no schema change, no migration,
// nothing persisted — and they fire only on UPDATE, so the bookkeeping tables that made
// `total_changes()` useless are still out of the picture.
const COACH_CONTEXT_TABLES = [
  "activities", "attention_schedule", "belief_dispositions", "blood_pressure_readings",
  "body_measurements", "bodyweight_log", "brain_decisions", "brain_evaluations",
  "brain_expectations", "brain_rollbacks", "calibration_events", "checkins", "context_events",
  "daily_metrics", "daily_session_compositions", "daily_session_decisions",
  "daily_session_outcomes", "day_reads", "exercise_aliases", "exercises", "food_notes",
  "fueling_feedback", "garmin_activities", "garmin_daily_metrics", "health_directives",
  "health_documents", "health_reviews", "hr_model_state", "insights", "journey_phases",
  "logged_sets", "marker_aliases", "meal_plans", "memory", "movement_tolerance_observations",
  "nutrition_targets", "plan_days", "plan_items", "plan_proposals", "program_blocks",
  "recovery_cycles", "session_skips", "sessions", "strength_objectives", "suggestions",
  "supplements", "surface_dismissals", "symptom_reports", "training_symptom_events",
  "family_members",
] as const;

type CoachContextBackstopStatements = {
  counts: ReturnType<typeof db.prepare>;
  profile: ReturnType<typeof db.prepare>;
  settings: ReturnType<typeof db.prepare>;
  /** The TEMP update odometer — null only if this SQLite refused the temp objects. */
  updates: ReturnType<typeof db.prepare> | null;
};
let coachContextBackstop: CoachContextBackstopStatements | null = null;

const COACH_CONTEXT_UPDATE_TABLE = "_cairn_coach_ctx_updates";

/** Does `table` carry an `updated_at` column? Asked once, at prepare time. */
function hasUpdatedAt(table: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return cols.some((c) => c?.name === "updated_at");
  } catch {
    return false;
  }
}

/**
 * One TEMP counter row plus an AFTER UPDATE trigger on each covered table. Returns the
 * statement that reads the counter, or null if any of it failed — in which case the
 * signature falls back to a never-matching key rather than serving a stale build.
 */
function installCoachContextUpdateOdometer(): ReturnType<typeof db.prepare> | null {
  try {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${COACH_CONTEXT_UPDATE_TABLE} (n INTEGER NOT NULL)`);
    const seeded = db.prepare(`SELECT COUNT(*) AS c FROM ${COACH_CONTEXT_UPDATE_TABLE}`).get() as any;
    if (!seeded?.c) db.exec(`INSERT INTO ${COACH_CONTEXT_UPDATE_TABLE} (n) VALUES (0)`);
    for (const t of COACH_CONTEXT_TABLES) {
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS _cairn_coach_ctx_u_${t} AFTER UPDATE ON ${t}
         BEGIN UPDATE ${COACH_CONTEXT_UPDATE_TABLE} SET n = n + 1; END`
      );
    }
    return db.prepare(`SELECT n FROM ${COACH_CONTEXT_UPDATE_TABLE}`);
  } catch {
    return null;
  }
}

// Prepared LAZILY, not at module load: db.ts runs its CREATE TABLEs and migrations on
// import, and a statement naming these tables must not compile before they exist.
// Prepared ONCE, because this runs on every getCoachContext call including the hits.
function coachContextBackstopStatements(): CoachContextBackstopStatements {
  if (!coachContextBackstop) {
    coachContextBackstop = {
      counts: db.prepare(
        `SELECT ${COACH_CONTEXT_TABLES.map((t, i) => {
          const cols = [`(SELECT COUNT(*) FROM ${t}) AS c${i}`, `(SELECT COALESCE(MAX(rowid),0) FROM ${t}) AS m${i}`];
          // Cheap and exact where it exists; the trigger odometer covers the rest.
          if (hasUpdatedAt(t)) cols.push(`(SELECT COALESCE(MAX(updated_at),'') FROM ${t}) AS u${i}`);
          return cols.join(", ");
        }).join(", ")}`
      ),
      profile: db.prepare(`SELECT * FROM profile WHERE id = 1`),
      settings: db.prepare(`SELECT * FROM settings WHERE id = 1`),
      updates: installCoachContextUpdateOdometer(),
    };
  }
  return coachContextBackstop;
}

export function coachContextBackstopSignature(): string {
  try {
    const prepared = coachContextBackstopStatements();
    if (!prepared.updates) return `nocoach:${Math.random()}`; // no update odometer → never memoize
    const updates = (prepared.updates.get() as any)?.n ?? null;
    if (updates === null) return `nocoach:${Math.random()}`;
    return [
      currentTrainingDataVersion(),
      currentFoodDataVersion(),
      currentCoachContextVersion(),
      updates,
      Object.values(prepared.counts.get() as Record<string, number>).join(","),
      JSON.stringify(prepared.profile.get() ?? {}),
      JSON.stringify(prepared.settings.get() ?? {}),
    ].join("|");
  } catch {
    return `nocoach:${Math.random()}`; // never-matching: rebuild rather than risk staleness
  }
}

// Full reset — resets both counters and clears every registered memo. Exported and
// called from test/_isolate.mjs (which wipes tables out-of-band before each test).
export function resetTrainingDataCache(): void {
  trainingDataVersion = 0;
  foodDataVersion = 0;
  coachContextVersion = 0;
  for (const clear of cacheClears) clear();
}

// Cheap SQL BACKSTOP for the training memos: row COUNT + MAX(id) of every table that
// feeds getProgramState / getWeeklyStats / estimateExpenditure (COUNT catches deletes,
// MAX(id) catches inserts), plus the handful of profile fields those reads personalize
// on (weight/goal/sex/age — updated in place, so a count/max can't see them). A
// superset for any single memo, which only ever over-invalidates (an extra recompute),
// never serves stale data. A query failure yields a never-matching key so we rebuild
// rather than risk staleness. Runs ONCE per memoized call, replacing 100s of queries
// on a hit — negligible next to what it guards.
export function trainingBackstopSignature(): string {
  try {
    const r = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM logged_sets) AS lsc, (SELECT COALESCE(MAX(id),0) FROM logged_sets) AS lsm,
           (SELECT COUNT(*) FROM sessions) AS sc, (SELECT COALESCE(MAX(id),0) FROM sessions) AS sm,
           (SELECT COUNT(*) FROM exercises) AS ec, (SELECT COALESCE(MAX(id),0) FROM exercises) AS em,
           (SELECT COUNT(*) FROM activities) AS ac, (SELECT COALESCE(MAX(id),0) FROM activities) AS am,
           (SELECT COUNT(*) FROM garmin_activities) AS gac, (SELECT COALESCE(MAX(id),0) FROM garmin_activities) AS gam,
           (SELECT COUNT(*) FROM bodyweight_log) AS bwc, (SELECT COALESCE(MAX(id),0) FROM bodyweight_log) AS bwm,
           (SELECT COUNT(*) FROM daily_metrics) AS dmc, (SELECT COALESCE(MAX(id),0) FROM daily_metrics) AS dmm,
           (SELECT COUNT(*) FROM garmin_daily_metrics) AS gdc, (SELECT COALESCE(MAX(id),0) FROM garmin_daily_metrics) AS gdm,
           (SELECT COUNT(*) FROM plan_days) AS pdc, (SELECT COALESCE(MAX(id),0) FROM plan_days) AS pdm,
           (SELECT COUNT(*) FROM plan_items) AS pic, (SELECT COALESCE(MAX(id),0) FROM plan_items) AS pim,
           (SELECT COUNT(*) FROM context_events) AS cec, (SELECT COALESCE(MAX(id),0) FROM context_events) AS cem`,
      )
      .get() as any;
    const p = db
      .prepare(`SELECT weight_lb, height_cm, activity_factor, measured_rmr_kcal, measured_rmr_date,
                       goal_weight_lb, goal_date, goal_mode, sex, age
                  FROM profile WHERE id = 1`)
      .get() as any;
    return [
      currentTrainingDataVersion(),
      r?.lsc, r?.lsm, r?.sc, r?.sm, r?.ec, r?.em, r?.ac, r?.am, r?.gac, r?.gam,
      r?.bwc, r?.bwm, r?.dmc, r?.dmm, r?.gdc, r?.gdm, r?.pdc, r?.pdm, r?.pic, r?.pim, r?.cec, r?.cem,
      p?.weight_lb ?? "", p?.height_cm ?? "", p?.activity_factor ?? "", p?.measured_rmr_kcal ?? "",
      p?.measured_rmr_date ?? "", p?.goal_weight_lb ?? "", p?.goal_date ?? "", p?.goal_mode ?? "",
      p?.sex ?? "", p?.age ?? "",
    ].join("|");
  } catch {
    return `nocache:${currentTrainingDataVersion()}:${Math.random()}`;
  }
}

// Food-note backstop for estimateExpenditure only (COUNT + MAX(id) of food_notes).
// estimateExpenditure folds this together with the training backstop, since it reads
// bodyweight/profile/context (training) AND food notes.
export function foodBackstopSignature(): string {
  try {
    const r = db
      .prepare(`SELECT COUNT(*) AS c, COALESCE(MAX(id),0) AS m FROM food_notes`)
      .get() as any;
    return `${currentFoodDataVersion()}|${r?.c ?? 0}|${r?.m ?? 0}`;
  } catch {
    return `nofood:${currentFoodDataVersion()}:${Math.random()}`;
  }
}
