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

test("a cut protects strength so regression remains visible instead of silently parking it", () => {
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb) VALUES (1, 'lose', 180)`).run();
  const read = wholePersonTrajectory({ end: "2026-06-25", days: 56 });
  assert.ok(read.phase.protects.includes("strength"));
  assert.ok(read.phase.optimizes.includes("lean mass retention"));
  assert.ok(!read.phase.parks.includes("strength"));
  assert.equal(read.domains.find((domain) => domain.domain === "strength").parked, false);
});
