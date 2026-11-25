// Who set a lift's muscle group decides who may change it (repo/exercises.ts
// MuscleGroupSource), and a lift no group can count is named in the balance read
// instead of silently earning nothing (repo/program-balance-read.ts).
//
// Covered here:
//   - the v134 column: present on a fresh DB, the backfill stamps existing groups
//     'legacy', and running it twice changes nothing;
//   - insert-time stamping: a unanimous curated lift is 'table', a classifier-only
//     guess is 'classifier', a group a person supplied is 'user';
//   - the agent rule: enrichment corrects a classifier guess, never flips its own
//     answer, never touches a person's group (including a cleared one);
//   - the deterministic re-check: a legacy group the lift does not train at all
//     ("Close-Grip Bench Press" under forearms) is corrected, a defensible one ("Dips"
//     under chest) stands, a classifier guess follows the curated answer;
//   - the balance read names ungrouped work and leaves every grouped number as it was.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { db, repo, localDaysAgo } from "./_seed.js";
import { MIGRATIONS } from "../dist/migrate.js";
import { curatedMuscleGroup } from "../dist/repo/muscle-credit.js";
import { programBalanceRead, ungroupedNote } from "../dist/repo/program-balance-read.js";
import { reconcileExercises } from "../dist/coachOps.js";

const TODAY = localDaysAgo(0);

beforeEach(() => {
  // Offline: no real agent may run (the Tidy below reaches the stub at most).
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok"], enrich_enabled: false });
});

// node:sqlite rows carry a null prototype; spread into a plain object to compare.
const row = (id) => ({ ...db.prepare("SELECT muscle_group, muscle_group_source FROM exercises WHERE id = ?").get(id) });
const insertRaw = (name, group, source) =>
  Number(
    db
      .prepare("INSERT INTO exercises (name, muscle_group, muscle_group_source, mode) VALUES (?, ?, ?, 'reps')")
      .run(name, group, source).lastInsertRowid
  );
const logSets = (exerciseId, count, date = TODAY, weight = 100) => {
  const session = repo.getOrCreateSession(date);
  for (let i = 1; i <= count; i++) {
    db.prepare("INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, ?, ?, 8)").run(
      session.id,
      exerciseId,
      i,
      weight
    );
  }
};

// ---------- schema ----------

test("a fresh DB has muscle_group_source; the migration backfills 'legacy' and is idempotent", () => {
  const columns = db.prepare("PRAGMA table_info(exercises)").all().map((c) => c.name);
  assert.ok(columns.includes("muscle_group_source"), "the create block carries the column");

  const migration = MIGRATIONS.find((m) => m.name === "exercises-muscle-group-source");
  assert.ok(migration, "the migration is on the ladder");
  const old = new DatabaseSync(":memory:");
  old.exec(`CREATE TABLE exercises (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, muscle_group TEXT, mode TEXT)`);
  old.exec(`INSERT INTO exercises (name, muscle_group) VALUES ('Close-Grip Bench Press', 'forearms'), ('Sled Push', NULL), ('Odd', '')`);
  migration.up(old);
  migration.up(old);
  const rows = old.prepare("SELECT name, muscle_group_source FROM exercises ORDER BY id").all();
  assert.deepEqual(
    rows.map((r) => [r.name, r.muscle_group_source]),
    [
      ["Close-Grip Bench Press", "legacy"],
      ["Sled Push", null],
      ["Odd", null],
    ],
    "an existing group is stamped legacy (nobody recorded who set it); no group, no source"
  );
  old.close();
});

// ---------- insert-time stamping ----------

test("a new lift is stamped by who decided its group", () => {
  const curl = repo.findOrCreateExercise("Lying Leg Curl");
  assert.deepEqual(row(curl.id), { muscle_group: "hamstrings", muscle_group_source: "table" }, "the curated tables agree");

  const skull = repo.findOrCreateExercise("EZ Bar Skull Crusher");
  assert.deepEqual(row(skull.id), { muscle_group: "triceps", muscle_group_source: "classifier" }, "the name regex alone");

  const sled = repo.findOrCreateExercise("Sled Push");
  assert.deepEqual(row(sled.id), { muscle_group: null, muscle_group_source: null }, "nothing can place it: no source");

  const mine = repo.upsertExercise({ name: "Landmine Rotation", muscle_group: "core" });
  assert.deepEqual(row(mine.id), { muscle_group: "core", muscle_group_source: "user" }, "a supplied group is a person's");
});

