// Muscle credit (src/repo/muscle-credit.ts): the one answer to "which muscles does this
// exercise train". Invariants:
//   - the primary is the stored group, else the name classifier, at a full share;
//   - a named lift refines its pattern (a deadlift credits the back, a leg curl does not
//     lend the glutes anything, a fly lends no triceps), and every long-standing half
//     share is unchanged;
//   - a quarter share is TOUCHED, never COUNTED: weekly volume, the floor, the dose ledger
//     and the bands read counted shares only, so quarter shares can never push a group
//     high or stand in for direct work;
//   - the group classifier and the pattern classifier agree on the names that used to
//     split (dips, kickbacks, nordic curl, close-grip bench, chest-supported row).
// Pure: no DB writes, no agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COUNTED_SHARE_MIN,
  NAMED_LIFTS,
  muscleCreditFor,
  primaryMuscleGroup,
} from "../dist/repo/muscle-credit.js";
import { classifyMuscleGroup } from "../dist/repo/exercise-canon.js";
import { classifyPattern, effectiveVolumeByGroup, indirectGroupsForExercise } from "../dist/repo/exercise-variations.js";
import { plannedWeeklyGroupSets } from "../dist/repo/plan-quality.js";
import { MUSCLE_LANDMARKS } from "../dist/repo/exercise-canon.js";

const credit = (name, stored) =>
  Object.fromEntries(muscleCreditFor(name, stored).map((c) => [c.group, c.share]));

test("the primary comes first at a full share, and is the one primary resolver", () => {
  const credits = muscleCreditFor("Barbell Bench Press");
  assert.deepEqual(credits[0], { group: "chest", share: 1, role: "primary" });
  assert.equal(primaryMuscleGroup("Barbell Bench Press"), "chest");
  // A stored group wins the primary.
  assert.equal(primaryMuscleGroup("Barbell Bench Press", "triceps"), "triceps");
  // Mobility never counts; nothing told is nothing credited.
  assert.deepEqual(muscleCreditFor("World's Greatest Stretch"), []);
  assert.deepEqual(muscleCreditFor("Zzz Unknown Thing"), []);
  assert.equal(primaryMuscleGroup("Cat Cow"), null);
});

test("every long-standing half share is unchanged", () => {
  assert.deepEqual(credit("Barbell Bench Press"), { chest: 1, triceps: 0.5, shoulders: 0.5 });
  assert.equal(credit("Seated DB Overhead Press").triceps, 0.5);
  assert.equal(credit("Barbell Bent Over Row").biceps, 0.5);
  assert.equal(credit("Barbell Bent Over Row")["rear delts"], 0.5);
  assert.equal(credit("Lat Pulldown").biceps, 0.5);
  assert.equal(credit("Back Squat").glutes, 0.5);
  assert.equal(credit("Romanian Deadlift").glutes, 0.5);
  assert.equal(credit("Walking Lunge").glutes, 0.5);
  assert.equal(credit("Hip Thrust").hamstrings, 0.5);
  // The legacy accessor still answers the counted secondaries only.
  assert.deepEqual(indirectGroupsForExercise("Barbell Bench Press").sort(), ["shoulders", "triceps"]);
  assert.deepEqual(indirectGroupsForExercise("Dumbbell Lateral Raise"), []);
});

test("a deadlift credits the back; pull-ups and chin-ups credit the grip", () => {
  const dl = credit("Conventional Deadlift");
  assert.equal(dl.hamstrings, 1);
  assert.equal(dl.back, 0.5, "the back holds a heavy bar: a counted half set");
  assert.equal(dl.glutes, 0.5);
  assert.equal(dl.forearms, 0.25);
  assert.equal(credit("Trap Bar Deadlift").quads, 0.25);
  assert.equal(credit("Romanian Deadlift").back, 0.25, "an RDL's back work is touched, not counted");
  assert.equal(credit("Pull-Up").forearms, 0.25);
  assert.equal(credit("Chin-Up").forearms, 0.25);
  assert.equal(credit("Chin-Up").biceps, 0.5);
  assert.equal(credit("Seated Cable Row").forearms, 0.25);
  assert.equal(credit("Back Squat").core, 0.25);
  assert.equal(credit("Leg Press").core, undefined, "a machine holds the trunk");
});

