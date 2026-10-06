// focusChangeDirection.test.js — every "what moved" change carries its own direction,
// computed from the same evidence its sentence states, so the UI never label-matches the
// change text against the evidence bullets to guess one. A direction, never a verdict.
import assert from "node:assert/strict";
import { test } from "node:test";
import { focusChanges } from "../dist/repo/coaching-focus-read.js";
import { addDaysISO } from "../dist/lib/dates.js";

const DATE = "2031-03-20";
const race = (over = {}) => ({
  event: "City Half",
  raceDate: "2031-05-01",
  distanceName: "half marathon",
  daysTo: 42,
  phase: "build",
  estimateSec: 7000,
  estimatePace: null,
  estimateAsOf: DATE,
  targetSec: null,
  stretchSec: null,
  fit: null,
  trend: { deltaSec: -95, since: "2031-02-20", word: "faster" },
  current: null,
  next: null,
  thisWeek: null,
  ride: null,
  longRunDay: null,
  lastClosed: { weekStart: "2031-03-10", km: 41 },
  bestWeekKm: 41,
  maxLongKmAhead: null,
  ...over,
});

function weights(recentLb, priorLb) {
  const points = [];
  for (let back = 0; back < 7; back += 2) points.push({ date: addDaysISO(DATE, -back), weight_lb: recentLb });
  for (let back = 7; back < 14; back += 2) points.push({ date: addDaysISO(DATE, -back), weight_lb: priorLb });
  return { points };
}

const byKind = (changes) => Object.fromEntries(changes.map((c) => [c.kind, c]));

test("each change's direction follows its own evidence", () => {
  const changes = byKind(
    focusChanges(
      {
        date: DATE,
        weekWins: { prs: [{ exercise: "Bench Press", label: "185 × 5 — new best" }] },
        goalPace: weights(181.2, 182.6),
        healthFocus: {
          lead: { readings: [{ name: "LDL-C", value: 128, unit: "mg/dL", date: addDaysISO(DATE, -5), trend: "falling" }] },
          priorities: [],
        },
      },
      race()
    )
  );
  assert.equal(changes.new_best?.direction, "up");
  assert.equal(changes.race_estimate?.direction, "down", "a faster estimate is the clock moving down");
  assert.match(changes.race_estimate.text, /faster/);
  assert.equal(changes.new_lab?.direction, "down");
  assert.equal(changes.weight?.direction, "down");
  assert.match(changes.weight.text, /lower/);
});

test("the opposite evidence gives the opposite direction; no shared trend gives none", () => {
  const changes = byKind(
    focusChanges(
      {
        date: DATE,
        goalPace: weights(183.4, 182.0),
        healthFocus: {
          lead: {
            readings: [
              { name: "LDL-C", value: 128, date: addDaysISO(DATE, -5), trend: "rising" },
              { name: "HbA1c", value: 5.2, date: addDaysISO(DATE, -5), trend: "falling" },
            ],
          },
          priorities: [],
        },
      },
      race({ trend: { deltaSec: 60, since: "2031-02-20", word: "slower" }, lastClosed: { weekStart: "2031-03-10", km: 30 } })
    )
  );
  assert.equal(changes.race_estimate?.direction, "up");
  assert.match(changes.race_estimate.text, /slower/);
  assert.equal(changes.weight?.direction, "up");
  assert.match(changes.weight.text, /higher/);
  assert.equal(changes.new_lab?.direction, null, "two readings moving opposite ways carry no one direction");
  assert.equal(changes.run_volume, undefined, "not the biggest week — no change to report");
});

test("the biggest running week of the eight reads up", () => {
  const changes = byKind(focusChanges({ date: DATE }, race({ trend: null })));
  assert.equal(changes.run_volume?.direction, "up");
  for (const c of Object.values(changes)) assert.ok("direction" in c, `${c.kind} carries the field`);
});