test("curatedMuscleGroup answers only where the tables are unanimous", () => {
  assert.equal(curatedMuscleGroup("Close-Grip Bench Press"), "triceps");
  assert.equal(curatedMuscleGroup("Lying Leg Curl"), "hamstrings");
  assert.equal(curatedMuscleGroup("Suitcase Carry"), null, "a carry row and a core classifier rule disagree: no guess");
  assert.equal(curatedMuscleGroup("Barbell Bench Press"), null, "no named-lift row: the tables say nothing");
});

// ---------- the agent rule ----------

test("enrichment corrects a classifier guess, then never flips its own answer", () => {
  const ex = repo.findOrCreateExercise("EZ Bar Skull Crusher");
  // The classifier guessed wrong (as an older rule did for close-grip benching).
  db.prepare("UPDATE exercises SET muscle_group = 'forearms', muscle_group_source = 'classifier' WHERE id = ?").run(ex.id);

  repo.applyExerciseEnrichment(ex.id, { muscle_group: "triceps" });
  assert.deepEqual(row(ex.id), { muscle_group: "triceps", muscle_group_source: "agent" }, "the guess is corrected");

  repo.applyExerciseEnrichment(ex.id, { muscle_group: "chest" });
  assert.deepEqual(row(ex.id), { muscle_group: "triceps", muscle_group_source: "agent" }, "a later agent answer never flips it");
});

test("an agent never overwrites a unanimous table group or a legacy group", () => {
  const curl = repo.findOrCreateExercise("Lying Leg Curl");
  repo.applyExerciseEnrichment(curl.id, { muscle_group: "glutes" });
  assert.equal(row(curl.id).muscle_group, "hamstrings");

  const legacy = insertRaw("Cable Hip Thing", "glutes", "legacy");
  repo.applyExerciseEnrichment(legacy, { muscle_group: "quads" });
  assert.deepEqual(row(legacy), { muscle_group: "glutes", muscle_group_source: "legacy" });
});

test("a person's group is never overwritten by any path, even a wrong or cleared one", async () => {
  const wrong = repo.upsertExercise({ name: "Close-Grip Bench Press", muscle_group: "forearms" });
  const cleared = repo.findOrCreateExercise("EZ Bar Skull Crusher");
  repo.updateExercise(cleared.id, { muscle_group: null });
  assert.deepEqual(row(cleared.id), { muscle_group: null, muscle_group_source: "user" }, "a person's clear is their choice");
  logSets(wrong.id, 3);
  logSets(cleared.id, 3);

  repo.applyExerciseEnrichment(wrong.id, { muscle_group: "triceps" });
  repo.applyExerciseEnrichment(cleared.id, { muscle_group: "triceps" });
  assert.equal(repo.applyAgentMuscleGroup(wrong.id, "triceps"), false);
  repo.recheckExerciseGroups();
  repo.correctExerciseGroups({ override: true });
  repo.reconcileExerciseGroups();
  await reconcileExercises("stub", undefined, { authoritativeGroups: true });
  await reconcileExercises("stub", undefined, { authoritativeGroups: false });

  assert.deepEqual(row(wrong.id), { muscle_group: "forearms", muscle_group_source: "user" });
  assert.deepEqual(row(cleared.id), { muscle_group: null, muscle_group_source: "user" });

  // A person changing it again is still theirs.
  repo.updateExercise(wrong.id, { muscle_group: "triceps" });
  assert.deepEqual(row(wrong.id), { muscle_group: "triceps", muscle_group_source: "user" });
});

// ---------- the deterministic re-check ----------

