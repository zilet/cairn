// Cairn's own strength shells, taken back OUT of Garmin's day energy
// (repo/garmin-shell-energy.ts). Garmin adds each MANUAL activity's calories above
// resting to the day's `burnedKilocalories`, and so to active and total kcal. Cairn
// prices its shells with its own estimate — so reading those totals verbatim would feed
// Cairn's estimate back into Cairn's TDEE. THE LAW: it never does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldCairnShellEnergy, foldDailySummary } from "../dist/garmin.js";
import { cairnShellOwnedKcal } from "../dist/repo/garmin-shell-energy.js";
import { db, repo, isoDaysAgo } from "./_seed.js";

const FULL_DAY_BMR = 1925;
const RATE = FULL_DAY_BMR / 1440;

function seedShell(date, kcal, minutes = 32, id = `shell-${date}`) {
  return repo.upsertGarminActivity({
    external_id: id,
    date,
    start_time: `${date}T07:30:00`,
    type: "strength_training",
    name: "Pull · Cairn",
    duration_min: minutes,
    raw: { activityId: id, activityName: "Pull · Cairn", duration: minutes * 60, calories: kcal, manualActivity: true },
  });
}

function fold(date, summary) {
  const m = { date };
  foldDailySummary(summary, m);
  foldCairnShellEnergy(summary, m);
  return m;
}

function stored(date) {
  return db
    .prepare(
      `SELECT active_calories, total_calories, cairn_shell_kcal, burned_calories, wellness_active_calories
         FROM garmin_daily_metrics WHERE date = ?`
    )
    .get(date);
}

// Garmin charges a manual activity at the FULL-day BMR rate even on today's partial
// summary; today borrows the latest finished day's stored BMR.
function seedFinishedDayBmr(daysAgo = 1) {
  repo.upsertGarminDailyMetric({ date: isoDaysAgo(daysAgo), bmr_calories: FULL_DAY_BMR });
}

test("the verified live day: a 194 kcal / 32 min shell comes back out of active and total", () => {
  const today = isoDaysAgo(0);
  seedFinishedDayBmr();
  seedShell(today, 194, 32);
  // The athlete's real summary (partial day): active = wellnessActive + burned,
  // total = bmr + active.
  const summary = {
    activeKilocalories: 513,
    wellnessActiveKilocalories: 362,
    burnedKilocalories: 151,
    totalKilocalories: 1832,
    bmrKilocalories: 1319,
  };
  const m = fold(today, summary);
  assert.equal(m.active_calories, 362);
  assert.equal(m.total_calories, 1681);
  assert.equal(m.cairn_shell_kcal, 151);
  assert.equal(m.burned_calories, 151);
  assert.equal(m.wellness_active_calories, 362);

  repo.upsertGarminDailyMetrics([m]);
  // Idempotent: every re-sync recomputes from the RAW summary, never subtracting again.
  repo.upsertGarminDailyMetrics([fold(today, summary)]);
  repo.upsertGarminDailyMetrics([fold(today, summary)]);
  assert.deepEqual(
    { ...stored(today) },
    {
      active_calories: 362,
      total_calories: 1681,
      cairn_shell_kcal: 151,
      burned_calories: 151,
      wellness_active_calories: 362,
    }
  );
});

test("a day the athlete also hand-entered an activity keeps THEIR energy and drops only ours", () => {
  const date = isoDaysAgo(3);
  seedShell(date, 194, 32);
  repo.upsertGarminActivity({
    external_id: "yoga-1",
    date,
    type: "yoga",
    name: "Evening yoga",
    duration_min: 60,
    raw: { activityId: "yoga-1", activityName: "Evening yoga", duration: 3600, calories: 200, manualActivity: true },
  });
  // A watch recording is inside wellnessActive, never in burned, and is not "manual".
  repo.upsertGarminActivity({
    external_id: "run-1",
    date,
    type: "running",
    name: "Morning Run",
    duration_min: 40,
    raw: { activityId: "run-1", activityName: "Morning Run", duration: 2400, calories: 420, manualActivity: false },
  });
  const ours = 194 - RATE * 32;
  const theirs = 200 - RATE * 60;
  const burned = Math.round(ours + theirs);
  const summary = {
    activeKilocalories: 900 + burned,
    wellnessActiveKilocalories: 900,
    burnedKilocalories: burned,
    totalKilocalories: FULL_DAY_BMR + 900 + burned,
    bmrKilocalories: FULL_DAY_BMR,
  };
  const m = fold(date, summary);
  assert.equal(m.cairn_shell_kcal, Math.round(ours * 10) / 10);
  assert.equal(m.active_calories, Math.round((900 + burned - ours) * 10) / 10);
  assert.ok(m.active_calories > 900, "the athlete's own yoga stays in the day");
});

