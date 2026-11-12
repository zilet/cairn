// What a lift occupies on a shared gym floor (station-footprint.ts), read off its NAME when
// no data field names the implement — the common free-weight and bodyweight movements
// travel, cable movements share the one stack, and only a parallel-bar dip holds the dip
// station. An AUTHORED pair is taken apart only when both lifts are positively known to
// sit on different fixed stations; unknown stays conservative only for pairs the server
// proposes (composition-pairing.ts). Synthetic fixtures only; deterministic and offline.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { authoredPairIsDoable, enforceSupersetRules, pairForSession, pairIsDoable } from "../dist/repo/composition-pairing.js";
import { stationFootprint } from "../dist/repo/station-footprint.js";
import { resetTables } from "./_seed.js";

beforeEach(() => resetTables("exercises", "exercise_guides"));

// [name, footprint, implement, station (fixed only)]
const TABLE = [
  // free weights, by name
  ["Lateral Raise", "portable", "dumbbell"],
  ["Front Raise", "portable", "dumbbell"],
  ["Rear Delt Fly", "portable", "dumbbell"],
  ["Reverse Fly", "portable", "dumbbell"],
  ["Dumbbell Fly", "portable", "dumbbell"],
  ["Bicep Curl", "portable", "dumbbell"],
  ["Biceps Curl", "portable", "dumbbell"],
  ["Hammer Curl", "portable", "dumbbell"],
  ["Concentration Curl", "portable", "dumbbell"],
  ["Skull Crusher", "portable", "dumbbell"],
  ["Overhead Triceps Extension", "portable", "dumbbell"],
  ["Tricep Kickback", "portable", "dumbbell"],
  ["Walking Lunge", "portable", "dumbbell"],
  ["Reverse Lunge", "portable", "dumbbell"],
  ["Bulgarian Split Squat", "portable", "dumbbell"],
  ["Split Squat", "portable", "dumbbell"],
  ["Step-Up", "portable", "dumbbell"],
  ["Calf Raise", "portable", "dumbbell"],
  ["Standing Calf Raise", "portable", "dumbbell"],
  ["Shrug", "portable", "dumbbell"],
  ["Goblet Squat", "portable", "dumbbell"],
  ["Farmer's Carry", "portable", "dumbbell"],
  ["Kettlebell Swing", "portable", "kettlebell"],
  ["Dumbbell Bench Press", "portable", "dumbbell"],
  // bodyweight
  ["Push-Up", "portable", "bodyweight"],
  ["Front Plank", "portable", "bodyweight"],
  ["Side Plank", "portable", "bodyweight"],
  ["Dead Bug", "portable", "bodyweight"],
  ["Bird Dog", "portable", "bodyweight"],
  ["Glute Bridge", "portable", "bodyweight"],
  ["Sit-Up", "portable", "bodyweight"],
  ["Russian Twist", "portable", "bodyweight"],
  ["Mountain Climber", "portable", "bodyweight"],
  ["Bench Dip", "portable", "bodyweight"],
  // one cable stack
  ["Tricep Pushdown", "fixed", "cable", "cable:stack"],
  ["Rope Pushdown", "fixed", "cable", "cable:stack"],
  ["Face Pull", "fixed", "cable", "cable:stack"],
  ["Cable Fly", "fixed", "cable", "cable:stack"],
  ["Cable Crossover", "fixed", "cable", "cable:stack"],
  ["Straight-Arm Pulldown", "fixed", "cable", "cable:stack"],
  ["Cable Curl", "fixed", "cable", "cable:stack"],
  ["Seated Cable Row", "fixed", "cable", "cable:row"],
  // stations
  ["Pull-Up", "fixed", "pullup_bar", "pullup_bar"],
  ["Hanging Leg Raise", "fixed", "pullup_bar", "pullup_bar"],
  ["Parallel Bar Dip", "fixed", "dip_station", "dip_station"],
  ["Dip", "fixed", "dip_station", "dip_station"],
  ["Ring Dip", "fixed", "suspension"],
  ["Lat Pulldown", "fixed", "machine"],
  ["Leg Press", "fixed", "machine"],
  ["Leg Extension", "fixed", "machine"],
  ["Lying Leg Curl", "fixed", "machine"],
  ["Seated Calf Raise", "fixed", "machine"],
  ["Smith Machine Squat", "fixed", "machine"],
  ["Back Squat", "fixed", "barbell"],
  ["Barbell Bench Press", "fixed", "barbell"],
  ["Landmine Press", "fixed", "landmine"],
  // a station word in the name keeps an otherwise free-weight name off the portable list
  ["Preacher Curl", "fixed", "unknown"],
  ["Machine Lateral Raise", "fixed", "machine"],
];

