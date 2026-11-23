// The two reads Horizon and Train › Intake open on, COUNTED rather than timed (a wall
// clock is flaky on a shared Pi). Each is a read over many engines, and each engine
// re-derives its inputs on its own, so the cost hides in repetition: a lift's alias row
// read once per session it appears in, a session's logged lifts read once per plan-day
// resolution that touches it, the day's food guides derived twice for one Intake open.
// These pin the statements one cold request prepares on the seeded demo, with about a
// fifth of headroom, so a change that brings a repeated read or an N+1 back fails here
// instead of on the athlete's phone. And the Intake fan-in hands the day's guides to the
// ideas, so its ideas must be exactly the ones the route answers on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { seedDemo } from "../dist/demoSeed.js";
import { runWithBrainSnapshot } from "../dist/brain/snapshot.js";
import { weekRead, weekReadStart } from "../dist/domain/training/week-read.js";
import { trainHomeResponses } from "../dist/routes/screen-responses.js";
import { fuelIdeasForDay } from "../dist/repo/fuel-ideas-day.js";
import { localDateISO } from "../dist/repo/shared.js";

// A fixed Wednesday: the demo's log is dated relative to today, so its shape (and the
// statements a read prepares over it) depends on the weekday.
const NOW = new Date("2026-11-18T12:00:00");

// db.prepare is the one funnel every read goes through (the same instrumentation the
// scheduler's idle-cost test uses).
function countStatements(fn) {
  const original = db.prepare;
  let count = 0;
  db.prepare = function (...args) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    return { value: fn(), count };
  } finally {
    db.prepare = original;
  }
}

// One request: the scope the server opens around every /api call (server.ts).
const request = (fn) => countStatements(() => runWithBrainSnapshot(fn));

test("Horizon's week read prepares a bounded number of statements", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  const { value, count } = request(() => weekRead(weekReadStart(undefined)));
  assert.equal(value.this_week, true, "the read is this week's");
  // 356 measured (631 before the repeated reads were folded); about a fifth of headroom.
  assert.ok(count <= 430, `GET /api/week prepared ${count} statements (budget 430)`);
});

test("Train › Intake's fan-in prepares a bounded number of statements and answers the ideas the route does", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  const date = localDateISO();
  const { value, count } = request(() => trainHomeResponses("fuel", date, "12"));
  assert.ok(value[`/nutrition/day?date=${date}`], "the day rode the fan-in");
  // 485 measured (777 before the repeated reads were folded; the week's fuel strip added
  // one, the week's food notes read once). About 150 of them are the week's shape read as
  // of the eve of the week, a second run-plan read by design: the day numbers hold still
  // while the week is lived. About a sixth of headroom.
  assert.ok(count <= 560, `GET /api/train-home?view=fuel prepared ${count} statements (budget 560)`);
  const alone = runWithBrainSnapshot(() => fuelIdeasForDay(date, { hour: 12, exclude: [] }));
  assert.deepEqual(value[`/fuel/ideas?date=${date}&hour=12`], alone, "the fan-in's ideas are the route's own");
});