test("a Garmin day that does not add up never leaves Cairn below what the watch measured", () => {
  // Live 2026-09-23: active 201 against wellness 46 + burned 160, a 304 kcal / 108 min
  // shell (share 159.6). Subtracting it all would read 41.4 — under the watch's 46.
  const date = isoDaysAgo(2);
  seedShell(date, 304, 108);
  const m = fold(date, {
    activeKilocalories: 201,
    wellnessActiveKilocalories: 46,
    burnedKilocalories: 160,
    totalKilocalories: 2126,
    bmrKilocalories: FULL_DAY_BMR,
  });
  assert.equal(m.active_calories, 46);
  assert.equal(m.total_calories, 1971);
  assert.equal(m.cairn_shell_kcal, 155);
});

test("no Cairn shell on the date: the totals are Garmin's own, stamped zero", () => {
  const date = isoDaysAgo(2);
  const m = fold(date, {
    activeKilocalories: 600,
    wellnessActiveKilocalories: 600,
    burnedKilocalories: 0,
    totalKilocalories: 2525,
    bmrKilocalories: FULL_DAY_BMR,
  });
  assert.equal(m.active_calories, 600);
  assert.equal(m.total_calories, 2525);
  assert.equal(m.cairn_shell_kcal, 0);
});

test("the pure rule: our share is the BMR formula, capped at burned and active — never all of burned", () => {
  const shell = { kcal: 194, duration_min: 32 };
  const ours = Math.round((194 - RATE * 32) * 10) / 10;
  assert.equal(ours, 151.2, "live-verified: 194 kcal / 32 min at bmr 1925 → 151");
  assert.equal(cairnShellOwnedKcal({ burned: null, active: 500, bmr_per_min: RATE, shells: [shell] }), ours);
  // burned also carries non-watch energy that is not ours: only our share comes out.
  assert.equal(cairnShellOwnedKcal({ burned: 351, active: 800, bmr_per_min: RATE, shells: [shell] }), ours);
  // Never more than burned, never more than active.
  assert.equal(cairnShellOwnedKcal({ burned: 40, active: 800, bmr_per_min: RATE, shells: [shell] }), 40);
  assert.equal(cairnShellOwnedKcal({ burned: 300, active: 120, bmr_per_min: RATE, shells: [shell] }), 120);
  // No full-day rate, or a shell with no calories on record → cannot be told.
  assert.equal(cairnShellOwnedKcal({ burned: 151, active: 500, bmr_per_min: null, shells: [shell] }), null);
  assert.equal(
    cairnShellOwnedKcal({ burned: 151, active: 500, bmr_per_min: RATE, shells: [{ kcal: null, duration_min: 32 }] }),
    null
  );
  // No shell at all → nothing of ours.
  assert.equal(cairnShellOwnedKcal({ burned: 151, active: 500, bmr_per_min: null, shells: [] }), 0);
  // The placeholder era, live-verified: 65.534 over 31 minutes → 24 kcal above resting.
  assert.equal(
    Math.round(
      cairnShellOwnedKcal({
        burned: null,
        active: 500,
        bmr_per_min: RATE,
        shells: [{ kcal: 65.534, duration_min: 31 }],
      })
    ),
    24
  );
});

test("burned that also carries a non-manual, non-watch import keeps the athlete's 200", () => {
  const date = isoDaysAgo(3);
  seedShell(date, 194, 32);
  // An Edge / Zwift ride lands in burned but is not flagged manualActivity.
  repo.upsertGarminActivity({
    external_id: "zwift-1",
    date,
    type: "cycling",
    name: "Zwift - Watopia",
    duration_min: 45,
    raw: {
      activityId: "zwift-1",
      activityName: "Zwift - Watopia",
      duration: 2700,
      calories: 260,
      manualActivity: false,
    },
  });
  const summary = {
    activeKilocalories: 500 + 151 + 200,
    wellnessActiveKilocalories: 500,
    burnedKilocalories: 151 + 200,
    totalKilocalories: FULL_DAY_BMR + 500 + 351,
    bmrKilocalories: FULL_DAY_BMR,
  };
  const m = fold(date, summary);
  assert.equal(Math.round(m.cairn_shell_kcal), 151);
  assert.equal(Math.round(m.active_calories), 700, "wellness 500 + the athlete's own 200");
  assert.equal(Math.round(m.total_calories), FULL_DAY_BMR + 700);
});

