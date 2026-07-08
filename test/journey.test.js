import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, isoDaysAgo } from "./_seed.js";

function reset() {
  resetTables("journey_phases", "body_measurements", "bodyweight_log", "garmin_daily_metrics", "profile");
}

function seedProfile(extra = {}) {
  return repo.setProfile({
    sex: "male",
    age: 44,
    height_in: 70,
    weight_lb: 180,
    goal_weight_lb: 165,
    goal_mode: "lose",
    activity_factor: 1.5,
    ...extra,
  });
}

beforeEach(reset);

test("profile persists journey baseline and body-fat target fields", () => {
  const p = seedProfile({
    start_weight_lb: 205.34,
    start_date: "2026-01-15",
    goal_bodyfat_pct: 15.2,
  });

  assert.equal(p.start_weight_lb, 205.3);
  assert.equal(p.start_date, "2026-01-15");
  assert.equal(p.goal_bodyfat_pct, 15.2);

  const stored = db.prepare(`SELECT start_weight_lb, start_date, goal_bodyfat_pct FROM profile WHERE id = 1`).get();
  assert.deepEqual({ ...stored }, { start_weight_lb: 205.3, start_date: "2026-01-15", goal_bodyfat_pct: 15.2 });
});

test("computeGoalCheck tapers the loss ceiling when tape body-fat estimate is lean", () => {
  seedProfile({ weight_lb: 180, goal_weight_lb: 170 });
  const noBf = repo.computeGoalCheck();
  assert.equal(noBf.safe_max_rate_lb, 1.8, "baseline ceiling remains 1%/wk without BF data");
  assert.equal(noBf.recommended.weekly_rate_lb, 1.35);

  repo.addBodyMeasurement(isoDaysAgo(0), { waist_in: 31, neck_in: 15 }, null, "test");
  const lean = repo.computeGoalCheck();

  assert.equal(lean.leanness_rate.body_fat_source, "tape");
  assert.ok(lean.leanness_rate.body_fat_pct < 15, `expected lean estimate, got ${lean.leanness_rate.body_fat_pct}`);
  assert.equal(lean.safe_max_rate_lb, 0.63, "very-lean ceiling tapers below 1%/wk");
  assert.equal(lean.recommended.weekly_rate_lb, 0.45, "recommended pace tapers harder below ~15% BF");
  assert.match(lean.leanness_rate.reason, /very lean/i);
});

test("journey phases are proposed first and activate only through explicit apply", () => {
  seedProfile({ start_weight_lb: 190, start_date: "2026-02-01", goal_bodyfat_pct: 15 });
  repo.addBodyMeasurement(isoDaysAgo(0), { waist_in: 38, neck_in: 15 }, null, "test");

  const phase = repo.createJourneyPhase({
    kind: "cut",
    reason: "Start the v1 journey.",
    source: "test",
  });

  assert.equal(phase.status, "proposed");
  assert.equal(repo.activeJourneyPhase(), null, "a proposed phase is not active");
  assert.equal(phase.target_weight_lb, 165);
  assert.equal(phase.target_bodyfat_pct, 15);
  assert.equal(phase.source, "test");

  const active = repo.activateJourneyPhase(phase.id);
  assert.equal(active.status, "active");
  assert.equal(repo.activeJourneyPhase().id, phase.id);
});

test("transition suggestion proposes maintenance after reaching the goal without writing a phase", () => {
  seedProfile({ weight_lb: 164.8, goal_weight_lb: 165, goal_bodyfat_pct: 15 });
  const before = repo.listJourneyPhases("all").length;

  const suggestion = repo.journeyTransitionSuggestion("2026-07-08");
  assert.ok(suggestion);
  assert.equal(suggestion.kind, "maintenance");
  assert.equal(suggestion.planned_rate_lb_wk, 0);
  assert.match(suggestion.reason, /Goal reached/i);

  assert.equal(repo.listJourneyPhases("all").length, before, "suggestions are pure reads, not writes");
  assert.equal(repo.activeJourneyPhase(), null, "nothing auto-applies");
});
