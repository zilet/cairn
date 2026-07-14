// estimateExpenditure (src/repo.ts) is the adherence-NEUTRAL energy-balance
// derivation. Constitution-critical: a thin logging week only lowers CONFIDENCE,
// it never errors and never reads a gap as a number to act on; an active
// trip/illness window suppresses confidence rather than re-targeting on noise.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedIntake, seedWeight, localDaysAgo } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "food_notes",
    "bodyweight_log",
    "context_events",
    "profile",
    "health_documents",
    "daily_metrics",
    "garmin_daily_metrics",
    "garmin_sources"
  );
});

test("returns null tdee / 'none' confidence with no data (never throws)", () => {
  const e = repo.estimateExpenditure(21);
  assert.equal(e.tdee, null);
  assert.equal(e.confidence, "none");
  assert.equal(e.intake_avg_kcal, null);
  assert.equal(e.trend_lb_wk, null);
  assert.equal(e.points, 0);
});

test("uses an honest low-confidence profile seed when outcome data is missing", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  const e = repo.estimateExpenditure(21);
  assert.equal(e.confidence, "none", "confidence still describes the absent outcome evidence");
  assert.equal(e.tdee_basis, "profile_seed");
  assert.equal(e.outcome_tdee, null);
  assert.equal(e.tdee, e.prior_tdee);
  assert.match(e.basis, /profile and activity/i);
  assert.deepEqual(e.provenance, ["profile:mifflin_st_jeor", "profile.activity_factor"]);
});

test("measured RMR uses generic active-calorie days when Garmin is absent", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: localDaysAgo(10),
    parsed_json: { markers: [{ name: "RMR", value: 1800, unit: "kcal/day" }] },
  });
  for (let i = 0; i < 7; i++) {
    db.prepare("INSERT INTO daily_metrics (source,date,active_calories) VALUES ('apple',?,400)").run(localDaysAgo(i));
  }
  const e = repo.estimateExpenditure(21);
  assert.equal(e.tdee, 2200);
  assert.equal(e.tdee_basis, "measured_rmr_active");
  assert.equal(e.coverage.prior_days, 7);
  assert.ok(e.provenance.includes("daily_active_calories:apple"));
});

test("medium outcome evidence blends two-thirds outcome with one-third strongest prior", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  for (let i = 0; i < 7; i++) seedIntake(i, 2400);
  for (const d of [8, 6, 3, 0]) seedWeight(localDaysAgo(d), 180);
  const e = repo.estimateExpenditure(21);
  assert.equal(e.confidence, "medium");
  assert.equal(e.outcome_tdee, 2400);
  assert.equal(e.tdee_basis, "blended_outcome_prior");
  assert.deepEqual(e.fusion, { outcome_weight: 2 / 3, prior_weight: 1 / 3 });
  assert.equal(e.tdee, Math.round((e.outcome_tdee * 2 + e.prior_tdee) / 3));
  assert.equal(repo.computeGoalCheck().tdee, e.tdee, "goal math consumes the same chosen estimate");
});

test("excludes future rows and clamps requested windows to 7..90 days", () => {
  db.prepare("INSERT INTO garmin_sources (id,provider,mode) VALUES (1,'garmin','unofficial')").run();
  for (let i = 0; i < 7; i++) {
    db.prepare("INSERT INTO garmin_daily_metrics (source_id,date,total_calories) VALUES (1,?,2500)").run(
      localDaysAgo(i)
    );
  }
  db.prepare("INSERT INTO garmin_daily_metrics (source_id,date,total_calories) VALUES (1,?,9999)").run(
    localDaysAgo(-2)
  );
  seedIntake(-2, 9999);
  seedWeight(localDaysAgo(-3), 190);
  seedWeight(localDaysAgo(-1), 150);

  const short = repo.estimateExpenditure(1);
  assert.equal(short.window_days, 7);
  assert.equal(short.tdee, 2500);
  assert.equal(short.outcome_tdee, null, "future intake/weigh-ins cannot manufacture an outcome anchor");
  assert.equal(repo.estimateExpenditure(365).window_days, 90);
});

