// trajectory.ts — ONE forward arc to the athlete's goals, with today as the next
// step on it. Invariants under test:
//   - NULL-quiet on a thin profile: no goal, no active block, no race → line === null,
//     no milestones, no horizon (silence over noise).
//   - horizon clamp 8–12 weeks: a long block clamps DOWN to 12; a short race-in-build
//     clamps UP to 8.
//   - milestone assembly + sort + cap: dated milestones sort ascending, undated lever
//     last, capped at 4.
//   - reuses projectGoalPace().projection_text VERBATIM as the body-comp framing —
//     never recomputes a sentence or a date.
//   - horizon precedence: active block → race-in-build → body-comp.
//
// Deterministic, offline, temp DB (see test/run.mjs). Imports trajectory.js
// directly from dist (the barrel wire-up is the integration owner's job, landing
// at merge — mirrors progression.test.js).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { getTrajectory } from "../dist/repo/trajectory.js";
import { projectGoalPace } from "../dist/repo/profile.js";

// ---- local seeding (kept in-file so we don't touch the shared _seed.js) ----
function reset() {
  for (const t of [
    "logged_sets", "plan_items", "plan_days", "sessions", "exercises",
    "bodyweight_log", "program_blocks", "activities", "garmin_activities",
    "day_reads", "health_documents", "profile", "app_state",
  ]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}
function isoDaysAhead(n) {
  return new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
}

// A clean profile with enough fields for computeGoalCheck to run.
function seedProfile(extra = {}) {
  return repo.setProfile({
    sex: "male", age: 35, height_cm: 180, weight_lb: 190, activity_factor: 1.5,
    ...extra,
  });
}

// A measured downward weight trend over the last 4 weeks — gives projectGoalPace a
// real slope (and so a projected date / projection_text).
function seedLosingTrend() {
  // ~0.5 lb/wk down over 28 days: 192 → 190
  const span = [
    [27, 192], [24, 191.7], [20, 191.2], [16, 190.9],
    [12, 190.6], [8, 190.3], [4, 190.1], [0, 190],
  ];
  for (const [days, lb] of span) repo.logWeight(lb, isoDaysAgo(days));
}

beforeEach(reset);

// ---------------------------------------------------------------------------

test("NULL-quiet on a thin profile — no goal, no block, no race", () => {
  // Bare profile, no goal weight, no endurance goal, no block.
  seedProfile();
  const t = getTrajectory(isoDaysAgo(0));
  assert.equal(t.line, null, "line is null when there's no arc to draw");
  assert.equal(t.horizon_weeks, null);
  assert.equal(t.phase, null);
  assert.equal(t.week_of, null);
  assert.equal(t.today_step, null, "no plan day → no step");
  assert.deepEqual(t.milestones, []);
});

test("a thin profile with NO profile row at all is still quiet, never throws", () => {
  // Don't even seed a profile.
  const t = getTrajectory();
  assert.equal(t.line, null);
  assert.deepEqual(t.milestones, []);
  assert.equal(t.horizon_weeks, null);
});

test("horizon clamps DOWN to 12 for a long block", () => {
  seedProfile();
  // A 12-week block at week 1 → 12 weeks remaining → clamps to the 12 ceiling.
  // (A longer one would clamp the same — createBlock caps total_weeks at 12.)
  repo.createBlock({ goal: "Strength base", focus: "strength", total_weeks: 12, week_index: 1 });
  const t = getTrajectory();
  assert.equal(t.horizon_weeks, 12, "remaining weeks clamp to the 12-week ceiling");
  assert.ok(t.horizon_weeks >= 8 && t.horizon_weeks <= 12, "always within the calm band");
  assert.equal(t.week_of, 1);
  assert.equal(t.phase, "accumulation");
});

test("horizon clamps UP to 8 for a short remaining block", () => {
  seedProfile();
  // A 4-week block at week 3 → 2 weeks remaining → clamps UP to the 8-week floor.
  repo.createBlock({ goal: "Peak", focus: "peak", total_weeks: 4, week_index: 3 });
  const t = getTrajectory();
  assert.equal(t.horizon_weeks, 8, "a short remaining horizon clamps up to the 8-week floor");
  assert.equal(t.week_of, 3);
});

test("horizon precedence — an active block wins over a race-in-build", () => {
  seedProfile({
    // A race ~6 weeks out (in the build window) would, on its own, anchor an
    // 8-week horizon. The active block must take precedence.
    endurance_goal: { mode: "race", event: "Local 10k", date: isoDaysAhead(42), distance_km: 10 },
  });
  repo.createBlock({ goal: "Build phase", focus: "endurance-base", total_weeks: 10, week_index: 4 });
  const t = getTrajectory();
  // Block at week 4 of 10 → 7 remaining → clamps UP to 8; phase from the block.
  assert.equal(t.week_of, 4, "week_of comes from the block, not the race");
  assert.equal(t.phase, "accumulation", "phase comes from the block, not the race phase");
  assert.ok(t.line.startsWith("Week 4 of 10"), `block-led line, got: ${t.line}`);
  // The race still appears as a milestone even though the block leads the horizon.
  const race = t.milestones.find((m) => m.kind === "race");
  assert.ok(race, "race day is still a milestone");
});

test("race-in-build anchors the horizon when there's NO block", () => {
  seedProfile({
    endurance_goal: { mode: "race", event: "Spring Half", date: isoDaysAhead(42), distance_km: 21 },
  });
  const t = getTrajectory();
  assert.ok(t.horizon_weeks >= 8 && t.horizon_weeks <= 12, "race-in-build sets a clamped horizon");
  assert.equal(t.week_of, null, "no block → no week_of");
  assert.ok(/out from Spring Half/.test(t.line), `race-led line, got: ${t.line}`);
  const race = t.milestones.find((m) => m.kind === "race");
  assert.ok(race && race.when === isoDaysAhead(42), "race milestone carries the race date");
});

test("body-comp arc reuses projectGoalPace().projection_text VERBATIM", () => {
  seedProfile({ weight_lb: 190, goal_weight_lb: 175, goal_date: isoDaysAhead(120) });
  seedLosingTrend();
  // Compute the canonical projection the SAME way the module does.
  const prof = repo.getProfile();
  const pace = projectGoalPace(prof, Math.max(0, prof.weight_lb - prof.goal_weight_lb));
  assert.ok(pace.projection_text, "precondition: there IS a projection text to reuse");

  const t = getTrajectory();
  // The projection_text is reused VERBATIM as the LEAD of the line (today's step
  // may be appended after it with the canonical connector — never recomputed).
  assert.ok(
    t.line.startsWith(pace.projection_text),
    `body-comp line leads with projection_text VERBATIM, got: ${t.line}`,
  );
  // And when there's no plan day to derive a step from, the line IS exactly it.
  if (!t.today_step) {
    assert.equal(t.line, pace.projection_text);
  }
});

test("body-comp arc with a projected date contributes a Goal weight milestone", () => {
  seedProfile({ weight_lb: 190, goal_weight_lb: 175, goal_date: isoDaysAhead(120) });
  seedLosingTrend();
  const prof = repo.getProfile();
  const pace = projectGoalPace(prof, prof.weight_lb - prof.goal_weight_lb);
  const t = getTrajectory();
  const goalM = t.milestones.find((m) => m.kind === "goal");
  if (pace.projected_goal_date) {
    assert.ok(goalM, "a goal-weight milestone when there's a projected date");
    assert.equal(goalM.when, pace.projected_goal_date, "goal milestone uses the projected date");
  }
});

test("milestones sort ascending by date, undated lever last, capped at 4", () => {
  // An arc rich enough to overflow the cap: a race, a body-comp goal date, a
  // deload (from accumulation phase), a block end, and an undated health lever.
  seedProfile({ weight_lb: 190, goal_weight_lb: 175, goal_date: isoDaysAhead(120) });
  seedLosingTrend();
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Town 5k", date: isoDaysAhead(30), distance_km: 5 },
  });
  repo.createBlock({ goal: "Mixed block", focus: "strength", total_weeks: 8, week_index: 2 });
  // A health-synthesis "one change" → an undated lever milestone.
  repo.saveHealthSynthesis({ headline: "Lipids are the lead", one_change: "Swap to oily fish 3x/wk" });

  const t = getTrajectory();
  assert.ok(t.milestones.length <= 4, `capped at 4, got ${t.milestones.length}`);

  const dated = t.milestones.filter((m) => m.when);
  // Dated milestones must be in ascending date order.
  for (let i = 1; i < dated.length; i++) {
    assert.ok(dated[i - 1].when <= dated[i].when, `dates ascending: ${dated[i - 1].when} <= ${dated[i].when}`);
  }
  // Any undated milestone (the lever) sorts AFTER all dated ones.
  const firstUndatedIdx = t.milestones.findIndex((m) => !m.when);
  if (firstUndatedIdx !== -1) {
    assert.ok(
      t.milestones.slice(firstUndatedIdx).every((m) => !m.when),
      "once an undated milestone appears, everything after it is undated too",
    );
  }
});

