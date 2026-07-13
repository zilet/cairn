import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

// Constitution guard: these motivational reads must never leak a numeric grade.
const NO_SCORE = (obj, label) => {
  const json = JSON.stringify(obj);
  assert.ok(!/impact_score/.test(json), `${label}: no impact_score leak`);
  assert.ok(!/"score"/.test(json), `${label}: no bare score field`);
};

// Offline seeding: upsert an exercise (setting group/mode only when provided so a
// null never clobbers an existing group), then insert one raw logged set for a date.
function ensureExercise(name, { muscle_group, mode } = {}) {
  const input = { name };
  if (muscle_group != null) input.muscle_group = muscle_group;
  if (mode != null) input.mode = mode;
  return repo.upsertExercise(input);
}
function logSet(date, name, fields = {}) {
  const { muscle_group, mode, weight = null, reps = null, rir = null, duration_sec = null } = fields;
  const ex = ensureExercise(name, { muscle_group, mode });
  const sess = repo.getOrCreateSession(date, null);
  const m = db
    .prepare(`SELECT MAX(set_number) AS m FROM logged_sets WHERE session_id = ? AND exercise_id = ?`)
    .get(sess.id, ex.id);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sess.id, ex.id, (m?.m ?? 0) + 1, weight, reps, rir, duration_sec);
  return sess.id;
}
const sid = (date) => repo.getSessionByDate(date).id;

// ---------- capability 1: sessionHighlights ----------

test("sessionHighlights flags an est-1RM PR vs prior history, with an up comparison and week rollup", () => {
  logSet("2026-06-01", "Bench Press", { weight: 100, reps: 5 });
  logSet("2026-06-05", "Bench Press", { weight: 110, reps: 5 });

  const h = repo.sessionHighlights(sid("2026-06-05"));
  assert.equal(h.prs.length, 1);
  assert.deepEqual(h.prs[0], { exercise: "Bench Press", kind: "e1rm", label: "110 lb × 5 — new best" });

  assert.equal(h.comparisons.length, 1);
  assert.deepEqual(h.comparisons[0], {
    exercise: "Bench Press",
    prev_date: "2026-06-01",
    prev_label: "100 × 5 on Jun 1",
    delta_label: "+10 lb",
    direction: "up",
  });

  // Trailing-7d rollup ending on the session date: one PR event, two trained days.
  assert.deepEqual(h.week, { prs: 1, trained_days_7: 2 });
  NO_SCORE(h, "sessionHighlights PR");
});

test("first-ever logging of an exercise is not a PR and reads 'first time logged'", () => {
  logSet("2026-06-05", "Back Squat", { weight: 200, reps: 5 });
  logSet("2026-06-05", "Dead Hang", { duration_sec: 45, mode: "timed" });

  const h = repo.sessionHighlights(sid("2026-06-05"));
  assert.deepEqual(h.prs, []); // no baseline for either exercise
  const squat = h.comparisons.find((c) => c.exercise === "Back Squat");
  assert.deepEqual(squat, {
    exercise: "Back Squat",
    prev_date: null,
    prev_label: "first time logged",
    delta_label: null,
    direction: null,
  });
  const hang = h.comparisons.find((c) => c.exercise === "Dead Hang");
  assert.equal(hang.prev_date, null);
  assert.equal(hang.direction, null);
});

test("sessionHighlights flags a timed-hold PR and formats holds as M:SS", () => {
  logSet("2026-06-01", "Plank", { duration_sec: 60, mode: "timed" });
  logSet("2026-06-05", "Plank", { duration_sec: 90, mode: "timed" });

  const h = repo.sessionHighlights(sid("2026-06-05"));
  assert.deepEqual(h.prs[0], { exercise: "Plank", kind: "duration", label: "1:30 hold — new best" });
  assert.deepEqual(h.comparisons[0], {
    exercise: "Plank",
    prev_date: "2026-06-01",
    prev_label: "1:00 hold on Jun 1",
    delta_label: "+30s",
    direction: "up",
  });
});

