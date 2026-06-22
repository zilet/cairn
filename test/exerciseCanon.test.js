// Exercise-name canonicalization (src/repo/exercise-canon.ts) — the strength
// brain's movement de-duplication and muscle-group classification. Invariants:
//   - classifyMuscleGroup maps real exercise names to the canonical taxonomy
//   - canonicalGroup folds legacy/free-form values (legs, posterior, abs, grip)
//   - normalizedExerciseKey deduplicates mode-variant names ("Dead hang" / "Dead hang timed")
//   - planExerciseMerges proposes concrete merges for duplicate exercise names
//   - reconcileExerciseGroups backfills null/legacy groups on existing exercises
//   - getProgress never returns a negative best1rm for an assisted lift
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

beforeEach(() => {
  try { db.prepare("DELETE FROM logged_sets").run(); } catch { /* ok */ }
  try { db.prepare("DELETE FROM sessions").run(); } catch { /* ok */ }
  try { db.prepare("DELETE FROM exercises").run(); } catch { /* ok */ }
  try { db.prepare("DELETE FROM plan_items").run(); } catch { /* ok */ }
});

// ---- classifyMuscleGroup on the REAL exercise names in the live DB ----

test("classifyMuscleGroup: chest exercises", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("Barbell Bench Press"), "chest");
  assert.equal(classifyMuscleGroup("Incline DB Press"), "chest");
});

test("classifyMuscleGroup: shoulder exercises", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("Seated DB Overhead Press"), "shoulders");
  assert.equal(classifyMuscleGroup("Lateral Raise"), "shoulders");
});

test("classifyMuscleGroup: rear delts", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("Face Pull"), "rear delts");
});

test("classifyMuscleGroup: triceps", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("Triceps Rope Pushdown"), "triceps");
});

test("classifyMuscleGroup: back exercises", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("Assisted Pull-Up"), "back");
  assert.equal(classifyMuscleGroup("Barbell Bent-Over Row"), "back");
  assert.equal(classifyMuscleGroup("Lat Pulldown"), "back");
  assert.equal(classifyMuscleGroup("Seated Cable Row"), "back");
});

test("classifyMuscleGroup: biceps", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("Hammer Curl"), "biceps");
});

test("classifyMuscleGroup: quad exercises", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("Back Squat"), "quads");
  assert.equal(classifyMuscleGroup("Bulgarian Split Squat"), "quads");
  assert.equal(classifyMuscleGroup("Seated leg press - machine"), "quads");
  assert.equal(classifyMuscleGroup("Leg Extension"), "quads");
});

test("classifyMuscleGroup: hamstring exercises", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("Romanian Deadlift"), "hamstrings");
  assert.equal(classifyMuscleGroup("Leg Curl"), "hamstrings");
});

test("classifyMuscleGroup: calves", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("Standing Calf Raise"), "calves");
  assert.equal(classifyMuscleGroup("Seated Calf Raise"), "calves");
});

test("classifyMuscleGroup: core exercises", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("ABs crunch rope pull overhead"), "core");
  assert.equal(classifyMuscleGroup("Dead Bug"), "core");
  assert.equal(classifyMuscleGroup("Side Plank"), "core");
});

test("classifyMuscleGroup: forearm/grip exercises", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("Dead hang"), "forearms");
  assert.equal(classifyMuscleGroup("Dead hang timed"), "forearms");
});

test("classifyMuscleGroup: mobility exercises", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup("90/90 Hip Switch"), "mobility");
});

test("classifyMuscleGroup: returns null for unknown exercises", () => {
  const { classifyMuscleGroup } = repo;
  assert.equal(classifyMuscleGroup(""), null);
  assert.equal(classifyMuscleGroup("some completely unknown movement xyz"), null);
});

// ---- canonicalGroup: legacy value mapping ----

test("canonicalGroup: folds legacy legs → quads", () => {
  const { canonicalGroup } = repo;
  assert.equal(canonicalGroup("legs"), "quads");
  assert.equal(canonicalGroup("Legs"), "quads");
});

test("canonicalGroup: folds legacy posterior → hamstrings", () => {
  const { canonicalGroup } = repo;
  assert.equal(canonicalGroup("posterior"), "hamstrings");
  assert.equal(canonicalGroup("Posterior Chain"), "hamstrings");
});

test("canonicalGroup: folds legacy abs → core", () => {
  const { canonicalGroup } = repo;
  assert.equal(canonicalGroup("abs"), "core");
  assert.equal(canonicalGroup("abdominals"), "core");
});