test("today_step folds into the line when a plan day exists", () => {
  seedProfile();
  repo.createBlock({ goal: "Strength base", focus: "strength", total_weeks: 8, week_index: 1 });
  // A plan day gives the day-read / forward-look a focus to surface as today's step.
  repo.savePlanDay(1, "Lower body", "Lower body", [
    { name: "Back Squat", muscle_group: "quads", target_sets: 3, target_reps: 5, target_weight: 185 },
  ]);
  const t = getTrajectory();
  // We don't assert the exact step text (it's day-read dependent), only that when
  // a step exists the line weaves it in with the canonical connector.
  if (t.today_step) {
    assert.ok(t.line.includes("today's step:"), `step folded into line, got: ${t.line}`);
  } else {
    // Still block-led even without a derivable step.
    assert.ok(t.line.startsWith("Week 1 of 8"), `block-led line, got: ${t.line}`);
  }
});

test("never throws and stays within the contract shape on a rich profile", () => {
  seedProfile({ weight_lb: 190, goal_weight_lb: 175, goal_date: isoDaysAhead(90) });
  seedLosingTrend();
  repo.createBlock({ goal: "Block", focus: "strength", total_weeks: 6, week_index: 2 });
  const t = getTrajectory();
  assert.equal(typeof t.line, "string");
  assert.ok(t.horizon_weeks == null || (t.horizon_weeks >= 8 && t.horizon_weeks <= 12));
  assert.ok(Array.isArray(t.milestones));
  for (const m of t.milestones) {
    assert.equal(typeof m.label, "string");
    assert.equal(typeof m.kind, "string");
    assert.ok(m.when === null || /^\d{4}-\d{2}-\d{2}$/.test(m.when));
  }
});