test("named lifts refine a pattern that hides different lifts", () => {
  assert.deepEqual(credit("Lying Leg Curl"), { hamstrings: 1 }, "knee flexion lends the glutes nothing");
  assert.deepEqual(credit("Leg Extension"), { quads: 1 });
  assert.deepEqual(credit("Cable Fly"), { chest: 1, shoulders: 0.25 }, "a fly never lends triceps");
  assert.equal(credit("Straight Arm Pulldown").biceps, undefined);
  assert.equal(credit("Close-Grip Bench Press").chest, 0.5);
  assert.equal(credit("Barbell Overhead Press").core, 0.25, "standing, the trunk braces");
  assert.equal(credit("Seated DB Overhead Press").core, undefined);
  assert.equal(credit("Hammer Curl").forearms, 0.25);
  // A calf raise on a leg press is a calf raise.
  assert.deepEqual(credit("Leg Press Calf Raise"), { calves: 1 });
});

test("a core movement credits core alone", () => {
  assert.deepEqual(credit("Flat Bench Knee Raise"), { core: 1 });
  assert.deepEqual(credit("Hanging Leg Raise"), { core: 1 });
  assert.deepEqual(credit("Suitcase Carry"), { core: 1 });
});

test("a stored group that files a lift elsewhere still credits the lift's own mover at half", () => {
  assert.deepEqual(credit("Dips", "chest"), { chest: 1, triceps: 0.5, shoulders: 0.25 });
  assert.equal(credit("Deadlift", "back").hamstrings, 0.5);
  // ...but only for a lift the table names: an unknown name never borrows a guess.
  // (The stored group's pattern hint still lends the long-standing half shares.)
  assert.deepEqual(credit("Plate Loaded Station", "chest"), { chest: 1, triceps: 0.5, shoulders: 0.5 });
});

test("every named-lift row agrees with the group classifier on its own example", () => {
  for (const row of NAMED_LIFTS) {
    assert.equal(classifyMuscleGroup(row.example), row.primary, `${row.lift}: ${row.example}`);
    const credits = muscleCreditFor(row.example);
    assert.equal(credits[0]?.group, row.primary, `${row.lift}: primary`);
    for (const [group, share] of row.synergists) {
      assert.ok(share === 0.5 || share === 0.25, `${row.lift}: ${group} share ${share}`);
      assert.equal(credits.find((c) => c.group === group)?.share, share, `${row.lift}: ${group}`);
    }
  }
});

test("group and pattern agree on the names that used to split", () => {
  const agree = [
    ["Dips", "triceps", "triceps"],
    ["Dip", "triceps", "triceps"],
    ["Weighted Dip", "triceps", "triceps"],
    ["Tricep Dip", "triceps", "triceps"],
    ["Bench Dip", "triceps", "triceps"],
    ["Chest Dip", "chest", "horizontal-push"],
    ["Tricep Kickback", "triceps", "triceps"],
    ["DB Kickback", "triceps", "triceps"],
    ["Cable Kickback", "glutes", "hip-extension"],
    ["Glute Kickback", "glutes", "hip-extension"],
    ["Nordic Curl", "hamstrings", "hinge"],
    ["Upright Row", "shoulders", "lateral-raise"],
    ["Close-Grip Bench Press", "triceps", "triceps"],
    ["Chest-Supported Row", "back", "horizontal-pull"],
    ["Kettlebell Swing", "hamstrings", "hinge"],
    ["Landmine Press", "shoulders", "vertical-push"],
  ];
  for (const [name, group, pattern] of agree) {
    assert.equal(classifyMuscleGroup(name), group, `${name} group`);
    assert.equal(classifyPattern(name), pattern, `${name} pattern`);
  }
});

test("a grip named as a hand position is not grip work", () => {
  assert.equal(classifyMuscleGroup("Wide-Grip Pulldown"), "back");
  assert.equal(classifyMuscleGroup("Close Grip Lat Pulldown"), "back");
  assert.equal(classifyMuscleGroup("Neutral-Grip Pull-Up"), "back");
  assert.equal(classifyMuscleGroup("Close-Grip Bench Press"), "triceps");
  assert.equal(classifyMuscleGroup("Grip Trainer"), "forearms");
  assert.equal(classifyMuscleGroup("Wrist Curl"), "forearms");
});

test("a quarter share is touched, never counted, by the logged-volume read", () => {
  const sets = [1, 2, 3].map(() => ({
    date: "2026-05-01",
    exercise: "Pull-Up",
    muscle_group: "back",
    weight: null,
    reps: 8,
    rir: 2,
  }));
  const counted = effectiveVolumeByGroup(sets);
  assert.equal(counted.get("back").sets, 3);
  assert.equal(counted.get("biceps").sets, 1.5);
  assert.equal(counted.has("forearms"), false, "a group touched only by quarter shares is not in the counted read at all");
  const touched = effectiveVolumeByGroup(sets, undefined, { shares: "touched" });
  assert.equal(touched.get("forearms").sets, 0.75);
  assert.equal(touched.get("forearms").tonnage, 0, "a synergist never earns tonnage");
  assert.equal(COUNTED_SHARE_MIN, 0.5);
});