test("derives a tdee from steady intake + a real weight trend", () => {
  for (let i = 0; i < 10; i++) seedIntake(i, 2500);
  const wdays = [14, 11, 8, 6, 3, 0];
  let w = 185;
  for (const d of wdays) {
    seedWeight(localDaysAgo(d), w);
    w -= 0.4;
  }
  const e = repo.estimateExpenditure(21);
  assert.equal(typeof e.tdee, "number");
  assert.equal(e.intake_avg_kcal, 2500);
  assert.ok(e.trend_lb_wk < 0, "losing weight => negative weekly trend");
  // Losing weight => maintenance is ABOVE average intake.
  assert.ok(e.tdee > e.intake_avg_kcal, "deficit means tdee > intake");
  assert.equal(e.confidence, "medium");
});

test("a THIN logging week lowers confidence but never errors or blames", () => {
  // One intake day, two weigh-ins over a short span — adherence-neutral: this is
  // 'low' confidence, NOT 'none', NOT an error, and tdee is still derivable.
  seedIntake(0, 2200);
  seedWeight(localDaysAgo(4), 180);
  seedWeight(localDaysAgo(0), 179.5);
  const e = repo.estimateExpenditure(21);
  assert.equal(e.confidence, "low");
  assert.equal(e.points, 1);
  assert.equal(typeof e.tdee, "number");
});

test("an active trip window SUPPRESSES confidence by one step", () => {
  // Build a clean 'medium' scenario, snapshot it, then add an overlapping trip:
  // the scale and food log are both unreliable mid-trip, so confidence steps down
  // (medium -> low) without changing the number it would otherwise report.
  for (let i = 0; i < 10; i++) seedIntake(i, 2500);
  const wdays = [14, 11, 8, 6, 3, 0];
  let w = 185;
  for (const d of wdays) {
    seedWeight(localDaysAgo(d), w);
    w -= 0.4;
  }
  const before = repo.estimateExpenditure(21);
  assert.equal(before.confidence, "medium");

  repo.addContextEvent({ kind: "trip", title: "Conference", start_date: localDaysAgo(2), end_date: localDaysAgo(-2) });
  const during = repo.estimateExpenditure(21);
  assert.equal(during.confidence, "low", "trip steps confidence down");
  assert.equal(during.tdee, before.tdee, "suppression lowers confidence, not the estimate");
});

test("an illness life_event also suppresses confidence", () => {
  for (let i = 0; i < 10; i++) seedIntake(i, 2500);
  const wdays = [14, 11, 8, 6, 3, 0];
  let w = 185;
  for (const d of wdays) {
    seedWeight(localDaysAgo(d), w);
    w -= 0.4;
  }
  assert.equal(repo.estimateExpenditure(21).confidence, "medium");
  repo.addContextEvent({ kind: "life_event", title: "Down with the flu", start_date: localDaysAgo(1), end_date: null });
  assert.equal(repo.estimateExpenditure(21).confidence, "low");
});

test("days with no food logged are absent, never counted as a zero-kcal crash diet", () => {
  // Only 3 logged intake days at 2400; their average is 2400, not diluted by the
  // unlogged days in the 21-day window.
  seedIntake(0, 2400);
  seedIntake(2, 2400);
  seedIntake(5, 2400);
  seedWeight(localDaysAgo(6), 180);
  seedWeight(localDaysAgo(0), 180);
  const e = repo.estimateExpenditure(21);
  assert.equal(e.intake_avg_kcal, 2400);
  assert.equal(e.points, 3);
});