test("the re-check fixes a curated lift filed under a group it does not train, and leaves a defensible one", () => {
  const closeGrip = insertRaw("Close-Grip Bench Press", "forearms", "legacy");
  const dips = insertRaw("Dips", "chest", "legacy");
  const curl = insertRaw("Lying Leg Curl", "biceps", "classifier");
  const carry = insertRaw("Suitcase Carry", "forearms", "legacy");
  const agentWrong = insertRaw("Seated Leg Curl", "calves", "agent");

  const res = repo.recheckExerciseGroups();

  assert.deepEqual(row(closeGrip), { muscle_group: "triceps", muscle_group_source: "table" }, "forearms is no mover of it");
  assert.deepEqual(row(dips), { muscle_group: "chest", muscle_group_source: "legacy" }, "the chest is a real second mover");
  assert.deepEqual(row(curl), { muscle_group: "hamstrings", muscle_group_source: "table" }, "a classifier guess follows");
  assert.deepEqual(row(carry), { muscle_group: "forearms", muscle_group_source: "legacy" }, "unsettled name: untouched");
  assert.deepEqual(row(agentWrong), { muscle_group: "hamstrings", muscle_group_source: "table" });
  assert.equal(res.updated, 3);
  assert.equal(repo.recheckExerciseGroups().updated, 0, "idempotent");
});

test("the nightly Tidy runs the re-check (no person needed for a group the lift never trains)", async () => {
  const closeGrip = insertRaw("Close-Grip Bench Press", "forearms", "legacy");
  logSets(closeGrip, 3);
  const pulldown = insertRaw("Wide-Grip Pulldown", "forearms", "legacy");
  logSets(pulldown, 3);
  const res = await reconcileExercises("stub", undefined, { authoritativeGroups: false });
  assert.equal(row(closeGrip).muscle_group, "triceps");
  // The grip does work in a pulldown, so the nightly pass leaves it; the person's Tidy
  // (the override table) is what replaces it, as before.
  assert.equal(row(pulldown).muscle_group, "forearms");
  assert.ok(res.groups_fixed >= 1);
});

// ---------- visibility ----------

test("the balance read names a lift with sets and no group, and leaves grouped numbers unchanged", () => {
  const bench = repo.findOrCreateExercise("Barbell Bench Press");
  const cableRow = repo.findOrCreateExercise("Seated Cable Row");
  logSets(bench.id, 4);
  logSets(cableRow.id, 3, localDaysAgo(3));
  const catCow = repo.findOrCreateExercise("Cat-Cow");
  logSets(catCow.id, 2);

  const before = repo.programBalance(2, TODAY);

  const sled = repo.findOrCreateExercise("Sled Push");
  assert.equal(row(sled.id).muscle_group, null, "nothing can place it");
  logSets(sled.id, 5);
  const flip = repo.findOrCreateExercise("Tire Flip");
  logSets(flip.id, 1, localDaysAgo(2));
  // Outside the window: not named.
  const old = repo.findOrCreateExercise("Battle Rope Slam");
  logSets(old.id, 2, localDaysAgo(30));

  const read = programBalanceRead(2, TODAY);
  const { ungrouped, ungrouped_note, ...balance } = read;
  assert.deepEqual(balance, before, "every grouped number is exactly what it was");
  assert.deepEqual(
    ungrouped.map((u) => [u.exercise, u.sets]),
    [
      ["Sled Push", 5],
      ["Tire Flip", 1],
    ],
    "named, most sets first; mobility and out-of-window work are not listed"
  );
  assert.match(ungrouped_note, /Sled Push \(5 sets\), Tire Flip \(1 set\)/);
  assert.doesNotMatch(ungrouped_note, /\d+\s*(%|\/\s*\d+|points?)/, "a count, never a score");
});

test("the balance read carries no note when every lift was counted", () => {
  const bench = repo.findOrCreateExercise("Barbell Bench Press");
  logSets(bench.id, 3);
  const read = programBalanceRead(2, TODAY);
  assert.deepEqual(read.ungrouped, []);
  assert.equal(read.ungrouped_note, null);
});

test("the ungrouped note names a few lifts, then 'and N more'", () => {
  const lifts = ["A", "B", "C", "D", "E"].map((exercise, i) => ({ exercise, sets: 5 - i, last_date: TODAY }));
  const note = ungroupedNote(lifts);
  assert.match(note, /A \(5 sets\), B \(4 sets\), C \(3 sets\), and 2 more\.$/);
  assert.doesNotMatch(note, /D \(|E \(/);
  assert.equal(ungroupedNote([]), null);
});
