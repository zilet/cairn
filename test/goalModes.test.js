// Goal modes (v41) + the daily-fuel review. Constitution-critical: 'maintain' is a
// first-class goal that anchors to real expenditure (no deficit), 'gain' is a
// conservative lean surplus (never a crash bulk), and the day-intake review is
// descriptive-first — a "remaining" only appears when a real target exists.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedIntake, seedWeight, isoDaysAgo } from "./_seed.js";

// A complete profile so computeGoalCheck() is `ok` (needs age/height/weight).
function setProfile(extra = {}) {
  return repo.setProfile({ age: 35, height_cm: 180, weight_lb: 185, activity_factor: 1.5, ...extra });
}

beforeEach(() => {
  resetTables("food_notes", "bodyweight_log", "context_events");
});

test("maintain mode anchors the target to TDEE — no deficit, no pressure", () => {
  setProfile({ goal_mode: "maintain", weight_lb: 185 });
  const g = repo.computeGoalCheck();
  assert.equal(g.ok, true);
  assert.equal(g.goal_mode, "maintain");
  assert.equal(g.recommended.target_intake_kcal, g.tdee, "maintenance target = real TDEE");
  assert.equal(g.recommended.daily_deficit_kcal, 0);
  assert.equal(g.recommended.weekly_rate_lb, 0);
});

test("gain mode targets a conservative surplus above TDEE (never a dirty bulk)", () => {
  setProfile({ goal_mode: "gain", weight_lb: 185 });
  const g = repo.computeGoalCheck();
  assert.equal(g.goal_mode, "gain");
  assert.ok(g.recommended.target_intake_kcal > g.tdee, "surplus is above maintenance");
  assert.ok(g.recommended.weekly_rate_lb > 0 && g.recommended.weekly_rate_lb <= 0.5, "lean-gain rate is capped");
});

test("lose mode keeps a lean-safe deficit below TDEE (existing behavior)", () => {
  setProfile({ goal_mode: "lose", weight_lb: 185, goal_weight_lb: 175 });
  const g = repo.computeGoalCheck();
  assert.equal(g.goal_mode, "lose");
  assert.ok(g.recommended.target_intake_kcal < g.tdee, "deficit is below maintenance");
  assert.ok(g.recommended.daily_deficit_kcal > 0);
});

test("derives lose vs maintain when goal_mode is unset (back-compat)", () => {
  setProfile({ goal_mode: null, weight_lb: 185, goal_weight_lb: 170 }); // goal below current → lose
  assert.equal(repo.computeGoalCheck().goal_mode, "lose");
  setProfile({ goal_mode: null, weight_lb: 185, goal_weight_lb: 185 }); // not below current → maintain
  assert.equal(repo.computeGoalCheck().goal_mode, "maintain");
});

test("getDayIntake sums today's food and shows 'remaining' when a target exists", () => {
  setProfile({ goal_mode: "maintain", weight_lb: 185 });
  seedIntake(0, 600, { protein_g: 40, summary: "Oatmeal & eggs" });
  seedIntake(0, 800, { protein_g: 50, summary: "Chicken bowl" });
  const d = repo.getDayIntake();
  assert.equal(d.count, 2);
  assert.equal(d.totals.kcal, 1400);
  assert.equal(d.totals.protein_g, 90);
  assert.equal(d.entries[0].summary, "Oatmeal & eggs");
  const tdee = repo.computeGoalCheck().tdee;
  assert.equal(d.target.kcal, tdee, "maintain target = TDEE");
  assert.equal(d.remaining.kcal, tdee - 1400, "'remaining', not 'consumed'");
});

test("getDayIntake is descriptive-only (no target) when the profile is incomplete", () => {
  resetTables("profile"); // no age/height/weight → computeGoalCheck not ok
  seedIntake(0, 500, { protein_g: 30, summary: "Snack" });
  const d = repo.getDayIntake();
  assert.equal(d.count, 1);
  assert.equal(d.totals.kcal, 500);
  assert.equal(d.target, null);
  assert.equal(d.remaining, null);
  setProfile(); // restore a complete profile for the rest of the run
});

test("updateFoodNote corrects fields, clamps, and stamps enrichment terminal", () => {
  const row = repo.addFoodNote("lunch", "", { summary: "Bowl", kcal: 700, protein_g: 40 }, undefined);
  repo.setFoodNoteEnrichStatus(row.id, "pending"); // prove the edit makes it terminal
  const upd = repo.updateFoodNote(row.id, { summary: "Chicken bowl", kcal: 999999, protein_g: 55, meal: "dinner" });
  assert.equal(upd.parsed.summary, "Chicken bowl");
  assert.equal(upd.parsed.kcal, 5000, "kcal clamped to the ceiling, never absurd");
  assert.equal(upd.parsed.protein_g, 55);
  assert.equal(upd.meal, "dinner");
  assert.equal(upd.enrichment_status, "done", "a manual edit is authoritative");
  assert.equal(repo.updateFoodNote(999999, { kcal: 1 }), null, "unknown id → null");
});

test("pace_status speaks the goal mode — 'holding' when maintaining, never 'behind'", () => {
  setProfile({ goal_mode: "maintain", weight_lb: 185 });
  seedWeight(isoDaysAgo(10), 185.0);
  seedWeight(isoDaysAgo(0), 185.1); // essentially flat
  const s = repo.getWeeklyStats();
  assert.equal(s.goal_mode, "maintain");
  assert.equal(s.pace_status, "holding");
  assert.notEqual(s.pace_status, "behind");
});

test("gain mode reads a steady upward trend as 'building'", () => {
  setProfile({ goal_mode: "gain", weight_lb: 185 });
  seedWeight(isoDaysAgo(10), 184);
  seedWeight(isoDaysAgo(0), 185); // ~0.7 lb/wk — within the lean-gain lane
  const s = repo.getWeeklyStats();
  assert.equal(s.goal_mode, "gain");
  assert.equal(s.pace_status, "on");
});