test("groups intake by stamped local day when created_at crosses UTC midnight", () => {
  const localDay = localDaysAgo(0);
  const nextUtcDay = new Date(Date.parse(`${localDay}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
     VALUES (?, 'dinner', '', ?, NULL, ?)`
  ).run(localDay, JSON.stringify({ kcal: 500 }), `${localDay} 23:30:00`);
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
     VALUES (?, 'snack', '', ?, NULL, ?)`
  ).run(localDay, JSON.stringify({ kcal: 700 }), `${nextUtcDay} 00:30:00`);

  const e = repo.estimateExpenditure(21);
  assert.equal(e.points, 1, "two UTC timestamps on the same local day count as one intake day");
  assert.equal(e.intake_avg_kcal, 1200, "the local day's kcal are summed before averaging");
});

test("14 snack-only days stay partial and cannot become an authoritative outcome target", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5, goal_mode: "maintain" });
  for (let i = 0; i < 14; i++) {
    db.prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
       VALUES (?, 'snack', '', ?, NULL, ?)`
    ).run(localDaysAgo(i), JSON.stringify({ kcal: 250, summary: "Snack" }), `${localDaysAgo(i)} 12:00:00`);
  }
  for (const d of [14, 12, 10, 8, 6, 4, 2, 0]) seedWeight(localDaysAgo(d), 180);

  const e = repo.estimateExpenditure(21);
  assert.equal(e.points, 14);
  assert.equal(e.quality.intake, "partial");
  assert.equal(e.coverage.credible_intake_days, 0);
  assert.equal(e.coverage.partial_intake_days, 14);
  assert.equal(e.confidence, "low");
  assert.equal(e.tdee_basis, "blended_outcome_prior");
  assert.ok(e.fusion.prior_weight > 0, "a safer user-specific prior keeps authority while coverage settles");
  assert.notEqual(e.tdee, e.outcome_tdee, "the snack-only outcome cannot set maintenance by itself");
  assert.match(e.quality.explanation, /partial/i);
});

test("an implausible outcome is downgraded, bounded, and cannot create a crash target", () => {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "lose",
    goal_weight_lb: 170,
  });
  for (let i = 0; i < 14; i++) seedIntake(i, 1_500);
  let weight = 180;
  for (const d of [14, 12, 10, 8, 6, 4, 2, 0]) {
    seedWeight(localDaysAgo(d), weight);
    weight += 3;
  }

  const e = repo.estimateExpenditure(21);
  assert.equal(e.quality.intake, "complete");
  assert.equal(e.quality.outcome, "implausible_low");
  assert.equal(e.confidence, "low");
  assert.ok(e.outcome_tdee < 0, "the raw contradictory outcome remains visible as evidence");
  assert.ok(e.tdee >= 1_200, "the chosen maintenance estimate is physiologically bounded");
  assert.notEqual(e.tdee, e.outcome_tdee);
  const goal = repo.computeGoalCheck();
  assert.ok(goal.recommended.target_intake_kcal >= 1_500, "goal math cannot inherit a crash target");
  assert.ok(goal.effective_target.target_kcal >= 1_500, "the effective target also remains safe");
});

test("complete low-calorie days can still earn confidence when their outcome is plausible", () => {
  repo.setProfile({ age: 35, height_cm: 160, weight_lb: 120, sex: "female", activity_factor: 1.3 });
  for (let i = 0; i < 14; i++) {
    for (const [meal, kcal] of [["breakfast", 350], ["lunch", 450], ["dinner", 500]]) {
      db.prepare(
        `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
         VALUES (?, ?, '', ?, NULL, ?)`
      ).run(localDaysAgo(i), meal, JSON.stringify({ kcal }), `${localDaysAgo(i)} 12:00:00`);
    }
  }
  let weight = 121.4;
  for (const d of [14, 12, 10, 8, 6, 4, 2, 0]) {
    seedWeight(localDaysAgo(d), weight);
    weight -= 0.2;
  }

  const e = repo.estimateExpenditure(21);
  assert.equal(e.quality.intake, "complete");
  assert.equal(e.quality.outcome, "plausible");
  assert.equal(e.confidence, "high");
  assert.equal(e.tdee_basis, "outcome_trend");
});
