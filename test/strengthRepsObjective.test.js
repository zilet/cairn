// A bodyweight lift's goal counts REPS (src/repo/strength-reps.ts, target_kind
// 'bodyweight_reps'): a pull-up goal reads its now, its goal and its direction off sets
// logged at bodyweight, an assisted set never counts (less assist is progress), a
// logged session that meets it completes it, and a loaded lift is refused one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { strengthObjectiveCarry } from "../dist/repo/strength-objective-carry.js";
import { weekRead } from "../dist/domain/training/week-read.js";
import { todayPath } from "../dist/repo/today-path.js";
import { renderStrengthJourney } from "../dist/prompt/shared.js";
import { localDateISO } from "../dist/repo/shared.js";

const back = (n) => new Date(new Date(`${localDateISO()}T00:00:00Z`).getTime() - n * 864e5).toISOString().slice(0, 10);
const PULL = "Pull-Up";
const set = (weight, reps, daysAgo) => repo.logSetByName({ exercise: PULL, weight, reps, rir: 1, date: back(daysAgo) });
const day = (reps, daysAgo, weight = null) => reps.map((r) => set(weight, r, daysAgo));

function pullUp() {
  repo.upsertExercise({ name: PULL, muscle_group: "back", mode: "reps" });
}

test("the schema carries the reps columns and a reps goal stores 0 as its est-1RM", () => {
  const cols = db
    .prepare("PRAGMA table_info(strength_objectives)")
    .all()
    .map((c) => c.name);
  for (const c of ["target_reps", "target_sets", "baseline_reps", "achieved_reps"]) assert.ok(cols.includes(c), c);
  pullUp();
  day([8], 3);
  const objective = repo.setStrengthObjective({ exercise: PULL, target_kind: "bodyweight_reps", target_reps: 12 });
  assert.equal(objective.target_kind, "bodyweight_reps");
  assert.equal(objective.target_est_1rm, 0);
  assert.equal(objective.target_reps, 12);
  assert.equal(objective.target_sets, null);
  assert.equal(objective.baseline_reps, 8);
  assert.equal(objective.status, "active");
});

test("a 3 × 10 pull-up goal reads now, goal and direction from bodyweight sets", () => {
  pullUp();
  day([6, 5, 5], 35);
  day([8, 7, 6], 20);
  day([9, 8, 6], 13);
  day([10, 10, 7], 6);
  const objective = repo.setStrengthObjective({
    exercise: PULL,
    target_kind: "bodyweight_reps",
    target_reps: 10,
    target_sets: 3,
  });
  assert.equal(objective.target_sets, 3);
  assert.equal(objective.baseline_reps, 27, "10, 10, 7 counts 27 of the goal's 30");

  const journey = repo.getStrengthJourney({ exercise: PULL });
  assert.equal(journey.available, true);
  assert.equal(journey.current, null, "no est-1RM is read for a reps goal");
  assert.equal(journey.gap_lb, null);
  assert.equal(journey.projection, null);
  assert.equal(journey.reps.goal_text, "3 × 10");
  assert.equal(journey.reps.goal_value, 30);
  assert.equal(journey.reps.now.text, "10, 10, 7");
  assert.equal(journey.reps.now.value, 27);
  assert.equal(journey.reps.four_weeks_ago.value, 16, "the envelope 28 days back: 6, 5, 5");
  assert.equal(journey.reps.direction, "toward");
  assert.equal(journey.trend.direction, "rising");
  assert.equal(journey.tracked, null);

  const prompt = renderStrengthJourney({ strength_journey: journey });
  assert.match(prompt, /10, 10, 7/);
  assert.match(prompt, /3 × 10 at bodyweight/);
  assert.doesNotMatch(prompt, /\b0 lb\b/);

  const row = todayPath().board.find((r) => r.key === "strength");
  assert.equal(row.label, PULL);
  assert.equal(row.now_text, "10, 10, 7");
  assert.equal(row.goal_text, "3 × 10");
  assert.equal(row.reached, false);

  const goal = weekRead().goals.find((g) => g.key === "strength");
  assert.equal(goal.now_text, "10, 10, 7");
  assert.equal(goal.goal_text, "3 × 10");
  assert.equal(goal.goal_words, "3 × 10");
  assert.equal(goal.direction, "toward");
  assert.match(goal.move_words, /^11 reps up since /);
  assert.equal(goal.direction_words, "Moving toward 3 × 10", "the reps goal is said in words");
  assert.equal(goal.mark_words, null, "no standard and no build mark for a rep count");
  assert.equal(goal.carried_words, null);
  assert.ok(goal.track, "a track from start to goal");
  assert.match(goal.line, /^Best 10, 10, 7 at bodyweight/);
  assert.doesNotMatch(JSON.stringify(goal), /Est\. 1RM|\b0 lb\b/);
});

test("while every set is assisted, now is 0 reps and the assist shrinking is the progress", () => {
  pullUp();
  day([6, 6], 30, -40);
  day([6, 6], 3, -25);
  repo.setStrengthObjective({ exercise: PULL, target_kind: "bodyweight_reps", target_reps: 5 });
  const journey = repo.getStrengthJourney({ exercise: PULL });
  assert.equal(journey.reps.now.value, 0, "an assisted set never counts toward an unassisted goal");
  assert.equal(journey.reps.now.text, "0 reps");
  assert.equal(journey.reps.now.assist_lb, 25);
  assert.equal(journey.reps.direction, "toward", "15 lb less assist over four weeks");

  const goal = weekRead().goals.find((g) => g.key === "strength");
  assert.equal(goal.now_text, "0 reps");
  assert.equal(goal.direction, "toward");
  assert.equal(goal.move_words, "25 lb of assist, down from 40");
  const row = todayPath().board.find((r) => r.key === "strength");
  assert.equal(row.note, "25 lb of assist, down from 40");
  assert.match(renderStrengthJourney({ strength_journey: journey }), /less assist is progress/);
});

