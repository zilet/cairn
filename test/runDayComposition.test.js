// The run morning that still served legs. 2026-09-17: a 9.8 km hilly run before
// work, the athlete opens Today, taps their own "Lower B" pill, and the card
// comes back with deadlifts, split squats and calf raises — merely lighter. The
// envelope had already said the legs were saturated and that chest, triceps and
// back were open; composition only ever read the first half.
//
// These cases hold the second half: a plan-sourced slot on a saturated group is
// re-pointed at the athlete's OWN work for an allowed group, carrying that
// movement's own anchor, and the session says why.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  ENDURANCE_SUBSTITUTED_SESSION_WHY,
  SUBSTITUTION_UNAVAILABLE_NOTES,
} from "../dist/repo/saturated-substitution.js";
import { publicTodayPlanDay } from "../dist/routes/today.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-09-18"; // a Thursday

beforeEach(() => {
  resetTables(
    "daily_session_compositions",
    "daily_session_decisions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "context_events",
    "checkins",
    "plan_items",
    "plan_days",
    "exercises",
    "activities",
    "garmin_activities",
    "profile"
  );
});

// The athlete's week: three upper days and one lower day, the shape that made the
// incident possible — the leg day is a real programmed day they are entitled to
// pick on any morning they like.
function seedWeek() {
  repo.setProfile({ primary_discipline: "hybrid" });
  repo.savePlanDay(1, "Upper A", "Push", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
  ]);
  repo.savePlanDay(2, "Upper B", "Chest and arms", [
    { exercise: "Incline Dumbbell Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 },
    { exercise: "Cable Triceps Pushdown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 50 },
  ]);
  repo.savePlanDay(3, "Pull", "Back", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12, target_weight: 120 },
  ]);
  repo.savePlanDay(4, "Lower B", "Legs", [
    { exercise: "Barbell Deadlift", sets: 2, rep_low: 6, rep_high: 8, target_weight: 185 },
    { exercise: "Bulgarian Split Squat", sets: 2, rep_low: 10, rep_high: 10, target_weight: 50 },
    { exercise: "Seated Calf Raise", sets: 1, rep_low: 15, rep_high: 15, target_weight: 90 },
  ]);
}

// The morning's own run: hilly, hard, and long enough to read heavy — which is
// what puts quads, hamstrings, glutes and calves in the envelope's saturated set.
function morningRun(date = DATE) {
  repo.addActivity({ type: "run", duration_min: 64, distance_km: 9.82, date, text: "Hilly run, Z3-Z4" });
}

function logHistory() {
  repo.logSetByName({ date: "2031-09-08", exercise: "Lat Pulldown", weight: 120, reps: 9, day_number: null });
  repo.logSetByName({ date: "2031-09-09", exercise: "Barbell Bench Press", weight: 155, reps: 6, day_number: null });
  repo.logSetByName({ date: "2031-09-10", exercise: "Cable Triceps Pushdown", weight: 50, reps: 11, day_number: null });
}

function pickLowerDay(extra = {}) {
  return repo.prepareDailySession({ date: DATE, source: "manual_plan", day_number: 4, ...extra });
}

test("a leg day picked on a run morning composes from the areas the run left alone", () => {
  seedWeek();
  morningRun();
  logHistory();

  const { daily_session: composition } = pickLowerDay();
  const names = composition.items.map((item) => item.exercise);

  assert.ok(
    !names.some((name) => /deadlift|split squat|calf raise/i.test(name)),
    `no saturated leg work survives the run morning (got ${JSON.stringify(names)})`
  );
  // Every slot is still a slot — the day the athlete picked keeps its shape.
  assert.equal(composition.items.length, 3);
  assert.deepEqual(
    [...composition.items.map((item) => item.substitution_for)].sort(),
    ["Barbell Deadlift", "Bulgarian Split Squat", "Seated Calf Raise"].sort(),
    "each original slot still has a stand-in after effect-order"
  );
  // Each stand-in carries its OWN anchor — what the athlete last worked it at —
  // and nothing carries a number this code made up.
  const byName = Object.fromEntries(composition.items.map((item) => [item.exercise, item]));
  for (const [name, item] of Object.entries(byName)) {
    const logged = repo.recentWorkingWeight(name);
    const planned = db
      .prepare(
        `SELECT pi.target_weight AS w FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
          WHERE e.name = ? COLLATE NOCASE AND pi.target_weight IS NOT NULL ORDER BY pi.id DESC LIMIT 1`
      )
      .get(name)?.w;
    assert.ok(
      item.target_weight == null || item.target_weight === logged || item.target_weight === planned,
      `${name} carries its own anchor, not an invented one (got ${item.target_weight})`
    );
  }
  // And the card says why, in words, on every moved slot.
  for (const item of composition.items) {
    assert.match(String(item.brain_change_reason ?? ""), /\S/);
    assert.match(String(item.note ?? ""), /\S/);
  }
  assert.ok(
    ENDURANCE_SUBSTITUTED_SESSION_WHY.includes(composition.why),
    `the session names the cause instead of "switched by you" (got ${JSON.stringify(composition.why)})`
  );
});

