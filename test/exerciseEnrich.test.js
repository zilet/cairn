// Off-plan exercise enrichment (Track C) — the 'exercise' enrichment kind
// (src/enrich.ts) plus its safe apply path (src/repo/exercises.ts).
//
// When the athlete adds a movement that isn't in the plan, POST /api/exercises
// persists it immediately (so the row + its ⓘ guide exist) and, on a genuine
// create, queues a background job: canonicalize the name, classify muscle group /
// mode / equipment, warm the how-to guide, and pregenerate muscle/equipment-aware
// art. The agent never runs in the harness (offline, deterministic), so we cover:
//   - upsertExercise({enrich}) persistence + the create-only enqueue gate.
//   - applyExerciseEnrichment: fill-only group/equipment/mode, the safe rename of
//     an unreferenced fresh row, the identity-guarded rename of a LOGGED row (the
//     same lift may be relabelled; a different lift may not), the validated Garmin
//     FIT mapping, and the merge-into-existing-duplicate path (logged sets
//     repointed, never lost).
//   - the deterministic Garmin mapping applied at insert, from both entry points,
//     with no agent in the picture.
//   - processExerciseJob graceful degradation (no agent / enrichment off → skipped,
//     row intact) and recoverPendingEnrich picking up an interrupted exercise.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { processExerciseJob, recoverPendingEnrich } from "../dist/enrich.js";

beforeEach(() => {
  // Keep the suite OFFLINE + deterministic: disable every real agent so
  // pickAgentOrder() returns [] and processExerciseJob degrades to 'skipped'
  // before ever spawning a CLI (the dev box may have claude/codex logged in).
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok", "stub"], enrich_enabled: true });
});

test("upsertExercise({enrich}) persists a new movement and queues it (status pending)", () => {
  const row = repo.upsertExercise({ name: "Single-Arm Lat Pulldown" }, { enrich: true });
  assert.ok(row.id, "the exercise row exists immediately");
  // Assert synchronously (before any await): the create sets 'pending'; the async
  // enqueue's drain hasn't run yet, so the status is still the just-written one.
  assert.equal(row.enrichment_status, "pending", "a genuinely new user-added exercise is queued for enrichment");
  assert.equal(repo.listExercises().filter((e) => e.name === "Single-Arm Lat Pulldown").length, 1);
});

test("upsertExercise({enrich}) re-adding an existing name does not create a duplicate", () => {
  const first = repo.upsertExercise({ name: "Zercher Squat" }, { enrich: true });
  const again = repo.upsertExercise({ name: "Zercher Squat" }, { enrich: true });
  assert.equal(again.id, first.id, "the existing row is reused, never duplicated");
  assert.equal(repo.listExercises().filter((e) => e.name === "Zercher Squat").length, 1);
});

test("upsertExercise records 'skipped' (no queue) when enrichment is off", () => {
  repo.setSettings({ enrich_enabled: false });
  const row = repo.upsertExercise({ name: "Hack Squat" }, { enrich: true });
  assert.equal(row.enrichment_status, "skipped", "a disabled install records skipped directly, no pending churn");
});

test("the seed/import path (no enrich flag) never enqueues — enrichment_status stays null", () => {
  const row = repo.upsertExercise({ name: "Goblet Squat" }); // no opts → plan-import/seed shape
  assert.equal(row.enrichment_status ?? null, null, "only the user-facing route opts into enrichment");
});

test("applyExerciseEnrichment fills a null group + equipment, and never clobbers a good group", () => {
  const row = repo.findOrCreateExercise("Mystery Move");
  db.prepare("UPDATE exercises SET muscle_group = NULL, equipment = NULL WHERE id = ?").run(row.id);

  repo.applyExerciseEnrichment(row.id, { muscle_group: "back", equipment: "a cable machine" });
  let ex = repo.getExercise(row.id);
  assert.equal(ex.muscle_group, "back", "a null group is filled");
  assert.equal(ex.equipment, "a cable machine", "equipment is captured for art/guide context");

  // A recognized-but-different group must NOT overwrite an already-good one.
  repo.applyExerciseEnrichment(row.id, { muscle_group: "chest", equipment: "dumbbells" });
  ex = repo.getExercise(row.id);
  assert.equal(ex.muscle_group, "back", "a good group is never overwritten");
  assert.equal(ex.equipment, "a cable machine", "a filled equipment tag is never overwritten");
});

