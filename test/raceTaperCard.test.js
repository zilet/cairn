import { test } from "node:test";
import assert from "node:assert/strict";
import { stressReducedItemDose } from "../dist/repo/daily-composition.js";
import { raceTrimForPlanDay } from "../dist/repo/race-taper-card.js";
import { stressBudgetCalendarTrim } from "../dist/repo/stress-budget.js";
import { localDaysAgo } from "./_seed.js";

// Live (2026-10-19): Friday's Lower in taper week, 13 days out, read "Back Squat 155,
// Deadlift 210" at full sets on the plan day-detail — the stress budget's taper trim is
// applied only by daily composition on the morning itself. A day ahead now shows the card
// that morning will carry, from composition's own clamp and the budget's own decision.

test("the day-ahead dose is composition's reduced-area clamp: two sets, an eased load, the taper note", () => {
  const date = localDaysAgo(-4);
  const dose = stressReducedItemDose(
    { exercise: "Back Squat", muscle_group: "quads", mode: "reps", sets: 3, target_weight: 155 },
    date,
    "race_taper_legs"
  );
  assert.equal(dose.sets, 2);
  assert.ok(dose.target_weight < 155 && dose.target_weight >= 135, `eased onto the grid, got ${dose.target_weight}`);
  assert.match(dose.note ?? "", /taper|lighter|fresh/i);
  const again = stressReducedItemDose(
    { exercise: "Back Squat", muscle_group: "quads", mode: "reps", sets: 3, target_weight: 155 },
    date,
    "race_taper_legs"
  );
  assert.equal(again.note, dose.note, "the same morning reads the same words");

  const hold = stressReducedItemDose(
    { exercise: "Copenhagen Plank", muscle_group: "core", mode: "timed", sets: 3, target_seconds: 40 },
    date,
    "race_week_legs"
  );
  assert.equal(hold.target_seconds, 36);
  assert.equal(hold.sets, 2);
});

test("with no dated race on file there is nothing to trim", () => {
  const items = [{ exercise: "Back Squat", muscle_group: "quads", sets: 3, target_weight: 155 }];
  assert.equal(stressBudgetCalendarTrim(localDaysAgo(-4), items, "supporting"), null);
  assert.equal(
    raceTrimForPlanDay(localDaysAgo(-4), items, (item) => item),
    null
  );
});
