// estimateExpenditure (src/repo.ts) is the adherence-NEUTRAL energy-balance
// derivation. Constitution-critical: a thin logging week only lowers CONFIDENCE,
// it never errors and never reads a gap as a number to act on; an active
// trip/illness window suppresses confidence rather than re-targeting on noise.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedIntake, seedWeight, localDaysAgo, tsDaysAgo } from "./_seed.js";

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

test("measured RMR uses meaningfully covered generic active-calorie days when Garmin is absent", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: localDaysAgo(10),
    parsed_json: { markers: [{ name: "RMR", value: 1800, unit: "kcal/day" }] },
  });
  for (let i = 0; i < 14; i++) {
    db.prepare("INSERT INTO daily_metrics (source,date,active_calories) VALUES ('apple',?,400)").run(
      localDaysAgo(i + 1)
    );
  }
  const e = repo.estimateExpenditure(21);
  assert.equal(e.tdee, 2200);
  assert.equal(e.tdee_basis, "measured_rmr_active");
  assert.equal(e.coverage.prior_days, 14);
  assert.ok(e.provenance.includes("daily_active_calories:apple"));
});

test("medium outcome evidence cannot own more than one-third against an independent prior", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  for (let i = 1; i <= 8; i++) seedIntake(i, 2400);
  for (const d of [8, 6, 3, 1]) seedWeight(localDaysAgo(d), 180);
  const e = repo.estimateExpenditure(21);
  assert.equal(e.confidence, "medium");
  assert.equal(e.outcome_tdee, 2400);
  assert.equal(e.tdee_basis, "blended_outcome_prior");
  assert.deepEqual(e.fusion, { outcome_weight: 1 / 3, prior_weight: 2 / 3 });
  assert.equal(e.tdee, Math.round((e.outcome_tdee + e.prior_tdee * 2) / 3));
  assert.equal(repo.computeGoalCheck().tdee, e.tdee, "goal math consumes the same chosen estimate");
});

