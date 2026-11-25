// The seed catalog's groups are honest data: every seeded group is a canonical taxonomy
// value; where the curated tables settle the lift (muscle-credit.ts curatedMuscleGroup)
// the seed agrees with them and is stamped 'table'; where they do not, the lift is on the
// deliberate list below, its group is the name classifier's, and it is stamped
// 'classifier' — exactly the provenance a fresh insert of that name would carry, so a
// later agent may correct it and a person's edit outranks it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { curatedMuscleGroup } from "../dist/repo/muscle-credit.js";
import { canonicalGroup, classifyMuscleGroup } from "../dist/repo/exercise-canon.js";
import { seed, seedExerciseGroups, seedGroupSource } from "../dist/seed.js";

// Lifts the curated tables do not settle (no unanimous named-lift row): their seeded
// group is the classifier's. Adding a seed lift the tables DO settle needs no entry here.
const NOT_SETTLED_BY_THE_TABLES = new Set([
  "Seated DB Overhead Press",
  "Incline DB Press",
  "Lateral Raise",
  "Triceps Rope Pushdown",
  "Side Plank",
  "Suitcase Carry",
  "Pallof Press",
  "Bird Dog",
  "Dead Bug",
  "Half-Kneeling Single-Arm Cable Chest Press",
  "Banded Side-Lying Clamshell",
  "Side-Lying Hip Abduction",
  "Glute Bridge",
  "Quadruped Thoracic Rotation",
  "Cat-Cow",
  "90/90 Breathing",
]);

test("every seeded group is canonical and agrees with the curated table, or is a listed exception", () => {
  for (const { name, group } of seedExerciseGroups()) {
    assert.equal(canonicalGroup(group), group, `${name}: "${group}" is a canonical group`);
    const curated = curatedMuscleGroup(name);
    if (curated) {
      assert.equal(group, curated, `${name}: the seed and the curated table agree`);
      assert.ok(!NOT_SETTLED_BY_THE_TABLES.has(name), `${name} is settled by the tables; drop it from the list`);
      assert.equal(seedGroupSource(name, group), "table");
    } else {
      assert.ok(NOT_SETTLED_BY_THE_TABLES.has(name), `${name}: the tables do not settle it, so it must be listed`);
      assert.equal(group, classifyMuscleGroup(name), `${name}: an unsettled lift carries the classifier's group`);
      assert.equal(seedGroupSource(name, group), "classifier");
    }
  }
});

test("the seeded rows carry exactly that provenance", () => {
  db.exec("DELETE FROM logged_sets; DELETE FROM sessions; DELETE FROM plan_items; DELETE FROM plan_days; DELETE FROM exercises;");
  seed();
  for (const { name, group } of seedExerciseGroups()) {
    const row = db.prepare("SELECT muscle_group, muscle_group_source FROM exercises WHERE name = ?").get(name);
    assert.ok(row, name);
    assert.equal(row.muscle_group, group, name);
    assert.equal(row.muscle_group_source, seedGroupSource(name, group), name);
  }
});