test("canonicalGroup: folds legacy grip → forearms", () => {
  const { canonicalGroup } = repo;
  assert.equal(canonicalGroup("grip"), "forearms");
  assert.equal(canonicalGroup("forearm"), "forearms");
});

test("canonicalGroup: passes through valid taxonomy values unchanged", () => {
  const { canonicalGroup } = repo;
  assert.equal(canonicalGroup("chest"), "chest");
  assert.equal(canonicalGroup("rear delts"), "rear delts");
  assert.equal(canonicalGroup("core"), "core");
  assert.equal(canonicalGroup("mobility"), "mobility");
});

test("canonicalGroup: returns null for null / unrecognized input", () => {
  const { canonicalGroup } = repo;
  assert.equal(canonicalGroup(null), null);
  assert.equal(canonicalGroup("unknown_value_xyz"), null);
});

// ---- normalizedExerciseKey: dedup Dead hang variants ----

test("normalizedExerciseKey: Dead hang and Dead hang timed share one key", () => {
  const { normalizedExerciseKey } = repo;
  assert.equal(normalizedExerciseKey("Dead hang"), normalizedExerciseKey("Dead hang timed"));
});

test("normalizedExerciseKey: different movements keep distinct keys", () => {
  const { normalizedExerciseKey } = repo;
  // barbell vs dumbbell are distinct implements
  assert.notEqual(normalizedExerciseKey("Barbell Bench Press"), normalizedExerciseKey("Dumbbell Bench Press"));
  // Back Squat vs Romanian Deadlift are totally different
  assert.notEqual(normalizedExerciseKey("Back Squat"), normalizedExerciseKey("Romanian Deadlift"));
});

test("normalizedExerciseKey: case and whitespace are normalized", () => {
  const { normalizedExerciseKey } = repo;
  assert.equal(normalizedExerciseKey("Dead Hang"), normalizedExerciseKey("dead hang"));
  assert.equal(normalizedExerciseKey("  Lat  Pulldown  "), normalizedExerciseKey("Lat Pulldown"));
});

// ---- planExerciseMerges: pure merge proposals ----

test("planExerciseMerges: proposes merge for Dead hang / Dead hang timed", () => {
  const { planExerciseMerges } = repo;
  const names = [
    { name: "Dead hang", sets: 15 },
    { name: "Dead hang timed", sets: 5 },
  ];
  const merges = planExerciseMerges(names);
  assert.equal(merges.length, 1, "one merge proposed");
  // The one with more sets is the primary (into); the other merges into it.
  assert.equal(merges[0].into, "Dead hang");
  assert.equal(merges[0].from, "Dead hang timed");
});

test("planExerciseMerges: no merge proposed for truly distinct exercises", () => {
  const { planExerciseMerges } = repo;
  const names = [
    { name: "Back Squat", sets: 20 },
    { name: "Romanian Deadlift", sets: 18 },
    { name: "Barbell Bench Press", sets: 15 },
  ];
  const merges = planExerciseMerges(names);
  assert.equal(merges.length, 0, "no merges for distinct exercises");
});

test("planExerciseMerges: reads from DB when names omitted and exercises exist", () => {
  // Seed two exercises whose keys collide.
  db.prepare("INSERT OR IGNORE INTO exercises (name, muscle_group, mode) VALUES ('Dead hang', 'forearms', 'timed')").run();
  db.prepare("INSERT OR IGNORE INTO exercises (name, muscle_group, mode) VALUES ('Dead hang timed', 'forearms', 'timed')").run();
  const { planExerciseMerges } = repo;
  const merges = planExerciseMerges();
  const hangMerge = merges.find((m) => m.from === "Dead hang timed" || m.into === "Dead hang timed");
  assert.ok(hangMerge, "merge proposed for the Dead hang variants from the DB");
});

// ---- reconcileExerciseGroups: backfill null/legacy groups ----

test("reconcileExerciseGroups: fills null group via classifier", () => {
  // Insert without a group — reconcile should classify it.
  db.prepare("INSERT OR IGNORE INTO exercises (name, mode) VALUES ('Barbell Bench Press', 'reps')").run();
  const { reconcileExerciseGroups } = repo;
  const result = reconcileExerciseGroups();
  assert.ok(result.updated >= 1, "at least one exercise was updated");
  const ex = db.prepare("SELECT muscle_group FROM exercises WHERE name = 'Barbell Bench Press'").get();
  assert.equal(ex.muscle_group, "chest");
});

