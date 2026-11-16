// A regressing lift under cut pressure may only blame FOOD when the fuel read itself
// asked for a hold/reduce. `cut.any` is also true off the cut's loss pace or anchors
// sliding, which say nothing about the diary (a sparse diary is absent, never "light").
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo } from "./_seed.js";
import { nextPrescription } from "../dist/repo/progression.js";
import * as voice from "../dist/repo/progression-voice.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";

beforeEach(() => {
  for (const t of ["logged_sets", "plan_items", "plan_days", "sessions", "exercises", "food_notes", "fueling_feedback", "nutrition_targets"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* absent */ }
  }
});

function seedSlippingDeadlift() {
  repo.upsertExercise({ name: "Deadlift", muscle_group: "hamstrings", mode: "reps" });
  const day = repo.savePlanDay(1, "Pull", "Pull", [
    { exercise: "Deadlift", sets: 3, rep_low: 5, rep_high: 5, target_weight: 365 },
  ]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(localDaysAgo(90), day.id);
  const ex = repo.findExercise("Deadlift");
  for (const [d, w] of [[28, 365], [21, 355], [14, 345], [5, 335]]) {
    const s = repo.getOrCreateSession(localDaysAgo(d), null);
    db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, ?, 5, 1)`).run(s.id, ex.id, w);
  }
}

const cut = (o) => {
  const c = { hold: false, reduce: false, sliding: false, fast_loss: false, near_goal: false, ...o };
  return { ...c, deep: c.sliding || c.fast_loss, any: c.hold || c.reduce || c.sliding || c.fast_loss };
};
const FUEL_CLAIM = /fuel|food|eating/i;

for (const [label, o] of [["sliding anchors", { sliding: true }], ["fast loss pace", { fast_loss: true }]]) {
  test(`a slip under ${label} with no fuel pressure holds without blaming food`, () => {
    seedSlippingDeadlift();
    const p = nextPrescription("Deadlift", undefined, { cut: cut(o) });
    assert.equal(p.action, "hold");
    assert.equal(p.suggested.weight, 365);
    assert.doesNotMatch(p.why, FUEL_CLAIM);
    assert.ok(voice.CUT_REGRESSION_HOLD_NO_FUEL_CLAIM.includes(p.why), "one variant of the no-claim set");
    assert.equal(violatesReadingGrammar(p.why), null);
  });
}

for (const [label, o] of [["hold", { hold: true }], ["reduce", { reduce: true }]]) {
  test(`a slip with the fuel read's own ${label} still tells the fueling story`, () => {
    seedSlippingDeadlift();
    const p = nextPrescription("Deadlift", undefined, { cut: cut(o) });
    assert.equal(p.action, "hold");
    assert.ok(voice.CUT_REGRESSION_HOLD.includes(p.why));
    assert.match(p.why, FUEL_CLAIM);
  });
}

test("the no-claim set is a real variant set and never blames or scores", () => {
  assert.ok(voice.CUT_REGRESSION_HOLD_NO_FUEL_CLAIM.length >= 3);
  for (const line of voice.CUT_REGRESSION_HOLD_NO_FUEL_CLAIM) {
    assert.doesNotMatch(line, FUEL_CLAIM);
    assert.doesNotMatch(line, /\d/);
    assert.equal(violatesReadingGrammar(line), null);
  }
});
