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
import { localDateISO } from "../dist/repo/shared.js";

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
  const today = localDateISO();
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
  const today = localDateISO();
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
  const today = localDateISO();
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

test("distinctExerciseNames returns logged/planned movements with group + usage context", () => {
  const ex = repo.findOrCreateExercise("Barbell Bench Press", "chest");
  const today = localDateISO();
  const sess = repo.getOrCreateSession(today);
  db.prepare("INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 135, 8)").run(sess.id, ex.id);
  db.prepare("INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 2, 135, 8)").run(sess.id, ex.id);
  const names = repo.distinctExerciseNames();
  const bench = names.find((n) => /bench press/i.test(n.name));
  assert.ok(bench, "the logged movement appears");
  assert.ok(bench.sets >= 2, "carries a logged-set count");
  assert.equal(bench.days, 1, "one distinct logged day");
  assert.equal(bench.last_used, today, "last-used date");
  assert.equal(bench.mode, "reps", "carries the mode");
  assert.equal(bench.in_plan, false, "not in the plan");
});

// ---- normalizedExerciseKey: plural fold ----

test("normalizedExerciseKey: singular and plural fold to one key", () => {
  const { normalizedExerciseKey } = repo;
  assert.equal(normalizedExerciseKey("Leg Extensions"), normalizedExerciseKey("Leg Extension"));
  assert.equal(normalizedExerciseKey("Lat Pulldowns"), normalizedExerciseKey("Lat Pulldown"));
  assert.equal(normalizedExerciseKey("Hammer Curls"), normalizedExerciseKey("Hammer Curl"));
  assert.equal(normalizedExerciseKey("Walking Lunges"), normalizedExerciseKey("Walking Lunge"));
  // "triceps"/"biceps" fold to their singular so a "Tricep Pushdown" reads the same.
  assert.equal(normalizedExerciseKey("Triceps Pushdown"), normalizedExerciseKey("Tricep Pushdown"));
});

test("normalizedExerciseKey: ss / short-word tokens are left intact by the fold", () => {
  const { normalizedExerciseKey } = repo;
  // "press" ends in ss, "abs" is too short — never singularized.
  assert.match(normalizedExerciseKey("Bench Press"), /press/);
  assert.match(normalizedExerciseKey("Overhead Press"), /press/);
  assert.match(normalizedExerciseKey("Weighted Abs"), /\babs\b/);
  // and the fold doesn't collapse genuinely different movements.
  assert.notEqual(normalizedExerciseKey("Barbell Bench Press"), normalizedExerciseKey("Dumbbell Bench Press"));
});

// ---- authoritativeGroup: high-precision group correction ----

test("authoritativeGroup: unambiguous movements resolve, contested ones stay null", () => {
  const { authoritativeGroup } = repo;
  assert.equal(authoritativeGroup("Wide-Grip Pulldown"), "back");
  assert.equal(authoritativeGroup("Barbell Bench Press"), "chest");
  assert.equal(authoritativeGroup("Back Squat"), "quads");
  assert.equal(authoritativeGroup("Lying Leg Curl"), "hamstrings");
  assert.equal(authoritativeGroup("Dead Hang"), "forearms");
  assert.equal(authoritativeGroup("Standing Calf Raise"), "calves");
  // contested single-token names are deliberately NOT authoritative (agent's call).
  assert.equal(authoritativeGroup("Weighted Dip"), null);
  assert.equal(authoritativeGroup("DB Pullover"), null);
  assert.equal(authoritativeGroup("Cable Curl"), null);
});

// ---- validateExerciseMergePlan: the pure merge safety net ----

test("validateExerciseMergePlan: accepts a same-lift rename, rejects real differences", () => {
  const { validateExerciseMergePlan } = repo;
  const ok = (from, into) => validateExerciseMergePlan(from, into).ok;

  // same lift under a different name — accepted (the stray duplicate has little history)
  assert.equal(ok({ name: "Squat", days: 2 }, { name: "Back Squat", days: 20 }), true);
  assert.equal(ok({ name: "Bench Press", days: 3 }, { name: "Barbell Bench Press", days: 25 }), true);
  assert.equal(ok({ name: "Single arm DB pulls", days: 2 }, { name: "Single-Arm DB Row", days: 12 }), true);
  // pure plural variant keys identically → always allowed
  assert.equal(ok({ name: "Leg Extensions", days: 10 }, { name: "Leg Extension", days: 12 }), true);

  // assisted ≠ unassisted
  assert.equal(ok({ name: "Assisted Pull-Up", days: 5 }, { name: "Pull Up", days: 6 }), false);
  // a variation token one side lacks
  assert.equal(ok({ name: "Incline Bench Press", days: 6 }, { name: "Barbell Bench Press", days: 20 }), false);
  // timed ≠ reps
  assert.equal(ok({ name: "Plank", mode: "timed", days: 4 }, { name: "Crunch", mode: "reps", days: 4 }), false);
  // two independently well-trained lifts (different keys) are protected
  assert.equal(ok({ name: "Back Squat", days: 12 }, { name: "Front Squat", days: 10 }), false);
  // identical names / empty are rejected
  assert.equal(ok({ name: "Row" }, { name: "Row" }), false);
  assert.equal(ok({ name: "" }, { name: "Row" }), false);
});

