// Cross-package seams found while integrating the elite round against the live
// snapshot (2026-09-23): a hard-effort label regex blind to Garmin's SNAKE_CASE, an HRV
// trend braking a morning whose own night was already back at the norm, a pull-up
// ladder logged at bodyweight missing from program state, and a two-month-old top set
// buying a heavier card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HARD_EFFORT } from "../dist/repo/heavy-load.js";
import { getProgramState } from "../dist/repo/program-state.js";
import { nextPrescription } from "../dist/repo/progression.js";
import { db, localDaysAgo, repo } from "./_seed.js";

test("Garmin's snake-case training labels read as hard efforts", () => {
  for (const label of ["LACTATE_THRESHOLD", "ANAEROBIC_CAPACITY", "VO2MAX", "TEMPO", "Tempo run"]) {
    assert.equal(HARD_EFFORT.label.test(label), true, label);
  }
  for (const label of ["AEROBIC_BASE", "RECOVERY", "Easy run", "Hills"]) {
    assert.equal(HARD_EFFORT.label.test(label), false, label);
  }
});

// The recovery input shape planningSignalState reads: a 7-day trend below the norm
// (delta) plus the verified nightly readings, newest first.
const trendDownWithNight = (date, lastNight) => ({
  baseline: { hrv: 60 },
  delta: { hrv: -9 },
  quality: { hrv_ms: { latest_date: date, source: "garmin", sample_count: 7, window_days: 14 } },
  verified: { hrv_ms: { readings: [{ date, value: lastNight }], latest_trustworthy_date: date } },
});

test("a dipping HRV trend whose own last night is back at the norm is context, not a brake", () => {
  const date = localDaysAgo(0);
  const recovered = repo.planningSignalState({ date, recovery: trendDownWithNight(date, 62) });
  const hrv = recovered.dimensions.recovery_capacity.evidence.find((item) => item.field === "hrv");
  assert.equal(hrv.direction, "caution", "the trend is still named");
  assert.equal(hrv.advice_only, true, "…but a night at the norm cannot be the reading that slows today");
  assert.equal(repo.hasFreshDecidingBrake(recovered.dimensions), false);

  const stillLow = repo.planningSignalState({ date, recovery: trendDownWithNight(date, 55) });
  const low = stillLow.dimensions.recovery_capacity.evidence.find((item) => item.field === "hrv");
  assert.equal(low.advice_only, undefined, "a night still under the norm keeps the brake's full standing");
  assert.equal(repo.hasFreshDecidingBrake(stillLow.dimensions), true);
});

test("a pull-up ladder logged purely at bodyweight is a trained lift in program state", () => {
  repo.logWeight(160, localDaysAgo(10));
  for (const daysAgo of [9, 5, 2]) {
    for (let set = 0; set < 3; set++) {
      repo.logSetByName({ date: localDaysAgo(daysAgo), exercise: "Pull-Up", weight: null, reps: 10 });
    }
  }
  const state = getProgramState(localDaysAgo(0));
  assert.ok(
    state.lifts.some((lift) => /pull-up/i.test(lift.exercise)),
    `bodyweight-only reps must not hide the lift (got ${JSON.stringify(state.lifts.map((l) => l.exercise))})`
  );
});

test("a lift that left the rotation two months ago re-baselines instead of stepping off its old top set", () => {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Lower",
      items: [{ exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 }],
    },
  ]);
  for (const daysAgo of [70, 66, 62]) {
    for (let set = 0; set < 3; set++) {
      repo.logSetByName({ date: localDaysAgo(daysAgo), exercise: "Romanian Deadlift", weight: 185, reps: 10, rir: 3 });
    }
  }
  // The athlete kept training — the RDL is what left the rotation.
  for (const daysAgo of [6, 3, 1]) {
    repo.logSetByName({ date: localDaysAgo(daysAgo), exercise: "Barbell Bench Press", weight: 135, reps: 8 });
  }
  const presc = nextPrescription("Romanian Deadlift");
  assert.ok(presc);
  assert.ok(
    presc.suggested.weight != null && presc.suggested.weight <= 185,
    `a stale top-of-range run holds its last load (got ${presc.suggested.weight} via ${presc.action})`
  );
});

test("a lower card completed in full counts as the week's full-load session, whatever an old top set says", async () => {
  const { fullLoadLowerSessionThisWeek } = await import("../dist/repo/plan-selection.js");
  repo.replacePlan([
    {
      day_number: 1,
      name: "Lower A",
      items: [{ exercise: "Back Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 192.5 }],
    },
  ]);
  // Two weeks back: a heavy triple-ish day that sets the logged working weight at 205.
  for (let set = 0; set < 3; set++) repo.logSetByName({ date: "2031-04-07", exercise: "Back Squat", weight: 205, reps: 5 });
  // Monday of the week under test: the composed card asks for 192.5 × 8–10 and it is done in full.
  const MONDAY = "2031-04-21";
  repo.prepareDailySession({ date: MONDAY, source: "manual_plan", day_number: 1 });
  // The live card: progression asked 192.5 at the 8-rep floor, below the old 205 working weight.
  const row = db.prepare(`SELECT id, items_json FROM daily_session_compositions WHERE date = ? AND status = 'active'`).get(MONDAY);
  const items = JSON.parse(row.items_json).map((item) => ({ ...item, target_weight: 192.5 }));
  db.prepare(`UPDATE daily_session_compositions SET items_json = ? WHERE id = ?`).run(JSON.stringify(items), row.id);
  for (let set = 0; set < 3; set++) repo.logSetByName({ date: MONDAY, exercise: "Back Squat", weight: 192.5, reps: 9 });
  assert.equal(fullLoadLowerSessionThisWeek("2031-04-23"), MONDAY);
});
