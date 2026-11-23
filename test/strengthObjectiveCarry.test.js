// A lift goal follows its movement through a RECORDED plan swap
// (src/repo/strength-objective-carry.ts): the journey, the completion ledger and the week
// read all count the replacement's sets from the swap day on, and say so. Nothing is
// guessed from the plan, nothing is merged across patterns, and bringing the original
// lift back ends the carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { strengthObjectiveCarry } from "../dist/repo/strength-objective-carry.js";
import { weekRead } from "../dist/domain/training/week-read.js";
import { renderStrengthJourney } from "../dist/prompt/shared.js";
import { localDateISO } from "../dist/repo/shared.js";

const back = (n) => new Date(new Date(`${localDateISO()}T00:00:00Z`).getTime() - n * 864e5).toISOString().slice(0, 10);
const log = (exercise, weight, reps, daysAgo) => repo.logSetByName({ exercise, weight, reps, rir: 2, date: back(daysAgo) });
const PENDLAY = "Pendlay Row";
const BENT = "Barbell Bent Over Row";

/** A Pendlay row goal with history, on the plan's Pull day. */
function seedRowGoal(days = [60, 50, 40, 30, 20]) {
  repo.upsertExercise({ name: PENDLAY, muscle_group: "back", mode: "reps" });
  repo.upsertExercise({ name: BENT, muscle_group: "back", mode: "reps" });
  for (const n of days) log(PENDLAY, 145, 10, n);
  const objective = repo.setStrengthObjective({ exercise: PENDLAY, target_kind: "explicit_est_1rm", target_est_1rm: 207 });
  repo.savePlanDay(1, "Pull", "Back", [{ exercise: PENDLAY, sets: 3, rep_low: 8, rep_high: 10 }]);
  return objective;
}

/** The plan swaps the lift out, the swap stamped `daysAgo` days back. */
function swap(from, to, daysAgo) {
  const res = repo.buildAndApplySwap(1, from, to);
  assert.equal(res.ok, true, JSON.stringify(res));
  db.prepare(
    `UPDATE plan_proposals SET created_at = ? WHERE id = (SELECT MAX(id) FROM plan_proposals WHERE status = 'applied')`
  ).run(`${back(daysAgo)} 12:00:00`);
}

test("a recorded same-pattern swap carries the goal: the replacement's sets count from the swap day", () => {
  const objective = seedRowGoal();
  // A bent-over set from BEFORE the swap never joins the goal's history.
  log(BENT, 185, 10, 45);
  assert.equal(strengthObjectiveCarry(objective), null, "no carry while the goal's own lift is planned");
  assert.equal(repo.getStrengthJourney({ exercise: PENDLAY }).tracked, null);

  swap(PENDLAY, BENT, 10);
  log(BENT, 155, 7, 3);

  const carry = strengthObjectiveCarry(objective);
  assert.equal(carry?.exercise, BENT);
  assert.equal(carry?.from, PENDLAY);
  assert.equal(carry?.since, back(10));

  const journey = repo.getStrengthJourney({ exercise: PENDLAY });
  assert.equal(journey.objective.exercise, PENDLAY, "the objective row is untouched");
  assert.equal(journey.objective.status, "active");
  assert.deepEqual(journey.tracked, { exercise: BENT, from: PENDLAY, since: back(10) });
  assert.equal(journey.latest.date, back(3), "the latest exposure is the replacement's");
  assert.equal(journey.latest.est_1rm, 191.2);
  assert.equal(journey.best.est_1rm, 193.3, "the pre-swap bent-over set is not in the goal's history");
  assert.match(journey.capacity_basis, /Barbell Bent Over Row carries this goal/);
  assert.match(renderStrengthJourney({ strength_journey: journey }), /goal FOLLOWS THE MOVEMENT/);

  const goal = weekRead().goals.find((g) => g.key === "strength");
  assert.equal(goal.id, "strength:pendlay row", "the row keeps the goal's id");
  assert.equal(goal.label, BENT, "and is named by the lift now trained");
  assert.match(goal.carried_words, /^Carries your Pendlay Row goal since /);
  assert.doesNotMatch(JSON.stringify(goal), /\b\d{4}-\d{2}-\d{2}\b/);

  // The original lift comes back: the carry ends, the goal reads its own exercise again.
  swap(BENT, PENDLAY, 0);
  assert.equal(strengthObjectiveCarry(objective), null);
  const again = repo.getStrengthJourney({ exercise: PENDLAY });
  assert.equal(again.tracked, null);
  assert.equal(again.latest.date, back(20));
});

test("a set on the lift carrying the goal can reach it", () => {
  const objective = seedRowGoal();
  swap(PENDLAY, BENT, 10);
  log(BENT, 180, 8, 0);
  const stored = repo.getStrengthObjective(objective.id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.achieved_est_1rm, 228);
  assert.equal(stored.achieved_date, back(0));
});

test("a swap to another movement pattern carries nothing", () => {
  const objective = seedRowGoal();
  repo.upsertExercise({ name: "Lat Pulldown", muscle_group: "back", mode: "reps" });
  swap(PENDLAY, "Lat Pulldown", 10);
  log("Lat Pulldown", 200, 8, 0);
  assert.equal(strengthObjectiveCarry(objective), null);
  assert.equal(repo.getStrengthObjective(objective.id).status, "active");
  assert.equal(repo.getStrengthJourney({ exercise: PENDLAY }).tracked, null);
});

test("a bodyweight lift swapped for a loaded one carries nothing: they are not one scale", () => {
  repo.upsertExercise({ name: "Weighted Pull-Up", muscle_group: "back", mode: "reps" });
  repo.upsertExercise({ name: "Lat Pulldown", muscle_group: "back", mode: "reps" });
  for (const n of [40, 30, 20]) log("Weighted Pull-Up", 25, 6, n);
  const objective = repo.setStrengthObjective({ exercise: "Weighted Pull-Up", target_kind: "explicit_est_1rm", target_est_1rm: 60 });
  repo.savePlanDay(1, "Pull", "Back", [{ exercise: "Weighted Pull-Up", sets: 3, rep_low: 5, rep_high: 8 }]);
  swap("Weighted Pull-Up", "Lat Pulldown", 10);
  log("Lat Pulldown", 150, 8, 0);
  assert.equal(strengthObjectiveCarry(objective), null);
  assert.equal(repo.getStrengthObjective(objective.id).status, "active");
});

test("no recorded swap: nothing is guessed from the plan, and a lift gone quiet says when it was last trained", () => {
  const objective = seedRowGoal([70, 60, 50, 40]);
  // The plan day is rewritten by hand: no swap is on record.
  repo.savePlanDay(1, "Pull", "Back", [{ exercise: BENT, sets: 3, rep_low: 8, rep_high: 10 }]);
  log(BENT, 155, 7, 3);
  assert.equal(strengthObjectiveCarry(objective), null);
  const goal = weekRead().goals.find((g) => g.key === "strength");
  assert.equal(goal.label, PENDLAY);
  assert.equal(goal.direction, null, "no call from a reading that old");
  assert.match(goal.direction_words, /^Last trained .+, goal \d+ lb$/);
  assert.equal(goal.move_words, null);
  assert.equal(goal.carried_words, null);
});