test("reconcileExerciseGroups: folds legacy 'legs' → 'quads'", () => {
  db.prepare("INSERT OR IGNORE INTO exercises (name, muscle_group, mode) VALUES ('Back Squat', 'legs', 'reps')").run();
  const { reconcileExerciseGroups } = repo;
  reconcileExerciseGroups();
  const ex = db.prepare("SELECT muscle_group FROM exercises WHERE name = 'Back Squat'").get();
  assert.equal(ex.muscle_group, "quads");
});

test("reconcileExerciseGroups: folds legacy 'posterior' → 'hamstrings'", () => {
  db.prepare("INSERT OR IGNORE INTO exercises (name, muscle_group, mode) VALUES ('Romanian Deadlift', 'posterior', 'reps')").run();
  const { reconcileExerciseGroups } = repo;
  reconcileExerciseGroups();
  const ex = db.prepare("SELECT muscle_group FROM exercises WHERE name = 'Romanian Deadlift'").get();
  assert.equal(ex.muscle_group, "hamstrings");
});

test("reconcileExerciseGroups: leaves already-canonical groups unchanged", () => {
  db.prepare("INSERT OR IGNORE INTO exercises (name, muscle_group, mode) VALUES ('Incline DB Press', 'chest', 'reps')").run();
  const { reconcileExerciseGroups } = repo;
  const result = reconcileExerciseGroups();
  // The exercise should not appear in changes (already correct).
  const changed = result.changes.find((c) => c.name === "Incline DB Press");
  assert.ok(!changed, "already-correct exercise not in changes");
});

// ---- getProgress: never returns a negative best1rm for an assisted lift ----

test("getProgress: assisted lift (negative weight) with known bodyweight gives non-negative best1rm", () => {
  // Set up a profile with bodyweight so the assisted calc can run.
  try {
    db.prepare("INSERT OR IGNORE INTO profile (id, weight_lb) VALUES (1, 185)").run();
    db.prepare("UPDATE profile SET weight_lb = 185 WHERE id = 1").run();
  } catch { /* ok */ }

  const ex = repo.upsertExercise({ name: "Assisted Pull-Up", muscle_group: "back" });
  const today = new Date().toISOString().slice(0, 10);
  const sess = repo.getOrCreateSession(today);
  // -30 means 30 lb assist; effective load = 185 - 30 = 155 lb for Epley.
  db.prepare(
    "INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, -30, 8)"
  ).run(sess.id, ex.id);

  const { getProgress } = repo;
  const prog = getProgress("Assisted Pull-Up");
  assert.ok(prog.found, "exercise found");
  assert.equal(prog.points.length, 1, "one point");
  const pt = prog.points[0];
  // best1rm must be non-negative (the assist reduces bodyweight, not the 1RM below 0).
  assert.ok(pt.best1rm === null || pt.best1rm >= 0, `best1rm must be null or ≥0, got ${pt.best1rm}`);
});

test("getProgress: assisted lift without known bodyweight yields null best1rm, not negative", () => {
  // Clear bodyweight from profile.
  try {
    db.prepare("UPDATE profile SET weight_lb = NULL WHERE id = 1").run();
  } catch { /* ok if profile doesn't exist */ }

  const ex = repo.upsertExercise({ name: "Machine Assisted Dip", muscle_group: "chest" });
  const today = new Date().toISOString().slice(0, 10);
  const sess = repo.getOrCreateSession(today);
  db.prepare(
    "INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, -20, 10)"
  ).run(sess.id, ex.id);

  const { getProgress } = repo;
  const prog = getProgress("Machine Assisted Dip");
  assert.ok(prog.found);
  // Without bodyweight, best1rm should be null (not computed, never negative).
  if (prog.points.length > 0) {
    assert.ok(
      prog.points[0].best1rm === null || prog.points[0].best1rm >= 0,
      `best1rm must be null or ≥0 when bodyweight is unknown, got ${prog.points[0].best1rm}`
    );
  }
});

test("getProgress: regular positive-weight lift still computes a valid best1rm", () => {
  const ex = repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest" });
  const today = new Date().toISOString().slice(0, 10);
  const sess = repo.getOrCreateSession(today);
  db.prepare(
    "INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 135, 8)"
  ).run(sess.id, ex.id);

  const { getProgress } = repo;
  const prog = getProgress("Barbell Bench Press");
  assert.ok(prog.found);
  assert.equal(prog.points.length, 1);
  // Epley(135, 8) = 135 * (1 + 8/30) = 135 * 1.267 ≈ 171.
  assert.ok((prog.points[0].best1rm ?? 0) > 0, "positive best1rm for a regular loaded set");
});