test("the ledger's sent price outranks the stale placeholder the activity pass stored", () => {
  const date = isoDaysAgo(2);
  repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date });
  const session = repo.getSessionByDate(date);
  seedShell(date, 65.534, 32, "shell-ledger"); // the list payload still says 65.534
  repo.recordSessionGarminExport(session.id, {
    activity_id: "shell-ledger",
    source: "manual",
    fingerprint: "f",
    exported_at: new Date().toISOString(),
    mode: "create",
    calories_sent: 194, // but the PUT landed in the same sync
  });
  const m = fold(date, {
    activeKilocalories: 513,
    wellnessActiveKilocalories: 362,
    burnedKilocalories: 151,
    totalKilocalories: FULL_DAY_BMR + 513,
    bmrKilocalories: FULL_DAY_BMR,
  });
  assert.equal(m.cairn_shell_kcal, 151);
  assert.equal(m.active_calories, 362);
});

test("a shell day whose share cannot be told keeps the last NET values, never Garmin's gross", () => {
  const today = isoDaysAgo(0);
  seedFinishedDayBmr();
  seedShell(today, 194, 32);
  const summary = (burned) => ({
    activeKilocalories: 362 + burned,
    wellnessActiveKilocalories: 362,
    burnedKilocalories: burned,
    totalKilocalories: 1319 + 362 + burned,
    bmrKilocalories: 1319,
  });
  repo.upsertGarminDailyMetrics([fold(today, summary(151))]);
  assert.equal(stored(today).active_calories, 362);

  // The stored finished-day BMR is gone: no full-day rate, so the share is unknowable.
  db.prepare("UPDATE garmin_daily_metrics SET bmr_calories = NULL WHERE date < ?").run(today);
  const m = fold(today, summary(160));
  assert.equal(m.active_calories, undefined);
  assert.equal(m.total_calories, undefined);
  assert.equal(m.cairn_shell_kcal, undefined);
  repo.upsertGarminDailyMetrics([m]);
  const row = stored(today);
  assert.equal(row.active_calories, 362, "the net value stands");
  assert.equal(row.total_calories, 1681);
  assert.equal(row.cairn_shell_kcal, 151);
  assert.equal(row.burned_calories, 160, "the raw audit column still moves");
});

test("THE LAW: Cairn's expenditure prior is identical whether the shells carry 65.534 or our 194", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  const WELLNESS = 450;
  const summaryFor = (burned) => ({
    activeKilocalories: WELLNESS + burned,
    wellnessActiveKilocalories: WELLNESS,
    burnedKilocalories: burned,
    totalKilocalories: FULL_DAY_BMR + WELLNESS + burned,
    bmrKilocalories: FULL_DAY_BMR,
  });
  // A shell on every day of the window, so the shells WOULD move the median if they
  // leaked — the test is sensitive, not vacuous (see the control at the end).
  const syncWindow = (shellKcal, { neutralize = true } = {}) => {
    const burned = Math.round(Math.max(0, shellKcal - RATE * 32));
    const metrics = [];
    for (let i = 1; i <= 14; i++) {
      const date = isoDaysAgo(i);
      seedShell(date, shellKcal, 32);
      const m = { date };
      foldDailySummary(summaryFor(burned), m);
      if (neutralize) foldCairnShellEnergy(summaryFor(burned), m);
      metrics.push(m);
    }
    repo.upsertGarminDailyMetrics(metrics);
    return repo.estimateExpenditure(21);
  };

  const placeholder = syncWindow(65.534);
  const priced = syncWindow(194);

  assert.equal(placeholder.tdee_basis, "garmin_total_calories");
  assert.ok(placeholder.prior_tdee > 0);
  assert.equal(priced.prior_tdee, placeholder.prior_tdee, "our estimate never moves Cairn's TDEE");
  assert.equal(priced.tdee, placeholder.tdee);
  const day = stored(isoDaysAgo(4));
  assert.equal(day.total_calories, FULL_DAY_BMR + WELLNESS);
  assert.equal(day.active_calories, WELLNESS);
  assert.equal(day.cairn_shell_kcal, 151);

  // Control: stored verbatim (the old ingest), the same shells DO move the prior.
  const leaked = syncWindow(194, { neutralize: false });
  assert.notEqual(leaked.prior_tdee, placeholder.prior_tdee);
});
