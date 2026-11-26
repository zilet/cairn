// "Hard days hard" as a READ (src/domain/training/week-layout.ts `lower_lift_placement`):
// where the week's heaviest lower lift day sits against its quality and long run —
// on the eve of one (worst), consolidated with the quality run (its own day or the day
// after it), or neutral. A read only: it moves no day, and the rest of the layout read
// (collisions, suggestion, heavy days) is unchanged by it. Deterministic and offline.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { lowerLiftPlacement, weekLayoutRead } from "../dist/domain/training/week-layout.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { repo, resetTables } from "./_seed.js";

const REF = "2026-04-20"; // a Monday

beforeEach(() => {
  resetTables("logged_sets", "sessions", "activities", "plan_items", "plan_days", "app_state", "profile");
});

function heavyLowerDay(dayNumber, name = "Lower") {
  repo.savePlanDay(dayNumber, name, "Lower", [
    { exercise: "Back Squat", sets: 5, rep_low: 3, rep_high: 5, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
}
function upperDay(dayNumber, name = "Push") {
  repo.savePlanDay(dayNumber, name, "Push", [
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 8, target_weight: 155 },
  ]);
}
const run = (day_number, kind) => ({
  day_number,
  label: kind === "long" ? "Long run" : kind === "quality" ? "Tempo" : "Easy",
  kind_label: kind,
  target_distance_km: kind === "long" ? 16 : 8,
});
const runPlan = (...runs) => ({ available: true, week_start: REF, runs });

test("eve_of_key_run: the heavy leg day the day before the quality run", () => {
  heavyLowerDay(3, "Lower A");
  upperDay(1);
  const read = weekLayoutRead(REF, { runPlan: runPlan(run(4, "quality"), run(7, "long")) });
  assert.equal(read.lower_lift_placement?.state, "eve_of_key_run");
  assert.match(read.lower_lift_placement.note, /Wednesday's Lower A/);
  assert.match(read.lower_lift_placement.note, /Thursday/);
  assert.match(read.lower_lift_placement.note, /quality run|run/);
});

test("eve_of_key_run: the eve of the long run outranks being the day after the quality run", () => {
  heavyLowerDay(5, "Lower B");
  const read = weekLayoutRead(REF, { runPlan: runPlan(run(4, "quality"), run(6, "long")) });
  assert.equal(read.lower_lift_placement?.state, "eve_of_key_run");
  assert.match(read.lower_lift_placement.note, /Saturday/);
  assert.match(read.lower_lift_placement.note, /long run/);
});

// Round 7: the read follows the live placement's ONE rule (key-run-proximity.ts, shared
// with plan-selection.ts keyRunAwarePlacement): a key run's own day and the day after it
// are not preferred — the placement trades a heavy lower day off both when it can.
test("on_key_run: the heavy leg day on the quality run's own day is not preferred", () => {
  heavyLowerDay(4, "Lower A");
  const read = weekLayoutRead(REF, { runPlan: runPlan(run(4, "quality"), run(7, "long")) });
  assert.equal(read.lower_lift_placement?.state, "on_key_run");
  assert.equal(read.lower_lift_placement.preferred, false);
  assert.match(read.lower_lift_placement.note, /Thursday/);
});

test("after_key_run: the heavy leg day the day after the quality run, the legs still carrying it", () => {
  heavyLowerDay(3, "Lower A");
  const read = weekLayoutRead(REF, { runPlan: runPlan(run(2, "quality"), run(7, "long")) });
  assert.equal(read.lower_lift_placement?.state, "after_key_run");
  assert.equal(read.lower_lift_placement.preferred, false);
  assert.match(read.lower_lift_placement.note, /Tuesday's quality run/);
  assert.match(read.lower_lift_placement.note, /still carrying/);
});

test("neutral: the heavy leg day clear of both key runs is the one preferred placement", () => {
  heavyLowerDay(1, "Lower A");
  const read = weekLayoutRead(REF, { runPlan: runPlan(run(4, "quality"), run(6, "long")) });
  assert.equal(read.lower_lift_placement?.state, "neutral");
  assert.equal(read.lower_lift_placement.preferred, true);
  assert.match(read.lower_lift_placement.note, /Monday's Lower A/);
});

test("null when there is nothing to read: no heavy lower day, or no key run", () => {
  upperDay(1);
  assert.equal(weekLayoutRead(REF, { runPlan: runPlan(run(4, "quality")) }).lower_lift_placement, null);
  heavyLowerDay(3);
  assert.equal(weekLayoutRead(REF, { runPlan: runPlan(run(5, "easy")) }).lower_lift_placement, null);
  assert.equal(weekLayoutRead(REF, {}).lower_lift_placement, null);
});

test("calendar space: the read follows the weekday the ring lays the heavy day on", () => {
  heavyLowerDay(1, "Lower");
  upperDay(2, "Upper");
  // Mon Lower, Wed Upper, Fri Lower; quality Thursday, long Sunday.
  const weekdayMap = new Map([
    [1, 1],
    [3, 2],
    [5, 1],
  ]);
  const read = weekLayoutRead(REF, {
    runPlan: runPlan(run(4, "quality"), run(7, "long")),
    strengthDows: [1, 3, 5],
    enduranceDows: [4, 0],
    weekdayMap,
  });
  assert.equal(read.space, "calendar");
  // Friday follows Thursday's quality run; Monday follows Sunday's long run: no eve, and
  // both are the day after a key run (the quality run speaks on the tie).
  assert.equal(read.lower_lift_placement?.state, "after_key_run");
  assert.match(read.lower_lift_placement.note, /Friday/);
});

test("a read only: the collision read and its suggestion are unchanged beside it", () => {
  heavyLowerDay(5, "Lower B");
  upperDay(2);
  const read = weekLayoutRead(REF, { runPlan: runPlan(run(6, "long")) });
  assert.equal(read.lower_lift_placement.state, "eve_of_key_run");
  assert.equal(read.clean, false);
  assert.ok(read.collisions.some((c) => c.kind === "heavy_lower_adjacent_long_run"));
  assert.ok(read.suggestion);
});

test("every note is one plain sentence, rotates by day, and holds the reading grammar", () => {
  const seen = new Set();
  for (let i = 0; i < 7; i++) {
    const date = new Date(Date.parse(`${REF}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10);
    for (const [heaviest, long, quality] of [
      [[3], 7, 4],
      [[5], 6, 4],
      [[4], 7, 4],
      [[5], 7, 4],
      [[1], 6, 4],
    ]) {
      const out = lowerLiftPlacement(heaviest, long, quality, date);
      assert.ok(out, JSON.stringify({ heaviest, long, quality }));
      assert.equal(violatesReadingGrammar(out.note), null, out.note);
      assert.ok(!/\d/.test(out.note), `no numbers: ${out.note}`);
      assert.equal((out.note.match(/[.!?](\s|$)/g) ?? []).length, 1, `one sentence: ${out.note}`);
      seen.add(out.note);
    }
  }
  assert.ok(seen.size > 5, "the notes rotate");
  assert.equal(lowerLiftPlacement([], 6, 4, REF), null);
  assert.equal(lowerLiftPlacement([3], null, null, REF), null);
});
