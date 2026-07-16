import { test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo } from "./_seed.js";

const back = (n) => localDaysAgo(n);

function logLift(exercise, weight, reps, daysAgo, muscle = "chest") {
  const ex = repo.upsertExercise({ name: exercise, muscle_group: muscle });
  const sess = repo.getOrCreateSession(back(daysAgo), null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
     VALUES (?, ?, 1, ?, ?, 2)`
  ).run(sess.id, ex.id, weight, reps);
}

const BENCH_CAP = {
  exercise: "Barbell Bench Press",
  label: "Bench press",
  est_1rm: 200,
  level: "intermediate",
  to_next: { level: "advanced", lb: 20 },
};

test("suggests a reachable next strength standard from injected capacities", () => {
  logLift("Barbell Bench Press", 170, 5, 3); // a fresh exposure exists

  const suggestion = repo.suggestAnchorObjective({ capacities: [BENCH_CAP] });
  assert.ok(suggestion, "a reachable standard becomes an anchor suggestion");
  assert.equal(suggestion.exercise, "Barbell Bench Press");
  assert.equal(suggestion.target_kind, "explicit_est_1rm");
  assert.equal(suggestion.target_est_1rm, 220, "target snaps to current + the reachable gap");
  assert.equal(suggestion.gap_lb, 20);
  assert.match(suggestion.title, /advanced/i);
  assert.match(suggestion.title, /bench press/i);
});

test("suggests a return to a personal best when a lift has slipped", () => {
  logLift("Barbell Bench Press", 205, 5, 60); // best ~239 est-1RM
  for (const d of [5, 2, 0]) logLift("Barbell Bench Press", 175, 5, d); // now ~204

  const suggestions = repo.suggestAnchorObjectives({ programState: repo.getProgramState() });
  const pb = suggestions.find((s) => s.target_kind === "return_to_personal_best");
  assert.ok(pb, "a clear regression from a personal best becomes a comeback suggestion");
  assert.equal(pb.exercise, "Barbell Bench Press");
  assert.equal(pb.target_est_1rm, 239.2, "the target is the demonstrated personal best");
  assert.equal(pb.current_est_1rm, 204.2);
  assert.equal(pb.gap_lb, 35);
});

test("surfaces a comeback even when only capacities are passed (the surface path)", () => {
  // The REST/MCP surface calls suggestAnchorObjective({ capacities }) without a
  // program state; the trained-lift scan must still default to the current one.
  logLift("Barbell Bench Press", 205, 5, 60);
  for (const d of [5, 2, 0]) logLift("Barbell Bench Press", 175, 5, d);

  const pb = repo.suggestAnchorObjective({ capacities: [] });
  assert.ok(pb, "a return-to-best surfaces without an explicit program state");
  assert.equal(pb.target_kind, "return_to_personal_best");
  assert.equal(pb.exercise, "Barbell Bench Press");
});

test("thin data yields no suggestion", () => {
  assert.equal(repo.suggestAnchorObjective(), null);
  assert.deepEqual(repo.suggestAnchorObjectives({ programState: repo.getProgramState() }), []);
});

test("a stale exact-lift exposure is not a live anchor", () => {
  logLift("Barbell Bench Press", 170, 5, 120); // last logged 4 months ago
  assert.equal(repo.suggestAnchorObjective({ capacities: [BENCH_CAP] }), null);
});

test("dismissing the suggestion quiets it for a long while", () => {
  logLift("Barbell Bench Press", 170, 5, 3);
  assert.ok(repo.suggestAnchorObjective({ capacities: [BENCH_CAP] }), "available before dismissal");

  repo.dismissAnchorObjectiveSuggestion();
  assert.equal(repo.suggestAnchorObjective({ capacities: [BENCH_CAP] }), null, "quiet after dismissal");
});

test("no suggestion once an objective already exists", () => {
  logLift("Barbell Bench Press", 170, 5, 3);
  repo.setStrengthObjective({ exercise: "Barbell Bench Press", target_kind: "explicit_est_1rm", target_est_1rm: 225 });
  assert.equal(repo.suggestAnchorObjective({ capacities: [BENCH_CAP] }), null);
});