test("the footprint table: at least forty common lifts by name alone", () => {
  assert.ok(TABLE.length >= 40, `${TABLE.length} names`);
  for (const [name, footprint, implement, station] of TABLE) {
    const read = stationFootprint(name);
    assert.equal(read.footprint, footprint, `${name}: ${JSON.stringify(read)}`);
    assert.equal(read.implement, implement, `${name}: ${JSON.stringify(read)}`);
    if (station) assert.equal(read.station, station, `${name}: ${JSON.stringify(read)}`);
  }
});

const item = (exercise, extra = {}) => ({ exercise, sets: 3, rep_low: 8, rep_high: 12, ...extra });

test("ordinary authored supersets are no longer split", () => {
  for (const [a, b] of [
    ["Lateral Raise", "Bicep Curl"],
    ["Walking Lunge", "Calf Raise"],
    ["Bulgarian Split Squat", "Shrug"],
    ["Skull Crusher", "Hammer Curl"],
    ["Tricep Pushdown", "Face Pull"], // one cable stack
    ["Bench Dip", "Push-Up"],
  ]) {
    const items = [item(a, { superset_group: 1 }), item(b, { superset_group: 1 })];
    const unpaired = enforceSupersetRules(items);
    assert.deepEqual(unpaired, [], `${a} + ${b}`);
    assert.equal(items[0].superset_group, 1, `${a} + ${b} stays paired`);
  }
});

test("an unknown footprint never breaks an authored pair; two KNOWN different stations still do", () => {
  // Chest-Supported Row names no implement (unknown).
  assert.equal(authoredPairIsDoable(item("Chest-Supported Row"), item("Lat Pulldown")), true);
  assert.equal(pairIsDoable(item("Chest-Supported Row"), item("Lat Pulldown")), false, "the server stays conservative");
  const unknownPair = [item("Chest-Supported Row", { superset_group: 2 }), item("Lat Pulldown", { superset_group: 2 })];
  assert.deepEqual(enforceSupersetRules(unknownPair), []);
  assert.equal(unknownPair[1].superset_group, 2);
  const known = [item("Leg Extension", { superset_group: 3 }), item("Lying Leg Curl", { superset_group: 3 })];
  assert.deepEqual(enforceSupersetRules(known), [
    { exercises: ["Leg Extension", "Lying Leg Curl"], reason: "two_stations" },
  ]);
  const dips = [item("Ring Dip", { superset_group: 4 }), item("Parallel Bar Dip", { superset_group: 4 })];
  assert.equal(enforceSupersetRules(dips).length, 1, "rings and a dip station are two known stations");
});

test("the plan-snapshot path reports changed when the rules alter its groups", () => {
  const envelope = {
    date: "2031-07-01",
    kind: "train",
    caps: { volume: "normal", intensity: "normal", duration_min: 60 },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [], deep: [] },
  };
  const altered = [item("Leg Extension", { superset_group: 1 }), item("Lying Leg Curl", { superset_group: 1 })];
  const result = pairForSession(altered, { envelope, date: envelope.date, planSnapshot: true });
  assert.equal(result.changed, true);
  assert.equal(result.items[0].superset_group, null);
  const untouched = [item("Lateral Raise", { superset_group: 1 }), item("Bicep Curl", { superset_group: 1 })];
  assert.equal(pairForSession(untouched, { envelope, date: envelope.date, planSnapshot: true }).changed, false);
});
