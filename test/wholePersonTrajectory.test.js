import { test } from "node:test";
import assert from "node:assert/strict";
import { wholePersonTrajectory } from "../dist/repo/whole-person-trajectory.js";
import { db } from "../dist/db.js";

test("whole-person trajectory stays verbal, phase-aware, and flags unexplained regression", () => {
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb) VALUES (1, 'maintain', 180)`).run();
  for (const [date, weight] of [
    ["2026-05-01", 180],
    ["2026-05-12", 180.2],
    ["2026-06-01", 181.5],
    ["2026-06-20", 183.5],
  ]) {
    db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`).run(date, weight);
  }
  const read = wholePersonTrajectory({ end: "2026-06-25", days: 56 });
  assert.equal(read.objective, "everything better");
  assert.equal(read.domains.find((domain) => domain.domain === "body_composition").verdict, "worse");
  assert.deepEqual(read.unexplained_worse, ["body_composition"]);
  assert.equal(read.revision_needed, true);
  assert.doesNotMatch(JSON.stringify(read), /score|\b\d{1,3}\/100\b/);
});

test("a hybrid cut optimizes strength development with retention as a universal floor", () => {
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb, primary_discipline) VALUES (1, 'lose', 180, 'hybrid')`).run();
  const read = wholePersonTrajectory({ end: "2026-06-25", days: 56 });
  assert.ok(read.phase.protects.includes("strength"));
  assert.ok(read.phase.optimizes.includes("strength and muscle development"));
  assert.ok(read.phase.optimizes.includes("body composition"));
  assert.ok(read.phase.floors.includes("no avoidable lean-mass loss"));
  assert.ok(!read.phase.optimizes.includes("strength retention"));
  assert.ok(!read.phase.parks.includes("strength"));
  assert.equal(read.domains.find((domain) => domain.domain === "strength").parked, false);
});

test("explicit ordered intent owns phase.optimizes while strength and lean-mass floors remain", () => {
  db.prepare(
    `INSERT INTO profile (id, goal_mode, weight_lb, primary_discipline, training_intent_json)
     VALUES (1, 'lose', 180, 'hybrid', ?)`
  ).run(
    JSON.stringify({
      priorities: ["longevity", "muscle", "leanness", "endurance"],
      endurance_role: "supporting",
      endurance_capacity: { sport: "MTB", target_duration_min: 120, context: null },
    })
  );
  const read = wholePersonTrajectory({ end: "2026-06-25", days: 56 });
  assert.deepEqual(read.phase.optimizes, ["longevity", "muscle development", "body composition", "endurance"]);
  assert.ok(read.phase.floors.includes("no avoidable strength regression"));
  assert.ok(read.phase.floors.includes("no avoidable lean-mass loss"));
  assert.ok(read.phase.protects.includes("strength"));
});

test("one established regressing lift stays visible even while another lift advances", () => {
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb, primary_discipline) VALUES (1, 'lose', 180, 'hybrid')`).run();
  const bench = Number(db.prepare(`INSERT INTO exercises (name, muscle_group) VALUES ('Bench Press', 'chest')`).run().lastInsertRowid);
  const raise = Number(db.prepare(`INSERT INTO exercises (name, muscle_group) VALUES ('Lateral Raise', 'shoulders')`).run().lastInsertRowid);
  const dates = ["2026-05-20", "2026-05-30", "2026-06-10", "2026-06-20"];
  dates.forEach((date, index) => {
    const session = Number(db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(date).lastInsertRowid);
    db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, ?, 5)`)
      .run(session, bench, 200 - index * 10);
    db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, ?, 12)`)
      .run(session, raise, 10 + index * 5);
  });

  const read = wholePersonTrajectory({ end: "2026-06-25", days: 56 });
  const strength = read.domains.find((domain) => domain.domain === "strength");
  assert.equal(strength.verdict, "worse");
  assert.match(strength.why, /Bench Press/);
  assert.match(strength.why, /Lateral Raise/);
  assert.match(strength.why, /other lift is still advancing/);
  assert.ok(read.unexplained_worse.includes("strength"));
  assert.equal(read.revision_needed, true);
});
