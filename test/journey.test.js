import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, isoDaysAgo } from "./_seed.js";
import { getTrajectory } from "../dist/repo/trajectory.js";
import { buildMealPlanPrompt } from "../dist/prompt.js";

function reset() {
  resetTables("journey_phases", "body_measurements", "bodyweight_log", "garmin_daily_metrics", "profile", "app_state");
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

function sqlAgo(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");
}

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

test("journey milestones detect weight-loss and percent-to-goal crossings", () => {
  seedProfile({ start_weight_lb: 190, start_date: isoDaysAgo(30), weight_lb: 190, goal_weight_lb: 170 });
  repo.logWeight(188, isoDaysAgo(20));
  repo.logWeight(180, isoDaysAgo(0));

  const milestones = repo.journeyMilestones();
  assert.ok(milestones.find((m) => m.id === "weight-loss-10"), "10 lb threshold crossed");
  assert.ok(milestones.find((m) => m.id === "goal-progress-50"), "halfway-to-goal threshold crossed");
  const top = milestones[0];
  assert.ok(top.priority > 0, "milestones carry internal priority for surfaces");
  assert.ok(top.achieved_date, "milestones carry a date for trajectory placement");
});

test("new journey milestone can feed since-last without surfacing a counter", () => {
  seedProfile({ start_weight_lb: 190, start_date: isoDaysAgo(30), weight_lb: 190, goal_weight_lb: 170 });
  repo.setAppState("today_last_seen_at", sqlAgo(2 * 60 * 60 * 1000));
  repo.logWeight(180, isoDaysAgo(0));

  const m = repo.latestJourneyMilestoneSince(sqlAgo(2 * 60 * 60 * 1000));
  assert.ok(m, "the crossing has a fresh created_at stamp");
  const c = repo.sinceLastLookedCandidate();
  assert.ok(c, "since-last picks up the journey milestone");
  assert.match(c.title, /crossed|goal|down/i);
  assert.ok(!/\bstreak\b/i.test(c.title), "never a streak");
  assert.ok(!/\b\d+\s*\/\s*\d+\b/.test(c.title), "no numeric score");
});

test("trajectory includes one calm journey milestone on the arc", () => {
  seedProfile({ start_weight_lb: 190, start_date: isoDaysAgo(30), weight_lb: 190, goal_weight_lb: 170 });
  repo.logWeight(180, isoDaysAgo(0));

  const t = getTrajectory();
  assert.ok(t.milestones.find((m) => m.kind === "journey"), "journey contributes one trajectory milestone");
});

test("nutrition prompts receive the journey arc without auto-applying phases", () => {
  seedProfile({ start_weight_lb: 190, start_date: "2026-02-01", goal_bodyfat_pct: 15 });
  const phase = repo.createJourneyPhase({
    kind: "cut",
    reason: "Start the cut.",
    source: "test",
  });
  repo.activateJourneyPhase(phase.id);

  const p = buildMealPlanPrompt();
  assert.match(p, /THE ARC/);
  assert.match(p, /active phase: cut/);
  assert.match(p, /continued strength and muscle\s+DEVELOPMENT remain the objective/);
  assert.match(p, /preservation is the universal safety floor, not the aspiration/);
  assert.match(p, /nothing auto-applies/i);
});
