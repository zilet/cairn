// Autoregulation feedback belongs to the muscles that session actually trained.
// A sore leg day used to hold EVERY lift for three days — the bench press
// included — because the brake never asked which muscles the feedback was about.
// The named-joint brake and the acute-load gate were already group-scoped; these
// two were the outliers. What is pinned here:
//   - leg-day soreness brakes leg work and leaves the bench alone
//   - the same for a flat performance report, scoped to ITS own session's day
//     (soreness and performance are read independently and can differ)
//   - an unresolvable scope FAILS CLOSED to the old whole-body brake
//   - one-step brake discipline is untouched: overload -> hold, never further
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { nextPrescription, recentAutoregulation } from "../dist/repo/progression.js";
import { localDateISO } from "../dist/repo/shared.js";

const isoDaysAgo = (n) => localDateISO(new Date(Date.now() - n * 864e5));

function reset() {
  resetTables("logged_sets", "sessions", "exercises", "plan_items", "plan_days", "activities", "program_blocks");
}
beforeEach(reset);

function logSet(name, group, date, { weight = 100, reps = 8, rir = 2, setNum = 1 } = {}) {
  const ex = repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sess.id, ex.id, setNum, weight, reps, rir);
}

function feedback(date, { soreness = null, performance = null } = {}) {
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(`UPDATE sessions SET soreness = ?, performance = ? WHERE id = ?`).run(soreness, performance, sess.id);
}

// An earned overload: a comfortable top set that the engine would step up from,
// so a brake is visible as the DIFFERENCE between hold and overload.
function seedEarnedLift(name, group) {
  logSet(name, group, isoDaysAgo(10), { weight: 100, reps: 8, rir: 2 });
  logSet(name, group, isoDaysAgo(4), { weight: 100, reps: 10, rir: 3 });
}

test("with no feedback at all, an earned lift is free to step up", () => {
  seedEarnedLift("Barbell Bench Press", "chest");
  const p = nextPrescription("Barbell Bench Press");
  assert.ok(p, "there is a prescription to read");
  assert.equal(p.action, "overload", "nothing is braking it");
});

test("leg-day soreness holds the squat and leaves the bench alone", () => {
  const sore = isoDaysAgo(1);
  seedEarnedLift("Barbell Bench Press", "chest");
  seedEarnedLift("Back Squat", "quads");
  // The sore session trained legs only.
  logSet("Back Squat", "quads", sore, { weight: 100, reps: 8, rir: 2, setNum: 2 });
  feedback(sore, { soreness: 5 });

  const autoreg = recentAutoregulation(undefined, localDateISO());
  assert.equal(autoreg.soreness, 5);
  assert.ok(autoreg.soreness_groups.includes("quads"), "the scope resolved to the legs");
  assert.ok(!autoreg.soreness_groups.includes("chest"), "and not to the chest");

  assert.equal(nextPrescription("Back Squat").action, "hold", "the sore muscle holds load");
  assert.equal(
    nextPrescription("Barbell Bench Press").action,
    "overload",
    "the bench never saw that session and keeps its earned step"
  );
});

test("a flat performance report is scoped to its own session's muscles", () => {
  const flat = isoDaysAgo(1);
  seedEarnedLift("Barbell Bench Press", "chest");
  seedEarnedLift("Back Squat", "quads");
  logSet("Barbell Bench Press", "chest", flat, { weight: 100, reps: 8, rir: 2, setNum: 2 });
  feedback(flat, { performance: 1 });

  const autoreg = recentAutoregulation(undefined, localDateISO());
  assert.ok(autoreg.performance_groups.includes("chest"));
  assert.equal(nextPrescription("Barbell Bench Press").action, "hold");
  assert.equal(nextPrescription("Back Squat").action, "overload", "the squat was not in that flat session");
});

test("soreness and performance from DIFFERENT days each carry their own scope", () => {
  seedEarnedLift("Barbell Bench Press", "chest");
  seedEarnedLift("Back Squat", "quads");
  const sore = isoDaysAgo(1);
  const flat = isoDaysAgo(2);
  logSet("Back Squat", "quads", sore, { weight: 100, reps: 8, rir: 2, setNum: 2 });
  feedback(sore, { soreness: 5 });
  logSet("Barbell Bench Press", "chest", flat, { weight: 100, reps: 8, rir: 2, setNum: 2 });
  feedback(flat, { performance: 1 });

  const autoreg = recentAutoregulation(undefined, localDateISO());
  assert.ok(autoreg.soreness_groups.includes("quads"));
  assert.ok(!autoreg.soreness_groups.includes("chest"));
  assert.ok(autoreg.performance_groups.includes("chest"));
  assert.ok(!autoreg.performance_groups.includes("quads"));
  // Each lift is braked by the signal that actually concerns it.
  assert.equal(nextPrescription("Back Squat").action, "hold");
  assert.equal(nextPrescription("Barbell Bench Press").action, "hold");
});

test("FAILS CLOSED: feedback on a day with no logged sets still brakes everything", () => {
  seedEarnedLift("Barbell Bench Press", "chest");
  seedEarnedLift("Back Squat", "quads");
  // A bare feedback row — the athlete rated a session that logged nothing.
  const bare = isoDaysAgo(1);
  feedback(bare, { soreness: 5 });

  const autoreg = recentAutoregulation(undefined, localDateISO());
  assert.deepEqual(autoreg.soreness_groups, [], "the scope is unresolved");
  assert.equal(nextPrescription("Back Squat").action, "hold", "an unresolved scope keeps the whole-body brake");
  assert.equal(nextPrescription("Barbell Bench Press").action, "hold");
});

test("indirect load counts as trained — a press day's soreness reaches the triceps", () => {
  const sore = isoDaysAgo(1);
  seedEarnedLift("Barbell Bench Press", "chest");
  seedEarnedLift("Triceps Pushdown", "triceps");
  logSet("Barbell Bench Press", "chest", sore, { weight: 100, reps: 8, rir: 2, setNum: 2 });
  feedback(sore, { soreness: 5 });

  const autoreg = recentAutoregulation(undefined, localDateISO());
  assert.ok(
    autoreg.soreness_groups.includes("triceps"),
    `a press loads the triceps too (got ${JSON.stringify(autoreg.soreness_groups)})`
  );
  assert.equal(nextPrescription("Triceps Pushdown").action, "hold");
});

test("scoping never deepens the brake — soreness holds, it does not deload", () => {
  const sore = isoDaysAgo(1);
  seedEarnedLift("Back Squat", "quads");
  logSet("Back Squat", "quads", sore, { weight: 100, reps: 8, rir: 2, setNum: 2 });
  feedback(sore, { soreness: 5 });
  const p = nextPrescription("Back Squat");
  assert.equal(p.action, "hold", "one step toward safety, never two");
  assert.notEqual(p.action, "deload");
});

test("stale feedback outside the window scopes to nothing and brakes nothing", () => {
  seedEarnedLift("Back Squat", "quads");
  const old = isoDaysAgo(9);
  logSet("Back Squat", "quads", old, { weight: 100, reps: 8, rir: 2, setNum: 2 });
  feedback(old, { soreness: 5 });
  const autoreg = recentAutoregulation(undefined, localDateISO());
  assert.equal(autoreg.soreness, null, "feedback older than the window is not read at all");
  assert.deepEqual(autoreg.soreness_groups, []);
});
