// A lift ENTERING the plan through a redraw (replacePlan with by:"restructure") starts from
// its movement unit (variant-start.ts), as the swap path's tier 2b does:
//   - only a lift new to the plan, with no history of its own and no load the author wrote;
//   - the slot is stamped now, so it reads UNTESTED until lifted;
//   - a load the agent or a person wrote is never overwritten;
//   - a person's save and an Undo (restoreStamps) never get one, nor a lift already on the plan;
//   - a draft's own note stands; an item without one says where the number came from.
// Synthetic fixtures through the repo's writers; deterministic and offline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { slotAuthorship } from "../dist/repo/prescription-authorship.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { db, repo } from "./_seed.js";

const day = (delta) => addDaysISO(localDateISO(), delta);

function benchWeek() {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.replacePlan([
    {
      day_number: 1,
      name: "Upper",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 200 }],
    },
  ]);
  for (const d of [21, 14, 7]) for (let i = 0; i < 3; i++) repo.logSetByName({ exercise: "Barbell Bench Press", weight: 200, reps: 5, date: day(-d) });
}

const redraw = (incoming, opts) =>
  repo.replacePlan(
    [
      { day_number: 1, name: "Upper", items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 200 }] },
      { day_number: 2, name: "Upper B", items: [{ exercise: "DB Bench Press", sets: 3, rep_low: 8, rep_high: 10, ...incoming }] },
    ],
    opts
  );
const slot = () => repo.getPlan().find((d) => d.day_number === 2).items[0];
const stampOf = (id) => db.prepare(`SELECT prescribed_at FROM plan_items WHERE id = ?`).get(id)?.prescribed_at ?? null;

test("a drafted week's new lift with no history and no written load starts from its unit, untested", () => {
  benchWeek();
  redraw({}, { by: "restructure" });
  const item = slot();
  // 200 x 0.4 (table) x 0.9 = 72, rounded down to the dumbbell's 5 lb step (variantStart.test.js).
  assert.equal(item.target_weight, 70);
  assert.match(item.note, /Barbell Bench Press/);
  const stamp = stampOf(item.id);
  assert.ok(stamp, "stamped by the write");
  const authorship = slotAuthorship(stamp, null);
  assert.equal(authorship.fresh, true, "a new prescription, written today");
  assert.equal(authorship.since, localDateISO());
  // Anything lifted before today predates it: the slot reads untested until lifted.
  assert.equal(slotAuthorship(stamp, day(-1)).untested, true);
});

test("a draft's own note stands", () => {
  benchWeek();
  redraw({ note: "Pause at the chest." }, { by: "restructure" });
  assert.equal(slot().target_weight, 70);
  assert.equal(slot().note, "Pause at the chest.");
});

test("a load the agent wrote is never overwritten", () => {
  benchWeek();
  redraw({ target_weight: 55 }, { by: "restructure" });
  assert.equal(slot().target_weight, 55);
});

test("a person's save and an Undo never ground; nor does a brain rewrite of another kind", () => {
  benchWeek();
  redraw({}, { by: "person" });
  assert.equal(slot().target_weight, null);
  benchWeek();
  redraw({}, { restoreStamps: true });
  assert.equal(slot().target_weight, null);
  benchWeek();
  redraw({});
  assert.equal(slot().target_weight, null);
});

test("a lift already on the plan is not entering it: its empty load stays empty", () => {
  benchWeek();
  redraw({}, { by: "person" }); // on the plan now, no load
  redraw({}, { by: "restructure" });
  assert.equal(slot().target_weight, null);
});

test("a lift with history of its own is left to its own tiers", () => {
  benchWeek();
  for (let i = 0; i < 3; i++) repo.logSetByName({ exercise: "DB Bench Press", weight: 60, reps: 10, date: day(-3) });
  redraw({}, { by: "restructure" });
  assert.equal(slot().target_weight, null);
});

test("timed work never takes a unit start", () => {
  benchWeek();
  repo.upsertExercise({ name: "Plank", muscle_group: "core", mode: "timed" });
  repo.replacePlan(
    [
      { day_number: 1, name: "Upper", items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 200 }] },
      { day_number: 2, name: "Core", items: [{ exercise: "Plank", sets: 3, mode: "timed" }] },
    ],
    { by: "restructure" }
  );
  assert.equal(slot().target_weight, null);
});