test("a logged session that meets the goal completes it, and a correction below it reopens it", () => {
  pullUp();
  day([10, 10, 7], 6);
  const objective = repo.setStrengthObjective({
    exercise: PULL,
    target_kind: "bodyweight_reps",
    target_reps: 10,
    target_sets: 3,
  });
  // An assisted 10 never closes it.
  set(-20, 10, 0);
  assert.equal(repo.getStrengthObjective(objective.id).status, "active");
  set(null, 10, 0);
  set(null, 10, 0);
  assert.equal(repo.getStrengthObjective(objective.id).status, "active", "two unassisted sets of three");
  const third = set(null, 11, 0);
  const done = repo.getStrengthObjective(objective.id);
  assert.equal(done.status, "completed");
  assert.equal(done.achieved_reps, 30);
  assert.equal(done.achieved_date, back(0));
  assert.equal(weekRead().goals.find((g) => g.key === "strength").direction, "reached");
  assert.match(weekRead().goals.find((g) => g.key === "strength").direction_words, /^Reached \d+ × \d+$/);

  repo.updateSet(Number(third.id), { reps: 8 });
  const reopened = repo.getStrengthObjective(objective.id);
  assert.equal(reopened.status, "active");
  assert.equal(reopened.achieved_reps, null);
});

test("a set with added load counts as its reps; a goal already met is recorded reached", () => {
  pullUp();
  day([12], 2, 10);
  const objective = repo.setStrengthObjective({ exercise: PULL, target_kind: "bodyweight_reps", target_reps: 12 });
  assert.equal(objective.status, "completed");
  assert.equal(objective.achieved_reps, 12);
});

test("a reps goal is refused on a loaded lift, and an est-1RM goal on a lift only done at bodyweight", () => {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.logSetByName({ exercise: "Barbell Bench Press", weight: 135, reps: 8, rir: 2, date: back(2) });
  assert.throws(
    () => repo.setStrengthObjective({ exercise: "Barbell Bench Press", target_kind: "bodyweight_reps", target_reps: 10 }),
    /loaded lift/
  );
  pullUp();
  day([9], 2);
  assert.throws(
    () => repo.setStrengthObjective({ exercise: PULL, target_kind: "explicit_est_1rm", target_est_1rm: 250 }),
    /counts reps/
  );
  assert.throws(
    () => repo.setStrengthObjective({ exercise: PULL, target_kind: "bodyweight_reps", target_reps: 0 }),
    /target_reps/
  );
  assert.equal(repo.listActiveStrengthObjectives().length, 0);
});

test("a reps goal never carries through a swap: a chin-up is not a pull-up's rep scale", () => {
  pullUp();
  repo.upsertExercise({ name: "Chin-Up", muscle_group: "back", mode: "reps" });
  day([8, 8], 20);
  const objective = repo.setStrengthObjective({ exercise: PULL, target_kind: "bodyweight_reps", target_reps: 12 });
  repo.savePlanDay(1, "Pull", "Back", [{ exercise: PULL, sets: 3, rep_low: 6, rep_high: 10 }]);
  const res = repo.buildAndApplySwap(1, PULL, "Chin-Up");
  assert.equal(res.ok, true, JSON.stringify(res));
  repo.logSetByName({ exercise: "Chin-Up", weight: null, reps: 14, rir: 1, date: back(0) });
  assert.equal(strengthObjectiveCarry(objective), null);
  const journey = repo.getStrengthJourney({ exercise: PULL });
  assert.equal(journey.tracked, null);
  assert.equal(journey.reps.now.text, "8 reps", "the chin-up's 14 never joins the pull-up goal");
  assert.equal(repo.getStrengthObjective(objective.id).status, "active");
});

test("beside an est-1RM goal the pull-up is one lift of the strength row, in reps", () => {
  repo.upsertExercise({ name: "Barbell Back Squat", muscle_group: "legs", mode: "reps" });
  for (const n of [20, 13, 6]) repo.logSetByName({ exercise: "Barbell Back Squat", weight: 225, reps: 5, rir: 2, date: back(n) });
  repo.setStrengthObjective({ exercise: "Barbell Back Squat", target_kind: "explicit_est_1rm", target_est_1rm: 300 });
  pullUp();
  day([8], 20);
  day([9], 6);
  repo.setStrengthObjective({ exercise: PULL, target_kind: "bodyweight_reps", target_reps: 12 });
  const goal = weekRead().goals.find((g) => g.key === "strength");
  assert.equal(goal.lifts.length, 2);
  const lift = goal.lifts.find((l) => l.label === PULL);
  assert.equal(lift.now_text, "9 reps");
  assert.equal(lift.goal_text, "12 reps");
  assert.equal(lift.mark_words, null);
  assert.ok(lift.track);
  // The anchor stays the est-1RM lift.
  assert.equal(todayPath().anchor?.exercise, "Barbell Back Squat");
});