test("excludes future rows and clamps requested windows to 7..90 days", () => {
  db.prepare("INSERT INTO garmin_sources (id,provider,mode) VALUES (1,'garmin','unofficial')").run();
  for (let i = 0; i < 14; i++) {
    db.prepare("INSERT INTO garmin_daily_metrics (source_id,date,total_calories) VALUES (1,?,2500)").run(
      localDaysAgo(i + 1)
    );
  }
  db.prepare("INSERT INTO garmin_daily_metrics (source_id,date,total_calories) VALUES (1,?,9999)").run(
    localDaysAgo(-2)
  );
  // A FUTURE-dated food note, inserted raw on purpose. seedIntake now drives
  // addFoodNote, which clamps a future date to today — correctly, since a meal
  // cannot be eaten tomorrow — so the production path can no longer produce the
  // corrupt row this case exists to test. Rawness stays here, at the call site that
  // depends on it, rather than being hidden back inside the shared fixture.
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
       VALUES (?, 'meal', '', ?, NULL, ?)`
  ).run(localDaysAgo(-2), JSON.stringify({ kcal: 9999 }), tsDaysAgo(-2));
  // Simulate legacy/imported corrupt future rows. Public logWeight correctly
  // rejects these now; the estimator must still ignore rows already in storage.
  db.prepare("INSERT INTO bodyweight_log (date,weight_lb,note) VALUES (?,?,?)").run(
    localDaysAgo(-3),
    190,
    "legacy future fixture"
  );
  db.prepare("INSERT INTO bodyweight_log (date,weight_lb,note) VALUES (?,?,?)").run(
    localDaysAgo(-1),
    150,
    "legacy future fixture"
  );

  const short = repo.estimateExpenditure(1);
  assert.equal(short.window_days, 7);
  assert.equal(short.tdee, 2500);
  assert.equal(short.outcome_tdee, null, "future intake/weigh-ins cannot manufacture an outcome anchor");
  assert.equal(repo.estimateExpenditure(365).window_days, 90);
});

test("derives a tdee from steady intake + a real weight trend", () => {
  for (let i = 1; i <= 14; i++) seedIntake(i, 2500);
  const wdays = [14, 11, 8, 6, 3, 1];
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

test("a one-day intake record cannot manufacture outcome confidence", () => {
  // Common-window alignment means a one-day intake record cannot borrow an
  // earlier scale change and pretend both signals covered the same period.
  seedIntake(1, 2200);
  seedWeight(localDaysAgo(4), 180);
  seedWeight(localDaysAgo(1), 179.5);
  const e = repo.estimateExpenditure(21);
  assert.equal(e.confidence, "none");
  assert.equal(e.points, 1);
  assert.equal(e.outcome_tdee, null);
});

test("an active trip window SUPPRESSES confidence by one step", () => {
  // Build a clean 'medium' scenario, snapshot it, then add an overlapping trip:
  // the scale and food log are both unreliable mid-trip, so confidence steps down
  // (medium -> low) without changing the number it would otherwise report.
  for (let i = 1; i <= 14; i++) seedIntake(i, 2500);
  const wdays = [14, 11, 8, 6, 3, 1];
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
  for (let i = 1; i <= 14; i++) seedIntake(i, 2500);
  const wdays = [14, 11, 8, 6, 3, 1];
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
  seedIntake(1, 2400);
  seedIntake(2, 2400);
  seedIntake(5, 2400);
  seedWeight(localDaysAgo(6), 180);
  seedWeight(localDaysAgo(1), 180);
  const e = repo.estimateExpenditure(21);
  assert.equal(e.intake_avg_kcal, 2400);
  assert.equal(e.points, 3);
});

test("groups intake by stamped local day when created_at crosses UTC midnight", () => {
  const localDay = localDaysAgo(1);
  const nextUtcDay = new Date(Date.parse(`${localDay}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  // The two labels have to reach across the day (morning food AND evening food):
  // this case is about DAY KEYING, and a day that does not read as complete is
  // absent intake evidence, so a lunch-and-dinner pair would count zero points for
  // a reason that has nothing to do with the UTC boundary being tested.
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
     VALUES (?, 'dinner', '', ?, NULL, ?)`
  ).run(localDay, JSON.stringify({ kcal: 500 }), `${localDay} 23:30:00`);
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
     VALUES (?, 'breakfast', '', ?, NULL, ?)`
  ).run(localDay, JSON.stringify({ kcal: 700 }), `${nextUtcDay} 00:30:00`);

  const e = repo.estimateExpenditure(21);
  assert.equal(e.points, 1, "two UTC timestamps on the same local day count as one intake day");
  assert.equal(e.intake_avg_kcal, 1200, "the local day's kcal are summed before averaging");
});

test("14 snack-only days stay partial and cannot become an authoritative outcome target", () => {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
  });
  for (let i = 1; i <= 14; i++) {
    db.prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
       VALUES (?, 'snack', '', ?, NULL, ?)`
    ).run(localDaysAgo(i), JSON.stringify({ kcal: 250, summary: "Snack" }), `${localDaysAgo(i)} 12:00:00`);
  }
  for (const d of [14, 12, 10, 8, 6, 4, 2, 1]) seedWeight(localDaysAgo(d), 180);

  const e = repo.estimateExpenditure(21);
  assert.equal(e.points, 0, "partial days are visible coverage, never usable outcome points");
  assert.equal(e.intake_avg_kcal, null);
  assert.equal(e.quality.intake, "partial");
  assert.equal(e.coverage.intake_days, 0);
  assert.equal(e.coverage.credible_intake_days, 0);
  assert.equal(e.coverage.partial_intake_days, 14);
  assert.equal(e.outcome_tdee, null);
  assert.equal(e.confidence, "none");
  assert.equal(e.tdee_basis, "profile_seed");
  assert.deepEqual(e.fusion, { outcome_weight: 0, prior_weight: 1 });
  assert.equal(e.tdee, e.prior_tdee, "the independent prior owns maintenance while coverage settles");
  assert.match(e.quality.explanation, /partial/i);
});

test("a fortnight of logged breakfasts never becomes a fortnight of intake days", () => {
  // The intake-coverage law: a day whose dinner was never logged is ABSENT, not a
  // low-intake day. Averaging these 700 kcal mornings into the trend would put
  // maintenance a thousand kcal under the truth and read a quiet log as a deficit.
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
  });
  for (let i = 1; i <= 14; i++) {
    db.prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
       VALUES (?, 'breakfast', '', ?, NULL, ?)`
    ).run(localDaysAgo(i), JSON.stringify({ kcal: 700, summary: "Eggs and oats" }), `${localDaysAgo(i)} 08:00:00`);
  }
  for (const d of [14, 12, 10, 8, 6, 4, 2, 1]) seedWeight(localDaysAgo(d), 180);

  const e = repo.estimateExpenditure(21);
  assert.equal(e.points, 0, "partial days are excluded from intake-based estimation");
  assert.equal(e.intake_avg_kcal, null, "a partial day never contributes a low daily average");
  assert.equal(e.coverage.credible_intake_days, 0);
  assert.equal(e.coverage.partial_intake_days, 14, "they stay VISIBLE as coverage");
  assert.equal(e.outcome_tdee, null);
  assert.equal(e.tdee, e.prior_tdee, "the prior owns maintenance rather than an invented deficit");
});