// ── a realistic 5-day push/pull/lower week, before and after ───────────────────
// Names only (no stored groups), so the classifier and the named-lift table are what
// is measured. BEFORE is the old model (one primary + 0.5 per pattern secondary, with
// "Dips" unclassified, a close-grip bench filed under chest, a fly lending triceps and
// shoulders, a leg curl and a leg extension lending the glutes). See the report table.
const WEEK = [
  {
    day_number: 1,
    items: [
      ["Barbell Bench Press", 4],
      ["Incline DB Press", 3],
      ["Seated DB Overhead Press", 3],
      ["Cable Lateral Raise", 3],
      ["Tricep Pushdown", 3],
      ["Dips", 3],
    ],
  },
  {
    day_number: 2,
    items: [
      ["Pull-Up", 4],
      ["Barbell Bent Over Row", 4],
      ["Lat Pulldown", 3],
      ["Face Pull", 3],
      ["Hammer Curl", 3],
      ["Barbell Curl", 2],
    ],
  },
  {
    day_number: 3,
    items: [
      ["Back Squat", 4],
      ["Romanian Deadlift", 3],
      ["Leg Press", 3],
      ["Leg Curl", 3],
      ["Standing Calf Raise", 4],
      ["Hanging Leg Raise", 3],
    ],
  },
  {
    day_number: 4,
    items: [
      ["Barbell Overhead Press", 4],
      ["Close-Grip Bench Press", 3],
      ["Chest-Supported Row", 3],
      ["Chin-Up", 3],
      ["Cable Fly", 3],
      ["Overhead Tricep Extension", 2],
    ],
  },
  {
    day_number: 5,
    items: [
      ["Conventional Deadlift", 3],
      ["Bulgarian Split Squat", 3],
      ["Hip Thrust", 3],
      ["Leg Extension", 3],
      ["Seated Calf Raise", 3],
      ["Farmer's Walk", 3],
    ],
  },
].map((d) => ({
  day_number: d.day_number,
  items: d.items.map(([exercise, sets]) => ({ exercise, sets, rep_low: 8, rep_high: 12 })),
}));

// (Before, "Close-Grip Bench Press" read as grip work on the word "grip": forearms 6.)
const BEFORE = {
  chest: 10, triceps: 13.5, shoulders: 15, back: 17, biceps: 13.5, "rear delts": 6.5,
  quads: 13, hamstrings: 10.5, glutes: 14, calves: 7, core: 3, forearms: 6,
};
const COUNTED = {
  chest: 13, triceps: 18, shoulders: 13.5, back: 18.5, biceps: 13.5, "rear delts": 6.5,
  quads: 13, hamstrings: 10.5, glutes: 11, calves: 7, core: 3, forearms: 3,
};
const TOUCHED = { ...COUNTED, shoulders: 16.5, back: 21, core: 7.5, forearms: 9.5 };

test("5-day push/pull/lower: counted weekly sets per group", () => {
  const counted = Object.fromEntries(plannedWeeklyGroupSets(WEEK));
  assert.deepEqual(counted, COUNTED);
});

test("5-day push/pull/lower: touched shares widen the picture, never the counted read", () => {
  const touched = Object.fromEntries(plannedWeeklyGroupSets(WEEK, { shares: "touched" }));
  assert.deepEqual(touched, TOUCHED);
  for (const [group, sets] of Object.entries(COUNTED)) {
    assert.ok(touched[group] >= sets, `${group} touched never under counted`);
  }
});

test("5-day push/pull/lower: no group leaves its band on synergist credit alone", () => {
  const FLOOR_GROUPS = ["chest", "back", "shoulders", "quads", "hamstrings", "glutes", "biceps", "triceps", "calves"];
  for (const [group, sets] of Object.entries(COUNTED)) {
    const landmark = MUSCLE_LANDMARKS[group];
    assert.ok(sets <= landmark.high, `${group} stays under its high landmark (${sets} vs ${landmark.high})`);
    // Every floor group the old model put at or over its low landmark is still there.
    if (FLOOR_GROUPS.includes(group) && BEFORE[group] >= landmark.low)
      assert.ok(sets >= landmark.low, `${group} keeps its low landmark`);
  }
  // Forearms get synergist credit from every row, pull and deadlift, but only as touched
  // shares: the counted read is the week's own grip work (the farmer's walk), nothing more.
  assert.equal(COUNTED.forearms, 3);
  assert.ok(TOUCHED.forearms > COUNTED.forearms);
});
