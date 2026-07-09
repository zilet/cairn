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

export function registerTrainingCacheClear(clear: () => void): void {
  cacheClears.push(clear);
}

// Full reset — resets both counters and clears every registered memo. Exported and
// called from test/_isolate.mjs (which wipes tables out-of-band before each test).
export function resetTrainingDataCache(): void {
  trainingDataVersion = 0;
  foodDataVersion = 0;
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
      .prepare(`SELECT weight_lb, goal_weight_lb, goal_date, goal_mode, sex, age FROM profile WHERE id = 1`)
      .get() as any;
    return [
      currentTrainingDataVersion(),
      r?.lsc, r?.lsm, r?.sc, r?.sm, r?.ec, r?.em, r?.ac, r?.am, r?.gac, r?.gam,
      r?.bwc, r?.bwm, r?.dmc, r?.dmm, r?.gdc, r?.gdm, r?.pdc, r?.pdm, r?.pic, r?.pim, r?.cec, r?.cem,
      p?.weight_lb ?? "", p?.goal_weight_lb ?? "", p?.goal_date ?? "", p?.goal_mode ?? "", p?.sex ?? "", p?.age ?? "",
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