test("the same fortnight, logged through to dinner, IS admissible evidence", () => {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_mode: "maintain",
  });
  for (let i = 1; i <= 14; i++) {
    for (const [label, kcal, hour] of [
      ["breakfast", 700, "08:00"],
      ["dinner", 1_500, "19:00"],
    ]) {
      db.prepare(
        `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
         VALUES (?, ?, '', ?, NULL, ?)`
      ).run(localDaysAgo(i), label, JSON.stringify({ kcal, summary: label }), `${localDaysAgo(i)} ${hour}:00`);
    }
  }
  for (const d of [14, 12, 10, 8, 6, 4, 2, 1]) seedWeight(localDaysAgo(d), 180);

  const e = repo.estimateExpenditure(21);
  assert.equal(e.points, 14, "days that reach across the day are real evidence");
  assert.equal(e.intake_avg_kcal, 2_200);
  assert.equal(e.coverage.credible_intake_days, 14);
  assert.equal(e.coverage.partial_intake_days, 0);
  assert.ok(e.outcome_tdee != null, "the outcome trend exists once the record is complete");
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
  for (let i = 1; i <= 14; i++) seedIntake(i, 1_500);
  let weight = 180;
  for (const d of [14, 12, 10, 8, 6, 4, 2, 1]) {
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

test("high outcome confidence requires at least a 28-day weight span", () => {
  repo.setProfile({ age: 35, height_cm: 160, weight_lb: 120, sex: "female", activity_factor: 1.3 });
  for (let i = 1; i <= 29; i++) {
    for (const [meal, kcal] of [
      ["breakfast", 350],
      ["lunch", 450],
      ["dinner", 500],
    ]) {
      db.prepare(
        `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
         VALUES (?, ?, '', ?, NULL, ?)`
      ).run(localDaysAgo(i), meal, JSON.stringify({ kcal }), `${localDaysAgo(i)} 12:00:00`);
    }
  }
  let weight = 122.8;
  for (const d of [29, 26, 23, 20, 17, 14, 11, 8, 5, 1]) {
    seedWeight(localDaysAgo(d), weight);
    weight -= 0.2;
  }

  const e = repo.estimateExpenditure(30);
  assert.equal(e.quality.intake, "complete");
  assert.equal(e.quality.outcome, "plausible");
  assert.equal(e.confidence, "high");
  assert.equal(e.tdee_basis, "blended_outcome_prior");
  assert.deepEqual(e.fusion, { outcome_weight: 3 / 4, prior_weight: 1 / 4 });
  assert.equal(e.coverage.weigh_in_span_days, 28);
});

test("a 27-day weight span remains medium even with otherwise complete coverage", () => {
  repo.setProfile({ age: 35, height_cm: 160, weight_lb: 120, sex: "female", activity_factor: 1.3 });
  for (let day = 1; day <= 28; day++) seedIntake(day, 1_700);
  for (const day of [28, 25, 22, 19, 16, 13, 10, 7, 4, 1]) {
    seedWeight(localDaysAgo(day), 120);
  }
  const e = repo.estimateExpenditure(30);
  assert.equal(e.coverage.weigh_in_span_days, 27);
  assert.equal(e.confidence, "medium");
  assert.deepEqual(e.fusion, { outcome_weight: 1 / 3, prior_weight: 2 / 3 });
});

test("unfinished current-day food, weight, and activity never move maintenance", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  for (let day = 1; day <= 14; day++) seedIntake(day, 2200);
  for (const day of [14, 11, 8, 5, 2, 1]) seedWeight(localDaysAgo(day), 180 - (14 - day) * 0.08);
  for (let day = 1; day <= 14; day++) {
    db.prepare("INSERT INTO daily_metrics (source,date,active_calories) VALUES ('apple',?,400)").run(localDaysAgo(day));
  }
  const before = repo.estimateExpenditure(21);

  seedIntake(0, 5000);
  seedWeight(localDaysAgo(0), 170);
  db.prepare("INSERT INTO daily_metrics (source,date,active_calories) VALUES ('apple',?,3000)").run(localDaysAgo(0));
  const after = repo.estimateExpenditure(21);

  assert.equal(after.tdee, before.tdee);
  assert.equal(after.intake_avg_kcal, before.intake_avg_kcal);
  assert.equal(after.trend_lb_wk, before.trend_lb_wk);
  assert.equal(after.exceptional_activity.allowance_kcal_per_day, before.exceptional_activity.allowance_kcal_per_day);
});

