import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";

beforeEach(() => resetTables("profile", "health_documents", "garmin_daily_metrics", "garmin_sources"));

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
  for (let day = 1; day <= 10; day++) {
    db.prepare("INSERT INTO garmin_daily_metrics (source_id,date,active_calories) VALUES (1,?,430)").run(
      `2026-07-${String(day).padStart(2, "0")}`
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
