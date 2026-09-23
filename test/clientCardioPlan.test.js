import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCardioPlan() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    RegExp,
    String,
    fmtKm: (km) => Number(km).toFixed(1),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/cardio-plan-client.js"), "utf8"), context);
  return context.CairnCardioPlan;
}

test("planned cardio helpers normalize structured intervals", () => {
  const cardio = loadCardioPlan();
  const interval = [{ reps: 6, on: "800m", off: "90s", zone: "Z5" }];

  assert.equal(cardio.cardioIntervalNote(interval), "6 × 800m");
  assert.equal(cardio.cardioIntervalStructure(interval, "Z5 (165-175 bpm)"), "6 × 800m @ Z5 (165-175 bpm), 90s jog");
  assert.equal(cardio.cardioIntervalNote({ note: "3 mi steady" }), "3 mi steady");
  assert.equal(cardio.cardioIntervalNote(" 30 min easy "), "30 min easy");
});

// The label/art/sport helpers served the run card inside the lift list and the
// run rows in the strength editor; runs left the strength plan, so those surfaces
// (and the helpers) are gone. What stays is the cardio predicate and the one filter
// every strength surface uses to keep an older payload's run out of it.
test("the strength-plan filter keeps lifts and drops runs, rest rows and run-only days", () => {
  const cardio = loadCardioPlan();

  assert.equal(cardio.isCardioItem({ kind: "cardio" }), true);
  assert.equal(cardio.isCardioItem({ kind: "strength" }), false);
  assert.equal(cardio.isCardioItem(null), false);

  const bench = { kind: "strength", exercise: "Bench" };
  const run = { kind: "cardio", note: "Easy run", target_distance_km: 6 };
  assert.deepEqual([...cardio.strengthPlanItems([bench, run]).map((item) => item.exercise)], ["Bench"]);
  assert.equal(cardio.strengthPlanItems(null).length, 0);

  assert.equal(cardio.isStrengthPlanDay({ items: [bench, run] }), true);
  assert.equal(cardio.isStrengthPlanDay({ day_type: "rest", items: [] }), false);
  assert.equal(cardio.isStrengthPlanDay({ items: [run] }), false, "a run-only day is not a lift day");
  assert.equal(cardio.isStrengthPlanDay({ items: [] }), true, "an empty training day is the athlete's scaffold");

  const days = cardio.strengthPlanDays([
    { day_number: 1, name: "Pull", items: [bench, run] },
    { day_number: 2, name: "Rest", day_type: "rest", items: [] },
    { day_number: 3, name: "Long Run", items: [{ kind: "cardio", note: "Long run" }] },
  ]);
  assert.deepEqual([...days.map((day) => day.name)], ["Pull"]);
  assert.deepEqual([...days[0].items.map((item) => item.exercise)], ["Bench"]);
  assert.equal(cardio.cardioLabel, undefined, "the run-card label helpers are gone with the run card");
});

test("planned cardio prescription prefers concrete distance, zone, and intervals", () => {
  const cardio = loadCardioPlan();

  assert.equal(
    cardio.cardioPrescription({
      target_distance_km: 12.25,
      target_zone: "Z2",
      interval: [{ reps: 4, on: "1 km", off: "2 min", zone: "Z4" }],
    }),
    "12.3 km · 4 × 1 km @ Z4, 2 min jog"
  );
  assert.equal(
    cardio.cardioPrescription({ target_duration_min: 45, target_zone: "Z3", interval_note: "steady" }),
    "45 min · Z3 · steady"
  );
});