// ---- NEW: agentic exercise understanding (clean names + reuse + profiling) ----

test("cleanExerciseName tidies a messy descriptive title", () => {
  const { cleanExerciseName } = repo;
  assert.equal(cleanExerciseName("incline db press lol 3x10"), "Incline DB Press");
  assert.equal(cleanExerciseName("romanian deadlift"), "Romanian Deadlift");
  assert.equal(cleanExerciseName("  single  arm   row  "), "Single Arm Row");
});

test("cleanExerciseName PRESERVES an already well-cased name (never mangles deliberate casing)", () => {
  const { cleanExerciseName } = repo;
  assert.equal(cleanExerciseName("Barbell Bench Press"), "Barbell Bench Press");
  assert.equal(cleanExerciseName("DB Shoulder Press"), "DB Shoulder Press");
  // but it still strips trailing set/rep noise off an otherwise-clean name
  assert.equal(cleanExerciseName("Barbell Bench Press 3x5"), "Barbell Bench Press");
});

test("detectExerciseMode flags holds as timed, loaded work as reps", () => {
  const { detectExerciseMode } = repo;
  assert.equal(detectExerciseMode("Plank"), "timed");
  assert.equal(detectExerciseMode("Dead Hang"), "timed");
  assert.equal(detectExerciseMode("Wall Sit"), "timed");
  assert.equal(detectExerciseMode("Barbell Bench Press"), "reps");
  assert.equal(detectExerciseMode("Romanian Deadlift"), "reps");
});

test("findOrCreateExercise REUSES by normalized name instead of duplicating (and writes an alias)", () => {
  const a = repo.findOrCreateExercise("Incline DB Press");
  const b = repo.findOrCreateExercise("incline db press"); // casing variant
  const c = repo.findOrCreateExercise("Incline DB Press 3x10"); // notation variant
  assert.equal(b.id, a.id, "a casing variant reuses the same exercise");
  assert.equal(c.id, a.id, "a notation variant reuses the same exercise");
  // exactly one row exists for this movement
  const rows = repo.listExercises().filter((e) => /incline db press/i.test(e.name));
  assert.equal(rows.length, 1, "no duplicate exercise was created");
  // the raw variant self-aligns next time via a persisted alias
  const aliases = repo.listExerciseAliases().map((x) => x.alias);
  assert.ok(aliases.some((al) => /incline db press/.test(al)), "an alias was recorded for reuse");
});

test("findOrCreateExercise stores a CLEANED display name + auto group/mode on create", () => {
  const ex = repo.findOrCreateExercise("dead hang for time");
  assert.equal(ex.name, "Dead Hang", "stored a clean canonical display name");
  assert.equal(ex.mode, "timed", "a hold auto-detects timed mode");
  assert.equal(ex.muscle_group, "forearms", "auto-classified to a group");
});

test("planExerciseAliases (pure validator) folds messy variants onto a clean canonical", () => {
  const items = [{ name: "incline db press lol" }, { name: "Incline DB Press" }];
  const groups = [
    { members: ["incline db press lol", "Incline DB Press"], canonical: "Incline DB Press", group: "chest", mode: "reps" },
  ];
  const aliases = repo.planExerciseAliases(items, groups);
  assert.ok(aliases.length >= 1, "produces at least one alias row");
  for (const a of aliases) {
    assert.equal(a.canonical, "Incline DB Press");
    assert.notEqual(a.rawNorm, "incline db press"); // never self-aliases the canonical
  }
  // a member that isn't a verbatim input is rejected (conservative)
  const bad = repo.planExerciseAliases(items, [
    { members: ["totally made up name"], canonical: "Made Up", group: "chest" },
  ]);
  assert.equal(bad.length, 0, "non-verbatim members are dropped");
});

test("distinctExerciseNames returns logged/planned movements with group + set count", () => {
  const ex = repo.findOrCreateExercise("Barbell Bench Press", "chest");
  const today = new Date().toISOString().slice(0, 10);
  const sess = repo.getOrCreateSession(today);
  db.prepare("INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 135, 8)").run(sess.id, ex.id);
  const names = repo.distinctExerciseNames();
  const bench = names.find((n) => /bench press/i.test(n.name));
  assert.ok(bench, "the logged movement appears");
  assert.ok(bench.sets >= 1, "carries a logged-set count");
});
