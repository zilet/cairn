// A leg-only endurance caution never rests, eases or holds a lifting day that does not
// touch the legs (owner ruling, 2026-10-21). The live morning that prompted it: three
// loading days in a row (long run, then lifts with runs), a fresh readiness, and the
// hybrid-interference caution as the only brake — over a pull day whose focus is
// literally "leg-free". The stack read REST, the learned ladder softened it to EASY, and
// the athlete was handed a spin and a walk on a stated lifting day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

// Wednesday 2026-10-21 (a stated lifting day), local noon.
function onWednesday(t) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 21, 12, 0, 0) });
  const today = localDateISO();
  assert.equal(dowOf(today), 3);
  return today;
}

function upperLift(date, exercise) {
  for (let n = 1; n <= 4; n++) repo.logSetByName({ date, exercise, weight: 135, reps: 8, rir: 1 });
  repo.getOrCreateSession(date, null);
  repo.setSessionFeedback(date, { performance: 4 });
}

// A Mon–Fri lifter who runs Sun long / Thu quality, with a plan whose days are
// `days` ([name, exercise] pairs), and the stacked week the live morning had.
function athlete(today, days) {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest" });
  repo.upsertExercise({ name: "Barbell Row", muscle_group: "back" });
  repo.upsertExercise({ name: "Barbell Squat", muscle_group: "quads" });
  days.forEach(([name, exercise], i) =>
    repo.savePlanDay(i + 1, name, name, [{ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 }])
  );
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: {
      priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
      endurance_role: "supporting",
    },
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 0, kind: "long" },
        { dow: 4, kind: "quality" },
      ],
      source: "athlete",
    },
  });
  repo.setSettings({ training_drive: "push" });
  for (let back = 1; back <= 20; back++) {
    repo.upsertGarminDailyMetric({
      date: addDays(today, -back),
      hrv_ms: [48, 50, 52, 54, 56][back % 5],
      resting_hr: [50, 51, 52, 53, 54][back % 5],
      sleep_min: 460,
    });
  }
  // Sunday's long run, hard; Monday and Tuesday lift, with a hard run on Monday.
  repo.addActivity({ type: "run", date: addDays(today, -3), distance_km: 18, duration_min: 105, rpe: 7 });
  repo.addActivity({ type: "run", date: addDays(today, -2), distance_km: 10, duration_min: 50, rpe: 7 });
  upperLift(addDays(today, -2), "Barbell Bench Press");
  upperLift(addDays(today, -1), "Barbell Bench Press");
  repo.upsertGarminDailyMetric({ date: today, hrv_ms: 54, resting_hr: 50, sleep_min: 470, training_readiness: 75 });
}

test("a leg-only endurance caution does not rest or ease an upper-body lifting day", (t) => {
  const today = onWednesday(t);
  athlete(today, [
    ["Push", "Barbell Bench Press"],
    ["Pull", "Barbell Row"],
  ]);
  const r = repo.dayRead(today);
  assert.ok(
    (r.signals.deciding_brakes ?? []).includes("hybrid_interference"),
    `the fixture carries the endurance caution: ${JSON.stringify(r.signals.deciding_brakes)}`
  );
  assert.equal(r.signals.endurance_off_due_day, true);
  assert.equal(r.kind, "train", `${r.decision.rule_code}: ${r.why}`);
  assert.notEqual(r.decision.rule_code, "stated_lift_dosed", "nothing on this day is a reason to dose the lift");
  assert.doesNotMatch(r.why, /legs/i, "the leg caution does not lead an upper-body day");
  assert.equal(violatesReadingGrammar(r.why), null);
});

test("the same caution still counts when the lifting day due loads the legs", (t) => {
  const today = onWednesday(t);
  athlete(today, [["Lower", "Barbell Squat"]]);
  const r = repo.dayRead(today);
  assert.ok((r.signals.deciding_brakes ?? []).includes("hybrid_interference"));
  assert.notEqual(r.signals.endurance_off_due_day, true);
});