test("an unconfirmed terminal three-pound scale shock is surfaced but cannot inflate TDEE materially", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  for (let day = 1; day <= 14; day++) seedIntake(day, 2200);
  for (const [day, weight] of [
    [14, 180],
    [11, 179.8],
    [8, 179.6],
    [5, 179.4],
    [2, 179.2],
  ]) {
    seedWeight(localDaysAgo(day), weight);
  }
  const settled = repo.estimateExpenditure(21);
  seedWeight(localDaysAgo(1), 176.1);
  const shocked = repo.estimateExpenditure(21);

  assert.equal(shocked.quality.terminal_weight_shock, true);
  assert.equal(shocked.quality.terminal_weight_shock_date, localDaysAgo(1));
  assert.ok(Math.abs(shocked.tdee - settled.tdee) <= 75, `${settled.tdee} -> ${shocked.tdee}`);
});

test("two matching low readings corroborate a level shift without converting the full step to tissue", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  for (let day = 1; day <= 14; day++) seedIntake(day, 2_200);
  for (const [day, weight] of [
    [14, 180],
    [11, 179.8],
    [8, 179.6],
    [5, 179.4],
    [3, 179.2],
    [2, 176.2],
    [1, 176.1],
  ]) {
    seedWeight(localDaysAgo(day), weight);
  }

  const e = repo.estimateExpenditure(21);
  assert.equal(e.quality.terminal_weight_shock, false);
  assert.equal(e.quality.weight_level_shift, "corroborated");
  assert.match(e.quality.explanation, /admits it cautiously/i);
  assert.ok(e.trend_lb_wk > -1.25, `cautious trend was ${e.trend_lb_wk} lb/wk`);
});

test("an abrupt step followed by a two-week plateau is learned cautiously", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  for (let day = 1; day <= 30; day++) seedIntake(day, 2_200);
  for (const [day, weight] of [
    [30, 180],
    [26, 180],
    [22, 179.9],
    [18, 179.9],
    [15, 176.1],
    [10, 176],
    [5, 176.1],
    [1, 176],
  ]) {
    seedWeight(localDaysAgo(day), weight);
  }

  const e = repo.estimateExpenditure(35);
  assert.equal(e.quality.weight_level_shift, "corroborated");
  assert.ok(e.trend_lb_wk < -0.1, "the sustained new level becomes evidence");
  assert.ok(e.trend_lb_wk > -1.5, `the one step did not become wholesale tissue loss: ${e.trend_lb_wk}`);
});

test("a sustained multiweek gradual loss remains learnable", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  for (let day = 1; day <= 30; day++) seedIntake(day, 2_200);
  let weight = 180;
  for (const day of [30, 26, 22, 18, 14, 10, 6, 1]) {
    seedWeight(localDaysAgo(day), weight);
    weight -= 0.5;
  }

  const e = repo.estimateExpenditure(35);
  assert.equal(e.quality.weight_level_shift, "none");
  assert.ok(e.trend_lb_wk < -0.5, `gradual sustained loss was learned: ${e.trend_lb_wk}`);
  assert.ok(e.outcome_tdee > e.intake_avg_kcal);
});

