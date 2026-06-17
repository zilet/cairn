// estimateExpenditure (src/repo.ts) is the adherence-NEUTRAL energy-balance
// derivation. Constitution-critical: a thin logging week only lowers CONFIDENCE,
// it never errors and never reads a gap as a number to act on; an active
// trip/illness window suppresses confidence rather than re-targeting on noise.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedIntake, seedWeight, isoDaysAgo } from "./_seed.js";

beforeEach(() => {
  resetTables("food_notes", "bodyweight_log", "context_events");
});

test("returns null tdee / 'none' confidence with no data (never throws)", () => {
  const e = repo.estimateExpenditure(21);
  assert.equal(e.tdee, null);
  assert.equal(e.confidence, "none");
  assert.equal(e.intake_avg_kcal, null);
  assert.equal(e.trend_lb_wk, null);
  assert.equal(e.points, 0);
});

test("derives a tdee from steady intake + a real weight trend", () => {
  for (let i = 0; i < 10; i++) seedIntake(i, 2500);
  const wdays = [14, 11, 8, 6, 3, 0];
  let w = 185;
  for (const d of wdays) { seedWeight(isoDaysAgo(d), w); w -= 0.4; }
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
  seedWeight(isoDaysAgo(4), 180);
  seedWeight(isoDaysAgo(0), 179.5);
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
  for (const d of wdays) { seedWeight(isoDaysAgo(d), w); w -= 0.4; }
  const before = repo.estimateExpenditure(21);
  assert.equal(before.confidence, "medium");

  repo.addContextEvent({ kind: "trip", title: "Conference", start_date: isoDaysAgo(2), end_date: isoDaysAgo(-2) });
  const during = repo.estimateExpenditure(21);
  assert.equal(during.confidence, "low", "trip steps confidence down");
  assert.equal(during.tdee, before.tdee, "suppression lowers confidence, not the estimate");
});

test("an illness life_event also suppresses confidence", () => {
  for (let i = 0; i < 10; i++) seedIntake(i, 2500);
  const wdays = [14, 11, 8, 6, 3, 0];
  let w = 185;
  for (const d of wdays) { seedWeight(isoDaysAgo(d), w); w -= 0.4; }
  assert.equal(repo.estimateExpenditure(21).confidence, "medium");
  repo.addContextEvent({ kind: "life_event", title: "Down with the flu", start_date: isoDaysAgo(1), end_date: null });
  assert.equal(repo.estimateExpenditure(21).confidence, "low");
});

test("days with no food logged are absent, never counted as a zero-kcal crash diet", () => {
  // Only 3 logged intake days at 2400; their average is 2400, not diluted by the
  // unlogged days in the 21-day window.
  seedIntake(0, 2400);
  seedIntake(2, 2400);
  seedIntake(5, 2400);
  seedWeight(isoDaysAgo(6), 180);
  seedWeight(isoDaysAgo(0), 180);
  const e = repo.estimateExpenditure(21);
  assert.equal(e.intake_avg_kcal, 2400);
  assert.equal(e.points, 3);
});
