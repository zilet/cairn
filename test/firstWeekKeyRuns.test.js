// The welcome preview lays strength days with the same key-run trade the live week
// uses (keyRunAwarePlacement): a heavy-lower day moves off a quality or long run and
// the days beside them. An easy run is not a key run.
import assert from "node:assert/strict";
import test from "node:test";
import { welcomeWeekFrom, welcomeWeekPreview } from "../dist/coachOps.js";
import { planDayCandidates, thisWeekPlanDayMap, weekdayPlanDayMap } from "../dist/repo/plan-selection.js";
import { repo } from "./_seed.js";

// 2031-07-14 is a Monday, and nothing is logged, so the live week is the unphased deal.
const MON = "2031-07-14";

const lift = (exercise) => ({ exercise, sets: 3, rep_low: 5, rep_high: 8, target_weight: 100 });

function seedWeek({ easyTuesday = false } = {}) {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  repo.savePlanDay(1, "Lower", "Squat", [lift("Back Squat")]);
  repo.savePlanDay(2, "Push", "Press", [lift("Bench Press")]);
  repo.setProfile({
    strength_schedule: { days: [{ dow: 1 }, { dow: 2 }], source: "athlete" },
    endurance_schedule: {
      days: easyTuesday
        ? [{ dow: 2, kind: "easy" }]
        : [
            { dow: 4, kind: "quality" },
            { dow: 0, kind: "long" },
          ],
      source: "athlete",
    },
  });
}

test("quality Thursday and long Sunday move Lower off the day after the long run, matching the live week", () => {
  seedWeek();
  const naive = weekdayPlanDayMap(planDayCandidates(), [1, 2]);
  assert.equal(naive.get(1)?.day_number, 1, "the deal alone puts Lower on Monday, the day after the long run");
  assert.equal(naive.get(2)?.day_number, 2);

  const preview = welcomeWeekFrom(repo.getPlan());
  assert.deepEqual(preview, [
    { dow: 1, day_number: 2, name: "Push" },
    { dow: 2, day_number: 1, name: "Lower" },
  ]);
  assert.deepEqual(welcomeWeekPreview(repo.getPlan()), preview);

  const live = thisWeekPlanDayMap(MON);
  assert.equal(live.map.get(1)?.day_number, 2);
  assert.equal(live.map.get(2)?.day_number, 1);
  assert.equal(live.map.get(2)?.name, "Lower");
});

test("an easy run is not a key run, so Lower stays on the weekday the deal gave it", () => {
  seedWeek({ easyTuesday: true });
  assert.deepEqual(welcomeWeekFrom(repo.getPlan()), [
    { dow: 1, day_number: 1, name: "Lower" },
    { dow: 2, day_number: 2, name: "Push" },
  ]);
  const live = thisWeekPlanDayMap(MON);
  assert.equal(live.map.get(1)?.day_number, 1);
  assert.equal(live.map.get(2)?.day_number, 2);
});