test("intake and weight must overlap on completed calendar days", () => {
  for (let day = 1; day <= 10; day++) seedIntake(day, 2300);
  seedWeight(localDaysAgo(20), 180);
  seedWeight(localDaysAgo(15), 179);
  const e = repo.estimateExpenditure(21);
  assert.equal(e.outcome_tdee, null);
  assert.equal(e.confidence, "none");
  assert.equal(e.coverage.weigh_in_days, 0);
});

test("rare long activity is frequency-amortized instead of promoted to an ordinary day", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: localDaysAgo(30),
    parsed_json: { markers: [{ name: "RMR", value: 1800, unit: "kcal/day" }] },
  });
  for (let day = 1; day <= 14; day++) {
    db.prepare("INSERT INTO daily_metrics (source,date,active_calories) VALUES ('apple',?,?)").run(
      localDaysAgo(day),
      day === 7 ? 1800 : 400
    );
  }
  const e = repo.estimateExpenditure(21);
  assert.equal(e.typical_tdee, 2200);
  assert.equal(e.exceptional_activity.typical_active_kcal, 400);
  assert.equal(e.exceptional_activity.exceptional_days, 1);
  assert.equal(e.exceptional_activity.window_days, 28);
  assert.equal(e.exceptional_activity.allowance_kcal_per_day, 50);
  assert.equal(e.tdee, 2250);
});

test("seven workout-only wearable rows across six weeks cannot own the ordinary prior", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: localDaysAgo(30),
    parsed_json: { markers: [{ name: "RMR", value: 1800, unit: "kcal/day" }] },
  });
  for (const day of [42, 35, 28, 21, 14, 7, 1]) {
    db.prepare("INSERT INTO daily_metrics (source,date,active_calories) VALUES ('apple',?,?)").run(
      localDaysAgo(day),
      day === 21 ? 1800 : 400
    );
  }
  const e = repo.estimateExpenditure(21);
  assert.equal(e.tdee_basis, "profile_seed");
  assert.equal(e.prior_basis, "profile_seed");
  assert.equal(e.anchors.some((anchor) => anchor.kind === "measured_rmr_active"), false);
  assert.equal(e.exceptional_activity.observed_days, 0);
});

test("a fused outcome subtracts the full rare-activity allowance from its ordinary-day read", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: localDaysAgo(30),
    parsed_json: { markers: [{ name: "RMR", value: 1800, unit: "kcal/day" }] },
  });
  for (let day = 1; day <= 14; day++) {
    seedIntake(day, 2_300);
    db.prepare("INSERT INTO daily_metrics (source,date,active_calories) VALUES ('apple',?,?)").run(
      localDaysAgo(day),
      day === 7 ? 1_800 : 400
    );
  }
  for (const day of [14, 11, 8, 5, 2, 1]) seedWeight(localDaysAgo(day), 180);

  const e = repo.estimateExpenditure(21);
  assert.equal(e.tdee_basis, "blended_outcome_prior");
  assert.deepEqual(e.fusion, { outcome_weight: 1 / 3, prior_weight: 2 / 3 });
  assert.equal(e.exceptional_activity.allowance_kcal_per_day, 50);
  assert.equal(e.typical_tdee, e.tdee - 50);
});

test("fresh measured RMR is modestly adjusted only when test-time weight is known", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 170, sex: "male", activity_factor: 1.5 });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: localDaysAgo(30),
    parsed_json: { markers: [{ name: "RMR", value: 1800, unit: "kcal/day" }] },
  });
  seedWeight(localDaysAgo(30), 180);
  for (const day of [3, 2, 1]) seedWeight(localDaysAgo(day), 170);
  for (let day = 1; day <= 14; day++) {
    db.prepare("INSERT INTO daily_metrics (source,date,active_calories) VALUES ('apple',?,400)").run(localDaysAgo(day));
  }
  const e = repo.estimateExpenditure(21);
  const measured = e.anchors.find((anchor) => anchor.kind === "measured_rmr_active");
  assert.deepEqual(measured.rmr_adjustment, {
    original_kcal: 1800,
    adjusted_kcal: 1755,
    test_weight_lb: 180,
    current_weight_lb: 170,
    delta_lb: -10,
    test_weight_date: localDaysAgo(30),
  });
  assert.ok(measured.provenance.includes("bodyweight:rmr_test_nearest"));
  assert.equal(e.typical_tdee, 2155);
});