test("comparisons cover down / even / more-reps / assisted / bodyweight, respecting the load encodings", () => {
  // prior session for every movement
  logSet("2026-06-10", "Bench Press", { weight: 100, reps: 5 });
  logSet("2026-06-10", "Barbell Row", { weight: 135, reps: 8 });
  logSet("2026-06-10", "Overhead Press", { weight: 95, reps: 5 });
  logSet("2026-06-10", "Barbell Curl", { weight: 60, reps: 8 });
  logSet("2026-06-10", "Assisted Pull-up", { weight: -40, reps: 8 }); // 40lb assist
  logSet("2026-06-10", "Push-up", { weight: null, reps: 20 }); // bodyweight

  // current session
  logSet("2026-06-17", "Bench Press", { weight: 110, reps: 5 }); // +10 lb, up
  logSet("2026-06-17", "Barbell Row", { weight: 130, reps: 8 }); // -5 lb, down
  logSet("2026-06-17", "Overhead Press", { weight: 95, reps: 5 }); // matched, even
  logSet("2026-06-17", "Barbell Curl", { weight: 60, reps: 10 }); // +2 reps, up
  logSet("2026-06-17", "Assisted Pull-up", { weight: -30, reps: 8 }); // less assist, up
  logSet("2026-06-17", "Push-up", { weight: null, reps: 25 }); // +5 reps, up

  const h = repo.sessionHighlights(sid("2026-06-17"));
  const by = Object.fromEntries(h.comparisons.map((c) => [c.exercise, c]));

  assert.equal(by["Barbell Row"].delta_label, "-5 lb");
  assert.equal(by["Barbell Row"].direction, "down");
  assert.equal(by["Overhead Press"].delta_label, "matched");
  assert.equal(by["Overhead Press"].direction, "even");
  assert.equal(by["Barbell Curl"].delta_label, "+2 reps");
  assert.equal(by["Barbell Curl"].direction, "up");
  assert.equal(by["Assisted Pull-up"].delta_label, "10 lb less assist");
  assert.equal(by["Assisted Pull-up"].direction, "up");
  assert.equal(by["Assisted Pull-up"].prev_label, "40 lb assist × 8 on Jun 10");
  assert.equal(by["Push-up"].delta_label, "+5 reps");
  assert.equal(by["Push-up"].direction, "up");
  assert.equal(by["Push-up"].prev_label, "20 reps on Jun 10");

  // est-1RM PRs: loaded lifts that beat their all-time-before-date best. Bench (heavier)
  // and Curl (more reps at the same load) PR; assisted/bodyweight never est-1RM PR.
  const prExercises = h.prs.map((p) => p.exercise).sort();
  assert.deepEqual(prExercises, ["Barbell Curl", "Bench Press"]);
  assert.ok(!h.prs.some((p) => ["Assisted Pull-up", "Push-up"].includes(p.exercise)));
});

test("sessionHighlights returns null for an unknown session id", () => {
  assert.equal(repo.sessionHighlights(999999), null);
});

// ---------- capability 2: weekWins ----------

test("weekWins on an empty DB returns the all-empty shape without throwing", () => {
  const w = repo.weekWins("2026-06-17");
  assert.deepEqual(w, {
    prs: [],
    trained_days_7: 0,
    week_sets: 0,
    volume_filled: [],
    pace: { status: null, label: null },
  });
  NO_SCORE(w, "weekWins empty");
});

test("weekWins rolls up new bests, trained days, hard sets, and filled volume for a seeded week", () => {
  // PR baseline (outside the week window) then a new best inside it.
  logSet("2026-06-05", "Bench Press", { weight: 100, reps: 5 });
  logSet("2026-06-12", "Bench Press", { weight: 110, reps: 5 });
  // Seven productive biceps sets this week (landmark low 6 → in the productive band).
  for (let i = 0; i < 7; i++) logSet("2026-06-15", "Barbell Curl", { weight: 60, reps: 10, muscle_group: "biceps" });
  // An activity day (no sets) still counts as a trained day.
  db.prepare(`INSERT INTO activities (date, type) VALUES ('2026-06-13', 'run')`).run();

  const w = repo.weekWins("2026-06-17"); // window [2026-06-11, 2026-06-17]

  assert.deepEqual(w.prs, [{ exercise: "Bench Press", label: "110 lb × 5 — new best" }]);
  assert.equal(w.trained_days_7, 3); // 06-12 sets, 06-15 sets, 06-13 activity
  assert.equal(w.week_sets, 8); // 1 bench + 7 curls inside the window

  const biceps = w.volume_filled.find((v) => v.muscle === "biceps");
  assert.ok(biceps, "biceps reached its productive range");
  assert.equal(biceps.label, "7 hard sets — productive volume");
  // A barely-trained group is below MEV and excluded.
  assert.ok(!w.volume_filled.some((v) => v.muscle === "quads"));
  NO_SCORE(w, "weekWins seeded");
});

test("weekWins dedupes multiple PRs of the same lift to the latest, newest-first", () => {
  logSet("2026-06-11", "Bench Press", { weight: 100, reps: 5 });
  logSet("2026-06-13", "Bench Press", { weight: 105, reps: 5 }); // PR
  logSet("2026-06-16", "Bench Press", { weight: 110, reps: 5 }); // PR (supersedes)
  logSet("2026-06-15", "Back Squat", { weight: 200, reps: 5 });
  logSet("2026-06-17", "Back Squat", { weight: 210, reps: 5 }); // PR

  const w = repo.weekWins("2026-06-17"); // window [2026-06-11, 2026-06-17]
  // One entry per exercise (bench's latest 110 wins), newest PR first (squat on 06-17).
  assert.deepEqual(w.prs, [
    { exercise: "Back Squat", label: "210 lb × 5 — new best" },
    { exercise: "Bench Press", label: "110 lb × 5 — new best" },
  ]);
});

test("weekWins pace phrases a real weight trend and narrows the status to on|behind|fast|null", () => {
  // A clear downward trend with no explicit goal → status folds to null but the label
  // still states the trend factually.
  repo.logWeight(185, "2026-06-20");
  repo.logWeight(183, "2026-06-30");

  const w = repo.weekWins("2026-06-30");
  assert.ok(w.pace.label && /^losing ~\d/.test(w.pace.label), `pace label: ${w.pace.label}`);
  assert.ok(w.pace.status === null || ["on", "behind", "fast"].includes(w.pace.status));
});
