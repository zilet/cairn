import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../dist/db.js";
import { getProfile, setProfile } from "../dist/repo.js";
import { seedIfEmpty } from "../dist/seed.js";
import { classifyMuscleGroup, resolveExerciseName } from "../dist/repo/exercise-canon.js";

test("CAIRN_BLANK_PROFILE creates only a neutral exercise catalog and never erases established data", async () => {
  const previous = process.env.CAIRN_BLANK_PROFILE;
  process.env.CAIRN_BLANK_PROFILE = "1";
  try {
    assert.equal(await seedIfEmpty(), true);

    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    assert.ok(count("exercises") > 0);
    assert.equal(count("plan_days"), 0);
    assert.equal(count("plan_items"), 0);
    assert.equal(count("sessions"), 0);
    assert.equal(count("logged_sets"), 0);
    assert.equal(count("body_measurements"), 0);
    assert.equal(count("bodyweight_log"), 0);
    assert.equal(count("profile"), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM exercises WHERE constraint_note IS NOT NULL").get().n), 0);

    // Even in the unusual case where an established user deleted every plan and
    // exercise, a later blank-mode seed may restore the neutral catalog but must
    // not touch their profile or history.
    setProfile({ about_me: "Getting started" });
    assert.equal(getProfile().sex, null, "partial blank-profile writes must not silently default sex to male");
    setProfile({ name: "Partner", sex: "female" });
    db.prepare("INSERT INTO sessions (date, notes) VALUES ('2026-07-12', 'real session')").run();
    db.exec("DELETE FROM exercises");
    assert.equal(await seedIfEmpty(), true);
    assert.deepEqual({ ...db.prepare("SELECT name, sex FROM profile WHERE id = 1").get() }, { name: "Partner", sex: "female" });
    assert.equal(count("sessions"), 1);
    assert.equal(count("plan_days"), 0);
    assert.ok(count("exercises") > 0);
  } finally {
    if (previous === undefined) delete process.env.CAIRN_BLANK_PROFILE;
    else process.env.CAIRN_BLANK_PROFILE = previous;
  }
});

// The neutral catalog carries a small supportive set — trunk, one-side-at-a-time, hip
// and prep work — so a balanced first week (or a stated movement consideration the
// athlete wants addressed) has cued movements to draw on. Each lands in the group the
// engines already understand, and resolves to itself rather than folding into a lift.
test("the blank catalog includes the cued supportive set, each in its canonical group", async () => {
  const previous = process.env.CAIRN_BLANK_PROFILE;
  process.env.CAIRN_BLANK_PROFILE = "1";
  try {
    assert.equal(await seedIfEmpty(), true);
    const expected = {
      "Side Plank": ["core", "timed"],
      "Suitcase Carry": ["core", "timed"],
      "Pallof Press": ["core", "reps"],
      "Bird Dog": ["core", "reps"],
      "Dead Bug": ["core", "reps"],
      "Single-Arm DB Row": ["back", "reps"],
      "Half-Kneeling Single-Arm Cable Chest Press": ["chest", "reps"],
      "Single-Arm DB Overhead Press": ["shoulders", "reps"],
      "Banded Side-Lying Clamshell": ["glutes", "reps"],
      "Side-Lying Hip Abduction": ["glutes", "reps"],
      "Glute Bridge": ["glutes", "reps"],
      "Quadruped Thoracic Rotation": ["mobility", "reps"],
      "Cat-Cow": ["mobility", "reps"],
      "90/90 Breathing": ["mobility", "timed"],
    };
    for (const [name, [group, mode]] of Object.entries(expected)) {
      const row = db.prepare("SELECT name, muscle_group, mode, cues, constraint_note FROM exercises WHERE name = ?").get(name);
      assert.ok(row, `${name} is seeded`);
      assert.equal(row.muscle_group, group, `${name} stored group`);
      assert.equal(classifyMuscleGroup(name), group, `${name} classifies to ${group}`);
      assert.equal(row.mode, mode, `${name} mode`);
      assert.ok(String(row.cues ?? "").trim().length > 20, `${name} carries real cues`);
      assert.equal(row.constraint_note, null);
      assert.equal(resolveExerciseName(name).canonical, name, `${name} resolves to itself`);
    }
  } finally {
    if (previous === undefined) delete process.env.CAIRN_BLANK_PROFILE;
    else process.env.CAIRN_BLANK_PROFILE = previous;
  }
});