test("applyExerciseEnrichment renames an unreferenced fresh row to a cleaner canonical + records the alias", () => {
  const row = repo.findOrCreateExercise("db incline press"); // → cleaned display, no logged sets
  const before = repo.getExercise(row.id).name;

  const r = repo.applyExerciseEnrichment(row.id, { canonical: "Incline Dumbbell Press" });
  assert.equal(r.id, row.id, "same row (renamed by id — logged data never moves)");
  assert.equal(r.name, "Incline Dumbbell Press");
  assert.ok(repo.findExercise("Incline Dumbbell Press"), "the row now carries the clean canonical name");
  assert.equal(repo.findExercise("Incline Dumbbell Press").id, row.id);
  assert.ok(
    repo.listExerciseAliases().some((a) => a.canonical === "Incline Dumbbell Press"),
    "an alias from the old name is recorded so a re-add resolves cleanly",
  );
  assert.notEqual(before, "Incline Dumbbell Press", "the name actually changed");
});

test("applyExerciseEnrichment renames a logged movement when the canonical is the same lift", () => {
  // A label is display text, not identity: "db incline press" and "Incline Dumbbell
  // Press" are the same lift, so the athlete gets the clean name and their history
  // stays exactly where it was (same row id, same sets).
  const row = repo.findOrCreateExercise("db incline press");
  const name = repo.getExercise(row.id).name;
  db.prepare("UPDATE exercises SET muscle_group = NULL WHERE id = ?").run(row.id);
  repo.logSetByName({ exercise: name, weight: 40, reps: 10, date: "2026-07-01" });
  const setsBefore = db.prepare("SELECT COUNT(*) AS c FROM logged_sets").get().c;

  const r = repo.applyExerciseEnrichment(row.id, { canonical: "Incline Dumbbell Press", muscle_group: "chest" });
  assert.equal(r.id, row.id, "the same row — logged numbers never move");
  assert.equal(r.name, "Incline Dumbbell Press", "the same lift, spelled cleanly");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM logged_sets").get().c, setsBefore, "logged sets are untouched");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM logged_sets WHERE exercise_id = ?").get(row.id).c,
    setsBefore,
    "and they still belong to this exercise"
  );
  assert.equal(repo.getExercise(row.id).muscle_group, "chest", "a null group still fills");
});

test("renaming a logged movement remaps Garmin onto the clean name", () => {
  const row = repo.findOrCreateExercise("db incline press");
  db.prepare(`UPDATE exercises SET garmin_category = 'SQUAT', garmin_exercise = NULL, garmin_map_status = 'mapped' WHERE id = ?`).run(
    row.id
  );
  repo.logSetByName({ exercise: repo.getExercise(row.id).name, weight: 40, reps: 10, date: "2026-07-01" });

  repo.applyExerciseEnrichment(row.id, { canonical: "Incline Dumbbell Press" });

  const after = repo.getExercise(row.id);
  assert.equal(after.name, "Incline Dumbbell Press");
  assert.notEqual(after.garmin_category, "SQUAT", "the messy name's miss must not stick");
  assert.equal(after.garmin_map_status, "mapped");
});

test("applyExerciseEnrichment never renames a logged movement into a DIFFERENT lift", () => {
  const row = repo.findOrCreateExercise("Bench Press");
  const name = repo.getExercise(row.id).name;
  repo.logSetByName({ exercise: name, weight: 135, reps: 8, date: "2026-07-01" });

  const r = repo.applyExerciseEnrichment(row.id, { canonical: "Goblet Squat" });
  assert.equal(r.name, name, "a real movement difference keeps the name the athlete has been using");
  assert.equal(repo.getExercise(row.id).name, name);
});