test("validateExerciseMergePlan: reports which relation justified the pass", () => {
  const { validateExerciseMergePlan } = repo;
  const rel = (from, into) => validateExerciseMergePlan(from, into).relation;
  // pure plural/naming variant → same key
  assert.equal(rel({ name: "Leg Extensions", days: 10 }, { name: "Leg Extension", days: 12 }), "same-key");
  // one name's tokens ⊂ the other's → subset
  assert.equal(rel({ name: "Squat", days: 2 }, { name: "Back Squat", days: 20 }), "subset");
  assert.equal(rel({ name: "Bench Press", days: 3 }, { name: "Barbell Bench Press", days: 25 }), "subset");
  // only a shared muscle group (no subset, no same key) → group-only
  assert.equal(rel({ name: "Single arm DB pulls", days: 2 }, { name: "Single-Arm DB Row", days: 12 }), "group-only");
  assert.equal(rel({ name: "Pendlay Row", days: 5 }, { name: "Barbell Bent-Over Row", days: 20 }), "group-only");
});

test("shouldAutoApplyMerge: only structural, high-confidence merges auto-apply", () => {
  const { validateExerciseMergePlan, shouldAutoApplyMerge } = repo;
  const auto = (from, into, conf) => shouldAutoApplyMerge(validateExerciseMergePlan(from, into), conf);
  // structural (subset / same-key) + high → auto-apply
  assert.equal(auto({ name: "Squat", days: 2 }, { name: "Back Squat", days: 20 }, "high"), true);
  assert.equal(auto({ name: "Bench Press", days: 3 }, { name: "Barbell Bench Press", days: 25 }, "high"), true);
  assert.equal(auto({ name: "Leg Extensions", days: 10 }, { name: "Leg Extension", days: 12 }, "high"), true);
  // group-only + high → DEMOTED (never auto-applied), even for a legit rename
  assert.equal(auto({ name: "Single arm DB pulls", days: 2 }, { name: "Single-Arm DB Row", days: 12 }, "high"), false);
  // group-only + high → DEMOTED for a distinct movement the group branch would admit
  assert.equal(auto({ name: "Pendlay Row", days: 5 }, { name: "Barbell Bent-Over Row", days: 20 }, "high"), false);
  // structural but only medium confidence → not auto-applied
  assert.equal(auto({ name: "Squat", days: 2 }, { name: "Back Squat", days: 20 }, "medium"), false);
  // a rejected verdict never auto-applies
  assert.equal(auto({ name: "Assisted Pull-Up", days: 5 }, { name: "Pull Up", days: 6 }, "high"), false);
});

test("classifyConstraint: grip/form cue progresses load; pain/load cue caps", () => {
  // The distinction that unfroze the curls: a GRIP/form/ROM cue is managed technically
  // (load still progresses); a pain/load-limiting note caps load; ambiguous → conservative.
  assert.equal(repo.classifyConstraint("Cubital tunnel: neutral grip only, no supinated curls."), "form");
  assert.equal(repo.classifyConstraint("Use a neutral grip, slow tempo"), "form");
  assert.equal(repo.classifyConstraint("left elbow — keep light, no heavy pulls"), "load");
  assert.equal(repo.classifyConstraint("knee pain under load"), "load");
  assert.equal(repo.classifyConstraint("rotator cuff issue"), "load"); // ambiguous injury → conservative cap
  assert.equal(repo.classifyConstraint(""), "none");
  assert.equal(repo.classifyConstraint(null), "none");
  assert.equal(repo.constraintLimitsLoad("neutral grip only"), false);
  assert.equal(repo.constraintLimitsLoad("painful under load"), true);
});
