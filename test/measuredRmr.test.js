import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, localDaysAgo, seedWeight } from "./_seed.js";

beforeEach(() => resetTables("profile", "health_documents", "garmin_daily_metrics", "garmin_sources", "bodyweight_log"));

test("a metabolic-test record becomes the structured RMR anchor without losing the source document", () => {
  repo.setProfile({
    age: 44,
    height_cm: 170.2,
    weight_lb: 174.2,
    sex: "male",
    activity_factor: 1.55,
    goal_mode: "maintain",
  });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: "2026-06-02",
    summary: "Indirect calorimetry measured resting metabolic rate 2,078 kcal/day.",
    parsed_json: { markers: [{ name: "Resting Metabolic Rate (RMR)", value: 2078, unit: "kcal/day" }] },
  });
  db.prepare("INSERT INTO garmin_sources (id,provider,mode) VALUES (1,'garmin','unofficial')").run();
  for (let day = 1; day <= 14; day++) {
    db.prepare("INSERT INTO garmin_daily_metrics (source_id,date,active_calories) VALUES (1,?,430)").run(
      localDaysAgo(day)
    );
  }

  const goal = repo.computeGoalCheck();
  assert.equal(goal.bmr, 2078);
  assert.equal(goal.bmr_source, "measured");
  assert.equal(goal.bmr_formula, 1639);
  assert.equal(goal.tdee_source, "measured_rmr_plus_activity");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM health_documents").get().n, 1);
  assert.equal(repo.getProfile().measured_rmr_kcal, 2078);
});

test("deleting the source metabolic test removes only its derived RMR anchor", () => {
  repo.setProfile({ age: 44, height_cm: 170.2, weight_lb: 174.2, sex: "male", activity_factor: 1.55 });
  const doc = repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: "2026-06-02",
    parsed_json: { markers: [{ name: "RMR", value: 2078, unit: "kcal/day" }] },
  });
  assert.equal(repo.getProfile().measured_rmr_kcal, 2078);

  repo.deleteHealthDocument(doc.id);

  const profile = repo.getProfile();
  assert.equal(profile.measured_rmr_kcal, null);
  assert.equal(repo.computeGoalCheck().bmr_source, "formula");
});

test("a recent measured RMR remains the leading expenditure anchor with freshness metadata", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: localDaysAgo(30),
    parsed_json: { markers: [{ name: "RMR", value: 1800, unit: "kcal/day" }] },
  });
  db.prepare("INSERT INTO garmin_sources (id,provider,mode) VALUES (1,'garmin','unofficial')").run();
  for (let i = 0; i < 14; i++) {
    db.prepare("INSERT INTO garmin_daily_metrics (source_id,date,active_calories,total_calories) VALUES (1,?,?,?)").run(
      localDaysAgo(i + 1),
      400,
      2600
    );
  }

  const e = repo.estimateExpenditure(21);
  assert.equal(e.tdee_basis, "measured_rmr_active");
  const measured = e.anchors.find((anchor) => anchor.kind === "measured_rmr_active");
  assert.equal(measured.freshness, "fresh");
  assert.equal(measured.age_days, 29, "freshness is assessed at the last completed local day");
  assert.equal(measured.freshness_weight, 1);
  assert.equal(repo.computeGoalCheck().bmr_source, "measured");
});

test("an aging measured RMR yields to fresher Garmin total calories", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: localDaysAgo(300),
    parsed_json: { markers: [{ name: "RMR", value: 2100, unit: "kcal/day" }] },
  });
  db.prepare("INSERT INTO garmin_sources (id,provider,mode) VALUES (1,'garmin','unofficial')").run();
  for (let i = 0; i < 14; i++) {
    db.prepare("INSERT INTO garmin_daily_metrics (source_id,date,active_calories,total_calories) VALUES (1,?,?,?)").run(
      localDaysAgo(i + 1),
      400,
      2500
    );
  }

  const e = repo.estimateExpenditure(21);
  assert.equal(e.tdee_basis, "garmin_total_calories");
  assert.equal(e.tdee, 2500);
  const measured = e.anchors.find((anchor) => anchor.kind === "measured_rmr_active");
  assert.equal(measured.freshness, "aging");
  assert.ok(measured.freshness_weight > 0 && measured.freshness_weight < 1);
  assert.equal(repo.computeGoalCheck().bmr_source, "blended");
});

test("an expired measured RMR cannot outrank the current profile anchor", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: localDaysAgo(800),
    parsed_json: { markers: [{ name: "RMR", value: 2100, unit: "kcal/day" }] },
  });
  for (let i = 0; i < 14; i++) {
    db.prepare("INSERT INTO daily_metrics (source,date,active_calories) VALUES ('apple',?,400)").run(
      localDaysAgo(i + 1)
    );
  }

  const e = repo.estimateExpenditure(21);
  assert.equal(e.tdee_basis, "profile_seed");
  assert.equal(
    e.anchors.some((anchor) => anchor.kind === "measured_rmr_active"),
    false
  );
  const goal = repo.computeGoalCheck();
  assert.equal(goal.measured_rmr.freshness, "expired");
  assert.equal(goal.measured_rmr.freshness_weight, 0);
  assert.equal(goal.bmr_source, "formula");
});

test("goal.measured_rmr surfaces the weight-adjusted value for a synthetic profile", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 184, sex: "male", activity_factor: 1.5 });
  repo.addHealthDocument({
    kind: "metabolic_test",
    doc_date: localDaysAgo(30),
    parsed_json: { markers: [{ name: "RMR", value: 1750, unit: "kcal/day" }] },
  });
  seedWeight(localDaysAgo(30), 200);
  for (const day of [3, 2, 1]) seedWeight(localDaysAgo(day), 184);

  const goal = repo.computeGoalCheck();
  assert.ok(goal.measured_rmr, "the measured RMR is still surfaced");
  assert.equal(goal.measured_rmr.kcal, 1750, "kcal stays the measured value");
  assert.ok(goal.measured_rmr_adjusted_for_lb, "adjustment metadata is present so agents can name both weights");
  assert.equal(goal.measured_rmr_adjusted_for_lb.original_kcal, 1750);
  assert.equal(goal.measured_rmr.adjusted_kcal, goal.measured_rmr_adjusted_for_lb.adjusted_kcal);
  assert.ok(goal.measured_rmr.adjusted_kcal < 1750, "scaled down with the drop from 200 to 184");
  assert.equal(goal.measured_rmr_adjusted_for_lb.test_weight_lb, 200);
  assert.equal(goal.measured_rmr_adjusted_for_lb.current_weight_lb, 184);
});
