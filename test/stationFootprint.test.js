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
  // A bare fly is a cable, a pec deck or dumbbells (second review, item 6): unknown.
  ["Rear Delt Fly", "fixed", "unknown"],
  ["Reverse Fly", "fixed", "unknown"],
  ["Dumbbell Fly", "portable", "dumbbell"],
  ["Bicep Curl", "portable", "dumbbell"],
  ["Biceps Curl", "portable", "dumbbell"],
  ["Hammer Curl", "portable", "dumbbell"],
  ["Concentration Curl", "portable", "dumbbell"],
  ["Skull Crusher", "portable", "dumbbell"],
  ["Overhead Triceps Extension", "portable", "dumbbell"],
  // A kickback with no implement named is a cable, a glute machine or dumbbells: unknown.
  ["Tricep Kickback", "fixed", "unknown"],
  ["Walking Lunge", "portable", "dumbbell"],
  ["Reverse Lunge", "portable", "dumbbell"],
  ["Bulgarian Split Squat", "portable", "dumbbell"],
  ["Split Squat", "portable", "dumbbell"],
  ["Step-Up", "portable", "dumbbell"],
  // A calf raise or a shrug with no implement named is commonly a machine, a smith or a
  // rack: unknown (item 6).
  ["Calf Raise", "fixed", "unknown"],
  ["Standing Calf Raise", "fixed", "unknown"],
  ["Shrug", "fixed", "unknown"],
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
  // A leg curl is a lying or seated machine, a ball, a partner: unknown (item 6).
  ["Lying Leg Curl", "fixed", "unknown"],
  ["Seated Calf Raise", "fixed", "machine"],
  ["Smith Machine Squat", "fixed", "machine"],
  ["Back Squat", "fixed", "barbell"],
  ["Barbell Bench Press", "fixed", "barbell"],
  ["Landmine Press", "fixed", "landmine"],
  // a station word in the name keeps an otherwise free-weight name off the portable list
  ["Preacher Curl", "fixed", "unknown"],
  ["Machine Lateral Raise", "fixed", "machine"],
];

// Second review, item 6: names chosen to be adversarial. A name is portable only when it
// positively names a portable implement or an unambiguous free-weight / bodyweight
// movement; a name commonly done on a machine or station, or ambiguous between one and a
// free weight, is unknown.
const ADVERSARIAL = [
  ["Hamstring Curl", "fixed", "unknown"],
  ["Seated Hamstring Curl", "fixed", "unknown"],
  ["Seated Leg Curl", "fixed", "unknown"],
  ["Leg Curl", "fixed", "unknown"],
  ["Nordic Hamstring Curl", "fixed", "unknown"],
  ["Nordic Curl", "fixed", "unknown"],
  ["Stability Ball Leg Curl", "portable", "mat"],
  ["Donkey Calf Raise", "fixed", "unknown"],
  ["Single-Leg Calf Raise", "fixed", "unknown"],
  ["Dumbbell Calf Raise", "portable", "dumbbell"],
  ["Smith Machine Calf Raise", "fixed", "machine"],
  ["Calf Raise on Leg Press", "fixed", "machine"],
  ["Glute Kickback", "fixed", "unknown"],
  ["Cable Glute Kickback", "fixed", "cable", "cable:stack"],
  ["Dumbbell Tricep Kickback", "portable", "dumbbell"],
  ["Banded Glute Kickback", "portable", "bands"],
  ["GHD Sit-Up", "fixed", "unknown"],
  ["Glute-Ham Raise", "fixed", "unknown"],
  ["Back Extension", "fixed", "unknown"],
  ["45 Degree Hyperextension", "fixed", "unknown"],
  ["Reverse Hyper", "fixed", "unknown"],
  ["Roman Chair Leg Raise", "fixed", "unknown"],
  ["Captain's Chair Knee Raise", "fixed", "unknown"],
  ["Decline Sit-Up", "fixed", "unknown"],
  ["Decline Crunch", "fixed", "unknown"],
  ["Chest Fly", "fixed", "unknown"],
  ["Dumbbell Chest Fly", "portable", "dumbbell"],
  ["Pec Deck Fly", "fixed", "machine"],
  ["Pullover", "fixed", "unknown"],
  ["Dumbbell Pullover", "portable", "dumbbell"],
  ["Dumbbell Shrug", "portable", "dumbbell"],
  ["Trap Bar Shrug", "fixed", "barbell"],
  ["Bayesian Curl", "fixed", "cable", "cable:stack"],
  ["Dips Between Benches", "portable", "bodyweight"],
  ["Dip Between Chairs", "portable", "bodyweight"],
  ["Sissy Squat", "fixed", "unknown"],
  ["Hack Squat", "fixed", "machine"],
  ["Spider Curl", "fixed", "unknown"],
  ["Zottman Curl", "portable", "dumbbell"],
  ["Wrist Curl", "portable", "dumbbell"],
  ["Hanging Knee Raise", "fixed", "pullup_bar", "pullup_bar"],
  ["Lying Leg Raise", "portable", "bodyweight"],
  ["Kettlebell Goblet Squat", "portable", "kettlebell"],
  ["Machine Shoulder Press", "fixed", "machine"],
];