test("applyExerciseEnrichment stores a valid Garmin mapping and refuses an invented enum", () => {
  const row = repo.findOrCreateExercise("ZTest Knee Wibble"); // nothing deterministic to find
  assert.equal(repo.getExercise(row.id).garmin_category, null);

  // An enum Garmin does not know would 400 the whole write — dropped outright.
  repo.applyExerciseEnrichment(row.id, { garmin_category: "KNEE_WIBBLE", garmin_exercise: "WIBBLE" });
  assert.equal(repo.getExercise(row.id).garmin_category, null, "an invented category never lands");

  repo.applyExerciseEnrichment(row.id, { garmin_category: "SQUAT", garmin_exercise: "GOBLET_SQUAT" });
  const mapped = repo.getExercise(row.id);
  assert.equal(mapped.garmin_category, "SQUAT");
  assert.equal(mapped.garmin_exercise, "GOBLET_SQUAT");
  assert.equal(mapped.garmin_map_status, "mapped");

  // Fill-only: an already-mapped pair is not replaced by a later suggestion.
  repo.applyExerciseEnrichment(row.id, { garmin_category: "BENCH_PRESS", garmin_exercise: null });
  assert.equal(repo.getExercise(row.id).garmin_category, "SQUAT", "a mapped pair is never clobbered");
});

test("ensureGarminMapping does not re-score a remembered miss", () => {
  const row = repo.findOrCreateExercise("ZTest Knee Wibble");
  assert.equal(repo.getExercise(row.id).garmin_map_status, "unmapped");
  db.prepare(`UPDATE exercises SET name = 'Back Squat' WHERE id = ?`).run(row.id);
  repo.ensureGarminMapping(row.id);
  assert.equal(
    repo.getExercise(row.id).garmin_map_status,
    "unmapped",
    "a remembered miss is not re-scored; a rename clears the status first"
  );
});

test("a new movement gets its deterministic Garmin mapping with no agent involved", () => {
  // Both entry points — the exercises screen and simply logging a set — resolve the
  // FIT mapping at insert, so write-back works on a fresh install with no CLI at all.
  const upserted = repo.upsertExercise({ name: "Goblet Squat" }, { enrich: true });
  const fromUpsert = repo.getExercise(upserted.id);
  assert.equal(fromUpsert.garmin_category, "SQUAT");
  assert.equal(fromUpsert.garmin_exercise, "GOBLET_SQUAT");
  assert.equal(fromUpsert.garmin_map_status, "mapped");

  repo.logSetByName({ exercise: "Romanian Deadlift", weight: 185, reps: 8, date: "2026-07-03" });
  const logged = repo.findExercise("Romanian Deadlift");
  assert.equal(logged.garmin_category, "DEADLIFT");
  assert.equal(logged.garmin_exercise, "ROMANIAN_DEADLIFT");

  // A name the catalog cannot place is remembered as unmapped rather than guessed at.
  repo.logSetByName({ exercise: "ZTest Knee Wibble", weight: 20, reps: 10, date: "2026-07-03" });
  const unknown = repo.findExercise("ZTest Knee Wibble");
  assert.equal(unknown.garmin_category, null);
  assert.equal(unknown.garmin_map_status, "unmapped");
});