test("with nothing else in the week to offer, the leg work stays and the session says so", () => {
  // The same run — but the only fresh work this athlete programs anywhere is
  // already on today's card, so there is nowhere to send the leg slots.
  repo.setProfile({ primary_discipline: "hybrid" });
  repo.savePlanDay(3, "Pull", "Back", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12, target_weight: 120 },
  ]);
  repo.savePlanDay(4, "Lower B", "Legs", [
    { exercise: "Barbell Deadlift", sets: 2, rep_low: 6, rep_high: 8, target_weight: 185 },
    { exercise: "Bulgarian Split Squat", sets: 2, rep_low: 10, rep_high: 10, target_weight: 50 },
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12, target_weight: 120 },
  ]);
  morningRun();
  repo.logSetByName({ date: "2031-09-09", exercise: "Barbell Deadlift", weight: 185, reps: 6, day_number: null });

  const { daily_session: composition } = pickLowerDay();
  const names = composition.items.map((item) => item.exercise);

  assert.deepEqual(names, ["Barbell Deadlift", "Bulgarian Split Squat", "Lat Pulldown"]);
  assert.ok(
    composition.items.every((item) => item.substitution_for == null),
    "nothing was substituted"
  );
  // The old behaviour stands — the work is kept, lightened — and the session is
  // honest about why it is still here.
  assert.ok(
    SUBSTITUTION_UNAVAILABLE_NOTES.some((note) => String(composition.why ?? "").includes(note)),
    `the session explains the work that stayed (got ${JSON.stringify(composition.why)})`
  );
  const deadlift = composition.items.find((item) => item.exercise === "Barbell Deadlift");
  assert.ok(deadlift.sets <= 2, "the held item is still bounded by the reduced-area cap");
});

test("a session with a logged set is never recomposed out from under the athlete", () => {
  seedWeek();
  morningRun();
  logHistory();

  const first = pickLowerDay();
  const composed = first.daily_session.items.map((item) => item.exercise);
  repo.logSetByName({ date: DATE, exercise: composed[0], weight: 100, reps: 8, day_number: 4 });

  // Asking again is a no-op: the composition the athlete is mid-way through is
  // handed straight back.
  const again = pickLowerDay();
  assert.equal(again.reused, true);
  assert.equal(again.daily_session.id, first.daily_session.id);
  assert.deepEqual(
    again.daily_session.items.map((item) => item.exercise),
    composed
  );
  // And an explicit replace is refused outright rather than rewriting the card
  // under the work already logged against it.
  assert.throws(() => pickLowerDay({ replace: true }), (error) => error.code === "daily_session_locked");
  assert.deepEqual(
    repo.getActiveDailySession(DATE).items.map((item) => item.exercise),
    composed
  );
});

test("the plan-day pills are told which days are still recovering", () => {
  seedWeek();
  morningRun();

  const selection = publicTodayPlanDay(DATE);
  const byDay = Object.fromEntries(selection.candidates.map((day) => [day.day_number, day]));

  assert.deepEqual([...byDay[4].recovering_groups].sort(), ["calves", "hamstrings", "quads"]);
  assert.equal(byDay[4].mostly_recovering, true, "the leg day is mostly work the run already did");
  assert.deepEqual(byDay[2].recovering_groups, []);
  assert.equal(byDay[2].mostly_recovering, false);
  // The pick itself is unchanged — this is a hint riding alongside it, not a gate.
  assert.equal(typeof selection.day_number, "number");
});