test("the footprint table: at least forty common lifts by name alone, and thirty adversarial ones", () => {
  assert.ok(TABLE.length >= 40, `${TABLE.length} names`);
  assert.ok(ADVERSARIAL.length >= 30, `${ADVERSARIAL.length} adversarial names`);
  for (const [name, footprint, implement, station] of [...TABLE, ...ADVERSARIAL]) {
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
  // (A leg curl is unknown since item 6, so two KNOWN machines stand in for the split.)
  const known = [item("Leg Extension", { superset_group: 3 }), item("Leg Press", { superset_group: 3 })];
  assert.deepEqual(enforceSupersetRules(known), [
    { exercises: ["Leg Extension", "Leg Press"], reason: "two_stations" },
  ]);
  // …and an authored Leg Extension + Hamstring Curl is never split on an unknown.
  const legs = [item("Leg Extension", { superset_group: 5 }), item("Hamstring Curl", { superset_group: 5 })];
  assert.deepEqual(enforceSupersetRules(legs), []);
  const dips = [item("Ring Dip", { superset_group: 4 }), item("Parallel Bar Dip", { superset_group: 4 })];
  assert.equal(enforceSupersetRules(dips).length, 1, "rings and a dip station are two known stations");
});

test("item 6: the server never proposes a pair with an unknown member", () => {
  const names = [...TABLE, ...ADVERSARIAL].map(([name]) => name);
  const unknown = names.filter((name) => stationFootprint(name).implement === "unknown");
  assert.ok(unknown.length >= 20, `${unknown.length} unknown names in the tables`);
  for (const a of unknown) for (const b of names) assert.equal(pairIsDoable(item(a), item(b)), false, `${a} + ${b}`);
  // The reviewer's pairs, by name: a hamstring curl beside a leg extension, a calf raise
  // beside a leg press — never offered.
  assert.equal(pairIsDoable(item("Hamstring Curl"), item("Leg Extension")), false);
  assert.equal(pairIsDoable(item("Calf Raise"), item("Leg Press")), false);
  // …and pairForSession, given a card of antagonists with unknown members, seats none.
  const envelope = {
    date: "2031-07-01",
    kind: "train",
    caps: { volume: "normal", intensity: "normal", duration_min: 60 },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [], deep: [] },
  };
  const card = [
    "Leg Extension",
    "Hamstring Curl",
    "Calf Raise",
    "Chest Fly",
    "Reverse Fly",
    "Tricep Kickback",
    "Hammer Curl",
    "Pullover",
    "Lateral Raise",
    "Glute Kickback",
    "Back Extension",
  ].map((name, position) => ({ ...item(name, { rep_low: 10, rep_high: 15 }), position, kind: "strength" }));
  const { items: out } = pairForSession(card, { envelope, date: envelope.date, planSnapshot: false });
  const groups = new Map();
  for (const row of out)
    if (row.superset_group != null) groups.set(row.superset_group, [...(groups.get(row.superset_group) ?? []), row.exercise]);
  for (const members of groups.values())
    for (const name of members)
      assert.notEqual(stationFootprint(name).implement, "unknown", `the server seated ${members.join(" + ")}`);
});

test("the plan-snapshot path reports changed when the rules alter its groups", () => {
  const envelope = {
    date: "2031-07-01",
    kind: "train",
    caps: { volume: "normal", intensity: "normal", duration_min: 60 },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [], deep: [] },
  };
  const altered = [item("Leg Extension", { superset_group: 1 }), item("Leg Press", { superset_group: 1 })];
  const result = pairForSession(altered, { envelope, date: envelope.date, planSnapshot: true });
  assert.equal(result.changed, true);
  assert.equal(result.items[0].superset_group, null);
  const untouched = [item("Lateral Raise", { superset_group: 1 }), item("Bicep Curl", { superset_group: 1 })];
  assert.equal(pairForSession(untouched, { envelope, date: envelope.date, planSnapshot: true }).changed, false);
});