test("a set logged through a surface queues its enrichment; an internal write and a Garmin import do not", () => {
  // The surfaces a person logs through (POST /api/sets, the log_set tool) opt in — the
  // name they typed is the one that may still need cleaning up.
  repo.logSetByName({ exercise: "Meadows Row", weight: 60, reps: 12, date: "2026-07-04" }, { enrich: true });
  assert.equal(
    repo.findExercise("Meadows Row").enrichment_status,
    "pending",
    "an off-plan movement usually arrives by being logged, not by being added"
  );

  // Without that opt-in the movement is still created and still mapped — it just does
  // not buy an agent call (seed, plan import and every internal write take this path).
  repo.logSetByName({ exercise: "Jefferson Curl", weight: 45, reps: 8, date: "2026-07-04" });
  const quiet = repo.findExercise("Jefferson Curl");
  assert.equal(quiet.enrichment_status ?? null, null, "an internal write never queues an agent call");

  // A Garmin set import creates rows too; those must stay off the queue, exactly like
  // seed and plan import.
  assert.equal(repo.findExercise("Seated Cable Row"), undefined);
  repo.importGarminActivitySets({
    session_id: repo.getOrCreateSession("2026-07-05").id,
    date: "2026-07-05",
    activity_key: "garmin-activity:test",
    sets: [{ exercise: "Seated Cable Row", weight: 45, reps: 10, exercise_mode: "reps" }],
  });
  const imported = repo.findExercise("Seated Cable Row");
  assert.ok(imported, "the movement exists");
  assert.equal(imported.enrichment_status ?? null, null, "a Garmin import never queues an agent call");
  assert.equal(imported.garmin_map_status, "mapped", "but it still gets the deterministic mapping");
});

test("applyExerciseEnrichment merges into an existing canonical duplicate, repointing logged sets", () => {
  const canonical = repo.findOrCreateExercise("Move Alpha");
  const dup = repo.findOrCreateExercise("Move Beta");
  assert.notEqual(canonical.id, dup.id, "two distinct rows to start");
  repo.logSetByName({ exercise: "Move Beta", weight: 55, reps: 8, date: "2026-07-02" });

  const r = repo.applyExerciseEnrichment(dup.id, { canonical: "Move Alpha" });
  assert.equal(r.id, canonical.id, "the duplicate merged INTO the existing canonical");
  assert.equal(r.name, "Move Alpha");
  assert.equal(repo.findExercise("Move Beta"), undefined, "the duplicate row is gone");
  const detail = repo.getExerciseDetail("Move Alpha");
  assert.ok(detail.recent.length >= 1, "the logged set was repointed to the canonical, never lost");
});

test("processExerciseJob degrades to 'skipped' offline (no agent), the row stands intact", async () => {
  const row = repo.upsertExercise({ name: "Pendlay Row" }, { enrich: true });
  await processExerciseJob(row.id);
  const after = repo.getExercise(row.id);
  assert.equal(after.enrichment_status, "skipped", "no usable agent → skipped, never stuck in_progress");
  assert.equal(after.name, "Pendlay Row", "the deterministic row is left untouched");
});

test("processExerciseJob is a clean no-op with enrichment disabled", async () => {
  const row = repo.upsertExercise({ name: "Jefferson Curl" }, { enrich: true });
  repo.setSettings({ enrich_enabled: false });
  await processExerciseJob(row.id);
  assert.equal(repo.getExercise(row.id).enrichment_status, "skipped");
});

test("processExerciseJob on a deleted row does not throw", async () => {
  await processExerciseJob(999999); // no such exercise
});

test("recoverPendingEnrich re-enqueues an interrupted exercise without throwing", () => {
  repo.setSettings({ enrich_enabled: false }); // avoid an async drain racing our manual writes
  const row = repo.upsertExercise({ name: "Reverse Nordic" }, { enrich: true });
  repo.setExerciseEnrichStatus(row.id, "in_progress"); // interrupted mid-enrichment
  const counts = recoverPendingEnrich();
  assert.ok(counts.exercises >= 1, `expected the pending exercise to be recovered, got ${counts.exercises}`);
});

test("exerciseArtPending reflects the enrichment status for the art defer guard", () => {
  const row = repo.upsertExercise({ name: "Spider Curl" }, { enrich: true });
  repo.setExerciseEnrichStatus(row.id, "in_progress");
  assert.equal(repo.exerciseArtPending("Spider Curl"), true, "art generation is deferred while enrichment runs");
  assert.equal(repo.exerciseArtPending("spider curl"), true, "name match is case-insensitive");
  repo.setExerciseEnrichStatus(row.id, "done");
  assert.equal(repo.exerciseArtPending("Spider Curl"), false, "once done, the name-only serve path is allowed");
  assert.equal(repo.exerciseArtPending("Never Added"), false, "an unknown exercise is not pending");
});
